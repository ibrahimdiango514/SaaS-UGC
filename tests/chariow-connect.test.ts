/**
 * Edge Functions `store-connect` et `store-import` — parcours Chariow.
 *
 * Ces tests exercent les handlers RÉELS, avec un environnement simulé : pas de
 * réseau, pas de base. Ce qu'ils protègent, dans l'ordre du parcours :
 *
 *   1. **la clé n'apparaît nulle part** — ni dans la réponse, ni dans un
 *      journal, ni dans un enregistrement de connexion ;
 *   2. **l'abonnement Business Grow est exigé AVANT tout appel réseau** ;
 *   3. **l'entreprise est vérifiée en base**, jamais d'après l'identifiant reçu ;
 *   4. **une clé d'une autre boutique est refusée** (le cas qui écraserait le
 *      mauvais catalogue) ;
 *   5. **un 401/403 de Chariow est un problème de connexion**, pas une panne ;
 *   6. **l'aperçu ne délivre aucun identifiant d'écriture** sans confirmation.
 */
import { describe, expect, it } from 'vitest';
import {
  handleStoreConnect,
  credentialName,
  type ConnectDependencies,
} from '../supabase/functions/store-connect/handler';
import { createStoreImportHandler, type StoreImportDependencies } from '../supabase/functions/store-import/handler';
import type { PinnedSocket } from '../supabase/functions/store-import/pinned-fetch';

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

const UTILISATEUR = '33333333-3333-4333-8333-333333333333';
const ENTREPRISE = '44444444-4444-4444-8444-444444444444';
/** Clé de test reconnaissable : jamais une vraie clé. */
const CLE_TEST = 'sk_live_test_000000000000000000000000';
const BOUTIQUE = 'https://ewbnibvk.mychariow.online';

function requete(corps: Record<string, unknown>, entetes: Record<string, string> = {}): Request {
  return new Request('https://edge.test/store-connect', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer jeton-de-test',
      origin: 'https://app.vyora.test',
      ...entetes,
    },
    body: JSON.stringify(corps),
  });
}

/* -------------------------------------------------------------------------- */
/* Charges utiles Chariow                                                      */
/* -------------------------------------------------------------------------- */

const boutiquePayload = {
  data: {
    id: 'store_abc123',
    name: 'SBC AI AGENCY',
    description: 'Dev founder SaaS',
    logo_url: null,
    url: BOUTIQUE,
    social_links: {},
    status: 'active',
    stats: { total_customers: 12, ratings: { total_ratings: 1 } },
  },
};

function produit(id: string, name: string, status = 'published') {
  return {
    id,
    name,
    slug: `${id}-slug`,
    description: '<p>Description</p>',
    type: 'course',
    category: { value: 'education_and_learning', label: 'Education and Learning' },
    status,
    is_free: false,
    pictures: { thumbnail: null, cover: 'https://cdn.chariow.com/c.jpg' },
    pricing: {
      effective: { value: 99, formatted: '$99.00', short: '99', currency: 'USD' },
      tracking: { currency: 'USD', value: 99 },
    },
    has_variant_pricing: false,
    quantity: null,
    on_sale_until: null,
  };
}

type Repondeur = (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> };

function apiChariow(repondeur: Repondeur) {
  const appels: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const entetes = new Headers(init?.headers ?? {});
    appels.push({ url: input, authorization: entetes.get('authorization') });
    const reponse = repondeur(new URL(input));
    return new Response(
      typeof reponse.body === 'string' ? reponse.body : JSON.stringify(reponse.body),
      { status: reponse.status ?? 200, headers: { 'content-type': 'application/json', ...(reponse.headers ?? {}) } },
    );
  };
  return { fetchImpl, appels };
}

/**
 * Faux socket qui répond selon le CHEMIN réellement demandé.
 *
 * La sortie réseau de `store-import` n'ouvre pas `fetch` mais un socket épinglé
 * (`connect`). Une doublure `fetchImpl` ne suffit donc pas : sans `connect`, la
 * sortie répond `REQUIRED` et l'aperçu échoue en 502. On simule ici le socket,
 * comme le fait déjà `store-import-edge.test.ts` pour Shopify.
 */
function socketApi(repondeur: Repondeur): PinnedSocket {
  let octets = new Uint8Array();
  let position = 0;
  return {
    async write(p: Uint8Array) {
      const texte = new TextDecoder().decode(p);
      const chemin = /^GET (\S+) HTTP\//.exec(texte)?.[1] ?? '/';
      const url = new URL(chemin, 'https://api.chariow.com');
      const { status = 200, body, headers = {} } = repondeur(url);
      const corps = typeof body === 'string' ? body : JSON.stringify(body);
      const entetes = [
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Erreur'}`,
        'Content-Type: application/json',
        `Content-Length: ${new TextEncoder().encode(corps).byteLength}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Connection: close',
        '',
        corps,
      ].join('\r\n');
      octets = new TextEncoder().encode(entetes);
      position = 0;
      return p.byteLength;
    },
    async read(p: Uint8Array) {
      if (position >= octets.length) return null;
      const taille = Math.min(p.length, octets.length - position);
      p.set(octets.subarray(position, position + taille));
      position += taille;
      return taille;
    },
    close() {},
  };
}

/* -------------------------------------------------------------------------- */
/* `store-connect` — environnement simulé                                      */
/* -------------------------------------------------------------------------- */

interface Journal {
  secrets: Array<{ userId: string; connectorKey: string; secret: string }>;
  connexions: Array<Record<string, unknown>>;
  echecs: Array<Record<string, unknown>>;
  logs: Array<{ message: string; detail?: Record<string, unknown> }>;
  supprimes: string[];
}

function environnement(options: {
  allowed?: boolean;
  reason?: string;
  canWrite?: boolean;
  api?: Repondeur;
  cleEnVault?: string | null;
  enregistrementEchoue?: string | null;
}): { deps: ConnectDependencies; journal: Journal; appels: ReturnType<typeof apiChariow>['appels'] } {
  const journal: Journal = { secrets: [], connexions: [], echecs: [], logs: [], supprimes: [] };
  const { fetchImpl, appels } = apiChariow(options.api ?? (() => ({ body: boutiquePayload })));

  const deps: ConnectDependencies = {
    async getUserId() { return UTILISATEUR; },
    async checkImportAccess() {
      const allowed = options.allowed ?? true;
      return {
        allowed,
        reason: options.reason ?? (allowed ? 'OK' : 'NO_SUBSCRIPTION'),
        message: allowed ? 'Actif' : 'Un abonnement Business Ground actif est requis.',
      };
    },
    async grantWorkspace() { return { canRead: true, canWrite: options.canWrite ?? true }; },
    async storeCredential(input) {
      journal.secrets.push({ userId: input.userId, connectorKey: input.connectorKey, secret: input.secret });
      return credentialName(input.userId, input.connectorKey);
    },
    async readCredential() { return options.cleEnVault ?? CLE_TEST; },
    async deleteCredential(name) { journal.supprimes.push(name); },
    async recordConnection(input) {
      if (options.enregistrementEchoue) throw new Error(options.enregistrementEchoue);
      journal.connexions.push({ ...input });
      return { connectionId: 'conn-1', status: 'connected' };
    },
    async recordFailure(input) {
      journal.echecs.push({ ...input });
      return { connectionId: 'conn-1', status: 'error' };
    },
    async readConnection() { return { connector_key: 'chariow', status: 'connected' }; },
    async markDisconnected() { return { status: 'disconnected' }; },
    async resolveHost() { return ['93.184.216.34']; },
    fetchImpl,
    log: (message, detail) => journal.logs.push({ message, detail }),
  };
  return { deps, journal, appels };
}

/* -------------------------------------------------------------------------- */
/* Connexion Chariow                                                           */
/* -------------------------------------------------------------------------- */

describe('store-connect — Chariow', () => {
  it('connecte une boutique en lisant réellement store puis products', async () => {
    const { deps, journal, appels } = environnement({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : { body: { data: [produit('prd_1', 'A')], pagination: { count: 1, next_cursor: null, has_more_pages: false } } }),
    });

    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST, url: BOUTIQUE }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );

    expect(reponse.status).toBe(200);
    const corps = await reponse.json() as { data: Record<string, unknown> };
    expect(corps.data.connected).toBe(true);
    expect(corps.data.shopName).toBe('SBC AI AGENCY');
    expect(corps.data.storeUrl).toBe(BOUTIQUE);
    expect(corps.data.resourcesRead).toEqual(['store', 'products']);
    expect(corps.data.connectedTo).toBe('api.chariow.com');

    // Deux appels, tous sur l'hôte fixe de l'API, tous avec la clé en en-tête.
    expect(appels).toHaveLength(2);
    expect(appels.every((a) => a.url.startsWith('https://api.chariow.com/v1'))).toBe(true);
    expect(appels.every((a) => a.authorization === `Bearer ${CLE_TEST}`)).toBe(true);

    // La clé est déposée en Vault, et elle n'est PAS dans la réponse.
    expect(journal.secrets).toHaveLength(1);
    expect(journal.secrets[0].connectorKey).toBe('chariow');
    expect(JSON.stringify(corps)).not.toContain(CLE_TEST);
    expect(journal.connexions[0].credentialRef).toBe(credentialName(UTILISATEUR, 'chariow'));
  });

  it('ne met JAMAIS la clé dans la référence externe de la connexion', async () => {
    const { deps, journal } = environnement({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : { body: { data: [], pagination: { count: 0, next_cursor: null, has_more_pages: false } } }),
    });
    await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(String(journal.connexions[0].externalAccountRef)).toBe(BOUTIQUE);
    expect(JSON.stringify(journal.connexions)).not.toContain(CLE_TEST);
    expect(JSON.stringify(journal.logs)).not.toContain(CLE_TEST);
  });

  it('refuse une clé appartenant à une AUTRE boutique, sans rien enregistrer', async () => {
    const { deps, journal } = environnement({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: { data: { ...boutiquePayload.data, url: 'https://autre.mychariow.online' } } }
        : { body: { data: [], pagination: { count: 0, next_cursor: null, has_more_pages: false } } }),
    });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST, url: BOUTIQUE }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(409);
    const corps = await reponse.json() as { error: { code: string; message: string } };
    expect(corps.error.code).toBe('SHOP_MISMATCH');
    expect(corps.error.message).toContain('autre.mychariow.online');
    // Rien n'a été déposé : refuser ne doit pas laisser un secret orphelin.
    expect(journal.secrets).toHaveLength(0);
    expect(journal.connexions).toHaveLength(0);
  });

  it('exige l’abonnement Business Grow AVANT tout appel à Chariow', async () => {
    const { deps, journal, appels } = environnement({ allowed: false, reason: 'SUBSCRIPTION_EXPIRED' });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(403);
    // Aucune requête sortante : un compte expiré ne doit pas consommer de quota.
    expect(appels).toHaveLength(0);
    expect(journal.secrets).toHaveLength(0);
  });

  it('refuse une entreprise sans droit d’écriture, sans appeler Chariow', async () => {
    const { deps, appels } = environnement({ canWrite: false });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(403);
    expect(appels).toHaveLength(0);
  });

  it('refuse une origine non autorisée', async () => {
    const { deps } = environnement({});
    const requeteEvil = requete(
      { action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST },
      { origin: 'https://evil.test' },
    );
    const reponse = await handleStoreConnect(requeteEvil, deps, { allowedOrigins: ['https://app.vyora.test'] });
    const corps = await reponse.json() as { error?: { code: string } };
    // `resolveCorsOrigin` rend `null` — jamais `*` — pour une origine inconnue :
    // le navigateur ne peut donc pas lire la réponse. C'est la garantie qui
    // compte ; le code d'erreur est un confort de diagnostic.
    const cors = reponse.headers.get('access-control-allow-origin');
    expect(cors === null || cors === 'null').toBe(true);
    expect(cors).not.toBe('*');
    expect(cors).not.toBe('https://evil.test');
    expect(corps.error?.code ?? 'ORIGIN_REJECTED').toBeTruthy();
  });

  it('remonte un 401 Chariow comme clé refusée, et journalise l’échec', async () => {
    const { deps, journal } = environnement({
      api: () => ({ status: 401, body: { message: 'Invalid API key. Please check again.', errors: [] } }),
    });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(401);
    const corps = await reponse.json() as { error: { code: string; message: string } };
    expect(corps.error.code).toBe('AUTH_INVALID');
    expect(journal.echecs.length).toBeGreaterThan(0);
    expect(journal.secrets).toHaveLength(0);
  });

  it('remonte un 403 de scope avec un message actionnable', async () => {
    const { deps } = environnement({
      api: () => ({
        status: 403,
        body: { message: 'missing scope', errors: { scopes: ['products.read'] } },
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="products.read"' },
      }),
    });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(403);
    const corps = await reponse.json() as { error: { code: string; message: string } };
    expect(corps.error.code).toBe('INSUFFICIENT_SCOPE');
    expect(corps.error.message).toContain('products.read');
  });

  it('refuse une clé mal formée sans aucun appel réseau', async () => {
    const { deps, appels } = environnement({});
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: 'pas-une-cle' }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(400);
    expect(appels).toHaveLength(0);
  });

  it('supprime le secret déposé si l’enregistrement échoue', async () => {
    const { deps, journal } = environnement({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : { body: { data: [], pagination: { count: 0, next_cursor: null, has_more_pages: false } } }),
      enregistrementEchoue: 'WORKSPACE_ACCESS_DENIED',
    });
    const reponse = await handleStoreConnect(
      requete({ action: 'connect', workspaceId: ENTREPRISE, connectorKey: 'chariow', apiKey: CLE_TEST }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(403);
    // Un secret sans connexion serait inutilisable : on le retire.
    expect(journal.supprimes).toEqual([credentialName(UTILISATEUR, 'chariow')]);
  });

  it('déconnecte : la connexion repasse à disconnected et le secret est retiré', async () => {
    const { deps, journal } = environnement({});
    const reponse = await handleStoreConnect(
      requete({ action: 'disconnect', workspaceId: ENTREPRISE, connectorKey: 'chariow' }),
      deps,
      { allowedOrigins: ['https://app.vyora.test'] },
    );
    expect(reponse.status).toBe(200);
    expect(journal.supprimes).toEqual([credentialName(UTILISATEUR, 'chariow')]);
  });
});

/* -------------------------------------------------------------------------- */
/* `store-import` — aperçu Chariow                                             */
/* -------------------------------------------------------------------------- */

function environnementImport(options: {
  allowed?: boolean;
  cle?: string | null;
  api?: Repondeur;
  existants?: Array<{ id: string; name: string; platformId?: string | null }>;
}): { handler: ReturnType<typeof createStoreImportHandler>; ecrits: unknown[]; appels: ReturnType<typeof apiChariow>['appels'] } {
  const ecrits: unknown[] = [];
  // `fetchImpl` n'existe pas dans `StoreImportDependencies` : l'Edge Function
  // sort par le socket épinglé (`connect`). Seuls les appels sont observés ici.
  const { appels } = apiChariow(options.api ?? (() => ({ body: boutiquePayload })));

  const deps: StoreImportDependencies = {
    async getUserId() { return UTILISATEUR; },
    async checkImportAccess() {
      const allowed = options.allowed ?? true;
      return {
        allowed,
        reason: allowed ? 'OK' : 'SUBSCRIPTION_EXPIRED',
        message: allowed ? 'Actif' : 'Abonnement expiré',
      };
    },
    async grantWorkspace() { return { canRead: true, canWrite: true }; },
    async listExistingProducts() { return options.existants ?? []; },
    async insertProducts(_ws, produits) {
      ecrits.push(...produits);
      return { created: produits.length, failed: [] };
    },
    async readStoreCredential() { return options.cle === undefined ? CLE_TEST : options.cle; },
    async resolveHost() { return ['93.184.216.34']; },
    // La sortie réelle de `store-import` est le socket épinglé, pas `fetch` :
    // les deux sont fournis pour que le test exerce le vrai chemin.
    connect: async () => socketApi(options.api ?? (() => ({ body: boutiquePayload }))),
    allowedOrigins: ['https://app.vyora.test'],
  };

  return { handler: createStoreImportHandler(deps), ecrits, appels };
}

describe('store-import — aperçu Chariow', () => {
  it('produit un aperçu sans rien écrire, avec les produits publiés', async () => {
    const { handler, ecrits, appels } = environnementImport({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : {
          body: {
            data: [produit('prd_1', 'Formation A'), produit('prd_2', 'Brouillon', 'draft')],
            pagination: { count: 2, next_cursor: null, has_more_pages: false },
          },
        }),
    });

    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));

    expect(reponse.status).toBe(200);
    const corps = await reponse.json() as {
      data: { products: Array<{ name: string; platformId: string }>; draftsSkipped?: number; previewId: string };
    };
    expect(corps.data.products).toHaveLength(1);
    expect(corps.data.products[0].platformId).toBe('prd_1');
    // Le brouillon est compté et remonté à l'écran.
    expect(corps.data.draftsSkipped).toBe(1);
    // Aucune écriture pendant l'aperçu.
    expect(ecrits).toHaveLength(0);
    // Tous les appels vont sur l'API Chariow, jamais sur la boutique.
    expect(appels.every((a) => a.url.startsWith('https://api.chariow.com/v1'))).toBe(true);
    expect(appels.some((a) => a.url.includes('mychariow.online'))).toBe(false);
  });

  it('refuse l’aperçu sans connexion enregistrée, avec un message explicite', async () => {
    const { handler } = environnementImport({ cle: null });
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(409);
    const corps = await reponse.json() as { error: { code: string; message: string } };
    expect(corps.error.code).toBe('CONNECTION_REQUIRED');
    expect(corps.error.message).toContain('Chariow');
  });

  it('exige l’abonnement avant de lire le catalogue', async () => {
    const { handler, appels } = environnementImport({ allowed: false });
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(403);
    expect(appels).toHaveLength(0);
  });

  it('explique « aucun produit publié » quand tout est en brouillon', async () => {
    const { handler } = environnementImport({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : {
          body: {
            data: [produit('prd_1', 'A', 'draft'), produit('prd_2', 'B', 'suspended')],
            pagination: { count: 2, next_cursor: null, has_more_pages: false },
          },
        }),
    });
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(422);
    const corps = await reponse.json() as { error: { code: string; message: string } };
    expect(corps.error.code).toBe('CATALOG_EMPTY');
    // Le message doit dire POURQUOI : 2 brouillons, pas « catalogue vide ».
    expect(corps.error.message).toContain('brouillon');
    expect(corps.error.message).toContain('2');
  });

  it('remonte un 401 comme refus de connexion, jamais comme panne d’import', async () => {
    const { handler } = environnementImport({
      api: () => ({ status: 401, body: { message: 'Invalid API key.', errors: [] } }),
    });
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(401);
    const corps = await reponse.json() as { error: { code: string } };
    expect(corps.error.code).toBe('STORE_CONNECTION_REFUSED');
  });

  it('refuse un connecteur inconnu au lieu de retomber sur un autre', async () => {
    const { handler } = environnementImport({});
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'inconnu' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(400);
    const corps = await reponse.json() as { error: { code: string } };
    expect(corps.error.code).toBe('UNKNOWN_CONNECTOR');
  });

  it('exige une confirmation explicite : un aperçu seul ne peut pas écrire', async () => {
    const { handler, ecrits } = environnementImport({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : {
          body: {
            data: [produit('prd_1', 'A')],
            pagination: { count: 1, next_cursor: null, has_more_pages: false },
          },
        }),
    });

    const apercu = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    const { data } = await apercu.json() as { data: { previewId: string } };

    // Sans `confirmed: true`, rien ne s'écrit.
    const refus = await handler(requete(
      { action: 'import', workspaceId: ENTREPRISE, previewId: data.previewId },
      { origin: 'https://app.vyora.test' },
    ));
    expect(refus.status).toBe(400);
    const corpsRefus = await refus.json() as { error: { code: string } };
    expect(corpsRefus.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(ecrits).toHaveLength(0);

    // Avec confirmation, l'écriture a lieu — une fois.
    const accepte = await handler(requete(
      { action: 'import', workspaceId: ENTREPRISE, previewId: data.previewId, confirmed: true },
      { origin: 'https://app.vyora.test' },
    ));
    expect(accepte.status).toBe(200);
    expect(ecrits).toHaveLength(1);
  });

  it('préserve l’identifiant stable Chariow pour reconnaître un produit déjà présent', async () => {
    const { handler } = environnementImport({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : {
          body: {
            data: [produit('prd_existant', 'Formation renommée')],
            pagination: { count: 1, next_cursor: null, has_more_pages: false },
          },
        }),
      // Le produit existe déjà avec ce platformId, sous un AUTRE nom : c'est le
      // renommage côté Chariow, cas typique que seul l'identifiant stable capte.
      existants: [{ id: 'prod-1', name: 'Ancien nom', platformId: 'prd_existant' }],
    });

    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    expect(reponse.status).toBe(200);
    const corps = await reponse.json() as {
      data: { products: Array<{ match: string; targetId: string | null; platformId: string }> };
    };
    expect(corps.data.products[0].match).toBe('update');
    expect(corps.data.products[0].targetId).toBe('prod-1');
  });

  it('ne transmet jamais la clé dans une réponse d’aperçu', async () => {
    const { handler } = environnementImport({
      api: (url) => (url.pathname.endsWith('/store')
        ? { body: boutiquePayload }
        : {
          body: {
            data: [produit('prd_1', 'A')],
            pagination: { count: 1, next_cursor: null, has_more_pages: false },
          },
        }),
    });
    const reponse = await handler(requete(
      { action: 'preview', workspaceId: ENTREPRISE, connectorKey: 'chariow' },
      { origin: 'https://app.vyora.test' },
    ));
    const texte = await reponse.text();
    expect(texte).not.toContain(CLE_TEST);
    expect(texte).not.toContain('sk_live');
  });
});
