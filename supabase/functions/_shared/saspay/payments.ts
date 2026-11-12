// VYORA — orchestration des paiements SasPay (indépendante de Deno et de la base).
//
// Invariants portés par ce module :
//   1. Le montant vient TOUJOURS du serveur (grille Studio / formule Business
//      Grow) — jamais du navigateur.
//   2. Rien n'est livré sans `GET /payments/{id}/verify/` renvoyant `SUCCESS`.
//      Un webhook, une redirection ou un statut de session ne suffisent jamais.
//   3. Un paiement ne règle qu'une commande et ne crédite qu'une fois
//      (garanti par la base : voir la migration `vyora_saspay_payments`).
//   4. Studio et Business Grow ne partagent ni commande, ni portefeuille :
//      chaque appel porte explicitement son produit.

import {
  SasPayError, redactSecrets,
  type SasPayClient, type TransactionStatus, type VerifiedPayment,
} from './client.ts';
import { normalizeDecimal, parseDecimal, formatDecimal, quoteFee, selectTier, type FeeQuote, type RateTier } from './money.ts';
import { verifyWebhookSignature } from './webhook.ts';

export type Product = 'studio' | 'business';
export type PaymentFlow = 'softpay' | 'checkout';
export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'refunded';
/** États présentés à l'utilisateur. */
export type PaymentState = 'todo' | 'pending' | 'confirmed' | 'failed' | 'cancelled';
export type SettleOutcome = 'paid' | 'already_paid' | 'pending' | 'failed' | 'cancelled' | 'amount_mismatch';

export const PRODUCTS: readonly Product[] = ['studio', 'business'];
export const HANDLED_WEBHOOK_EVENTS = ['transaction.success', 'transaction.failed', 'transaction.cancelled'] as const;

export interface OrderRecord {
  product: Product;
  id: string;
  user_id: string;
  status: OrderStatus;
  /** Chaîne décimale, figée à la création. */
  amount: string;
  currency: string;
  country: string;
  internal_reference: string;
  label: string;
  payment_flow: PaymentFlow | null;
  network_code: string | null;
  provider_payment_id: string | null;
  provider_session_id: string | null;
  provider_status: string | null;
  checkout_url: string | null;
  last_verified_at: string | null;
  [key: string]: unknown;
}

export interface SettleInput {
  paymentId: string | null;
  status: TransactionStatus;
  requestedAmount: string | null;
  currency: string | null;
  fee: string | null;
  charged: string | null;
  net: string | null;
  feeMode: string | null;
  reference: string | null;
  source: 'verify' | 'webhook' | 'initiate';
  failureCode?: string | null;
}

export type SettleResult = OrderRecord & { outcome: SettleOutcome; credited: boolean };

export interface CountryConfig {
  name?: string;
  currency?: string;
  dial_code?: string;
  national_number_length?: number;
  networks?: Array<{ code: string; label?: string }>;
}

export interface QuoteContext {
  product: Product;
  enabled: boolean;
  mode: string;
  flows: string[];
  countries: Record<string, CountryConfig>;
  eligible: boolean;
  reason: string | null;
  price: ({ amount: string; currency: string; label: string } & Record<string, unknown>) | null;
}

export type StudioItem = { kind: 'pack'; pack_key: string } | { kind: 'custom'; amount_xof: number };
export type BusinessItem = { plan_key: string };
export type PaymentItem = StudioItem | BusinessItem;

export interface CreateOrderInput {
  userId: string;
  product: Product;
  item: PaymentItem;
  country: string;
  flow: PaymentFlow;
  network: string | null;
  idempotencyKey: string;
  quotedFee: string | null;
  quotedTotal: string | null;
  quotedFeeMode: string | null;
  msisdnMasked: string | null;
}

/** Port de persistance. L'implémentation réelle appelle les RPC `vyora_payment_*`. */
export interface PaymentStore {
  quote(userId: string, product: Product, item: PaymentItem | Record<string, never>): Promise<QuoteContext>;
  createOrder(input: CreateOrderInput): Promise<OrderRecord & { reused: boolean }>;
  getOrder(product: Product, orderId: string): Promise<OrderRecord | null>;
  attach(product: Product, orderId: string, refs: {
    paymentId: string | null; sessionId: string | null; checkoutUrl: string | null; providerStatus: string | null;
  }): Promise<OrderRecord>;
  settle(product: Product, orderId: string, input: SettleInput): Promise<SettleResult>;
  findOrder(refs: { paymentId: string | null; sessionId: string | null }): Promise<{ product: Product; orderId: string } | null>;
  openCheckoutOrders(limit: number): Promise<Array<{ product: Product; orderId: string; sessionId: string }>>;
  recordWebhook(product: Product, eventKey: string, eventType: string, payload: Record<string, unknown>): Promise<{ first: boolean; processed: boolean }>;
  finishWebhook(product: Product, eventKey: string, ok: boolean, error?: string): Promise<void>;
  isAdmin(userId: string): Promise<boolean>;
}

export class PaymentError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  constructor(code: string, status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface PaymentUser {
  id: string;
  email: string | null;
  name: string | null;
}

export interface PaymentServiceDeps {
  store: PaymentStore;
  /** `null` tant qu'aucune clé SasPay n'est installée côté serveur. */
  client: SasPayClient | null;
  webhookSecret: string | null;
  /** Millisecondes Unix. */
  now: () => number;
  /** Journal structuré. Ne reçoit jamais de secret ni de numéro complet. */
  log?: (event: string, details: Record<string, unknown>) => void;
  ratesTtlMs?: number;
  minVerifyIntervalMs?: number;
}

const NO_DELIVERY = 'Aucun crédit n’est accordé tant que le paiement n’est pas confirmé.';

const PROVIDER_CODE_MESSAGES: Record<string, string> = {
  invalid_customer: 'Les informations du payeur sont refusées. Vérifiez le numéro de téléphone.',
  invalid_method: 'Ce moyen de paiement est indisponible pour le moment. Choisissez-en un autre.',
  missing_method: 'Choisissez un moyen de paiement.',
  no_route_available: 'Ce moyen de paiement est indisponible pour le moment. Choisissez-en un autre.',
  invalid_country: 'Ce pays n’est pas pris en charge pour le paiement.',
  no_exchange_rate: 'Ce paiement ne peut pas être converti dans la devise demandée.',
  prepayment_otp_missing: 'Ce réseau exige un code préalable. Utilisez la page de paiement sécurisée.',
  api_key_scope_forbidden: 'Le compte de paiement n’est pas autorisé à encaisser.',
};

/** Motifs d'inéligibilité renvoyés par la base → (code, message). */
const INELIGIBLE_REASONS: Record<string, [code: string, message: string]> = {
  business_billing_disabled: ['BUSINESS_BILLING_DISABLED', 'La facturation Business Grow n’est pas activée.'],
  business_subscription_managed_elsewhere: ['BUSINESS_SUBSCRIPTION_MANAGED_ELSEWHERE',
    'Votre abonnement Business Grow est géré par un autre moyen de paiement. Contactez le support.'],
  business_plan_change_not_supported: ['BUSINESS_PLAN_CHANGE_NOT_SUPPORTED',
    'Une autre formule est déjà en cours. Vous pourrez changer de formule à la fin de la période, ou contactez le support.'],
  not_vyora_customer: ['PAYMENT_NOT_ELIGIBLE', 'Ce compte ne peut pas acheter de crédits Studio.'],
};

/** Traduit une erreur SasPay en erreur présentable, sans détail sensible. */
export function fromSasPayError(error: SasPayError, details: Record<string, unknown> = {}): PaymentError {
  const known = PROVIDER_CODE_MESSAGES[error.code];
  const meta = { ...details, provider_status: error.status, provider_code: error.code };
  switch (error.kind) {
    case 'unauthorized':
      return new PaymentError('PAYMENT_PROVIDER_UNAUTHORIZED', 503,
        'Le service de paiement est mal configuré. Aucun débit n’a été effectué.', meta);
    case 'forbidden':
      return new PaymentError('PAYMENT_PROVIDER_FORBIDDEN', 503,
        known ?? 'Le service de paiement n’est pas autorisé pour cette opération. Aucun débit n’a été effectué.', meta);
    case 'not_found':
      return new PaymentError('PAYMENT_PROVIDER_NOT_FOUND', 404,
        'Ce paiement est introuvable chez le prestataire.', meta);
    case 'conflict':
      return new PaymentError('PAYMENT_ALREADY_IN_PROGRESS', 409,
        'Une tentative est déjà en cours pour cette commande. Patientez quelques secondes puis vérifiez son statut.', meta);
    case 'gone':
      return new PaymentError('PAYMENT_EXPIRED', 410, 'Ce paiement a expiré. Lancez-en un nouveau.', meta);
    case 'unprocessable':
    case 'bad_request':
      return new PaymentError('PAYMENT_REJECTED', 422,
        known ?? 'Le prestataire a refusé cette demande de paiement. Vérifiez les informations saisies.', meta);
    case 'rate_limited':
      return new PaymentError('PAYMENT_RATE_LIMITED', 429,
        'Trop de demandes de paiement. Réessayez dans une minute.', meta);
    default:
      return new PaymentError('PAYMENT_PROVIDER_UNAVAILABLE', 503,
        `Le prestataire de paiement ne répond pas. ${NO_DELIVERY}`, meta);
  }
}

/** État utilisateur d'une commande. */
export function paymentState(order: Pick<OrderRecord, 'status' | 'provider_payment_id' | 'provider_session_id'>): PaymentState {
  if (order.status === 'paid' || order.status === 'refunded') return 'confirmed';
  if (order.status === 'failed') return 'failed';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'processing' || order.provider_payment_id || order.provider_session_id) return 'pending';
  return 'todo';
}

const PUBLIC_FIELDS = [
  'product', 'id', 'status', 'amount', 'currency', 'country', 'internal_reference', 'label',
  'kind', 'pack_key', 'credits', 'plan_key', 'period_days', 'monthly_credit_units',
  'payment_flow', 'network_code', 'payer_msisdn_masked', 'checkout_url', 'provider_status',
  'quoted_fee_mode', 'quoted_fee_amount', 'quoted_total_amount',
  'fee_charge_mode', 'fee_amount', 'charged_amount', 'net_amount',
  'failure_code', 'created_at', 'paid_at', 'expires_at', 'last_verified_at',
] as const;

/** Vue d'une commande renvoyée au navigateur : jamais d'identifiant utilisateur. */
export function publicOrder(order: OrderRecord): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const field of PUBLIC_FIELDS) if (order[field] !== undefined) view[field] = order[field];
  view.state = paymentState(order);
  return view;
}

/** Normalise un numéro local ou international vers `+<indicatif><numéro>`. */
export function normalizeMsisdn(input: unknown, country: CountryConfig): string | null {
  if (typeof input !== 'string') return null;
  const dial = String(country.dial_code ?? '').replace(/\D/g, '');
  const length = Number(country.national_number_length ?? 0);
  if (!dial || !Number.isInteger(length) || length < 6) return null;
  let digits = input.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.length === length) national = digits;
  else if (digits.startsWith(dial) && digits.length === dial.length + length) national = digits.slice(dial.length);
  else return null;
  return `+${dial}${national}`;
}

/** Ne conserve que l'indicatif et les deux derniers chiffres. */
export function maskMsisdn(msisdn: string): string {
  if (msisdn.length < 7) return '••••';
  return `${msisdn.slice(0, 4)}${'•'.repeat(Math.max(msisdn.length - 6, 2))}${msisdn.slice(-2)}`;
}

function splitName(name: string | null, email: string | null): { first: string; last: string } {
  const source = (name ?? '').replace(/\s+/g, ' ').trim() || (email ?? '').split('@')[0] || '';
  const parts = source.split(' ').filter(Boolean);
  const first = (parts[0] ?? 'Client').slice(0, 60);
  const last = (parts.slice(1).join(' ') || 'VYORA').slice(0, 60);
  return { first, last };
}

function isProduct(value: unknown): value is Product {
  return value === 'studio' || value === 'business';
}

function parseItem(product: Product, raw: unknown): PaymentItem {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (product === 'business') {
    if (typeof item.plan_key !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(item.plan_key)) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Formule Business Grow invalide.');
    }
    return { plan_key: item.plan_key };
  }
  if (item.kind === 'pack' && typeof item.pack_key === 'string' && /^[a-z0-9_-]{1,60}$/i.test(item.pack_key)) {
    return { kind: 'pack', pack_key: item.pack_key };
  }
  if (item.kind === 'custom' && typeof item.amount_xof === 'number' && Number.isSafeInteger(item.amount_xof) && item.amount_xof > 0) {
    return { kind: 'custom', amount_xof: item.amount_xof };
  }
  throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Produit à payer invalide.');
}

interface RateRow {
  country_code?: unknown;
  network_code?: unknown;
  payin?: { available?: unknown; otp_required?: unknown; tiers?: unknown } | null;
}

export interface NetworkOption {
  code: string;
  label: string;
  /** Faux si le compte marchand ne peut pas encaisser sur ce réseau. */
  available: boolean;
  /** Vrai si le réseau exige un code avant paiement : seul le parcours hébergé le gère. */
  otp_required: boolean;
  /** Estimation des frais ; `null` si le tarif du compte n'a pas pu être lu. */
  fee: FeeQuote | null;
}

export function createPaymentService(deps: PaymentServiceDeps) {
  const { store, client } = deps;
  const log = deps.log ?? (() => undefined);
  const ratesTtlMs = deps.ratesTtlMs ?? 5 * 60_000;
  const minVerifyIntervalMs = deps.minVerifyIntervalMs ?? 3_000;
  let ratesCache: { at: number; rows: RateRow[] } | null = null;

  /** Tarifs du compte marchand. Lecture seule, mise en cache, jamais bloquante. */
  async function rates(): Promise<RateRow[] | null> {
    if (!client) return null;
    if (ratesCache && deps.now() - ratesCache.at < ratesTtlMs) return ratesCache.rows;
    try {
      const rows = await client.myRates() as RateRow[];
      ratesCache = { at: deps.now(), rows };
      return rows;
    } catch (error) {
      log('saspay_rates_unavailable', { code: error instanceof SasPayError ? error.code : 'unknown' });
      return null;
    }
  }

  function networkOption(
    rows: RateRow[] | null, country: string, network: { code: string; label?: string }, amount: string | null,
  ): NetworkOption {
    const row = rows?.find((r) => String(r.country_code ?? '').toUpperCase() === country && r.network_code === network.code);
    const payin = row?.payin ?? null;
    const tiers = Array.isArray(payin?.tiers) ? payin.tiers as RateTier[] : [];
    return {
      code: network.code,
      label: network.label || network.code,
      // Sans grille lisible, on ne déclare pas le réseau indisponible : SasPay tranchera.
      available: rows === null ? true : Boolean(row) && payin?.available !== false,
      otp_required: payin?.otp_required === true,
      fee: amount ? quoteFee(amount, selectTier(amount, tiers)) : null,
    };
  }

  function unavailableReason(ctx: QuoteContext): { code: string; message: string } | null {
    if (!ctx.enabled) {
      return { code: 'PAYMENTS_DISABLED', message: 'Le paiement en ligne n’est pas encore activé.' };
    }
    if (!ctx.eligible) {
      const known = INELIGIBLE_REASONS[ctx.reason ?? ''];
      if (known) return { code: known[0], message: known[1] };
      return { code: 'PAYMENT_NOT_ELIGIBLE', message: 'Ce compte ne peut pas effectuer cet achat.' };
    }
    if (!client) {
      return { code: 'PAYMENTS_NOT_CONFIGURED', message: 'Le service de paiement n’est pas configuré côté serveur.' };
    }
    if (client.mode !== ctx.mode) {
      return {
        code: 'PAYMENT_MODE_MISMATCH',
        message: 'La clé de paiement installée ne correspond pas au mode configuré (test ou production).',
      };
    }
    return null;
  }

  function assertReady(ctx: QuoteContext): SasPayClient {
    const reason = unavailableReason(ctx);
    if (reason) {
      const status = reason.code === 'PAYMENT_NOT_ELIGIBLE' ? 403
        : reason.code.startsWith('BUSINESS_SUBSCRIPTION') || reason.code.startsWith('BUSINESS_PLAN') ? 409 : 503;
      throw new PaymentError(reason.code, status, reason.message);
    }
    return client as SasPayClient;
  }

  /** Options de paiement et devis (prix serveur + frais estimés par réseau). */
  async function options(user: PaymentUser, input: { product: unknown; item?: unknown }) {
    if (!isProduct(input.product)) throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Produit inconnu.');
    const product = input.product;
    const item = input.item === undefined || input.item === null ? {} : parseItem(product, input.item);
    const ctx = await store.quote(user.id, product, item);
    const reason = unavailableReason(ctx);
    const rows = reason ? null : await rates();
    const amount = ctx.price?.amount ?? null;
    return {
      product,
      available: reason === null,
      reason: reason?.code ?? null,
      message: reason?.message ?? null,
      mode: ctx.mode,
      flows: ctx.flows,
      price: ctx.price,
      countries: Object.entries(ctx.countries).map(([code, country]) => ({
        code,
        name: country.name ?? code,
        currency: country.currency ?? null,
        dial_code: country.dial_code ?? null,
        national_number_length: country.national_number_length ?? null,
        networks: (country.networks ?? []).map((network) => networkOption(rows, code, network, amount)),
      })),
    };
  }

  /** Interroge SasPay puis règle la commande selon le statut VÉRIFIÉ. */
  async function sync(
    order: OrderRecord, source: SettleInput['source'], knownPaymentId: string | null = null,
  ): Promise<SettleResult> {
    const sasPay = client;
    if (!sasPay) throw new PaymentError('PAYMENTS_NOT_CONFIGURED', 503, 'Le service de paiement n’est pas configuré côté serveur.');
    let paymentId = order.provider_payment_id ?? knownPaymentId;

    if (!paymentId && order.provider_session_id) {
      const session = await sasPay.checkoutStatus(order.provider_session_id);
      if (session.transaction_id) {
        paymentId = session.transaction_id;
      } else if (session.status === 'EXPIRED' || session.status === 'CANCELLED') {
        return store.settle(order.product, order.id, {
          paymentId: null, status: 'CANCELLED', requestedAmount: null, currency: null, fee: null,
          charged: null, net: null, feeMode: null, reference: null, source,
          failureCode: `checkout_${session.status.toLowerCase()}`,
        });
      }
      // Session `PAID` sans transaction vérifiable : on ne livre pas.
    }
    if (!paymentId) return { ...order, outcome: 'pending', credited: false };

    const tx: VerifiedPayment = await sasPay.verifyPayment(paymentId);
    if (tx.id !== paymentId) {
      throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Paiement vérifié différent du paiement demandé');
    }
    const requested = normalizeDecimal(tx.requested_amount);
    const charged = normalizeDecimal(tx.debited_amount);
    // Frais réellement supportés par le payeur : montant débité − montant demandé.
    let fee = normalizeDecimal(tx.client_fee);
    const requestedScaled = parseDecimal(requested);
    const chargedScaled = parseDecimal(charged);
    if (requestedScaled !== null && chargedScaled !== null && chargedScaled >= requestedScaled) {
      fee = formatDecimal(chargedScaled - requestedScaled);
    }
    return store.settle(order.product, order.id, {
      paymentId, status: tx.status, requestedAmount: requested, currency: tx.currency,
      fee, charged, net: normalizeDecimal(tx.net_amount), feeMode: tx.fee_charge_mode,
      reference: tx.reference, source,
    });
  }

  function nextStep(order: OrderRecord): 'redirect' | 'await_confirmation' | 'done' | 'retry' {
    const state = paymentState(order);
    if (state === 'confirmed' || state === 'failed' || state === 'cancelled') return 'done';
    if (state === 'todo') return 'retry';
    return order.checkout_url ? 'redirect' : 'await_confirmation';
  }

  /** Crée la commande (montant figé côté serveur) puis initie le paiement chez SasPay. */
  async function create(
    user: PaymentUser,
    input: {
      product: unknown; item: unknown; country: unknown; flow: unknown; network?: unknown;
      phone?: unknown; idempotency_key: unknown;
    },
    context: { returnUrl?: (order: OrderRecord) => string | null } = {},
  ) {
    if (!isProduct(input.product)) throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Produit inconnu.');
    const product = input.product;
    const item = parseItem(product, input.item);
    const flow = input.flow;
    if (flow !== 'softpay' && flow !== 'checkout') {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Parcours de paiement inconnu.');
    }
    const idempotencyKey = typeof input.idempotency_key === 'string' ? input.idempotency_key : '';
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(idempotencyKey)) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Identifiant d’opération invalide.');
    }
    const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Pays invalide.');
    if (!user.email) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Une adresse e-mail est requise pour payer.');
    }

    const ctx = await store.quote(user.id, product, item);
    const sasPay = assertReady(ctx);
    const countryConfig = ctx.countries[country];
    if (!countryConfig) throw new PaymentError('PAYMENT_COUNTRY_NOT_SUPPORTED', 422, 'Ce pays n’est pas pris en charge pour le paiement.');
    if (!ctx.flows.includes(flow)) throw new PaymentError('PAYMENT_FLOW_NOT_ALLOWED', 422, 'Ce parcours de paiement n’est pas activé.');
    if (!ctx.price) throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Produit à payer invalide.');

    let network: string | null = null;
    let msisdn: string | null = null;
    let quote: FeeQuote | null = null;
    if (flow === 'softpay') {
      network = typeof input.network === 'string' ? input.network : '';
      const declared = (countryConfig.networks ?? []).find((n) => n.code === network);
      if (!declared) throw new PaymentError('PAYMENT_NETWORK_NOT_SUPPORTED', 422, 'Ce moyen de paiement n’est pas proposé.');
      msisdn = normalizeMsisdn(input.phone, countryConfig);
      if (!msisdn) {
        throw new PaymentError('PAYMENT_INVALID_PHONE', 422,
          `Numéro de téléphone invalide. Saisissez un numéro ${countryConfig.name ?? country} à ${countryConfig.national_number_length ?? 8} chiffres.`);
      }
      const option = networkOption(await rates(), country, declared, ctx.price.amount);
      if (!option.available) throw new PaymentError('PAYMENT_NETWORK_UNAVAILABLE', 422, PROVIDER_CODE_MESSAGES.invalid_method);
      if (option.otp_required) throw new PaymentError('PAYMENT_NETWORK_REQUIRES_OTP', 422, PROVIDER_CODE_MESSAGES.prepayment_otp_missing);
      quote = option.fee;
    } else if (typeof input.phone === 'string' && input.phone.trim()) {
      msisdn = normalizeMsisdn(input.phone, countryConfig);
    }

    const order = await store.createOrder({
      userId: user.id, product, item, country, flow, network, idempotencyKey,
      quotedFee: quote?.fee ?? null, quotedTotal: quote?.total ?? null, quotedFeeMode: quote?.mode ?? null,
      msisdnMasked: msisdn ? maskMsisdn(msisdn) : null,
    });

    // Rejeu de la même intention : aucun second paiement n'est initié.
    if (order.status !== 'pending' || order.provider_payment_id || order.provider_session_id) {
      return { order: publicOrder(order), next: nextStep(order), reused: true };
    }

    const { first, last } = splitName(user.name, user.email);
    const metadata = { order_reference: order.internal_reference, product };
    const description = order.label.slice(0, 120);
    try {
      let attached: OrderRecord;
      if (flow === 'softpay') {
        // `Idempotency-Key` = référence interne : un rejeu réseau renvoie le paiement d'origine.
        const result = await sasPay.softpay({
          amount: order.amount, currency: order.currency, country: order.country, network: network as string,
          customer: { email: user.email, first_name: first, last_name: last, phone: msisdn as string },
          description, metadata,
        }, order.internal_reference);
        attached = await store.attach(product, order.id, {
          paymentId: result.id, sessionId: null, checkoutUrl: result.checkout_url, providerStatus: result.status,
        });
      } else {
        const returnUrl = context.returnUrl?.(order) ?? null;
        const result = await sasPay.createCheckoutSession({
          amount: order.amount, currency: order.currency,
          customer_email: user.email, customer_name: `${first} ${last}`.trim(),
          description, country: order.country, metadata,
          ...(msisdn ? { customer_phone: msisdn } : {}),
          ...(returnUrl ? { return_url: returnUrl } : {}),
        });
        try {
          attached = await store.attach(product, order.id, {
            paymentId: null, sessionId: result.id, checkoutUrl: result.checkout_url, providerStatus: result.status,
          });
        } catch (error) {
          // SasPay n'offre pas d'idempotence sur les sessions : deux requêtes
          // simultanées créent deux sessions. La première rattachée fait foi ;
          // l'autre n'est jamais communiquée au client (donc jamais payée).
          if (!(error instanceof PaymentError) || error.code !== 'PAYMENT_REFERENCE_CONFLICT') throw error;
          const current = await store.getOrder(product, order.id);
          if (!current) throw error;
          log('saspay_checkout_session_discarded', { product, order: order.id });
          return { order: publicOrder(current), next: nextStep(current), reused: true };
        }
      }
      log('saspay_payment_initiated', { product, order: order.id, flow, network });
      return { order: publicOrder(attached), next: nextStep(attached), reused: order.reused };
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      log('saspay_initiation_failed', { product, order: order.id, flow, status: error.status, code: error.code });
      if (error.definitive) {
        // Refus certain : aucun paiement n'existe chez SasPay, la commande est close.
        await store.settle(product, order.id, {
          paymentId: null, status: 'FAILED', requestedAmount: null, currency: null, fee: null, charged: null,
          net: null, feeMode: null, reference: null, source: 'initiate', failureCode: error.code,
        });
      }
      // Sinon la commande reste « à effectuer » : la même intention peut être rejouée.
      throw fromSasPayError(error, { order_id: order.id, retryable: error.retryable });
    }
  }

  /** Statut d'une commande, revérifié auprès de SasPay si elle n'est pas réglée. */
  async function refresh(user: PaymentUser, input: { product: unknown; order_id: unknown }) {
    if (!isProduct(input.product) || typeof input.order_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.order_id)) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Commande invalide.');
    }
    const order = await store.getOrder(input.product, input.order_id);
    // Même réponse pour « inexistante » et « à quelqu'un d'autre » : rien ne fuit.
    if (!order || (order.user_id !== user.id && !(await store.isAdmin(user.id)))) {
      throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
    }
    const untouched = { order: publicOrder(order), verified: false, credited: false, message: null as string | null };
    if (order.status === 'paid' || order.status === 'refunded') return { ...untouched, verified: true };
    if (!order.provider_payment_id && !order.provider_session_id) return untouched;
    const lastVerified = order.last_verified_at ? Date.parse(order.last_verified_at) : 0;
    if (Number.isFinite(lastVerified) && deps.now() - lastVerified < minVerifyIntervalMs) return untouched;
    if (!client) return { ...untouched, message: 'Le service de paiement n’est pas configuré côté serveur.' };
    try {
      const result = await sync(order, 'verify');
      const message = result.outcome === 'amount_mismatch'
        ? 'Le montant reçu ne correspond pas à la commande. Le support a été alerté ; aucun crédit n’a été accordé.'
        : null;
      return { order: publicOrder(result), verified: true, credited: result.credited, message };
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      log('saspay_verify_failed', { product: order.product, order: order.id, status: error.status, code: error.code });
      return { ...untouched, message: fromSasPayError(error).message };
    }
  }

  /** Traite un webhook SasPay. Le statut annoncé n'est jamais cru : il est revérifié. */
  async function webhook(rawBody: string, headers: { signature: string | null; timestamp: string | null }) {
    if (!deps.webhookSecret) {
      throw new PaymentError('WEBHOOK_NOT_CONFIGURED', 503, 'Secret de webhook absent.');
    }
    const check = await verifyWebhookSignature({
      secret: deps.webhookSecret, signature: headers.signature, timestamp: headers.timestamp,
      rawBody, nowSeconds: Math.floor(deps.now() / 1000),
    });
    if (!check.ok) {
      log('saspay_webhook_rejected', { reason: check.reason });
      throw new PaymentError('WEBHOOK_SIGNATURE_INVALID', 401, 'Signature de webhook invalide.', { reason: check.reason });
    }

    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { body = null; }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new PaymentError('WEBHOOK_INVALID_BODY', 400, 'Corps de webhook invalide.');
    }
    const envelope = body as { event?: unknown; data?: unknown };
    const event = typeof envelope.event === 'string' ? envelope.event : '';
    if (!(HANDLED_WEBHOOK_EVENTS as readonly string[]).includes(event)) {
      return { received: true, ignored: true, reason: 'event_not_handled' };
    }
    const data = (typeof envelope.data === 'object' && envelope.data !== null ? envelope.data : {}) as Record<string, unknown>;
    const paymentId = typeof data.id === 'string' ? data.id.trim() : '';
    if (!/^[A-Za-z0-9-]{8,64}$/.test(paymentId)) {
      throw new PaymentError('WEBHOOK_INVALID_BODY', 400, 'Identifiant de transaction invalide.');
    }
    if (!client) throw new PaymentError('PAYMENTS_NOT_CONFIGURED', 503, 'Clé SasPay absente : vérification impossible.');

    let match = await store.findOrder({ paymentId, sessionId: null });
    if (!match) {
      // Parcours hébergé : la transaction n'est connue qu'après paiement.
      for (const candidate of await store.openCheckoutOrders(10)) {
        try {
          const session = await client.checkoutStatus(candidate.sessionId);
          if (session.transaction_id === paymentId) {
            match = { product: candidate.product, orderId: candidate.orderId };
            break;
          }
        } catch { /* session illisible : candidat suivant */ }
      }
    }
    // Le compte marchand peut servir d'autres produits : transaction inconnue = ignorée.
    if (!match) return { received: true, ignored: true, reason: 'unknown_transaction' };

    const eventKey = `${event}:${paymentId}`;
    const pick = (value: unknown) => (typeof value === 'string' ? value.slice(0, 80) : null);
    const seen = await store.recordWebhook(match.product, eventKey, event, {
      event, id: paymentId, status: pick(data.status), amount: pick(data.amount),
      currency: pick(data.currency), reference: pick(data.reference),
    });
    if (seen.processed) return { received: true, duplicate: true };

    try {
      const order = await store.getOrder(match.product, match.orderId);
      if (!order) throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
      const result = await sync(order, 'webhook', paymentId);
      await store.finishWebhook(match.product, eventKey, true);
      log('saspay_webhook_processed', { product: match.product, order: match.orderId, outcome: result.outcome });
      return { received: true, outcome: result.outcome, credited: result.credited };
    } catch (error) {
      const code = error instanceof SasPayError || error instanceof PaymentError ? error.code : 'unexpected_error';
      await store.finishWebhook(match.product, eventKey, false, code).catch(() => undefined);
      log('saspay_webhook_failed', { product: match.product, order: match.orderId, code });
      // 503 : SasPay retentera ; le traitement est idempotent.
      throw new PaymentError('WEBHOOK_PROCESSING_FAILED', 503, 'Traitement du webhook momentanément impossible.');
    }
  }

  /** Soldes marchands SasPay — lecture seule, réservée aux administrateurs. */
  async function balances(user: PaymentUser) {
    if (!(await store.isAdmin(user.id))) {
      throw new PaymentError('PAYMENT_FORBIDDEN', 403, 'Réservé aux administrateurs.');
    }
    if (!client) {
      return { configured: false, mode: null, balances: [], message: 'Aucune clé SasPay n’est installée côté serveur.' };
    }
    try {
      // Un portefeuille par pays : la liste n'est jamais fusionnée ni additionnée.
      return { configured: true, mode: client.mode, balances: await client.merchantBalances(), message: null };
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      log('saspay_balances_failed', { status: error.status, code: error.code });
      throw fromSasPayError(error);
    }
  }

  return { options, create, refresh, webhook, balances };
}

export type PaymentService = ReturnType<typeof createPaymentService>;

/** Message de journal sûr pour une erreur quelconque. */
export function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
