import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MuApiModel } from '../src/lib/types';
import {
  MODE_DESCRIPTIONS, defaultParams, isModelAvailable, modelDurations, modelFamily, modelModes,
  modelRatios, modelResolutions, modelsForMode, normalizeParamValue, supportedParams,
} from '../src/studio/model';
import { EMPTY_STRUCTURE, composeStructuredPrompt } from '../src/studio/prompt';
import { NAV_SECTIONS, ROADMAP_SECTIONS, STUDIO_SECTIONS } from '../src/studio/sections';
import { TRACK_STEPS, trackingState } from '../src/studio/tracking';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

function model(overrides: Partial<MuApiModel> = {}): MuApiModel {
  return {
    model_id: 'seedance-lite-t2v', display_name: 'Seedance Lite', description: 'Prompt → vidéo',
    category: 'Text to Video', endpoint: '/api/v1/seedance-lite-t2v',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed'],
    required_fields: ['prompt'],
    param_schema: {
      aspect_ratio: { type: 'select', options: ['16:9', '9:16', '1:1'], default: '9:16' },
      resolution: { type: 'select', options: ['480p', '720p', '1080p'], default: '480p' },
      duration: { type: 'number', min: 5, max: 30, default: 5 },
      camera_fixed: { type: 'boolean', default: false },
      ghost_setting: { type: 'select', options: ['never'] },
    },
    cost_usd: 0.1, cost_currency: 'USD', is_enabled: true, is_coming_soon: false,
    ...overrides,
  };
}

describe('catalogue dynamique du Video Studio', () => {
  it('dérive les modes des champs réels, sans liste de modèles figée', () => {
    expect(modelModes(model())).toEqual(['text-to-video']);
    expect(modelModes(model({
      model_id: 'seedance-lite-i2v', category: 'Image to Video',
      input_fields: ['prompt', 'image_url', 'last_image'], required_fields: ['prompt', 'image_url'],
    }))).toEqual(['image-to-video']);
    expect(modelModes(model({
      model_id: 'hypothetical-v2v', input_fields: ['prompt', 'video_url'],
    }))).toEqual(['video-to-video']);
  });

  it('filtre les modèles par mode sans inventer de capacité', () => {
    const t2v = model();
    const i2v = model({ model_id: 'seedance-lite-i2v', input_fields: ['prompt', 'image_url'], required_fields: ['prompt', 'image_url'] });
    const list = [t2v, i2v];
    expect(modelsForMode(list, 'text-to-video').map((m) => m.model_id)).toEqual(['seedance-lite-t2v']);
    expect(modelsForMode(list, 'image-to-video').map((m) => m.model_id)).toEqual(['seedance-lite-i2v']);
    expect(modelsForMode(list, 'video-to-video')).toEqual([]);
  });

  it('n’affiche et n’envoie que les paramètres déclarés dans param_schema ET input_fields', () => {
    const keys = supportedParams(model()).map(([key]) => key);
    expect(keys).toContain('aspect_ratio');
    expect(keys).toContain('duration');
    expect(keys).not.toContain('ghost_setting');
    expect(keys).not.toContain('negative_prompt');
    expect(defaultParams(model())).toEqual({ aspect_ratio: '9:16', resolution: '480p', duration: 5, camera_fixed: false });
  });

  it('conserve le type numérique des options MuAPI et résume les capacités', () => {
    const kling = model({
      model_id: 'kling-o1-standard-image-to-video', input_fields: ['prompt', 'image_url', 'duration'],
      required_fields: ['prompt', 'image_url'], param_schema: { duration: { type: 'select', options: [5, 10], default: 5 } },
    });
    expect(normalizeParamValue(kling, 'duration', '10')).toBe(10);
    expect(modelDurations(kling)).toEqual(['5 s', '10 s']);
    expect(modelDurations(model())).toEqual(['5 à 30 s']);
  });

  it('expose formats, résolutions, famille et disponibilité depuis la ligne live', () => {
    const m = model();
    expect(modelRatios(m)).toEqual(['16:9', '9:16', '1:1']);
    expect(modelResolutions(m)).toEqual(['480p', '720p', '1080p']);
    expect(modelFamily(m)).toContain('Seedance');
    expect(isModelAvailable(m)).toBe(true);
    expect(isModelAvailable({ ...m, is_coming_soon: true })).toBe(false);
    expect(isModelAvailable({ ...m, is_enabled: false })).toBe(false);
  });
});

describe('suivi professionnel', () => {
  it('couvre tous les états métier dans un ordre stable', () => {
    expect(TRACK_STEPS.map((s) => s.id)).toEqual(['draft', 'queued', 'submitting', 'processing', 'finalizing', 'succeeded']);
    expect(trackingState('', null).tone).toBe('idle');
    expect(trackingState('queued', null)).toMatchObject({ label: 'En attente', serverSide: true });
    expect(trackingState('reserved', null)).toMatchObject({ label: 'Lancement' });
    expect(trackingState('processing', 'processing')).toMatchObject({ label: 'En cours de génération', serverSide: true });
    expect(trackingState('processing', 'completed')).toMatchObject({ label: 'Traitement du résultat' });
    expect(trackingState('succeeded', 'completed')).toMatchObject({ label: 'Terminé', progress: 100, tone: 'success' });
    expect(trackingState('failed', 'failed')).toMatchObject({ tone: 'error' });
    expect(trackingState('cancelled', null)).toMatchObject({ tone: 'cancelled' });
  });
});

describe('architecture modulaire et espaces préparés', () => {
  it('déclare les espaces livrés et préparés sans ambiguity', () => {
    const live = STUDIO_SECTIONS.filter((s) => s.status === 'live').map((s) => s.id);
    expect(live).toEqual(expect.arrayContaining(['video', 'generations', 'projects', 'saved']));
    // Video→Video et Lip Sync sont désormais livrés : leur capacité réelle
    // existe côté fournisseur et le Studio les ouvre sur `?mode=`.
    for (const id of ['video-to-video', 'lip-sync']) {
      const section = STUDIO_SECTIONS.find((s) => s.id === id);
      expect(section?.status).toBe('live');
      expect(section?.route).toMatch(/^\/app\/studio\?mode=/);
    }
    // Ce qui n'a réellement aucun moteur connecté reste marqué « préparé ».
    for (const id of ['image', 'avatar', 'audio', 'workflows', 'storyboarding']) {
      expect(STUDIO_SECTIONS.find((s) => s.id === id)?.status).toBe('prepared');
    }
    expect(NAV_SECTIONS.every((s) => s.group !== 'roadmap')).toBe(true);
    expect(ROADMAP_SECTIONS.every((s) => s.status === 'prepared')).toBe(true);
  });

  it('n’affiche aucun bouton de génération dans les fiches préparées', () => {
    const prepared = read('src/studio/components/PreparedSpace.tsx');
    expect(prepared).toContain('Préparé · non opérationnel');
    expect(prepared).toContain('Aucun bouton de génération');
    expect(prepared).not.toMatch(/Générer|Generate/i);
  });

  it('ne révèle pas les noms des services techniques dans les textes publics du Studio', () => {
    const tracking = [
      trackingState('', ''),
      trackingState('queued', ''),
      trackingState('processing', 'processing'),
      trackingState('succeeded', 'completed'),
      trackingState('failed', ''),
    ];
    const publicCopy = [
      ...Object.values(MODE_DESCRIPTIONS),
      ...STUDIO_SECTIONS.map((section) => section.description),
      ...tracking.map((state) => `${state.label} ${state.description}`),
    ].join(' ');
    expect(publicCopy).not.toMatch(/MuAPI|Groq|Gemini|USD/i);
  });

  it('les images de référence restent privées et compatibles avec les fonctions live', () => {
    const videoStudio = read('src/studio/VideoStudio.tsx');
    expect(videoStudio).toContain('uploadReferenceImage');
    expect(videoStudio).toContain('signedStorageUrl(firstPath, 86400)');
    expect(videoStudio).toContain('image_storage_path');
    expect(videoStudio).toContain('last_image_storage_path');
    expect(videoStudio).toContain('image_url: await signedStorageUrl');
    expect(videoStudio).not.toContain('VITE_MUAPI');
  });
});

describe('prompt structuré et sécurité des secrets', () => {
  it('assemble uniquement les valeurs saisies par l’utilisateur', () => {
    expect(composeStructuredPrompt(EMPTY_STRUCTURE)).toBe('');
    const text = composeStructuredPrompt({ ...EMPTY_STRUCTURE, character: 'Une créatrice', movement: 'Travelling lent' });
    expect(text).toContain('Une créatrice');
    expect(text).toContain('Travelling lent');
    expect(text).not.toContain('Décor');
  });

  it('aucun frontend du studio ne lit une clé MuAPI ou un en-tête fournisseur', () => {
    const files = readdirSync(join(process.cwd(), 'src/studio'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name)).map((e) => e.name);
    const components = readdirSync(join(process.cwd(), 'src/studio/components'))
      .filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => `src/studio/components/${f}`);
    for (const file of [...files.map((f) => `src/studio/${f}`), ...components]) {
      const source = read(file);
      expect(source).not.toContain('x-api-key');
      expect(source).not.toContain('Deno.env.get');
      expect(source).not.toContain('process.env');
      expect(source).not.toContain('VITE_MUAPI');
    }
  });
});
