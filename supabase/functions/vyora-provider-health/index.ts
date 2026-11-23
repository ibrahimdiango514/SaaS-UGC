// VYORA — surveillance planifiée du fournisseur IA central (FreeLLMAPI).
//
// Appelée uniquement par le job pg_cron `vyora-provider-health-*` via pg_net.
// Deux protections, dans cet ordre :
//   1. `verify_jwt = false` (comme `reelora-video-worker`) : le job ne peut pas
//      présenter un JWT utilisateur. L'authentification repose sur un jeton
//      aléatoire de 256 bits stocké dans Supabase Vault ; il est comparé à temps
//      constant et n'est jamais journalisé ni renvoyé.
//   2. `x-vyora-cron: provider-health` obligatoire : une requête sans cet en-tête
//      est rejetée avant même la lecture du Vault.
//
// AUCUNE GÉNÉRATION : ce service ne lit que le catalogue du fournisseur
// (GET /models) pour vérifier la clé et le modèle configuré. Il n'appelle jamais
// un endpoint de complétion, ne consomme aucun quota, n'écrit aucun crédit.
//
// AUCUN FOURNISSEUR EN DUR : les cibles viennent des descripteurs du registre
// (`vyora_ai_provider_descriptors()`), protocole `openai` uniquement. Un
// fournisseur ajouté au registre est surveillé sans modification de ce fichier.
//
// Le verdict est écrit par la RPC `vyora_record_provider_verification`
// (service_role) : le routage voit exactement le même état que via `providers.verify`.

type Json = Record<string, unknown>;

const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-vyora-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function env(name: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name] ?? "";
}

const SUPABASE_URL = () => env("SUPABASE_URL");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");

interface DescriptorRow {
  key: string;
  kind: string;
  baseUrl: string | null;
  modelsUrl: string | null;
  apiKeyEnv: string | null;
  transport: string | null;
  headers: Record<string, string>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Jeton attendu, lu en base via une RPC réservée au service_role. */
async function expectedToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/vyora_provider_health_cron_token`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return "";
  const data = (await res.json()) as unknown;
  return typeof data === "string" ? data : "";
}

/** Écrit le verdict : santé (vue par le routage) + historique détaillé. */
async function recordVerification(payload: Json): Promise<{ ok: boolean; detail: unknown }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/vyora_record_provider_verification`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let detail: unknown = text;
  try { detail = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  return { ok: res.ok, detail };
}

/** Lecture des descripteurs du registre central (source de vérité unique). */
async function loadDescriptors(): Promise<DescriptorRow[]> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/vyora_ai_provider_descriptors`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  const out: DescriptorRow[] = [];
  for (const raw of data) {
    const row = (raw ?? {}) as Json;
    const key = typeof row.key === "string" ? row.key.trim().toLowerCase() : "";
    if (!key) continue;
    const headers: Record<string, string> = {};
    if (row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)) {
      for (const [name, value] of Object.entries(row.headers as Json)) {
        if (typeof value === "string") headers[name] = value;
      }
    }
    out.push({
      key,
      kind: typeof row.adapter_kind === "string" ? row.adapter_kind : "openai",
      baseUrl: typeof row.base_url === "string" ? row.base_url : null,
      modelsUrl: typeof row.models_url === "string" ? row.models_url : null,
      apiKeyEnv: typeof row.api_key_env === "string" ? row.api_key_env : null,
      transport: typeof row.transport === "string" ? row.transport : "rest",
      headers,
    });
  }
  return out;
}

interface CheckResult {
  providerKey: string;
  modelKey: string;
  status: "healthy" | "failed";
  latencyMs: number;
  errorCode: string | null;
  availableModels: string[];
  catalogHttpStatus: number | null;
  detail: Json;
}

function failure(
  providerKey: string,
  modelKey: string,
  errorCode: string,
  extra: Partial<CheckResult> = {},
): CheckResult {
  return {
    providerKey,
    modelKey,
    status: "failed",
    latencyMs: 0,
    errorCode,
    availableModels: [],
    catalogHttpStatus: null,
    detail: {},
    ...extra,
  };
}

/** URL de catalogue effective, déduite du descripteur (jamais inventée). */
function catalogUrlFor(descriptor: DescriptorRow): string | null {
  if (descriptor.modelsUrl) return descriptor.modelsUrl;
  if (!descriptor.baseUrl) return null;
  return `${descriptor.baseUrl.replace(/\/+$/, "")}/models`;
}

/** En-têtes de lecture du catalogue : Bearer, protocole OpenAI-compatible. */
function catalogHeaders(descriptor: DescriptorRow, apiKey: string): Record<string, string> {
  return { ...descriptor.headers, Authorization: `Bearer ${apiKey}` };
}

/** Identifiants de modèles d'un catalogue OpenAI-compatible. */
function listModelIds(payload: Json): string[] {
  const out: string[] = [];
  const root = payload.result && typeof payload.result === "object" ? (payload.result as Json) : payload;
  const rows = Array.isArray(root.data)
    ? (root.data as unknown[])
    : Array.isArray(root.models)
      ? (root.models as unknown[])
      : Array.isArray(root)
        ? (root as unknown[])
        : [];
  for (const row of rows) {
    const item = (row ?? {}) as Json;
    const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : null;
    if (id && !out.includes(id)) out.push(id);
  }
  return out.sort();
}

/**
 * Modèle attendu : conventions `<PRÉFIXE>_MODEL` et `<PRÉFIXE>_DEFAULT_MODEL`
 * DÉRIVÉES du nom de la variable de clé (ex. FREE_LLM_API_KEY → FREE_LLM_MODEL,
 * FREE_LLM_DEFAULT_MODEL). Un nom non standard ne fait jamais lire la clé
 * comme un modèle.
 */
function configuredModel(descriptor: DescriptorRow): string {
  const apiKeyEnv = descriptor.apiKeyEnv ?? "";
  const prefix = apiKeyEnv.replace(/_API_KEY$|_API_TOKEN$/, "");
  if (!prefix || prefix === apiKeyEnv) return "";
  return env(`${prefix}_MODEL`) || env(`${prefix}_DEFAULT_MODEL`);
}

/** Sonde d'un fournisseur du REGISTRE, pilotée par son descripteur. */
async function checkDescriptorProvider(descriptor: DescriptorRow): Promise<CheckResult> {
  const apiKey = descriptor.apiKeyEnv ? env(descriptor.apiKeyEnv) : "";
  const model = configuredModel(descriptor);
  if (!apiKey) return failure(descriptor.key, model, "PROVIDER_NOT_CONFIGURED");
  return await probeCatalog(descriptor, model, apiKey);
}

/** Lecture du catalogue : la seule requête envoyée (aucune génération). */
async function probeCatalog(
  descriptor: DescriptorRow,
  model: string,
  apiKey: string,
): Promise<CheckResult> {
  const url = catalogUrlFor(descriptor);
  if (!url) return failure(descriptor.key, model, "PROVIDER_ENDPOINT_MISSING", {
    detail: { missing: ["URL de catalogue absente du descripteur"] },
  });

  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: catalogHeaders(descriptor, apiKey),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403
        ? "PROVIDER_AUTH_FAILED"
        : res.status === 429
          ? "PROVIDER_RATE_LIMITED"
          : res.status >= 500
            ? "PROVIDER_UNAVAILABLE"
            : "PROVIDER_REQUEST_REJECTED";
      return failure(descriptor.key, model, code, {
        latencyMs, catalogHttpStatus: res.status,
        detail: { transport: descriptor.transport, catalog_url_host: new URL(url).host },
      });
    }
    const payload = (await res.json()) as Json;
    const availableModels = listModelIds(payload);
    const attribution = Object.keys(descriptor.headers).length > 0 ? descriptor.headers : null;
    const modelPresent = model ? availableModels.includes(model) : null;
    return {
      providerKey: descriptor.key,
      modelKey: model,
      // Un catalogue lisible vaut « healthy » ; sans modèle explicitement
      // configuré la présence n'est pas exigée (elle est inconnue).
      status: modelPresent === false ? "failed" : "healthy",
      latencyMs: Date.now() - startedAt,
      errorCode: modelPresent === false ? "PROVIDER_MODEL_MISSING" : null,
      availableModels,
      catalogHttpStatus: res.status,
      detail: { transport: descriptor.transport, catalog_url_host: new URL(url).host, catalog_headers: attribution },
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return failure(descriptor.key, model, timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR", {
      latencyMs: Date.now() - startedAt,
      detail: { transport: descriptor.transport },
    });
  }
}

// Exposé pour le chargeur de production (`new Function`) : le bundle n'a pas
// d'exports ES, il publie donc le handler sur l'objet global avant Deno.serve.
const runtimeGlobal = globalThis as unknown as {
  __vyoraProviderHealthHandler?: (req: Request) => Promise<Response>;
  Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void };
};

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Méthode non autorisée.", 405);

  // Rejet immédiat d'un client qui n'est pas le job planifié.
  if (req.headers.get("x-vyora-cron") !== "provider-health") {
    return fail("CRON_HEADER_REQUIRED", "En-tête de surveillance absent.", 403);
  }

  const authorization = req.headers.get("Authorization") ?? "";
  const supplied = authorization.replace(/^Bearer\s+/i, "").trim();
  if (supplied.length < 32) return fail("SERVICE_TOKEN_INVALID", "Jeton serveur invalide.", 401);

  let expected = "";
  try {
    expected = await expectedToken();
  } catch {
    return fail("SERVICE_TOKEN_UNAVAILABLE", "Jeton serveur indisponible.", 503);
  }
  if (!constantTimeEqual(supplied, expected)) {
    return fail("SERVICE_TOKEN_INVALID", "Jeton serveur invalide.", 401);
  }

  let body: Json;
  try { body = (await req.json()) as Json; } catch { return fail("INVALID_BODY", "Corps JSON invalide.", 400); }
  const requested = typeof body.providerKey === "string" ? body.providerKey.toLowerCase() : "";

  const descriptors = await loadDescriptors();
  const checks = descriptors.map((descriptor) => ({
    key: descriptor.key,
    descriptor,
    run: () => checkDescriptorProvider(descriptor),
  }));

  // Un fournisseur sans clé n'est pas sondé par défaut (il reste inactif) ;
  // une demande EXPLICITE le sonde pour obtenir un diagnostic lisible.
  const configured = (descriptor: DescriptorRow): boolean =>
    Boolean(descriptor.apiKeyEnv && env(descriptor.apiKeyEnv));

  const targets = checks.filter((check) => {
    if (requested) return check.key === requested;
    return configured(check.descriptor);
  });
  if (requested && targets.length === 0) {
    return fail("PROVIDER_UNKNOWN", `Fournisseur « ${requested} » inconnu du registre.`, 404);
  }

  const results = [];
  for (const target of targets) {
    const result = await target.run();
    let recorded: { ok: boolean; detail: unknown } = { ok: false, detail: "not_attempted" };
    try {
      recorded = await recordVerification({
        p_provider_key: result.providerKey,
        p_status: result.status,
        p_latency_ms: result.latencyMs,
        p_error_code: result.errorCode,
        p_provider_model_key: result.modelKey || null,
        p_http_status: result.catalogHttpStatus,
        p_attempt: 1,
        p_pg_net_request_id: null,
        p_detail: {
          via: "pg_cron",
          catalog_only: true,
          available_models: result.availableModels.slice(0, 40),
          ...result.detail,
        },
      });
    } catch {
      recorded = { ok: false, detail: "record_failed" };
    }
    results.push({
      providerKey: result.providerKey,
      modelKey: result.modelKey,
      status: result.status,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      catalogHttpStatus: result.catalogHttpStatus,
      transport: result.detail.transport ?? null,
      availableModelCount: result.availableModels.length,
      recorded: recorded.ok,
      recordDetail: recorded.detail,
    });
  }

  const failed = results.filter((result) => result.status !== "healthy");
  return json(
    {
      service: "vyora-provider-health",
      checked_at: new Date().toISOString(),
      catalog_only: true,
      results,
    },
    failed.length === 0 ? 200 : 502,
  );
}

// Deno-only bootstrap : exporter `handler` permet les tests Node/Vitest.
runtimeGlobal.__vyoraProviderHealthHandler = handler;
runtimeGlobal.Deno?.serve?.(handler);
