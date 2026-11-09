/**
 * Project media discovery, hydration and deterministic UGC assembly.
 *
 * Bridges real Reelora projects (`ugc_video_projects`), saved scripts/scenes
 * (`ugc_project_scripts`, `ugc_project_scenes`), and private generated/uploaded
 * assets (`ugc_generated_assets`) into the Video Editor without inventing media.
 */

import {
  getProject, listAssets, listJobs, listScenes, listScripts, signedStorageUrl,
} from '../../lib/api';
import type { GeneratedAsset, GenerationJob, Project, Scene, Script } from '../../lib/types';
import { buildLocalPlan, planToEditorProject } from '../plan';
import { loadEditorProject } from './persistence';
import {
  clampDuration, emptyAudio, sceneId, type AspectPreset, type EditorProject,
  type EditorScene, type SceneRole, type TransitionKind,
} from './types';

export interface ProjectMediaItem {
  id: string;
  origin: 'project-asset' | 'workspace-asset' | 'local-upload';
  mediaType: 'video' | 'audio';
  name: string;
  storagePath?: string;
  assetId?: string;
  jobId?: string | null;
  projectId?: string | null;
  url?: string;
  createdAt?: string;
  mimeType?: string | null;
  fileSizeBytes?: number | null;
  sourceDuration?: number;
  width?: number;
  height?: number;
  modelId?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isVideoAsset(asset: GeneratedAsset): boolean {
  return Boolean(asset.storage_path) && (
    (asset.asset_type ?? '').includes('video')
    || (asset.mime_type ?? '').startsWith('video/')
    || /\.(mp4|webm|mov|m4v)$/i.test(asset.storage_path)
  );
}

function isAudioAsset(asset: GeneratedAsset): boolean {
  return Boolean(asset.storage_path) && (
    (asset.asset_type ?? '').includes('audio')
    || (asset.mime_type ?? '').startsWith('audio/')
    || /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(asset.storage_path)
  );
}

function mapRole(sceneType: string | null | undefined): SceneRole {
  switch ((sceneType ?? '').toLowerCase()) {
    case 'hook': return 'hook';
    case 'product_demo':
    case 'ugc':
    case 'demo': return 'demo';
    case 'testimonial_style':
    case 'proof':
    case 'cutaway': return 'proof';
    case 'cta': return 'cta';
    default: return 'custom';
  }
}

const ROLE_TITLES: Record<SceneRole, string> = {
  hook: 'Accroche',
  demo: 'Démonstration',
  proof: 'Preuve / bénéfice',
  cta: 'Appel à l’action',
  custom: 'Plan',
};

function toAspect(raw: string | null | undefined): AspectPreset {
  if (raw === '1:1' || raw === '16:9' || raw === '9:16') return raw;
  return '9:16';
}

export async function signMediaItems(
  assets: GeneratedAsset[],
  jobs: GenerationJob[],
  currentProjectId: string | null,
): Promise<ProjectMediaItem[]> {
  const relevant = assets.filter((a) => isVideoAsset(a) || isAudioAsset(a));
  // Prioritize assets linked to the current project first, then workspace assets.
  const sorted = [...relevant].sort((a, b) => {
    const aOwn = currentProjectId && a.project_id === currentProjectId ? 0 : 1;
    const bOwn = currentProjectId && b.project_id === currentProjectId ? 0 : 1;
    if (aOwn !== bOwn) return aOwn - bOwn;
    return String(b.created_at).localeCompare(String(a.created_at));
  }).slice(0, 60);

  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const signed = new Map<string, string>();
  await Promise.all(sorted.map(async (asset) => {
    if (!asset.storage_path) return;
    try { signed.set(asset.storage_path, await signedStorageUrl(asset.storage_path, 3600)); }
    catch { /* unavailable media remains unattached */ }
  }));

  return sorted.map((asset) => {
    const job = asset.generation_job_id ? jobMap.get(asset.generation_job_id) : undefined;
    const meta = asRecord(asset.metadata);
    const payload = asRecord(job?.request_payload);
    const modelId = typeof meta.model_id === 'string'
      ? meta.model_id
      : typeof payload.model_id === 'string' ? payload.model_id : undefined;
    return {
      id: `asset-${asset.id}`,
      origin: currentProjectId && asset.project_id === currentProjectId ? 'project-asset' : 'workspace-asset',
      mediaType: isAudioAsset(asset) ? 'audio' : 'video',
      name: asset.storage_path.split('/').pop() || 'Média Reelora',
      storagePath: asset.storage_path,
      assetId: asset.id,
      jobId: asset.generation_job_id,
      projectId: asset.project_id,
      url: signed.get(asset.storage_path),
      createdAt: asset.created_at,
      mimeType: asset.mime_type,
      fileSizeBytes: asset.file_size_bytes,
      modelId,
    };
  });
}

export interface HydratedProjectResult {
  editor: EditorProject;
  projectRecord: Project | null;
  mediaItems: ProjectMediaItem[];
  fromSavedEditor: boolean;
}

/**
 * Load an existing saved editor state OR initialize a real editor project from
 * the Reelora project record, its scripts, storyboard scenes, and video assets.
 */
export async function hydrateEditorFromProject(projectId: string): Promise<HydratedProjectResult> {
  const [savedEditor, projectRecord, scripts, dbScenes, assets, jobs] = await Promise.all([
    loadEditorProject(projectId),
    getProject(projectId),
    listScripts(projectId).catch(() => [] as Script[]),
    listScenes(projectId).catch(() => [] as Scene[]),
    listAssets(200).catch(() => [] as GeneratedAsset[]),
    listJobs(200).catch(() => [] as GenerationJob[]),
  ]);

  const mediaItems = await signMediaItems(assets, jobs, projectId);
  if (savedEditor) {
    return {
      editor: savedEditor,
      projectRecord,
      mediaItems,
      fromSavedEditor: true,
    };
  }

  if (!projectRecord) {
    throw new Error('Projet introuvable ou inaccessible.');
  }

  const latestScript = scripts[0];
  const briefPrompt = (projectRecord.brief || projectRecord.campaign_objective || projectRecord.title || '').trim();
  const aspect = toAspect(projectRecord.aspect_ratio);
  const projectVideos = mediaItems.filter((m) => m.origin === 'project-asset' && m.mediaType === 'video' && Boolean(m.url));

  let editor: EditorProject;
  if (dbScenes.length > 0) {
    const mappedScenes: EditorScene[] = dbScenes.slice(0, 24).map((sc) => {
      const role = mapRole(sc.scene_type);
      const matchedAsset = sc.asset_id
        ? mediaItems.find((m) => m.assetId === sc.asset_id && m.url)
        : undefined;
      return {
        id: sceneId(),
        role,
        label: ROLE_TITLES[role],
        duration: clampDuration(sc.duration_seconds || 3),
        trimStart: 0,
        source: matchedAsset
          ? {
            kind: 'asset',
            name: matchedAsset.name,
            url: matchedAsset.url,
            storagePath: matchedAsset.storagePath,
            assetId: matchedAsset.assetId,
            jobId: matchedAsset.jobId ?? undefined,
          }
          : { kind: 'none', name: '' },
        visualPrompt: sc.visual_prompt ?? '',
        spokenText: sc.spoken_text ?? '',
        subtitle: sc.subtitle_text ?? sc.spoken_text ?? '',
        transition: 'cut',
      };
    });
    editor = {
      version: 1,
      projectId: projectRecord.id,
      title: projectRecord.title,
      prompt: briefPrompt,
      sector: 'general',
      quality: 'standard',
      mode: 'idea',
      modelId: '',
      aspect,
      subtitlesEnabled: true,
      planSource: 'deterministic',
      scenes: mappedScenes,
      audio: emptyAudio(0.8),
      voiceover: emptyAudio(1),
      audioDucking: true,
      ugcPreset: 'ugc-balanced',
      targetDuration: mappedScenes.reduce((acc, s) => acc + s.duration, 0) || 20,
      updatedAt: new Date().toISOString(),
    };
  } else {
    const plan = buildLocalPlan({
      prompt: briefPrompt || projectRecord.title,
      script: latestScript?.script_text ?? '',
      ratio: aspect,
      subtitles: true,
    });
    editor = {
      ...planToEditorProject(plan, {
        quality: 'standard',
        mode: 'idea',
        model: null,
        subtitles: true,
        projectId: projectRecord.id,
      }),
      title: projectRecord.title,
      voiceover: emptyAudio(1),
      audioDucking: true,
      ugcPreset: 'ugc-balanced',
      targetDuration: plan.totalDuration,
    };
    if (latestScript && editor.scenes.length > 0) {
      if (latestScript.hook) {
        editor.scenes[0] = {
          ...editor.scenes[0],
          spokenText: latestScript.hook,
          subtitle: latestScript.hook.slice(0, 110),
        };
      }
      const last = editor.scenes.length - 1;
      if (latestScript.call_to_action && last > 0) {
        editor.scenes[last] = {
          ...editor.scenes[last],
          spokenText: latestScript.call_to_action,
          subtitle: latestScript.call_to_action.slice(0, 110),
        };
      }
    }
  }

  // Attach unassigned project videos sequentially into empty scenes if available.
  if (projectVideos.length > 0) {
    let mediaIdx = 0;
    editor = {
      ...editor,
      scenes: editor.scenes.map((scene) => {
        if (scene.source.kind !== 'none' || mediaIdx >= projectVideos.length) return scene;
        const item = projectVideos[mediaIdx++];
        return {
          ...scene,
          source: {
            kind: 'asset',
            name: item.name,
            url: item.url,
            storagePath: item.storagePath,
            assetId: item.assetId,
            jobId: item.jobId ?? undefined,
          },
        };
      }),
    };
  }

  return {
    editor,
    projectRecord,
    mediaItems,
    fromSavedEditor: false,
  };
}

/**
 * Deterministic smart assembly from real project media items.
 * Never fabricates media; uses only `mediaItems` that actually have a playable URL.
 */
export function assembleFromProjectMedia(
  project: EditorProject,
  mediaItems: ProjectMediaItem[],
): EditorProject {
  const videos = mediaItems.filter((m) => m.mediaType === 'video' && Boolean(m.url));
  if (videos.length === 0) return project;

  // Ensure canonical UGC scene structure if scenes are empty.
  const baseScenes: EditorScene[] = project.scenes.length > 0
    ? project.scenes
    : [
      { id: sceneId(), role: 'hook', label: 'Accroche', duration: 2.5, trimStart: 0, source: { kind: 'none', name: '' }, visualPrompt: '', spokenText: '', subtitle: '', transition: 'cut' },
      { id: sceneId(), role: 'demo', label: 'Démonstration', duration: 6, trimStart: 0, source: { kind: 'none', name: '' }, visualPrompt: '', spokenText: '', subtitle: '', transition: 'dissolve' },
      { id: sceneId(), role: 'cta', label: 'Appel à l’action', duration: 3.5, trimStart: 0, source: { kind: 'none', name: '' }, visualPrompt: '', spokenText: '', subtitle: '', transition: 'fade' },
    ];

  // Canonical UGC ordering: hook -> demo -> proof -> custom -> cta
  const roleWeight: Record<SceneRole, number> = { hook: 0, demo: 1, proof: 2, custom: 3, cta: 4 };
  const ordered = [...baseScenes].sort((a, b) => roleWeight[a.role] - roleWeight[b.role]);

  const singleLongClip = videos.length === 1 && (videos[0].sourceDuration ?? 0) >= 6;
  let trimCursor = 0;

  const updated = ordered.map((scene, index) => {
    const clip = videos[index % videos.length];
    const hasExisting = scene.source.kind !== 'none' && Boolean(scene.source.url);
    const chosen = hasExisting ? scene.source : {
      kind: clip.assetId ? 'asset' as const : 'local' as const,
      name: clip.name,
      url: clip.url,
      storagePath: clip.storagePath,
      assetId: clip.assetId,
      jobId: clip.jobId ?? undefined,
      sourceDuration: clip.sourceDuration,
      mediaWidth: clip.width,
      mediaHeight: clip.height,
    };

    let duration = scene.duration;
    let trimStart = scene.trimStart;
    if (!hasExisting && singleLongClip && clip.sourceDuration) {
      const slice = clampDuration(Math.min(scene.duration, Math.max(1.5, clip.sourceDuration / ordered.length)));
      trimStart = Math.min(trimCursor, Math.max(0, clip.sourceDuration - 0.5));
      duration = clampDuration(Math.min(slice, Math.max(0.5, clip.sourceDuration - trimStart)));
      trimCursor += duration;
    } else if (!hasExisting && clip.sourceDuration && clip.sourceDuration < duration) {
      duration = clampDuration(clip.sourceDuration);
    }

    const nextTransition: TransitionKind = index === ordered.length - 1
      ? 'cut'
      : scene.role === 'hook'
        ? 'cut'
        : index === ordered.length - 2 ? 'fade' : 'dissolve';

    return {
      ...scene,
      source: chosen,
      duration,
      trimStart,
      transition: scene.transition === 'cut' ? nextTransition : scene.transition,
      transitionDuration: scene.transitionDuration ?? 0.4,
    };
  });

  return {
    ...project,
    demo: undefined,
    scenes: updated,
    updatedAt: new Date().toISOString(),
  };
}
