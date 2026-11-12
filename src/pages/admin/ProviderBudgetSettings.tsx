import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, BellRing, Coins, FileClock, Power, PowerOff } from 'lucide-react';
import { Banner, Badge, Button, Card, CardHeader, EmptyState, Input } from '../../components/ui';
import { formatDate, statusLabel } from '../../lib/format';
import type { AdminProviderSpendSummary } from '../../lib/types';

const formatUsd = (amount: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 6,
}).format(amount);

const providerLabel = (provider: string | null) => {
  if (!provider) return 'Global';
  return provider === 'muapi' ? 'MuAPI' : provider;
};

interface ProviderBudgetSettingsProps {
  summary: AdminProviderSpendSummary | null;
  error: string;
  capDraft: string;
  busy: boolean;
  onCapDraftChange: (value: string) => void;
  onSave: (event: FormEvent) => void;
  onEnable: () => void;
  onDisable: () => void;
  onSavePolicy: (alertPercent: number, providerCaps: Record<string, number>) => Promise<void>;
  onAckAlert: (alertId: string) => Promise<void>;
}

export default function ProviderBudgetSettings({
  summary, error, capDraft, busy, onCapDraftChange, onSave, onEnable, onDisable, onSavePolicy, onAckAlert,
}: ProviderBudgetSettingsProps) {
  const [alertPercent, setAlertPercent] = useState('80');
  const [capMuapi, setCapMuapi] = useState('');
  const [policyBusy, setPolicyBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState<string | null>(null);

  // Les valeurs serveur font foi : le formulaire ne fait que les refléter.
  useEffect(() => {
    if (!summary) return;
    setAlertPercent(String(summary.alert_percent ?? 80));
    const caps = summary.provider_caps_usd ?? {};
    setCapMuapi(caps.muapi === undefined || caps.muapi === null ? '' : String(caps.muapi));
  }, [summary]);

  const submitPolicy = async (event: FormEvent) => {
    event.preventDefault();
    const percent = Number(alertPercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
    const caps: Record<string, number> = {};
    if (capMuapi.trim() !== '') {
      const value = Number(capMuapi);
      if (!Number.isFinite(value) || value < 0) return;
      caps.muapi = value;
    }
    setPolicyBusy(true);
    try { await onSavePolicy(percent, caps); } finally { setPolicyBusy(false); }
  };

  const ack = async (alertId: string) => {
    setAckBusy(alertId);
    try { await onAckAlert(alertId); } finally { setAckBusy(null); }
  };

  const pendingAlerts = (summary?.alerts ?? []).filter((alert) => !alert.acknowledged_at);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Budget et fournisseurs IA" description="Plafond global appliqué côté serveur avant toute réservation de dépense fournisseur." />
        {error && <div className="px-5 pb-3"><Banner tone="warning" title="Suivi du budget indisponible">{error}</Banner></div>}
        <div className="grid gap-3 px-5 pb-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">Plafond maximal</p><p className="mt-1 text-lg font-semibold text-white">{summary ? formatUsd(summary.max_usd) : '—'}</p></div>
          <div className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">Dépenses réelles connues</p><p className="mt-1 text-lg font-semibold text-white">{summary ? formatUsd(summary.actual_spent_usd) : '—'}</p></div>
          <div className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">Budget engagé (estimations incluses)</p><p className="mt-1 text-lg font-semibold text-white">{summary ? formatUsd(summary.committed_usd) : '—'}</p></div>
          <div className="rounded-xl border border-line bg-white/[0.03] p-3"><p className="text-xs text-slate-500">Budget restant</p><p className={`mt-1 text-lg font-semibold ${summary?.remaining_usd === 0 ? 'text-amber-200' : 'text-emerald-200'}`}>{summary ? formatUsd(summary.remaining_usd) : '—'}</p></div>
        </div>
        {summary && (summary.max_usd === 0 || summary.remaining_usd === 0) && (
          <div className="px-5 pb-4"><Banner tone="warning" title={summary.max_usd === 0 ? 'Aucun test payant autorisé' : 'Plafond atteint'}>
            Les nouvelles générations payantes sont bloquées côté serveur. Les dépenses réelles restent séparées des réservations et estimations.
          </Banner></div>
        )}
        {summary?.alert_state === 'threshold' && (
          <div className="px-5 pb-4"><Banner tone="warning" title={`Seuil d’alerte franchi (${summary.alert_percent} %)`}>
            {formatUsd(summary.committed_usd)} engagés sur {formatUsd(summary.max_usd)}. Les générations restent possibles jusqu’à épuisement du plafond.
          </Banner></div>
        )}
        {summary && summary.estimated_unpriced_usd > 0 && (
          <div className="px-5 pb-4"><Banner tone="warning" title="Coût réel indisponible pour certaines opérations">
            Le montant estimé est conservé séparément et engagé par prudence jusqu’à réception d’un coût réel vérifiable.
          </Banner></div>
        )}
        <form onSubmit={onSave} className="space-y-4 p-5 pt-0">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Input label="Plafond maximal autorisé (USD)" type="number" min="0" max="1000000" step="0.01" required
              value={capDraft} onChange={(event) => onCapDraftChange(event.target.value)}
              hint="0 USD bloque tous les nouveaux appels payants." />
            <Button type="submit" loading={busy} icon={<Coins size={14} />}>Enregistrer le plafond</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {summary?.enabled
              ? <Button type="button" variant="outline" loading={busy} icon={<PowerOff size={14} />} onClick={onDisable}>Désactiver immédiatement les tests payants</Button>
              : <Button type="button" loading={busy} disabled={!summary || summary.max_usd <= 0} icon={<Power size={14} />} onClick={onEnable}>Autoriser les tests payants</Button>}
            <span className="self-center text-xs text-slate-500">{summary?.enabled ? 'Autorisation active côté serveur.' : 'Désactivé : aucun appel de génération payant ne peut partir.'}</span>
          </div>
          {summary && <p className="text-xs text-slate-500">{summary.tests_count} test(s) lancé(s) · {summary.blocked_count} tentative(s) bloquée(s) · {formatUsd(summary.reserved_usd)} réservé(s) en cours.</p>}
        </form>
      </Card>

      <Card>
        <CardHeader title="Plafonds par fournisseur et alertes" description="Second verrou indépendant du plafond global. Un fournisseur sans plafond dédié reste borné par le plafond global." />
        <form onSubmit={submitPolicy} className="space-y-4 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Seuil d’alerte (% du plafond global)" type="number" min="0" max="100" step="1" required
              value={alertPercent} onChange={(event) => setAlertPercent(event.target.value)}
              hint="0 désactive les alertes. Une alerte est émise une seule fois par palier." />
            <Input label="Plafond dédié MuAPI (USD)" type="number" min="0" step="0.01"
              value={capMuapi} onChange={(event) => setCapMuapi(event.target.value)}
              hint="Vide = pas de plafond dédié (le plafond global s’applique seul)." />
          </div>
          <Button type="submit" loading={policyBusy} icon={<BellRing size={14} />}>Enregistrer la politique d’alerte</Button>
          <p className="text-xs text-slate-500">Les deux plafonds sont vérifiés côté base avant tout appel payant ; un refus ne consomme aucun crédit fournisseur.</p>
        </form>
      </Card>

      <Card>
        <CardHeader title="Dépenses par fournisseur" description="Montants établis à partir des réservations et des coûts réellement connus." />
        {!summary?.by_provider.length ? <div className="p-5"><EmptyState icon={<Coins size={22} />} title="Aucune dépense fournisseur enregistrée" /></div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Fournisseur</th><th>Dépenses réelles</th><th>Réservé</th><th>Engagé</th><th>Plafond dédié</th></tr></thead>
            <tbody>{summary.by_provider.map((provider) => <tr key={provider.provider}>
              <td className="font-medium text-white">{providerLabel(provider.provider)}</td>
              <td>{formatUsd(provider.actual_spent_usd)}</td><td>{formatUsd(provider.reserved_usd)}</td><td>{formatUsd(provider.committed_usd)}</td>
              <td>{provider.cap_usd === null ? <span className="text-xs text-slate-500">Plafond global uniquement</span> : <span>{formatUsd(Number(provider.cap_usd))}{provider.remaining_usd !== null && <span className="ml-1 text-xs text-slate-500">({formatUsd(provider.remaining_usd)} restants)</span>}</span>}</td>
            </tr>)}</tbody></table></div>
        )}
      </Card>

      <Card>
        <CardHeader title="Alertes de budget" description="Émises côté serveur, dédupliquées par palier, et notifiées aux administrateurs." />
        {!summary?.alerts.length ? <div className="p-5"><EmptyState icon={<AlertTriangle size={22} />} title="Aucune alerte de budget" /></div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Portée</th><th>Alerte</th><th>Détail</th><th>État</th><th /></tr></thead>
            <tbody>{summary.alerts.map((alert) => <tr key={alert.id}>
              <td className="whitespace-nowrap text-xs text-slate-400">{formatDate(alert.created_at, true)}</td>
              <td>{providerLabel(alert.provider)}</td>
              <td><Badge status={alert.severity}>{alert.title}</Badge></td>
              <td className="text-xs text-slate-400">{alert.reason}</td>
              <td>{alert.acknowledged_at
                ? <span className="text-xs text-slate-500">Prise en compte</span>
                : <span className="text-xs text-amber-200">À traiter</span>}</td>
              <td>{!alert.acknowledged_at && <Button size="sm" variant="ghost" loading={ackBusy === alert.id} onClick={() => void ack(alert.id)}>Acquitter</Button>}</td>
            </tr>)}</tbody></table></div>
        )}
        {pendingAlerts.length > 0 && (
          <div className="px-5 pb-4"><p className="text-xs text-amber-200">{pendingAlerts.length} alerte(s) de budget non acquittée(s).</p></div>
        )}
      </Card>

      <Card>
        <CardHeader title="Historique des dépenses fournisseur" description="Les coûts estimés et les montants réellement communiqués sont distincts. Aucune valeur n’est inventée." />
        {!summary?.history.length ? <div className="p-5"><EmptyState icon={<FileClock size={22} />} title="Aucune opération enregistrée" /></div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Fournisseur</th><th>Modèle / génération</th><th>Statut</th><th>Coût estimé</th><th>Coût réel</th><th>Référence fournisseur</th></tr></thead>
            <tbody>{summary.history.map((entry) => <tr key={entry.id}>
              <td className="whitespace-nowrap text-xs text-slate-400">{formatDate(entry.created_at, true)}</td>
              <td>{providerLabel(entry.provider)}</td>
              <td><p className="font-medium text-white">{entry.model_id}</p><p className="font-mono text-[10px] text-slate-500">{entry.generation_job_id}</p></td>
              <td><Badge status={entry.status}>{entry.status === 'blocked' ? 'Bloqué' : statusLabel(entry.status)}</Badge>{entry.reason_code && <p className="mt-1 text-[10px] text-slate-500">{entry.reason_code}</p>}</td>
              <td>{formatUsd(entry.estimated_cost_usd)}</td>
              <td>{entry.actual_cost_usd === null ? <span className="text-xs text-slate-500">Coût réel indisponible</span> : formatUsd(entry.actual_cost_usd)}</td>
              <td className="font-mono text-[10px] text-slate-500">{entry.provider_request_id ?? '—'}</td>
            </tr>)}</tbody></table></div>
        )}
      </Card>
    </div>
  );
}
