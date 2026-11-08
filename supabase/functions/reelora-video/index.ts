// Reelora video worker — real provider integrations (HeyGen avatar video or fal.ai
// image-to-video). Provider API keys are read server-side only. Jobs, credits,
// assets and notifications are updated through SECURITY DEFINER RPCs.
//
// Actions: { action: "start" | "status", job_id: "<uuid>" }
// The browser polls "status" until the job succeeds or fails; no fake result is
// ever produced when a provider (or its key) is unavailable.

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

type Json = Record<string, unknown>;
const SUPABASE_URL = () => Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = () => Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
const BUCKET = "ugc-assets";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
function str(v: unknown, max = 4000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function svcHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, ...extra };
}

async function rpcService(name: string, args: Json): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST", headers: svcHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === "object" && data !== null && "message" in data ? String((data as Json).message) : text;
    return { ok: false, data: null, error: msg };
  }
  return { ok: true, data };
}

async function restService<T = Json>(path: string): Promise<T[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, { headers: svcHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

// The Supabase gateway verifies this JWT's signature before invoking the function
// (verify_jwt = true, NEVER deploy this function with --no-verify-jwt). We only
// read the already-verified "sub" claim to compare it with the job's owner.
function userIdFromJwt(jwt: string): string | null {
  try {
    const token = jwt.replace(/^Bearer\s+/i, "");
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(atob(b64)) as Json;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch { return null; }
}

async function rpcUser(name: string, args: Json, userJwt: string): Promise<void> {
  await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ANON_KEY(), Authorization: userJwt, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

async function signStoragePath(path: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL()}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST", headers: svcHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const data = await res.json() as Json;
  const signed = str(data.signedURL ?? data.signedUrl, 1000);
  if (!signed) return null;
  return signed.startsWith("http") ? signed : `${SUPABASE_URL()}/storage/v1${signed.startsWith("/") ? "" : "/"}${signed}`;
}

async function uploadVideo(jobId: string, workspaceId: string, url: string): Promise<{ storage_path: string; file_size_bytes: number } | null> {
  const video = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!video.ok) throw new Error(`Téléchargement de la vidéo impossible (HTTP ${video.status})`);
  const buffer = await video.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("Le fichier vidéo retourné par le fournisseur est vide");
  const path = `${workspaceId}/${jobId}.mp4`;
  const res = await fetch(`${SUPABASE_URL()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: svcHeaders({ "Content-Type": "video/mp4", "x-upsert": "true" }),
    body: buffer,
  });
  if (!res.ok) throw new Error(`Stockage de la vidéo impossible (HTTP ${res.status})`);
  return { storage_path: path, file_size_bytes: buffer.byteLength };
}

async function finalize(jobId: string, status: "succeeded" | "failed", opts: Json = {}): Promise<void> {
  const r = await rpcService("reelora_finalize_generation", {
    p_job_id: jobId,
    p_status: status,
    p_storage_path: opts.storage_path ?? null,
    p_mime_type: "video/mp4",
    p_file_size_bytes: opts.file_size_bytes ?? null,
    p_result_payload: opts.result_payload ?? {},
    p_error_message: opts.error_message ?? null,
  });
  if (!r.ok) console.error("finalize failed", r.error);
}

async function failJob(jobId: string, userJwt: string, code: string, message: string): Promise<Response> {
  await finalize(jobId, "failed", { error_message: message });
  await rpcUser("reelora_refund_quota", { p_kind: "video", p_reference_id: jobId }, userJwt);
  return fail(code, message, 503);
}

function dimensions(ratio: string): { width: number; height: number } {
  if (ratio === "16:9") return { width: 1280, height: 720 };
  if (ratio === "1:1") return { width: 720, height: 720 };
  if (ratio === "4:5") return { width: 720, height: 900 };
  return { width: 720, height: 1280 };
}

async function loadJob(jobId: string): Promise<Json | null> {
  const rows = await restService<Json>(`ugc_generation_jobs?id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`);
  return rows[0] ?? null;
}

async function loadScript(projectId: string | null): Promise<string> {
  if (!projectId) return "";
  const rows = await restService<Json>(`ugc_project_scripts?project_id=eq.${encodeURIComponent(projectId)}&select=script_text&order=version.desc&limit=1`);
  return str(rows[0]?.script_text, 4000);
}

async function loadAvatar(avatarId: string | null): Promise<Json | null> {
  if (!avatarId) return null;
  const rows = await restService<Json>(`reelora_avatars?id=eq.${encodeURIComponent(avatarId)}&select=*&limit=1`);
  return rows[0] ?? null;
}

async function submitHeygen(job: Json, payload: Json): Promise<{ id: string; extra: Json }> {
  const key = Deno.env.get("HEYGEN_API_KEY");
  if (!key) throw new Error("HEYGEN_NOT_CONFIGURED");
  const avatar = await loadAvatar(str(payload.avatar_id, 80) || null);
  const avatarId = str(payload.avatar_id_provider, 200) || str(avatar?.provider_avatar_id, 200);
  const voiceId = str(payload.voice_id, 200) || str(avatar?.voice_id, 200) || str(Deno.env.get("HEYGEN_DEFAULT_VOICE_ID"), 200);
  if (!avatarId) throw new Error("AVATAR_NOT_CONFIGURED");
  const script = str(payload.script_text, 4000) || await loadScript(str(job.project_id, 80) || null);
  if (!script) throw new Error("SCRIPT_MISSING");
  const speed = Math.min(Math.max(Number(payload.voice_speed) || 1, 0.5), 2);
  const voice: Json = { type: "text", input_text: script, speed };
  if (voiceId) voice.voice_id = voiceId;
  const body = {
    video_inputs: [{
      character: { type: "avatar", avatar_id: avatarId, avatar_style: "normal" },
      voice,
      background: { type: "color", value: str(payload.background_color, 20) || "#FFFFFF" },
    }],
    dimension: dimensions(str(payload.aspect_ratio, 10) || "9:16"),
    title: str(payload.title, 120) || `Reelora ${str(job.id, 40)}`,
  };
  const res = await fetch("https://api.heygen.com/v2/video/generate", {
    method: "POST", headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(raw) as Json; } catch { /* handled below */ }
  if (!res.ok) {
    const detail = str((parsed.error as Json | undefined)?.message, 300) || str(parsed.message, 300) || `HTTP ${res.status}`;
    throw new Error(`HEYGEN_SUBMIT_ERROR: ${detail}`);
  }
  const data = (parsed.data ?? {}) as Json;
  const id = str(data.video_id, 200);
  if (!id) throw new Error("HEYGEN_SUBMIT_ERROR: video_id absent de la réponse");
  return { id, extra: { provider_script: script, avatar_id: avatarId, voice_id: voiceId } };
}

async function heygenStatus(providerJobId: string): Promise<{ state: string; url?: string; error?: string }> {
  const key = Deno.env.get("HEYGEN_API_KEY");
  if (!key) throw new Error("HEYGEN_NOT_CONFIGURED");
  const res = await fetch(`https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(providerJobId)}`, {
    headers: { "X-Api-Key": key }, signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(raw) as Json; } catch { /* handled below */ }
  if (!res.ok) throw new Error(`HEYGEN_STATUS_ERROR: HTTP ${res.status}`);
  const data = (parsed.data ?? {}) as Json;
  const state = str(data.status, 40).toLowerCase();
  if (state === "completed") return { state: "completed", url: str(data.video_url, 2000) };
  if (state === "failed") return { state: "failed", error: str(data.error, 400) || "Le fournisseur a signalé un échec" };
  return { state: state || "processing" };
}

async function submitFal(job: Json, payload: Json): Promise<{ id: string; extra: Json }> {
  const key = Deno.env.get("FAL_KEY");
  if (!key) throw new Error("FAL_NOT_CONFIGURED");
  const model = str(payload.model, 200) || str(Deno.env.get("FAL_MODEL"), 200) || "fal-ai/kling-video/v1.6/standard/image-to-video";
  const avatar = await loadAvatar(str(payload.avatar_id, 80) || null);
  let imageUrl = str(payload.image_url, 2000) || str(avatar?.preview_url, 2000);
  if (!imageUrl && str(avatar?.preview_storage_path, 500)) {
    imageUrl = (await signStoragePath(str(avatar?.preview_storage_path, 500))) ?? "";
  }
  if (!imageUrl) throw new Error("IMAGE_MISSING");
  const script = str(payload.script_text, 4000) || await loadScript(str(job.project_id, 80) || null);
  const prompt = str(payload.visual_prompt, 1200) || `Vidéo UGC verticale authentique, personne présentant le produit face caméra, lumière naturelle. ${script.slice(0, 400)}`;
  const res = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST", headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: { prompt, image_url: imageUrl, duration: str(payload.fal_duration, 10) || "5" } }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(raw) as Json; } catch { /* handled below */ }
  if (!res.ok) {
    const detail = str(parsed.detail, 300) || str(parsed.error, 300) || str(parsed.message, 300) || `HTTP ${res.status}`;
    throw new Error(`FAL_SUBMIT_ERROR: ${detail}`);
  }
  const id = str(parsed.request_id, 200);
  if (!id) throw new Error("FAL_SUBMIT_ERROR: request_id absent de la réponse");
  return {
    id,
    extra: {
      fal_model: model,
      fal_status_url: str(parsed.status_url, 1000) || `https://queue.fal.run/${model}/requests/${id}/status`,
      fal_response_url: str(parsed.response_url, 1000) || `https://queue.fal.run/${model}/requests/${id}`,
    },
  };
}

async function falStatus(payload: Json, providerJobId: string): Promise<{ state: string; url?: string; error?: string }> {
  const key = Deno.env.get("FAL_KEY");
  if (!key) throw new Error("FAL_NOT_CONFIGURED");
  const statusUrl = str(payload.fal_status_url, 1000) || `https://queue.fal.run/${str(payload.fal_model, 200) || "fal-ai/kling-video/v1.6/standard/image-to-video"}/requests/${providerJobId}/status`;
  const res = await fetch(statusUrl, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30000) });
  const raw = await res.text();
  let parsed: Json = {};
  try { parsed = JSON.parse(raw) as Json; } catch { /* handled below */ }
  if (!res.ok) throw new Error(`FAL_STATUS_ERROR: HTTP ${res.status}`);
  const state = str(parsed.status, 40).toUpperCase();
  if (state === "FAILED") return { state: "failed", error: str(parsed.error, 400) || "Le fournisseur a signalé un échec" };
  if (state !== "COMPLETED") return { state: state.toLowerCase() || "processing" };
  const responseUrl = str(payload.fal_response_url, 1000) || `https://queue.fal.run/${str(payload.fal_model, 200) || "fal-ai/kling-video/v1.6/standard/image-to-video"}/requests/${providerJobId}`;
  const resultRes = await fetch(responseUrl, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(30000) });
  const resultRaw = await resultRes.text();
  if (!resultRes.ok) throw new Error(`FAL_RESULT_ERROR: HTTP ${resultRes.status}`);
  let result: Json = {};
  try { result = JSON.parse(resultRaw) as Json; } catch { /* handled below */ }
  const data = (result.data ?? result) as Json;
  const video = (data.video ?? {}) as Json;
  const url = str(video.url, 2000) || str(data.video_url, 2000);
  if (!url) throw new Error("FAL_RESULT_ERROR: URL vidéo absente");
  return { state: "completed", url };
}

function providerFromBody(payload: Json): string {
  const requested = str(payload.provider, 30).toLowerCase();
  const configured = str(Deno.env.get("REELORA_VIDEO_PROVIDER"), 30).toLowerCase();
  return requested || configured || "heygen";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  const userJwt = req.headers.get("Authorization") ?? "";
  if (!userJwt.startsWith("Bearer ")) return fail("UNAUTHENTICATED", "Authentification requise.", 401);
  const userId = userIdFromJwt(userJwt);
  if (!userId) return fail("UNAUTHENTICATED", "Jeton utilisateur invalide.", 401);
  if (!SERVICE_KEY() || !SUPABASE_URL()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente côté serveur.", 500);

  let body: Json;
  try { body = await req.json() as Json; } catch { return fail("INVALID_BODY", "Corps de requête JSON invalide.", 400); }
  const action = str(body.action, 20);
  const jobId = str(body.job_id, 80);
  if (!jobId) return fail("INVALID_INPUT", "job_id requis.", 400);

  const job = await loadJob(jobId);
  if (!job) return fail("JOB_NOT_FOUND", "Tâche de génération introuvable.", 404);
  if (str(job.created_by, 80) !== userId) return fail("FORBIDDEN", "Cette tâche ne vous appartient pas.", 403);
  const status = str(job.status, 30);
  const requestPayload = (job.request_payload ?? {}) as Json;
  const providerJobId = str(job.provider_job_id, 300);
  const provider = str(job.provider, 30) || providerFromBody(requestPayload);

  try {
    if (action === "start") {
      if (["succeeded", "failed", "cancelled"].includes(status)) {
        return json({ job_id: jobId, status, provider, provider_job_id: providerJobId || null });
      }
      if (providerJobId) return json({ job_id: jobId, status, provider, provider_job_id: providerJobId });

      const wantedProvider = providerFromBody(requestPayload) || provider;
      const keyName = wantedProvider === "fal" ? "FAL_KEY" : "HEYGEN_API_KEY";
      if (!Deno.env.get(keyName)) {
        return await failJob(jobId, userJwt, "VIDEO_PROVIDER_NOT_CONFIGURED",
          `Le service de génération vidéo n'est pas configuré : ajoutez le secret ${keyName} (et REELORA_VIDEO_PROVIDER=${wantedProvider}) dans Supabase. Les crédits réservés ont été restitués.`);
      }

      let submitted: { id: string; extra: Json };
      try {
        submitted = wantedProvider === "fal" ? await submitFal(job, requestPayload) : await submitHeygen(job, requestPayload);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const friendly: Record<string, string> = {
          HEYGEN_NOT_CONFIGURED: "Clé HeyGen absente côté serveur.",
          FAL_NOT_CONFIGURED: "Clé fal.ai absente côté serveur.",
          AVATAR_NOT_CONFIGURED: "Sélectionnez un avatar avec un identifiant fournisseur valide avant de lancer la génération.",
          SCRIPT_MISSING: "Générez ou saisissez un script avant de lancer la vidéo.",
          IMAGE_MISSING: "Ajoutez une image de référence à l'avatar pour le mode fal.ai.",
        };
        const code = message.split(":")[0];
        return await failJob(jobId, userJwt, code, friendly[code] ?? `Le fournisseur vidéo a refusé la requête : ${message}`);
      }

      const merged = { ...requestPayload, ...submitted.extra, provider: wantedProvider };
      const updated = await rpcService("reelora_set_job_processing", {
        p_job_id: jobId, p_provider: wantedProvider, p_provider_job_id: submitted.id, p_request_payload: merged,
      });
      if (!updated.ok) return fail("JOB_UPDATE_ERROR", `Impossible de mettre à jour la tâche : ${updated.error}`, 500);
      return json({ job_id: jobId, status: "processing", provider: wantedProvider, provider_job_id: submitted.id });
    }

    if (action === "status") {
      if (["succeeded", "failed", "cancelled"].includes(status)) {
        return json({ job_id: jobId, status, provider, provider_job_id: providerJobId || null });
      }
      if (!providerJobId) {
        return json({ job_id: jobId, status, provider, provider_job_id: null, message: "Tâche non encore soumise au fournisseur." });
      }
      const createdAt = Date.parse(str(job.created_at, 40));
      if (Number.isFinite(createdAt) && Date.now() - createdAt > 45 * 60 * 1000) {
        await finalize(jobId, "failed", { error_message: "Délai d'attente dépassé (45 minutes)." });
        await rpcUser("reelora_refund_quota", { p_kind: "video", p_reference_id: jobId }, userJwt);
        return json({ job_id: jobId, status: "failed", error: "Délai d'attente dépassé." });
      }

      let result: { state: string; url?: string; error?: string };
      try {
        result = provider === "fal" ? await falStatus(requestPayload, providerJobId) : await heygenStatus(providerJobId);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // A transient polling error should not burn the job; report it and let the UI retry.
        return fail("PROVIDER_STATUS_ERROR", `Statut fournisseur indisponible : ${message}`, 502);
      }

      if (result.state === "failed") {
        await finalize(jobId, "failed", { error_message: result.error ?? "Échec du fournisseur vidéo." });
        await rpcUser("reelora_refund_quota", { p_kind: "video", p_reference_id: jobId }, userJwt);
        return json({ job_id: jobId, status: "failed", error: result.error });
      }
      if (result.state !== "completed" || !result.url) {
        return json({ job_id: jobId, status: "processing", provider_state: result.state, provider_job_id: providerJobId });
      }

      try {
        const stored = await uploadVideo(jobId, str(job.workspace_id, 80), result.url!);
        if (!stored) throw new Error("Stockage impossible");
        await finalize(jobId, "succeeded", {
          storage_path: stored.storage_path,
          file_size_bytes: stored.file_size_bytes,
          result_payload: { provider, provider_job_id: providerJobId, source_url: result.url },
        });
        return json({ job_id: jobId, status: "succeeded", storage_path: stored.storage_path, file_size_bytes: stored.file_size_bytes });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await failJob(jobId, userJwt, "ASSET_STORAGE_ERROR", `Vidéo générée mais stockage impossible : ${message}`);
        return fail("ASSET_STORAGE_ERROR", `Vidéo générée mais stockage impossible : ${message}`, 502);
      }
    }

    return fail("UNKNOWN_ACTION", "Action vidéo inconnue.", 400);
  } catch (error) {
    console.error("reelora-video", error);
    return fail("VIDEO_INTERNAL_ERROR", "Une erreur inattendue est survenue pendant la génération vidéo.", 500);
  }
});
