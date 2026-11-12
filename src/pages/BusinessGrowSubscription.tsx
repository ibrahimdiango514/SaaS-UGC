import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Brain, Check, Coins, Info, RefreshCw, Sparkles } from 'lucide-react';
import { Badge, Banner, Button, Card, ErrorState, LoadingState } from '../components/ui';
import { rpc } from '../lib/api';
import { asAppError } from '../lib/errors';
import { formatDate } from '../lib/format';
import PaymentDialog from '../components/PaymentDialog';
import {
  PAYMENT_STATE_LABELS, PAYMENT_STATE_TONES, formatAmount, getBusinessSubscription, getPaymentOptions, listMyPayments, refundBadge,
  type BusinessSubscription, type PaymentOptions, type PaymentOrder,
} from '../lib/payments';

/**
 * Abonnement Business Grow — catalogue PROPRE au produit Business Grow.
 *
 * Ce que cette page NE fait pas :
 * - elle n'affiche aucun crédit, pack ou portefeuille VYORA Studio ;
 * - elle ne montre aucun prix non fixé : une formule sans prix n'est jamais
 *   présentée comme achetable ;
 * - elle ne prétend pas encaisser un paiement : le bouton de souscription n'est
 *   actif que si le SERVEUR annonce le paiement disponible (facturation Business
 *   Grow activée, prestataire configuré, formule active avec un prix fixé).
 *   Sinon il reste « Souscription indisponible ».
 * - elle n'active jamais un abonnement elle-même : seul un paiement vérifié
 *   auprès de SasPay par le serveur le fait.
 *
 * Source de vérité : `public.business_grow_catalog()` (schéma `saas_business`).
 */
interface BusinessPlan {
  plan_key: string;
  display_name: string;
  tagline: string | null;
  monthly_price_minor: number | null;
  currency: string;
  monthly_credit_units: number | null;
  features: string[] | null;
  active: boolean;
}

interface BusinessCatalog {
  plans?: BusinessPlan[];
  config?: { target_margin_percent?: number; renewal_period_days?: number } | null;
  billing_enabled?: boolean;
}

const price = (plan: BusinessPlan) => {
  if (plan.monthly_price_minor === null || plan.monthly_price_minor === undefined) return null;
  if (plan.monthly_price_minor === 0) return 'Gratuit';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency', currency: plan.currency || 'XOF', maximumFractionDigits: 0,
  }).format(plan.monthly_price_minor);
};

export default function BusinessGrowSubscription() {
  const [catalog, setCatalog] = useState<BusinessCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [payment, setPayment] = useState<PaymentOptions | null>(null);
  const [subscription, setSubscription] = useState<BusinessSubscription | null>(null);
  const [payments, setPayments] = useState<PaymentOrder[]>([]);
  const [checkout, setCheckout] = useState<BusinessPlan | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const [catalogResult, optionsResult, subscriptionResult, paymentRows] = await Promise.all([
        rpc<BusinessCatalog>('business_grow_catalog'),
        // Service de paiement absent ou désactivé : la souscription reste indisponible.
        getPaymentOptions('business').catch(() => null),
        getBusinessSubscription().catch(() => null),
        listMyPayments('business', 20).catch(() => [] as PaymentOrder[]),
      ]);
      setCatalog(catalogResult);
      setPayment(optionsResult);
      setSubscription(subscriptionResult);
      setPayments(paymentRows);
    } catch (err) {
      if (!silent) setError(asAppError(err, 'Impossible de charger les formules Business Grow.').message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const plans = catalog?.plans ?? [];
  const billingEnabled = catalog?.billing_enabled === true;
  /** Le serveur de paiement fait foi : sans son accord explicite, rien n'est achetable. */
  const paymentAvailable = billingEnabled && payment?.available === true;
  const canSubscribe = (plan: BusinessPlan) => paymentAvailable && plan.active
    && typeof plan.monthly_price_minor === 'number' && plan.monthly_price_minor > 0
    && typeof plan.monthly_credit_units === 'number'
    // Changement de formule en cours de période : non pris en charge.
    && (!subscription?.is_current || subscription.plan_key === plan.plan_key);
  const unavailableHint = !billingEnabled
    ? 'La facturation Business Grow n’est pas activée'
    : payment?.message || 'Le paiement en ligne n’est pas disponible pour le moment';

  return (
    <div className="mx-auto w-full max-w-[1100px] space-y-4 animate-fadeUp">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="inline-flex items-center gap-1.5 rounded-full border border-violet-300/25 bg-violet-400/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-200">
            <Brain size={11} /> Business Grow
          </p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-white">Abonnement Business Grow</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-400">
            Formules, quotas et unités de consommation propres à Business Grow.
            Ce catalogue est indépendant de VYORA Studio&nbsp;: aucun crédit, aucun
            portefeuille et aucune règle de marge ne sont partagés entre les deux produits.
          </p>
        </div>
        <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
          Actualiser
        </Button>
      </header>

      {!billingEnabled && (
        <Banner tone="info" title="Facturation Business Grow non activée">
          Les formules ci-dessous décrivent l’offre prévue. Aucun prix n’est affiché tant qu’il
          n’a pas été fixé côté serveur, et aucun paiement ne peut être déclenché : la
          facturation reste désactivée. Rien n’est simulé.
        </Banner>
      )}

      {billingEnabled && !paymentAvailable && !loading && (
        <Banner tone="warning" title="Souscription en ligne indisponible">
          {unavailableHint}. Aucun paiement ne peut être déclenché.
        </Banner>
      )}

      {subscription?.is_current && (
        <Banner tone="success" title={`Abonnement actif : ${subscription.plan_label ?? subscription.plan_key}`}>
          Valable jusqu’au {formatDate(subscription.current_period_end)}. Aucun renouvellement automatique :
          vous prolongez vous-même votre formule quand vous le souhaitez.
        </Banner>
      )}

      {loading && <LoadingState label="Chargement des formules Business Grow…" />}
      {!loading && error && <ErrorState message={error} onRetry={() => void load()} />}

      {!loading && !error && plans.length === 0 && (
        <Card>
          <div className="p-6">
            <p className="text-sm font-semibold text-white">Aucune formule commercialisée pour le moment</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              Le catalogue Business Grow existe mais aucune formule n’est encore activée.
              Aucune offre, aucun prix et aucun quota ne sont donc présentés comme disponibles.
            </p>
          </div>
        </Card>
      )}

      {!loading && !error && plans.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const shown = price(plan);
            const features = Array.isArray(plan.features) ? plan.features : [];
            return (
              <Card key={plan.plan_key} className="flex flex-col">
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-sm font-semibold text-white">{plan.display_name}</p>
                  {plan.tagline && <p className="mt-0.5 text-[11px] text-slate-400">{plan.tagline}</p>}
                  <p className="mt-3 text-2xl font-bold tracking-tight text-white">
                    {shown ?? <span className="text-base font-semibold text-slate-400">Prix à définir</span>}
                  </p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {plan.monthly_credit_units === null || plan.monthly_credit_units === undefined
                      ? 'Quota mensuel à définir'
                      : `${plan.monthly_credit_units.toLocaleString('fr-FR')} unités Business Grow / mois`}
                  </p>
                  {features.length > 0 && (
                    <ul className="mt-3 space-y-1.5">
                      {features.map((f) => (
                        <li key={f} className="flex items-start gap-1.5 text-[11.5px] leading-snug text-slate-300">
                          <Check size={12} className="mt-0.5 shrink-0 text-violet-300" /> {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-4 flex-1" />
                  {canSubscribe(plan) ? (
                    <Button size="sm" className="w-full" onClick={() => setCheckout(plan)}>
                      <Coins size={13} /> {subscription?.is_current ? 'Prolonger de 30 jours' : 'Souscrire'}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled
                      title={subscription?.is_current && subscription.plan_key !== plan.plan_key
                        ? 'Le changement de formule en cours de période n’est pas encore possible'
                        : unavailableHint}
                    >
                      <Coins size={13} /> Souscription indisponible
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {payments.length > 0 && (
        <section aria-label="Paiements Business Grow">
          <h2 className="text-sm font-semibold text-white">Paiements Business Grow</h2>
          <ul className="mt-2 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.08] bg-white/[0.02] px-3">
            {payments.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-slate-300">{row.label ?? 'Abonnement Business Grow'}</span>
                <span className="text-slate-500">{formatDate(row.created_at, true)}</span>
                <span className="text-slate-300">{formatAmount(row.amount, row.currency)}</span>
                {refundBadge(row)
                  ? <Badge tone={refundBadge(row)?.tone}>{refundBadge(row)?.label}{row.refund_amount ? ` · ${formatAmount(row.refund_amount, row.currency)}` : ''}</Badge>
                  : <Badge tone={PAYMENT_STATE_TONES[row.state]}>{PAYMENT_STATE_LABELS[row.state]}</Badge>}
                {(row.state === 'pending' || row.state === 'todo' || row.state === 'review' || row.state === 'unapplied') && (
                  <Link to={`/app/paiement/retour?produit=business&commande=${row.id}`} className="text-violet-300 hover:text-white">
                    {row.state === 'unapplied' ? 'Détails' : 'Suivre'}
                  </Link>
                )}
                {row.state === 'review' && (
                  <p className="w-full text-[11px] text-amber-200" data-testid="business-review">
                    Paiement en cours de vérification : ne payez pas une seconde fois. Aucun autre paiement ne peut être lancé d’ici là.
                  </p>
                )}
                {row.state === 'unapplied' && (
                  <p className="w-full text-[11px] text-amber-200" data-testid="business-unapplied">
                    Paiement reçu mais non appliqué à votre abonnement : le support vous rembourse intégralement.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {catalog?.config && (
        <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-slate-600">
          <Info size={11} className="mt-0.5 shrink-0" />
          Renouvellement tous les {catalog.config.renewal_period_days ?? 30} jours.
          Marge cible Business Grow : {catalog.config.target_margin_percent ?? '—'} %
          (jamais appliquée au Studio).
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] pt-3 text-[11px]">
        <Link to="/app/business" className="inline-flex items-center gap-1 text-violet-300/80 hover:text-violet-200">
          Ouvrir Business Grow <ArrowRight size={11} />
        </Link>
        <Link to="/app/credits" className="inline-flex items-center gap-1 text-cyan-400/70 hover:text-cyan-300">
          <Sparkles size={11} /> Crédits VYORA Studio (produit distinct)
        </Link>
      </div>

      <PaymentDialog
        open={checkout !== null}
        product="business"
        item={checkout ? { plan_key: checkout.plan_key } : null}
        title={checkout ? `Business Grow — ${checkout.display_name}` : 'Paiement'}
        onClose={() => { setCheckout(null); void load(true); }}
        onConfirmed={() => void load(true)}
      />
    </div>
  );
}
