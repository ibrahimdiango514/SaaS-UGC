import postgres from 'npm:postgres@3.4.5';
import { createBusinessGrowHandler, type BusinessGrowStore } from './handler.ts';

type Json = Record<string, unknown>;

function env(name: string): string {
  return Deno.env.get(name) ?? '';
}

const supabaseUrl = env('SUPABASE_URL');
const anonKey = env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY');
const databaseUrl = env('BUSINESS_GROW_DATABASE_URL');

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
  if (!result.ok) return null;
  const user = await result.json() as Json;
  return typeof user.id === 'string' ? user.id : null;
}

const store: BusinessGrowStore = {
  async listProviders() {
    return await requiredSql()`select * from saas_business.bg_list_providers()`;
  },
  async listConversations(userId) {
    return await requiredSql()`select * from saas_business.bg_list_conversations(${userId}::uuid, 50)`;
  },
  async listMessages(userId, conversationId) {
    return await requiredSql()`select * from saas_business.bg_list_messages(${userId}::uuid, ${conversationId}::uuid, 200)`;
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
        ${userId}::uuid, ${requiredSql().json(profile)}
      )
    `;
  },
  async putMemoryItem(userId, itemId, category, content) {
    const [row] = await requiredSql()`
      select saas_business.bg_put_memory_item(
        ${userId}::uuid,
        ${itemId}::uuid,
        ${category},
        ${requiredSql().json(content)},
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
  async submitUserMessage(userId, conversationId, content, idempotencyKey, requestHash) {
    const [row] = await requiredSql()`
      select * from saas_business.bg_submit_user_message(
        ${userId}::uuid, ${conversationId}::uuid, ${content},
        ${idempotencyKey}, ${requestHash}, 'business_advisor'
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
  async selectRoute(userId, requestId, conversationId) {
    const [row] = await requiredSql()`
      select * from saas_business.bg_select_route(
        ${requestId}::uuid, ${userId}::uuid, ${conversationId}::uuid,
        1, null, null
      )
    `;
    return {
      attemptId: row.attempt_id as string,
      providerKey: row.provider_key as string,
      modelKey: row.model_key as string,
    };
  },
  async failRequest(userId, requestId, errorCode) {
    await requiredSql()`
      select saas_business.bg_fail_request(
        ${requestId}::uuid, ${userId}::uuid, ${errorCode}
      )
    `;
  },
  async finalizeAttempt(userId, requestId, attemptId, errorCode) {
    await requiredSql()`
      select saas_business.bg_finalize_attempt(
        ${attemptId}::uuid, ${requestId}::uuid, ${userId}::uuid,
        'failed', null, null, null, null, ${errorCode}, null,
        null, 'failed', null
      )
    `;
  },
};

const allowedOrigins = (env('BUSINESS_GROW_ALLOWED_ORIGINS') || 'http://localhost:5173,http://localhost:4173,https://reelora.netlify.app')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

Deno.serve(createBusinessGrowHandler({ store, getUserId: authUserId, allowedOrigins }));
