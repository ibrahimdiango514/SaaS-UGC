import type {
  AIProviderKey,
  AttemptTrace,
  CandidateModel,
  CostTier,
  OrchestratorInput,
  OrchestratorResult,
  ProviderErrorCode,
  RoutingRuleInput,
} from './types.ts';
import {
  ProviderCallError,
  TASK_DEFAULT_CHAINS,
  findModelSpec,
  tierRank,
} from './providers/base.ts';
import type { ProviderRegistry } from './providers/registry.ts';

export class AllProvidersFailedError extends Error {
  readonly code: ProviderErrorCode;
  readonly attempts: AttemptTrace[];

  constructor(message: string, attempts: AttemptTrace[], primaryCode: ProviderErrorCode = 'PROVIDER_UNAVAILABLE') {
    super(message);
    this.name = 'AllProvidersFailedError';
    this.code = primaryCode;
    this.attempts = attempts;
  }
}

function modelCreditsCost(providerKey: AIProviderKey, modelId: string): number {
  return findModelSpec(providerKey, modelId)?.creditsCost ?? 1;
}

function passesCostTier(providerKey: AIProviderKey, modelId: string, maxTier?: CostTier): boolean {
  if (!maxTier) return true;
  const spec = findModelSpec(providerKey, modelId);
  if (!spec) return true;
  return tierRank(spec.costTier) <= tierRank(maxTier);
}

export function buildCandidateChain(
  input: OrchestratorInput,
  registry: ProviderRegistry,
): CandidateModel[] {
  const routing: RoutingRuleInput = input.routing ?? { selectionMode: 'auto', allowFallback: true };
  const allowFallback = routing.allowFallback !== false;
  const maxCostTier = routing.maxCostTier;
  const candidates: CandidateModel[] = [];
  const seen = new Set<string>();

  const push = (
    providerKey: AIProviderKey,
    modelId: string,
    reason: CandidateModel['reason'],
    enforceTier = true,
  ) => {
    const adapter = registry.get(providerKey);
    if (!adapter || !adapter.isImplemented) return;
    const key = `${providerKey}::${modelId}`;
    if (seen.has(key)) return;
    if (enforceTier && !passesCostTier(providerKey, modelId, maxCostTier)) return;
    seen.add(key);
    candidates.push({
      providerKey,
      modelId,
      reason,
      creditsCost: modelCreditsCost(providerKey, modelId),
    });
  };

  if (routing.selectionMode === 'manual' && routing.preferredProviderKey) {
    const adapter = registry.get(routing.preferredProviderKey);
    const model = routing.preferredModelId || adapter?.listStaticModels()[0]?.modelId || '';
    if (model) push(routing.preferredProviderKey, model, 'manual', false);
  } else if (routing.preferredProviderKey && routing.preferredModelId) {
    push(routing.preferredProviderKey, routing.preferredModelId, 'rule_primary');
  }

  if (allowFallback && Array.isArray(routing.fallbackChain)) {
    for (const item of routing.fallbackChain) {
      push(item.providerKey, item.modelId, 'rule_fallback');
    }
  }

  if (routing.selectionMode !== 'manual' || allowFallback) {
    const taskChain = TASK_DEFAULT_CHAINS[input.taskType] ?? TASK_DEFAULT_CHAINS.default;
    for (let i = 0; i < taskChain.length; i += 1) {
      const entry = taskChain[i];
      push(
        entry.providerKey,
        entry.modelId,
        candidates.length === 0 ? 'auto_task' : 'auto_fallback',
      );
      if (!allowFallback && candidates.length >= 1) break;
    }
  }

  // Fallback guarantee: if tier filter eliminated everything, inspect default task chain unfiltered
  if (candidates.length === 0 && routing.selectionMode !== 'manual') {
    const fallbackChain = TASK_DEFAULT_CHAINS[input.taskType] ?? TASK_DEFAULT_CHAINS.default;
    for (const entry of fallbackChain) {
      push(entry.providerKey, entry.modelId, 'auto_fallback', false);
      if (!allowFallback && candidates.length >= 1) break;
    }
  }

  return candidates;
}

function mapErrorStatus(code: ProviderErrorCode): AttemptTrace['status'] {
  if (code === 'NOT_CONFIGURED' || code === 'NOT_IMPLEMENTED') return 'skipped_unconfigured';
  if (code === 'RATE_LIMITED' || code === 'QUOTA_EXCEEDED') return 'rate_limited';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'AUTH_ERROR') return 'auth_error';
  if (code === 'EMPTY_RESPONSE') return 'empty_response';
  return 'failed';
}

export async function orchestrateAI(
  input: OrchestratorInput,
  registry: ProviderRegistry,
): Promise<OrchestratorResult> {
  const candidates = buildCandidateChain(input, registry);
  if (candidates.length === 0) {
    throw new AllProvidersFailedError(
      'Aucun modèle IA compatible n’est disponible pour cette configuration.',
      [],
      'NOT_CONFIGURED',
    );
  }

  const attempts: AttemptTrace[] = [];
  let attemptNumber = 0;

  for (const candidate of candidates) {
    attemptNumber += 1;
    const adapter = registry.get(candidate.providerKey);
    if (!adapter || !adapter.isImplemented) {
      attempts.push({
        attemptNumber,
        providerKey: candidate.providerKey,
        modelId: candidate.modelId,
        status: 'skipped_unconfigured',
        errorCode: 'NOT_IMPLEMENTED',
        errorMessage: `Fournisseur ${candidate.providerKey} non implémenté.`,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
      continue;
    }

    if (!adapter.isConfigured()) {
      attempts.push({
        attemptNumber,
        providerKey: candidate.providerKey,
        modelId: candidate.modelId,
        status: 'skipped_unconfigured',
        errorCode: 'NOT_CONFIGURED',
        errorMessage: `Secret serveur ${adapter.envKeyName} absent.`,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
      continue;
    }

    try {
      const response = await adapter.generate({
        model: candidate.modelId,
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        jsonMode: input.jsonMode,
        tools: input.tools,
      });

      attempts.push({
        attemptNumber,
        providerKey: response.providerKey,
        modelId: response.modelId,
        status: 'succeeded',
        latencyMs: response.latencyMs,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        estimatedCostUsd: response.estimatedCostUsd,
      });

      return {
        response,
        fallbackUsed: attemptNumber > 1,
        attempts,
        creditsCost: candidate.creditsCost,
      };
    } catch (err) {
      const pErr = err instanceof ProviderCallError
        ? err
        : new ProviderCallError({
            code: 'PROVIDER_UNAVAILABLE',
            message: err instanceof Error ? err.message : String(err),
            providerKey: candidate.providerKey,
            modelId: candidate.modelId,
          });

      attempts.push({
        attemptNumber,
        providerKey: candidate.providerKey,
        modelId: candidate.modelId,
        status: mapErrorStatus(pErr.code),
        httpStatus: pErr.httpStatus,
        errorCode: pErr.code,
        errorMessage: pErr.message,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });

      if (!pErr.retryable) {
        break;
      }
    }
  }

  const allUnconfigured = attempts.length > 0 && attempts.every((a) => a.errorCode === 'NOT_CONFIGURED' || a.errorCode === 'NOT_IMPLEMENTED');
  const firstCode = allUnconfigured
    ? 'NOT_CONFIGURED'
    : (attempts.find((a) => a.errorCode && a.errorCode !== 'NOT_CONFIGURED')?.errorCode ?? 'PROVIDER_UNAVAILABLE');

  const summary = allUnconfigured
    ? 'Aucun fournisseur IA (Groq ou Google Gemini) n’est encore configuré côté serveur. Ajoutez au moins une clé API valide dans les secrets Supabase.'
    : `Tous les fournisseurs IA ont échoué (${attempts.map((a) => `${a.providerKey}:${a.errorCode ?? 'ERROR'}`).join(', ')}). Aucune réponse n’a été simulée.`;

  throw new AllProvidersFailedError(summary, attempts, firstCode);
}
