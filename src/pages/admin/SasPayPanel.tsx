/**
 * Administration — paiements SasPay.
 *
 *  - Les soldes marchands sont lus chez SasPay par le serveur ; VYORA n'expose
 *    aucun retrait, transfert ni recharge de portefeuille.
 *  - Un paiement ne peut être ni créé, ni modifié, ni validé à la main : son état
 *    ne change que par une vérification auprès de SasPay (le bouton « Revérifier »
 *    ne fait que redemander cet état au serveur).
 *  - Seule écriture possible : enregistrer le remboursement d'un paiement
 *    confirmé (reprise de ce qui a été livré, sans mouvement d'argent), puis
 *    attester le versement fait hors de VYORA. Voir `SasPayOperations`.
 *  - Studio et Business Grow sont listés séparément, jamais additionnés.
 */
import { useCallback, useEffect, useState } from 'react';
import { Lock, RefreshCw, Wallet } from 'lucide-react';
import { Badge, Banner, Button, Card, CardHeader, EmptyState, Tabs } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  PAYMENT_STATE_LABELS, PAYMENT_STATE_TONES, adminListPayments, formatAmount, getPaymentStatus, getSasPayBalances,
  adminPaymentHealth, isFinalState, refundBadge, type PaymentHealth, type PaymentOrder, type PaymentProduct,
  type SasPayBalances,
} from '../../lib/payments';
import { PaymentHealthCard, RefundDialog, SettleRefundDialog } from './SasPayOperations';

const MODE_LABELS: Record<string, string> = { test: 'Mode test', live: 'Production', unknown: 'Mode inconnu' };

export default function SasPayPanel() {
  const [balances, setBalances] = useState<SasPayBalances | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [balanceBusy, setBalanceBusy] = useState(false);
  const [product, setProduct] = useState<PaymentProduct>('studio');
  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [ordersError, setOrdersError] = useState('');
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [health, setHealth] = useState<PaymentHealth | null>(null);
  const [healthError, setHealthError] = useState('');
  const [healthBusy, setHealthBusy] = useState(false);
  const [refunding, setRefunding] = useState<PaymentOrder | null>(null);
  const [settling, setSettling] = useState<PaymentOrder | null>(null);

  const loadBalances = useCallback(async () => {
    setBalanceBusy(true); setBalanceError('');
    try {
      setBalances(await getSasPayBalances());
    } catch (err) {
      // Solde illisible : on l'indique, on n'affiche jamais « 0 ».
      setBalances(null);
      setBalanceError(asAppError(err, 'Les soldes SasPay n’ont pas pu être lus.').message);
    } finally { setBalanceBusy(false); }
  }, []);

  const loadOrders = useCallback(async (target: PaymentProduct) => {
    setOrdersBusy(true); setOrdersError('');
    try {
      setOrders(await adminListPayments(target, 100));
    } catch (err) {
      setOrders([]);
      setOrdersError(asAppError(err, 'Les paiements n’ont pas pu être chargés.').message);
    } finally { setOrdersBusy(false); }
  }, []);

  const loadHealth = useCallback(async () => {
    setHealthBusy(true); setHealthError('');
    try {
      setHealth(await adminPaymentHealth());
    } catch (err) {
      // Surveillance illisible : « non vérifiée », jamais « tout va bien ».
      setHealth(null);
      setHealthError(asAppError(err, 'L’état de la surveillance n’a pas pu être lu.').message);
    } finally { setHealthBusy(false); }
  }, []);

  const afterRefund = (message: string) => {
    setRefunding(null); setSettling(null); setNotice(message);
    void loadOrders(product); void loadHealth();
  };

  useEffect(() => { void loadBalances(); }, [loadBalances]);
  useEffect(() => { void loadHealth(); }, [loadHealth]);
  useEffect(() => { void loadOrders(product); }, [loadOrders, product]);

  const recheck = async (order: PaymentOrder) => {
    setChecking(order.id); setNotice('');
    try {
      const result = await getPaymentStatus(order.product, order.id);
      setNotice(result.message
        ?? `Commande ${order.internal_reference} : ${PAYMENT_STATE_LABELS[result.order.state].toLowerCase()} (état vérifié auprès de SasPay).`);
      await loadOrders(product);
    } catch (err) {
      setNotice(asAppError(err, 'Vérification impossible pour le moment.').message);
    } finally { setChecking(null); }
  };

  return (
    <div className="space-y-5" data-testid="saspay-panel">
      <Card>
        <CardHeader
          title="Soldes marchands SasPay"
          description="Lus chez SasPay par le serveur. Un portefeuille par pays : les montants ne sont jamais additionnés."
          action={(
            <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} loading={balanceBusy} onClick={() => void loadBalances()}>
              Actualiser
            </Button>
          )}
        />
        <div className="space-y-3 p-5">
          <p className="flex items-center gap-1.5 text-[11.5px] text-slate-400">
            <Lock size={12} className="text-slate-500" />
            Lecture seule : aucun retrait, transfert ni recharge n’est possible depuis VYORA.
          </p>
          {balanceError && <Banner tone="warning" title="Soldes non vérifiés">{balanceError}</Banner>}
          {balances && !balances.configured && (
            <Banner tone="info" title="SasPay non configuré">{balances.message ?? 'Aucune clé SasPay n’est installée côté serveur.'}</Banner>
          )}
          {balances?.configured && (
            <>
              <Badge tone={balances.mode === 'live' ? 'success' : 'warning'}>{MODE_LABELS[balances.mode ?? 'unknown'] ?? 'Mode inconnu'}</Badge>
              {balances.balances.length === 0 ? (
                <EmptyState icon={<Wallet size={22} />} title="Aucun portefeuille marchand" />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {balances.balances.map((b) => (
                    <div key={b.id} className="rounded-xl border border-line bg-white/[0.03] p-3" data-testid="saspay-balance">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-semibold text-slate-300">{b.country} · {b.currency}</p>
                        {b.is_frozen && <Badge tone="danger">Gelé</Badge>}
                      </div>
                      <p className="mt-1 text-lg font-semibold text-white">{formatAmount(b.available_amount, b.currency)}</p>
                      <p className="text-[11px] text-slate-500">Disponible</p>
                      <p className="mt-2 text-sm text-slate-300">{formatAmount(b.pending_amount, b.currency)}</p>
                      <p className="text-[11px] text-slate-500">En attente de règlement</p>
                      {b.updated_at && <p className="mt-2 text-[10.5px] text-slate-600">Mis à jour le {formatDate(b.updated_at, true)}</p>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      <PaymentHealthCard health={health} error={healthError} busy={healthBusy} onReload={() => void loadHealth()} />

      <Card>
        <CardHeader
          title="Paiements SasPay"
          description="L’état d’un paiement ne change que par vérification auprès de SasPay. Un paiement confirmé peut être remboursé : VYORA reprend ce qui a été livré, vous rendez l’argent."
          action={(
            <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} loading={ordersBusy} onClick={() => void loadOrders(product)}>
              Actualiser
            </Button>
          )}
        />
        <div className="px-5 pt-4">
          <Tabs
            active={product}
            onChange={(id) => setProduct(id === 'business' ? 'business' : 'studio')}
            tabs={[{ id: 'studio', label: 'Studio (crédits)' }, { id: 'business', label: 'Business Grow (abonnements)' }]}
          />
        </div>
        {notice && <p className="px-5 pt-3 text-[12px] text-amber-200" role="status">{notice}</p>}
        {ordersError && <div className="p-5"><Banner tone="danger" title="Chargement impossible">{ordersError}</Banner></div>}
        {!ordersError && orders.length === 0 && !ordersBusy && (
          <EmptyState icon={<Wallet size={22} />} title="Aucun paiement SasPay" description="Les paiements apparaissent ici dès leur création." />
        )}
        {orders.length > 0 && (
          <div className="divide-y divide-white/[0.06]">
            {orders.map((o) => (
              <div key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" data-testid="saspay-order">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">
                    {formatAmount(o.amount, o.currency)} · {o.label ?? '—'}
                    {typeof o.credits === 'number' ? ` → ${o.credits} crédits` : ''}
                  </p>
                  <p className="truncate text-[11px] text-slate-500">
                    {formatDate(o.created_at, true)} · {o.user_email ?? 'Utilisateur inconnu'} · {o.network_code ?? o.payment_flow ?? '—'}
                    {' · '}<span className="font-mono">{o.internal_reference}</span>
                  </p>
                  {o.state === 'confirmed' && (
                    <p className="text-[11px] text-slate-400">
                      Débité : {formatAmount(o.charged_amount, o.currency)} · Frais : {formatAmount(o.fee_amount, o.currency)}
                      {' '}· Net reçu : {formatAmount(o.net_amount, o.currency)}
                    </p>
                  )}
                  {o.state === 'unapplied' && (
                    <p className="text-[11px] text-amber-200" data-testid="saspay-unapplied">
                      Encaissé par SasPay mais non appliqué : rien n’a été livré. À rembourser intégralement au client.
                    </p>
                  )}
                  {o.failure_code && <p className="text-[11px] text-rose-300/80">Motif : {o.failure_code}</p>}
                  {o.status === 'refunded' && (
                    <p className="text-[11px] text-amber-200/90" data-testid="saspay-refund">
                      Remboursement de {formatAmount(o.refund_amount, o.currency)} enregistré le {formatDate(o.refunded_at ?? null, true)}
                      {typeof o.refund_credits_recovered === 'number' && ` · ${o.refund_credits_recovered} crédits repris`}
                      {typeof o.refund_credits_unrecovered === 'number' && o.refund_credits_unrecovered > 0 && ` (${o.refund_credits_unrecovered} déjà utilisés)`}
                      {typeof o.refund_days_recovered === 'number' && (o.refund_days_recovered > 0
                        ? ` · ${o.refund_days_recovered} jours retirés`
                        : ' · paiement jamais appliqué, abonnement inchangé')}
                      {o.refund_reason && ` · Motif : ${o.refund_reason}`}
                      {o.refund_state === 'settled'
                        ? ` · Versé le ${formatDate(o.refund_settled_at ?? null, true)} (réf. ${o.refund_external_reference ?? '—'})`
                        : ' · Versement au client non attesté'}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {refundBadge(o)
                    ? <Badge tone={refundBadge(o)?.tone}>{refundBadge(o)?.label}</Badge>
                    : <Badge tone={PAYMENT_STATE_TONES[o.state]}>{PAYMENT_STATE_LABELS[o.state]}</Badge>}
                  {(o.status === 'paid' || o.state === 'unapplied') && (
                    <Button size="sm" variant="outline" onClick={() => setRefunding(o)}>Rembourser</Button>
                  )}
                  {o.status === 'refunded' && o.refund_state !== 'settled' && (
                    <Button size="sm" variant="outline" onClick={() => setSettling(o)}>Attester le versement</Button>
                  )}
                  {!isFinalState(o.state) && (
                    <Button size="sm" variant="outline" loading={checking === o.id} onClick={() => void recheck(o)}>
                      Revérifier
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {refunding && <RefundDialog order={refunding} onClose={() => setRefunding(null)} onDone={afterRefund} />}
      {settling && <SettleRefundDialog order={settling} onClose={() => setSettling(null)} onDone={afterRefund} />}
    </div>
  );
}
