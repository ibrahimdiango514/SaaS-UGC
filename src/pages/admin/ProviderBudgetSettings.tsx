import type { FormEvent } from 'react';
import { Coins, FileClock, Power, PowerOff } from 'lucide-react';
import { Banner, Badge, Button, Card, CardHeader, EmptyState, Input } from '../../components/ui';
import { formatDate, statusLabel } from '../../lib/format';
import type { AdminProviderSpendSummary } from '../../lib/types';

const formatUsd = (amount: number) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 6,
}).format(amount);

interface ProviderBudgetSettingsProps {
  summary: AdminProviderSpendSummary | null;
  error: string;
  capDraft: string;
  busy: boolean;
  onCapDraftChange: (value: string) => void;
  onSave: (event: FormEvent) => void;
  onEnable: () => void;
  onDisable: () => void;
}

export default function ProviderBudgetSettings({
  summary, error, capDraft, busy, onCapDraftChange, onSave, onEnable, onDisable,
}: ProviderBudgetSettingsProps) {
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
        <CardHeader title="Dépenses par fournisseur" description="Montants établis à partir des réservations et des coûts réellement connus." />
        {!summary?.by_provider.length ? <div className="p-5"><EmptyState icon={<Coins size={22} />} title="Aucune dépense fournisseur enregistrée" /></div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Fournisseur</th><th>Dépenses réelles</th><th>Réservé</th><th>Engagé</th></tr></thead>
            <tbody>{summary.by_provider.map((provider) => <tr key={provider.provider}>
              <td className="font-medium text-white">{provider.provider === 'muapi' ? 'MuAPI' : provider.provider}</td>
              <td>{formatUsd(provider.actual_spent_usd)}</td><td>{formatUsd(provider.reserved_usd)}</td><td>{formatUsd(provider.committed_usd)}</td>
            </tr>)}</tbody></table></div>
        )}
      </Card>

      <Card>
        <CardHeader title="Historique des dépenses fournisseur" description="Les coûts estimés et les montants réellement communiqués sont distincts. Aucune valeur n’est inventée." />
        {!summary?.history.length ? <div className="p-5"><EmptyState icon={<FileClock size={22} />} title="Aucune opération enregistrée" /></div> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Fournisseur</th><th>Modèle / génération</th><th>Statut</th><th>Coût estimé</th><th>Coût réel</th><th>Référence fournisseur</th></tr></thead>
            <tbody>{summary.history.map((entry) => <tr key={entry.id}>
              <td className="whitespace-nowrap text-xs text-slate-400">{formatDate(entry.created_at, true)}</td>
              <td>{entry.provider === 'muapi' ? 'MuAPI' : entry.provider}</td>
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
