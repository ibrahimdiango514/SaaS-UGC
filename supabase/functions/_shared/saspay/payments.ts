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
  type FoundTransaction, type SasPayClient, type SoftpayRequest, type SoftpayResult,
  type TransactionStatus, type VerifiedPayment,
} from './client.ts';
import { normalizeDecimal, parseDecimal, formatDecimal, quoteFee, selectTier, type FeeQuote, type RateTier } from './money.ts';
import { verifyWebhookSignature } from './webhook.ts';

export type Product = 'studio' | 'business';
export type PaymentFlow = 'softpay' | 'checkout';
export type OrderStatus = 'pending' | 'processing' | 'paid' | 'failed' | 'cancelled' | 'refunded';
/** États présentés à l'utilisateur. */
/**
 * États présentés à l'utilisateur. `unapplied` : paiement ENCAISSÉ mais que la
 * base a refusé d'activer (Business Grow, abonnement incompatible) — rien n'a
 * été livré, l'argent est à rendre par le support. État final.
 */
export type PaymentState = 'todo' | 'pending' | 'confirmed' | 'failed' | 'cancelled' | 'unapplied'
  /**
   * `review` : une demande softpay est partie chez SasPay sans que sa réponse
   * ne revienne. On ignore si le client a été débité : la commande n'est NI
   * payée NI non payée tant qu'une preuve (ou un administrateur) n'a pas tranché.
   */
  | 'review';
export type SettleOutcome =
  | 'paid' | 'already_paid' | 'pending' | 'failed' | 'cancelled' | 'amount_mismatch'
  /** Business Grow : encaissement incompatible avec l'abonnement en cours — rien n'est livré, définitivement. */
  | 'subscription_conflict';

export const PRODUCTS: readonly Product[] = ['studio', 'business'];
export const HANDLED_WEBHOOK_EVENTS = ['transaction.success', 'transaction.failed', 'transaction.cancelled'] as const;

export interface OrderRecord {
  product: Product;
  id: string;
  /**
   * Mode de frais à demander à SasPay, d'après le devis figé (`DEDUCTED` sous la
   * politique de prix). Renvoyé par la création de commande uniquement.
   */
  requested_fee_mode?: string | null;
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
  source: 'verify' | 'webhook' | 'initiate' | 'reconcile';
  failureCode?: string | null;
}

export type SettleResult = OrderRecord & { outcome: SettleOutcome; credited: boolean };

export interface CountryConfig {
  name?: string;
  currency?: string;
  dial_code?: string;
  national_number_length?: number;
  networks?: Array<{ code: string; label?: string }>;
  /** Prix final de l'article dans ce pays (tout compris), calculé par la base. */
  price?: { amount: string; currency: string };
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
  /** Vrai sous la politique de prix : le prix affiché est final, aucun frais ne s'y ajoute. */
  all_inclusive?: boolean;
  /** Sans article : prix finals du catalogue (fourchette entre pays). */
  catalog?: Record<string, { amount: string; max_amount: string; currency: string }> | null;
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

  // Réconciliation (tâche planifiée).
  /** Jeton serveur de la tâche planifiée (Vault). `null` s'il n'existe pas. */
  reconcileToken(): Promise<string | null>;
  /** Ouvre une exécution ; `null` si une autre est déjà en cours. */
  reconcileStart(source: string): Promise<string | null>;
  reconcileBatch(limit: number): Promise<ReconcileBatch>;
  reconcileFinish(runId: string, status: 'ok' | 'partial' | 'error', counts: ReconcileCounts & { detail?: Record<string, unknown> }): Promise<void>;
  findOrderByReference(reference: string): Promise<{ product: Product; orderId: string } | null>;
  reportAnomaly(anomaly: PaymentAnomaly): Promise<boolean>;

  // Création softpay restée sans réponse.
  /**
   * Enregistre une tentative AVANT l'appel SasPay et renvoie le corps à
   * envoyer (celui de la première tentative, à l'identique). Refuse hors
   * fenêtre de rejeu, en rapprochement manuel, ou si un autre paiement du même
   * client est incertain.
   */
  beginInitiation(product: Product, orderId: string, request: SoftpayRequest): Promise<InitiationTicket>;
  /** L'appel s'est terminé sans issue certaine. */
  initiationUnknown(product: Product, orderId: string, error: string): Promise<void>;
  /**
   * `dueOnly` : commandes incertaines dont la recherche SasPay est due.
   * Sinon : toutes les tentatives non soldées, appel encore en vol compris.
   */
  unconfirmedOrders(limit: number, dueOnly: boolean): Promise<UnconfirmedOrder[]>;
  noteCandidates(product: Product, orderId: string, candidates: PaymentCandidate[]): Promise<void>;
  /** Ajoute une transaction annoncée par un webhook aux candidates d'une commande incertaine. */
  addCandidate(product: Product, orderId: string, candidate: PaymentCandidate): Promise<void>;
  /** Trace la décision d'un administrateur de rattacher un paiement. */
  reviewAttached(adminId: string, product: Product, orderId: string, paymentId: string, note: string): Promise<void>;
  /** Import des tarifs du compte dans le barème (contrôles et historisation faits en base). */
  importRates(adminId: string, rates: unknown[]): Promise<{ inserted: number; unchanged: number; closed: number; skipped: number }>;
}

export type InitiationTicket =
  | { allowed: true; attempt: number; request: SoftpayRequest; replayUntil: string | null }
  | {
    allowed: false;
    /**
     * `attempt_in_progress` : un appel est en vol pour CETTE commande ;
     * `other_payment_*` : une autre commande du client n'est pas soldée.
     */
    reason: 'not_pending' | 'under_review' | 'attempt_in_progress' | 'other_payment_unconfirmed' | 'other_payment_in_progress';
  };

export interface UnconfirmedOrder {
  product: Product;
  orderId: string;
  internalReference: string;
  /** Numéro complet du payeur (jamais journalisé, jamais renvoyé au navigateur). */
  phone: string | null;
  amount: string | null;
  currency: string | null;
  firstAttemptAt: string;
  lastAttemptAt: string;
  inReview: boolean;
}

/** Transaction SasPay qui POURRAIT être celle d'une commande incertaine. */
export interface PaymentCandidate {
  id: string;
  reference: string | null;
  status: string | null;
  amount: string | null;
  currency: string | null;
  created_at: string | null;
  /** Vrai si SasPay a restitué un libellé pour cette transaction (sans notre référence). */
  described: boolean;
  /** D'où vient la piste : recherche par numéro, ou webhook d'une transaction inconnue. */
  source?: 'search' | 'webhook';
  /** Webhook seulement : le numéro débité annoncé est-il celui de la commande ? */
  msisdn_match?: boolean | null;
}

export interface ReconcileBatch {
  due: Array<{ product: Product; orderId: string }>;
  /** Vrai si le balayage des encaissements SasPay est dû. */
  sweep: boolean;
  /** Borne basse du balayage (ISO 8601). */
  sweepSince: string;
  /** Créations softpay restées sans réponse, à rechercher chez SasPay par numéro. */
  unconfirmed: UnconfirmedOrder[];
}

export interface ReconcileCounts {
  checked: number;
  settled: number;
  closed: number;
  errors: number;
  swept: number;
  anomalies: number;
  sweep_done: boolean;
}

export type AnomalyKind =
  | 'order_stuck' | 'duplicate_payment' | 'payment_conflict' | 'amount_mismatch' | 'payment_not_found'
  | 'subscription_conflict' | 'sweep_unreliable' | 'initiation_unconfirmed';

export interface PaymentAnomaly {
  kind: AnomalyKind;
  product: Product | null;
  orderId: string | null;
  paymentId: string | null;
  reference: string | null;
  details: Record<string, unknown>;
}

/** Référence interne VYORA (`VYS-…` Studio, `VYB-…` Business Grow) présente dans un texte. */
export function orderReferenceIn(value: string | null | undefined): string | null {
  return /(?:^|[^A-Za-z0-9])(VY[SB]-[0-9A-F]{32})(?![A-Za-z0-9])/.exec(value ?? '')?.[1] ?? null;
}

/** Comparaison à temps constant (longueurs égales uniquement). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  /** Pause avant le rejeu immédiat d'une création softpay sans réponse (défaut 2 s). */
  replayDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
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

/** Motifs de refus d'activation d'un encaissement Business Grow (posés par la base, définitifs). */
export const SUBSCRIPTION_CONFLICT_CODES: readonly string[] = [
  'business_plan_change_not_supported', 'business_subscription_managed_elsewhere',
];

export const SUBSCRIPTION_CONFLICT_MESSAGE = 'Votre paiement a bien été reçu, mais il n’a pas pu être appliqué '
  + 'à votre abonnement en cours. Rien n’a été modifié sur votre abonnement. '
  + 'Le support a été alerté et vous remboursera intégralement.';

/**
 * Marqueurs d'une commande softpay dont l'appel de création n'a pas rendu de
 * réponse exploitable. `initiation_unconfirmed` : la même demande peut encore
 * être rejouée (même clé d'idempotence). `manual_review` : fenêtre de rejeu
 * close, un administrateur doit rapprocher.
 */
export const UNCONFIRMED_CODES: readonly string[] = ['initiation_unconfirmed', 'manual_review'];

export const UNCONFIRMED_MESSAGE = 'Le service de paiement n’a pas confirmé cette demande : elle a peut-être '
  + 'été envoyée sur votre téléphone. Ne payez pas une seconde fois. Vous pouvez relancer cette même demande '
  + '— ce n’est pas un nouveau paiement. ' + NO_DELIVERY;

export const REVIEW_MESSAGE = 'Votre paiement est en cours de vérification par notre équipe. '
  + 'Ne payez pas une seconde fois. Si vous avez été débité, votre achat sera livré ; '
  + 'sinon la commande sera annulée sans frais.';

export const OTHER_UNCONFIRMED_MESSAGE = 'Un de vos paiements est en cours de vérification. '
  + 'Aucun autre paiement ne peut être lancé tant qu’il n’est pas confirmé ou annulé.';

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
export function paymentState(
  order: Pick<OrderRecord, 'status' | 'provider_payment_id' | 'provider_session_id'> & { failure_code?: string | null },
): PaymentState {
  if (order.status === 'paid' || order.status === 'refunded') return 'confirmed';
  // Encaissé mais non activable : ni « en attente » (plus rien à attendre), ni
  // « échoué » (le client a bien été débité).
  if (order.failure_code && SUBSCRIPTION_CONFLICT_CODES.includes(order.failure_code)) return 'unapplied';
  if (order.status === 'failed') return 'failed';
  if (order.status === 'cancelled') return 'cancelled';
  if (order.status === 'processing' || order.provider_payment_id || order.provider_session_id) return 'pending';
  // Demande partie chez SasPay sans réponse : ni « à effectuer » (elle a pu
  // aboutir), ni « en attente » (aucun paiement identifié à suivre).
  if (order.failure_code && UNCONFIRMED_CODES.includes(order.failure_code)) return 'review';
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
  // Frais déduits : le client paie le prix affiché, point. Le montant des frais
  // (estimé ou réel) et le net reçu par VYORA sont des données internes.
  if (order.quoted_fee_mode === 'DEDUCTED' || order.fee_charge_mode === 'DEDUCTED') {
    delete view.quoted_fee_amount;
    delete view.fee_amount;
    delete view.net_amount;
  }
  view.state = paymentState(order);
  // En vérification : la MÊME demande peut être relancée tant que la fenêtre de
  // rejeu est ouverte (le serveur tranche à chaque relance).
  if (view.state === 'review') view.retry_allowed = order.failure_code === 'initiation_unconfirmed';
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
  const replayDelayMs = deps.replayDelayMs ?? 2_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
    const allInclusive = ctx.all_inclusive === true;
    return {
      product,
      available: reason === null,
      reason: reason?.code ?? null,
      message: reason?.message ?? null,
      mode: ctx.mode,
      flows: ctx.flows,
      price: ctx.price,
      // Prix tout compris : ce qui est affiché est ce qui est débité.
      all_inclusive: allInclusive,
      catalog: ctx.catalog ?? null,
      countries: Object.entries(ctx.countries).map(([code, country]) => ({
        code,
        name: country.name ?? code,
        currency: country.currency ?? null,
        dial_code: country.dial_code ?? null,
        national_number_length: country.national_number_length ?? null,
        price: country.price ?? null,
        networks: (country.networks ?? []).map((network) => {
          const option = networkOption(rows, code, network, country.price?.amount ?? amount);
          // Sous la politique de prix, aucun frais n'est annoncé en sus : les
          // frais SasPay sont déduits de ce que VYORA reçoit.
          return allInclusive ? { ...option, fee: null } : option;
        }),
      })),
    };
  }

  /** Interroge SasPay puis règle la commande selon le statut VÉRIFIÉ. */
  /**
   * Encaissement Business Grow que la base a refusé d'activer : signalé tout de
   * suite (une seule ligne par commande), quel que soit le chemin qui l'a vu.
   */
  async function flagSubscriptionConflict(order: OrderRecord): Promise<void> {
    log('saspay_subscription_conflict', { product: order.product, order: order.id, code: order.failure_code });
    await store.reportAnomaly({
      kind: 'subscription_conflict', product: order.product, orderId: order.id,
      paymentId: order.provider_payment_id, reference: order.internal_reference,
      details: { reason: order.failure_code, plan_key: order.plan_key ?? null, amount: order.amount, currency: order.currency },
    }).catch(() => undefined);
  }

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
    const net = normalizeDecimal(tx.net_amount);
    // Frais réellement prélevés par SasPay = montant débité au client − net
    // reçu par VYORA. Vrai dans les deux modes : frais ajoutés (débité =
    // demandé + frais, net = demandé) comme frais déduits (débité = demandé,
    // net = demandé − frais). « Débité − demandé » vaudrait toujours zéro en
    // frais déduits et masquerait le coût réel.
    let fee = normalizeDecimal(tx.client_fee);
    const requestedScaled = parseDecimal(requested);
    const chargedScaled = parseDecimal(charged);
    const netScaled = parseDecimal(net);
    if (chargedScaled !== null && netScaled !== null && chargedScaled >= netScaled) {
      fee = formatDecimal(chargedScaled - netScaled);
    } else if (requestedScaled !== null && chargedScaled !== null && chargedScaled >= requestedScaled) {
      fee = formatDecimal(chargedScaled - requestedScaled);
    }
    // Le mode de frais demandé n'est appliqué par SasPay que si le compte
    // l'autorise ; sinon il est ignoré sans erreur. On le signale : en frais
    // ajoutés, le client paie plus que le prix affiché.
    if (order.requested_fee_mode && tx.status === 'SUCCESS' && tx.fee_charge_mode
      && tx.fee_charge_mode !== order.requested_fee_mode) {
      log('payment_fee_mode_ignored', {
        product: order.product, order_id: order.id, requested: order.requested_fee_mode, applied: tx.fee_charge_mode,
      });
    }
    return store.settle(order.product, order.id, {
      paymentId, status: tx.status, requestedAmount: requested, currency: tx.currency,
      fee, charged, net, feeMode: tx.fee_charge_mode,
      reference: tx.reference, source,
    });
  }

  function nextStep(order: OrderRecord): 'redirect' | 'await_confirmation' | 'done' | 'retry' | 'review' {
    const state = paymentState(order);
    if (state === 'confirmed' || state === 'failed' || state === 'cancelled' || state === 'unapplied') return 'done';
    if (state === 'review') return 'review';
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
      return { order: publicOrder(order), next: nextStep(order), reused: true, message: null as string | null };
    }

    const { first, last } = splitName(user.name, user.email);
    const metadata = { order_reference: order.internal_reference, product };
    // La référence interne figure dans le libellé et les métadonnées transmis à
    // SasPay. Si SasPay les restitue (sa spécification ne le garantit pas), ils
    // permettent de reconnaître un paiement dont l'identifiant s'est perdu.
    const description = `${order.label.slice(0, 80)} — ${order.internal_reference}`;
    // Prix tout compris : on demande à SasPay de déduire ses frais du montant
    // reversé (le client est débité exactement du prix affiché). Le mode vient
    // du devis figé sur la commande : un rejeu envoie donc le même corps.
    const feeMode = order.requested_fee_mode === 'DEDUCTED' ? { fee_charge_mode: 'DEDUCTED' as const } : {};

    if (flow === 'softpay') {
      return initiateSoftpay(order, {
        amount: order.amount, currency: order.currency, country: order.country, network: network as string,
        customer: { email: user.email, first_name: first, last_name: last, phone: msisdn as string },
        description, metadata, ...feeMode,
      });
    }

    try {
      const returnUrl = context.returnUrl?.(order) ?? null;
      const result = await sasPay.createCheckoutSession({
        amount: order.amount, currency: order.currency,
        customer_email: user.email, customer_name: `${first} ${last}`.trim(),
        description, country: order.country, metadata, ...feeMode,
        ...(msisdn ? { customer_phone: msisdn } : {}),
        ...(returnUrl ? { return_url: returnUrl } : {}),
      });
      let attached: OrderRecord;
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
        return { order: publicOrder(current), next: nextStep(current), reused: true, message: null as string | null };
      }
      log('saspay_payment_initiated', { product, order: order.id, flow, network });
      return { order: publicOrder(attached), next: nextStep(attached), reused: order.reused, message: null as string | null };
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      log('saspay_initiation_failed', { product, order: order.id, flow, status: error.status, code: error.code });
      if (error.definitive) {
        // Refus certain : aucune session n'existe chez SasPay, la commande est close.
        await store.settle(product, order.id, {
          paymentId: null, status: 'FAILED', requestedAmount: null, currency: null, fee: null, charged: null,
          net: null, feeMode: null, reference: null, source: 'initiate', failureCode: error.code,
        });
      }
      // Sinon la commande reste « à effectuer ». Une session dont la réponse
      // s'est perdue n'a jamais été montrée au client : elle ne peut pas être payée.
      throw fromSasPayError(error, { order_id: order.id, retryable: error.retryable });
    }
  }

  /** Vue renvoyée au client pour une commande dont la création softpay est sans réponse. */
  async function unconfirmedView(order: OrderRecord, reused: boolean, sent = false) {
    // `sent` : la demande est partie vers SasPay. Si la commande ne peut pas être
    // relue, elle est présentée « en vérification » — jamais « à effectuer ».
    const current = await store.getOrder(order.product, order.id).catch(() => null)
      ?? (sent ? { ...order, failure_code: 'initiation_unconfirmed' } : order);
    const state = paymentState(current);
    const message = state !== 'review' ? null
      : current.failure_code === 'initiation_unconfirmed' ? UNCONFIRMED_MESSAGE : REVIEW_MESSAGE;
    return { order: publicOrder(current), next: nextStep(current), reused, message };
  }

  /**
   * Pousse la demande softpay. La tentative est enregistrée AVANT l'appel, avec
   * le corps exact : tout rejeu (immédiat ici, ou relance du client) renvoie ce
   * même corps avec la même `Idempotency-Key`, seule garantie documentée par
   * SasPay de retrouver un paiement dont la réponse s'est perdue.
   */
  async function initiateSoftpay(order: OrderRecord & { reused: boolean }, body: SoftpayRequest) {
    const sasPay = client as SasPayClient;
    const product = order.product;
    const ticket = await store.beginInitiation(product, order.id, body);
    if (!ticket.allowed) {
      log('saspay_initiation_not_allowed', { product, order: order.id, reason: ticket.reason });
      if (ticket.reason === 'other_payment_unconfirmed') {
        throw new PaymentError('PAYMENT_UNDER_REVIEW', 409, OTHER_UNCONFIRMED_MESSAGE, { order_id: order.id });
      }
      if (ticket.reason === 'other_payment_in_progress') {
        throw new PaymentError('PAYMENT_ALREADY_IN_PROGRESS', 409,
          'Un autre paiement est en cours d’envoi. Patientez quelques secondes puis vérifiez son statut.',
          { order_id: order.id });
      }
      if (ticket.reason === 'attempt_in_progress') {
        // Double clic : la même demande est déjà en vol. On attend son issue
        // (quelques secondes) au lieu d'en envoyer une seconde.
        for (let wait = 0; wait < 4; wait += 1) {
          await sleep(replayDelayMs);
          const current = await store.getOrder(product, order.id).catch(() => null);
          if (current && paymentState(current) !== 'review') {
            return { order: publicOrder(current), next: nextStep(current), reused: true, message: null };
          }
        }
      }
      // Rapprochement manuel, issue encore inconnue, ou commande rattachée
      // entre-temps : aucun appel SasPay, l'état est dit tel quel.
      return unconfirmedView(order, true);
    }

    // Une tentative antérieure est restée sans réponse : un refus d'accès reçu
    // maintenant (clé changée, compte suspendu) ne dit rien de la première.
    const afterUnknown = ticket.attempt > 1;
    let result: SoftpayResult | null = null;
    let failure: SasPayError | null = null;
    let certain = false;
    let sawUncertain = false;
    // Un appel, puis UN rejeu immédiat si l'issue est inconnue : le client est
    // encore devant son écran, la demande reste celle qu'il attend.
    for (let call = 0; call < 2 && !result; call += 1) {
      if (call > 0) await sleep(replayDelayMs);
      try {
        result = await sasPay.softpay(ticket.request, order.internal_reference);
      } catch (error) {
        if (!(error instanceof SasPayError)) {
          // Erreur imprévue pendant l'appel : la requête est peut-être partie.
          // Répondre « erreur, rien n'a été débité » serait une affirmation gratuite.
          await store.initiationUnknown(product, order.id, 'unexpected_error').catch(() => undefined);
          log('saspay_initiation_failed', {
            product, order: order.id, flow: 'softpay', code: 'unexpected_error', call: call + 1, certain: false,
            message: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
          });
          return unconfirmedView(order, order.reused, true);
        }
        failure = error;
        const blind = (afterUnknown || sawUncertain) && (error.kind === 'unauthorized' || error.kind === 'forbidden');
        // Limite de débit : SasPay a écarté la requête sans la traiter. Si aucune
        // tentative antérieure n'est incertaine, aucun paiement ne peut exister.
        const throttled = error.kind === 'rate_limited' && !afterUnknown && !sawUncertain;
        certain = (error.definitive && !blind) || throttled;
        if (!certain) sawUncertain = true;
        log('saspay_initiation_failed', {
          product, order: order.id, flow: 'softpay', status: error.status, code: error.code, call: call + 1, certain,
        });
        if (certain) break;
      }
    }

    if (result) {
      try {
        const attached = await store.attach(product, order.id, {
          paymentId: result.id, sessionId: null, checkoutUrl: result.checkout_url, providerStatus: result.status,
        });
        log('saspay_payment_initiated', { product, order: order.id, flow: 'softpay', network: order.network_code, attempt: ticket.attempt });
        return { order: publicOrder(attached), next: nextStep(attached), reused: order.reused, message: null };
      } catch (error) {
        // Le paiement existe chez SasPay mais son identifiant n'a pas pu être
        // enregistré : même situation qu'une réponse perdue. Le client reçoit
        // peut-être la demande sur son téléphone : on ne lui dit pas « erreur ».
        await store.initiationUnknown(product, order.id, 'attach_failed').catch(() => undefined);
        log('saspay_attach_failed', {
          product, order: order.id, code: error instanceof PaymentError ? error.code : 'unexpected_error',
        });
        return unconfirmedView(order, order.reused, true);
      }
    }

    const error = failure as SasPayError;
    if (certain) {
      // Refus certain : aucun paiement n'existe chez SasPay, la commande est close.
      await store.settle(product, order.id, {
        paymentId: null, status: 'FAILED', requestedAmount: null, currency: null, fee: null, charged: null,
        net: null, feeMode: null, reference: null, source: 'initiate', failureCode: error.code,
      });
      throw fromSasPayError(error, { order_id: order.id, retryable: error.retryable });
    }
    // Issue inconnue : la commande n'est ni payée ni non payée. Le client peut
    // relancer la MÊME demande pendant la fenêtre de rejeu ; ensuite, un
    // administrateur rapproche.
    await store.initiationUnknown(product, order.id, error.code).catch(() => undefined);
    return unconfirmedView(order, order.reused, true);
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
    // Refus d'activation déjà prononcé : état final, inutile d'interroger SasPay.
    if (paymentState(order) === 'unapplied') return { ...untouched, verified: true, message: SUBSCRIPTION_CONFLICT_MESSAGE };
    // Création softpay sans réponse : aucun paiement identifié à interroger.
    // L'état est dit tel quel — ni payé, ni non payé.
    if (paymentState(order) === 'review') {
      return { ...untouched, message: order.failure_code === 'initiation_unconfirmed' ? UNCONFIRMED_MESSAGE : REVIEW_MESSAGE };
    }
    if (!order.provider_payment_id && !order.provider_session_id) return untouched;
    const lastVerified = order.last_verified_at ? Date.parse(order.last_verified_at) : 0;
    if (Number.isFinite(lastVerified) && deps.now() - lastVerified < minVerifyIntervalMs) return untouched;
    if (!client) return { ...untouched, message: 'Le service de paiement n’est pas configuré côté serveur.' };
    try {
      const result = await sync(order, 'verify');
      const message = result.outcome === 'amount_mismatch'
        ? 'Le montant reçu ne correspond pas à la commande. Le support a été alerté ; aucun crédit n’a été accordé.'
        : result.outcome === 'subscription_conflict' ? SUBSCRIPTION_CONFLICT_MESSAGE : null;
      if (result.outcome === 'subscription_conflict') await flagSubscriptionConflict(result);
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
    if (!match) {
      // Dernière piste : une commande dont la création softpay est restée sans
      // réponse. Le webhook ne porte ni libellé ni métadonnées ; la transaction
      // est donc relue chez SasPay, et n'est rattachée que si SasPay restitue
      // NOTRE référence de commande (preuve), jamais sur une ressemblance.
      try {
        match = await matchUnconfirmed(paymentId, typeof data.msisdn === 'string' ? data.msisdn : null);
      } catch (error) {
        // SasPay injoignable alors qu'une commande incertaine attend : le
        // webhook est refusé (503) pour que SasPay le représente plus tard.
        if (!(error instanceof SasPayError) || !error.definitive) {
          log('saspay_webhook_failed', { code: error instanceof SasPayError ? error.code : 'unexpected_error', stage: 'unconfirmed' });
          throw new PaymentError('WEBHOOK_PROCESSING_FAILED', 503, 'Traitement du webhook momentanément impossible.');
        }
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
      if (result.outcome === 'subscription_conflict') await flagSubscriptionConflict(result);
      // L'événement n'est « traité » que si la vérification auprès de SasPay a
      // abouti à une issue. Si SasPay répond encore « en attente » (le webhook
      // a devancé son propre état), l'événement reste REJOUABLE : sa prochaine
      // livraison — relance automatique ou renvoi manuel depuis le tableau de
      // bord — revérifiera au lieu d'être écartée comme un doublon.
      const conclusive = result.outcome !== 'pending';
      await store.finishWebhook(match.product, eventKey, conclusive, conclusive ? undefined : 'not_confirmed_yet');
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

  /** Référence de commande VYORA restituée par SasPay pour une transaction (libellé ou métadonnées). */
  function provenReference(tx: { description: string | null; metadata_reference: string | null }): string | null {
    return orderReferenceIn(tx.description) ?? orderReferenceIn(tx.metadata_reference);
  }

  /**
   * Transaction inconnue : appartient-elle à une commande incertaine ? Vrai
   * seulement si SasPay restitue la référence de cette commande.
   */
  async function matchUnconfirmed(
    paymentId: string, announcedMsisdn: string | null,
  ): Promise<{ product: Product; orderId: string } | null> {
    const sasPay = client;
    if (!sasPay) return null;
    // Toutes les tentatives non soldées, y compris celle dont l'appel de création
    // est encore en vol : le client peut valider avant que la réponse n'arrive.
    const open = await store.unconfirmedOrders(200, false);
    if (open.length === 0) return null;
    const tx = await sasPay.verifyPayment(paymentId);
    const reference = provenReference(tx);
    const found = reference ? open.find((o) => o.internalReference === reference) : undefined;
    if (found) {
      log('saspay_unconfirmed_matched', { product: found.product, order: found.orderId, via: 'webhook' });
      return { product: found.product, orderId: found.orderId };
    }
    // Référence d'une autre commande, ou sens contraire : sans rapport.
    if (reference || (tx.flow_direction && tx.flow_direction !== 'INBOUND')) return null;
    // Aucune preuve. Si la transaction RESSEMBLE à une commande incertaine
    // (montant, devise, date), elle est proposée à l'administrateur : le webhook
    // n'est ainsi pas perdu, mais rien n'est rattaché ni livré.
    const amount = parseDecimal(normalizeDecimal(tx.requested_amount));
    const createdAt = tx.created_at ? Date.parse(tx.created_at) : NaN;
    const announced = digitsOf(announcedMsisdn);
    for (const order of open) {
      const expected = parseDecimal(normalizeDecimal(order.amount));
      if (amount === null || expected === null || amount !== expected) continue;
      if (tx.currency && order.currency && tx.currency !== order.currency.toUpperCase()) continue;
      const first = Date.parse(order.firstAttemptAt);
      const last = Date.parse(order.lastAttemptAt);
      if (Number.isFinite(createdAt) && Number.isFinite(first)
        && (createdAt < first - 5 * 60_000 || createdAt > (Number.isFinite(last) ? last : first) + 30 * 60_000)) continue;
      const expectedDigits = digitsOf(order.phone);
      await store.addCandidate(order.product, order.orderId, {
        id: tx.id, reference: tx.reference, status: tx.status, amount: tx.requested_amount, currency: tx.currency,
        created_at: tx.created_at, described: tx.description !== null, source: 'webhook',
        msisdn_match: announced.length >= 8 && expectedDigits.length >= 8
          ? announced.slice(-8) === expectedDigits.slice(-8) : null,
      }).catch(() => undefined);
      log('saspay_unconfirmed_candidate', { product: order.product, order: order.orderId, via: 'webhook' });
    }
    return null;
  }

  /** Chiffres d'un numéro (la recherche SasPay ne documente pas son format). */
  function digitsOf(phone: string | null): string {
    return (phone ?? '').replace(/\D/g, '');
  }

  /**
   * Cherche chez SasPay (lecture seule) les transactions du numéro du payeur
   * autour de la tentative. Renvoie la transaction PROUVÉE (référence de la
   * commande restituée par SasPay) et les simples candidates (même montant,
   * même devise, même fenêtre) destinées à l'administrateur.
   */
  async function searchUnconfirmed(sasPay: SasPayClient, target: UnconfirmedOrder): Promise<{
    proven: FoundTransaction | null; candidates: PaymentCandidate[];
  }> {
    const digits = digitsOf(target.phone);
    if (digits.length < 8) return { proven: null, candidates: [] };
    const first = Date.parse(target.firstAttemptAt);
    const last = Date.parse(target.lastAttemptAt);
    if (!Number.isFinite(first)) return { proven: null, candidates: [] };
    // Fenêtre : 5 min avant la première tentative, 30 min après la dernière
    // (horloges décalées, validation tardive sur le téléphone).
    const from = first - 5 * 60_000;
    const to = (Number.isFinite(last) ? last : first) + 30 * 60_000;
    const seen = new Map<string, FoundTransaction>();
    // Numéro international complet, puis numéro national (8 derniers chiffres).
    for (const term of [...new Set([digits, digits.slice(-8)])]) {
      const found = await sasPay.searchPayments({ search: term, createdAfter: new Date(from).toISOString() });
      for (const tx of found.transactions) seen.set(tx.id, tx);
      if (seen.size > 0) break;
    }
    const expected = parseDecimal(normalizeDecimal(target.amount));
    let proven: FoundTransaction | null = null;
    const candidates: PaymentCandidate[] = [];
    for (const tx of seen.values()) {
      if (provenReference(tx) === target.internalReference) { proven = tx; continue; }
      // Portant la référence d'une AUTRE commande : ce n'est pas la nôtre.
      if (provenReference(tx)) continue;
      const createdAt = tx.created_at ? Date.parse(tx.created_at) : NaN;
      if (Number.isFinite(createdAt) && (createdAt < from || createdAt > to)) continue;
      const amount = parseDecimal(normalizeDecimal(tx.requested_amount));
      if (expected !== null && amount !== null && amount !== expected) continue;
      if (tx.currency && target.currency && tx.currency !== target.currency.toUpperCase()) continue;
      // Déjà rattachée à une autre commande VYORA : écartée.
      if (await store.findOrder({ paymentId: tx.id, sessionId: null })) continue;
      candidates.push({
        id: tx.id, reference: tx.reference, status: tx.status, amount: tx.requested_amount,
        currency: tx.currency, created_at: tx.created_at, described: tx.description !== null, source: 'search',
      });
    }
    return { proven, candidates: candidates.slice(0, 10) };
  }

  /**
   * Décision d'un administrateur : « ce paiement SasPay est celui de cette
   * commande ». Le paiement est relu chez SasPay AVANT tout rattachement (un
   * rattachement est définitif) : sens, montant, devise, date, et absence
   * d'autre commande liée. La livraison suit ensuite la voie ordinaire — seul
   * un statut `SUCCESS` vérifié livre.
   */
  async function resolveReview(
    user: PaymentUser, input: { product: unknown; order_id: unknown; payment_id: unknown; note?: unknown },
  ) {
    if (!(await store.isAdmin(user.id))) throw new PaymentError('PAYMENT_FORBIDDEN', 403, 'Réservé aux administrateurs.');
    if (!isProduct(input.product) || typeof input.order_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.order_id)) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Commande invalide.');
    }
    const paymentId = typeof input.payment_id === 'string' ? input.payment_id.trim() : '';
    if (!/^[A-Za-z0-9-]{8,64}$/.test(paymentId)) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Identifiant de transaction SasPay invalide.');
    }
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
    if (note.length < 10) {
      throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Indiquez comment ce paiement a été identifié (10 caractères au moins).');
    }
    const sasPay = client;
    if (!sasPay) throw new PaymentError('PAYMENTS_NOT_CONFIGURED', 503, 'Le service de paiement n’est pas configuré côté serveur.');
    const order = await store.getOrder(input.product, input.order_id);
    if (!order) throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
    if (paymentState(order) !== 'review') {
      throw new PaymentError('PAYMENT_NOT_UNDER_REVIEW', 409, 'Cette commande n’est pas en cours de vérification.');
    }
    const other = await store.findOrder({ paymentId, sessionId: null });
    if (other) throw new PaymentError('PAYMENT_REFERENCE_CONFLICT', 409, 'Ce paiement est déjà rattaché à une autre commande.');

    let tx: VerifiedPayment;
    try {
      tx = await sasPay.verifyPayment(paymentId);
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      throw fromSasPayError(error, { order_id: order.id });
    }
    const refuse = (message: string) => new PaymentError('PAYMENT_REVIEW_MISMATCH', 422, `${message} Rien n’a été rattaché.`);
    if (tx.id !== paymentId) throw refuse('SasPay a renvoyé une autre transaction.');
    if (tx.flow_direction && tx.flow_direction !== 'INBOUND') throw refuse('Cette transaction n’est pas un encaissement.');
    const requested = parseDecimal(normalizeDecimal(tx.requested_amount));
    if (requested === null || requested !== parseDecimal(order.amount) || (tx.currency ?? '') !== order.currency.toUpperCase()) {
      throw refuse('Le montant ou la devise de cette transaction ne correspond pas à la commande.');
    }
    const reference = provenReference(tx);
    if (reference && reference !== order.internal_reference) {
      throw refuse('Cette transaction porte la référence d’une autre commande.');
    }
    const createdAt = tx.created_at ? Date.parse(tx.created_at) : NaN;
    const orderedAt = Date.parse(String(order.created_at ?? ''));
    if (Number.isFinite(createdAt) && Number.isFinite(orderedAt) && createdAt < orderedAt - 5 * 60_000) {
      throw refuse('Cette transaction est antérieure à la commande.');
    }
    // Une transaction créée bien après notre DERNIER envoi ne peut pas venir de
    // cette commande (elle peut venir d'un autre produit du même compte marchand).
    const attempt = (await store.unconfirmedOrders(200, false).catch(() => []))
      .find((o) => o.product === order.product && o.orderId === order.id);
    const lastSent = attempt ? Date.parse(attempt.lastAttemptAt) : NaN;
    if (Number.isFinite(createdAt) && Number.isFinite(lastSent) && createdAt > lastSent + 60 * 60_000) {
      throw refuse('Cette transaction a été créée plus d’une heure après le dernier envoi de la demande : elle ne peut pas en provenir.');
    }

    const result = await sync(order, 'verify', paymentId);
    // Trace de la décision. Le rattachement est déjà fait : un échec d'écriture
    // de la trace est journalisé, il n'annule rien.
    await store.reviewAttached(user.id, order.product, order.id, paymentId, note).catch(() => {
      log('saspay_review_audit_failed', { product: order.product, order: order.id, admin: user.id });
    });
    if (result.outcome === 'subscription_conflict') await flagSubscriptionConflict(result);
    log('saspay_review_attached', { product: order.product, order: order.id, outcome: result.outcome });
    return { order: publicOrder(result), outcome: result.outcome, credited: result.credited };
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

  /**
   * Importe dans le barème les tarifs du compte SasPay (`GET /pricing/my-rates/`,
   * lecture seule chez SasPay). Réservé aux administrateurs, à leur demande.
   */
  async function syncRates(user: PaymentUser) {
    if (!(await store.isAdmin(user.id))) {
      throw new PaymentError('PAYMENT_FORBIDDEN', 403, 'Réservé aux administrateurs.');
    }
    if (!client) {
      throw new PaymentError('PAYMENTS_NOT_CONFIGURED', 503, 'Aucune clé SasPay n’est installée côté serveur.');
    }
    let rows: unknown[];
    try {
      rows = await client.myRates();
    } catch (error) {
      if (!(error instanceof SasPayError)) throw error;
      log('saspay_rates_unavailable', { status: error.status, code: error.code });
      throw fromSasPayError(error);
    }
    const result = await store.importRates(user.id, rows);
    ratesCache = null;
    log('saspay_rates_imported', { ...result, mode: client.mode });
    return { mode: client.mode, ...result };
  }

  /** Vrai si le jeton présenté est celui de la tâche planifiée. */
  async function isCronToken(presented: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(presented)) return false;
    const expected = await store.reconcileToken();
    return typeof expected === 'string' && expected.length === 64 && constantTimeEqual(presented, expected);
  }

  /**
   * Réconciliation : revérifie auprès de SasPay les commandes en attente, puis
   * balaie les encaissements réussis pour retrouver ceux qu'aucun webhook n'a
   * signalés. Ne livre que par `sync` → `settle` : mêmes preuves, même
   * idempotence que le reste. Aucun appel SasPay d'écriture.
   */
  async function reconcile(options: { source?: string; limit?: number; budgetMs?: number } = {}) {
    const sasPay = client;
    if (!sasPay) return { ran: false as const, reason: 'not_configured' as const };
    const runId = await store.reconcileStart(options.source ?? 'cron');
    if (!runId) return { ran: false as const, reason: 'already_running' as const };

    const startedAt = deps.now();
    const budgetMs = options.budgetMs ?? 40_000;
    const outOfTime = () => deps.now() - startedAt > budgetMs;
    const counts: ReconcileCounts = { checked: 0, settled: 0, closed: 0, errors: 0, swept: 0, anomalies: 0, sweep_done: false };
    const detail: Record<string, unknown> = {};
    let status: 'ok' | 'partial' | 'error' = 'ok';
    const isOpen = (order: OrderRecord) => order.status === 'pending' || order.status === 'processing';
    /** Commandes déjà interrogées pendant cette exécution : une seule vérification chacune. */
    const seen = new Set<string>();

    async function flag(anomaly: PaymentAnomaly): Promise<void> {
      counts.anomalies += 1;
      log('saspay_reconcile_anomaly', { kind: anomaly.kind, product: anomaly.product, order: anomaly.orderId });
      await store.reportAnomaly(anomaly).catch(() => undefined);
    }

    async function verifyOne(order: OrderRecord, knownPaymentId: string | null = null): Promise<void> {
      if (seen.has(order.id)) return;
      seen.add(order.id);
      try {
        const result = await sync(order, 'reconcile', knownPaymentId);
        counts.checked += 1;
        if (result.outcome === 'paid') {
          counts.settled += 1;
          log('saspay_reconcile_settled', { product: order.product, order: order.id });
        } else if ((result.outcome === 'failed' || result.outcome === 'cancelled') && isOpen(order)) {
          counts.closed += 1;
        } else if (result.outcome === 'amount_mismatch') {
          await flag({
            kind: 'amount_mismatch', product: order.product, orderId: order.id,
            paymentId: result.provider_payment_id ?? knownPaymentId, reference: order.internal_reference,
            details: { expected: order.amount, currency: order.currency },
          });
        } else if (result.outcome === 'subscription_conflict') {
          await flag({
            kind: 'subscription_conflict', product: order.product, orderId: order.id,
            paymentId: result.provider_payment_id ?? knownPaymentId, reference: order.internal_reference,
            details: { reason: result.failure_code, plan_key: order.plan_key ?? null, amount: order.amount, currency: order.currency },
          });
        }
      } catch (error) {
        counts.errors += 1;
        const code = error instanceof SasPayError || error instanceof PaymentError ? error.code : 'unexpected_error';
        log('saspay_reconcile_order_failed', { product: order.product, order: order.id, code });
        if (!(error instanceof SasPayError) || error.kind !== 'not_found' || !isOpen(order)) return;
        // SasPay ne connaît pas (ou plus) ce paiement : signalé, puis clos après
        // 24 h. Un succès tardif rouvrirait la commande (revérifiée 72 h).
        await flag({
          kind: 'payment_not_found', product: order.product, orderId: order.id,
          paymentId: order.provider_payment_id, reference: order.internal_reference, details: {},
        });
        const createdAt = Date.parse(String(order.created_at ?? ''));
        if (Number.isFinite(createdAt) && deps.now() - createdAt > 24 * 3_600_000) {
          await store.settle(order.product, order.id, {
            paymentId: null, status: 'CANCELLED', requestedAmount: null, currency: null, fee: null, charged: null,
            net: null, feeMode: null, reference: null, source: 'reconcile', failureCode: 'provider_payment_not_found',
          }).then(() => { counts.closed += 1; }).catch(() => undefined);
        }
      }
    }

    try {
      const batch = await store.reconcileBatch(Math.min(Math.max(options.limit ?? 20, 1), 50));
      for (const due of batch.due) {
        if (outOfTime()) { detail.stopped = 'time_budget'; break; }
        const order = await store.getOrder(due.product, due.orderId);
        if (order) await verifyOne(order);
      }

      if (batch.sweep && !outOfTime()) {
        // 5 pages de 200 (maximum documenté) : jusqu'à 1 000 encaissements par passage.
        const listing = await sasPay.listSuccessfulPayments({ createdAfter: batch.sweepSince, maxPages: 5, pageSize: 200 });
        detail.sweep_listed = listing.transactions.length;
        // Le filet a deux angles morts, signalés au lieu d'être tus :
        //  * la liste dépasse ce qu'un passage peut lire (ordre des pages non spécifié) ;
        //  * SasPay ne renvoie pas le libellé (`description`), que sa spécification
        //    ne garantit pas : aucune référence VYORA n'est alors lisible.
        if (listing.truncated) detail.sweep_truncated = true;
        if (listing.transactions.length > 0 && listing.described === 0) detail.sweep_blind = true;
        if (detail.sweep_truncated || detail.sweep_blind) {
          await flag({
            kind: 'sweep_unreliable', product: null, orderId: null, paymentId: null, reference: null,
            details: {
              reason: detail.sweep_blind ? 'description_missing' : 'truncated',
              listed: listing.transactions.length, described: listing.described,
            },
          });
        }
        for (const tx of listing.transactions) {
          if (outOfTime()) { detail.stopped = 'time_budget'; break; }
          const reference = orderReferenceIn(tx.description);
          // Le compte marchand peut servir d'autres produits : sans référence VYORA, ignoré.
          if (!reference) continue;
          counts.swept += 1;
          const match = await store.findOrderByReference(reference);
          const order = match ? await store.getOrder(match.product, match.orderId) : null;
          if (!order) continue;
          const settled = order.status === 'paid' || order.status === 'refunded';
          if (order.provider_payment_id === tx.id) {
            if (!settled) await verifyOne(order);
            continue;
          }
          if (order.provider_payment_id) {
            // Un second encaissement réussi porte la référence d'une commande
            // déjà liée à un autre paiement : rien n'est livré, un humain tranche.
            await flag({
              kind: settled ? 'duplicate_payment' : 'payment_conflict', product: order.product, orderId: order.id,
              paymentId: tx.id, reference, details: { tracked_payment_id: order.provider_payment_id },
            });
            continue;
          }
          // Aucune transaction connue : session hébergée (SasPay dira laquelle)
          // ou création restée sans réponse (la transaction trouvée est vérifiée).
          await verifyOne(order, order.provider_session_id ? null : tx.id);
        }
        counts.sweep_done = detail.stopped !== 'time_budget';
      }

      // Créations softpay restées sans réponse : recherche par numéro du payeur
      // (seul critère stable que SasPay documente). Une transaction n'est
      // rattachée que si SasPay restitue la référence de la commande ; sinon les
      // candidates sont consignées pour l'administrateur et RIEN n'est livré.
      let searched = 0;
      let recovered = 0;
      let withCandidates = 0;
      for (const target of batch.unconfirmed ?? []) {
        if (outOfTime()) { detail.stopped = 'time_budget'; break; }
        const order = await store.getOrder(target.product, target.orderId);
        if (!order || paymentState(order) !== 'review') continue;
        try {
          const found = await searchUnconfirmed(sasPay, target);
          searched += 1;
          if (found.proven) {
            log('saspay_unconfirmed_matched', { product: order.product, order: order.id, via: 'search' });
            await verifyOne(order, found.proven.id);
            recovered += 1;
            continue;
          }
          if (found.candidates.length > 0) withCandidates += 1;
          await store.noteCandidates(target.product, target.orderId, found.candidates);
        } catch (error) {
          counts.errors += 1;
          const code = error instanceof SasPayError || error instanceof PaymentError ? error.code : 'unexpected_error';
          log('saspay_unconfirmed_search_failed', { product: target.product, order: target.orderId, code });
        }
      }
      if (searched > 0) {
        detail.unconfirmed_searched = searched;
        detail.unconfirmed_recovered = recovered;
        detail.unconfirmed_with_candidates = withCandidates;
      }
      if (counts.errors > 0 || detail.stopped || detail.sweep_truncated || detail.sweep_blind) status = 'partial';
    } catch (error) {
      status = counts.checked > 0 ? 'partial' : 'error';
      detail.error = error instanceof SasPayError || error instanceof PaymentError ? error.code : 'unexpected_error';
      log('saspay_reconcile_failed', { code: detail.error });
    }
    await store.reconcileFinish(runId, status, { ...counts, detail }).catch(() => undefined);
    log('saspay_reconcile_done', { status, ...counts });
    return { ran: true as const, status, ...counts };
  }

  return { options, create, refresh, webhook, balances, reconcile, isCronToken, resolveReview, syncRates };
}

export type PaymentService = ReturnType<typeof createPaymentService>;

/** Message de journal sûr pour une erreur quelconque. */
export function safeErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300);
}
