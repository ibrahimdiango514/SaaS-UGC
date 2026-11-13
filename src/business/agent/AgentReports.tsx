import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Download, FileText, Loader2, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { Badge, Button, ConfirmDialog, cn } from '../../components/ui';
import { businessGrowApi, type BusinessRecommendation, type BusinessReport, type BusinessReportType, type SavedBusinessReport } from '../api';

const REPORTS: Array<{ key: BusinessReportType; label: string }> = [
  { key: 'health', label: 'Santé globale' }, { key: 'commercial', label: 'Commercial' },
  { key: 'financial', label: 'Financier' }, { key: 'customers', label: 'Clients' },
  { key: 'recovery', label: 'Récupération des revenus' }, { key: 'operations', label: 'Opérationnel' },
];
function dates() {
  const now = new Date(); const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { to: end.toISOString().slice(0, 10), from: new Date(end.getTime() - 29 * 86_400_000).toISOString().slice(0, 10) };
}
function validPeriod(from: string, to: string): boolean {
  const parse = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
    const value = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : NaN;
  };
  const first = parse(from); const last = parse(to);
  return Number.isFinite(first) && Number.isFinite(last) && last >= first && last - first <= 365 * 86_400_000;
}
function reportLabel(type: BusinessReportType) { return REPORTS.find((item) => item.key === type)?.label ?? type; }
function priorityTone(priority: BusinessRecommendation['priority']): 'danger' | 'warning' | 'neutral' {
  return priority === 'critique' || priority === 'élevée' ? 'danger' : priority === 'moyenne' ? 'warning' : 'neutral';
}
function downloadReport(report: BusinessReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `vyora-${report.type}-${report.period.from}-${report.period.to}.json`;
  link.click(); URL.revokeObjectURL(url);
}

/** Le calcul affiché ici est déterministe ; il n'est jamais étiqueté comme une réponse fournisseur IA. */
export default function AgentReports({ workspaceId, ready, busy, onReport, onPropose, onAsk }: {
  workspaceId: string | null; ready: boolean; busy: boolean;
  onReport: (report: BusinessReport | null) => void;
  onPropose: (finding: BusinessRecommendation) => Promise<boolean>;
  onAsk: (text: string) => void;
}) {
  const initial = useRef(dates());
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<BusinessReportType>('health');
  const [from, setFrom] = useState(initial.current.from); const [to, setTo] = useState(initial.current.to);
  const [report, setReport] = useState<BusinessReport | null>(null);
  const [reports, setReports] = useState<SavedBusinessReport[]>([]);
  const [activeSavedId, setActiveSavedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedBusinessReport | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [showAll, setShowAll] = useState(false); const [proposing, setProposing] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const historySequence = useRef(0);
  const proposalSequence = useRef(0);
  const deleteSequence = useRef(0);
  const saveKeys = useRef(new Map<string, string>());

  const analyze = useCallback(async (reportType: BusinessReportType, start: string, end: string, save: boolean) => {
    if (!workspaceId || !ready || typeof businessGrowApi.generateReport !== 'function') return;
    const seq = ++requestSequence.current;
    if (save) setSaving(true); else setLoading(true);
    setError(''); setNotice('');
    try {
      const key = `${reportType}:${start}:${end}`;
      if (save && !saveKeys.current.has(key)) saveKeys.current.set(key, crypto.randomUUID());
      const result = await businessGrowApi.generateReport(workspaceId, reportType, start, end, save, saveKeys.current.get(key));
      if (seq !== requestSequence.current) return;
      setReport(result.report); setActiveSavedId(save ? result.id ?? null : null); setShowAll(false); onReport(result.report);
      if (save) {
        saveKeys.current.delete(key);
        setNotice(result.created === false ? 'Rapport déjà enregistré : résultat initial conservé.' : 'Rapport enregistré dans cette entreprise.');
        if (typeof businessGrowApi.listReports === 'function') {
          try {
            const historySeq = ++historySequence.current;
            const history = await businessGrowApi.listReports(workspaceId);
            if (seq === requestSequence.current && historySeq === historySequence.current) setReports(history.reports);
          } catch { /* le rapport est enregistré même si l’historique ne se recharge pas */ }
        }
      }
    } catch (cause) {
      if (seq === requestSequence.current) setError(cause instanceof Error ? cause.message : 'Analyse indisponible.');
    } finally {
      if (seq === requestSequence.current) { setLoading(false); setSaving(false); }
    }
  }, [workspaceId, ready, onReport]);

  useEffect(() => {
    setReport(null); setReports([]); setActiveSavedId(null); setDeleteTarget(null); setDeleting(false); setError(''); setNotice(''); setLoading(false); setSaving(false); setProposing(null);
    onReport(null);
    if (workspaceId && ready) {
      // Un seul calcul borné, sans écriture ni coût fournisseur, pour adapter les suggestions.
      void analyze('health', initial.current.from, initial.current.to, false);
    }
    return () => { requestSequence.current++; historySequence.current++; proposalSequence.current++; deleteSequence.current++; };
  }, [analyze, workspaceId, ready, onReport]);

  useEffect(() => { saveKeys.current.clear(); }, [workspaceId]);

  const loadHistory = async () => {
    if (!workspaceId || typeof businessGrowApi.listReports !== 'function') return;
    const seq = ++historySequence.current;
    try { const result = await businessGrowApi.listReports(workspaceId); if (seq === historySequence.current) setReports(result.reports); }
    catch (cause) { if (seq === historySequence.current) setError(cause instanceof Error ? cause.message : 'Historique des rapports indisponible.'); }
  };
  const confirmDeleteReport = async () => {
    if (!workspaceId || !deleteTarget || deleting) return;
    const target = deleteTarget;
    const seq = ++deleteSequence.current;
    historySequence.current++; // Ignore tout ancien chargement de l'historique.
    setDeleting(true); setError(''); setNotice('');
    try {
      await businessGrowApi.deleteReport(workspaceId, target.id);
      if (seq !== deleteSequence.current) return;
      setReports((current) => current.filter((saved) => saved.id !== target.id));
      if (activeSavedId === target.id) { setReport(null); setActiveSavedId(null); onReport(null); }
      setNotice('Rapport supprimé de l’historique. Les éventuels fichiers téléchargés restent sur vos appareils.');
    } catch (cause) {
      if (seq === deleteSequence.current) setError(`${cause instanceof Error ? cause.message : 'Suppression non confirmée.'} Actualisez l’historique avant de recommencer.`);
    } finally {
      if (seq === deleteSequence.current) { setDeleting(false); setDeleteTarget(null); }
    }
  };
  const prepareTask = async (finding: BusinessRecommendation) => {
    const seq = ++proposalSequence.current;
    setProposing(finding.id); setNotice(''); setError('');
    try {
      if (await onPropose(finding) && seq === proposalSequence.current) setNotice('Proposition ajoutée à la conversation initiale : vérifiez-la puis approuvez ou rejetez-la.');
    } catch (cause) { if (seq === proposalSequence.current) setError(cause instanceof Error ? cause.message : 'Proposition impossible.'); }
    finally { if (seq === proposalSequence.current) setProposing(null); }
  };
  const periodValid = validPeriod(from, to);

  if (!workspaceId || !ready) return null;
  return (
    <div className="rounded-2xl border border-violet-300/15 bg-violet-300/[0.035]" data-testid="business-agent-reports">
      <button type="button" onClick={() => { setOpen(!open); if (!open) void loadHistory(); }} aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.025]">
        <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-violet-300/10 text-violet-200"><Activity size={17} /></span>
          <span><span className="block text-sm font-semibold text-white">Diagnostics & rapports</span>
            <span className="block text-[11px] text-slate-400">Calcul sur les données enregistrées · sans appel IA</span></span></span>
        <span className="text-xs text-violet-200">{loading ? 'Analyse…' : report ? `${report.totalRecommendations} recommandation(s)` : 'Ouvrir'} <ArrowUpRight size={13} className="ml-1 inline" /></span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-white/[0.07] p-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="text-[11px] text-slate-400">Rapport
              <select aria-label="Type de rapport" value={type} onChange={(e) => setType(e.target.value as BusinessReportType)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c111b] px-2 py-2 text-xs text-white">
                {REPORTS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-slate-400">Du
              <input aria-label="Début de période" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c111b] px-2 py-2 text-xs text-white" />
            </label>
            <label className="text-[11px] text-slate-400">Au
              <input aria-label="Fin de période" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-[#0c111b] px-2 py-2 text-xs text-white" />
            </label>
          </div>
          {!periodValid && <p role="alert" className="text-xs text-amber-100">Choisissez une période valide de 366 jours maximum.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<RefreshCw size={13} />} loading={loading} disabled={busy || saving || deleting || !periodValid} onClick={() => void analyze(type, from, to, false)}>Analyser</Button>
            <Button size="sm" variant="outline" icon={<FileText size={13} />} loading={saving} disabled={busy || loading || deleting || !periodValid} onClick={() => void analyze(type, from, to, true)}>Enregistrer le rapport</Button>
            {report && <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => downloadReport(report)}>Télécharger JSON</Button>}
          </div>
          {error && <p className="rounded-lg border border-rose-400/20 bg-rose-400/5 p-3 text-xs text-rose-200" role="alert">{error}</p>}
          {notice && <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 p-3 text-xs text-emerald-200" role="status">{notice}</p>}
          {loading && <p className="flex items-center gap-2 text-xs text-slate-400"><Loader2 size={13} className="animate-spin" /> Lecture sécurisée des modules…</p>}
          {report && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-sm font-semibold text-white">{reportLabel(report.type)}</p>
                  <p className="text-[11px] text-slate-400">Période : {report.period.from} → {report.period.to} · instantané : {report.asOf}</p></div>
                <Button size="sm" variant="ghost" icon={<Sparkles size={13} />} onClick={() => {
                  // Les libellés et notes de fiches sont non fiables : ne pas les
                  // transformer en instructions de chat. Seules les mesures validées
                  // et catégories déterministes sont copiées dans ce brouillon.
                  const details = report.recommendations.slice(0, 8).map(({ kind, priority, facts }) => ({ kind, priority, facts }));
                  const summary = { period: report.period, asOf: report.asOf, coverage: report.coverage.map(({ module, count, status, truncated }) => ({ module, count, status, truncated })), metrics: report.metrics, findings: details, warnings: report.warnings };
                  onAsk(`Approfondis ce rapport ${reportLabel(report.type)} calculé automatiquement. Distingue les faits, les données manquantes et les actions à valider. Les montants ne sont pas des gains garantis. Données : ${JSON.stringify(summary)}`.slice(0, 12000));
                }}>Approfondir avec l’IA</Button>
              </div>
              {report.metrics.length > 0 && <div className="grid gap-2 sm:grid-cols-3">{report.metrics.map((metric) => (
                <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-black/15 p-3"><p className="text-[10px] text-slate-400">{metric.label}</p><p className="mt-1 text-sm font-semibold text-white">{new Intl.NumberFormat('fr-FR').format(metric.value)} {metric.unit}</p><p className="mt-1 text-[10px] text-slate-500">{metric.basis}</p></div>
              ))}</div>}
              <div className="flex flex-wrap gap-1.5">{report.coverage.map((item) => (
                <span key={item.category} title={item.status === 'consent_required' ? 'Consentement requis' : `${item.count} enregistrement(s)`} className={cn('rounded-full border px-2 py-1 text-[10px]',item.status === 'available' ? 'border-emerald-300/20 text-emerald-200' : 'border-white/10 text-slate-500')}>
                  {item.module} · {item.status === 'consent_required' ? 'consentement requis' : item.count}{item.truncated ? '+' : ''}
                </span>
              ))}</div>
              {report.warnings.map((warning) => <p key={warning} className="flex gap-2 text-[11px] leading-relaxed text-amber-100/75"><ShieldCheck size={13} className="mt-0.5 shrink-0" />{warning}</p>)}
              {report.recommendations.length === 0 && <p className="rounded-xl border border-dashed border-white/10 p-4 text-xs text-slate-400">Aucune alerte détectée dans les données disponibles. Un module vide ne prouve pas l’absence de risque.</p>}
              <div className="space-y-2">{report.recommendations.slice(0, showAll ? 40 : 6).map((item) => (
                <article key={item.id} className="rounded-xl border border-white/[0.08] bg-[#0c111b] p-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold text-white">{item.problem}</p><p className="mt-1 text-[10px] text-violet-200">{item.module}</p></div><Badge tone={priorityTone(item.priority)}>Priorité {item.priority}</Badge></div>
                  <p className="mt-2 text-slate-300"><strong className="text-slate-200">Preuves :</strong> {item.evidence.join(' ')}</p>
                  <p className="mt-1 text-slate-400"><strong className="text-slate-300">Impact potentiel :</strong> {item.potentialImpact}</p>
                  <p className="mt-1 text-slate-400"><strong className="text-slate-300">Action :</strong> {item.action}</p>
                  <Button size="sm" variant="outline" className="mt-3" disabled={busy || proposing !== null} loading={proposing === item.id} onClick={() => void prepareTask(item)}>Préparer une tâche</Button>
                </article>
              ))}</div>
              {report.recommendations.length > 6 && <button type="button" className="text-xs text-violet-200 underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Voir moins' : `Voir les ${report.recommendations.length} recommandations affichées`}</button>}
            </div>
          )}
          <div className="border-t border-white/[0.07] pt-3">
            <div className="mb-2 flex items-center justify-between gap-2"><p className="text-xs font-semibold text-slate-300">Rapports enregistrés · {reports.length}/100</p>
              <button type="button" disabled={deleting} onClick={() => void loadHistory()} className="text-[11px] text-violet-200 underline disabled:opacity-50">Actualiser l’historique</button></div>
            <p className="mb-2 text-[11px] text-slate-500">Les rapports conservés peuvent contenir des informations copiées ; vous pouvez les supprimer ici.</p>
            {reports.length === 0 ? <p className="text-[11px] text-slate-500">Aucun rapport enregistré chargé.</p> :
              <div className="max-h-56 space-y-1 overflow-y-auto">{reports.map((saved) => (
                <div key={saved.id} className="flex items-center gap-1 rounded-lg border border-white/10">
                  <button type="button" disabled={busy || loading || saving || deleting} onClick={() => { setType(saved.report_type); setFrom(saved.period_from); setTo(saved.period_to); setReport(saved.document); setActiveSavedId(saved.id); onReport(saved.document); setNotice('Rapport enregistré chargé.'); }} className="min-w-0 flex-1 px-2 py-2 text-left text-[11px] text-slate-300 hover:text-white disabled:opacity-50">{reportLabel(saved.report_type)} · {saved.period_from} → {saved.period_to} <span className="text-slate-500">· {new Date(saved.created_at).toLocaleString('fr-FR')}</span></button>
                  <button type="button" disabled={busy || loading || saving || deleting} onClick={() => setDeleteTarget(saved)} aria-label={`Supprimer le rapport ${reportLabel(saved.report_type)} du ${saved.period_from} au ${saved.period_to}, enregistré le ${saved.created_at}`} className="rounded-lg p-2 text-slate-400 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50"><Trash2 size={14} /></button>
                </div>
              ))}</div>}
          </div>
          <ConfirmDialog open={Boolean(deleteTarget)} title="Supprimer ce rapport ?" danger loading={deleting} confirmLabel="Supprimer le rapport"
            message="Cette suppression retire le rapport enregistré de cette entreprise. Les fiches, tâches, conversations et fichiers déjà téléchargés restent inchangés."
            onClose={() => { if (!deleting) setDeleteTarget(null); }} onConfirm={() => void confirmDeleteReport()} />
        </div>
      )}
    </div>
  );
}
