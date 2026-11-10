import { describe, expect, it, vi } from 'vitest';
import {
  createBusinessGrowHandler,
  type BusinessGrowDependencies,
  type BusinessGrowStore,
} from '../supabase/functions/business-grow/handler';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
      throw new Error('no verified and healthy route');
    }),
    failRequest: vi.fn(async () => undefined),
    finalizeAttempt: vi.fn(async () => undefined),
  };
  const dependencies: BusinessGrowDependencies = {
    store,
    getUserId: vi.fn(async (authorization) => authorization === 'Bearer valid-token' ? userA : null),
    allowedOrigins: ['https://reelora.test'],
  };
  return { store, dependencies, handler: createBusinessGrowHandler(dependencies) };
}

function request(body: unknown, authorization = 'Bearer valid-token') {
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
    const response = await handler(request({ action: 'conversations.list' }, 'Bearer invalid-token'));

    expect(response.status).toBe(401);
    expect(store.listConversations).not.toHaveBeenCalled();
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
    const handler = createBusinessGrowHandler(dependencies);
    const response = await handler(request({
      action: 'conversations.rename',
      conversationId: conversationA,
      title: 'Intrusion',
    }));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  });

  it('stores the user message and request but returns an explicit no-provider result', async () => {
    const { handler, store } = fixture();
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
  });

  it('records an explicit failed attempt if a route exists but has no provider adapter', async () => {
    const { dependencies, store } = fixture();
    vi.mocked(store.selectRoute).mockResolvedValue({
      attemptId: '99999999-9999-4999-8999-999999999999',
      providerKey: 'groq',
      modelKey: 'unverified-model',
    });
    const handler = createBusinessGrowHandler(dependencies);
    const response = await handler(request({
      action: 'messages.send',
      conversationId: conversationA,
      content: 'Test explicite.',
      idempotencyKey,
    }));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('PROVIDER_ADAPTER_NOT_CONFIGURED');
    expect(store.finalizeAttempt).toHaveBeenCalledWith(
      userA, requestA, '99999999-9999-4999-8999-999999999999', 'PROVIDER_ADAPTER_NOT_CONFIGURED',
    );
    expect(store.failRequest).not.toHaveBeenCalled();
  });
});
