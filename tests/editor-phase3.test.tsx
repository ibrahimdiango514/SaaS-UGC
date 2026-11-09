// @vitest-environment jsdom
/**
 * PHASE 3 — tests unitaires (logique pure) et tests d’intégration UI SIMULÉS (jsdom).
 *
 * Distinction stricte :
 * - Les suites « Logique pure » testent les fonctions réelles de montage, découpage,
 *   règles UGC déterministes, génération SRT, validation de persistance et garde-fous
 *   d’export sans aucune simulation de succès.
 * - Les suites « Interface desktop & mobile (fixtures API simulées) » montent les
 *   vrais composants React (VideoEditor, Timeline, AssistPanel, SubtitlesVoiceoverPanel)
 *   avec des mocks explicites de Supabase/Auth, sans appel MuAPI, sans appel Groq,
 *   sans crédit débité et sans génération payante.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { GeneratedAsset, Project, Scene, Script } from '../src/lib/types';
import {
  addScene, clampTransitionDuration, duplicateScene, effectiveSubtitleConfig,
  effectiveVoiceover, parseEditorProject, patchScene, reorderScenesByIds,
  replaceSceneSource, splitScene, totalDuration, trimScene,
  type EditorProject,
} from '../src/studio/editor/types';
import {
  analyzeProject, estimateSpeechDurationSeconds, subtitleSpans,
} from '../src/studio/editor/assist';
import { buildSrt, exportCapabilities, renderIssues, renderProject } from '../src/studio/editor/render';
import { buildLocalPlan, planToEditorProject } from '../src/studio/plan';

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
    user: { id: 'user-1', email: 'creator@reelora.test' },
    profile: { display_name: 'Créateur UGC' },
    workspaceId: 'ws-1',
    quota: { credits: 36 },
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

import {
  loadEditorProject, loadProjectLocalDraft, saveEditorProject, saveLocalDraft,
} from '../src/studio/editor/persistence';
import {
  assembleFromProjectMedia, hydrateEditorFromProject, type ProjectMediaItem,
} from '../src/studio/editor/projectMedia';
import { AssistPanel } from '../src/studio/editor/components/AssistPanel';
import { SubtitlesVoiceoverPanel } from '../src/studio/editor/components/SubtitlesVoiceoverPanel';
import { Timeline } from '../src/studio/editor/components/Timeline';
import VideoEditor from '../src/studio/VideoEditor';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function makeProject(overrides: Partial<EditorProject> = {}): EditorProject {
  const plan = buildLocalPlan({
    prompt: 'Publicité UGC de 20 secondes pour un sérum éclat : accroche, démonstration texture, preuve visible et CTA.',
    ratio: '9:16',
    subtitles: true,
  });
  return {
    ...planToEditorProject(plan, {
      quality: 'standard', mode: 'idea', model: null, subtitles: true, projectId: 'proj-1',
    }),
    ugcPreset: 'ugc-balanced',
    targetDuration: 20,
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
    createObjectURL: vi.fn(() => 'blob:mock-clip'),
    revokeObjectURL: vi.fn(),
  });
  apiMocks.listProjects.mockResolvedValue([]);
  apiMocks.listScripts.mockResolvedValue([]);
  apiMocks.listScenes.mockResolvedValue([]);
  apiMocks.listAssets.mockResolvedValue([]);
  apiMocks.listJobs.mockResolvedValue([]);
  apiMocks.signedStorageUrl.mockResolvedValue('https://signed.example/clip.mp4');
  apiMocks.uploadEditorMedia.mockResolvedValue('ws-1/editor/uploaded.mp4');
  apiMocks.healthCheck.mockResolvedValue({ configured: { groq: false, muapi: true, supabase: true, worker: true } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Logique pure · Timeline (découpage, déplacement, duplication, trim)', () => {
  it('scinde un clip en deux segments continus avec décalage trimStart et texte réparti', () => {
    const base = makeProject();
    const first = {
      ...base.scenes[0],
      duration: 8,
      trimStart: 1.5,
      spokenText: 'Première phrase accroche puis démonstration produit claire',
      subtitle: 'Accroche forte puis démonstration',
      source: { kind: 'asset' as const, name: 'clip.mp4', url: 'https://signed.example/clip.mp4', sourceDuration: 15 },
    };
    const proj = { ...base, scenes: [first, ...base.scenes.slice(1)] };
    const split = splitScene(proj, first.id, 3);
    expect(split.scenes).toHaveLength(base.scenes.length + 1);
    expect(split.scenes[0].duration).toBe(3);
    expect(split.scenes[0].trimStart).toBe(1.5);
    expect(split.scenes[0].transition).toBe('cut');
    expect(split.scenes[1].duration).toBe(5);
    expect(split.scenes[1].trimStart).toBe(4.5);
    expect(split.scenes[1].source.url).toBe('https://signed.example/clip.mp4');
    expect(split.scenes[0].spokenText.length).toBeGreaterThan(0);
    expect(split.scenes[1].spokenText.length).toBeGreaterThan(0);
  });

  it('ajoute, duplique, réordonne par IDs et borne le trim sur la durée réelle du média', () => {
    let proj = makeProject();
    const initialCount = proj.scenes.length;
    proj = addScene(proj, { role: 'proof', label: 'Preuve client', duration: 4 });
    expect(proj.scenes).toHaveLength(initialCount + 1);

    const targetId = proj.scenes[1].id;
    proj = duplicateScene(proj, targetId);
    expect(proj.scenes).toHaveLength(initialCount + 2);
    expect(proj.scenes[2].id).not.toBe(targetId);

    const reversedIds = [...proj.scenes].reverse().map((s) => s.id);
    const reordered = reorderScenesByIds(proj, reversedIds);
    expect(reordered.scenes.map((s) => s.id)).toEqual(reversedIds);

    const withBounds = replaceSceneSource(proj, targetId, {
      kind: 'local', name: 'court.mp4', url: 'blob:court', sourceDuration: 6,
    });
    const trimmed = trimScene(withBounds, targetId, { trimStart: 4, duration: 10 });
    const sc = trimmed.scenes.find((s) => s.id === targetId)!;
    expect(sc.trimStart).toBe(4);
    expect(sc.duration).toBe(2);
    expect(clampTransitionDuration(3)).toBe(1.2);
  });

  it('préserve tous les champs Phase 3 et reste rétrocompatible avec les projets Phase 2', () => {
    const legacyRaw = {
      version: 1,
      projectId: 'proj-legacy',
      title: 'Ancien montage Phase 2',
      prompt: 'Brief existant',
      sector: 'cosmetique',
      quality: 'standard',
      mode: 'idea',
      modelId: '',
      aspect: '9:16',
      subtitlesEnabled: true,
      planSource: 'deterministic',
      scenes: [{
        id: 'sc-old',
        role: 'hook',
        label: 'Accroche',
        duration: 3,
        trimStart: 0,
        source: { kind: 'none', name: '' },
        visualPrompt: 'Plan visage',
        spokenText: 'Bonjour',
        subtitle: 'Bonjour',
        transition: 'cut',
      }],
      audio: { kind: 'none', name: '', volume: 0.8 },
      updatedAt: '2026-11-09T12:00:00.000Z',
    };
    const parsedLegacy = parseEditorProject(legacyRaw);
    expect(parsedLegacy).not.toBeNull();
    expect(effectiveSubtitleConfig(parsedLegacy!).position).toBe('bottom');
    expect(effectiveVoiceover(parsedLegacy!).kind).toBe('none');

    const phase3 = makeProject({
      subtitleConfig: { position: 'center', style: 'pill', size: 'lg', uppercase: true },
      voiceover: { kind: 'asset', name: 'voix.mp3', storagePath: 'ws-1/editor/voix.mp3', volume: 0.95, startAt: 0.5, trimStart: 0.2 },
      audioDucking: true,
      ugcPreset: 'tiktok-fast',
      targetDuration: 15,
      suggestionDecisions: { hook: { status: 'accepted', updatedAt: '2026-11-09T18:00:00.000Z' } },
    });
    const roundtrip = parseEditorProject(phase3);
    expect(roundtrip?.subtitleConfig).toEqual({ position: 'center', style: 'pill', size: 'lg', uppercase: true });
    expect(roundtrip?.voiceover?.storagePath).toBe('ws-1/editor/voix.mp3');
    expect(roundtrip?.ugcPreset).toBe('tiktok-fast');
    expect(roundtrip?.suggestionDecisions?.hook.status).toBe('accepted');
  });
});

describe('Logique pure · Hydratation & assemblage intelligent des médias du projet', () => {
  it('hydrate un projet Reelora existant (scripts, scènes, vidéos) même sans brouillon éditeur sauvegardé', async () => {
    const dbProject: Project = {
      id: 'proj-real', workspace_id: 'ws-1', brand_id: null, product_id: null, created_by: 'u1',
      title: 'Campagne Sérum', brief: 'Publicité UGC pour un sérum hydratant', campaign_objective: null,
      target_audience: null, target_market: null, platform: 'TikTok', language: 'fr',
      aspect_ratio: '9:16', status: 'draft', settings: {}, created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z',
    };
    const dbScripts: Script[] = [{
      id: 'scr-1', project_id: 'proj-real', version: 1, language: 'fr', marketing_angle: null,
      hook: 'Tu fais encore cette erreur le matin ?', script_text: 'Texte complet',
      call_to_action: 'Lien en bio maintenant', claims_to_avoid: [], status: 'approved', created_by: 'u1', created_at: '2026-11-09T10:00:00Z',
    }];
    const dbScenes: Scene[] = [{
      id: 's1', project_id: 'proj-real', script_id: 'scr-1', scene_order: 1, duration_seconds: 3,
      scene_type: 'hook', visual_prompt: 'Gros plan', spoken_text: 'Stop !', subtitle_text: 'Stop !', asset_id: 'asset-1',
      scene_settings: {}, created_at: '2026-11-09T10:00:00Z',
    }];
    const dbAssets: GeneratedAsset[] = [{
      id: 'asset-1', workspace_id: 'ws-1', project_id: 'proj-real', generation_job_id: 'job-1', created_by: 'u1',
      asset_type: 'video/mp4', storage_path: 'ws-1/videos/serum.mp4', mime_type: 'video/mp4',
      file_size_bytes: 2048000, metadata: { model_id: 'seedance-lite-t2v' }, created_at: '2026-11-09T10:05:00Z',
    }];

    apiMocks.getProject.mockResolvedValue(dbProject);
    apiMocks.listScripts.mockResolvedValue(dbScripts);
    apiMocks.listScenes.mockResolvedValue(dbScenes);
    apiMocks.listAssets.mockResolvedValue(dbAssets);
    apiMocks.listJobs.mockResolvedValue([]);

    const hydrated = await hydrateEditorFromProject('proj-real');
    expect(hydrated.fromSavedEditor).toBe(false);
    expect(hydrated.editor.projectId).toBe('proj-real');
    expect(hydrated.editor.demo).toBeUndefined();
    expect(hydrated.editor.scenes[0].source.kind).toBe('asset');
    expect(hydrated.editor.scenes[0].source.url).toBe('https://signed.example/clip.mp4');
    expect(hydrated.mediaItems[0].origin).toBe('project-asset');
  });

  it('assemble automatiquement un clip long unique sur plusieurs scènes avec trimStart distincts sans inventer de média', () => {
    const emptyProj = makeProject();
    const media: ProjectMediaItem[] = [{
      id: 'm1', origin: 'project-asset', mediaType: 'video', name: 'rush.mp4',
      url: 'https://signed.example/rush.mp4', storagePath: 'ws-1/rush.mp4', assetId: 'a1',
      sourceDuration: 18, width: 720, height: 1280,
    }];
    const assembled = assembleFromProjectMedia(emptyProj, media);
    expect(assembled.scenes.every((s) => s.source.url === 'https://signed.example/rush.mp4')).toBe(true);
    const trims = assembled.scenes.map((s) => s.trimStart);
    expect(trims[0]).toBe(0);
    expect(trims[1]).toBeGreaterThan(0);
    expect(trims[2]).toBeGreaterThan(trims[1]);
    expect(assembled.scenes[assembled.scenes.length - 1].role).toBe('cta');
  });
});

describe('Logique pure · Assistant UGC intelligent (règles locales vs IA)', () => {
  it('détecte ordre narratif, accroche longue, plan trop long, WPM voix off, ducking et ratio', () => {
    const base = makeProject({
      aspect: '9:16',
      ugcPreset: 'tiktok-fast',
      targetDuration: 15,
      voiceover: { kind: 'local', name: 'voix.wav', url: 'blob:voix', volume: 1 },
      audio: { kind: 'local', name: 'beat.mp3', url: 'blob:beat', volume: 0.7 },
      audioDucking: false,
    });
    const scenes = [
      {
        ...base.scenes[3], // cta wrongly placed first
        duration: 2,
      },
      {
        ...base.scenes[0], // hook placed after cta and too long for tiktok-fast
        duration: 5,
      },
      {
        ...base.scenes[1], // demo: long shot + mismatch 16:9 clip + fast spoken text (~10.4s vs 7s)
        duration: 7,
        spokenText: 'Voici comment appliquer le sérum chaque matin après avoir nettoyé votre visage avec de l eau tiède et sans frotter puis massez doucement pendant trente secondes',
        source: { kind: 'local' as const, name: 'wide.mp4', url: 'blob:wide', sourceDuration: 5, mediaWidth: 1920, mediaHeight: 1080 },
      },
      base.scenes[2],
    ];
    const suggestions = analyzeProject({ ...base, scenes }, 15, { preset: 'tiktok-fast' });
    const ids = suggestions.map((s) => s.id);
    expect(ids).toContain('hook');
    expect(ids).toContain('cta');
    expect(ids).toContain('trim-bounds');
    expect(ids).toContain('split-long');
    expect(ids).toContain('wpm-sync');
    expect(ids).toContain('aspect-fit');
    expect(ids).toContain('audio-ducking');
    expect(estimateSpeechDurationSeconds('Un deux trois quatre cinq')).toBe(2);

    // Every suggestion has origin local-deterministic (never fake AI)
    expect(suggestions.every((s) => s.origin === 'local-deterministic')).toBe(true);

    // Applying trim-bounds fixes the overrun cleanly
    const trimSugg = suggestions.find((s) => s.id === 'trim-bounds')!;
    const afterTrim = trimSugg.apply!({ ...base, scenes });
    expect(afterTrim.scenes[2].duration).toBeLessThanOrEqual(5);
  });

  it('génère des spans sous-titres et un fichier SRT exact', () => {
    const p = makeProject();
    p.scenes[0] = patchScene(p, p.scenes[0].id, { duration: 4, subtitle: 'Accroche rapide', subtitleStart: 0.5, subtitleEnd: 3.5 }).scenes[0];
    const spans = subtitleSpans(p);
    expect(spans[0].start).toBe(0.5);
    expect(spans[0].end).toBe(3.5);
    const srt = buildSrt(p);
    expect(srt).toContain('00:00:00,500 --> 00:00:03,500');
    expect(srt).toContain('Accroche rapide');
  });
});

describe('Logique pure · Persistance sans perte & refus strict de faux export', () => {
  it('conserve les URLs blob en session tout en nettoyant la copie DB et re-signe la voix off au chargement', async () => {
    apiMocks.getProject.mockResolvedValue({ settings: { keepMe: 42 } });
    apiMocks.updateProject.mockResolvedValue(undefined);

    let proj = makeProject({
      projectId: 'proj-save',
      voiceover: { kind: 'local', name: 'mic.webm', url: 'blob:mic', storagePath: 'ws-1/editor/mic.webm', volume: 1 },
    });
    proj = replaceSceneSource(proj, proj.scenes[0].id, {
      kind: 'local', name: 'local-only.mp4', url: 'blob:live-session',
    });

    const inMemoryAfterSave = await saveEditorProject('proj-save', proj);
    const dbPayload = apiMocks.updateProject.mock.calls[0][1].settings;
    expect(dbPayload.keepMe).toBe(42);
    // DB copy has no blob URL and explicitly marks non-uploaded local media as none
    expect(dbPayload.reelora_editor_v1.scenes[0].source.url).toBeUndefined();
    expect(dbPayload.reelora_editor_v1.scenes[0].source.kind).toBe('none');
    // Active in-memory session preserves blob URL so user does not lose live clip
    expect(inMemoryAfterSave.scenes[0].source.url).toBe('blob:live-session');
    // Voiceover storagePath was re-signed
    expect(inMemoryAfterSave.voiceover?.url).toBe('https://signed.example/clip.mp4');

    apiMocks.getProject.mockResolvedValue({ settings: dbPayload });
    const reloaded = await loadEditorProject('proj-save');
    expect(reloaded?.voiceover?.url).toBe('https://signed.example/clip.mp4');

    saveLocalDraft(proj);
    expect(loadProjectLocalDraft('proj-save')?.scenes[0].source.url).toBeUndefined();
  });

  it('refuse tout export lorsque MediaRecorder / captureStream est indisponible ou qu’un média manque', async () => {
    const caps = exportCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.reasons.length).toBeGreaterThan(0);

    const p = makeProject();
    expect(renderIssues(p).length).toBeGreaterThan(0);
    await expect(renderProject(p)).rejects.toThrow();

    // Even if all scenes had URLs, renderProject refuses without MediaRecorder/captureStream
    const readyScenes = p.scenes.map((s) => ({
      ...s,
      source: { kind: 'asset' as const, name: 'ok.mp4', url: 'https://signed.example/ok.mp4' },
    }));
    await expect(renderProject({ ...p, scenes: readyScenes })).rejects.toThrow(/MediaRecorder|indisponible/i);
  });
});

describe('Interface desktop & mobile (fixtures API simulées — aucune génération ni débit)', () => {
  it('AssistPanel permet d’accepter, modifier et rejeter chaque suggestion locale et désactive Groq si absent', () => {
    const onChange = vi.fn();
    const base = makeProject();
    // Place hook after demo so 'hook' suggestion appears
    const reordered = { ...base, scenes: [base.scenes[1], base.scenes[0], base.scenes[2], base.scenes[3]] };
    const { rerender } = render(
      <AssistPanel
        project={reordered}
        onChange={onChange}
        groqConfigured={false}
        onProposeAiPlan={async () => null}
      />,
    );

    expect(screen.getByText(/Local · déterministe/i)).toBeTruthy();
    expect(screen.getByText(/GROQ_API_KEY absent côté serveur/i)).toBeTruthy();

    // Reject 'audio' suggestion
    const audioCard = screen.getByTestId('suggestion-audio');
    fireEvent.click(audioCard.querySelector('button:last-child')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    let updated: EditorProject = onChange.mock.calls[0][0];
    expect(updated.suggestionDecisions?.audio.status).toBe('rejected');

    // Rerender with updated project & modify 'hook' suggestion to position 1
    rerender(
      <AssistPanel
        project={updated}
        onChange={onChange}
        groqConfigured={false}
        onProposeAiPlan={async () => null}
      />,
    );
    const hookCard = screen.getByTestId('suggestion-hook');
    const modifyBtn = Array.from(hookCard.querySelectorAll('button')).find((b) => b.textContent?.includes('Modifier'))!;
    fireEvent.click(modifyBtn);
    fireEvent.click(screen.getByText('Appliquer ma version'));
    expect(onChange).toHaveBeenCalledTimes(2);
    updated = onChange.mock.calls[1][0];
    expect(updated.suggestionDecisions?.hook.status).toBe('modified');
    expect(updated.scenes[0].role).toBe('hook');
  });

  it('Timeline interactive permet d’ajouter un plan et de scinder un clip', () => {
    const onChange = vi.fn();
    const proj = makeProject();
    render(
      <Timeline
        project={proj}
        onChange={onChange}
        selectedId={proj.scenes[1].id}
        onSelect={vi.fn()}
        playhead={proj.scenes[0].duration + 1}
        onSeek={vi.fn()}
        playing={false}
        onTogglePlay={vi.fn()}
        onImport={vi.fn()}
        onImportAudio={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTitle('Scinder le plan au niveau du curseur'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].scenes).toHaveLength(proj.scenes.length + 1);

    fireEvent.click(screen.getByTitle('Ajouter un nouveau plan'));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0].scenes).toHaveLength(proj.scenes.length + 1);
  });

  it('SubtitlesVoiceoverPanel affiche honnêtement l’absence de TTS et génère les sous-titres depuis la voix off', () => {
    const onChange = vi.fn();
    const proj = makeProject();
    proj.scenes[0] = { ...proj.scenes[0], spokenText: 'Découvre ce sérum en 3 secondes', subtitle: '' };

    render(
      <SubtitlesVoiceoverPanel
        project={proj}
        onChange={onChange}
        onImportVoiceover={vi.fn()}
        onImportAudio={vi.fn()}
      />,
    );

    expect(screen.getByText(/Synthèse vocale IA \(TTS\) non connectée/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/Copier depuis voix off/i));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].scenes[0].subtitle).toBe('Découvre ce sérum en 3 secondes');
  });

  it('VideoEditor hydrate un projet réel, gère les vues desktop/mobile, sauvegarde sans perte et bloque le faux export', async () => {
    const dbProject: Project = {
      id: 'proj-ui', workspace_id: 'ws-1', brand_id: null, product_id: null, created_by: 'u1',
      title: 'Montage UI Phase 3', brief: 'Publicité UGC de 20 secondes pour un soin visage éclat.',
      campaign_objective: null, target_audience: null, target_market: null, platform: 'TikTok',
      language: 'fr', aspect_ratio: '9:16', status: 'draft', settings: {},
      created_at: '2026-11-09T10:00:00Z', updated_at: '2026-11-09T10:00:00Z',
    };
    apiMocks.getProject.mockResolvedValue(dbProject);
    apiMocks.listProjects.mockResolvedValue([dbProject]);
    apiMocks.updateProject.mockResolvedValue(undefined);
    apiMocks.listAssets.mockResolvedValue([{
      id: 'a-ui', workspace_id: 'ws-1', project_id: 'proj-ui', generation_job_id: null, created_by: 'u1',
      asset_type: 'video/mp4', storage_path: 'ws-1/videos/rush.mp4', mime_type: 'video/mp4',
      file_size_bytes: 1024000, metadata: {}, created_at: '2026-11-09T10:01:00Z',
    }]);

    // Simulate mobile viewport width first, then desktop verification via shared responsive tabs
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 390 });

    render(
      <MemoryRouter initialEntries={['/app/studio/montage?projet=proj-ui']}>
        <Routes>
          <Route path="/app/studio/montage" element={<VideoEditor />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByDisplayValue('Montage UI Phase 3').length).toBeGreaterThanOrEqual(2));
    // Not marked as demo project because hydrated from real project
    expect(screen.queryByText(/Projet de démonstration/i)).toBeNull();

    // Auto-assemble project media from banner (1 real project video in mediaItems)
    const assembleBtn = screen.getByRole('button', { name: /Assembler depuis les médias du projet/i });
    fireEvent.click(assembleBtn);
    await waitFor(() => expect(screen.getByText(/Tous les plans ont un média/i)).toBeTruthy());

    // Switch to mobile Export tab & verify real technical refusal (no fake export)
    const mobileExportTab = screen.getAllByRole('tab').find((t) => t.textContent?.trim() === 'Export')!;
    fireEvent.click(mobileExportTab);
    expect(screen.getByText(/Export vidéo indisponible dans cet environnement/i)).toBeTruthy();
    const renderBtn = screen.getByRole('button', { name: /Lancer le rendu/i }) as HTMLButtonElement;
    expect(renderBtn.disabled).toBe(true);

    // Switch to Desktop Sous-titres & Voix off tab and verify undo/redo + lossless save
    const desktopVoiceTab = screen.getAllByRole('tab').find((t) => t.textContent?.includes('Sous-titres & Voix off'))!;
    fireEvent.click(desktopVoiceTab);
    expect(screen.getByText(/Téléprompteur voix off/i)).toBeTruthy();

    // Undo restores missing media state, Redo restores assembled state
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByText(/Tous les plans ont un média/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rétablir' }));
    expect(screen.getByText(/Tous les plans ont un média/i)).toBeTruthy();

    // Save project back to Supabase without data loss
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer$/i }));
    await waitFor(() => expect(apiMocks.updateProject).toHaveBeenCalledTimes(1));
    const savedEditor = apiMocks.updateProject.mock.calls[0][1].settings.reelora_editor_v1;
    expect(totalDuration(savedEditor)).toBeGreaterThan(0);
    expect(savedEditor.scenes.every((s: { source: { storagePath?: string } }) => s.source.storagePath === 'ws-1/videos/rush.mp4')).toBe(true);

    // Verify no paid generation or MuAPI start action exists in editor code
    const editorSrc = read('src/studio/VideoEditor.tsx');
    expect(editorSrc).not.toContain('videoStart');
    expect(editorSrc).not.toContain('startGeneration');
  });
});

describe('Sécurité, routes historiques et garde-fous Phase 1 & 2 préservés', () => {
  it('conserve toutes les routes historiques et verify_jwt=true sur reelora-ai et reelora-video', () => {
    const app = read('src/App.tsx');
    for (const route of ['path="studio"', 'path="studio/classique"', 'path="studio/montage"', 'path="studio/avance"', 'path="projets/:id"']) {
      expect(app).toContain(route);
    }
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.reelora-ai\][\s\S]*?verify_jwt\s*=\s*true/);
    expect(config).toMatch(/\[functions\.reelora-video\][\s\S]*?verify_jwt\s*=\s*true/);
  });
});
