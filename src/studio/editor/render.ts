/**
 * REAL browser-side video compositor for the Reelora AI Video Editor.
 *
 * It is not a mock: it draws every frame onto a canvas, mixes clip audio,
 * voiceover and background music through Web Audio, encodes with MediaRecorder
 * and returns an actual playable Blob that the user can download. It runs
 * entirely in the browser so NO Edge Function redeploy, NO new table and NO RLS
 * change are required.
 *
 * Known, explicit limitations (also surfaced in the UI):
 *  - container is WebM/MP4 depending on MediaRecorder support (no server transcode);
 *  - render happens in real time (a 20 s timeline takes ~20 s);
 *  - the tab must stay open; remote media must allow CORS or canvas is tainted;
 *  - there is no server render queue; "reprendre" replays the saved project.
 */

import { subtitleSpans } from './assist';
import {
  ASPECT_PRESETS, clampTransitionDuration, effectiveSubtitleConfig, effectiveVoiceover,
  totalDuration, type EditorProject, type FitMode, type SubtitleConfig,
} from './types';

export const RENDER_LIMITATIONS = [
  'Encodage navigateur (WebM/MP4 selon MediaRecorder) : pas de transcodage serveur.',
  'Rendu en temps réel : un montage de 20 s demande environ 20 s, onglet ouvert.',
  'Les médias distants doivent autoriser CORS, sinon le canvas est protégé et le rendu est refusé.',
  'Aucune file de rendu serveur : « reprendre » relance le rendu depuis le projet sauvegardé.',
];

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

const CANDIDATE_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

export function supportedMimeType(): string | null {
  const w = globalThis as unknown as {
    MediaRecorder?: { isTypeSupported?: (t: string) => boolean };
  };
  if (typeof w.MediaRecorder === 'undefined' || typeof w.MediaRecorder.isTypeSupported !== 'function') return null;
  return CANDIDATE_MIMES.find((m) => w.MediaRecorder!.isTypeSupported!(m)) ?? null;
}

export interface ExportCapabilities {
  supported: boolean;
  mimeType: string | null;
  hasMediaRecorder: boolean;
  hasCaptureStream: boolean;
  hasAudioContext: boolean;
  reasons: string[];
}

/**
 * Inspect real browser encoding capabilities before allowing export.
 * Never claims export is available when MediaRecorder or captureStream is absent.
 */
export function exportCapabilities(): ExportCapabilities {
  const g = globalThis as unknown as {
    MediaRecorder?: unknown;
    AudioContext?: unknown;
    HTMLCanvasElement?: { prototype?: { captureStream?: unknown } };
  };
  const mimeType = supportedMimeType();
  const hasMediaRecorder = typeof g.MediaRecorder !== 'undefined' && mimeType !== null;
  const hasCaptureStream = typeof g.HTMLCanvasElement?.prototype?.captureStream === 'function';
  const hasAudioContext = typeof g.AudioContext === 'function';
  const reasons: string[] = [];
  if (!hasMediaRecorder) reasons.push('MediaRecorder vidéo non supporté par ce navigateur.');
  if (!hasCaptureStream) reasons.push('canvas.captureStream() indisponible dans cet environnement.');
  return {
    supported: hasMediaRecorder && hasCaptureStream,
    mimeType,
    hasMediaRecorder,
    hasCaptureStream,
    hasAudioContext,
    reasons,
  };
}

export interface RenderOptions {
  fps?: number;
  onProgress?: (ratio: number, label: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  audioMixed: boolean;
  width: number;
  height: number;
}

interface LoadedMedia { video: HTMLVideoElement; sourceNode: MediaElementAudioSourceNode | null; gainNode: GainNode | null }
interface LoadedAudio {
  el: HTMLAudioElement;
  gainNode: GainNode | null;
  baseVolume: number;
  startAt: number;
  trimStart: number;
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
  const boxH = shown.length * lineHeight + 22;
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
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#ffffff';
  shown.forEach((l, i) => {
    const y = boxY + 11 + lineHeight * (i + 0.5);
    if (cfg.style === 'outline') {
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.strokeText(l, w / 2, y);
    }
    ctx.fillText(l, w / 2, y);
  });
}

/** Encode the saved project into a real media file. */
export async function renderProject(project: EditorProject, options: RenderOptions = {}): Promise<RenderResult> {
  const issues = renderIssues(project);
  if (issues.length) throw new Error(issues.join(' '));
  const caps = exportCapabilities();
  if (!caps.supported || !caps.mimeType) {
    throw new Error(caps.reasons.join(' ') || 'Encodage vidéo indisponible dans ce navigateur.');
  }
  if (options.signal?.aborted) throw new DOMException('Rendu interrompu.', 'AbortError');

  const mimeType = caps.mimeType;
  const fps = Math.min(60, Math.max(12, options.fps ?? 30));
  const preset = ASPECT_PRESETS[project.aspect];
  const durationSeconds = totalDuration(project);
  const subCfg = effectiveSubtitleConfig(project);
  const voiceoverTrack = effectiveVoiceover(project);
  const canvas = document.createElement('canvas');
  canvas.width = preset.width;
  canvas.height = preset.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D indisponible : rendu impossible.');

  const media: LoadedMedia[] = [];
  const audioTracks: { music?: LoadedAudio; voiceover?: LoadedAudio } = {};
  let audioCtx: AudioContext | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let recorder: MediaRecorder | null = null;
  let frameId = 0;
  let stream: MediaStream | null = null;
  let finished = false;

  const cleanup = () => {
    if (frameId) cancelAnimationFrame(frameId);
    for (const m of media) {
      try { m.video.pause(); m.sourceNode?.disconnect(); } catch { /* already released */ }
      m.video.removeAttribute('src');
      m.video.load();
    }
    for (const track of [audioTracks.music, audioTracks.voiceover]) {
      if (!track) continue;
      try { track.el.pause(); track.gainNode?.disconnect(); } catch { /* already released */ }
      track.el.removeAttribute('src');
      track.el.load();
    }
    if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* ignore */ } }
    if (stream) for (const t of stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
    void audioCtx?.close().catch(() => undefined);
  };

  try {
    // Preload every real source; a failure is explicit, never replaced by a fake clip.
    for (const scene of project.scenes) {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = scene.source.url ?? '';
      media.push({ video, sourceNode: null, gainNode: null });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Délai de chargement dépassé pour « ${scene.label} ». Utilisez un fichier local ou une création Reelora accessible.`)), 15000);
        video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`Média illisible pour « ${scene.label} ». Vérifiez le fichier ou les autorisations CORS.`)); }, { once: true });
      });
      const maxStart = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : 0;
      video.currentTime = Math.min(scene.trimStart, maxStart);
    }

    // Web Audio mixing of real clip audio + optional music + optional voiceover.
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
            gain.gain.value = project.audio.kind === 'none' ? clipVol : clipVol * 0.7;
            node.connect(gain).connect(audioDest);
            m.sourceNode = node;
            m.gainNode = gain;
          } catch { /* CORS-tainted media: video only, explicitly tolerated */ }
        }
      } catch { audioCtx = null; audioDest = null; }
    }

    const loadAudioTrack = async (track: typeof project.audio): Promise<LoadedAudio | undefined> => {
      if (track.kind === 'none' || !track.url || track.muted || !audioCtx || !audioDest) return undefined;
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
          el,
          gainNode: gain,
          baseVolume: track.volume,
          startAt: Math.max(0, track.startAt ?? 0),
          trimStart: Math.max(0, track.trimStart ?? 0),
        };
      } catch {
        return undefined;
      }
    };

    audioTracks.music = await loadAudioTrack(project.audio);
    audioTracks.voiceover = await loadAudioTrack(voiceoverTrack);

    stream = canvas.captureStream(fps);
    if (audioDest) for (const track of audioDest.stream.getAudioTracks()) stream.addTrack(track);

    const chunks: BlobPart[] = [];
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 });
    const done = new Promise<Blob>((resolve, reject) => {
      recorder!.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder!.onerror = () => reject(new Error('L’encodeur vidéo a rencontré une erreur. Reprenez le rendu depuis le projet sauvegardé.'));
      recorder!.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });
    recorder.start(500);

    await new Promise<void>((resolve, reject) => {
      const started = performance.now();
      const onAbort = () => { finished = true; reject(new DOMException('Rendu interrompu.', 'AbortError')); };
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
        if (track.gainNode) track.gainNode.gain.value = track.baseVolume * duckFactor;
        if (Math.abs(track.el.currentTime - targetTime) > 0.35) {
          try { track.el.currentTime = targetTime; } catch { /* seek race */ }
        }
        if (track.el.paused) void track.el.play().catch(() => undefined);
      };

      const step = (now: number) => {
        if (finished) return;
        const elapsed = (now - started) / 1000;
        if (options.signal?.aborted) { onAbort(); return; }
        let cursor = 0;
        let active = 0;
        for (let i = 0; i < project.scenes.length; i += 1) {
          if (elapsed < cursor + project.scenes[i].duration || i === project.scenes.length - 1) { active = i; break; }
          cursor += project.scenes[i].duration;
        }
        const activeScene = project.scenes[active];
        const localElapsed = Math.max(0, elapsed - cursor);
        const voiceActive = Boolean(
          audioTracks.voiceover
          && elapsed >= audioTracks.voiceover.startAt
          && (!Number.isFinite(audioTracks.voiceover.el.duration)
            || audioTracks.voiceover.trimStart + (elapsed - audioTracks.voiceover.startAt) < audioTracks.voiceover.el.duration),
        );
        syncAudio(audioTracks.voiceover, elapsed, 1);
        syncAudio(audioTracks.music, elapsed, project.audioDucking && voiceActive ? 0.32 : 1);

        media.forEach((m, i) => {
          if (i === active) {
            const expected = Math.min(activeScene.trimStart + localElapsed, Math.max(0, (m.video.duration || 0) - 0.05));
            if (Math.abs(m.video.currentTime - expected) > 0.4) { try { m.video.currentTime = expected; } catch { /* seek race */ } }
            if (m.video.paused) void m.video.play().catch(() => undefined);
          } else if (!m.video.paused) m.video.pause();
        });
        ctx.fillStyle = '#05070d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawClip(ctx, media[active].video, canvas.width, canvas.height, activeScene.fitMode ?? 'cover');

        // Transition over `transitionDuration` seconds, drawn from the NEXT real clip.
        const transDur = clampTransitionDuration(activeScene.transitionDuration);
        const remaining = activeScene.duration - localElapsed;
        if (active < project.scenes.length - 1 && remaining < transDur && activeScene.transition !== 'cut') {
          const k = Math.min(1, Math.max(0, (transDur - remaining) / transDur));
          const nextScene = project.scenes[active + 1];
          const next = media[active + 1].video;
          if (next.readyState >= 2) {
            if (activeScene.transition === 'fade') {
              ctx.fillStyle = `rgba(5, 7, 13, ${k < 0.5 ? k * 2 : (1 - k) * 2})`;
              if (k >= 0.5) drawClip(ctx, next, canvas.width, canvas.height, nextScene.fitMode ?? 'cover', (k - 0.5) * 2);
              else ctx.fillRect(0, 0, canvas.width, canvas.height);
            } else {
              const offset = activeScene.transition === 'slide' ? canvas.width * (1 - k) : 0;
              drawClip(ctx, next, canvas.width, canvas.height, nextScene.fitMode ?? 'cover', k, offset);
            }
          }
        }
        if (project.subtitlesEnabled && activeScene.subtitle.trim()) {
          const subStart = activeScene.subtitleStart ?? 0;
          const subEnd = activeScene.subtitleEnd ?? activeScene.duration;
          if (localElapsed >= subStart && localElapsed <= subEnd) {
            drawSubtitle(ctx, activeScene.subtitle, canvas.width, canvas.height, subCfg);
          }
        }
        options.onProgress?.(Math.min(1, elapsed / Math.max(0.1, durationSeconds)),
          `Rendu · plan ${active + 1}/${project.scenes.length}`);
        if (elapsed >= durationSeconds) { finished = true; recorder!.stop(); resolve(); return; }
        frameId = requestAnimationFrame(step);
      };
      frameId = requestAnimationFrame(step);
    });

    const blob = await done;
    if (blob.size === 0) throw new Error('Le fichier rendu est vide. Reprenez le rendu depuis le projet sauvegardé.');
    return {
      blob, mimeType, durationSeconds,
      audioMixed: Boolean(audioDest), width: canvas.width, height: canvas.height,
    };
  } catch (error) {
    throw error instanceof Error ? error : new Error('Rendu impossible.');
  } finally {
    cleanup();
  }
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
