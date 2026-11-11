/**
 * VYORA — devis vidéo fournisseur (MuAPI / « MyAPI »).
 *
 * Ce module est VOLONTAIREMENT pur (aucun accès réseau, aucun secret, aucune
 * dépendance Deno/Node) afin d'être :
 *   1. exécuté côté serveur par l'Edge Function `reelora-video` ;
 *   2. testé unitairement avec les mêmes règles que la production.
 *
 * Règles non négociables :
 *   - Aucun prix n'est inventé. Si le fournisseur ne renvoie pas un tarif
 *     exploitable en USD, le devis est déclaré indisponible avec un code
 *     d'erreur explicite.
 *   - Le tarif catalogue (ugc_video_models.cost_usd) n'est utilisé QUE pour les
 *     modèles à tarification fixe. Pour les modèles `dynamic_pricing`, seul
 *     `POST /api/v1/models/{name}/estimate-cost` fait foi.
 *   - Le devis expose la base tarifaire réellement transmise (durée,
 *     résolution, quantité, options facturées) pour que l'utilisateur sache
 *     exactement ce qui est chiffré.
 */

export type Json = Record<string, unknown>;

export type ProviderQuoteSource = 'provider_estimate' | 'catalog_tariff' | 'none';

export type ProviderQuoteErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'PROVIDER_KEY_MISSING'
  | 'ESTIMATE_ENDPOINT_MISSING'
  | 'ESTIMATE_ENDPOINT_INVALID'
  | 'PROMPT_REQUIRED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BAD_RESPONSE'
  | 'PROVIDER_PRICE_MISSING'
  | 'CURRENCY_UNSUPPORTED'
  | 'PRICE_NOT_POSITIVE'
  | 'CATALOG_TARIFF_MISSING';

export interface ProviderQuote {
  /** `true` uniquement quand un montant USD strictement positif est vérifié. */
  available: boolean;
  cost_usd: number | null;
  currency: 'USD' | null;
  source: ProviderQuoteSource;
  error_code: ProviderQuoteErrorCode | null;
  error_message: string | null;
  /** Horodatage serveur de la vérification. */
  checked_at: string;
  /** Date de dernière synchronisation du catalogue (fraîcheur du tarif fixe). */
  catalog_synced_at: string | null;
  stale_catalog: boolean;
  /** Paramètres facturés réellement envoyés au fournisseur. */
  pricing_basis: Record<string, string | number | boolean>;
  /** Unités facturées détectées (ex. `duration`, `resolution`, `quantity`). */
  billing_units: string[];
  /** Indique qu'un endpoint de devis vérifié existe (le chemin technique reste serveur). */
  estimate_endpoint_available: boolean;
}

export interface QuoteModelMeta {
  modelId: string;
  publicId?: string | null;
  displayName?: string | null;
  catalogCostUsd?: number | null;
  catalogCurrency?: string | null;
  dynamicPricing: boolean;
  estimateEndpoint?: string | null;
  active: boolean;
  enabled: boolean;
  comingSoon: boolean;
  syncedAt?: string | null;
  requiredFields?: string[];
  supportedFields?: string[];
}

export interface ProviderReplyLike {
  ok: boolean;
  status?: number;
  data?: unknown;
  /** `true` quand la requête a dépassé le délai client. */
  timedOut?: boolean;
  /** Erreur réseau (DNS, TLS, connexion refusée). */
  networkError?: boolean;
}

const MEDIA_FIELDS = new Set([
  'prompt', 'image_url', 'last_image', 'first_frame', 'last_image_url',
  'image', 'start_image', 'end_image', 'mask_image_url', 'mask_video_url',
  'video_url', 'audio_url', 'input_video', 'images_list', 'image_urls',
  'reference_images', 'request_id', 'draft_request_id',
]);

const BILLING_UNIT_ALIASES: Record<string, string> = {
  duration: 'duration',
  duration_seconds: 'duration',
  seconds: 'duration',
  resolution: 'resolution',
  quality: 'resolution',
  quantity: 'quantity',
  num_images: 'quantity',
  n: 'quantity',
  batch_size: 'quantity',
  aspect_ratio: 'aspect_ratio',
  generate_audio: 'audio',
  audio: 'audio',
  fps: 'fps',
  high_bitrate: 'bitrate',
  draft: 'draft',
};

const BILLING_UNIT_ORDER = [
  'duration', 'resolution', 'quantity', 'audio', 'aspect_ratio', 'fps', 'bitrate', 'draft',
];

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function asString(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * Le tarif exact est recherché dans toutes les formes documentées par MuAPI
 * (`cost`, `cost_usd`, `estimated_cost`, `price`, …), y compris imbriquées.
 * Aucune valeur n'est déduite d'un champ non tarifaire.
 */
export function extractProviderCostUsd(payload: unknown): number | null {
  const root = asRecord(asRecord(payload).data ?? payload);
  const candidates: unknown[] = [
    root.cost, root.cost_usd, root.estimated_cost, root.estimate_cost,
    root.price, root.total_cost, root.amount, root.amount_usd, root.usd,
    root.total, root.credits_cost_usd,
    asRecord(root.cost).amount, asRecord(root.cost).usd, asRecord(root.cost).value,
    asRecord(root.pricing).cost, asRecord(root.pricing).amount,
    asRecord(root.estimate).cost, asRecord(root.estimate).amount_usd,
    asRecord(root.data).cost, asRecord(root.data).cost_usd,
    asRecord(root.data).estimated_cost,
  ];
  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

export function extractProviderCurrency(payload: unknown, fallback = 'USD'): string {
  const root = asRecord(asRecord(payload).data ?? payload);
  const raw = asString(
    root.currency ?? root.cost_currency ?? asRecord(root.cost).currency
    ?? asRecord(root.pricing).currency ?? asRecord(root.data).currency,
    10,
  );
  return (raw || fallback).toUpperCase();
}

/** Normalise un endpoint d'estimation et rejette tout ce qui n'est pas MuAPI. */
export function normalizeEstimateEndpoint(value: unknown, modelId: string): string | null {
  const candidate = asString(value, 300);
  const fallback = `/api/v1/models/${modelId}/estimate-cost`;
  const path = candidate || fallback;
  if (!path.startsWith('/api/v1/models/')) return null;
  if (!path.endsWith('/estimate-cost')) return null;
  if (/^\/api\/v1\/models\/[A-Za-z0-9._-]{1,160}\/estimate-cost$/.test(path)) return path;
  return /^\/api\/v1\/models\/[A-Za-z0-9._%.-]{1,200}\/estimate-cost$/.test(path) ? path : null;
}

/**
 * Base tarifaire réellement transmise au fournisseur : uniquement les
 * paramètres scalaires acceptés par le schéma vérifié. Le prompt et les médias
 * sont exclus (ils ne sont jamais facturés comme unités). Les valeurs sont
 * triées pour rester déterministes.
 */
export function buildPricingBasis(
  params: Record<string, unknown>,
  supportedFields?: string[],
): Record<string, string | number | boolean> {
  const allowed = supportedFields && supportedFields.length
    ? new Set(supportedFields.map((field) => field.toLowerCase()))
    : null;
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(params).sort()) {
    if (MEDIA_FIELDS.has(key) || key.startsWith('__')) continue;
    if (allowed && !allowed.has(key.toLowerCase())) continue;
    const value = params[key];
    if (typeof value === 'string') {
      const trimmed = value.trim().slice(0, 120);
      if (trimmed) out[key] = trimmed;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

/** Unités de facturation identifiables dans la base tarifaire. */
export function billingUnits(pricingBasis: Record<string, string | number | boolean>): string[] {
  const found = new Set<string>();
  for (const key of Object.keys(pricingBasis)) {
    const unit = BILLING_UNIT_ALIASES[key.toLowerCase()];
    if (unit) found.add(unit);
  }
  return BILLING_UNIT_ORDER.filter((unit) => found.has(unit));
}

export function isCatalogStale(syncedAt: string | null | undefined, now: Date, maxAgeHours = 36): boolean {
  if (!syncedAt) return true;
  const timestamp = Date.parse(syncedAt);
  if (!Number.isFinite(timestamp)) return true;
  return now.getTime() - timestamp > maxAgeHours * 3600_000;
}

const PROVIDER_ERROR_MESSAGES: Record<ProviderQuoteErrorCode, string> = {
  MODEL_NOT_FOUND: 'Ce modèle vidéo n’existe pas dans le catalogue VYORA.',
  MODEL_UNAVAILABLE: 'Ce modèle n’est pas disponible pour votre compte.',
  PROVIDER_KEY_MISSING: 'Le service de génération n’est pas configuré côté serveur.',
  ESTIMATE_ENDPOINT_MISSING: 'Ce modèle n’expose pas d’endpoint de devis vérifié.',
  ESTIMATE_ENDPOINT_INVALID: 'L’endpoint de devis du fournisseur est invalide.',
  PROMPT_REQUIRED: 'Renseignez une instruction vidéo pour obtenir un devis exact.',
  PROVIDER_AUTH_FAILED: 'Le fournisseur a refusé l’authentification serveur. Devis indisponible.',
  PROVIDER_RATE_LIMITED: 'Le fournisseur limite temporairement les requêtes. Réessayez dans un instant.',
  PROVIDER_UNAVAILABLE: 'Le fournisseur de génération est momentanément indisponible.',
  PROVIDER_TIMEOUT: 'Le fournisseur n’a pas répondu à temps. Devis indisponible.',
  PROVIDER_BAD_RESPONSE: 'Le fournisseur a renvoyé une réponse illisible.',
  PROVIDER_PRICE_MISSING: 'Le fournisseur n’a pas renvoyé de tarif exploitable pour ces paramètres.',
  CURRENCY_UNSUPPORTED: 'Le tarif renvoyé n’est pas exprimé en dollars américains (USD).',
  PRICE_NOT_POSITIVE: 'Le tarif renvoyé n’est pas un montant facturable.',
  CATALOG_TARIFF_MISSING: 'Aucun tarif vérifié n’est disponible pour ce modèle.',
};

export function providerErrorMessage(code: ProviderQuoteErrorCode): string {
  return PROVIDER_ERROR_MESSAGES[code];
}

export function classifyProviderFailure(reply: ProviderReplyLike): ProviderQuoteErrorCode {
  if (reply.timedOut) return 'PROVIDER_TIMEOUT';
  if (reply.networkError) return 'PROVIDER_UNAVAILABLE';
  const status = reply.status ?? 0;
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 404) return 'ESTIMATE_ENDPOINT_MISSING';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (status === 0) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_BAD_RESPONSE';
}

export function unavailableQuote(input: {
  code: ProviderQuoteErrorCode;
  now: Date;
  estimateEndpoint?: string | null;
  catalogSyncedAt?: string | null;
  pricingBasis?: Record<string, string | number | boolean>;
  staleCatalog?: boolean;
  message?: string | null;
}): ProviderQuote {
  const basis = input.pricingBasis ?? {};
  const synced = input.catalogSyncedAt ?? null;
  return {
    available: false,
    cost_usd: null,
    currency: null,
    source: 'none',
    error_code: input.code,
    error_message: input.message ?? providerErrorMessage(input.code),
    checked_at: input.now.toISOString(),
    catalog_synced_at: synced,
    stale_catalog: input.staleCatalog ?? true,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(input.estimateEndpoint),
  };
}

function availableQuote(input: {
  costUsd: number;
  source: Exclude<ProviderQuoteSource, 'none'>;
  now: Date;
  estimateEndpoint?: string | null;
  catalogSyncedAt?: string | null;
  pricingBasis?: Record<string, string | number | boolean>;
  staleCatalog?: boolean;
}): ProviderQuote {
  const basis = input.pricingBasis ?? {};
  return {
    available: true,
    cost_usd: Math.round(input.costUsd * 1_000_000) / 1_000_000,
    currency: 'USD',
    source: input.source,
    error_code: null,
    error_message: null,
    checked_at: input.now.toISOString(),
    catalog_synced_at: input.catalogSyncedAt ?? null,
    stale_catalog: input.staleCatalog ?? false,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(input.estimateEndpoint),
  };
}

/**
 * Construit le devis final à partir :
 *  - des métadonnées vérifiées du modèle (catalogue serveur) ;
 *  - de la réponse réelle de `estimate-cost` (ou `null` si non appelé) ;
 *  - des paramètres facturés réellement transmis.
 *
 * Aucune estimation locale n'est faite : on ne fait que lire un tarif
 * fournisseur ou un tarif catalogue explicitement fixe.
 */
export function buildProviderQuote(input: {
  model: QuoteModelMeta | null;
  providerReply?: ProviderReplyLike | null;
  pricingParams?: Record<string, unknown>;
  prompt?: string;
  now?: Date;
  catalogMaxAgeHours?: number;
  requirePrompt?: boolean;
}): ProviderQuote {
  const now = input.now ?? new Date();
  const model = input.model;
  const pricingBasis = buildPricingBasis(input.pricingParams ?? {}, model?.supportedFields);
  if (!model) {
    return unavailableQuote({ code: 'MODEL_NOT_FOUND', now, pricingBasis });
  }
  const estimateEndpoint = normalizeEstimateEndpoint(model.estimateEndpoint, model.modelId);
  const syncedAt = model.syncedAt ?? null;
  const staleCatalog = isCatalogStale(syncedAt, now, input.catalogMaxAgeHours ?? 36);
  const common = { estimateEndpoint, catalogSyncedAt: syncedAt, pricingBasis, staleCatalog };

  if (!model.active || !model.enabled || model.comingSoon) {
    return unavailableQuote({ code: 'MODEL_UNAVAILABLE', now, ...common });
  }

  if (model.dynamicPricing) {
    if (input.requirePrompt && !asString(input.prompt)) {
      return unavailableQuote({ code: 'PROMPT_REQUIRED', now, ...common });
    }
    if (!estimateEndpoint) {
      return unavailableQuote({ code: 'ESTIMATE_ENDPOINT_INVALID', now, ...common });
    }
    const reply = input.providerReply;
    if (!reply) {
      return unavailableQuote({ code: 'PROVIDER_UNAVAILABLE', now, ...common });
    }
    if (!reply.ok) {
      return unavailableQuote({ code: classifyProviderFailure(reply), now, ...common });
    }
    const currency = extractProviderCurrency(reply.data, 'USD');
    if (currency !== 'USD') {
      return unavailableQuote({
        code: 'CURRENCY_UNSUPPORTED', now, ...common,
        message: `Le fournisseur a renvoyé un tarif en ${currency}. Seuls les tarifs USD vérifiables sont acceptés.`,
      });
    }
    const cost = extractProviderCostUsd(reply.data);
    if (cost === null) {
      return unavailableQuote({ code: 'PROVIDER_PRICE_MISSING', now, ...common });
    }
    if (!(cost > 0)) {
      return unavailableQuote({ code: 'PRICE_NOT_POSITIVE', now, ...common });
    }
    return availableQuote({ costUsd: cost, source: 'provider_estimate', now, ...common });
  }

  // Tarification fixe : seul le tarif catalogue vérifié est utilisé.
  const fixedCurrency = (model.catalogCurrency ?? 'USD').toUpperCase();
  if (fixedCurrency !== 'USD') {
    return unavailableQuote({
      code: 'CURRENCY_UNSUPPORTED', now, ...common,
      message: `Le tarif catalogue de ce modèle est exprimé en ${fixedCurrency}. Devis USD indisponible.`,
    });
  }
  const catalogCost = toFiniteNumber(model.catalogCostUsd);
  if (catalogCost === null) {
    return unavailableQuote({ code: 'CATALOG_TARIFF_MISSING', now, ...common });
  }
  if (!(catalogCost > 0)) {
    return unavailableQuote({ code: 'PRICE_NOT_POSITIVE', now, ...common });
  }
  return availableQuote({ costUsd: catalogCost, source: 'catalog_tariff', now, ...common });
}

/** Paramètres de devis nets : ni prompt, ni média, ni champ interne. */
export function quotePricingParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params).sort()) {
    if (MEDIA_FIELDS.has(key) || key.startsWith('__')) continue;
    out[key] = params[key];
  }
  return out;
}

/** Libellé lisible d'une unité de facturation (UI). */
export const BILLING_UNIT_LABELS: Record<string, string> = {
  duration: 'durée',
  resolution: 'résolution',
  quantity: 'quantité',
  audio: 'audio',
  aspect_ratio: 'format',
  fps: 'images/s',
  bitrate: 'débit',
  draft: 'brouillon',
};
