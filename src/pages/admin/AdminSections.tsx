/*
 * Sections administrateur adossées à des données réelles.
 *
 * - Revenus et MRR : RPC serveur `vyora_admin_metrics` (lecture seule, admin vérifié
 *   côté base). Aucun chiffre n'est extrapolé ; une période sans événement est
 *   affichée comme telle.
 * - Modèles vidéo : catalogue MuAPI réellement interrogé côté serveur
 *   (`admin-catalog`), prix en USD d'origine + équivalent USDT (convention 1:1).
 * - Fournisseurs IA : sonde serveur du moteur central + coûts réels enregistrés.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Coins, CreditCard, Download, Loader2, RefreshCw, Sparkles, TrendingUp, Users, Video } from 'lucide-react';

import { Badge, Button, Card, CardHeader, EmptyState, Input, LoadingState, Select, StatCard } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { asAppError } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  adminProviderHealthCron,
  adminVideoCatalog,
  aiEngineHealth,
  type AiEngineHealth,
  type ProviderHealthCronStatus,
} from '../../lib/api';
import type { AdminMetrics, AdminVideoCatalogResponse, MuApiModel } from '../../lib/types';
import { BarChart, LineChart, Sparkline } from './AdminCharts';

/* -------------------------------------------------------------------------- */
/* Helpers partagés                                                           */
/* -------------------------------------------------------------------------- */

export const USDT_PARITY_NOTE =
  'Conversion affichée : 1 USD = 1 USDT (convention de calcul interne, pas un taux de marché).';

/** Montant monétaire réel : 0 reste 0 (pas de « Sur devis » sur un revenu). */
export function money(minor: number | null | undefined, currency = 'XOF'): string {
  const amount = Number(minor ?? 0) / 100;
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

const usd = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatUsdValue(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${usd.format(amount)} USD`;
}

export function formatUsdtValue(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${usd.format(amount)} USDT`;
}

/** Un tarif absent ne doit jamais être affiché comme 0 USD. */
export function parseModelCost(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function modelStatusLabel(model: MuApiModel): { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' } {
  switch (model.reelora_status) {
    case 'active': return { label: 'Actif', tone: 'success' };
    case 'coming_soon': return { label: 'Bientôt', tone: 'warning' };
    case 'unsupported': return { label: 'Entrée non connectée', tone: 'warning' };
    case 'disabled': return { label: 'Désactivé', tone: 'neutral' };
    case 'unverified': return { label: 'Tarif non vérifié', tone: 'danger' };
    default: return { label: 'Statut inconnu', tone: 'neutral' };
  }
}

/** CSV complet du catalogue, utilisable plus tard pour construire les crédits. */
export function modelsToCsv(models: MuApiModel[]): string {
  const header = [
    'model_id', 'nom_commercial', 'categorie', 'tarif_usd', 'equivalent_usdt', 'devise_source',
    'tarification_dynamique', 'strategie_tarifaire', 'statut_vyora', 'acces_compte', 'champs_requis', 'synchronise_le',
  ];
  const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const rows = models.map((model) => {
    const cost = parseModelCost(model.cost_usd);
    return [
      model.model_id,
      model.display_name,
      model.category,
      cost === null || !Number.isFinite(cost) ? '' : cost.toFixed(4),
      cost === null || !Number.isFinite(cost) ? '' : cost.toFixed(4),
      model.cost_currency ?? 'USD',
      model.dynamic_pricing ? 'oui' : 'non',
      model.cost_strategy ?? '',
      model.reelora_status ?? '',
      model.account_access ?? '',
      (model.required_fields ?? []).join('|'),
      model.synced_at ?? '',
    ].map(escape).join(';');
  });
  return [header.join(';'), ...rows].join('\n');
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const monthLabels = (rows: Array<{ month: string }>) => rows.map((row) => row.month);

function deltaPercent(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? 'stable' : 'nouveau';
  const delta = ((current - previous) / previous) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)} %`;
}

/* -------------------------------------------------------------------------- */
/* Revenus                                                                    */
/* -------------------------------------------------------------------------- */

export function RevenueSection({ metrics, loading, months, onMonths }: {
  metrics: AdminMetrics | null;
  loading: boolean;
  months: number;
  onMonths: (value: number) => void;
}) {
  if (loading && !metrics) return <LoadingState label="Chargement des métriques…" />;
  if (!metrics) return <EmptyState icon={<CreditCard size={22} />} title="Métriques indisponibles" description="La RPC vyora_admin_metrics n’a rien renvoyé." />;

  const revenueMonths = metrics.revenue.by_month;
  const values = revenueMonths.map((row) => row.collected_minor / 100);
  const current = values.at(-1) ?? 0;
  const previous = values.at(-2) ?? 0;
  const currency = metrics.revenue.currency;
  const anyRevenue = metrics.revenue.collected_total_minor > 0;

  return (
    <div className="space-y-5" data-testid="admin-revenue">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Période analysée : {metrics.period_start} → {metrics.period_end} · {months} mois · généré le {formatDate(metrics.generated_at, true)}
        </p>
        <Select value={String(months)} onChange={(event) => onMonths(Number(event.target.value))} className="w-auto min-w-[140px]">
          <option value="3">3 mois</option>
          <option value="6">6 mois</option>
          <option value="12">12 mois</option>
          <option value="24">24 mois</option>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Revenus encaissés" value={money(metrics.revenue.collected_total_minor, currency)} icon={<Coins size={19} />} hint={`${metrics.revenue.collected_orders} commande(s) payée(s)`} tone="emerald" />
        <StatCard label="Revenus du mois" value={money(current * 100, currency)} icon={<CreditCard size={19} />} hint={`vs mois précédent : ${deltaPercent(current, previous)}`} tone="cyan" />
        <StatCard label="MRR actuel" value={money(metrics.mrr.current_minor, currency)} icon={<TrendingUp size={19} />} hint={`${metrics.mrr.active_recurring_subscriptions} abonnement(s) récurrent(s) actif(s)`} tone="amber" />
        <StatCard label="Recharges en attente" value={metrics.revenue.pending_orders} icon={<Loader2 size={19} />} hint="Non comptées dans les revenus" />
      </div>

      {!metrics.history.has_history || !anyRevenue ? (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-4 text-sm text-amber-200">
          <p className="font-semibold">Période exploitable limitée</p>
          <p className="mt-1 text-amber-100/80">
            Premier événement réel : {metrics.history.first_activity_at ? formatDate(metrics.history.first_activity_at, true) : 'aucun'}.
            Aucun paiement encaissé n’est enregistré sur la période, donc les graphiques restent à zéro : aucun historique n’est reconstitué.
          </p>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Revenus encaissés par mois" description={`Commandes payées uniquement (${currency}).`} />
          <div className="p-5">
            <BarChart
              labels={monthLabels(revenueMonths)}
              values={values}
              label="Revenus encaissés par mois"
              valueFormatter={(value) => money(value * 100, currency)}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Comparaison" description="Mois courant vs mois précédent." />
          <div className="space-y-3 p-5 text-sm">
            <div className="flex items-center justify-between"><span className="text-slate-400">Mois courant</span><span className="font-semibold text-white">{money(current * 100, currency)}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-400">Mois précédent</span><span className="font-semibold text-white">{money(previous * 100, currency)}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-400">Évolution</span><span className="font-semibold text-cyan-300">{deltaPercent(current, previous)}</span></div>
            <div className="flex items-center justify-between"><span className="text-slate-400">Commandes payées</span><span className="font-semibold text-white">{metrics.revenue.collected_orders}</span></div>
            <p className="pt-2 text-[11px] leading-relaxed text-slate-500">
              Un encaissement de crédits est un paiement ponctuel : il n’entre pas dans le MRR.
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Détail mensuel" description="Revenus encaissés, commandes et MRR du même mois." />
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Mois</th><th>Encaissé</th><th>Commandes</th><th>MRR</th><th>Abonnements actifs</th></tr></thead>
            <tbody>
              {revenueMonths.map((row, index) => (
                <tr key={row.month}>
                  <td className="font-medium text-white">{row.month}</td>
                  <td>{money(row.collected_minor, currency)}</td>
                  <td>{row.orders}</td>
                  <td>{money(metrics.mrr.by_month[index]?.mrr_minor ?? 0, currency)}</td>
                  <td>{metrics.mrr.by_month[index]?.active_subscriptions ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* KPI / MRR                                                                  */
/* -------------------------------------------------------------------------- */

export function KpiSection({ metrics, loading }: { metrics: AdminMetrics | null; loading: boolean }) {
  if (loading && !metrics) return <LoadingState label="Chargement des métriques…" />;
  if (!metrics) return <EmptyState icon={<TrendingUp size={22} />} title="KPI indisponibles" />;

  const mrrRows = metrics.mrr.by_month;
  const currency = metrics.mrr.currency;
  const newValues = mrrRows.map((row) => row.new_mrr_minor / 100);
  const lostValues = mrrRows.map((row) => row.lost_mrr_minor / 100);
  const mrrValues = mrrRows.map((row) => row.mrr_minor / 100);
  const newSubs = metrics.subscriptions.new_by_month.map((row) => row.count);
  const cancelledSubs = metrics.subscriptions.cancelled_by_month.map((row) => row.count);
  const newUsers = metrics.users.new_by_month.map((row) => row.count);

  return (
    <div className="space-y-5" data-testid="admin-kpis">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MRR" value={money(metrics.mrr.current_minor, currency)} icon={<TrendingUp size={19} />} hint={`${metrics.mrr.active_recurring_subscriptions} récurrent(s) actif(s)`} tone="emerald" />
        <StatCard label="Abonnements actifs" value={metrics.subscriptions.active} icon={<Users size={19} />} hint={`${metrics.subscriptions.cancelled} annulé(s) · ${metrics.subscriptions.total} au total`} tone="cyan" />
        <StatCard label="Nouveaux clients" value={metrics.users.customers} icon={<Users size={19} />} hint={`${metrics.users.with_subscription} avec abonnement`} />
        <StatCard label="Net MRR (dernier mois)" value={money(mrrRows.at(-1)?.net_mrr_minor ?? 0, currency)} icon={<Sparkles size={19} />} hint="Nouveau − perdu" tone="amber" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tendance du MRR" description="MRR, nouveau MRR et MRR perdu par mois." />
          <div className="p-5">
            <LineChart
              labels={monthLabels(mrrRows)}
              series={[
                { label: 'MRR', color: '#34d399', values: mrrValues },
                { label: 'Nouveau MRR', color: '#38bdf8', values: newValues },
                { label: 'MRR perdu', color: '#f87171', values: lostValues },
              ]}
              label="Tendance du MRR"
              valueFormatter={(value) => money(value * 100, currency)}
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="Abonnements" description="Nouveaux et annulés par mois (statuts réels)." />
          <div className="p-5">
            <BarChart
              labels={monthLabels(metrics.subscriptions.new_by_month)}
              values={newSubs}
              label="Nouveaux abonnements par mois"
            />
            <div className="mt-4">
              <LineChart
                labels={monthLabels(metrics.subscriptions.cancelled_by_month)}
                series={[{ label: 'Annulations', color: '#fb923c', values: cancelledSubs }]}
                label="Annulations par mois"
                height={110}
              />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="Détail MRR" description="Méthode : abonnements réellement actifs × prix mensuel de la formule." />
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Mois</th><th>MRR</th><th>Nouveau</th><th>Perdu</th><th>Net</th><th>Actifs</th></tr></thead>
              <tbody>
                {mrrRows.map((row) => (
                  <tr key={row.month}>
                    <td className="font-medium text-white">{row.month}</td>
                    <td>{money(row.mrr_minor, currency)}</td>
                    <td className="text-emerald-300">{money(row.new_mrr_minor, currency)}</td>
                    <td className="text-rose-300">{money(row.lost_mrr_minor, currency)}</td>
                    <td>{money(row.net_mrr_minor, currency)}</td>
                    <td>{row.active_subscriptions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card>
          <CardHeader title="Nouveaux clients" description="Comptes clients créés par mois." />
          <div className="p-5">
            <BarChart labels={monthLabels(metrics.users.new_by_month)} values={newUsers} label="Nouveaux clients par mois" color="#a78bfa" height={140} />
            <div className="mt-4 flex items-center gap-3 text-xs text-slate-500">
              <Sparkline values={newUsers} color="#a78bfa" />
              <span>Tendance sur la période</span>
            </div>
          </div>
        </Card>
      </div>

      <div className="rounded-2xl border border-line bg-white/[0.02] p-4 text-[11px] leading-relaxed text-slate-500">
        <p className="font-semibold text-slate-400">Méthode MRR documentée</p>
        <p className="mt-1">
          Seuls les abonnements dont le statut est réellement <code>active</code> sont comptés, au prix mensuel de leur formule.
          Le MRR perdu utilise la date de dernière mise à jour d’un abonnement annulé (seule date de résiliation disponible).
          Les encaissements ponctuels de crédits sont exclus du MRR. Premier événement réel de la base : {metrics.history.first_activity_at ? formatDate(metrics.history.first_activity_at, true) : 'aucun'} ·
          période exploitable : {metrics.history.exploitable_from} ({metrics.history.months_of_history} mois d’historique).
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Modèles vidéo                                                              */
/* -------------------------------------------------------------------------- */

export function ModelsSection() {
  const toast = useToast();
  const [catalog, setCatalog] = useState<AdminVideoCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setCatalog(await adminVideoCatalog()); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const models = catalog?.models ?? [];
  const categories = useMemo(() => ['all', ...Array.from(new Set(models.map((model) => model.category))).sort()], [models]);
  const filtered = useMemo(() => models.filter((model) => {
    const haystack = `${model.model_id} ${model.display_name} ${model.category}`.toLowerCase();
    if (search && !haystack.includes(search.toLowerCase())) return false;
    if (category !== 'all' && model.category !== category) return false;
    if (status !== 'all' && model.reelora_status !== status) return false;
    return true;
  }), [models, search, category, status]);

  const priced = filtered.map((model) => parseModelCost(model.cost_usd)).filter((cost): cost is number => cost !== null);
  const avg = priced.length ? priced.reduce((sum, cost) => sum + cost, 0) / priced.length : 0;
  const min = priced.length ? Math.min(...priced) : 0;
  const max = priced.length ? Math.max(...priced) : 0;

  return (
    <div className="space-y-5" data-testid="admin-models">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Catalogue MuAPI réel · {catalog ? `${catalog.catalog.detected_video} modèles vidéo détectés` : 'chargement'} ·
          récupéré le {catalog ? formatDate(catalog.catalog.fetched_at, true) : '—'}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()} loading={loading} icon={<RefreshCw size={14} />}>Rafraîchir</Button>
          <Button variant="outline" size="sm" disabled={!filtered.length} icon={<Download size={14} />}
            onClick={() => { downloadCsv(`vyora-modeles-${new Date().toISOString().slice(0, 10)}.csv`, modelsToCsv(filtered)); toast.success(`${filtered.length} modèle(s) exporté(s).`); }}>
            Exporter CSV
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Modèles détectés" value={catalog?.catalog.detected_video ?? 0} icon={<Video size={19} />} tone="cyan" />
        <StatCard label="Sélectionnables" value={catalog?.catalog.active ?? 0} icon={<CheckCircle2 size={19} />} tone="emerald" hint={`${catalog?.catalog.unavailable ?? 0} indisponible(s)`} />
        <StatCard label="Tarif moyen" value={formatUsdValue(avg)} icon={<Coins size={19} />} hint={`min ${formatUsdValue(min)} · max ${formatUsdValue(max)}`} tone="amber" />
        <StatCard label="Clé MuAPI" value={catalog?.catalog.account.key_valid ? 'validée' : 'non validée'} icon={<AlertTriangle size={19} />}
          hint={catalog?.catalog.account.key_configured ? 'clé configurée côté serveur' : 'clé absente côté serveur'} />
      </div>

      <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04] p-4 text-[11px] leading-relaxed text-cyan-100/80">
        Prix d’origine en USD, tels que renvoyés par MuAPI. {USDT_PARITY_NOTE} Les modèles dont le tarif dépend des paramètres
        (durée, résolution) sont marqués « tarification dynamique » : le montant affiché est le tarif de base vérifié, le devis exact
        reste calculé côté serveur avant toute génération.
      </div>

      <Card>
        <CardHeader title={`Catalogue complet (${filtered.length}/${models.length})`} description="Identifiant technique, nom commercial, catégorie, tarif et statut réel."
          action={<div className="flex flex-wrap gap-2">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher un modèle…" className="max-w-xs" />
            <Select value={category} onChange={(event) => setCategory(event.target.value)} className="w-auto min-w-[150px]">
              {categories.map((item) => <option key={item} value={item}>{item === 'all' ? 'Toutes catégories' : item}</option>)}
            </Select>
            <Select value={status} onChange={(event) => setStatus(event.target.value)} className="w-auto min-w-[140px]">
              <option value="all">Tous statuts</option>
              <option value="active">Actif</option>
              <option value="coming_soon">Bientôt</option>
              <option value="unsupported">Entrée non connectée</option>
              <option value="unverified">Tarif non vérifié</option>
              <option value="disabled">Désactivé</option>
            </Select>
          </div>} />
        {loading && !catalog ? <LoadingState label="Chargement du catalogue…" /> : filtered.length === 0 ? (
          <EmptyState icon={<Video size={22} />} title="Aucun modèle" description="Ajustez les filtres ou rafraîchissez le catalogue." />
        ) : (
          <div className="table-wrap max-h-[640px] overflow-auto">
            <table className="table">
              <thead><tr><th>Identifiant</th><th>Nom commercial</th><th>Catégorie</th><th>Tarif</th><th>USDT</th><th>Tarification</th><th>Statut</th></tr></thead>
              <tbody>
                {filtered.map((model) => {
                  const badge = modelStatusLabel(model);
                  const cost = parseModelCost(model.cost_usd);
                  return (
                    <tr key={model.model_id}>
                      <td className="font-mono text-[11px] text-slate-400">{model.model_id}</td>
                      <td className="font-medium text-white">{model.display_name}</td>
                      <td className="text-xs text-slate-400">{model.category}</td>
                      <td>{cost === null ? <span className="text-rose-300">tarif non communiqué</span> : formatUsdValue(cost)}</td>
                      <td>{cost === null ? '—' : formatUsdtValue(cost)}</td>
                      <td className="text-xs text-slate-400">{model.dynamic_pricing ? 'dynamique (paramètres)' : 'fixe'}{model.cost_strategy ? ` · ${model.cost_strategy}` : ''}</td>
                      <td><Badge tone={badge.tone}>{badge.label}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Fournisseurs IA                                                            */
/* -------------------------------------------------------------------------- */

const CRON_STATUS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  healthy: { label: 'Sain', tone: 'success' },
  collected: { label: 'Reçu', tone: 'success' },
  dispatched: { label: 'Envoyé', tone: 'neutral' },
  failed: { label: 'Échec', tone: 'danger' },
  no_response: { label: 'Sans réponse', tone: 'danger' },
  degraded: { label: 'Dégradé', tone: 'warning' },
  skipped: { label: 'Ignoré', tone: 'neutral' },
};

function cronLabel(status: string | null | undefined) {
  if (!status) return { label: 'Jamais exécuté', tone: 'neutral' as const };
  return CRON_STATUS_LABELS[status] ?? { label: status, tone: 'neutral' as const };
}

/**
 * État réel du job pg_cron de surveillance des fournisseurs : jobs planifiés,
 * dernières exécutions planifiées et dernière vérification de chaque
 * fournisseur. Aucune valeur n'est estimée côté navigateur.
 */
export function ProviderHealthCronCard() {
  const [status, setStatus] = useState<ProviderHealthCronStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setStatus(await adminProviderHealthCron()); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const jobs = status?.jobs ?? [];
  const providers = status?.providers ?? [];
  const lastRuns = status?.last_runs ?? [];

  return (
    <Card>
      <CardHeader
        title="Surveillance automatique des fournisseurs"
        description="Job pg_cron qui re-vérifie Groq et Gemini avant l’expiration des contrôles de 24 h. Données lues en base."
        action={<Button variant="ghost" size="sm" onClick={() => void load()} loading={loading} icon={<RefreshCw size={14} />}>Rafraîchir</Button>}
      />
      <div className="space-y-4" data-testid="provider-health-cron">
        {error ? <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div> : null}
        {loading && !status ? <LoadingState label="Lecture de la planification…" /> : null}

        {!loading && !error && jobs.length === 0 ? (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] p-4 text-sm text-amber-200">
            Aucun job de surveillance planifié : les contrôles de santé expirent au bout de 24 h et le routage refusera les fournisseurs.
          </div>
        ) : null}

        {jobs.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Job</th><th>jobid</th><th>Fréquence (UTC)</th><th>État</th></tr></thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.jobid}>
                    <td className="font-medium text-white">{job.jobname}</td>
                    <td>{job.jobid}</td>
                    <td className="font-mono text-xs">{job.schedule}</td>
                    <td><Badge tone={job.active ? 'success' : 'danger'}>{job.active ? 'actif' : 'inactif'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {providers.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {providers.map((provider) => {
              const state = cronLabel(provider.last_status);
              return (
                <div key={provider.provider_key} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-white">{provider.provider_key === 'gemini' ? 'Gemini' : 'Groq'}</p>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <dl className="mt-3 space-y-1 text-xs text-slate-400">
                    <div className="flex justify-between gap-3"><dt>Dernier contrôle réussi</dt><dd className="text-slate-200">{provider.last_healthy_at ? formatDate(provider.last_healthy_at, true) : '—'}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Dernier envoi</dt><dd className="text-slate-200">{provider.last_dispatch_at ? formatDate(provider.last_dispatch_at, true) : '—'}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Latence</dt><dd className="text-slate-200">{provider.last_latency_ms === null ? '—' : `${provider.last_latency_ms} ms`}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Modèle vérifié</dt><dd className="text-slate-200">{provider.verified_model ?? '—'}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Échecs consécutifs</dt><dd className={provider.consecutive_failures > 0 ? 'text-amber-300' : 'text-slate-200'}>{provider.consecutive_failures}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Alerte ouverte</dt><dd className={provider.alert_open ? 'text-rose-300' : 'text-slate-200'}>{provider.alert_open ? 'oui' : 'non'}</dd></div>
                  </dl>
                </div>
              );
            })}
          </div>
        ) : null}

        {lastRuns.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Exécution</th><th>Statut</th><th>Début</th><th>Message</th></tr></thead>
              <tbody>
                {lastRuns.map((run, index) => (
                  <tr key={`${run.jobid}-${run.start_time}-${index}`}>
                    <td className="font-medium text-white">{run.jobname ?? `job ${run.jobid}`}</td>
                    <td><Badge tone={run.status === 'succeeded' ? 'success' : 'danger'}>{run.status}</Badge></td>
                    <td className="text-xs text-slate-400">{formatDate(run.start_time, true)}</td>
                    <td className="max-w-[22rem] truncate text-xs text-slate-400" title={run.return_message ?? ''}>{run.return_message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function ProvidersSection({ metrics }: { metrics: AdminMetrics | null }) {
  const [health, setHealth] = useState<AiEngineHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setHealth(await aiEngineHealth()); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groq = health?.providers?.groq;
  const gemini = health?.providers?.gemini;
  const attempts = metrics?.providers.business_growth ?? [];
  const studioCosts = metrics?.providers.studio_cost_events ?? [];

  return (
    <div className="space-y-5" data-testid="admin-providers">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Sonde réelle du moteur IA central (les clés ne quittent jamais le serveur).</p>
        <Button variant="ghost" size="sm" onClick={() => void load()} loading={loading} icon={<RefreshCw size={14} />}>Vérifier</Button>
      </div>

      {error ? <div className="rounded-xl border border-rose-400/30 bg-rose-400/[0.06] p-4 text-sm text-rose-200">{error}</div> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Groq" value={groq ? (groq.configured ? 'configuré' : 'non configuré') : '—'} icon={<Sparkles size={19} />} tone={groq?.configured ? 'emerald' : 'brand'} hint={groq?.model ?? 'modèle inconnu'} />
        <StatCard label="Gemini" value={gemini ? (gemini.configured ? 'configuré' : 'non configuré') : '—'} icon={<Sparkles size={19} />} tone={gemini?.configured ? 'emerald' : 'brand'} hint={gemini?.model ?? 'modèle inconnu'} />
        <StatCard label="MuAPI" value={metrics ? `${metrics.models.total} modèles` : '—'} icon={<Video size={19} />} tone="cyan" hint={metrics?.models.synced_at ? `synchronisé le ${formatDate(metrics.models.synced_at, true)}` : 'jamais synchronisé'} />
      </div>

      <ProviderHealthCronCard />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Tentatives par fournisseur" description="Business Growth — appels réellement journalisés." />
          {attempts.length === 0 ? <EmptyState icon={<Sparkles size={22} />} title="Aucune tentative" description="Aucun appel IA n’a encore été journalisé." /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Fournisseur</th><th>Appels</th><th>Succès</th><th>Échecs</th><th>Coût (micro-USD)</th></tr></thead>
                <tbody>{attempts.map((row) => (
                  <tr key={row.provider_key}>
                    <td className="font-medium text-white">{row.provider_key}</td><td>{row.attempts}</td>
                    <td className="text-emerald-300">{row.succeeded}</td><td className="text-rose-300">{row.failed}</td>
                    <td>{row.provider_cost_micros}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Coûts fournisseurs Studio" description="Événements de coût réellement enregistrés." />
          {studioCosts.length === 0 ? <EmptyState icon={<Coins size={22} />} title="Aucun coût enregistré" description="Aucune génération payante n’a été lancée." /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Fournisseur</th><th>Montant</th><th>Événements</th><th>Dernier</th></tr></thead>
                <tbody>{studioCosts.map((row) => (
                  <tr key={`${row.provider}-${row.currency}`}>
                    <td className="font-medium text-white">{row.provider}</td>
                    <td>{Number(row.amount).toFixed(4)} {row.currency}</td>
                    <td>{row.events}</td>
                    <td className="text-xs text-slate-400">{row.last_event_at ? formatDate(row.last_event_at, true) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Activité Studio / Business Growth                                          */
/* -------------------------------------------------------------------------- */

export function StudioActivitySection({ metrics, loading }: { metrics: AdminMetrics | null; loading: boolean }) {
  if (loading && !metrics) return <LoadingState label="Chargement des métriques…" />;
  if (!metrics) return <EmptyState icon={<Video size={22} />} title="Activité indisponible" />;
  const rows = metrics.studio.by_month;
  return (
    <div className="space-y-5" data-testid="admin-studio-activity">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Générations" value={metrics.studio.jobs_total} icon={<Video size={19} />} tone="cyan" />
        <StatCard label="Réussies" value={metrics.studio.jobs_succeeded} icon={<CheckCircle2 size={19} />} tone="emerald" />
        <StatCard label="Échecs" value={metrics.studio.jobs_failed} icon={<AlertTriangle size={19} />} />
        <StatCard label="Crédits consommés" value={metrics.studio.credits_charged_total} icon={<Coins size={19} />} tone="amber" />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card><CardHeader title="Générations par mois" description="Tâches réellement créées dans Studio." />
          <div className="p-5"><BarChart labels={monthLabels(rows)} values={rows.map((row) => row.jobs)} label="Générations par mois" /></div>
        </Card>
        <Card><CardHeader title="Usage par type" description="Compteur de quotas réellement consommé." />
          <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">
            {Object.entries(metrics.studio.usage_by_kind).length === 0
              ? <p className="col-span-full text-sm text-slate-500">Aucune consommation enregistrée.</p>
              : Object.entries(metrics.studio.usage_by_kind).map(([kind, total]) => (
                <div key={kind} className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">{kind}</p><p className="mt-1 text-xl font-bold text-white">{total}</p></div>
              ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function GrowthActivitySection({ metrics, loading }: { metrics: AdminMetrics | null; loading: boolean }) {
  if (loading && !metrics) return <LoadingState label="Chargement des métriques…" />;
  if (!metrics) return <EmptyState icon={<Sparkles size={22} />} title="Activité indisponible" />;
  const rows = metrics.business_growth.by_month;
  return (
    <div className="space-y-5" data-testid="admin-growth-activity">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requêtes IA" value={metrics.business_growth.requests_total} icon={<Sparkles size={19} />} tone="cyan" hint={`${metrics.business_growth.requests_failed} échec(s)`} />
        <StatCard label="Conversations" value={metrics.business_growth.conversations} icon={<Users size={19} />} hint={`${metrics.business_growth.messages} messages`} />
        <StatCard label="Mémoire métier" value={metrics.business_growth.memory_items} icon={<Coins size={19} />} tone="emerald" hint="faits consentis enregistrés" />
        <StatCard label="Tokens consommés" value={metrics.business_growth.tokens_total} icon={<TrendingUp size={19} />} tone="amber" hint={`${metrics.business_growth.tool_executions} action(s) proposée(s)`} />
      </div>
      <Card><CardHeader title="Requêtes Business Growth par mois" description="Requêtes réellement journalisées." />
        <div className="p-5"><BarChart labels={monthLabels(rows)} values={rows.map((row) => row.requests)} label="Requêtes Business Growth par mois" color="#22d3ee" /></div>
      </Card>
    </div>
  );
}
