// Reelora Central AI Engine & Business Grow — TypeScript Integration Contracts (Frontend / VS Code)

export type AIProviderKey =
  | 'groq'
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'mistral';

export type AISpace = 'business_grow' | 'studio_ugc';

export type AITaskType =
  | 'default'
  | 'chat'
  | 'strategy'
  | 'action_plan'
  | 'marketing_campaign'
  | 'sales_analysis'
  | 'content_ideas'
  | 'memory_extraction'
  | 'tool_planning'
  | 'script_generation';

export type SelectionMode = 'auto' | 'manual';

export type CostTier = 'economy' | 'balanced' | 'premium';

export type AIProviderVerificationStatus =
  | 'unconfigured'
  | 'configured_unverified'
  | 'connected'
  | 'error'
  | 'planned';

export type AIErrorCode =
  | 'NOT_CONFIGURED'
  | 'AI_PROVIDERS_NOT_CONFIGURED'
  | 'NOT_IMPLEMENTED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'BG_INSUFFICIENT_CREDITS'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'EMPTY_RESPONSE'
  | 'INVALID_RESPONSE'
  | 'SAFETY_BLOCKED'
  | 'CONNECTOR_NOT_CONNECTED'
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN';

export interface AIProviderStatus {
  providerKey: AIProviderKey;
  displayName: string;
  implemented: boolean;
  /** True only if the server-side environment secret exists (value is never exposed). */
  configured: boolean;
  /** True ONLY after an authentic live API probe succeeded on the server. */
  connected: boolean;
  verificationStatus: AIProviderVerificationStatus;
  envSecretName: string;
  modelsCount: number;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
}

export interface AIModelDefinition {
  providerKey: AIProviderKey;
  modelId: string;
  displayName: string;
  capabilities: string[];
  recommendedTasks: AITaskType[];
  contextWindow: number;
  maxOutputTokens: number;
  costInputPer1mUsd: number;
  costOutputPer1mUsd: number;
  creditsCost: number;
  costTier: CostTier;
  supportsJson: boolean;
  supportsTools: boolean;
  enabled: boolean;
}

export interface AIHealthResponse {
  engine: 'reelora-ai-engine';
  status: 'ok';
  creditDomainIsolation: true;
  providers: AIProviderStatus[];
  models: AIModelDefinition[];
}

export interface AIProviderVerificationResponse {
  providerKey: AIProviderKey;
  modelId: string;
  configured: boolean;
  implemented: boolean;
  verified: boolean;
  latencyMs: number;
  errorCode?: AIErrorCode;
  errorMessage?: string;
  checkedAt: string;
}

export interface AIRoutingPreference {
  selectionMode: SelectionMode;
  preferredProviderKey?: AIProviderKey | null;
  preferredModelId?: string | null;
  fallbackChain?: Array<{ providerKey: AIProviderKey; modelId: string }>;
  maxCostTier?: CostTier;
  allowFallback?: boolean;
}

export interface AIRoutingRuleRecord {
  id: string;
  workspace_id: string | null;
  user_id: string | null;
  space: AISpace | 'global';
  task_type: AITaskType;
  selection_mode: SelectionMode;
  preferred_provider_key: AIProviderKey | null;
  preferred_model_id: string | null;
  fallback_chain: Array<{ provider_key: AIProviderKey; model_id: string }>;
  max_cost_tier: CostTier;
  allow_fallback: boolean;
  daily_budget_credits: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AIChatMessageInput {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface AIToolProposal {
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'read' | 'draft' | 'write_requires_approval';
  rationale?: string;
}

export interface AIAttemptLog {
  attemptNumber: number;
  providerKey: AIProviderKey;
  modelId: string;
  status:
    | 'succeeded'
    | 'failed'
    | 'skipped_unconfigured'
    | 'rate_limited'
    | 'timeout'
    | 'auth_error'
    | 'empty_response';
  httpStatus?: number;
  errorCode?: AIErrorCode;
  errorMessage?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AIExecuteRequest {
  space?: AISpace;
  taskType?: AITaskType;
  workspaceId?: string;
  systemPrompt?: string;
  prompt?: string;
  messages?: AIChatMessageInput[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  routing?: AIRoutingPreference;
}

export interface AIBusinessChatRequest extends AIExecuteRequest {
  space?: 'business_grow';
  businessProfileId?: string;
  conversationId?: string;
  persistUserMessage?: boolean;
  enableTools?: boolean;
}

export interface AIUsageSummary {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  bgCreditsCharged: number;
  studioUgcCreditsCharged: 0;
}

export interface AIExecuteResponse {
  requestId: string;
  space: AISpace;
  taskType: AITaskType;
  provider: AIProviderKey;
  model: string;
  fallbackUsed: boolean;
  attempts: AIAttemptLog[];
  text: string;
  toolProposals: AIToolProposal[];
  usage: AIUsageSummary;
  latencyMs: number;
  messageId: string | null;
  businessProfileId: string | null;
}

export interface AIRequestLog {
  id: string;
  user_id: string;
  workspace_id: string;
  space: AISpace;
  task_type: AITaskType;
  conversation_id: string | null;
  business_profile_id: string | null;
  selection_mode: SelectionMode;
  requested_provider_key: AIProviderKey | null;
  requested_model_id: string | null;
  actual_provider_key: AIProviderKey | null;
  actual_model_id: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  fallback_used: boolean;
  attempts_count: number;
  latency_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  bg_credits_charged: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

// ============================================================================
// Business Grow Isolated Credits
// ============================================================================

export interface BGQuotaStatus {
  wallet_id: string;
  workspace_id: string;
  credit_domain: 'business_grow';
  studio_ugc_credits_untouched: true;
  available_credits: number;
  reserved_credits: number;
  monthly_allowance: number;
  period_key: string;
  period_used: number;
  lifetime_consumed: number;
}

// ============================================================================
// Business Grow Profile, Memory, Conversations & Tools
// ============================================================================

export type BusinessMemoryCategory =
  | 'company'
  | 'product'
  | 'audience'
  | 'goal'
  | 'positioning'
  | 'tone'
  | 'preference'
  | 'work_history'
  | 'metric'
  | 'insight';

export interface BusinessProductServiceItem {
  name: string;
  description?: string;
  price?: string;
  marginNote?: string;
}

export interface BusinessProfile {
  id: string;
  workspace_id: string;
  user_id: string;
  company_name: string;
  industry: string | null;
  tagline: string | null;
  description: string | null;
  website_url: string | null;
  primary_language: string;
  products_services: BusinessProductServiceItem[];
  target_customers: string[];
  business_goals: string[];
  positioning: string | null;
  brand_identity: Record<string, unknown>;
  communication_tone: string | null;
  preferences: Record<string, unknown>;
  ai_memory_consent: boolean;
  consent_updated_at: string | null;
  is_default: boolean;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface BusinessMemoryItem {
  id: string;
  workspace_id: string;
  user_id: string;
  business_profile_id: string;
  category: BusinessMemoryCategory;
  memory_key: string;
  summary: string;
  structured_data: Record<string, unknown>;
  confidence: number;
  source_type: 'explicit_user' | 'conversation_extracted' | 'connector_sync' | 'action_outcome';
  source_ref_id: string | null;
  pinned: boolean;
  active: boolean;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessConversation {
  id: string;
  workspace_id: string;
  user_id: string;
  business_profile_id: string | null;
  title: string;
  objective: string | null;
  active_task_type: AITaskType;
  routing_override: Record<string, unknown>;
  status: 'active' | 'archived';
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessMessage {
  id: string;
  conversation_id: string;
  workspace_id: string;
  user_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  task_type: AITaskType | null;
  provider_key: AIProviderKey | null;
  model_id: string | null;
  request_id: string | null;
  structured_payload: Record<string, unknown>;
  tool_proposals: AIToolProposal[];
  token_count: number | null;
  created_at: string;
}

export interface BusinessToolDefinition {
  name: string;
  title: string;
  description: string;
  category: 'memory' | 'strategy' | 'marketing' | 'studio_handoff' | 'connector_read';
  riskLevel: 'read' | 'draft' | 'write_requires_approval';
  requiresBusinessProfile: boolean;
  parameters: Record<string, unknown>;
}

export interface BusinessToolExecution {
  id: string;
  workspace_id: string;
  user_id: string;
  business_profile_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  request_id: string | null;
  tool_name: string;
  risk_level: 'read' | 'draft' | 'write_requires_approval';
  status: 'pending_approval' | 'approved' | 'rejected' | 'executed' | 'failed';
  input_args: Record<string, unknown>;
  output_result: Record<string, unknown>;
  error_message: string | null;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  created_at: string;
}

// ============================================================================
// External Connectors (Social & E-Commerce — prepared interfaces)
// ============================================================================

export type ExternalConnectorPlatform =
  | 'facebook'
  | 'instagram'
  | 'youtube'
  | 'tiktok'
  | 'shopify'
  | 'woocommerce'
  | 'custom';

export type ExternalConnectorCategory = 'social' | 'ecommerce';

export type ConnectorConnectionStatus =
  | 'not_connected'
  | 'oauth_pending'
  | 'connected_readonly'
  | 'connected_active'
  | 'revoked'
  | 'error';

export interface ExternalConnectorSpec {
  platform: ExternalConnectorPlatform;
  displayName: string;
  category: ExternalConnectorCategory;
  oauthSupported: boolean;
  requiredScopes: string[];
  capabilities: string[];
  documentationNote: string;
}

export interface ExternalConnectorState {
  id: string;
  workspace_id: string;
  business_profile_id: string | null;
  user_id: string;
  platform: ExternalConnectorPlatform;
  category: ExternalConnectorCategory;
  connection_status: ConnectorConnectionStatus;
  external_account_id: string | null;
  external_account_name: string | null;
  granted_scopes: string[];
  sync_capabilities: Record<string, unknown>;
  last_sync_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
