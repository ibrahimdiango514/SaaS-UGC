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
/**
 * États présentés à l'utilisateur. `unapplied` : paiement encaissé mais non
 * appliqué (Business Grow, abonnement incompatible au moment du paiement) —
 * rien n'a été livré, le support rembourse. État final.
 * `review` : la demande Mobile Money est partie, mais SasPay n'a pas répondu —
 * on ignore si le client a été sollicité ou débité. Ni payée, ni échouée :
 * aucun autre paiement n'est possible tant que ce doute n'est pas levé.
 */
export type PaymentState = 'todo' | 'pending' | 'review' | 'confirmed' | 'failed' | 'cancelled' | 'unapplied';

/** Motifs posés par la base sur une commande dont l'issue de création est inconnue. */
export const REVIEW_CODES: readonly string[] = ['initiation_unconfirmed', 'manual_review'];

/** Message par défaut d'une commande en vérification (le serveur fournit le sien quand il répond). */
export const REVIEW_MESSAGE = 'Le service de paiement n’a pas confirmé cette demande. Ne payez pas une seconde fois : '
  + 'si vous avez été débité, votre achat sera livré ; sinon la commande sera annulée sans frais.';

/** Motifs de refus d'activation d'un encaissement (posés par la base, définitifs). */
export const UNAPPLIED_CODES: readonly string[] = ['business_plan_change_not_supported', 'business_subscription_managed_elsewhere'];

/** Message montré au client dont le paiement a été reçu mais n'a pas pu être appliqué. */
export const UNAPPLIED_MESSAGE = 'Votre paiement a bien été reçu, mais il n’a pas pu être appliqué à votre abonnement en cours. '
  + 'Rien n’a été modifié sur votre abonnement. Le support a été alerté et vous remboursera intégralement.';

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
  /** Prix final à payer dans ce pays (présent quand le prix est tout compris). */
  price?: { amount: string; currency: string } | null;
}

/** Prix final d'un article du catalogue (pack Studio, formule Business Grow). */
export interface CatalogPrice {
  /** Prix final le plus bas parmi les pays ouverts. */
  amount: string;
  /** Prix final le plus élevé (différent seulement si les tarifs varient d'un pays à l'autre). */
  max_amount?: string;
  currency: string;
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
  /**
   * Vrai quand le prix affiché est le prix final : le client paie exactement
   * ce montant, aucuns frais ne s'ajoutent au moment de payer.
   */
  all_inclusive?: boolean;
  /** Prix finals par article, pour les pages de tarifs. */
  catalog?: Record<string, CatalogPrice> | null;
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
  /** Commande en vérification : la même demande peut-elle encore être relancée (sans nouveau paiement) ? */
  retry_allowed?: boolean;
  created_at?: string;
  paid_at?: string | null;
  /** Listes lues en base : un paiement SasPay est-il rattaché à la commande ? */
  has_payment?: boolean | null;
  /** Vue administrateur uniquement. */
  user_email?: string | null;
  provider_payment_id?: string | null;
  provider_session_id?: string | null;
  provider_status?: string | null;
  /** Remboursement (présent uniquement si la commande a été remboursée). */
  refunded_at?: string | null;
  refund_state?: RefundState | null;
  /** Montant à rendre au client, décidé par l'administrateur (chaîne décimale). */
  refund_amount?: string | null;
  refund_credits_recovered?: number | null;
  refund_credits_unrecovered?: number | null;
  refund_days_recovered?: number | null;
  refund_units_recovered?: number | null;
  refund_settled_at?: string | null;
  /** Vue administrateur uniquement : notes internes, jamais montrées au client. */
  refund_reason?: string | null;
  refund_external_reference?: string | null;
  refund_subscription_status?: string | null;
}

/**
 * Un remboursement se fait en deux temps, SANS mouvement d'argent par VYORA :
 *  - `credits_recovered` : crédits (ou jours d'abonnement) repris, argent à rendre ;
 *  - `settled` : l'administrateur atteste avoir rendu l'argent, référence à l'appui.
 */
export type RefundState = 'credits_recovered' | 'settled';

export interface CreatePaymentResult {
  order: PaymentOrder;
  /** `review` : SasPay n'a pas répondu — issue inconnue, voir `message`. */
  next: 'await_confirmation' | 'redirect' | 'done' | 'failed' | 'review';
  reused: boolean;
  message?: string | null;
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

/* -------------------------------------------------------------------------- */
/* Remboursements et exploitation (administrateur)                            */
/* -------------------------------------------------------------------------- */

/** Ce qu'un remboursement reprendrait maintenant. Calculé par le serveur. */
export interface RefundPreview {
  product: PaymentProduct;
  order_id: string;
  status: string;
  internal_reference: string;
  price_xof: number;
  /** Plafond de ce qui peut être rendu, au prorata de ce qui est repris. */
  max_refund_xof: number;
  needs_partial: boolean;
  refundable: boolean;
  blocked: string | null;
  // Studio
  credits_granted?: number;
  wallet_available?: number;
  wallet_reserved?: number;
  credits_recoverable?: number;
  credits_unrecoverable?: number;
  // Business Grow
  plan_key?: string;
  period_days?: number;
  subscription_status?: string | null;
  current_period_end?: string | null;
  days_recoverable?: number;
  new_period_end?: string | null;
  will_cancel?: boolean;
  /** Encaissement jamais appliqué : remboursement intégral, abonnement inchangé. */
  undelivered?: boolean;
  failure_code?: string | null;
}

export type RefundResult = PaymentOrder & { outcome?: 'refunded' | 'already_refunded' };

export function adminRefundPreview(product: PaymentProduct, orderId: string): Promise<RefundPreview> {
  return rpc<RefundPreview>('vyora_admin_refund_preview', { p_product: product, p_order_id: orderId });
}

/**
 * Enregistre un remboursement : reprend les crédits (ou la période d'abonnement)
 * et clôt la commande. N'envoie AUCUN argent : le versement se fait hors de
 * VYORA, puis s'atteste avec `adminSettleRefund`.
 */
export async function adminRecordRefund(input: {
  product: PaymentProduct; orderId: string; reason: string; amountXof: number; allowPartial: boolean;
}): Promise<RefundResult> {
  const row = await rpc<RefundResult>(
    input.product === 'studio' ? 'vyora_admin_refund_studio' : 'vyora_admin_refund_business',
    { p_order_id: input.orderId, p_reason: input.reason, p_refund_amount_xof: input.amountXof, p_allow_partial: input.allowPartial },
  );
  return { ...row, product: input.product, state: paymentStateOf(row) };
}

/** Atteste que l'argent a été rendu au client (référence du versement). */
export async function adminSettleRefund(product: PaymentProduct, orderId: string, reference: string): Promise<RefundResult> {
  const row = await rpc<RefundResult>('vyora_admin_refund_settle', {
    p_product: product, p_order_id: orderId, p_external_reference: reference,
  });
  return { ...row, product, state: paymentStateOf(row) };
}

export type AnomalyKind = 'order_stuck' | 'duplicate_payment' | 'payment_conflict' | 'amount_mismatch' | 'payment_not_found'
  | 'subscription_conflict' | 'sweep_unreliable' | 'initiation_unconfirmed'
  | 'fee_exceeds_provision' | 'net_below_base' | 'fee_mode_unexpected' | 'reconciliation_failed';

/** Anomalies qui ne se « classent » pas : elles exigent une décision sur la commande elle-même. */
export const DECISION_ANOMALIES: readonly string[] = ['initiation_unconfirmed'];

/**
 * Transaction SasPay qui RESSEMBLE à une commande sans réponse (montant, devise,
 * date). Ce n'est pas une preuve : SasPay ne restitue aucune référence marchande
 * recherchable. Seul l'administrateur peut la rattacher, après contrôle.
 */
export interface ReviewCandidate {
  id: string;
  reference?: string | null;
  status?: string | null;
  amount?: string | null;
  currency?: string | null;
  created_at?: string | null;
  /** `webhook` : annoncée par SasPay ; `search` : trouvée par recherche sur le numéro du payeur. */
  source?: 'webhook' | 'search' | string | null;
  /** Le numéro annoncé par SasPay est celui saisi par le client. */
  msisdn_match?: boolean | null;
}

/** Commande dont la création Mobile Money est restée sans réponse. */
export interface UnconfirmedPayment {
  product: PaymentProduct;
  order_id: string;
  internal_reference: string;
  user_email: string | null;
  amount: string | number;
  currency: string;
  network: string | null;
  payer_msisdn_masked: string | null;
  attempts: number;
  first_attempt_at: string | null;
  last_attempt_at: string | null;
  /** Rapprochement manuel ouvert : plus aucun rejeu automatique, décision attendue. */
  in_review: boolean;
  review_at: string | null;
  last_error: string | null;
  candidates: ReviewCandidate[];
  last_search_at: string | null;
}

export interface PaymentAnomaly {
  id: string;
  kind: AnomalyKind | string;
  product: PaymentProduct | null;
  order_id: string | null;
  internal_reference: string | null;
  provider_payment_id: string | null;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ReconcileRun {
  id: string;
  trigger_source: string;
  status: 'running' | 'ok' | 'partial' | 'error' | 'skipped' | string;
  started_at: string;
  finished_at: string | null;
  checked: number;
  settled: number;
  closed: number;
  errors: number;
  swept: number;
  anomalies: number;
  sweep_done: boolean;
  /** Le rattrapage a atteint sa limite de lecture : des encaissements n'ont pas été examinés. */
  sweep_truncated?: boolean;
  /** La liste SasPay ne portait aucun libellé : le rattrapage par référence était impossible. */
  sweep_blind?: boolean;
}

export interface PaymentHealth {
  enabled: boolean;
  mode: 'test' | 'live' | string;
  cron: { available: boolean; scheduled: boolean; schedule?: string; active?: boolean };
  /** Prérequis de l'appel planifié : jeton présent dans le coffre, extension HTTP disponible. */
  dispatch?: { token_present: boolean; http_available: boolean };
  open_orders: { studio: number; business: number };
  refunds_awaiting_settlement: number;
  runs: ReconcileRun[];
  anomalies: PaymentAnomaly[];
  /** Créations Mobile Money sans réponse, non soldées. */
  unconfirmed: UnconfirmedPayment[];
}

export async function adminPaymentHealth(): Promise<PaymentHealth | null> {
  const row = await rpc<PaymentHealth | null>('vyora_admin_payment_health');
  // Réponse inattendue : « inconnu », jamais un état sain inventé.
  if (!row || typeof row !== 'object' || Array.isArray(row) || !row.cron || !Array.isArray(row.runs)) return null;
  const unconfirmed = (Array.isArray(row.unconfirmed) ? row.unconfirmed : [])
    .map((line) => ({ ...line, candidates: Array.isArray(line.candidates) ? line.candidates : [] }));
  return { ...row, anomalies: Array.isArray(row.anomalies) ? row.anomalies : [], unconfirmed };
}

export interface ReviewResolution {
  order: PaymentOrder;
  outcome: string;
  credited: boolean;
}

/**
 * Rattache une transaction SasPay à une commande en rapprochement manuel. Le
 * serveur relit la transaction chez SasPay et refuse tout écart (montant,
 * devise, sens, date, autre référence) : rien n'est livré sans `SUCCESS` vérifié.
 */
export function adminAttachReviewPayment(input: {
  product: PaymentProduct; orderId: string; paymentId: string; note: string;
}): Promise<ReviewResolution> {
  return invokeEdge<ReviewResolution>(FUNCTION, {
    action: 'resolve_review', product: input.product, order_id: input.orderId, payment_id: input.paymentId, note: input.note,
  });
}

/**
 * Clôt une commande en rapprochement manuel quand l'administrateur atteste
 * qu'AUCUN encaissement n'existe chez SasPay. Le client peut alors repayer. Un
 * encaissement vérifié plus tard rouvrirait et livrerait la commande.
 */
export function adminCloseUnconfirmed(product: PaymentProduct, orderId: string, note: string): Promise<unknown> {
  return rpc<unknown>('vyora_admin_close_unconfirmed', { p_product: product, p_order_id: orderId, p_note: note });
}

export function adminResolveAnomaly(anomalyId: string, note: string): Promise<PaymentAnomaly> {
  return rpc<PaymentAnomaly>('vyora_admin_resolve_anomaly', { p_anomaly_id: anomalyId, p_note: note });
}

export const ANOMALY_LABELS: Record<string, string> = {
  order_stuck: 'Paiement bloqué depuis plus de 24 h',
  duplicate_payment: 'Double encaissement pour une même commande',
  payment_conflict: 'Encaissement non rattachable à la commande',
  amount_mismatch: 'Montant encaissé différent de la commande',
  payment_not_found: 'Paiement introuvable chez SasPay',
  subscription_conflict: 'Paiement encaissé mais non appliqué à l’abonnement',
  sweep_unreliable: 'Rattrapage des paiements incomplet',
  initiation_unconfirmed: 'Demande de paiement restée sans réponse de SasPay',
  fee_exceeds_provision: 'Frais SasPay supérieurs à la provision',
  net_below_base: 'Net reçu inférieur au prix de base',
  fee_mode_unexpected: 'Frais ajoutés au client au lieu d’être déduits',
  reconciliation_failed: 'Rapprochement financier non enregistré',
};

/** Ce qu'il faut faire, en clair, face à chaque anomalie. */
export const ANOMALY_ADVICE: Record<string, string> = {
  order_stuck: 'Vérifiez la transaction dans le tableau de bord SasPay. La commande reste revérifiée automatiquement.',
  duplicate_payment: 'Le client a été débité deux fois : un seul achat a été livré. Rendez le second paiement au client, puis classez l’anomalie.',
  payment_conflict: 'Un encaissement réussi porte la référence d’une commande liée à une autre transaction. Rien n’a été livré : comparez les deux transactions chez SasPay.',
  amount_mismatch: 'Rien n’a été livré. Rendez le montant encaissé au client ou demandez-lui de repasser commande.',
  payment_not_found: 'SasPay ne connaît pas cette transaction. La commande est close après 24 h ; un succès tardif la rouvrirait.',
  subscription_conflict: 'Le client a payé, mais son abonnement en cours ne permettait pas d’appliquer ce paiement : rien n’a été livré ni modifié. Remboursez-le intégralement depuis la liste des paiements Business Grow (« Rembourser »), rendez l’argent, puis attestez le versement : l’anomalie se classera seule.',
  initiation_unconfirmed: 'La demande Mobile Money est partie, mais SasPay n’a jamais répondu : on ignore si le client a été débité. Rien n’a été livré et le client ne peut lancer aucun autre paiement. Cherchez la transaction dans le tableau de bord SasPay (numéro, montant, heure), puis tranchez dans « Paiements sans réponse » : rattachez-la, ou attestez qu’aucun encaissement n’existe.',
  fee_exceeds_provision: 'Le client a été livré normalement. Les frais réels de cette transaction dépassent la provision facturée : la marge est entamée. Importez les tarifs du compte SasPay (Finances → Barème) pour que les prochains prix couvrent ces frais, ou relevez la provision.',
  net_below_base: 'Le client a été livré normalement, mais VYORA a reçu moins que le prix de base de l’article : cette vente est déficitaire. Vérifiez le barème et la provision dans Finances.',
  fee_mode_unexpected: 'SasPay a AJOUTÉ les frais au montant demandé au lieu de les déduire : le client a payé plus que le prix affiché. Dans le tableau de bord SasPay, Paramètres → Frais, activez « Autoriser le choix du mode de frais par l’API » ou choisissez le mode « Déduits » par défaut. Envisagez de rendre la différence au client.',
  reconciliation_failed: 'Le paiement est confirmé et le client livré, mais la ligne de rapprochement (frais, net, marge) n’a pas pu être écrite. Relancez « Reprendre l’historique » dans Finances ; si l’erreur persiste, transmettez le détail au support technique.',
  sweep_unreliable: 'La liste des transactions SasPay n’a pas permis de rechercher les paiements dont la réponse s’est perdue (libellé absent, ou trop de transactions à lire). Les paiements rattachés à une commande restent revérifiés un par un. Comparez les encaissements récents du tableau de bord SasPay avec la liste des paiements.',
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  running: 'En cours', ok: 'Réussie', partial: 'Partielle', error: 'En erreur', skipped: 'Ignorée',
};

/** Étiquette de remboursement d'une commande, ou `null` si elle n'est pas remboursée. */
export function refundBadge(order: Pick<PaymentOrder, 'status' | 'refund_state'>): { label: string; tone: string } | null {
  if (order.status !== 'refunded') return null;
  return order.refund_state === 'settled'
    ? { label: 'Remboursé', tone: 'neutral' }
    : { label: 'Remboursement en cours', tone: 'warning' };
}

/**
 * Montant de remboursement saisi : entier de francs CFA, entre 1 et le plafond
 * calculé par le serveur. Confort de saisie — le serveur revalide.
 */
export function parseRefundAmount(input: string, maxXof: number): number | null {
  const text = input.replace(/[\s\u00a0\u202f]/g, '');
  if (!/^\d{1,9}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= maxXof ? value : null;
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
  provider_payment_id?: string | null; provider_session_id?: string | null; failure_code?: string | null;
}): PaymentState {
  if (order.state === 'todo' || order.state === 'pending' || order.state === 'review' || order.state === 'confirmed'
    || order.state === 'failed' || order.state === 'cancelled' || order.state === 'unapplied') return order.state;
  if (order.status !== 'paid' && order.status !== 'refunded'
    && typeof order.failure_code === 'string' && UNAPPLIED_CODES.includes(order.failure_code)) return 'unapplied';
  // Création sans réponse : ni « à effectuer » (le client a peut-être payé), ni échouée.
  if ((order.status === 'pending' || order.status === 'processing')
    && typeof order.failure_code === 'string' && REVIEW_CODES.includes(order.failure_code)) return 'review';
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
  review: 'En vérification',
  confirmed: 'Confirmé',
  failed: 'Échoué',
  cancelled: 'Annulé',
  unapplied: 'Reçu, non appliqué',
};

export const PAYMENT_STATE_TONES: Record<PaymentState, string> = {
  todo: 'neutral', pending: 'warning', review: 'warning', confirmed: 'success', failed: 'danger', cancelled: 'danger', unapplied: 'warning',
};

/** Un paiement terminé n'a plus besoin d'être interrogé. (`review` n'est PAS final : il peut encore être payé.) */
export function isFinalState(state: PaymentState): boolean {
  return state === 'confirmed' || state === 'failed' || state === 'cancelled' || state === 'unapplied';
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

/**
 * Prix à afficher sur une page de tarifs. Quand le paiement en ligne applique
 * un prix tout compris, c'est le prix final du catalogue serveur ; sinon le
 * prix de la grille. Le navigateur ne calcule jamais de frais lui-même.
 */
export function catalogPrice(
  options: Pick<PaymentOptions, 'available' | 'all_inclusive' | 'catalog'> | null | undefined,
  itemKey: string, fallback: number, currency = 'XOF',
): { label: string; amount: number; from: boolean } {
  const entry = options?.available === true && options.all_inclusive === true ? options.catalog?.[itemKey] : null;
  const value = entry && /^\d+(\.\d{1,2})?$/.test(entry.amount) ? entry : null;
  if (!value) return { label: formatAmount(fallback, currency), amount: fallback, from: false };
  return {
    label: formatAmount(value.amount, value.currency),
    amount: Number(value.amount),
    from: Boolean(value.max_amount && value.max_amount !== value.amount),
  };
}

/** Prix final à payer dans un pays : celui du pays s'il est fourni, sinon le prix général. */
export function finalPrice(options: Pick<PaymentOptions, 'price'> | null | undefined, country?: Pick<PaymentCountry, 'price'> | null): string | null {
  return country?.price?.amount ?? options?.price?.amount ?? null;
}

/** Phrase décrivant qui supporte les frais, sans rien inventer si le devis manque. */
export function describeFee(fee: FeeQuote | null, currency = 'XOF', allInclusive = false): string {
  if (allInclusive) return 'Prix final, frais de paiement inclus : aucun supplément ne sera ajouté.';
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

/* -------------------------------------------------------------------------- */
/* Tarification, barème et rapprochement financier (administrateur)           */
/* -------------------------------------------------------------------------- */
/*
 * Unités transmises par le serveur : montants en CENTIÈMES entiers, taux en
 * MILLIÈMES DE POUR CENT (2,5 % = 2500). Le navigateur ne fait aucun calcul de
 * frais : il affiche ce que la base a calculé et convertit seulement les
 * saisies de l'administrateur, par manipulation de chaînes (aucun flottant).
 */

export type PricingStrategy = 'cover_fees' | 'provision_only';

export interface PricingPolicy {
  enabled: boolean;
  strategy: PricingStrategy;
  fee_charge_mode: 'DEDUCTED';
  currencies: Record<string, { provision_cents: number; rounding_step_cents: number }>;
}

export type TariffSource = 'saspay_documentation' | 'saspay_account_rates' | 'owner_provided';

export interface Tariff {
  id: string;
  transaction_type: 'payin' | 'payout';
  country_code: string | null;
  currency: string;
  network_code: string | null;
  min_amount_cents: number;
  max_amount_cents: number | null;
  percent_milli: number;
  fixed_cents: number;
  floor_fee_cents: number | null;
  cap_fee_cents: number | null;
  fee_base: 'total' | 'base';
  account_fee_mode: string | null;
  valid_from: string;
  valid_until: string | null;
  source: TariffSource;
  source_note: string | null;
  created_at: string;
  closed_at: string | null;
  active: boolean;
}

export interface MissingTariff {
  country_code: string;
  currency: string | null;
  network_code: string | null;
  network_label: string;
  flow: 'softpay' | 'checkout';
}

export interface PricingOverview {
  policy: PricingPolicy;
  tariffs: Tariff[];
  missing_tariffs: MissingTariff[];
  /** Lignes d'encaissement pour lesquelles le compte SasPay annonce des frais AJOUTÉS au client. */
  account_add_on_lines: number;
  /** Paiements confirmés sans ligne de rapprochement. */
  missing_reconciliations: number;
}

export interface PriceSimulation {
  policy_enabled: boolean;
  strategy: PricingStrategy;
  currency: string;
  country: string;
  network: string | null;
  base_cents: number;
  provision_cents: number;
  final_cents: number;
  surcharge_cents: number;
  estimated_fee_cents: number | null;
  expected_net_cents: number | null;
  expected_margin_cents: number | null;
  tariff_status: 'missing' | 'confirmed';
  tariff: { percent_milli: number; fixed_cents: number; floor_fee_cents: number | null; cap_fee_cents: number | null;
    fee_base: string; source: TariffSource; country_code: string | null; network_code: string | null } | null;
}

export interface PayoutSimulation {
  amount_cents: number;
  provision_cents: number;
  estimated_fee_cents: number | null;
  tariff_status: 'missing' | 'confirmed';
  account_fee_mode: string | null;
}

export interface FinanceStats {
  transactions: number;
  currency: string | null;
  /** Plus d'une devise dans le périmètre : les totaux ne sont pas additionnables. */
  currencies: number;
  gross_cents: number;
  base_cents: number;
  provision_cents: number;
  fee_known: number;
  fee_unknown: number;
  actual_fee_cents: number;
  actual_net_cents: number;
  margin_cents: number;
  estimated: number;
  estimated_fee_cents: number;
  expected_net_cents: number;
  compared: number;
  fee_variance_cents: number;
  refunded_cents: number;
  refunded: number;
  unprofitable: number;
  over_provision: number;
  tariff_missing: number;
}

export interface FinanceLine {
  product: PaymentProduct;
  order_id: string;
  internal_reference: string;
  item_key: string | null;
  country_code: string | null;
  network: string;
  currency: string;
  base_cents: number | null;
  provision_cents: number | null;
  final_cents: number | null;
  charged_cents: number | null;
  estimated_fee_cents: number | null;
  actual_fee_cents: number | null;
  actual_net_cents: number | null;
  margin_cents: number | null;
  fee_variance_cents?: number | null;
  refund_cents?: number | null;
  revision?: number;
  flags: string[];
  paid_at: string;
}

export interface FinanceReport {
  totals: FinanceStats | null;
  by_country: Array<FinanceStats & { country_code: string | null }>;
  by_network: Array<FinanceStats & { network: string }>;
  by_product: Array<FinanceStats & { product: PaymentProduct; item_key: string | null }>;
  unprofitable: FinanceLine[];
  recent: FinanceLine[];
}

export interface FinanceFilters {
  from?: string | null;
  to?: string | null;
  country?: string | null;
  network?: string | null;
  product?: PaymentProduct | null;
  limit?: number;
}

export interface TariffInput {
  transaction_type: 'payin' | 'payout';
  country_code: string | null;
  currency: string;
  network_code: string | null;
  min_amount_cents: number;
  max_amount_cents: number | null;
  percent_milli: number;
  fixed_cents: number;
  floor_fee_cents: number | null;
  cap_fee_cents: number | null;
  fee_base: 'total' | 'base';
  source: 'saspay_documentation' | 'owner_provided';
  source_note: string;
  /** Tarif nul affirmé explicitement (jamais obtenu par oubli). */
  confirmed_free?: boolean;
}

export interface RatesImport {
  mode: 'test' | 'live';
  inserted: number;
  unchanged: number;
  closed: number;
  skipped: number;
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

export async function adminPricingOverview(): Promise<PricingOverview | null> {
  const row = await rpc<PricingOverview | null>('vyora_admin_pricing_overview');
  // Réponse inattendue : « inconnu », jamais une politique inventée.
  if (!row || typeof row !== 'object' || !row.policy || typeof row.policy.enabled !== 'boolean') return null;
  return {
    ...row,
    tariffs: list<Tariff>(row.tariffs),
    missing_tariffs: list<MissingTariff>(row.missing_tariffs),
    account_add_on_lines: Number(row.account_add_on_lines ?? 0),
    missing_reconciliations: Number(row.missing_reconciliations ?? 0),
  };
}

export function adminSetPricingPolicy(policy: Omit<PricingPolicy, 'fee_charge_mode'>): Promise<PricingPolicy> {
  return rpc<PricingPolicy>('vyora_admin_set_pricing_policy', { p_policy: policy });
}

export function adminAddTariff(tariff: TariffInput): Promise<Tariff> {
  return rpc<Tariff>('vyora_admin_add_tariff', { p_tariff: tariff });
}

export function adminCloseTariff(id: string, note: string): Promise<Tariff> {
  return rpc<Tariff>('vyora_admin_close_tariff', { p_tariff_id: id, p_note: note });
}

export function adminPriceSimulation(baseCents: number, currency: string, country: string, network: string | null): Promise<PriceSimulation> {
  return rpc<PriceSimulation>('vyora_admin_price_simulation', {
    p_base_cents: baseCents, p_currency: currency, p_country: country, p_network: network,
  });
}

export function adminPayoutSimulation(amountCents: number, currency: string, country: string, network: string | null): Promise<PayoutSimulation> {
  return rpc<PayoutSimulation>('vyora_admin_payout_simulation', {
    p_amount_cents: amountCents, p_currency: currency, p_country: country, p_network: network,
  });
}

export async function adminFinanceReport(filters: FinanceFilters = {}): Promise<FinanceReport | null> {
  const row = await rpc<FinanceReport | null>('vyora_admin_finance_report', {
    p_from: filters.from ?? null, p_to: filters.to ?? null, p_country: filters.country ?? null,
    p_network: filters.network ?? null, p_product: filters.product ?? null, p_limit: filters.limit ?? 50,
  });
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  return {
    totals: row.totals && typeof row.totals === 'object' ? row.totals : null,
    by_country: list(row.by_country), by_network: list(row.by_network), by_product: list(row.by_product),
    unprofitable: list(row.unprofitable), recent: list(row.recent),
  };
}

/** Écrit les lignes de rapprochement manquantes des paiements déjà confirmés. */
export async function adminFinanceBackfill(): Promise<number> {
  const row = await rpc<{ recorded?: number } | null>('vyora_admin_finance_backfill');
  return Number(row?.recorded ?? 0);
}

/**
 * Importe dans le barème les tarifs du compte SasPay (lecture seule chez
 * SasPay : `GET /pricing/my-rates/`). Aucun paiement n'est créé.
 */
export function adminSyncRates(): Promise<RatesImport> {
  return invokeEdge<RatesImport>(FUNCTION, { action: 'sync_rates' });
}

/** Centièmes entiers → « 1 234,56 FCFA ». Valeur absente : « — » (jamais zéro). */
export function formatCents(cents: number | null | undefined, currency = 'XOF'): string {
  if (cents === null || cents === undefined || !Number.isSafeInteger(cents)) return '—';
  const abs = Math.abs(cents);
  const text = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return `${cents < 0 ? '−' : ''}${formatAmount(text, currency)}`;
}

/** Millièmes de pour cent → « 2,5 % ». */
export function formatPercentMilli(milli: number | null | undefined): string {
  if (milli === null || milli === undefined || !Number.isSafeInteger(milli) || milli < 0) return '—';
  const frac = String(milli % 1000).padStart(3, '0').replace(/0+$/, '');
  return `${Math.trunc(milli / 1000)}${frac ? `,${frac}` : ''}\u00a0%`;
}

/**
 * Saisie décimale → entier mis à l'échelle (`digits` décimales), sans flottant.
 * « 2,5 » avec 3 décimales → 2500 ; « 1000 » avec 2 décimales → 100000.
 * Renvoie `null` si la saisie est vide, négative, trop précise ou trop grande.
 */
export function parseScaled(input: string, digits: number): number | null {
  const text = input.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const match = /^(\d{1,12})(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const frac = match[2] ?? '';
  if (frac.length > digits) return null;
  const value = Number(`${match[1]}${frac.padEnd(digits, '0')}`);
  return Number.isSafeInteger(value) ? value : null;
}

export const TARIFF_SOURCE_LABELS: Record<string, string> = {
  saspay_account_rates: 'Tarifs du compte SasPay (import)',
  saspay_documentation: 'Documentation SasPay',
  owner_provided: 'Fourni par le propriétaire',
};

export const FINANCE_FLAG_LABELS: Record<string, string> = {
  legacy_pricing: 'Ancienne tarification (sans provision)',
  tariff_missing: 'Tarif SasPay non confirmé lors de la commande',
  charged_assumed: 'Montant débité non restitué par SasPay (supposé égal au prix)',
  fee_unknown: 'Frais réels non restitués par SasPay',
  fee_exceeds_provision: 'Frais supérieurs à la provision',
  net_below_base: 'Net inférieur au prix de base',
  fee_mode_unexpected: 'Frais ajoutés au client au lieu d’être déduits',
};
