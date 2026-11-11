import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  REELORA_DOMAIN_BOUNDARIES,
  UGC_HANDOFF_BRIEF_VERSION,
  buildBusinessGrowLocationState,
  buildStudioLocationStateFromBrief,
  extractUgcHandoffBriefFromLocationState,
  formatUgcPromptFromBrief,
  normalizeUgcHandoffBrief,
  parseBusinessGrowEntryIntent,
} from '../src/contracts/business-grow';
import { describeModelCapabilities, BUSINESS_ROUTING_DEFAULTS } from '../src/business/ai/registry';
import { extractToolProposals } from '../supabase/functions/business-grow/intelligence';
import { listAdapterDescriptors } from '../supabase/functions/business-grow/providers';
import { createBusinessGrowHandler, type BusinessGrowDependencies, type BusinessGrowStore } from '../supabase/functions/business-grow/handler';

const apiMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getQuota: vi.fn(),
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
  listMessages: vi.fn(),
}));

vi.mock('../src/business/api', () => ({
  businessGrowApi: {
    getStatus: apiMocks.getStatus,
    getQuota: apiMocks.getQuota,
    createConversation: apiMocks.createConversation,
    sendMessage: apiMocks.sendMessage,
    listMessages: apiMocks.listMessages,
  },
}));

import { businessGrowBridge } from '../src/business/bridge';

describe('Reelora AI ↔ Platform contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes Business Grow -> Studio UGC handoff briefs with consumesStudioCredits = false', () => {
    const normalized = normalizeUgcHandoffBrief({
      productName: 'Sérum Karité Éclat',
      campaignAngle: 'Routine 7 jours anti-teint terne',
      hook: 'Tu fais encore cette erreur le matin ?',
      audience: 'Femmes actives 25-40 ans',
      callToAction: 'Découvre le sérum maintenant',
      ratio: '9:16',
      sector: 'cosmetique',
    }, {
      executionId: 'exec-123',
      conversationId: 'conv-456',
    });

    expect(normalized).toEqual({
      version: UGC_HANDOFF_BRIEF_VERSION,
      source: 'business_grow',
      sourceExecutionId: 'exec-123',
      sourceConversationId: 'conv-456',
      brandName: null,
      product: 'Sérum Karité Éclat',
      angle: 'Routine 7 jours anti-teint terne',
      hook: 'Tu fais encore cette erreur le matin ?',
      targetAudience: 'Femmes actives 25-40 ans',
      summary: '',
      cta: 'Découvre le sérum maintenant',
      preferredRatio: '9:16',
      suggestedSector: 'cosmetique',
      consumesStudioCredits: false,
    });

    expect(REELORA_DOMAIN_BOUNDARIES.studioCreditsNeverDebitedByBusinessGrow).toBe(true);
    expect(REELORA_DOMAIN_BOUNDARIES.businessGrowSchema).toBe('saas_business');
    expect(REELORA_DOMAIN_BOUNDARIES.studioUgcSchema).toBe('saas_ugc');

    const state = buildStudioLocationStateFromBrief(normalized);
    expect(extractUgcHandoffBriefFromLocationState(state)).toEqual(normalized);
    expect(formatUgcPromptFromBrief(normalized!)).toContain('Sérum Karité Éclat');
    expect(formatUgcPromptFromBrief(normalized!)).toContain('Tu fais encore cette erreur le matin ?');
    expect(normalizeUgcHandoffBrief({ unrelated: true })).toBeNull();
    expect(extractUgcHandoffBriefFromLocationState(null)).toBeNull();
  });

  it('builds and validates BusinessGrowEntryIntent from platform routes', () => {
    const state = buildBusinessGrowLocationState({
      section: 'chat',
      roleKey: 'marketing_campaign',
      projectId: 'proj-1',
      projectTitle: 'Lancement Été',
      brandName: 'Atelier Bamako',
      initialDraft: 'Prépare 3 hooks TikTok pour Lancement Été.',
      sourceRoute: '/app/projets/proj-1',
    });

    const parsed = parseBusinessGrowEntryIntent(state);
    expect(parsed).toMatchObject({
      version: 'reelora-bg-entry-v1',
      section: 'chat',
      roleKey: 'marketing_campaign',
      projectId: 'proj-1',
      projectTitle: 'Lancement Été',
      brandName: 'Atelier Bamako',
      initialDraft: 'Prépare 3 hooks TikTok pour Lancement Été.',
      sourceRoute: '/app/projets/proj-1',
    });

    const invalidParsed = parseBusinessGrowEntryIntent({
      businessGrowIntent: { section: 'unknown', roleKey: 'hacker_role', projectTitle: 'OK' },
    });
    expect(invalidParsed?.section).toBeUndefined();
    expect(invalidParsed?.roleKey).toBeUndefined();
    expect(invalidParsed?.projectTitle).toBe('OK');
    expect(parseBusinessGrowEntryIntent({})).toBeNull();
  });

  it('exposes isolated platform snapshots and task execution through businessGrowBridge', async () => {
    apiMocks.getStatus.mockResolvedValueOnce({
      providers: [
        {
          provider_key: 'groq',
          display_name: 'Groq',
          enabled: true,
          status: 'available',
          config_status: 'configured',
          checked_at: '2026-11-10T00:00:00Z',
          verified_model_keys: ['openai-gpt-oss-120b'],
        },
        {
          provider_key: 'openai',
          display_name: 'OpenAI',
          enabled: false,
          status: 'unverified',
          config_status: 'missing',
          checked_at: null,
        },
      ],
    });
    apiMocks.getQuota.mockResolvedValueOnce({
      domain: 'business_grow',
      studio_ugc_untouched: true,
      available_units: 999900,
      reserved_units: 0,
      monthly_allowance: 1000000,
      period_key: '2026-11',
    });

    const snapshot = await businessGrowBridge.getSnapshot();
    expect(snapshot.backendReachable).toBe(true);
    expect(snapshot.availableProviderCount).toBe(1);
    expect(snapshot.quota).toMatchObject({
      domain: 'business_grow',
      studioUgcUntouched: true,
      availableUnits: 999900,
    });

    apiMocks.createConversation.mockResolvedValueOnce({ conversationId: 'conv-auto-1' });
    apiMocks.sendMessage.mockResolvedValueOnce({
      requestId: 'req-1',
      inputMessageId: 'msg-1',
      status: 'succeeded',
      providerAvailable: true,
      provider: { key: 'groq', model: 'openai/gpt-oss-120b' },
      fallbackUsed: false,
      attemptsCount: 1,
      assistantReply: 'Voici les 3 angles demandés.',
      toolProposals: [],
    });

    const taskResult = await businessGrowBridge.executeTask({
      roleKey: 'content_strategy',
      workspaceId: 'ws-1',
      prompt: 'Propose 3 angles UGC.',
      idempotencyKey: 'idem-1',
    });
    expect(taskResult).toMatchObject({
      conversationId: 'conv-auto-1',
      providerKey: 'groq',
      modelKey: 'openai/gpt-oss-120b',
      assistantReply: 'Voici les 3 angles demandés.',
    });
    expect(apiMocks.listMessages).not.toHaveBeenCalled();
  });

  it('describes model capabilities, adapter descriptors, strips --- before tool fences, and maps 409/404 on tools.resolve', async () => {
    expect(describeModelCapabilities({ reasoning: true, fast_response: true, disabled: false })).toEqual([
      'Raisonnement stratégique',
      'Réponse rapide',
    ]);
    expect(BUSINESS_ROUTING_DEFAULTS.defaultAllowFallbackInManual).toBe(false);

    const adapters = listAdapterDescriptors();
    expect(adapters.find((a) => a.id === 'groq')?.implemented).toBe(true);
    expect(adapters.find((a) => a.id === 'gemini')?.implemented).toBe(true);
    expect(adapters.find((a) => a.id === 'openai')?.implemented).toBe(false);

    const extracted = extractToolProposals(
      'Réponse propre.\n---\n<!--REELORA_TOOL_PROPOSALS:[{"toolName":"handoff_ugc_brief","summary":"Brief vidéo","arguments":{"productName":"Huile Karité","ratio":"9:16"}}]-->',
    );
    expect(extracted.cleanText).toBe('Réponse propre.');
    expect(extracted.proposals[0].arguments).toMatchObject({
      product: 'Huile Karité',
      preferredRatio: '9:16',
      consumesStudioCredits: false,
    });

    const store: BusinessGrowStore = {
      listProviders: vi.fn(async () => []),
      listConversations: vi.fn(async () => []),
      createConversation: vi.fn(async () => 'conv-1'),
      renameConversation: vi.fn(async () => true),
      deleteConversation: vi.fn(async () => true),
      listMessages: vi.fn(async () => []),
      submitUserMessage: vi.fn(),
      startRequest: vi.fn(),
      selectRoute: vi.fn(),
      finalizeAttempt: vi.fn(),
      failRequest: vi.fn(),
      getMemory: vi.fn(async () => ({ consent: false, items: [] })),
      setMemoryConsent: vi.fn(async () => ({ event_id: 1, occurred_at: '2026-11-10' })),
      saveMemoryProfile: vi.fn(async () => {}),
      putMemoryItem: vi.fn(async () => 'item-1'),
      deleteMemoryItem: vi.fn(async () => true),
      resolveToolExecution: vi.fn()
        .mockRejectedValueOnce(new Error('tool execution already resolved'))
        .mockRejectedValueOnce(new Error('tool execution not found')),
    };

    const dependencies: BusinessGrowDependencies = {
      allowedOrigins: ['https://reelora.example'],
      getUserId: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
      providerOrder: ['groq', 'gemini'],
      providerConfigs: {},
      store,
      complete: vi.fn(),
    };

    const handler = createBusinessGrowHandler(dependencies);
    const conflict = await handler(new Request('https://edge.test/business-grow', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', Origin: 'https://reelora.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'tools.resolve',
        executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
        decision: 'approved',
      }),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'TOOL_ALREADY_RESOLVED' } });

    const missing = await handler(new Request('https://edge.test/business-grow', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', Origin: 'https://reelora.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'tools.resolve',
        executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8',
        decision: 'rejected',
      }),
    }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'TOOL_NOT_FOUND' } });
  });
});
