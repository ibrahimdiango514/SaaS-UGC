import { describe, expect, it, vi } from 'vitest';

/*
 * Surveillance planifiée du fournisseur IA central (job pg_cron -> pg_net).
 *
 * Ces tests appellent le vrai handler avec un `fetch` simulé : aucune requête
 * réseau réelle, aucune clé utilisée. Ils verrouillent les garanties demandées :
 * authentification serveur, contrôle catalogue uniquement (aucune génération),
 * cibles issues du SEUL registre (aucun fournisseur en dur), enregistrement des
 * verdicts et refus des appelants non autorisés.
 */

const TOKEN = 'a'.repeat(64);

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

type DescriptorStub = {
  key: string;
  adapter_kind?: string;
  base_url?: string | null;
  models_url?: string | null;
  api_key_env?: string | null;
  account_id_env?: string | null;
  gateway_id_env?: string | null;
  transport?: string;
  headers?: Record<string, string>;
};

const FREELLM_DESCRIPTOR: DescriptorStub = {
  key: 'freellmapi',
  adapter_kind: 'openai',
  base_url: 'https://api.test/v1',
  models_url: 'https://api.test/v1/models',
  api_key_env: 'FREE_LLM_API_KEY',
};

function stubFetch(options: {
  token?: string;
  recordOk?: boolean;
  descriptors?: DescriptorStub[];
  /** Statut HTTP renvoyé par le catalogue du fournisseur. */
  catalogStatus?: number;
} = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body as string | undefined });

    if (url.endsWith('/rpc/vyora_ai_provider_descriptors')) {
      return new Response(JSON.stringify(options.descriptors ?? [FREELLM_DESCRIPTOR]), { status: 200 });
    }
    if (url.endsWith('/rpc/vyora_provider_health_cron_token')) {
      return new Response(JSON.stringify(options.token ?? TOKEN), { status: 200 });
    }
    if (url.endsWith('/rpc/vyora_record_provider_verification')) {
      return new Response(JSON.stringify({ run_id: 1, alert_opened: 0 }), {
        status: options.recordOk === false ? 500 : 200,
      });
    }
    if (url.includes('api.test')) {
      const status = options.catalogStatus ?? 200;
      return new Response(
        JSON.stringify(status === 200
          ? { data: [{ id: 'auto' }, { id: 'auto:fast' }] }
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
    FREE_LLM_API_KEY: 'freellm-key',
    FREE_LLM_MODEL: 'auto',
    ...env,
  });
  const mod = await import('../supabase/functions/vyora-provider-health/index');
  return mod.handler as (req: Request) => Promise<Response>;
}

function request(headers: Record<string, string>, body: unknown = { providerKey: 'freellmapi' }) {
  return new Request('https://edge.test/vyora-provider-health', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const cronHeaders = { Authorization: `Bearer ${TOKEN}`, 'x-vyora-cron': 'provider-health' };

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
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('SERVICE_TOKEN_INVALID');
    expect(calls.some((call) => call.url.includes('api.test'))).toBe(false);
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
  it('ne lit que le catalogue du fournisseur central (GET), jamais une complétion', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler();
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.catalog_only).toBe(true);
    expect(body.results[0]).toMatchObject({ providerKey: 'freellmapi', status: 'healthy', recorded: true });

    const providerCalls = calls.filter((call) => call.url.includes('api.test'));
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].method).toBe('GET');
    expect(providerCalls[0].url).toContain('/v1/models');
    expect(providerCalls[0].headers.authorization).toBe('Bearer freellm-key');
    // Garantie centrale : aucun endpoint de complétion, donc aucune génération.
    expect(calls.some((call) => call.url.includes('chat/completions'))).toBe(false);
  });

  it('signale un modèle configuré absent du catalogue sans inventer de succès', async () => {
    stubFetch();
    const handler = await loadHandler({ FREE_LLM_MODEL: 'modele-inexistant' });
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_MODEL_MISSING' });
  });

  it('transmet l’erreur fournisseur réelle (401) et enregistre l’échec', async () => {
    const { calls } = stubFetch({ catalogStatus: 401 });
    const handler = await loadHandler();
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_AUTH_FAILED' });
    const record = calls.find((call) => call.url.includes('vyora_record_provider_verification'));
    expect(record).toBeTruthy();
    expect(JSON.parse(record!.body!)).toMatchObject({ p_status: 'failed', p_error_code: 'PROVIDER_AUTH_FAILED' });
  });

  it('signale une configuration absente sans appel réseau au fournisseur', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler({ FREE_LLM_API_KEY: '' });
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(502);
    expect((await res.json()).results[0]).toMatchObject({ errorCode: 'PROVIDER_NOT_CONFIGURED' });
    expect(calls.some((call) => call.url.includes('api.test'))).toBe(false);
  });

  it('500 du catalogue : échec réel transmis et enregistré (jamais de faux succès)', async () => {
    const { calls } = stubFetch({ catalogStatus: 500 });
    const handler = await loadHandler();
    const res = await handler(request(cronHeaders));
    expect(res.status).toBe(502);
    expect((await res.json()).results[0]).toMatchObject({
      providerKey: 'freellmapi', status: 'failed', errorCode: 'PROVIDER_UNAVAILABLE',
    });
    const record = calls.find((call) => call.url.includes('vyora_record_provider_verification'));
    expect(JSON.parse(record!.body!)).toMatchObject({ p_status: 'failed', p_error_code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('surveillance fournisseur — plus aucun fournisseur historique', () => {
  it('un fournisseur supprimé (groq, gemini) est inconnu : 404, aucun appel réseau', async () => {
    for (const legacy of ['groq', 'gemini', 'cloudflare']) {
      const { calls } = stubFetch({ descriptors: [FREELLM_DESCRIPTOR] });
      const handler = await loadHandler();
      const res = await handler(request(cronHeaders, { providerKey: legacy }));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('PROVIDER_UNKNOWN');
      expect(calls.some((call) => call.url.includes('api.groq.com') || call.url.includes('generativelanguage') || call.url.includes('cloudflare'))).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it('sans descripteur configuré, aucun fournisseur n’est sondé implicitement', async () => {
    const { calls } = stubFetch({ descriptors: [] });
    const handler = await loadHandler();
    const res = await handler(request(cronHeaders, {}));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
    expect(calls.some((call) => call.url.includes('api.test'))).toBe(false);
  });

  it('un fournisseur du registre sans clé n’est pas sondé par défaut', async () => {
    const { calls } = stubFetch();
    const handler = await loadHandler({ FREE_LLM_API_KEY: '' });
    const res = await handler(request(cronHeaders, {}));
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
    expect(calls.some((call) => call.url.includes('api.test'))).toBe(false);
  });
});

describe('surveillance fournisseur — aucun secret dans le verdict', () => {
  it('le nom de variable du registre ne fait jamais lire une clé comme modèle', async () => {
    const { calls } = stubFetch({
      descriptors: [{
        key: 'custom',
        adapter_kind: 'openai',
        base_url: 'https://api.test/v1',
        // Nom de variable volontairement non standard : aucune convention
        // `<préfixe>_MODEL` ne doit être déduite, et surtout pas la valeur lue.
        api_key_env: 'CUSTOM_TOKEN',
      }],
    });
    const handler = await loadHandler({ CUSTOM_TOKEN: 'secret-value-0123456789' });
    const res = await handler(request(cronHeaders, { providerKey: 'custom' }));
    const text = await res.text();
    expect(text).not.toContain('secret-value-0123456789');
    const body = JSON.parse(text);
    expect(body.results[0].modelKey).toBe('');
    const record = calls.find((call) => call.url.includes('vyora_record_provider_verification'));
    expect(record!.body).not.toContain('secret-value-0123456789');
  });
});

// ===========================================================================
describe('sémantique du 502 — un verdict, pas une panne du service', () => {
  /**
   * Incident du 25/11/2026 : des 502 ont été lus comme une panne de Provider
   * Health. Ce n'est pas le cas : 502 est le code de retour NORMAL d'une sonde
   * qui a trouvé au moins un fournisseur dégradé.
   *
   *     return json({...}, failed.length === 0 ? 200 : 502);
   *
   * Le corps de la réponse porte le verdict détaillé (statut, code d'erreur,
   * HTTP du catalogue, latence). Un 502 EST le compte rendu ; un 200 signifie
   * « tout va bien ». Ces tests figent cette convention, pour qu'on ne
   * « corrige » pas un jour ce 502 en 200 — ce qui masquerait une panne réelle.
   *
   * Ce qui relèverait d'une vraie panne du système de vérification :
   *   - 403 CRON_HEADER_REQUIRED  : le job pg_cron n'envoie plus l'en-tête
   *   - 401 SERVICE_TOKEN_INVALID : jeton de service désynchronisé
   *   - 503 SERVICE_TOKEN_UNAVAILABLE : Vault illisible
   *   - 404 PROVIDER_UNKNOWN      : fournisseur absent du registre
   *   - `recorded: false` dans le corps : le verdict n'a pas pu être enregistré
   */
  const appeler = async (options: Parameters<typeof stubFetch>[0] = {}) => {
    const { fetchMock } = stubFetch(options);
    const handler = await loadHandler();
    const res = await handler(request(cronHeaders));
    return { res, body: await res.json(), fetchMock };
  };

  it('un fournisseur sain donne 200', async () => {
    const { res, body } = await appeler({ catalogStatus: 200 });
    expect(res.status).toBe(200);
    expect(body.results.every((r: { status: string }) => r.status === 'healthy')).toBe(true);
  });

  it('un fournisseur dégradé donne 502 ET le détail du verdict dans le corps', async () => {
    const { res, body } = await appeler({ catalogStatus: 401 });
    expect(res.status).toBe(502);
    const [verdict] = body.results;
    // Le diagnostic est exploitable : qui, quoi, quel statut HTTP.
    expect(verdict.providerKey).toBe('freellmapi');
    expect(verdict.status).not.toBe('healthy');
    expect(verdict.errorCode).toBeTruthy();
    expect(verdict.catalogHttpStatus).toBe(401);
  });

  it('sans fournisseur désigné, un fournisseur non configuré n’est pas sondé', async () => {
    // Aucune clé et aucune demande explicite : rien n'est sondé, donc 200.
    const { fetchMock } = stubFetch({
      descriptors: [{ ...FREELLM_DESCRIPTOR, api_key_env: null }],
    });
    const handler = await loadHandler();
    // Corps sans `providerKey` : on demande le balayage par défaut.
    const res = await handler(request(cronHeaders, {}));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results).toHaveLength(0);
    // Aucun appel au catalogue du fournisseur.
    const appelsCatalogue = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('api.test'));
    expect(appelsCatalogue).toHaveLength(0);
  });

  it('un fournisseur DEMANDÉ sans clé est signalé, pas ignoré silencieusement', async () => {
    // Demande explicite = diagnostic demandé : l'absence de clé doit se voir.
    const { res, body } = await appeler({
      descriptors: [{ ...FREELLM_DESCRIPTOR, api_key_env: null }],
    });
    expect(res.status).toBe(502);
    expect(body.results[0].errorCode).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('un échec d’enregistrement du verdict est signalé, pas masqué', async () => {
    const { res, body } = await appeler({ catalogStatus: 200, recordOk: false });
    // Le fournisseur va bien -> 200, mais `recorded: false` dit que la trace manque.
    // `recordDetail` porte la réponse brute de la RPC : c'est elle qu'il faut
    // lire pour comprendre pourquoi l'enregistrement a échoué.
    expect(res.status).toBe(200);
    expect(body.results[0].recorded).toBe(false);
    expect(body.results[0].recordDetail).toBeTruthy();
  });
});
