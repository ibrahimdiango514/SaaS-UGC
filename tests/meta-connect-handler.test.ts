import { describe, expect, it, vi } from 'vitest';
import {
  MetaConnectError,
  explainMetaError,
  handleMetaConnect,
  pageSecretName,
  pinSecretName,
  tokenSecretName,
  type ConnectionRow,
  type MetaConfig,
  type MetaDeps,
  type PageRow,
} from '../supabase/functions/meta-connect/handler';
import { MetaError } from '../src/business/meta/graph';
import { randomState } from '../src/business/meta/oauth';

/**
 * `meta-connect` — la fonction Edge qui porte les quatre parcours Meta.
 *
 * Ces tests exercent le handler réel avec des dépendances injectées : aucune
 * base, aucun réseau, aucun secret réel. Ce qu'ils prouvent, point par point :
 *
 *  1. sans JWT vérifié → 401 ;
 *  2. sans abonnement Business Grow actif → 402/403, AVANT toute lecture ;
 *  3. sans droit d'écriture sur l'entreprise → 403 ;
 *  4. un `state` inconnu, déjà consommé ou expiré ne donne aucune connexion ;
 *  5. le WABA et le numéro envoyés par le navigateur ne sont pas crus : ils
 *     doivent figurer dans ce que le jeton voit réellement ;
 *  6. une page dont on n'est pas administrateur est refusée (`/me/accounts`) ;
 *  7. le retour de Meta (`/callback`) ne consomme le code qu'avec un `state`
 *     valide, et redirige sans jamais exposer de jeton ;
 *  8. les jetons ne sortent jamais : ni dans une réponse, ni dans un journal.
 */

const APP_ID = '1692282959171281';
const APP_SECRET = 'APP_SECRET_DE_TEST_NE_DOIT_PAS_FUIRER';
const USER = '373436db-0f06-4888-a489-e9c60d7fbd8b';
const WS = '1e1fd8bb-6ad4-4ae2-8e99-bf48373fce1b';
const OTHER_USER = '00000000-0000-4000-8000-000000000001';

const config: MetaConfig = {
  appId: APP_ID,
  appSecret: APP_SECRET,
  appUrl: 'https://vyora-saas-ugc.netlify.app',
  supabaseUrl: 'https://xbuuhfwobrafcbgtdgjx.supabase.co',
  configIds: { whatsapp: 'CFG_WA', facebook: 'CFG_FB', messenger: 'CFG_MS', instagram: 'CFG_IG' },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Réponses Graph simulées, indexées par chemin. */
function graphFake(routes: Record<string, unknown | (() => unknown)>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    for (const [motif, corps] of Object.entries(routes)) {
      if (u.includes(motif)) {
        const valeur = typeof corps === 'function' ? (corps as () => unknown)() : corps;
        return json(valeur);
      }
    }
    return json({ error: { code: 100, message: `route Graph non simulée : ${u}` } }, 400);
  });
}

interface Etat {
  secrets: Map<string, string>;
  connections: Map<string, ConnectionRow>;
  pages: Map<string, PageRow>;
  states: Map<string, { userId: string; workspaceId: string; product: string }>;
  logs: string[];
  integration: Array<{ key: string; external: string }>;
  messages: Array<Record<string, unknown>>;
}

function depsAvec(overrides: Partial<MetaDeps> = {}, options: {
  allowed: boolean;
  canRead?: boolean;
  canWrite?: boolean;
  fetchImpl?: typeof fetch;
} = { allowed: true }) {
  const etat: Etat = {
    secrets: new Map(),
    connections: new Map(),
    pages: new Map(),
    states: new Map(),
    logs: [],
    integration: [],
    messages: [],
  };
  const cle = (product: string) => `${USER}:${WS}:${product}`;

  const deps: MetaDeps = {
    config,
    getUserId: async (authorization: string) =>
      authorization === `Bearer jwt-${USER}` ? USER : null,
    checkImportAccess: async () => ({
      allowed: options.allowed,
      reason: options.allowed ? 'OK' : 'SUBSCRIPTION_REQUIRED',
      message: options.allowed ? '' : 'Un abonnement Business Grow actif est requis.',
    }),
    grantWorkspace: async () => ({ canRead: options.canRead ?? true, canWrite: options.canWrite ?? true }),

    stateCreate: async (state, userId, workspaceId, product) => {
      etat.states.set(state, { userId, workspaceId, product });
    },
    stateConsume: async (state) => {
      const trouve = etat.states.get(state);
      if (!trouve) return null;
      etat.states.delete(state);
      return { userId: trouve.userId, workspaceId: trouve.workspaceId, product: trouve.product as never };
    },

    storeSecret: async (name, value) => { etat.secrets.set(name, value); },
    readSecret: async (name) => etat.secrets.get(name) ?? null,
    deleteSecret: async (name) => { etat.secrets.delete(name); },

    connectionUpsert: async (payload) => {
      const id = `conn-${payload.product}`;
      etat.connections.set(cle(String(payload.product)), {
        id,
        user_id: String(payload.user_id),
        workspace_id: String(payload.workspace_id),
        product: payload.product as never,
        status: String(payload.status ?? 'connected'),
        external_account_id: String(payload.external_account_id),
        display_name: (payload.display_name as string | null) ?? null,
        granted_scopes: (payload.granted_scopes as string[]) ?? [],
        token_ref: (payload.token_ref as string | null) ?? null,
        token_expires_at: (payload.token_expires_at as string | null) ?? null,
        metadata: (payload.metadata as Record<string, unknown>) ?? {},
        last_error: null,
      });
      return id;
    },
    connectionInternal: async (userId, workspaceId, product) =>
      userId === USER && workspaceId === WS ? etat.connections.get(cle(product)) ?? null : null,
    connectionsList: async (userId, workspaceId, product) => {
      if (userId !== USER || workspaceId !== WS) return [];
      const lignes = [...etat.connections.values()]
        .filter((c) => !product || c.product === product)
        .map((c) => ({
          id: c.id, product: c.product, status: c.status, external_account_id: c.external_account_id,
          display_name: c.display_name, granted_scopes: c.granted_scopes, token_expires_at: c.token_expires_at,
          has_token: Boolean(c.token_ref), metadata: c.metadata, last_error: c.last_error,
          last_verified_at: null, updated_at: new Date().toISOString(),
          pages: [...etat.pages.values()].filter((p) => p.connection_id === c.id),
        }));
      return lignes;
    },
    connectionSetStatus: async (userId, workspaceId, product, status, error) => {
      const c = etat.connections.get(`${userId}:${workspaceId}:${product}`);
      if (c) etat.connections.set(`${userId}:${workspaceId}:${product}`, { ...c, status, last_error: error ?? null });
    },
    connectionMergeMetadata: async (userId, workspaceId, product, metadata) => {
      const c = etat.connections.get(`${userId}:${workspaceId}:${product}`);
      if (c) etat.connections.set(`${userId}:${workspaceId}:${product}`, { ...c, metadata: { ...c.metadata, ...metadata } });
    },
    connectionDelete: async (userId, workspaceId, product) => {
      const c = etat.connections.get(`${userId}:${workspaceId}:${product}`);
      const pages = [...etat.pages.values()].filter((p) => p.connection_id === c?.id);
      for (const p of pages) etat.pages.delete(p.page_id);
      etat.connections.delete(`${userId}:${workspaceId}:${product}`);
      return { tokenRefs: [...pages.map((p) => p.token_ref), c?.token_ref].filter((r): r is string => Boolean(r)) };
    },
    pagesReplace: async (userId, workspaceId, product, pages) => {
      const c = etat.connections.get(`${userId}:${workspaceId}:${product}`);
      const retires: string[] = [];
      for (const [id, page] of etat.pages) {
        if (page.connection_id === c?.id && !pages.some((x) => x.page_id === id)) {
          if (page.token_ref) retires.push(page.token_ref);
          etat.pages.delete(id);
        }
      }
      for (const p of pages) {
        etat.pages.set(String(p.page_id), {
          id: `page-${p.page_id}`,
          connection_id: c?.id ?? '',
          page_id: String(p.page_id),
          name: String(p.name),
          token_ref: (p.token_ref as string | null) ?? null,
          instagram_business_account_id: (p.instagram_business_account_id as string | null) ?? null,
          tasks: (p.tasks as string[]) ?? [],
        });
      }
      return { removedTokenRefs: retires };
    },
    pageInternal: async (userId, workspaceId, product, pageId) => {
      const c = userId === USER && workspaceId === WS ? etat.connections.get(cle(product)) : null;
      const page = etat.pages.get(pageId);
      return page && c && page.connection_id === c.id ? page : null;
    },
    recordIntegration: async (_u, _w, key, _ref, external) => { etat.integration.push({ key, external }); },
    disconnectIntegration: async () => {},
    messageRecord: async (payload) => { etat.messages.push(payload); },
    messagesList: async () => [],
    conversationsList: async () => [],
    pageEventsList: async () => [],
    fetchImpl: options.fetchImpl,
    log: (message, detail) => { etat.logs.push(`${message} ${JSON.stringify(detail ?? {})}`); },
  };

  return { deps: { ...deps, ...overrides }, etat };
}

function post(corps: Record<string, unknown>, options: { jwt?: string; origin?: string } = {}) {
  return new Request('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.jwt ?? `jwt-${USER}`}`,
      origin: options.origin ?? 'https://vyora-saas-ugc.netlify.app',
    },
    body: JSON.stringify(corps),
  });
}

const ORIGINS = ['https://vyora-saas-ugc.netlify.app', 'http://localhost:5173'];

/* ----------------------------- Authentification --------------------------- */

describe('meta-connect — aucune action sans identité vérifiée', () => {
  it('refuse un appel sans JWT (401) et ne touche à rien', async () => {
    const { deps, etat } = depsAvec();
    const reponse = await handleMetaConnect(
      new Request('https://x/functions/v1/meta-connect', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', workspaceId: WS, product: 'whatsapp' }),
      }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(401);
    expect(await reponse.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(etat.states.size).toBe(0);
  });

  it('refuse un action inconnue et un corps illisible', async () => {
    const { deps } = depsAvec();
    expect((await handleMetaConnect(post({ action: 'delete-everything', workspaceId: WS }), deps, { allowedOrigins: ORIGINS })).status).toBe(400);
    const illisible = new Request('https://x/functions/v1/meta-connect', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer jwt-${USER}` }, body: '{',
    });
    expect((await handleMetaConnect(illisible, deps, { allowedOrigins: ORIGINS })).status).toBe(400);
  });

  it('refuse un identifiant d’entreprise qui n’est pas un UUID', async () => {
    const { deps } = depsAvec();
    const reponse = await handleMetaConnect(post({ action: 'status', workspaceId: 'pas-un-uuid' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'INVALID_WORKSPACE' } });
  });

  it('expose les origines autorisées, jamais un joker', async () => {
    const { deps } = depsAvec();
    const reponse = await handleMetaConnect(post({ action: 'status', workspaceId: WS }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.headers.get('access-control-allow-origin')).toBe('https://vyora-saas-ugc.netlify.app');
    const inconnue = await handleMetaConnect(post({ action: 'status', workspaceId: WS }, { origin: 'https://evil.example' }), deps, { allowedOrigins: ORIGINS });
    expect(inconnue.headers.get('access-control-allow-origin')).toBe('null');
  });
});

/* ------------------------------- Abonnement ------------------------------ */

describe('meta-connect — verrou d’abonnement Business Grow', () => {
  it('refuse chaque action quand l’abonnement est inactif, avant toute lecture', async () => {
    const fetchImpl = vi.fn();
    const { deps } = depsAvec({}, { allowed: false, fetchImpl: fetchImpl as unknown as typeof fetch });
    for (const action of ['start', 'status', 'pages.list', 'disconnect', 'whatsapp.send']) {
      const reponse = await handleMetaConnect(post({ action, workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
      expect(reponse.status, action).toBe(402);
      expect(await reponse.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_REQUIRED' } });
    }
    // Aucun appel Meta n'a été tenté.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuse une action d’écriture sans droit d’écriture sur l’entreprise', async () => {
    const { deps } = depsAvec({}, { allowed: true, canRead: true, canWrite: false });
    const ecriture = await handleMetaConnect(post({ action: 'disconnect', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
    expect(ecriture.status).toBe(403);
    expect(await ecriture.json()).toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    // La lecture reste permise.
    expect((await handleMetaConnect(post({ action: 'status', workspaceId: WS }), deps, { allowedOrigins: ORIGINS })).status).toBe(200);
  });

  it('refuse les actions même en lecture pour une entreprise étrangère', async () => {
    const { deps } = depsAvec({}, { allowed: true, canRead: false, canWrite: false });
    const reponse = await handleMetaConnect(post({ action: 'status', workspaceId: WS }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(403);
  });
});

/* --------------------------------- start --------------------------------- */

describe('meta-connect — démarrage du parcours', () => {
  it('sans META_APP_ID/SECRET : 503 explicite, aucun état créé', async () => {
    const { deps, etat } = depsAvec({ config: { ...config, appId: '', appSecret: '' } });
    const reponse = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(503);
    expect(await reponse.json()).toMatchObject({ error: { code: 'META_NOT_CONFIGURED' } });
    expect(etat.states.size).toBe(0);
  });

  it('sans identifiant de configuration pour ce produit : 503 nommant la variable', async () => {
    const { deps, etat } = depsAvec({ config: { ...config, configIds: { facebook: 'CFG_FB' } } });
    const reponse = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(503);
    const corps = await reponse.json() as { error: { message: string } };
    expect(corps.error.message).toContain('META_WHATSAPP_CONFIG_ID');
    expect(etat.states.size).toBe(0);
  });

  it('WhatsApp renvoie le lancement Embedded Signup (aucun secret, state unique)', async () => {
    const { deps, etat } = depsAvec();
    const reponse = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(200);
    const { data } = await reponse.json() as { data: Record<string, unknown> };
    expect(data.mode).toBe('embedded-signup');
    expect(data.appId).toBe(APP_ID);
    expect(data.configId).toBe('CFG_WA');
    expect(String(data.state)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(data)).not.toContain(APP_SECRET);
    expect(etat.states.get(String(data.state))).toMatchObject({ userId: USER, workspaceId: WS, product: 'whatsapp' });
  });

  it('Facebook renvoie une URL de redirection avec state et config_id, sans secret', async () => {
    const { deps } = depsAvec();
    const reponse = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    const { data } = await reponse.json() as { data: { mode: string; url: string } };
    expect(data.mode).toBe('redirect');
    const url = new URL(data.url);
    expect(url.searchParams.get('config_id')).toBe('CFG_FB');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect/callback');
    expect(data.url).not.toContain(APP_SECRET);
  });

  it('refuse un produit inconnu', async () => {
    const { deps } = depsAvec();
    const reponse = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'tiktok' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'INVALID_PRODUCT' } });
  });
});

/* ---------------------------- Retour Meta (GET) --------------------------- */

describe('meta-connect — retour Meta : le state est la seule clé', () => {
  const ROUTES = {
    'oauth/access_token': { access_token: 'EAAJETON_LONG_1234567890abcdef', expires_in: 5184000 },
    debug_token: { data: { app_id: APP_ID, is_valid: true, expires_at: 1800000000, scopes: ['pages_show_list', 'pages_read_engagement'] } },
    '/me': { id: 'USER_FB_1', name: 'Compte Test' },
  };

  it('sans state : redirection vers le front avec erreur, code non échangé', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const reponse = await handleMetaConnect(
      new Request('https://x/functions/v1/meta-connect/callback?code=ABC&state=invalide', { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(303);
    const location = new URL(String(reponse.headers.get('location')));
    expect(location.searchParams.get('meta')).toBe('error');
    expect(location.searchParams.get('code')).toBe('STATE_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un state consommé ne peut pas resservir (rejeu de code) ', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const premier = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?code=ABC&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(premier.status).toBe(303);
    expect(String(premier.headers.get('location'))).toContain('meta=connected');
    const second = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?code=ABC&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(String(second.headers.get('location'))).toContain('code=STATE_INVALID');
    // Un seul échange de code au total.
    expect(fetchImpl.mock.calls.filter((c) => String(c[0]).includes('oauth/access_token')).length).toBe(2);
    expect(etat.states.size).toBe(0);
  });

  it('refus de l’utilisateur chez Meta : aucun échange, redirection USER_DENIED', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const reponse = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?error=access_denied&error_reason=user_denied&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    const location = new URL(String(reponse.headers.get('location')));
    expect(location.searchParams.get('code')).toBe('USER_DENIED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un jeton d’une autre application est refusé', async () => {
    const fetchImpl = graphFake({
      ...ROUTES,
      debug_token: { data: { app_id: '999999999999999', is_valid: true } },
    });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const reponse = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?code=ABC&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(String(reponse.headers.get('location'))).toContain('code=META_TOKEN_MISMATCH');
    expect(etat.connections.size).toBe(0);
  });

  it('un échange réussi enregistre une connexion réelle, jeton en Vault seulement', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const reponse = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?code=ABC&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(String(reponse.headers.get('location'))).toContain('meta=connected');
    // Aucun jeton dans l'URL de retour.
    expect(String(reponse.headers.get('location'))).not.toContain('EAA');

    const connexion = etat.connections.get(`${USER}:${WS}:facebook`);
    expect(connexion).toMatchObject({ external_account_id: 'USER_FB_1', status: 'connected' });
    expect(connexion?.token_ref).toBe(tokenSecretName('facebook', USER, WS));
    expect(etat.secrets.get(String(connexion?.token_ref))).toBe('EAAJETON_LONG_1234567890abcdef');
    // La connexion est tracée dans le socle Business Grow, avec l'identifiant réel.
    expect(etat.integration).toEqual([{ key: 'facebook', external: 'USER_FB_1' }]);
  });

  it('un échec Meta est classé et aucun secret n’est stocké', async () => {
    const fetchImpl = graphFake({
      'oauth/access_token': { error: { code: 100, message: 'Invalid verification code format.' } },
    });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const reponse = await handleMetaConnect(
      new Request(`https://x/functions/v1/meta-connect/callback?code=ABC&state=${state}`, { method: 'GET' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(String(reponse.headers.get('location'))).toContain('meta=error');
    expect(etat.connections.size).toBe(0);
    expect(etat.secrets.size).toBe(0);
    // Les journaux ne contiennent ni code d'autorisation ni secret.
    const journaux = etat.logs.join(' ');
    expect(journaux).not.toContain(APP_SECRET);
  });
});

/* --------------------------- WhatsApp Embedded --------------------------- */

describe('meta-connect — Embedded Signup WhatsApp', () => {
  const ROUTES = {
    'oauth/access_token': { access_token: 'EAAJETON_WA_1234567890abcdef', expires_in: 5184000 },
    debug_token: {
      data: {
        app_id: APP_ID, is_valid: true, scopes: ['whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['102290129340398'] }],
      },
    },
    // Ordre significatif : `graphFake` retient la PREMIÈRE route dont le motif
    // apparaît dans l'URL. Les plus spécifiques passent donc en premier.
    '/106540352242922/register': { success: true },
    '/102290129340398/phone_numbers': { data: [{ id: '106540352242922', display_phone_number: '+223 70 00 00 00', verified_name: 'VYORA Test', quality_rating: 'GREEN' }] },
    'subscribed_apps': { success: true },
    '/102290129340398': { id: '102290129340398', name: 'Portefeuille Test', account_review_status: 'APPROVED' },
  };

  async function finaliser(options: {
    body: (state: string) => Record<string, unknown>;
    fetchImpl?: typeof fetch;
  }) {
    const fetchImpl = options.fetchImpl ?? graphFake(ROUTES);
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'whatsapp');
    const reponse = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, ...options.body(state) }),
      deps, { allowedOrigins: ORIGINS },
    );
    return { reponse, etat, fetchImpl };
  }

  it('accepte le WABA et le numéro réellement vus par le jeton', async () => {
    const { reponse, etat } = await finaliser({
      body: (state) => ({ state, code: 'CODE_WA', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
    });
    expect(reponse.status).toBe(200);
    const { data } = await reponse.json() as { data: { connected: boolean; connections: Array<Record<string, unknown>> } };
    expect(data.connected).toBe(true);
    const connexion = etat.connections.get(`${USER}:${WS}:whatsapp`);
    expect(connexion).toMatchObject({ external_account_id: '102290129340398', display_name: 'VYORA Test' });
    expect(connexion?.metadata).toMatchObject({
      waba_id: '102290129340398',
      phone_number_id: '106540352242922',
      display_phone_number: '+223 70 00 00 00',
      webhook_subscribed: true,
      registered: true,
    });
    // Le PIN d'enregistrement est en Vault, jamais en base ni dans la réponse.
    expect(etat.secrets.has(pinSecretName(USER, WS))).toBe(true);
    expect(JSON.stringify(data)).not.toContain('EAA');
  });

  it('refuse un numéro qui n’appartient pas au WABA autorisé', async () => {
    const { reponse, etat } = await finaliser({
      body: (state) => ({ state, code: 'CODE_WA', wabaId: '102290129340398', phoneNumberId: '999999999999999' }),
    });
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'PHONE_NOT_IN_WABA' } });
    expect(etat.connections.size).toBe(0);
  });

  it('refuse un WABA que le jeton ne voit pas', async () => {
    const fetchImpl = graphFake({
      'oauth/access_token': ROUTES['oauth/access_token'],
      debug_token: ROUTES.debug_token,
      '/102290129340398': { error: { code: 100, message: 'Unsupported get request. Object does not exist' } },
    });
    const { reponse, etat } = await finaliser({
      body: (state) => ({ state, code: 'CODE_WA', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reponse.status).toBe(400);
    expect(etat.connections.size).toBe(0);
    expect(etat.secrets.size).toBe(0);
  });

  it('sans WABA identifié : refus explicite, pas de connexion à moitié', async () => {
    const fetchImpl = graphFake({
      ...ROUTES,
      debug_token: { data: { app_id: APP_ID, is_valid: true, scopes: [], granular_scopes: [] } },
    });
    const { reponse, etat } = await finaliser({
      body: (state) => ({ state, code: 'CODE_WA' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'WABA_REQUIRED' } });
    expect(etat.connections.size).toBe(0);
  });

  it('un state d’un autre utilisateur ne donne aucune connexion', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    // State émis pour un AUTRE utilisateur.
    await deps.stateCreate(state, OTHER_USER, WS, 'whatsapp');
    const reponse = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, state, code: 'C', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'STATE_INVALID' } });
    expect(etat.connections.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un state de Facebook ne peut pas servir à WhatsApp', async () => {
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: graphFake(ROUTES) as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'facebook');
    const reponse = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, state, code: 'C', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(400);
    expect(etat.connections.size).toBe(0);
  });

  it('sans code : refus immédiat, aucun échange', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const state = randomState();
    await deps.stateCreate(state, USER, WS, 'whatsapp');
    const reponse = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, state }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'NO_CODE' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ------------------------------ Pages owned ----------------------------- */

describe('meta-connect — propriété des pages', () => {
  const ROUTES = {
    'me/accounts': {
      data: [
        { id: '117804259030922', name: 'Page autorisée', category: 'Business', access_token: 'EAA_PAGE_OK_JETON_1234567890', tasks: ['MANAGE', 'CREATE_CONTENT'] },
        { id: '117804259030923', name: 'Page en lecture', category: 'Business', access_token: 'EAA_PAGE_LECTURE_JETON_123', tasks: ['ANALYZE'] },
      ],
      paging: {},
    },
    'subscribed_apps': { success: true },
  };

  async function avecConnexion(fetchImpl: typeof fetch) {
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl });
    const jeton = 'EAAJETON_PAGE_PRINCIPAL_123456789';
    etat.secrets.set(tokenSecretName('facebook', USER, WS), jeton);
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'USER_FB_1', display_name: 'Compte', granted_scopes: ['pages_show_list'],
      token_ref: tokenSecretName('facebook', USER, WS), token_expires_at: null, metadata: {},
    });
    return { deps, etat, jeton };
  }

  it('liste les pages réellement autorisées et leur état de sélection', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = await avecConnexion(fetchImpl as unknown as typeof fetch);
    const reponse = await handleMetaConnect(post({ action: 'pages.list', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    const { data } = await reponse.json() as { data: { pages: Array<Record<string, unknown>> } };
    expect(data.pages.map((p) => p.page_id)).toEqual(['117804259030922', '117804259030923']);
    expect(data.pages[0].can_manage).toBe(true);
    expect(data.pages[1].can_manage).toBe(false);
    // Le jeton de page ne sort JAMAIS vers le navigateur.
    expect(JSON.stringify(data)).not.toContain('EAA');
  });

  it('refuse une page dont on n’est pas administrateur', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps, etat } = await avecConnexion(fetchImpl as unknown as typeof fetch);
    const reponse = await handleMetaConnect(
      post({ action: 'pages.select', workspaceId: WS, product: 'facebook', pageIds: ['117804259030922', '888888888888888'] }),
      deps, { allowedOrigins: ORIGINS },
    );
    const { data } = await reponse.json() as { data: { selected: number; refused: Array<{ page_id: string; code: string }> } };
    expect(data.selected).toBe(1);
    expect(data.refused).toEqual([{ page_id: '888888888888888', code: 'NOT_OWNED' }]);
    // Seule la page réellement possédée est enregistrée.
    expect([...etat.pages.keys()]).toEqual(['117804259030922']);
    expect(etat.secrets.has(pageSecretName('facebook', '117804259030922', USER, WS))).toBe(true);
  });

  it('retirer une page supprime son jeton de Vault', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps, etat } = await avecConnexion(fetchImpl as unknown as typeof fetch);
    await handleMetaConnect(post({ action: 'pages.select', workspaceId: WS, product: 'facebook', pageIds: ['117804259030922', '117804259030923'] }), deps, { allowedOrigins: ORIGINS });
    expect(etat.secrets.size).toBe(3); // jeton utilisateur + deux jetons de page
    await handleMetaConnect(post({ action: 'pages.select', workspaceId: WS, product: 'facebook', pageIds: ['117804259030922'] }), deps, { allowedOrigins: ORIGINS });
    expect(etat.pages.has('117804259030923')).toBe(false);
    expect(etat.secrets.has(pageSecretName('facebook', '117804259030923', USER, WS))).toBe(false);
  });

  it('sans connexion Facebook préalable, aucune page ne peut être listée', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    const reponse = await handleMetaConnect(post({ action: 'pages.list', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(409);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('une page d’une AUTRE entreprise n’est pas utilisable', async () => {
    const fetchImpl = graphFake(ROUTES);
    const { deps } = await avecConnexion(fetchImpl as unknown as typeof fetch);
    const reponse = await handleMetaConnect(
      post({ action: 'facebook.posts', workspaceId: WS, product: 'facebook', pageId: '777777777777777' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(404);
    expect(await reponse.json()).toMatchObject({ error: { code: 'PAGE_NOT_SELECTED' } });
  });
});

/* --------------------------- Jetons et erreurs -------------------------- */

describe('meta-connect — jetons, expiration et erreurs lisibles', () => {
  it('un jeton expiré passe la connexion en « expired » et demande reconnexion', async () => {
    const fetchImpl = graphFake({});
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.secrets.set(tokenSecretName('facebook', USER, WS), 'EAA_VIEUX');
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'U1', display_name: 'Compte', granted_scopes: [], token_ref: tokenSecretName('facebook', USER, WS),
      token_expires_at: new Date(Date.now() - 60_000).toISOString(), metadata: {},
    });
    const reponse = await handleMetaConnect(post({ action: 'pages.list', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(401);
    expect(await reponse.json()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } });
    expect(etat.connections.get(`${USER}:${WS}:facebook`)?.status).toBe('expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un jeton révoqué chez Meta bascule la connexion en « revoked »', async () => {
    const fetchImpl = graphFake({ 'me/accounts': { error: { code: 190, error_subcode: 458, message: 'Session has been invalidated' } } });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.secrets.set(tokenSecretName('facebook', USER, WS), 'EAA_REVOQUE');
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'U1', display_name: 'Compte', granted_scopes: [], token_ref: tokenSecretName('facebook', USER, WS),
      token_expires_at: null, metadata: {},
    });
    const reponse = await handleMetaConnect(post({ action: 'pages.list', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(401);
    expect(etat.connections.get(`${USER}:${WS}:facebook`)?.status).toBe('revoked');
    expect(etat.connections.get(`${USER}:${WS}:facebook`)?.last_error).toContain('reconnectez');
  });

  it('les erreurs Meta sont traduites en français compréhensible', () => {
    expect(explainMetaError(new MetaError('auth_expired', 'x'))).toContain('expiré');
    expect(explainMetaError(new MetaError('permission_denied', 'pages_messaging'))).toContain('permission');
    expect(explainMetaError(new MetaError('rate_limited', 'x'))).toContain('réessayez');
    expect(explainMetaError(new MetaError('timeout', 'x'))).toContain('répondu');
    // Aucun message ne recopie une pile ni un jeton.
    const message = explainMetaError(new MetaError('invalid_request', 'EAA1234567890abcdef'));
    expect(message).not.toContain('EAA1234567890');
  });

  it('une erreur interne ne divulgue pas la cause brute', async () => {
    const { deps } = depsAvec({
      connectionsList: async () => { throw new Error(`connexion impossible à ${APP_SECRET}`); },
    });
    const reponse = await handleMetaConnect(post({ action: 'status', workspaceId: WS }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(500);
    const texte = JSON.stringify(await reponse.json());
    expect(texte).not.toContain(APP_SECRET);
    expect(texte).toContain('indisponible');
  });
});

/* ------------------------------- Déconnexion ---------------------------- */

describe('meta-connect — déconnexion', () => {
  it('supprime la connexion, purge Vault et révoque chez Meta', async () => {
    let revoque = false;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('me/permissions')) {
        revoque = (init?.method ?? 'GET') === 'DELETE';
        return json({ success: true });
      }
      return json({});
    });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.secrets.set(tokenSecretName('facebook', USER, WS), 'EAA_A_REVOQUER_1234567890');
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'U1', display_name: 'Compte', granted_scopes: [], token_ref: tokenSecretName('facebook', USER, WS),
      token_expires_at: null, metadata: {},
    });
    const reponse = await handleMetaConnect(post({ action: 'disconnect', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    const { data } = await reponse.json() as { data: { disconnected: boolean; remoteRevoked: boolean } };
    expect(data.disconnected).toBe(true);
    expect(data.remoteRevoked).toBe(true);
    expect(revoque).toBe(true);
    expect(etat.connections.size).toBe(0);
    expect(etat.secrets.size).toBe(0);
  });

  it('si la révocation distante échoue, la déconnexion locale est quand même faite et signalée', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('me/permissions')) return json({ error: { code: 190, message: 'invalid token' } }, 400);
      return json({});
    });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.secrets.set(tokenSecretName('facebook', USER, WS), 'EAA_INVALIDE');
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'U1', display_name: 'Compte', granted_scopes: [], token_ref: tokenSecretName('facebook', USER, WS),
      token_expires_at: null, metadata: {},
    });
    const reponse = await handleMetaConnect(post({ action: 'disconnect', workspaceId: WS, product: 'facebook' }), deps, { allowedOrigins: ORIGINS });
    const { data } = await reponse.json() as { data: { disconnected: boolean; remoteRevoked: boolean } };
    expect(data.disconnected).toBe(true);
    expect(data.remoteRevoked).toBe(false);
    expect(etat.connections.size).toBe(0);
  });

  it('une déconnexion WhatsApp purge aussi le PIN d’enregistrement', async () => {
    const { deps, etat } = depsAvec();
    etat.secrets.set(tokenSecretName('whatsapp', USER, WS), 'EAA_WA');
    etat.secrets.set(pinSecretName(USER, WS), '123456');
    await deps.connectionUpsert({
      user_id: USER, workspace_id: WS, product: 'whatsapp', status: 'connected',
      external_account_id: 'WABA', display_name: 'Numéro', granted_scopes: [], token_ref: tokenSecretName('whatsapp', USER, WS),
      token_expires_at: null, metadata: { flow: 'embedded-signup' },
    });
    await handleMetaConnect(post({ action: 'disconnect', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: ORIGINS });
    expect(etat.secrets.size).toBe(0);
  });
});

/* ------------------------- Envoi et lecture réels ----------------------- */

describe('meta-connect — envoi et lecture', () => {
  it('un envoi WhatsApp sans numéro destinataire valide est refusé avant tout appel', async () => {
    const fetchImpl = graphFake({});
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.connections.set(`${USER}:${WS}:whatsapp`, {
      id: 'c', user_id: USER, workspace_id: WS, product: 'whatsapp', status: 'connected',
      external_account_id: 'WABA', display_name: 'N', granted_scopes: [], token_ref: tokenSecretName('whatsapp', USER, WS),
      token_expires_at: null, metadata: { phone_number_id: '106540352242922', flow: 'embedded-signup' }, last_error: null,
    });
    etat.secrets.set(tokenSecretName('whatsapp', USER, WS), 'EAA_WA');
    const reponse = await handleMetaConnect(post({ action: 'whatsapp.send', workspaceId: WS, to: '12', text: 'x' }), deps, { allowedOrigins: ORIGINS });
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'RECIPIENT_INVALID' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un envoi WhatsApp accepté par Meta est tracé dans l’historique', async () => {
    const fetchImpl = graphFake({ '/106540352242922/messages': { messages: [{ id: 'wamid.OUT' }], contacts: [{ wa_id: '22370000000' }] } });
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.connections.set(`${USER}:${WS}:whatsapp`, {
      id: 'conn-wa', user_id: USER, workspace_id: WS, product: 'whatsapp', status: 'connected',
      external_account_id: 'WABA', display_name: 'N', granted_scopes: [], token_ref: tokenSecretName('whatsapp', USER, WS),
      token_expires_at: null, metadata: { phone_number_id: '106540352242922', flow: 'embedded-signup' }, last_error: null,
    });
    etat.secrets.set(tokenSecretName('whatsapp', USER, WS), 'EAA_WA');
    const reponse = await handleMetaConnect(
      post({ action: 'whatsapp.send', workspaceId: WS, to: '+223 70 00 00 00', text: 'Bonjour' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(200);
    expect(etat.messages[0]).toMatchObject({ channel: 'whatsapp', conversation_ref: '22370000000', external_message_id: 'wamid.OUT', direction: 'out' });
  });

  it('la suppression d’une publication d’une autre page est refusée', async () => {
    const fetchImpl = graphFake({});
    const { deps, etat } = depsAvec({}, { allowed: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    etat.connections.set(`${USER}:${WS}:facebook`, {
      id: 'conn-fb', user_id: USER, workspace_id: WS, product: 'facebook', status: 'connected',
      external_account_id: 'U1', display_name: 'C', granted_scopes: [], token_ref: tokenSecretName('facebook', USER, WS),
      token_expires_at: null, metadata: {}, last_error: null,
    });
    etat.pages.set('117804259030999', {
      id: 'p1', connection_id: 'conn-fb', page_id: '117804259030999', name: 'Page', token_ref: pageSecretName('facebook', '117804259030999', USER, WS),
      instagram_business_account_id: null, tasks: ['MANAGE'],
    });
    etat.secrets.set(tokenSecretName('facebook', USER, WS), 'EAA_FB');
    etat.secrets.set(pageSecretName('facebook', '117804259030999', USER, WS), 'EAA_PAGE');
    const reponse = await handleMetaConnect(
      post({ action: 'facebook.post.delete', workspaceId: WS, pageId: '117804259030999', postId: '666666666666_555' }),
      deps, { allowedOrigins: ORIGINS },
    );
    expect(reponse.status).toBe(400);
    expect(await reponse.json()).toMatchObject({ error: { code: 'POST_INVALID' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/* ------------------------------ Types utiles ---------------------------- */

describe('meta-connect — noms de secrets', () => {
  it('chaque secret porte le produit, l’utilisateur et l’entreprise (pas de collision)', () => {
    expect(tokenSecretName('whatsapp', USER, WS)).toBe(`vyora_meta_whatsapp_${USER}_${WS}`);
    expect(pageSecretName('messenger', 'PAGE', USER, WS)).toBe(`vyora_meta_page_messenger_PAGE_${USER}_${WS}`);
    expect(pinSecretName(USER, WS)).toBe(`vyora_meta_wa_pin_${USER}_${WS}`);
    // Deux entreprises du même utilisateur ne partagent aucun secret.
    expect(tokenSecretName('facebook', USER, 'A')).not.toBe(tokenSecretName('facebook', USER, 'B'));
  });

  it('MetaConnectError porte son code et son statut', () => {
    const erreur = new MetaConnectError('TEST', 'message', 418);
    expect(erreur.code).toBe('TEST');
    expect(erreur.status).toBe(418);
    expect(erreur.name).toBe('MetaConnectError');
  });
});

/**
 * Réalités de l'API Meta que le code doit refléter — et qui ne se voient pas
 * dans les tests précédents (ils vérifient des refus, pas des sémantiques de
 * jeton).
 */
describe('meta-connect — sémantique réelle des jetons Meta', () => {
  const ROUTES = {
    'oauth/access_token': { access_token: 'EAAJETON_WA_PERMANENT', token_type: 'bearer' },
    debug_token: {
      data: {
        app_id: APP_ID, is_valid: true, scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['102290129340398'] }],
      },
    },
    '/106540352242922/register': { success: true },
    '/102290129340398/phone_numbers': { data: [{ id: '106540352242922', display_phone_number: '+223 70 00 00 00', verified_name: 'VYORA Test' }] },
    subscribed_apps: { success: true },
    '/102290129340398': { id: '102290129340398', name: 'Portefeuille Test' },
  };

  async function connecter() {
    const { deps, etat } = depsAvec({ fetchImpl: graphFake(ROUTES) as unknown as typeof fetch });
    const lancement = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: [] });
    const { data } = await lancement.json() as { data: { state: string } };
    const fin = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, state: data.state, code: 'CODE_WA', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
      deps,
      { allowedOrigins: [] },
    );
    expect(fin.status).toBe(200);
    return { deps, etat };
  }

  it('un numéro déjà sur Cloud API (coexistence) n’est pas réenregistré', async () => {
    // Reprise d'un numéro de l'app WhatsApp Business : `platform_type` vaut
    // CLOUD_API. Le réenregistrer échouerait sur le PIN, alors que Meta demande
    // explicitement de sauter cette étape.
    const routes = {
      ...ROUTES,
      '/102290129340398/phone_numbers': {
        data: [{ id: '106540352242922', display_phone_number: '+223 70 00 00 00', verified_name: 'VYORA Test', platform_type: 'CLOUD_API' }],
      },
      '/106540352242922/register': { error: { code: 133005, message: 'Two step verification PIN mismatch' } },
    };
    const { deps, etat } = depsAvec({ fetchImpl: graphFake(routes) as unknown as typeof fetch });
    const lancement = await handleMetaConnect(post({ action: 'start', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: [] });
    const { data } = await lancement.json() as { data: { state: string } };
    const fin = await handleMetaConnect(
      post({ action: 'finish-embedded', workspaceId: WS, state: data.state, code: 'CODE_WA', wabaId: '102290129340398', phoneNumberId: '106540352242922' }),
      deps,
      { allowedOrigins: [] },
    );
    expect(fin.status).toBe(200);
    const connexion = etat.connections.get(`${USER}:${WS}:whatsapp`);
    expect(connexion?.metadata?.register_skipped_already_cloud_api).toBe(true);
    expect(connexion?.metadata?.registered).toBe(true);
    expect(connexion?.metadata?.register_error).toBeNull();
    // Aucun PIN n'a été créé pour un numéro qu'on n'enregistre pas.
    expect([...etat.secrets.keys()].some((k) => k.includes('wa_pin'))).toBe(false);
  });

  it('un jeton d’intégration métier (sans expires_in) n’est jamais daté d’expiration', async () => {
    const { etat } = await connecter();
    const connexion = etat.connections.get(`${USER}:${WS}:whatsapp`);
    // Écrire une date inventée afficherait « Jeton expiré » sur un jeton permanent.
    expect(connexion?.token_expires_at ?? null).toBeNull();
    expect(connexion?.metadata?.permanent_token).toBe(true);
  });

  it('« renouveler » ne prétend pas renouveler un jeton permanent, et le vérifie', async () => {
    const { deps } = await connecter();
    const reponse = await handleMetaConnect(post({ action: 'refresh', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: [] });
    expect(reponse.status).toBe(200);
    const { data } = await reponse.json() as { data: { refreshed: boolean; reason: string; message: string } };
    expect(data.refreshed).toBe(false);
    expect(data.reason).toBe('PERMANENT_TOKEN');
    expect(data.message).toMatch(/sans date d’expiration/);
  });

  it('un jeton permanent révoqué chez Meta bascule la connexion en expiré', async () => {
    const { deps, etat } = await connecter();
    // Meta ne répond plus que « invalid » sur ce jeton.
    (deps as { fetchImpl?: typeof fetch }).fetchImpl = graphFake({
      debug_token: { data: { app_id: APP_ID, is_valid: false } },
    }) as unknown as typeof fetch;
    const reponse = await handleMetaConnect(post({ action: 'refresh', workspaceId: WS, product: 'whatsapp' }), deps, { allowedOrigins: [] });
    expect(reponse.status).toBe(401);
    const corps = await reponse.json() as { error: { code: string } };
    expect(corps.error.code).toBe('TOKEN_EXPIRED');
    expect(etat.connections.get(`${USER}:${WS}:whatsapp`)?.status).toBe('expired');
  });
});
