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
  parseRegistrySnapshot,
  runAiCall,
  resolveConfiguredProvidersFromSnapshot,
  routingLogPayload,
  buildAiChain,
  type AiCallOutcome,
  type AiCallRequest,
  type AiEngineDeps,
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
  const kind = (['openai', 'none'] as const).includes(kindRaw as never)
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

/* -------------------------------------------------------------------------- */
/* Diagnostic du ROUTAGE réel                                                  */
/*                                                                             */
/* La sonde prouve qu'un fournisseur répond ; elle ne prouve pas que le moteur */
/* le CHOISIT. Or le routeur écarte un fournisseur absent de l'ensemble des    */
/* « configurés » (`buildAiChain`, filtre dur n°1) — un fournisseur sain peut  */
/* donc rester inatteignable. Cette action exécute la vraie chaîne de décision */
/* du moteur avec le registre réel, et n'appelle le fournisseur QUE si         */
/* l'opérateur le demande explicitement (`call: true`).                        */
/* -------------------------------------------------------------------------- */

/** Snapshot du registre, lu côté serveur (aucun secret dans la réponse). */
async function loadRegistrySnapshot(): Promise<ReturnType<typeof parseRegistrySnapshot>> {
  const res = await rpc('vyora_ai_registry_snapshot', {});
  if (!res.ok) return null;
  return parseRegistrySnapshot(res.data);
}

/**
 * Dépendances du moteur, identiques à celles de l'hôte `vyora-ai`.
 *
 * `configuredProviders` reste VIDE : le moteur complète l'ensemble en lisant
 * `api_key_env` au registre et sa valeur dans les secrets Edge. On ne duplique
 * donc ici aucune liste de fournisseurs — c'est précisément ce que ce
 * diagnostic doit mesurer.
 */
function aiEngineDeps(outcomeBox: { outcome: AiCallOutcome | null }): AiEngineDeps {
  return {
    // Un diagnostic ne consomme pas la chaîne entière : 2 tentatives au plus,
    // chacune bornée à 20 s (la fonction Edge plafonne à 150 s).
    maxAttempts: 2,
    requestTimeoutMs: 20_000,
    loadRegistry: loadRegistrySnapshot,
    configuredProviders: () => new Set<string>(),
    credentials: (providerKey) => {
      const names = legacyEnvNames(providerKey);
      return { apiKey: firstEnv(names.apiKey), accountId: firstEnv(names.accountId), gatewayId: null };
    },
    env: (name) => env(name) || null,
    fetcher: fetch,
    // `vyora_ai_log_call` attend des paramètres PLATS (un appel par tentative),
    // pas un jsonb : un payload groupé serait rejeté et la dépense réelle
    // resterait invisible.
    logCall: async (entry) => {
      if (!entry.attempts.length) return;
      const lastSuccess = entry.attempts.length - 1;
      for (let i = 0; i < entry.attempts.length; i += 1) {
        const attempt = entry.attempts[i];
        await rpc('vyora_ai_log_call', {
          p_space: entry.space,
          p_user_id: entry.userId,
          p_workspace_id: entry.workspaceId,
          p_task_key: entry.taskKey,
          p_provider_key: attempt.providerKey,
          p_model_key: attempt.modelKey,
          p_provider_model_key: attempt.providerModelKey,
          p_attempt_number: attempt.attempt,
          p_status: attempt.status,
          p_error_code: attempt.errorCode,
          p_input_tokens: attempt.inputTokens,
          p_output_tokens: attempt.outputTokens,
          p_latency_ms: attempt.latencyMs,
          p_cost_input_usd: attempt.status === 'success' && i === lastSuccess ? entry.costInputUsd : null,
          p_cost_output_usd: attempt.status === 'success' && i === lastSuccess ? entry.costOutputUsd : null,
          p_fallback_from: i > 0 ? entry.attempts[i - 1].providerKey : null,
        });
      }
    },
    logRouting: async (entry) => {
      await rpc('vyora_ai_log_routing', { p_payload: routingLogPayload(entry) });
    },
    // Idempotence : la clé vient de l'appelant. Sans clé, rien n'est réservé —
    // et donc rien n'est bloqué.
    claimCall: async (requestKey, meta) => {
      const res = await rpc('vyora_ai_claim_call', {
        p_request_key: requestKey,
        p_space: meta.space,
        p_user_id: meta.userId,
        p_workspace_id: meta.workspaceId,
      });
      void outcomeBox;
      const row = Array.isArray(res.data) ? (res.data[0] as Json | undefined) : (res.data && typeof res.data === 'object' ? res.data as Json : undefined);
      if (!res.ok || !row || typeof row.claimed !== 'boolean') throw new Error('AI_IDEMPOTENCY_UNAVAILABLE');
      return {
        claimed: row.claimed === true,
        status: typeof row.status === 'string' ? row.status : 'in_flight',
        providerKey: typeof row.provider_key === 'string' ? row.provider_key : null,
        modelKey: typeof row.model_key === 'string' ? row.model_key : null,
        outcomeCode: typeof row.outcome_code === 'string' ? row.outcome_code : null,
      };
    },
    releaseCall: async (params) => {
      await rpc('vyora_ai_release_call', {
        p_request_key: params.requestKey,
        p_status: params.status,
        p_provider_key: params.providerKey,
        p_model_key: params.modelKey,
        p_outcome_code: params.outcomeCode,
        p_content_chars: params.contentChars,
      });
    },
  };
}

/** Noms de variables historiques d'un fournisseur (aucune valeur). */
function legacyEnvNames(providerKey: string): { apiKey: string[]; accountId: string[] } {
  const upper = providerKey.replace(/[^a-z0-9]+/gi, '_').toUpperCase();
  return {
    apiKey: [
      `BUSINESS_GROW_${upper}_API_KEY`,
      `BUSINESS_GROW_${upper}_API_TOKEN`,
      `${upper}_API_KEY`,
      `${upper}_API_TOKEN`,
    ],
    accountId: [`BUSINESS_GROW_${upper}_ACCOUNT_ID`, `${upper}_ACCOUNT_ID`],
  };
}

function firstEnv(names: string[]): string | null {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return null;
}

async function routeDiagnostic(body: Json): Promise<Response> {
  const roleKey = str(body.role, 60) || null;
  const preferProvider = str(body.prefer, 40).toLowerCase() || null;
  const levelRaw = str(body.level, 20);
  const level = (['fast', 'economy', 'advanced', 'specialized', 'fallback'] as const)
    .includes(levelRaw as never) ? (levelRaw as AiCallRequest['level'] & string) : null;
  // Fournisseurs à écarter (ex. dernier échec connu, ou ciblage d'un candidat
  // précis pour une vérification). Le moteur en fait une pénalité, pas un
  // retrait : la chaîne reste non vide.
  const avoidProviders = Array.isArray(body.avoid)
    ? body.avoid.filter((v): v is string => typeof v === 'string').slice(0, 8)
    : undefined;
  const wantCall = body.call === true;

  const snapshot = await loadRegistrySnapshot();
  if (!snapshot) {
    return fail('REGISTRY_UNAVAILABLE', 'Registre illisible : diagnostic de routage impossible.', 503);
  }

  const prompt = str(body.prompt, 2000)
    || 'Réponds uniquement par le mot OK. Ceci est un test de routage interne.';

  // Chaîne de décision, calculée par le routeur de production lui-même, avec la
  // résolution d'identifiants du moteur (aucune copie locale de la logique).
  const routeDeps = aiEngineDeps({ outcome: null });
  const { steps, skipReason } = buildAiChain(
    snapshot,
    {
      role: roleKey,
      level,
      requireCapabilities: Array.isArray(body.capabilities)
        ? body.capabilities.filter((c): c is string => typeof c === 'string').slice(0, 8)
        : undefined,
      preferProvider,
      avoidProviders,
      minContextTokens: null,
      maxCostInPerMtok: null,
    },
    resolveConfiguredProvidersFromSnapshot(snapshot, routeDeps),
  );

  const report: Json = {
    role: roleKey,
    prefer: preferProvider,
    avoid: avoidProviders ?? [],
    level,
    call_requested: wantCall,
    skip_reason: skipReason,
    // La chaîne complète, dans l'ordre où le moteur l'essaierait.
    chain: steps.map((step, index) => ({
      rank: index + 1,
      provider: step.providerKey,
      model: step.modelKey,
      provider_model: step.providerModelKey,
      score: step.score,
      reason: step.reason,
      cost_in: step.costIn,
      cost_out: step.costOut,
    })),
    executed: null as Json | null,
  };

  if (!wantCall) {
    // Dry-run par défaut : aucune requête fournisseur, aucune facturation.
    report.note = steps.length > 0
      ? 'Chaîne calculée sans appel : `call: true` exécute la vraie complétion.'
      : 'Aucun modèle compatible : voir skip_reason.';
    return json({ service: 'vyora-ai-providers', action: 'route', dry_run: true, ...report });
  }

  if (skipReason) {
    return json({ service: 'vyora-ai-providers', action: 'route', dry_run: false, ...report });
  }

  const box: { outcome: AiCallOutcome | null } = { outcome: null };
  const deps = aiEngineDeps(box);
  const outcome = await runAiCall(deps, {
    messages: [{ role: 'user', content: prompt }],
    options: { maxOutputTokens: 16, temperature: 0 },
    role: roleKey,
    level,
    preferProvider,
    avoidProviders,
    space: 'system',
    userId: null,
    taskKey: roleKey ?? 'route_diagnostic',
    // Clé d'idempotence : un rejeu ne rappelle jamais le fournisseur.
    requestKey: `diag:${roleKey ?? 'auto'}:${Date.now()}`,
  });
  box.outcome = outcome;

  report.executed = {
    ok: outcome.ok,
    code: outcome.code,
    provider: outcome.providerKey,
    model: outcome.modelKey,
    provider_model: outcome.providerModelKey,
    http_status: null,
    content_chars: outcome.content !== null ? outcome.content.length : null,
    input_tokens: outcome.inputTokens,
    output_tokens: outcome.outputTokens,
    estimated_cost_usd: outcome.estimatedCostUsd,
    latency_ms: outcome.latencyMs,
    duplicate: outcome.duplicate === true,
    // Chaque tentative réelle, dans l'ordre : c'est la preuve du fallback.
    attempts: outcome.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      provider: attempt.providerKey,
      model: attempt.modelKey,
      status: attempt.status,
      error_code: attempt.errorCode,
      latency_ms: attempt.latencyMs,
      input_tokens: attempt.inputTokens,
      output_tokens: attempt.outputTokens,
      score: attempt.score,
      routed_by: attempt.routedBy,
    })),
  };

  return json({ service: 'vyora-ai-providers', action: 'route', dry_run: false, ...report });
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

  // Diagnostic du routage : lecture du registre + chaîne de décision, sans
  // toucher au catalogue ni au statut des fournisseurs.
  if (action === 'route') return routeDiagnostic(body);

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
      // A read-only discovery must not deactivate an existing provider.
      if (probeCompletion) await rpc('vyora_ai_record_probe', {
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
    // The legacy sync marks all unseen rows absent, and probeProvider does not
    // yet prove pagination completeness. Never mutate the catalog in read-only
    // mode. Also refuse to sync a truncated >400-model snapshot on legacy probes.
    if (probeCompletion && probe.catalogOk && probe.models.length > 0 && probe.models.length <= 400) {
      const payload = probe.models.map((model) => ({
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
      syncedModels = synced.ok && typeof synced.data === 'number' ? synced.data : 0;
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

    // In catalog-only mode, a null completion is not a failed completion.
    // The legacy RPC would disable the provider, so never write its verdict.
    if (probeCompletion) await rpc('vyora_ai_record_probe', {
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
      status: !probeCompletion ? (completion.catalogOk ? 'catalog_accessible' : 'catalog_inaccessible')
        : completion.completionOk === true ? 'healthy' : completion.catalogOk ? 'degraded' : 'failed',
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

runtimeGlobal.__vyoraAiProvidersHandler = handler;
runtimeGlobal.Deno?.serve?.(handler);
