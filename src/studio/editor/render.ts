/**
 * Reelora Phase 4 — Unified Dual-Engine Video Renderer.
 *
 * Engine #1 (preferred when supported): WebCodecs (`VideoEncoder` + `AudioEncoder`)
 *   + `OfflineAudioContext` sample-accurate mixer + `mp4-muxer` / `webm-muxer`.
 *   Produces deterministic, frame-accurate, seekable `.mp4` (H.264 + AAC/Opus) or
 *   `.webm` (VP9 + Opus) across 720p, 1080p and 4K (when hardware-supported).
 *
 * Engine #2 (fallback when WebCodecs is unavailable): `MediaRecorder` + `canvas.captureStream`
 *   + Web Audio `AudioContext` mixing with ramped ducking.
 *
 * Strict guarantees:
 *  - Never advertises or executes an unsupported resolution/codec.
 *  - Never produces a simulated/empty blob: verifies size + MP4/WebM signature.
 *  - Cleans up every HTMLVideoElement, HTMLAudioElement, VideoFrame, AudioData,
 *    VideoEncoder, AudioEncoder, MediaStreamTrack and AudioContext in `finally`.
 */

import { ArrayBufferTarget as Mp4ArrayBufferTarget, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmArrayBufferTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { DUCKING_FACTOR, mixProjectAudioOffline } from './audioMixer';
import { subtitleSpans } from './assist';
import {
  DEFAULT_EXPORT_SETTINGS, exportCapabilities, probeExportCapabilities, resolveExportPlan,
  supportedMimeType, verifyVideoBlob,
  type ExportCapabilities, type ExportPhase, type ExportSettings,
} from './exportConfig';
import {
  ASPECT_PRESETS, clampTransitionDuration, effectiveSubtitleConfig, effectiveVoiceover,
  totalDuration, type EditorProject, type FitMode, type SubtitleConfig,
} from './types';

export {
  DEFAULT_EXPORT_SETTINGS, exportCapabilities, probeExportCapabilities, resolveExportPlan,
  supportedMimeType, verifyVideoBlob,
  type ExportCapabilities, type ExportPhase, type ExportSettings,
};
export * from './exportConfig';

export const RENDER_LIMITATIONS = [
  'Rendu local navigateur gratuit (0 crédit UGC) : onglet actif requis ; en mode MediaRecorder le rendu s’exécute en temps réel.',
  'Les médias distants doivent autoriser CORS, sinon Canvas 2D protège la frame et le rendu est refusé.',
  '4K (2160p) et MP4 natif H.264 dépendent de la prise en charge réelle WebCodecs du navigateur.',
  'En cas d’interruption ou de changement de page, le projet sauvegardé reste intact.',
];

export type RenderErrorCode =
  | 'INVALID_PROJECT'
  | 'CODEC_UNSUPPORTED'
  | 'MEDIA_LOAD_ERROR'
  | 'DECODE_ERROR'
  | 'ABORTED'
  | 'ENCODER_ERROR'
  | 'OUTPUT_INVALID';

export class RenderError extends Error {
  code: RenderErrorCode;
  constructor(message: string, code: RenderErrorCode) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
  }
}

export interface FrameSegment { sceneIndex: number; startFrame: number; endFrame: number }

/** Pure frame schedule — unit-testable, deterministic. */
export function planRenderFrames(project: EditorProject, fps = 30): FrameSegment[] {
  let frame = 0;
  return project.scenes.map((scene, sceneIndex) => {
    const frames = Math.max(1, Math.round(Math.max(0, scene.duration) * fps));
    const segment = { sceneIndex, startFrame: frame, endFrame: frame + frames - 1 };
    frame += frames;
    return segment;
  });
}

export function renderIssues(project: EditorProject): string[] {
  const issues: string[] = [];
  if (project.scenes.length === 0) issues.push('Aucune scène dans le montage.');
  const missing = project.scenes.filter((s) => s.source.kind === 'none' || !s.source.url);
  if (missing.length) issues.push(`Média manquant pour : ${missing.map((s) => s.label).join(', ')}. Importez un clip ou utilisez une création réelle.`);
  if (project.scenes.some((s) => s.duration <= 0)) issues.push('Une scène a une durée nulle.');
  if (!ASPECT_PRESETS[project.aspect]) issues.push('Format de sortie inconnu.');
  return issues;
}

export interface RenderOptions {
  fps?: number;
  settings?: ExportSettings;
  onProgress?: (ratio: number, label: string) => void;
  onStage?: (phase: ExportPhase, ratio: number, label: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  container: 'mp4' | 'webm';
  engine: 'webcodecs' | 'mediarecorder';
  durationSeconds: number;
  audioMixed: boolean;
  width: number;
  height: number;
  fps: number;
  diagnostics: string[];
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new RenderError('Export interrompu par l’utilisateur. Votre montage reste intact.', 'ABORTED');
  }
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  fitMode: FitMode = 'cover',
  alpha = 1,
  offsetX = 0,
) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = fitMode === 'contain' ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(video, offsetX + (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  w: number,
  h: number,
  cfg: SubtitleConfig,
) {
  const text = cfg.uppercase ? rawText.trim().toUpperCase() : rawText.trim();
  if (!text) return;
  const sizeFactor = cfg.size === 'lg' ? 0.052 : cfg.size === 'sm' ? 0.034 : 0.042;
  const fontSize = Math.max(16, Math.round(w * sizeFactor));
  ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const maxWidth = w * 0.84;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, 3);
  const lineHeight = fontSize * 1.35;
  const boxH = shown.length * lineHeight + Math.round(w * 0.03);
  const boxY = cfg.position === 'top'
    ? Math.round(h * 0.08)
    : cfg.position === 'center'
      ? Math.round((h - boxH) / 2)
      : h - boxH - Math.round(h * 0.07);

  if (cfg.style !== 'outline') {
    ctx.fillStyle = cfg.style === 'pill' ? 'rgba(8, 45, 58, 0.84)' : 'rgba(4, 8, 14, 0.76)';
    ctx.beginPath();
    ctx.roundRect(w * 0.08, boxY, w * 0.84, boxH, cfg.style === 'pill' ? 999 : 14);
    ctx.fill();
    if (cfg.style === 'pill') {
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
      ctx.lineWidth = Math.max(2, Math.round(w * 0.003));
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#ffffff';
  shown.forEach((l, i) => {
    const y = boxY + Math.round(w * 0.015) + lineHeight * (i + 0.5);
    if (cfg.style === 'outline') {
      ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.14));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.strokeText(l, w / 2, y);
    }
    ctx.fillText(l, w / 2, y);
  });
}

function renderCompositeFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  project: EditorProject,
  videos: HTMLVideoElement[],
  elapsed: number,
  subCfg: SubtitleConfig,
): { activeIndex: number; localElapsed: number } {
  let cursor = 0;
  let activeIndex = 0;
  for (let i = 0; i < project.scenes.length; i += 1) {
    if (elapsed < cursor + project.scenes[i].duration || i === project.scenes.length - 1) {
      activeIndex = i;
      break;
    }
    cursor += project.scenes[i].duration;
  }
  const activeScene = project.scenes[activeIndex];
  const localElapsed = Math.max(0, elapsed - cursor);

  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, w, h);
  drawClip(ctx, videos[activeIndex], w, h, activeScene.fitMode ?? 'cover');

  const transDur = clampTransitionDuration(activeScene.transitionDuration);
  const remaining = activeScene.duration - localElapsed;
  if (activeIndex < project.scenes.length - 1 && remaining < transDur && activeScene.transition !== 'cut') {
    const k = Math.min(1, Math.max(0, (transDur - remaining) / transDur));
    const nextScene = project.scenes[activeIndex + 1];
    const next = videos[activeIndex + 1];
    if (next.readyState >= 2) {
      if (activeScene.transition === 'fade') {
        ctx.fillStyle = `rgba(5, 7, 13, ${k < 0.5 ? k * 2 : (1 - k) * 2})`;
        if (k >= 0.5) drawClip(ctx, next, w, h, nextScene.fitMode ?? 'cover', (k - 0.5) * 2);
        else ctx.fillRect(0, 0, w, h);
      } else {
        const offset = activeScene.transition === 'slide' ? w * (1 - k) : 0;
        drawClip(ctx, next, w, h, nextScene.fitMode ?? 'cover', k, offset);
      }
    }
  }

  if (project.subtitlesEnabled && activeScene.subtitle.trim()) {
    const subStart = activeScene.subtitleStart ?? 0;
    const subEnd = activeScene.subtitleEnd ?? activeScene.duration;
    if (localElapsed >= subStart && localElapsed <= subEnd) {
      drawSubtitle(ctx, activeScene.subtitle, w, h, subCfg);
    }
  }

  return { activeIndex, localElapsed };
}

async function preloadVideoElement(url: string, label: string, signal?: AbortSignal): Promise<HTMLVideoElement> {
  throwIfAborted(signal);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanupListeners();
      reject(new RenderError('Export interrompu.', 'ABORTED'));
    };
    const timer = setTimeout(() => {
      cleanupListeners();
      reject(new RenderError(`Délai de chargement dépassé pour « ${label} ».`, 'MEDIA_LOAD_ERROR'));
    }, 15000);
    const onReady = () => {
      cleanupListeners();
      resolve();
    };
    const onErr = () => {
      cleanupListeners();
      reject(new RenderError(`Média illisible pour « ${label} ». Vérifiez le fichier ou CORS.`, 'MEDIA_LOAD_ERROR'));
    };
    const cleanupListeners = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
    };
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onErr, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return video;
}

async function seekVideoExact(video: HTMLVideoElement, targetTime: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.02) : targetTime;
  const clamped = Math.min(Math.max(0, targetTime), maxTime);
  if (Math.abs(video.currentTime - clamped) < 0.004 && video.readyState >= 2) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new RenderError('Export interrompu.', 'ABORTED')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new RenderError('Erreur de décodage pendant la lecture image par image.', 'DECODE_ERROR')); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onErr);
      signal?.removeEventListener('abort', onAbort);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onErr, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      video.currentTime = clamped;
    } catch {
      cleanup();
      resolve();
    }
  });
}

async function encodeAudioBufferChunks(
  audioEncoder: AudioEncoder,
  buffer: AudioBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const sampleRate = buffer.sampleRate;
  const numChannels = Math.min(2, buffer.numberOfChannels);
  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;
  const chunkFrames = 1024;
  const totalFrames = buffer.length;

  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    throwIfAborted(signal);
    const count = Math.min(chunkFrames, totalFrames - offset);
    const planar = new Float32Array(count * 2);
    planar.set(left.subarray(offset, offset + count), 0);
    planar.set(right.subarray(offset, offset + count), count);

    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: count,
      numberOfChannels: 2,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    try {
      while (audioEncoder.encodeQueueSize > 16) {
        await new Promise((r) => setTimeout(r, 4));
        throwIfAborted(signal);
      }
      audioEncoder.encode(audioData);
    } finally {
      audioData.close();
    }
  }
}

async function renderWithWebCodecs(
  project: EditorProject,
  settings: ExportSettings,
  plan: ReturnType<typeof resolveExportPlan>,
  caps: ExportCapabilities,
  options: RenderOptions,
): Promise<RenderResult> {
  const fps = settings.fps;
  const durationSeconds = totalDuration(project);
  const totalFrames = Math.max(1, Math.round(durationSeconds * fps));
  const subCfg = effectiveSubtitleConfig(project);
  const isMp4 = plan.container === 'mp4';
  const profile = isMp4 ? caps.mp4Profile : caps.webmProfile;

  if (!profile.supported || !profile.videoCodec || typeof VideoEncoder !== 'function') {
    throw new RenderError('Profil WebCodecs indisponible pour ce format.', 'CODEC_UNSUPPORTED');
  }

  // Re-probe exact codec string at exact target dimensions for safety (especially 4K).
  const candidateCodecs = isMp4
    ? [profile.videoCodec, 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4D4028', 'avc1.42001E']
    : [profile.videoCodec, 'vp09.00.31.08', 'vp09.00.10.08'];
  let activeVideoCodec: string | null = null;
  for (const c of candidateCodecs) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: c,
        width: plan.width,
        height: plan.height,
        framerate: fps,
        bitrate: plan.videoBitsPerSecond,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (support?.supported) { activeVideoCodec = c; break; }
    } catch { /* try next */ }
  }
  if (!activeVideoCodec) {
    throw new RenderError(
      `Encodeur WebCodecs non supporté pour ${plan.width}×${plan.height} (${settings.resolution}).`,
      'CODEC_UNSUPPORTED',
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RenderError('Contexte Canvas 2D indisponible.', 'ENCODER_ERROR');

  const videos: HTMLVideoElement[] = [];
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let encoderFailure: Error | null = null;
  const diagnostics: string[] = [];

  const notify = (phase: ExportPhase, ratio: number, label: string) => {
    options.onStage?.(phase, ratio, label);
    options.onProgress?.(ratio, label);
  };

  try {
    notify('preparing', 0.04, 'Chargement et vérification des clips…');
    for (let i = 0; i < project.scenes.length; i += 1) {
      const sc = project.scenes[i];
      const v = await preloadVideoElement(sc.source.url ?? '', sc.label, options.signal);
      videos.push(v);
    }

    notify('preparing', 0.14, 'Mixage audio haute précision…');
    const audioSampleRate = 48000;
    const canEncodeAudio = Boolean(profile.audioCodec && profile.muxerAudioCodec && typeof AudioEncoder !== 'undefined');
    const mixedAudio = canEncodeAudio
      ? await mixProjectAudioOffline(project, audioSampleRate, options.signal)
      : { buffer: null, hasAudio: false, sampleRate: audioSampleRate, diagnostics: [] };
    diagnostics.push(...mixedAudio.diagnostics);
    const includeAudio = Boolean(canEncodeAudio && mixedAudio.hasAudio && mixedAudio.buffer);

    let mp4Muxer: Mp4Muxer<Mp4ArrayBufferTarget> | null = null;
    let webmMuxer: WebmMuxer<WebmArrayBufferTarget> | null = null;
    const mp4Target = isMp4 ? new Mp4ArrayBufferTarget() : null;
    const webmTarget = !isMp4 ? new WebmArrayBufferTarget() : null;

    if (isMp4 && mp4Target) {
      mp4Muxer = new Mp4Muxer({
        target: mp4Target,
        video: {
          codec: 'avc',
          width: plan.width,
          height: plan.height,
          frameRate: fps,
        },
        ...(includeAudio && profile.muxerAudioCodec ? {
          audio: {
            codec: profile.muxerAudioCodec,
            numberOfChannels: 2,
            sampleRate: audioSampleRate,
          },
        } : {}),
        fastStart: 'in-memory',
      });
    } else if (webmTarget) {
      webmMuxer = new WebmMuxer({
        target: webmTarget,
        video: {
          codec: 'V_VP9',
          width: plan.width,
          height: plan.height,
          frameRate: fps,
        },
        ...(includeAudio ? {
          audio: {
            codec: 'A_OPUS',
            numberOfChannels: 2,
            sampleRate: audioSampleRate,
          },
        } : {}),
      });
    }

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
        else if (webmMuxer) webmMuxer.addVideoChunk(chunk, meta);
      },
      error: (err) => {
        encoderFailure = new RenderError(`Erreur encodeur vidéo : ${err.message}`, 'ENCODER_ERROR');
      },
    });
    videoEncoder.configure({
      codec: activeVideoCodec,
      width: plan.width,
      height: plan.height,
      bitrate: plan.videoBitsPerSecond,
      framerate: fps,
      ...(isMp4 ? { avc: { format: 'avc' as const } } : {}),
    });

    if (includeAudio && profile.audioCodec) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (mp4Muxer) mp4Muxer.addAudioChunk(chunk, meta);
          else if (webmMuxer) webmMuxer.addAudioChunk(chunk, meta);
        },
        error: (err) => {
          encoderFailure = new RenderError(`Erreur encodeur audio : ${err.message}`, 'ENCODER_ERROR');
        },
      });
      audioEncoder.configure({
        codec: profile.audioCodec,
        numberOfChannels: 2,
        sampleRate: audioSampleRate,
        bitrate: plan.audioBitsPerSecond,
      });
    }

    // Frame-by-frame deterministic encoding
    const frameDurationUs = Math.round(1_000_000 / fps);
    const keyInterval = fps * 2;

    for (let f = 0; f < totalFrames; f += 1) {
      throwIfAborted(options.signal);
      if (encoderFailure) throw encoderFailure;

      const elapsed = f / fps;
      // Locate scene + local time before drawing so we only seek active (and transitioning) clips
      let cursor = 0;
      let activeIdx = 0;
      for (let i = 0; i < project.scenes.length; i += 1) {
        if (elapsed < cursor + project.scenes[i].duration || i === project.scenes.length - 1) {
          activeIdx = i;
          break;
        }
        cursor += project.scenes[i].duration;
      }
      const sc = project.scenes[activeIdx];
      const localElapsed = Math.max(0, elapsed - cursor);
      await seekVideoExact(videos[activeIdx], (sc.trimStart ?? 0) + localElapsed, options.signal);

      const transDur = clampTransitionDuration(sc.transitionDuration);
      const remaining = sc.duration - localElapsed;
      if (activeIdx < project.scenes.length - 1 && remaining < transDur && sc.transition !== 'cut') {
        const nextSc = project.scenes[activeIdx + 1];
        const nextLocal = Math.max(0, transDur - remaining);
        await seekVideoExact(videos[activeIdx + 1], (nextSc.trimStart ?? 0) + nextLocal, options.signal);
      }

      renderCompositeFrame(ctx, plan.width, plan.height, project, videos, elapsed, subCfg);

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((f * 1_000_000) / fps),
        duration: frameDurationUs,
      });
      try {
        while (videoEncoder.encodeQueueSize > 8) {
          await new Promise((r) => setTimeout(r, 4));
          throwIfAborted(options.signal);
          if (encoderFailure) throw encoderFailure;
        }
        videoEncoder.encode(frame, { keyFrame: f % keyInterval === 0 });
      } finally {
        frame.close();
      }

      if (f % Math.max(1, Math.round(fps / 4)) === 0 || f === totalFrames - 1) {
        const videoProgress = 0.18 + (0.70 * (f + 1)) / totalFrames;
        notify('rendering', videoProgress, `Rendu · plan ${activeIdx + 1}/${project.scenes.length} · image ${f + 1}/${totalFrames}`);
        // Yield to UI so progress bar & Abort button stay responsive
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    notify('finalizing', 0.90, 'Encodage audio & assemblage du conteneur…');
    if (audioEncoder && mixedAudio.buffer) {
      await encodeAudioBufferChunks(audioEncoder, mixedAudio.buffer, options.signal);
      await audioEncoder.flush();
    }
    await videoEncoder.flush();
    if (encoderFailure) throw encoderFailure;

    mp4Muxer?.finalize();
    webmMuxer?.finalize();
    const outBuffer = mp4Target?.buffer ?? webmTarget?.buffer;
    if (!outBuffer) {
      throw new RenderError('Aucun flux finalisé par le multiplexeur.', 'OUTPUT_INVALID');
    }

    const blob = new Blob([outBuffer], { type: isMp4 ? 'video/mp4' : 'video/webm' });
    const verification = await verifyVideoBlob(blob, isMp4 ? 'mp4' : 'webm');
    if (!verification.valid) {
      throw new RenderError(verification.reason || 'Le fichier vidéo exporté est invalide.', 'OUTPUT_INVALID');
    }

    notify('succeeded', 1, 'Fichier vidéo vérifié et prêt.');
    return {
      blob,
      mimeType: isMp4 ? 'video/mp4' : 'video/webm',
      container: isMp4 ? 'mp4' : 'webm',
      engine: 'webcodecs',
      durationSeconds,
      audioMixed: includeAudio,
      width: plan.width,
      height: plan.height,
      fps,
      diagnostics,
    };
  } finally {
    try { if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close(); } catch { /* ignore */ }
    try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch { /* ignore */ }
    for (const v of videos) {
      try { v.pause(); } catch { /* ignore */ }
      v.removeAttribute('src');
      v.load();
    }
  }
}

interface LoadedMedia { video: HTMLVideoElement; sourceNode: MediaElementAudioSourceNode | null; gainNode: GainNode | null }
interface LoadedAudio {
  el: HTMLAudioElement;
  gainNode: GainNode | null;
  baseVolume: number;
  startAt: number;
  trimStart: number;
}

async function renderWithMediaRecorder(
  project: EditorProject,
  settings: ExportSettings,
  plan: ReturnType<typeof resolveExportPlan>,
  options: RenderOptions,
): Promise<RenderResult> {
  if (!plan.mimeType) {
    throw new RenderError('Aucun conteneur MediaRecorder disponible.', 'CODEC_UNSUPPORTED');
  }

  const fps = settings.fps;
  const durationSeconds = totalDuration(project);
  const subCfg = effectiveSubtitleConfig(project);
  const voiceoverTrack = effectiveVoiceover(project);

  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new RenderError('Contexte Canvas 2D indisponible.', 'ENCODER_ERROR');

  const media: LoadedMedia[] = [];
  const audioTracks: { music?: LoadedAudio; voiceover?: LoadedAudio } = {};
  let audioCtx: AudioContext | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let recorder: MediaRecorder | null = null;
  let frameId = 0;
  let stream: MediaStream | null = null;
  let finished = false;
  const diagnostics: string[] = [];

  const notify = (phase: ExportPhase, ratio: number, label: string) => {
    options.onStage?.(phase, ratio, label);
    options.onProgress?.(ratio, label);
  };

  const cleanup = () => {
    if (frameId) cancelAnimationFrame(frameId);
    for (const m of media) {
      try { m.video.pause(); m.sourceNode?.disconnect(); } catch { /* released */ }
      m.video.removeAttribute('src');
      m.video.load();
    }
    for (const track of [audioTracks.music, audioTracks.voiceover]) {
      if (!track) continue;
      try { track.el.pause(); track.gainNode?.disconnect(); } catch { /* released */ }
      track.el.removeAttribute('src');
      track.el.load();
    }
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    void audioCtx?.close().catch(() => undefined);
  };

  try {
    notify('preparing', 0.05, 'Chargement des médias…');
    for (const scene of project.scenes) {
      const video = await preloadVideoElement(scene.source.url ?? '', scene.label, options.signal);
      media.push({ video, sourceNode: null, gainNode: null });
      const maxStart = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : 0;
      video.currentTime = Math.min(scene.trimStart, maxStart);
    }

    const AudioCtor = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (AudioCtor) {
      try {
        audioCtx = new AudioCtor();
        await audioCtx.resume().catch(() => undefined);
        audioDest = audioCtx.createMediaStreamDestination();
        for (let i = 0; i < media.length; i += 1) {
          const m = media[i];
          const sc = project.scenes[i];
          try {
            const node = audioCtx.createMediaElementSource(m.video);
            const gain = audioCtx.createGain();
            const clipVol = sc.muted ? 0 : (sc.volume ?? 1);
            gain.gain.value = !project.audio || project.audio.kind === 'none' ? clipVol : clipVol * 0.72;
            node.connect(gain).connect(audioDest);
            m.sourceNode = node;
            m.gainNode = gain;
          } catch {
            diagnostics.push(`Piste audio du clip « ${sc.label} » exclue (CORS).`);
          }
        }
      } catch { audioCtx = null; audioDest = null; }
    }

    const loadAudioTrack = async (track: typeof project.audio | undefined, label: string): Promise<LoadedAudio | undefined> => {
      if (!track || track.kind === 'none' || !track.url || track.muted || !audioCtx || !audioDest) return undefined;
      try {
        const el = document.createElement('audio');
        el.crossOrigin = 'anonymous';
        el.src = track.url;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 4000);
          el.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
          el.addEventListener('error', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        const node = audioCtx.createMediaElementSource(el);
        const gain = audioCtx.createGain();
        gain.gain.value = track.volume;
        node.connect(gain).connect(audioDest);
        return {
          el, gainNode: gain, baseVolume: track.volume,
          startAt: Math.max(0, track.startAt ?? 0),
          trimStart: Math.max(0, track.trimStart ?? 0),
        };
      } catch {
        diagnostics.push(`Piste audio « ${label} » non mixée (CORS ou format).`);
        return undefined;
      }
    };

    audioTracks.music = await loadAudioTrack(project.audio, project.audio?.name || 'Musique');
    audioTracks.voiceover = await loadAudioTrack(voiceoverTrack, voiceoverTrack?.name || 'Voix off');

    stream = canvas.captureStream(fps);
    if (audioDest) for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track);

    const chunks: BlobPart[] = [];
    recorder = new MediaRecorder(stream, {
      mimeType: plan.mimeType,
      videoBitsPerSecond: plan.videoBitsPerSecond,
      audioBitsPerSecond: plan.audioBitsPerSecond,
    });
    const done = new Promise<Blob>((resolve, reject) => {
      recorder!.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder!.onerror = () => reject(new RenderError('Erreur de l’encodeur MediaRecorder.', 'ENCODER_ERROR'));
      recorder!.onstop = () => resolve(new Blob(chunks, { type: plan.mimeType! }));
    });
    recorder.start(400);

    const videos = media.map((m) => m.video);
    await new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const onAbort = () => {
        finished = true;
        reject(new RenderError('Export interrompu par l’utilisateur. Votre montage reste intact.', 'ABORTED'));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const syncAudio = (track: LoadedAudio | undefined, elapsed: number, duckFactor = 1) => {
        if (!track) return;
        const localTime = elapsed - track.startAt;
        if (localTime < 0) {
          if (!track.el.paused) track.el.pause();
          return;
        }
        const targetTime = track.trimStart + localTime;
        if (Number.isFinite(track.el.duration) && targetTime >= track.el.duration) {
          if (!track.el.paused) track.el.pause();
          return;
        }
        if (track.gainNode && audioCtx) {
          track.gainNode.gain.setTargetAtTime(track.baseVolume * duckFactor, audioCtx.currentTime, 0.04);
        }
        if (Math.abs(track.el.currentTime - targetTime) > 0.3) {
          try { track.el.currentTime = targetTime; } catch { /* seek race */ }
        }
        if (track.el.paused) {
          try { void Promise.resolve(track.el.play()).catch(() => undefined); } catch { /* ignore */ }
        }
      };

      const step = (now: number) => {
        if (finished) return;
        const elapsed = (now - started) / 1000;
        if (options.signal?.aborted) { onAbort(); return; }

        const { activeIndex, localElapsed } = renderCompositeFrame(
          ctx, plan.width, plan.height, project, videos, elapsed, subCfg,
        );
        const activeScene = project.scenes[activeIndex];

        const voiceActive = Boolean(
          audioTracks.voiceover
          && elapsed >= audioTracks.voiceover.startAt
          && (!Number.isFinite(audioTracks.voiceover.el.duration)
            || audioTracks.voiceover.trimStart + (elapsed - audioTracks.voiceover.startAt) < audioTracks.voiceover.el.duration),
        );
        syncAudio(audioTracks.voiceover, elapsed, 1);
        syncAudio(audioTracks.music, elapsed, project.audioDucking !== false && voiceActive ? DUCKING_FACTOR : 1);

        media.forEach((m, i) => {
          if (i === activeIndex) {
            const expected = Math.min(activeScene.trimStart + localElapsed, Math.max(0, (m.video.duration || 0) - 0.05));
            if (Math.abs(m.video.currentTime - expected) > 0.35) {
              try { m.video.currentTime = expected; } catch { /* seek race */ }
            }
            if (m.video.paused) {
              try { void Promise.resolve(m.video.play()).catch(() => undefined); } catch { /* ignore */ }
            }
          } else if (!m.video.paused) m.video.pause();
        });

        notify(
          'rendering',
          0.12 + 0.80 * Math.min(1, elapsed / Math.max(0.1, durationSeconds)),
          `Rendu temps réel · plan ${activeIndex + 1}/${project.scenes.length}`,
        );
        if (elapsed >= durationSeconds) {
          finished = true;
          notify('finalizing', 0.94, 'Finalisation du fichier vidéo…');
          recorder!.stop();
          resolve();
          return;
        }
        frameId = requestAnimationFrame(step);
      };
      frameId = requestAnimationFrame(step);
    });

    const blob = await done;
    const verification = await verifyVideoBlob(blob, plan.container);
    if (!verification.valid) {
      throw new RenderError(verification.reason || 'Le fichier rendu est vide ou invalide.', 'OUTPUT_INVALID');
    }

    notify('succeeded', 1, 'Fichier vidéo vérifié et prêt.');
    return {
      blob,
      mimeType: plan.mimeType,
      container: plan.container ?? (plan.mimeType.includes('mp4') ? 'mp4' : 'webm'),
      engine: 'mediarecorder',
      durationSeconds,
      audioMixed: Boolean(audioDest),
      width: plan.width,
      height: plan.height,
      fps,
      diagnostics,
    };
  } finally {
    cleanup();
  }
}

/**
 * Primary Phase 4 export entrypoint.
 * Chooses the best genuinely supported engine (WebCodecs MP4/WebM or MediaRecorder)
 * for the requested format, resolution, fps & quality, and never simulates success.
 */
export async function renderVideo(project: EditorProject, options: RenderOptions = {}): Promise<RenderResult> {
  const issues = renderIssues(project);
  if (issues.length) throw new RenderError(issues.join(' '), 'INVALID_PROJECT');
  throwIfAborted(options.signal);

  const settings: ExportSettings = options.settings ?? {
    ...DEFAULT_EXPORT_SETTINGS,
    fps: options.fps === 24 ? 24 : 30,
  };
  const caps = await probeExportCapabilities(project.aspect, settings.fps);
  const plan = resolveExportPlan(project.aspect, settings, caps);

  if (!plan.allowed || plan.engine === 'unavailable') {
    throw new RenderError(
      plan.reason || caps.reasons.join(' ') || 'Encodage vidéo indisponible dans cet environnement.',
      'CODEC_UNSUPPORTED',
    );
  }

  if (plan.engine === 'webcodecs') {
    return renderWithWebCodecs(project, settings, plan, caps, options);
  }
  return renderWithMediaRecorder(project, settings, plan, options);
}

/** Backwards-compatible alias kept for Phase 3 callers & tests. */
export async function renderProject(project: EditorProject, options: RenderOptions = {}): Promise<RenderResult> {
  return renderVideo(project, options);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function exportFilename(project: EditorProject, mimeType: string): string {
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const slug = project.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'reelora-montage';
  return `${slug}-${project.aspect.replace(':', 'x')}.${ext}`;
}

function formatSrtTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.round((safe % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Pure deterministic SubRip (.srt) subtitle file generator. */
export function buildSrt(project: EditorProject): string {
  const spans = subtitleSpans(project);
  return spans.map((span, idx) =>
    `${idx + 1}\n${formatSrtTime(span.start)} --> ${formatSrtTime(span.end)}\n${span.text}`,
  ).join('\n\n');
}
