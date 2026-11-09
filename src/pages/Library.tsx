import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Download, ExternalLink, Film, FolderKanban, HardDrive, RefreshCw, Sparkles, Trash2,
} from 'lucide-react';
import {
  PageHeader, Card, Button, Badge, LoadingState, ErrorState, EmptyState,
  ConfirmDialog, Modal, Select,
} from '../components/ui';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { formatBytes, formatDate } from '../lib/format';
import {
  attachAssetToProject, deleteAsset, listAssets, listJobs, listProjects, signedStorageUrl,
} from '../lib/api';
import type { GeneratedAsset, GenerationJob, Project } from '../lib/types';
import { paramsSummary, type ParamValue } from '../studio/model';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function paramValues(value: unknown): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[key] = raw;
  }
  return out;
}

function VideoCard({ asset, job, projects, onDelete, onAttach }: {
  asset: GeneratedAsset;
  job?: GenerationJob | null;
  projects: Project[];
  onDelete: (a: GeneratedAsset) => void;
  onAttach: (a: GeneratedAsset, projectId: string) => void | Promise<void>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [projectId, setProjectId] = useState(asset.project_id ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    signedStorageUrl(asset.storage_path, 3600)
      .then((u) => { if (active) setUrl(u); })
      .catch((e) => { if (active) setError(asAppError(e).message); });
    return () => { active = false; };
  }, [asset.storage_path]);

  const metadata = asRecord(asset.metadata);
  const payload = asRecord(job?.request_payload);
  const modelId = String(metadata.model_id ?? payload.model_id ?? '—');
  const params = paramValues(metadata.params ?? payload.params);
  const credits = job?.credits_charged || job?.credits_reserved || Number(metadata.credits_reserved ?? 0);
  const project = projects.find((p) => p.id === asset.project_id);

  const submitAttach = async () => {
    if (!projectId) return;
    setSaving(true);
    try { await onAttach(asset, projectId); setAttachOpen(false); }
    finally { setSaving(false); }
  };

  return (
    <Card className="overflow-hidden">
      <div className="relative aspect-video bg-black/60">
        {url ? <video src={url} controls playsInline preload="metadata" className="h-full w-full" /> : (
          <div className="grid h-full place-items-center"><Film size={28} className={error ? 'text-rose-400' : 'text-slate-600'} /></div>
        )}
      </div>
      <div className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone="success">Vidéo réelle</Badge>
          <span className="text-[11px] text-slate-500">{formatDate(asset.created_at, true)}</span>
        </div>
        <p className="mt-2 truncate text-xs text-slate-400" title={asset.storage_path}>{asset.storage_path}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><HardDrive size={12} /> {formatBytes(asset.file_size_bytes)}</span>
          <span>{asset.mime_type ?? 'video/mp4'}</span>
          <span className="text-amber-300">{credits} crédits</span>
        </div>
        <div className="mt-3 space-y-1.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-2.5 text-[10px] leading-relaxed">
          <p><span className="text-slate-500">Modèle : </span><span className="font-mono text-slate-300">{modelId}</span></p>
          <p><span className="text-slate-500">Paramètres : </span><span className="text-slate-300">{paramsSummary(params)}</span></p>
          <p><span className="text-slate-500">Projet : </span><span className="text-slate-300">{project?.title ?? 'Bibliothèque uniquement'}</span></p>
          <p><span className="text-slate-500">Stockage : </span><span className="text-emerald-300">Supabase Storage privé</span></p>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {url && <a href={url} target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm flex-1"><ExternalLink size={13} /> Lire</a>}
          {url && <a href={url} download className="btn btn-outline btn-sm" title="Télécharger"><Download size={13} /></a>}
          <Button variant="outline" size="sm" icon={<FolderKanban size={13} />} onClick={() => setAttachOpen(true)} title="Enregistrer dans un projet" />
          {job && <Link to={`/app/studio?reuse=${job.id}`} className="btn btn-outline btn-sm" title="Relancer avec des paramètres similaires"><RefreshCw size={13} /></Link>}
          <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => onDelete(asset)} title="Supprimer" />
        </div>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      </div>

      <Modal open={attachOpen} onClose={() => setAttachOpen(false)} title="Enregistrer dans un projet" size="sm"
        description="Le fichier reste dans Storage privé ; seule la relation au projet est mise à jour via une RPC RLS."
        footer={<><Button variant="ghost" onClick={() => setAttachOpen(false)}>Annuler</Button><Button loading={saving} disabled={!projectId} onClick={() => void submitAttach()}>Enregistrer</Button></>}>
        <Select label="Projet" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">Choisir un projet…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
      </Modal>
    </Card>
  );
}

export default function Library({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toDelete, setToDelete] = useState<GeneratedAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [a, j, p] = await Promise.all([
        listAssets(), listJobs(200).catch(() => [] as GenerationJob[]), listProjects().catch(() => [] as Project[]),
      ]);
      setAssets(a); setJobs(j); setProjects(p);
    } catch (err) { setError(asAppError(err).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteAsset(toDelete.id, toDelete.storage_path);
      toast.success('Création supprimée.'); setToDelete(null); await load();
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const onAttach = async (asset: GeneratedAsset, projectId: string) => {
    try {
      const ok = await attachAssetToProject(asset.id, projectId);
      if (!ok) throw new Error('Fiche introuvable ou accès refusé.');
      toast.success('Création enregistrée dans le projet.');
      await load();
    } catch (err) { toast.error(asAppError(err).message); }
  };

  return (
    <>
      {embedded ? (
        <div className="mb-4 flex justify-end"><Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Actualiser</Button></div>
      ) : (
        <PageHeader eyebrow="Bibliothèque" title="Mes créations" description="Vidéos réellement générées et stockées dans votre espace privé."
          actions={<Button variant="ghost" size="sm" onClick={() => void load()}>Actualiser</Button>} />
      )}
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading ? <LoadingState label="Chargement de la bibliothèque…" /> : assets.length === 0 ? (
        <EmptyState icon={<Sparkles size={24} />} title="Aucune création" description="Les vidéos produites depuis le Video Studio apparaîtront ici. Aucun fichier de démonstration n’est affiché."
          action={<Link to="/app/studio" className="btn btn-primary btn-sm">Ouvrir le Video Studio</Link>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((a) => <VideoCard key={a.id} asset={a} job={jobs.find((j) => j.id === a.generation_job_id) ?? null}
            projects={projects} onDelete={setToDelete} onAttach={(asset, projectId) => onAttach(asset, projectId)} />)}
        </div>
      )}
      <ConfirmDialog open={Boolean(toDelete)} title="Supprimer cette création ?" danger confirmLabel="Supprimer" onClose={() => setToDelete(null)} onConfirm={() => void onDelete()}
        message="Le fichier vidéo et sa fiche seront supprimés. Cette action est irréversible." />
    </>
  );
}
