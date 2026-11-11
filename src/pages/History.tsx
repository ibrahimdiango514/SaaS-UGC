import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Coins, Film, FolderKanban, RefreshCw, Scissors, Square, ChevronDown, ChevronUp } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Badge, Select, LoadingState, ErrorState, EmptyState, Tabs } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, statusLabel } from '../lib/format';
import { cancelGeneration, listJobEvents, listJobs, listLedger } from '../lib/api';
import type { GenerationJob, LedgerEntry } from '../lib/types';
import { paramsSummary, type ParamValue } from '../studio/model';
import { QUALITY_TIERS } from '../studio/quality';
import { CREATION_MODES } from '../studio/plan';

const HISTORY_PAGE_SIZE = 50;

function usedParams(payload: Record<string, unknown>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const source = payload.params && typeof payload.params === 'object' ? payload.params as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function JobRow({ job, onCancel, onRefresh }: { job: GenerationJob; onCancel: (id: string) => void; onRefresh: () => void }) {
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;
  const result = (job.result_payload ?? {}) as Record<string, unknown>;
  const mode = CREATION_MODES.find((m) => m.id === payload.creation_mode)?.label ?? 'Parcours détaillé';
  const quality = QUALITY_TIERS.find((q) => q.id === payload.quality)?.label ?? 'Création vidéo';
  const resultPath = typeof result.storage_path === 'string' ? result.storage_path : '';
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<{ id: string; event_type: string; from_status: string | null; to_status: string | null; created_at: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventError, setEventError] = useState('');

  const loadEvents = async () => {
    setLoading(true);
    setEventError('');
    try { setEvents(await listJobEvents(job.id)); }
    catch (error) { setEventError(asAppError(error).message); }
    finally { setLoading(false); }
  };

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (events.length === 0) await loadEvents();
  };

  return (
    <div className="border-b border-white/[0.06] last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
        <div className="min-w-[150px] flex-1">
          <p className="text-sm font-medium text-white">{quality}</p>
          <p className="text-[11px] text-slate-500">{formatDate(job.created_at, true)}</p>
        </div>
        <Badge status={job.status}>{statusLabel(job.status)}</Badge>
        <span className="hidden text-xs text-slate-500 sm:block">{job.credits_charged || job.credits_reserved} crédits</span>
        {['queued', 'reserved'].includes(job.status) && <Button size="sm" variant="ghost" icon={<Square size={13} />} onClick={() => onCancel(job.id)}>Annuler</Button>}
        <button onClick={() => void toggle()} className="btn btn-ghost btn-icon" title="Détails">{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>
      </div>
      {open && (
        <div className="grid gap-3 bg-white/[0.02] px-5 pb-4 pt-1 text-xs sm:grid-cols-2">
          <div><p className="text-slate-500">Identifiant</p><p className="break-all font-mono text-slate-300">{job.id}</p></div>
          <div><p className="text-slate-500">Type de création</p><p className="text-slate-300">Vidéo VYORA</p></div>
          <div><p className="text-slate-500">Coût / date</p><p className="text-slate-300">{job.credits_charged || job.credits_reserved} crédits · {formatDate(job.created_at, true)}</p></div>
          <div><p className="text-slate-500">Mode / qualité</p><p className="text-slate-300">{mode} · {quality}</p></div>
          <div><p className="text-slate-500">Projet</p><p className="truncate text-slate-300">{job.project_id ? <Link className="text-cyan-300 hover:underline" to={`/app/projets/${job.project_id}`}>Ouvrir le projet</Link> : '—'}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Paramètres utilisés</p><p className="text-slate-300">{paramsSummary(usedParams(payload))}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Description</p><p className="line-clamp-3 text-slate-300">{String(payload.visual_prompt ?? '—')}</p></div>
          <div className="sm:col-span-2"><p className="text-slate-500">Résultat</p><p className="text-slate-300">{resultPath || job.status === 'succeeded' ? 'Vidéo enregistrée dans la bibliothèque.' : 'Aucun fichier vidéo disponible.'}</p></div>
          {job.status === 'failed' && <div className="sm:col-span-2"><p className="text-slate-500">État</p><p className="text-slate-300">La génération a échoué. Les crédits réservés ont été restitués.</p></div>}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Link to={`/app/studio?reuse=${job.id}`} className="btn btn-outline btn-sm"><RefreshCw size={13} /> Régénérer / variante</Link>
            <Link to={`/app/studio/montage?job=${job.id}`} className="btn btn-outline btn-sm"><Scissors size={13} /> Modifier le montage</Link>
            <Link to={`/app/studio/montage?draft=1`} className="btn btn-ghost btn-sm"><FolderKanban size={13} /> Reprendre l’éditeur</Link>
            <Link to="/app/bibliotheque" className="btn btn-ghost btn-sm"><Film size={13} /> Résultat / bibliothèque</Link>
            {['queued', 'reserved', 'processing'].includes(job.status) &&
              <Link to={`/app/studio?job=${job.id}`} className="btn btn-ghost btn-sm"><Activity size={13} /> Reprendre le suivi</Link>}
          </div>
          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="font-semibold text-slate-400">Événements de production</p>
              {eventError && <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void loadEvents()}>Réessayer</Button>}
            </div>
            {loading ? <LoadingState /> : eventError ? (
              <p className="rounded-lg border border-rose-400/20 bg-rose-400/[0.05] p-3 text-xs text-rose-200" role="alert">{eventError}</p>
            ) : events.length === 0 ? <p className="text-slate-600">Aucun événement enregistré.</p> : (
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
  const [loadingMoreJobs, setLoadingMoreJobs] = useState(false);
  const [loadingMoreLedger, setLoadingMoreLedger] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<GenerationJob['status'] | 'all'>('all');
  const [tab, setTab] = useState('jobs');
  const [hasMoreJobs, setHasMoreJobs] = useState(false);
  const [hasMoreLedger, setHasMoreLedger] = useState(false);
  const [jobsOffset, setJobsOffset] = useState(0);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true); setError('');
    setJobs([]); setLedger([]);
    setHasMoreJobs(false); setHasMoreLedger(false);
    setJobsOffset(0); setLedgerOffset(0);
    try {
      const [jobPage, ledgerPage] = await Promise.all([
        listJobs(HISTORY_PAGE_SIZE + 1, 0, status === 'all' ? undefined : status),
        listLedger(HISTORY_PAGE_SIZE + 1, 0),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setJobs(jobPage.slice(0, HISTORY_PAGE_SIZE));
      setLedger(ledgerPage.slice(0, HISTORY_PAGE_SIZE));
      setHasMoreJobs(jobPage.length > HISTORY_PAGE_SIZE);
      setHasMoreLedger(ledgerPage.length > HISTORY_PAGE_SIZE);
      setJobsOffset(HISTORY_PAGE_SIZE);
      setLedgerOffset(HISTORY_PAGE_SIZE);
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  const loadMoreJobs = async () => {
    const requestId = loadRequestRef.current;
    setLoadingMoreJobs(true);
    try {
      const page = await listJobs(HISTORY_PAGE_SIZE + 1, jobsOffset, status === 'all' ? undefined : status);
      if (requestId !== loadRequestRef.current) return;
      setJobs((current) => [...current, ...page.slice(0, HISTORY_PAGE_SIZE).filter((job) => !current.some((item) => item.id === job.id))]);
      setHasMoreJobs(page.length > HISTORY_PAGE_SIZE);
      setJobsOffset((current) => current + HISTORY_PAGE_SIZE);
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoadingMoreJobs(false);
    }
  };

  const loadMoreLedger = async () => {
    const requestId = loadRequestRef.current;
    setLoadingMoreLedger(true);
    try {
      const page = await listLedger(HISTORY_PAGE_SIZE + 1, ledgerOffset);
      if (requestId !== loadRequestRef.current) return;
      setLedger((current) => [...current, ...page.slice(0, HISTORY_PAGE_SIZE).filter((entry) => !current.some((item) => item.id === entry.id))]);
      setHasMoreLedger(page.length > HISTORY_PAGE_SIZE);
      setLedgerOffset((current) => current + HISTORY_PAGE_SIZE);
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoadingMoreLedger(false);
    }
  };

  const onCancel = async (id: string) => {
    try { await cancelGeneration(id); toast.success('Génération annulée, crédits restitués.'); await refreshQuota(); await load(); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  const filtered = jobs;

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end"><Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button></div>
      ) : (
        <PageHeader eyebrow="Suivi" title="Historique des générations" description="Chaque tâche, événement de production et mouvement de crédits est enregistré."
          actions={<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button>} />
      )}
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'jobs', label: `Générations (${jobs.length}${hasMoreJobs ? '+' : ''})`, icon: <Activity size={14} /> }, { id: 'ledger', label: `Crédits (${ledger.length}${hasMoreLedger ? '+' : ''})`, icon: <Coins size={14} /> }]} />
      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {tab === 'jobs' && (
        <Card>
          <CardHeader title="Tâches de génération" action={<Select value={status} onChange={(e) => setStatus(e.target.value as GenerationJob['status'] | 'all')} className="w-auto min-w-[150px]" aria-label="Filtrer par statut">
            <option value="all">Tous les statuts</option>{['queued', 'reserved', 'processing', 'succeeded', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </Select>} />
          {loading ? <LoadingState /> : filtered.length === 0 ? <EmptyState icon={<Activity size={22} />} title="Aucune génération" description="Lancez une création depuis l’UGC Studio." action={<Link to="/app/studio" className="btn btn-primary btn-sm">Ouvrir le Studio</Link>} /> : (
            <div>{filtered.map((j) => <JobRow key={j.id} job={j} onCancel={(id) => void onCancel(id)} onRefresh={() => void load()} />)}</div>
          )}
          {!loading && hasMoreJobs && <div className="flex justify-center border-t border-line p-4"><Button variant="outline" loading={loadingMoreJobs} onClick={() => void loadMoreJobs()}>Charger plus de générations</Button></div>}
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
          {!loading && hasMoreLedger && <div className="flex justify-center border-t border-line p-4"><Button variant="outline" loading={loadingMoreLedger} onClick={() => void loadMoreLedger()}>Charger plus de mouvements</Button></div>}
        </Card>
      )}
    </>
  );
}
