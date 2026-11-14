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
    listModuleRecords: vi.fn(async () => []),
    createModuleRecord: vi.fn(async () => 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
    updateModuleRecord: vi.fn(async () => true),
    deleteModuleRecord: vi.fn(async () => true),
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

  it('allows preflight negotiation but rejects disallowed POSTs before authentication or store access', async () => {
    const { handler, dependencies, store } = fixture();
    const origin = 'https://attacker.example';
    const preflight = await handler(new Request('https://edge.test/business-grow', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,apikey,content-type' },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('authorization');

    const denied = await handler(new Request('https://edge.test/business-grow', {
      method: 'POST',
      headers: { Origin: origin, Authorization: 'Bearer valid-user-session', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'conversations.create', title: 'ne doit pas exister' }),
    }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(await denied.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    expect(dependencies.getUserId).not.toHaveBeenCalled();
    expect(store.createConversation).not.toHaveBeenCalled();
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
    store.getMemory = vi.fn(async () => ({ consent: true, items: [{ category: 'secret', content: 'Autre espace historique' }] }));
    store.getConversationScope = vi.fn(async () => ({ workspaceId: '11111111-1111-4111-8111-111111111111' }));
    store.getScopedMemory = vi.fn(async () => ({
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
    expect(sentMessages[0].content).not.toContain('Autre espace historique');
    expect(store.getMemory).not.toHaveBeenCalled();
    expect(store.getScopedMemory).toHaveBeenCalledWith(userA, '11111111-1111-4111-8111-111111111111');
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
    expect(spoofedPreflight.status).toBe(204);
    const spoofedOrigin = 'https://deploy-preview-4--saas-ugc-growth.netlify.app.evil.com';
    expect(spoofedPreflight.headers.get('Access-Control-Allow-Origin')).toBe(spoofedOrigin);
    const denied = await handler(new Request('https://edge.test/business-grow', {
      method: 'POST', headers: { Origin: spoofedOrigin, Authorization: 'Bearer valid-user-session' },
      body: JSON.stringify({ action: 'status' }),
    }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
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

  it('liste les enregistrements d’un module métier autorisé', async () => {
    const { handler, store } = fixture();
    store.listModuleRecords = vi.fn(async () => [{
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      category: 'bg_module_lead_rescue',
      data: { name: 'Amina', status: 'nouveau' },
      created_at: '2026-11-13T10:00:00Z',
      updated_at: '2026-11-13T10:00:00Z',
    }]);

    const response = await handler(request({ action: 'modules.records', op: 'list', category: 'bg_module_lead_rescue' }));
    expect(response.status).toBe(200);
    expect(store.listModuleRecords).toHaveBeenCalledWith(userA, 'bg_module_lead_rescue');
    expect(await response.json()).toMatchObject({
      data: { records: [{ data: { name: 'Amina', status: 'nouveau' } }] },
    });
  });

  it('refuse une catégorie de module inconnue avant tout accès au stockage', async () => {
    const { handler, store } = fixture();
    const response = await handler(request({ action: 'modules.records', op: 'list', category: 'public.ugc_projects' }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe('INVALID_MODULE');
    expect(store.listModuleRecords).not.toHaveBeenCalled();
  });

  it('crée un enregistrement avec une clé de déduplication', async () => {
    const { handler, store } = fixture();
    const response = await handler(request({
      action: 'modules.records',
      op: 'create',
      category: 'bg_module_operations_manager',
      data: { title: 'Relancer la facture', status: 'a_faire' },
      dedupeKey: 'playbook:record',
    }));
    expect(response.status).toBe(200);
    expect(store.createModuleRecord).toHaveBeenCalledWith(
      userA, 'bg_module_operations_manager',
      { title: 'Relancer la facture', status: 'a_faire' },
      'playbook:record',
    );
  });

  it('renvoie 404 quand la mise à jour ne trouve aucun enregistrement', async () => {
    const { handler, store } = fixture();
    store.updateModuleRecord = vi.fn(async () => false);
    const response = await handler(request({
      action: 'modules.records',
      op: 'update',
      category: 'bg_module_lead_rescue',
      recordId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      data: { status: 'relance' },
    }));
    expect(response.status).toBe(404);
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe('MODULE_RECORD_NOT_FOUND');
  });

  it('signale honnêtement un stockage de modules non déployé', async () => {
    const { dependencies } = fixture();
    const store = { ...dependencies.store, listModuleRecords: undefined };
    const unavailable = createBusinessGrowHandler({ ...dependencies, store });
    const response = await unavailable(request({ action: 'modules.records', op: 'list', category: 'bg_module_lead_rescue' }));
    expect(response.status).toBe(503);
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe('MODULES_UNAVAILABLE');
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
      const preflight = await handler(new Request('https://edge.test/business-grow', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      }));
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      const blocked = await handler(new Request('https://edge.test/business-grow', {
        method: 'POST', headers: { Origin: origin, Authorization: 'Bearer valid-user-session' },
        body: JSON.stringify({ action: 'status' }),
      }));
      expect(blocked.status).toBe(403);
      expect(blocked.headers.get('Access-Control-Allow-Origin')).toBe(origin);
      expect(await blocked.json()).toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
    }
  });
});

describe('Business Agent Phase 3 · API cloisonnée et consentement', () => {
  const workspace = '11111111-1111-4111-8111-111111111111';
  const otherWorkspace = '22222222-2222-4222-8222-222222222222';
  const source = '33333333-3333-4333-8333-333333333333';
  const snapshot = {
    crmConsent: true,
    crm: [{ id: source, data: { name: 'Awa secrète', email: 'secret@example.test', stage: 'perdu' } }],
    modules: { bg_module_payment_recovery: [{ id: source, data: { invoiceRef: 'FAC-PRIVÉE', customer: 'Client secret', notes: 'instruction secrète', status: 'en_retard', dueDate: '2026-01-01', amount: 75000 } }] },
  };

  it('exige le protocole SQL complet avant toute opération v3', async () => {
    const { handler, store } = fixture();
    const body = { action: 'v3.conversations.create', workspaceId: workspace, title: 'Entreprise' };
    expect((await handler(request(body))).status).toBe(503);
    expect(store.createConversation).not.toHaveBeenCalled();
    store.getWorkspaceProtocol = vi.fn(async () => 'business-workspace-v3');
    vi.mocked(store.getWorkspaceProtocol).mockRejectedValueOnce(new Error('function does not exist'));
    expect((await handler(request(body))).status).toBe(503);
    vi.mocked(store.getWorkspaceProtocol).mockRejectedValueOnce(new Error('workspace access denied'));
    expect((await handler(request(body))).status).toBe(403);
    vi.mocked(store.getWorkspaceProtocol).mockResolvedValueOnce('old-version');
    expect((await handler(request(body))).status).toBe(503);
    expect(store.createConversation).not.toHaveBeenCalled();
    expect((await handler(request({ ...body, workspaceId: null }))).status).toBe(400);
    expect((await handler(request({ ...body, action: 'v3.status' }))).status).toBe(400);
    expect((await handler(request(body))).status).toBe(200);
    expect(store.getWorkspaceProtocol).toHaveBeenCalledWith(userA, workspace);
    expect(store.createConversation).toHaveBeenCalledWith(userA, 'Entreprise', workspace);
  });

  it('ne lit ni ne modifie une conversation ou proposition d’une autre entreprise en v3', async () => {
    const { handler, store } = fixture();
    store.getWorkspaceProtocol = vi.fn(async () => 'business-workspace-v3');
    store.getConversationScope = vi.fn(async () => ({ workspaceId: otherWorkspace }));
    store.listToolExecutions = vi.fn(async () => []);
    store.resolveScopedAgentTool = vi.fn(async () => ({ status: 'executed' }));
    for (const action of ['v3.conversations.rename', 'v3.conversations.delete', 'v3.messages.list', 'v3.tools.list']) {
      expect((await handler(request({ action, workspaceId: workspace, conversationId: conversationA, title: 'Nouveau' }))).status).toBe(404);
    }
    expect(store.renameConversation).not.toHaveBeenCalled();
    expect(store.deleteConversation).not.toHaveBeenCalled();
    expect(store.listMessages).not.toHaveBeenCalled();
    expect(store.listToolExecutions).not.toHaveBeenCalled();
    vi.mocked(store.getConversationScope).mockResolvedValue({ workspaceId: workspace });
    expect((await handler(request({ action: 'v3.tools.list', workspaceId: workspace, conversationId: conversationA }))).status).toBe(200);
    expect(store.listToolExecutions).toHaveBeenCalledWith(userA, conversationA);
    expect((await handler(request({ action: 'v3.tools.resolve', workspaceId: workspace, executionId: source, decision: 'approved' }))).status).toBe(200);
    expect(store.resolveScopedAgentTool).toHaveBeenCalledWith(userA, workspace, source, 'approved');
    expect(store.resolveAgentTool).toBeUndefined();
    expect((await handler(request({ action: 'v3.tools.list', workspaceId: workspace }))).status).toBe(400);
  });

  it('confirme une tâche d’automatisation uniquement via le protocole et le store scoped', async () => {
    const { handler, store } = fixture();
    store.getWorkspaceProtocol = vi.fn(async () => 'business-workspace-v3');
    const body = { action: 'v3.automation.task.confirm', workspaceId: workspace, playbookId: conversationA,
      sourceCategory: 'bg_module_order_cart_recovery', sourceId: source, previewDay: '2026-11-13',
      expectedPlaybook: { status: 'actif', trigger: 'panier_abandonne' }, expectedSource: { status: 'panier' },
      task: { status: 'a_faire', title: 'Relance', sourceRecordId: source }, user_id: userB };
    expect((await handler(request({ ...body, action: 'automation.task.confirm' }))).status).toBe(400);
    expect((await handler(request(body))).status).toBe(503);
    store.confirmAutomationTask = vi.fn(async () => ({ taskId: requestA, created: true }));
    for (const invalid of [
      { previewDay: '2026-02-30' }, { sourceCategory: 'growth_prospect' },
      { sourceId: 'invalid' }, { expectedSource: [] }, { task: {} }, { workspaceId: null },
    ]) expect((await handler(request({ ...body, ...invalid }))).status).toBe(400);
    expect(store.confirmAutomationTask).not.toHaveBeenCalled();
    const response = await handler(request(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { taskId: requestA, created: true } });
    expect(store.confirmAutomationTask).toHaveBeenCalledWith(userA, workspace, conversationA, body.sourceCategory, source, body.previewDay, body.expectedPlaybook, body.expectedSource, body.task);
    expect(store.createModuleRecord).not.toHaveBeenCalled();
    for (const [message, code] of [
      ['automation source changed', 'AUTOMATION_SOURCE_CHANGED'],
      ['automation source no longer eligible', 'AUTOMATION_SOURCE_CHANGED'],
      ['automation preview expired', 'AUTOMATION_PREVIEW_EXPIRED'],
    ]) {
      vi.mocked(store.confirmAutomationTask).mockRejectedValueOnce(new Error(message));
      const failed = await handler(request(body));
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ error: { code } });
    }
  });

  it('isole toutes les opérations d’intégration et refuse le repli global', async () => {
    const { handler, store } = fixture();
    store.getWorkspaceProtocol = vi.fn(async () => 'business-workspace-v3');
    store.listIntegrationConnections = vi.fn(async () => [{ status: 'global' }]);
    store.requestIntegrationConnection = vi.fn(async () => 'pending');
    const legacyRequest = await handler(request({ action: 'integrations.request', workspaceId: workspace, connectorKey: 'shopify' }));
    expect(legacyRequest.status).toBe(409);
    expect(await legacyRequest.json()).toMatchObject({ error: { code: 'BUSINESS_GROW_UPGRADE_REQUIRED' } });
    store.cancelIntegrationRequest = vi.fn(async () => true);
    store.disconnectIntegrationConnection = vi.fn(async () => true);
    for (const action of ['list', 'request', 'cancel', 'disconnect']) {
      expect((await handler(request({ action: `v3.integrations.${action}`, workspaceId: workspace, connectorKey: 'shopify' }))).status).toBe(503);
    }
    expect(store.listIntegrationConnections).not.toHaveBeenCalled();
    expect(store.requestIntegrationConnection).not.toHaveBeenCalled();
    expect(store.cancelIntegrationRequest).not.toHaveBeenCalled();
    expect(store.disconnectIntegrationConnection).not.toHaveBeenCalled();
    store.listScopedIntegrationConnections = vi.fn(async () => []);
    store.requestScopedIntegrationConnection = vi.fn(async () => 'pending');
    store.cancelScopedIntegrationRequest = vi.fn(async () => true);
    store.disconnectScopedIntegrationConnection = vi.fn(async () => true);
    for (const action of ['list', 'request', 'cancel', 'disconnect']) {
      expect((await handler(request({ action: `v3.integrations.${action}`, workspaceId: workspace, connectorKey: 'shopify', user_id: userB }))).status).toBe(200);
    }
    expect(store.listScopedIntegrationConnections).toHaveBeenCalledWith(userA, workspace);
    expect(store.requestScopedIntegrationConnection).toHaveBeenCalledWith(userA, workspace, 'shopify');
    expect(store.cancelScopedIntegrationRequest).toHaveBeenCalledWith(userA, workspace, 'shopify');
    expect(store.disconnectScopedIntegrationConnection).toHaveBeenCalledWith(userA, workspace, 'shopify');
    expect((await handler(request({ action: 'v3.integrations.request', workspaceId: workspace, connectorKey: 'invalid' }))).status).toBe(400);
  });

  it('oriente conversations, mémoire et détails vers le périmètre demandé sans repli personnel', async () => {
    const { handler, store } = fixture();
    store.listScopedConversations = vi.fn(async () => [{ id: conversationA }]);
    store.getScopedMemory = vi.fn(async () => ({ consent: true, profile: { company: 'A' }, items: [] }));
    store.listScopedRecentRequests = vi.fn(async () => [{ id: requestA }]);
    store.listRecentRequests = vi.fn(async () => [{ id: 'global' }]);
    const conv = await handler(request({ action: 'conversations.list', workspaceId: workspace, user_id: userB }));
    const mem = await handler(request({ action: 'memory.get', workspaceId: workspace }));
    const history = await handler(request({ action: 'requests.list', workspaceId: workspace }));
    expect([conv.status, mem.status, history.status]).toEqual([200, 200, 200]);
    expect(store.listScopedConversations).toHaveBeenCalledWith(userA, workspace);
    expect(store.getScopedMemory).toHaveBeenCalledWith(userA, workspace);
    expect(store.listScopedRecentRequests).toHaveBeenCalledWith(userA, workspace, 25);
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.getMemory).not.toHaveBeenCalled();
    expect(store.listRecentRequests).not.toHaveBeenCalled();
    expect(await history.json()).toMatchObject({ data: { requests: [{ id: requestA }] } });
  });

  it('échoue de façon fermée si les services scoped sont indisponibles ou le workspace invalide', async () => {
    const { handler, store } = fixture();
    for (const action of ['conversations.list', 'requests.list', 'memory.get']) {
      const unavailable = await handler(request({ action, workspaceId: workspace }));
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ error: { code: 'AGENT_UNAVAILABLE' } });
      const invalid = await handler(request({ action, workspaceId: 'not-a-uuid' }));
      expect(invalid.status).toBe(400);
    }
    expect(store.listConversations).not.toHaveBeenCalled();
    expect(store.getMemory).not.toHaveBeenCalled();
  });

  it('transmet le scope aux mutations des modules et de la mémoire', async () => {
    const { handler, store } = fixture();
    store.listScopedModuleRecords = vi.fn(async () => []);
    store.createScopedModuleRecord = vi.fn(async () => source);
    store.updateScopedModuleRecord = vi.fn(async () => true);
    store.deleteScopedModuleRecord = vi.fn(async () => true);
    store.putScopedMemoryItem = vi.fn(async () => source);
    const base = { action: 'modules.records', category: 'bg_module_payment_recovery', workspaceId: workspace };
    expect((await handler(request({ ...base, op: 'create', data: { amount: 123 }, dedupeKey: 'dedupe' }))).status).toBe(200);
    expect((await handler(request({ ...base, op: 'update', recordId: source, data: { status: 'paye' } }))).status).toBe(200);
    expect((await handler(request({ ...base, op: 'delete', recordId: source }))).status).toBe(200);
    expect((await handler(request({ action: 'memory.item.put', workspaceId: workspace, category: 'goals', content: { text: 'objectif' } }))).status).toBe(200);
    expect(store.createScopedModuleRecord).toHaveBeenCalledWith(userA, workspace, base.category, { amount: 123 }, 'dedupe');
    expect(store.updateScopedModuleRecord).toHaveBeenCalledWith(userA, workspace, base.category, source, { status: 'paye' });
    expect(store.deleteScopedModuleRecord).toHaveBeenCalledWith(userA, workspace, base.category, source);
    expect(store.putScopedMemoryItem).toHaveBeenCalledWith(userA, workspace, null, 'goals', { text: 'objectif' });
    expect(store.createModuleRecord).not.toHaveBeenCalled();
    expect(store.putMemoryItem).not.toHaveBeenCalled();
  });

  it('calcule un rapport sans fournisseur, ne sauvegarde que sur demande et valide période et idempotence', async () => {
    const { handler, store, dependencies } = fixture();
    store.getBusinessSnapshot = vi.fn(async () => snapshot);
    store.saveAgentReport = vi.fn(async (_u, _w, _t, _f, _to, _key, report) => ({ report, created: true }));
    store.listAgentReports = vi.fn(async () => [{ id: source }]);
    const args = { action: 'agent.report', workspaceId: workspace, reportType: 'recovery', from: '2026-01-01', to: '2026-11-13' };
    const analyzed = await handler(request(args));
    expect(analyzed.status).toBe(200);
    const result = await analyzed.json() as { data: { saved: boolean; report: { recommendations: Array<{ kind: string }> } } };
    expect(result.data.saved).toBe(false);
    expect(result.data.report.recommendations.map((item) => item.kind)).toContain('invoice_overdue');
    expect(store.getBusinessSnapshot).toHaveBeenCalledWith(userA, workspace);
    expect(store.saveAgentReport).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
    const badSave = await handler(request({ ...args, save: true }));
    expect(badSave.status).toBe(400);
    expect(store.saveAgentReport).not.toHaveBeenCalled();
    const saved = await handler(request({ ...args, save: true, idempotencyKey }));
    expect(saved.status).toBe(200);
    expect(store.saveAgentReport).toHaveBeenCalledWith(userA, workspace, 'recovery', args.from, args.to, idempotencyKey, expect.objectContaining({ type: 'recovery' }));
    expect((await handler(request({ action: 'agent.reports.list', workspaceId: workspace }))).status).toBe(200);
    expect(store.listAgentReports).toHaveBeenCalledWith(userA, workspace);
    expect((await handler(request({ ...args, from: '2026-01-01', to: '2027-01-02' }))).status).toBe(400);
    expect((await handler(request({ ...args, reportType: 'sql arbitraire' }))).status).toBe(400);
  });

  it('supprime uniquement le rapport du compte et de l’entreprise autorisés', async () => {
    const { handler, store } = fixture();
    store.deleteAgentReport = vi.fn(async () => true);
    const invalid = await handler(request({ action: 'agent.reports.delete', workspaceId: workspace, reportId: 'invalid' }));
    expect(invalid.status).toBe(400);
    expect(store.deleteAgentReport).not.toHaveBeenCalled();
    const deleted = await handler(request({ action: 'agent.reports.delete', workspaceId: workspace, reportId: source, user_id: userB }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ data: { deleted: true } });
    expect(store.deleteAgentReport).toHaveBeenCalledWith(userA, workspace, source);
    vi.mocked(store.deleteAgentReport).mockResolvedValueOnce(false);
    const missing = await handler(request({ action: 'agent.reports.delete', workspaceId: otherWorkspace, reportId: source }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: 'REPORT_NOT_FOUND' } });
  });

  it('exige une confirmation explicite pour importer l’historique et transmet le scope', async () => {
    const { handler, store } = fixture();
    store.importLegacyMemory = vi.fn(async () => ({ importedItems: 1, importedProfile: false }));
    const rejected = await handler(request({ action: 'memory.legacy.import', workspaceId: workspace, confirmed: 'true' }));
    expect(rejected.status).toBe(400);
    expect(store.importLegacyMemory).not.toHaveBeenCalled();
    const accepted = await handler(request({ action: 'memory.legacy.import', workspaceId: workspace, confirmed: true }));
    expect(accepted.status).toBe(200);
    expect(store.importLegacyMemory).toHaveBeenCalledWith(userA, workspace);
    expect(await accepted.json()).toMatchObject({ data: { importedItems: 1, importedProfile: false } });
  });

  it('prépare une proposition sans créer de tâche, puis exige une décision humaine et propage une source modifiée', async () => {
    const { handler, store, dependencies } = fixture();
    store.proposeAgentTask = vi.fn(async () => ({ id: source, status: 'pending_approval' }));
    store.resolveAgentTool = vi.fn(async () => { throw new Error('agent source changed'); });
    const proposed = await handler(request({ action: 'agent.task.propose', workspaceId: workspace, conversationId: conversationA, sourceCategory: 'bg_module_payment_recovery', sourceRecordId: source, idempotencyKey }));
    expect(proposed.status).toBe(200);
    expect(store.proposeAgentTask).toHaveBeenCalledWith(userA, workspace, conversationA, 'bg_module_payment_recovery', source, idempotencyKey);
    expect(store.createModuleRecord).not.toHaveBeenCalled();
    expect(store.resolveAgentTool).not.toHaveBeenCalled();
    const noDecision = await handler(request({ action: 'tools.resolve', executionId: source }));
    expect(noDecision.status).toBe(400);
    const conflict = await handler(request({ action: 'tools.resolve', executionId: source, decision: 'approved' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'AGENT_SOURCE_CHANGED' } });
    expect(store.resolveAgentTool).toHaveBeenCalledWith(userA, source, 'approved');
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it('refuse une conversation d’une autre entreprise avant de lire la mémoire ou d’écrire un message', async () => {
    const { handler, store, dependencies } = fixture();
    store.getConversationScope = vi.fn(async () => ({ workspaceId: otherWorkspace }));
    store.getScopedMemory = vi.fn(async () => ({ consent: true }));
    const response = await handler(request({ action: 'messages.send', workspaceId: workspace, conversationId: conversationA, content: 'Bonjour', idempotencyKey }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
    expect(store.getScopedMemory).not.toHaveBeenCalled();
    expect(store.getMemory).not.toHaveBeenCalled();
    expect(store.submitUserMessage).not.toHaveBeenCalled();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it('fournit au modèle des faits numériques, sans noms ni notes du diagnostic ou contacts CRM', async () => {
    const { handler, store, dependencies } = fixture();
    store.getConversationScope = vi.fn(async () => ({ workspaceId: workspace }));
    store.getScopedMemory = vi.fn(async () => ({ consent: true, items: [{ category: 'growth_prospect', content: { email: 'secret@example.test', name: 'Awa secrète' } }] }));
    store.getBusinessSnapshot = vi.fn(async () => snapshot);
    vi.mocked(store.selectRoute).mockResolvedValue({ attemptId: source, providerKey: 'groq', modelKey: 'groq-logical-key', providerModelKey: 'verified-groq-model' });
    const response = await handler(request({ action: 'messages.send', conversationId: conversationA, workspaceId: workspace, content: 'Analyse les priorités.', idempotencyKey }));
    expect(response.status).toBe(200);
    const prompt = vi.mocked(dependencies.complete).mock.calls[0][2][0].content;
    expect(prompt).toContain('75000');
    expect(prompt).toContain('invoice_overdue');
    for (const secret of ['Awa secrète', 'secret@example.test', 'FAC-PRIVÉE', 'Client secret', 'instruction secrète']) expect(prompt).not.toContain(secret);
    expect(store.getMemory).not.toHaveBeenCalled();
  });
});
