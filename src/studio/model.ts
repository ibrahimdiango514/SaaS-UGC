import type { MuApiModel, MuApiParamDef } from '../lib/types';

/** Values a dynamic parameter can hold. Kept in sync with the Edge Function. */
export type ParamValue = string | number | boolean;

export type GenerationMode = 'text-to-video' | 'image-to-video' | 'video-to-video';

export const MODE_LABELS: Record<GenerationMode, string> = {
  'text-to-video': 'Texte → Vidéo',
  'image-to-video': 'Image → Vidéo',
  'video-to-video': 'Vidéo → Vidéo',
};

export const MODE_DESCRIPTIONS: Record<GenerationMode, string> = {
  'text-to-video': 'Décrivez la scène : MuAPI génère la vidéo à partir de votre prompt.',
  'image-to-video': 'Importez une image de référence et décrivez le mouvement souhaité.',
  'video-to-video': 'Transformation d’une vidéo existante — aucun modèle vérifié n’est encore intégré.',
};

/**
 * Family is derived from the REAL model identifier returned by the MuAPI
 * catalog (never from a hardcoded model list). It is a display label only.
 */
export function modelFamily(model: MuApiModel): string {
  const id = model.model_id.toLowerCase();
  if (id.startsWith('seedance')) return 'Seedance · ByteDance';
  if (id.startsWith('veo')) return 'Veo · Google';
  if (id.startsWith('grok')) return 'Grok Imagine · xAI';
  if (id.startsWith('kling')) return 'Kling · Kuaishou';
  if (id.startsWith('wan')) return 'Wan · Alibaba';
  if (id.startsWith('ltx')) return 'LTX · Lightricks';
  if (id.startsWith('hailuo') || id.startsWith('minimax')) return 'Hailuo · MiniMax';
  return model.category || 'MuAPI';
}

/** Modes are derived from the fields the model actually declares. */
export function modelModes(model: MuApiModel): GenerationMode[] {
  const fields = model.input_fields.map((f) => f.toLowerCase());
  const modes: GenerationMode[] = [];
  if (fields.includes('video_url') || fields.includes('input_video')) modes.push('video-to-video');
  if (fields.includes('image_url') || fields.includes('first_frame')) modes.push('image-to-video');
  if (!fields.includes('audio_url') && !fields.includes('video_url') && !fields.includes('image_url')) {
    modes.push('text-to-video');
  }
  // An image-to-video model still accepts a text prompt, but the mode selector
  // exposes the strongest capability of that model.
  if (modes.length === 0) modes.push('text-to-video');
  return modes;
}

export function modeFromModel(model: MuApiModel): GenerationMode {
  return modelModes(model)[0];
}

export function modelsForMode(models: MuApiModel[], mode: GenerationMode): MuApiModel[] {
  return models.filter((m) => modelModes(m).includes(mode));
}

/** Only parameters declared in BOTH param_schema and input_fields are shown. */
export function supportedParams(model: MuApiModel): Array<[string, MuApiParamDef]> {
  return Object.entries(model.param_schema ?? {}).filter(([key]) => model.input_fields.includes(key));
}

export function defaultParams(model: MuApiModel | undefined): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  if (!model) return out;
  for (const [key, def] of supportedParams(model)) {
    if (def.default !== undefined) out[key] = def.default;
  }
  return out;
}

export function optionsOf(model: MuApiModel, key: string): string[] {
  const def = model.param_schema?.[key];
  return (def?.options ?? []).map(String);
}

/** A select value must keep the exact type declared in the MuAPI schema. */
export function normalizeParamValue(model: MuApiModel, key: string, raw: string): ParamValue {
  const option = model.param_schema?.[key]?.options?.find((v) => String(v) === raw);
  return typeof option === 'number' ? option : raw;
}

export function modelResolutions(model: MuApiModel): string[] {
  return optionsOf(model, 'resolution');
}

export function modelRatios(model: MuApiModel): string[] {
  return optionsOf(model, 'aspect_ratio');
}

export function modelDurations(model: MuApiModel): string[] {
  const def = model.param_schema?.duration;
  if (def?.options?.length) return def.options.map((v) => `${v} s`);
  if (def?.min != null && def?.max != null) return [`${def.min} à ${def.max} s`];
  return [];
}

/** French labels for the parameter keys exposed by the verified MuAPI catalog. */
const PARAM_LABELS: Record<string, string> = {
  aspect_ratio: 'Format / ratio',
  resolution: 'Résolution',
  duration: 'Durée',
  mode: 'Mode de génération',
  camera_fixed: 'Caméra fixe',
  negative_prompt: 'Prompt négatif',
  seed: 'Graine aléatoire',
  speed: 'Vitesse de génération',
  motion_strength: 'Intensité du mouvement',
  guidance_scale: 'Fidélité au prompt',
  audio: 'Ambiance sonore',
};

export function paramLabel(key: string): string {
  if (PARAM_LABELS[key]) return PARAM_LABELS[key];
  return key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Human-readable summary of the selected parameters (no invented values). */
export function paramsSummary(params: Record<string, ParamValue>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== '' && v !== undefined);
  if (!entries.length) return 'Paramètres par défaut du modèle';
  return entries.map(([k, v]) => `${paramLabel(k)} : ${typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v)}`).join(' · ');
}

export function isModelAvailable(model: MuApiModel): boolean {
  return Boolean(model.is_enabled && !model.is_coming_soon);
}

/** Cost shown to the user comes from the server estimate; never a local guess. */
export function providerCostLabel(costUsd: number | string | null | undefined, currency = 'USD'): string {
  const n = Number(costUsd);
  return Number.isFinite(n) && costUsd !== null && costUsd !== undefined
    ? `${n.toFixed(3)} ${currency}`
    : 'non communiqué';
}
