import { supabase } from '../lib/supabase';
import { AppError, humanizeError } from '../lib/errors';
import type {
  AIBusinessChatRequest,
  AIExecuteRequest,
  AIExecuteResponse,
  AIHealthResponse,
  AIModelDefinition,
  AIProviderKey,
  AIProviderVerificationResponse,
  AIRequestLog,
  AIRoutingRuleRecord,
  AIRoutingPreference,
  AISpace,
  AITaskType,
  BGQuotaStatus,
  BusinessConversation,
  BusinessMemoryCategory,
  BusinessMemoryItem,
  BusinessMessage,
  BusinessProfile,
  BusinessToolExecution,
  ExternalConnectorPlatform,
  ExternalConnectorState,
} from './contracts';

type AnyResult = { data: unknown; error: { message?: string; code?: string } | null };

async function unwrap<T>(promise: PromiseLike<AnyResult>): Promise<T> {
  const { data, error } = await promise;
  if (error) {
    throw new AppError(humanizeError(error.message), error.code ?? 'DB_ERROR');
  }
  return data as T;
}

async function invokeAiEngine<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('reelora-ai-engine', { body });
  if (error) {
    let payload: { error?: { code?: string; message?: string } } | null = null;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx?.json) payload = await ctx.json() as { error?: { code?: string; message?: string } };
    } catch { /* non-JSON body */ }
    throw new AppError(
      payload?.error?.message || humanizeError(error.message),
      payload?.error?.code || 'AI_ENGINE_ERROR',
    );
  }
  return data as T;
}

// ============================================================================
// 1. Engine Health, Live Verification & Models
// ============================================================================

export async function getAIHealth(): Promise<AIHealthResponse> {
  return invokeAiEngine<AIHealthResponse>({ action: 'health' });
}

export async function verifyAIProvider(
  providerKey: AIProviderKey,
  modelId?: string,
): Promise<AIProviderVerificationResponse> {
  return invokeAiEngine<AIProviderVerificationResponse>({
    action: 'verify_provider',
    providerKey,
    ...(modelId ? { modelId } : {}),
  });
}

export async function listAIModels(options: { providerKey?: AIProviderKey; includeRemote?: boolean } = {}): Promise<{
  models: AIModelDefinition[];
  remoteModels: Record<string, string[]>;
}> {
  return invokeAiEngine({
    action: 'list_models',
    ...(options.providerKey ? { providerKey: options.providerKey } : {}),
    includeRemote: Boolean(options.includeRemote),
  });
}

// ============================================================================
// 2. Execution & Business Grow Chat
// ============================================================================

export async function executeAI(req: AIExecuteRequest): Promise<AIExecuteResponse> {
  return invokeAiEngine<AIExecuteResponse>({
    action: 'execute',
    ...req,
  });
}

export async function sendBusinessGrowMessage(req: AIBusinessChatRequest): Promise<AIExecuteResponse> {
  return invokeAiEngine<AIExecuteResponse>({
    action: 'business_chat',
    space: 'business_grow',
    ...req,
  });
}

// ============================================================================
// 3. Routing Rules & Telemetry
// ============================================================================

export async function listRoutingRules(space?: AISpace): Promise<AIRoutingRuleRecord[]> {
  let q = supabase.from('reelora_ai_routing_rules').select('*').order('updated_at', { ascending: false });
  if (space) q = q.in('space', [space, 'global']);
  return unwrap<AIRoutingRuleRecord[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function saveWorkspaceRoutingRule(input: {
  workspaceId: string;
  userId?: string | null;
  space: AISpace;
  taskType: AITaskType;
  routing: AIRoutingPreference;
}): Promise<AIRoutingRuleRecord> {
  const payload = {
    workspace_id: input.workspaceId,
    user_id: input.userId ?? null,
    space: input.space,
    task_type: input.taskType,
    selection_mode: input.routing.selectionMode,
    preferred_provider_key: input.routing.preferredProviderKey ?? null,
    preferred_model_id: input.routing.preferredModelId ?? null,
    fallback_chain: (input.routing.fallbackChain ?? []).map((f) => ({
      provider_key: f.providerKey,
      model_id: f.modelId,
    })),
    max_cost_tier: input.routing.maxCostTier ?? 'premium',
    allow_fallback: input.routing.allowFallback ?? true,
    active: true,
  };
  return unwrap<AIRoutingRuleRecord>(
    supabase.from('reelora_ai_routing_rules').upsert(payload).select('*').single() as unknown as PromiseLike<AnyResult>,
  );
}

export async function listAIRequests(limit = 50): Promise<AIRequestLog[]> {
  return unwrap<AIRequestLog[]>(
    supabase.from('reelora_ai_requests').select('*').order('created_at', { ascending: false }).limit(limit) as unknown as PromiseLike<AnyResult>,
  );
}

// ============================================================================
// 4. Isolated Business Grow Credits (NEVER touches Studio UGC credits)
// ============================================================================

export async function getBGQuotaStatus(workspaceId?: string): Promise<BGQuotaStatus> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return unwrap<BGQuotaStatus>((supabase.rpc as any)('reelora_bg_quota_status', workspaceId ? { p_workspace_id: workspaceId } : {}));
}

// ============================================================================
// 5. Business Profile, Persistent Memory, Conversations & Tools
// ============================================================================

export async function listBusinessProfiles(): Promise<BusinessProfile[]> {
  return unwrap<BusinessProfile[]>(
    supabase.from('reelora_bg_business_profiles').select('*').eq('status', 'active').order('is_default', { ascending: false }).order('updated_at', { ascending: false }) as unknown as PromiseLike<AnyResult>,
  );
}

export async function upsertBusinessProfile(
  profile: Partial<BusinessProfile> & { workspace_id: string; user_id: string; company_name: string },
): Promise<BusinessProfile> {
  return unwrap<BusinessProfile>(
    supabase.from('reelora_bg_business_profiles').upsert(profile).select('*').single() as unknown as PromiseLike<AnyResult>,
  );
}

export async function listBusinessMemories(businessProfileId: string): Promise<BusinessMemoryItem[]> {
  return unwrap<BusinessMemoryItem[]>(
    supabase
      .from('reelora_bg_business_memories')
      .select('*')
      .eq('business_profile_id', businessProfileId)
      .eq('active', true)
      .order('pinned', { ascending: false })
      .order('updated_at', { ascending: false }) as unknown as PromiseLike<AnyResult>,
  );
}

export async function saveBusinessMemory(input: {
  businessProfileId: string;
  category: BusinessMemoryCategory;
  memoryKey: string;
  summary: string;
  structuredData?: Record<string, unknown>;
  sourceType?: 'explicit_user' | 'conversation_extracted' | 'connector_sync' | 'action_outcome';
  confidence?: number;
  pinned?: boolean;
}): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return unwrap<string>((supabase.rpc as any)('reelora_bg_upsert_memory', {
    p_business_profile_id: input.businessProfileId,
    p_category: input.category,
    p_memory_key: input.memoryKey,
    p_summary: input.summary,
    p_structured_data: input.structuredData ?? {},
    p_source_type: input.sourceType ?? 'explicit_user',
    p_confidence: input.confidence ?? 0.95,
    p_pinned: Boolean(input.pinned),
  }));
}

export async function deleteBusinessMemory(memoryId: string): Promise<void> {
  await unwrap(
    supabase.from('reelora_bg_business_memories').delete().eq('id', memoryId) as unknown as PromiseLike<AnyResult>,
  );
}

export async function listBusinessConversations(): Promise<BusinessConversation[]> {
  return unwrap<BusinessConversation[]>(
    supabase
      .from('reelora_bg_conversations')
      .select('*')
      .eq('status', 'active')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false }) as unknown as PromiseLike<AnyResult>,
  );
}

export async function createBusinessConversation(input: {
  workspaceId: string;
  userId: string;
  businessProfileId?: string | null;
  title?: string;
  objective?: string;
  activeTaskType?: AITaskType;
}): Promise<BusinessConversation> {
  return unwrap<BusinessConversation>(
    supabase
      .from('reelora_bg_conversations')
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        business_profile_id: input.businessProfileId ?? null,
        title: input.title?.trim() || 'Nouvelle session Business Grow',
        objective: input.objective ?? null,
        active_task_type: input.activeTaskType ?? 'chat',
      })
      .select('*')
      .single() as unknown as PromiseLike<AnyResult>,
  );
}

export async function listBusinessMessages(conversationId: string): Promise<BusinessMessage[]> {
  return unwrap<BusinessMessage[]>(
    supabase
      .from('reelora_bg_messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }) as unknown as PromiseLike<AnyResult>,
  );
}

export async function listToolExecutions(conversationId?: string): Promise<BusinessToolExecution[]> {
  let q = supabase.from('reelora_bg_tool_executions').select('*').order('created_at', { ascending: false }).limit(50);
  if (conversationId) q = q.eq('conversation_id', conversationId);
  return unwrap<BusinessToolExecution[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function resolveToolExecution(
  executionId: string,
  decision: 'approved' | 'rejected',
): Promise<{ id: string; status: string; tool_name: string; approved_at: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return unwrap((supabase.rpc as any)('reelora_bg_resolve_tool_execution', {
    p_execution_id: executionId,
    p_decision: decision,
  }));
}

// ============================================================================
// 6. External Connectors (Prepared — read status / register draft connection)
// ============================================================================

export async function listExternalConnectors(businessProfileId?: string): Promise<ExternalConnectorState[]> {
  let q = supabase.from('reelora_bg_external_connectors').select('*').order('platform');
  if (businessProfileId) q = q.eq('business_profile_id', businessProfileId);
  return unwrap<ExternalConnectorState[]>(q as unknown as PromiseLike<AnyResult>);
}

export async function registerPreparedConnector(input: {
  workspaceId: string;
  userId: string;
  businessProfileId: string;
  platform: ExternalConnectorPlatform;
  category: 'social' | 'ecommerce';
}): Promise<ExternalConnectorState> {
  return unwrap<ExternalConnectorState>(
    supabase
      .from('reelora_bg_external_connectors')
      .upsert({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        business_profile_id: input.businessProfileId,
        platform: input.platform,
        category: input.category,
        connection_status: 'not_connected',
      })
      .select('*')
      .single() as unknown as PromiseLike<AnyResult>,
  );
}

export const reeloraAI = {
  getHealth: getAIHealth,
  verifyProvider: verifyAIProvider,
  listModels: listAIModels,
  execute: executeAI,
  sendBusinessMessage: sendBusinessGrowMessage,
  listRoutingRules,
  saveWorkspaceRoutingRule,
  listRequests: listAIRequests,
  getBGQuota: getBGQuotaStatus,
  listBusinessProfiles,
  upsertBusinessProfile,
  listBusinessMemories,
  saveBusinessMemory,
  deleteBusinessMemory,
  listBusinessConversations,
  createBusinessConversation,
  listBusinessMessages,
  listToolExecutions,
  resolveToolExecution,
  listExternalConnectors,
  registerPreparedConnector,
};
