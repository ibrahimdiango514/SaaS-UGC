/**
 * Pure, testable helpers for the finalised Studio catalogue.
 *
 * Everything here is derived from the video catalog or opaque backend quote.
 */

import type { MuApiModel, VideoCostEstimate } from '../lib/types';
import {
  MODE_LABELS, modelDurations, modelModes, modelRatios, modelResolutions,
  reeloraModelStatus,
} from './model';

export type CatalogCategoryId = 'all' | 't2v' | 'i2v' | 'a2v' | 'v2v' | 'effects' | 'tools' | 'other';
export type CatalogStatusFilter = 'all' | 'active' | 'unavailable' | 'account' | 'public_only' | 'unverified';
export type CapabilityFilter = 'all' | 'ratio' | 'resolution' | 'duration' | 'audio' | 'image';
export type PricingFilter = 'all' | 'dynamic' | 'fixed';
export type CatalogSort = 'relevance' | 'cost-asc' | 'cost-desc' | 'name';

export interface CatalogFilters {
  query: string;
  category: CatalogCategoryId;
  status: CatalogStatusFilter;
  capability: CapabilityFilter;
  pricing: PricingFilter;
  sort: CatalogSort;
}

export const DEFAULT_CATALOG_FILTERS: CatalogFilters = {
  query: '', category: 'all', status: 'all', capability: 'all', pricing: 'all', sort: 'relevance',
};

interface CategoryOption { id: CatalogCategoryId; label: string; match: (m: MuApiModel) => boolean }

/**
 * Categories match the REAL 8 categories of the live catalog. Matching is done
 * on both the declared category and the derived mode, so a model whose category
 * is unusual but whose inputs are Text-to-Video is still found correctly.
 */
export const CATALOG_CATEGORIES: CategoryOption[] = [
  { id: 'all', label: 'Tous', match: () => true },
  { id: 't2v', label: 'Texte → Vidéo', match: (m) => m.category === 'Text to Video' || modelModes(m).includes('text-to-video') },
  { id: 'i2v', label: 'Image → Vidéo', match: (m) => m.category === 'Image to Video' || modelModes(m).includes('image-to-video') },
  { id: 'a2v', label: 'Audio / Avatar', match: (m) => m.category === 'Audio to Video' || ['avatar', 'lipsync'].includes((m.group_of ?? '').toLowerCase()) || modelModes(m).includes('audio-to-video') },
  { id: 'v2v', label: 'Vidéo → Vidéo', match: (m) => m.category === 'Video to Video' || modelModes(m).includes('video-to-video') },
  { id: 'effects', label: 'Effets', match: (m) => (m.group_of ?? '').toLowerCase() === 'ai-effects' || modelModes(m).includes('effects') },
  { id: 'tools', label: 'Outils / édition', match: (m) => ['video-tools', 'video-edit'].includes((m.group_of ?? '').toLowerCase()) || ['Lora Support', 'Training'].includes(m.category) },
  { id: 'other', label: 'Autres familles', match: (m) => !CATALOG_CATEGORIES.slice(1, 7).some((c) => c.match(m)) },
];

export const CATALOG_STATUSES: { id: CatalogStatusFilter; label: string }[] = [
  { id: 'all', label: 'Tous les statuts' },
  { id: 'active', label: 'Disponibles dans VYORA' },
  { id: 'unavailable', label: 'Indisponibles' },
];

export const CATALOG_CAPABILITIES: { id: CapabilityFilter; label: string }[] = [
  { id: 'all', label: 'Toutes les capacités' },
  { id: 'ratio', label: 'Format / ratio' },
  { id: 'resolution', label: 'Résolution' },
  { id: 'duration', label: 'Durée' },
  { id: 'audio', label: 'Audio natif' },
  { id: 'image', label: 'Image → vidéo' },
];

export const CATALOG_PRICING: { id: PricingFilter; label: string }[] = [
  { id: 'all', label: 'Toute tarification' },
  { id: 'dynamic', label: 'Devis dynamique' },
  { id: 'fixed', label: 'Tarif catalogue' },
];

export const CATALOG_SORTS: { id: CatalogSort; label: string }[] = [
  { id: 'relevance', label: 'Ordre du catalogue' },
  { id: 'name', label: 'Nom A → Z' },
];

/** The server decides availability; client-side status is only a mirror. */
export function catalogModelStatus(model: MuApiModel) {
  return model.reelora_status
    ? { status: model.reelora_status, reason: model.reelora_reason ?? '' }
    : reeloraModelStatus(model);
}

export interface ModelCapabilities {
  ratios: string[];
  resolutions: string[];
  durations: string[];
  hasRatio: boolean;
  hasResolution: boolean;
  hasDuration: boolean;
  hasAudio: boolean;
  hasImage: boolean;
  requiresImage: boolean;
  dynamicPricing: boolean;
  /** Short badges built ONLY from declared fields / declared options. */
  tags: string[];
}

function compact(values: string[], prefix: string, declared: string): string {
  if (!values.length) return declared;
  const head = values.slice(0, 2).join('/');
  return values.length > 2 ? `${prefix} ${head}…` : `${prefix} ${head}`;
}

/**
 * Capability badges use `input_fields` first: the synced catalog declares the
 * fields for all 236 active models, while the exact `param_schema` options are
 * only fetched on demand for the selected model (GET /models/{name}). When the
 * options are present they are shown verbatim; otherwise we state only that
 * the capability is declared — never a guessed value.
 */
export function modelCapabilities(model: MuApiModel): ModelCapabilities {
  const fields = model.input_fields.map((f) => f.toLowerCase());
  const ratios = modelRatios(model);
  const resolutions = modelResolutions(model);
  const durations = modelDurations(model);
  const hasRatio = fields.includes('aspect_ratio') || ratios.length > 0;
  const hasResolution = fields.includes('resolution') || resolutions.length > 0;
  const hasDuration = fields.includes('duration') || durations.length > 0;
  const hasAudio = fields.includes('generate_audio') || fields.includes('audio');
  const hasImage = fields.includes('image_url') || fields.includes('last_image') || fields.includes('first_frame');
  const requiresImage = model.required_fields.some((f) => f.toLowerCase() === 'image_url');
  const meta = (model.param_schema as Record<string, unknown> | undefined)?.['__catalog'] as { dynamic_pricing?: unknown } | undefined;
  const dynamicPricing = Boolean(model.dynamic_pricing) || meta?.dynamic_pricing === true;
  const tags: string[] = [];
  if (hasRatio) tags.push(compact(ratios, 'Formats', 'Format déclaré'));
  if (hasResolution) tags.push(compact(resolutions, 'Résolutions', 'Résolution déclarée'));
  if (hasDuration) tags.push(compact(durations, 'Durée', 'Durée déclarée'));
  if (hasAudio) tags.push('Audio natif');
  if (hasImage) tags.push(requiresImage ? 'Image requise' : 'Image → vidéo');
  return {
    ratios, resolutions, durations, hasRatio, hasResolution, hasDuration,
    hasAudio, hasImage, requiresImage, dynamicPricing, tags,
  };
}

function knownCostUsd(model: MuApiModel): number | null {
  const n = Number(model.cost_usd);
  return model.cost_usd !== null && model.cost_usd !== undefined && model.cost_usd !== ''
    && Number.isFinite(n) && n >= 0 ? n : null;
}

function searchHaystack(model: MuApiModel): string {
  return [
    model.model_id, model.display_name, model.description, model.family, model.group_of,
    model.category, model.endpoint, MODE_LABELS[modelModes(model)[0]] ?? '',
    ...modelCapabilities(model).tags,
  ].filter(Boolean).join(' ').toLowerCase();
}

function matches(model: MuApiModel, f: CatalogFilters, withCategory: boolean): boolean {
  if (withCategory) {
    const cat = CATALOG_CATEGORIES.find((c) => c.id === f.category)?.match ?? (() => true);
    if (!cat(model)) return false;
  }
  const s = catalogModelStatus(model);
  if (f.status === 'active' && s.status !== 'active') return false;
  if (f.status === 'unavailable' && s.status === 'active') return false;
  if (f.status === 'account' && model.account_access !== 'account') return false;
  if (f.status === 'public_only' && model.account_access !== 'public_only') return false;
  if (f.status === 'unverified' && model.account_access !== 'unverified') return false;
  if (f.pricing !== 'all') {
    const dyn = modelCapabilities(model).dynamicPricing;
    if (f.pricing === 'dynamic' && !dyn) return false;
    if (f.pricing === 'fixed' && dyn) return false;
  }
  if (f.capability !== 'all') {
    const c = modelCapabilities(model);
    const ok = f.capability === 'ratio' ? c.hasRatio
      : f.capability === 'resolution' ? c.hasResolution
        : f.capability === 'duration' ? c.hasDuration
          : f.capability === 'audio' ? c.hasAudio : c.hasImage;
    if (!ok) return false;
  }
  const tokens = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length) {
    const hay = searchHaystack(model);
    if (!tokens.every((t) => hay.includes(t))) return false;
  }
  return true;
}

function sortModels(items: MuApiModel[], sort: CatalogSort): MuApiModel[] {
  const out = items.slice();
  if (sort === 'name') return out.sort((a, b) => a.display_name.localeCompare(b.display_name, 'fr'));
  if (sort === 'cost-asc' || sort === 'cost-desc') {
    const sign = sort === 'cost-asc' ? 1 : -1;
    return out.sort((a, b) => {
      const ca = knownCostUsd(a);
      const cb = knownCostUsd(b);
      if (ca === null && cb === null) return 0;
      if (ca === null) return 1;
      if (cb === null) return -1;
      return sign * (ca - cb);
    });
  }
  return out;
}

export interface CatalogSearchResult {
  items: MuApiModel[];
  total: number;
  counts: Record<CatalogCategoryId, number>;
  activeFilters: number;
}

export function filterModels(models: MuApiModel[], f: CatalogFilters): CatalogSearchResult {
  const items = sortModels(models.filter((m) => matches(m, f, true)), f.sort);
  const counts = {} as Record<CatalogCategoryId, number>;
  for (const c of CATALOG_CATEGORIES) {
    counts[c.id] = models.filter((m) => matches(m, { ...f, category: c.id }, true)).length;
  }
  const activeFilters = (Object.keys(DEFAULT_CATALOG_FILTERS) as (keyof CatalogFilters)[])
    .filter((k) => f[k] !== DEFAULT_CATALOG_FILTERS[k]).length;
  return { items, total: items.length, counts, activeFilters };
}

export interface CreditSummary {
  creditsCost: number | null;
  balance: number;
  remaining: number | null;
  enough: boolean;
  exactQuote: boolean;
  quoteToConfirm: boolean;
  canReserve: boolean;
}

/**
 * Single source of truth for the customer-facing credit summary and reservation
 * guard. Internal provider quote details are not part of this display model.
 */
export function creditSummary(
  estimate: VideoCostEstimate | null | undefined,
  balance: number,
  _requiresExactQuote = false,
): CreditSummary {
  const raw = estimate?.credits_cost;
  const creditsCost = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  const remaining = creditsCost === null ? null : Math.max(0, balance - creditsCost);
  const enough = creditsCost !== null && creditsCost > 0 && balance >= creditsCost;
  const expiresAt = estimate?.quote_expires_at ? Date.parse(estimate.quote_expires_at) : Number.NaN;
  const quoteFresh = Number.isFinite(expiresAt) && expiresAt > Date.now();
  const exactQuote = Boolean(estimate?.quote_id && estimate.pricing_available && quoteFresh);
  const quoteToConfirm = !estimate || !estimate.pricing_available || !estimate.quote_id || !quoteFresh;
  const canReserve = Boolean(estimate)
    && estimate?.service_active === true
    && estimate?.model_available === true
    && Boolean(estimate?.quote_id)
    && !quoteToConfirm
    && enough;
  return {
    creditsCost, balance, remaining, enough,
    exactQuote,
    quoteToConfirm,
    canReserve: Boolean(canReserve),
  };
}

/** Explicit confirmation is mandatory: no accepted checkbox ⇒ no generation. */
export function canConfirmGeneration(input: {
  estimate: VideoCostEstimate | null;
  balance: number;
  accepted: boolean;
  requiresExactQuote?: boolean;
  blockedReason?: string;
  loading?: boolean;
}): boolean {
  return input.accepted
    && !input.loading
    && !input.blockedReason
    && creditSummary(input.estimate, input.balance, input.requiresExactQuote).canReserve;
}
