import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Coins, RefreshCw, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Badge, Select, LoadingState, ErrorState, EmptyState, Tabs } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, statusLabel, truncate } from '../lib/format';
import { cancelGeneration, listJobEvents, listJobs, listLedger } from '../lib/api';
import type { GenerationJob, LedgerEntry } from '../lib/types';
import { paramsSummary, type ParamValue } from '../studio/model';

function usedParams(payload: Record<string, unknown>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const source = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function JobRow({ job, onCancel, onRefresh }: { job: GenerationJob; onCancel: (id: string) => void; onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<{ id: string; event_type: string; from_status: string | null; to_status: string | null; created_at: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open && events.length === 0) {
      setLoading(true);
      try { setEvents(await listJobEvents(job.id)); } catch { /* displayed as empty */ }
      finally { setLoading(false); }
    }
    setOpen(!open);
  };

  return (
    <div className="border-b border-white/[0.06] last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
        <div className="min-w-[150px] flex-1">
          <p className="text-sm font-medium text-white">{job.service_key}</p>
          <p className="text-[11px] text-slate-500">{formatDate(job.created_at, true)} · {job.provider ?? 'non soumis'}</p>
        </div>
        <Badge status={job.status}>{statusLabel(job.status)}</Badge>
        <span className="hidden text-xs text-slate-500 sm:block">{job.credits_charged || job.credits_reserved} crédits</span>
        {['queued', 'reserved'].includes(job.status) && <Button size="sm" variant="ghost" icon={<Square size={13} />} onClick={() => onCancel(job.id)}>Annuler</Button>}
        <button onClick={() => void toggle()} className="btn btn-ghost btn-icon" title="Détails">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
      </div>
      {open && (
        <div className="grid gap-3 bg-white/[0.02] px-5 pb-4 pt-1 text-xs sm:grid-cols-2">
          <div><p className="text-slate-500">Identifiant</p><p className="break-all font-mono text-slate-300">{job.id}</p></div>
          <div><p className="text-slate-500">Fournisseur</p><p className="text-slate-300">{job.provider ?? '—'} {job.provider_job_id && <span className="font-mono text-[10px]">({truncate(job.provider_job_id, 30)})</span>}</p></div>
          <div><p className="text-slate-500">Modèle MuAPI</p><p className="font-mono text-slate-300">{String((job.request_payload as Record<string, unknown>)?.model_id ?? '—')}</p></div>
          <div><p className="text-slate-500">Coût / date</p><p className="text-slate-300">{job.credits_charged || job.credits_reserved} crédits · {formatDate(job.created_at, true)}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Paramètres utilisés</p><p className="text-slate-300">{paramsSummary(usedParams(job.request_payload as Record<string, unknown>))}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Description</p><p className="line-clamp-3 text-slate-300">{String((job.request_payload as Record<string, unknown>)?.visual_prompt ?? '—')}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Erreur</p><p className="text-slate-300">{job.error_message || '—'}</p></div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Link to={`/app/studio?reuse=${job.id}`} className="btn btn-outline btn-sm"><RefreshCw size={13} /> Relancer avec ces paramètres</Link>
            {['queued', 'reserved', 'processing'].includes(job.status) &&
              <Link to={`/app/studio?job=${job.id}`} className="btn btn-ghost btn-sm"><Activity size={13} /> Reprendre le suivi</Link>}
          </div>
          <div className="sm:col-span-2">
            <p className="mb-2 font-semibold text-slate-400">Événements de production</p>
            {loading ? <LoadingState /> : events.length === 0 ? <p className="text-slate-600">Aucun événement.</p> : (
              <ol className="space-y-1.5 border-l border-line pl-3">{events.map((e) => (
                <li key={e.id} className="relative"><span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-brand-400" />
                  <span className="text-slate-300">{e.event_type}</span> <span className="text-slate-600">{e.from_status ?? '—'} → {e.to_status ?? '—'}</span> <span className="text-slate-600">· {formatDate(e.created_at, true)}</span>
                </li>
              ))}</ol>
            )}
          </div>
          <Button size="sm" variant="ghost" className="w-fit" icon={<RefreshCw size={12} />} onClick={onRefresh}>Actualiser la liste</Button>
        </div>
      )}
    </div>
  );
}

export default function History({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const { refreshQuota } = useAuth();
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('all');
  const [tab, setTab] = useState('jobs');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { const [j, l] = await Promise.all([listJobs(200), listLedger(100)]); setJobs(j); setLedger(l); }
    catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onCancel = async (id: string) => {
    try { await cancelGeneration(id); toast.success('Génération annulée, crédits restitués.'); await refreshQuota(); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const filtered = status === 'all' ? jobs : jobs.filter((j) => j.status === status);

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end"><Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button></div>
      ) : (
        <PageHeader eyebrow="Suivi" title="Historique des générations" description="Chaque tâche, événement de production et mouvement de crédits est enregistré."
          actions={<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button>} />
      )}
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'jobs', label: `Générations (${jobs.length})`, icon: <Activity size={14} /> }, { id: 'ledger', label: `Crédits (${ledger.length})`, icon: <Coins size={14} /> }]} />
      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {tab === 'jobs' && (
        <Card>
          <CardHeader title="Tâches de génération" action={<Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto min-w-[150px]" aria-label="Filtrer par statut">
            <option value="all">Tous les statuts</option>{['queued', 'reserved', 'processing', 'succeeded', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </Select>} />
          {loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState icon={<Activity size={22} />} title="Aucune génération" description="Lancez une création depuis l’UGC Studio." action={<Link to="/app/studio" className="btn btn-primary btn-sm">Ouvrir le Studio</Link>} /> : (
            <div>{filtered.map((j) => <JobRow key={j.id} job={j} onCancel={(id) => void onCancel(id)} onRefresh={() => void load()} />)}</div>
          )}
        </Card>
      )}

      {tab === 'ledger' && (
        <Card><CardHeader title="Mouvements de crédits" description="Réservations, consommations, restitutions et ajustements." />
          {loading ? <LoadingState /> : ledger.length === 0 ? <EmptyState icon={<Coins size={22} />} title="Aucun mouvement" description="Les opérations de crédits apparaîtront ici." /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Opération</th><th>Disponible</th><th>Réservé</th><th>Description</th></tr></thead>
              <tbody>{ledger.map((l) => <tr key={l.id}>
                <td className="whitespace-nowrap text-xs">{formatDate(l.created_at, true)}</td>
                <td><Badge tone={l.available_delta > 0 ? 'success' : 'neutral'}>{l.operation_type}</Badge></td>
                <td className={l.available_delta > 0 ? 'text-emerald-300' : l.available_delta < 0 ? 'text-rose-300' : ''}>{l.available_delta > 0 ? '+' : ''}{l.available_delta}</td>
                <td className="text-slate-400">{l.reserved_delta}</td>
                <td className="text-xs text-slate-400">{l.description || '—'}</td>
              </tr>)}</tbody></table></div>
          )}
        </Card>
      )}
    </>
  );
}
