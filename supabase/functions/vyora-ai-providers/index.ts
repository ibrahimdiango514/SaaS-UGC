// VYORA — intégration des fournisseurs IA : sonde RÉELLE et synchronisation
// du catalogue (phase 1, 2026-11-14).
//
// Cette fonction ne fait qu'une chose : appeler RÉELLEMENT chaque fournisseur
// configuré (lecture de catalogue, puis une complétion minimale bornée à
// 16 jetons), puis écrire le verdict au registre. Elle ne génère aucun contenu
// produit : aucune dépense inutile, aucune réponse inventée.
//
// Ce qu'elle N'ÉCRIT JAMAIS : une clé. Les secrets sont lus par leur NOM
// (`api_key_env` / `account_id_env` / `gateway_id_env` du registre), restent en
// mémoire le temps d'un appel HTTP, et ne sortent ni dans la réponse, ni dans
// les journaux, ni en base.
//
// Ce qu'elle refuse de supposer :
//   * un fournisseur sans clé n'est pas sondé (il reste inactif) ;
//   * un jeton Cloudflare de passerelle ne fonctionne pas sur l'API REST, et
//     inversement : la sonde essaie la voie déclarée au registre, rien d'autre ;
//   * sans ACCOUNT_ID / GATEWAY_ID, elle renvoie un blocage explicite — elle ne
//     simule jamais une connexion fonctionnelle.
//
// Accès : jeton `service_role` (appel interne) OU jeton administrateur vérifié.

import {
  probeProvider,
  conversationalModels,
  pickProbeModel,
  type AiProbeDescriptor,
  type AiProbeResult,
} from '../_shared/ai-core/index.ts';

type Json = Record<string, unknown>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function env(key: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get?: (k: string) => string } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key) ?? g.process?.env?.[key] ?? '';
}

const SUPABASE_URL = () => env('SUPABASE_URL');
const SERVICE_KEY = () => env('SUPABASE_SERVICE_ROLE_KEY');
const ANON_KEY = () => env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function fail(code: string, message: string, status = 400): Response {
  return json({ error: { code, message } }, status);
}
function rec(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}
function str(value: unknown, max = 4000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function rpc(name: string, body: Json, token = SERVICE_KEY()): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, data };
}

/** Descripteur de registre → descripteur de sonde (aucun secret ici). */
function toProbeDescriptor(row: Json): AiProbeDescriptor {
  const kindRaw = str(row.adapter_kind, 20);
  const kind = (['openai', 'gemini', 'cloudflare', 'none'] as const).includes(kindRaw as never)
    ? (kindRaw as AiProbeDescriptor['kind'])
    : 'openai';
  return {
    key: str(row.key, 40),
    kind,
    baseUrl: str(row.base_url, 300),
    modelsUrl: str(row.models_url, 300) || null,
    apiKeyEnv: str(row.api_key_env, 80) || null,
    accountIdEnv: str(row.account_id_env, 80) || null,
    transport: str(row.transport, 20) === 'gateway' ? 'gateway' : 'rest',
    headers: Object.fromEntries(
      Object.entries(rec(row.headers)).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>,
  };
}

/**
 * Identifiants d'un fournisseur, résolus par NOM depuis les secrets Edge.
 * `partial` liste les variables attendues mais absentes — sans jamais exposer
 * une valeur.
 */
function credentialsFor(row: Json): {
  credentials: { apiKey: string | null; accountId: string | null; gatewayId: string | null };
  missing: string[];
} {
  const apiKeyEnv = str(row.api_key_env, 80);
  const accountIdEnv = str(row.account_id_env, 80);
  const gatewayIdEnv = str(row.gateway_id_env, 80);
  const apiKey = apiKeyEnv ? env(apiKeyEnv) || null : null;
  const accountId = accountIdEnv ? env(accountIdEnv) || null : null;
  const gatewayId = gatewayIdEnv ? env(gatewayIdEnv) || null : null;
  const missing: string[] = [];
  if (!apiKey) missing.push(apiKeyEnv || 'API_KEY_ENV_NON_DECLARE');
  if (accountIdEnv && !accountId) missing.push(accountIdEnv);
  if (gatewayIdEnv && !gatewayId) missing.push(gatewayIdEnv);
  return { credentials: { apiKey, accountId, gatewayId }, missing };
}

/** Jeton du job planifié, lu en base via une RPC réservée au service_role. */
async function expectedCronToken(): Promise<string> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/vyora_provider_health_cron_token`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return '';
  const data = (await res.json()) as unknown;
  return typeof data === 'string' ? data : '';
}

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAdmin(jwt: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/vyora_ai_admin_registry_get`, {
    method: 'POST',
    headers: { apikey: ANON_KEY(), Authorization: jwt, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  return res.ok;
}

// Exposé pour le chargeur de production (`new Function`) : le bundle n'a pas
// d'exports ES, il publie donc le handler sur l'objet global avant Deno.serve.
const runtimeGlobal = globalThis as unknown as {
  __vyoraAiProvidersHandler?: (req: Request) => Promise<Response>;
  Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void };
};

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return fail('UNAUTHENTICATED', 'Authentification requise.', 401);
  if (!SUPABASE_URL() || !SERVICE_KEY()) {
    return fail('SERVER_NOT_CONFIGURED', 'Configuration Supabase absente côté serveur.', 500);
  }

  const internal = authorization.trim() === `Bearer ${SERVICE_KEY()}`;
  let internalJob = false;
  if (!internal) {
    // Job planifié (pg_cron → pg_net) : jeton aléatoire de Vault, comparé en
    // temps constant. Aucun autre appelant ne peut déclencher une sonde.
    const supplied = authorization.replace(/^Bearer\s+/i, '').trim();
    if (supplied.length >= 32 && constantTimeEqual(supplied, await expectedCronToken())) {
      internalJob = true;
    } else if (!(await isAdmin(authorization))) {
      return fail('FORBIDDEN', 'Réservé à l’administration.', 403);
    }
  }

  let body: Json;
  try {
    body = rec(await req.json());
  } catch {
    return fail('INVALID_BODY', 'Corps JSON invalide.', 400);
  }

  const action = str(body.action, 40) || 'probe';

  // — Descripteurs : uniquement les fournisseurs de la phase d'intégration —
  const descriptorsRes = await rpc('vyora_ai_provider_descriptors', {});
  if (!descriptorsRes.ok) {
    return fail('REGISTRY_UNAVAILABLE', 'Descripteurs illisibles : migration de phase 1 absente ou droits insuffisants.', 503);
  }
  const descriptors = Array.isArray(descriptorsRes.data) ? (descriptorsRes.data as Json[]) : [];
  const requested = str(body.provider, 40).toLowerCase();
  const targets = requested
    ? descriptors.filter((row) => str(row.key, 40) === requested)
    : descriptors;
  if (requested && targets.length === 0) {
    return fail('PROVIDER_NOT_IN_PHASE', `Fournisseur « ${requested} » absent de la phase d’intégration.`, 404);
  }

  const probeCompletion = body.catalog_only !== true;
  const results: Json[] = [];

  for (const row of targets) {
    const key = str(row.key, 40);
    const descriptor = toProbeDescriptor(row);
    const { credentials, missing } = credentialsFor(row);

    if (!credentials.apiKey) {
      // Fournisseur non configuré : verdict écrit, AUCUN appel réseau.
      results.push({
        provider: key,
        status: 'not_configured',
        missing,
        catalog_models: 0,
        verified_model: null,
        message: 'Secret absent : aucun appel effectué, aucun statut inventé.',
      });
      await rpc('vyora_ai_record_probe', {
        p_payload: {
          provider_key: key,
          catalog_ok: false,
          completion_ok: null,
          error_code: 'PROVIDER_NOT_CONFIGURED',
          latency_ms: 0,
          reached: 'credentials',
        },
      });
      continue;
    }

    const probe: AiProbeResult = await probeProvider(
      descriptor,
      credentials,
      null,
      { fetcher: fetch, timeoutMs: 20_000, probeCompletion: false },
    );

    // Le catalogue est écrit AVANT le choix du modèle de test : on ne devine
    // jamais un identifiant de modèle, on le lit chez le fournisseur.
    let syncedModels = 0;
    if (probe.catalogOk && probe.models.length > 0) {
      const payload = probe.models.slice(0, 400).map((model) => ({
        model_key: model.modelKey,
        provider_model: model.providerModel,
        display_name: model.displayName,
        capabilities: model.capabilities,
        context_in: model.contextIn,
        max_out: model.maxOut,
        cost_in: model.costIn,
        cost_out: model.costOut,
        tier: model.tier,
        note: model.note,
      }));
      const synced = await rpc('vyora_ai_sync_catalog', { p_provider_key: key, p_models: payload });
      syncedModels = typeof synced.data === 'number' ? synced.data : probe.models.length;
    }

    // Modèle de test : un choix EXPLICITE de l'opérateur, sinon le modèle le
    // moins cher du catalogue réel. Jamais un identifiant deviné.
    // Déclaré au registre par l'opérateur (alias documenté absent du
    // catalogue), ou modèle imposé par l'appel. Une déclaration explicite n'est
    // pas une inférence : le catalogue reste la source par défaut.
    const preferred = str(body.model, 120) || str(row.probe_model, 120) || null;
    // Une déclaration EXPLICITE (opérateur ou appel) prime et n'est pas
    // confrontée au catalogue : c'est précisément le cas des alias documentés
    // que le fournisseur n'énumère pas (`default` chez LLM7). Le catalogue ne
    // sert qu'au choix AUTOMATIQUE, où aucune valeur n'est inventée.
    const probeModel = preferred
      || (probe.catalogOk ? pickProbeModel(conversationalModels(probe.models), null) : null);

    let completion: AiProbeResult = probe;
    if (probeCompletion && probe.catalogOk && probeModel) {
      completion = await probeProvider(
        descriptor,
        credentials,
        probeModel,
        { fetcher: fetch, timeoutMs: 25_000, probeCompletion: true },
      );
    }

    const errorCode = completion.completionOk === false
      ? completion.completionErrorCode
      : completion.catalogOk
        ? null
        : completion.catalogErrorCode;

    await rpc('vyora_ai_record_probe', {
      p_payload: {
        provider_key: key,
        catalog_ok: completion.catalogOk,
        completion_ok: completion.completionOk,
        error_code: errorCode,
        latency_ms: completion.latencyMs,
        probe_model: probeModel,
        reached: completion.reached,
        http_status: completion.completionHttpStatus,
        error_detail: completion.completionDetail,
      },
    });

    results.push({
      provider: key,
      transport: str(row.transport, 20) || 'rest',
      status: completion.completionOk === true
        ? 'healthy'
        : completion.catalogOk ? 'degraded' : 'failed',
      credentials_present: true,
      missing,
      catalog_http_status: completion.catalogHttpStatus,
      catalog_models: completion.models.length,
      catalog_models_synced: syncedModels,
      // Les identifiants réels, jamais les secrets.
      probe_model: probeModel,
      completion_ok: completion.completionOk,
      error_code: errorCode,
      // Preuve exploitable : statut HTTP + message réel du fournisseur.
      // `completionDetail` est déjà tronqué et purgé de tout secret côté sonde.
      http_status: completion.completionHttpStatus,
      error_detail: completion.completionDetail,
      latency_ms: completion.latencyMs,
      reached: completion.reached,
    });
  }

  return json({
    service: 'vyora-ai-providers',
    action,
    via: internalJob ? 'pg_cron' : internal ? 'service_role' : 'admin',
    phase: 'phase-1-2026-11-14',
    catalog_only: !probeCompletion,
    probed_at: new Date().toISOString(),
    results,
  });
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };

runtimeGlobal.__vyoraAiProvidersHandler = handler;
runtimeGlobal.Deno?.serve?.(handler);
