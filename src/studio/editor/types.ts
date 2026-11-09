/**
 * Reelora AI Video Editor — domain model (Phase 3 enhanced, v1 backwards-compatible).
 *
 * This is a REAL editing model: scenes, tracks, trims, transitions, voiceover,
 * subtitle styling and user suggestion decisions are persisted in the existing
 * project `settings` JSONB column (`reelora_editor_v1`). Nothing here pretends
 * a media file exists when it does not.
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
export const SCENE_ROLES: { id: SceneRole; label: string }[] = [
  { id: 'hook', label: 'Accroche' },
  { id: 'demo', label: 'Démonstration' },
  { id: 'proof', label: 'Preuve / bénéfice' },
  { id: 'cta', label: 'Appel à l’action' },
  { id: 'custom', label: 'Plan libre' },
];

export type TransitionKind = 'cut' | 'fade' | 'dissolve' | 'slide';
export const TRANSITIONS: { id: TransitionKind; label: string }[] = [
  { id: 'cut', label: 'Coupe franche' },
  { id: 'fade', label: 'Fondu' },
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'slide', label: 'Balayage' },
];

export type FitMode = 'cover' | 'contain';

export type UgcRhythmPresetId = 'tiktok-fast' | 'ugc-balanced' | 'storytelling';
export interface UgcRhythmPreset {
  id: UgcRhythmPresetId;
  label: string;
  targetDuration: number;
  maxHookDuration: number;
  maxShotDuration: number;
  description: string;
}

export const UGC_RHYTHM_PRESETS: Record<UgcRhythmPresetId, UgcRhythmPreset> = {
  'tiktok-fast': {
    id: 'tiktok-fast',
    label: 'TikTok / Reels nerveux (15 s)',
    targetDuration: 15,
    maxHookDuration: 2.5,
    maxShotDuration: 4.5,
    description: 'Cuts rapides (1,5–4 s), accroche immédiate, rythme soutenu.',
  },
  'ugc-balanced': {
    id: 'ugc-balanced',
    label: 'UGC Produit équilibré (20 s)',
    targetDuration: 20,
    maxHookDuration: 3.5,
    maxShotDuration: 6,
    description: 'Structure classique : Accroche → Démo → Preuve → CTA.',
  },
  storytelling: {
    id: 'storytelling',
    label: 'Storytelling / Témoignage (30 s)',
    targetDuration: 30,
    maxHookDuration: 4,
    maxShotDuration: 8,
    description: 'Laisse respirer la voix off et les démonstrations détaillées.',
  },
};

export type SubtitlePosition = 'bottom' | 'center' | 'top';
export type SubtitlePreset = 'box' | 'pill' | 'outline';
export type SubtitleSize = 'sm' | 'md' | 'lg';

export interface SubtitleConfig {
  position: SubtitlePosition;
  style: SubtitlePreset;
  size: SubtitleSize;
  uppercase: boolean;
}

export const DEFAULT_SUBTITLE_CONFIG: SubtitleConfig = {
  position: 'bottom',
  style: 'box',
  size: 'md',
  uppercase: false,
};

/**
 * A source is either absent, a locally imported file, a real Reelora asset from
 * the private library, or a real generation job. `none` is NEVER rendered as a
 * fake video: the renderer refuses to export while a scene has no media.
 */
export interface MediaSource {
  kind: 'none' | 'local' | 'asset' | 'job';
  name: string;
  /** Signed or object URL for the current session; never persisted as durable. */
  url?: string;
  /** Private Storage path under the user's workspace prefix, persisted instead. */
  storagePath?: string;
  assetId?: string;
  jobId?: string;
  /** Real measured source duration in seconds (set when loaded in browser). */
  sourceDuration?: number;
  /** Real measured video width/height (set when loaded in browser). */
  mediaWidth?: number;
  mediaHeight?: number;
  mimeType?: string;
  /** Transient upload state in the active tab only. */
  uploadPending?: boolean;
  uploadError?: string;
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
  /** Optional subtitle offset inside the scene (seconds from scene start). */
  subtitleStart?: number;
  /** Optional subtitle end inside the scene (seconds from scene start). */
  subtitleEnd?: number;
  transition: TransitionKind;
  /** Transition duration in seconds (0.15..1.2, default 0.4). */
  transitionDuration?: number;
  /** Framing in output canvas (`cover` fills frame, `contain` fits whole clip). */
  fitMode?: FitMode;
  /** Clip native audio volume (0..1, default 1). */
  volume?: number;
  /** Mute the clip's own audio track. */
  muted?: boolean;
}

export interface AudioTrack {
  kind: 'none' | 'local' | 'asset';
  name: string;
  /** Signed/object URL for the current browser session only. */
  url?: string;
  /** Private Storage path persisted instead of a short-lived signed URL. */
  storagePath?: string;
  volume: number;
  /** Offset in seconds where this track starts playing on the timeline (default 0). */
  startAt?: number;
  /** Trim offset inside the audio file itself (default 0). */
  trimStart?: number;
  /** Measured audio duration in seconds. */
  sourceDuration?: number;
  muted?: boolean;
}

export interface SuggestionDecision {
  status: 'accepted' | 'modified' | 'rejected';
  customValue?: string;
  updatedAt: string;
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
  subtitleConfig?: SubtitleConfig;
  planSource: 'deterministic' | 'ai';
  scenes: EditorScene[];
  /** Background music / ambience track. */
  audio: AudioTrack;
  /** Dedicated voiceover track (imported audio or real browser mic recording). */
  voiceover?: AudioTrack;
  /** Automatically lower background music when voiceover is active. */
  audioDucking?: boolean;
  /** Selected UGC rhythm profile for assistant recommendations. */
  ugcPreset?: UgcRhythmPresetId;
  /** Target total duration in seconds for rhythm analysis. */
  targetDuration?: number;
  /** Persisted user decisions on assistant suggestions. */
  suggestionDecisions?: Record<string, SuggestionDecision>;
  updatedAt: string;
  /** Explicit demo flag: the UI must label it as a demonstration project. */
  demo?: boolean;
}

export function emptyAudio(volume = 0.8): AudioTrack {
  return { kind: 'none', name: '', volume, startAt: 0, trimStart: 0, muted: false };
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

export function clampTransitionDuration(value: number | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.4;
  return Math.min(1.2, Math.max(0.15, Math.round(n * 20) / 20));
}

export function effectiveSubtitleConfig(project: EditorProject): SubtitleConfig {
  return project.subtitleConfig ?? DEFAULT_SUBTITLE_CONFIG;
}

export function effectiveVoiceover(project: EditorProject): AudioTrack {
  return project.voiceover ?? emptyAudio(1);
}

/* --------------------------- Pure timeline operations -------------------- */

export function moveScene(project: EditorProject, from: number, to: number): EditorProject {
  const scenes = [...project.scenes];
  if (from < 0 || from >= scenes.length || to < 0 || to >= scenes.length || from === to) return project;
  const [item] = scenes.splice(from, 1);
  scenes.splice(to, 0, item);
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function reorderScenesByIds(project: EditorProject, orderedIds: string[]): EditorProject {
  const map = new Map(project.scenes.map((s) => [s.id, s]));
  const next: EditorScene[] = [];
  for (const id of orderedIds) {
    const found = map.get(id);
    if (found) {
      next.push(found);
      map.delete(id);
    }
  }
  for (const remaining of map.values()) next.push(remaining);
  if (next.length !== project.scenes.length) return project;
  return { ...project, scenes: next, updatedAt: new Date().toISOString() };
}

export function removeScene(project: EditorProject, id: string): EditorProject {
  const scenes = project.scenes.filter((s) => s.id !== id);
  return scenes.length === project.scenes.length ? project
    : { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function addScene(
  project: EditorProject,
  partial: Partial<EditorScene> = {},
  insertAt?: number,
): EditorProject {
  if (project.scenes.length >= 24) return project;
  const role: SceneRole = partial.role ?? 'custom';
  const defaultLabel = SCENE_ROLES.find((r) => r.id === role)?.label ?? 'Nouveau plan';
  const scene: EditorScene = {
    id: partial.id ?? sceneId(),
    role,
    label: partial.label ?? defaultLabel,
    duration: clampDuration(partial.duration ?? 3),
    trimStart: Math.max(0, Number(partial.trimStart) || 0),
    source: partial.source ?? { kind: 'none', name: '' },
    visualPrompt: partial.visualPrompt ?? '',
    spokenText: partial.spokenText ?? '',
    subtitle: partial.subtitle ?? '',
    transition: partial.transition ?? 'cut',
    transitionDuration: clampTransitionDuration(partial.transitionDuration),
    fitMode: partial.fitMode ?? 'cover',
    volume: partial.volume ?? 1,
    muted: partial.muted ?? false,
  };
  const scenes = [...project.scenes];
  const idx = insertAt === undefined ? scenes.length : Math.min(scenes.length, Math.max(0, insertAt));
  scenes.splice(idx, 0, scene);
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function duplicateScene(project: EditorProject, id: string): EditorProject {
  if (project.scenes.length >= 24) return project;
  const idx = project.scenes.findIndex((s) => s.id === id);
  if (idx < 0) return project;
  const orig = project.scenes[idx];
  const copy: EditorScene = {
    ...orig,
    id: sceneId(),
    label: `${orig.label} (copie)`.slice(0, 120),
    source: { ...orig.source },
  };
  const scenes = [...project.scenes];
  scenes.splice(idx + 1, 0, copy);
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

function splitTextAtProportion(text: string, ratio: number): [string, string] {
  const clean = text.trim();
  if (!clean) return ['', ''];
  const words = clean.split(/\s+/);
  if (words.length < 2) return [clean, ''];
  const cut = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)));
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
}

/**
 * Split one scene into two contiguous parts at `splitAtLocalSeconds` (relative to
 * the start of the scene). Preserves real media references and updates `trimStart`
 * for the second half so playback stays continuous.
 */
export function splitScene(project: EditorProject, id: string, splitAtLocalSeconds?: number): EditorProject {
  if (project.scenes.length >= 24) return project;
  const idx = project.scenes.findIndex((s) => s.id === id);
  if (idx < 0) return project;
  const target = project.scenes[idx];
  if (target.duration < 1) return project;

  const rawSplit = splitAtLocalSeconds === undefined ? target.duration / 2 : splitAtLocalSeconds;
  const split = Math.round(Math.min(target.duration - 0.5, Math.max(0.5, rawSplit)) * 10) / 10;
  const remaining = Math.round((target.duration - split) * 10) / 10;
  if (split < 0.5 || remaining < 0.5) return project;

  const ratio = split / target.duration;
  const [spokenA, spokenB] = splitTextAtProportion(target.spokenText, ratio);
  const [subA, subB] = splitTextAtProportion(target.subtitle, ratio);

  const first: EditorScene = {
    ...target,
    duration: split,
    spokenText: spokenA,
    subtitle: subA,
    transition: 'cut',
  };
  const second: EditorScene = {
    ...target,
    id: sceneId(),
    label: `${target.label} · suite`.slice(0, 120),
    duration: remaining,
    trimStart: Math.round(((target.trimStart || 0) + split) * 10) / 10,
    source: { ...target.source },
    spokenText: spokenB,
    subtitle: subB,
  };
  const scenes = [...project.scenes];
  scenes.splice(idx, 1, first, second);
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

export function trimScene(
  project: EditorProject,
  id: string,
  bounds: { trimStart?: number; duration?: number },
): EditorProject {
  const scene = project.scenes.find((s) => s.id === id);
  if (!scene) return project;
  const sourceDur = scene.source.sourceDuration;
  let nextTrim = bounds.trimStart !== undefined ? Math.max(0, Math.round(bounds.trimStart * 10) / 10) : scene.trimStart;
  if (sourceDur && Number.isFinite(sourceDur) && sourceDur > 0.5) {
    nextTrim = Math.min(nextTrim, Math.max(0, Math.round((sourceDur - 0.5) * 10) / 10));
  }
  let nextDuration = bounds.duration !== undefined ? clampDuration(bounds.duration) : scene.duration;
  if (sourceDur && Number.isFinite(sourceDur) && sourceDur >= 0.5 && nextTrim + nextDuration > sourceDur) {
    nextDuration = clampDuration(Math.max(0.5, sourceDur - nextTrim));
  }
  return patchScene(project, id, { trimStart: nextTrim, duration: nextDuration });
}

export function patchScene(project: EditorProject, id: string, patch: Partial<EditorScene>): EditorProject {
  let changed = false;
  const scenes = project.scenes.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    const next: EditorScene = { ...s, ...patch };
    if (patch.duration !== undefined) next.duration = clampDuration(patch.duration);
    if (patch.trimStart !== undefined) next.trimStart = Math.max(0, Math.round((Number(patch.trimStart) || 0) * 10) / 10);
    if (patch.transitionDuration !== undefined) next.transitionDuration = clampTransitionDuration(patch.transitionDuration);
    if (patch.volume !== undefined) next.volume = Math.min(1, Math.max(0, Number(patch.volume) || 0));
    if (patch.subtitleStart !== undefined) next.subtitleStart = Math.max(0, Math.min(next.duration, Number(patch.subtitleStart) || 0));
    if (patch.subtitleEnd !== undefined) next.subtitleEnd = Math.max(0, Math.min(next.duration, Number(patch.subtitleEnd) || next.duration));
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

function parseAudioTrack(raw: unknown, fallbackVolume: number): AudioTrack {
  const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const kind = a.kind === 'local' || a.kind === 'asset' ? a.kind : 'none';
  return {
    kind,
    name: typeof a.name === 'string' ? a.name.slice(0, 200) : '',
    ...(typeof a.url === 'string' ? { url: a.url.slice(0, 2000) } : {}),
    ...(typeof a.storagePath === 'string' ? { storagePath: a.storagePath.slice(0, 500) } : {}),
    volume: Number.isFinite(Number(a.volume)) ? Math.min(1, Math.max(0, Number(a.volume))) : fallbackVolume,
    ...(Number.isFinite(Number(a.startAt)) ? { startAt: Math.max(0, Number(a.startAt)) } : {}),
    ...(Number.isFinite(Number(a.trimStart)) ? { trimStart: Math.max(0, Number(a.trimStart)) } : {}),
    ...(Number.isFinite(Number(a.sourceDuration)) && Number(a.sourceDuration) > 0 ? { sourceDuration: Number(a.sourceDuration) } : {}),
    ...(a.muted === true ? { muted: true } : {}),
  };
}

function parseSubtitleConfig(raw: unknown): SubtitleConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const position: SubtitlePosition = r.position === 'top' || r.position === 'center' || r.position === 'bottom' ? r.position : 'bottom';
  const style: SubtitlePreset = r.style === 'pill' || r.style === 'outline' || r.style === 'box' ? r.style : 'box';
  const size: SubtitleSize = r.size === 'sm' || r.size === 'md' || r.size === 'lg' ? r.size : 'md';
  return { position, style, size, uppercase: r.uppercase === true };
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
    const duration = clampDuration(Number(s.duration) || 3);
    scenes.push({
      id: typeof s.id === 'string' ? s.id : sceneId(),
      role,
      label: typeof s.label === 'string' ? s.label.slice(0, 120) : 'Plan',
      duration,
      trimStart: Math.max(0, Number(s.trimStart) || 0),
      source: {
        kind: kind as MediaSource['kind'],
        name: typeof src.name === 'string' ? src.name.slice(0, 200) : '',
        ...(typeof src.url === 'string' ? { url: src.url.slice(0, 2000) } : {}),
        ...(typeof src.storagePath === 'string' ? { storagePath: src.storagePath.slice(0, 500) } : {}),
        ...(typeof src.assetId === 'string' ? { assetId: src.assetId } : {}),
        ...(typeof src.jobId === 'string' ? { jobId: src.jobId } : {}),
        ...(Number.isFinite(Number(src.sourceDuration)) && Number(src.sourceDuration) > 0 ? { sourceDuration: Number(src.sourceDuration) } : {}),
        ...(Number.isFinite(Number(src.mediaWidth)) && Number(src.mediaWidth) > 0 ? { mediaWidth: Number(src.mediaWidth) } : {}),
        ...(Number.isFinite(Number(src.mediaHeight)) && Number(src.mediaHeight) > 0 ? { mediaHeight: Number(src.mediaHeight) } : {}),
        ...(typeof src.mimeType === 'string' ? { mimeType: src.mimeType.slice(0, 80) } : {}),
      },
      visualPrompt: typeof s.visualPrompt === 'string' ? s.visualPrompt.slice(0, 4000) : '',
      spokenText: typeof s.spokenText === 'string' ? s.spokenText.slice(0, 2000) : '',
      subtitle: typeof s.subtitle === 'string' ? s.subtitle.slice(0, 500) : '',
      ...(Number.isFinite(Number(s.subtitleStart)) ? { subtitleStart: Math.max(0, Math.min(duration, Number(s.subtitleStart))) } : {}),
      ...(Number.isFinite(Number(s.subtitleEnd)) ? { subtitleEnd: Math.max(0, Math.min(duration, Number(s.subtitleEnd))) } : {}),
      transition,
      ...(Number.isFinite(Number(s.transitionDuration)) ? { transitionDuration: clampTransitionDuration(Number(s.transitionDuration)) } : {}),
      ...(s.fitMode === 'cover' || s.fitMode === 'contain' ? { fitMode: s.fitMode } : {}),
      ...(Number.isFinite(Number(s.volume)) ? { volume: Math.min(1, Math.max(0, Number(s.volume))) } : {}),
      ...(s.muted === true ? { muted: true } : {}),
    });
  }
  const aspect = (r.aspect === '1:1' || r.aspect === '16:9' || r.aspect === '9:16') ? r.aspect : '9:16';
  const subtitleConfig = parseSubtitleConfig(r.subtitleConfig);
  const ugcPreset: UgcRhythmPresetId | undefined =
    r.ugcPreset === 'tiktok-fast' || r.ugcPreset === 'ugc-balanced' || r.ugcPreset === 'storytelling'
      ? r.ugcPreset : undefined;

  let suggestionDecisions: Record<string, SuggestionDecision> | undefined;
  if (r.suggestionDecisions && typeof r.suggestionDecisions === 'object' && !Array.isArray(r.suggestionDecisions)) {
    const out: Record<string, SuggestionDecision> = {};
    for (const [k, val] of Object.entries(r.suggestionDecisions as Record<string, unknown>).slice(0, 50)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      const v = val as Record<string, unknown>;
      if (v.status === 'accepted' || v.status === 'modified' || v.status === 'rejected') {
        out[k] = {
          status: v.status,
          ...(typeof v.customValue === 'string' ? { customValue: v.customValue.slice(0, 500) } : {}),
          updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
        };
      }
    }
    if (Object.keys(out).length > 0) suggestionDecisions = out;
  }

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
    ...(subtitleConfig ? { subtitleConfig } : {}),
    planSource: r.planSource === 'ai' ? 'ai' : 'deterministic',
    scenes,
    audio: parseAudioTrack(r.audio, 0.8),
    ...(r.voiceover ? { voiceover: parseAudioTrack(r.voiceover, 1) } : {}),
    ...(typeof r.audioDucking === 'boolean' ? { audioDucking: r.audioDucking } : {}),
    ...(ugcPreset ? { ugcPreset } : {}),
    ...(Number.isFinite(Number(r.targetDuration)) && Number(r.targetDuration) >= 5 ? { targetDuration: Math.min(90, Math.max(5, Number(r.targetDuration))) } : {}),
    ...(suggestionDecisions ? { suggestionDecisions } : {}),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
    ...(r.demo === true ? { demo: true } : {}),
  };
}
