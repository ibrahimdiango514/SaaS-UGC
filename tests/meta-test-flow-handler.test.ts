import { describe, expect, it, vi } from 'vitest';
import {
  handleMetaConnect,
  type ConnectionRow,
  type MetaConfig,
  type MetaDeps,
} from '../supabase/functions/meta-connect/handler';

/**
 * Parcours WhatsApp de test — refus au niveau du HANDLER.
 *
 * ## Pourquoi un fichier séparé
 * `tests/meta-test-flow.test.ts` vérifie la décision (`refuseTestFlow`) en
 * isolation. Ici, on traverse la vraie fonction Edge : c'est elle qui décide de
 * l'ordre des contrôles, du statut HTTP et du contenu de la réponse. Un module
 * parfaitement gardé peut être mal branché — ces tests couvrent le branchement.
 *
 * ## Les six exigences de sécurité, une par test
 *  1. administrateur autorisé → parcours accessible ;
 *  2. client non administrateur → refus serveur ;
 *  3. non authentifié → refus ;
 *  4. identifiant non autorisé → refus ;
 *  5. vérification webhook invalide → refus ;
 *  6. aucun secret dans les réponses ni les journaux.
 */

const ADMIN = 'd54cb18f-0f06-4888-a489-e9c60d7fbd8b';
const CLIENT = '373436db-0f06-4888-a489-e9c60d7fbd8b';
const WS = '1e1fd8bb-6ad4-4ae2-8e99-bf48373fce1b';
const JETON_TEST = 'EAABtesttokenVRAIMENTsecret1234567890';

const config: MetaConfig = {
  appId: '1692282959171281',
  appSecret: 'APP_SECRET_NE_DOIT_PAS_FUIRER',
  appUrl: 'https://vyora-saas-ugc.netlify.app',
  supabaseUrl: 'https://xbuuhfwobrafcbgtdgjx.supabase.co',
  configIds: { whatsapp: 'CFG_WA' },
};

const TEST_FLOW = {
  enabled: true,
  wabaId: '102290129340398',
  phoneNumberId: '106540352242922',
  displayPhoneNumber: '+1 555 000 0000',
};

/** Graph simulé : le numéro appartient (ou non) au WABA selon `appartient`. */
function graphFake(appartient = true, abonnementOk = true) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const json = (corps: unknown, status = 200) =>
      new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/phone_numbers')) {
      return json({
        data: appartient
          ? [{ id: '106540352242922', display_phone_number: '+1 555 000 0000', verified_name: 'VYORA Test', quality_rating: 'GREEN' }]
          : [{ id: '999999999999999', display_phone_number: '+1 555 111 1111' }],
      });
    }
    if (u.includes('/subscribed_apps')) return json({ success: abonnementOk });
    if (u.includes('102290129340398')) return json({ id: '102290129340398', name: 'Compte de test' });
    return json({ error: { code: 100, message: 'route non simulée' } }, 400);
  });
}

interface Etat {
  secrets: Map<string, string>;
  connections: Map<string, ConnectionRow>;
  logs: string[];
}

function depsAvec(overrides: Partial<MetaDeps> = {}, options: {
  isAdmin?: boolean;
  testFlow?: typeof TEST_FLOW | undefined;
  fetchImpl?: typeof fetch;
  allowed?: boolean;
} = {}) {
  const etat: Etat = { secrets: new Map(), connections: new Map(), logs: [] };

  const deps: MetaDeps = {
    config,
    testFlow: options.testFlow === undefined ? TEST_FLOW : options.testFlow,
    getUserId: async (authorization: string) => {
      if (authorization === `Bearer jwt-${ADMIN}`) return ADMIN;
      if (authorization === `Bearer jwt-${CLIENT}`) return CLIENT;
      return null;
    },
    isAdmin: async (userId: string) => (options.isAdmin ?? true) && userId === ADMIN,
    checkImportAccess: async () => ({
      allowed: options.allowed ?? true,
      reason: 'OK',
      message: '',
    }),
    grantWorkspace: async () => ({ canRead: true, canWrite: true }),
    stateCreate: async () => {},
    stateConsume: async () => null,
    storeSecret: async (nom, valeur) => { etat.secrets.set(nom, valeur); },
    readSecret: async (nom) => etat.secrets.get(nom) ?? null,
    deleteSecret: async (nom) => { etat.secrets.delete(nom); },
    connectionUpsert: async (payload) => {
      etat.connections.set('whatsapp', {
        id: 'conn-wa',
        user_id: String(payload.user_id),
        workspace_id: String(payload.workspace_id),
        product: 'whatsapp',
        status: String(payload.status ?? 'connected'),
        external_account_id: String(payload.external_account_id),
        display_name: (payload.display_name as string | null) ?? null,
        granted_scopes: (payload.granted_scopes as string[]) ?? [],
        token_ref: (payload.token_ref as string | null) ?? null,
        token_expires_at: (payload.token_expires_at as string | null) ?? null,
        metadata: (payload.metadata as Record<string, unknown>) ?? {},
        last_error: null,
      });
      return 'conn-wa';
    },
    connectionInternal: async () => etat.connections.get('whatsapp') ?? null,
    connectionsList: async () => [...etat.connections.values()],
    connectionSetStatus: async () => {},
    connectionMergeMetadata: async () => {},
    connectionDelete: async () => { etat.connections.delete('whatsapp'); return { tokenRefs: [] }; },
    pagesReplace: async () => ({ removedTokenRefs: [] }),
    pageInternal: async () => null,
    recordIntegration: async () => {},
    disconnectIntegration: async () => {},
    messageRecord: async () => {},
    messagesList: async () => [],
    conversationsList: async () => [],
    pageEventsList: async () => [],
    fetchImpl: options.fetchImpl,
    log: (message, detail) => { etat.logs.push(`${message} ${JSON.stringify(detail ?? {})}`); },
  };

  return { deps: { ...deps, ...overrides }, etat };
}

function post(corps: Record<string, unknown>, jwt = `jwt-${ADMIN}`) {
  return new Request('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/meta-connect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${jwt}`,
      origin: 'https://vyora-saas-ugc.netlify.app',
    },
    body: JSON.stringify(corps),
  });
}

const ORIGINS = ['https://vyora-saas-ugc.netlify.app'];

/** Pose le jeton de test, comme le fait `index.ts` au démarrage. */
function avecJeton<T>(fn: () => Promise<T>): Promise<T> {
  (globalThis as unknown as { __metaTestToken?: string }).__metaTestToken = JETON_TEST;
  return fn();
}

const appeler = (
  deps: MetaDeps,
  corps: Record<string, unknown>,
  jwt?: string,
) => avecJeton(() => handleMetaConnect(post(corps, jwt), deps, { allowedOrigins: ORIGINS }));

/* --------------------------- 1. administrateur ---------------------------- */

describe('administrateur autorisé — le parcours fonctionne', () => {
  it('whatsapp.test.status expose l’état sans secret', async () => {
    const { deps } = depsAvec();
    const r = await appeler(deps, { action: 'whatsapp.test.status', workspaceId: WS });
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { data: { testFlow: { available: boolean; wabaId: string } } };
    expect(corps.data.testFlow.available).toBe(true);
    expect(corps.data.testFlow.wabaId).toBe('102290129340398');
    expect(JSON.stringify(corps)).not.toContain(JETON_TEST);
  });

  it('whatsapp.test.connect enregistre la connexion vérifiée par Meta', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(200);
    const ligne = etat.connections.get('whatsapp');
    expect(ligne?.status).toBe('connected');
    expect(ligne?.external_account_id).toBe('102290129340398');
    expect(ligne?.metadata.flow).toBe('test-number');
    expect(ligne?.metadata.test_flow).toBe(true);
    // Le jeton part en Vault, pas dans la table.
    expect(ligne?.token_ref).toMatch(/^vyora_meta_test_token:/);
    expect(etat.secrets.get(ligne?.token_ref ?? '')).toBe(JETON_TEST);
    expect(JSON.stringify(ligne)).not.toContain(JETON_TEST);
  });

  it('signale un abonnement webhook refusé sans bloquer la connexion', async () => {
    const { deps } = depsAvec({}, { fetchImpl: graphFake(true, false) as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { data: { webhookSubscribed: boolean; warning: string } };
    expect(corps.data.webhookSubscribed).toBe(false);
    expect(corps.data.warning).toContain('webhook');
  });

  it('whatsapp.test.disconnect retire la connexion de test', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(etat.connections.size).toBe(1);
    const r = await appeler(deps, { action: 'whatsapp.test.disconnect', workspaceId: WS });
    expect(r.status).toBe(200);
    expect(etat.connections.size).toBe(0);
  });
});

/* ------------------------- 2. client non administrateur ------------------- */

describe('client non administrateur — refus serveur', () => {
  it('reçoit 404 pour les trois actions, jamais 403', async () => {
    /*
     * Un 403 révélerait l'existence du parcours. Un 404 est la réponse qu'il
     * obtiendrait pour une action inexistante : il n'apprend rien.
     */
    for (const action of ['whatsapp.test.status', 'whatsapp.test.connect', 'whatsapp.test.disconnect']) {
      const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
      const r = await appeler(deps, { action, workspaceId: WS }, `jwt-${CLIENT}`);
      expect(r.status, action).toBe(404);
      expect((await r.json()) as unknown).toMatchObject({ error: { code: 'TEST_FLOW_UNAVAILABLE' } });
      // Rien n'a été écrit, rien n'a été appelé chez Meta.
      expect(etat.connections.size, action).toBe(0);
    }
  });

  it('ne peut pas se déclarer administrateur par le corps de la requête', async () => {
    // Tentative explicite : le corps prétend être admin, le serveur ignore.
    const { deps, etat } = depsAvec({}, { isAdmin: false, fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, {
      action: 'whatsapp.test.connect',
      workspaceId: WS,
      isAdmin: true,
      is_admin: true,
      admin: true,
      userId: ADMIN,
      role: 'admin',
    }, `jwt-${CLIENT}`);
    expect(r.status).toBe(404);
    expect(etat.connections.size).toBe(0);
  });

  it('refuse même avec un abonnement actif et des droits d’écriture', async () => {
    // Le parcours de test n'est pas une question d'abonnement : c'est une
    // question d'identité. Un client well-provisioned reste refusé.
    const { deps } = depsAvec({}, { isAdmin: false, allowed: true, fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS }, `jwt-${CLIENT}`);
    expect(r.status).toBe(404);
  });

  it('le refus intervient AVANT le contrôle d’abonnement', async () => {
    /*
     * Ordre vérifié : sans cela, un client sans abonnement recevrait 402 et un
     * client abonné 403 — deux réponses qui, comparées, lui apprendraient que
     * l'action existe.
     */
    const { deps } = depsAvec({}, { isAdmin: false, allowed: false, fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.status', workspaceId: WS }, `jwt-${CLIENT}`);
    expect(r.status).toBe(404);
    expect((await r.json()) as unknown).toMatchObject({ error: { code: 'TEST_FLOW_UNAVAILABLE' } });
  });
});

/* ----------------------------- 3. non authentifié ------------------------- */

describe('utilisateur non authentifié — refus', () => {
  it('sans JWT : 401', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await avecJeton(() => handleMetaConnect(
      new Request('https://x/functions/v1/meta-connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'whatsapp.test.connect', workspaceId: WS }),
      }),
      deps, { allowedOrigins: ORIGINS },
    ));
    expect(r.status).toBe(401);
    expect(etat.connections.size).toBe(0);
  });

  it('avec un JWT forgé : 401', async () => {
    const { deps } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS }, 'jwt-forge');
    expect(r.status).toBe(401);
  });
});

/* ------------------------- 4. identifiant non autorisé -------------------- */

describe('identifiant non autorisé — refus, sans écriture', () => {
  it('refuse un numéro absent du WABA déclaré', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake(false) as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(409);
    expect((await r.json()) as unknown).toMatchObject({ error: { code: 'TEST_FLOW_TARGET_INVALID' } });
    expect(etat.connections.size).toBe(0);
  });

  it('ignore tout identifiant fourni par le client', async () => {
    /*
     * L'exigence « aucun rattachement possible d'un numéro arbitraire » : même
     * en envoyant explicitement un autre WABA et un autre numéro, le serveur
     * utilise UNIQUEMENT sa configuration. Ici la configuration est valide,
     * donc la connexion réussit — et porte bien les identifiants serveur, pas
     * ceux du corps.
     */
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, {
      action: 'whatsapp.test.connect',
      workspaceId: WS,
      wabaId: '999999999999999',
      phoneNumberId: '888888888888888',
      external_account_id: '999999999999999',
    });
    expect(r.status).toBe(200);
    const ligne = etat.connections.get('whatsapp');
    expect(ligne?.external_account_id).toBe('102290129340398');
    expect(ligne?.metadata.phone_number_id).toBe('106540352242922');
    expect(JSON.stringify(ligne)).not.toContain('999999999999999');
  });

  it('refuse quand la configuration serveur est incomplète', async () => {
    const { deps } = depsAvec({}, {
      testFlow: { ...TEST_FLOW, wabaId: '' },
      fetchImpl: graphFake() as unknown as typeof fetch,
    });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(503);
    expect((await r.json()) as unknown).toMatchObject({ error: { code: 'TEST_FLOW_NOT_CONFIGURED' } });
  });

  it('refuse quand l’interrupteur serveur est fermé, même pour l’administrateur', async () => {
    const { deps, etat } = depsAvec({}, {
      testFlow: { ...TEST_FLOW, enabled: false },
      fetchImpl: graphFake() as unknown as typeof fetch,
    });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(404);
    expect(etat.connections.size).toBe(0);
  });

  it('refuse quand le jeton de test n’est pas configuré', async () => {
    const { deps } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    (globalThis as unknown as { __metaTestToken?: string }).__metaTestToken = '';
    const r = await handleMetaConnect(
      post({ action: 'whatsapp.test.connect', workspaceId: WS }), deps, { allowedOrigins: ORIGINS },
    );
    expect(r.status).toBe(503);
    expect((await r.json()) as unknown).toMatchObject({ error: { code: 'TEST_FLOW_TOKEN_MISSING' } });
  });
});

/* ---------------------- 5. vérification webhook invalide ------------------ */

describe('vérification auprès de Meta — Meta tranche', () => {
  it('refuse quand Meta ne donne pas accès au WABA', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 190, message: 'invalid token' } }), { status: 401 }));
    const { deps, etat } = depsAvec({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    // MetaError → statut relayé, et surtout : aucune connexion écrite.
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(etat.connections.size).toBe(0);
  });

  it('refuse une liste de numéros vide', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/phone_numbers')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: '102290129340398', name: 'Compte' }), { status: 200 });
    });
    const { deps, etat } = depsAvec({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect(r.status).toBe(409);
    expect(etat.connections.size).toBe(0);
  });
});

/* ---------------------- 6. aucun secret dans les sorties ----------------- */

describe('aucun secret dans les réponses ni les journaux', () => {
  it('la réponse de connect ne contient ni jeton ni App Secret', async () => {
    const { deps } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    const texte = await r.text();
    expect(texte).not.toContain(JETON_TEST);
    expect(texte).not.toContain('EAAB');
    expect(texte).not.toContain(config.appSecret);
  });

  it('les journaux ne contiennent ni jeton ni secret', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake(false) as unknown as typeof fetch });
    await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    const tout = etat.logs.join('\n');
    expect(tout).not.toContain(JETON_TEST);
    expect(tout).not.toContain(config.appSecret);
  });

  it('une erreur Meta contenant le jeton est expurgée avant de remonter', async () => {
    // Meta renvoie parfois le jeton dans le message d'erreur : il doit être
    // filtré par `redactTokens`, sinon il atterrit chez le navigateur.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        error: { code: 190, message: `Invalid OAuth access token ${JETON_TEST}`, type: 'OAuthException' },
      }), { status: 401 }));
    const { deps } = depsAvec({}, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    const texte = await r.text();
    expect(texte).not.toContain(JETON_TEST);
  });
});

/* --------------------- le parcours client n'est pas touché --------------- */

describe('le parcours Embedded Signup reste intact', () => {
  it('un client non administrateur garde accès aux actions normales', async () => {
    // La garde de test ne doit pas déteindre sur le parcours client.
    const { deps } = depsAvec({}, { isAdmin: false });
    const r = await appeler(deps, { action: 'status', workspaceId: WS }, `jwt-${CLIENT}`);
    expect(r.status).toBe(200);
  });

  it('start reste gouverné par le config_id, pas par le parcours de test', async () => {
    const { deps } = depsAvec({}, { isAdmin: false });
    const r = await appeler(deps, { action: 'start', product: 'whatsapp', workspaceId: WS }, `jwt-${CLIENT}`);
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { data: { mode: string } };
    expect(corps.data.mode).toBe('embedded-signup');
  });

  it('le parcours de test ne crée jamais de connexion d’un autre produit', async () => {
    const { deps, etat } = depsAvec({}, { fetchImpl: graphFake() as unknown as typeof fetch });
    await appeler(deps, { action: 'whatsapp.test.connect', workspaceId: WS });
    expect([...etat.connections.keys()]).toEqual(['whatsapp']);
  });
});
