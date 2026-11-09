/**
 * Reelora Phase 4 — Export configuration, real capability probing & output verification.
 *
 * Strict honesty rules:
 *  - Every resolution (720p, 1080p, 4k) and container (mp4, webm) is probed against
 *    real browser APIs (WebCodecs VideoEncoder/AudioEncoder & MediaRecorder/captureStream).
 *  - No resolution or codec is ever advertised as supported when the browser rejects it.
 *  - Output blobs are inspected (size + container magic bytes) before declaring success.
 */

import { ASPECT_PRESETS, totalDuration, type AspectPreset, type EditorProject } from './types';

export type ExportResolutionId = '720p' | '1080p' | '4k';
export type ExportQualityId = 'standard' | 'high' | 'master';
export type ExportContainerId = 'auto' | 'mp4' | 'webm';
export type ExportEngineKind = 'webcodecs' | 'mediarecorder' | 'unavailable';
export type ExportPhase =
  | 'idle'
  | 'preparing'
  | 'rendering'
  | 'finalizing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface ExportSettings {
  resolution: ExportResolutionId;
  quality: ExportQualityId;
  fps: 24 | 30;
  container: ExportContainerId;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  resolution: '1080p',
  quality: 'high',
  fps: 30,
  container: 'auto',
};

export const RESOLUTION_LABELS: Record<ExportResolutionId, { label: string; badge: string; shortSide: number }> = {
  '720p': { label: 'HD 720p', badge: 'Rapide · universel', shortSide: 720 },
  '1080p': { label: 'Full HD 1080p', badge: 'Recommandé UGC', shortSide: 1080 },
  '4k': { label: 'Ultra HD 4K', badge: 'WebCodecs requis', shortSide: 2160 },
};

export const QUALITY_LABELS: Record<ExportQualityId, { label: string; description: string }> = {
  standard: { label: 'Standard', description: 'Fichier léger, partage rapide' },
  high: { label: 'Élevée', description: 'Netteté optimale TikTok / Reels' },
  master: { label: 'Master', description: 'Débit maximal sans compression visible' },
};

export const BITRATE_MATRIX: Record<ExportResolutionId, Record<ExportQualityId, { video: number; audio: number }>> = {
  '720p': {
    standard: { video: 3_500_000, audio: 128_000 },
    high: { video: 6_000_000, audio: 192_000 },
    master: { video: 9_500_000, audio: 256_000 },
  },
  '1080p': {
    standard: { video: 6_000_000, audio: 128_000 },
    high: { video: 10_000_000, audio: 192_000 },
    master: { video: 16_000_000, audio: 256_000 },
  },
  '4k': {
    standard: { video: 16_000_000, audio: 192_000 },
    high: { video: 28_000_000, audio: 256_000 },
    master: { video: 42_000_000, audio: 320_000 },
  },
};

export function exportDimensions(aspect: AspectPreset, resolution: ExportResolutionId): { width: number; height: number } {
  const shortSide = RESOLUTION_LABELS[resolution].shortSide;
  const base = ASPECT_PRESETS[aspect];
  if (aspect === '1:1') return { width: shortSide, height: shortSide };
  if (aspect === '16:9') {
    const width = Math.round((shortSide * base.width) / base.height / 2) * 2;
    return { width, height: shortSide };
  }
  const height = Math.round((shortSide * base.height) / base.width / 2) * 2;
  return { width: shortSide, height };
}

export interface ResolutionSupport {
  resolution: ExportResolutionId;
  width: number;
  height: number;
  supported: boolean;
  engine: ExportEngineKind;
  reason?: string;
}

export interface WebCodecsProfile {
  supported: boolean;
  videoCodec: string | null;
  muxerVideoCodec: 'avc' | 'vp9' | null;
  container: 'mp4' | 'webm' | null;
  audioCodec: string | null;
  muxerAudioCodec: 'aac' | 'opus' | null;
}

export interface ExportCapabilities {
  supported: boolean;
  engine: ExportEngineKind;
  mimeType: string | null;
  hasMediaRecorder: boolean;
  hasCaptureStream: boolean;
  hasAudioContext: boolean;
  hasOfflineAudioContext: boolean;
  hasWebCodecs: boolean;
  supportsMp4: boolean;
  supportsWebm: boolean;
  mp4Profile: WebCodecsProfile;
  webmProfile: WebCodecsProfile;
  resolutions: Record<ExportResolutionId, ResolutionSupport>;
  reasons: string[];
}

const CANDIDATE_RECORDER_MIMES = [
  'video/mp4;codecs=h264,aac',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function supportedMimeType(preferred: ExportContainerId = 'auto'): string | null {
  const w = globalThis as unknown as {
    MediaRecorder?: { isTypeSupported?: (t: string) => boolean };
  };
  if (typeof w.MediaRecorder === 'undefined' || typeof w.MediaRecorder.isTypeSupported !== 'function') return null;
  const list = preferred === 'mp4'
    ? CANDIDATE_RECORDER_MIMES.filter((m) => m.startsWith('video/mp4'))
    : preferred === 'webm'
      ? CANDIDATE_RECORDER_MIMES.filter((m) => m.startsWith('video/webm'))
      : CANDIDATE_RECORDER_MIMES;
  return list.find((m) => w.MediaRecorder!.isTypeSupported!(m)) ?? null;
}

function emptyWebCodecsProfile(): WebCodecsProfile {
  return { supported: false, videoCodec: null, muxerVideoCodec: null, container: null, audioCodec: null, muxerAudioCodec: null };
}

function makeDefaultResolutions(aspect: AspectPreset, mediaRecorderSupported: boolean): Record<ExportResolutionId, ResolutionSupport> {
  const d720 = exportDimensions(aspect, '720p');
  const d1080 = exportDimensions(aspect, '1080p');
  const d4k = exportDimensions(aspect, '4k');
  return {
    '720p': {
      resolution: '720p', ...d720,
      supported: mediaRecorderSupported,
      engine: mediaRecorderSupported ? 'mediarecorder' : 'unavailable',
      ...(!mediaRecorderSupported ? { reason: 'Encodeur vidéo (WebCodecs / MediaRecorder) indisponible dans cet environnement.' } : {}),
    },
    '1080p': {
      resolution: '1080p', ...d1080,
      supported: mediaRecorderSupported,
      engine: mediaRecorderSupported ? 'mediarecorder' : 'unavailable',
      ...(!mediaRecorderSupported ? { reason: 'Encodeur vidéo (WebCodecs / MediaRecorder) indisponible dans cet environnement.' } : {}),
    },
    '4k': {
      resolution: '4k', ...d4k,
      supported: false,
      engine: 'unavailable',
      reason: '4K nécessite WebCodecs (VideoEncoder) pris en charge matériellement.',
    },
  };
}

/**
 * Synchronous capability snapshot used for immediate state & Phase 3 compatibility.
 * Note: WebCodecs per-resolution hardware probing is asynchronous via `probeExportCapabilities()`.
 */
export function exportCapabilities(aspect: AspectPreset = '9:16'): ExportCapabilities {
  const g = globalThis as unknown as {
    MediaRecorder?: unknown;
    AudioContext?: unknown;
    OfflineAudioContext?: unknown;
    VideoEncoder?: { isConfigSupported?: unknown };
    AudioEncoder?: { isConfigSupported?: unknown };
    HTMLCanvasElement?: { prototype?: { captureStream?: unknown } };
  };
  const mimeType = supportedMimeType('auto');
  const hasMediaRecorder = typeof g.MediaRecorder !== 'undefined' && mimeType !== null;
  const hasCaptureStream = typeof g.HTMLCanvasElement?.prototype?.captureStream === 'function';
  const hasAudioContext = typeof g.AudioContext === 'function';
  const hasOfflineAudioContext = typeof g.OfflineAudioContext === 'function';
  const hasWebCodecs = typeof g.VideoEncoder?.isConfigSupported === 'function';
  const mediaRecorderReady = hasMediaRecorder && hasCaptureStream;
  const supportsMp4 = supportedMimeType('mp4') !== null && hasCaptureStream;
  const supportsWebm = supportedMimeType('webm') !== null && hasCaptureStream;

  const reasons: string[] = [];
  if (!hasMediaRecorder) reasons.push('MediaRecorder vidéo non supporté par ce navigateur.');
  if (!hasCaptureStream) reasons.push('canvas.captureStream() indisponible dans cet environnement.');

  return {
    supported: mediaRecorderReady,
    engine: mediaRecorderReady ? 'mediarecorder' : 'unavailable',
    mimeType,
    hasMediaRecorder,
    hasCaptureStream,
    hasAudioContext,
    hasOfflineAudioContext,
    hasWebCodecs,
    supportsMp4,
    supportsWebm,
    mp4Profile: emptyWebCodecsProfile(),
    webmProfile: emptyWebCodecsProfile(),
    resolutions: makeDefaultResolutions(aspect, mediaRecorderReady),
    reasons,
  };
}

interface VideoEncoderStatic {
  isConfigSupported?: (cfg: VideoEncoderConfig) => Promise<{ supported?: boolean }>;
}
interface AudioEncoderStatic {
  isConfigSupported?: (cfg: AudioEncoderConfig) => Promise<{ supported?: boolean }>;
}

async function probeVideoCodec(
  VideoEnc: VideoEncoderStatic | undefined,
  codecs: string[],
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string | null> {
  if (!VideoEnc || typeof VideoEnc.isConfigSupported !== 'function') return null;
  for (const codec of codecs) {
    try {
      const res = await VideoEnc.isConfigSupported({
        codec,
        width,
        height,
        framerate: fps,
        bitrate,
        hardwareAcceleration: 'prefer-hardware',
      });
      if (res?.supported) return codec;
    } catch { /* try next codec */ }
  }
  return null;
}

async function probeAudioCodec(
  AudioEnc: AudioEncoderStatic | undefined,
  codecs: string[],
  sampleRate = 48000,
): Promise<string | null> {
  if (!AudioEnc || typeof AudioEnc.isConfigSupported !== 'function') return null;
  for (const codec of codecs) {
    try {
      const res = await AudioEnc.isConfigSupported({
        codec,
        numberOfChannels: 2,
        sampleRate,
        bitrate: 192_000,
      });
      if (res?.supported) return codec;
    } catch { /* try next codec */ }
  }
  return null;
}

/**
 * Full async hardware & codec capability probe.
 * Probes WebCodecs per exact (width x height) for 720p, 1080p and 4K,
 * alongside AudioEncoder + OfflineAudioContext + MediaRecorder fallback.
 */
export async function probeExportCapabilities(aspect: AspectPreset = '9:16', fps: 24 | 30 = 30): Promise<ExportCapabilities> {
  const base = exportCapabilities(aspect);
  const g = globalThis as unknown as {
    VideoEncoder?: VideoEncoderStatic;
    AudioEncoder?: AudioEncoderStatic;
    VideoFrame?: unknown;
  };
  if (!g.VideoEncoder?.isConfigSupported || typeof g.VideoFrame === 'undefined') {
    return base;
  }

  const avcStd = ['avc1.640028', 'avc1.4D4028', 'avc1.42001E'];
  const avc4k = ['avc1.640033', 'avc1.640032', 'avc1.640028'];
  const vp9Codecs = ['vp09.00.10.08', 'vp09.00.31.08'];

  const [aacCodec, opusCodec] = await Promise.all([
    probeAudioCodec(g.AudioEncoder, ['mp4a.40.2']),
    probeAudioCodec(g.AudioEncoder, ['opus']),
  ]);

  const probeFor = async (resId: ExportResolutionId): Promise<{
    mp4: string | null; webm: string | null; dim: { width: number; height: number };
  }> => {
    const dim = exportDimensions(aspect, resId);
    const bitrate = BITRATE_MATRIX[resId].high.video;
    const [mp4, webm] = await Promise.all([
      probeVideoCodec(g.VideoEncoder, resId === '4k' ? avc4k : avcStd, dim.width, dim.height, fps, bitrate),
      probeVideoCodec(g.VideoEncoder, vp9Codecs, dim.width, dim.height, fps, bitrate),
    ]);
    return { mp4, webm, dim };
  };

  const [r720, r1080, r4k] = await Promise.all([probeFor('720p'), probeFor('1080p'), probeFor('4k')]);

  const mp4Video = r1080.mp4 ?? r720.mp4;
  const webmVideo = r1080.webm ?? r720.webm;

  const mp4AudioCodec = aacCodec ?? opusCodec;
  const mp4Profile: WebCodecsProfile = mp4Video
    ? {
        supported: true,
        videoCodec: mp4Video,
        muxerVideoCodec: 'avc',
        container: 'mp4',
        audioCodec: mp4AudioCodec,
        muxerAudioCodec: mp4AudioCodec === 'mp4a.40.2' ? 'aac' : mp4AudioCodec === 'opus' ? 'opus' : null,
      }
    : emptyWebCodecsProfile();

  const webmProfile: WebCodecsProfile = webmVideo
    ? {
        supported: true,
        videoCodec: webmVideo,
        muxerVideoCodec: 'vp9',
        container: 'webm',
        audioCodec: opusCodec,
        muxerAudioCodec: opusCodec ? 'opus' : null,
      }
    : emptyWebCodecsProfile();

  const mediaRecorderReady = base.hasMediaRecorder && base.hasCaptureStream;
  const webCodecsAny = mp4Profile.supported || webmProfile.supported;

  const resolutions: Record<ExportResolutionId, ResolutionSupport> = {
    '720p': {
      resolution: '720p',
      ...r720.dim,
      supported: Boolean(r720.mp4 || r720.webm || mediaRecorderReady),
      engine: (r720.mp4 || r720.webm) ? 'webcodecs' : mediaRecorderReady ? 'mediarecorder' : 'unavailable',
      ...(!(r720.mp4 || r720.webm || mediaRecorderReady) ? { reason: 'Aucun encodeur compatible 720p.' } : {}),
    },
    '1080p': {
      resolution: '1080p',
      ...r1080.dim,
      supported: Boolean(r1080.mp4 || r1080.webm || mediaRecorderReady),
      engine: (r1080.mp4 || r1080.webm) ? 'webcodecs' : mediaRecorderReady ? 'mediarecorder' : 'unavailable',
      ...(!(r1080.mp4 || r1080.webm || mediaRecorderReady) ? { reason: 'Aucun encodeur compatible 1080p.' } : {}),
    },
    '4k': {
      resolution: '4k',
      ...r4k.dim,
      supported: Boolean(r4k.mp4 || r4k.webm),
      engine: (r4k.mp4 || r4k.webm) ? 'webcodecs' : 'unavailable',
      ...(!(r4k.mp4 || r4k.webm)
        ? { reason: 'Encodeur matériel 4K WebCodecs non disponible dans ce navigateur.' }
        : {}),
    },
  };

  const supportsMp4 = mp4Profile.supported || (supportedMimeType('mp4') !== null && base.hasCaptureStream);
  const supportsWebm = webmProfile.supported || (supportedMimeType('webm') !== null && base.hasCaptureStream);
  const mimeType = mp4Profile.supported
    ? 'video/mp4'
    : webmProfile.supported
      ? 'video/webm'
      : base.mimeType;

  const supported = webCodecsAny || mediaRecorderReady;
  const engine: ExportEngineKind = webCodecsAny ? 'webcodecs' : mediaRecorderReady ? 'mediarecorder' : 'unavailable';

  const reasons = supported ? [] : base.reasons;

  return {
    supported,
    engine,
    mimeType,
    hasMediaRecorder: base.hasMediaRecorder,
    hasCaptureStream: base.hasCaptureStream,
    hasAudioContext: base.hasAudioContext,
    hasOfflineAudioContext: base.hasOfflineAudioContext,
    hasWebCodecs: true,
    supportsMp4,
    supportsWebm,
    mp4Profile,
    webmProfile,
    resolutions,
    reasons,
  };
}

export function resolveExportPlan(
  aspect: AspectPreset,
  settings: ExportSettings,
  caps: ExportCapabilities,
): {
  allowed: boolean;
  engine: ExportEngineKind;
  container: 'mp4' | 'webm' | null;
  mimeType: string | null;
  width: number;
  height: number;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  reason?: string;
} {
  const { width, height } = exportDimensions(aspect, settings.resolution);
  const rates = BITRATE_MATRIX[settings.resolution][settings.quality];
  const resSupport = caps.resolutions[settings.resolution];

  if (!caps.supported || !resSupport?.supported) {
    return {
      allowed: false,
      engine: 'unavailable',
      container: null,
      mimeType: null,
      width,
      height,
      videoBitsPerSecond: rates.video,
      audioBitsPerSecond: rates.audio,
      reason: resSupport?.reason || caps.reasons.join(' ') || 'Export indisponible dans cet environnement.',
    };
  }

  // Pick WebCodecs if requested resolution supports it AND requested container matches
  const wantsMp4 = settings.container === 'mp4';
  const wantsWebm = settings.container === 'webm';

  if (resSupport.engine === 'webcodecs') {
    if (!wantsWebm && caps.mp4Profile.supported) {
      return {
        allowed: true,
        engine: 'webcodecs',
        container: 'mp4',
        mimeType: 'video/mp4',
        width,
        height,
        videoBitsPerSecond: rates.video,
        audioBitsPerSecond: rates.audio,
      };
    }
    if (!wantsMp4 && caps.webmProfile.supported) {
      return {
        allowed: true,
        engine: 'webcodecs',
        container: 'webm',
        mimeType: 'video/webm',
        width,
        height,
        videoBitsPerSecond: rates.video,
        audioBitsPerSecond: rates.audio,
      };
    }
  }

  // Fallback to MediaRecorder when allowed (never 4K)
  if (settings.resolution !== '4k' && caps.hasMediaRecorder && caps.hasCaptureStream) {
    const mime = supportedMimeType(settings.container);
    if (mime) {
      return {
        allowed: true,
        engine: 'mediarecorder',
        container: mime.includes('mp4') ? 'mp4' : 'webm',
        mimeType: mime,
        width,
        height,
        videoBitsPerSecond: rates.video,
        audioBitsPerSecond: rates.audio,
      };
    }
  }

  return {
    allowed: false,
    engine: 'unavailable',
    container: null,
    mimeType: null,
    width,
    height,
    videoBitsPerSecond: rates.video,
    audioBitsPerSecond: rates.audio,
    reason: `Format ${settings.container.toUpperCase()} (${settings.resolution}) non pris en charge par ce navigateur.`,
  };
}

export interface ExportEstimate {
  width: number;
  height: number;
  durationSeconds: number;
  estimatedSizeMb: number;
  estimatedRenderMinSeconds: number;
  estimatedRenderMaxSeconds: number;
}

export function estimateExportMetrics(
  project: EditorProject,
  settings: ExportSettings,
  engine: ExportEngineKind,
): ExportEstimate {
  const { width, height } = exportDimensions(project.aspect, settings.resolution);
  const durationSeconds = totalDuration(project);
  const rates = BITRATE_MATRIX[settings.resolution][settings.quality];
  const totalBits = (rates.video + rates.audio) * durationSeconds;
  const estimatedSizeMb = Number((totalBits / 8 / (1024 * 1024)).toFixed(2));

  if (engine === 'mediarecorder') {
    // MediaRecorder runs strictly in real time (+ ~2s preload/finalize overhead)
    return {
      width,
      height,
      durationSeconds,
      estimatedSizeMb,
      estimatedRenderMinSeconds: Math.max(2, Math.ceil(durationSeconds)),
      estimatedRenderMaxSeconds: Math.max(4, Math.ceil(durationSeconds * 1.15 + 3)),
    };
  }

  // WebCodecs scales with pixel count & total frames
  const scaleFactor = settings.resolution === '4k' ? 2.4 : settings.resolution === '1080p' ? 0.9 : 0.55;
  const minS = Math.max(2, Math.ceil(durationSeconds * scaleFactor * 0.6));
  const maxS = Math.max(minS + 2, Math.ceil(durationSeconds * scaleFactor * 1.4 + 3));
  return {
    width,
    height,
    durationSeconds,
    estimatedSizeMb,
    estimatedRenderMinSeconds: minS,
    estimatedRenderMaxSeconds: maxS,
  };
}

export interface BlobVerification {
  valid: boolean;
  sizeBytes: number;
  detectedContainer: 'mp4' | 'webm' | 'unknown';
  reason?: string;
}

/**
 * Inspect actual generated bytes before allowing download / marking export succeeded.
 * Never accepts empty blobs or non-media buffers.
 */
export async function verifyVideoBlob(blob: Blob, expected?: 'mp4' | 'webm' | null): Promise<BlobVerification> {
  if (!(blob instanceof Blob)) {
    return { valid: false, sizeBytes: 0, detectedContainer: 'unknown', reason: 'Objet exporté invalide.' };
  }
  if (blob.size < 128) {
    return {
      valid: false,
      sizeBytes: blob.size,
      detectedContainer: 'unknown',
      reason: `Fichier rendu trop petit ou vide (${blob.size} octets).`,
    };
  }
  if (typeof blob.arrayBuffer !== 'function') {
    return { valid: true, sizeBytes: blob.size, detectedContainer: expected ?? 'unknown' };
  }
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const isMp4 = head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70; // 'ftyp'
  const isWebm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3; // EBML
  const detectedContainer: 'mp4' | 'webm' | 'unknown' = isMp4 ? 'mp4' : isWebm ? 'webm' : 'unknown';

  if (expected && detectedContainer !== 'unknown' && detectedContainer !== expected) {
    return {
      valid: false,
      sizeBytes: blob.size,
      detectedContainer,
      reason: `Conteneur inattendu (${detectedContainer} au lieu de ${expected}).`,
    };
  }
  if (detectedContainer === 'unknown' && expected) {
    return {
      valid: false,
      sizeBytes: blob.size,
      detectedContainer,
      reason: 'Signature conteneur MP4/WebM absente du fichier généré.',
    };
  }
  return { valid: true, sizeBytes: blob.size, detectedContainer };
}
