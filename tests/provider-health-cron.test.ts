import { describe, expect, it, vi } from 'vitest';

/*
 * Surveillance planifiée des fournisseurs IA (job pg_cron -> pg_net).
 *
 * Ces tests appellent le vrai handler avec un `fetch` simulé : aucune requête
 * réseau réelle, aucune clé utilisée. Ils verrouillent les garanties demandées :
 * authentification serveur, contrôle catalogue uniquement (aucune génération),
 * enregistrement des verdicts et refus des appelants non autorisés.
 */

const TOKEN = 'a'.repeat(64);

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function stubFetch(options: {
  token?: string;
  groqStatus?: number;
  geminiStatus?: number;
  recordOk?: boolean;
} = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body as string | undefined });

    if (url.endsWith('/rpc/vyora_provider_health_cron_token')) {
      return new Response(JSON.stringify(options.token ?? TOKEN), { status: 200 });
    }
    if (url.endsWith('/rpc/vyora_record_provider_verification')) {
      return new Response(JSON.stringify({ run_id: 1, alert_opened: 0 }), {
        status: options.recordOk === false ? 500 : 200,
      });
    }
    if (url.includes('api.groq.com')) {
      const status = options.groqStatus ?? 200;
      return new Response(
        JSON.stringify(status === 200 ? { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'openai/gpt-oss-20b' }] } : { error: 'nope' }),
        { status },
      );
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      const status = options.geminiStatus ?? 200;
      return new Response(
        JSON.stringify(status === 200
          ? { models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-3.5-flash' }] }
          : { error: 'nope' }),
        { status },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

async function loadHandler(env: Record<string, string> = {}) {
  vi.resetModules();
  Object.assign(process.env, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    BUSINESS_GROW_GROQ_API_KEY: 'groq-key',
    BUSINESS_GROW_GROQ_MODEL: 'openai/gpt-oss-120b',
    BUSINESS_GROW_GEMINI_API_KEY: 'gemini-key',
    BUSINESS_GROW_GEMINI_MODEL: 'gemini-2.5-flash',
    ...env,
  });
  const mod = await import('../supabase/functions/vyora-provider-health/index');
  return mod.handler as (req: Request) => Promise<Response>;
}

function request(headers: Record<string, string>, body: unknown = { providerKey: 'groq' }) {
  return new Request('https://edge.test/vyora-provider-health', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('surveillance fournisseur — authentification serveur', () => {
  it('refuse un appel sans en-tête de surveillance sans lire le Vault', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler();
    const res = await handler(request({ Authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('CRON_HEADER_REQUIRED');
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('refuse un jeton invalide et ne contacte aucun fournisseur', async () => {
    const { calls } = stubFetch({ token: 'b'.repeat(64) });
    const handler = await loadHandler();
    const res = await handler(request({ Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('SERVICE_TOKEN_INVALID');
    expect(calls.some((call) => call.url.includes('api.groq.com'))).toBe(false);
  });

  it('refuse un jeton absent ou trop court', async () => {
    stubFetch();
    const handler = await loadHandler();
    const res = await handler(request({ Authorization: 'Bearer court', 'x-vyora-cron': 'provider-health' }));
    expect(res.status).toBe(401);
    vi.unstubAllGlobals();
  });
});

describe('surveillance fournisseur — contrôle sans génération', () => {
  it('ne lit que le catalogue Groq (GET) et n’appelle jamais de complétion', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler();
    const res = await handler(request({ Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog_only).toBe(true);
    expect(body.results[0]).toMatchObject({ providerKey: 'groq', status: 'healthy', recorded: true });

    const providerCalls = calls.filter((call) => call.url.includes('api.groq.com'));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].method).toBe('GET');
    expect(providerCalls[0].url).toContain('/openai/v1/models');
    // Garantie centrale : aucun endpoint de complétion, donc aucune génération.
    expect(calls.some((call) => call.url.includes('chat/completions'))).toBe(false);
  });

  it('vérifie Gemini sur le catalogue et signale la latence réelle', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler();
    const res = await handler(request(
      { Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' },
      { providerKey: 'gemini' },
    ));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({
      providerKey: 'gemini', modelKey: 'gemini-2.5-flash', status: 'healthy',
    });
    expect(typeof body.results[0].latencyMs).toBe('number');
    const providerCalls = calls.filter((call) => call.url.includes('generativelanguage'));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].method).toBe('GET');
    expect(calls.some((call) => call.url.includes(':generateContent'))).toBe(false);
  });

  it('signale un modèle configuré absent du catalogue sans inventer de succès', async () => {
    stubFetch();
    const handler = await loadHandler({ BUSINESS_GROW_GEMINI_MODEL: 'modele-inexistant' });
    const res = await handler(request(
      { Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' },
      { providerKey: 'gemini' },
    ));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_MODEL_MISSING' });
  });

  it('transmet l’erreur fournisseur réelle (401) et enregistre l’échec', async () => {
    const { calls } = stubFetch({ groqStatus: 401 });
    const handler = await loadHandler();
    const res = await handler(request({ Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_AUTH_FAILED' });
    const record = calls.find((call) => call.url.includes('vyora_record_provider_verification'));
    expect(record).toBeTruthy();
    expect(JSON.parse(record!.body!)).toMatchObject({ p_status: 'failed', p_error_code: 'PROVIDER_AUTH_FAILED' });
  });

  it('signale une configuration absente sans appel réseau au fournisseur', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler({ BUSINESS_GROW_GROQ_API_KEY: '' });
    const res = await handler(request({ Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' }));
    expect(res.status).toBe(502);
    expect((await res.json()).results[0]).toMatchObject({ errorCode: 'PROVIDER_NOT_CONFIGURED' });
    expect(calls.some((call) => call.url.includes('api.groq.com'))).toBe(false);
  });
});
