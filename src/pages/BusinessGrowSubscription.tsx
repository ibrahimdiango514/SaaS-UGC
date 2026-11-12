import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Brain, Check, Coins, Info, RefreshCw, Sparkles } from 'lucide-react';
import { Banner, Button, Card, ErrorState, LoadingState } from '../components/ui';
import { rpc } from '../lib/api';
import { asAppError } from '../lib/errors';

/**
 * Abonnement Business Grow — catalogue PROPRE au produit Business Grow.
 *
 * Ce que cette page NE fait pas :
 * - elle n'affiche aucun crédit, pack ou portefeuille VYORA Studio ;
 * - elle ne montre aucun prix non fixé : une formule sans prix n'est jamais
 *   présentée comme achetable ;
 * - elle ne prétend pas encaisser un paiement : `billing_enabled = false` tant
 *   qu'aucun prestataire de paiement n'est configuré côté serveur.
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

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setCatalog(await rpc<BusinessCatalog>('business_grow_catalog'));
    } catch (err) {
      setError(asAppError(err, 'Impossible de charger les formules Business Grow.').message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const plans = catalog?.plans ?? [];
  const billingEnabled = catalog?.billing_enabled === true;

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
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    disabled
                    title="Aucun prestataire de paiement Business Grow n’est configuré"
                  >
                    <Coins size={13} /> Souscription indisponible
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
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
    </div>
  );
}
