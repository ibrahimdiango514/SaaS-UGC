// @ts-nocheck — artefact esbuild : verifie et execute par les tests.
// ---------------------------------------------------------------------------
// BUNDLE AUTONOME — généré par esbuild depuis
//   supabase/functions/reelora-video/index.ts
//   supabase/functions/_shared/video-quote.ts
// Ne pas editer a la main : node scripts/build-edge-bundle.mjs
// Verifie par tests/edge-bundle-parity.test.ts (egalite octet pour octet).
// ---------------------------------------------------------------------------
// supabase/functions/_shared/video-quote.ts
var MEDIA_FIELDS = /* @__PURE__ */ new Set([
  "prompt",
  "image_url",
  "last_image",
  "first_frame",
  "last_image_url",
  "image",
  "start_image",
  "end_image",
  "mask_image_url",
  "mask_video_url",
  "video_url",
  "audio_url",
  "input_video",
  "images_list",
  "image_urls",
  "reference_images",
  "request_id",
  "draft_request_id"
]);
var BILLING_UNIT_ALIASES = {
  duration: "duration",
  duration_seconds: "duration",
  seconds: "duration",
  resolution: "resolution",
  quality: "resolution",
  quantity: "quantity",
  num_images: "quantity",
  n: "quantity",
  batch_size: "quantity",
  aspect_ratio: "aspect_ratio",
  generate_audio: "audio",
  audio: "audio",
  fps: "fps",
  high_bitrate: "bitrate",
  draft: "draft"
};
var BILLING_UNIT_ORDER = [
  "duration",
  "resolution",
  "quantity",
  "audio",
  "aspect_ratio",
  "fps",
  "bitrate",
  "draft"
];
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString(value, max = 400) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function extractProviderCostUsd(payload) {
  const root = asRecord(asRecord(payload).data ?? payload);
  const candidates = [
    root.cost,
    root.cost_usd,
    root.estimated_cost,
    root.estimate_cost,
    root.price,
    root.total_cost,
    root.amount,
    root.amount_usd,
    root.usd,
    root.total,
    root.credits_cost_usd,
    asRecord(root.cost).amount,
    asRecord(root.cost).usd,
    asRecord(root.cost).value,
    asRecord(root.pricing).cost,
    asRecord(root.pricing).amount,
    asRecord(root.estimate).cost,
    asRecord(root.estimate).amount_usd,
    asRecord(root.data).cost,
    asRecord(root.data).cost_usd,
    asRecord(root.data).estimated_cost
  ];
  for (const candidate of candidates) {
    const value = toFiniteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}
function extractProviderCurrency(payload, fallback = "USD") {
  const root = asRecord(asRecord(payload).data ?? payload);
  const raw = asString(
    root.currency ?? root.cost_currency ?? asRecord(root.cost).currency ?? asRecord(root.pricing).currency ?? asRecord(root.data).currency,
    10
  );
  return (raw || fallback).toUpperCase();
}
function normalizeEstimateEndpoint(value, modelId) {
  const candidate = asString(value, 300);
  const fallback = `/api/v1/models/${modelId}/estimate-cost`;
  const path = candidate || fallback;
  if (!path.startsWith("/api/v1/models/")) return null;
  if (!path.endsWith("/estimate-cost")) return null;
  if (/^\/api\/v1\/models\/[A-Za-z0-9._-]{1,160}\/estimate-cost$/.test(path)) return path;
  return /^\/api\/v1\/models\/[A-Za-z0-9._%.-]{1,200}\/estimate-cost$/.test(path) ? path : null;
}
function buildPricingBasis(params, supportedFields) {
  const allowed = supportedFields && supportedFields.length ? new Set(supportedFields.map((field) => field.toLowerCase())) : null;
  const out = {};
  for (const key of Object.keys(params).sort()) {
    if (MEDIA_FIELDS.has(key) || key.startsWith("__")) continue;
    if (allowed && !allowed.has(key.toLowerCase())) continue;
    const value = params[key];
    if (typeof value === "string") {
      const trimmed = value.trim().slice(0, 120);
      if (trimmed) out[key] = trimmed;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
function billingUnits(pricingBasis) {
  const found = /* @__PURE__ */ new Set();
  for (const key of Object.keys(pricingBasis)) {
    const unit = BILLING_UNIT_ALIASES[key.toLowerCase()];
    if (unit) found.add(unit);
  }
  return BILLING_UNIT_ORDER.filter((unit) => found.has(unit));
}
function isCatalogStale(syncedAt, now, maxAgeHours = 36) {
  if (!syncedAt) return true;
  const timestamp = Date.parse(syncedAt);
  if (!Number.isFinite(timestamp)) return true;
  return now.getTime() - timestamp > maxAgeHours * 36e5;
}
var PROVIDER_ERROR_MESSAGES = {
  MODEL_NOT_FOUND: "Ce mod\xE8le vid\xE9o n\u2019existe pas dans le catalogue VYORA.",
  MODEL_UNAVAILABLE: "Ce mod\xE8le n\u2019est pas disponible pour votre compte.",
  PROVIDER_KEY_MISSING: "Le service de g\xE9n\xE9ration n\u2019est pas configur\xE9 c\xF4t\xE9 serveur.",
  ESTIMATE_ENDPOINT_MISSING: "Ce mod\xE8le n\u2019expose pas d\u2019endpoint de devis v\xE9rifi\xE9.",
  ESTIMATE_ENDPOINT_INVALID: "L\u2019endpoint de devis du fournisseur est invalide.",
  PROMPT_REQUIRED: "Renseignez une instruction vid\xE9o pour obtenir un devis exact.",
  PROVIDER_AUTH_FAILED: "Le fournisseur a refus\xE9 l\u2019authentification serveur. Devis indisponible.",
  PROVIDER_RATE_LIMITED: "Le fournisseur limite temporairement les requ\xEAtes. R\xE9essayez dans un instant.",
  PROVIDER_UNAVAILABLE: "Le fournisseur de g\xE9n\xE9ration est momentan\xE9ment indisponible.",
  PROVIDER_TIMEOUT: "Le fournisseur n\u2019a pas r\xE9pondu \xE0 temps. Devis indisponible.",
  PROVIDER_BAD_RESPONSE: "Le fournisseur a renvoy\xE9 une r\xE9ponse illisible.",
  PROVIDER_PRICE_MISSING: "Le fournisseur n\u2019a pas renvoy\xE9 de tarif exploitable pour ces param\xE8tres.",
  CURRENCY_UNSUPPORTED: "Le tarif renvoy\xE9 n\u2019est pas exprim\xE9 en dollars am\xE9ricains (USD).",
  PRICE_NOT_POSITIVE: "Le tarif renvoy\xE9 n\u2019est pas un montant facturable.",
  CATALOG_TARIFF_MISSING: "Aucun tarif v\xE9rifi\xE9 n\u2019est disponible pour ce mod\xE8le."
};
function providerErrorMessage(code) {
  return PROVIDER_ERROR_MESSAGES[code];
}
function classifyProviderFailure(reply) {
  if (reply.timedOut) return "PROVIDER_TIMEOUT";
  if (reply.networkError) return "PROVIDER_UNAVAILABLE";
  const status = reply.status ?? 0;
  if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status === 404) return "ESTIMATE_ENDPOINT_MISSING";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  if (status === 0) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_BAD_RESPONSE";
}
function unavailableQuote(input) {
  const basis = input.pricingBasis ?? {};
  const synced = input.catalogSyncedAt ?? null;
  return {
    available: false,
    cost_usd: null,
    currency: null,
    source: "none",
    error_code: input.code,
    error_message: input.message ?? providerErrorMessage(input.code),
    checked_at: input.now.toISOString(),
    catalog_synced_at: synced,
    stale_catalog: input.staleCatalog ?? true,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(input.estimateEndpoint)
  };
}
function availableQuote(input) {
  const basis = input.pricingBasis ?? {};
  return {
    available: true,
    cost_usd: Math.round(input.costUsd * 1e6) / 1e6,
    currency: "USD",
    source: input.source,
    error_code: null,
    error_message: null,
    checked_at: input.now.toISOString(),
    catalog_synced_at: input.catalogSyncedAt ?? null,
    stale_catalog: input.staleCatalog ?? false,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(input.estimateEndpoint)
  };
}
function buildProviderQuote(input) {
  const now = input.now ?? /* @__PURE__ */ new Date();
  const model = input.model;
  const pricingBasis = buildPricingBasis(input.pricingParams ?? {}, model?.supportedFields);
  if (!model) {
    return unavailableQuote({ code: "MODEL_NOT_FOUND", now, pricingBasis });
  }
  const estimateEndpoint = normalizeEstimateEndpoint(model.estimateEndpoint, model.modelId);
  const syncedAt = model.syncedAt ?? null;
  const staleCatalog = isCatalogStale(syncedAt, now, input.catalogMaxAgeHours ?? 36);
  const common = { estimateEndpoint, catalogSyncedAt: syncedAt, pricingBasis, staleCatalog };
  if (!model.active || !model.enabled || model.comingSoon) {
    return unavailableQuote({ code: "MODEL_UNAVAILABLE", now, ...common });
  }
  if (model.dynamicPricing) {
    if (input.requirePrompt && !asString(input.prompt)) {
      return unavailableQuote({ code: "PROMPT_REQUIRED", now, ...common });
    }
    if (!estimateEndpoint) {
      return unavailableQuote({ code: "ESTIMATE_ENDPOINT_INVALID", now, ...common });
    }
    const reply = input.providerReply;
    if (!reply) {
      return unavailableQuote({ code: "PROVIDER_UNAVAILABLE", now, ...common });
    }
    if (!reply.ok) {
      return unavailableQuote({ code: classifyProviderFailure(reply), now, ...common });
    }
    const currency = extractProviderCurrency(reply.data, "USD");
    if (currency !== "USD") {
      return unavailableQuote({
        code: "CURRENCY_UNSUPPORTED",
        now,
        ...common,
        message: `Le fournisseur a renvoy\xE9 un tarif en ${currency}. Seuls les tarifs USD v\xE9rifiables sont accept\xE9s.`
      });
    }
    const cost = extractProviderCostUsd(reply.data);
    if (cost === null) {
      return unavailableQuote({ code: "PROVIDER_PRICE_MISSING", now, ...common });
    }
    if (!(cost > 0)) {
      return unavailableQuote({ code: "PRICE_NOT_POSITIVE", now, ...common });
    }
    return availableQuote({ costUsd: cost, source: "provider_estimate", now, ...common });
  }
  const fixedCurrency = (model.catalogCurrency ?? "USD").toUpperCase();
  if (fixedCurrency !== "USD") {
    return unavailableQuote({
      code: "CURRENCY_UNSUPPORTED",
      now,
      ...common,
      message: `Le tarif catalogue de ce mod\xE8le est exprim\xE9 en ${fixedCurrency}. Devis USD indisponible.`
    });
  }
  const catalogCost = toFiniteNumber(model.catalogCostUsd);
  if (catalogCost === null) {
    return unavailableQuote({ code: "CATALOG_TARIFF_MISSING", now, ...common });
  }
  if (!(catalogCost > 0)) {
    return unavailableQuote({ code: "PRICE_NOT_POSITIVE", now, ...common });
  }
  return availableQuote({ costUsd: catalogCost, source: "catalog_tariff", now, ...common });
}

// supabase/functions/reelora-video/index.ts
var MUAPI_BASE = "https://api.muapi.ai";
var BUCKET = "ugc-assets";
var cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400"
};
function env(key) {
  const g = globalThis;
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}
var SUPABASE_URL = () => env("SUPABASE_URL");
var SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
var ANON_KEY = () => env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
var MUAPI_KEY = () => env("MUAPI_API_KEY");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function fail(code, message, status = 400) {
  return json({ error: { code, message } }, status);
}
function str(v, max = 4e3) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function redact(text) {
  const k = MUAPI_KEY();
  return k ? text.split(k).join("[REDACTED]") : text;
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v, fallback = false) {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "True" || v === "TRUE") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "False" || v === "FALSE") return false;
  return fallback;
}
function svcHeaders(extra = {}) {
  return { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, ...extra };
}
async function rpcService(name, args) {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: svcHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(2e4)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "message" in data ? String(data.message) : text;
    return { ok: false, data: null, error: redact(msg) };
  }
  return { ok: true, data };
}
async function restService(path) {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    headers: svcHeaders(),
    signal: AbortSignal.timeout(2e4)
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
async function authUserId(jwt) {
  const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: ANON_KEY(), Authorization: jwt },
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) return null;
  const d = await res.json();
  return str(d.id, 80) || null;
}
async function workerToken() {
  const r = await rpcService("reelora_worker_token", {});
  return r.ok ? str(r.data, 200) : "";
}
async function loadJob(id) {
  const rows = await restService(`ugc_generation_jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows[0] ?? null;
}
async function loadModel(id) {
  const encoded = encodeURIComponent(id);
  const rows = await restService(
    `reelora_video_models?or=(model_id.eq.${encoded},public_id.eq.${encoded})&select=*&limit=1`
  );
  return rows[0] ?? null;
}
function customerModel(model, index, status, reason) {
  const category = str(model.category, 60);
  const schema = paramSchemaFromRow(model);
  const safeSchema = Object.fromEntries(Object.entries(schema).filter(([key]) => !key.startsWith("__")));
  const meta = metaFromRow(model);
  const modelStatus = status ?? statusFor(model).status;
  return {
    model_id: str(model.public_id, 80),
    display_name: `VYORA ${category === "Image to Video" ? "Image" : "Video"} ${String(index + 1).padStart(2, "0")}`,
    description: category === "Image to Video" ? "Animez un visuel de r\xE9f\xE9rence avec des param\xE8tres de cr\xE9ation v\xE9rifi\xE9s." : "Cr\xE9ez une vid\xE9o \xE0 partir d'une instruction et de param\xE8tres v\xE9rifi\xE9s.",
    category,
    input_fields: asArray(model.input_fields),
    required_fields: asArray(model.required_fields),
    param_schema: safeSchema,
    dynamic_pricing: bool(meta.dynamic_pricing, false),
    is_enabled: bool(model.is_enabled, true),
    is_coming_soon: bool(model.is_coming_soon, false),
    sort_order: finite(model.sort_order) ?? index,
    reelora_status: modelStatus,
    reelora_reason: reason ?? (modelStatus === "active" ? "Disponible dans VYORA." : modelStatus === "coming_soon" ? "Bient\xF4t disponible." : "Indisponible momentan\xE9ment.")
  };
}
function pricingParameters(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !["prompt", "image_url", "last_image", "first_frame", "last_image_url"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
async function loadVideoPricingConfig() {
  const url = `${SUPABASE_URL()}/rest/v1/ugc_app_settings?setting_key=eq.video_pricing_config&select=setting_value,updated_at&limit=1`;
  const response = await fetch(url, { headers: svcHeaders(), signal: AbortSignal.timeout(15e3) });
  if (!response.ok) throw new Error(`VIDEO_PRICING_READ_ERROR: HTTP ${response.status}`);
  const rows = await response.json();
  const row = rows[0];
  if (!row) return null;
  const config = obj(row.setting_value);
  return {
    enabled: bool(config.enabled),
    usd_to_xof: finite(config.usd_to_xof),
    credit_value_xof: finite(config.credit_value_xof),
    markup_percent: finite(config.markup_percent),
    additional_cost_usd: finite(config.additional_cost_usd),
    updated_at: str(row.updated_at, 80)
  };
}
function calculateVideoCredits(providerCostUsd, config, secondaryCostsUsd = []) {
  const { usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd } = config;
  const extras = secondaryCostsUsd.map((value) => Number(value));
  if (![providerCostUsd, usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd].every(Number.isFinite) || providerCostUsd <= 0 || (usd_to_xof ?? 0) <= 0 || (credit_value_xof ?? 0) <= 0 || (markup_percent ?? -1) < 0 || (additional_cost_usd ?? -1) < 0) return null;
  if (extras.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const extrasUsd = extras.reduce((total, value) => total + value, 0);
  const totalXof = (providerCostUsd + additional_cost_usd + extrasUsd) * usd_to_xof * (1 + markup_percent / 100);
  const credits = Math.ceil(totalXof / credit_value_xof);
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}
function packPricePerCredit(pack) {
  if (!Number.isFinite(pack.price_xof) || !Number.isFinite(pack.credits) || pack.price_xof <= 0 || pack.credits <= 0) return null;
  return Math.round(pack.price_xof / pack.credits * 1e4) / 1e4;
}
function assertPackLadder(packs) {
  const sorted = packs.map((pack) => ({ pack, unit: packPricePerCredit(pack) })).sort((a, b) => a.pack.credits - b.pack.credits);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1].unit;
    const current = sorted[index].unit;
    if (previous === null || current === null) return "invalid_pack_values";
    if (current >= previous) return "pack_ladder_not_degressive";
  }
  return null;
}
async function loadAvatar(id) {
  const rows = await restService(`reelora_avatars?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows[0] ?? null;
}
async function loadScript(projectId) {
  const rows = await restService(
    `ugc_project_scripts?project_id=eq.${encodeURIComponent(projectId)}&select=script_text&order=version.desc&limit=1`
  );
  return str(rows[0]?.script_text, 4e3);
}
function workspaceImagePath(raw, workspaceId) {
  const path = str(raw, 500).replace(/^\/+/, "");
  const ws = str(workspaceId, 80);
  if (!ws || !path.startsWith(`${ws}/`) || path.includes("..") || path.includes("\\")) return "";
  return path;
}
async function signStoragePath(path) {
  const res = await fetch(`${SUPABASE_URL()}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: svcHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: 3600 }),
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) return null;
  const d = await res.json();
  const signed = str(d.signedURL ?? d.signedUrl, 1e3);
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${SUPABASE_URL()}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
}
var SUPPORTED_REQUIRED_FIELDS = /* @__PURE__ */ new Set([
  "prompt",
  "image_url",
  "video_url",
  "audio_url",
  // Variantes de nommage de la même capacité, déclarées par certains modèles.
  "input_video",
  "first_frame_url",
  "first_frame_image"
]);
var SOURCE_FIELDS = /* @__PURE__ */ new Set([
  "prompt",
  "image_url",
  "last_image",
  "audio_url",
  "video_url",
  "input_video",
  "images_list",
  "image_urls",
  "mask_image_url",
  "mask_video_url",
  "request_id",
  "audios_list",
  "videos_list",
  "audio_files",
  "video_files",
  "draft_request_id",
  "omni_reference_task_type",
  "draft",
  "end_image_url",
  "first_frame_url",
  "last_frame_url",
  "reference_audios",
  "reference_videos",
  "reference_images",
  "video_urls",
  "audio_ids",
  "character_ids",
  "loras",
  "lora_list",
  "elements",
  "origin_task_id",
  "end_time",
  "start_time",
  "trim_start",
  "trim_end",
  "templ_start_seconds",
  "templ_end_seconds",
  "reference_video_url",
  "first_frame_image",
  "last_frame_image",
  "image",
  "video",
  "audio"
]);
function isSourceField(key) {
  const k = key.toLowerCase();
  if (SOURCE_FIELDS.has(k)) return true;
  return k.endsWith("_url") || k.endsWith("_urls") || k.endsWith("_list") || k.endsWith("_files") || k.endsWith("_file") || k.endsWith("_ids") || k.endsWith("_images") || k.endsWith("_videos") || k.endsWith("_audios") || k.endsWith("_request_id") || k.endsWith("_task_id") || k.endsWith("_frame_url") || k.startsWith("reference_") || k.startsWith("mask_") || k.startsWith("templ_") || k === "draft" || k === "elements" || k === "loras" || k === "lora_list";
}
function validModelId(id) {
  return /^[a-z0-9._-]{1,120}$/.test(id);
}
function validEndpoint(path) {
  return /^\/api\/v1\/[A-Za-z0-9._-]{1,160}$/.test(path);
}
function validEstimateEndpoint(path) {
  return /^\/api\/v1\/models\/[A-Za-z0-9._-]{1,120}\/estimate-cost$/.test(path);
}
function normalizeEndpoint(rawEndpoint, rawEndpointUrl, name) {
  const a = str(rawEndpoint, 220);
  if (validEndpoint(a)) return a;
  const b = str(rawEndpointUrl, 220);
  if (validEndpoint(b)) return b;
  if (validModelId(b)) return `/api/v1/${b}`;
  return `/api/v1/${name}`;
}
function normalizeEstimateEndpoint2(raw, name) {
  const p = str(raw, 240);
  if (validEstimateEndpoint(p)) return p;
  if (validModelId(name)) return `/api/v1/models/${name}/estimate-cost`;
  return null;
}
function asArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
}
function prettyName(name) {
  return name.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 120);
}
function scalar(v) {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : void 0;
}
function paramSchemaFromClient(raw, fields) {
  const out = {};
  for (const [key, value] of Object.entries(obj(raw))) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const d = obj(value);
    const type = str(d.type, 20).toLowerCase();
    if (!["select", "number", "boolean", "string", "array", "object"].includes(type)) continue;
    const def = { type };
    if (Array.isArray(d.options)) def.options = d.options.map(scalar).filter((x) => x !== void 0);
    if (finite(d.min) !== null) def.min = Number(d.min);
    if (finite(d.max) !== null) def.max = Number(d.max);
    if (finite(d.step) !== null) def.step = Number(d.step);
    const defDefault = scalar(d.default);
    if (defDefault !== void 0) def.default = defDefault;
    if (str(d.label, 100)) def.label = str(d.label, 100);
    if (str(d.description, 300)) def.description = str(d.description, 300);
    if (d.required === true) def.required = true;
    out[key] = def;
  }
  return out;
}
function schemaFromInputSchema(raw, fallbackFields) {
  void fallbackFields;
  const root = obj(raw);
  const schemas = obj(root.schemas ?? root);
  const input = obj(schemas.input_data ?? schemas.input ?? root);
  const props = obj(input.properties ?? schemas.properties ?? root.properties);
  const required = asArray(input.required ?? root.required);
  const schema = {};
  for (const [key, value] of Object.entries(props)) {
    const d = obj(value);
    const rawType = str(d.type, 30).toLowerCase();
    const enumValues = Array.isArray(d.enum) ? d.enum : null;
    let type = "object";
    if (enumValues) type = "select";
    else if (["int", "integer", "number", "float", "double"].includes(rawType)) type = "number";
    else if (rawType === "boolean") type = "boolean";
    else if (rawType === "string") type = "string";
    else if (rawType === "array") type = "array";
    else if (rawType === "object") type = "object";
    const def = { type };
    const title = str(d.title ?? d.name, 100);
    const description = str(d.description, 300);
    if (title) def.label = title;
    if (description) def.description = description;
    if (enumValues) def.options = enumValues.map(scalar).filter((x) => x !== void 0);
    const min = finite(d.minValue ?? d.minimum ?? d.min);
    const max = finite(d.maxValue ?? d.maximum ?? d.max);
    const step = finite(d.step);
    if (min !== null) def.min = min;
    if (max !== null) def.max = max;
    if (step !== null) def.step = step;
    const defDefault = scalar(d.default);
    if (defDefault !== void 0) def.default = defDefault;
    if (required.includes(key)) def.required = true;
    schema[key] = def;
  }
  return schema;
}
function paramSchemaFromRow(row) {
  const raw = obj(row.param_schema);
  const out = {};
  let curated = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__catalog") continue;
    const d = obj(value);
    const type = str(d.type, 20).toLowerCase();
    if (!["select", "number", "boolean", "string", "array", "object"].includes(type)) continue;
    const def = paramSchemaFromClient({ [key]: d }, [key])[key];
    if (!def) continue;
    out[key] = def;
    if (type !== "string" || def.options?.length || def.default !== void 0 || def.min !== void 0 || def.max !== void 0) curated = true;
  }
  return curated || !Object.keys(obj(raw.__catalog)).length ? out : {};
}
function metaFromRow(row) {
  return obj(obj(row.param_schema).__catalog);
}
function quoteMetaFromRow(row, modelId) {
  const meta = metaFromRow(row);
  const publicId = str(row.public_id, 80) || null;
  const inputFields = asArray(row.input_fields);
  const requiredFields = asArray(row.required_fields);
  const category = str(row.category, 60);
  return {
    modelId,
    publicId,
    displayName: `VYORA ${category === "Image to Video" ? "Image" : "Video"}`,
    catalogCostUsd: finite(row.cost_usd),
    catalogCurrency: str(row.cost_currency, 10) || "USD",
    dynamicPricing: bool(meta.dynamic_pricing, false),
    estimateEndpoint: normalizeEstimateEndpoint2(meta.estimate_endpoint, modelId),
    active: bool(row.active, false),
    enabled: bool(row.is_enabled, true),
    comingSoon: bool(row.is_coming_soon, false),
    syncedAt: str(row.synced_at, 60) || null,
    requiredFields,
    supportedFields: inputFields.length ? inputFields : Object.keys(paramSchemaFromRow(row))
  };
}
function mergeSchema(a, b) {
  return Object.keys(b).length ? { ...a, ...b } : a;
}
function isVideoEntry(entry) {
  const category = str(entry.category, 100).toLowerCase();
  const group = str(entry.group_of, 60).toLowerCase();
  return category.includes("video") || ["video", "avatar", "video-edit", "video-tools", "lipsync"].includes(group) || group === "ai-effects" && category.includes("video");
}
function mapLiveEntry(entry, access) {
  const name = str(entry.name ?? entry.model_id, 120);
  const inputFields = asArray(entry.input_fields);
  const schema = schemaFromInputSchema(entry.input_schema, inputFields);
  const fields = inputFields.length ? inputFields : Object.keys(schema);
  const requiredFields = asArray(entry.required_fields ?? obj(entry.input_schema).required);
  const endpoint = normalizeEndpoint(entry.endpoint, entry.endpoint_url, name);
  const estimate = normalizeEstimateEndpoint2(entry.estimate_endpoint, name);
  return {
    model_id: name,
    display_name: str(entry.display_name, 120) || prettyName(name),
    description: str(entry.description, 600) || null,
    category: str(entry.category, 80) || "other",
    endpoint,
    input_fields: fields,
    required_fields: requiredFields,
    param_schema: schema,
    cost_usd: finite(entry.cost ?? entry.cost_usd),
    cost_currency: str(entry.cost_currency, 10) || "USD",
    is_enabled: bool(entry.is_enabled, true),
    is_coming_soon: bool(entry.is_coming_soon, false),
    family: str(entry.family, 80) || null,
    group_of: str(entry.group_of, 80) || null,
    domain: str(entry.domain, 80) || null,
    cost_strategy: str(entry.cost_strategy, 80) || null,
    dynamic_pricing: bool(entry.dynamic_pricing, false),
    endpoint_url: str(entry.endpoint_url, 160) || null,
    estimate_endpoint: estimate,
    source: access === "account" ? "muapi_authenticated" : "muapi_public",
    account_access: access
  };
}
function mapDbRow(row, access) {
  const id = str(row.model_id, 120);
  const meta = metaFromRow(row);
  return {
    model_id: id,
    display_name: str(row.display_name, 120) || prettyName(id),
    description: str(row.description, 600) || null,
    category: str(row.category, 80) || "other",
    endpoint: normalizeEndpoint(row.endpoint, meta.endpoint_url, id),
    input_fields: asArray(row.input_fields),
    required_fields: asArray(row.required_fields),
    param_schema: paramSchemaFromRow(row),
    cost_usd: finite(row.cost_usd),
    cost_currency: str(row.cost_currency, 10) || "USD",
    active: bool(row.active, true),
    is_enabled: bool(row.is_enabled, true),
    is_coming_soon: bool(row.is_coming_soon, false),
    synced_at: str(row.synced_at, 60) || null,
    family: str(meta.family, 80) || null,
    group_of: str(meta.group_of, 80) || null,
    domain: str(meta.domain, 80) || null,
    cost_strategy: str(meta.cost_strategy, 80) || null,
    dynamic_pricing: bool(meta.dynamic_pricing, false),
    endpoint_url: str(meta.endpoint_url, 160) || null,
    estimate_endpoint: normalizeEstimateEndpoint2(meta.estimate_endpoint, id),
    source: str(meta.source, 40) || "database",
    account_access: access
  };
}
function statusFor(model) {
  if (!bool(model.active, true)) return { status: "disabled", reason: "D\xE9sactiv\xE9 dans le catalogue VYORA." };
  if (!bool(model.is_enabled, true)) return { status: "disabled", reason: "D\xE9sactiv\xE9 dans le catalogue MuAPI." };
  if (bool(model.is_coming_soon, false)) return { status: "coming_soon", reason: "Annonc\xE9 par MuAPI, pas encore lanc\xE9." };
  const unsupported = asArray(model.required_fields).filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) return { status: "unsupported", reason: `Entr\xE9e non connect\xE9e dans VYORA : ${unsupported.join(", ")}.` };
  if (model.account_access === "unverified") return { status: "unverified", reason: "Cl\xE9 / compte MuAPI non valid\xE9e c\xF4t\xE9 serveur." };
  if (model.account_access === "public_only") return { status: "unverified", reason: "Mod\xE8le public MuAPI absent du catalogue retourn\xE9 avec la cl\xE9." };
  return { status: "active", reason: "Mod\xE8le actif et s\xE9lectionnable." };
}
async function muapiFetch(path, init = {}) {
  const headers = { Accept: "application/json" };
  if (init.useKey && MUAPI_KEY()) headers["x-api-key"] = MUAPI_KEY();
  if (init.body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${MUAPI_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body ? JSON.stringify(init.body) : void 0,
      signal: AbortSignal.timeout(init.timeout ?? 18e3)
    });
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = raw;
    }
    const d = obj(obj(data).data ?? data);
    const error = res.ok ? "" : redact(str(d.message ?? d.error ?? d.detail, 300) || raw.slice(0, 300) || `HTTP ${res.status}`);
    return { status: res.status, data, error, ok: res.ok };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      status: 0,
      data: null,
      error: redact(e instanceof Error ? e.message : String(e)),
      ok: false,
      timedOut
    };
  }
}
function hasBooleanFlag(value, names, depth = 0) {
  if (depth > 4 || value === null || value === void 0) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = hasBooleanFlag(item, names, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (names.includes(k.toLowerCase()) && typeof v === "boolean") return v;
    const found = hasBooleanFlag(v, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
async function probeAccount() {
  const key = MUAPI_KEY();
  if (!key) {
    const auth2 = { status: null, data: null, error: "Secret MUAPI_API_KEY absent c\xF4t\xE9 serveur.", ok: false };
    return {
      key_configured: false,
      key_valid: false,
      catalog_status: null,
      balance_status: null,
      keys_status: null,
      key_is_test: null,
      error: auth2.error,
      auth: auth2
    };
  }
  const [auth, balance, keys] = await Promise.all([
    muapiFetch("/api/v1/models", { useKey: true, timeout: 2e4 }),
    muapiFetch("/api/v1/account/balance", { useKey: true, timeout: 12e3 }),
    muapiFetch("/api/v1/keys", { useKey: true, timeout: 12e3 })
  ]);
  const key_valid = auth.ok || balance.ok || keys.ok;
  const key_is_test = keys.ok ? hasBooleanFlag(keys.data, ["is_test", "test", "is_sandbox", "sandbox"]) : null;
  const errors = [auth, balance, keys].filter((r) => !r.ok).map((r) => r.error).filter(Boolean);
  return {
    key_configured: true,
    key_valid,
    catalog_status: auth.status,
    balance_status: balance.status,
    keys_status: keys.status,
    key_is_test,
    error: key_valid ? auth.ok ? "" : "Catalogue authentifi\xE9 indisponible : " + auth.error : redact(errors.join(" \xB7 ") || "Cl\xE9 MuAPI refus\xE9e."),
    auth
  };
}
async function fetchProviderBalance() {
  if (!MUAPI_KEY()) {
    return {
      status: "error",
      balance_usd: null,
      currency: null,
      http_status: null,
      error_code: "provider_key_missing",
      error_message: "Cl\xE9 MuAPI absente c\xF4t\xE9 serveur.",
      data: {}
    };
  }
  const reply = await muapiFetch("/api/v1/account/balance", { useKey: true, timeout: 12e3 });
  const data = obj(reply.data);
  const raw = obj(data.data ?? data);
  const balance = finite(raw.balance ?? data.balance);
  if (!reply.ok || balance === null) {
    return {
      status: "error",
      balance_usd: null,
      currency: null,
      http_status: reply.status ?? null,
      error_code: reply.ok ? "provider_balance_unreadable" : "provider_balance_unavailable",
      error_message: reply.ok ? "La r\xE9ponse de solde MuAPI ne contient pas de montant exploitable." : reply.error || `HTTP ${reply.status}`,
      data: {}
    };
  }
  return {
    status: "ok",
    balance_usd: balance,
    currency: str(raw.currency ?? data.currency, 10) || "USD",
    http_status: reply.status ?? null,
    error_code: null,
    error_message: null,
    data: raw
  };
}
async function persistProviderBalance(probe) {
  const d = probe.data;
  const payload = {
    provider: "muapi",
    balance_usd: probe.balance_usd,
    currency: probe.currency,
    account_email: str(d.email, 200) || null,
    bonus_balances: obj(d.bonus_balances),
    topup_totals: obj(d.topup_totals),
    http_status: probe.http_status,
    status: probe.status,
    error_code: probe.error_code,
    error_message: probe.error_message ? redact(probe.error_message).slice(0, 500) : null,
    synced_at: probe.status === "ok" ? (/* @__PURE__ */ new Date()).toISOString() : null,
    checked_at: (/* @__PURE__ */ new Date()).toISOString(),
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/ugc_provider_balance?on_conflict=provider`, {
    method: "POST",
    headers: svcHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15e3)
  });
  if (!res.ok) {
    console.error("provider balance persist failed", res.status);
    return;
  }
  if (probe.status !== "ok") {
    await fetch(`${SUPABASE_URL()}/rest/v1/ugc_provider_spend_alerts`, {
      method: "POST",
      headers: svcHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({
        alert_key: `balance_sync_${(/* @__PURE__ */ new Date()).toISOString().slice(0, 13)}`,
        provider: "muapi",
        kind: "balance_sync_failed",
        severity: "warning",
        title: "Solde MuAPI non v\xE9rifiable",
        reason: probe.error_message ? redact(probe.error_message).slice(0, 300) : probe.error_code,
        metadata: { http_status: probe.http_status, error_code: probe.error_code }
      }),
      signal: AbortSignal.timeout(15e3)
    });
  }
}
function balanceGate(probe, costUsd) {
  if (probe.status !== "ok" || probe.balance_usd === null) return "PROVIDER_BALANCE_UNAVAILABLE";
  if (costUsd > 0 && probe.balance_usd < costUsd) return "PROVIDER_BALANCE_INSUFFICIENT";
  return null;
}
function entriesOf(reply) {
  const data = obj(reply.data);
  return Array.isArray(data.models) ? data.models.filter((x) => !!x && typeof x === "object") : [];
}
function totalOf(reply, entries) {
  const data = obj(reply.data);
  const n = finite(data.total);
  return n !== null ? n : reply.ok ? entries.length : null;
}
var schemaCache = /* @__PURE__ */ new Map();
async function effectiveSchema(row, modelId) {
  const local = paramSchemaFromRow(row);
  const fallback = { schema: local, fields: asArray(row.input_fields), required: asArray(row.required_fields) };
  if (Object.keys(local).length) return fallback;
  const cached = schemaCache.get(modelId);
  if (cached && Date.now() - cached.at < 3e5) return { schema: cached.schema, fields: cached.fields, required: cached.required };
  const key = MUAPI_KEY();
  let reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: Boolean(key), timeout: 12e3 });
  if (!reply.ok && key) reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: false, timeout: 12e3 });
  if (!reply.ok) return fallback;
  const d = obj(obj(reply.data).data ?? reply.data);
  const fields = asArray(d.input_fields);
  const schema = schemaFromInputSchema(d.input_schema, fields);
  const required = asArray(d.required_fields);
  const value = { schema, fields, required, at: Date.now() };
  schemaCache.set(modelId, value);
  return { schema, fields, required };
}
function buildQuoteBody(body, schema, fields, required) {
  const out = {};
  const prompt = str(body.prompt, 4e3);
  const imageUrl = str(body.image_url, 2e3);
  const lastImageUrl = str(body.last_image_url, 2e3);
  if ((fields.includes("prompt") || required.includes("prompt")) && prompt) out.prompt = prompt;
  if ((fields.includes("image_url") || required.includes("image_url")) && imageUrl) out.image_url = imageUrl;
  if ((fields.includes("last_image") || required.includes("last_image")) && lastImageUrl) out.last_image = lastImageUrl;
  const videoUrl = str(body.video_url, 2e3);
  const audioUrl = str(body.audio_url, 2e3);
  for (const key of ["video_url", "input_video"]) {
    if ((fields.includes(key) || required.includes(key)) && videoUrl) out[key] = videoUrl;
  }
  if ((fields.includes("audio_url") || required.includes("audio_url")) && audioUrl) out.audio_url = audioUrl;
  const params = obj(body.params);
  for (const [key, def] of Object.entries(schema)) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const raw = params[key] ?? body[key] ?? def.default;
    const value = scalar(raw);
    if (!def || value === void 0) continue;
    if (def.type === "select" && Array.isArray(def.options) && !def.options.some((o) => String(o) === String(value))) continue;
    if (def.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.min(Math.max(n, def.min ?? 1), def.max ?? 300);
    } else if (def.type === "boolean") out[key] = value === true || value === "true" || value === 1;
    else if (def.type === "string" || def.type === "select") out[key] = value;
  }
  return out;
}
function buildMuapiBody(model, payload, prompt, imageUrl, lastImageUrl = "", media = {}) {
  const fields = asArray(model.input_fields);
  const required = asArray(model.required_fields);
  const body = {};
  if (fields.includes("prompt") || required.includes("prompt")) body.prompt = prompt;
  if (fields.includes("image_url")) {
    if (required.includes("image_url") && !imageUrl) throw new Error("IMAGE_MISSING");
    if (imageUrl) body.image_url = imageUrl;
  }
  const videoUrl = media.videoUrl ?? "";
  const audioUrl = media.audioUrl ?? "";
  for (const key of ["video_url", "input_video"]) {
    if (!fields.includes(key)) continue;
    if (required.includes(key) && !videoUrl) throw new Error("VIDEO_MISSING");
    if (videoUrl) body[key] = videoUrl;
  }
  if (fields.includes("audio_url")) {
    if (required.includes("audio_url") && !audioUrl) throw new Error("AUDIO_MISSING");
    if (audioUrl) body.audio_url = audioUrl;
  }
  for (const key of ["first_frame_url", "first_frame_image"]) {
    if (!fields.includes(key)) continue;
    if (required.includes(key) && !imageUrl) throw new Error("IMAGE_MISSING");
    if (imageUrl) body[key] = imageUrl;
  }
  if (fields.includes("last_image")) {
    if (required.includes("last_image") && !lastImageUrl) throw new Error("LAST_IMAGE_MISSING");
    if (lastImageUrl) body.last_image = lastImageUrl;
  }
  const schema = paramSchemaFromRow(model);
  const params = obj(payload.params);
  for (const [key, def] of Object.entries(schema)) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const raw = params[key] ?? payload[key] ?? def.default;
    const value = scalar(raw);
    if (value === void 0 || value === "") continue;
    if (def.type === "select") {
      if (Array.isArray(def.options) && !def.options.some((o) => String(o) === String(value))) continue;
      body[key] = value;
    } else if (def.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      body[key] = Math.min(Math.max(n, def.min ?? 1), def.max ?? 300);
    } else if (def.type === "boolean") {
      body[key] = value === true || value === "true" || value === 1;
    } else if (def.type === "string") {
      body[key] = value;
    }
  }
  return body;
}
function buildPrompt(payload, script) {
  const visual = str(payload.visual_prompt, 1500);
  const scenes = Array.isArray(payload.scenes) ? payload.scenes.slice(0, 8) : [];
  const sceneText = scenes.map(
    (s, i) => `Plan ${i + 1} (${str(s.scene_type, 30) || "ugc"}, ${Number(s.duration_seconds) || 3}s) : ${str(s.visual_prompt, 400)}`
  ).filter((x) => x.length > 20).join(" ");
  const ctx = script ? ` Contexte du message UGC (voix off, ne pas \xE9crire \xE0 l'\xE9cran) : ${script.slice(0, 500)}` : "";
  const base = [visual, sceneText].filter(Boolean).join(" ");
  return (base || "Vid\xE9o UGC verticale authentique film\xE9e au smartphone, lumi\xE8re naturelle, personne pr\xE9sentant le produit.").concat(ctx).slice(0, 4e3);
}
function muapiSubmitId(raw) {
  const d = obj(raw.data ?? raw);
  return str(d.request_id, 300) || str(d.id, 300);
}
function muapiCost(raw) {
  const d = obj(raw.data ?? raw);
  return d.cost && typeof d.cost === "object" ? obj(d.cost) : null;
}
function muapiActualCostUsd(raw) {
  if (!raw) return null;
  const currency = str(raw.currency ?? raw.cost_currency, 10).toUpperCase();
  const amount = raw.amount_usd ?? raw.cost_usd ?? (currency === "USD" ? raw.amount : null);
  const value = finite(amount);
  return value !== null && value >= 0 ? value : null;
}
async function updateProviderSpend(jobId, status, options = {}) {
  const result = await rpcService("reelora_update_provider_spend", {
    p_job_id: jobId,
    p_status: status,
    p_provider_request_id: options.providerRequestId ?? null,
    p_actual_cost_usd: options.actualCostUsd ?? null,
    p_release: options.release ?? false,
    p_reason_code: options.reasonCode ?? null
  });
  if (!result.ok || result.data !== true) {
    console.error("provider spend update failed", redact(result.error ?? "provider_spend_update_rejected"));
    return false;
  }
  return true;
}
function friendly(code, _detail) {
  const map = {
    MUAPI_NOT_CONFIGURED: "Le service vid\xE9o n\u2019est pas disponible pour le moment. Les cr\xE9dits r\xE9serv\xE9s ont \xE9t\xE9 restitu\xE9s.",
    MUAPI_SUBMIT_ERROR: "La demande de g\xE9n\xE9ration n\u2019a pas abouti. Les cr\xE9dits r\xE9serv\xE9s ont \xE9t\xE9 restitu\xE9s.",
    MUAPI_NO_REQUEST_ID: "Le suivi de la g\xE9n\xE9ration n\u2019a pas pu d\xE9marrer. Les cr\xE9dits r\xE9serv\xE9s ont \xE9t\xE9 restitu\xE9s.",
    MODEL_UNAVAILABLE: "Ce mod\xE8le n\u2019est plus disponible. Choisissez une autre option.",
    MODEL_NOT_FOUND: "Ce mod\xE8le est introuvable.",
    UNSUPPORTED_INPUT: "Ce mod\xE8le n\xE9cessite un r\xE9glage qui n\u2019est pas pris en charge. Les cr\xE9dits r\xE9serv\xE9s ont \xE9t\xE9 restitu\xE9s.",
    IMAGE_MISSING: "Ce mod\xE8le exige une image de r\xE9f\xE9rence. Importez une image ou choisissez un mod\xE8le texte \u2192 vid\xE9o.",
    LAST_IMAGE_MISSING: "Ce mod\xE8le exige une image finale de r\xE9f\xE9rence.",
    SCRIPT_MISSING: "G\xE9n\xE9rez ou saisissez un script avant de lancer la vid\xE9o.",
    VIDEO_QUOTE_INVALID: "Le devis est expir\xE9 ou ne correspond plus aux param\xE8tres. Recalculez le co\xFBt avant de relancer.",
    SUBMISSION_ALREADY_CLAIMED: "La soumission est d\xE9j\xE0 en cours. Actualisez le suivi.",
    PROVIDER_SPEND_DISABLED: "Les tests payants du fournisseur sont d\xE9sactiv\xE9s par l\u2019administration.",
    PROVIDER_SPEND_CAP_EXCEEDED: "Le budget fournisseur disponible ne couvre pas cette g\xE9n\xE9ration.",
    PROVIDER_SPEND_UNAVAILABLE: "La v\xE9rification du budget fournisseur est indisponible. Aucun appel payant n\u2019a \xE9t\xE9 lanc\xE9.",
    PROVIDER_SPEND_ALREADY_RESERVED: "La r\xE9servation du budget est d\xE9j\xE0 utilis\xE9e ou n\xE9cessite une v\xE9rification administrative.",
    PROVIDER_SPEND_PROVIDER_CAP_EXCEEDED: "Le plafond VYORA de ce fournisseur est atteint. Aucun appel payant n\u2019a \xE9t\xE9 lanc\xE9.",
    PROVIDER_SPEND_PROVIDER_CAP_UNAVAILABLE: "Le plafond de ce fournisseur n\u2019a pas pu \xEAtre v\xE9rifi\xE9. Aucun appel payant n\u2019a \xE9t\xE9 lanc\xE9.",
    PROVIDER_BALANCE_INSUFFICIENT: "Le solde fournisseur MuAPI est insuffisant pour cette g\xE9n\xE9ration. Aucun appel payant n\u2019a \xE9t\xE9 lanc\xE9 : rechargez le compte MuAPI depuis l\u2019espace administration.",
    PROVIDER_BALANCE_UNAVAILABLE: "Impossible de v\xE9rifier le solde MuAPI. Aucun appel payant n\u2019a \xE9t\xE9 lanc\xE9. R\xE9essayez ou v\xE9rifiez la cl\xE9 et la connexion au fournisseur."
  };
  return map[code] ?? "La g\xE9n\xE9ration a \xE9chou\xE9. Les cr\xE9dits r\xE9serv\xE9s ont \xE9t\xE9 restitu\xE9s.";
}
async function releaseQuota(jobId, userId) {
  await rpcService("reelora_release_video_quota", { p_job_id: jobId, p_user_id: userId });
}
async function failJob(jobId, userId, code, detail) {
  await rpcService("reelora_finalize_generation", {
    p_job_id: jobId,
    p_status: "failed",
    p_storage_path: null,
    p_mime_type: "video/mp4",
    p_file_size_bytes: null,
    p_result_payload: { error_code: code },
    p_error_message: friendly(code, detail)
  });
  await releaseQuota(jobId, userId);
  return fail(code, friendly(code, detail), 503);
}
async function actionModels() {
  const key = MUAPI_KEY();
  if (key) {
    try {
      const res = await fetch(`${MUAPI_BASE}/api/v1/models`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(15e3)
      });
      if (res.ok) {
        const catalog = await res.json();
        const rows = await restService("reelora_video_models?select=model_id,public_id");
        const allowed = new Set(rows.map((r) => str(r.model_id, 120)));
        const entries = Array.isArray(catalog.models) ? catalog.models.filter((m) => allowed.has(str(m.name, 120))) : [];
        if (entries.length) await rpcService("reelora_sync_video_models", { p_models: entries });
      }
    } catch {
    }
  }
  const models = await restService("reelora_video_models?active=eq.true&select=*&order=sort_order");
  return json({ models: models.map((m, index) => customerModel(m, index)) });
}
async function actionCatalog(adminOnly = false) {
  const [publicReply, probe, dbRows] = await Promise.all([
    muapiFetch("/api/v1/models", { useKey: false, timeout: 2e4 }),
    probeAccount(),
    restService("reelora_video_models?select=*&order=sort_order")
  ]);
  const publicEntries = entriesOf(publicReply);
  const authEntries = probe.auth.ok ? entriesOf(probe.auth) : [];
  const authNames = new Set(authEntries.map((e) => str(e.name, 120)).filter(validModelId));
  const authCatalogOk = probe.auth.ok && authNames.size > 0;
  const accessFor = (name) => {
    if (!probe.key_valid || !authCatalogOk) return "unverified";
    return authNames.has(name) ? "account" : "public_only";
  };
  const merged = /* @__PURE__ */ new Map();
  for (const row of dbRows) {
    const id = str(row.model_id, 120);
    if (validModelId(id)) merged.set(id, mapDbRow(row, accessFor(id)));
  }
  for (const entry of publicEntries.filter(isVideoEntry)) {
    const id = str(entry.name, 120);
    if (!validModelId(id)) continue;
    const live = mapLiveEntry(entry, accessFor(id));
    const prev = merged.get(id);
    merged.set(id, prev ? {
      ...prev,
      ...live,
      input_fields: asArray(live.input_fields).length ? live.input_fields : asArray(prev.input_fields),
      required_fields: asArray(live.required_fields).length ? live.required_fields : asArray(prev.required_fields),
      param_schema: mergeSchema(obj(prev.param_schema), live.param_schema),
      synced_at: prev.synced_at ?? null
    } : live);
  }
  for (const entry of authEntries.filter(isVideoEntry)) {
    const id = str(entry.name, 120);
    if (!validModelId(id)) continue;
    const access = accessFor(id);
    const live = mapLiveEntry(entry, access);
    const prev = merged.get(id);
    merged.set(id, prev ? {
      ...prev,
      ...live,
      input_fields: asArray(live.input_fields).length ? live.input_fields : asArray(prev.input_fields),
      required_fields: asArray(live.required_fields).length ? live.required_fields : asArray(prev.required_fields),
      param_schema: mergeSchema(obj(prev.param_schema), live.param_schema),
      synced_at: prev.synced_at ?? null,
      account_access: access
    } : live);
  }
  const models = Array.from(merged.values()).map((model) => {
    const s = statusFor(model);
    return { ...model, reelora_status: s.status, reelora_reason: s.reason };
  }).sort((a, b) => str(a.category).localeCompare(str(b.category)) || str(a.model_id).localeCompare(str(b.model_id)));
  const reasons = {};
  for (const m of models) reasons[str(m.reelora_status)] = (reasons[str(m.reelora_status)] ?? 0) + 1;
  const active = reasons.active ?? 0;
  const account_accessible = models.filter((m) => m.account_access === "account").length;
  const public_only = models.filter((m) => m.account_access === "public_only").length;
  const errors = [];
  if (!publicReply.ok) errors.push(`Catalogue public MuAPI indisponible : ${publicReply.error || `HTTP ${publicReply.status}`}`);
  if (probe.key_configured && !probe.key_valid) errors.push(`Cl\xE9 MuAPI non valid\xE9e : ${probe.error}`);
  if (probe.key_configured && probe.key_valid && !authCatalogOk) errors.push(`Catalogue authentifi\xE9 indisponible : ${probe.error || "aucune entr\xE9e retourn\xE9e"}`);
  if (!dbRows.length && !publicReply.ok) errors.push("Catalogue local indisponible.");
  const source = probe.key_valid && authCatalogOk ? "muapi_authenticated" : publicReply.ok ? "muapi_public" : "database";
  const catalog = {
    source,
    fetched_at: (/* @__PURE__ */ new Date()).toISOString(),
    public_total: totalOf(publicReply, publicEntries),
    authenticated_total: probe.auth.ok ? totalOf(probe.auth, authEntries) : null,
    detected_video: models.length,
    active,
    unavailable: models.length - active,
    account_accessible,
    public_only,
    reasons,
    endpoints: [
      `GET /api/v1/models (public HTTP ${publicReply.status || "network"})`,
      `GET /api/v1/models (authentifi\xE9 HTTP ${probe.catalog_status ?? "network"})`,
      `GET /api/v1/account/balance (HTTP ${probe.balance_status ?? "network"})`,
      `GET /api/v1/keys (HTTP ${probe.keys_status ?? "network"})`
    ],
    error: errors.length ? redact(errors.join(" \xB7 ")) : null,
    account: {
      key_configured: probe.key_configured,
      key_valid: probe.key_valid,
      catalog_status: probe.catalog_status,
      balance_status: probe.balance_status,
      keys_status: probe.keys_status,
      key_is_test: probe.key_is_test,
      error: probe.error ? redact(probe.error) : null
    }
  };
  if (adminOnly) return json({ models, catalog });
  const publicIdByModelId = new Map(dbRows.map((row) => [str(row.model_id, 120), str(row.public_id, 80)]));
  const customerModels = models.filter((model) => publicIdByModelId.has(str(model.model_id, 120))).map((model, index) => customerModel(
    { ...model, public_id: publicIdByModelId.get(str(model.model_id, 120)) },
    index,
    str(model.reelora_status)
  ));
  const verified = probe.key_valid && authCatalogOk;
  return json({
    models: customerModels,
    catalog: {
      fetched_at: catalog.fetched_at,
      detected_video: customerModels.length,
      active: customerModels.filter((model) => model.reelora_status === "active").length,
      unavailable: customerModels.filter((model) => model.reelora_status !== "active").length,
      verified,
      error: verified ? null : "Le catalogue est temporairement indisponible."
    }
  });
}
async function actionModelDetail(body) {
  const requestedModelId = str(body.model_id, 120);
  if (!requestedModelId) return fail("INVALID_INPUT", "Identifiant de mod\xE8le invalide.", 400);
  const row = await loadModel(requestedModelId);
  if (!row) return fail("MODEL_NOT_FOUND", "Mod\xE8le vid\xE9o inconnu.", 404);
  const publicModelId = str(row.public_id, 80);
  const modelId = str(row.model_id, 120);
  const key = MUAPI_KEY();
  let reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: Boolean(key), timeout: 15e3 });
  if (!reply.ok && key) reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: false, timeout: 15e3 });
  if (!reply.ok) return fail("MODEL_DETAIL_UNAVAILABLE", "Les param\xE8tres de ce mod\xE8le ne sont pas disponibles.", 502);
  const d = obj(obj(reply.data).data ?? reply.data);
  const name = str(d.name, 120) || modelId;
  if (name !== modelId) return fail("MODEL_DETAIL_MISMATCH", "La fiche MuAPI ne correspond pas au mod\xE8le demand\xE9.", 502);
  const fields = asArray(d.input_fields);
  const detailSchema = schemaFromInputSchema(d.input_schema, fields);
  const rowSchema = paramSchemaFromRow(row);
  const model = {
    ...row,
    ...mapLiveEntry({ ...d, name: modelId }, "unverified"),
    model_id: modelId,
    public_id: publicModelId,
    input_fields: fields.length ? fields : asArray(row.input_fields),
    required_fields: asArray(d.required_fields).length ? asArray(d.required_fields) : asArray(row.required_fields),
    param_schema: mergeSchema(rowSchema, detailSchema)
  };
  return json({ model: customerModel(model, 0) });
}
async function actionAdminCatalog(userJwt) {
  const response = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_overview`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15e3)
  });
  if (!response.ok) return fail("FORBIDDEN", "Acc\xE8s administrateur requis.", 403);
  await actionModels();
  return actionCatalog(true);
}
async function actionAdminProviderBalance(userJwt, refresh) {
  const response = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_overview`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15e3)
  });
  if (!response.ok) return fail("FORBIDDEN", "Acc\xE8s administrateur requis.", 403);
  if (refresh) {
    const probe = await fetchProviderBalance();
    await persistProviderBalance(probe);
    const summary = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_provider_spend_summary`, {
      method: "POST",
      headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15e3)
    });
    const spend2 = summary.ok ? await summary.json() : null;
    return json({
      balance: {
        provider: "muapi",
        status: probe.status,
        balance_usd: probe.balance_usd,
        currency: probe.currency,
        http_status: probe.http_status,
        error_code: probe.error_code,
        error_message: probe.error_message ? redact(probe.error_message) : null,
        checked_at: (/* @__PURE__ */ new Date()).toISOString()
      },
      spend: spend2
    });
  }
  const [stored, spend] = await Promise.all([
    fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_provider_balance`, {
      method: "POST",
      headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15e3)
    }),
    fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_provider_spend_summary`, {
      method: "POST",
      headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15e3)
    })
  ]);
  const balance = stored.ok ? await stored.json() : { error: "read_failed" };
  const spendData = spend.ok ? await spend.json() : null;
  return json({ balance, spend: spendData });
}
async function resolveProviderQuote(body) {
  const requested = str(body.model_id, 120);
  const now = /* @__PURE__ */ new Date();
  const row = requested ? await loadModel(requested) : null;
  if (!row) {
    return {
      quote: unavailableQuote({ code: "MODEL_NOT_FOUND", now }),
      quoteParams: {},
      pricingBasis: {},
      modelStatus: "disabled",
      modelAvailable: false,
      modelReason: "Mod\xE8le vid\xE9o inconnu.",
      publicModelId: null,
      modelId: requested,
      meta: null
    };
  }
  const modelId = str(row.model_id, 120);
  const publicModelId = str(row.public_id, 80) || null;
  const meta = quoteMetaFromRow(row, modelId);
  const effective = await effectiveSchema(row, modelId);
  const clientSchema = paramSchemaFromClient(body.param_schema, effective.fields);
  const schema = Object.keys(clientSchema).length ? clientSchema : effective.schema;
  const quoteParams = buildQuoteBody(body, schema, effective.fields, effective.required);
  const pricingBasis = buildPricingBasis(quoteParams, effective.fields);
  const unsupported = effective.required.filter((field) => !SUPPORTED_REQUIRED_FIELDS.has(field.toLowerCase()));
  const status = statusFor(row);
  const modelAvailable = Boolean(bool(row.active, false) && bool(row.is_enabled, true) && !bool(row.is_coming_soon, false) && !unsupported.length);
  const base = {
    estimateEndpoint: meta.estimateEndpoint,
    catalogSyncedAt: meta.syncedAt,
    pricingBasis
  };
  const modelReason = unsupported.length ? "Ce mod\xE8le n\xE9cessite un r\xE9glage qui n\u2019est pas encore pris en charge." : modelAvailable ? "Disponible dans VYORA." : status.reason || "Indisponible momentan\xE9ment.";
  const finish = (quote) => ({
    quote,
    quoteParams,
    pricingBasis,
    modelStatus: status.status,
    modelAvailable,
    modelReason,
    publicModelId,
    modelId,
    meta
  });
  if (!modelAvailable) {
    return finish(unavailableQuote({ code: "MODEL_UNAVAILABLE", now, ...base }));
  }
  if (meta.dynamicPricing) {
    if (!MUAPI_KEY()) {
      return finish(unavailableQuote({ code: "PROVIDER_KEY_MISSING", now, ...base }));
    }
    if (!meta.estimateEndpoint) {
      return finish(unavailableQuote({ code: "ESTIMATE_ENDPOINT_MISSING", now, ...base }));
    }
    if (effective.required.includes("prompt") && !str(quoteParams.prompt, 4e3)) {
      return finish(unavailableQuote({ code: "PROMPT_REQUIRED", now, ...base }));
    }
    const reply = await muapiFetch(meta.estimateEndpoint, {
      method: "POST",
      useKey: true,
      body: quoteParams,
      timeout: 2e4
    });
    const providerReply = {
      ok: reply.ok,
      status: reply.status,
      data: reply.data,
      timedOut: reply.timedOut === true
    };
    const quote = buildProviderQuote({
      model: meta,
      providerReply,
      pricingParams: quoteParams,
      prompt: str(quoteParams.prompt, 4e3),
      now
    });
    return finish(quote);
  }
  return finish(buildProviderQuote({
    model: meta,
    providerReply: null,
    pricingParams: quoteParams,
    prompt: str(quoteParams.prompt, 4e3),
    now
  }));
}
async function actionProviderQuote(body) {
  const resolved = await resolveProviderQuote(body);
  return json({
    model_id: resolved.publicModelId,
    model_available: resolved.modelAvailable,
    model_status: resolved.modelStatus,
    model_reason: resolved.modelReason,
    quote: resolved.quote
  });
}
async function actionEstimate(body, userId) {
  const serviceKey = str(body.service_key, 80);
  const requestedModelId = str(body.model_id, 120);
  const rows = await restService(`ugc_service_catalog?service_key=eq.${encodeURIComponent(serviceKey)}&select=service_key,display_name,credits_cost,active&limit=1`);
  const service = rows[0];
  const resolved = requestedModelId ? await resolveProviderQuote(body) : null;
  const quote = resolved?.quote ?? null;
  const providerCostUsd = quote?.available ? quote.cost_usd : null;
  const quoteAvailable = Boolean(quote?.available && providerCostUsd && providerCostUsd > 0);
  const modelAvailable = Boolean(resolved?.modelAvailable);
  const modelStatus = resolved?.modelStatus ?? "disabled";
  let creditsCost = null;
  let quoteId = null;
  let pricingError = null;
  if (!service?.active || !modelAvailable) {
    pricingError = "Ce mod\xE8le ou ce service n'est pas disponible pour le moment.";
  } else if (!quoteAvailable || providerCostUsd === null) {
    pricingError = quote?.error_message ?? "Le tarif exact de cette g\xE9n\xE9ration n'est pas disponible.";
  } else {
    const config = await loadVideoPricingConfig();
    if (!config?.enabled || config.usd_to_xof === null || config.credit_value_xof === null || config.markup_percent === null || config.additional_cost_usd === null || !config.updated_at) {
      pricingError = "La tarification en cr\xE9dits n'est pas encore configur\xE9e. Le devis fournisseur en USD reste disponible, mais la r\xE9servation de cr\xE9dits est bloqu\xE9e.";
    } else {
      creditsCost = calculateVideoCredits(providerCostUsd, config);
      if (creditsCost === null) {
        pricingError = "Le tarif exact de cette g\xE9n\xE9ration n'est pas disponible.";
      } else {
        const pricingParams = pricingParameters(resolved?.quoteParams ?? {});
        const recorded = await rpcService("reelora_record_video_quote", {
          p_user_id: userId,
          p_service_key: serviceKey,
          p_model_id: resolved?.modelId ?? "",
          p_public_model_id: resolved?.publicModelId ?? "",
          p_credits_cost: creditsCost,
          p_provider_cost_usd: providerCostUsd,
          p_usd_to_xof: config.usd_to_xof,
          p_credit_value_xof: config.credit_value_xof,
          p_markup_percent: config.markup_percent,
          p_additional_cost_usd: config.additional_cost_usd,
          p_config_updated_at: config.updated_at,
          p_quote_params: pricingParams,
          p_pricing_params: pricingParams
        });
        if (recorded.ok && typeof recorded.data === "string") {
          quoteId = recorded.data;
        } else {
          creditsCost = null;
          pricingError = "Le devis n'a pas pu \xEAtre valid\xE9. R\xE9essayez.";
        }
      }
    }
  }
  return json({
    service_key: serviceKey,
    credits_cost: creditsCost,
    service_active: Boolean(service?.active),
    model_id: resolved?.publicModelId ?? null,
    model_available: modelAvailable,
    model_status: modelStatus,
    model_reason: resolved?.modelReason ?? "Mod\xE8le vid\xE9o inconnu.",
    pricing_available: Boolean(quoteId),
    pricing_error: pricingError,
    quote_id: quoteId,
    quote_expires_at: quoteId ? new Date(Date.now() + 10 * 60 * 1e3).toISOString() : null,
    provider_quote: quote
  });
}
async function actionStart(jobId, userId) {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "T\xE2che de g\xE9n\xE9ration introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette t\xE2che ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const providerJobId = str(job.provider_job_id, 300);
  const payload = obj(job.request_payload);
  if (["succeeded", "failed", "cancelled"].includes(status) || providerJobId) {
    return json({ job_id: jobId, status });
  }
  const quoteId = str(job.pricing_quote_id, 80) || str(payload.quote_id, 80);
  const quoteResult = quoteId ? await rpcService("reelora_get_video_quote", { p_quote_id: quoteId }) : { ok: false, data: null, error: "missing_quote" };
  const quote = obj(quoteResult.data);
  const publicModelId = str(payload.model_id, 80);
  if (!quoteResult.ok || str(quote.user_id, 80) !== userId || str(quote.service_key, 80) !== str(job.service_key, 80) || str(quote.public_model_id, 80) !== publicModelId || Number(quote.credits_cost) !== Number(job.credits_reserved)) {
    return await failJob(jobId, userId, "VIDEO_QUOTE_INVALID", "");
  }
  const claimId = `claim-${crypto.randomUUID()}`;
  const claim = await rpcService("reelora_claim_generation_submission", { p_job_id: jobId, p_claim_id: claimId });
  if (!claim.ok || claim.data !== true) {
    return json({
      job_id: jobId,
      status,
      message: friendly("SUBMISSION_ALREADY_CLAIMED", "")
    });
  }
  const key = MUAPI_KEY();
  if (!key) {
    return await failJob(jobId, userId, "MUAPI_NOT_CONFIGURED", "Cl\xE9 MuAPI absente.");
  }
  const rawModel = publicModelId ? await loadModel(publicModelId) : null;
  if (!rawModel) return await failJob(jobId, userId, "MODEL_NOT_FOUND", "");
  const modelId = str(rawModel.model_id, 120);
  const model = { ...rawModel };
  if (!bool(model.active, false) || !bool(model.is_enabled, true) || bool(model.is_coming_soon, false)) {
    return await failJob(jobId, userId, "MODEL_UNAVAILABLE", "");
  }
  const effective = await effectiveSchema(model, modelId);
  const unsupported = effective.required.filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) return await failJob(jobId, userId, "UNSUPPORTED_INPUT", unsupported.join(", "));
  model.input_fields = effective.fields;
  model.required_fields = effective.required;
  model.param_schema = effective.schema;
  const script = str(payload.script_text, 4e3) || await loadScript(str(job.project_id, 80));
  if (script.length < 10) return await failJob(jobId, userId, "SCRIPT_MISSING", "Script absent.");
  const prompt = buildPrompt(payload, script);
  const workspaceId = str(job.workspace_id, 80);
  const modelFields = asArray(model.input_fields);
  const acceptsImage = modelFields.includes("image_url");
  const acceptsLastImage = modelFields.includes("last_image");
  let imageUrl = acceptsImage ? str(payload.image_url, 2e3) : "";
  const imagePath = acceptsImage ? workspaceImagePath(payload.image_storage_path, workspaceId) : "";
  if (!imageUrl && imagePath) imageUrl = await signStoragePath(imagePath) ?? "";
  if (!imageUrl && acceptsImage) {
    const avatar = await loadAvatar(str(payload.avatar_id, 80));
    imageUrl = str(avatar?.preview_url, 2e3);
    const avatarPath = workspaceImagePath(avatar?.preview_storage_path, workspaceId);
    if (!imageUrl && avatarPath) {
      imageUrl = await signStoragePath(avatarPath) ?? "";
    }
  }
  let lastImageUrl = acceptsLastImage ? str(payload.last_image_url, 2e3) : "";
  const lastImagePath = acceptsLastImage ? workspaceImagePath(payload.last_image_storage_path, workspaceId) : "";
  if (!lastImageUrl && lastImagePath) lastImageUrl = await signStoragePath(lastImagePath) ?? "";
  const acceptsVideo = modelFields.some((f) => f === "video_url" || f === "input_video");
  const acceptsAudio = modelFields.includes("audio_url");
  let videoUrl = acceptsVideo ? str(payload.video_url, 2e3) : "";
  const videoPath = acceptsVideo ? workspaceImagePath(payload.video_storage_path, workspaceId) : "";
  if (!videoUrl && videoPath) videoUrl = await signStoragePath(videoPath) ?? "";
  let audioUrl = acceptsAudio ? str(payload.audio_url, 2e3) : "";
  const audioPath = acceptsAudio ? workspaceImagePath(payload.audio_storage_path, workspaceId) : "";
  if (!audioUrl && audioPath) audioUrl = await signStoragePath(audioPath) ?? "";
  let submitBody;
  try {
    submitBody = buildMuapiBody(model, payload, prompt, imageUrl, lastImageUrl, { videoUrl, audioUrl });
  } catch (e) {
    const code = e instanceof Error ? e.message.split(":")[0] : "INVALID_INPUT";
    return await failJob(jobId, userId, code, e instanceof Error ? e.message : String(e));
  }
  if (str(quote.model_id, 120) !== modelId || canonicalJson(pricingParameters(submitBody)) !== canonicalJson(obj(quote.pricing_params))) {
    return await failJob(jobId, userId, "VIDEO_QUOTE_INVALID", "");
  }
  const endpoint = normalizeEndpoint(model.endpoint, metaFromRow(rawModel).endpoint_url, modelId);
  if (!validEndpoint(endpoint)) return await failJob(jobId, userId, "MODEL_UNAVAILABLE", "");
  const spendReservation = await rpcService("reelora_reserve_provider_spend", { p_job_id: jobId });
  if (!spendReservation.ok) {
    console.error("provider spend reservation failed", redact(spendReservation.error ?? "provider_spend_unavailable"));
    return await failJob(jobId, userId, "PROVIDER_SPEND_UNAVAILABLE", "");
  }
  const spendDecision = obj(spendReservation.data);
  if (spendDecision.allowed !== true) {
    const reason = str(spendDecision.reason, 80);
    const code = reason === "provider_spend_disabled" ? "PROVIDER_SPEND_DISABLED" : reason === "provider_spend_cap_exceeded" ? "PROVIDER_SPEND_CAP_EXCEEDED" : "PROVIDER_SPEND_ALREADY_RESERVED";
    return await failJob(jobId, userId, code, "");
  }
  const estimatedUsd = finite(spendDecision.estimated_cost_usd) ?? 0;
  const providerBalance = await fetchProviderBalance();
  void persistProviderBalance(providerBalance);
  const gate = balanceGate(providerBalance, estimatedUsd);
  if (gate) {
    console.warn("provider balance gate blocked", redact(gate));
    return await failJob(
      jobId,
      userId,
      gate,
      providerBalance.error_message || `solde=${providerBalance.balance_usd ?? "inconnu"} requis=${estimatedUsd}`
    );
  }
  let submitUrl = `${MUAPI_BASE}${endpoint}`;
  const token = await workerToken();
  if (token) {
    const base = env("REELORA_WEBHOOK_BASE_URL") || `${SUPABASE_URL()}/functions/v1/reelora-video-worker`;
    const u = new URL(submitUrl);
    u.searchParams.set("webhook", `${base}?mode=webhook&token=${encodeURIComponent(token)}`);
    submitUrl = u.toString();
  }
  let requestId = "";
  let cost = null;
  let submitRejected = false;
  try {
    const res = await fetch(submitUrl, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(submitBody),
      signal: AbortSignal.timeout(6e4)
    });
    const raw = await res.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
    }
    if (!res.ok) {
      submitRejected = res.status >= 400 && res.status < 500;
      const detail = redact(str(parsed.message, 300) || str(parsed.error, 300) || raw.slice(0, 300));
      throw new Error(`MUAPI_SUBMIT_ERROR: ${detail || `HTTP ${res.status}`}`);
    }
    requestId = muapiSubmitId(parsed);
    cost = muapiCost(parsed);
  } catch (e) {
    const detail = redact(e instanceof Error ? e.message : String(e));
    if (submitRejected) {
      await updateProviderSpend(jobId, "failed", { release: true, reasonCode: "provider_rejected" });
    } else {
      await updateProviderSpend(jobId, "unknown", { reasonCode: "provider_submission_outcome_unknown" });
    }
    return await failJob(jobId, userId, "MUAPI_SUBMIT_ERROR", detail);
  }
  if (!requestId) {
    await updateProviderSpend(jobId, "unknown", { reasonCode: "provider_request_id_missing" });
    return await failJob(jobId, userId, "MUAPI_NO_REQUEST_ID", "");
  }
  await updateProviderSpend(jobId, "submitted", {
    providerRequestId: requestId,
    actualCostUsd: muapiActualCostUsd(cost)
  });
  const merged = {
    ...payload,
    model_id: publicModelId,
    webhook_enabled: Boolean(token)
  };
  const updated = await rpcService("reelora_set_job_processing", {
    p_job_id: jobId,
    p_provider: "muapi",
    p_provider_job_id: requestId,
    p_request_payload: merged
  });
  if (!updated.ok) return fail("JOB_UPDATE_ERROR", redact(updated.error ?? "Mise \xE0 jour impossible."), 500);
  if (cost) await rpcService("reelora_record_video_poll", {
    p_job_id: jobId,
    p_provider_status: "queued",
    p_next_poll_seconds: 30,
    p_cost: cost
  });
  return json({
    job_id: jobId,
    status: "processing",
    provider_state: "queued",
    model_id: publicModelId,
    webhook_enabled: Boolean(token)
  });
}
async function actionStatus(jobId, userId) {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "T\xE2che de g\xE9n\xE9ration introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette t\xE2che ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const result = {
    job_id: jobId,
    status,
    provider_state: str(obj(job.result_payload).provider_status, 40) || null,
    error: status === "failed" ? str(job.error_message, 500) || null : null,
    progress: status === "succeeded" ? 100 : status === "processing" ? 55 : status === "reserved" ? 20 : 0
  };
  if (status === "succeeded") {
    const assets = await restService(
      `ugc_generated_assets?generation_job_id=eq.${encodeURIComponent(jobId)}&select=storage_path,file_size_bytes,mime_type&limit=1`
    );
    const path = str(assets[0]?.storage_path, 500);
    if (path) {
      result.storage_path = path;
      result.preview_url = await signStoragePath(path);
    }
  }
  return json(result);
}
async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "M\xE9thode non autoris\xE9e.", 405);
  const userJwt = req.headers.get("Authorization") ?? "";
  if (!userJwt.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  if (!SERVICE_KEY() || !SUPABASE_URL()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente c\xF4t\xE9 serveur.", 500);
  const userId = await authUserId(userJwt);
  if (!userId) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);
  let body;
  try {
    body = await req.json();
  } catch {
    return fail("INVALID_BODY", "Corps de requ\xEAte JSON invalide.", 400);
  }
  const action = str(body.action, 40);
  try {
    if (action === "catalog") return await actionCatalog();
    if (action === "admin-catalog") return await actionAdminCatalog(userJwt);
    if (action === "admin-provider-balance") {
      return await actionAdminProviderBalance(userJwt, bool(body.refresh, false));
    }
    if (action === "model-detail") return await actionModelDetail(body);
    if (action === "models") return await actionModels();
    if (action === "estimate") return await actionEstimate(body, userId);
    if (action === "quote" || action === "provider-quote") return await actionProviderQuote(body);
    const jobId = str(body.job_id, 80);
    if (!jobId) return fail("INVALID_INPUT", "job_id requis.", 400);
    if (action === "start") return await actionStart(jobId, userId);
    if (action === "status") return await actionStatus(jobId, userId);
    return fail("UNKNOWN_ACTION", "Action vid\xE9o inconnue.", 400);
  } catch (error) {
    console.error("reelora-video", redact(error instanceof Error ? error.message : String(error)));
    return fail("VIDEO_INTERNAL_ERROR", "Une erreur inattendue est survenue pendant la g\xE9n\xE9ration vid\xE9o.", 500);
  }
}
var runtime = globalThis;
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
export {
  assertPackLadder,
  calculateVideoCredits,
  handler,
  packPricePerCredit
};
