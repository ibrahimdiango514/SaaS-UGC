import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertCircle, ArrowLeft, CheckCircle2, Clapperboard, Download, Film, FolderOpen,
  Info, LoaderCircle, Mic, Pause, Play, RefreshCw, Save, Scissors, Sparkles,
  Subtitles, Upload, Wand2, X,
} from 'lucide-react';
import { Banner, Button, ErrorState, LoadingState, Modal, Select, cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  generateScript, healthCheck, listAssets, listJobs, listProjects, signedStorageUrl,
} from '../lib/api';
import { asAppError } from '../lib/errors';
import type { GeneratedAsset, GenerationJob, Project } from '../lib/types';
import { StudioTopBar } from './components/StudioTopBar';
import {
  buildLocalPlan, mapAiScriptToPlan, planToEditorProject, replanEditorScenes,
  validateProductionPlan, type ProductionPlan,
} from './plan';
import { AssistPanel } from './editor/components/AssistPanel';
import { PreviewPlayer, type SceneMediaMeta } from './editor/components/PreviewPlayer';
import { SubtitlesVoiceoverPanel } from './editor/components/SubtitlesVoiceoverPanel';
import { Timeline } from './editor/components/Timeline';
import {
  createEditorProject, loadLocalDraft, loadProjectLocalDraft, persistLocalMedia,
  saveEditorProject, saveLocalDraft,
} from './editor/persistence';
import {
  assembleFromProjectMedia, hydrateEditorFromProject, signMediaItems,
  type ProjectMediaItem,
} from './editor/projectMedia';
import {
  RENDER_LIMITATIONS, buildSrt, downloadBlob, exportCapabilities, exportFilename,
  renderIssues, renderProject, type RenderResult,
} from './editor/render';
import {
  ASPECT_PRESETS, emptyAudio, patchScene, replaceSceneSource, splitScene,
  totalDuration, type AspectPreset, type EditorProject,
} from './editor/types';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const DEMO_BRIEF = 'Pub UGC de 20 secondes pour un sérum éclat : accroche problème, démonstration texture, bénéfice visible, appel à l’achat.';

type EditorTab = 'assist' | 'voice' | 'media' | 'export';
type MobileSection = 'timeline' | EditorTab;

function demoProject(): EditorProject {
  const plan = buildLocalPlan({ prompt: DEMO_BRIEF, ratio: '9:16', subtitles: true });
  return {
    ...planToEditorProject(plan, {
      quality: 'standard', mode: 'idea', model: null, subtitles: true, demo: true,
    }),
    voiceover: emptyAudio(1),
    audioDucking: true,
    ugcPreset: 'ugc-balanced',
    targetDuration: 20,
  };
}

function readAudioDuration(url: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    try {
      const el = document.createElement('audio');
      el.preload = 'metadata';
      const done = (val?: number) => {
        el.removeAttribute('src');
        resolve(val);
      };
      const timer = setTimeout(() => done(undefined), 3000);
      el.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        done(Number.isFinite(el.duration) && el.duration > 0 ? Number(el.duration.toFixed(2)) : undefined);
      }, { once: true });
      el.addEventListener('error', () => { clearTimeout(timer); done(undefined); }, { once: true });
      el.src = url;
    } catch {
      resolve(undefined);
    }
  });
}

function readVideoMeta(url: string): Promise<SceneMediaMeta | null> {
  return new Promise((resolve) => {
    try {
      const el = document.createElement('video');
      el.preload = 'metadata';
      const done = (val: SceneMediaMeta | null) => {
        el.removeAttribute('src');
        resolve(val);
      };
      const timer = setTimeout(() => done(null), 4000);
      el.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        if (Number.isFinite(el.duration) && el.duration > 0) {
          done({
            sourceDuration: Number(el.duration.toFixed(2)),
            mediaWidth: el.videoWidth || 0,
            mediaHeight: el.videoHeight || 0,
          });
        } else done(null);
      }, { once: true });
      el.addEventListener('error', () => { clearTimeout(timer); done(null); }, { once: true });
      el.src = url;
    } catch {
      resolve(null);
    }
  });
}

export default function VideoEditor() {
  const toast = useToast();
  const navigate = useNavigate();
  const { workspaceId } = useAuth();
  const [search] = useSearchParams();

  const [project, setProject] = useState<EditorProject | null>(null);
  const [projectsList, setProjectsList] = useState<Project[]>([]);
  const [mediaItems, setMediaItems] = useState<ProjectMediaItem[]>([]);
  const [recoverableDraft, setRecoverableDraft] = useState<EditorProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState<0.75 | 1 | 1.25>(1);
  const [previewMuted, setPreviewMuted] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('assist');
  const [mobileSection, setMobileSection] = useState<MobileSection>('timeline');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [brief, setBrief] = useState('');
  const [planMessage, setPlanMessage] = useState('');
  const [planBusy, setPlanBusy] = useState(false);
  const [health, setHealth] = useState<Record<string, boolean> | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [dirty, setDirty] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderLabel, setRenderLabel] = useState('');
  const [renderError, setRenderError] = useState('');
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const undoStack = useRef<EditorProject[]>([]);
  const redoStack = useRef<EditorProject[]>([]);
  const [, setHistoryTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setRecoverableDraft(null);
    undoStack.current = [];
    redoStack.current = [];
    try {
      let next: EditorProject | null = null;
      let loadedMedia: ProjectMediaItem[] = [];
      const savedId = search.get('projet');
      const wantsDraft = search.get('draft') === '1';

      if (savedId) {
        const hydrated = await hydrateEditorFromProject(savedId);
        next = hydrated.editor;
        loadedMedia = hydrated.mediaItems;
        const localProjDraft = loadProjectLocalDraft(savedId);
        if (localProjDraft && hydrated.fromSavedEditor && localProjDraft.updatedAt > hydrated.editor.updatedAt) {
          setRecoverableDraft(localProjDraft);
        }
      } else if (wantsDraft) {
        next = loadLocalDraft();
      }

      if (!next) next = demoProject();

      if (loadedMedia.length === 0) {
        const [allAssets, allJobs] = await Promise.all([
          listAssets(100).catch(() => [] as GeneratedAsset[]),
          listJobs(100).catch(() => [] as GenerationJob[]),
        ]);
        loadedMedia = await signMediaItems(allAssets, allJobs, next.projectId);
      }

      const jobId = search.get('job');
      if (jobId) {
        const match = loadedMedia.find((m) => m.jobId === jobId && m.mediaType === 'video' && m.url);
        if (match?.url) {
          const first = next.scenes[0]?.id;
          if (first) {
            next = replaceSceneSource(next, first, {
              kind: 'job',
              name: match.name || 'Vidéo générée',
              url: match.url,
              storagePath: match.storagePath,
              assetId: match.assetId,
              jobId,
            });
          }
        } else {
          const all = await listAssets().catch(() => [] as GeneratedAsset[]);
          const asset = all.find((a) => a.generation_job_id === jobId && a.storage_path && a.asset_type?.includes('video'));
          if (asset?.storage_path) {
            try {
              const url = await signedStorageUrl(asset.storage_path, 3600);
              const first = next.scenes[0]?.id;
              if (first) {
                next = replaceSceneSource(next, first, {
                  kind: 'job', name: 'Vidéo générée', url, storagePath: asset.storage_path, assetId: asset.id, jobId,
                });
              }
            } catch { /* media remains explicitly missing */ }
          }
        }
      }

      const projects = await listProjects().catch(() => [] as Project[]);
      setProjectsList(projects);
      setMediaItems(loadedMedia);
      setProject(next);
      setBrief(next.prompt);
      setSelectedId(next.scenes[0]?.id ?? '');
      setPlayhead(0);
      setPlaying(false);
      setDirty(false);
      try { setHealth((await healthCheck()).configured); } catch { setHealth(null); }
    } catch (err) {
      setLoadError(asAppError(err).message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { void load(); }, [load]);

  const commitChange = useCallback((next: EditorProject, recordUndo = true) => {
    setProject((prev) => {
      if (prev && recordUndo) {
        undoStack.current = [...undoStack.current.slice(-39), prev];
        redoStack.current = [];
        setHistoryTick((t) => t + 1);
      }
      const updated: EditorProject = { ...next, updatedAt: new Date().toISOString() };
      saveLocalDraft(updated);
      return updated;
    });
    setDirty(true);
    setRenderResult(null);
    setRenderError('');
  }, []);

  const onUndo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (!previous) return;
    setProject((current) => {
      if (current) redoStack.current.push(current);
      saveLocalDraft(previous);
      return previous;
    });
    setDirty(true);
    setHistoryTick((t) => t + 1);
  }, []);

  const onRedo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    setProject((current) => {
      if (current) undoStack.current.push(current);
      saveLocalDraft(next);
      return next;
    });
    setDirty(true);
    setHistoryTick((t) => t + 1);
  }, []);

  // Warn before accidental tab close when edits haven't been persisted to Supabase yet.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Keyboard shortcuts when focus is outside inputs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (!project) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
      } else if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        let cursor = 0;
        for (const s of project.scenes) {
          if (playhead >= cursor && playhead <= cursor + s.duration && s.duration >= 1) {
            e.preventDefault();
            commitChange(splitScene(project, s.id, playhead - cursor));
            break;
          }
          cursor += s.duration;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, playhead, commitChange, onUndo, onRedo]);

  const total = useMemo(() => project ? totalDuration(project) : 0, [project]);
  const issues = useMemo(() => project ? renderIssues(project) : [], [project]);
  const caps = useMemo(() => exportCapabilities(), []);

  const onTogglePlay = useCallback(() => {
    if (!project) return;
    if (project.scenes.length === 0) {
      toast.warning('Ajoutez au moins un plan avant la lecture.');
      return;
    }
    if (playhead >= total - 0.05) setPlayhead(0);
    setPlaying((v) => !v);
  }, [project, playhead, total, toast]);

  const onPreviewEnded = useCallback(() => {
    setPlaying(false);
  }, []);

  const onMediaMetadata = useCallback((sceneId: string, meta: SceneMediaMeta) => {
    setProject((current) => {
      if (!current) return current;
      const sc = current.scenes.find((s) => s.id === sceneId);
      if (!sc) return current;
      if (
        sc.source.sourceDuration === meta.sourceDuration
        && sc.source.mediaWidth === meta.mediaWidth
        && sc.source.mediaHeight === meta.mediaHeight
      ) return current;
      const updated = patchScene(current, sceneId, {
        source: {
          ...sc.source,
          sourceDuration: meta.sourceDuration,
          mediaWidth: meta.mediaWidth,
          mediaHeight: meta.mediaHeight,
        },
      });
      saveLocalDraft(updated);
      return updated;
    });
  }, []);

  const onImport = async (file: File, sceneId: string) => {
    if (!project) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('Fichier trop volumineux (50 Mo maximum).');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const meta = await readVideoMeta(objectUrl);
    const initialSource = {
      kind: 'local' as const,
      name: file.name,
      url: objectUrl,
      mimeType: file.type,
      uploadPending: Boolean(workspaceId),
      ...(meta ?? {}),
    };
    const nextProject = replaceSceneSource(
      meta && meta.sourceDuration > 0 && meta.sourceDuration < (project.scenes.find((s) => s.id === sceneId)?.duration ?? 3)
        ? patchScene(project, sceneId, { duration: meta.sourceDuration })
        : project,
      sceneId,
      initialSource,
    );
    commitChange(nextProject);
    setMediaItems((prev) => [{
      id: `local-${Date.now()}-${file.name}`,
      origin: 'local-upload',
      mediaType: 'video',
      name: file.name,
      url: objectUrl,
      mimeType: file.type,
      fileSizeBytes: file.size,
      sourceDuration: meta?.sourceDuration,
      width: meta?.mediaWidth,
      height: meta?.mediaHeight,
    }, ...prev]);

    if (!workspaceId) {
      toast.warning('Clip disponible pour cette session uniquement : espace de travail indisponible pour la sauvegarde.');
      return;
    }
    try {
      const storagePath = await persistLocalMedia(workspaceId, file);
      setProject((current) => {
        if (!current) return current;
        const sc = current.scenes.find((s) => s.id === sceneId);
        if (!sc) return current;
        const synced = replaceSceneSource(current, sceneId, {
          ...sc.source,
          kind: 'local',
          name: file.name,
          url: objectUrl,
          storagePath,
          uploadPending: false,
          uploadError: undefined,
        });
        saveLocalDraft(synced);
        return synced;
      });
      toast.success('Clip importé dans votre espace de stockage privé.');
    } catch (err) {
      const msg = asAppError(err).message;
      setProject((current) => {
        if (!current) return current;
        const sc = current.scenes.find((s) => s.id === sceneId);
        if (!sc) return current;
        return replaceSceneSource(current, sceneId, { ...sc.source, uploadPending: false, uploadError: msg });
      });
      toast.warning(`Sauvegarde du clip impossible : ${msg}`);
    }
  };

  const importAudioTrack = async (file: File, target: 'music' | 'voiceover') => {
    if (!project) return;
    if (!file.type.startsWith('audio/') && !file.type.includes('webm')) {
      toast.error('Choisissez un fichier audio valide.');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('Fichier trop volumineux (50 Mo maximum).');
      return;
    }
    const url = URL.createObjectURL(file);
    const sourceDuration = await readAudioDuration(url);
    const baseTrack = {
      kind: 'local' as const,
      name: file.name,
      url,
      volume: target === 'voiceover' ? 1 : (project.audio.volume || 0.8),
      startAt: 0,
      trimStart: 0,
      muted: false,
      ...(sourceDuration ? { sourceDuration } : {}),
    };
    commitChange(target === 'voiceover'
      ? { ...project, voiceover: baseTrack, audioDucking: project.audioDucking ?? true }
      : { ...project, audio: baseTrack });

    if (workspaceId) {
      try {
        const storagePath = await persistLocalMedia(workspaceId, file);
        setProject((current) => {
          if (!current) return current;
          const updated = target === 'voiceover'
            ? { ...current, voiceover: { ...(current.voiceover ?? baseTrack), storagePath } }
            : { ...current, audio: { ...current.audio, storagePath } };
          saveLocalDraft(updated);
          return updated;
        });
        toast.success(target === 'voiceover' ? 'Voix off enregistrée dans le stockage privé.' : 'Musique importée.');
      } catch (err) {
        toast.warning(`Audio disponible pour cette session uniquement : ${asAppError(err).message}`);
      }
    }
  };

  const save = useCallback(async (): Promise<EditorProject | null> => {
    if (!project) return null;
    setSaving(true);
    try {
      let next: EditorProject;
      const toPersist: EditorProject = { ...project, demo: project.projectId ? undefined : project.demo };
      if (project.projectId) {
        next = await saveEditorProject(project.projectId, toPersist);
      } else {
        const id = await createEditorProject({ ...toPersist, demo: undefined });
        next = await saveEditorProject(id, { ...toPersist, projectId: id, demo: undefined });
      }
      setProject(next);
      saveLocalDraft(next);
      setRecoverableDraft(null);
      setDirty(false);
      setSavedAt(new Date().toISOString());
      toast.success('Montage enregistré sans perte dans le projet Reelora.');
      return next;
    } catch (err) {
      toast.error(asAppError(err).message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [project, toast]);

  const render = useCallback(async () => {
    if (!project) return;
    const problems = renderIssues(project);
    if (problems.length) {
      setRenderError(problems.join(' '));
      toast.warning(problems[0]);
      return;
    }
    if (!caps.supported || !caps.mimeType) {
      setRenderError(caps.reasons.join(' ') || 'Rendu vidéo non pris en charge par ce navigateur.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRendering(true);
    setRenderError('');
    setRenderResult(null);
    setRenderProgress(0);
    setRenderLabel('Préparation des médias…');
    try {
      const result = await renderProject(project, {
        fps: 30,
        signal: controller.signal,
        onProgress: (ratio, label) => { setRenderProgress(ratio); setRenderLabel(label); },
      });
      setRenderResult(result);
      setRenderProgress(1);
      setRenderLabel('Rendu terminé');
      toast.success('Rendu navigateur terminé : votre vidéo réelle est prête.');
    } catch (err) {
      if (controller.signal.aborted) {
        setRenderError('Rendu interrompu. Le montage est conservé : reprenez quand vous voulez.');
      } else {
        setRenderError(asAppError(err).message);
      }
    } finally {
      setRendering(false);
      abortRef.current = null;
    }
  }, [project, caps, toast]);

  const refreshMediaBin = async () => {
    setLibraryOpen(true);
    setLibraryBusy(true);
    try {
      const [allAssets, allJobs] = await Promise.all([
        listAssets(100),
        listJobs(100).catch(() => [] as GenerationJob[]),
      ]);
      const signed = await signMediaItems(allAssets, allJobs, project?.projectId ?? null);
      setMediaItems((prev) => {
        const localOnly = prev.filter((m) => m.origin === 'local-upload');
        return [...localOnly, ...signed];
      });
    } catch (err) {
      toast.error(asAppError(err).message);
    } finally {
      setLibraryBusy(false);
    }
  };

  const attachMediaItemToScene = (item: ProjectMediaItem, targetSceneId?: string) => {
    if (!project) return;
    if (item.mediaType === 'audio') {
      if (!item.url) { toast.warning('URL signée indisponible pour ce média.'); return; }
      commitChange({
        ...project,
        voiceover: {
          kind: item.assetId ? 'asset' : 'local',
          name: item.name,
          url: item.url,
          storagePath: item.storagePath,
          volume: 1,
          startAt: 0,
          trimStart: 0,
        },
      });
      setLibraryOpen(false);
      toast.success('Audio attaché à la piste voix off.');
      return;
    }
    const targetId = targetSceneId || selectedId || project.scenes[0]?.id;
    if (!targetId || !item.url) {
      toast.warning('Sélectionnez un plan cible.');
      return;
    }
    commitChange(replaceSceneSource(project, targetId, {
      kind: item.assetId ? 'asset' : 'local',
      name: item.name,
      url: item.url,
      storagePath: item.storagePath,
      assetId: item.assetId,
      jobId: item.jobId ?? undefined,
      sourceDuration: item.sourceDuration,
      mediaWidth: item.width,
      mediaHeight: item.height,
    }));
    setLibraryOpen(false);
    toast.success('Média réel attaché au plan sélectionné.');
  };

  const onAutoAssembleProjectMedia = () => {
    if (!project) return;
    const videos = mediaItems.filter((m) => m.mediaType === 'video' && Boolean(m.url));
    if (videos.length === 0) {
      toast.warning('Aucun média vidéo disponible dans le projet pour le moment.');
      return;
    }
    commitChange(assembleFromProjectMedia(project, mediaItems));
    toast.success(`Montage pré-assemblé à partir de ${videos.length} média(x) réel(s) du projet.`);
  };

  const proposeGroqPlan = async (): Promise<ProductionPlan | null> => {
    if (!project || health?.groq !== true) return null;
    const local = buildLocalPlan({
      prompt: brief || project.prompt || project.title,
      ratio: project.aspect,
      subtitles: project.subtitlesEnabled,
    });
    const script = await generateScript({
      project_id: project.projectId,
      product: (project.title || brief).slice(0, 120),
      brief: (brief || project.prompt).slice(0, 800),
      duration: Math.round(total || 20),
      language: 'fr',
    });
    const mapped = mapAiScriptToPlan(script, local);
    if (!mapped.ok) {
      throw new Error(`Réponse Groq rejetée par la validation structurée : ${mapped.errors.join(' ')}`);
    }
    return mapped.plan;
  };

  const applyBrief = (useAi: boolean) => async () => {
    if (!project) return;
    if (brief.trim().length < 20) {
      toast.warning('Décrivez la demande générale en au moins 20 caractères.');
      return;
    }
    setPlanBusy(true);
    setPlanMessage('');
    try {
      const local = buildLocalPlan({
        prompt: brief, ratio: project.aspect, subtitles: project.subtitlesEnabled,
      });
      if (!useAi) {
        const validated = validateProductionPlan(local);
        if (!validated.ok) { setPlanMessage(`Plan rejeté : ${validated.errors.join(' ')}`); return; }
        commitChange(replanEditorScenes(project, validated.plan));
        setPlanMessage('Plan local validé : les scènes ont été recalculées, les médias réels conservés par position.');
        toast.success('Demande générale appliquée au montage.');
        return;
      }
      if (health?.groq !== true) {
        setPlanMessage('Assistance IA indisponible : GROQ_API_KEY absent côté serveur. Aucune réponse n’est simulée.');
        return;
      }
      const aiPlan = await proposeGroqPlan();
      if (aiPlan) {
        commitChange(replanEditorScenes(project, aiPlan));
        setPlanMessage('Plan Groq validé puis appliqué au montage. Relisez chaque plan et ses médias.');
        toast.success('Plan IA validé et appliqué.');
      }
    } catch (err) {
      setPlanMessage(asAppError(err).message);
      toast.error(asAppError(err).message);
    } finally {
      setPlanBusy(false);
    }
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
  const projectVideosCount = mediaItems.filter((m) => m.mediaType === 'video' && Boolean(m.url)).length;
  const srtReady = buildSrt(project).trim().length > 0;

  return (
    <div className="studio-v2 animate-fadeUp pb-6">
      <StudioTopBar />

      {/* Top editor header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-white">AI Video Editor</h1>
            {project.demo && (
              <span className="rounded-lg border border-amber-400/25 bg-amber-400/[0.07] px-2 py-1 text-[10px] font-semibold text-amber-200">
                Projet de démonstration · sans média réel
              </span>
            )}
            {dirty && (
              <span className="rounded-lg border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 text-[10px] font-medium text-cyan-200">
                Modifications locales non enregistrées
              </span>
            )}
            {!dirty && savedAt && (
              <span className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/25 bg-emerald-400/10 px-2 py-1 text-[10px] text-emerald-200">
                <CheckCircle2 size={11} /> Enregistré à {new Date(savedAt).toLocaleTimeString('fr-FR')}
              </span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-slate-400">
            Montage multi-pistes, assistant UGC local, sous-titres & voix off, sauvegarde sans perte et rendu navigateur réel.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {projectsList.length > 0 && (
            <Select
              aria-label="Projet cible de sauvegarde"
              value={project.projectId ?? ''}
              onChange={(e) => {
                const nextId = e.target.value;
                if (nextId) navigate(`/app/studio/montage?projet=${nextId}`);
              }}
              className="w-auto max-w-[190px] text-xs"
            >
              <option value="">Nouveau projet lors de l’enregistrement…</option>
              {projectsList.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </Select>
          )}
          <Link to="/app/studio" className="studio-icon-link"><ArrowLeft size={13} /> Studio</Link>
          <Button size="sm" variant="outline" icon={<FolderOpen size={13} />} onClick={() => void refreshMediaBin()}>
            Médias ({projectVideosCount})
          </Button>
          <Button size="sm" variant="outline" icon={<Save size={13} />} loading={saving} onClick={() => void save()}>
            Enregistrer
          </Button>
          <Button size="sm" variant="ghost" icon={<Clapperboard size={13} />} onClick={backToStudio}>
            Plan Studio
          </Button>
        </div>
      </div>

      {recoverableDraft && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.07] px-3 py-2 text-xs text-cyan-100">
          <span>Un brouillon local plus récent ({new Date(recoverableDraft.updatedAt).toLocaleTimeString('fr-FR')}) existe pour ce projet.</span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { setProject(recoverableDraft); setBrief(recoverableDraft.prompt); setRecoverableDraft(null); setDirty(true); }}>
              Reprendre ce brouillon
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRecoverableDraft(null)}>Ignorer</Button>
          </div>
        </div>
      )}

      {/* Mobile section navigation (390px friendly) */}
      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1 lg:hidden" role="tablist" aria-label="Vues mobile de l’éditeur">
        {([
          { id: 'timeline', label: 'Timeline', icon: Scissors },
          { id: 'assist', label: 'Assistant', icon: Sparkles },
          { id: 'voice', label: 'Voix & Titres', icon: Mic },
          { id: 'media', label: `Médias (${projectVideosCount})`, icon: FolderOpen },
          { id: 'export', label: 'Export', icon: Film },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mobileSection === tab.id}
            onClick={() => setMobileSection(tab.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium',
              mobileSection === tab.id
                ? 'border-cyan-400/50 bg-cyan-400/15 text-white'
                : 'border-white/[0.08] bg-white/[0.02] text-slate-400',
            )}
          >
            <tab.icon size={13} /> {tab.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(310px,420px)_minmax(0,1fr)]">
        {/* Left column: Fluid Preview + Format + Brief */}
        <div className="space-y-3">
          <PreviewPlayer
            project={project}
            playhead={playhead}
            playing={playing}
            playbackRate={playbackRate}
            muted={previewMuted}
            onToggleMute={() => setPreviewMuted((m) => !m)}
            onTimeChange={setPlayhead}
            onEnded={onPreviewEnded}
            onMediaMetadata={onMediaMetadata}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={playing ? <Pause size={13} /> : <Play size={13} />} onClick={onTogglePlay}>
              {playing ? 'Pause' : 'Prévisualiser'}
            </Button>
            <Button size="sm" variant="outline" icon={<Scissors size={13} />} onClick={() => { setPlayhead(0); setPlaying(false); }}>
              Début
            </Button>
            <div className="flex rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-[10px]">
              {([0.75, 1, 1.25] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setPlaybackRate(r)}
                  className={cn('rounded-md px-2 py-1', playbackRate === r ? 'bg-cyan-400/20 text-cyan-200' : 'text-slate-400')}
                >
                  {r}×
                </button>
              ))}
            </div>
            <span className="ml-auto text-[10px] text-slate-400">
              {missingCount === 0 ? 'Tous les plans ont un média' : `${missingCount} plan(s) sans média`}
            </span>
          </div>

          {projectVideosCount > 0 && missingCount > 0 && (
            <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/[0.06] p-3 text-[11px] text-cyan-100">
              <p className="font-semibold">Médias réels disponibles ({projectVideosCount})</p>
              <p className="mt-0.5 text-[10px] text-slate-300">
                Pré-assemblez automatiquement vos médias du projet dans les plans vides.
              </p>
              <Button size="sm" variant="outline" className="mt-2" icon={<Wand2 size={12} />} onClick={onAutoAssembleProjectMedia}>
                Assembler depuis les médias du projet
              </Button>
            </div>
          )}

          {/* Output Format & Title */}
          <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
            <p className="text-xs font-semibold text-white">Projet & format de sortie</p>
            <label className="mt-2 block text-[10px] text-slate-400">Titre du montage
              <input
                value={project.title}
                onChange={(e) => commitChange({ ...project, title: e.target.value.slice(0, 120) })}
                className="studio-input mt-1"
              />
            </label>
            <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
              <Select label="Format" value={project.aspect} onChange={(e) => commitChange({ ...project, aspect: e.target.value as AspectPreset })}>
                {(Object.keys(ASPECT_PRESETS) as AspectPreset[]).map((key) => (
                  <option key={key} value={key}>{ASPECT_PRESETS[key].label}</option>
                ))}
              </Select>
              <div className="rounded-xl border border-white/[0.07] bg-black/20 px-3 py-2 text-[10px] text-slate-400">
                <p className="text-white">{ASPECT_PRESETS[project.aspect].width} × {ASPECT_PRESETS[project.aspect].height} px</p>
                <p className="mt-1">{ASPECT_PRESETS[project.aspect].platforms}</p>
              </div>
            </div>
          </section>

          {/* General Brief Replanner */}
          <section className="hidden rounded-2xl border border-white/[0.08] bg-[#080d14] p-4 lg:block">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
              <Sparkles size={13} className="text-cyan-300" /> Recalculer la structure narrative
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              Recalcule les scènes depuis votre brief tout en conservant vos médias réels par position.
            </p>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value.slice(0, 4000))} rows={3} className="studio-input mt-2 resize-none" />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" loading={planBusy} onClick={() => void applyBrief(false)()}>
                Recalculer le plan local
              </Button>
              <Button size="sm" variant="ghost" loading={planBusy} disabled={health?.groq !== true} onClick={() => void applyBrief(true)()}>
                Proposer avec Groq
              </Button>
            </div>
            {health?.groq === false && <p className="mt-2 text-[10px] text-amber-300">GROQ_API_KEY absent : aucune réponse IA simulée.</p>}
            {planMessage && <p className="mt-2 text-[11px] leading-relaxed text-slate-300">{planMessage}</p>}
          </section>
        </div>

        {/* Right column: Interactive Timeline + Tabbed Intelligent Modules */}
        <div className="space-y-3">
          <div className={cn(mobileSection !== 'timeline' && 'hidden lg:block')}>
            <Timeline
              project={project}
              onChange={(next) => commitChange(next)}
              selectedId={selected?.id ?? ''}
              onSelect={setSelectedId}
              playhead={playhead}
              onSeek={(t) => { setPlayhead(t); setPlaying(false); }}
              playing={playing}
              onTogglePlay={onTogglePlay}
              onImport={(f, id) => void onImport(f, id)}
              onImportAudio={(f) => void importAudioTrack(f, 'music')}
              onImportVoiceover={(f) => void importAudioTrack(f, 'voiceover')}
              onOpenLibrary={() => void refreshMediaBin()}
              onOpenVoiceTab={() => { setActiveTab('voice'); setMobileSection('voice'); }}
              onUndo={onUndo}
              onRedo={onRedo}
              canUndo={undoStack.current.length > 0}
              canRedo={redoStack.current.length > 0}
            />
          </div>

          {/* Desktop Workspace Tabs */}
          <div className="hidden flex-wrap gap-1.5 rounded-xl border border-white/[0.08] bg-[#080d14] p-1.5 lg:flex" role="tablist" aria-label="Modules de montage intelligent">
            {([
              { id: 'assist', label: 'Assistant intelligent', icon: Sparkles },
              { id: 'voice', label: 'Sous-titres & Voix off', icon: Subtitles },
              { id: 'media', label: `Médias du projet (${mediaItems.length})`, icon: FolderOpen },
              { id: 'export', label: 'Export & Rendu réel', icon: Film },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition',
                  activeTab === tab.id
                    ? 'bg-cyan-400/15 text-white ring-1 ring-inset ring-cyan-400/35'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-white',
                )}
              >
                <tab.icon size={13} className={activeTab === tab.id ? 'text-cyan-300' : ''} />
                {tab.label}
              </button>
            ))}
          </div>

          {/* Module 1: Intelligent Assistant */}
          <div className={cn(mobileSection === 'assist' ? 'block' : 'hidden', activeTab === 'assist' ? 'lg:block' : 'lg:hidden')}>
            <AssistPanel
              project={project}
              onChange={(next) => commitChange(next)}
              disabled={rendering}
              mediaItems={mediaItems}
              groqConfigured={health?.groq ?? null}
              onProposeAiPlan={proposeGroqPlan}
              onSelectScene={(id) => {
                setSelectedId(id);
                let cursor = 0;
                for (const s of project.scenes) {
                  if (s.id === id) { setPlayhead(cursor); break; }
                  cursor += s.duration;
                }
              }}
            />
          </div>

          {/* Module 2: Subtitles & Voiceover */}
          <div className={cn(mobileSection === 'voice' ? 'block' : 'hidden', activeTab === 'voice' ? 'lg:block' : 'lg:hidden')}>
            <SubtitlesVoiceoverPanel
              project={project}
              onChange={(next) => commitChange(next)}
              onImportVoiceover={(f) => void importAudioTrack(f, 'voiceover')}
              onImportAudio={(f) => void importAudioTrack(f, 'music')}
              disabled={rendering}
            />
          </div>

          {/* Module 3: Project Media Bin */}
          <div className={cn(mobileSection === 'media' ? 'block' : 'hidden', activeTab === 'media' ? 'lg:block' : 'lg:hidden')}>
            <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" aria-label="Médias du projet">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <FolderOpen size={13} className="text-cyan-300" /> Médiathèque du projet & bibliothèque
                  </p>
                  <p className="mt-1 text-[10px] text-slate-400">
                    Médias réellement stockés ou importés pour ce montage. Cliquez pour attacher au plan {selected ? `« ${selected.label} »` : '1'}.
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="outline" icon={<RefreshCw size={12} />} onClick={() => void refreshMediaBin()}>
                    Actualiser
                  </Button>
                  {projectVideosCount > 0 && (
                    <Button size="sm" icon={<Wand2 size={12} />} onClick={onAutoAssembleProjectMedia}>
                      Assembler auto
                    </Button>
                  )}
                </div>
              </div>

              {mediaItems.length === 0 ? (
                <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/25 p-5 text-center text-xs text-slate-400">
                  <Upload size={20} className="mx-auto mb-2 text-slate-600" />
                  Aucun média réel dans ce projet pour l’instant. Importez un clip dans un plan de la timeline ou générez une création depuis le Video Studio.
                </div>
              ) : (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {mediaItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={cn(
                            'rounded px-1.5 py-0.5 text-[9px] font-semibold',
                            item.origin === 'project-asset'
                              ? 'bg-emerald-400/15 text-emerald-200'
                              : item.origin === 'local-upload'
                                ? 'bg-cyan-400/15 text-cyan-200'
                                : 'bg-white/10 text-slate-300',
                          )}>
                            {item.origin === 'project-asset' ? 'Projet' : item.origin === 'local-upload' ? 'Import session' : 'Bibliothèque'}
                          </span>
                          <span className="truncate text-xs font-medium text-white">{item.name}</span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-500">
                          {item.mediaType === 'audio' ? 'Audio' : 'Vidéo'}
                          {item.sourceDuration ? ` · ${item.sourceDuration.toFixed(1)} s` : ''}
                          {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
                          {item.modelId ? ` · ${item.modelId}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!item.url}
                        onClick={() => attachMediaItemToScene(item, selected?.id)}
                      >
                        {item.mediaType === 'audio' ? 'Voix off' : 'Attacher'}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Module 4: Real Render & Export (strict capability check, never simulated) */}
          <div className={cn(mobileSection === 'export' ? 'block' : 'hidden', activeTab === 'export' ? 'lg:block' : 'lg:hidden')}>
            <section className="rounded-2xl border border-cyan-400/20 bg-[#080d14] p-4" aria-label="Export et rendu vidéo réel">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
                    <Film size={13} className="text-cyan-300" /> Export & rendu réel
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    Canvas 2D + Web Audio + MediaRecorder : le fichier vidéo n’est exporté que lorsque l’encodage navigateur réel est disponible et que chaque plan contient un média réel.
                  </p>
                </div>
                <span className={cn(
                  'rounded-lg border px-2 py-1 text-[10px]',
                  caps.supported ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/25 bg-rose-400/10 text-rose-200',
                )}>
                  {caps.supported && caps.mimeType ? caps.mimeType.split(';')[0] : 'Encodage indisponible'}
                </span>
              </div>

              {/* Technical capability diagnostics */}
              <div className="mt-3 grid gap-2 sm:grid-cols-3 text-[10px]">
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
                  <span className="text-slate-500">MediaRecorder</span>
                  <p className={caps.hasMediaRecorder ? 'text-emerald-300' : 'text-rose-300'}>
                    {caps.hasMediaRecorder ? 'Disponible' : 'Indisponible'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
                  <span className="text-slate-500">Capture Canvas</span>
                  <p className={caps.hasCaptureStream ? 'text-emerald-300' : 'text-rose-300'}>
                    {caps.hasCaptureStream ? 'Disponible' : 'Indisponible'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/[0.07] bg-black/25 px-2.5 py-2">
                  <span className="text-slate-500">Mixage Web Audio</span>
                  <p className={caps.hasAudioContext ? 'text-emerald-300' : 'text-amber-300'}>
                    {caps.hasAudioContext ? 'Disponible' : 'Vidéo seule'}
                  </p>
                </div>
              </div>

              {issues.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] leading-relaxed text-amber-200">
                  <AlertCircle size={11} className="mr-1 inline" /> {issues.join(' ')}
                </div>
              )}

              {!caps.supported && (
                <div className="mt-3">
                  <Banner tone="danger" title="Export vidéo indisponible dans cet environnement">
                    {caps.reasons.join(' ')} Aucun export factice ou simulé ne sera généré. Utilisez un navigateur prenant en charge MediaRecorder et canvas.captureStream (Chrome, Edge, Firefox récents).
                  </Banner>
                </div>
              )}

              {renderError && <div className="mt-3"><Banner tone="danger" title="Rendu non terminé">{renderError}</Banner></div>}

              {rendering && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span>{renderLabel}</span>
                    <span>{Math.round(renderProgress * 100)} %</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.08]">
                    <div className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-emerald-300 transition-all" style={{ width: `${Math.round(renderProgress * 100)}%` }} />
                  </div>
                  <Button size="sm" variant="ghost" className="mt-2" icon={<X size={12} />} onClick={() => abortRef.current?.abort()}>
                    Interrompre
                  </Button>
                </div>
              )}

              {renderResult && (
                <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200">
                    <CheckCircle2 size={12} /> Fichier prêt · {renderResult.width}×{renderResult.height} · {renderResult.durationSeconds.toFixed(1)} s
                  </p>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {(renderResult.blob.size / 1024 / 1024).toFixed(2)} Mo · {renderResult.mimeType} · audio mixé : {renderResult.audioMixed ? 'oui' : 'non'}
                  </p>
                  <Button
                    size="sm"
                    className="mt-2"
                    icon={<Download size={13} />}
                    onClick={() => downloadBlob(renderResult.blob, exportFilename(project, renderResult.mimeType))}
                  >
                    Télécharger la vidéo
                  </Button>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  loading={rendering}
                  disabled={issues.length > 0 || !caps.supported}
                  icon={<LoaderCircle size={13} />}
                  onClick={() => void render()}
                >
                  Lancer le rendu
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={issues.length > 0 || !caps.supported}
                  icon={<RefreshCw size={13} />}
                  onClick={() => void (async () => { await save(); await render(); })()}
                >
                  Enregistrer et exporter
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!srtReady}
                  icon={<Download size={13} />}
                  onClick={() => {
                    const srt = buildSrt(project);
                    if (!srt.trim()) return;
                    downloadBlob(new Blob([srt], { type: 'text/plain;charset=utf-8' }), 'sous-titres.srt');
                  }}
                >
                  Exporter sous-titres (.SRT)
                </Button>
              </div>

              <details className="mt-3 rounded-xl border border-white/[0.07] bg-black/20 p-3 text-[10px] text-slate-400">
                <summary className="cursor-pointer font-medium text-slate-300">Limitations techniques explicites</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4 leading-relaxed">
                  {RENDER_LIMITATIONS.map((l) => <li key={l}>{l}</li>)}
                </ul>
                <p className="mt-2 flex items-start gap-1.5">
                  <Info size={10} className="mt-0.5 shrink-0" />
                  Aucune file de rendu serveur, aucun transcodage MP4 garanti, aucun crédit UGC consommé par le montage.
                </p>
              </details>
            </section>
          </div>
        </div>
      </div>

      {/* Modal: Project Media & Library Picker */}
      <Modal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        title="Médias du projet & bibliothèque Reelora"
        size="lg"
        description="Seuls les médias réels stockés dans votre espace privé peuvent être attachés à un plan."
      >
        {libraryBusy ? <LoadingState label="Chargement des médias du projet…" /> : mediaItems.length === 0 ? (
          <div className="rounded-xl border border-white/[0.08] bg-black/20 p-5 text-center text-xs text-slate-400">
            <Upload size={20} className="mx-auto mb-2 text-slate-600" />
            Aucune vidéo générée ou média disponible. Lancez une génération MuAPI réelle ou importez un clip local dans un plan.
          </div>
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {mediaItems.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={!m.url}
                onClick={() => attachMediaItemToScene(m, selected?.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-left hover:border-cyan-400/40 disabled:opacity-45"
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-slate-300">
                      {m.origin === 'project-asset' ? 'Projet' : m.origin === 'local-upload' ? 'Session' : 'Bibliothèque'}
                    </span>
                    <span className="truncate text-xs font-medium text-white">{m.name}</span>
                  </span>
                  <span className="mt-1 block text-[10px] text-slate-500">
                    {m.createdAt ? new Date(m.createdAt).toLocaleString('fr-FR') : 'Session locale'} · {m.mimeType ?? m.mediaType}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] text-cyan-300">
                  {m.mediaType === 'audio'
                    ? 'Attacher en voix off'
                    : `Attacher au plan ${selected ? project.scenes.findIndex((s) => s.id === selected.id) + 1 : 1}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
