// Doubles de test pour les paiements SasPay : faux SasPay (HTTP) et faux stockage.
// Le faux stockage reproduit les règles portées par la migration
// `vyora_saspay_payments` (prix serveur, idempotence, crédit unique).
import {
  type CreateOrderInput, type OrderRecord, type PaymentAnomaly, type PaymentCandidate, type PaymentStore, type Product,
  type QuoteContext, type ReconcileCounts, type SettleInput, type SettleResult, type UnconfirmedOrder, PaymentError,
} from '../../supabase/functions/_shared/saspay/payments';
import type { SoftpayRequest } from '../../supabase/functions/_shared/saspay/client';
import { signWebhook } from '../../supabase/functions/_shared/saspay/webhook';
import {
  quotePrice, reconcile as reconcilePricing, type FeeLine, type PriceQuote, type PricingPolicy, type Reconciliation,
} from '../../supabase/functions/_shared/saspay/pricing';
import { formatDecimal, parseDecimal } from '../../supabase/functions/_shared/saspay/money';

export const TEST_KEY = 'sk_test_unit_0123456789abcdef';
export const LIVE_KEY = 'sk_live_unit_0123456789abcdef';
export const WEBHOOK_SECRET = 'whsec_unit_test_secret';
export const NOW = Date.parse('2026-11-13T10:00:00Z');
export const CRON_TOKEN = 'a1b2c3d4'.repeat(8);

export const ML_COUNTRY = {
  name: 'Mali', currency: 'XOF', dial_code: '223', national_number_length: 8,
  networks: [
    { code: 'orange_ml', label: 'Orange Money' },
    { code: 'moov_ml', label: 'Moov Money' },
    { code: 'mobi_cash_ml', label: 'Mobi Cash' },
  ],
};

const PACKS: Record<string, { price: number; credits: number; label: string }> = {
  creator: { price: 5000, credits: 27, label: 'Pack Creator' },
  pro_creator: { price: 15000, credits: 95, label: 'Pack Pro Creator' },
  studio_business: { price: 35000, credits: 265, label: 'Pack Studio Business' },
};

export interface FakeStoreOptions {
  enabled?: boolean;
  mode?: 'test' | 'live';
  flows?: string[];
  admins?: string[];
  businessEnabled?: boolean;
  businessPlans?: Record<string, { price: number; label: string }>;
  /** Jeton de la tâche planifiée (`null` : absent de Vault). */
  cronToken?: string | null;
  /** Fenêtre de rejeu d'une création softpay sans réponse (défaut 10 min, comme en base). */
  replayWindowMs?: number;
  /** Relances permises au client pendant cette fenêtre (défaut 4, comme en base). */
  maxAttempts?: number;
  /**
   * Politique de prix (provision, barème). Absente : comportement d'origine,
   * prix de base = prix payé — comme en base quand la politique est désactivée.
   */
  pricing?: { policy: PricingPolicy; lines?: FeeLine[] };
}

/** Politique livrée par la migration : provision de 1 000 FCFA, prix arrondi au franc. */
export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  enabled: true, strategy: 'cover_fees',
  currencies: { XOF: { provision_cents: 100_000n, rounding_step_cents: 100n } },
};

/** Tentative de création softpay, telle que la consigne `vyora_payment_initiations`. */
export interface FakeInitiation {
  product: Product;
  orderId: string;
  userId: string;
  request: SoftpayRequest | null;
  attempts: number;
  outcome: 'started' | 'unknown' | 'attached' | 'refused' | 'closed';
  lastError: string | null;
  firstAttemptAt: number;
  lastAttemptAt: number;
  reviewAt: number | null;
  resolvedAt: number | null;
  candidates: PaymentCandidate[];
  resolvedBy: string | null;
  note: string | null;
}

export function createFakeStore(options: FakeStoreOptions = {}) {
  const orders = new Map<string, OrderRecord>();
  const byKey = new Map<string, string>();
  const webhooks = new Map<string, 'received' | 'processed' | 'failed'>();
  /** Portefeuilles STRICTEMENT séparés par produit. */
  const credits = { studio: new Map<string, number>(), business: new Map<string, number>() };
  const calls: string[] = [];
  const config = {
    enabled: options.enabled ?? true,
    mode: options.mode ?? 'test',
    flows: options.flows ?? ['softpay', 'checkout'],
  };
  const plans = options.businessPlans ?? { croissance: { price: 25000, label: 'Business Grow — Croissance' } };
  let sequence = 0;
  const anomalies: PaymentAnomaly[] = [];
  /** Devis figés et lignes de rapprochement, comme `pricing_quote` et `vyora_payment_reconciliations`. */
  const quotes = new Map<string, PriceQuote>();
  const ledger = new Map<string, Reconciliation>();
  const pricing = options.pricing ?? null;
  const importedRates: unknown[][] = [];
  /** Prix final d'un prix de base (chaîne décimale), d'après la politique ; `null` sans politique. */
  function priced(baseAmount: string, country: string, network: string | null): PriceQuote | null {
    if (!pricing) return null;
    return quotePrice({
      policy: pricing.policy, lines: pricing.lines ?? [], baseCents: parseDecimal(baseAmount) as bigint, currency: 'XOF',
      country, network, networks: config.flows.includes('checkout') ? null : ML_COUNTRY.networks.map((n) => n.code), at: NOW,
    });
  }
  const runs: Array<{ id: string; source: string; status: string; counts?: ReconcileCounts & { detail?: Record<string, unknown> } }> = [];
  const reconcile = { sweep: true, due: null as Array<{ product: Product; orderId: string }> | null };
  /** Commandes dont la base refuserait l'activation (Business Grow : abonnement incompatible). */
  const activationBlocks = new Map<string, string>();
  /** Horloge de la base : avançable par les tests (fenêtre de rejeu, rapprochement). */
  const clock = { now: NOW };
  const initiations = new Map<string, FakeInitiation>();
  const replayWindowMs = options.replayWindowMs ?? 10 * 60_000;
  const maxAttempts = options.maxAttempts ?? 4;
  let attachFailures = 0;

  /** Comme en base : issue inconnue, ou appel lancé depuis plus de 60 s sans conclusion. */
  const uncertain = (i: FakeInitiation) => i.resolvedAt === null
    && (i.outcome === 'unknown' || (i.outcome === 'started' && i.lastAttemptAt < clock.now - 60_000));

  /** Comme le déclencheur `vyora_payment_initiation_sync`. */
  function syncInitiation(orderId: string): void {
    const order = orders.get(orderId);
    if (!order) return;
    const identified = Boolean(order.provider_payment_id || order.provider_session_id);
    if (!identified && order.status === 'pending') return;
    if (order.failure_code === 'initiation_unconfirmed' || order.failure_code === 'manual_review') order.failure_code = null;
    const init = initiations.get(orderId);
    if (!init || init.resolvedAt !== null) return;
    init.resolvedAt = clock.now;
    init.request = null;
    init.outcome = order.provider_payment_id ? 'attached' : order.status === 'failed' ? 'refused' : 'closed';
  }

  /** Comme `vyora_payment_open_review` : entrée en rapprochement manuel + anomalie. */
  function openReview(orderId: string, reason: string): boolean {
    const order = orders.get(orderId);
    const init = initiations.get(orderId);
    if (!order || !init || init.resolvedAt !== null || init.reviewAt !== null) return false;
    if (order.status !== 'pending' || order.provider_payment_id || order.provider_session_id) return false;
    init.reviewAt = clock.now;
    init.outcome = 'unknown';
    order.failure_code = 'manual_review';
    anomalies.push({
      kind: 'initiation_unconfirmed', product: order.product, orderId, paymentId: null,
      reference: order.internal_reference, details: { reason, attempts: init.attempts },
    });
    return true;
  }

  function price(product: Product, item: Record<string, unknown>) {
    if (product === 'studio') {
      if (item.kind === 'pack') {
        const pack = PACKS[String(item.pack_key)];
        if (!pack) throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Ce pack de crédits n’existe plus.');
        return { amount: `${pack.price}.00`, currency: 'XOF', label: pack.label, credits: pack.credits, kind: 'pack', pack_key: item.pack_key };
      }
      const amount = Number(item.amount_xof);
      if (amount < 5000 || amount > 350000 || amount % 1000 !== 0) {
        throw new PaymentError('PAYMENT_AMOUNT_OUT_OF_BOUNDS', 422, 'Le montant saisi est hors des limites autorisées.');
      }
      const tier = Object.values(PACKS).filter((p) => p.price <= amount).sort((a, b) => b.price - a.price)[0];
      return { amount: `${amount}.00`, currency: 'XOF', label: 'Recharge personnalisée', credits: Math.floor((amount * tier.credits) / tier.price), kind: 'custom', pack_key: null };
    }
    const plan = plans[String(item.plan_key)];
    if (!plan) throw new PaymentError('BUSINESS_PLAN_NOT_PURCHASABLE', 422, 'Cette formule Business Grow n’est pas commercialisée.');
    return { amount: `${plan.price}.00`, currency: 'XOF', label: plan.label, plan_key: item.plan_key, period_days: 30 };
  }

  const store: PaymentStore = {
    async quote(userId, product, item): Promise<QuoteContext> {
      calls.push('quote');
      const raw = item as Record<string, unknown>;
      let eligible = true;
      let reason: string | null = null;
      if (product === 'studio' && (options.admins ?? []).includes(userId)) { eligible = false; reason = 'not_vyora_customer'; }
      if (product === 'business' && options.businessEnabled === false) { eligible = false; reason = 'business_billing_disabled'; }
      const hasItem = 'kind' in raw || 'plan_key' in raw;
      const base = eligible && hasItem ? price(product, raw) : null;
      const quoted = base ? priced(base.amount, 'ML', null) : null;
      const final = quoted ? formatDecimal(quoted.final_cents) : null;
      const catalog: Record<string, { amount: string; max_amount: string; currency: string }> = {};
      if (!hasItem) {
        const items = product === 'studio'
          ? Object.entries(PACKS).map(([key, pack]) => [key, pack.price] as const)
          : Object.entries(plans).map(([key, plan]) => [key, plan.price] as const);
        for (const [key, amount] of items) {
          const q = priced(`${amount}.00`, 'ML', null);
          const shown = q ? formatDecimal(q.final_cents) : `${amount}.00`;
          catalog[key] = { amount: shown, max_amount: shown, currency: 'XOF' };
        }
      }
      return {
        product, enabled: config.enabled, mode: config.mode, flows: config.flows,
        countries: { ML: base && final ? { ...ML_COUNTRY, price: { amount: final, currency: 'XOF' } } : ML_COUNTRY },
        eligible, reason, price: base && final ? { ...base, amount: final } : base,
        all_inclusive: pricing?.policy.enabled === true,
        catalog: hasItem ? null : catalog,
      };
    },

    async createOrder(input: CreateOrderInput) {
      calls.push('createOrder');
      const key = `${input.product}:${input.userId}:${input.idempotencyKey}`;
      const existing = byKey.get(key);
      if (existing) {
        return {
          ...(orders.get(existing) as OrderRecord), reused: true,
          requested_fee_mode: quotes.get(existing)?.fee_charge_mode ?? null,
        };
      }
      // Comme le déclencheur `vyora_payment_block_unconfirmed` : aucune nouvelle
      // commande tant qu'un paiement du client est incertain (tous produits).
      const open = [...initiations.values()].filter((i) => i.userId === input.userId && i.resolvedAt === null);
      if (open.some(uncertain)) {
        throw new PaymentError('PAYMENT_UNDER_REVIEW', 409, 'Un de vos paiements est en cours de vérification. Aucun autre paiement ne peut être lancé tant qu’il n’est pas confirmé ou annulé.');
      }
      if (open.length > 0) {
        throw new PaymentError('PAYMENT_ALREADY_IN_PROGRESS', 409, 'Un paiement est déjà en cours d’envoi. Patientez quelques secondes puis vérifiez son statut avant d’en lancer un autre.');
      }
      const base = price(input.product, input.item as Record<string, unknown>);
      // Comme en base : le montant de la commande est le prix FINAL du devis, figé.
      const frozen = priced(base.amount, input.country, input.network);
      const policyOn = frozen?.policy_enabled === true;
      const quoted = frozen ? { ...base, amount: formatDecimal(frozen.final_cents) } : base;
      sequence += 1;
      const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
      const order: OrderRecord = {
        product: input.product, id, user_id: input.userId, status: 'pending',
        amount: quoted.amount, currency: quoted.currency, country: input.country,
        internal_reference: `${input.product === 'studio' ? 'VYS' : 'VYB'}-${String(sequence).padStart(32, '0')}`,
        created_at: new Date(NOW).toISOString(),
        label: quoted.label, payment_flow: input.flow, network_code: input.network,
        provider_payment_id: null, provider_session_id: null, provider_status: null, checkout_url: null,
        last_verified_at: null, credits: 'credits' in quoted ? quoted.credits : undefined,
        payer_msisdn_masked: input.msisdnMasked,
        quoted_fee_amount: policyOn
          ? (frozen.estimated_fee_cents === null ? null : formatDecimal(frozen.estimated_fee_cents)) : input.quotedFee,
        quoted_total_amount: policyOn ? quoted.amount : input.quotedTotal,
        quoted_fee_mode: policyOn ? 'DEDUCTED' : input.quotedFeeMode,
      };
      orders.set(id, order); byKey.set(key, id);
      if (frozen) quotes.set(id, frozen);
      return { ...order, reused: false, requested_fee_mode: frozen?.fee_charge_mode ?? null };
    },

    async getOrder(product, orderId) {
      const order = orders.get(orderId);
      return order && order.product === product ? { ...order } : null;
    },

    async attach(product, orderId, refs) {
      calls.push('attach');
      const order = orders.get(orderId);
      if (!order || order.product !== product) throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
      for (const other of orders.values()) {
        if (other.id !== orderId && refs.paymentId && other.provider_payment_id === refs.paymentId) {
          throw new PaymentError('PAYMENT_REFERENCE_CONFLICT', 409, 'Ce paiement est déjà rattaché à une autre commande.');
        }
      }
      if ((order.provider_payment_id && refs.paymentId && order.provider_payment_id !== refs.paymentId)
        || (order.provider_session_id && refs.sessionId && order.provider_session_id !== refs.sessionId)) {
        throw new PaymentError('PAYMENT_REFERENCE_CONFLICT', 409, 'Ce paiement est déjà rattaché à une autre commande.');
      }
      order.provider_payment_id ??= refs.paymentId;
      order.provider_session_id ??= refs.sessionId;
      order.checkout_url = refs.checkoutUrl ?? order.checkout_url;
      order.provider_status = refs.providerStatus ?? order.provider_status;
      if (order.status === 'pending') order.status = 'processing';
      return { ...order };
    },

    async settle(product, orderId, input: SettleInput): Promise<SettleResult> {
      calls.push(`settle:${input.status}`);
      const order = orders.get(orderId);
      if (!order || order.product !== product) throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
      order.last_verified_at = new Date(NOW).toISOString();
      if (order.status === 'paid') return { ...order, outcome: 'already_paid', credited: false };
      // Comme en base : une commande remboursée ne se relivre jamais.
      if (order.status === 'refunded') return { ...order, outcome: 'already_paid', credited: false };
      // Comme en base : un refus d'activation prononcé sur un encaissement est figé.
      if (order.provider_status === 'SUCCESS' && typeof order.failure_code === 'string'
        && ['business_plan_change_not_supported', 'business_subscription_managed_elsewhere'].includes(order.failure_code)) {
        return { ...order, outcome: 'subscription_conflict', credited: false };
      }
      if (input.status === 'SUCCESS') {
        if (!input.paymentId) throw new Error('payment_id_required');
        if (input.requestedAmount !== order.amount || input.currency !== order.currency) {
          order.failure_code = 'amount_mismatch';
          return { ...order, outcome: 'amount_mismatch', credited: false };
        }
        // Comme en base : refus d'activation définitif, rien n'est livré.
        const block = activationBlocks.get(order.id);
        if (block) {
          order.failure_code = block;
          order.provider_payment_id ??= input.paymentId;
          order.provider_status = 'SUCCESS';
          if (order.status === 'pending') order.status = 'processing';
          return { ...order, outcome: 'subscription_conflict', credited: false };
        }
        order.status = 'paid';
        order.provider_payment_id ??= input.paymentId;
        order.provider_status = 'SUCCESS';
        order.fee_amount = input.fee; order.charged_amount = input.charged; order.net_amount = input.net;
        order.fee_charge_mode = input.feeMode;
        // Comme le déclencheur `vyora_payment_ledger` : une ligne de rapprochement
        // par commande réglée, et une alerte par dépassement.
        const frozen = quotes.get(order.id) ?? null;
        const line = reconcilePricing(frozen, parseDecimal(order.amount) as bigint, {
          chargedCents: input.charged === null ? null : parseDecimal(input.charged),
          netCents: input.net === null ? null : parseDecimal(input.net), feeMode: input.feeMode,
        });
        ledger.set(order.id, line);
        if (frozen?.policy_enabled) {
          for (const flag of line.flags) {
            if (flag === 'fee_exceeds_provision' || flag === 'net_below_base' || flag === 'fee_mode_unexpected') {
              anomalies.push({
                kind: flag, product, orderId: order.id, paymentId: order.provider_payment_id,
                reference: order.internal_reference, details: {},
              } as unknown as PaymentAnomaly);
            }
          }
        }
        const wallet = credits[product];
        wallet.set(order.user_id, (wallet.get(order.user_id) ?? 0) + Number(order.credits ?? 1));
        return { ...order, outcome: 'paid', credited: true };
      }
      if (input.status === 'FAILED' || input.status === 'CANCELLED') {
        order.status = input.status === 'FAILED' ? 'failed' : 'cancelled';
        order.provider_status = input.status;
        order.failure_code = input.failureCode ?? input.status.toLowerCase();
        return { ...order, outcome: input.status === 'FAILED' ? 'failed' : 'cancelled', credited: false };
      }
      order.provider_payment_id ??= input.paymentId;
      order.provider_status = 'PENDING';
      if (order.status === 'pending') order.status = 'processing';
      return { ...order, outcome: 'pending', credited: false };
    },

    async findOrder(refs) {
      for (const order of orders.values()) {
        if ((refs.paymentId && order.provider_payment_id === refs.paymentId)
          || (refs.sessionId && order.provider_session_id === refs.sessionId)) {
          return { product: order.product, orderId: order.id };
        }
      }
      return null;
    },

    async openCheckoutOrders() {
      return [...orders.values()]
        .filter((o) => o.payment_flow === 'checkout' && o.provider_session_id && !o.provider_payment_id
          && (o.status === 'pending' || o.status === 'processing'))
        .map((o) => ({ product: o.product, orderId: o.id, sessionId: o.provider_session_id as string }));
    },

    async recordWebhook(_product, eventKey) {
      const status = webhooks.get(eventKey);
      if (!status) { webhooks.set(eventKey, 'received'); return { first: true, processed: false }; }
      return { first: false, processed: status === 'processed' };
    },

    async finishWebhook(_product, eventKey, ok) {
      if (webhooks.get(eventKey) !== 'processed') webhooks.set(eventKey, ok ? 'processed' : 'failed');
    },

    async isAdmin(userId) {
      return (options.admins ?? []).includes(userId);
    },

    async importRates(adminId, rates) {
      calls.push('importRates');
      if (!(options.admins ?? []).includes(adminId)) throw new PaymentError('PAYMENT_FORBIDDEN', 403, 'Réservé aux administrateurs.');
      if (rates.length === 0) throw new PaymentError('PAYMENT_RATES_EMPTY', 502, 'SasPay n’a renvoyé aucun tarif exploitable. Le barème n’a pas été modifié.');
      importedRates.push(rates);
      return { inserted: rates.length, unchanged: 0, closed: 0, skipped: 0 };
    },

    async reconcileToken() {
      calls.push('reconcileToken');
      return options.cronToken === undefined ? CRON_TOKEN : options.cronToken;
    },

    async reconcileStart(source) {
      if (runs.some((run) => run.status === 'running')) return null;
      const id = `run-${runs.length + 1}`;
      runs.push({ id, source, status: 'running' });
      return id;
    },

    async reconcileBatch(limit) {
      const due = reconcile.due ?? [...orders.values()]
        .filter((o) => (o.provider_payment_id || o.provider_session_id)
          && ['pending', 'processing', 'failed', 'cancelled'].includes(o.status))
        .map((o) => ({ product: o.product, orderId: o.id }));
      return {
        due: due.slice(0, limit), sweep: reconcile.sweep, sweepSince: new Date(NOW - 72 * 3_600_000).toISOString(),
        unconfirmed: await store.unconfirmedOrders(10, true),
      };
    },

    async reconcileFinish(runId, status, counts) {
      const run = runs.find((r) => r.id === runId);
      if (run && run.status === 'running') { run.status = status; run.counts = counts; }
    },

    async findOrderByReference(reference) {
      if (!/^VY[SB]-[0-9A-F]{32}$/.test(reference)) return null;
      const order = [...orders.values()].find((o) => o.internal_reference === reference);
      return order ? { product: order.product, orderId: order.id } : null;
    },

    async reportAnomaly(anomaly) {
      anomalies.push(anomaly);
      return true;
    },

    async beginInitiation(product, orderId, request) {
      calls.push('beginInitiation');
      const order = orders.get(orderId);
      if (!order || order.product !== product) throw new PaymentError('PAYMENT_NOT_FOUND', 404, 'Commande introuvable.');
      if (order.status !== 'pending' || order.provider_payment_id || order.provider_session_id) {
        return { allowed: false, reason: 'not_pending' };
      }
      const others = [...initiations.values()]
        .filter((i) => i.userId === order.user_id && i.orderId !== orderId && i.resolvedAt === null);
      if (others.length > 0) {
        return { allowed: false, reason: others.some(uncertain) ? 'other_payment_unconfirmed' : 'other_payment_in_progress' };
      }
      let init = initiations.get(orderId);
      if (init) {
        if (init.resolvedAt !== null) return { allowed: false, reason: 'not_pending' };
        if (init.reviewAt !== null) return { allowed: false, reason: 'under_review' };
        if (init.attempts >= maxAttempts || clock.now > init.firstAttemptAt + replayWindowMs) {
          openReview(orderId, init.attempts >= maxAttempts ? 'attempts_exhausted' : 'replay_window_elapsed');
          return { allowed: false, reason: 'under_review' };
        }
        if (init.outcome === 'started' && init.lastAttemptAt > clock.now - 20_000) {
          return { allowed: false, reason: 'attempt_in_progress' };
        }
        init.attempts += 1; init.lastAttemptAt = clock.now; init.outcome = 'started';
      } else {
        init = {
          product, orderId, userId: order.user_id,
          // Passage par JSON, comme un aller-retour en base.
          request: JSON.parse(JSON.stringify(request)) as SoftpayRequest,
          attempts: 1, outcome: 'started', lastError: null, firstAttemptAt: clock.now, lastAttemptAt: clock.now,
          reviewAt: null, resolvedAt: null, candidates: [], resolvedBy: null, note: null,
        };
        initiations.set(orderId, init);
      }
      order.failure_code = 'initiation_unconfirmed';
      return {
        allowed: true, attempt: init.attempts, request: init.request as SoftpayRequest,
        replayUntil: new Date(init.firstAttemptAt + replayWindowMs).toISOString(),
      };
    },

    async initiationUnknown(_product, orderId, error) {
      calls.push('initiationUnknown');
      const init = initiations.get(orderId);
      if (init && init.resolvedAt === null) { init.outcome = 'unknown'; init.lastError = error.slice(0, 80); }
    },

    async unconfirmedOrders(limit, dueOnly) {
      const rows: UnconfirmedOrder[] = [];
      for (const init of initiations.values()) {
        // Comme en base : pour un webhook, toute tentative non soldée (appel en vol compris).
        if (dueOnly ? !uncertain(init) : init.resolvedAt !== null) continue;
        const order = orders.get(init.orderId) as OrderRecord;
        rows.push({
          product: init.product, orderId: init.orderId, internalReference: order.internal_reference,
          phone: init.request?.customer.phone ?? null, amount: order.amount, currency: order.currency,
          firstAttemptAt: new Date(init.firstAttemptAt).toISOString(),
          lastAttemptAt: new Date(init.lastAttemptAt).toISOString(), inReview: init.reviewAt !== null,
        });
      }
      return rows.slice(0, limit);
    },

    async noteCandidates(_product, orderId, candidates) {
      calls.push('noteCandidates');
      const init = initiations.get(orderId);
      if (init && init.resolvedAt === null) {
        // Comme en base : les pistes venues d'un webhook survivent à une recherche.
        const kept = init.candidates.filter((c) => c.source === 'webhook' && !candidates.some((n) => n.id === c.id));
        init.candidates = [...kept, ...candidates];
      }
    },

    async addCandidate(_product, orderId, candidate) {
      calls.push('addCandidate');
      const init = initiations.get(orderId);
      if (init && init.resolvedAt === null && !init.candidates.some((c) => c.id === candidate.id)) init.candidates.push(candidate);
    },

    async reviewAttached(adminId, _product, orderId, _paymentId, note) {
      calls.push('reviewAttached');
      const init = initiations.get(orderId);
      if (init) { init.resolvedBy = adminId; init.note = note; }
    },
  };

  // Comme en base : tout rattachement ou règlement passe par le déclencheur de
  // suivi (marqueur levé, tentative soldée).
  const rawAttach = store.attach.bind(store);
  const rawSettle = store.settle.bind(store);
  store.attach = async (product, orderId, refs) => {
    if (attachFailures > 0) {
      attachFailures -= 1;
      throw new PaymentError('PAYMENT_STORAGE_UNAVAILABLE', 503, 'Le service est momentanément indisponible. Réessayez.');
    }
    await rawAttach(product, orderId, refs);
    syncInitiation(orderId);
    return { ...(orders.get(orderId) as OrderRecord) };
  };
  store.settle = async (product, orderId, input) => {
    const result = await rawSettle(product, orderId, input);
    syncInitiation(orderId);
    return { ...(orders.get(orderId) as OrderRecord), outcome: result.outcome, credited: result.credited };
  };

  return {
    store, orders, credits, webhooks, calls, config, anomalies, runs, reconcile, clock, initiations,
    quotes, ledger, importedRates,
    /** Les `n` prochains rattachements échouent (base injoignable juste après la réponse SasPay). */
    failAttach(n = 1) { attachFailures = n; },
    /** Entretien planifié (`vyora_payment_housekeeping`) : rapprochements ouverts, commandes expirées. */
    housekeeping() {
      let opened = 0;
      let expired = 0;
      for (const init of initiations.values()) {
        if (init.resolvedAt !== null || init.reviewAt !== null || init.lastAttemptAt >= clock.now - 90_000) continue;
        if (init.attempts >= maxAttempts || init.firstAttemptAt < clock.now - replayWindowMs) {
          if (openReview(init.orderId, init.attempts >= maxAttempts ? 'attempts_exhausted' : 'replay_window_elapsed')) opened += 1;
        }
      }
      for (const order of orders.values()) {
        if (order.status !== 'pending' || order.provider_payment_id || order.provider_session_id) continue;
        const init = initiations.get(order.id);
        // Une tentative non soldée protège la commande de l'expiration.
        if (init && init.resolvedAt === null) continue;
        if (Date.parse(String(order.created_at)) < clock.now - 45 * 60_000) {
          order.status = 'cancelled'; order.failure_code = 'expired_unpaid'; expired += 1;
        }
      }
      return { opened, expired };
    },
    /** Décision d'un administrateur : aucun encaissement (`vyora_admin_close_unconfirmed`). */
    closeUnpaid(orderId: string, adminId: string, note: string) {
      const order = orders.get(orderId);
      const init = initiations.get(orderId);
      if (!order || !init || init.resolvedAt !== null || init.reviewAt === null
        || order.status !== 'pending' || order.provider_payment_id) {
        throw new Error('payment_not_under_review');
      }
      order.status = 'cancelled'; order.failure_code = 'unconfirmed_closed';
      syncInitiation(orderId);
      init.resolvedBy = adminId; init.note = note;
    },
    /** La base refusera d'activer cette commande une fois payée (autre formule en cours…). */
    blockActivation(orderId: string, code = 'business_plan_change_not_supported') { activationBlocks.set(orderId, code); },
  };
}

export interface SasPayCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Responder = (call: SasPayCall) => Response | Promise<Response> | undefined;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Faux SasPay : transactions en mémoire, réponses au format documenté (enveloppe `{success,data}`). */
export function createFakeSasPay() {
  const calls: SasPayCall[] = [];
  const transactions = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const idempotent = new Map<string, Record<string, unknown>>();
  let override: Responder | null = null;
  let sequence = 0;
  let listingHonoursFilters = true;
  let listingOmitsDescription = false;
  let nextOverride: string | null = null;
  let lostResponses = 0;
  let droppedRequests = 0;
  let exposeMetadata = false;
  let verifyOmitsDescription = false;
  /** Le compte accepte-t-il que l'API choisisse le mode de frais (option « ALLOW_CLIENT_OVERRIDE ») ? */
  let allowFeeModeOverride = true;
  /** Frais d'encaissement appliqués par le faux SasPay (centièmes), d'après le montant demandé. */
  let feeOf: (amountCents: bigint) => bigint = () => 10_000n;
  /** Montants d'une transaction selon le mode : qui paie les frais. */
  const amounts = (amount: string, requestedMode: unknown, accountMode: 'ADD_ON' | 'DEDUCTED') => {
    const mode = allowFeeModeOverride && (requestedMode === 'ADD_ON' || requestedMode === 'DEDUCTED') ? requestedMode : accountMode;
    const cents = parseDecimal(amount) as bigint;
    const fee = feeOf(cents);
    return mode === 'ADD_ON'
      ? { fee_charge_mode: 'ADD_ON', client_fee: formatDecimal(fee), debited_amount: formatDecimal(cents + fee), net_amount: formatDecimal(cents) }
      : { fee_charge_mode: 'DEDUCTED', client_fee: formatDecimal(fee), debited_amount: formatDecimal(cents), net_amount: formatDecimal(cents - fee) };
  };
  const idempotentBodies = new Map<string, string>();
  /** Vue d'une transaction telle que l'API la renvoie (champs non garantis masquables). */
  const shown = (row: Record<string, unknown>, omitDescription: boolean) => {
    const { _phone, _email, metadata, description, ...rest } = row;
    return {
      ...rest,
      ...(omitDescription ? {} : { description }),
      ...(exposeMetadata && metadata ? { metadata } : {}),
    };
  };
  let rates: unknown[] = [{
    country_code: 'ML', currency: 'XOF', network_code: 'orange_ml', network_name: 'Orange Money Mali',
    payin: { available: true, is_custom: false, otp_required: false, otp_instructions: null,
      tiers: [{ min_amount: '0.00', max_amount: null, percent: '2.00', fixed: '0.00', floor_amount: null, cap_amount: null, fee_charge_mode: 'ADD_ON' }] },
  }, {
    country_code: 'ML', currency: 'XOF', network_code: 'moov_ml', network_name: 'Moov Money Mali',
    payin: { available: true, is_custom: false, otp_required: false, otp_instructions: null,
      tiers: [{ min_amount: '0.00', max_amount: null, percent: '3.00', fixed: '50.00', floor_amount: null, cap_amount: null, fee_charge_mode: 'DEDUCTED' }] },
  }, {
    country_code: 'ML', currency: 'XOF', network_code: 'mobi_cash_ml', network_name: 'Mobi Cash Mali',
    payin: { available: false, is_custom: false, otp_required: false, otp_instructions: null, tiers: [] },
  }];

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const call: SasPayCall = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace('/api/v1', '') + url.search,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    };
    calls.push(call);
    const forced = override ? await override(call) : undefined;
    if (forced) return forced;
    if (headers.authorization !== `Bearer ${TEST_KEY}` && headers.authorization !== `Bearer ${LIVE_KEY}`) {
      return jsonResponse({ success: false, error: { code: 'authentication_failed', message: 'Invalid API key' }, code: 401 }, 401);
    }

    if (call.method === 'POST' && call.path === '/payments/softpay/') {
      // La requête n'atteint jamais SasPay (coupure à l'aller).
      if (droppedRequests > 0) { droppedRequests -= 1; throw new TypeError('network down (request never sent)'); }
      const key = headers['idempotency-key'];
      const rawBody = JSON.stringify(call.body);
      const replay = key ? idempotent.get(key) : undefined;
      if (replay) {
        // Comme documenté : même clé + corps différent → 409.
        if (idempotentBodies.get(key) !== rawBody) {
          return jsonResponse({ success: false, error: { code: 'idempotency_key_reused', message: 'Idempotency-Key déjà utilisée avec un corps différent' }, code: 409 }, 409);
        }
        // Le rejeu est bien servi par SasPay, mais sa réponse peut se perdre elle aussi.
        if (lostResponses > 0) { lostResponses -= 1; throw new TypeError('network down (response lost)'); }
        return jsonResponse({ success: true, data: replay, code: 201 }, 201);
      }
      sequence += 1;
      const id = `tx-${String(sequence).padStart(8, '0')}`;
      const amount = String(call.body?.amount);
      transactions.set(id, {
        id, reference: `SP-${id}`, status: 'PENDING', requested_amount: amount, currency: call.body?.currency,
        ...amounts(amount, call.body?.fee_charge_mode, 'ADD_ON'),
        description: call.body?.description ?? null, transaction_type: 'PAIEMENT', flow_direction: 'INBOUND',
        created_at: new Date(NOW).toISOString(),
        metadata: call.body?.metadata ?? null,
        _phone: String((call.body?.customer as Record<string, unknown> | undefined)?.phone ?? ''),
        _email: String((call.body?.customer as Record<string, unknown> | undefined)?.email ?? ''),
      });
      const data = { message: 'Payment initiated', id, status: 'PENDING', checkout_url: '' };
      if (key) { idempotent.set(key, data); idempotentBodies.set(key, rawBody); }
      // SasPay a bien créé le paiement, mais sa réponse ne revient pas.
      if (lostResponses > 0) { lostResponses -= 1; throw new TypeError('network down (response lost)'); }
      return jsonResponse({ success: true, data, code: 201 }, 201);
    }
    if (call.method === 'POST' && call.path === '/checkout-sessions/') {
      sequence += 1;
      const id = `cs-${String(sequence).padStart(8, '0')}`;
      sessions.set(id, { id, slug: id, status: 'PENDING', transaction_id: null, transaction_status: null, transaction_reference: null, amount: call.body?.amount, currency: call.body?.currency, description: call.body?.description ?? null });
      // Forme « nue » (sans enveloppe), comme dans les exemples OpenAPI.
      return jsonResponse({ id, slug: id, checkout_url: `https://pay.saspay.me/c/${id}`, status: 'PENDING', transaction: null, paid_at: null }, 201);
    }
    const status = call.path.match(/^\/checkout-sessions\/([^/]+)\/status\/$/);
    if (call.method === 'GET' && status) {
      const session = sessions.get(status[1]);
      return session ? jsonResponse({ success: true, data: session, code: 200 })
        : jsonResponse({ success: false, error: { code: 'not_found', message: 'Not found' }, code: 404 }, 404);
    }
    const verify = call.path.match(/^\/payments\/([^/]+)\/verify\/$/);
    if (call.method === 'GET' && verify) {
      const tx = transactions.get(verify[1]);
      return tx ? jsonResponse({ success: true, data: shown(tx, verifyOmitsDescription), code: 200 })
        : jsonResponse({ success: false, error: { code: 'not_found', message: 'Not found' }, code: 404 }, 404);
    }
    if (call.method === 'GET' && call.path.startsWith('/transactions/')) {
      // Liste paginée par curseur, au format documenté : `{next, previous, results}`.
      const query = new URL(`https://x${call.path}`).searchParams;
      const size = Number(query.get('page_size') ?? 50);
      const offset = Number(query.get('cursor') ?? 0);
      const since = Date.parse(query.get('created_at__gte') ?? '') || 0;
      // Recherche libre documentée : référence, nom, e-mail, téléphone du client.
      const search = (query.get('search') ?? '').toLowerCase();
      const digits = search.replace(/\D/g, '');
      const matches = (tx: Record<string, unknown>) => !search
        || String(tx.reference ?? '').toLowerCase().includes(search)
        || String(tx._email ?? '').toLowerCase().includes(search)
        || (digits.length >= 6 && String(tx._phone ?? '').replace(/\D/g, '').includes(digits));
      const rows = [...transactions.values()].filter((tx) => matches(tx) && (!listingHonoursFilters
        || ((!query.get('status') || tx.status === query.get('status'))
          && (Date.parse(String(tx.created_at ?? new Date(NOW).toISOString())) >= since))));
      query.set('cursor', String(offset + size));
      const next = offset + size < rows.length ? `${url.origin}/api/v1/transactions/?${query.toString()}` : null;
      const page = rows.slice(offset, offset + size).map((row) => shown(row, listingOmitsDescription));
      return jsonResponse({ success: true, code: 200, data: { next: nextOverride ?? next, previous: null, results: page } });
    }
    if (call.method === 'GET' && call.path === '/pricing/my-rates/') return jsonResponse({ success: true, data: rates, code: 200 });
    if (call.method === 'GET' && call.path.startsWith('/merchant-balances/')) {
      return jsonResponse({ success: true, code: 200, data: { count: 2, next: null, previous: null, results: [
        { id: 'bal-ml', merchant: 'm1', country: 'ML', currency: 'XOF', available_amount: '125000.00', pending_amount: '5000.00', is_frozen: false, updated_at: '2026-11-13T09:00:00Z' },
        { id: 'bal-sn', merchant: 'm1', country: 'SN', currency: 'XOF', available_amount: '900.00', pending_amount: '0.00', is_frozen: true, updated_at: '2026-11-12T09:00:00Z' },
      ] } });
    }
    return jsonResponse({ success: false, error: { code: 'not_found', message: 'Not found' }, code: 404 }, 404);
  }) as typeof fetch;

  return {
    fetcher, calls, transactions, sessions,
    /** Force la prochaine réponse (ou toutes) pour simuler une panne. */
    respondWith(responder: Responder | null) { override = responder; },
    setRates(next: unknown[]) { rates = next; },
    /** Simule une API qui ignorerait les filtres de la liste des transactions. */
    ignoreListFilters() { listingHonoursFilters = false; },
    /**
     * Simule une liste de transactions SANS champ `description` : la
     * spécification OpenAPI ne le garantit pas (il n'apparaît que dans un exemple).
     */
    omitListDescriptions(omit = true) { listingOmitsDescription = omit; },
    /** Même chose pour `GET /payments/{id}/verify/` : le libellé n'y est qu'un exemple. */
    omitVerifyDescriptions(omit = true) { verifyOmitsDescription = omit; },
    /** SasPay restitue (ou non) les `metadata` transmises : aucun schéma ne le garantit. */
    exposeMetadata(expose = true) { exposeMetadata = expose; },
    /** Les `n` prochaines créations softpay ABOUTISSENT chez SasPay mais leur réponse se perd. */
    loseSoftpayResponses(n = 1) { lostResponses = n; },
    /** Les `n` prochaines créations softpay n'atteignent jamais SasPay. */
    dropSoftpayRequests(n = 1) { droppedRequests = n; },
    /** Force l'adresse de page suivante renvoyée par la liste (curseur hostile). */
    setNextPage(next: string | null) { nextOverride = next; },
    /** Paiement encaissé chez SasPay sans que VYORA en ait eu connaissance. */
    addTransaction(patch: Record<string, unknown>) {
      sequence += 1;
      const id = String(patch.id ?? `tx-${String(sequence).padStart(8, '0')}`);
      transactions.set(id, {
        id, reference: `SP-${id}`, status: 'SUCCESS', currency: 'XOF', fee_charge_mode: 'ADD_ON', client_fee: '0.00',
        // Comme dans l'exemple documenté : le champ existe, même sans libellé.
        description: null,
        transaction_type: 'PAIEMENT', flow_direction: 'INBOUND', created_at: new Date(NOW).toISOString(), ...patch,
      });
      return id;
    },
    setTransaction(id: string, patch: Record<string, unknown>) {
      transactions.set(id, { ...(transactions.get(id) ?? { id }), ...patch });
    },
    /** Simule le paiement d'une session hébergée : crée la transaction liée. */
    paySession(sessionId: string, txStatus = 'SUCCESS') {
      const session = sessions.get(sessionId) as Record<string, unknown>;
      sequence += 1;
      const id = `tx-${String(sequence).padStart(8, '0')}`;
      transactions.set(id, {
        id, reference: `SP-${id}`, status: txStatus, requested_amount: session.amount, currency: session.currency,
        fee_charge_mode: 'DEDUCTED', client_fee: '0.00', debited_amount: session.amount,
        net_amount: (Number(session.amount) * 0.97).toFixed(2),
        description: session.description ?? null, transaction_type: 'PAIEMENT', flow_direction: 'INBOUND',
        created_at: new Date(NOW).toISOString(),
      });
      Object.assign(session, { status: txStatus === 'SUCCESS' ? 'PAID' : 'PENDING', transaction_id: id, transaction_status: txStatus, transaction_reference: `SP-${id}` });
      return id;
    },
    /** Le compte ignore le mode de frais envoyé par l'API (réglage par défaut du compte appliqué). */
    ignoreFeeModeOverride() { allowFeeModeOverride = false; },
    /** Frais d'encaissement du faux SasPay, en centièmes, d'après le montant demandé. */
    setFee(fn: (amountCents: bigint) => bigint) { feeOf = fn; },
    count(method: string, pathPrefix: string) {
      return calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix)).length;
    },
  };
}

/** Fabrique une requête de webhook signée comme le ferait SasPay. */
export async function signedWebhook(body: unknown, options: { secret?: string; timestamp?: number; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(NOW / 1000));
  const signature = await signWebhook(options.secret ?? WEBHOOK_SECRET, timestamp, raw);
  return { raw, timestamp, signature };
}
