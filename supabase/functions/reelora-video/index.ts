// Reelora video gateway — MuAPI is the PRIMARY (and only) video provider.
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
  const rows = await restService<Json>(`reelora_video_models?model_id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows[0] ?? null;
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
 * A reference image may be uploaded to the private Reelora bucket. Only paths
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
interface MuapiReply { status: number; data: unknown; error: string; ok: boolean }
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

/** Required inputs Reelora can actually provide today. No audio/TTS/lipsync engine is connected. */
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
/** Convert MuAPI's JSON-Schema-like input_schema into Reelora's param_schema. */
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
  if (!bool(model.is_enabled, true)) return { status: "disabled", reason: "Désactivé dans le catalogue MuAPI." };
  if (bool(model.is_coming_soon, false)) return { status: "coming_soon", reason: "Annoncé par MuAPI, pas encore lancé." };
  const unsupported = asArray(model.required_fields).filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  if (unsupported.length) return { status: "unsupported", reason: `Entrée non connectée dans Reelora : ${unsupported.join(", ")}.` };
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
    return { status: 0, data: null, error: redact(e instanceof Error ? e.message : String(e)), ok: false };
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
const quoteCache = new Map<string, { cost: number | null; currency: string; at: number }>();
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
  for (const [key, raw] of Object.entries(params)) {
    if (!fields.includes(key) || isSourceField(key) || key.startsWith("__")) continue;
    const def = schema[key];
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
function providerCost(reply: MuapiReply): number | null {
  const root = obj(obj(reply.data).data ?? reply.data);
  const candidates: unknown[] = [root.cost, root.cost_usd, root.estimated_cost, root.price,
    root.total_cost, root.amount, root.amount_usd, root.usd, root.total,
    obj(root.cost).amount, obj(root.cost).usd, obj(root.data).cost];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && Number.isFinite(Number(c))) return Number(c);
    const o = obj(c);
    for (const v of [o.amount, o.usd, o.cost, o.total, o.value]) {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return null;
}
function providerCurrency(reply: MuapiReply, fallback: string): string {
  const root = obj(obj(reply.data).data ?? reply.data);
  return str(root.currency ?? root.cost_currency ?? obj(root.cost).currency, 10) || fallback;
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
    // array / object: no connected Reelora control, never invented or forwarded.
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

function friendly(code: string, detail: string): string {
  const map: Record<string, string> = {
    MUAPI_NOT_CONFIGURED: "Le service vidéo MuAPI n’est pas configuré : ajoutez le secret serveur MUAPI_API_KEY dans Supabase. Les crédits réservés ont été restitués.",
    MUAPI_SUBMIT_ERROR: `MuAPI a refusé la requête : ${detail}`,
    MUAPI_NO_REQUEST_ID: "MuAPI n’a pas renvoyé d’identifiant de tâche. Les crédits réservés ont été restitués.",
    MODEL_UNAVAILABLE: "Ce modèle vidéo MuAPI n’est plus disponible. Choisissez un autre modèle.",
    MODEL_NOT_FOUND: "Modèle vidéo MuAPI inconnu.",
    UNSUPPORTED_INPUT: `Ce modèle exige une entrée non connectée dans Reelora : ${detail}. Aucune génération n’a été lancée ; les crédits réservés ont été restitués.`,
    IMAGE_MISSING: "Ce modèle exige une image de référence. Importez une image ou choisissez un modèle texte → vidéo.",
    LAST_IMAGE_MISSING: "Ce modèle exige une image finale de référence.",
    SCRIPT_MISSING: "Générez ou saisissez un script avant de lancer la vidéo.",
    SUBMISSION_ALREADY_CLAIMED: "La soumission est déjà en cours. Actualisez le suivi.",
  };
  return map[code] ?? detail;
}

async function releaseQuota(jobId: string, userId: string): Promise<void> {
  await rpcService("reelora_release_video_quota", { p_job_id: jobId, p_user_id: userId });
}
async function failJob(jobId: string, userId: string, code: string, detail: string): Promise<Response> {
  await rpcService("reelora_finalize_generation", {
    p_job_id: jobId, p_status: "failed", p_storage_path: null,
    p_mime_type: "video/mp4", p_file_size_bytes: null,
    p_result_payload: { provider: "muapi", error_code: code },
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
        const rows = await restService<Json>("reelora_video_models?select=model_id");
        const allowed = new Set(rows.map((r) => str(r.model_id, 120)));
        const entries = Array.isArray(catalog.models)
          ? (catalog.models as Json[]).filter((m) => allowed.has(str(m.name, 120)))
          : [];
        if (entries.length) await rpcService("reelora_sync_video_models", { p_models: entries });
      }
    } catch { /* cached catalog remains available */ }
  }
  const models = await restService<Json>("reelora_video_models?active=eq.true&select=*&order=sort_order");
  return json({ models: models.map((m) => ({
    model_id: m.model_id, display_name: m.display_name, description: m.description,
    category: m.category, endpoint: m.endpoint, input_fields: m.input_fields,
    required_fields: m.required_fields, param_schema: m.param_schema,
    cost_usd: m.cost_usd, cost_currency: m.cost_currency,
    is_enabled: m.is_enabled, is_coming_soon: m.is_coming_soon, synced_at: m.synced_at,
  })) });
}

/** Full public + account-scoped video catalogue, with explicit diagnostics. */
async function actionCatalog(): Promise<Response> {
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
  return json({ models, catalog });
}

/** Full input_schema of one real model, fetched server-side with its own key. */
async function actionModelDetail(body: Json): Promise<Response> {
  const modelId = str(body.model_id, 120);
  if (!validModelId(modelId)) return fail("INVALID_INPUT", "Identifiant de modèle invalide.", 400);
  const row = await loadModel(modelId);
  if (!row) return fail("MODEL_NOT_FOUND", "Modèle vidéo MuAPI inconnu.", 404);
  const key = MUAPI_KEY();
  let reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: Boolean(key), timeout: 15000 });
  if (!reply.ok && key) reply = await muapiFetch(`/api/v1/models/${encodeURIComponent(modelId)}`, { useKey: false, timeout: 15000 });
  if (!reply.ok) return fail("MODEL_DETAIL_UNAVAILABLE", `Schéma MuAPI indisponible : ${reply.error || `HTTP ${reply.status}`}`, 502);
  const d = obj(obj(reply.data).data ?? reply.data);
  const name = str(d.name, 120) || modelId;
  if (name !== modelId) return fail("MODEL_DETAIL_MISMATCH", "La fiche MuAPI ne correspond pas au modèle demandé.", 502);
  const fields = asArray(d.input_fields);
  const detailSchema = schemaFromInputSchema(d.input_schema, fields);
  const rowSchema = paramSchemaFromRow(row);
  const model: Json = {
    ...mapLiveEntry({ ...d, name: modelId }, "unverified"),
    model_id: modelId,
    input_fields: fields.length ? fields : asArray(row.input_fields),
    required_fields: asArray(d.required_fields).length ? asArray(d.required_fields) : asArray(row.required_fields),
    param_schema: mergeSchema(rowSchema, detailSchema),
    source: "muapi_model_detail",
    // Access is deliberately NOT overwritten here: the catalog action alone
    // decides public vs account after validating the key.
    account_access: undefined,
    reelora_status: undefined,
    reelora_reason: undefined,
  };
  return json({ model });
}

async function actionEstimate(body: Json): Promise<Response> {
  const serviceKey = str(body.service_key, 80);
  const modelId = str(body.model_id, 120);
  const rows = await restService<Json>(`ugc_service_catalog?service_key=eq.${encodeURIComponent(serviceKey)}&select=service_key,display_name,credits_cost,active&limit=1`);
  const service = rows[0];
  const rawModel = modelId ? await loadModel(modelId) : null;
  const model = rawModel ? { ...rawModel } : null;
  const meta = model ? metaFromRow(model) : {};
  const dynamic = bool(meta.dynamic_pricing, false);
  const estimateEndpoint = model ? normalizeEstimateEndpoint(meta.estimate_endpoint, modelId) : null;
  const quoteRequested = body.params !== undefined || body.prompt !== undefined || body.image_url !== undefined || body.last_image_url !== undefined;
  const effective = model ? await effectiveSchema(model, modelId) : { schema: {}, fields: [] as string[], required: [] as string[] };
  const clientSchema = paramSchemaFromClient(body.param_schema, effective.fields);
  const schema = Object.keys(clientSchema).length ? clientSchema : effective.schema;
  const quoteParams = model ? buildQuoteBody(body, schema, effective.fields, effective.required) : {};
  const unsupported = effective.required.filter((f) => !SUPPORTED_REQUIRED_FIELDS.has(f.toLowerCase()));
  const catalogCost = finite(model?.cost_usd);
  let providerCostUsd: number | string | null = catalogCost;
  let currency = str(model?.cost_currency, 10) || "USD";
  let quoteSource: "catalog" | "estimate_cost" | "unavailable" = "catalog";
  let quoteError: string | null = null;

  if (quoteRequested && model && dynamic) {
    if (!MUAPI_KEY()) {
      quoteSource = "unavailable";
      quoteError = "Devis exact indisponible : secret serveur MUAPI_API_KEY absent.";
    } else if (!estimateEndpoint) {
      quoteSource = "unavailable";
      quoteError = "Devis exact indisponible : endpoint estimate-cost non déclaré par MuAPI.";
    } else if (effective.required.includes("prompt") && !str(quoteParams.prompt, 4000)) {
      quoteSource = "unavailable";
      quoteError = "Saisissez une instruction pour obtenir le devis exact de ce modèle à tarification dynamique.";
    } else {
      const cacheKey = `${modelId}|${estimateEndpoint}|${JSON.stringify(quoteParams)}`;
      const cached = quoteCache.get(cacheKey);
      let cost: number | null = cached && Date.now() - cached.at < 300000 ? cached.cost : null;
      if (!cached || Date.now() - cached.at >= 300000) {
        const reply = await muapiFetch(estimateEndpoint, { method: "POST", useKey: true, body: quoteParams, timeout: 20000 });
        cost = reply.ok ? providerCost(reply) : null;
        if (reply.ok && cost !== null) {
          currency = providerCurrency(reply, currency);
          quoteCache.set(cacheKey, { cost, currency, at: Date.now() });
        } else {
          quoteError = `MuAPI estimate-cost : ${reply.error || `HTTP ${reply.status}`}`;
        }
      } else if (cached) currency = cached.currency;
      if (cost !== null) {
        providerCostUsd = cost;
        quoteSource = "estimate_cost";
      } else {
        quoteSource = "unavailable";
        quoteError = quoteError ?? "MuAPI n’a pas renvoyé de coût exploitable pour ces paramètres exacts.";
      }
    }
  }

  const modelAvailable = Boolean(model && bool(model.active, false) && bool(model.is_enabled, true)
    && !bool(model.is_coming_soon, false) && !unsupported.length && quoteSource !== "unavailable");
  const modelStatus: Status = !model ? "disabled"
    : !bool(model.is_enabled, true) ? "disabled"
      : bool(model.is_coming_soon, false) ? "coming_soon"
        : unsupported.length ? "unsupported"
          : quoteSource === "unavailable" ? "unverified" : "active";
  const modelReason = !model ? "Modèle inconnu du catalogue Reelora."
    : unsupported.length ? `Entrée non connectée : ${unsupported.join(", ")}.`
      : quoteSource === "unavailable" ? quoteError
        : "Modèle actif et sélectionnable.";

  // A catalogue tariff is NOT an exact provider quote. When estimate-cost fails
  // (or cannot be requested), never fall back to the catalogue price: the UI
  // must display "devis fournisseur à confirmer" instead of an invented number.
  if (quoteSource === "unavailable") providerCostUsd = null;

  return json({
    service_key: serviceKey,
    credits_cost: Number(service?.credits_cost ?? 0),
    service_active: Boolean(service?.active),
    model_id: modelId || null,
    model_available: modelAvailable,
    model_status: modelStatus,
    model_reason: modelReason,
    provider_cost_usd: providerCostUsd,
    provider_cost_currency: currency,
    provider_quote_source: quoteSource,
    provider_quote_error: quoteError ? redact(quoteError) : null,
    quote_params: quoteParams,
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
    return json({ job_id: jobId, status, provider: "muapi", provider_job_id: providerJobId || null });
  }

  // Atomic claim: two concurrent "start" calls can never POST twice to MuAPI.
  const claimId = `claim-${crypto.randomUUID()}`;
  const claim = await rpcService("reelora_claim_generation_submission", { p_job_id: jobId, p_claim_id: claimId });
  if (!claim.ok || claim.data !== true) {
    return json({ job_id: jobId, status, provider: "muapi", provider_job_id: null,
      message: friendly("SUBMISSION_ALREADY_CLAIMED", "") });
  }

  const key = MUAPI_KEY();
  if (!key) {
    return await failJob(jobId, userId, "MUAPI_NOT_CONFIGURED", "Clé MuAPI absente.");
  }

  const modelId = str(payload.model_id, 120);
  const rawModel = modelId ? await loadModel(modelId) : null;
  if (!rawModel) return await failJob(jobId, userId, "MODEL_NOT_FOUND", `Modèle ${modelId || "(non renseigné)"} inconnu.`);
  const model: Json = { ...rawModel };
  if (!bool(model.active, false) || !bool(model.is_enabled, true) || bool(model.is_coming_soon, false)) {
    return await failJob(jobId, userId, "MODEL_UNAVAILABLE", `Modèle ${modelId} indisponible.`);
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

  const endpoint = normalizeEndpoint(model.endpoint, metaFromRow(rawModel).endpoint_url, modelId);
  if (!validEndpoint(endpoint)) return await failJob(jobId, userId, "MODEL_UNAVAILABLE", "Endpoint MuAPI invalide.");
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
      const detail = redact(str(parsed.message, 300) || str(parsed.error, 300) || raw.slice(0, 300));
      throw new Error(`MUAPI_SUBMIT_ERROR: ${detail || `HTTP ${res.status}`}`);
    }
    requestId = muapiSubmitId(parsed);
    cost = muapiCost(parsed);
  } catch (e) {
    const detail = redact(e instanceof Error ? e.message : String(e));
    return await failJob(jobId, userId, "MUAPI_SUBMIT_ERROR", detail);
  }
  if (!requestId) return await failJob(jobId, userId, "MUAPI_NO_REQUEST_ID", "Réponse MuAPI sans request_id.");

  const merged: Json = {
    ...payload, provider: "muapi", model_id: modelId, model_endpoint: endpoint,
    muapi_request_id: requestId, muapi_submit_body: submitBody, muapi_submit_cost: cost,
    webhook_enabled: Boolean(token), prompt_used: prompt,
  };
  const updated = await rpcService("reelora_set_job_processing", {
    p_job_id: jobId, p_provider: "muapi", p_provider_job_id: requestId, p_request_payload: merged,
  });
  if (!updated.ok) return fail("JOB_UPDATE_ERROR", redact(updated.error ?? "Mise à jour impossible."), 500);
  if (cost) await rpcService("reelora_record_video_poll", {
    p_job_id: jobId, p_provider_status: "queued", p_next_poll_seconds: 30, p_cost: cost,
  });
  return json({ job_id: jobId, status: "processing", provider: "muapi",
    provider_job_id: requestId, provider_state: "queued", model_id: modelId,
    provider_cost: cost, webhook_enabled: Boolean(token) });
}

async function actionStatus(jobId: string, userId: string): Promise<Response> {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "Tâche de génération introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette tâche ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const result: Json = {
    job_id: jobId, status, provider: "muapi",
    provider_job_id: str(job.provider_job_id, 300) || null,
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
    if (action === "model-detail") return await actionModelDetail(body);
    if (action === "models") return await actionModels();
    if (action === "estimate") return await actionEstimate(body);
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
