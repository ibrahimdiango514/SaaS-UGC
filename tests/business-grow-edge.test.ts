import { describe, expect, it, vi } from 'vitest';
import {
  createBusinessGrowHandler,
  NoVerifiedProviderRouteError,
  type BusinessGrowDependencies,
  type BusinessGrowStore,
} from '../supabase/functions/business-grow/handler';
import {
  ProviderCallError,
  type BusinessProvider,
  type ProviderConfig,
  type ProviderProbeResult,
} from '../supabase/functions/business-grow/providers';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'abababab-abab-4bab-8bab-abababababab';
const conversationA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const messageA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const idempotencyKey = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function fixture() {
  const store: BusinessGrowStore = {
    listProviders: vi.fn(async () => []),
    listConversations: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    createConversation: vi.fn(async () => conversationA),
    renameConversation: vi.fn(async () => true),
    deleteConversation: vi.fn(async () => true),
    getMemory: vi.fn(async () => ({ consent: false, items: [] })),
    setMemoryConsent: vi.fn(async () => ({ event_id: 1, occurred_at: '2026-01-01T00:00:00Z' })),
    saveMemoryProfile: vi.fn(async () => undefined),
    putMemoryItem: vi.fn(async () => 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    deleteMemoryItem: vi.fn(async () => true),
    submitUserMessage: vi.fn(async () => ({
      requestId: requestA, inputMessageId: messageA, status: 'queued', created: true,
    })),
    startRequest: vi.fn(async () => undefined),
    selectRoute: vi.fn(async () => {
      throw new NoVerifiedProviderRouteError();
    }),
    failRequest: vi.fn(async () => undefined),
    finalizeAttempt: vi.fn(async () => undefined),
  };
  const dependencies: BusinessGrowDependencies = {
    store,
    getUserId: vi.fn(async (authorization) => authorization === 'Bearer valid-user-session' ? userA : null),
    allowedOrigins: [
      'https://reelora.test',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ],
    providerConfigs: {
      groq: { apiKey: 'test-groq-secret', model: 'verified-groq-model' },
      gemini: { apiKey: 'test-gemini-secret', model: 'verified-gemini-model' },
    },
    providerOrder: ['groq', 'gemini'],
    complete: vi.fn(async () => ({ content: 'Réponse de test.', inputTokens: 10, outputTokens: 12 })),
  };
  return { store, dependencies, handler: createBusinessGrowHandler(dependencies) };
}

function request(body: unknown, authorization = 'Bearer valid-user-session') {
  return new Request('https://edge.test/business-grow', {
    method: 'POST',
    headers: {
      Authorization: authorization,
      Origin: 'https://reelora.test',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('Business Grow Edge handler', () => {
  it('refuses unauthenticated calls before accessing the store', async () => {
    const { handler, store } = fixture();
    const response = await handler(request({ action: 'conversations.list' }, 'Bearer invalid'));

    expect(response.status).toBe(401);
    expect(store.listConversations).not.toHaveBeenCalled();
  });

  it('reports authentication service failures as unavailable instead of invalidating the session', async () => {
    const { handler, dependencies, store } = fixture();
    vi.mocked(dependencies.getUserId).mockRejectedValueOnce(new Error('Auth service unavailable'));

    const response = await handler(request({ action: 'conversations.list' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'AUTH_SERVICE_UNAVAILABLE' },
    });
    expect(store.listConversations).not.toHaveBeenCalled();
  });

  it('answers the Vite 127.0.0.1 preflight with the allowed Supabase headers', async () => {
    const { handler, store } = fixture();
    const response = await handler(new Request('https://edge.test/business-grow', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, apikey, content-type, x-client-info',
      },
    }));

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5173');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('apikey');
    expect(store.listProviders).not.toHaveBeenCalled();
  });

  it('rejects disallowed preflight origins', async () => {
    const { handler } = fixture();
    const response = await handler(new Request('https://edge.test/business-grow', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example' },
    }));

    expect(response.status).toBe(403);
    // Le refus est renvoyé AVEC l'en-tête d'origine : sans lui le navigateur
    // transforme ce 403 en erreur réseau, affichée à tort « backend absent ».
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://attacker.example');
    expect(await response.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });

  it('derives the owner from the validated session, not a body user id', async () => {
    const { handler, store } = fixture();
    const response = await handler(request({
      action: 'conversations.list',
      user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }));

    expect(response.status).toBe(200);
    expect(store.listConversations).toHaveBeenCalledWith(userA);
  });

  it('renames and deletes only through ownership-scoped store operations', async () => {
    const { handler, store } = fixture();
    const rename = await handler(request({
      action: 'conversations.rename',
      conversationId: conversationA,
      title: 'Nouvelle stratégie',
    }));
    const deleteResponse = await handler(request({
      action: 'conversations.delete',
      conversationId: conversationA,
    }));

    expect(rename.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(store.renameConversation).toHaveBeenCalledWith(userA, conversationA, 'Nouvelle stratégie');
    expect(store.deleteConversation).toHaveBeenCalledWith(userA, conversationA);
  });

  it('does not report a conversation as renamed if it is not owned by the caller', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.renameConversation).mockResolvedValue(false);
    const response = await createBusinessGrowHandler(dependencies)(request({
      action: 'conversations.rename',
      conversationId: conversationA,
      title: 'Intrusion',
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  });

  it('returns an explicit failure when no database-verified route exists', async () => {
    const { handler, store, dependencies } = fixture();
    const response = await handler(request({
      action: 'messages.send',
      user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      conversationId: conversationA,
      content: 'Prépare un plan de lancement.',
      idempotencyKey,
    }));
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('NO_VERIFIED_PROVIDER');
    expect(body.error.message).toContain('aucune réponse n’a été simulée');
    expect(store.submitUserMessage).toHaveBeenCalledWith(
      userA,
      conversationA,
      'Prépare un plan de lancement.',
      idempotencyKey,
      expect.any(String),
    );
    expect(store.startRequest).toHaveBeenCalledWith(userA, requestA);
    expect(store.failRequest).toHaveBeenCalledWith(userA, requestA, 'NO_VERIFIED_PROVIDER');
    expect(store.listMessages).toHaveBeenCalledWith(userA, conversationA);
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it('uses the verified Groq route, prior history, and records the real answer', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockResolvedValue({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'groq',
      modelKey: 'groq-logical-key',
      providerModelKey: 'verified-groq-model',
    });
    vi.mocked(store.listMessages).mockResolvedValue([
      { author_role: 'user', content: 'Contexte précédent' },
      { author_role: 'assistant', content: 'Réponse précédente' },
    ]);

    const response = await createBusinessGrowHandler(dependencies)(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Test explicite.',
      idempotencyKey,
    }));
    const body = await response.json() as {
      data: { status: string; provider: { key: string; model: string } };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: 'succeeded',
      provider: { key: 'groq', model: 'verified-groq-model' },
    });
    expect(dependencies.complete).toHaveBeenCalledWith('groq', dependencies.providerConfigs.groq, [
      expect.objectContaining({ role: 'system' }),
      { role: 'user', content: 'Contexte précédent' },
      { role: 'assistant', content: 'Réponse précédente' },
      { role: 'user', content: 'Test explicite.' },
    ], { model: 'verified-groq-model', roleKey: 'business_advisor' });
    expect(store.finalizeAttempt).toHaveBeenCalledWith(
      userA, requestA, '99999999-9999-4999-8999-999999999999',
      expect.objectContaining({ status: 'succeeded', outputContent: 'Réponse de test.', inputTokens: 10, outputTokens: 12 }),
    );
    expect(store.failRequest).not.toHaveBeenCalled();
  });

  it('caps the history sent to providers while retaining the newest context', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockResolvedValue({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'groq',
      modelKey: 'groq-logical-key',
      providerModelKey: 'verified-groq-model',
    });
    vi.mocked(store.listMessages).mockResolvedValue([
      ...Array.from({ length: 10 }, (_, index) => ({
        author_role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index}:` + 'x'.repeat(11_990),
      })),
    ]);

    await createBusinessGrowHandler(dependencies)(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Question la plus récente.',
      idempotencyKey,
    }));

    const [, , messages] = vi.mocked(dependencies.complete).mock.calls[0];
    const historyCharacters = messages
      .filter((message) => message.role !== 'system')
      .reduce((total, message) => total + message.content.length, 0);
    expect(historyCharacters).toBeLessThanOrEqual(60_000);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'Question la plus récente.' });
  });

  it('falls back to the next database-verified provider and reports which one answered', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute)
      .mockResolvedValueOnce({
        attemptId: '99999999-9999-4999-8999-999999999999',
        providerKey: 'groq',
        modelKey: 'groq-logical-key',
        providerModelKey: 'verified-groq-model',
      })
      .mockResolvedValueOnce({
        attemptId: '88888888-8888-4888-8888-888888888888',
        providerKey: 'gemini',
        modelKey: 'gemini-logical-key',
        providerModelKey: 'verified-gemini-model',
      });
    vi.mocked(dependencies.complete)
      .mockRejectedValueOnce(new ProviderCallError('PROVIDER_RATE_LIMITED', true))
      .mockResolvedValueOnce({ content: 'Gemini a répondu.', inputTokens: 8, outputTokens: 9 });

    const response = await createBusinessGrowHandler(dependencies)(request({
      action: 'messages.send', conversationId: conversationA,
      content: 'Prépare un plan.', idempotencyKey,
    }));
    const body = await response.json() as { data: { provider: { key: string } } };

    expect(response.status).toBe(200);
    expect(body.data.provider.key).toBe('gemini');
    expect(store.selectRoute).toHaveBeenNthCalledWith(
      2, userA, requestA, conversationA, 2, '99999999-9999-4999-8999-999999999999',
      'PROVIDER_RATE_LIMITED', ['groq', 'gemini'], ['groq'],
    );
    expect(store.finalizeAttempt).toHaveBeenNthCalledWith(
      1, userA, requestA, '99999999-9999-4999-8999-999999999999',
      expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED', finalizeRequest: false }),
    );
    expect(store.finalizeAttempt).toHaveBeenNthCalledWith(
      2, userA, requestA, '88888888-8888-4888-8888-888888888888',
      expect.objectContaining({ status: 'succeeded', outputContent: 'Gemini a répondu.' }),
    );
  });

  it('does not call an API when the key is missing', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockResolvedValue({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'groq',
      modelKey: 'groq-logical-key',
      providerModelKey: 'verified-groq-model',
    });
    dependencies.providerConfigs.groq = { apiKey: '', model: 'verified-groq-model' };

    const response = await createBusinessGrowHandler(dependencies)(request({
      action: 'messages.send', conversationId: conversationA, content: 'Test', idempotencyKey,
    }));

    expect(response.status).toBe(503);
    expect(dependencies.complete).not.toHaveBeenCalled();
    expect(store.finalizeAttempt).toHaveBeenCalledWith(
      userA, requestA, expect.any(String),
      expect.objectContaining({ status: 'failed', errorCode: 'PROVIDER_NOT_CONFIGURED' }),
    );
  });

  it('does not expose provider keys in response or logs when providers fail', async () => {
    const { dependencies, store } = fixture();
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(store.selectRoute)
      .mockResolvedValueOnce({
        attemptId: '99999999-9999-4999-8999-999999999999',
        providerKey: 'groq', modelKey: 'groq-logical-key', providerModelKey: 'verified-groq-model',
      })
      .mockResolvedValueOnce({
        attemptId: '88888888-8888-4888-8888-888888888888',
        providerKey: 'gemini', modelKey: 'gemini-logical-key', providerModelKey: 'verified-gemini-model',
      });
    vi.mocked(dependencies.complete).mockRejectedValue(new ProviderCallError('PROVIDER_TIMEOUT', true));

    const response = await createBusinessGrowHandler(dependencies)(request({
      action: 'messages.send', conversationId: conversationA, content: 'Test', idempotencyKey,
    }));
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain('PROVIDER_TIMEOUT');
    expect(body).not.toContain('test-groq-secret');
    expect(body).not.toContain('test-gemini-secret');
    expect(logError).not.toHaveBeenCalled();
    expect(store.failRequest).toHaveBeenCalledWith(userA, requestA, 'PROVIDER_TIMEOUT');
    logError.mockRestore();
  });

  it('passes the authenticated owner and conversation to message history lookup', async () => {
    const { handler, store } = fixture();
    const response = await handler(request({ action: 'messages.list', conversationId: conversationA }));

    expect(response.status).toBe(200);
    expect(store.listMessages).toHaveBeenCalledWith(userA, conversationA);
  });

  it('scopes another user’s conversation lookup to the authenticated user, not body identity', async () => {
    const { handler, store, dependencies } = fixture();
    vi.mocked(dependencies.getUserId).mockResolvedValue(userB);
    const response = await handler(request({
      action: 'messages.list',
      conversationId: conversationA,
      user_id: userA,
    }, 'Bearer user-b'));

    expect(response.status).toBe(200);
    expect(store.listMessages).toHaveBeenCalledWith(userB, conversationA);
    expect(store.listMessages).not.toHaveBeenCalledWith(userA, conversationA);
  });

  it('does not misreport an unexpected route database error as provider unavailability', async () => {
    const { handler, store } = fixture();
    vi.mocked(store.selectRoute).mockRejectedValueOnce(new Error('database connection unavailable'));
    const response = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Test',
      idempotencyKey,
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'ROUTE_SELECTION_FAILED' },
    });
    expect(store.failRequest).toHaveBeenCalledWith(userA, requestA, 'ROUTE_SELECTION_FAILED');
  });

  it('does not log exception details that may contain connection or provider secrets', async () => {
    const { handler, store } = fixture();
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(store.listConversations).mockRejectedValueOnce(
      new Error('connection string contains a sensitive value'),
    );

    const response = await handler(request({ action: 'conversations.list' }));
    const loggedDetails = JSON.stringify(logError.mock.calls);

    expect(response.status).toBe(500);
    expect(loggedDetails).not.toContain('sensitive value');
    expect(loggedDetails).toContain('conversations.list');
    logError.mockRestore();
  });

  it('verifies providers live via probeProvider and persists verification result', async () => {
    const { dependencies, store } = fixture();
    const recordHealthCheck = vi.fn(async () => undefined);
    store.recordHealthCheck = recordHealthCheck;
    const probeMock = vi.fn(async (providerKey: BusinessProvider, config: ProviderConfig): Promise<ProviderProbeResult> => {
      if (!config.apiKey || !config.model) {
        return {
          providerKey,
          modelKey: config.model || '',
          status: 'failed',
          latencyMs: 0,
          errorCode: 'PROVIDER_NOT_CONFIGURED',
          availableModels: [],
        };
      }
      return {
        providerKey,
        modelKey: config.model,
        status: 'healthy',
        latencyMs: 42,
        errorCode: null,
        availableModels: ['verified-groq-model', 'other-model'],
      };
    });
    dependencies.probe = probeMock;

    const handler = createBusinessGrowHandler(dependencies);
    const okRes = await handler(request({ action: 'providers.verify', providerKey: 'groq' }));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toMatchObject({
      data: { providerKey: 'groq', status: 'healthy', latencyMs: 42 },
    });
    expect(recordHealthCheck).toHaveBeenCalledWith(expect.objectContaining({
      providerKey: 'groq',
      modelKey: 'verified-groq-model',
      status: 'healthy',
    }));

    dependencies.providerConfigs.gemini = { apiKey: '', model: '' };
    const missingRes = await handler(request({ action: 'providers.verify', providerKey: 'gemini' }));
    expect(missingRes.status).toBe(503);
    expect(await missingRes.json()).toMatchObject({ error: { code: 'PROVIDER_NOT_CONFIGURED' } });

    probeMock.mockResolvedValueOnce({
      providerKey: 'groq',
      modelKey: 'verified-groq-model',
      status: 'failed',
      latencyMs: 90,
      errorCode: 'PROVIDER_AUTH_FAILED',
      availableModels: [],
    });
    const failedRes = await handler(request({ action: 'providers.verify', providerKey: 'groq' }));
    expect(failedRes.status).toBe(502);
    expect(recordHealthCheck).toHaveBeenLastCalledWith(expect.objectContaining({
      providerKey: 'groq',
      status: 'failed',
      errorCode: 'PROVIDER_AUTH_FAILED',
    }));
  });

  it('supports roles, routing preferences, models discovery, quota, requests and integrations endpoints', async () => {
    const { dependencies, store } = fixture();
    store.listModels = vi.fn(async () => [{
      provider_key: 'groq',
      model_key: 'groq-main',
      provider_model_key: 'verified-groq-model',
      display_name: 'Groq Main',
      capabilities: { reasoning: true },
      enabled: true,
      verification_status: 'verified',
      max_input_tokens: 8192,
      max_output_tokens: 4096,
      verified_at: '2026-11-09T00:00:00Z',
    }]);
    store.listRoles = vi.fn(async () => []);
    store.getRoutingPreferences = vi.fn(async () => [{
      id: 'pref-1',
      role_key: 'marketing_campaign',
      selection_mode: 'manual',
      preferred_provider_key: 'groq',
      preferred_model_key: 'verified-groq-model',
      allow_fallback: false,
      updated_at: '2026-11-09T00:00:00Z',
    }]);
    const upsertRoutingPreference = vi.fn(async () => 'pref-1');
    store.upsertRoutingPreference = upsertRoutingPreference;
    store.getQuota = vi.fn(async () => ({
      domain: 'business_grow' as const,
      studio_ugc_untouched: true as const,
      available_units: 950,
      reserved_units: 0,
      monthly_allowance: 1000,
    }));
    store.listRecentRequests = vi.fn(async () => [{ id: requestA, status: 'succeeded' }]);
    store.listIntegrationConnections = vi.fn(async () => []);
    dependencies.discoverModels = vi.fn(async () => ['verified-groq-model']);

    const handler = createBusinessGrowHandler(dependencies);
    const modelsRes = await handler(request({ action: 'models.list', providerKey: 'groq', includeRemote: true }));
    expect(modelsRes.status).toBe(200);
    expect(await modelsRes.json()).toMatchObject({
      data: {
        models: [{ provider_key: 'groq', verification_status: 'verified' }],
        remoteModels: { groq: ['verified-groq-model'] },
      },
    });

    const rolesRes = await handler(request({ action: 'roles.list' }));
    expect(rolesRes.status).toBe(200);

    const savePrefRes = await handler(request({
      action: 'routing.save',
      roleKey: 'marketing_campaign',
      selectionMode: 'manual',
      preferredProviderKey: 'groq',
      preferredModelKey: 'verified-groq-model',
      allowFallback: false,
    }));
    expect(savePrefRes.status).toBe(200);
    expect(upsertRoutingPreference).toHaveBeenCalledWith(userA, 'marketing_campaign', {
      selectionMode: 'manual',
      preferredProviderKey: 'groq',
      preferredModelKey: 'verified-groq-model',
      allowFallback: false,
    });

    const quotaRes = await handler(request({ action: 'quota.status' }));
    expect(await quotaRes.json()).toMatchObject({
      data: { domain: 'business_grow', studio_ugc_untouched: true, available_units: 950 },
    });

    expect((await handler(request({ action: 'routing.get' }))).status).toBe(200);
    expect((await handler(request({ action: 'requests.list' }))).status).toBe(200);
    expect((await handler(request({ action: 'integrations.list' }))).status).toBe(200);
  });

  it('enforces isolated Business Grow quota and releases reservation on failed requests', async () => {
    const { dependencies, store } = fixture();
    const reserveQuota = vi.fn(async () => {
      throw new Error('BG_INSUFFICIENT_QUOTA');
    });
    const releaseQuota = vi.fn(async () => 1000);
    const captureQuota = vi.fn(async () => 999);
    store.reserveQuota = reserveQuota;
    store.releaseQuota = releaseQuota;
    store.captureQuota = captureQuota;

    const handler = createBusinessGrowHandler(dependencies);
    const blocked = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Test quota',
      idempotencyKey,
    }));
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ error: { code: 'BG_INSUFFICIENT_QUOTA' } });
    expect(store.failRequest).toHaveBeenCalledWith(userA, requestA, 'BG_INSUFFICIENT_QUOTA');

    reserveQuota.mockResolvedValueOnce({
      reserved: true, available_units: 999, reserved_units: 1, monthly_allowance: 1000,
    } as never);
    const releasedRes = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Route manquante',
      idempotencyKey,
    }));
    expect(releasedRes.status).toBe(503);
    expect(releaseQuota).toHaveBeenCalledWith(userA, requestA, 1, 'NO_VERIFIED_PROVIDER');
    expect(captureQuota).not.toHaveBeenCalled();
  });

  it('honors manual routing without fallback and injects workspace + consented memory context', async () => {
    const { dependencies, store } = fixture();
    store.getMemory = vi.fn(async () => ({
      consent: true,
      profile: { industry: 'Beauté naturelle' },
      items: [{ id: 'm1', category: 'audience', content: { text: 'Femmes 25-40 ans' }, created_at: '2026-01-01', updated_at: '2026-01-01' }],
    }));
    store.getWorkspaceContext = vi.fn(async () => ({
      workspace: { id: '11111111-1111-4111-8111-111111111111', name: 'Atelier Bamako', country_code: 'ML', default_language: 'fr' },
      brands: [{ name: 'Karité Pure', industry: 'Cosmétique', description: null, voice_guidelines: 'Direct et rassurant' }],
      products: [{ name: 'Baume Éclat', description: 'Hydratation intense', key_benefits: ['Naturel'], price_amount: 12000, price_currency: 'XOF' }],
    }));
    vi.mocked(store.selectRoute).mockResolvedValue({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'gemini',
      modelKey: 'gemini-logical',
      providerModelKey: 'verified-gemini-model',
    });
    vi.mocked(dependencies.complete).mockResolvedValueOnce({
      content: 'Voici la stratégie marketing.\n<!--REELORA_TOOL_PROPOSALS:[{"toolName":"handoff_ugc_brief","summary":"Créer un brief vidéo","arguments":{"hook":"Peau radieuse dès demain","cta":"Commandez maintenant"}}]-->',
      inputTokens: 40,
      outputTokens: 30,
    });
    store.createToolExecution = vi.fn(async () => 'tool-exec-1');

    const handler = createBusinessGrowHandler(dependencies);
    const res = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      roleKey: 'marketing_campaign',
      content: 'Propose une campagne et un brief UGC.',
      idempotencyKey,
      routing: {
        selectionMode: 'manual',
        preferredProviderKey: 'gemini',
        preferredModelKey: 'verified-gemini-model',
        allowFallback: false,
      },
    }));

    expect(res.status).toBe(200);
    const json = await res.json() as {
      data: {
        roleKey: string;
        toolProposals: Array<{ id: string | null; toolName: string; riskLevel: string }>;
      };
    };
    expect(json.data.roleKey).toBe('marketing_campaign');
    expect(json.data.toolProposals).toHaveLength(1);
    expect(json.data.toolProposals[0]).toMatchObject({
      id: 'tool-exec-1',
      toolName: 'handoff_ugc_brief',
      riskLevel: 'write_requires_approval',
    });

    const [, , sentMessages] = vi.mocked(dependencies.complete).mock.calls[0];
    expect(sentMessages[0].content).toContain('Atelier Bamako');
    expect(sentMessages[0].content).toContain('Karité Pure');
    expect(sentMessages[0].content).toContain('Baume Éclat');
    expect(sentMessages[0].content).toContain('Femmes 25-40 ans');
    expect(store.selectRoute).toHaveBeenCalledWith(
      userA, requestA, conversationA, 1, null, null, ['gemini'], [], 'verified-gemini-model',
    );
    expect(store.finalizeAttempt).toHaveBeenCalledWith(
      userA, requestA, '99999999-9999-4999-8999-999999999999',
      expect.objectContaining({ outputContent: 'Voici la stratégie marketing.' }),
    );
  });

  it('requires active consent to approve memory-write tool proposals and executes non-debiting UGC handoff', async () => {
    const { dependencies, store } = fixture();
    let activeToolName = 'propose_memory_save';
    let activeInputArgs: Record<string, unknown> = { category: 'positioning', text: 'Positionnement premium accessible' };
    store.resolveToolExecution = vi.fn(async (_userId, executionId, decision, outputResult) => ({
      id: executionId,
      tool_name: activeToolName,
      status: decision,
      input_args: activeInputArgs,
      output_result: outputResult,
    }));

    const handler = createBusinessGrowHandler(dependencies);
    const denied = await handler(request({
      action: 'tools.resolve',
      executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      decision: 'approved',
    }));
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: 'business_memory_consent_required' } });
    expect(store.putMemoryItem).not.toHaveBeenCalled();

    vi.mocked(store.getMemory).mockResolvedValueOnce({ consent: true, items: [] });
    const approvedMem = await handler(request({
      action: 'tools.resolve',
      executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      decision: 'approved',
    }));
    expect(approvedMem.status).toBe(200);
    expect(store.putMemoryItem).toHaveBeenCalledWith(userA, null, 'positioning', {
      text: 'Positionnement premium accessible',
      category: 'positioning',
    });

    activeToolName = 'handoff_ugc_brief';
    activeInputArgs = { product: 'Baume Éclat', hook: 'Stop les taches brunes', angle: 'Routine 7 jours' };
    const ugcRes = await handler(request({
      action: 'tools.resolve',
      executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      decision: 'approved',
    }));
    expect(ugcRes.status).toBe(200);
    expect(await ugcRes.json()).toMatchObject({
      data: {
        status: 'executed',
        output_result: {
          handoffDraft: {
            product: 'Baume Éclat',
            hook: 'Stop les taches brunes',
            consumesStudioCredits: false,
          },
        },
      },
    });
  });

  it('drops preferredModelKey on secondary provider fallback and loads saved role preferences when routing is omitted', async () => {
    const { dependencies, store } = fixture();
    store.getRoutingPreferences = vi.fn(async () => [
      {
        role_key: 'action_plan',
        selection_mode: 'manual',
        preferred_provider_key: 'groq',
        preferred_model_key: 'openai/gpt-oss-120b',
        allow_fallback: true,
      },
    ]);
    vi.mocked(store.selectRoute)
      .mockResolvedValueOnce({
        attemptId: '99999999-9999-4999-8999-999999999991',
        providerKey: 'groq',
        modelKey: 'openai-gpt-oss-120b',
        providerModelKey: 'openai/gpt-oss-120b',
      })
      .mockResolvedValueOnce({
        attemptId: '99999999-9999-4999-8999-999999999992',
        providerKey: 'gemini',
        modelKey: 'gemini-2.5-flash',
        providerModelKey: 'gemini-2.5-flash',
      });
    vi.mocked(dependencies.complete)
      .mockRejectedValueOnce(new ProviderCallError('PROVIDER_UNAVAILABLE', true))
      .mockResolvedValueOnce({ content: 'Plan de secours Gemini.', inputTokens: 20, outputTokens: 25 });

    const handler = createBusinessGrowHandler(dependencies);
    const res = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      roleKey: 'action_plan',
      content: 'Construis un plan 30/60/90.',
      idempotencyKey,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        status: 'succeeded',
        fallbackUsed: true,
        attemptsCount: 2,
        provider: { key: 'gemini', model: 'gemini-2.5-flash' },
      },
    });
    expect(store.selectRoute).toHaveBeenNthCalledWith(
      1, userA, requestA, conversationA, 1, null, null, ['groq', 'gemini'], [], 'openai/gpt-oss-120b',
    );
    expect(store.selectRoute).toHaveBeenNthCalledWith(
      2, userA, requestA, conversationA, 2, '99999999-9999-4999-8999-999999999991', 'PROVIDER_UNAVAILABLE', ['groq', 'gemini'], ['groq'],
    );
  });

  it('strips unclosed/truncated REELORA_TOOL_PROPOSALS markers and normalizes handoff_ugc_brief field aliases', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockResolvedValueOnce({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'gemini',
      modelKey: 'gemini-2.5-flash',
      providerModelKey: 'gemini-2.5-flash',
    });
    vi.mocked(dependencies.complete).mockResolvedValueOnce({
      content: 'Voici ton plan.\n---\n<!--REELORA_TOOL_PROPOSALS:[{"toolName":"propose_action_plan","summary":"Plan tronqué',
      inputTokens: 15,
      outputTokens: 20,
    });
    const handler = createBusinessGrowHandler(dependencies);
    const msgRes = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      roleKey: 'action_plan',
      content: 'Plan rapide',
      idempotencyKey,
    }));
    expect(msgRes.status).toBe(200);
    expect(store.finalizeAttempt).toHaveBeenCalledWith(
      userA, requestA, '99999999-9999-4999-8999-999999999999',
      expect.objectContaining({ status: 'succeeded', outputContent: 'Voici ton plan.' }),
    );

    store.resolveToolExecution = vi.fn(async (_u, executionId, decision, outputResult) => ({
      id: executionId,
      status: decision,
      tool_name: 'handoff_ugc_brief',
      input_args: { productName: 'Sérum Éclat', campaignAngle: 'Éclat naturel 7 jours', audience: 'Femmes 25-45' },
      output_result: outputResult,
    }));
    const handoffRes = await handler(request({
      action: 'tools.resolve',
      executionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      decision: 'approved',
    }));
    expect(handoffRes.status).toBe(200);
    expect(await handoffRes.json()).toMatchObject({
      data: {
        status: 'executed',
        output_result: {
          handoffDraft: {
            product: 'Sérum Éclat',
            angle: 'Éclat naturel 7 jours',
            targetAudience: 'Femmes 25-45',
            consumesStudioCredits: false,
          },
        },
      },
    });
  });

  it('returns 409 business_memory_consent_required when memory.item.put is called without active consent', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.putMemoryItem).mockRejectedValueOnce(new Error('active memory consent required'));
    const handler = createBusinessGrowHandler(dependencies);
    const res = await handler(request({
      action: 'memory.item.put',
      category: 'objectif',
      content: { text: 'Test' },
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: 'business_memory_consent_required' },
    });
  });

  it('supports scoped Netlify deploy preview wildcard origins while blocking spoofs', async () => {
    const { dependencies } = fixture();
    const handler = createBusinessGrowHandler({
      ...dependencies,
      allowedOrigins: ['https://deploy-preview-*--saas-ugc-growth.netlify.app'],
    });

    const allowedPreflight = await handler(new Request('https://edge.test/business-grow', {
      method: 'OPTIONS',
      headers: { Origin: 'https://deploy-preview-4--saas-ugc-growth.netlify.app' },
    }));
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://deploy-preview-4--saas-ugc-growth.netlify.app',
    );

    const spoofedPreflight = await handler(new Request('https://edge.test/business-grow', {
      method: 'OPTIONS',
      headers: { Origin: 'https://deploy-preview-4--saas-ugc-growth.netlify.app.evil.com' },
    }));
    expect(spoofedPreflight.status).toBe(403);
    expect(spoofedPreflight.headers.get('Access-Control-Allow-Origin'))
      .toBe('https://deploy-preview-4--saas-ugc-growth.netlify.app.evil.com');
    const spoofedBody = await spoofedPreflight.json() as { error?: { code?: string } };
    expect(spoofedBody.error?.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('falls back cleanly when preferredModelKey is unavailable and allowFallback is true', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockImplementation(async (_u, _r, _c, _attempt, _prev, _reason, _order, _ex, preferredModel) => {
      if (preferredModel) throw new NoVerifiedProviderRouteError();
      return {
        attemptId: '11111111-1111-4111-8111-111111111111',
        providerKey: 'groq',
        modelKey: 'openai-gpt-oss-120b',
        providerModelKey: 'openai/gpt-oss-120b',
      };
    });
    const handler = createBusinessGrowHandler(dependencies);
    const res = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Test fallback modèle indisponible',
      idempotencyKey,
      routing: {
        selectionMode: 'manual',
        preferredProviderKey: 'gemini',
        preferredModelKey: 'gemini-pro-latest',
        allowFallback: true,
      },
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        status: 'succeeded',
        provider: { key: 'groq', model: 'openai/gpt-oss-120b' },
      },
    });
    expect(store.selectRoute).toHaveBeenCalledTimes(2);
  });
});

describe('Origines des aperçus de travail (régression CORS)', () => {
  it('accepte un aperçu e2b de n’importe quelle session et refuse un hôte usurpé', async () => {
    const { dependencies } = fixture();
    const handler = createBusinessGrowHandler({
      ...dependencies,
      allowedOrigins: [...dependencies.allowedOrigins, 'https://*.e2b.app'],
    });

    for (const origin of [
      'https://4180-ia19ukd7j0vjzx70dsuks.e2b.app',
      'https://5173-iu476i6ok9qrn5o47a39w.e2b.app',
    ]) {
      const preflight = await handler(new Request('https://edge.test/business-grow', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }

    for (const origin of [
      'https://4180-ia19ukd7j0vjzx70dsuks.e2b.app.evil.com',
      'http://4180-ia19ukd7j0vjzx70dsuks.e2b.app',
    ]) {
      const blocked = await handler(new Request('https://edge.test/business-grow', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }));
      expect(blocked.status).toBe(403);
      // Refus explicite et lisible : l'origine est renvoyée pour que le navigateur
      // expose le 403 ORIGIN_NOT_ALLOWED au lieu d'une erreur réseau opaque.
      expect(blocked.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      const blockedBody = await blocked.json() as { error?: { code?: string } };
      expect(blockedBody.error?.code).toBe('ORIGIN_NOT_ALLOWED');
    }
  });
});
