import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSession, invoke } = vi.hoisted(() => ({
  getSession: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../src/lib/supabase', () => ({
  SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
  SUPABASE_URL: 'https://xbuuhfwobrafcbgtdgjx.supabase.co',
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
      // Les deux transports ont réellement été tentés (direct puis relais same-origin).
      const targets = fetcher.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toContain('/functions/v1/business-grow');
      expect(targets).toContain('/api/business-grow');
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
