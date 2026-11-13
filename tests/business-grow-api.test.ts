import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession, invoke, publicConfig } = vi.hoisted(() => ({
  getSession: vi.fn(),
  invoke: vi.fn(),
  publicConfig: { url: 'https://xbuuhfwobrafcbgtdgjx.supabase.co' },
}));

vi.mock('../src/lib/supabase', () => ({
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  get SUPABASE_URL() { return publicConfig.url; },
  supabase: {
    auth: { getSession },
    functions: { invoke },
  },
}));

import { BusinessGrowApiError, businessGrowApi } from '../src/business/api';

describe('Business Grow browser API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicConfig.url = 'https://xbuuhfwobrafcbgtdgjx.supabase.co';
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

  it('appelle la fonction Edge avec le JWT VYORA explicite', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { conversations: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { location: { hostname: '4173-demo.e2b.app' } });

    try {
      await expect(businessGrowApi.listConversations()).resolves.toEqual({ conversations: [] });
      const [url, init] = fetcher.mock.calls[0];
      expect(String(url)).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/business-grow');
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-session-token');
      expect(headers.get('apikey')).toBe('test-publishable-key');
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('ne prétend jamais que la fonction n’est pas déployée quand le réseau échoue', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { location: { hostname: '4173-demo.e2b.app' } });

    try {
      const error = await businessGrowApi.listConversations().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BusinessGrowApiError);
      expect(error).toMatchObject({ code: 'BUSINESS_GROW_UNREACHABLE' });
      // Aucune affirmation d'absence de déploiement : ce serait un diagnostic inventé.
      expect((error as BusinessGrowApiError).message).not.toMatch(/absent|déployée|pas encore installé/i);
      // Sur Vite, le relais same-origin constitue le secours du chemin direct.
      const targets = fetcher.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toContain('/functions/v1/business-grow');
      expect(targets[1]).toBe('/api/business-grow');
      expect(targets).not.toContain('/.netlify/functions/business-grow');
      expect((error as BusinessGrowApiError).message).not.toMatch(/JSON invalide|404/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bascule sur le relais same-origin quand seul l’appel direct est bloqué', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('supabase.co')) throw new TypeError('Blocked by client');
      return new Response(JSON.stringify({ data: { providers: [{ provider_key: 'groq' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { location: { hostname: 'vyora-ugc.netlify.app' } });

    try {
      await expect(businessGrowApi.getStatus()).resolves.toEqual({
        providers: [{ provider_key: 'groq' }],
      });
      expect(fetcher.mock.calls.map((call) => String(call[0]))).toContain('/api/business-grow');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('n’attribue jamais un 404 à un déploiement manquant : un 404 métier est propagé', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ error: { code: 'MEMORY_ITEM_NOT_FOUND', message: 'Note mémoire introuvable.' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { location: { hostname: 'vyora-ugc.netlify.app' } });

    try {
      const error = await businessGrowApi.getStatus().catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: 'MEMORY_ITEM_NOT_FOUND', status: 404 });
      expect((error as BusinessGrowApiError).message).toBe('Note mémoire introuvable.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes local Supabase development through the same-origin relay', async () => {
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
      expect(String(url)).toBe('/api/business-grow');
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

  it('never sends another Supabase project’s JWT to the canonical Netlify relay', async () => {
    publicConfig.url = 'https://other-project.supabase.co';
    vi.stubGlobal('window', { location: { hostname: 'vyora-ugc.netlify.app' } });
    const fetcher = vi.fn(async (_input: RequestInfo | URL) => { throw new TypeError('Blocked'); });
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(businessGrowApi.getStatus()).rejects.toMatchObject({ code: 'BUSINESS_GROW_UNREACHABLE' });
      expect(fetcher.mock.calls).toHaveLength(1);
      expect(String(fetcher.mock.calls[0][0])).toBe('https://other-project.supabase.co/functions/v1/business-grow');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'http://127.0.0.1:54321/functions/v1/business-grow?redirect=evil',
    'http://user:password@127.0.0.1:54321/functions/v1/business-grow',
    'http://localhost:1234/functions/v1/business-grow',
  ])('rejects an unsafe local function override before sending a token: %s', async (url) => {
    vi.stubEnv('VITE_BUSINESS_GROW_FUNCTION_URL', url);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(businessGrowApi.getStatus()).rejects.toMatchObject({ code: 'INVALID_LOCAL_FUNCTION_URL' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it('invokes new Business Grow actions cleanly with structured payloads', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('window', { location: { hostname: '4173-demo.e2b.app' } });

    try {
      await businessGrowApi.verifyProvider('groq', 'llama-3.3-70b-versatile');
      expect(bodies.at(-1)).toEqual({
        action: 'providers.verify', providerKey: 'groq', modelKey: 'llama-3.3-70b-versatile',
      });

      await businessGrowApi.listModels('gemini', true);
      expect(bodies.at(-1)).toEqual({ action: 'models.list', providerKey: 'gemini', includeRemote: true });

      await businessGrowApi.saveRouting({
        roleKey: 'action_plan',
        selectionMode: 'manual',
        preferredProviderKey: 'groq',
        preferredModelKey: null,
        allowFallback: false,
      });
      expect(bodies.at(-1)).toEqual({
        action: 'routing.save',
        roleKey: 'action_plan',
        selectionMode: 'manual',
        preferredProviderKey: 'groq',
        preferredModelKey: null,
        allowFallback: false,
      });

      await businessGrowApi.getQuota();
      expect(bodies.at(-1)).toEqual({ action: 'quota.status' });

      await businessGrowApi.resolveTool('tool-1', 'approved');
      expect(bodies.at(-1)).toEqual({ action: 'tools.resolve', executionId: 'tool-1', decision: 'approved' });

      await businessGrowApi.listIntegrations();
      expect(bodies.at(-1)).toEqual({ action: 'integrations.list' });

      await businessGrowApi.sendMessage('conv-1', 'Hello', 'idem-1', {
        roleKey: 'marketing_campaign',
        workspaceId: 'ws-1',
        routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: false },
      });
      expect(bodies.at(-1)).toEqual({
        action: 'messages.send',
        conversationId: 'conv-1',
        content: 'Hello',
        idempotencyKey: 'idem-1',
        roleKey: 'marketing_campaign',
        workspaceId: 'ws-1',
        routing: { selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: false },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('routes Netlify Deploy Preview calls directly through /api/business-grow with function fallback', async () => {
    vi.stubGlobal('window', { location: { hostname: 'deploy-preview-4--saas-ugc-growth.netlify.app' } });
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/business-grow') {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ data: { providers: [] } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(businessGrowApi.getStatus()).resolves.toEqual({ providers: [] });
      expect(invoke).not.toHaveBeenCalled();
      expect(String(fetcher.mock.calls[0][0])).toBe('/api/business-grow');
      expect(String(fetcher.mock.calls[1][0])).toBe('/.netlify/functions/business-grow');
      const headers = new Headers(fetcher.mock.calls[1][1]?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-session-token');
      expect(headers.get('apikey')).toBe('test-publishable-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('privilégie le relais same-origin sur *.netlify.app, puis l’appel direct', async () => {
    vi.stubGlobal('window', { location: { hostname: 'saas-ugc-growth.netlify.app' } });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/business-grow') return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ data: { conversations: [{ id: 'c1' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(businessGrowApi.listConversations()).resolves.toEqual({
        conversations: [{ id: 'c1' }],
      });
      expect(invoke).not.toHaveBeenCalled();
      const targets = fetcher.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toBe('/api/business-grow');
      expect(targets[1]).toBe('/.netlify/functions/business-grow');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to /.netlify/functions/business-grow when /api/business-grow returns HTML SPA fallback', async () => {
    vi.stubGlobal('window', { location: { hostname: 'deploy-preview-4--saas-ugc-growth.netlify.app' } });
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/api/business-grow') {
        return new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      return new Response(JSON.stringify({ data: { providers: [{ provider_key: 'groq' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      await expect(businessGrowApi.getStatus()).resolves.toEqual({ providers: [{ provider_key: 'groq' }] });
      expect(String(fetcher.mock.calls[0][0])).toBe('/api/business-grow');
      expect(String(fetcher.mock.calls[1][0])).toBe('/.netlify/functions/business-grow');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects the working Vite relay before issuing a mutation', async () => {
    vi.stubGlobal('window', { location: { hostname: '5173-demo.e2b.app' } });
    const calls: Array<{ target: string; action: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const action = (JSON.parse(String(init?.body)) as { action: string }).action;
      calls.push({ target, action });
      if (target.includes('supabase.co')) throw new TypeError('Network blocked');
      return new Response(JSON.stringify({ data: action === 'status'
        ? { providers: [] } : { conversationId: 'created-once' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await businessGrowApi.getStatus();
      await expect(businessGrowApi.createConversation('Essai', null)).resolves.toEqual({ conversationId: 'created-once' });
      expect(calls.map(({ target, action }) => [target.includes('supabase.co') ? 'direct' : target, action])).toEqual([
        ['direct', 'status'], ['/api/business-grow', 'status'],
        ['/api/business-grow', 'status'], ['/api/business-grow', 'conversations.create'],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rechecks the channel with a read when the network changes before a mutation', async () => {
    vi.stubGlobal('window', { location: { hostname: '5173-changing.e2b.app' } });
    let directBlocked = true;
    let relayBlocked = false;
    const calls: Array<{ target: string; action: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const action = (JSON.parse(String(init?.body)) as { action: string }).action;
      calls.push({ target, action });
      if (target.includes('supabase.co') && directBlocked) throw new TypeError('Blocked');
      if (target === '/api/business-grow' && relayBlocked) {
        return new Response(JSON.stringify({ error: { code: 'BUSINESS_GROW_RELAY_UNAVAILABLE' } }), { status: 502 });
      }
      return new Response(JSON.stringify({ data: action === 'status'
        ? { providers: [] } : { conversationId: 'one-conversation' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      await businessGrowApi.getStatus();
      directBlocked = false;
      relayBlocked = true;
      await expect(businessGrowApi.createConversation('Essai', null)).resolves.toEqual({ conversationId: 'one-conversation' });
      expect(calls.filter((call) => call.action === 'conversations.create')).toEqual([
        { target: 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/business-grow', action: 'conversations.create' },
      ]);
      expect(calls.slice(2).map(({ target, action }) => [target.includes('supabase.co') ? 'direct' : target, action])).toEqual([
        ['/api/business-grow', 'status'], ['direct', 'status'], ['direct', 'conversations.create'],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(['network', 'relay-error', 'html'] as const)(
    'never replays a mutation when the result is ambiguous (%s)', async (failure) => {
      vi.stubGlobal('window', { location: { hostname: 'vyora-ugc.netlify.app' } });
      const calls: Array<{ target: string; action: string }> = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input);
        const action = (JSON.parse(String(init?.body)) as { action: string }).action;
        calls.push({ target, action });
        if (action === 'status') return new Response(JSON.stringify({ data: { providers: [] } }), { status: 200 });
        if (failure === 'network') throw new TypeError('response lost');
        if (failure === 'relay-error') {
          return new Response(JSON.stringify({ error: { code: 'BUSINESS_GROW_UNAVAILABLE' } }), { status: 502 });
        }
        return new Response('<html>réponse illisible</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
      });
      vi.stubGlobal('fetch', fetcher);
      try {
        const error = await businessGrowApi.createConversation('Ne pas dupliquer', null).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'BUSINESS_GROW_RESULT_UNKNOWN' });
        expect((error as Error).message).toMatch(/vérifiez son résultat/i);
        expect(calls.filter((call) => call.action === 'conversations.create')).toEqual([
          { target: '/api/business-grow', action: 'conversations.create' },
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('shows an expired gateway JWT as an authentication error without retrying another transport', async () => {
    vi.stubGlobal('window', { location: { hostname: '5173-auth.e2b.app' } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const error = await businessGrowApi.getStatus().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
      expect((error as Error).message).toMatch(/session.*reconnectez/i);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates an explicit CORS denial instead of claiming a network failure', async () => {
    vi.stubGlobal('window', { location: { hostname: '5173-denied.e2b.app' } });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'ORIGIN_NOT_ALLOWED', message: 'Origine non autorisée.',
    } }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(businessGrowApi.getStatus()).rejects.toMatchObject({ code: 'ORIGIN_NOT_ALLOWED', status: 403 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('executes the real Netlify Edge relay without forwarding an Origin header upstream', async () => {
    // @ts-expect-error JS edge relay module without TypeScript declaration file
    const { default: relayHandler } = await import('../netlify/edge-functions/business-grow.js') as {
      default: (request: Request) => Promise<Response>;
    };
    vi.stubGlobal('window', { location: { hostname: 'deploy-preview-4--saas-ugc-growth.netlify.app' } });

    const upstreamCalls: Array<{ url: string; origin: string | null; auth: string | null; apikey: string | null }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/business-grow') {
        return await relayHandler(
          new Request('https://deploy-preview-4--saas-ugc-growth.netlify.app/api/business-grow', {
            method: 'POST',
            headers: {
              Origin: 'https://deploy-preview-4--saas-ugc-growth.netlify.app',
              ...(init?.headers as Record<string, string>),
            },
            body: init?.body as string,
          }),
        );
      }
      const headers = new Headers(init?.headers);
      upstreamCalls.push({
        url,
        origin: headers.get('Origin'),
        auth: headers.get('Authorization'),
        apikey: headers.get('apikey'),
      });
      return new Response(JSON.stringify({ data: { providers: [{ provider_key: 'groq', status: 'available' }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    try {
      const res = await businessGrowApi.getStatus();
      expect(res.providers).toEqual([{ provider_key: 'groq', status: 'available' }]);
      expect(upstreamCalls).toEqual([{
        url: 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/business-grow',
        origin: null,
        auth: 'Bearer test-session-token',
        apikey: 'test-publishable-key',
      }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the Netlify preview relays free of server secrets and locked to the canonical Supabase project', () => {
    for (const rel of ['netlify/edge-functions/business-grow.js', 'netlify/functions/business-grow.mjs']) {
      const src = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(src).toContain('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/business-grow');
      expect(src).not.toMatch(/GROQ_API_KEY|GEMINI_API_KEY|SERVICE_ROLE|Deno\.env\.get|process\.env/);
    }
  });
});
