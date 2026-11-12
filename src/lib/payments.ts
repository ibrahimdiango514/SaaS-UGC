/**
 * Paiements SasPay — côté navigateur.
 *
 * Le navigateur ne détient aucune clé et ne décide de rien : il transmet une
 * INTENTION (produit, article, réseau, numéro) à l'Edge Function `vyora-payments`.
 * Le prix, les crédits, les frais et l'état du paiement viennent toujours du
 * serveur. Un paiement n'est « confirmé » que lorsque le serveur l'a vérifié
 * auprès de SasPay ; l'URL de retour ou un message local ne prouvent rien.
 */
import { invokeEdge, rpc } from './api';

export type PaymentProduct = 'studio' | 'business';
export type PaymentFlow = 'softpay' | 'checkout';
/** Les cinq états présentés à l'utilisateur. */
export type PaymentState = 'todo' | 'pending' | 'confirmed' | 'failed' | 'cancelled';

export type PaymentItem =
  | { kind: 'pack'; pack_key: string }
  | { kind: 'custom'; amount_xof: number }
  | { plan_key: string };

export interface FeeQuote {
  fee: string;
  mode: 'ADD_ON' | 'DEDUCTED';
  /** Montant débité au client. */
  total: string;
  /** Montant reçu par VYORA. */
  net: string;
}

export interface PaymentNetwork {
  code: string;
  label: string;
  available: boolean;
  otp_required: boolean;
  fee: FeeQuote | null;
}

export interface PaymentCountry {
  code: string;
  name: string;
  currency: string | null;
  dial_code: string | null;
  national_number_length: number | null;
  networks: PaymentNetwork[];
}

export interface PaymentPrice {
  amount: string;
  currency: string;
  label?: string;
  credits?: number;
  period_days?: number;
  monthly_credit_units?: number;
}

export interface PaymentOptions {
  product: PaymentProduct;
  available: boolean;
  reason: string | null;
  message: string | null;
  mode: 'test' | 'live';
  flows: PaymentFlow[];
  price: PaymentPrice | null;
  countries: PaymentCountry[];
}

export interface PaymentOrder {
  product: PaymentProduct;
  id: string;
  status: string;
  state: PaymentState;
  amount: string;
  currency: string;
  country?: string;
  internal_reference: string;
  label?: string | null;
  credits?: number | null;
  plan_key?: string | null;
  period_days?: number | null;
  payment_flow?: PaymentFlow | null;
  network_code?: string | null;
  payer_msisdn_masked?: string | null;
  checkout_url?: string | null;
  quoted_fee_mode?: string | null;
  quoted_fee_amount?: string | null;
  quoted_total_amount?: string | null;
  fee_charge_mode?: string | null;
  fee_amount?: string | null;
  charged_amount?: string | null;
  net_amount?: string | null;
  failure_code?: string | null;
  created_at?: string;
  paid_at?: string | null;
  /** Listes lues en base : un paiement SasPay est-il rattaché à la commande ? */
  has_payment?: boolean | null;
  /** Vue administrateur uniquement. */
  user_email?: string | null;
  provider_payment_id?: string | null;
  provider_session_id?: string | null;
  provider_status?: string | null;
}

export interface CreatePaymentResult {
  order: PaymentOrder;
  next: 'await_confirmation' | 'redirect' | 'done' | 'failed';
  reused: boolean;
}

export interface PaymentStatusResult {
  order: PaymentOrder;
  verified: boolean;
  credited: boolean;
  message: string | null;
}

export interface SasPayBalance {
  id: string;
  country: string;
  currency: string;
  available_amount: string;
  pending_amount: string;
  is_frozen: boolean;
  updated_at?: string | null;
}

export interface SasPayBalances {
  configured: boolean;
  mode: 'test' | 'live' | 'unknown' | null;
  balances: SasPayBalance[];
  message: string | null;
}

export interface CreatePaymentInput {
  product: PaymentProduct;
  item: PaymentItem;
  country: string;
  flow: PaymentFlow;
  network?: string;
  phone?: string;
  idempotencyKey: string;
}

const FUNCTION = 'vyora-payments';

export function getPaymentOptions(product: PaymentProduct, item?: PaymentItem): Promise<PaymentOptions> {
  return invokeEdge<PaymentOptions>(FUNCTION, { action: 'options', product, ...(item ? { item } : {}) });
}

/** Ne transmet ni prix ni crédits : le serveur relit sa propre grille. */
export function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  return invokeEdge<CreatePaymentResult>(FUNCTION, {
    action: 'create',
    product: input.product,
    item: input.item,
    country: input.country,
    flow: input.flow,
    ...(input.flow === 'softpay' ? { network: input.network, phone: input.phone } : {}),
    idempotency_key: input.idempotencyKey,
  });
}

export function getPaymentStatus(product: PaymentProduct, orderId: string): Promise<PaymentStatusResult> {
  return invokeEdge<PaymentStatusResult>(FUNCTION, { action: 'status', product, order_id: orderId });
}

export function getSasPayBalances(): Promise<SasPayBalances> {
  return invokeEdge<SasPayBalances>(FUNCTION, { action: 'balances' });
}

export async function listMyPayments(product: PaymentProduct, limit = 20): Promise<PaymentOrder[]> {
  const rows = await rpc<PaymentOrder[] | null>('vyora_my_payments', { p_product: product, p_limit: limit });
  return Array.isArray(rows) ? rows.map(withState) : [];
}

export async function adminListPayments(product: PaymentProduct, limit = 100): Promise<PaymentOrder[]> {
  const rows = await rpc<PaymentOrder[] | null>('vyora_admin_payments', { p_product: product, p_limit: limit });
  return Array.isArray(rows) ? rows.map(withState) : [];
}

export interface BusinessSubscription {
  plan_key: string;
  plan_label: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  is_current: boolean;
}

export function getBusinessSubscription(): Promise<BusinessSubscription | null> {
  return rpc<BusinessSubscription | null>('vyora_business_subscription');
}

/* -------------------------------------------------------------------------- */
/* Aides pures (testées)                                                      */
/* -------------------------------------------------------------------------- */

/** Même correspondance que le serveur, pour les listes lues directement en base. */
export function paymentStateOf(order: {
  status?: string | null; state?: string | null; has_payment?: boolean | null;
  provider_payment_id?: string | null; provider_session_id?: string | null;
}): PaymentState {
  if (order.state === 'todo' || order.state === 'pending' || order.state === 'confirmed'
    || order.state === 'failed' || order.state === 'cancelled') return order.state;
  switch (order.status) {
    case 'paid': case 'refunded': return 'confirmed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'processing': return 'pending';
    default: return (order.has_payment ?? Boolean(order.provider_payment_id || order.provider_session_id)) ? 'pending' : 'todo';
  }
}

function withState(order: PaymentOrder): PaymentOrder {
  return { ...order, state: paymentStateOf(order) };
}

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  todo: 'À effectuer',
  pending: 'En attente',
  confirmed: 'Confirmé',
  failed: 'Échoué',
  cancelled: 'Annulé',
};

export const PAYMENT_STATE_TONES: Record<PaymentState, string> = {
  todo: 'neutral', pending: 'warning', confirmed: 'success', failed: 'danger', cancelled: 'danger',
};

/** Un paiement terminé n'a plus besoin d'être interrogé. */
export function isFinalState(state: PaymentState): boolean {
  return state === 'confirmed' || state === 'failed' || state === 'cancelled';
}

/**
 * Affiche un montant décimal transmis en chaîne (« 5000.00 » → « 5 000 FCFA »).
 * Aucun calcul flottant : la partie entière est regroupée telle quelle et les
 * centimes ne sont montrés que s'ils sont non nuls.
 */
export function formatAmount(value: string | number | null | undefined, currency = 'XOF'): string {
  if (value === null || value === undefined || value === '') return '—';
  const text = typeof value === 'number' ? value.toFixed(2) : value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return '—';
  const whole = match[1].replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const cents = (match[2] ?? '').padEnd(2, '0');
  const unit = currency === 'XOF' ? 'FCFA' : currency;
  return `${whole}${cents === '00' ? '' : `,${cents}`}\u00a0${unit}`;
}

/** Phrase décrivant qui supporte les frais, sans rien inventer si le devis manque. */
export function describeFee(fee: FeeQuote | null, currency = 'XOF'): string {
  if (!fee) return 'Frais éventuels de l’opérateur indiqués avant validation.';
  if (fee.fee === '0.00') return 'Aucuns frais de paiement.';
  return fee.mode === 'ADD_ON'
    ? `Frais de paiement estimés : ${formatAmount(fee.fee, currency)} en sus — total débité ${formatAmount(fee.total, currency)}.`
    : `Frais de paiement inclus : vous payez ${formatAmount(fee.total, currency)}, sans supplément.`;
}

/** Validation locale d'un numéro (confort de saisie : le serveur revalide). */
export function isPlausiblePhone(input: string, country: Pick<PaymentCountry, 'dial_code' | 'national_number_length'>): boolean {
  const dial = String(country.dial_code ?? '').replace(/\D/g, '');
  const length = Number(country.national_number_length ?? 0);
  if (!dial || !length) return false;
  let digits = input.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return false;
  return digits.length === length || (digits.startsWith(dial) && digits.length === dial.length + length);
}

/**
 * Clé d'idempotence d'une INTENTION de paiement.
 *
 * Une même intention (mêmes choix) garde la même clé : un double clic ou un
 * renvoi après coupure réseau retombe sur la même commande, sans second débit.
 * Dès qu'un choix change (réseau, numéro, parcours) ou après un échec définitif,
 * une nouvelle clé est tirée, sinon le serveur renverrait l'ancienne commande.
 */
export function createIntentKeeper(random: () => string = () => crypto.randomUUID()) {
  let signature: string | null = null;
  let key = '';
  return {
    keyFor(intent: Record<string, unknown>): string {
      const next = JSON.stringify(Object.keys(intent).sort().map((name) => [name, intent[name] ?? null]));
      if (next !== signature) { signature = next; key = `vyora-${random()}`; }
      return key;
    },
    reset(): void { signature = null; key = ''; },
  };
}

export function isPaymentProduct(value: unknown): value is PaymentProduct {
  return value === 'studio' || value === 'business';
}

export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Lien sortant vers la page de paiement : https uniquement (le serveur applique
 * la même règle). Le domaine n'est pas filtré : la documentation SasPay ne fixe
 * pas celui de ses pages de paiement, et le lien ne vient que de notre serveur.
 */
export function isSafeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
