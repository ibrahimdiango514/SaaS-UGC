import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Clapperboard, FileText, Layers, Pencil, Save, Scissors, Trash2, Wand2 } from 'lucide-react';
import { PageHeader, Card, CardHeader, Button, Input, Textarea, Select, Badge, LoadingState, ErrorState, EmptyState, Tabs, ConfirmDialog } from '../components/ui';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { asAppError } from '../lib/errors';
import { formatDate, statusLabel, truncate } from '../lib/format';
import { deleteProject, getProject, listJobs, listScenes, listScripts, updateProject } from '../lib/api';
import type { GenerationJob, Project, Scene, Script } from '../lib/types';

export default function ProjectDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { refreshQuota } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('apercu');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Project>>({});
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasMoreJobs, setHasMoreJobs] = useState(false);
  const [loadingMoreJobs, setLoadingMoreJobs] = useState(false);
  const [jobsLoadError, setJobsLoadError] = useState('');
  const loadRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true); setError('');
    setJobsLoadError('');
    setProject(null); setScripts([]); setScenes([]); setJobs([]);
    setHasMoreJobs(false);
    try {
      const [p, s, sc, jobPage] = await Promise.all([
        getProject(id), listScripts(id), listScenes(id), listJobs(51, 0, undefined, id),
      ]);
      if (requestId !== loadRequestRef.current) return;
      if (!p) { setError('Projet introuvable ou inaccessible.'); return; }
      setProject(p); setForm(p); setScripts(s); setScenes(sc);
      setJobs(jobPage.slice(0, 50)); setHasMoreJobs(jobPage.length > 50);
    } catch (err) {
      if (requestId === loadRequestRef.current) setError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, [id]);

  const loadMoreJobs = async () => {
    if (loadingMoreJobs || !hasMoreJobs) return;
    const requestId = loadRequestRef.current;
    const offset = jobs.length;
    setLoadingMoreJobs(true);
    setJobsLoadError('');
    try {
      const jobPage = await listJobs(51, offset, undefined, id);
      if (requestId !== loadRequestRef.current) return;
      setJobs((current) => [...current, ...jobPage.slice(0, 50).filter((job) => !current.some((item) => item.id === job.id))]);
      setHasMoreJobs(jobPage.length > 50);
    } catch (err) {
      if (requestId === loadRequestRef.current) setJobsLoadError(asAppError(err).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoadingMoreJobs(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { loadRequestRef.current += 1; };
  }, [load]);

  const onSave = async () => {
    if (!form.title?.trim()) {
      toast.warning('Le titre du projet est obligatoire.');
      return;
    }
    setSaving(true);
    try {
      await updateProject(id, {
        title: form.title.trim(), brief: form.brief, platform: form.platform, language: form.language,
        aspect_ratio: form.aspect_ratio, campaign_objective: form.campaign_objective,
        target_audience: form.target_audience, target_market: form.target_market, status: form.status,
      } as Partial<Project>);
      setEditing(false); toast.success('Projet mis à jour.'); await load();
    } catch (err) { toast.error(asAppError(err).message); }
    finally { setSaving(false); }
  };

  const onDelete = async () => {
    try { await deleteProject(id); toast.success('Projet supprimé.'); await refreshQuota(); navigate('/app/projets'); }
    catch (err) { toast.error(asAppError(err).message); }
  };

  if (loading) return <LoadingState label="Chargement du projet…" />;
  if (error || !project) return <ErrorState message={error || 'Projet introuvable.'} onRetry={() => void load()} />;

  const tabs = [
    { id: 'apercu', label: 'Aperçu', icon: <Clapperboard size={14} /> },
    { id: 'scripts', label: `Scripts (${scripts.length})`, icon: <FileText size={14} /> },
    { id: 'scenes', label: `Scènes (${scenes.length})`, icon: <Layers size={14} /> },
    { id: 'generations', label: `Générations (${jobs.length}${hasMoreJobs ? '+' : ''})`, icon: <Wand2 size={14} /> },
  ];

  return (
    <>
      <div className="mb-4"><Link to="/app/projets" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-white"><ArrowLeft size={14} /> Tous les projets</Link></div>
      <PageHeader eyebrow="Projet" title={project.title} description={`Créé le ${formatDate(project.created_at)} · ${project.platform ?? 'Multi-plateforme'} · ${project.aspect_ratio}`}
        actions={<>
          <Badge status={project.status}>{statusLabel(project.status)}</Badge>
          <Link to={`/app/studio?projet=${project.id}`} className="btn btn-primary btn-sm"><Wand2 size={14} /> Ouvrir dans le Studio</Link>
          <Link to={`/app/studio/montage?projet=${project.id}`} className="btn btn-outline btn-sm"><Scissors size={14} /> Montage intelligent</Link>
          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Supprimer</Button>
        </>} />

      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'apercu' && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Brief & paramètres" action={<Button variant="ghost" size="sm" icon={editing ? <Save size={14} /> : <Pencil size={14} />} onClick={() => editing ? void onSave() : setEditing(true)} loading={saving}>{editing ? 'Enregistrer' : 'Modifier'}</Button>} />
            {editing ? (
              <div className="space-y-4 p-5">
                <Input label="Titre" value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                <Textarea label="Brief" value={form.brief ?? ''} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Select label="Plateforme" value={form.platform ?? ''} onChange={(e) => setForm({ ...form, platform: e.target.value })}>{['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Facebook', 'LinkedIn', 'Site web'].map((x) => <option key={x}>{x}</option>)}</Select>
                  <Select label="Format" value={form.aspect_ratio ?? ''} onChange={(e) => setForm({ ...form, aspect_ratio: e.target.value })}>{['9:16', '1:1', '4:5', '16:9'].map((x) => <option key={x}>{x}</option>)}</Select>
                  <Select label="Statut" value={form.status ?? ''} onChange={(e) => setForm({ ...form, status: e.target.value as Project['status'] })}>{['draft', 'queued', 'generating', 'completed', 'failed', 'archived'].map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</Select>
                  <Select label="Langue" value={form.language ?? 'fr'} onChange={(e) => setForm({ ...form, language: e.target.value })}><option value="fr">Français</option><option value="en">Anglais</option><option value="es">Espagnol</option></Select>
                </div>
                <Input label="Objectif" value={form.campaign_objective ?? ''} onChange={(e) => setForm({ ...form, campaign_objective: e.target.value })} />
                <Input label="Audience" value={form.target_audience ?? ''} onChange={(e) => setForm({ ...form, target_audience: e.target.value })} />
                <Input label="Marché" value={form.target_market ?? ''} onChange={(e) => setForm({ ...form, target_market: e.target.value })} />
              </div>
            ) : (
              <dl className="grid gap-4 p-5 sm:grid-cols-2">
                {[
                  ['Brief', project.brief], ['Objectif', project.campaign_objective], ['Audience', project.target_audience],
                  ['Marché', project.target_market], ['Plateforme', project.platform], ['Langue', project.language?.toUpperCase()],
                ].map(([label, value]) => (
                  <div key={label}><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-1 text-sm text-slate-200">{value || '—'}</dd></div>
                ))}
              </dl>
            )}
          </Card>
          <Card>
            <CardHeader title="Activité" />
            <div className="space-y-4 p-5 text-sm">
              {[
                ['Scripts', scripts.length], ['Scènes', scenes.length], ['Générations', jobs.length],
                ['Vidéos réussies', jobs.filter((j) => j.status === 'succeeded').length],
              ].map(([label, value]) => <div key={String(label)} className="flex justify-between border-b border-white/[0.06] pb-3"><span className="text-slate-400">{label}</span><span className="font-semibold text-white">{value}</span></div>)}
              <Link to={`/app/scripts?projet=${project.id}`} className="btn btn-outline btn-sm w-full"><FileText size={14} /> Générer un script</Link>
            </div>
          </Card>
        </div>
      )}

      {tab === 'scripts' && (
        <Card>
          <CardHeader title="Scripts du projet" action={<Link to={`/app/scripts?projet=${project.id}`} className="btn btn-primary btn-sm"><Wand2 size={14} /> Nouveau script</Link>} />
          {scripts.length === 0 ? <EmptyState icon={<FileText size={22} />} title="Aucun script" description="Générez un script IA pour ce projet." /> : (
            <div className="divide-y divide-white/[0.06]">{scripts.map((s) => (
              <div key={s.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2"><Badge status={s.status}>{statusLabel(s.status)}</Badge><span className="text-xs text-slate-500">v{s.version} · {formatDate(s.created_at, true)}</span></div>
                {s.hook && <p className="mt-3 text-sm font-semibold text-brand-200">{s.hook}</p>}
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{truncate(s.script_text, 700)}</p>
                {s.call_to_action && <p className="mt-2 text-xs text-emerald-300">CTA : {s.call_to_action}</p>}
              </div>
            ))}</div>
          )}
        </Card>
      )}

      {tab === 'scenes' && (
        <Card>
          <CardHeader title="Scènes du storyboard" />
          {scenes.length === 0 ? <EmptyState icon={<Layers size={22} />} title="Aucune scène" description="Générez un script avec scènes depuis l’onglet Scripts." /> : (
            <div className="grid gap-3 p-5 sm:grid-cols-2">{scenes.map((s) => (
              <div key={s.id} className="rounded-xl border border-line bg-white/[0.025] p-4">
                <div className="flex items-center justify-between"><Badge tone="info">{s.scene_type}</Badge><span className="text-xs text-slate-500">#{s.scene_order} · {s.duration_seconds}s</span></div>
                <p className="mt-3 text-sm text-white">{s.spoken_text || s.subtitle_text || '—'}</p>
                {s.visual_prompt && <p className="mt-2 text-xs leading-relaxed text-slate-500">{truncate(s.visual_prompt, 180)}</p>}
              </div>
            ))}</div>
          )}
        </Card>
      )}

      {tab === 'generations' && (
        <Card>
          <CardHeader title="Générations liées" action={<Link to="/app/historique" className="text-xs font-semibold text-brand-300">Historique complet</Link>} />
          {jobs.length === 0 ? <EmptyState icon={<Wand2 size={22} />} title="Aucune génération" description="Lancez une vidéo depuis l’UGC Studio." /> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Création</th><th>Statut</th><th>Type</th><th>Crédits</th><th>Date</th></tr></thead>
              <tbody>{jobs.map((j) => <tr key={j.id}><td className="font-medium text-white">Vidéo VYORA</td><td><Badge status={j.status}>{statusLabel(j.status)}</Badge></td><td>Vidéo</td><td>{j.credits_charged || j.credits_reserved}</td><td className="text-xs">{formatDate(j.created_at, true)}</td></tr>)}</tbody></table></div>
          )}
          {jobsLoadError && <p role="alert" className="m-4 rounded-lg border border-rose-400/20 bg-rose-400/[0.05] p-3 text-xs text-rose-200">{jobsLoadError}</p>}
          {hasMoreJobs && <div className="flex justify-center border-t border-line p-4"><Button variant="outline" loading={loadingMoreJobs} onClick={() => void loadMoreJobs()}>Charger plus de générations</Button></div>}
        </Card>
      )}

      <ConfirmDialog open={confirmDelete} title="Supprimer le projet ?" danger confirmLabel="Supprimer définitivement" onClose={() => setConfirmDelete(false)} onConfirm={() => void onDelete()}
        message="Cette action supprime le projet, ses scripts et ses scènes. Les vidéos déjà produites restent disponibles dans la bibliothèque." />
    </>
  );
}
