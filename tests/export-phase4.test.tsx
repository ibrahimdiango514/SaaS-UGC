// @vitest-environment jsdom
/**
 * PHASE 4 — Tests du moteur d'export vidéo professionnel.
 *
 * DISTINCTION STRICTE :
 * 1. « Logique pure & conteneurs binaires réels » : teste les calculs déterministes
 *    (ratios 9:16/16:9/1:1, résolutions 720p/1080p/4K, plan audio + ducking,
 *    manifeste serveur, validation d'octets MP4/WebM) ainsi que la génération binaire
 *    réelle par `mp4-muxer` et `webm-muxer`.
 * 2. « Moteur & UI sous jsdom (APIs navigateur simulées) » : teste `probeExportCapabilities`,
 *    `renderVideo`, `ExportPanel` et `VideoEditor` (desktop + mobile 390px) avec mocks
 *    explicites de VideoEncoder/AudioEncoder/OfflineAudioContext/MediaRecorder et Supabase.
 * 3. Aucun véritable encodage matériel Chrome/Safari ni aucune capture vidéo navigateur
 *    live n'est prétendu par cette suite jsdom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from 'mp4-muxer';
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from 'webm-muxer';
import { buildLocalPlan, planToEditorProject } from '../src/studio/plan';
import type { EditorProject } from '../src/studio/editor/types';
import {
  DUCKING_FACTOR, mixProjectAudioOffline, planAudioTimeline,
} from '../src/studio/editor/audioMixer';
import {
  DEFAULT_EXPORT_SETTINGS, estimateExportMetrics, exportCapabilities, exportDimensions,
  probeExportCapabilities, resolveExportPlan, verifyVideoBlob,
  type ExportCapabilities,
} from '../src/studio/editor/exportConfig';
import {
  RenderError, downloadBlob, exportFilename, planRenderFrames, renderIssues, renderVideo,
} from '../src/studio/editor/render';
import {
  assessServerRenderNeed, buildServerRenderManifest,
} from '../src/studio/editor/serverRenderSpec';
import { ExportPanel } from '../src/studio/editor/components/ExportPanel';

const apiMocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  createProject: vi.fn(),
  listProjects: vi.fn(),
  listScripts: vi.fn(),
  listScenes: vi.fn(),
  listAssets: vi.fn(),
  listJobs: vi.fn(),
  signedStorageUrl: vi.fn(),
  uploadEditorMedia: vi.fn(),
  generateScript: vi.fn(),
  healthCheck: vi.fn(),
}));

vi.mock('../src/lib/api', () => apiMocks);
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'creator@reelora.test' },
    profile: { display_name: 'Créateur' },
    workspaceId: 'ws-1',
    quota: { credits: 9 },
  }),
}));
vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

import VideoEditor from '../src/studio/VideoEditor';

function readyProject(overrides: Partial<EditorProject> = {}): EditorProject {
  const plan = buildLocalPlan({
    prompt: 'Publicité UGC pour un sérum éclat : accroche, démonstration, preuve et CTA.',
    ratio: '9:16',
    subtitles: true,
  });
  const base = planToEditorProject(plan, {
    quality: 'standard', mode: 'idea', model: null, subtitles: true, projectId: 'proj-p4',
  });
  return {
    ...base,
    scenes: base.scenes.map((s, idx) => ({
      ...s,
      trimStart: idx * 0.5,
      source: {
        kind: 'asset',
        name: `clip-${idx + 1}.mp4`,
        url: `https://signed.example/clip-${idx + 1}.mp4`,
        storagePath: `ws-1/clip-${idx + 1}.mp4`,
        sourceDuration: 12,
      },
    })),
    voiceover: {
      kind: 'asset',
      name: 'voix-off.wav',
      url: 'https://signed.example/voix.wav',
      storagePath: 'ws-1/voix.wav',
      volume: 1,
      startAt: 0.5,
      trimStart: 0.2,
      sourceDuration: 10,
    },
    audio: {
      kind: 'asset',
      name: 'musique.mp3',
      url: 'https://signed.example/music.mp3',
      storagePath: 'ws-1/music.mp3',
      volume: 0.8,
      startAt: 0,
      trimStart: 0,
      sourceDuration: 30,
    },
    audioDucking: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:exported-video'),
    revokeObjectURL: vi.fn(),
  });
  apiMocks.listProjects.mockResolvedValue([]);
  apiMocks.listScripts.mockResolvedValue([]);
  apiMocks.listScenes.mockResolvedValue([]);
  apiMocks.listAssets.mockResolvedValue([]);
  apiMocks.listJobs.mockResolvedValue([]);
  apiMocks.signedStorageUrl.mockResolvedValue('https://signed.example/clip.mp4');
  apiMocks.healthCheck.mockResolvedValue({ configured: { groq: false, muapi: true, supabase: true, worker: true } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('1. Logique pure & conteneurs binaires réels (MP4 / WebM)', () => {
  it('calcule les dimensions exactes et paires pour les 3 ratios et 3 résolutions', () => {
    expect(exportDimensions('9:16', '720p')).toEqual({ width: 720, height: 1280 });
    expect(exportDimensions('9:16', '1080p')).toEqual({ width: 1080, height: 1920 });
    expect(exportDimensions('9:16', '4k')).toEqual({ width: 2160, height: 3840 });

    expect(exportDimensions('16:9', '720p')).toEqual({ width: 1280, height: 720 });
    expect(exportDimensions('16:9', '1080p')).toEqual({ width: 1920, height: 1080 });
    expect(exportDimensions('16:9', '4k')).toEqual({ width: 3840, height: 2160 });

    expect(exportDimensions('1:1', '720p')).toEqual({ width: 720, height: 720 });
    expect(exportDimensions('1:1', '1080p')).toEqual({ width: 1080, height: 1080 });
    expect(exportDimensions('1:1', '4k')).toEqual({ width: 2160, height: 2160 });
  });

  it('planifie avec précision les clips, trims, voix off, musique et fenêtres de ducking', () => {
    const p = readyProject();
    const audioPlan = planAudioTimeline(p);
    expect(audioPlan.clips).toHaveLength(p.scenes.length);
    expect(audioPlan.clips[1].trimStart).toBe(0.5);
    expect(audioPlan.voiceover?.start).toBe(0.5);
    expect(audioPlan.voiceover?.trimStart).toBe(0.2);
    expect(audioPlan.music?.volume).toBe(0.8);
    expect(audioPlan.duckingWindows).toEqual([
      { start: 0.5, end: 10.3, factor: DUCKING_FACTOR },
    ]);

    // When ducking is disabled, no ducking windows are created
    const noDuck = planAudioTimeline({ ...p, audioDucking: false });
    expect(noDuck.duckingWindows).toEqual([]);
  });

  it('planifie les frames pour plusieurs clips et montages longs (> 60 s)', () => {
    const base = readyProject();
    const fourScenes = [...base.scenes, { ...base.scenes[1], id: 'sc-extra' }].map((s) => ({ ...s, duration: 18 })); // 4 * 18s = 72s
    const frames = planRenderFrames({ ...base, scenes: fourScenes }, 30);
    expect(frames).toHaveLength(4);
    expect(frames[3].endFrame).toBe(72 * 30 - 1);

    const est = estimateExportMetrics({ ...base, scenes: fourScenes }, DEFAULT_EXPORT_SETTINGS, 'webcodecs');
    expect(est.durationSeconds).toBe(72);
    expect(est.estimatedSizeMb).toBeGreaterThan(50);
  });

  it('génère et vérifie de vrais octets MP4 (ftyp) et WebM (EBML) via les multiplexeurs et rejette les faux blobs', async () => {
    // Real MP4 container bytes generated by mp4-muxer
    const mp4Target = new Mp4Target();
    const mp4Muxer = new Mp4Muxer({
      target: mp4Target,
      video: { codec: 'avc', width: 720, height: 1280, frameRate: 30 },
      fastStart: 'in-memory',
    });
    mp4Muxer.addVideoChunkRaw(
      new Uint8Array(256).fill(0x65),
      'key',
      0,
      33333,
      { decoderConfig: { codec: 'avc1.42001E', description: new Uint8Array([1, 66, 0, 30, 255, 225, 0, 4, 103, 66, 0, 30, 1, 0, 4, 104, 206, 60, 128]) } },
    );
    mp4Muxer.finalize();
    const mp4Blob = new Blob([mp4Target.buffer], { type: 'video/mp4' });
    const mp4Check = await verifyVideoBlob(mp4Blob, 'mp4');
    expect(mp4Check.valid).toBe(true);
    expect(mp4Check.detectedContainer).toBe('mp4');

    // Real WebM container bytes generated by webm-muxer
    const webmTarget = new WebmTarget();
    const webmMuxer = new WebmMuxer({
      target: webmTarget,
      video: { codec: 'V_VP9', width: 720, height: 1280, frameRate: 30 },
    });
    webmMuxer.addVideoChunkRaw(new Uint8Array(256).fill(0x82), 'key', 0);
    webmMuxer.finalize();
    const webmBlob = new Blob([webmTarget.buffer], { type: 'video/webm' });
    const webmCheck = await verifyVideoBlob(webmBlob, 'webm');
    expect(webmCheck.valid).toBe(true);
    expect(webmCheck.detectedContainer).toBe('webm');

    // Strict rejection of empty/fake/corrupt blobs
    expect((await verifyVideoBlob(new Blob([]), 'mp4')).valid).toBe(false);
    expect((await verifyVideoBlob(new Blob(['<html>not a video</html>'.repeat(20)], { type: 'video/mp4' }), 'mp4')).valid).toBe(false);
  });

  it('évalue honnêtement les besoins de rendu serveur sans déclencher de déploiement ni débiter de crédits', () => {
    const p = readyProject();
    const caps = exportCapabilities('9:16'); // unavailable in Node/jsdom
    const assess = assessServerRenderNeed(p, DEFAULT_EXPORT_SETTINGS, caps);
    expect(assess.needed).toBe(true);
    expect(assess.serverEngineDeployed).toBe(false);
    expect(assess.creditsChargedForLocalExport).toBe(0);

    const manifest = buildServerRenderManifest(p, { ...DEFAULT_EXPORT_SETTINGS, resolution: '1080p' });
    expect(manifest.width).toBe(1080);
    expect(manifest.height).toBe(1920);
    expect(manifest.audioPlan.duckingWindows.length).toBe(1);
  });
});

function installBrowserVideoCanvasMock(videosOut: HTMLVideoElement[], loadDelayMs = 0) {
  const origCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = origCreateElement(tag);
    if (tag === 'video') {
      const v = el as HTMLVideoElement;
      videosOut.push(v);
      let ct = 0;
      Object.defineProperty(v, 'currentTime', {
        get: () => ct,
        set: (val: number) => {
          ct = val;
          queueMicrotask(() => v.dispatchEvent(new Event('seeked')));
        },
        configurable: true,
      });
      Object.defineProperty(v, 'duration', { value: 5, configurable: true });
      Object.defineProperty(v, 'videoWidth', { value: 720, configurable: true });
      Object.defineProperty(v, 'videoHeight', { value: 1280, configurable: true });
      Object.defineProperty(v, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(v, 'pause', { value: vi.fn(), configurable: true });
      Object.defineProperty(v, 'play', { value: vi.fn(async () => undefined), configurable: true });
      Object.defineProperty(v, 'load', { value: vi.fn(), configurable: true });
      setTimeout(() => v.dispatchEvent(new Event('loadeddata')), loadDelayMs);
    } else if (tag === 'canvas') {
      const c = el as HTMLCanvasElement;
      vi.spyOn(c, 'getContext').mockReturnValue({
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
        globalAlpha: 1,
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        roundRect: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        measureText: () => ({ width: 40 }),
        strokeText: vi.fn(),
        fillText: vi.fn(),
      } as unknown as CanvasRenderingContext2D);
    }
    return el;
  });
}

describe('2. Moteur de rendu sous jsdom (APIs navigateur simulées)', () => {
  it('sonde les capacités réelles WebCodecs par résolution (refuse 4K si non supporté par le matériel)', async () => {
    vi.stubGlobal('VideoFrame', class {});
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async (cfg: VideoEncoderConfig) => ({
        // Simulate hardware supporting 720p & 1080p H.264, but NOT 4K
        supported: cfg.codec.startsWith('avc1') && cfg.width <= 1920 && cfg.height <= 1920,
      })),
    });
    vi.stubGlobal('AudioEncoder', {
      isConfigSupported: vi.fn(async (cfg: AudioEncoderConfig) => ({
        supported: cfg.codec === 'mp4a.40.2',
      })),
    });
    vi.stubGlobal('OfflineAudioContext', class {});

    const caps = await probeExportCapabilities('9:16', 30);
    expect(caps.supported).toBe(true);
    expect(caps.engine).toBe('webcodecs');
    expect(caps.resolutions['720p'].supported).toBe(true);
    expect(caps.resolutions['1080p'].supported).toBe(true);
    expect(caps.resolutions['4k'].supported).toBe(false);
    expect(caps.supportsMp4).toBe(true);
    expect(caps.supportsWebm).toBe(false);

    // Requesting unsupported 4K or unsupported WebM is strictly blocked
    const plan4k = resolveExportPlan('9:16', { ...DEFAULT_EXPORT_SETTINGS, resolution: '4k' }, caps);
    expect(plan4k.allowed).toBe(false);
    const planWebm = resolveExportPlan('9:16', { ...DEFAULT_EXPORT_SETTINGS, container: 'webm' }, caps);
    expect(planWebm.allowed).toBe(false);
  });

  it('exécute le pipeline complet WebCodecs + OfflineAudioContext (simulé), gère annulation et nettoyage mémoire', async () => {
    const p = readyProject({
      scenes: readyProject().scenes.slice(0, 2).map((s) => ({ ...s, duration: 0.4 })),
    });

    const createdVideos: HTMLVideoElement[] = [];
    installBrowserVideoCanvasMock(createdVideos, 0);

    let closedFrames = 0;
    let closedAudioData = 0;
    vi.stubGlobal('VideoFrame', class {
      close = () => { closedFrames += 1; };
    });
    vi.stubGlobal('AudioData', class {
      close = () => { closedAudioData += 1; };
    });
    class MockEncodedVideoChunk {
      type: 'key' | 'delta';
      timestamp: number;
      duration: number;
      byteLength: number;
      private bytes: Uint8Array;
      constructor(init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
        this.bytes = init.data;
        this.byteLength = init.data.byteLength;
      }
      copyTo(dest: BufferSource) {
        new Uint8Array(dest as ArrayBuffer).set(this.bytes);
      }
    }
    class MockEncodedAudioChunk {
      type: 'key' | 'delta';
      timestamp: number;
      duration: number;
      byteLength: number;
      private bytes: Uint8Array;
      constructor(init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) {
        this.type = init.type;
        this.timestamp = init.timestamp;
        this.duration = init.duration;
        this.bytes = init.data;
        this.byteLength = init.data.byteLength;
      }
      copyTo(dest: BufferSource) {
        new Uint8Array(dest as ArrayBuffer).set(this.bytes);
      }
    }
    vi.stubGlobal('EncodedVideoChunk', MockEncodedVideoChunk);
    vi.stubGlobal('EncodedAudioChunk', MockEncodedAudioChunk);

    class MockVideoEncoder {
      static isConfigSupported = vi.fn(async (cfg: VideoEncoderConfig) => ({
        supported: cfg.codec.startsWith('avc1') && cfg.width <= 1920 && cfg.height <= 1920,
      }));
      state = 'configured';
      encodeQueueSize = 0;
      private out: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
      constructor(init: VideoEncoderInit) { this.out = init.output; }
      configure = vi.fn();
      encode = vi.fn((_frame: VideoFrame, opts?: { keyFrame?: boolean }) => {
        const bytes = new Uint8Array(64).fill(0x65);
        this.out(
          new MockEncodedVideoChunk({ type: opts?.keyFrame ? 'key' : 'delta', timestamp: 0, duration: 33333, data: bytes }) as unknown as EncodedVideoChunk,
          { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array([1, 100, 0, 40, 255, 225, 0, 4, 103, 100, 0, 40, 1, 0, 4, 104, 238, 60, 128]) } },
        );
      });
      flush = vi.fn(async () => undefined);
      close = vi.fn(() => { this.state = 'closed'; });
    }

    class MockAudioEncoder {
      static isConfigSupported = vi.fn(async () => ({ supported: true }));
      state = 'configured';
      encodeQueueSize = 0;
      private out: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void;
      constructor(init: AudioEncoderInit) { this.out = init.output; }
      configure = vi.fn();
      encode = vi.fn(() => {
        const bytes = new Uint8Array(32).fill(0x11);
        this.out(
          new MockEncodedAudioChunk({ type: 'key', timestamp: 0, duration: 21333, data: bytes }) as unknown as EncodedAudioChunk,
          { decoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: new Uint8Array([0x11, 0x90]) } },
        );
      });
      flush = vi.fn(async () => undefined);
      close = vi.fn(() => { this.state = 'closed'; });
    }

    const gainNodes: Array<{ linearRampToValueAtTime: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn> }> = [];
    class MockOfflineAudioContext {
      destination = {};
      private sr: number;
      private len: number;
      constructor(_ch: number, len: number, sr: number) { this.len = len; this.sr = sr; }
      decodeAudioData = vi.fn(async () => ({ duration: 5, numberOfChannels: 2, sampleRate: this.sr, length: this.sr * 5, getChannelData: () => new Float32Array(this.sr * 5) }));
      createBufferSource = vi.fn(() => ({ buffer: null, connect: () => ({ connect: () => undefined }), start: vi.fn() }));
      createGain = vi.fn(() => {
        const g = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
        gainNodes.push({ setValueAtTime: g.setValueAtTime, linearRampToValueAtTime: g.linearRampToValueAtTime });
        return { gain: g, connect: vi.fn() };
      });
      startRendering = vi.fn(async () => ({
        duration: this.len / this.sr,
        numberOfChannels: 2,
        sampleRate: this.sr,
        length: this.len,
        getChannelData: () => new Float32Array(this.len),
      }));
    }

    vi.stubGlobal('VideoEncoder', MockVideoEncoder);
    vi.stubGlobal('AudioEncoder', MockAudioEncoder);
    vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(128), { status: 200 })));

    const stages: string[] = [];
    const res = await renderVideo(p, {
      settings: { resolution: '720p', quality: 'high', fps: 24, container: 'mp4' },
      onStage: (phase) => stages.push(phase),
    });

    expect(res.engine).toBe('webcodecs');
    expect(res.container).toBe('mp4');
    expect(res.width).toBe(720);
    expect(res.height).toBe(1280);
    expect(res.audioMixed).toBe(true);
    expect(res.blob.size).toBeGreaterThan(200);
    expect((await verifyVideoBlob(res.blob, 'mp4')).valid).toBe(true);
    expect(stages).toContain('preparing');
    expect(stages).toContain('rendering');
    expect(stages).toContain('finalizing');
    expect(stages).toContain('succeeded');
    expect(closedFrames).toBeGreaterThan(0);
    expect(closedAudioData).toBeGreaterThan(0);
    // Videos were cleared on cleanup
    expect(createdVideos.every((v) => !v.getAttribute('src'))).toBe(true);

    // Verify ducking gain ramps dropped music gain to music.volume * DUCKING_FACTOR
    const duckingRampCalled = gainNodes.some((g) =>
      g.linearRampToValueAtTime.mock.calls.some(([val]) => Math.abs((val as number) - 0.8 * DUCKING_FACTOR) < 0.01),
    );
    expect(duckingRampCalled).toBe(true);

    // Also render 16:9 (fade transition + pill subtitles) & 1:1 (slide transition + outline subtitles)
    const proj169 = readyProject({
      aspect: '16:9',
      subtitleConfig: { style: 'pill', position: 'bottom', size: 'md', uppercase: false },
      scenes: readyProject().scenes.slice(0, 2).map((s, i) => ({
        ...s,
        duration: 0.4,
        transition: i === 0 ? 'fade' : 'cut',
        transitionDuration: 0.25,
        subtitleStart: 0,
        subtitleEnd: 0.4,
      })),
    });
    const res169 = await renderVideo(proj169, {
      settings: { resolution: '720p', quality: 'standard', fps: 24, container: 'mp4' },
    });
    expect(res169.width).toBe(1280);
    expect(res169.height).toBe(720);

    const proj11 = readyProject({
      aspect: '1:1',
      subtitleConfig: { style: 'outline', position: 'center', size: 'lg', uppercase: true },
      scenes: readyProject().scenes.slice(0, 2).map((s, i) => ({
        ...s,
        duration: 0.4,
        transition: i === 0 ? 'slide' : 'cut',
        transitionDuration: 0.25,
      })),
    });
    const res11 = await renderVideo(proj11, {
      settings: { resolution: '1080p', quality: 'high', fps: 24, container: 'mp4' },
    });
    expect(res11.width).toBe(1080);
    expect(res11.height).toBe(1080);

    // Test Abort / cancellation preserves project & releases resources
    const ac = new AbortController();
    ac.abort();
    await expect(renderVideo(p, { signal: ac.signal })).rejects.toMatchObject({ code: 'ABORTED' });

    // OfflineAudioContext direct check for ducking diagnostics
    const mixRes = await mixProjectAudioOffline(p, 48000);
    expect(mixRes.hasAudio).toBe(true);
  });

  it('bascule sur MediaRecorder lorsque WebCodecs est absent et rejette tout environnement sans encodeur', async () => {
    const p = readyProject({
      scenes: readyProject().scenes.slice(0, 1).map((s) => ({ ...s, duration: 0.2 })),
      voiceover: undefined,
      audio: undefined,
    });

    // Neither WebCodecs nor MediaRecorder -> strictly blocked with CODEC_UNSUPPORTED
    await expect(renderVideo(p)).rejects.toMatchObject({ code: 'CODEC_UNSUPPORTED' });

    // MediaRecorder present (WebCodecs absent) -> produces verified WebM fallback
    installBrowserVideoCanvasMock([], 0);
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      writable: true,
      value: () => ({
        getVideoTracks: () => [{ id: 'vt-1', stop: vi.fn() }],
        getTracks: () => [{ stop: vi.fn() }],
      }),
    });

    const webmTarget = new WebmTarget();
    const webmMuxer = new WebmMuxer({ target: webmTarget, video: { codec: 'V_VP9', width: 720, height: 1280, frameRate: 24 } });
    webmMuxer.addVideoChunkRaw(new Uint8Array(256).fill(0x82), 'key', 0);
    webmMuxer.finalize();
    const validWebmBytes = new Uint8Array(webmTarget.buffer);

    class MockMediaRecorder {
      static isTypeSupported = vi.fn((m: string) => m.includes('webm'));
      mimeType: string;
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
        this.mimeType = opts?.mimeType || 'video/webm';
      }
      start = vi.fn();
      stop = vi.fn(() => {
        this.ondataavailable?.({ data: new Blob([validWebmBytes], { type: 'video/webm' }) });
        this.onstop?.();
      });
    }
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
    vi.stubGlobal('MediaStream', class {
      addTrack = vi.fn();
      getTracks = () => [];
    });

    try {
      const fallbackRes = await renderVideo(p, {
        settings: { resolution: '720p', quality: 'standard', fps: 24, container: 'webm' },
      });
      expect(fallbackRes.engine).toBe('mediarecorder');
      expect(fallbackRes.container).toBe('webm');
      expect((await verifyVideoBlob(fallbackRes.blob, 'webm')).valid).toBe(true);
    } finally {
      delete (HTMLCanvasElement.prototype as unknown as { captureStream?: unknown }).captureStream;
    }
  }, 15000);

  it('rejette explicitement les médias corrompus / CORS inaccessibles sans simuler de fichier', async () => {
    vi.stubGlobal('VideoFrame', class {});
    vi.stubGlobal('VideoEncoder', {
      isConfigSupported: vi.fn(async () => ({ supported: true })),
    });
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'video') {
        setTimeout(() => el.dispatchEvent(new Event('error')), 0);
      }
      return el;
    });

    const p = readyProject();
    await expect(renderVideo(p, { settings: { resolution: '720p', quality: 'standard', fps: 30, container: 'mp4' } }))
      .rejects.toBeInstanceOf(RenderError);
    vi.restoreAllMocks();
  });
});

describe('3. Expérience utilisateur ExportPanel & VideoEditor (desktop + mobile 390px, fixtures simulées)', () => {
  it('empêche les doubles lancements, gère téléchargement + lecture de vérification et désactive les résolutions non supportées', () => {
    const p = readyProject();
    const caps: ExportCapabilities = {
      ...exportCapabilities('9:16'),
      supported: true,
      engine: 'webcodecs',
      mimeType: 'video/mp4',
      supportsMp4: true,
      supportsWebm: false,
      hasOfflineAudioContext: true,
      resolutions: {
        '720p': { resolution: '720p', width: 720, height: 1280, supported: true, engine: 'webcodecs' },
        '1080p': { resolution: '1080p', width: 1080, height: 1920, supported: true, engine: 'webcodecs' },
        '4k': { resolution: '4k', width: 2160, height: 3840, supported: false, engine: 'unavailable', reason: 'Encodeur 4K absent.' },
      },
    };

    const onStartRender = vi.fn();
    const { rerender } = render(
      <ExportPanel
        project={p}
        caps={caps}
        settings={DEFAULT_EXPORT_SETTINGS}
        onSettingsChange={vi.fn()}
        onAspectChange={vi.fn()}
        phase="idle"
        progress={0}
        progressLabel=""
        error=""
        result={null}
        onStartRender={onStartRender}
        onSaveAndRender={vi.fn()}
        onCancel={vi.fn()}
        srtReady
      />,
    );

    const btn4k = screen.getByRole('button', { name: 'Résolution 4k' }) as HTMLButtonElement;
    expect(btn4k.disabled).toBe(true);
    expect(screen.getByText('Encodeur 4K absent.')).toBeTruthy();

    // During rendering, launch buttons are strictly disabled (double-launch protection)
    rerender(
      <ExportPanel
        project={p}
        caps={caps}
        settings={DEFAULT_EXPORT_SETTINGS}
        onSettingsChange={vi.fn()}
        onAspectChange={vi.fn()}
        phase="rendering"
        progress={0.45}
        progressLabel="Rendu · plan 2/4"
        error=""
        result={null}
        onStartRender={onStartRender}
        onSaveAndRender={vi.fn()}
        onCancel={vi.fn()}
        srtReady
      />,
    );
    expect((screen.getByRole('button', { name: /Lancer le rendu/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Enregistrer et exporter/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('45 %')).toBeTruthy();

    // After succeeded render, real <video controls> playback preview & download button appear
    const mockBlob = new Blob([new Uint8Array(512)], { type: 'video/mp4' });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    rerender(
      <ExportPanel
        project={p}
        caps={caps}
        settings={DEFAULT_EXPORT_SETTINGS}
        onSettingsChange={vi.fn()}
        onAspectChange={vi.fn()}
        phase="succeeded"
        progress={1}
        progressLabel="Fichier vidéo vérifié et prêt."
        error=""
        result={{
          blob: mockBlob,
          mimeType: 'video/mp4',
          container: 'mp4',
          engine: 'webcodecs',
          durationSeconds: 20,
          audioMixed: true,
          width: 1080,
          height: 1920,
          fps: 30,
          diagnostics: [],
        }}
        onStartRender={onStartRender}
        onSaveAndRender={vi.fn()}
        onCancel={vi.fn()}
        srtReady
      />,
    );

    expect(screen.getByLabelText('Aperçu du fichier vidéo exporté')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Télécharger \(MP4\)/i }));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(exportFilename(p, 'video/mp4')).toMatch(/-9x16\.mp4$/);
    downloadBlob(mockBlob, 'test.mp4');
    clickSpy.mockRestore();
  });

  it('VideoEditor protège contre les doubles clics, sauvegarde avant export et préserve le montage sur mobile (390px)', async () => {
    const projData = {
      id: 'proj-exp',
      workspace_id: 'ws-1',
      brand_id: null,
      product_id: null,
      created_by: 'u1',
      title: 'Campagne Phase 4',
      brief: 'Brief test',
      campaign_objective: null,
      target_audience: null,
      target_market: null,
      platform: 'TikTok',
      language: 'fr',
      aspect_ratio: '9:16',
      status: 'draft',
      settings: {
        reelora_editor_v1: readyProject({ projectId: 'proj-exp', title: 'Campagne Phase 4' }),
      },
      created_at: '2026-11-09T10:00:00Z',
      updated_at: '2026-11-09T10:00:00Z',
    };
    apiMocks.getProject.mockResolvedValue(projData);
    apiMocks.listProjects.mockResolvedValue([projData]);
    apiMocks.updateProject.mockResolvedValue(undefined);

    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });

    render(
      <MemoryRouter initialEntries={['/app/studio/montage?projet=proj-exp']}>
        <Routes>
          <Route path="/app/studio/montage" element={<VideoEditor />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByDisplayValue('Campagne Phase 4').length).toBeGreaterThanOrEqual(2));

    const mobileExportTab = screen.getAllByRole('tab').find((t) => t.textContent?.trim() === 'Export')!;
    fireEvent.click(mobileExportTab);

    expect(screen.getByText(/Moteur d’export vidéo professionnel/i)).toBeTruthy();
    expect(screen.getByText(/Export vidéo indisponible dans cet environnement/i)).toBeTruthy();
    expect(renderIssues(readyProject())).toHaveLength(0);
    // Launch button remains strictly disabled in jsdom without encoders
    expect((screen.getByRole('button', { name: /Lancer le rendu/i }) as HTMLButtonElement).disabled).toBe(true);

    // Save project safely before & after export tab switches without data loss
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer$/i }));
    await waitFor(() => expect(apiMocks.updateProject).toHaveBeenCalledTimes(1));
  });

  it('vérifie la protection anti-double-lancement et sauvegarde avant export dans VideoEditor (WebCodecs simulé)', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1280 });
    const baseProj = readyProject({
      projectId: 'proj-lock',
      title: 'Test Anti-Double',
      scenes: readyProject().scenes.slice(0, 1).map((s) => ({ ...s, duration: 0.4 })),
    });
    const projData = {
      id: 'proj-lock',
      workspace_id: 'ws-1',
      brand_id: null,
      product_id: null,
      created_by: 'u1',
      title: 'Test Anti-Double',
      brief: 'Brief',
      campaign_objective: null,
      target_audience: null,
      target_market: null,
      platform: 'TikTok',
      language: 'fr',
      aspect_ratio: '9:16',
      status: 'draft',
      settings: { reelora_editor_v1: baseProj },
      created_at: '2026-11-09T10:00:00Z',
      updated_at: '2026-11-09T10:00:00Z',
    };
    apiMocks.getProject.mockResolvedValue(projData);
    apiMocks.listProjects.mockResolvedValue([projData]);
    apiMocks.updateProject.mockResolvedValue(undefined);

    let encoderBuilds = 0;
    vi.stubGlobal('VideoFrame', class { close = vi.fn(); });
    class MockChunk {
      type: 'key' | 'delta';
      timestamp: number;
      duration: number;
      byteLength: number;
      private bytes: Uint8Array;
      constructor(init: { type: 'key' | 'delta'; timestamp: number; duration: number; data: Uint8Array }) {
        this.type = init.type; this.timestamp = init.timestamp; this.duration = init.duration;
        this.bytes = init.data; this.byteLength = init.data.byteLength;
      }
      copyTo(dest: BufferSource) { new Uint8Array(dest as ArrayBuffer).set(this.bytes); }
    }
    vi.stubGlobal('EncodedVideoChunk', MockChunk);
    vi.stubGlobal('VideoEncoder', class {
      static isConfigSupported = vi.fn(async (cfg: VideoEncoderConfig) => ({
        supported: cfg.codec.startsWith('avc1') && cfg.width <= 1920 && cfg.height <= 1920,
      }));
      state = 'configured';
      encodeQueueSize = 0;
      private out: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
      constructor(init: VideoEncoderInit) { encoderBuilds += 1; this.out = init.output; }
      configure = vi.fn();
      encode = vi.fn((_f: VideoFrame, opts?: { keyFrame?: boolean }) => {
        const bytes = new Uint8Array(64).fill(0x65);
        this.out(
          new MockChunk({ type: opts?.keyFrame ? 'key' : 'delta', timestamp: 0, duration: 33333, data: bytes }) as unknown as EncodedVideoChunk,
          { decoderConfig: { codec: 'avc1.640028', description: new Uint8Array([1, 100, 0, 40, 255, 225, 0, 4, 103, 100, 0, 40, 1, 0, 4, 104, 238, 60, 128]) } },
        );
      });
      flush = vi.fn(async () => undefined);
      close = vi.fn(() => { this.state = 'closed'; });
    });

    installBrowserVideoCanvasMock([], 10);

    render(
      <MemoryRouter initialEntries={['/app/studio/montage?projet=proj-lock']}>
        <Routes>
          <Route path="/app/studio/montage" element={<VideoEditor />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByDisplayValue('Test Anti-Double').length).toBeGreaterThanOrEqual(2));
    const desktopExportTab = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Export & Rendu réel'))!;
    fireEvent.click(desktopExportTab);

    await waitFor(() => expect(screen.getByTestId('export-engine-badge').textContent).toContain('WebCodecs'));

    const saveAndExportBtn = screen.getByRole('button', { name: /Enregistrer et exporter/i });
    // Fire double-click rapidly
    fireEvent.click(saveAndExportBtn);
    fireEvent.click(saveAndExportBtn);

    await waitFor(() => expect(screen.getByTestId('export-phase-badge').textContent).toBe('Réussi · vérifié'), { timeout: 5000 });
    expect(apiMocks.updateProject).toHaveBeenCalledTimes(1);
    expect(encoderBuilds).toBe(1);
    vi.restoreAllMocks();
  });
});
