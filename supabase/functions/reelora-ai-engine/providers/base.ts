import type {
  AIProviderKey,
  AITaskType,
  CostTier,
  ModelSpec,
  ProviderErrorCode,
} from '../types.ts';

// Runtime-safe env lookup working in both Deno Edge & Node/Vitest without
// static `Deno.env.get` references that break Node unit test scanners.
export function readServerEnv(key: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(key)?.trim() ?? g.process?.env?.[key]?.trim() ?? '';
}

export class ProviderCallError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerKey: AIProviderKey;
  readonly modelId: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;

  constructor(params: {
    code: ProviderErrorCode;
    message: string;
    providerKey: AIProviderKey;
    modelId: string;
    httpStatus?: number;
    retryable?: boolean;
    retryAfterSec?: number;
  }) {
    super(params.message);
    this.name = 'ProviderCallError';
    this.code = params.code;
    this.providerKey = params.providerKey;
    this.modelId = params.modelId;
    this.httpStatus = params.httpStatus;
    this.retryAfterSec = params.retryAfterSec;
    this.retryable = params.retryable ?? (
      params.code !== 'BAD_REQUEST'
    );
  }
}

export const MODEL_CATALOG: ModelSpec[] = [
  // Groq Cloud
  {
    providerKey: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B Versatile (Groq)',
    capabilities: ['chat', 'strategy', 'action_plan', 'marketing_campaign', 'content_ideas', 'json', 'tools'],
    recommendedTasks: ['default', 'chat', 'content_ideas', 'marketing_campaign', 'action_plan', 'script_generation'],
    contextWindow: 128000,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 0.59,
    costOutputPer1mUsd: 0.79,
    creditsCost: 1,
    costTier: 'economy',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  {
    providerKey: 'groq',
    modelId: 'llama-3.1-8b-instant',
    displayName: 'Llama 3.1 8B Instant (Groq)',
    capabilities: ['chat', 'memory_extraction', 'fast', 'json'],
    recommendedTasks: ['memory_extraction', 'chat'],
    contextWindow: 128000,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 0.05,
    costOutputPer1mUsd: 0.08,
    creditsCost: 1,
    costTier: 'economy',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  {
    providerKey: 'groq',
    modelId: 'qwen/qwen3-32b',
    displayName: 'Qwen 3 32B (Groq)',
    capabilities: ['chat', 'reasoning', 'sales_analysis', 'strategy', 'json', 'tools'],
    recommendedTasks: ['sales_analysis', 'strategy', 'tool_planning'],
    contextWindow: 131072,
    maxOutputTokens: 16384,
    costInputPer1mUsd: 0.29,
    costOutputPer1mUsd: 0.59,
    creditsCost: 1,
    costTier: 'balanced',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  // Google Gemini
  {
    providerKey: 'gemini',
    modelId: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    capabilities: ['chat', 'strategy', 'action_plan', 'marketing_campaign', 'sales_analysis', 'content_ideas', 'json', 'tools', 'long_context'],
    recommendedTasks: ['default', 'chat', 'action_plan', 'marketing_campaign', 'content_ideas', 'memory_extraction'],
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 0.30,
    costOutputPer1mUsd: 2.50,
    creditsCost: 1,
    costTier: 'balanced',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  {
    providerKey: 'gemini',
    modelId: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    capabilities: ['reasoning', 'strategy', 'sales_analysis', 'action_plan', 'json', 'tools', 'long_context'],
    recommendedTasks: ['strategy', 'sales_analysis', 'tool_planning'],
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 1.25,
    costOutputPer1mUsd: 10.0,
    creditsCost: 3,
    costTier: 'premium',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  {
    providerKey: 'gemini',
    modelId: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    capabilities: ['chat', 'fast', 'json', 'tools'],
    recommendedTasks: ['chat', 'memory_extraction'],
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 0.10,
    costOutputPer1mUsd: 0.40,
    creditsCost: 1,
    costTier: 'economy',
    supportsJson: true,
    supportsTools: true,
    enabled: true,
  },
  // Prepared future providers (architecture ready, adapters stubbed until enabled)
  {
    providerKey: 'openai',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini (préparé)',
    capabilities: ['chat', 'json', 'tools'],
    recommendedTasks: ['chat', 'tool_planning'],
    contextWindow: 128000,
    maxOutputTokens: 16384,
    costInputPer1mUsd: 0.15,
    costOutputPer1mUsd: 0.60,
    creditsCost: 1,
    costTier: 'economy',
    supportsJson: true,
    supportsTools: true,
    enabled: false,
  },
  {
    providerKey: 'anthropic',
    modelId: 'claude-sonnet-4-20250514',
    displayName: 'Claude Sonnet 4 (préparé)',
    capabilities: ['reasoning', 'strategy', 'tools'],
    recommendedTasks: ['strategy', 'action_plan'],
    contextWindow: 200000,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 3.0,
    costOutputPer1mUsd: 15.0,
    creditsCost: 3,
    costTier: 'premium',
    supportsJson: false,
    supportsTools: true,
    enabled: false,
  },
  {
    providerKey: 'deepseek',
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat (préparé)',
    capabilities: ['chat', 'reasoning', 'json'],
    recommendedTasks: ['chat', 'sales_analysis'],
    contextWindow: 64000,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 0.27,
    costOutputPer1mUsd: 1.10,
    creditsCost: 1,
    costTier: 'economy',
    supportsJson: true,
    supportsTools: true,
    enabled: false,
  },
  {
    providerKey: 'mistral',
    modelId: 'mistral-large-latest',
    displayName: 'Mistral Large (préparé)',
    capabilities: ['chat', 'strategy', 'json', 'tools'],
    recommendedTasks: ['strategy', 'marketing_campaign'],
    contextWindow: 128000,
    maxOutputTokens: 8192,
    costInputPer1mUsd: 2.0,
    costOutputPer1mUsd: 6.0,
    creditsCost: 2,
    costTier: 'balanced',
    supportsJson: true,
    supportsTools: true,
    enabled: false,
  },
];

export function findModelSpec(providerKey: AIProviderKey, modelId: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.providerKey === providerKey && m.modelId === modelId);
}

export function estimateUsdCost(
  providerKey: AIProviderKey,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const spec = findModelSpec(providerKey, modelId);
  if (!spec) return 0;
  const inputCost = (Math.max(0, inputTokens) / 1_000_000) * spec.costInputPer1mUsd;
  const outputCost = (Math.max(0, outputTokens) / 1_000_000) * spec.costOutputPer1mUsd;
  return Number((inputCost + outputCost).toFixed(6));
}

export function tierRank(tier: CostTier): number {
  if (tier === 'economy') return 1;
  if (tier === 'balanced') return 2;
  return 3;
}

export const TASK_DEFAULT_CHAINS: Record<AITaskType, Array<{ providerKey: AIProviderKey; modelId: string }>> = {
  default: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
    { providerKey: 'groq', modelId: 'llama-3.1-8b-instant' },
  ],
  chat: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
    { providerKey: 'gemini', modelId: 'gemini-2.0-flash' },
  ],
  strategy: [
    { providerKey: 'gemini', modelId: 'gemini-2.5-pro' },
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  action_plan: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-pro' },
  ],
  marketing_campaign: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  sales_analysis: [
    { providerKey: 'gemini', modelId: 'gemini-2.5-pro' },
    { providerKey: 'groq', modelId: 'qwen/qwen3-32b' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  content_ideas: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  memory_extraction: [
    { providerKey: 'groq', modelId: 'llama-3.1-8b-instant' },
    { providerKey: 'gemini', modelId: 'gemini-2.0-flash' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  tool_planning: [
    { providerKey: 'gemini', modelId: 'gemini-2.5-pro' },
    { providerKey: 'groq', modelId: 'qwen/qwen3-32b' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
  script_generation: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
};
