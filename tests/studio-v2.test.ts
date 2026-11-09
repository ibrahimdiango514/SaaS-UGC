import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuApiModel } from '../src/lib/types';
import {
  PLAN_VERSION, buildLocalPlan, detectSector, extractDuration, mapAiScriptToPlan,
  planToEditorProject, replanEditorScenes, validateProductionPlan,
} from '../src/studio/plan';
import {
  QUALITY_TIERS, SUPPORTED_REQUIRED_FIELDS, buildCompatibleParams, catalogByCost,
  defaultSettingsFor, modelForQuality,
} from '../src/studio/quality';
import {
  ASPECT_PRESETS, EDITOR_SETTINGS_KEY, clampDuration, moveScene, parseEditorProject,
  patchScene, removeScene, replaceSceneSource, scenesWithMedia, totalDuration,
  type EditorProject,
} from '../src/studio/editor/types';
import { analyzeProject, subtitleSpans } from '../src/studio/editor/assist';
import {
  RENDER_LIMITATIONS, exportFilename, planRenderFrames, renderIssues, supportedMimeType,
} from '../src/studio/editor/render';
import {
  PLANNER_PROMPT_VERSION, PLANNER_SYSTEM_PROMPT, PLAN_OUTPUT_CONTRACT,
} from '../supabase/functions/reelora-ai/planner-prompt';

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  signedStorageUrl: vi.fn(),
  uploadEditorMedia: vi.fn(),
}));
vi.mock('../src/lib/api', () => api);

import {
  loadEditorProject, loadLocalDraft, saveEditorProject, saveLocalDraft,
} from '../src/studio/editor/persistence';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function model(overrides: Partial<MuApiModel> = {}): MuApiModel {
  return {
    model_id: 'seedance-lite-t2v', display_name: 'Seedance Lite', description: null,
    category: 'Text to Video', endpoint: '/api/v1/seedance-lite-t2v',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed'],
    required_fields: ['prompt'],
    param_schema: {
      aspect_ratio: { type: 'select', options: ['16:9', '9:16', '1:1'], default: '9:16' },
      resolution: { type: 'select', options: ['480p', '720p'], default: '480p' },
      duration: { type: 'number', min: 5, max: 30, default: 5 },
      camera_fixed: { type: 'boolean', default: false },
      ghost_setting: { type: 'select', options: ['never'] },
    },
    cost_usd: 0.1, cost_currency: 'USD', is_enabled: true, is_coming_soon: false,
    ...overrides,
  };
}

function editor(overrides: Partial<EditorProject> = {}): EditorProject {
  const plan = buildLocalPlan({ prompt: 'Crée une publicité UGC de 20 secondes pour un sérum cosmétique : accroche, démonstration et achat.', ratio: '9:16', subtitles: true });
  return {
    ...planToEditorProject(plan, {
      quality: 'standard', mode: 'idea', model: null, subtitles: true, demo: true,
    }),
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
  api.signedStorageUrl.mockResolvedValue('https://signed.example/clip.mp4');
});
afterEach(() => vi.unstubAllGlobals());

describe('Plan de production à partir d’UNE instruction', () => {
  it('détecte secteur, durée, produit et construit la structure narrative', () => {
    const prompt = 'Crée une publicité UGC de 20 secondes pour un sérum cosmétique : accroche, démonstration et achat.';
    const plan = buildLocalPlan({ prompt, ratio: '9:16', subtitles: true });
    expect(detectSector(prompt)).toBe('cosmetique');
    expect(extractDuration(prompt)).toBe(20);
    expect(plan.product.toLowerCase()).toContain('sérum');
    expect(plan.version).toBe(PLAN_VERSION);
    expect(plan.source).toBe('deterministic');
    expect(plan.ratio).toBe('9:16');
    expect(plan.scenes.map((s) => s.role)).toEqual(['hook', 'demo', 'proof', 'cta']);
    expect(plan.scenes.every((s) => s.visualPrompt.length > 0 && s.durationSeconds >= 0.5)).toBe(true);
    expect(validateProductionPlan(plan).ok).toBe(true);
  });

  it('refuse une sortie IA non conforme avant tout envoi au fournisseur', () => {
    expect(validateProductionPlan(null).ok).toBe(false);
    expect(validateProductionPlan({ version: 'autre', source: 'ai', objective: 'x', ratio: '4:3', scenes: [] }).ok).toBe(false);
    expect(mapAiScriptToPlan({}, buildLocalPlan({ prompt: 'Publicité UGC pour une application mobile.' })).ok).toBe(false);
    const raw = {
      script_text: 'Script UGC',
      scenes: [
        { scene_type: 'ugc', visual_prompt: 'Accroche réelle', duration_seconds: 4, spoken_text: 'Voix off', subtitle_text: 'Sous-titre' },
        { scene_type: 'product_demo', visual_prompt: 'Démonstration', duration_seconds: 6, spoken_text: 'Voix off 2' },
      ],
    };
    const mapped = mapAiScriptToPlan(raw, buildLocalPlan({ prompt: 'Publicité UGC de 10 secondes pour une application.' }));
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      expect(mapped.plan.source).toBe('ai');
      expect(mapped.plan.scenes).toHaveLength(2);
      expect(mapped.plan.scenes[1].subtitle).toContain('Voix off 2');
    }
  });

  it('mappe un plan vers un projet d’éditeur sans fabriquer de média', () => {
    const project = editor();
    expect(project.demo).toBe(true);
    expect(project.scenes).toHaveLength(4);
    expect(project.scenes.every((s) => s.source.kind === 'none' && !s.source.url)).toBe(true);
    expect(scenesWithMedia(project)).toHaveLength(0);
    expect(renderIssues(project).join(' ')).toContain('Média manquant');
  });

  it('recalcule les scènes en conservant les médias réels par position', () => {
    let project = editor();
    const first = project.scenes[0].id;
    project = replaceSceneSource(project, first, {
      kind: 'asset', name: 'creation.mp4', url: 'https://signed.example/real.mp4', storagePath: 'w/assets/creation.mp4', assetId: 'a1',
    });
    const newPlan = buildLocalPlan({ prompt: 'Nouvelle publicité UGC de 15 secondes pour une veste minimaliste.', ratio: '16:9', subtitles: false });
    const replanned = replanEditorScenes(project, newPlan);
    expect(replanned.aspect).toBe('16:9');
    expect(replanned.scenes[0].source.assetId).toBe('a1');
    expect(replanned.scenes.slice(1).every((s) => s.source.kind === 'none')).toBe(true);
    expect(replanned.prompt).toContain('veste');
  });
});

describe('Qualité, catalogue vérifié et devis', () => {
  it('ne calcule aucun coût côté frontend et expose trois niveaux réels', () => {
    expect(QUALITY_TIERS.map((q) => q.id)).toEqual(['rapide', 'standard', 'premium']);
    expect(QUALITY_TIERS.map((q) => q.serviceKey)).toEqual(['ugc_clip_8s', 'ugc_clip_15s', 'ugc_ad_4clips']);
    expect(read('src/studio/quality.ts')).not.toMatch(/credits_cost\s*[:=]\s*\d/);
    expect(read('src/studio/components/PromptBar.tsx')).toContain('creditSummary(estimate');
  });

  it('exclut un modèle vérifié dont une entrée requise n’est pas intégrée', () => {
    const cheap = model({ model_id: 'cheap-t2v', cost_usd: 0.05 });
    const mid = model({ model_id: 'mid-t2v', cost_usd: 0.2 });
    const premium = model({ model_id: 'premium-t2v', cost_usd: 0.6 });
    const audioRequired = model({
      model_id: 'avatar-lipsync', category: 'Image to Video',
      input_fields: ['prompt', 'image_url', 'audio_url'], required_fields: ['prompt', 'image_url', 'audio_url'], cost_usd: 0.01,
    });
    expect(SUPPORTED_REQUIRED_FIELDS.has('audio_url')).toBe(false);
    expect(catalogByCost([cheap, mid, premium], 'text-to-video').map((m) => m.model_id)).toEqual(['cheap-t2v', 'mid-t2v', 'premium-t2v']);
    expect(catalogByCost([audioRequired], 'image-to-video')).toHaveLength(0);
    expect(modelForQuality([cheap, mid, premium], 'text-to-video', 'standard')?.model_id).toBe('mid-t2v');
  });

  it('n’envoie que param_schema ∩ input_fields, avec 9:16 par défaut', () => {
    const m = model();
    expect(defaultSettingsFor(m).ratio).toBe('9:16');
    const params = buildCompatibleParams(m, {
      ratio: '9:16', resolution: '480p', duration: 99,
      extras: { camera_fixed: true, ghost_setting: 'never', unknown: 'x' },
    });
    expect(params).toEqual({ aspect_ratio: '9:16', resolution: '480p', duration: 30, camera_fixed: true });
    expect(params).not.toHaveProperty('ghost_setting');
    expect(params).not.toHaveProperty('unknown');
  });
});

describe('Timeline, pistes et analyse de montage déterministe', () => {
  it('réordonne, modifie, supprime et remplace une source réelle', () => {
    const p = editor();
    const ids = p.scenes.map((s) => s.id);
    const moved = moveScene(p, 3, 0);
    expect(moved.scenes[0].id).toBe(ids[3]);
    expect(moved.scenes[1].id).toBe(ids[0]);
    const patched = patchScene(p, ids[0], { duration: 100, trimStart: -4, transition: 'fade' });
    expect(patched.scenes[0].duration).toBe(60);
    expect(patched.scenes[0].trimStart).toBe(0);
    expect(patched.scenes[0].transition).toBe('fade');
    const removed = removeScene(p, ids[1]);
    expect(removed.scenes).toHaveLength(3);
    const attached = replaceSceneSource(p, ids[2], { kind: 'job', name: 'job.mp4', url: 'https://signed.example/job.mp4', jobId: 'j1' });
    expect(scenesWithMedia(attached).map((s) => s.id)).toEqual([ids[2]]);
    expect(clampDuration(0.1)).toBe(0.5);
    expect(totalDuration({ ...p, scenes: p.scenes.slice(0, 2) })).toBeGreaterThan(0);
  });

  it('parse strictement un projet sauvegardé et refuse un payload mal formé', () => {
    expect(parseEditorProject(null)).toBeNull();
    expect(parseEditorProject({ version: 99, scenes: [] })).toBeNull();
    const parsed = parseEditorProject(editor());
    expect(parsed?.version).toBe(1);
    expect(parsed?.scenes).toHaveLength(4);
    expect(parsed?.aspect).toBe('9:16');
  });

  it('produit des suggestions réelles, acceptables et refusables, sans réponse IA simulée', () => {
    const base = editor();
    const p: EditorProject = {
      ...base,
      scenes: base.scenes.map((s, i) => i === 0
        ? { ...s, spokenText: 'Voix off réelle pour synchroniser', subtitle: '' }
        : s),
    };
    const suggestions = analyzeProject(p, 20);
    expect(suggestions.some((s) => s.id === 'media' && s.severity === 'error')).toBe(true);
    expect(suggestions.some((s) => s.id === 'subtitles' && typeof s.apply === 'function')).toBe(true);
    expect(suggestions.some((s) => s.id === 'audio')).toBe(true);
    expect(read('src/studio/editor/assist.ts')).toContain('deterministic LOCAL rules');
    const spans = subtitleSpans(p);
    // The first scene deliberately has no subtitle, so only three real spans remain.
    expect(spans).toHaveLength(3);
    expect(spans[0].start).toBeCloseTo(p.scenes[0].duration, 5);
    expect(spans[1].start).toBeCloseTo(spans[0].end, 5);
  });
});

describe('Rendu navigateur réel et limites explicites', () => {
  it('planifie les images et refuse un export sans média', () => {
    const p = editor();
    expect(planRenderFrames({ ...p, scenes: p.scenes.slice(0, 2).map((s) => ({ ...s, duration: 2 })) }, 30)).toEqual([
      { sceneIndex: 0, startFrame: 0, endFrame: 59 },
      { sceneIndex: 1, startFrame: 60, endFrame: 119 },
    ]);
    expect(renderIssues(p).length).toBeGreaterThan(0);
    expect(RENDER_LIMITATIONS.join(' ')).toContain('temps réel');
    expect(RENDER_LIMITATIONS.join(' ')).toContain('CORS');
    expect(exportFilename({ ...p, title: 'Sérum Éclat' }, 'video/webm')).toMatch(/^serum-eclat-9x16\.webm$/);
  });

  it('détecte un MIME supporté sans prétendre à un transcodage serveur', () => {
    expect(supportedMimeType()).toBeNull();
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (t: string) => t === 'video/webm;codecs=vp9,opus' });
    expect(supportedMimeType()).toBe('video/webm;codecs=vp9,opus');
  });
});

describe('Persistance sans nouvelle table ni secret exposé', () => {
  it('enregistre dans settings[reelora_editor_v1] et retire les URL signées', async () => {
    api.getProject.mockResolvedValue({ settings: { unrelated: true } });
    api.updateProject.mockResolvedValue(undefined);
    let p = editor({ projectId: 'proj-1' });
    const id = p.scenes[0].id;
    p = replaceSceneSource(p, id, { kind: 'local', name: 'clip.mp4', url: 'blob:session', storagePath: 'w/editor/clip.mp4' });
    const saved = await saveEditorProject('proj-1', p);
    expect(api.updateProject).toHaveBeenCalledTimes(1);
    const settings = api.updateProject.mock.calls[0][1].settings as Record<string, unknown>;
    expect(settings.unrelated).toBe(true);
    const persisted = settings[EDITOR_SETTINGS_KEY] as { scenes: { source: { url?: string; storagePath?: string } }[] };
    expect(persisted.scenes[0].source.url).toBeUndefined();
    expect(persisted.scenes[0].source.storagePath).toBe('w/editor/clip.mp4');
    expect(saved.scenes[0].source.url).toBe('https://signed.example/clip.mp4');
  });

  it('re-signe les chemins privés à l’ouverture d’un projet', async () => {
    const p = editor({ projectId: 'proj-2' });
    p.scenes[0].source = { kind: 'asset', name: 'a.mp4', storagePath: 'w/assets/a.mp4' };
    api.getProject.mockResolvedValue({ settings: { [EDITOR_SETTINGS_KEY]: p } });
    const loaded = await loadEditorProject('proj-2');
    expect(api.signedStorageUrl).toHaveBeenCalledWith('w/assets/a.mp4', 3600);
    expect(loaded?.scenes[0].source.url).toBe('https://signed.example/clip.mp4');
  });

  it('supprime les blob: URL mortes au rechargement d’un brouillon local', () => {
    let p = editor();
    p = replaceSceneSource(p, p.scenes[0].id, { kind: 'local', name: 'local.mp4', url: 'blob:dead' });
    saveLocalDraft(p);
    const loaded = loadLocalDraft();
    expect(loaded?.scenes[0].source.url).toBeUndefined();
    expect(loaded?.scenes[0].source.kind).toBe('none');
  });
});

describe('System prompt interne, routes et ressources de démonstration', () => {
  it('maintient une version cohérente, côté serveur, sans champ technique exposé', () => {
    expect(PLANNER_PROMPT_VERSION).toBe(PLAN_VERSION);
    expect(PLAN_OUTPUT_CONTRACT.version).toBe(PLAN_VERSION);
    expect(PLANNER_SYSTEM_PROMPT).toContain('planificateur de production');
    expect(PLANNER_SYSTEM_PROMPT).toContain('Ne propose aucun paramètre technique de modèle');
    for (const f of readdirSync(join(process.cwd(), 'src'), { recursive: true }).filter((n) => String(n).endsWith('.ts') || String(n).endsWith('.tsx'))) {
      expect(read(`src/${f}`)).not.toContain('PLANNER_SYSTEM_PROMPT');
    }
    expect(read('supabase/functions/reelora-ai/planner-prompt.ts')).toContain('NOT deployed');
  });

  it('câble les routes du nouveau studio et de l’éditeur sans supprimer les parcours existants', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('path="studio" element={<GenerationStudio />}');
    expect(app).toContain('path="studio/classique" element={<VideoStudio />}');
    expect(app).toContain('path="studio/montage" element={<VideoEditor />}');
    expect(app).toContain('path="studio/avance" element={<StudioLegacy />}');
    const css = read('src/index.css');
    for (const cls of ['studio-icon-link', 'studio-select', 'studio-range', 'studio-chip', 'studio-input', 'studio-number', 'studio-action']) {
      expect(css).toContain(`.${cls}`);
    }
  });

  it('intègre cinq vrais JPEG de démonstration explicitement étiquetés', () => {
    const names = readdirSync(join(process.cwd(), 'public/studio-examples')).filter((n) => n.endsWith('.jpg'));
    expect(names).toHaveLength(5);
    for (const n of names) {
      const buf = readFileSync(join(process.cwd(), 'public/studio-examples', n));
      expect(buf.subarray(0, 3).toString('hex')).toBe('ffd8ff');
      expect(buf.length).toBeGreaterThan(10_000);
    }
    expect(read('src/studio/components/GenerationEmptyState.tsx')).toContain('Démo');
    expect(read('src/studio/components/StudioTopBar.tsx')).toContain('À venir');
    expect(ASPECT_PRESETS['9:16'].platforms).toContain('TikTok');
  });
});
