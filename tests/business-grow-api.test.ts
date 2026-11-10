import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession, invoke } = vi.hoisted(() => ({
  getSession: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  supabase: {
    auth: { getSession },
    functions: { invoke },
  },
}));

import { BusinessGrowApiError, businessGrowApi } from '../src/business/api';

describe('Business Grow browser API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({
      data: { session: { access_token: 'test-session-token' } },
      error: null,
    });
  });

  it('does not call the Edge Function without the existing Reelora session', async () => {
    getSession.mockResolvedValueOnce({ data: { session: null }, error: null });

    await expect(businessGrowApi.listConversations()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('explains an unavailable Edge Function without exposing a raw SDK message', async () => {
    const fetchError = Object.assign(new Error('Failed to send a request to the Edge Function'), {
      name: 'FunctionsFetchError',
      context: new TypeError('fetch failed'),
    });
    invoke.mockResolvedValueOnce({ data: null, error: fetchError });

    await expect(businessGrowApi.listConversations()).rejects.toMatchObject({
      code: 'BUSINESS_GROW_UNAVAILABLE',
      message: expect.stringContaining('backend Business Grow'),
    });
    expect(invoke).toHaveBeenCalledWith('business-grow', {
      body: { action: 'conversations.list' },
    });
  });

  it('maps an undeployed Edge Function response to an actionable unavailable error', async () => {
    invoke.mockResolvedValueOnce({
      data: null,
      error: Object.assign(new Error('Function not found'), {
        name: 'FunctionsHttpError',
        context: new Response('not found', { status: 404 }),
      }),
    });

    const error = await businessGrowApi.getStatus().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusinessGrowApiError);
    expect(error).toMatchObject({
      code: 'BUSINESS_GROW_UNAVAILABLE',
      status: 404,
    });
  });

  it('can target only the local Supabase Edge endpoint in development', async () => {
    vi.stubEnv(
      'VITE_BUSINESS_GROW_FUNCTION_URL',
      'http://127.0.0.1:54321/functions/v1/business-grow',
    );
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { conversations: [] } }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(businessGrowApi.listConversations()).resolves.toEqual({ conversations: [] });
      const [url, init] = fetcher.mock.calls[0];
      expect(String(url)).toBe('http://127.0.0.1:54321/functions/v1/business-grow');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-session-token');
      expect(new Headers(init?.headers).get('apikey')).toBe('test-publishable-key');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('rejects a non-loopback function URL without sending the session anywhere', async () => {
    vi.stubEnv('VITE_BUSINESS_GROW_FUNCTION_URL', 'https://attacker.example/functions/v1/business-grow');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    invoke.mockResolvedValueOnce({ data: { data: { conversations: [] } }, error: null });

    try {
      const error = await businessGrowApi.listConversations().catch((caught: unknown) => caught);

      expect(fetcher).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(error).toMatchObject({ code: 'INVALID_LOCAL_FUNCTION_URL' });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('invokes new Business Grow actions cleanly with structured payloads', async () => {
    invoke.mockResolvedValue({ data: { data: { ok: true } }, error: null });

    await businessGrowApi.verifyProvider('groq', 'llama-3.3-70b-versatile');
    expect(invoke).toHaveBeenLastCalledWith('business-grow', {
      body: { action: 'providers.verify', providerKey: 'groq', modelKey: 'llama-3.3-70b-versatile' },
    });

    await businessGrowApi.listModels('gemini', true);
    expect(invoke).toHaveBeenLastCalledWith('business-grow', {
      body: { action: 'models.list', providerKey: 'gemini', includeRemote: true },
    });

    await businessGrowApi.saveRouting({
      roleKey: 'action_plan',
      selectionMode: 'manual',
      preferredProviderKey: 'groq',
      preferredModelKey: null,
      allowFallback: false,
    });
    expect(invoke).toHaveBeenLastCalledWith('business-grow', {
      body: {
        action: 'routing.save',
        roleKey: 'action_plan',
        selectionMode: 'manual',
        preferredProviderKey: 'groq',
        preferredModelKey: null,
        allowFallback: false,
      },
    });

    await businessGrowApi.getQuota();
    expect(invoke).toHaveBeenLastCalledWith('business-grow', { body: { action: 'quota.status' } });

    await businessGrowApi.resolveTool('tool-1', 'approved');
    expect(invoke).toHaveBeenLastCalledWith('business-grow', {
      body: { action: 'tools.resolve', executionId: 'tool-1', decision: 'approved' },
    });

    await businessGrowApi.listIntegrations();
    expect(invoke).toHaveBeenLastCalledWith('business-grow', { body: { action: 'integrations.list' } });

    await businessGrowApi.sendMessage('conv-1', 'Hello', 'idem-1', {
      roleKey: 'marketing_campaign',
      workspaceId: 'ws-1',
      routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: false },
    });
    expect(invoke).toHaveBeenLastCalledWith('business-grow', {
      body: {
        action: 'messages.send',
        conversationId: 'conv-1',
        content: 'Hello',
        idempotencyKey: 'idem-1',
        roleKey: 'marketing_campaign',
        workspaceId: 'ws-1',
        routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: false },
      },
    });
  });
});
