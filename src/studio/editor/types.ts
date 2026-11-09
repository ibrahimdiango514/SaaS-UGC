/**
 * Reelora AI Video Editor — domain model.
 *
 * This is a REAL editing model: scenes, tracks, trims, transitions and subtitle
 * spans are user-editable state, persisted in the existing project `settings`
 * JSONB column. Nothing here pretends a media file exists when it does not.
 */

export const EDITOR_VERSION = 1;
export const EDITOR_SETTINGS_KEY = 'reelora_editor_v1';

export type AspectPreset = '9:16' | '1:1' | '16:9';

/** Real export dimensions for a browser-side compositor (scaled for performance). */
export const ASPECT_PRESETS: Record<AspectPreset, { width: number; height: number; label: string; platforms: string }> = {
  '9:16': { width: 720, height: 1280, label: 'Vertical 9:16', platforms: 'TikTok · Reels · Shorts' },
  '1:1': { width: 720, height: 720, label: 'Carré 1:1', platforms: 'Feed Instagram · LinkedIn' },
  '16:9': { width: 1280, height: 720, label: 'Paysage 16:9', platforms: 'YouTube · site web' },
};

export type SceneRole = 'hook' | 'demo' | 'proof' | 'cta' | 'custom';
export type TransitionKind = 'cut' | 'fade' | 'dissolve' | 'slide';
export const TRANSITIONS: { id: TransitionKind; label: string }[] = [
  { id: 'cut', label: 'Coupe franche' },
  { id: 'fade', label: 'Fondu' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'slide', label: 'Balayage' },
];

/**
 * A source is either absent, a locally imported file, a real Reelora asset from
 * the private library, or a real generation job. `none` is NEVER rendered as a
 * fake video: the renderer refuses to export while a scene has no media.
 */
export interface MediaSource {
  kind: 'none' | 'local' | 'asset' | 'job';
  name: string;
  /** Signed URL, refreshed on load; never persisted as a long-lived value. */
  url?: string;
  /** Private Storage path under the user's workspace prefix, persisted instead. */
  storagePath?: string;
  assetId?: string;
  jobId?: string;
}

export interface EditorScene {
  id: string;
  role: SceneRole;
  label: string;
  /** Displayed/exported duration in seconds. */
  duration: number;
  /** Trim point inside the source media, in seconds. */
  trimStart: number;
  source: MediaSource;
  visualPrompt: string;
  spokenText: string;
  subtitle: string;
  transition: TransitionKind;
}

export interface AudioTrack {
  kind: 'none' | 'local' | 'asset';
  name: string;
  /** Signed/object URL for the current browser session only. */
  url?: string;
  /** Private Storage path persisted instead of a short-lived signed URL. */
  storagePath?: string;
  volume: number;
}

export interface EditorProject {
  version: number;
  projectId: string | null;
  title: string;
  prompt: string;
  sector: string;
  quality: string;
  mode: string;
  modelId: string;
  aspect: AspectPreset;
  subtitlesEnabled: boolean;
  planSource: 'deterministic' | 'ai';
  scenes: EditorScene[];
  audio: AudioTrack;
  updatedAt: string;
  /** Explicit demo flag: the UI must label it as a demonstration project. */
  demo?: boolean;
}

export function emptyAudio(): AudioTrack {
  return { kind: 'none', name: '', volume: 0.8 };
}

export function sceneId(prefix = 'sc'): string {
  const c = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  return `${prefix}-${c.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function totalDuration(project: EditorProject): number {
  return Number(project.scenes.reduce((sum, s) => sum + Math.max(0, s.duration), 0).toFixed(2));
}

export function clampDuration(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(60, Math.max(0.5, Math.round(n * 10) / 10));
}

/* --------------------------- Pure timeline operations -------------------- */

export function moveScene(project: EditorProject, from: number, to: number): EditorProject {
  const scenes = [...project.scenes];
  if (from < 0 || from >= scenes.length || to < 0 || to >= scenes.length || from === to) return project;
  const [item] = scenes.splice(from, 1);
  scenes.splice(to, 0, item);
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function removeScene(project: EditorProject, id: string): EditorProject {
  const scenes = project.scenes.filter((s) => s.id !== id);
  return scenes.length === project.scenes.length ? project
    : { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function patchScene(project: EditorProject, id: string, patch: Partial<EditorScene>): EditorProject {
  let changed = false;
  const scenes = project.scenes.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    const next = { ...s, ...patch };
    if (patch.duration !== undefined) next.duration = clampDuration(patch.duration);
    if (patch.trimStart !== undefined) next.trimStart = Math.max(0, Number(patch.trimStart) || 0);
    return next;
  });
  return changed ? { ...project, scenes, updatedAt: new Date().toISOString() } : project;
}

export function replaceSceneSource(project: EditorProject, id: string, source: MediaSource): EditorProject {
  return patchScene(project, id, { source });
}

export function scenesWithMedia(project: EditorProject): EditorScene[] {
  return project.scenes.filter((s) => s.source.kind !== 'none' && Boolean(s.source.url));
}

/** Structured parse of persisted JSON. Never trusts a malformed payload. */
export function parseEditorProject(raw: unknown): EditorProject | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== EDITOR_VERSION || !Array.isArray(r.scenes)) return null;
  const roles: SceneRole[] = ['hook', 'demo', 'proof', 'cta', 'custom'];
  const transitions: TransitionKind[] = ['cut', 'fade', 'dissolve', 'slide'];
  const scenes: EditorScene[] = [];
  for (const item of r.scenes.slice(0, 24)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const s = item as Record<string, unknown>;
    const src = (s.source && typeof s.source === 'object' ? s.source : {}) as Record<string, unknown>;
    const kind = src.kind;
    if (!['none', 'local', 'asset', 'job'].includes(String(kind))) return null;
    const role = roles.includes(s.role as SceneRole) ? s.role as SceneRole : 'custom';
    const transition = transitions.includes(s.transition as TransitionKind) ? s.transition as TransitionKind : 'cut';
    scenes.push({
      id: typeof s.id === 'string' ? s.id : sceneId(),
      role,
      label: typeof s.label === 'string' ? s.label.slice(0, 120) : 'Plan',
      duration: clampDuration(Number(s.duration) || 3),
      trimStart: Math.max(0, Number(s.trimStart) || 0),
      source: {
        kind: kind as MediaSource['kind'],
        name: typeof src.name === 'string' ? src.name.slice(0, 200) : '',
        ...(typeof src.url === 'string' ? { url: src.url.slice(0, 2000) } : {}),
        ...(typeof src.storagePath === 'string' ? { storagePath: src.storagePath.slice(0, 500) } : {}),
        ...(typeof src.assetId === 'string' ? { assetId: src.assetId } : {}),
        ...(typeof src.jobId === 'string' ? { jobId: src.jobId } : {}),
      },
      visualPrompt: typeof s.visualPrompt === 'string' ? s.visualPrompt.slice(0, 4000) : '',
      spokenText: typeof s.spokenText === 'string' ? s.spokenText.slice(0, 2000) : '',
      subtitle: typeof s.subtitle === 'string' ? s.subtitle.slice(0, 500) : '',
      transition,
    });
  }
  const aspect = (r.aspect === '1:1' || r.aspect === '16:9' || r.aspect === '9:16') ? r.aspect : '9:16';
  const audio = (r.audio && typeof r.audio === 'object' ? r.audio : {}) as Record<string, unknown>;
  return {
    version: EDITOR_VERSION,
    projectId: typeof r.projectId === 'string' ? r.projectId : null,
    title: typeof r.title === 'string' ? r.title.slice(0, 200) : 'Montage Reelora',
    prompt: typeof r.prompt === 'string' ? r.prompt.slice(0, 4000) : '',
    sector: typeof r.sector === 'string' ? r.sector.slice(0, 60) : 'general',
    quality: typeof r.quality === 'string' ? r.quality.slice(0, 40) : 'standard',
    mode: typeof r.mode === 'string' ? r.mode.slice(0, 40) : 'idea',
    modelId: typeof r.modelId === 'string' ? r.modelId.slice(0, 120) : '',
    aspect,
    subtitlesEnabled: r.subtitlesEnabled !== false,
    planSource: r.planSource === 'ai' ? 'ai' : 'deterministic',
    scenes,
    audio: {
      kind: audio.kind === 'local' || audio.kind === 'asset' ? audio.kind : 'none',
      name: typeof audio.name === 'string' ? audio.name.slice(0, 200) : '',
      ...(typeof audio.url === 'string' ? { url: audio.url.slice(0, 2000) } : {}),
      ...(typeof audio.storagePath === 'string' ? { storagePath: audio.storagePath.slice(0, 500) } : {}),
      volume: Math.min(1, Math.max(0, Number(audio.volume) || 0.8)),
    },
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    ...(r.demo === true ? { demo: true } : {}),
  };
}
