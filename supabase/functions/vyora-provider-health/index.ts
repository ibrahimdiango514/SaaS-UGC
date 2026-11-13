// VYORA — surveillance planifiée des fournisseurs IA (Groq, Gemini).
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
// Le prix éventuel d'un GET catalogue est documenté dans
// docs/surveillance-fournisseurs-cron.md.
//
// Le verdict est écrit par la RPC `vyora_record_provider_verification`
// (service_role) qui réutilise les fonctions de santé existantes : le routage
// Business Grow voit exactement le même état que via `providers.verify`.

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

// VYORA AI CORE — les 7 fournisseurs surveillés. La sonde est « catalogue
// only » : une simple lecture de la liste des modèles (aucune complétion,
// aucun contenu généré, coût nul). Un fournisseur SANS clé n'est pas sondé
// (il reste simplement inactif dans le registre, enabled=false).
const PROVIDERS = {
  groq: {
    keyVar: "BUSINESS_GROW_GROQ_API_KEY",
    modelVar: "BUSINESS_GROW_GROQ_MODEL",
    modelsUrl: () => "https://api.groq.com/openai/v1/models",
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.data) ? payload.data : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },
  },
  gemini: {
    keyVar: "BUSINESS_GROW_GEMINI_API_KEY",
    modelVar: "BUSINESS_GROW_GEMINI_MODEL",
    modelsUrl: () => "https://generativelanguage.googleapis.com/v1beta/models",
    modelsHeader: (key: string) => ({ "x-goog-api-key": key }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.models) ? payload.models : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).name : null))
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.replace(/^models\//, ""));
    },
  },
  deepseek: {
    keyVar: "BUSINESS_GROW_DEEPSEEK_API_KEY",
    modelVar: "BUSINESS_GROW_DEEPSEEK_MODEL",
    modelsUrl: () => "https://api.deepseek.com/models",
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.data) ? payload.data : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },
  },
  mistral: {
    keyVar: "BUSINESS_GROW_MISTRAL_API_KEY",
    modelVar: "BUSINESS_GROW_MISTRAL_MODEL",
    modelsUrl: () => "https://api.mistral.ai/v1/models",
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.data) ? payload.data : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },
  },
  grok: {
    keyVar: "BUSINESS_GROW_GROK_API_KEY",
    modelVar: "BUSINESS_GROW_GROK_MODEL",
    modelsUrl: () => "https://api.x.ai/v1/models",
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.data) ? payload.data : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },
  },
  openrouter: {
    keyVar: "BUSINESS_GROW_OPENROUTER_API_KEY",
    modelVar: "BUSINESS_GROW_OPENROUTER_MODEL",
    modelsUrl: () => "https://openrouter.ai/api/v1/models",
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const data = Array.isArray(payload.data) ? payload.data : [];
      return data
        .map((item) => (item && typeof item === "object" ? (item as Json).id : null))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    },
  },
  cloudflare: {
    keyVar: "BUSINESS_GROW_CLOUDFLARE_API_TOKEN",
    modelVar: "BUSINESS_GROW_CLOUDFLARE_MODEL",
    modelsUrl: () => {
      const account = env("BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID");
      return account
        ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/models`
        : null;
    },
    modelsHeader: (key: string) => ({ Authorization: `Bearer ${key}` }),
    listModels(payload: Json): string[] {
      const result = payload.result && typeof payload.result === "object" ? (payload.result as Json) : payload;
      const rows = Array.isArray(result.models) ? result.models : Array.isArray(result) ? result : [];
      const out: string[] = [];
      for (const row of rows) {
        const item = (row ?? {}) as Json;
        const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : null;
        if (id && !out.includes(id)) out.push(id);
      }
      return out;
    },
  },
} as const;

type ProviderKey = keyof typeof PROVIDERS;

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

async function checkProvider(providerKey: ProviderKey) {
  const provider = PROVIDERS[providerKey];
  const apiKey = env(provider.keyVar);
  const model = env(provider.modelVar);
  const startedAt = Date.now();

  if (!apiKey || !model) {
    return {
      providerKey,
      modelKey: model || "",
      status: "failed" as const,
      latencyMs: 0,
      errorCode: "PROVIDER_NOT_CONFIGURED",
      availableModels: [] as string[],
      catalogHttpStatus: null as number | null,
    };
  }

  const modelsUrl = provider.modelsUrl();
  if (!modelsUrl) {
    return {
      providerKey,
      modelKey: model,
      status: "failed" as const,
      latencyMs: 0,
      errorCode: "PROVIDER_NOT_CONFIGURED",
      availableModels: [] as string[],
      catalogHttpStatus: null as number | null,
    };
  }

  try {
    // GET catalogue uniquement : aucune complétion, aucun contenu généré.
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: provider.modelsHeader(apiKey),
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
      return {
        providerKey,
        modelKey: model,
        status: "failed" as const,
        latencyMs,
        errorCode: code,
        availableModels: [] as string[],
        catalogHttpStatus: res.status,
      };
    }
    const payload = (await res.json()) as Json;
    const availableModels = provider.listModels(payload).sort();
    const modelPresent = availableModels.includes(model);
    return {
      providerKey,
      modelKey: model,
      status: modelPresent ? ("healthy" as const) : ("failed" as const),
      latencyMs: Date.now() - startedAt,
      errorCode: modelPresent ? null : "PROVIDER_MODEL_MISSING",
      availableModels,
      catalogHttpStatus: res.status,
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      providerKey,
      modelKey: model,
      status: "failed" as const,
      latencyMs: Date.now() - startedAt,
      errorCode: timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
      availableModels: [] as string[],
      catalogHttpStatus: null as number | null,
    };
  }
}

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
  // Par défaut : tous les fournisseurs CONFIGURÉS (clé + modèle présents) —
  // un fournisseur sans clé n'est pas sondé : il reste inactif (enabled=false),
  // son état provient de la synchronisation de configuration, pas de la sonde.
  // Requête EXPLICITE pour un fournisseur connu : il est sondé même sans clé,
  // pour un diagnostic lisible (PROVIDER_NOT_CONFIGURED).
  const configuredKeys = (Object.keys(PROVIDERS) as ProviderKey[]).filter(
    (key) => Boolean(env(PROVIDERS[key].keyVar) && env(PROVIDERS[key].modelVar)),
  );
  const targets: ProviderKey[] = requested
    ? ((requested as string) in PROVIDERS ? [requested as ProviderKey] : configuredKeys)
    : configuredKeys;

  const results = [];
  for (const providerKey of targets) {
    const result = await checkProvider(providerKey);
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
const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
