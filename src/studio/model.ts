import type { MuApiModel, MuApiParamDef, ReeloraModelStatus } from '../lib/types';

/** Values a dynamic parameter can hold. Kept in sync with the Edge Function. */
export type ParamValue = string | number | boolean;

export type GenerationMode =
  | 'text-to-video'
  | 'image-to-video'
  | 'video-to-video'
  | 'audio-to-video'
  | 'video-edit'
  | 'video-tools'
  | 'effects'
  | 'lora'
  | 'training'
  | 'other';

export const MODE_LABELS: Record<GenerationMode, string> = {
  'text-to-video': 'Texte → Vidéo',
  'image-to-video': 'Image → Vidéo',
  'video-to-video': 'Vidéo → Vidéo',
  'audio-to-video': 'Audio → Vidéo',
  'video-edit': 'Édition vidéo',
  'video-tools': 'Outils vidéo',
  effects: 'Effets vidéo',
  lora: 'LoRA vidéo',
  training: 'Entraînement vidéo',
  other: 'Autre famille vidéo',
};

export const MODE_DESCRIPTIONS: Record<GenerationMode, string> = {
  'text-to-video': 'Décrivez la scène : MuAPI génère la vidéo à partir de votre prompt.',
  'image-to-video': 'Importez une image de référence et décrivez le mouvement souhaité.',
  'video-to-video': 'Transformation d’une vidéo existante : source vidéo non connectée dans Reelora.',
  'audio-to-video': 'Avatar / lip sync : source audio non produite par Reelora.',
  'video-edit': 'Édition ou habillage d’une vidéo : source vidéo non connectée.',
  'video-tools': 'Outil vidéo : entrées spécifiques non connectées.',
  effects: 'Effet animé depuis une image : source image requise.',
  lora: 'Modèle LoRA vidéo : entrées spécifiques non connectées.',
  training: 'Entraînement vidéo : aucun parcours Reelora connecté.',
  other: 'Famille vidéo déclarée par MuAPI, sans moteur Reelora dédié.',
};

/**
 * Required input fields Reelora can actually provide today. A verified model
 * that requires anything else (audio, video, multiple images, a previous
 * request id, …) is shown in the catalogue but never presented as a working
 * generation path until that capability is integrated.
 */
export const SUPPORTED_REQUIRED_FIELDS = new Set(['prompt', 'image_url']);

/** Source fields are supplied separately, never exposed as tunable parameters. */
const SOURCE_FIELDS = new Set([
  'prompt', 'image_url', 'last_image', 'audio_url', 'video_url', 'input_video',
  'images_list', 'image_urls', 'mask_image_url', 'mask_video_url', 'request_id',
  'audios_list', 'videos_list', 'audio_files', 'video_files', 'draft_request_id',
  'omni_reference_task_type', 'draft', 'end_image_url', 'first_frame_url',
  'last_frame_url', 'reference_audios', 'reference_videos', 'reference_images',
  'video_urls', 'audio_ids', 'character_ids', 'loras', 'lora_list', 'elements',
  'origin_task_id', 'end_time', 'start_time', 'trim_start', 'trim_end',
  'templ_start_seconds', 'templ_end_seconds', 'reference_video_url',
  'first_frame_image', 'last_frame_image', 'image', 'video', 'audio',
]);

/** Structured / media inputs never become invented scalar controls. */
export function isSourceField(key: string): boolean {
  const k = key.toLowerCase();
  if (SOURCE_FIELDS.has(k)) return true;
  return k.endsWith('_url') || k.endsWith('_urls') || k.endsWith('_list')
    || k.endsWith('_files') || k.endsWith('_file') || k.endsWith('_ids')
    || k.endsWith('_images') || k.endsWith('_videos') || k.endsWith('_audios')
    || k.endsWith('_request_id') || k.endsWith('_task_id') || k.endsWith('_frame_url')
    || k.startsWith('reference_') || k.startsWith('mask_') || k.startsWith('templ_')
    || k === 'draft' || k === 'elements' || k === 'loras' || k === 'lora_list';
}

/** Family is derived from the REAL model identifier returned by the MuAPI catalog. */
export function modelFamily(model: MuApiModel): string {
  const id = model.model_id.toLowerCase();
  if (id.startsWith('seedance')) return 'Seedance · ByteDance';
  if (id.startsWith('veo')) return 'Veo · Google';
  if (id.startsWith('grok')) return 'Grok Imagine · xAI';
  if (id.startsWith('kling')) return 'Kling · Kuaishou';
  if (id.startsWith('wan')) return 'Wan · Alibaba';
  if (id.startsWith('ltx')) return 'LTX · Lightricks';
  if (id.startsWith('hailuo') || id.startsWith('minimax')) return 'Hailuo · MiniMax';
  return model.family || model.category || 'MuAPI';
}

/** Modes are derived from real category, family and declared input fields. */
export function modelModes(model: MuApiModel): GenerationMode[] {
  const fields = model.input_fields.map((f) => f.toLowerCase());
  const cat = (model.category ?? '').toLowerCase();
  const group = (model.group_of ?? '').toLowerCase();
  const sourceModes: GenerationMode[] = [];
  const modes: GenerationMode[] = [];

  if (fields.includes('video_url') || fields.includes('input_video') || cat.includes('video to video')) {
    sourceModes.push('video-to-video');
  }
  if (fields.includes('audio_url') || cat.includes('audio to video') || group === 'avatar' || group === 'lipsync') {
    sourceModes.push('audio-to-video');
  }
  if (fields.includes('image_url') || fields.includes('first_frame') || cat.includes('image to video')) {
    sourceModes.push('image-to-video');
  }
  modes.push(...sourceModes);
  if (group === 'video-edit') modes.push('video-edit');
  if (group === 'video-tools') modes.push('video-tools');
  if (group === 'ai-effects') modes.push('effects');
  if (cat.includes('lora')) modes.push('lora');
  if (cat.includes('training')) modes.push('training');
  // A declared source field takes precedence over the public category: never
  // advertise a text-only mode for a model that actually needs media.
  if (sourceModes.length === 0 && modes.length === 0
    && (cat.includes('text to video') || !fields.some((f) => isSourceField(f)))) {
    modes.push('text-to-video');
  }
  if (modes.length === 0) modes.push('other');
  return [...new Set(modes)];
}

export function modeFromModel(model: MuApiModel): GenerationMode {
  return modelModes(model)[0];
}

export function modelsForMode(models: MuApiModel[], mode: GenerationMode): MuApiModel[] {
  return models.filter((m) => modelModes(m).includes(mode));
}

/** Only parameters declared in BOTH param_schema and input_fields are shown. */
export function supportedParams(model: MuApiModel): Array<[string, MuApiParamDef]> {
  return Object.entries(model.param_schema ?? {}).filter(([key, def]) =>
    !key.startsWith('__')
    && !isSourceField(key)
    && model.input_fields.includes(key)
    && def != null,
  );
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

/** French labels for parameters exposed by the verified MuAPI catalog. */
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
  generate_audio: 'Audio natif',
  enable_watermark: 'Filigrane',
  quality: 'Qualité',
  name: 'Type d’effet',
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

/** A model is selectable only when MuAPI AND Reelora can really serve it. */
export function reeloraModelStatus(model: MuApiModel): { status: ReeloraModelStatus; reason: string } {
  if (!model.is_enabled) return { status: 'disabled', reason: 'Désactivé dans le catalogue MuAPI.' };
  if (model.is_coming_soon) return { status: 'coming_soon', reason: 'Annoncé par MuAPI, pas encore lancé.' };
  const unsupported = (model.required_fields ?? []).filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) {
    return { status: 'unsupported', reason: `Entrée non connectée dans Reelora : ${unsupported.join(', ')}.` };
  }
  if (model.account_access === 'unverified') {
    return { status: 'unverified', reason: 'Clé / compte MuAPI non validée côté serveur.' };
  }
  if (model.account_access === 'public_only') {
    return { status: 'unverified', reason: 'Modèle public MuAPI non accessible au compte configuré.' };
  }
  return { status: 'active', reason: 'Modèle actif et sélectionnable.' };
}

export function isModelAvailable(model: MuApiModel): boolean {
  if (!model.is_enabled || model.is_coming_soon) return false;
  return reeloraModelStatus(model).status === 'active';
}

export function statusLabel(status: ReeloraModelStatus): string {
  return {
    active: 'Actif',
    disabled: 'Désactivé',
    coming_soon: 'Bientôt',
    unsupported: 'Entrée non connectée',
    unverified: 'Compte non vérifié',
  }[status];
}

/** Cost shown to the user comes from the server estimate; never a local guess. */
export function providerCostLabel(costUsd: number | string | null | undefined, currency = 'USD'): string {
  const n = Number(costUsd);
  return Number.isFinite(n) && costUsd !== null && costUsd !== undefined
    ? `${n.toFixed(3)} ${currency}`
    : 'non communiqué';
}

/** Wording required when MuAPI's exact estimate-cost quote cannot be obtained. */
export const QUOTE_TO_CONFIRM = 'devis fournisseur à confirmer';

export interface ProviderQuoteView {
  provider_cost_usd?: number | string | null;
  provider_cost_currency?: string;
  provider_quote_source?: 'catalog' | 'estimate_cost' | 'unavailable' | string;
}

/** True only when the displayed USD amount comes from a successful exact quote. */
export function isExactProviderQuote(estimate: ProviderQuoteView | null | undefined): boolean {
  return estimate?.provider_quote_source === 'estimate_cost'
    && estimate.provider_cost_usd !== null && estimate.provider_cost_usd !== undefined
    && Number.isFinite(Number(estimate.provider_cost_usd));
}

/**
 * Never display `0.000 USD` for a failed or absent quote. A catalogue tariff is
 * factual but is explicitly labelled as a non-exact quote; `unavailable` has no
 * price at all and is only described as "devis fournisseur à confirmer".
 */
export function providerQuoteCostLabel(estimate: ProviderQuoteView | null | undefined): string {
  if (!estimate || estimate.provider_quote_source === 'unavailable'
    || estimate.provider_cost_usd === null || estimate.provider_cost_usd === undefined) {
    return QUOTE_TO_CONFIRM;
  }
  return providerCostLabel(estimate.provider_cost_usd, estimate.provider_cost_currency ?? 'USD');
}

export function providerQuoteOriginLabel(estimate: ProviderQuoteView | null | undefined): string {
  if (isExactProviderQuote(estimate)) return 'estimate-cost MuAPI';
  if (!estimate || estimate.provider_quote_source === 'unavailable'
    || estimate.provider_cost_usd === null || estimate.provider_cost_usd === undefined) {
    return QUOTE_TO_CONFIRM;
  }
  return 'tarif catalogue MuAPI · devis exact non disponible';
}
