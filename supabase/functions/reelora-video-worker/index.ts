// VYORA MuAPI worker — SERVER-SIDE tracking, independent of any open browser tab.
//
// Two entry points (both protected by a Vault-stored shared token, verify_jwt = false
// because MuAPI itself cannot send a Supabase JWT):
//   POST ?mode=webhook&token=...   MuAPI completion callback (wake-up signal only)
//   POST ?mode=tick                 pg_cron / pg_net reconciliation (every minute)
//
// MuAPI does NOT document a signature scheme for webhooks. We therefore (1) require
// an unguessable per-deployment token in the URL, and (2) NEVER trust the callback
// body: the authoritative state is always re-read from
// GET /api/v1/predictions/{request_id}/result with our own x-api-key.
// https://muapi.ai/docs/webhooks · https://muapi.ai/docs/api-reference
//
// All credit capture/release goes through the existing SECURITY DEFINER RPCs, so
// repeated callbacks and overlapping cron ticks cannot double-charge or double-refund.

type Json = Record<string, unknown>;
const MUAPI_BASE = "https://api.muapi.ai";
const BUCKET = "ugc-assets";
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-reelora-worker-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function env(key: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? "";
}
const SUPABASE_URL = () => env("SUPABASE_URL");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");
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
function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface MuapiResult { state: string; outputs: string[]; error: string; cost: Json | null; id: string }
function parseResult(raw: Json): MuapiResult {
  const d = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Json;
  const outputs = Array.isArray(d.outputs)
    ? (d.outputs as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const video = (d.video && typeof d.video === "object" ? d.video : {}) as Json;
  if (!outputs.length && str(video.url, 2000)) outputs.push(str(video.url, 2000));
  return {
    state: str(d.status, 40).toLowerCase() || "unknown",
    outputs,
    error: str(d.error, 500) || str(raw.error, 500),
    cost: d.cost && typeof d.cost === "object" ? (d.cost as Json) : null,
    id: str(d.id, 300) || str(raw.id, 300),
  };
}
function providerActualCostUsd(cost: Json | null): number | null {
  if (!cost) return null;
  const currency = str(cost.currency ?? cost.cost_currency, 10).toUpperCase();
  const raw = cost.amount_usd ?? cost.cost_usd ?? (currency === "USD" ? cost.amount : null);
  const amount = typeof raw === "number" ? raw
    : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
async function updateProviderSpend(
  jobId: string,
  status: "succeeded" | "failed" | "cancelled",
  requestId: string,
  cost: Json | null,
): Promise<void> {
  try {
    const result = await rpcService("reelora_update_provider_spend", {
      p_job_id: jobId,
      p_status: status,
      p_provider_request_id: requestId || null,
      p_actual_cost_usd: providerActualCostUsd(cost),
      p_release: false,
      p_reason_code: null,
    });
    if (!result.ok || result.data !== true) {
      console.error("provider spend settlement failed", redact(result.error ?? "provider_spend_settlement_rejected"));
    }
  } catch (error) {
    console.error("provider spend settlement failed", redact(error instanceof Error ? error.message : String(error)));
  }
}
async function pollMuapi(requestId: string): Promise<MuapiResult> {
  const key = MUAPI_KEY();
  if (!key) throw new Error("MUAPI_NOT_CONFIGURED");
  const res = await fetch(
    `${MUAPI_BASE}/api/v1/predictions/${encodeURIComponent(requestId)}/result`,
    { headers: { "x-api-key": key }, signal: AbortSignal.timeout(30000) },
  );
  const raw = await res.text();
  let parsed: Json = {};
  try { parsed = raw ? JSON.parse(raw) as Json : {}; } catch { /* handled below */ }
  if (!res.ok) throw new Error(`MUAPI_POLL_ERROR: HTTP ${res.status}`);
  return parseResult(parsed);
}

async function uploadVideo(jobId: string, workspaceId: string, url: string): Promise<{ path: string; size: number }> {
  const video = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!video.ok) throw new Error(`Téléchargement de la vidéo impossible (HTTP ${video.status})`);
  const buffer = await video.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error("Le fichier vidéo retourné par MuAPI est vide");
  const path = `${workspaceId}/${jobId}.mp4`;
  const res = await fetch(`${SUPABASE_URL()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: svcHeaders({ "Content-Type": "video/mp4", "x-upsert": "true" }),
    body: buffer, signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`Stockage de la vidéo impossible (HTTP ${res.status})`);
  return { path, size: buffer.byteLength };
}
async function finalize(jobId: string, status: "succeeded" | "failed", opts: Json = {}): Promise<void> {
  const r = await rpcService("reelora_finalize_generation", {
    p_job_id: jobId, p_status: status,
    p_storage_path: opts.storage_path ?? null, p_mime_type: "video/mp4",
    p_file_size_bytes: opts.file_size_bytes ?? null,
    p_result_payload: opts.result_payload ?? {},
    p_error_message: opts.error_message ?? null,
  });
  if (!r.ok) console.error("finalize failed", redact(r.error ?? "unknown"));
}
async function releaseQuota(jobId: string, userId: string): Promise<void> {
  await rpcService("reelora_release_video_quota", { p_job_id: jobId, p_user_id: userId });
}

// Idempotent reconciliation of ONE job. The webhook payload is never trusted as
// the source of truth; only this server-side poll decides success/failure.
async function reconcile(job: Json): Promise<string> {
  const jobId = str(job.id ?? job.job_id, 80);
  const requestId = str(job.provider_job_id, 300);
  const userId = str(job.created_by, 80);
  if (!jobId || !requestId || !userId) return "invalid";
  const fresh = (await restService<Json>(`ugc_generation_jobs?id=eq.${encodeURIComponent(jobId)}&select=status,provider_job_id&limit=1`))[0];
  const current = str(fresh?.status, 30);
  if (["succeeded", "failed", "cancelled"].includes(current)) return "already_terminal";

  let result: MuapiResult;
  try { result = await pollMuapi(requestId); }
  catch (e) {
    // A transient poll error must not burn the job; the next cron tick retries.
    console.error("muapi poll", redact(e instanceof Error ? e.message : String(e)));
    return "poll_error";
  }

  if (result.state === "completed" && result.outputs.length) {
    try {
      const stored = await uploadVideo(jobId, str(job.workspace_id, 80), result.outputs[0]);
      await updateProviderSpend(jobId, "succeeded", requestId, result.cost);
      const requestPayload = job.request_payload && typeof job.request_payload === "object"
        ? job.request_payload as Json : {};
      await finalize(jobId, "succeeded", {
        storage_path: stored.path, file_size_bytes: stored.size,
        result_payload: {
          provider_status: result.state,
          params: requestPayload.params && typeof requestPayload.params === "object" ? requestPayload.params : {},
          visual_prompt: str(requestPayload.visual_prompt, 1000),
          mode: str(requestPayload.mode, 40),
          credits_reserved: Number(job.credits_reserved ?? 0),
        },
      });
      return "succeeded";
    } catch (e) {
      const message = redact(e instanceof Error ? e.message : String(e));
      await updateProviderSpend(jobId, "failed", requestId, result.cost);
      await finalize(jobId, "failed", { error_message: `La vidéo a été générée mais son enregistrement a échoué : ${message}` });
      await releaseQuota(jobId, userId);
      return "storage_failed";
    }
  }
  if (result.state === "failed" || result.state === "cancelled") {
    await updateProviderSpend(
      jobId,
      result.state === "cancelled" ? "cancelled" : "failed",
      requestId,
      result.cost,
    );
    await finalize(jobId, "failed", {
      error_message: "La génération a échoué. Les crédits réservés ont été restitués.",
    });
    await releaseQuota(jobId, userId);
    return "failed";
  }
  await rpcService("reelora_record_video_poll", {
    p_job_id: jobId, p_provider_status: result.state || "processing",
    p_next_poll_seconds: 30, p_cost: result.cost,
  });
  return "processing";
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);
  if (!SERVICE_KEY() || !SUPABASE_URL()) return fail("SERVER_NOT_CONFIGURED", "Configuration Supabase absente.", 500);

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "tick";
  const supplied = req.headers.get("x-reelora-worker-token") ?? url.searchParams.get("token") ?? "";
  const tokenRpc = await rpcService("reelora_worker_token", {});
  const expected = tokenRpc.ok ? str(tokenRpc.data, 200) : "";
  if (!expected || !constantTimeEqual(supplied, expected)) {
    return fail("UNAUTHORIZED", "Jeton worker invalide.", 401);
  }

  try {
    if (mode === "tick") {
      const tick = await rpcService("reelora_video_tick", { p_limit: 10 });
      if (!tick.ok) return fail("TICK_ERROR", redact(tick.error ?? "Reconciliation impossible."), 502);
      const data = (tick.data && typeof tick.data === "object" ? tick.data : {}) as Json;
      const due = Array.isArray(data.due) ? (data.due as Json[]) : [];
      const outcomes: string[] = [];
      for (const job of due) outcomes.push(await reconcile(job));
      return json({ mode, expired: data.expired ?? 0, checked: due.length, outcomes });
    }

    if (mode === "webhook") {
      let body: Json;
      try { body = await req.json() as Json; } catch { return fail("INVALID_BODY", "Corps JSON invalide.", 400); }
      const requestId = str(body.id ?? body.request_id ?? (body.data as Json | undefined)?.id, 300);
      if (!requestId) return json({ mode, ignored: true, reason: "missing_task_id" });
      const rows = await restService<Json>(
        `ugc_generation_jobs?provider_job_id=eq.${encodeURIComponent(requestId)}&provider=eq.muapi&select=*&limit=1`,
      );
      const job = rows[0];
      if (!job) return json({ mode, ignored: true, reason: "unknown_task" });
      const outcome = await reconcile(job);
      return json({ mode, request_id: requestId, outcome });
    }

    return fail("UNKNOWN_MODE", "Mode worker inconnu.", 400);
  } catch (error) {
    console.error("reelora-video-worker", redact(error instanceof Error ? error.message : String(error)));
    return fail("WORKER_INTERNAL_ERROR", "Erreur interne du suivi de génération.", 500);
  }
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
