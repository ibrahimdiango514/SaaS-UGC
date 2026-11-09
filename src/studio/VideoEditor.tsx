import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, CheckCircle2, Clapperboard, Download, Film, FolderOpen,
  Info, LoaderCircle, Pause, Play, RefreshCw, Save, Scissors, Sparkles, Upload, X,
} from 'lucide-react';
import { Banner, Button, ErrorState, LoadingState, Modal, Select, Toggle } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  generateScript, healthCheck, listAssets, signedStorageUrl,
} from '../lib/api';
import { asAppError } from '../lib/errors';
import type { GeneratedAsset } from '../lib/types';
import { StudioTopBar } from './components/StudioTopBar';
import {
  buildLocalPlan, mapAiScriptToPlan, planToEditorProject, replanEditorScenes, validateProductionPlan,
} from './plan';
import { AssistPanel } from './editor/components/AssistPanel';
import { PreviewPlayer } from './editor/components/PreviewPlayer';
import { Timeline } from './editor/components/Timeline';
import {
  createEditorProject, loadEditorProject, loadLocalDraft, persistLocalMedia,
  saveEditorProject, saveLocalDraft,
} from './editor/persistence';
import {
  RENDER_LIMITATIONS, downloadBlob, exportFilename, renderIssues, renderProject,
  supportedMimeType,
  type RenderResult,
} from './editor/render';
import {
  ASPECT_PRESETS, replaceSceneSource, totalDuration,
  type AspectPreset, type EditorProject,
} from './editor/types';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const DEMO_BRIEF = 'Pub UGC de 20 secondes pour un sérum éclat : accroche problème, démonstration texture, bénéfice visible, appel à l’achat.';

function demoProject(): EditorProject {
  const plan = buildLocalPlan({ prompt: DEMO_BRIEF, ratio: '9:16', subtitles: true });
  return planToEditorProject(plan, {
    quality: 'standard', mode: 'idea', model: null, subtitles: true, demo: true,
  });
}

function cumulativeBoundaries(project: EditorProject): number[] {
  const out: number[] = [0];
  for (const s of project.scenes) out.push(out[out.length - 1] + Math.max(0, s.duration));
  return out;
}

export default function VideoEditor() {
  const toast = useToast();
  const navigate = useNavigate();
  const { workspaceId } = useAuth();
  const [search] = useSearchParams();

  const [project, setProject] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [brief, setBrief] = useState('');
  const [planMessage, setPlanMessage] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderLabel, setRenderLabel] = useState('');
  const [renderError, setRenderError] = useState('');
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      let next: EditorProject | null = null;
      if (search.get('draft') === '1') next = loadLocalDraft();
      const savedId = search.get('projet');
      if (!next && savedId) next = await loadEditorProject(savedId);
      if (!next) next = demoProject();

      const jobId = search.get('job');
      if (jobId) {
        const all = await listAssets().catch(() => [] as GeneratedAsset[]);
        const asset = all.find((a) => a.generation_job_id === jobId && a.storage_path && a.asset_type?.includes('video'));
        if (asset?.storage_path) {
          try {
            const url = await signedStorageUrl(asset.storage_path, 3600);
            const first = next.scenes[0]?.id;
            if (first) next = replaceSceneSource(next, first, {
              kind: 'job', name: 'Vidéo générée', url, storagePath: asset.storage_path, assetId: asset.id, jobId,
            });
          } catch { /* media remains explicitly missing */ }
        }
      }
      setProject(next); setBrief(next.prompt); setSelectedId(next.scenes[0]?.id ?? '');
      setPlayhead(0); setPlaying(false);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
    } catch (err) { setLoadError(asAppError(err).message); }
    finally { setLoading(false); }
  }, [search]);
  useEffect(() => { void load(); }, [load]);

  const onChange = useCallback((next: EditorProject) => {
    setProject({ ...next, updatedAt: new Date().toISOString() });
    setRenderResult(null); setRenderError('');
  }, []);

  const total = useMemo(() => project ? totalDuration(project) : 0, [project]);
  const issues = useMemo(() => project ? renderIssues(project) : [], [project]);
  const mime = useMemo(() => supportedMimeType(), []);
  const boundaries = useMemo(() => project ? cumulativeBoundaries(project) : [0], [project]);

  const onTogglePlay = () => {
    if (!project) return;
    if (issues.length) { toast.warning('Ajoutez un média réel à chaque plan avant la lecture.'); return; }
    if (playhead >= total - 0.05) setPlayhead(0);
    setPlaying((v) => !v);
  };

  const onPreviewEnded = () => {
    const next = boundaries.find((b) => b > playhead + 0.1);
    if (next !== undefined && next < total - 0.05) setPlayhead(next);
    else { setPlayhead(total); setPlaying(false); }
  };

  const onImport = async (file: File, sceneId: string) => {
    if (!project) return;
    if (file.size > MAX_IMPORT_BYTES) { toast.error('Fichier trop volumineux (50 Mo maximum).'); return; }
    const objectUrl = URL.createObjectURL(file);
    // Immediately usable in this tab, even before the private upload completes.
    onChange(replaceSceneSource(project, sceneId, { kind: 'local', name: file.name, url: objectUrl }));
    if (!workspaceId) {
      toast.warning('Clip disponible pour cette session uniquement : espace de travail indisponible pour la sauvegarde.');
      return;
    }
    try {
      const storagePath = await persistLocalMedia(workspaceId, file);
      setProject((current) => current ? replaceSceneSource(current, sceneId, {
        kind: 'local', name: file.name, url: objectUrl, storagePath,
      }) : current);
      toast.success('Clip importé dans votre espace de stockage privé.');
    } catch (err) {
      toast.warning(`Sauvegarde du clip impossible : ${asAppError(err).message}`);
    }
  };

  const onImportAudio = async (file: File) => {
    if (!project) return;
    if (!file.type.startsWith('audio/')) { toast.error('Choisissez un fichier audio.'); return; }
    if (file.size > MAX_IMPORT_BYTES) { toast.error('Fichier trop volumineux (50 Mo maximum).'); return; }
    const url = URL.createObjectURL(file);
    let storagePath: string | undefined;
    if (workspaceId) {
      try { storagePath = await persistLocalMedia(workspaceId, file); }
      catch (err) { toast.warning(`Audio disponible pour cette session : ${asAppError(err).message}`); }
    }
    onChange({ ...project, audio: { kind: 'local', name: file.name, url, storagePath, volume: project.audio.volume || 0.8 } });
  };

  const save = useCallback(async (): Promise<EditorProject | null> => {
    if (!project) return null;
    setSaving(true);
    try {
      let next = project;
      if (project.projectId) next = await saveEditorProject(project.projectId, project);
      else {
        const id = await createEditorProject(project);
        next = { ...project, projectId: id };
      }
      setProject(next); saveLocalDraft(next);
      setSavedAt(new Date().toISOString());
      toast.success('Montage enregistré dans le projet UGC existant (aucune nouvelle table).');
      return next;
    } catch (err) { toast.error(asAppError(err).message); return null; }
    finally { setSaving(false); }
  }, [project, toast]);

  const render = useCallback(async () => {
    if (!project) return;
    const problems = renderIssues(project);
    if (problems.length) { setRenderError(problems.join(' ')); toast.warning(problems[0]); return; }
    if (!mime) { setRenderError('MediaRecorder non pris en charge par ce navigateur.'); return; }
    abortRef.current?.abort();
    const controller = new AbortController(); abortRef.current = controller;
    setRendering(true); setRenderError(''); setRenderResult(null); setRenderProgress(0); setRenderLabel('Préparation…');
    try {
      const result = await renderProject(project, {
        fps: 30, signal: controller.signal,
        onProgress: (ratio, label) => { setRenderProgress(ratio); setRenderLabel(label); },
      });
      setRenderResult(result); setRenderProgress(1); setRenderLabel('Rendu terminé');
      toast.success('Rendu navigateur terminé : un fichier vidéo réel est prêt à télécharger.');
    } catch (err) {
      if (controller.signal.aborted) setRenderError('Rendu interrompu. Le montage est conservé : reprenez quand vous voulez.');
      else setRenderError(asAppError(err).message);
    } finally { setRendering(false); abortRef.current = null; }
  }, [project, mime, toast]);

  const openLibrary = async () => {
    setLibraryOpen(true); setLibraryBusy(true);
    try { setAssets((await listAssets()).filter((a) => a.storage_path && a.asset_type?.includes('video')).slice(0, 50)); }
    catch (err) { toast.error(asAppError(err).message); setAssets([]); }
    finally { setLibraryBusy(false); }
  };

  const attachAsset = async (asset: GeneratedAsset) => {
    if (!project || !selectedId || !asset.storage_path) return;
    try {
      const url = await signedStorageUrl(asset.storage_path, 3600);
      onChange(replaceSceneSource(project, selectedId, {
        kind: 'asset', name: asset.storage_path.split('/').pop() || 'Création Reelora',
        url, storagePath: asset.storage_path, assetId: asset.id,
      }));
      setLibraryOpen(false); toast.success('Création réelle attachée au plan sélectionné.');
    } catch (err) { toast.error(asAppError(err).message); }
  };

  const applyBrief = (useAi: boolean) => async () => {
    if (!project) return;
    if (brief.trim().length < 20) { toast.warning('Décrivez la demande générale en au moins 20 caractères.'); return; }
    setPlanBusy(true); setPlanMessage('');
    try {
      const local = buildLocalPlan({
        prompt: brief, ratio: project.aspect, subtitles: project.subtitlesEnabled,
      });
      if (!useAi) {
        const validated = validateProductionPlan(local);
        if (!validated.ok) { setPlanMessage(`Plan rejeté : ${validated.errors.join(' ')}`); return; }
        onChange(replanEditorScenes(project, validated.plan));
        setPlanMessage('Plan local validé : les scènes ont été recalculées, les médias réels conservés par position.');
        toast.success('Demande générale appliquée au montage.');
        return;
      }
      if (health?.groq !== true) {
        setPlanMessage('Assistance IA indisponible : GROQ_API_KEY absent côté serveur. Aucune réponse n’est simulée.');
        return;
      }
      const script = await generateScript({
        product: brief.slice(0, 120), brief: brief.slice(0, 800),
        duration: Math.round(total || 20), language: 'fr',
      });
      const mapped = mapAiScriptToPlan(script, local);
      if (!mapped.ok) {
        setPlanMessage(`Réponse Groq rejetée par la validation structurée : ${mapped.errors.join(' ')} Aucune donnée n’a été transmise à MuAPI.`);
        toast.warning('Plan IA invalide : montage inchangé.');
        return;
      }
      onChange(replanEditorScenes(project, mapped.plan));
      setPlanMessage('Plan Groq validé puis appliqué au montage. Relisez chaque plan et ses médias.');
      toast.success('Plan IA validé et appliqué.');
    } catch (err) { setPlanMessage(asAppError(err).message); toast.error(asAppError(err).message); }
    finally { setPlanBusy(false); }
  };

  const backToStudio = () => {
    if (!project) return;
    saveLocalDraft(project);
    navigate('/app/studio?fromEditor=1');
  };

  if (loading) return <div className="studio-v2"><StudioTopBar /><LoadingState label="Ouverture de l’AI Video Editor…" /></div>;
  if (loadError || !project) return <div className="studio-v2"><StudioTopBar /><ErrorState message={loadError || 'Montage introuvable.'} onRetry={() => void load()} /></div>;

  const selected = project.scenes.find((s) => s.id === selectedId) ?? project.scenes[0] ?? null;
  const missingCount = project.scenes.filter((s) => s.source.kind === 'none' || !s.source.url).length;

  return (
    <div className="studio-v2 animate-fadeUp pb-4">
      <StudioTopBar />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-white">AI Video Editor</h1>
            {project.demo && <span className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1 text-[10px] font-semibold text-amber-200">Projet de démonstration · sans média réel</span>}
          </div>
          <p className="mt-1 text-[11px] text-slate-500">Timeline, pistes, sauvegarde et rendu réel dans le navigateur. Aucun montage n’est présenté comme un appel fournisseur.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/app/studio" className="studio-icon-link"><ArrowLeft size={13} /> Video Studio</Link>
          <Button size="sm" variant="outline" icon={<FolderOpen size={13} />} onClick={() => void openLibrary()}>Bibliothèque</Button>
          <Button size="sm" variant="outline" icon={<Save size={13} />} loading={saving} onClick={() => void save()}>Enregistrer</Button>
          <Button size="sm" variant="ghost" icon={<Clapperboard size={13} />} onClick={backToStudio}>Retour au plan</Button>
        </div>
      </div>

      {savedAt && <p className="mt-2 flex items-center gap-1.5 text-[10px] text-emerald-300"><CheckCircle2 size={11} /> Enregistré à {new Date(savedAt).toLocaleTimeString('fr-FR')}</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
        <div className="space-y-3">
          <PreviewPlayer project={project} playhead={playhead} playing={playing}
            onTimeChange={setPlayhead} onEnded={onPreviewEnded} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={playing ? <Pause size={13} /> : <Play size={13} />} onClick={onTogglePlay}>
              {playing ? 'Pause' : 'Prévisualiser'}
            </Button>
            <Button size="sm" variant="outline" icon={<Scissors size={13} />} onClick={() => { setPlayhead(0); setPlaying(false); }}>Reprendre au début</Button>
            <span className="text-[10px] text-slate-500">{missingCount} plan(s) sans média</span>
          </div>

          <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
            <p className="text-xs font-semibold text-white">Sortie & formats sociaux</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <Select label="Format" value={project.aspect} onChange={(e) => onChange({ ...project, aspect: e.target.value as AspectPreset })}>
                {(Object.keys(ASPECT_PRESETS) as AspectPreset[]).map((key) => (
                  <option key={key} value={key}>{ASPECT_PRESETS[key].label}</option>
                ))}
              </Select>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2 text-[10px] text-slate-400">
                <p className="text-white">{ASPECT_PRESETS[project.aspect].width} × {ASPECT_PRESETS[project.aspect].height} px</p>
                <p className="mt-1">{ASPECT_PRESETS[project.aspect].platforms}</p>
              </div>
            </div>
            <div className="mt-3"><Toggle checked={project.subtitlesEnabled} onChange={(v) => onChange({ ...project, subtitlesEnabled: v })} label="Sous-titres incrustés" /></div>
            <p className="mt-3 text-[10px] leading-relaxed text-slate-600">Format réel du canvas, pas d’adaptateur serveur. Le rendu final conserve le ratio choisi.</p>
          </section>

          <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Sparkles size={13} className="text-cyan-300" /> Modifier la demande générale</p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Une seule instruction recalcule la structure narrative ; les clips réels restent attachés par position et les nouveaux plans restent explicitement vides.</p>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value.slice(0, 4000))} rows={3} className="studio-input mt-2 resize-none" />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" loading={planBusy} onClick={() => void applyBrief(false)()}>Recalculer le plan local</Button>
              <Button size="sm" variant="ghost" loading={planBusy} disabled={health?.groq !== true} onClick={() => void applyBrief(true)()}>Proposer avec Groq</Button>
            </div>
            {health?.groq === false && <p className="mt-2 text-[10px] text-amber-300">GROQ_API_KEY absent : aucune réponse IA simulée.</p>}
            {planMessage && <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{planMessage}</p>}
          </section>
        </div>

        <div className="space-y-3">
          <Timeline project={project} onChange={onChange} selectedId={selected?.id ?? ''} onSelect={setSelectedId}
            playhead={playhead} onSeek={(t) => { setPlayhead(t); setPlaying(false); }} playing={playing}
            onTogglePlay={onTogglePlay} onImport={(f, id) => void onImport(f, id)} onImportAudio={(f) => void onImportAudio(f)} />

          <div className="grid gap-3 xl:grid-cols-2">
            <AssistPanel project={project} onChange={onChange} disabled={rendering} />
            <section className="rounded-2xl border border-cyan-400/20 bg-[#080d14] p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Film size={13} className="text-cyan-300" /> Rendu final</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Canvas 2D + Web Audio + MediaRecorder : fichier vidéo réel, pas une suite d’images statiques.</p>
                </div>
                <span className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400">{mime ? mime.split(';')[0] : 'Non supporté'}</span>
              </div>

              {issues.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-200">
                  <AlertCircle size={11} className="mr-1 inline" /> {issues.join(' ')}
                </div>
              )}
              {!mime && <div className="mt-3"><Banner tone="danger" title="Encodage indisponible">Ce navigateur ne prend pas en charge MediaRecorder. Aucun export ne sera simulé.</Banner></div>}
              {renderError && <div className="mt-3"><Banner tone="danger" title="Rendu non terminé">{renderError}</Banner></div>}

              {rendering && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-slate-400"><span>{renderLabel}</span><span>{Math.round(renderProgress * 100)} %</span></div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.08]"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300 transition-all" style={{ width: `${Math.round(renderProgress * 100)}%` }} /></div>
                  <Button size="sm" variant="ghost" className="mt-2" icon={<X size={12} />} onClick={() => abortRef.current?.abort()}>Interrompre</Button>
                </div>
              )}

              {renderResult && (
                <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200"><CheckCircle2 size={12} /> Fichier prêt · {renderResult.width}×{renderResult.height} · {renderResult.durationSeconds.toFixed(1)} s</p>
                  <p className="mt-1 text-[10px] text-slate-400">{(renderResult.blob.size / 1024 / 1024).toFixed(2)} Mo · {renderResult.mimeType} · audio mixé : {renderResult.audioMixed ? 'oui' : 'non'}</p>
                  <Button size="sm" className="mt-2" icon={<Download size={13} />}
                    onClick={() => downloadBlob(renderResult.blob, exportFilename(project, renderResult.mimeType))}>
                    Télécharger la vidéo
                  </Button>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" loading={rendering} disabled={issues.length > 0 || !mime} icon={<LoaderCircle size={13} />} onClick={() => void render()}>Lancer le rendu</Button>
                <Button size="sm" variant="outline" icon={<RefreshCw size={13} />} onClick={() => void (async () => { await save(); await render(); })()}>Enregistrer et reprendre</Button>
              </div>
              <details className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3 text-[10px] text-slate-400">
                <summary className="cursor-pointer font-medium text-slate-300">Limitations techniques explicites</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
                  {RENDER_LIMITATIONS.map((l) => <li key={l}>{l}</li>)}
                </ul>
                <p className="mt-2 flex items-start gap-1.5"><Info size={10} className="mt-0.5 shrink-0" /> Aucune file de rendu serveur, aucun transcodage MP4 garanti, aucun crédit UGC consommé par le montage.</p>
              </details>
            </section>
          </div>
        </div>
      </div>

      <Modal open={libraryOpen} onClose={() => setLibraryOpen(false)} title="Créations vidéo Reelora" size="lg"
        description="Seules les créations réellement stockées dans votre espace privé peuvent être attachées à un plan.">
        {libraryBusy ? <LoadingState label="Lecture de la bibliothèque…" /> : assets.length === 0 ? (
          <div className="rounded-xl border border-white/[0.08] bg-black/20 p-5 text-center text-xs text-slate-400">
            <Upload size={20} className="mx-auto mb-2 text-slate-600" />
            Aucune vidéo générée disponible. Lancez une génération MuAPI réelle ou importez un clip local.
          </div>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {assets.map((a) => (
              <button key={a.id} type="button" onClick={() => void attachAsset(a)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-left hover:border-cyan-400/40">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-white">{a.storage_path.split('/').pop()}</span>
                  <span className="mt-1 block text-[10px] text-slate-500">{new Date(a.created_at).toLocaleString('fr-FR')} · {a.mime_type ?? 'vidéo'}</span>
                </span>
                <span className="shrink-0 text-[10px] text-cyan-300">Attacher au plan {selected ? project.scenes.findIndex((s) => s.id === selected.id) + 1 : 1}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
