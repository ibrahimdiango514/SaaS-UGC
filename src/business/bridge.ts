import type {
  BusinessAiEnginePort,
  BusinessGrowPlatformSnapshot,
  BusinessGrowStatusPort,
  PlatformAiTaskRequest,
  PlatformAiTaskResult,
} from '../contracts/business-grow';
import { businessGrowApi } from './api';

/**
 * Pont officiel pour les modules Reelora externes à Business Grow
 * (Dashboard, Studio UGC, Projets, Paramètres, futurs outils VS Code).
 *
 * Ce pont expose uniquement les ports de contrats publics et isole
 * totalement `saas_business` de `saas_ugc`.
 */
export const businessGrowBridge: BusinessGrowStatusPort & BusinessAiEnginePort = {
  async getSnapshot(): Promise<BusinessGrowPlatformSnapshot> {
    try {
      const [statusResult, quotaResult] = await Promise.allSettled([
        businessGrowApi.getStatus(),
        businessGrowApi.getQuota(),
      ]);

      const providers = statusResult.status === 'fulfilled'
        ? statusResult.value.providers.map((provider) => ({
            providerKey: provider.provider_key,
            displayName: provider.display_name,
            enabled: provider.enabled,
            status: provider.status,
            configStatus: provider.config_status,
            verifiedModelKeys: provider.verified_model_keys ?? [],
          }))
        : [];

      const quota = quotaResult.status === 'fulfilled'
        ? {
            domain: 'business_grow' as const,
            studioUgcUntouched: true as const,
            availableUnits: quotaResult.value.available_units,
            reservedUnits: quotaResult.value.reserved_units,
            monthlyAllowance: quotaResult.value.monthly_allowance,
            periodKey: quotaResult.value.period_key ?? null,
          }
        : null;

      return {
        backendReachable: statusResult.status === 'fulfilled',
        availableProviderCount: providers.filter((p) => p.enabled && p.status === 'available').length,
        providers,
        quota,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        backendReachable: false,
        availableProviderCount: 0,
        providers: [],
        quota: null,
        checkedAt: new Date().toISOString(),
      };
    }
  },

  async executeTask(request: PlatformAiTaskRequest): Promise<PlatformAiTaskResult> {
    let conversationId = request.conversationId ?? null;
    if (!conversationId) {
      const created = await businessGrowApi.createConversation(
        request.conversationTitle?.trim() || 'Tâche IA VYORA',
        request.workspaceId ?? null,
      );
      conversationId = created.conversationId;
    }

    const sent = await businessGrowApi.sendMessage(
      conversationId,
      request.prompt,
      request.idempotencyKey,
      {
        roleKey: request.roleKey,
        workspaceId: request.workspaceId ?? null,
        routing: request.routing,
      },
    );

    const sentRecord = sent as Record<string, unknown>;
    let assistantReply: string | null = typeof sentRecord.assistantReply === 'string'
      ? sentRecord.assistantReply
      : null;

    if (assistantReply === null) {
      try {
        const listed = await businessGrowApi.listMessages(conversationId);
        const lastAssistant = [...listed.messages]
          .reverse()
          .find((message) => message.author_role === 'assistant');
        assistantReply = lastAssistant?.content ?? null;
      } catch {
        assistantReply = null;
      }
    }

    return {
      conversationId,
      requestId: sent.requestId,
      status: sent.status,
      providerKey: sent.provider?.key ?? null,
      modelKey: sent.provider?.model ?? null,
      fallbackUsed: sent.fallbackUsed === true,
      attemptsCount: sent.attemptsCount ?? 1,
      assistantReply,
      toolProposals: sent.toolProposals ?? [],
    };
  },
};
