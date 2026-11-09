/**
 * Reelora Phase 4 — Sample-accurate timeline audio planner & OfflineAudioContext mixer.
 *
 * `planAudioTimeline()` is pure and deterministic (fully unit-tested in Node).
 * `mixProjectAudioOffline()` decodes and mixes real clip audio, voiceover and
 * background music with smooth gain-ramped ducking in a browser OfflineAudioContext.
 */

import { clampTransitionDuration, effectiveVoiceover, totalDuration, type EditorProject } from './types';

export const DUCKING_FACTOR = 0.30;
export const DUCKING_RAMP_SECONDS = 0.12;

export interface ScheduledAudioSegment {
  kind: 'clip' | 'voiceover' | 'music';
  label: string;
  url: string;
  /** Timeline start in seconds. */
  start: number;
  /** Timeline end in seconds. */
  end: number;
  /** Source media offset in seconds. */
  trimStart: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

export interface DuckingWindow {
  start: number;
  end: number;
  factor: number;
}

export interface AudioTimelinePlan {
  totalDuration: number;
  clips: ScheduledAudioSegment[];
  voiceover: ScheduledAudioSegment | null;
  music: ScheduledAudioSegment | null;
  duckingWindows: DuckingWindow[];
}

export function planAudioTimeline(project: EditorProject): AudioTimelinePlan {
  const total = totalDuration(project);
  const clips: ScheduledAudioSegment[] = [];
  let cursor = 0;

  for (let i = 0; i < project.scenes.length; i += 1) {
    const sc = project.scenes[i];
    const dur = Math.max(0, sc.duration);
    const start = cursor;
    const end = Number((cursor + dur).toFixed(4));
    cursor = end;
    if (sc.source.kind === 'none' || !sc.source.url || sc.muted) continue;
    const vol = Math.min(1, Math.max(0, sc.volume ?? 1));
    if (vol <= 0 || dur <= 0) continue;
    const transOut = i < project.scenes.length - 1 && sc.transition !== 'cut'
      ? Math.min(dur * 0.4, clampTransitionDuration(sc.transitionDuration) * 0.5)
      : 0;
    const prev = i > 0 ? project.scenes[i - 1] : null;
    const transIn = prev && prev.transition !== 'cut'
      ? Math.min(dur * 0.4, clampTransitionDuration(prev.transitionDuration) * 0.5)
      : 0;

    clips.push({
      kind: 'clip',
      label: sc.label,
      url: sc.source.url,
      start,
      end,
      trimStart: Math.max(0, sc.trimStart ?? 0),
      volume: vol,
      fadeIn: transIn,
      fadeOut: transOut,
    });
  }

  const voTrack = effectiveVoiceover(project);
  let voiceover: ScheduledAudioSegment | null = null;
  if (voTrack.kind !== 'none' && voTrack.url && !voTrack.muted && voTrack.volume > 0) {
    const start = Math.min(total, Math.max(0, voTrack.startAt ?? 0));
    const maxRem = Math.max(0, total - start);
    const dur = voTrack.sourceDuration && voTrack.sourceDuration > 0
      ? Math.min(maxRem, Math.max(0, voTrack.sourceDuration - Math.max(0, voTrack.trimStart ?? 0)))
      : maxRem;
    if (dur > 0.05) {
      voiceover = {
        kind: 'voiceover',
        label: voTrack.name || 'Voix off',
        url: voTrack.url,
        start,
        end: Number((start + dur).toFixed(4)),
        trimStart: Math.max(0, voTrack.trimStart ?? 0),
        volume: Math.min(1, Math.max(0, voTrack.volume)),
        fadeIn: 0.03,
        fadeOut: 0.05,
      };
    }
  }

  const musicTrack = project.audio;
  let music: ScheduledAudioSegment | null = null;
  if (musicTrack.kind !== 'none' && musicTrack.url && !musicTrack.muted && musicTrack.volume > 0) {
    const start = Math.min(total, Math.max(0, musicTrack.startAt ?? 0));
    const maxRem = Math.max(0, total - start);
    const dur = musicTrack.sourceDuration && musicTrack.sourceDuration > 0
      ? Math.min(maxRem, Math.max(0, musicTrack.sourceDuration - Math.max(0, musicTrack.trimStart ?? 0)))
      : maxRem;
    if (dur > 0.05) {
      music = {
        kind: 'music',
        label: musicTrack.name || 'Musique',
        url: musicTrack.url,
        start,
        end: Number((start + dur).toFixed(4)),
        trimStart: Math.max(0, musicTrack.trimStart ?? 0),
        volume: Math.min(1, Math.max(0, musicTrack.volume)),
        fadeIn: 0.08,
        fadeOut: 0.25,
      };
    }
  }

  const duckingWindows: DuckingWindow[] = [];
  if (project.audioDucking !== false && voiceover && music) {
    const overlapStart = Math.max(voiceover.start, music.start);
    const overlapEnd = Math.min(voiceover.end, music.end);
    if (overlapEnd > overlapStart) {
      duckingWindows.push({
        start: overlapStart,
        end: overlapEnd,
        factor: DUCKING_FACTOR,
      });
    }
  }

  return { totalDuration: total, clips, voiceover, music, duckingWindows };
}

export interface OfflineAudioMixResult {
  buffer: AudioBuffer | null;
  hasAudio: boolean;
  sampleRate: number;
  diagnostics: string[];
}

async function fetchAndDecodeAudio(
  ctx: BaseAudioContext,
  url: string,
  cache: Map<string, AudioBuffer | null>,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  if (cache.has(url)) return cache.get(url) ?? null;
  try {
    const res = await fetch(url, { mode: 'cors', signal });
    if (!res.ok) {
      cache.set(url, null);
      return null;
    }
    const raw = await res.arrayBuffer();
    if (signal?.aborted) return null;
    // decodeAudioData detaches the buffer; keep our own slice safely
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    cache.set(url, decoded);
    return decoded;
  } catch {
    cache.set(url, null);
    return null;
  }
}

export async function mixProjectAudioOffline(
  project: EditorProject,
  sampleRate = 48000,
  signal?: AbortSignal,
): Promise<OfflineAudioMixResult> {
  const plan = planAudioTimeline(project);
  const OfflineCtor = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!OfflineCtor || plan.totalDuration <= 0) {
    return { buffer: null, hasAudio: false, sampleRate, diagnostics: ['OfflineAudioContext indisponible.'] };
  }

  const allSegments: ScheduledAudioSegment[] = [
    ...plan.clips,
    ...(plan.voiceover ? [plan.voiceover] : []),
    ...(plan.music ? [plan.music] : []),
  ];
  if (allSegments.length === 0) {
    return { buffer: null, hasAudio: false, sampleRate, diagnostics: [] };
  }

  const totalFrames = Math.max(1, Math.ceil(plan.totalDuration * sampleRate));
  const ctx = new OfflineCtor(2, totalFrames, sampleRate);
  const cache = new Map<string, AudioBuffer | null>();
  const diagnostics: string[] = [];
  let scheduledCount = 0;

  const scheduleSegment = (seg: ScheduledAudioSegment, buf: AudioBuffer, duckWindows: DuckingWindow[] = []) => {
    const offset = Math.min(Math.max(0, seg.trimStart), Math.max(0, buf.duration - 0.01));
    const available = Math.max(0, buf.duration - offset);
    const duration = Math.min(available, seg.end - seg.start);
    if (duration <= 0.01) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const gain = ctx.createGain();
    const baseGain = seg.kind === 'clip' && plan.music ? seg.volume * 0.72 : seg.volume;
    gain.gain.setValueAtTime(seg.fadeIn > 0 ? 0.001 : baseGain, seg.start);
    if (seg.fadeIn > 0) {
      gain.gain.linearRampToValueAtTime(baseGain, Math.min(seg.end, seg.start + seg.fadeIn));
    }

    // Apply sample-accurate ducking ramps for background music when voiceover overlaps
    for (const dw of duckWindows) {
      const s = Math.max(seg.start, dw.start);
      const e = Math.min(seg.end, dw.end);
      if (e <= s) continue;
      const rampStart = Math.max(seg.start, s - DUCKING_RAMP_SECONDS);
      gain.gain.setValueAtTime(baseGain, rampStart);
      gain.gain.linearRampToValueAtTime(baseGain * dw.factor, s);
      gain.gain.setValueAtTime(baseGain * dw.factor, Math.max(s, e - DUCKING_RAMP_SECONDS));
      gain.gain.linearRampToValueAtTime(baseGain, Math.min(seg.end, e + DUCKING_RAMP_SECONDS));
    }

    if (seg.fadeOut > 0 && duration > seg.fadeOut + 0.05) {
      const fadeStart = seg.start + duration - seg.fadeOut;
      const endGain = duckWindows.some((dw) => fadeStart >= dw.start && fadeStart <= dw.end)
        ? baseGain * DUCKING_FACTOR
        : baseGain;
      gain.gain.setValueAtTime(endGain, fadeStart);
      gain.gain.linearRampToValueAtTime(0.001, seg.start + duration);
    }

    src.connect(gain).connect(ctx.destination);
    src.start(seg.start, offset, duration);
    scheduledCount += 1;
  };

  for (const seg of allSegments) {
    if (signal?.aborted) throw new DOMException('Mixage audio interrompu.', 'AbortError');
    const buf = await fetchAndDecodeAudio(ctx, seg.url, cache, signal);
    if (!buf) {
      if (seg.kind !== 'clip') {
        diagnostics.push(`Piste audio non décodable (${seg.label}) : vérifiez le format ou CORS.`);
      }
      continue;
    }
    scheduleSegment(seg, buf, seg.kind === 'music' ? plan.duckingWindows : []);
  }

  if (scheduledCount === 0) {
    cache.clear();
    return { buffer: null, hasAudio: false, sampleRate, diagnostics };
  }

  const rendered = await ctx.startRendering();
  cache.clear();
  return { buffer: rendered, hasAudio: true, sampleRate, diagnostics };
}
