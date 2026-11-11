import postgres from 'npm:postgres@3.4.5';
import {
  createBusinessGrowHandler,
  NoVerifiedProviderRouteError,
  type BusinessGrowStore,
} from './handler.ts';
import type { WorkspaceCompanyContext } from './intelligence.ts';
import {
  callProvider,
  listRemoteModels,
  probeProvider,
  providerOrder,
  type BusinessProvider,
} from './providers.ts';

type Json = Record<string, unknown>;

function env(name: string): string {
  return Deno.env.get(name) ?? '';
}

const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const databaseUrl = env('BUSINESS_GROW_DATABASE_URL') || env('SUPABASE_DB_URL');

// Secrets Business Grow strictement séparés du Studio UGC.
const providerConfigs = {
  groq: {
    apiKey: env('BUSINESS_GROW_GROQ_API_KEY'),
    model: env('BUSINESS_GROW_GROQ_MODEL'),
  },
  gemini: {
    apiKey: env('BUSINESS_GROW_GEMINI_API_KEY'),
    model: env('BUSINESS_GROW_GEMINI_MODEL'),
  },
};
const configuredProviderOrder = providerOrder(env('BUSINESS_GROW_PROVIDER_ORDER') || 'groq,gemini');

const sql = databaseUrl
  ? postgres(databaseUrl, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: 'require',
      prepare: false,
      connection: { application_name: 'reelora-business-grow-edge' },
    })
  : null;

function requiredSql() {
  if (!sql) throw new Error('Business Grow database connection is not configured.');
  return sql;
}

async function authUserId(authorization: string): Promise<string | null> {
  if (!supabaseUrl || !anonKey) return null;
  const result = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (result.status === 401 || result.status === 403) return null;
  if (!result.ok) throw new Error('Supabase Auth request failed.');
  const user = await result.json() as Json;
  return typeof user.id === 'string' ? user.id : null;
}

/**
 * Aides de typage uniquement (aucun effet à l'exécution) :
 * `postgres` renvoie une RowList itérable là où le store expose des tableaux,
 * et `json()` attend un JSONValue plus strict que nos `Record<string, unknown>`.
 */
const asRows = (rows: unknown): unknown[] => rows as unknown[];
const asJsonValue = (value: unknown): never => value as never;

const store: BusinessGrowStore = {
  async listProviders() {
    const db = requiredSql();
    for (const key of ['groq', 'gemini'] as const) {
      const cfg = providerConfigs[key];
      const status = cfg?.apiKey && cfg?.model ? 'configured' : 'missing';
      try {
        await db`select saas_business.bg_sync_provider_config(${key}, ${status}, ${cfg?.model || null})`;
      } catch {
        // Ignore if optional sync helper is absent before extension migration.
      }
    }

    const providers = await db`select * from saas_business.bg_list_providers()`;
    return providers.map((provider: Record<string, unknown>) => {
      const key = provider.provider_key;
      const config = key === 'groq' || key === 'gemini'
        ? providerConfigs[key as BusinessProvider]
        : null;
      const verifiedModelKeys = Array.isArray(provider.verified_model_keys)
        ? provider.verified_model_keys as string[]
        : [];
      const runtimeModelVerified = Boolean(
        config?.apiKey && verifiedModelKeys.length > 0 && (!config.model || verifiedModelKeys.includes(config.model)),
      );
      return {
        ...provider,
        enabled: Boolean(provider.enabled && runtimeModelVerified),
        status: runtimeModelVerified ? provider.status : 'unverified',
        config_status: config?.apiKey && (config.model || verifiedModelKeys.length > 0) ? 'configured' : 'missing',
      };
    });
  },
  async recordHealthCheck(result) {
    const db = requiredSql();
    const cfgStatus = providerConfigs[result.providerKey as BusinessProvider]?.apiKey ? 'configured' : 'missing';
    try {
      await db`select saas_business.bg_sync_provider_config(${result.providerKey}, ${cfgStatus}, ${result.modelKey || null})`;
    } catch {
      // Optional before extension migration.
    }
    if (result.modelKey) {
      await db`
        select saas_business.bg_sync_verified_model(
          ${result.providerKey},
          ${result.modelKey},
          ${result.status},
          ${result.latencyMs},
          ${result.errorCode}
        )
      `;
    } else {
      await db`
        select saas_business.bg_record_health_check(
          ${result.providerKey}, null, ${result.status}, ${result.latencyMs}, ${result.errorCode}
        )
      `;
    }
  },
  async listModels(providerKey) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_models(${providerKey ?? null})`);
  },
  async listRoles() {
    return asRows(await requiredSql()`select * from saas_business.bg_list_roles()`);
  },
  async getRoutingPreferences(userId) {
    return asRows(await requiredSql()`select * from saas_business.bg_get_routing_preferences(${userId}::uuid)`);
  },
  async upsertRoutingPreference(userId, roleKey, options) {
    const [row] = await requiredSql()`
      select saas_business.bg_upsert_routing_preference(
        ${userId}::uuid,
        ${roleKey},
        ${options.selectionMode},
        ${options.preferredProviderKey},
        ${options.preferredModelKey},
        ${options.allowFallback}
      ) as id
    `;
    return row.id as string;
  },
  async getQuota(userId) {
    const [row] = await requiredSql()`select saas_business.bg_quota_status(${userId}::uuid) as quota`;
    return row.quota;
  },
  async reserveQuota(userId, requestId, amount, reason) {
    const [row] = await requiredSql()`
      select saas_business.bg_reserve_units(
        ${userId}::uuid, ${requestId}::uuid, ${amount}, ${reason}
      ) as quota
    `;
    return row.quota;
  },
  async captureQuota(userId, requestId, reserved, actual) {
    const [row] = await requiredSql()`
      select saas_business.bg_capture_units(
        ${userId}::uuid, ${requestId}::uuid, ${reserved}, ${actual}
      ) as quota
    `;
    return row.quota;
  },
  async releaseQuota(userId, requestId, amount, reason) {
    const [row] = await requiredSql()`
      select saas_business.bg_release_units(
        ${userId}::uuid, ${requestId}::uuid, ${amount}, ${reason}
      ) as quota
    `;
    return row.quota;
  },
  async listRecentRequests(userId, limit = 25) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_recent_requests(${userId}::uuid, ${limit})`);
  },
  async getWorkspaceContext(userId, workspaceId) {
    if (!workspaceId) return null;
    const [row] = await requiredSql()`
      select saas_business.bg_get_workspace_context(${userId}::uuid, ${workspaceId}::uuid) as ctx
    `;
    return (row?.ctx as WorkspaceCompanyContext | null) ?? null;
  },
  async createToolExecution(userId, conversationId, requestId, proposal) {
    const db = requiredSql();
    const [row] = await db`
      select saas_business.bg_create_tool_execution(
        ${userId}::uuid,
        ${conversationId}::uuid,
        ${requestId}::uuid,
        ${proposal.toolName},
        ${proposal.riskLevel},
        ${db.json({ summary: proposal.summary, ...proposal.arguments })}
      ) as id
    `;
    return row.id as string;
  },
  async listToolExecutions(userId, conversationId = null) {
    return asRows(await requiredSql()`
      select * from saas_business.bg_list_tool_executions(${userId}::uuid, ${conversationId}::uuid, 30)
    `);
  },
  async resolveToolExecution(userId, executionId, decision, outputResult = {}) {
    const db = requiredSql();
    const [row] = await db`
      select saas_business.bg_resolve_tool_execution(
        ${userId}::uuid,
        ${executionId}::uuid,
        ${decision},
        ${db.json(asJsonValue(outputResult))}
      ) as resolved
    `;
    return row.resolved as {
      id: string;
      tool_name: string;
      status: string;
      input_args?: Record<string, unknown>;
      output_result?: Record<string, unknown>;
    };
  },
  async listIntegrationConnections(userId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_integration_connections(${userId}::uuid)`);
  },
  async listConversations(userId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_conversations(${userId}::uuid, 50)`);
  },
  async listMessages(userId, conversationId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_messages(${userId}::uuid, ${conversationId}::uuid, 200)`);
  },
  async createConversation(userId, title, workspaceId) {
    const [row] = await requiredSql()`
      select saas_business.bg_create_conversation(
        ${userId}::uuid, ${title}, ${workspaceId}::uuid
      ) as id
    `;
    return row.id as string;
  },
  async renameConversation(userId, conversationId, title) {
    const [row] = await requiredSql()`
      select saas_business.bg_rename_conversation(
        ${userId}::uuid, ${conversationId}::uuid, ${title}
      ) as renamed
    `;
    return row.renamed as boolean;
  },
  async deleteConversation(userId, conversationId) {
    const [row] = await requiredSql()`
      select saas_business.bg_delete_conversation(
        ${userId}::uuid, ${conversationId}::uuid
      ) as deleted
    `;
    return row.deleted as boolean;
  },
  async getMemory(userId) {
    const [row] = await requiredSql()`
      select saas_business.bg_get_memory(${userId}::uuid) as memory
    `;
    return row.memory;
  },
  async setMemoryConsent(userId, enabled, policyVersion) {
    const [row] = await requiredSql()`
      select * from saas_business.bg_set_memory_consent(
        ${userId}::uuid, ${enabled}, ${policyVersion}
      )
    `;
    return row;
  },
  async saveMemoryProfile(userId, profile) {
    await requiredSql()`
      select saas_business.bg_upsert_memory_profile(
        ${userId}::uuid, ${requiredSql().json(asJsonValue(profile))}
      )
    `;
  },
  async putMemoryItem(userId, itemId, category, content) {
    const [row] = await requiredSql()`
      select saas_business.bg_put_memory_item(
        ${userId}::uuid,
        ${itemId}::uuid,
        ${category},
        ${requiredSql().json(asJsonValue(content))},
        'manual',
        null
      ) as id
    `;
    return row.id as string;
  },
  async deleteMemoryItem(userId, itemId) {
    const [row] = await requiredSql()`
      select saas_business.bg_delete_memory_item(
        ${userId}::uuid, ${itemId}::uuid
      ) as deleted
    `;
    return row.deleted as boolean;
  },
  async submitUserMessage(userId, conversationId, content, idempotencyKey, requestHash, roleKey = 'business_advisor') {
    const [row] = await requiredSql()`
      select * from saas_business.bg_submit_user_message(
        ${userId}::uuid, ${conversationId}::uuid, ${content},
        ${idempotencyKey}, ${requestHash}, ${roleKey}
      )
    `;
    return {
      requestId: row.request_id as string,
      inputMessageId: row.input_message_id as string,
      status: row.status as string,
      created: row.created as boolean,
    };
  },
  async startRequest(userId, requestId) {
    await requiredSql()`
      select saas_business.bg_start_request(${requestId}::uuid, ${userId}::uuid)
    `;
  },
  async selectRoute(
    userId,
    requestId,
    conversationId,
    attemptNumber,
    fallbackFromAttemptId,
    fallbackReason,
    preferredProviders,
    excludedProviders,
    preferredModelKey = null,
  ) {
    const [row] = await requiredSql()`
      select * from saas_business.bg_select_route(
        ${requestId}::uuid, ${userId}::uuid, ${conversationId}::uuid,
        ${attemptNumber}, ${fallbackFromAttemptId}::uuid, ${fallbackReason},
        ${requiredSql().array(preferredProviders, 25)}::text[],
        ${requiredSql().array(excludedProviders, 25)}::text[],
        ${preferredModelKey}
      )
    `;
    if (!row) throw new NoVerifiedProviderRouteError();
    return {
      attemptId: row.attempt_id as string,
      providerKey: row.provider_key as string,
      modelKey: row.model_key as string,
      providerModelKey: row.provider_model_key as string,
    };
  },
  async failRequest(userId, requestId, errorCode) {
    await requiredSql()`
      select saas_business.bg_fail_request(
        ${requestId}::uuid, ${userId}::uuid, ${errorCode}
      )
    `;
  },
  async finalizeAttempt(userId, requestId, attemptId, result) {
    if (result.status === 'succeeded') {
      if (!result.outputContent) throw new Error('Successful provider response is empty.');
      await requiredSql()`
        select saas_business.bg_complete_attempt(
          ${attemptId}::uuid, ${requestId}::uuid, ${userId}::uuid,
          ${result.outputContent}, ${result.inputTokens}, ${result.outputTokens},
          ${result.latencyMs}
        )
      `;
      return;
    }
    await requiredSql()`
      select saas_business.bg_finalize_attempt(
        ${attemptId}::uuid, ${requestId}::uuid, ${userId}::uuid,
        'failed', ${result.inputTokens}, ${result.outputTokens}, null, ${result.latencyMs}, ${result.errorCode}, null,
        null, ${result.finalizeRequest === false ? 'running' : 'failed'}, null
      )
    `;
  },
};

const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--saas-ugc-growth.netlify.app',
  'https://sbc-ai-agency-dashbord.netlify.app',
  'https://reelora.netlify.app',
  // Un aperçu de travail tourne sur un hôte `{port}-{sandbox}.e2b.app` dont
  // l'identifiant de sandbox change à chaque session : lister des identifiants
  // figés produisait un 403 ORIGIN_NOT_ALLOWED (« backend absent ou
  // injoignable ») dès qu'un nouvel aperçu était ouvert. CORS n'est pas une
  // frontière d'authentification ici : chaque requête exige un JWT VYORA.
  'https://*.e2b.app',
].join(',');

const allowedOrigins = (env('BUSINESS_GROW_ALLOWED_ORIGINS') || defaultAllowedOrigins)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

Deno.serve(createBusinessGrowHandler({
  store,
  getUserId: authUserId,
  allowedOrigins,
  providerConfigs,
  providerOrder: configuredProviderOrder,
  complete: callProvider,
  probe: probeProvider,
  discoverModels: listRemoteModels,
}));
