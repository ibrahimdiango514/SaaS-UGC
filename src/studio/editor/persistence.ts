/**
 * Editor persistence — reuses the EXISTING project table and RLS.
 *
 * The whole editing state is stored under a single namespaced key inside the
 * already-existing `ugc_video_projects.settings` JSONB column. No new table,
 * column, policy, view or RPC is created. Reads/writes go through the existing
 * `getProject` / `updateProject` / `createProject` API functions and therefore
 * inherit the existing `can_edit_workspace` RLS checks.
 *
 * Signed URLs and blob: URLs are session-only. Private Storage paths are
 * persisted; when a saved project is opened again, fresh signed URLs are
 * requested through the existing Supabase Storage API. A locally imported
 * clip without a Storage path is NOT persisted: it must be re-imported, and
 * the UI marks the scene as missing media rather than faking a source.
 */

import { createProject, getProject, signedStorageUrl, updateProject, uploadEditorMedia } from '../../lib/api';
import type { Json } from '../../lib/types';
import { EDITOR_SETTINGS_KEY, parseEditorProject, type AudioTrack, type EditorProject } from './types';

function settingsOf(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function durableAudio(track: AudioTrack | undefined): AudioTrack | undefined {
  if (!track) return undefined;
  return {
    ...track,
    url: undefined,
    ...(track.kind === 'local' && !track.storagePath
      ? { kind: 'none' as const, name: '' }
      : {}),
  };
}

/** Remove transient URLs and flags before any durable write. */
function durableCopy(editor: EditorProject): EditorProject {
  return {
    ...editor,
    scenes: editor.scenes.map((scene) => ({
      ...scene,
      source: {
        ...scene.source,
        // Signed/object URLs die with the session; private Storage paths persist.
        url: undefined,
        uploadPending: undefined,
        uploadError: undefined,
        ...(scene.source.kind === 'local' && !scene.source.storagePath
          ? { name: `${scene.source.name || 'Clip local'} · à réimporter`, kind: 'none' as const }
          : {}),
      },
    })),
    audio: durableAudio(editor.audio) ?? { kind: 'none', name: '', volume: 0.8 },
    ...(editor.voiceover ? { voiceover: durableAudio(editor.voiceover) } : {}),
  };
}

/** Re-sign the private paths that were persisted. Failures leave media missing explicitly. */
async function refreshSignedSources(editor: EditorProject, fallbackLive?: EditorProject): Promise<EditorProject> {
  const paths = [
    ...editor.scenes.map((s) => s.source.storagePath).filter((v): v is string => Boolean(v)),
    ...(editor.audio.storagePath ? [editor.audio.storagePath] : []),
    ...(editor.voiceover?.storagePath ? [editor.voiceover.storagePath] : []),
  ];
  const unique = [...new Set(paths)];
  const signed = new Map<string, string>();
  await Promise.all(unique.map(async (path) => {
    try { signed.set(path, await signedStorageUrl(path, 3600)); } catch { /* explicit missing media */ }
  }));
  const signAudio = (track: AudioTrack, live?: AudioTrack): AudioTrack => {
    if (track.storagePath && signed.has(track.storagePath)) {
      return { ...track, url: signed.get(track.storagePath) };
    }
    if (live?.kind === 'local' && !live.storagePath && live.url?.startsWith('blob:')) {
      return live;
    }
    return { ...track, url: undefined };
  };

  return {
    ...editor,
    scenes: editor.scenes.map((s, i) => {
      const liveScene = fallbackLive?.scenes[i];
      if (s.source.storagePath && signed.has(s.source.storagePath)) {
        return { ...s, source: { ...s.source, url: signed.get(s.source.storagePath) } };
      }
      if (liveScene && liveScene.source.kind === 'local' && !liveScene.source.storagePath && liveScene.source.url?.startsWith('blob:')) {
        // Keep session blob URL playable in the active tab until page reload.
        return { ...s, source: liveScene.source };
      }
      return { ...s, source: { ...s.source, url: undefined } };
    }),
    audio: signAudio(editor.audio, fallbackLive?.audio),
    ...(editor.voiceover ? { voiceover: signAudio(editor.voiceover, fallbackLive?.voiceover) } : {}),
  };
}

export async function loadEditorProject(projectId: string): Promise<EditorProject | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const parsed = parseEditorProject(settingsOf(project.settings)[EDITOR_SETTINGS_KEY]);
  return parsed ? refreshSignedSources(parsed) : null;
}

/** Merge, never overwrite unrelated project settings. */
export async function saveEditorProject(projectId: string, editor: EditorProject): Promise<EditorProject> {
  const project = await getProject(projectId);
  if (!project) throw new Error('Projet introuvable : créez un projet avant d’enregistrer le montage.');
  const durable = durableCopy(editor);
  const next = { ...settingsOf(project.settings), [EDITOR_SETTINGS_KEY]: durable as unknown as Json };
  await updateProject(projectId, { settings: next });
  return refreshSignedSources(durable, editor);
}

export async function createEditorProject(editor: EditorProject): Promise<string> {
  const durable = durableCopy(editor);
  return createProject({
    title: durable.title || 'Montage Reelora',
    brief: durable.prompt.slice(0, 1000),
    platform: 'TikTok',
    language: 'fr',
    aspect_ratio: durable.aspect,
    campaign_objective: durable.prompt.slice(0, 300),
    settings: { [EDITOR_SETTINGS_KEY]: durable as unknown as Json },
  });
}

/**
 * Persist a locally imported video/audio to the SAME private Storage bucket so
 * that a subsequent save/load can restore it. Requires a workspace context;
 * failure is reported by the caller and the in-memory session URL still works.
 */
export async function persistLocalMedia(workspaceId: string, file: File): Promise<string> {
  return uploadEditorMedia(workspaceId, file);
}

/** Local copy is a convenience only; the authoritative copy is in Supabase. */
const LOCAL_KEY = 'reelora.editor.draft.v1';
const PROJECT_DRAFT_PREFIX = 'reelora.editor.project.v1.';

/** blob: URLs cannot survive a reload; keep signed URLs for the current tab. */
function withoutDeadBlobUrls(editor: EditorProject): EditorProject {
  const dead = (url?: string) => Boolean(url?.startsWith('blob:'));
  return {
    ...editor,
    scenes: editor.scenes.map((s) => ({
      ...s,
      source: dead(s.source.url)
        ? { ...s.source, url: undefined, ...(s.source.storagePath ? {} : { kind: 'none' as const }) }
        : s.source,
    })),
    audio: dead(editor.audio.url)
      ? { ...editor.audio, url: undefined, ...(editor.audio.storagePath ? {} : { kind: 'none' as const }) }
      : editor.audio,
    ...(editor.voiceover
      ? {
        voiceover: dead(editor.voiceover.url)
          ? { ...editor.voiceover, url: undefined, ...(editor.voiceover.storagePath ? {} : { kind: 'none' as const }) }
          : editor.voiceover,
      }
      : {}),
  };
}

export function saveLocalDraft(editor: EditorProject): void {
  // Keep session object URLs for in-tab navigation; loadLocalDraft drops any
  // stale blob: URL after a reload, when the underlying Blob no longer exists.
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(editor));
    if (editor.projectId) {
      localStorage.setItem(`${PROJECT_DRAFT_PREFIX}${editor.projectId}`, JSON.stringify(editor));
    }
  } catch { /* quota / private mode */ }
}

export function loadLocalDraft(): EditorProject | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? parseEditorProject(JSON.parse(raw) as unknown) : null;
    return parsed ? withoutDeadBlobUrls(parsed) : null;
  } catch { return null; }
}

export function loadProjectLocalDraft(projectId: string): EditorProject | null {
  try {
    const raw = localStorage.getItem(`${PROJECT_DRAFT_PREFIX}${projectId}`);
    const parsed = raw ? parseEditorProject(JSON.parse(raw) as unknown) : null;
    return parsed ? withoutDeadBlobUrls(parsed) : null;
  } catch { return null; }
}

export function clearLocalDraft(projectId?: string | null): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
    if (projectId) localStorage.removeItem(`${PROJECT_DRAFT_PREFIX}${projectId}`);
  } catch { /* ignore */ }
}
