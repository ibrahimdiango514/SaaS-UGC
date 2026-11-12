/**
 * Page de retour après la page de paiement SasPay.
 *
 * Revenir ici ne prouve AUCUN paiement : l'adresse (et tout paramètre qu'elle
 * porte) peut être ouverte ou modifiée par n'importe qui. La page se contente de
 * demander au serveur l'état de la commande ; c'est le serveur qui interroge
 * SasPay et qui crédite, une seule fois, si le paiement est réellement confirmé.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Banner, Button, Card } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import {
  PAYMENT_STATE_LABELS, UNAPPLIED_MESSAGE, formatAmount, getPaymentStatus, isFinalState, isOrderId, isPaymentProduct,
  type PaymentOrder,
} from '../lib/payments';

export const RETURN_POLL_INTERVAL_MS = 4_000;
export const RETURN_POLL_MAX_MS = 120_000;

export default function PaymentReturn() {
  const [params] = useSearchParams();
  const { refreshQuota } = useAuth();
  const product = params.get('produit');
  const orderId = params.get('commande');
  const valid = isPaymentProduct(product) && isOrderId(orderId);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [waiting, setWaiting] = useState(valid);
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const refreshed = useRef(false);

  const backTo = product === 'business' ? '/app/business/abonnement' : '/app/credits';
  const backLabel = product === 'business' ? 'Retour à l’abonnement Business Grow' : 'Retour aux crédits Studio';

  const onOrder = useCallback((next: PaymentOrder) => {
    setOrder(next);
    if (next.state === 'confirmed' && next.product === 'studio' && !refreshed.current) {
      refreshed.current = true;
      void refreshQuota();
    }
  }, [refreshQuota]);

  useEffect(() => {
    if (!isPaymentProduct(product) || !isOrderId(orderId)) return undefined;
    let stopped = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    setWaiting(true); setTimedOut(false); setError('');
    const tick = async () => {
      if (stopped) return;
      try {
        const result = await getPaymentStatus(product, orderId);
        if (stopped) return;
        setNotice(result.message ?? '');
        onOrder(result.order);
        if (isFinalState(result.order.state)) { setWaiting(false); return; }
      } catch (err) {
        if (stopped) return;
        const appError = asAppError(err, 'Vérification momentanément impossible.');
        // Commande inconnue ou appartenant à un autre compte : inutile d'insister.
        if (appError.code === 'PAYMENT_NOT_FOUND' || appError.code === 'PAYMENT_INVALID_REQUEST') {
          setError(appError.message); setWaiting(false); return;
        }
        setNotice(appError.message);
      }
      if (Date.now() - startedAt >= RETURN_POLL_MAX_MS) { setTimedOut(true); setWaiting(false); return; }
      timer = window.setTimeout(() => void tick(), RETURN_POLL_INTERVAL_MS);
    };
    void tick();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [product, orderId, attempt, onOrder]);

  if (!valid) {
    return (
      <div className="mx-auto w-full max-w-xl animate-fadeUp space-y-4">
        <Banner tone="warning" title="Lien de retour invalide">
          Cette adresse ne correspond à aucune commande. Aucun paiement n’a été pris en compte depuis cette page.
        </Banner>
        <Link to="/app/credits" className="text-sm text-cyan-300 hover:text-white">Retour aux crédits Studio</Link>
      </div>
    );
  }

  const state = order?.state ?? null;

  return (
    <div className="mx-auto w-full max-w-xl animate-fadeUp space-y-4" data-testid="payment-return" data-state={state ?? 'checking'}>
      <h1 className="text-2xl font-bold tracking-tight text-white">Suivi de votre paiement</h1>

      {error && (
        <Banner tone="danger" title="Commande introuvable">
          {error} Aucun paiement n’a été pris en compte depuis cette page.
        </Banner>
      )}

      {!error && (
        <Card>
          <div className="space-y-3 p-5" role="status" aria-live="polite">
            {!order && (
              <p className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 size={15} className="animate-spin" /> Vérification auprès de SasPay…
              </p>
            )}

            {order && state === 'confirmed' && order.status === 'refunded' && (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-slate-200"><CheckCircle2 size={18} /> Paiement remboursé</p>
                <p className="text-sm leading-relaxed text-slate-300">
                  {order.product === 'studio'
                    ? 'Ce paiement a été remboursé : les crédits correspondants ont été retirés de votre solde Studio.'
                    : 'Ce paiement a été remboursé : la période d’abonnement correspondante a été retirée.'}
                </p>
              </>
            )}

            {order && state === 'confirmed' && order.status !== 'refunded' && (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-emerald-200"><CheckCircle2 size={18} /> Paiement confirmé</p>
                <p className="text-sm leading-relaxed text-slate-300">
                  {order.product === 'studio'
                    ? `${order.credits ?? ''} crédits ont été ajoutés à votre solde Studio.`
                    : 'Votre abonnement Business Grow est actif.'}
                </p>
              </>
            )}

            {order && (state === 'failed' || state === 'cancelled') && (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-rose-200">
                  <XCircle size={18} /> Paiement {PAYMENT_STATE_LABELS[state].toLowerCase()}
                </p>
                <p className="text-sm leading-relaxed text-slate-300">
                  {state === 'cancelled' ? 'Le paiement a été annulé ou a expiré.' : 'Le paiement n’a pas abouti.'}
                  {' '}Rien n’a été crédité.
                </p>
              </>
            )}

            {order && state === 'unapplied' && (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-amber-100" data-testid="payment-unapplied">
                  <Clock size={17} /> Paiement reçu, non appliqué
                </p>
                <p className="text-sm leading-relaxed text-slate-300">{UNAPPLIED_MESSAGE}</p>
                <p className="text-[12px] text-slate-400">
                  Conservez la référence ci-dessous : elle permet au support de retrouver votre paiement. Ne payez pas une seconde fois.
                </p>
              </>
            )}

            {order && (state === 'pending' || state === 'todo') && (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-amber-100">
                  {waiting ? <Loader2 size={17} className="animate-spin" /> : <Clock size={17} />}
                  {state === 'todo' ? 'Paiement non effectué' : 'Paiement en attente de confirmation'}
                </p>
                <p className="text-sm leading-relaxed text-slate-300">
                  SasPay n’a pas encore confirmé ce paiement. Rien n’est crédité avant cette confirmation.
                </p>
              </>
            )}

            {order && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-white/[0.06] pt-3 text-[12px]">
                <dt className="text-slate-500">Commande</dt><dd className="text-right text-slate-300">{order.label ?? '—'}</dd>
                <dt className="text-slate-500">Montant</dt><dd className="text-right text-slate-300">{formatAmount(order.amount, order.currency)}</dd>
                <dt className="text-slate-500">Référence</dt><dd className="text-right font-mono text-slate-300">{order.internal_reference}</dd>
                <dt className="text-slate-500">État</dt><dd className="text-right text-slate-300">{order.status === 'refunded' ? 'Remboursé' : state ? PAYMENT_STATE_LABELS[state] : '—'}</dd>
              </dl>
            )}

            {notice && !isFinalState(state ?? 'pending') && <p className="text-[12px] text-amber-200">{notice}</p>}

            {timedOut && (
              <Banner tone="info" title="Toujours en attente">
                La confirmation tarde. Vous pouvez quitter cette page : la commande sera mise à jour
                automatiquement dès la réponse de SasPay et apparaîtra dans votre historique.
              </Banner>
            )}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {!error && !waiting && state !== 'confirmed' && state !== 'failed' && state !== 'cancelled' && (
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>Vérifier à nouveau</Button>
        )}
        <Link to={backTo} className="text-sm text-cyan-300 hover:text-white">{backLabel}</Link>
      </div>
    </div>
  );
}
