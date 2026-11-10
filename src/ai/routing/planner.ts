import type {
  AIModelDefinition,
  AIProviderKey,
  AIProviderStatus,
  AIRoutingPreference,
  AITaskType,
  CostTier,
} from '../contracts';
import { AI_MODEL_CATALOG } from '../providers/registry';

export interface PlannedRouteCandidate {
  providerKey: AIProviderKey;
  modelId: string;
  displayName: string;
  creditsCost: number;
  role: 'primary' | 'fallback';
  availableNow: boolean;
}

const DEFAULT_CHAINS: Record<AITaskType, Array<{ providerKey: AIProviderKey; modelId: string }>> = {
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
  ],
  tool_planning: [
    { providerKey: 'gemini', modelId: 'gemini-2.5-pro' },
    { providerKey: 'groq', modelId: 'qwen/qwen3-32b' },
  ],
  script_generation: [
    { providerKey: 'groq', modelId: 'llama-3.3-70b-versatile' },
    { providerKey: 'gemini', modelId: 'gemini-2.5-flash' },
  ],
};

function tierRank(tier: CostTier): number {
  return tier === 'economy' ? 1 : tier === 'balanced' ? 2 : 3;
}

export function previewRoutingPlan(
  taskType: AITaskType,
  routing: AIRoutingPreference | undefined,
  providerStatuses: AIProviderStatus[] = [],
  catalog: AIModelDefinition[] = AI_MODEL_CATALOG,
): PlannedRouteCandidate[] {
  const allowFallback = routing?.allowFallback !== false;
  const maxTier = routing?.maxCostTier;
  const statusMap = new Map(providerStatuses.map((s) => [s.providerKey, s]));
  const out: PlannedRouteCandidate[] = [];
  const seen = new Set<string>();

  const push = (providerKey: AIProviderKey, modelId: string, enforceTier: boolean) => {
    const k = `${providerKey}::${modelId}`;
    if (seen.has(k)) return;
    const spec = catalog.find((m) => m.providerKey === providerKey && m.modelId === modelId);
    if (!spec || !spec.enabled) return;
    if (enforceTier && maxTier && tierRank(spec.costTier) > tierRank(maxTier)) return;
    seen.add(k);
    const st = statusMap.get(providerKey);
    out.push({
      providerKey,
      modelId,
      displayName: spec.displayName,
      creditsCost: spec.creditsCost,
      role: out.length === 0 ? 'primary' : 'fallback',
      availableNow: st ? (st.implemented && st.configured) : false,
    });
  };

  if (routing?.selectionMode === 'manual' && routing.preferredProviderKey && routing.preferredModelId) {
    push(routing.preferredProviderKey, routing.preferredModelId, false);
  } else if (routing?.preferredProviderKey && routing.preferredModelId) {
    push(routing.preferredProviderKey, routing.preferredModelId, true);
  }

  if (allowFallback && routing?.fallbackChain) {
    for (const item of routing.fallbackChain) {
      push(item.providerKey, item.modelId, true);
    }
  }

  if (routing?.selectionMode !== 'manual' || allowFallback) {
    for (const item of DEFAULT_CHAINS[taskType] ?? DEFAULT_CHAINS.default) {
      push(item.providerKey, item.modelId, true);
      if (!allowFallback && out.length >= 1) break;
    }
  }

  return out;
}
