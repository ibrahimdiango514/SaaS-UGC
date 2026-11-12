// Doubles de test pour les paiements SasPay : faux SasPay (HTTP) et faux stockage.
// Le faux stockage reproduit les règles portées par la migration
// `vyora_saspay_payments` (prix serveur, idempotence, crédit unique).
import {
  type CreateOrderInput, type OrderRecord, type PaymentAnomaly, type PaymentStore, type Product, type QuoteContext,
  type ReconcileCounts, type SettleInput, type SettleResult, PaymentError,
} from '../../supabase/functions/_shared/saspay/payments';
import { signWebhook } from '../../supabase/functions/_shared/saspay/webhook';

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
  const runs: Array<{ id: string; source: string; status: string; counts?: ReconcileCounts & { detail?: Record<string, unknown> } }> = [];
  const reconcile = { sweep: true, due: null as Array<{ product: Product; orderId: string }> | null };
  /** Commandes dont la base refuserait l'activation (Business Grow : abonnement incompatible). */
  const activationBlocks = new Map<string, string>();

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
      return {
        product, enabled: config.enabled, mode: config.mode, flows: config.flows, countries: { ML: ML_COUNTRY },
        eligible, reason, price: eligible && hasItem ? price(product, raw) : null,
      };
    },

    async createOrder(input: CreateOrderInput) {
      calls.push('createOrder');
      const key = `${input.product}:${input.userId}:${input.idempotencyKey}`;
      const existing = byKey.get(key);
      if (existing) return { ...(orders.get(existing) as OrderRecord), reused: true };
      const quoted = price(input.product, input.item as Record<string, unknown>);
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
        payer_msisdn_masked: input.msisdnMasked, quoted_fee_amount: input.quotedFee,
        quoted_total_amount: input.quotedTotal, quoted_fee_mode: input.quotedFeeMode,
      };
      orders.set(id, order); byKey.set(key, id);
      return { ...order, reused: false };
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
      return { due: due.slice(0, limit), sweep: reconcile.sweep, sweepSince: new Date(NOW - 72 * 3_600_000).toISOString() };
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
  };

  return {
    store, orders, credits, webhooks, calls, config, anomalies, runs, reconcile,
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
      const key = headers['idempotency-key'];
      const replay = key ? idempotent.get(key) : undefined;
      if (replay) return jsonResponse({ success: true, data: replay, code: 201 }, 201);
      sequence += 1;
      const id = `tx-${String(sequence).padStart(8, '0')}`;
      const amount = String(call.body?.amount);
      transactions.set(id, {
        id, reference: `SP-${id}`, status: 'PENDING', requested_amount: amount, currency: call.body?.currency,
        fee_charge_mode: 'ADD_ON', client_fee: '100.00', debited_amount: (Number(amount) + 100).toFixed(2), net_amount: amount,
        description: call.body?.description ?? null, transaction_type: 'PAIEMENT', flow_direction: 'INBOUND',
        created_at: new Date(NOW).toISOString(),
      });
      const data = { message: 'Payment initiated', id, status: 'PENDING', checkout_url: '' };
      if (key) idempotent.set(key, data);
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
      return tx ? jsonResponse({ success: true, data: tx, code: 200 })
        : jsonResponse({ success: false, error: { code: 'not_found', message: 'Not found' }, code: 404 }, 404);
    }
    if (call.method === 'GET' && call.path.startsWith('/transactions/')) {
      // Liste paginée par curseur, au format documenté : `{next, previous, results}`.
      const query = new URL(`https://x${call.path}`).searchParams;
      const size = Number(query.get('page_size') ?? 50);
      const offset = Number(query.get('cursor') ?? 0);
      const since = Date.parse(query.get('created_at__gte') ?? '') || 0;
      const rows = [...transactions.values()].filter((tx) => (!listingHonoursFilters
        || ((!query.get('status') || tx.status === query.get('status'))
          && (Date.parse(String(tx.created_at ?? new Date(NOW).toISOString())) >= since))));
      query.set('cursor', String(offset + size));
      const next = offset + size < rows.length ? `${url.origin}/api/v1/transactions/?${query.toString()}` : null;
      const page = rows.slice(offset, offset + size).map((row) => {
        if (!listingOmitsDescription) return row;
        const { description: _omitted, ...rest } = row;
        return rest;
      });
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
