import { describe, expect, it, vi } from 'vitest';
import { createOwnerBootstrapHandler } from '../supabase/functions/reelora-owner-bootstrap/index';

const OWNER_ID = 'c49beb02-c606-4a38-ac92-85566571abc1';
const config = {
  supabaseUrl: 'https://project.supabase.co',
  serviceRoleKey: 'service-role-test-key',
  ownerEmail: 'owner@example.com',
};

type MockFetch = typeof fetch & {
  mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
};

function mockFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): MockFetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(responder(String(input), init))) as unknown as MockFetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('reelora-owner-bootstrap Edge Function', () => {
  it('reports the bootstrap status without exposing the owner email', async () => {
    const fetcher = mockFetch(() => jsonResponse(true));
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', {
      method: 'GET',
      headers: { origin: 'https://vyora-ugc.netlify.app' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: true, initialized: false, configured: true });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://vyora-ugc.netlify.app');
    expect(fetcher.mock.calls[0]?.[0]).toContain('reelora_first_admin_bootstrap_available');
  });

  it('requires an authenticated, confirmed, allowlisted owner before calling the privileged bootstrap RPC', async () => {
    const fetcher = mockFetch((url) => {
      if (url.endsWith('/auth/v1/user')) {
        return jsonResponse({ id: OWNER_ID, email: 'OWNER@example.com', email_confirmed_at: '2026-11-11T00:00:00Z' });
      }
      if (url.endsWith('/reelora_first_admin_bootstrap_available')) return jsonResponse(true);
      if (url.endsWith('/reelora_bootstrap_first_admin')) return jsonResponse(OWNER_ID);
      throw new Error(`Unexpected request: ${url}`);
    });
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', {
      method: 'POST',
      headers: {
        origin: 'https://vyora-ugc.netlify.app',
        authorization: 'Bearer confirmed-owner-session',
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user_id: OWNER_ID });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://project.supabase.co/auth/v1/user',
      'https://project.supabase.co/rest/v1/rpc/reelora_first_admin_bootstrap_available',
      'https://project.supabase.co/rest/v1/rpc/reelora_bootstrap_first_admin',
    ]);
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ p_email: 'owner@example.com' }));
  });

  it('rejects unauthenticated callers and never invokes the role-assignment RPC', async () => {
    const fetcher = mockFetch(() => jsonResponse(true));
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', { method: 'POST' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'authentication_required' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a confirmed but non-owner account', async () => {
    const fetcher = mockFetch((url) => url.endsWith('/auth/v1/user')
      ? jsonResponse({ id: 'regular-user', email: 'user@example.com', email_confirmed_at: '2026-11-11T00:00:00Z' })
      : jsonResponse(true));
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', {
      method: 'POST',
      headers: { authorization: 'Bearer regular-user-session' },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'owner_email_not_authorized' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects unconfirmed email addresses', async () => {
    const fetcher = mockFetch(() => jsonResponse({ id: OWNER_ID, email: 'owner@example.com' }));
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', {
      method: 'POST',
      headers: { authorization: 'Bearer unconfirmed-session' },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'email_confirmation_required' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses all bootstrap attempts after an administrator exists', async () => {
    const fetcher = mockFetch((url) => {
      if (url.endsWith('/auth/v1/user')) {
        return jsonResponse({ id: OWNER_ID, email: 'owner@example.com', confirmed_at: '2026-11-11T00:00:00Z' });
      }
      return jsonResponse(false);
    });
    const handler = createOwnerBootstrapHandler(config, fetcher);

    const response = await handler(new Request('https://edge.test/reelora-owner-bootstrap', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-session' },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'admin_already_initialized' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
