import postgres from 'npm:postgres@3.4.5';
import {
  createBusinessGrowHandler,
  NoVerifiedProviderRouteError,
  type BusinessGrowStore,
} from './handler.ts';
import type { AgentMemoryItem, WorkspaceCompanyContext } from './intelligence.ts';
import type { WorkspaceCompanyContext } from './intelligence.ts';
import type { BusinessSnapshot } from './diagnostics.ts';
import {
  callProvider,
  listRemoteModels,
  probeProvider,
  providerOrder,
  type BusinessProvider,
  type ProviderConfig,
} from './providers.ts';

type Json = Record<string, unknown>;

function env(name: string): string {
  return Deno.env.get(name) ?? '';
}

const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const databaseUrl = env('BUSINESS_GROW_DATABASE_URL') || env('SUPABASE_DB_URL');

// Secrets Business Grow strictement séparés du Studio UGC.
// Les 5 nouveaux fournisseurs (VYORA AI CORE) restent INACTIFS tant que leur
// clé n'est pas présente : le registre ne les autorise qu'une fois configurés
// ET vérifiés par un test API réel.
const providerConfigs: Partial<Record<BusinessProvider, ProviderConfig>> = {
  groq: {
    apiKey: env('BUSINESS_GROW_GROQ_API_KEY'),
    model: env('BUSINESS_GROW_GROQ_MODEL'),
  },
  gemini: {
    apiKey: env('BUSINESS_GROW_GEMINI_API_KEY'),
    model: env('BUSINESS_GROW_GEMINI_MODEL'),
  },
  deepseek: {
    apiKey: env('BUSINESS_GROW_DEEPSEEK_API_KEY'),
    model: env('BUSINESS_GROW_DEEPSEEK_MODEL'),
  },
  mistral: {
    apiKey: env('BUSINESS_GROW_MISTRAL_API_KEY'),
    model: env('BUSINESS_GROW_MISTRAL_MODEL'),
  },
  grok: {
    apiKey: env('BUSINESS_GROW_GROK_API_KEY'),
    model: env('BUSINESS_GROW_GROK_MODEL'),
  },
  cloudflare: {
    apiKey: env('BUSINESS_GROW_CLOUDFLARE_API_TOKEN'),
    model: env('BUSINESS_GROW_CLOUDFLARE_MODEL'),
    accountId: env('BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID'),
  },
  openrouter: {
    apiKey: env('BUSINESS_GROW_OPENROUTER_API_KEY'),
    model: env('BUSINESS_GROW_OPENROUTER_MODEL'),
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
    // Synchronise l'état de configuration de TOUS les fournisseurs de la pile
    // VYORA AI CORE (pas seulement les historiques). Un fournisseur sans clé
    // passe à 'missing' et reste inactif (enabled=false) — comportement dormant.
    for (const [key, cfg] of Object.entries(providerConfigs)) {
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
      const config = providerConfigs[key as BusinessProvider] ?? null;
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
  /** Journal central des appels IA (A7). La fonction SECURITY DEFINER
   *  `vyora_ai_log_call` vérifie le périmètre ; EXECUTE réservé bg_edge. */
  async logAiCall(args) {
    await requiredSql()`
      select public.vyora_ai_log_call(
        ${args.space},
        ${args.userId}::uuid,
        ${args.workspaceId}::uuid,
        ${args.taskKey},
        ${args.providerKey},
        ${args.modelKey},
        ${args.providerModelKey},
        ${args.attemptNumber},
        ${args.status},
        ${args.errorCode},
        ${args.inputTokens},
        ${args.outputTokens},
        ${args.latencyMs},
        null,
        null,
        ${args.fallbackFrom}
      )
    `;
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
  async listScopedRecentRequests(userId, workspaceId, limit = 25) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_scoped_recent_requests(${userId}::uuid, ${workspaceId}::uuid, ${limit})`);
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
  async requestIntegrationConnection(userId, connectorKey, workspaceId) {
    const [row] = await requiredSql()`
      select saas_business.bg_request_integration_connection(
        ${userId}::uuid, ${connectorKey}, ${workspaceId}::uuid
      ) as status
    `;
    return row.status as string;
  },
  async cancelIntegrationRequest(userId, connectorKey) {
    const [row] = await requiredSql()`
      select saas_business.bg_cancel_integration_request(${userId}::uuid, ${connectorKey}) as cancelled
    `;
    return row.cancelled as boolean;
  },
  async disconnectIntegrationConnection(userId, connectorKey) {
    const [row] = await requiredSql()`
      select saas_business.bg_disconnect_integration_connection(${userId}::uuid, ${connectorKey}) as disconnected
    `;
    return row.disconnected as boolean;
  },
  async getWorkspaceProtocol(userId, workspaceId) {
    const [row] = await requiredSql()`select saas_business.bg_workspace_protocol(${userId}::uuid, ${workspaceId}::uuid) as protocol`;
    return row.protocol as string;
  },
  async resolveScopedAgentTool(userId, workspaceId, executionId, decision) {
    const [row] = await requiredSql()`select saas_business.bg_agent_resolve_scoped_tool(${userId}::uuid, ${workspaceId}::uuid, ${executionId}::uuid, ${decision}) as resolved`;
    return row.resolved;
  },
  async listScopedIntegrationConnections(userId, workspaceId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_scoped_integration_connections(${userId}::uuid, ${workspaceId}::uuid)`);
  },
  async requestScopedIntegrationConnection(userId, workspaceId, connectorKey) {
    const [row] = await requiredSql()`select saas_business.bg_request_scoped_integration_connection(${userId}::uuid, ${workspaceId}::uuid, ${connectorKey}) as status`;
    return row.status as string;
  },
  async cancelScopedIntegrationRequest(userId, workspaceId, connectorKey) {
    const [row] = await requiredSql()`select saas_business.bg_cancel_scoped_integration_request(${userId}::uuid, ${workspaceId}::uuid, ${connectorKey}) as cancelled`;
    return row.cancelled as boolean;
  },
  async disconnectScopedIntegrationConnection(userId, workspaceId, connectorKey) {
    const [row] = await requiredSql()`select saas_business.bg_disconnect_scoped_integration_connection(${userId}::uuid, ${workspaceId}::uuid, ${connectorKey}) as disconnected`;
    return row.disconnected as boolean;
  },
  async getConversationScope(userId, conversationId) {
    const [row] = await requiredSql()`select saas_business.bg_conversation_scope(${userId}::uuid, ${conversationId}::uuid) as scope`;
    return row.scope as { workspaceId: string | null } | null;
  },
  async listScopedConversations(userId, workspaceId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_scoped_conversations(${userId}::uuid, ${workspaceId}::uuid, 50)`);
  },
  async getScopedMemory(userId, workspaceId) {
    const [row] = await requiredSql()`select saas_business.bg_get_scoped_memory(${userId}::uuid, ${workspaceId}::uuid) as memory`;
    return row.memory;
  },
  async setScopedMemoryConsent(userId, workspaceId, enabled, policy) {
    const [row] = await requiredSql()`select * from saas_business.bg_set_scoped_memory_consent(${userId}::uuid, ${workspaceId}::uuid, ${enabled}, ${policy})`;
    return row;
  },
  async saveScopedMemoryProfile(userId, workspaceId, profile) {
    const db = requiredSql();
    await db`select saas_business.bg_upsert_scoped_memory_profile(${userId}::uuid, ${workspaceId}::uuid, ${db.json(asJsonValue(profile))})`;
  },
  async putScopedMemoryItem(userId, workspaceId, itemId, category, content) {
    const db = requiredSql();
    const [row] = await db`select saas_business.bg_put_scoped_memory_item(${userId}::uuid, ${workspaceId}::uuid, ${itemId}::uuid, ${category}, ${db.json(asJsonValue(content))}, 'manual', null) as id`;
    return row.id as string;
  },
  async deleteScopedMemoryItem(userId, workspaceId, itemId) {
    const [row] = await requiredSql()`select saas_business.bg_delete_scoped_memory_item(${userId}::uuid, ${workspaceId}::uuid, ${itemId}::uuid) as deleted`;
    return row.deleted as boolean;
  },
  async importLegacyMemory(userId, workspaceId) {
    const [row] = await requiredSql()`select saas_business.bg_import_legacy_memory(${userId}::uuid, ${workspaceId}::uuid) as result`;
    return row.result;
  },
  async listScopedModuleRecords(userId, workspaceId, category) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_scoped_module_records(${userId}::uuid, ${workspaceId}::uuid, ${category})`);
  },
  async createScopedModuleRecord(userId, workspaceId, category, data, dedupeKey) {
    const db = requiredSql();
    const [row] = await db`select saas_business.bg_create_scoped_module_record(${userId}::uuid, ${workspaceId}::uuid, ${category}, ${db.json(asJsonValue(data))}, ${dedupeKey}) as id`;
    return row.id as string;
  },
  async updateScopedModuleRecord(userId, workspaceId, category, recordId, data) {
    const db = requiredSql();
    const [row] = await db`select saas_business.bg_update_scoped_module_record(${userId}::uuid, ${workspaceId}::uuid, ${recordId}::uuid, ${category}, ${db.json(asJsonValue(data))}) as updated`;
    return row.updated as boolean;
  },
  async deleteScopedModuleRecord(userId, workspaceId, category, recordId) {
    const [row] = await requiredSql()`select saas_business.bg_delete_scoped_module_record(${userId}::uuid, ${workspaceId}::uuid, ${recordId}::uuid, ${category}) as deleted`;
    return row.deleted as boolean;
  },
  async confirmAutomationTask(userId, workspaceId, playbookId, sourceCategory, sourceId, previewDay, expectedPlaybook, expectedSource, task) {
    const db = requiredSql();
    const [row] = await db`select saas_business.bg_confirm_automation_task(
      ${userId}::uuid, ${workspaceId}::uuid, ${playbookId}::uuid, ${sourceCategory}, ${sourceId}::uuid,
      ${previewDay}::date, ${db.json(asJsonValue(expectedPlaybook))}, ${db.json(asJsonValue(expectedSource))}, ${db.json(asJsonValue(task))}
    ) as result`;
    return row.result as { taskId: string; created: boolean };
  },
  async getBusinessSnapshot(userId, workspaceId) {
    const [row] = await requiredSql()`select saas_business.bg_business_snapshot(${userId}::uuid, ${workspaceId}::uuid) as snapshot`;
    return row.snapshot as BusinessSnapshot;
  },
  async saveAgentReport(userId, workspaceId, type, from, to, idempotencyKey, report) {
    const db = requiredSql();
    const [row] = await db`select saas_business.bg_save_agent_report(${userId}::uuid, ${workspaceId}::uuid, ${type}, ${from}::date, ${to}::date, ${idempotencyKey}::uuid, ${db.json(asJsonValue(report))}) as result`;
    return row.result;
  },
  async listAgentReports(userId, workspaceId) {
    return asRows(await requiredSql()`select * from saas_business.bg_list_agent_reports(${userId}::uuid, ${workspaceId}::uuid)`);
  },
  async deleteAgentReport(userId, workspaceId, reportId) {
    const [row] = await requiredSql()`select saas_business.bg_delete_agent_report(${userId}::uuid, ${workspaceId}::uuid, ${reportId}::uuid) as deleted`;
    return row.deleted as boolean;
  },
  async proposeAgentTask(userId, workspaceId, conversationId, category, sourceId, idempotencyKey) {
    const [row] = await requiredSql()`select saas_business.bg_agent_propose_task(${userId}::uuid, ${workspaceId}::uuid, ${conversationId}::uuid, ${category}, ${sourceId}::uuid, ${idempotencyKey}::uuid) as result`;
    return row.result;
  },
  async resolveAgentTool(userId, executionId, decision) {
    const [row] = await requiredSql()`select saas_business.bg_agent_resolve_tool(${userId}::uuid, ${executionId}::uuid, ${decision}) as result`;
    return row.result;
  },
  async listModuleRecords(userId, category) {
    return asRows(await requiredSql()`
      select * from saas_business.bg_list_module_records(${userId}::uuid, ${category})
    `);
  },
  async createModuleRecord(userId, category, data, dedupeKey = null) {
    const db = requiredSql();
    const [row] = await db`
      select saas_business.bg_create_module_record(
        ${userId}::uuid,
        ${category},
        ${db.json(asJsonValue(data))},
        ${dedupeKey}
      ) as id
    `;
    return row.id as string;
  },
  async updateModuleRecord(userId, recordId, data) {
    const db = requiredSql();
    const [row] = await db`
      select saas_business.bg_update_module_record(
        ${userId}::uuid, ${recordId}::uuid, ${db.json(asJsonValue(data))}
      ) as updated
    `;
    return row.updated as boolean;
  },
  async deleteModuleRecord(userId, recordId) {
    const [row] = await requiredSql()`
      select saas_business.bg_delete_module_record(${userId}::uuid, ${recordId}::uuid) as deleted
    `;
    return row.deleted as boolean;
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
  // --- Mémoire persistante de l'agent (VYORA AI CORE) ------------------------
  // Chaque fonction est SECURITY DEFINER et contrôle l'appartenance
  // utilisateur/workspace (bg_assert_workspace_access) : l'Edge ne fait que
  // transmettre l'identifiant authentifié, jamais un périmètre arbitraire.
  async searchAgentMemory(userId, workspaceId, query, limit = 5) {
    const rows = await requiredSql()`
      select id::text as id, category, title, content, confidence
      from saas_business.ai_memory_search(
        ${userId}::uuid, ${workspaceId}::uuid, ${query}, null, ${limit}, null
      )
      order by score desc
    `;
    return asRows(rows) as AgentMemoryItem[];
  },
  async saveAgentMemory(userId, workspaceId, category, title, content, confidence, source, supersedes = null) {
    const [row] = await requiredSql()`
      select saas_business.ai_memory_save(
        ${userId}::uuid,
        ${workspaceId}::uuid,
        ${category},
        ${title},
        ${content},
        ${confidence},
        ${source},
        ${supersedes}::uuid
      ) as id
    `;
    return row.id as string;
  },
  async listAgentMemories(userId, workspaceId, category = null, limit = 20) {
    const rows = await requiredSql()`
      select id::text as id, category, title, content, confidence
      from saas_business.ai_memory_list(
        ${userId}::uuid, ${workspaceId}::uuid, ${category}, ${limit}
      )
      order by created_at desc
    `;
    return asRows(rows) as AgentMemoryItem[];
  },
  async forgetAgentMemory(userId, memoryId) {
    const [row] = await requiredSql()`
      select saas_business.ai_memory_forget(
        ${userId}::uuid, ${memoryId}::uuid
      ) as forgotten
    `;
    return row.forgotten as boolean;
  },
  async submitUserMessage(userId, conversationId, content, idempotencyKey, requestHash, roleKey = 'business_advisor') {
    const [row] = await requiredSql()`
      select * from saas_business.bg_submit_scoped_user_message(
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
  // Domaine de production actuel du SaaS (README, vérifié le 2026-11-12).
  'https://vyora-ugc.netlify.app',
  'https://saas-ugc-growth.netlify.app',
  'https://deploy-preview-*--saas-ugc-growth.netlify.app',
  // Aperçus de la branche de travail actuelle : leur nom porte le slug du
  // site Netlify (`vyora`), absent des motifs ci-dessus.
  'https://deploy-preview-*--vyora.netlify.app',
  'https://sbc-ai-agency-dashbord.netlify.app',
  'https://reelora.netlify.app',
  // Un aperçu de travail tourne sur un hôte `{port}-{sandbox}.e2b.app` dont
  // l'identifiant de sandbox change à chaque session : lister des identifiants
  // figés produisait un 403 ORIGIN_NOT_ALLOWED (« backend absent ou
  // injoignable ») dès qu'un nouvel aperçu était ouvert. CORS n'est pas une
  // frontière d'authentification ici : chaque requête exige un JWT VYORA.
  'https://*.e2b.app',
].join(',');

// Le secret `BUSINESS_GROW_ALLOWED_ORIGINS` s'AJOUTE à la liste par défaut au lieu
// de la remplacer : une valeur partielle (ou une rotation de secret) ne pouvait
// jusqu'ici retirer la production de la liste et produisait un 403
// ORIGIN_NOT_ALLOWED — donc « backend absent ou injoignable » côté SaaS alors que
// la fonction répondait. CORS n'est pas la frontière d'authentification : chaque
// requête exige encore un JWT VYORA valide.
const productionOrigins = ['https://vyora-ugc.netlify.app', 'https://*.e2b.app'];

const allowedOrigins = [
  ...defaultAllowedOrigins.split(','),
  ...productionOrigins,
  ...(env('BUSINESS_GROW_ALLOWED_ORIGINS') || '').split(','),
]
  .map((origin) => origin.trim())
  .filter(Boolean)
  .filter((origin, index, all) => all.indexOf(origin) === index);

Deno.serve(createBusinessGrowHandler({
  store,
  getUserId: authUserId,
  allowedOrigins,
  providerConfigs,
  providerOrder: configuredProviderOrder,
  complete: (provider, config, messages, meta) => callProvider(provider, config, messages, fetch, undefined, meta),
  probe: probeProvider,
  discoverModels: listRemoteModels,
}));
