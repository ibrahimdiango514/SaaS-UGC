/**
 * Quality tiers are a Reelora UX abstraction over the REAL backend.
 *
 * - The credit cost is NEVER computed here: it comes from the server action
 *   `reelora-video { action: "estimate" }` (ugc_service_catalog.credits_cost).
 * - The chosen MuAPI model is derived from the live verified catalog, ordered
 *   by its real `cost_usd`. No model identifier is invented.
 * - Compatible settings are derived from `param_schema ∩ input_fields`.
 */

import type { MuApiModel, MuApiParamDef, ServiceCatalogItem } from '../lib/types';
import {
  isModelAvailable, modelsForMode, normalizeParamValue, optionsOf, supportedParams,
  type GenerationMode,
} from './model';
export { SUPPORTED_REQUIRED_FIELDS } from './model';

export type QualityTier = 'rapide' | 'standard' | 'premium';

export interface QualityDefinition {
  id: QualityTier;
  label: string;
  description: string;
  /** Must exist and be active in ugc_service_catalog. */
  serviceKey: string;
}

/** Required input fields are declared in model.ts and shared with the Edge gateway. */
export const QUALITY_TIERS: QualityDefinition[] = [
  { id: 'rapide', label: 'Rapide', description: 'Clip court, modèle le plus économique', serviceKey: 'ugc_clip_8s' },
  { id: 'standard', label: 'Standard', description: 'Clip plus long, rendu équilibré', serviceKey: 'ugc_clip_15s' },
  { id: 'premium', label: 'Premium', description: 'Publicité UGC complète, modèle haut de gamme', serviceKey: 'ugc_ad_4clips' },
];

export function serviceForQuality(services: ServiceCatalogItem[], tier: QualityTier): ServiceCatalogItem | null {
  const def = QUALITY_TIERS.find((q) => q.id === tier);
  if (!def) return null;
  return services.find((s) => s.service_key === def.serviceKey && s.active) ?? null;
}

/**
 * A model without a KNOWN, finite catalogue price must never be ranked as
 * "le plus économique": the old `NaN → 0` fallback silently promoted unknown
 * prices. Only real declared costs can be compared.
 */
export function hasKnownCost(model: MuApiModel): boolean {
  const n = Number(model.cost_usd);
  return model.cost_usd !== null && model.cost_usd !== undefined && model.cost_usd !== ''
    && Number.isFinite(n) && n >= 0;
}

/** Sorted by the real provider cost declared in the verified catalog. */
export function catalogByCost(models: MuApiModel[], mode: GenerationMode): MuApiModel[] {
  return modelsForMode(models, mode)
    .filter(isModelAvailable)
    .filter((m) => (m.required_fields ?? []).every((field) => ['prompt', 'image_url'].includes(field.toLowerCase())))
    .filter(hasKnownCost)
    .slice()
    .sort((a, b) => Number(a.cost_usd) - Number(b.cost_usd));
}

export function modelForQuality(models: MuApiModel[], mode: GenerationMode, tier: QualityTier): MuApiModel | null {
  const sorted = catalogByCost(models, mode);
  if (sorted.length === 0) return null;
  const index = tier === 'rapide' ? 0
    : tier === 'standard' ? Math.floor((sorted.length - 1) / 2)
      : sorted.length - 1;
  return sorted[Math.min(index, sorted.length - 1)];
}

/** The exact Rapide / Standard / Premium → real model + service mapping. */
export function qualityTierSummary(models: MuApiModel[], services: ServiceCatalogItem[], mode: GenerationMode) {
  return QUALITY_TIERS.map((def) => {
    const service = serviceForQuality(services, def.id);
    const picked = modelForQuality(models, mode, def.id);
    return {
      tier: def.id,
      label: def.label,
      description: def.description,
      serviceKey: def.serviceKey,
      serviceActive: Boolean(service?.active),
      creditsCost: service?.credits_cost ?? null,
      modelId: picked?.model_id ?? null,
      modelName: picked?.display_name ?? null,
      catalogCostUsd: picked && hasKnownCost(picked) ? Number(picked.cost_usd) : null,
      available: Boolean(service?.active && picked),
    };
  });
}

/** Only parameters the selected model really accepts. */
export function compatibleParams(model: MuApiModel | null): Array<[string, MuApiParamDef]> {
  return model ? supportedParams(model) : [];
}

/**
 * MuAPI schemas describe options either as `type: "select"` or as another
 * scalar type carrying an `options` array. Both are real declared constraints;
 * requiring only `select` used to discard valid values.
 */
export function selectOptions(model: MuApiModel | null, key: string): string[] {
  return model ? optionsOf(model, key) : [];
}

export function numericRange(model: MuApiModel | null, key: string): { min: number; max: number } | null {
  if (!model) return null;
  const def = model.param_schema?.[key];
  // Both bounds must be REAL declared bounds: never use 1..300 as a guess.
  if (!def || def.min == null || def.max == null) return null;
  const min = Number(def.min);
  const max = Number(def.max);
  return Number.isFinite(min) && Number.isFinite(max) && max >= min ? { min, max } : null;
}

/** Clamp a user duration to the model's REAL bounds; null = not supported. */
export function clampToModelDuration(model: MuApiModel | null, desired: number): number | null {
  if (!model) return null;
  const def = model.param_schema?.duration;
  const n = Number(desired);
  // MuAPI duration selects (e.g. Kling 5|10) only accept declared option values.
  const declared = selectOptions(model, 'duration').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (declared.length) {
    const base = Number.isFinite(n) ? n : declared[0];
    return declared.reduce((best, v) => Math.abs(v - base) < Math.abs(best - base) ? v : best, declared[0]);
  }
  const range = numericRange(model, 'duration');
  if (!range) return Number.isFinite(Number(def?.default)) ? Number(def?.default) : null;
  const base = Number.isFinite(n) ? n : range.min;
  return Math.min(range.max, Math.max(range.min, Math.round(base)));
}

/** Default generation settings from the model's declared schema, ratio 9:16 first. */
export function defaultSettingsFor(model: MuApiModel | null): {
  ratio: string; resolution: string | null; duration: number | null;
} {
  const ratios = selectOptions(model, 'aspect_ratio');
  const resolutions = selectOptions(model, 'resolution');
  const defRatio = model?.param_schema?.aspect_ratio?.default;
  const defRes = model?.param_schema?.resolution?.default;
  const ratio = ratios.includes('9:16') ? '9:16'
    : (typeof defRatio === 'string' ? defRatio : ratios[0] ?? '9:16');
  return {
    ratio,
    resolution: resolutions.length ? String(defRes ?? resolutions[0]) : null,
    duration: clampToModelDuration(model, 5),
  };
}

/**
 * Only a value that the REAL schema declares is sent. MuAPI catalog rows with
 * a placeholder `string` field and no options/default must not receive a
 * guessed `9:16`, `720p` or duration from the local UI.
 */
function declaredScalar(
  model: MuApiModel,
  key: string,
  def: MuApiParamDef,
  candidate: string | number | boolean,
): string | number | boolean | null {
  const options = selectOptions(model, key);
  if (options.length) {
    const raw = String(candidate);
    if (options.includes(raw)) return normalizeParamValue(model, key, raw);
    if (def.default !== undefined && options.includes(String(def.default))) return def.default;
    return null;
  }
  if (def.default !== undefined) return def.default;
  return null;
}

/** Build the exact `params` object sent to the existing backend. */
export function buildCompatibleParams(
  model: MuApiModel | null,
  chosen: { ratio: string; resolution: string | null; duration: number | null; extras: Record<string, string | number | boolean> },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!model) return out;
  for (const [key, def] of compatibleParams(model)) {
    if (key === 'aspect_ratio') {
      const value = declaredScalar(model, key, def, chosen.ratio);
      if (value !== null) out[key] = value;
      continue;
    }
    if (key === 'resolution') {
      if (chosen.resolution === null) continue;
      const value = declaredScalar(model, key, def, chosen.resolution);
      if (value !== null) out[key] = value;
      continue;
    }
    if (key === 'duration') {
      const value = clampToModelDuration(model, chosen.duration ?? 5);
      if (value !== null) out[key] = value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(chosen.extras, key)) {
      const raw = chosen.extras[key];
      const options = selectOptions(model, key);
      if (options.length && !options.includes(String(raw))) continue;
      if (def.type === 'boolean') out[key] = raw === true || raw === 'true' || raw === 1;
      else if (def.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) {
          const range = numericRange(model, key);
          out[key] = range ? Math.min(range.max, Math.max(range.min, n)) : normalizeParamValue(model, key, String(raw));
        }
      } else out[key] = options.length ? normalizeParamValue(model, key, String(raw)) : raw;
    } else if (def.default !== undefined) {
      out[key] = def.default as string | number | boolean;
    }
  }
  return out;
}
