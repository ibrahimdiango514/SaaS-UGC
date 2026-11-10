import type { AIModelDefinition, AIProviderKey, AITaskType } from '../contracts';

export interface AIProviderMeta {
  providerKey: AIProviderKey;
  displayName: string;
  implemented: boolean;
  envSecretName: string;
  description: string;
}

export const AI_PROVIDER_CATALOG: AIProviderMeta[] = [
  {
    providerKey: 'groq',
    displayName: 'Groq Cloud',
    implemented: true,
    envSecretName: 'GROQ_API_KEY',
    description: 'Inférence ultra-rapide (Llama 3.3 70B, Llama 3.1 8B, Qwen 3 32B) pour chat, campagnes et extraction mémoire.',
  },
  {
    providerKey: 'gemini',
    displayName: 'Google Gemini',
    implemented: true,
    envSecretName: 'GEMINI_API_KEY',
    description: 'Raisonnement long contexte (Gemini 2.5 Pro & Flash) pour stratégie d’entreprise, analyse commerciale et plans d’action.',
  },
  {
    providerKey: 'openai',
    displayName: 'OpenAI',
    implemented: false,
    envSecretName: 'OPENAI_API_KEY',
    description: 'Architecture prête pour extension ultérieure (GPT-4o / GPT-4o mini).',
  },
  {
    providerKey: 'anthropic',
    displayName: 'Anthropic Claude',
    implemented: false,
    envSecretName: 'ANTHROPIC_API_KEY',
    description: 'Architecture prête pour extension ultérieure (Claude Sonnet 4).',
  },
  {
    providerKey: 'deepseek',
    displayName: 'DeepSeek',
    implemented: false,
    envSecretName: 'DEEPSEEK_API_KEY',
    description: 'Architecture prête pour extension ultérieure (DeepSeek Chat / Reasoner).',
  },
  {
    providerKey: 'mistral',
    displayName: 'Mistral AI',
    implemented: false,
    envSecretName: 'MISTRAL_API_KEY',
    description: 'Architecture prête pour extension ultérieure (Mistral Large).',
  },
];

export const AI_MODEL_CATALOG: AIModelDefinition[] = [
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
];

export function modelsForProvider(providerKey: AIProviderKey): AIModelDefinition[] {
  return AI_MODEL_CATALOG.filter((m) => m.providerKey === providerKey && m.enabled);
}

export function recommendedModelsForTask(taskType: AITaskType): AIModelDefinition[] {
  return AI_MODEL_CATALOG.filter((m) => m.enabled && m.recommendedTasks.includes(taskType));
}
