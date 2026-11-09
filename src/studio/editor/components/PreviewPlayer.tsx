import { useEffect, useMemo, useRef } from 'react';
import { Film, Play, Volume2, VolumeX } from 'lucide-react';
import {
  ASPECT_PRESETS, clampTransitionDuration, effectiveSubtitleConfig,
  effectiveVoiceover, totalDuration, type EditorProject, type EditorScene,
} from '../types';

export interface SceneMediaMeta {
  sourceDuration: number;
  mediaWidth: number;
  mediaHeight: number;
}

function activeSceneAt(scenes: EditorScene[], playhead: number) {
  let cursor = 0;
  let index = 0;
  let local = 0;
  for (let i = 0; i < scenes.length; i += 1) {
    const d = Math.max(0, scenes[i].duration);
    if (playhead < cursor + d || i === scenes.length - 1) {
      index = i;
      local = Math.max(0, Math.min(d, playhead - cursor));
      break;
    }
    cursor += d;
  }
  return { index, cursor, local, scene: scenes[index] ?? null };
}

function safePlay(el: HTMLMediaElement | null) {
  if (!el || typeof el.play !== 'function') return;
  try {
    const res = el.play();
    if (res && typeof (res as Promise<void>).catch === 'function') {
      (res as Promise<void>).catch(() => undefined);
    }
  } catch { /* jsdom or autoplay guard */ }
}

function safePause(el: HTMLMediaElement | null) {
  if (!el || el.paused || typeof el.pause !== 'function') return;
  try { el.pause(); } catch { /* jsdom */ }
}

/**
 * Fluid preview player:
 *  - preloads active + next clip in parallel layers for glitch-free transitions;
 *  - renders real CSS fade / dissolve / slide transitions matching render.ts;
 *  - syncs clip audio, voiceover track and music track (with ducking);
 *  - never invents synthetic video when a scene has no real source.
 */
export function PreviewPlayer({
  project,
  playhead,
  playing,
  playbackRate = 1,
  muted = false,
  onToggleMute,
  onTimeChange,
  onEnded,
  onMediaMetadata,
}: {
  project: EditorProject;
  playhead: number;
  playing: boolean;
  playbackRate?: number;
  muted?: boolean;
  onToggleMute?: () => void;
  onTimeChange: (t: number) => void;
  onEnded: () => void;
  onMediaMetadata?: (sceneId: string, meta: SceneMediaMeta) => void;
}) {
  const activeVideoRef = useRef<HTMLVideoElement>(null);
  const nextVideoRef = useRef<HTMLVideoElement>(null);
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const musicAudioRef = useRef<HTMLAudioElement>(null);

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const total = useMemo(() => totalDuration(project), [project]);

  const { index, local, scene } = activeSceneAt(project.scenes, playhead);
  const nextScene = project.scenes[index + 1] ?? null;
  const url = scene?.source.url ?? '';
  const nextUrl = nextScene?.source.url ?? '';
  const preset = ASPECT_PRESETS[project.aspect];
  const subCfg = effectiveSubtitleConfig(project);
  const voiceover = effectiveVoiceover(project);

  // Compute transition blend factor during the tail of the current scene.
  const transDur = clampTransitionDuration(scene?.transitionDuration);
  const remaining = scene ? Math.max(0, scene.duration - local) : 0;
  const inTransition = Boolean(
    scene && nextScene && scene.transition !== 'cut' && remaining < transDur && nextUrl,
  );
  const k = inTransition ? Math.min(1, Math.max(0, (transDur - remaining) / transDur)) : 0;

  // Smooth rAF playhead clock when playing
  useEffect(() => {
    if (!playing || total <= 0) return;
    let rafId = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000) * playbackRate;
      last = now;
      const next = playheadRef.current + dt;
      if (next >= total) {
        onTimeChange(total);
        onEnded();
        return;
      }
      onTimeChange(next);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [playing, total, playbackRate, onTimeChange, onEnded]);

  // Sync active video element with playhead / play state
  useEffect(() => {
    const v = activeVideoRef.current;
    if (!v || !url || !scene) return;
    v.playbackRate = playbackRate;
    v.muted = muted || Boolean(scene.muted) || (scene.volume ?? 1) === 0;
    v.volume = Math.min(1, Math.max(0, scene.volume ?? 1));
    const expected = (scene.trimStart ?? 0) + local;
    if (Number.isFinite(v.duration) && v.duration > 0 && Number.isFinite(expected)) {
      const clamped = Math.min(expected, Math.max(0, v.duration - 0.05));
      if (Math.abs(v.currentTime - clamped) > (playing ? 0.35 : 0.08)) {
        try { v.currentTime = clamped; } catch { /* seek race */ }
      }
    }
    if (playing) safePlay(v);
    else safePause(v);
  }, [url, playing, index, local, scene, playbackRate, muted]);

  // Pre-cue next scene video so transition into it is seamless
  useEffect(() => {
    const nv = nextVideoRef.current;
    if (!nv || !nextUrl || !nextScene) return;
    nv.playbackRate = playbackRate;
    nv.muted = true;
    const expected = nextScene.trimStart ?? 0;
    if (Number.isFinite(nv.duration) && nv.duration > 0 && Math.abs(nv.currentTime - expected) > 0.25) {
      try { nv.currentTime = Math.min(expected, Math.max(0, nv.duration - 0.05)); } catch { /* ignore */ }
    }
    if (playing && inTransition) safePlay(nv);
    else safePause(nv);
  }, [nextUrl, nextScene, playing, inTransition, playbackRate]);

  // Sync Voiceover & Music tracks
  useEffect(() => {
    const syncTrack = (el: HTMLAudioElement | null, track: typeof project.audio, duckFactor = 1) => {
      if (!el || track.kind === 'none' || !track.url || track.muted || muted) {
        safePause(el);
        return;
      }
      el.playbackRate = playbackRate;
      el.volume = Math.min(1, Math.max(0, track.volume * duckFactor));
      const startAt = Math.max(0, track.startAt ?? 0);
      const trimStart = Math.max(0, track.trimStart ?? 0);
      const localT = playhead - startAt;
      if (localT < 0 || (Number.isFinite(el.duration) && el.duration > 0 && trimStart + localT >= el.duration)) {
        safePause(el);
        return;
      }
      const target = trimStart + localT;
      if (Math.abs(el.currentTime - target) > 0.35) {
        try { el.currentTime = target; } catch { /* seek */ }
      }
      if (playing) safePlay(el);
      else safePause(el);
    };

    const voStart = Math.max(0, voiceover.startAt ?? 0);
    const voActive = Boolean(
      voiceover.kind !== 'none'
      && voiceover.url
      && !voiceover.muted
      && playhead >= voStart
      && (!voiceover.sourceDuration || (playhead - voStart + (voiceover.trimStart ?? 0)) < voiceover.sourceDuration),
    );
    syncTrack(voiceAudioRef.current, voiceover, 1);
    syncTrack(musicAudioRef.current, project.audio, project.audioDucking && voActive ? 0.32 : 1);
  }, [playhead, playing, playbackRate, muted, voiceover, project.audio, project.audioDucking]);

  // Determine active subtitle visibility according to optional per-scene span
  const subVisible = Boolean(
    project.subtitlesEnabled
    && scene?.subtitle.trim()
    && local >= (scene.subtitleStart ?? 0)
    && local <= (scene.subtitleEnd ?? scene.duration),
  );
  const subText = scene?.subtitle.trim() ?? '';
  const displayedSub = subCfg.uppercase ? subText.toUpperCase() : subText;

  const subPositionCls = subCfg.position === 'top'
    ? 'top-[8%]'
    : subCfg.position === 'center'
      ? 'top-1/2 -translate-y-1/2'
      : 'bottom-[7%]';
  const subStyleCls = subCfg.style === 'pill'
    ? 'rounded-full border border-cyan-400/45 bg-[#082d3a]/85 px-4 py-1.5 shadow-lg'
    : subCfg.style === 'outline'
      ? 'bg-transparent px-2 py-1 drop-shadow-[0_2px_3px_rgba(0,0,0,0.95)]'
      : 'rounded-xl bg-black/75 px-3 py-2';
  const subSizeCls = subCfg.size === 'lg'
    ? 'text-sm sm:text-base font-bold'
    : subCfg.size === 'sm'
      ? 'text-[11px] sm:text-xs font-medium'
      : 'text-xs sm:text-sm font-semibold';

  const fitClass = scene?.fitMode === 'contain' ? 'object-contain' : 'object-cover';
  const nextFitClass = nextScene?.fitMode === 'contain' ? 'object-contain' : 'object-cover';

  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-black select-none"
      style={{ aspectRatio: `${preset.width} / ${preset.height}`, maxHeight: 'min(58vh, 560px)' }}
    >
      {url ? (
        <video
          key={`main-${scene?.id}-${url}`}
          ref={activeVideoRef}
          src={url}
          playsInline
          crossOrigin="anonymous"
          preload="auto"
          className={`absolute inset-0 h-full w-full ${fitClass}`}
          style={
            inTransition && scene?.transition === 'fade'
              ? { opacity: k < 0.5 ? 1 - k * 2 : 0 }
              : inTransition && scene?.transition === 'dissolve'
                ? { opacity: 1 - k }
                : undefined
          }
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (scene && onMediaMetadata && Number.isFinite(v.duration) && v.duration > 0) {
              onMediaMetadata(scene.id, {
                sourceDuration: Number(v.duration.toFixed(2)),
                mediaWidth: v.videoWidth || 0,
                mediaHeight: v.videoHeight || 0,
              });
            }
          }}
        />
      ) : (
        <div className="grid h-full min-h-[240px] place-items-center px-6 text-center">
          <div>
            <Film size={30} className="mx-auto text-slate-600" />
            <p className="mt-2 text-sm text-slate-300">Aucun média réel pour ce plan</p>
            <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-slate-500">
              La prévisualisation n’affiche pas de vidéo fictive. Importez un clip ou attachez une création du projet.
            </p>
          </div>
        </div>
      )}

      {/* Preloaded next video layer for smooth transitions */}
      {nextUrl && (
        <video
          key={`next-${nextScene?.id}-${nextUrl}`}
          ref={nextVideoRef}
          src={nextUrl}
          playsInline
          muted
          crossOrigin="anonymous"
          preload="auto"
          className={`pointer-events-none absolute inset-0 h-full w-full ${nextFitClass}`}
          style={{
            opacity: inTransition
              ? (scene?.transition === 'fade' ? (k >= 0.5 ? (k - 0.5) * 2 : 0) : scene?.transition === 'slide' ? 1 : k)
              : 0,
            transform: inTransition && scene?.transition === 'slide'
              ? `translateX(${(1 - k) * 100}%)`
              : undefined,
          }}
        />
      )}

      {/* Hidden synchronized audio elements for voiceover & music */}
      {voiceover.kind !== 'none' && voiceover.url && (
        <audio ref={voiceAudioRef} src={voiceover.url} preload="auto" crossOrigin="anonymous" />
      )}
      {project.audio.kind !== 'none' && project.audio.url && (
        <audio ref={musicAudioRef} src={project.audio.url} preload="auto" crossOrigin="anonymous" />
      )}

      {subVisible && displayedSub && (
        <div
          data-testid="preview-subtitle"
          className={`pointer-events-none absolute inset-x-[8%] text-center leading-snug text-white ${subPositionCls} ${subStyleCls} ${subSizeCls}`}
        >
          {displayedSub}
        </div>
      )}

      <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-lg bg-black/70 px-2 py-1 text-[10px] text-cyan-200 backdrop-blur">
        {playing ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" /> : <Play size={10} />}
        <span>Plan {index + 1}/{Math.max(1, project.scenes.length)} · {scene?.label ?? '—'}</span>
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1.5">
        {project.demo && (
          <span className="rounded-lg border border-amber-400/30 bg-amber-400/15 px-2 py-1 text-[10px] font-semibold text-amber-200 backdrop-blur">
            Démo · sans média réel
          </span>
        )}
        {onToggleMute && (
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? 'Réactiver le son de prévisualisation' : 'Couper le son de prévisualisation'}
            className="grid h-7 w-7 place-items-center rounded-lg bg-black/70 text-slate-200 backdrop-blur hover:text-white"
          >
            {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
        )}
      </div>
    </div>
  );
}
