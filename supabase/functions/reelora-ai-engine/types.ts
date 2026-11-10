// Core types for Reelora Central AI Engine (Deno Edge & Node/Vitest compatible)

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

export type ProviderErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_IMPLEMENTED'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'EMPTY_RESPONSE'
  | 'INVALID_RESPONSE'
  | 'SAFETY_BLOCKED'
  | 'BAD_REQUEST';

export interface AIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface AIToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIToolCallProposal {
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: 'read' | 'draft' | 'write_requires_approval';
  rationale?: string;
}

export interface ModelSpec {
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

export interface ProviderRequest {
  model: string;
  systemPrompt?: string;
  messages: AIChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  tools?: AIToolDeclaration[];
  timeoutMs?: number;
}

export interface ProviderResponse {
  providerKey: AIProviderKey;
  modelId: string;
  text: string;
  toolCalls: AIToolCallProposal[];
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  rawFinishDetails?: string;
}

export interface ProviderVerificationResult {
  providerKey: AIProviderKey;
  modelId: string;
  configured: boolean;
  implemented: boolean;
  verified: boolean;
  latencyMs: number;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  checkedAt: string;
}

export interface AIProviderAdapter {
  readonly providerKey: AIProviderKey;
  readonly displayName: string;
  readonly isImplemented: boolean;
  readonly envKeyName: string;
  isConfigured(): boolean;
  listStaticModels(): ModelSpec[];
  listRemoteModels?(): Promise<string[]>;
  generate(req: ProviderRequest): Promise<ProviderResponse>;
  verify(modelId?: string): Promise<ProviderVerificationResult>;
}

export interface CandidateModel {
  providerKey: AIProviderKey;
  modelId: string;
  reason: 'manual' | 'rule_primary' | 'rule_fallback' | 'auto_task' | 'auto_fallback';
  creditsCost: number;
}

export interface RoutingRuleInput {
  selectionMode: SelectionMode;
  preferredProviderKey?: AIProviderKey | null;
  preferredModelId?: string | null;
  fallbackChain?: Array<{ providerKey: AIProviderKey; modelId: string }>;
  maxCostTier?: CostTier;
  allowFallback?: boolean;
}

export interface AttemptTrace {
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
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface OrchestratorInput {
  space: AISpace;
  taskType: AITaskType;
  systemPrompt?: string;
  messages: AIChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  tools?: AIToolDeclaration[];
  routing?: RoutingRuleInput;
}

export interface OrchestratorResult {
  response: ProviderResponse;
  fallbackUsed: boolean;
  attempts: AttemptTrace[];
  creditsCost: number;
}
