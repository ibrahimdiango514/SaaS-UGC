// VYORA — service de devis fournisseur (MyAPI / MuAPI), calculé côté serveur.
//
// Contrat : POST { model_id, params?, prompt?, image_url?, last_image_url? }
//   -> { model_id, model_available, model_status, model_reason, quote }
// Aucune génération, aucun crédit débité, aucune réservation : cet endpoint
// interroge uniquement le tarif réel du fournisseur en USD.
//
// Les clés (MUAPI_API_KEY, SUPABASE_SERVICE_ROLE_KEY) restent des secrets Edge.
// Fonction volontairement autonome (aucun import relatif) pour être déployable
// telle quelle par l'API de gestion Supabase.

type Json = Record<string, unknown>;

export interface QuoteResult {
  available: boolean;
  cost_usd: number | null;
  currency: "USD" | null;
  source: "provider_estimate" | "catalog_tariff" | "none";
  error_code: string | null;
  error_message: string | null;
  checked_at: string;
  catalog_synced_at: string | null;
  stale_catalog: boolean;
  pricing_basis: Json;
  billing_units: string[];
  estimate_endpoint_available: boolean;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const MUAPI_BASE = "https://api.muapi.ai";
const CATALOG_MAX_AGE_HOURS = 36;

function env(key: string): string {
  const g = globalThis as unknown as { Deno?: { env?: { get?: (k: string) => string } }; process?: { env?: Record<string, string | undefined> } };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}
const SUPABASE_URL = () => env("SUPABASE_URL");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = () => env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const MUAPI_KEY = () => env("MUAPI_API_KEY");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
function str(value: unknown, max = 4000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function rec(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function flag(value: unknown, fallback = false): boolean {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return fallback;
}
function redact(text: string): string {
  const key = MUAPI_KEY();
  return key ? text.split(key).join("[REDACTED]") : text;
}
function idValid(id: string): boolean {
  return /^[a-z0-9._-]{1,120}$/.test(id);
}
function estimatePath(raw: unknown, modelId: string): string | null {
  const candidate = str(raw, 240) || `/api/v1/models/${modelId}/estimate-cost`;
  if (!/^\/api\/v1\/models\/[A-Za-z0-9._-]{1,120}\/estimate-cost$/.test(candidate)) return null;
  return candidate;
}

const ERROR_MESSAGES: Record<string, string> = {
  MODEL_NOT_FOUND: "Ce modèle vidéo n’existe pas dans le catalogue VYORA.",
  MODEL_UNAVAILABLE: "Ce modèle n’est pas disponible pour votre compte.",
  PROVIDER_KEY_MISSING: "Le service de génération n’est pas configuré côté serveur.",
  ESTIMATE_ENDPOINT_MISSING: "Ce modèle n’expose pas d’endpoint de devis vérifié.",
  ESTIMATE_ENDPOINT_INVALID: "L’endpoint de devis du fournisseur est invalide.",
  PROMPT_REQUIRED: "Renseignez une instruction vidéo pour obtenir un devis exact.",
  PROVIDER_AUTH_FAILED: "Le fournisseur a refusé l’authentification serveur. Devis indisponible.",
  PROVIDER_RATE_LIMITED: "Le fournisseur limite temporairement les requêtes. Réessayez dans un instant.",
  PROVIDER_UNAVAILABLE: "Le fournisseur de génération est momentanément indisponible.",
  PROVIDER_TIMEOUT: "Le fournisseur n’a pas répondu à temps. Devis indisponible.",
  PROVIDER_BAD_RESPONSE: "Le fournisseur a renvoyé une réponse illisible.",
  PROVIDER_PRICE_MISSING: "Le fournisseur n’a pas renvoyé de tarif exploitable pour ces paramètres.",
  CURRENCY_UNSUPPORTED: "Le tarif renvoyé n’est pas exprimé en dollars américains (USD).",
  PRICE_NOT_POSITIVE: "Le tarif renvoyé n’est pas un montant facturable.",
  CATALOG_TARIFF_MISSING: "Aucun tarif vérifié n’est disponible pour ce modèle.",
  UNAUTHENTICATED: "Authentification requise.",
  SERVER_NOT_CONFIGURED: "Configuration Supabase absente côté serveur.",
};
function errorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? "Devis indisponible.";
}

function providerErrorCode(reply: { status: number; timedOut: boolean }): string {
  if (reply.timedOut) return "PROVIDER_TIMEOUT";
  if (reply.status === 401 || reply.status === 403) return "PROVIDER_AUTH_FAILED";
  if (reply.status === 429) return "PROVIDER_RATE_LIMITED";
  if (reply.status === 404) return "ESTIMATE_ENDPOINT_MISSING";
  if (reply.status === 0 || reply.status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_BAD_RESPONSE";
}

function providerCost(reply: Json): number | null {
  const root = rec(rec(reply).data ?? reply);
  const candidates = [
    root.cost, root.cost_usd, root.estimated_cost, root.estimate_cost, root.price, root.total_cost,
    root.amount, root.amount_usd, root.total, root.credits_cost_usd,
    rec(root.cost).amount, rec(root.cost).usd, rec(root.cost).value,
    rec(root.pricing).cost, rec(root.pricing).amount, rec(root.total).usd,
    rec(rec(root.data).cost).amount, rec(root.data).cost_usd, rec(root.data).estimated_cost,
  ];
  for (const candidate of candidates) {
    const value = num(candidate);
    if (value !== null) return value;
  }
  return null;
}
function providerCurrency(reply: Json): string {
  const root = rec(rec(reply).data ?? reply);
  return (str(root.currency ?? root.cost_currency ?? rec(root.cost).currency ?? rec(root.pricing).currency, 10) || "USD").toUpperCase();
}

const MEDIA_KEYS = new Set([
  "prompt", "image_url", "last_image", "first_frame", "last_image_url", "image", "video_url",
  "audio_url", "input_video", "images_list", "image_urls", "request_id", "draft_request_id",
]);
const BILLING_UNITS: Record<string, string> = {
  duration: "duration", duration_seconds: "duration", seconds: "duration",
  resolution: "resolution", quality: "resolution",
  quantity: "quantity", num_images: "quantity", n: "quantity", batch_size: "quantity",
  aspect_ratio: "aspect_ratio", generate_audio: "audio", audio: "audio",
  fps: "fps", high_bitrate: "bitrate", draft: "draft",
};
const BILLING_ORDER = ["duration", "resolution", "quantity", "audio", "aspect_ratio", "fps", "bitrate", "draft"];

/** Seuls les paramètres scalaires de tarification sont renvoyés (jamais le prompt ni les médias). */
export function pricingBasis(values: Json): Json {
  const basis: Json = {};
  for (const key of Object.keys(values).sort()) {
    if (MEDIA_KEYS.has(key) || key.startsWith("__")) continue;
    const value = values[key];
    if (typeof value === "string") {
      const clean = value.trim().slice(0, 120);
      if (clean) basis[key] = clean;
    } else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
      basis[key] = value;
    }
  }
  return basis;
}
export function billingUnits(basis: Json): string[] {
  const found = new Set<string>();
  for (const key of Object.keys(basis)) {
    const unit = BILLING_UNITS[key.toLowerCase()];
    if (unit) found.add(unit);
  }
  return BILLING_ORDER.filter((unit) => found.has(unit));
}

async function rest(path: string): Promise<Json[]> {
  const response = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data) ? data as Json[] : [];
}
async function authUserId(jwt: string): Promise<string | null> {
  const response = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: ANON_KEY(), Authorization: jwt },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  const data = await response.json();
  return str(rec(data).id, 80) || null;
}

type ModelRow = Json;
type ModelMeta = { modelId: string; publicId: string | null; dynamic: boolean; estimateEndpoint: string | null; active: boolean; enabled: boolean; comingSoon: boolean; syncedAt: string | null; costUsd: number | null; currency: string };

function modelMeta(row: ModelRow, modelId: string): ModelMeta {
  const catalog = rec(rec(row.param_schema).__catalog);
  return {
    modelId,
    publicId: str(row.public_id, 80) || null,
    dynamic: flag(catalog.dynamic_pricing, false),
    estimateEndpoint: estimatePath(catalog.estimate_endpoint, modelId),
    active: flag(row.active, false),
    enabled: flag(row.is_enabled, true),
    comingSoon: flag(row.is_coming_soon, false),
    syncedAt: str(row.synced_at, 60) || null,
    costUsd: num(row.cost_usd),
    currency: (str(row.cost_currency, 10) || "USD").toUpperCase(),
  };
}
function staleCatalog(syncedAt: string | null, now: Date): boolean {
  if (!syncedAt) return true;
  const parsed = Date.parse(syncedAt);
  return Number.isFinite(parsed) ? now.getTime() - parsed > CATALOG_MAX_AGE_HOURS * 3_600_000 : true;
}
function unavailable(code: string, now: Date, meta: ModelMeta | null, basis: Json, message?: string): QuoteResult {
  return {
    available: false,
    cost_usd: null,
    currency: null,
    source: "none",
    error_code: code,
    error_message: message ?? errorMessage(code),
    checked_at: now.toISOString(),
    catalog_synced_at: meta?.syncedAt ?? null,
    stale_catalog: meta ? staleCatalog(meta.syncedAt, now) : true,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(meta?.estimateEndpoint),
  };
}
function available(costUsd: number, source: "provider_estimate" | "catalog_tariff", now: Date, meta: ModelMeta | null, basis: Json): QuoteResult {
  return {
    available: true,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    currency: "USD",
    source,
    error_code: null,
    error_message: null,
    checked_at: now.toISOString(),
    catalog_synced_at: meta?.syncedAt ?? null,
    stale_catalog: meta ? staleCatalog(meta.syncedAt, now) : false,
    pricing_basis: basis,
    billing_units: billingUnits(basis),
    estimate_endpoint_available: Boolean(meta?.estimateEndpoint),
  };
}

/** Paramètres envoyés au fournisseur : valeurs fournies, complétées par les defaults du schéma. */
export function providerParams(row: ModelRow, body: Json): Json {
  const schema = rec(row.param_schema);
  const schemaKeys = Object.keys(schema).filter((key) => !key.startsWith("__"));
  const allowed = new Set<string>([...strArray(row.input_fields), ...schemaKeys]);
  const supplied = { ...rec(body.params), ...body };
  const out: Json = {};
  for (const key of allowed) {
    if (key.startsWith("__")) continue;
    const definition = rec(schema[key]);
    const raw = supplied[key] ?? rec(body.params)[key] ?? definition.default;
    if (raw === undefined || raw === null || raw === "") continue;
    const type = str(definition.type, 20).toLowerCase();
    if (type === "number") {
      const value = num(raw);
      if (value === null) continue;
      out[key] = Math.min(Math.max(value, num(definition.min) ?? value), num(definition.max) ?? value);
    } else if (type === "boolean") {
      out[key] = raw === true || raw === "true" || raw === 1;
    } else if (type === "select") {
      const options = Array.isArray(definition.options) ? definition.options : [];
      if (options.length && !options.some((option) => String(option) === String(raw))) continue;
      out[key] = raw as never;
    } else if (["string", "array", "object"].includes(type)) {
      out[key] = raw as never;
    } else if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
    }
  }
  const prompt = str(body.prompt, 4000);
  const imageUrl = str(body.image_url, 2000);
  const lastImage = str(body.last_image_url, 2000);
  if (prompt) out.prompt = prompt;
  if (imageUrl) out.image_url = imageUrl;
  if (lastImage) out.last_image = lastImage;
  return out;
}
function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function estimate(endpoint: string, payload: Json): Promise<{ ok: boolean; status: number; data: unknown; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${MUAPI_BASE}${endpoint}`, {
      method: "POST",
      headers: { "x-api-key": MUAPI_KEY(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: unknown = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    return { ok: response.ok, status: response.status, data, timedOut: false };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, status: 0, data: null, timedOut: name === "AbortError" || name === "TimeoutError" };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildQuote(row: ModelRow | null, requestedId: string, body: Json, now = new Date()) {
  if (!row) {
    return {
      model_id: null, model_available: false, model_status: "disabled",
      model_reason: errorMessage("MODEL_NOT_FOUND"),
      quote: unavailable("MODEL_NOT_FOUND", now, null, {}),
    };
  }
  const modelId = str(row.model_id, 120);
  const meta = modelMeta(row, modelId);
  const params = providerParams(row, body);
  const basis = pricingBasis(params);
  const required = strArray(row.required_fields).filter((field) => !["prompt", "image_url"].includes(field.toLowerCase()));
  const supported = meta.active && meta.enabled && !meta.comingSoon && required.length === 0;
  const reason = required.length
    ? `Ce modèle nécessite un réglage qui n’est pas encore pris en charge : ${required.join(", ")}.`
    : meta.comingSoon ? "Annoncé par le fournisseur, pas encore lancé."
      : !meta.enabled ? "Désactivé dans le catalogue fournisseur."
        : !meta.active ? "Désactivé dans le catalogue VYORA."
          : "Disponible dans VYORA.";

  const pack = (quote: QuoteResult) => ({
    model_id: meta.publicId ?? str(row.public_id, 80) ?? requestedId,
    model_available: supported,
    model_status: supported ? "active" : !meta.active ? "disabled" : meta.comingSoon ? "coming_soon" : "unsupported",
    model_reason: reason,
    quote,
  });

  if (!supported) return pack(unavailable("MODEL_UNAVAILABLE", now, meta, basis, reason));

  if (meta.dynamic) {
    if (!MUAPI_KEY()) return pack(unavailable("PROVIDER_KEY_MISSING", now, meta, basis));
    if (!meta.estimateEndpoint) return pack(unavailable("ESTIMATE_ENDPOINT_MISSING", now, meta, basis));
    if (strArray(row.required_fields).some((field) => field.toLowerCase() === "prompt") && !str(body.prompt, 4000)) {
      return pack(unavailable("PROMPT_REQUIRED", now, meta, basis));
    }
    const reply = await estimate(meta.estimateEndpoint, params);
    if (!reply.ok) return pack(unavailable(providerErrorCode(reply), now, meta, basis));
    const currency = providerCurrency(rec(reply.data));
    if (currency !== "USD") {
      return pack(unavailable("CURRENCY_UNSUPPORTED", now, meta, basis,
        `Le fournisseur a renvoyé un tarif en ${currency}. Seuls les tarifs USD vérifiables sont acceptés.`));
    }
    const cost = providerCost(rec(reply.data));
    if (cost === null) return pack(unavailable("PROVIDER_PRICE_MISSING", now, meta, basis));
    if (cost <= 0) return pack(unavailable("PRICE_NOT_POSITIVE", now, meta, basis));
    return pack(available(cost, "provider_estimate", now, meta, basis));
  }

  if (meta.currency !== "USD") {
    return pack(unavailable("CURRENCY_UNSUPPORTED", now, meta, basis,
      `Le tarif catalogue de ce modèle est exprimé en ${meta.currency}. Devis USD indisponible.`));
  }
  if (meta.costUsd === null) return pack(unavailable("CATALOG_TARIFF_MISSING", now, meta, basis));
  if (meta.costUsd <= 0) return pack(unavailable("PRICE_NOT_POSITIVE", now, meta, basis));
  return pack(available(meta.costUsd, "catalog_tariff", now, meta, basis));
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return fail("UNAUTHENTICATED", errorMessage("UNAUTHENTICATED"), 401);
  if (!SUPABASE_URL() || !SERVICE_KEY() || !ANON_KEY()) {
    return fail("SERVER_NOT_CONFIGURED", errorMessage("SERVER_NOT_CONFIGURED"), 500);
  }
  const userId = await authUserId(authorization);
  if (!userId) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);

  let body: Json;
  try { body = rec(await req.json()); } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const requestedId = str(body.model_id, 120);
  if (!requestedId || !idValid(requestedId)) return fail("INVALID_INPUT", "Identifiant de modèle invalide.", 400);

  try {
    const encoded = encodeURIComponent(requestedId);
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId);
    // public_id et model_id n'ont pas le même type : une seule colonne est filtrée
    // (un `or` sur les deux ferait échouer la conversion uuid côté PostgREST).
    const rows = await rest(`reelora_video_models?${isUuid ? 'public_id' : 'model_id'}=eq.${encoded}&select=*&limit=1`);
    return json(await buildQuote(rows[0] ?? null, requestedId, body));
  } catch (error) {
    console.error("video-quote", redact(error instanceof Error ? error.message : String(error)));
    return fail("QUOTE_INTERNAL_ERROR", "Le devis fournisseur est momentanément indisponible.", 500);
  }
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
