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
import { isModelAvailable, modelsForMode, supportedParams, type GenerationMode } from './model';
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

/** Sorted by the real provider cost declared in the verified catalog. */
export function catalogByCost(models: MuApiModel[], mode: GenerationMode): MuApiModel[] {
  return modelsForMode(models, mode)
    .filter(isModelAvailable)
    .filter((m) => (m.required_fields ?? []).every((field) => ['prompt', 'image_url'].includes(field.toLowerCase())))
    .slice()
    .sort((a, b) => {
      const ca = Number(a.cost_usd);
      const cb = Number(b.cost_usd);
      return (Number.isFinite(ca) ? ca : 0) - (Number.isFinite(cb) ? cb : 0);
    });
}

export function modelForQuality(models: MuApiModel[], mode: GenerationMode, tier: QualityTier): MuApiModel | null {
  const sorted = catalogByCost(models, mode);
  if (sorted.length === 0) return null;
  const index = tier === 'rapide' ? 0
    : tier === 'standard' ? Math.floor((sorted.length - 1) / 2)
      : sorted.length - 1;
  return sorted[Math.min(index, sorted.length - 1)];
}

/** Only parameters the selected model really accepts. */
export function compatibleParams(model: MuApiModel | null): Array<[string, MuApiParamDef]> {
  return model ? supportedParams(model) : [];
}

export function selectOptions(model: MuApiModel | null, key: string): string[] {
  if (!model) return [];
  const def = model.param_schema?.[key];
  return def?.type === 'select' && Array.isArray(def.options) ? def.options.map(String) : [];
}

export function numericRange(model: MuApiModel | null, key: string): { min: number; max: number } | null {
  if (!model) return null;
  const def = model.param_schema?.[key];
  return def?.type === 'number' ? { min: Number(def.min ?? 1), max: Number(def.max ?? 300) } : null;
}

/** Clamp a user duration to the model's REAL bounds; null = not supported. */
export function clampToModelDuration(model: MuApiModel | null, desired: number): number | null {
  const range = numericRange(model, 'duration');
  if (!range) return null;
  const n = Number(desired);
  const base = Number.isFinite(n) ? n : range.min;
  // MuAPI duration selects (e.g. Kling 5|10) only accept declared option values.
  const def = model?.param_schema?.duration;
  if (def?.type === 'select') {
    const options = (def.options ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (options.length === 0) return null;
    return options.reduce((best, v) => Math.abs(v - base) < Math.abs(best - base) ? v : best, options[0]);
  }
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

/** Build the exact `params` object sent to the existing backend. */
export function buildCompatibleParams(
  model: MuApiModel | null,
  chosen: { ratio: string; resolution: string | null; duration: number | null; extras: Record<string, string | number | boolean> },
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!model) return out;
  for (const [key, def] of compatibleParams(model)) {
    if (key === 'aspect_ratio') {
      const options = selectOptions(model, key);
      if (options.includes(chosen.ratio)) out[key] = chosen.ratio;
      else if (options.length && typeof def.default === 'string') out[key] = def.default;
      continue;
    }
    if (key === 'resolution') {
      if (chosen.resolution && selectOptions(model, key).includes(chosen.resolution)) out[key] = chosen.resolution;
      continue;
    }
    if (key === 'duration') {
      const value = clampToModelDuration(model, chosen.duration ?? 5);
      if (value !== null) out[key] = value;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(chosen.extras, key)) {
      const raw = chosen.extras[key];
      if (def.type === 'select' && !selectOptions(model, key).includes(String(raw))) continue;
      if (def.type === 'boolean') out[key] = raw === true || raw === 'true' || raw === 1;
      else if (def.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) out[key] = n;
      } else out[key] = raw;
    } else if (def.default !== undefined) {
      out[key] = def.default as string | number | boolean;
    }
  }
  return out;
}
