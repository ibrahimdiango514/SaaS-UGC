// Reelora video gateway — MuAPI is the PRIMARY (and only) video provider.
// Groq remains the text provider (reelora-ai). HeyGen / fal.ai are NOT used here.
//
// Official MuAPI contract (verified):
//   POST https://api.muapi.ai/api/v1/{model}   x-api-key: KEY   -> { request_id, status, cost }
//   GET  https://api.muapi.ai/api/v1/predictions/{request_id}/result
//        -> { id, status: queued|pending|processing|completed|failed|cancelled, outputs[], error, cost }
//   GET  https://api.muapi.ai/api/v1/models    -> { models: [...] }
//   ?webhook=<https url> on submit            -> POST callback on terminal state
// Docs: https://muapi.ai/docs/api-reference , https://muapi.ai/docs/webhooks
//
// Actions (JWT required, gateway verify_jwt = true):
//   { action: "models" }                       -> live/cached verified video models
//   { action: "estimate", service_key, model_id } -> credit + provider cost estimate
//   { action: "start", job_id }               -> idempotent MuAPI submission
//   { action: "status", job_id }              -> DB state + signed preview URL
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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

/* -------------------------------- MuAPI --------------------------------- */

interface ParamDef { type: string; options?: unknown[]; min?: number; max?: number; default?: unknown }

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function buildMuapiBody(model: Json, payload: Json, prompt: string, imageUrl: string, lastImageUrl = ""): Json {
  const fields = asArray(model.input_fields);
  const required = asArray(model.required_fields);
  const body: Json = { prompt };
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
  const schema = (model.param_schema && typeof model.param_schema === "object"
    ? model.param_schema : {}) as Record<string, ParamDef>;
  const params = (payload.params && typeof payload.params === "object" ? payload.params : {}) as Json;
  for (const [key, def] of Object.entries(schema)) {
    if (!def || !fields.includes(key)) continue; // never send an unsupported parameter
    const raw = params[key] ?? payload[key] ?? def.default;
    if (raw === undefined || raw === null || raw === "") continue;
    if (def.type === "select") {
      if (Array.isArray(def.options) && !def.options.includes(raw)) continue;
      body[key] = raw;
    } else if (def.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      body[key] = Math.min(Math.max(n, def.min ?? 1), def.max ?? 300);
    } else if (def.type === "boolean") {
      body[key] = raw === true || raw === "true" || raw === 1;
    }
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
  const d = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Json;
  return str(d.request_id, 300) || str(d.id, 300);
}
function muapiCost(raw: Json): Json | null {
  const d = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Json;
  return d.cost && typeof d.cost === "object" ? (d.cost as Json) : null;
}

function friendly(code: string, detail: string): string {
  const map: Record<string, string> = {
    MUAPI_NOT_CONFIGURED: "Le service vidéo MuAPI n’est pas configuré : ajoutez le secret serveur MUAPI_API_KEY dans Supabase. Les crédits réservés ont été restitués.",
    MUAPI_SUBMIT_ERROR: `MuAPI a refusé la requête : ${detail}`,
    MUAPI_NO_REQUEST_ID: "MuAPI n’a pas renvoyé d’identifiant de tâche. Les crédits réservés ont été restitués.",
    MODEL_UNAVAILABLE: "Ce modèle vidéo MuAPI n’est plus disponible. Choisissez un autre modèle.",
    MODEL_NOT_FOUND: "Modèle vidéo MuAPI inconnu.",
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

async function actionEstimate(body: Json): Promise<Response> {
  const serviceKey = str(body.service_key, 80);
  const modelId = str(body.model_id, 120);
  const rows = await restService<Json>(`ugc_service_catalog?service_key=eq.${encodeURIComponent(serviceKey)}&select=service_key,display_name,credits_cost,active&limit=1`);
  const service = rows[0];
  const model = modelId ? (await loadModel(modelId)) : null;
  return json({
    service_key: serviceKey,
    credits_cost: Number(service?.credits_cost ?? 0),
    service_active: Boolean(service?.active),
    model_id: modelId || null,
    model_available: Boolean(model?.active && model?.is_enabled && !model?.is_coming_soon),
    provider_cost_usd: model?.cost_usd ?? null,
    provider_cost_currency: model?.cost_currency ?? "USD",
  });
}

async function actionStart(jobId: string, userId: string): Promise<Response> {
  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "Tâche de génération introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette tâche ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const providerJobId = str(job.provider_job_id, 300);
  const payload = (job.request_payload && typeof job.request_payload === "object" ? job.request_payload : {}) as Json;

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
  const model = modelId ? await loadModel(modelId) : null;
  if (!model) return await failJob(jobId, userId, "MODEL_NOT_FOUND", `Modèle ${modelId || "(non renseigné)"} inconnu.`);
  if (!model.active || !model.is_enabled || model.is_coming_soon) {
    return await failJob(jobId, userId, "MODEL_UNAVAILABLE", `Modèle ${modelId} indisponible.`);
  }

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

  const endpoint = str(model.endpoint, 200);
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
    provider_state: str(job.result_payload && typeof job.result_payload === "object"
      ? (job.result_payload as Json).provider_status : null, 40) || null,
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
