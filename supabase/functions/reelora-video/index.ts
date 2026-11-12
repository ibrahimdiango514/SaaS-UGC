// VYORA video gateway — MuAPI is the PRIMARY (and only) video provider.
// Groq remains the text provider (reelora-ai). HeyGen / fal.ai are NOT used here.
//
// Official MuAPI contract (verified):
//   POST https://api.muapi.ai/api/v1/{model}   x-api-key: KEY   -> { request_id, status, cost }
//   GET  https://api.muapi.ai/api/v1/predictions/{request_id}/result
//        -> { id, status: queued|pending|processing|completed|failed|cancelled, outputs[], error, cost }
//   GET  https://api.muapi.ai/api/v1/models    -> { models: [...] }
//   GET  https://api.muapi.ai/api/v1/models/{name} -> input_schema / output_schema
//   POST https://api.muapi.ai/api/v1/models/{name}/estimate-cost -> exact USD quote, no media, no debit
//   GET  https://api.muapi.ai/api/v1/account/balance , /api/v1/keys -> read-only key probe
//   ?webhook=<https url> on submit            -> POST callback on terminal state
// Docs: https://muapi.ai/docs/api-reference , https://muapi.ai/docs/pricing
//
// Actions (JWT required, gateway verify_jwt = true):
//   { action: "catalog" }                       -> full public + authenticated video catalogue and diagnostics
//   { action: "model-detail", model_id }        -> real input_schema for one model
//   { action: "models" }                        -> live/cached verified video models (legacy Studio)
//   { action: "estimate", service_key, model_id, params?, prompt?, image_url? }
//                                               -> backend credit + exact provider cost estimate
//   { action: "start", job_id }                 -> idempotent MuAPI submission
//   { action: "status", job_id }                -> DB state + signed preview URL
//
// Tracking does NOT depend on an open browser tab: MuAPI webhooks + a pg_cron
// worker (reelora-video-worker) reconcile jobs server-side.
//
// MUAPI_API_KEY is read from Edge secrets only. It is never returned, logged,
// placed in a VITE_* variable or sent to the browser.

import {
  buildProviderQuote,
  buildPricingBasis,
  unavailableQuote,
  type ProviderQuote,
  type ProviderReplyLike,
  type QuoteModelMeta,
} from "../_shared/video-quote.ts";

type Json = Record<string, unknown>;
const MUAPI_BASE = "https://api.muapi.ai";
const BUCKET = "ugc-assets";
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// Works both in Deno (Supabase Edge) and Node (Vitest with injected process.env).
function env(key: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}
const SUPABASE_URL = () => env("SUPABASE_URL");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = () => env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
const MUAPI_KEY = () => env("MUAPI_API_KEY");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
function str(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function redact(text: string): string {
  const k = MUAPI_KEY();
  return k ? text.split(k).join("[REDACTED]") : text;
}
function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
}
function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown, fallback = false): boolean {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "True" || v === "TRUE") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "False" || v === "FALSE") return false;
  return fallback;
}
function svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, ...extra };
}
async function rpcService(name: string, args: Json): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST", headers: svcHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(args), signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "message" in data
      ? String((data as Json).message) : text;
    return { ok: false, data: null, error: redact(msg) };
  }
  return { ok: true, data };
}
async function restService<T = Json>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    headers: svcHeaders(), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}
async function authUserId(jwt: string): Promise<string | null> {
  // GoTrue validates the token a second time and gives us an authoritative uid.
  const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
    headers: { apikey: ANON_KEY(), Authorization: jwt }, signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const d = await res.json() as Json;
  return str(d.id, 80) || null;
}
async function workerToken(): Promise<string> {
  const r = await rpcService("reelora_worker_token", {});
  return r.ok ? str(r.data, 200) : "";
}
async function loadJob(id: string): Promise<Json | null> {
  const rows = await restService<Json>(`ugc_generation_jobs?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows[0] ?? null;
}
async function loadModel(id: string): Promise<Json | null> {
  const encoded = encodeURIComponent(id);
  const rows = await restService<Json>(
    `reelora_video_models?or=(model_id.eq.${encoded},public_id.eq.${encoded})&select=*&limit=1`,
  );
  return rows[0] ?? null;
}

function customerModel(model: Json, index: number, status?: Status, reason?: string): Json {
  const category = str(model.category, 60);
  const schema = paramSchemaFromRow(model);
  const safeSchema = Object.fromEntries(Object.entries(schema).filter(([key]) => !key.startsWith("__")));
  const meta = metaFromRow(model);
  const modelStatus = status ?? statusFor(model).status;
  return {
    model_id: str(model.public_id, 80),
    display_name: `VYORA ${category === "Image to Video" ? "Image" : "Video"} ${String(index + 1).padStart(2, "0")}`,
    description: category === "Image to Video"
      ? "Animez un visuel de référence avec des paramètres de création vérifiés."
      : "Créez une vidéo à partir d'une instruction et de paramètres vérifiés.",
    category,
    input_fields: asArray(model.input_fields),
    required_fields: asArray(model.required_fields),
    param_schema: safeSchema,
    dynamic_pricing: bool(meta.dynamic_pricing, false),
    is_enabled: bool(model.is_enabled, true),
    is_coming_soon: bool(model.is_coming_soon, false),
    sort_order: finite(model.sort_order) ?? index,
    reelora_status: modelStatus,
    reelora_reason: reason ?? (modelStatus === "active"
      ? "Disponible dans VYORA."
      : modelStatus === "coming_soon" ? "Bientôt disponible." : "Indisponible momentanément."),
  };
}

function pricingParameters(values: Json): Json {
  return Object.fromEntries(Object.entries(values)
    .filter(([key]) => !["prompt", "image_url", "last_image", "first_frame", "last_image_url"].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface VideoPricingConfig {
  enabled: boolean;
  usd_to_xof: number | null;
  credit_value_xof: number | null;
  markup_percent: number | null;
  additional_cost_usd: number | null;
  updated_at: string;
}

async function loadVideoPricingConfig(): Promise<VideoPricingConfig | null> {
  const url = `${SUPABASE_URL()}/rest/v1/ugc_app_settings?setting_key=eq.video_pricing_config&select=setting_value,updated_at&limit=1`;
  const response = await fetch(url, { headers: svcHeaders(), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`VIDEO_PRICING_READ_ERROR: HTTP ${response.status}`);
  const rows = await response.json() as Json[];
  const row = rows[0];
  if (!row) return null;
  const config = obj(row.setting_value);
  return {
    enabled: bool(config.enabled),
    usd_to_xof: finite(config.usd_to_xof),
    credit_value_xof: finite(config.credit_value_xof),
    markup_percent: finite(config.markup_percent),
    additional_cost_usd: finite(config.additional_cost_usd),
    updated_at: str(row.updated_at, 80),
  };
}

/**
 * Calcule le nombre de crédits Studio d'une opération.
 *
 * SEULE AUTORITÉ : ce calcul. Le client reçoit le résultat, il ne le propose
 * jamais. Si un seul paramètre est inconnu (coût fournisseur, change, valeur du
 * crédit, marge), la fonction renvoie `null` et l'appelant DOIT refuser
 * l'opération commerciale : aucun coût n'est deviné.
 *
 * Formule : ((coût fournisseur + traitement) × change × (1 + marge)) / valeur du crédit
 * puis arrondi supérieur, minimum 1 crédit.
 *
 * `secondaryCostsUsd` couvre les traitements complémentaires réellement
 * facturés par le fournisseur ou par le pipeline (rendu, remux, audio).
 */
export function calculateVideoCredits(
  providerCostUsd: number,
  config: Pick<VideoPricingConfig, "usd_to_xof" | "credit_value_xof" | "markup_percent" | "additional_cost_usd">,
  secondaryCostsUsd: number[] = [],
): number | null {
  const { usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd } = config;
  const extras = secondaryCostsUsd.map((value) => Number(value));
  if (![providerCostUsd, usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd].every(Number.isFinite)
    || providerCostUsd <= 0 || (usd_to_xof ?? 0) <= 0 || (credit_value_xof ?? 0) <= 0
    || (markup_percent ?? -1) < 0 || (additional_cost_usd ?? -1) < 0) return null;
  if (extras.some((value) => !Number.isFinite(value) || value < 0)) return null;

  const extrasUsd = extras.reduce((total, value) => total + value, 0);
  const totalXof = (providerCostUsd + additional_cost_usd! + extrasUsd)
    * usd_to_xof! * (1 + markup_percent! / 100);
  const credits = Math.ceil(totalXof / credit_value_xof!);
  return Number.isSafeInteger(credits) && credits > 0 ? credits : null;
}

/**
 * Grille d'achat Studio : prix par crédit dégressif selon le pack.
 * Les packs et leurs montants viennent de `ugc_app_settings.studio_pricing_config`
 * (administrable), jamais d'une constante côté navigateur.
 */
export interface StudioPack {
  pack_key: string;
  label: string;
  price_xof: number;
  credits: number;
  recommended?: boolean;
}

export function packPricePerCredit(pack: Pick<StudioPack, "price_xof" | "credits">): number | null {
  if (!Number.isFinite(pack.price_xof) || !Number.isFinite(pack.credits)
    || pack.price_xof <= 0 || pack.credits <= 0) return null;
  return Math.round((pack.price_xof / pack.credits) * 10000) / 10000;
}

/** Vérifie qu'un pack est cohérent : plus de crédits ⇒ prix par crédit plus bas. */
export function assertPackLadder(packs: StudioPack[]): string | null {
  const sorted = packs
    .map((pack) => ({ pack, unit: packPricePerCredit(pack) }))
    .sort((a, b) => (a.pack.credits - b.pack.credits));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1].unit;
    const current = sorted[index].unit;
    if (previous === null || current === null) return "invalid_pack_values";
    if (current >= previous) return "pack_ladder_not_degressive";
  }
  return null;
}
async function loadAvatar(id: string): Promise<Json | null> {
  const rows = await restService<Json>(`reelora_avatars?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows[0] ?? null;
}
async function loadScript(projectId: string): Promise<string> {
  const rows = await restService<Json>(
    `ugc_project_scripts?project_id=eq.${encodeURIComponent(projectId)}&select=script_text&order=version.desc&limit=1`,
  );
  return str(rows[0]?.script_text, 4000);
}
/**
 * A reference image may be uploaded to the private VYORA bucket. Only paths
 * inside the job's own workspace prefix are signed and forwarded to MuAPI.
 */
function workspaceImagePath(raw: unknown, workspaceId: string): string {
  const path = str(raw, 500).replace(/^\/+/, '');
  const ws = str(workspaceId, 80);
  if (!ws || !path.startsWith(`${ws}/`) || path.includes('..') || path.includes('\\')) return '';
  return path;
}
async function signStoragePath(path: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL()}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST", headers: svcHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: 3600 }), signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  const d = await res.json() as Json;
  const signed = str(d.signedURL ?? d.signedUrl, 1000);
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${SUPABASE_URL()}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
}

/* --------------------------- MuAPI catalogue ---------------------------- */

interface ParamDef {
  type: "select" | "number" | "boolean" | "string" | "array" | "object";
  label?: string;
  description?: string;
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  required?: boolean;
}
interface MuapiReply { status: number; data: unknown; error: string; ok: boolean; timedOut?: boolean }
interface AccountProbe {
  key_configured: boolean;
  key_valid: boolean;
  catalog_status: number | null;
  balance_status: number | null;
  keys_status: number | null;
  key_is_test: boolean | null;
  error: string;
  auth: MuapiReply;
}
type Access = "account" | "public_only" | "unverified";
type Status = "active" | "disabled" | "coming_soon" | "unsupported" | "unverified";

/** Required inputs VYORA can actually provide today. No audio/TTS/lipsync engine is connected. */
const SUPPORTED_REQUIRED_FIELDS = new Set(["prompt", "image_url"]);
/** Media/structured fields are never exposed as tunable scalar parameters. */
const SOURCE_FIELDS = new Set([
  "prompt", "image_url", "last_image", "audio_url", "video_url", "input_video",
  "images_list", "image_urls", "mask_image_url", "mask_video_url", "request_id",
  "audios_list", "videos_list", "audio_files", "video_files", "draft_request_id",
  "omni_reference_task_type", "draft", "end_image_url", "first_frame_url",
  "last_frame_url", "reference_audios", "reference_videos", "reference_images",
  "video_urls", "audio_ids", "character_ids", "loras", "lora_list", "elements",
  "origin_task_id", "end_time", "start_time", "trim_start", "trim_end",
  "templ_start_seconds", "templ_end_seconds", "reference_video_url",
  "first_frame_image", "last_frame_image", "image", "video", "audio",
]);
function isSourceField(key: string): boolean {
  const k = key.toLowerCase();
  if (SOURCE_FIELDS.has(k)) return true;
  return k.endsWith("_url") || k.endsWith("_urls") || k.endsWith("_list")
    || k.endsWith("_files") || k.endsWith("_file") || k.endsWith("_ids")
    || k.endsWith("_images") || k.endsWith("_videos") || k.endsWith("_audios")
    || k.endsWith("_request_id") || k.endsWith("_task_id") || k.endsWith("_frame_url")
    || k.startsWith("reference_") || k.startsWith("mask_") || k.startsWith("templ_")
    || k === "draft" || k === "elements" || k === "loras" || k === "lora_list";
}
function validModelId(id: string): boolean { return /^[a-z0-9._-]{1,120}$/.test(id); }
function validEndpoint(path: string): boolean { return /^\/api\/v1\/[A-Za-z0-9._-]{1,160}$/.test(path); }
function validEstimateEndpoint(path: string): boolean {
  return /^\/api\/v1\/models\/[A-Za-z0-9._-]{1,120}\/estimate-cost$/.test(path);
}
function normalizeEndpoint(rawEndpoint: unknown, rawEndpointUrl: unknown, name: string): string {
  const a = str(rawEndpoint, 220);
  if (validEndpoint(a)) return a;
  const b = str(rawEndpointUrl, 220);
  if (validEndpoint(b)) return b;
  if (validModelId(b)) return `/api/v1/${b}`;
  return `/api/v1/${name}`;
}
function normalizeEstimateEndpoint(raw: unknown, name: string): string | null {
  const p = str(raw, 240);
  if (validEstimateEndpoint(p)) return p;
  if (validModelId(name)) return `/api/v1/models/${name}/estimate-cost`;
  return null;
}
function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean) : [];
}
function prettyName(name: string): string {
  return name.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 120);
}
function scalar(v: unknown): string | number | boolean | undefined {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}
function paramSchemaFromClient(raw: unknown, fields: string[]): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  for (const [key, value] of Object.entries(obj(raw))) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const d = obj(value);
    const type = str(d.type, 20).toLowerCase();
    if (!["select", "number", "boolean", "string", "array", "object"].includes(type)) continue;
    const def: ParamDef = { type: type as ParamDef["type"] };
    if (Array.isArray(d.options)) def.options = d.options.map(scalar).filter((x): x is string | number => x !== undefined);
    if (finite(d.min) !== null) def.min = Number(d.min);
    if (finite(d.max) !== null) def.max = Number(d.max);
    if (finite(d.step) !== null) def.step = Number(d.step);
    const defDefault = scalar(d.default);
    if (defDefault !== undefined) def.default = defDefault;
    if (str(d.label, 100)) def.label = str(d.label, 100);
    if (str(d.description, 300)) def.description = str(d.description, 300);
    if (d.required === true) def.required = true;
    out[key] = def;
  }
  return out;
}
/** Convert MuAPI's JSON-Schema-like input_schema into VYORA's param_schema. */
function schemaFromInputSchema(raw: unknown, fallbackFields: string[]): Record<string, ParamDef> {
  void fallbackFields; // Kept for call-site clarity; JSON Schema properties are authoritative.
  const root = obj(raw);
  const schemas = obj(root.schemas ?? root);
  const input = obj(schemas.input_data ?? schemas.input ?? root);
  const props = obj(input.properties ?? schemas.properties ?? root.properties);
  const required = asArray(input.required ?? root.required);
  const schema: Record<string, ParamDef> = {};
  // Keep every declared property (including arrays/objects): the frontend
  // filters them by input_fields and never invents a control for them.
  for (const [key, value] of Object.entries(props)) {
    const d = obj(value);
    const rawType = str(d.type, 30).toLowerCase();
    const enumValues = Array.isArray(d.enum) ? d.enum : null;
    let type: ParamDef["type"] = "object";
    if (enumValues) type = "select";
    else if (["int", "integer", "number", "float", "double"].includes(rawType)) type = "number";
    else if (rawType === "boolean") type = "boolean";
    else if (rawType === "string") type = "string";
    else if (rawType === "array") type = "array";
    else if (rawType === "object") type = "object";
    const def: ParamDef = { type };
    const title = str(d.title ?? d.name, 100);
    const description = str(d.description, 300);
    if (title) def.label = title;
    if (description) def.description = description;
    if (enumValues) def.options = enumValues.map(scalar).filter((x): x is string | number => x !== undefined);
    const min = finite(d.minValue ?? d.minimum ?? d.min);
    const max = finite(d.maxValue ?? d.maximum ?? d.max);
    const step = finite(d.step);
    if (min !== null) def.min = min;
    if (max !== null) def.max = max;
    if (step !== null) def.step = step;
    const defDefault = scalar(d.default);
    if (defDefault !== undefined) def.default = defDefault;
    if (required.includes(key)) def.required = true;
    schema[key] = def;
  }
  return schema;
}
/**
 * The 20261109125503 migration seeded a generic {"type":"string"} placeholder
 * for every input field. Those are NOT verified capabilities: drop them until
 * GET /models/{name} returns the real input_schema. Curated schemas (select,
 * number, boolean, defaults) are preserved.
 */
function paramSchemaFromRow(row: Json): Record<string, ParamDef> {
  const raw = obj(row.param_schema);
  const out: Record<string, ParamDef> = {};
  let curated = false;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__catalog") continue;
    const d = obj(value);
    const type = str(d.type, 20).toLowerCase();
    if (!["select", "number", "boolean", "string", "array", "object"].includes(type)) continue;
    const def = paramSchemaFromClient({ [key]: d }, [key])[key];
    if (!def) continue;
    out[key] = def;
    if (type !== "string" || def.options?.length || def.default !== undefined || def.min !== undefined || def.max !== undefined) curated = true;
  }
  return curated || !Object.keys(obj(raw.__catalog)).length ? out : {};
}
function metaFromRow(row: Json): Json { return obj(obj(row.param_schema).__catalog); }

/**
 * Métadonnées de devis exposées au module de tarification pur. Aucun secret,
 * aucun coût fournisseur brut n'est écrit en base ici : le tarif est toujours
 * relu et vérifié côté serveur au moment du devis.
 */
function quoteMetaFromRow(row: Json, modelId: string): QuoteModelMeta {
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
    estimateEndpoint: normalizeEstimateEndpoint(meta.estimate_endpoint, modelId),
    active: bool(row.active, false),
    enabled: bool(row.is_enabled, true),
    comingSoon: bool(row.is_coming_soon, false),
    syncedAt: str(row.synced_at, 60) || null,
    requiredFields,
    supportedFields: inputFields.length ? inputFields : Object.keys(paramSchemaFromRow(row)),
  };
}

function mergeSchema(a: Record<string, ParamDef>, b: Record<string, ParamDef>): Record<string, ParamDef> {
  return Object.keys(b).length ? { ...a, ...b } : a;
}
function isVideoEntry(entry: Json): boolean {
  const category = str(entry.category, 100).toLowerCase();
  const group = str(entry.group_of, 60).toLowerCase();
  return category.includes("video")
    || ["video", "avatar", "video-edit", "video-tools", "lipsync"].includes(group)
    || (group === "ai-effects" && category.includes("video"));
}
function mapLiveEntry(entry: Json, access: Access): Json {
  const name = str(entry.name ?? entry.model_id, 120);
  const inputFields = asArray(entry.input_fields);
  const schema = schemaFromInputSchema(entry.input_schema, inputFields);
  const fields = inputFields.length ? inputFields : Object.keys(schema);
  const requiredFields = asArray(entry.required_fields ?? obj(entry.input_schema).required);
  const endpoint = normalizeEndpoint(entry.endpoint, entry.endpoint_url, name);
  const estimate = normalizeEstimateEndpoint(entry.estimate_endpoint, name);
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
    account_access: access,
  };
}
function mapDbRow(row: Json, access: Access): Json {
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
    estimate_endpoint: normalizeEstimateEndpoint(meta.estimate_endpoint, id),
    source: str(meta.source, 40) || "database",
    account_access: access,
  };
}
function statusFor(model: Json): { status: Status; reason: string } {
  if (!bool(model.active, true)) return { status: "disabled", reason: "Désactivé dans le catalogue VYORA." };
  if (!bool(model.is_enabled, true)) return { status: "disabled", reason: "Désactivé dans le catalogue MuAPI." };
  if (bool(model.is_coming_soon, false)) return { status: "coming_soon", reason: "Annoncé par MuAPI, pas encore lancé." };
  const unsupported = asArray(model.required_fields).filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) return { status: "unsupported", reason: `Entrée non connectée dans VYORA : ${unsupported.join(", ")}.` };
  if (model.account_access === "unverified") return { status: "unverified", reason: "Clé / compte MuAPI non validée côté serveur." };
  if (model.account_access === "public_only") return { status: "unverified", reason: "Modèle public MuAPI absent du catalogue retourné avec la clé." };
  return { status: "active", reason: "Modèle actif et sélectionnable." };
}
async function muapiFetch(path: string, init: { method?: string; useKey?: boolean; body?: Json; timeout?: number } = {}): Promise<MuapiReply> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.useKey && MUAPI_KEY()) headers["x-api-key"] = MUAPI_KEY();
  if (init.body) headers["Content-Type"] = "application/json";
  try {
    const res = await fetch(`${MUAPI_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeout ?? 18000),
    });
    const raw = await res.text();
    let data: unknown = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    const d = obj(obj(data).data ?? data);
    const error = res.ok ? "" : redact(str(d.message ?? d.error ?? d.detail, 300) || raw.slice(0, 300) || `HTTP ${res.status}`);
    return { status: res.status, data, error, ok: res.ok };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      status: 0, data: null,
      error: redact(e instanceof Error ? e.message : String(e)),
      ok: false, timedOut,
    };
  }
}
function hasBooleanFlag(value: unknown, names: string[], depth = 0): boolean | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = hasBooleanFlag(item, names, depth + 1); if (found !== null) return found; }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value as Json)) {
    if (names.includes(k.toLowerCase()) && typeof v === "boolean") return v;
    const found = hasBooleanFlag(v, names, depth + 1);
    if (found !== null) return found;
  }
  return null;
}
async function probeAccount(): Promise<AccountProbe> {
  const key = MUAPI_KEY();
  if (!key) {
    const auth: MuapiReply = { status: null as unknown as number, data: null, error: "Secret MUAPI_API_KEY absent côté serveur.", ok: false };
    return { key_configured: false, key_valid: false, catalog_status: null, balance_status: null,
      keys_status: null, key_is_test: null, error: auth.error, auth };
  }
  const [auth, balance, keys] = await Promise.all([
    muapiFetch("/api/v1/models", { useKey: true, timeout: 20000 }),
    muapiFetch("/api/v1/account/balance", { useKey: true, timeout: 12000 }),
    muapiFetch("/api/v1/keys", { useKey: true, timeout: 12000 }),
  ]);
  const key_valid = auth.ok || balance.ok || keys.ok;
  const key_is_test = keys.ok ? hasBooleanFlag(keys.data, ["is_test", "test", "is_sandbox", "sandbox"]) : null;
  const errors = [auth, balance, keys].filter((r) => !r.ok).map((r) => r.error).filter(Boolean);
  return {
    key_configured: true, key_valid,
    catalog_status: auth.status, balance_status: balance.status, keys_status: keys.status,
    key_is_test,
    error: key_valid ? (auth.ok ? "" : "Catalogue authentifié indisponible : " + auth.error) : redact(errors.join(" · ") || "Clé MuAPI refusée."),
    auth,
  };
}
function entriesOf(reply: MuapiReply): Json[] {
  const data = obj(reply.data);
  return Array.isArray(data.models) ? (data.models as unknown[]).filter((x): x is Json => !!x && typeof x === "object") : [];
}
function totalOf(reply: MuapiReply, entries: Json[]): number | null {
  const data = obj(reply.data);
  const n = finite(data.total);
  return n !== null ? n : (reply.ok ? entries.length : null);
}

const schemaCache = new Map<string, { schema: Record<string, ParamDef>; fields: string[]; required: string[]; at: number }>();
async function effectiveSchema(row: Json, modelId: string): Promise<{ schema: Record<string, ParamDef>; fields: string[]; required: string[] }> {
  const local = paramSchemaFromRow(row);
  const fallback = { schema: local, fields: asArray(row.input_fields), required: asArray(row.required_fields) };
  if (Object.keys(local).length) return fallback;
  const cached = schemaCache.get(modelId);
  if (cached && Date.now() - cached.at < 300000) return { schema: cached.schema, fields: cached.fields, required: cached.required };
  const key = MUAPI_KEY();
  let reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: Boolean(key), timeout: 12000 });
  if (!reply.ok && key) reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: false, timeout: 12000 });
  if (!reply.ok) return fallback;
  const d = obj(obj(reply.data).data ?? reply.data);
  const fields = asArray(d.input_fields);
  const schema = schemaFromInputSchema(d.input_schema, fields);
  const required = asArray(d.required_fields);
  const value = { schema, fields, required, at: Date.now() };
  schemaCache.set(modelId, value);
  return { schema, fields, required };
}
function buildQuoteBody(body: Json, schema: Record<string, ParamDef>, fields: string[], required: string[]): Json {
  const out: Json = {};
  const prompt = str(body.prompt, 4000);
  const imageUrl = str(body.image_url, 2000);
  const lastImageUrl = str(body.last_image_url, 2000);
  if ((fields.includes("prompt") || required.includes("prompt")) && prompt) out.prompt = prompt;
  if ((fields.includes("image_url") || required.includes("image_url")) && imageUrl) out.image_url = imageUrl;
  if ((fields.includes("last_image") || required.includes("last_image")) && lastImageUrl) out.last_image = lastImageUrl;
  const params = obj(body.params);
  for (const [key, def] of Object.entries(schema)) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const raw = params[key] ?? body[key] ?? def.default;
    const value = scalar(raw);
    if (!def || value === undefined) continue;
    if (def.type === "select" && Array.isArray(def.options) && !def.options.some((o) => String(o) === String(value))) continue;
    if (def.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.min(Math.max(n, def.min ?? 1), def.max ?? 300);
    } else if (def.type === "boolean") out[key] = value === true || value === "true" || value === 1;
    else if (def.type === "string" || def.type === "select") out[key] = value;
    // Arrays / objects are never invented or forwarded as scalar settings.
  }
  return out;
}
/* -------------------------------- MuAPI --------------------------------- */

function buildMuapiBody(model: Json, payload: Json, prompt: string, imageUrl: string, lastImageUrl = ""): Json {
  const fields = asArray(model.input_fields);
  const required = asArray(model.required_fields);
  const body: Json = {};
  if (fields.includes("prompt") || required.includes("prompt")) body.prompt = prompt;
  if (fields.includes("image_url")) {
    if (required.includes("image_url") && !imageUrl) throw new Error("IMAGE_MISSING");
    if (imageUrl) body.image_url = imageUrl;
  }
  // `last_image` is an optional, model-specific reference frame. It is sent
  // ONLY when the verified catalog explicitly declares that input field.
  if (fields.includes("last_image")) {
    if (required.includes("last_image") && !lastImageUrl) throw new Error("LAST_IMAGE_MISSING");
    if (lastImageUrl) body.last_image = lastImageUrl;
  }
  const schema = paramSchemaFromRow(model);
  const params = obj(payload.params);
  for (const [key, def] of Object.entries(schema)) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue; // never send an unsupported parameter
    const raw = params[key] ?? payload[key] ?? def.default;
    const value = scalar(raw);
    if (value === undefined || value === "") continue;
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
    // array / object: no connected VYORA control, never invented or forwarded.
  }
  return body;
}
function buildPrompt(payload: Json, script: string): string {
  const visual = str(payload.visual_prompt, 1500);
  const scenes = Array.isArray(payload.scenes) ? (payload.scenes as Json[]).slice(0, 8) : [];
  const sceneText = scenes.map((s, i) =>
    `Plan ${i + 1} (${str(s.scene_type, 30) || "ugc"}, ${Number(s.duration_seconds) || 3}s) : ${str(s.visual_prompt, 400)}`,
  ).filter((x) => x.length > 20).join(" ");
  const ctx = script ? ` Contexte du message UGC (voix off, ne pas écrire à l'écran) : ${script.slice(0, 500)}` : "";
  const base = [visual, sceneText].filter(Boolean).join(" ");
  return (base || "Vidéo UGC verticale authentique filmée au smartphone, lumière naturelle, personne présentant le produit.").concat(ctx).slice(0, 4000);
}
function muapiSubmitId(raw: Json): string {
  const d = obj(raw.data ?? raw);
  return str(d.request_id, 300) || str(d.id, 300);
}
function muapiCost(raw: Json): Json | null {
  const d = obj(raw.data ?? raw);
  return d.cost && typeof d.cost === "object" ? obj(d.cost) : null;
}
function muapiActualCostUsd(raw: Json | null): number | null {
  if (!raw) return null;
  const currency = str(raw.currency ?? raw.cost_currency, 10).toUpperCase();
  const amount = raw.amount_usd ?? raw.cost_usd ?? (currency === "USD" ? raw.amount : null);
  const value = finite(amount);
  return value !== null && value >= 0 ? value : null;
}

async function updateProviderSpend(
  jobId: string,
  status: "submitted" | "unknown" | "succeeded" | "failed" | "cancelled",
  options: { providerRequestId?: string; actualCostUsd?: number | null; release?: boolean; reasonCode?: string } = {},
): Promise<boolean> {
  const result = await rpcService("reelora_update_provider_spend", {
    p_job_id: jobId,
    p_status: status,
    p_provider_request_id: options.providerRequestId ?? null,
    p_actual_cost_usd: options.actualCostUsd ?? null,
    p_release: options.release ?? false,
    p_reason_code: options.reasonCode ?? null,
  });
  if (!result.ok || result.data !== true) {
    console.error("provider spend update failed", redact(result.error ?? "provider_spend_update_rejected"));
    return false;
  }
  return true;
}

function friendly(code: string, _detail: string): string {
  const map: Record<string, string> = {
    MUAPI_NOT_CONFIGURED: "Le service vidéo n’est pas disponible pour le moment. Les crédits réservés ont été restitués.",
    MUAPI_SUBMIT_ERROR: "La demande de génération n’a pas abouti. Les crédits réservés ont été restitués.",
    MUAPI_NO_REQUEST_ID: "Le suivi de la génération n’a pas pu démarrer. Les crédits réservés ont été restitués.",
    MODEL_UNAVAILABLE: "Ce modèle n’est plus disponible. Choisissez une autre option.",
    MODEL_NOT_FOUND: "Ce modèle est introuvable.",
    UNSUPPORTED_INPUT: "Ce modèle nécessite un réglage qui n’est pas pris en charge. Les crédits réservés ont été restitués.",
    IMAGE_MISSING: "Ce modèle exige une image de référence. Importez une image ou choisissez un modèle texte → vidéo.",
    LAST_IMAGE_MISSING: "Ce modèle exige une image finale de référence.",
    SCRIPT_MISSING: "Générez ou saisissez un script avant de lancer la vidéo.",
    VIDEO_QUOTE_INVALID: "Le devis est expiré ou ne correspond plus aux paramètres. Recalculez le coût avant de relancer.",
    SUBMISSION_ALREADY_CLAIMED: "La soumission est déjà en cours. Actualisez le suivi.",
    PROVIDER_SPEND_DISABLED: "Les tests payants du fournisseur sont désactivés par l’administration.",
    PROVIDER_SPEND_CAP_EXCEEDED: "Le budget fournisseur disponible ne couvre pas cette génération.",
    PROVIDER_SPEND_UNAVAILABLE: "La vérification du budget fournisseur est indisponible. Aucun appel payant n’a été lancé.",
    PROVIDER_SPEND_ALREADY_RESERVED: "La réservation du budget est déjà utilisée ou nécessite une vérification administrative.",
  };
  return map[code] ?? "La génération a échoué. Les crédits réservés ont été restitués.";
}

async function releaseQuota(jobId: string, userId: string): Promise<void> {
  await rpcService("reelora_release_video_quota", { p_job_id: jobId, p_user_id: userId });
}
async function failJob(jobId: string, userId: string, code: string, detail: string): Promise<Response> {
  await rpcService("reelora_finalize_generation", {
    p_job_id: jobId, p_status: "failed", p_storage_path: null,
    p_mime_type: "video/mp4", p_file_size_bytes: null,
    p_result_payload: { error_code: code },
    p_error_message: friendly(code, detail),
  });
  await releaseQuota(jobId, userId);
  return fail(code, friendly(code, detail), 503);
}

/* ------------------------------- Actions -------------------------------- */

async function actionModels(): Promise<Response> {
  const key = MUAPI_KEY();
  if (key) {
    try {
      const res = await fetch(`${MUAPI_BASE}/api/v1/models`, {
        headers: { "x-api-key": key }, signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const catalog = await res.json() as Json;
        const rows = await restService<Json>("reelora_video_models?select=model_id,public_id");
        const allowed = new Set(rows.map((r) => str(r.model_id, 120)));
        const entries = Array.isArray(catalog.models)
          ? (catalog.models as Json[]).filter((m) => allowed.has(str(m.name, 120)))
          : [];
        if (entries.length) await rpcService("reelora_sync_video_models", { p_models: entries });
      }
    } catch { /* cached catalog remains available */ }
  }
  const models = await restService<Json>("reelora_video_models?active=eq.true&select=*&order=sort_order");
  return json({ models: models.map((m, index) => customerModel(m, index)) });
}

/** Full public + account-scoped video catalogue; raw diagnostics are admin-only. */
async function actionCatalog(adminOnly = false): Promise<Response> {
  const [publicReply, probe, dbRows] = await Promise.all([
    muapiFetch("/api/v1/models", { useKey: false, timeout: 20000 }),
    probeAccount(),
    restService<Json>("reelora_video_models?select=*&order=sort_order"),
  ]);
  const publicEntries = entriesOf(publicReply);
  const authEntries = probe.auth.ok ? entriesOf(probe.auth) : [];
  const authNames = new Set(authEntries.map((e) => str(e.name, 120)).filter(validModelId));
  const authCatalogOk = probe.auth.ok && authNames.size > 0;
  const accessFor = (name: string): Access => {
    if (!probe.key_valid || !authCatalogOk) return "unverified";
    return authNames.has(name) ? "account" : "public_only";
  };
  const merged = new Map<string, Json>();
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
      ...prev, ...live,
      input_fields: asArray(live.input_fields).length ? live.input_fields : asArray(prev.input_fields),
      required_fields: asArray(live.required_fields).length ? live.required_fields : asArray(prev.required_fields),
      param_schema: mergeSchema(obj(prev.param_schema) as unknown as Record<string, ParamDef>, live.param_schema as Record<string, ParamDef>),
      synced_at: prev.synced_at ?? null,
    } : live);
  }
  for (const entry of authEntries.filter(isVideoEntry)) {
    const id = str(entry.name, 120);
    if (!validModelId(id)) continue;
    const access = accessFor(id);
    const live = mapLiveEntry(entry, access);
    const prev = merged.get(id);
    merged.set(id, prev ? {
      ...prev, ...live,
      input_fields: asArray(live.input_fields).length ? live.input_fields : asArray(prev.input_fields),
      required_fields: asArray(live.required_fields).length ? live.required_fields : asArray(prev.required_fields),
      param_schema: mergeSchema(obj(prev.param_schema) as unknown as Record<string, ParamDef>, live.param_schema as Record<string, ParamDef>),
      synced_at: prev.synced_at ?? null,
      account_access: access,
    } : live);
  }

  const models: Json[] = Array.from(merged.values()).map((model): Json => {
    const s = statusFor(model);
    return { ...model, reelora_status: s.status, reelora_reason: s.reason };
  }).sort((a, b) => str(a.category).localeCompare(str(b.category)) || str(a.model_id).localeCompare(str(b.model_id)));

  const reasons: Record<string, number> = {};
  for (const m of models) reasons[str(m.reelora_status)] = (reasons[str(m.reelora_status)] ?? 0) + 1;
  const active = reasons.active ?? 0;
  const account_accessible = models.filter((m) => m.account_access === "account").length;
  const public_only = models.filter((m) => m.account_access === "public_only").length;
  const errors: string[] = [];
  if (!publicReply.ok) errors.push(`Catalogue public MuAPI indisponible : ${publicReply.error || `HTTP ${publicReply.status}`}`);
  if (probe.key_configured && !probe.key_valid) errors.push(`Clé MuAPI non validée : ${probe.error}`);
  if (probe.key_configured && probe.key_valid && !authCatalogOk) errors.push(`Catalogue authentifié indisponible : ${probe.error || "aucune entrée retournée"}`);
  if (!dbRows.length && !publicReply.ok) errors.push("Catalogue local indisponible.");

  const source = probe.key_valid && authCatalogOk ? "muapi_authenticated"
    : publicReply.ok ? "muapi_public" : "database";
  const catalog = {
    source,
    fetched_at: new Date().toISOString(),
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
      `GET /api/v1/models (authentifié HTTP ${probe.catalog_status ?? "network"})`,
      `GET /api/v1/account/balance (HTTP ${probe.balance_status ?? "network"})`,
      `GET /api/v1/keys (HTTP ${probe.keys_status ?? "network"})`,
    ],
    error: errors.length ? redact(errors.join(" · ")) : null,
    account: {
      key_configured: probe.key_configured,
      key_valid: probe.key_valid,
      catalog_status: probe.catalog_status,
      balance_status: probe.balance_status,
      keys_status: probe.keys_status,
      key_is_test: probe.key_is_test,
      error: probe.error ? redact(probe.error) : null,
    },
  };
  if (adminOnly) return json({ models, catalog });

  const publicIdByModelId = new Map(dbRows.map((row) => [str(row.model_id, 120), str(row.public_id, 80)]));
  const customerModels = models
    .filter((model) => publicIdByModelId.has(str(model.model_id, 120)))
    .map((model, index) => customerModel(
      { ...model, public_id: publicIdByModelId.get(str(model.model_id, 120)) },
      index,
      str(model.reelora_status) as Status,
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
      error: verified ? null : "Le catalogue est temporairement indisponible.",
    },
  });
}

/** Full input_schema of one real model, fetched server-side with its own key. */
async function actionModelDetail(body: Json): Promise<Response> {
  const requestedModelId = str(body.model_id, 120);
  if (!requestedModelId) return fail("INVALID_INPUT", "Identifiant de modèle invalide.", 400);
  const row = await loadModel(requestedModelId);
  if (!row) return fail("MODEL_NOT_FOUND", "Modèle vidéo inconnu.", 404);
  const publicModelId = str(row.public_id, 80);
  const modelId = str(row.model_id, 120);
  const key = MUAPI_KEY();
  let reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: Boolean(key), timeout: 15000 });
  if (!reply.ok && key) reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: false, timeout: 15000 });
  if (!reply.ok) return fail("MODEL_DETAIL_UNAVAILABLE", "Les paramètres de ce modèle ne sont pas disponibles.", 502);
  const d = obj(obj(reply.data).data ?? reply.data);
  const name = str(d.name, 120) || modelId;
  if (name !== modelId) return fail("MODEL_DETAIL_MISMATCH", "La fiche MuAPI ne correspond pas au modèle demandé.", 502);
  const fields = asArray(d.input_fields);
  const detailSchema = schemaFromInputSchema(d.input_schema, fields);
  const rowSchema = paramSchemaFromRow(row);
  const model: Json = {
    ...row,
    ...mapLiveEntry({ ...d, name: modelId }, "unverified"),
    model_id: modelId,
    public_id: publicModelId,
    input_fields: fields.length ? fields : asArray(row.input_fields),
    required_fields: asArray(d.required_fields).length ? asArray(d.required_fields) : asArray(row.required_fields),
    param_schema: mergeSchema(rowSchema, detailSchema),
  };
  return json({ model: customerModel(model, 0) });
}

async function actionAdminCatalog(userJwt: string): Promise<Response> {
  const response = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/reelora_admin_overview`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return fail("FORBIDDEN", "Accès administrateur requis.", 403);
  await actionModels();
  return actionCatalog(true);
}

interface ResolvedProviderQuote {
  quote: ProviderQuote;
  quoteParams: Json;
  pricingBasis: Record<string, string | number | boolean>;
  modelStatus: Status;
  modelAvailable: boolean;
  modelReason: string;
  publicModelId: string | null;
  modelId: string;
  meta: QuoteModelMeta | null;
}

/**
 * Cœur du devis : lit le modèle réel, applique SES paramètres vérifiés et,
 * pour les modèles à tarification dynamique, interroge UNIQUEMENT
 * `POST /api/v1/models/{name}/estimate-cost` (jamais une génération).
 */
async function resolveProviderQuote(body: Json): Promise<ResolvedProviderQuote> {
  const requested = str(body.model_id, 120);
  const now = new Date();
  const row = requested ? await loadModel(requested) : null;
  if (!row) {
    return {
      quote: unavailableQuote({ code: "MODEL_NOT_FOUND", now }),
      quoteParams: {}, pricingBasis: {},
      modelStatus: "disabled", modelAvailable: false,
      modelReason: "Modèle vidéo inconnu.", publicModelId: null,
      modelId: requested, meta: null,
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
  const modelAvailable = Boolean(bool(row.active, false) && bool(row.is_enabled, true)
    && !bool(row.is_coming_soon, false) && !unsupported.length);
  const base = {
    estimateEndpoint: meta.estimateEndpoint,
    catalogSyncedAt: meta.syncedAt,
    pricingBasis,
  };
  const modelReason = unsupported.length
    ? "Ce modèle nécessite un réglage qui n’est pas encore pris en charge."
    : modelAvailable ? "Disponible dans VYORA." : (status.reason || "Indisponible momentanément.");

  const finish = (quote: ProviderQuote): ResolvedProviderQuote => ({
    quote, quoteParams, pricingBasis,
    modelStatus: status.status, modelAvailable, modelReason, publicModelId, modelId, meta,
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
    if (effective.required.includes("prompt") && !str(quoteParams.prompt, 4000)) {
      return finish(unavailableQuote({ code: "PROMPT_REQUIRED", now, ...base }));
    }
    const reply = await muapiFetch(meta.estimateEndpoint, {
      method: "POST", useKey: true, body: quoteParams, timeout: 20000,
    });
    const providerReply: ProviderReplyLike = {
      ok: reply.ok, status: reply.status, data: reply.data, timedOut: reply.timedOut === true,
    };
    const quote = buildProviderQuote({
      model: meta, providerReply, pricingParams: quoteParams,
      prompt: str(quoteParams.prompt, 4000), now,
    });
    return finish(quote);
  }
  return finish(buildProviderQuote({
    model: meta, providerReply: null, pricingParams: quoteParams,
    prompt: str(quoteParams.prompt, 4000), now,
  }));
}

/** Devis fournisseur public (aucun crédit, aucune génération, aucun débit). */
async function actionProviderQuote(body: Json): Promise<Response> {
  const resolved = await resolveProviderQuote(body);
  return json({
    model_id: resolved.publicModelId,
    model_available: resolved.modelAvailable,
    model_status: resolved.modelStatus,
    model_reason: resolved.modelReason,
    quote: resolved.quote,
  });
}

async function actionEstimate(body: Json, userId: string): Promise<Response> {
  const serviceKey = str(body.service_key, 80);
  const requestedModelId = str(body.model_id, 120);
  const rows = await restService<Json>(`ugc_service_catalog?service_key=eq.${encodeURIComponent(serviceKey)}&select=service_key,display_name,credits_cost,active&limit=1`);
  const service = rows[0];
  const resolved = requestedModelId
    ? await resolveProviderQuote(body)
    : null;
  const quote = resolved?.quote ?? null;
  const providerCostUsd = quote?.available ? quote.cost_usd : null;
  const quoteAvailable = Boolean(quote?.available && providerCostUsd && providerCostUsd > 0);
  const modelAvailable = Boolean(resolved?.modelAvailable);
  const modelStatus: Status = resolved?.modelStatus ?? "disabled";

  let creditsCost: number | null = null;
  let quoteId: string | null = null;
  let pricingError: string | null = null;
  if (!service?.active || !modelAvailable) {
    pricingError = "Ce modèle ou ce service n'est pas disponible pour le moment.";
  } else if (!quoteAvailable || providerCostUsd === null) {
    pricingError = quote?.error_message ?? "Le tarif exact de cette génération n'est pas disponible.";
  } else {
    const config = await loadVideoPricingConfig();
    if (!config?.enabled || config.usd_to_xof === null || config.credit_value_xof === null
      || config.markup_percent === null || config.additional_cost_usd === null || !config.updated_at) {
      pricingError = "La tarification en crédits n'est pas encore configurée. Le devis fournisseur en USD reste disponible, mais la réservation de crédits est bloquée.";
    } else {
      creditsCost = calculateVideoCredits(providerCostUsd, config);
      if (creditsCost === null) {
        pricingError = "Le tarif exact de cette génération n'est pas disponible.";
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
          p_pricing_params: pricingParams,
        });
        if (recorded.ok && typeof recorded.data === "string") {
          quoteId = recorded.data;
        } else {
          creditsCost = null;
          pricingError = "Le devis n'a pas pu être validé. Réessayez.";
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
    model_reason: resolved?.modelReason ?? "Modèle vidéo inconnu.",
    pricing_available: Boolean(quoteId),
    pricing_error: pricingError,
    quote_id: quoteId,
    quote_expires_at: quoteId ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
    provider_quote: quote,
  });
}

async function actionStart(jobId: string, userId: string): Promise<Response> {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "Tâche de génération introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette tâche ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const providerJobId = str(job.provider_job_id, 300);
  const payload = obj(job.request_payload);

  if (["succeeded", "failed", "cancelled"].includes(status) || providerJobId) {
    return json({ job_id: jobId, status });
  }

  const quoteId = str(job.pricing_quote_id, 80) || str(payload.quote_id, 80);
  const quoteResult = quoteId ? await rpcService("reelora_get_video_quote", { p_quote_id: quoteId })
    : { ok: false, data: null, error: "missing_quote" };
  const quote = obj(quoteResult.data);
  const publicModelId = str(payload.model_id, 80);
  if (!quoteResult.ok || str(quote.user_id, 80) !== userId
    || str(quote.service_key, 80) !== str(job.service_key, 80)
    || str(quote.public_model_id, 80) !== publicModelId
    || Number(quote.credits_cost) !== Number(job.credits_reserved)) {
    return await failJob(jobId, userId, "VIDEO_QUOTE_INVALID", "");
  }

  // Atomic claim: two concurrent start calls can never submit twice.
  const claimId = `claim-${crypto.randomUUID()}`;
  const claim = await rpcService("reelora_claim_generation_submission", { p_job_id: jobId, p_claim_id: claimId });
  if (!claim.ok || claim.data !== true) {
    return json({ job_id: jobId, status,
      message: friendly("SUBMISSION_ALREADY_CLAIMED", "") });
  }

  const key = MUAPI_KEY();
  if (!key) {
    return await failJob(jobId, userId, "MUAPI_NOT_CONFIGURED", "Clé MuAPI absente.");
  }

  const rawModel = publicModelId ? await loadModel(publicModelId) : null;
  if (!rawModel) return await failJob(jobId, userId, "MODEL_NOT_FOUND", "");
  const modelId = str(rawModel.model_id, 120);
  const model: Json = { ...rawModel };
  if (!bool(model.active, false) || !bool(model.is_enabled, true) || bool(model.is_coming_soon, false)) {
    return await failJob(jobId, userId, "MODEL_UNAVAILABLE", "");
  }
  const effective = await effectiveSchema(model, modelId);
  const unsupported = effective.required.filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) return await failJob(jobId, userId, "UNSUPPORTED_INPUT", unsupported.join(", "));
  // Use the real schema (curated DB or GET /models/{name}) for exact parameters.
  model.input_fields = effective.fields;
  model.required_fields = effective.required;
  model.param_schema = effective.schema as unknown as Json;

  const script = str(payload.script_text, 4000) || await loadScript(str(job.project_id, 80));
  if (script.length < 10) return await failJob(jobId, userId, "SCRIPT_MISSING", "Script absent.");
  const prompt = buildPrompt(payload, script);

  const workspaceId = str(job.workspace_id, 80);
  const modelFields = asArray(model.input_fields);
  const acceptsImage = modelFields.includes("image_url");
  const acceptsLastImage = modelFields.includes("last_image");
  let imageUrl = acceptsImage ? str(payload.image_url, 2000) : "";
  const imagePath = acceptsImage ? workspaceImagePath(payload.image_storage_path, workspaceId) : "";
  if (!imageUrl && imagePath) imageUrl = (await signStoragePath(imagePath)) ?? "";
  if (!imageUrl && acceptsImage) {
    const avatar = await loadAvatar(str(payload.avatar_id, 80));
    imageUrl = str(avatar?.preview_url, 2000);
    const avatarPath = workspaceImagePath(avatar?.preview_storage_path, workspaceId);
    if (!imageUrl && avatarPath) {
      imageUrl = (await signStoragePath(avatarPath)) ?? "";
    }
  }

  let lastImageUrl = acceptsLastImage ? str(payload.last_image_url, 2000) : "";
  const lastImagePath = acceptsLastImage ? workspaceImagePath(payload.last_image_storage_path, workspaceId) : "";
  if (!lastImageUrl && lastImagePath) lastImageUrl = (await signStoragePath(lastImagePath)) ?? "";

  let submitBody: Json;
  try { submitBody = buildMuapiBody(model, payload, prompt, imageUrl, lastImageUrl); }
  catch (e) {
    const code = e instanceof Error ? e.message.split(":")[0] : "INVALID_INPUT";
    return await failJob(jobId, userId, code, e instanceof Error ? e.message : String(e));
  }
  if (str(quote.model_id, 120) !== modelId
    || canonicalJson(pricingParameters(submitBody)) !== canonicalJson(obj(quote.pricing_params))) {
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
    const code = reason === "provider_spend_disabled" ? "PROVIDER_SPEND_DISABLED"
      : reason === "provider_spend_cap_exceeded" ? "PROVIDER_SPEND_CAP_EXCEEDED"
        : "PROVIDER_SPEND_ALREADY_RESERVED";
    return await failJob(jobId, userId, code, "");
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
  let cost: Json | null = null;
  let submitRejected = false;
  try {
    const res = await fetch(submitUrl, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(submitBody), signal: AbortSignal.timeout(60000),
    });
    const raw = await res.text();
    let parsed: Json = {};
    try { parsed = raw ? JSON.parse(raw) as Json : {}; } catch { /* handled below */ }
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
    actualCostUsd: muapiActualCostUsd(cost),
  });

  const merged: Json = {
    ...payload, model_id: publicModelId, webhook_enabled: Boolean(token),
  };
  const updated = await rpcService("reelora_set_job_processing", {
    p_job_id: jobId, p_provider: "muapi", p_provider_job_id: requestId, p_request_payload: merged,
  });
  if (!updated.ok) return fail("JOB_UPDATE_ERROR", redact(updated.error ?? "Mise à jour impossible."), 500);
  if (cost) await rpcService("reelora_record_video_poll", {
    p_job_id: jobId, p_provider_status: "queued", p_next_poll_seconds: 30, p_cost: cost,
  });
  return json({ job_id: jobId, status: "processing", provider_state: "queued",
    model_id: publicModelId, webhook_enabled: Boolean(token) });
}

async function actionStatus(jobId: string, userId: string): Promise<Response> {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "Tâche de génération introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette tâche ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const result: Json = {
    job_id: jobId, status,
    provider_state: str(obj(job.result_payload).provider_status, 40) || null,
    error: status === "failed" ? str(job.error_message, 500) || null : null,
    progress: status === "succeeded" ? 100 : status === "processing" ? 55 : status === "reserved" ? 20 : 0,
  };
  if (status === "succeeded") {
    const assets = await restService<Json>(
      `ugc_generated_assets?generation_job_id=eq.${encodeURIComponent(jobId)}&select=storage_path,file_size_bytes,mime_type&limit=1`,
    );
    const path = str(assets[0]?.storage_path, 500);
    if (path) { result.storage_path = path; result.preview_url = await signStoragePath(path); }
  }
  return json(result);
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  const userJwt = req.headers.get("Authorization") ?? "";
  if (!userJwt.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  if (!SERVICE_KEY() || !SUPABASE_URL()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente côté serveur.", 500);
  const userId = await authUserId(userJwt);
  if (!userId) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);

  let body: Json;
  try { body = await req.json() as Json; } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const action = str(body.action, 20);
  try {
    if (action === "catalog") return await actionCatalog();
    if (action === "admin-catalog") return await actionAdminCatalog(userJwt);
    if (action === "model-detail") return await actionModelDetail(body);
    if (action === "models") return await actionModels();
    if (action === "estimate") return await actionEstimate(body, userId);
    if (action === "quote" || action === "provider-quote") return await actionProviderQuote(body);
    const jobId = str(body.job_id, 80);
    if (!jobId) return fail("INVALID_INPUT", "job_id requis.", 400);
    if (action === "start") return await actionStart(jobId, userId);
    if (action === "status") return await actionStatus(jobId, userId);
    return fail("UNKNOWN_ACTION", "Action vidéo inconnue.", 400);
  } catch (error) {
    console.error("reelora-video", redact(error instanceof Error ? error.message : String(error)));
    return fail("VIDEO_INTERNAL_ERROR", "Une erreur inattendue est survenue pendant la génération vidéo.", 500);
  }
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
