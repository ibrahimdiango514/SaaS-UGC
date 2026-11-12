// VYORA — persistance des paiements : appels RPC PostgREST avec la clé service.
//
// Aucune écriture directe en table : tout passe par les fonctions
// `public.vyora_payment_*` (réservées à `service_role`), qui portent les verrous,
// l'unicité et l'immuabilité. Studio et Business Grow ont des fonctions distinctes.

import {
  PaymentError,
  type CreateOrderInput, type OrderRecord, type PaymentItem, type PaymentStore, type Product,
  type QuoteContext, type SettleInput, type SettleResult,
} from './payments.ts';

export interface StoreConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetcher?: typeof fetch;
  log?: (event: string, details: Record<string, unknown>) => void;
}

/** Exceptions levées par la base → erreurs présentables. */
const DB_ERRORS: Record<string, [code: string, status: number, message: string]> = {
  payments_disabled: ['PAYMENTS_DISABLED', 503, 'Le paiement en ligne n’est pas encore activé.'],
  not_vyora_customer: ['PAYMENT_NOT_ELIGIBLE', 403, 'Ce compte ne peut pas acheter de crédits Studio.'],
  not_authenticated: ['PAYMENT_NOT_ELIGIBLE', 401, 'Session expirée, veuillez vous reconnecter.'],
  invalid_idempotency_key: ['PAYMENT_INVALID_REQUEST', 400, 'Identifiant d’opération invalide.'],
  idempotency_key_reused: ['PAYMENT_IDEMPOTENCY_CONFLICT', 409, 'Cette opération a déjà été lancée avec d’autres paramètres. Relancez un nouveau paiement.'],
  too_many_open_payments: ['PAYMENT_TOO_MANY_OPEN', 429, 'Plusieurs paiements sont déjà en attente. Terminez-les ou patientez avant d’en lancer un autre.'],
  payment_flow_not_allowed: ['PAYMENT_FLOW_NOT_ALLOWED', 422, 'Ce parcours de paiement n’est pas activé.'],
  payment_country_not_supported: ['PAYMENT_COUNTRY_NOT_SUPPORTED', 422, 'Ce pays n’est pas pris en charge pour le paiement.'],
  payment_network_not_supported: ['PAYMENT_NETWORK_NOT_SUPPORTED', 422, 'Ce moyen de paiement n’est pas proposé.'],
  payment_currency_not_supported: ['PAYMENT_CURRENCY_NOT_SUPPORTED', 422, 'Cette devise n’est pas prise en charge pour le paiement.'],
  unknown_pack: ['PAYMENT_INVALID_REQUEST', 400, 'Ce pack de crédits n’existe plus.'],
  invalid_order_kind: ['PAYMENT_INVALID_REQUEST', 400, 'Produit à payer invalide.'],
  invalid_pack_values: ['PAYMENT_PRICING_ERROR', 503, 'La grille tarifaire est incomplète. Aucun paiement n’a été lancé.'],
  custom_amount_out_of_bounds: ['PAYMENT_AMOUNT_OUT_OF_BOUNDS', 422, 'Le montant saisi est hors des limites autorisées.'],
  custom_recharge_not_configured: ['PAYMENT_PRICING_ERROR', 503, 'La recharge personnalisée n’est pas configurée.'],
  studio_pricing_not_configured: ['PAYMENT_PRICING_ERROR', 503, 'La grille tarifaire Studio n’est pas configurée.'],
  business_billing_disabled: ['BUSINESS_BILLING_DISABLED', 503, 'La facturation Business Grow n’est pas activée.'],
  business_plan_not_purchasable: ['BUSINESS_PLAN_NOT_PURCHASABLE', 422, 'Cette formule Business Grow n’est pas commercialisée.'],
  business_subscription_managed_elsewhere: ['BUSINESS_SUBSCRIPTION_MANAGED_ELSEWHERE', 409, 'Votre abonnement Business Grow est géré par un autre moyen de paiement. Contactez le support.'],
  business_plan_change_not_supported: ['BUSINESS_PLAN_CHANGE_NOT_SUPPORTED', 409, 'Une autre formule est déjà en cours. Vous pourrez changer de formule à la fin de la période, ou contactez le support.'],
  payment_order_not_found: ['PAYMENT_NOT_FOUND', 404, 'Commande introuvable.'],
  provider_reference_conflict: ['PAYMENT_REFERENCE_CONFLICT', 409, 'Ce paiement est déjà rattaché à une autre commande.'],
};

type Json = Record<string, unknown>;

export function createSupabasePaymentStore(config: StoreConfig): PaymentStore {
  const fetcher = config.fetcher ?? fetch;
  const base = config.supabaseUrl.replace(/\/+$/, '');

  async function rpc<T>(name: string, args: Json): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PaymentError('PAYMENT_STORAGE_UNAVAILABLE', 503, 'Le service est momentanément indisponible. Réessayez.');
    }
    const raw = await response.text();
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    if (!response.ok) {
      const message = typeof (parsed as Json | null)?.message === 'string' ? String((parsed as Json).message) : '';
      const known = DB_ERRORS[message];
      if (known) throw new PaymentError(known[0], known[1], known[2]);
      config.log?.('payment_rpc_failed', { rpc: name, status: response.status, db_message: message.slice(0, 160) });
      throw new PaymentError('PAYMENT_STORAGE_ERROR', 500, 'L’opération n’a pas pu être enregistrée. Aucun débit n’a été effectué par VYORA.');
    }
    return parsed as T;
  }

  const fn = (product: Product, studio: string, business: string) => (product === 'studio' ? studio : business);

  return {
    quote(userId, product, item) {
      return rpc<QuoteContext>('vyora_payment_quote', { p_user_id: userId, p_product: product, p_item: item });
    },

    createOrder(input: CreateOrderInput) {
      const common = {
        p_user_id: input.userId, p_country: input.country, p_flow: input.flow, p_network: input.network,
        p_idempotency_key: input.idempotencyKey, p_quoted_fee: input.quotedFee, p_quoted_total: input.quotedTotal,
        p_quoted_fee_mode: input.quotedFeeMode, p_msisdn_masked: input.msisdnMasked,
      };
      if (input.product === 'studio') {
        const item = input.item as Extract<PaymentItem, { kind: string }>;
        return rpc<OrderRecord & { reused: boolean }>('vyora_payment_create_studio_order', {
          ...common,
          p_kind: item.kind,
          p_pack_key: item.kind === 'pack' ? item.pack_key : null,
          p_amount_xof: item.kind === 'custom' ? item.amount_xof : null,
        });
      }
      return rpc<OrderRecord & { reused: boolean }>('vyora_payment_create_bg_order', {
        ...common, p_plan_key: (input.item as { plan_key: string }).plan_key,
      });
    },

    getOrder(product, orderId) {
      return rpc<OrderRecord | null>('vyora_payment_get_order', { p_product: product, p_order_id: orderId });
    },

    attach(product, orderId, refs) {
      return rpc<OrderRecord>(fn(product, 'vyora_payment_studio_attach', 'vyora_payment_bg_attach'), {
        p_order_id: orderId, p_payment_id: refs.paymentId, p_session_id: refs.sessionId,
        p_checkout_url: refs.checkoutUrl, p_provider_status: refs.providerStatus,
      });
    },

    settle(product, orderId, input: SettleInput) {
      return rpc<SettleResult>(fn(product, 'vyora_payment_studio_settle', 'vyora_payment_bg_settle'), {
        p_order_id: orderId, p_payment_id: input.paymentId, p_provider_status: input.status,
        // Chaînes décimales : PostgreSQL les convertit en `numeric` sans perte.
        p_requested_amount: input.requestedAmount, p_currency: input.currency, p_fee: input.fee,
        p_charged: input.charged, p_net: input.net, p_fee_mode: input.feeMode,
        p_reference: input.reference, p_source: input.source, p_failure_code: input.failureCode ?? null,
      });
    },

    async findOrder(refs) {
      const row = await rpc<{ product: Product; order_id: string } | null>('vyora_payment_find_order', {
        p_payment_id: refs.paymentId, p_session_id: refs.sessionId,
      });
      return row ? { product: row.product, orderId: row.order_id } : null;
    },

    async openCheckoutOrders(limit) {
      const rows = await rpc<Array<{ product: Product; order_id: string; session_id: string }> | null>(
        'vyora_payment_open_checkout_orders', { p_limit: limit },
      );
      return (rows ?? []).map((row) => ({ product: row.product, orderId: row.order_id, sessionId: row.session_id }));
    },

    recordWebhook(product, eventKey, eventType, payload) {
      return rpc<{ first: boolean; processed: boolean }>('vyora_payment_record_webhook', {
        p_product: product, p_event_key: eventKey, p_event_type: eventType, p_payload: payload,
      });
    },

    async finishWebhook(product, eventKey, ok, error) {
      await rpc<null>('vyora_payment_finish_webhook', {
        p_product: product, p_event_key: eventKey, p_ok: ok, p_error: error ?? null,
      });
    },

    async isAdmin(userId) {
      return (await rpc<boolean>('vyora_payment_is_admin', { p_user_id: userId })) === true;
    },
  };
}
