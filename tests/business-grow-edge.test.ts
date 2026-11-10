import { describe, expect, it, vi } from 'vitest';
import {
  createBusinessGrowHandler,
  NoVerifiedProviderRouteError,
  type BusinessGrowDependencies,
  type BusinessGrowStore,
} from '../supabase/functions/business-grow/handler';
import { ProviderCallError } from '../supabase/functions/business-grow/providers';

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
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
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
    ]);
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
});
