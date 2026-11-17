/**
 * Edge Function `store-connect` — parcours de connexion PrestaShop.
 *
 * Ces tests exercent le handler réel, avec un environnement simulé : pas de
 * réseau, pas de base. Ce qu'ils protègent, dans l'ordre du parcours :
 *
 *   - **aucun secret ne sort** : la clé ne figure ni dans la réponse, ni dans
 *     les journaux, ni dans un enregistrement transmis ;
 *   - **l'abonnement est exigé** avant même d'interroger la boutique ;
 *   - **l'entreprise est vérifiée en base**, pas d'après l'identifiant reçu ;
 *   - **le SSRF est bloqué** : adresse privée, schéma non HTTPS, port exotique ;
 *   - **un échec est journalisé** et ne laisse pas une connexion valide en place.
 */
import { describe, expect, it } from 'vitest';
import {
  handleStoreConnect,
  normalizeApiKey,
  credentialName,
  type ConnectDependencies,
} from '../supabase/functions/store-connect/handler';

/* -------------------------------------------------------------------------- */
/* Environnement simulé                                                       */
/* -------------------------------------------------------------------------- */

interface Journal {
  secrets: Array<{ userId: string; connectorKey: string; secret: string }>;
  supprimes: string[];
  connexions: Array<Record<string, unknown>>;
  echecs: Array<Record<string, unknown>>;
  logs: Array<{ message: string; detail?: Record<string, unknown> }>;
}

const UTILISATEUR = '22222222-2222-4222-8222-222222222222';
const ENTREPRISE = '11111111-1111-4111-8111-111111111111';
const CLE = 'CLEFAPI1234567890ABCDEF123456';

function environnement(options: {
  userId?: string | null;
  allowed?: boolean;
  reason?: string;
  canWrite?: boolean;
  canRead?: boolean;
  /** Réponses de l'API PrestaShop, par suffixe de chemin. */
  api?: (url: URL) => { status?: number; body: unknown };
  dns?: string[];
  dnsLance?: boolean;
  vaultEchoue?: boolean;
  enregistrementEchoue?: string | null;
  etat?: unknown;
}): { deps: ConnectDependencies; journal: Journal } {
  const journal: Journal = { secrets: [], supprimes: [], connexions: [], echecs: [], logs: [] };

  const deps: ConnectDependencies = {
    async getUserId() {
      return options.userId === undefined ? UTILISATEUR : options.userId;
    },
    async checkImportAccess() {
      return {
        allowed: options.allowed ?? true,
        reason: options.reason ?? 'OK',
        message: (options.allowed ?? true) ? 'Actif' : 'Abonnement requis',
      };
    },
    async grantWorkspace() {
      return {
        canRead: options.canRead ?? true,
        canWrite: options.canWrite ?? true,
      };
    },
    async storeCredential(input) {
      if (options.vaultEchoue) throw new Error('Vault indisponible');
      journal.secrets.push(input);
      return credentialName(input.userId, input.connectorKey);
    },
    async readCredential() {
      return CLE;
    },
    async deleteCredential(name) {
      journal.supprimes.push(name);
    },
    async recordConnection(input) {
      if (options.enregistrementEchoue) throw new Error(options.enregistrementEchoue);
      journal.connexions.push(input);
      return { connectionId: 'connexion-1', status: 'connected' };
    },
    async recordFailure(input) {
      journal.echecs.push(input);
      return { connectionId: 'connexion-1', status: 'error' };
    },
    async readConnection() {
      return options.etat ?? null;
    },
    async resolveHost() {
      if (options.dnsLance) throw new Error('DNS mort');
      return options.dns ?? ['203.0.113.10'];
    },
    async fetchImpl(input) {
      const url = new URL(input);
      const api = options.api;
      if (api) {
        const reponse = api(url);
        // Un corps déjà textuel est renvoyé tel quel : c'est ainsi que le vrai
        // serveur renvoie une page HTML, et c'est ce que le connecteur doit
        // savoir reconnaître.
        const corps = typeof reponse.body === 'string' ? reponse.body : JSON.stringify(reponse.body);
        return new Response(corps, {
          status: reponse.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Catalogue minimal par défaut : la vérification doit réussir.
      if (url.pathname.endsWith('/shops')) {
        return new Response(JSON.stringify({ prestashop: { shops: [{ id: '1', name: 'Boutique', version: '8.1' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/languages')) {
        return new Response(JSON.stringify({ prestashop: { languages: [{ id: '1', iso_code: 'fr' }] } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ prestashop: { products: [{ id: '1', name: 'Produit' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-range': '0-0/12' },
      });
    },
    log: (message, detail) => { journal.logs.push({ message, detail }); },
  };

  return { deps, journal };
}

function requete(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('https://exemple.invalid/functions/v1/store-connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer jeton', ...headers },
    body: JSON.stringify(body),
  });
}

/** Corps complet d'une connexion. */
function connexion(surcharge: Record<string, unknown> = {}) {
  return {
    action: 'connect',
    workspaceId: ENTREPRISE,
    connectorKey: 'prestashop',
    url: 'https://boutique.example',
    apiKey: CLE,
    ...surcharge,
  };
}

/** Vérifie qu'aucun secret ne fuit dans une réponse. */
function sansFuite(texte: string, secret = CLE) {
  expect(texte).not.toContain(secret);
  expect(texte).not.toContain('ws_key');
}

/* -------------------------------------------------------------------------- */
/* Connexion réussie                                                          */
/* -------------------------------------------------------------------------- */

describe('store-connect — connexion réussie', () => {
  it('vérifie, dépose le secret et enregistre la connexion', async () => {
    const { deps, journal } = environnement({});
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    const texte = await reponse.text();
    expect(reponse.status).toBe(200);
    sansFuite(texte);
    const corps = JSON.parse(texte) as { data: Record<string, unknown> };
    expect(corps.data).toMatchObject({
      connectorKey: 'prestashop',
      status: 'connected',
      connected: true,
      shopName: 'Boutique',
      version: '8.1',
      totalProducts: 12,
    });
    // La preuve de vérification : trois ressources réellement lues.
    expect(corps.data.resourcesRead).toEqual(['shops', 'languages', 'products']);

    // Le secret est déposé une fois, avec la clé exacte.
    expect(journal.secrets).toHaveLength(1);
    expect(journal.secrets[0]).toMatchObject({ userId: UTILISATEUR, connectorKey: 'prestashop', secret: CLE });

    // La connexion enregistre le NOM du secret, jamais sa valeur.
    expect(journal.connexions).toHaveLength(1);
    const enregistrement = journal.connexions[0];
    expect(enregistrement.credentialRef).toBe(`vyora_prestashop_${UTILISATEUR}`);
    expect(JSON.stringify(enregistrement)).not.toContain(CLE);
    // La référence externe est le domaine, pas la clé.
    expect(enregistrement.externalAccountRef).toBe('https://boutique.example/');
  });

  it('ne renvoie jamais le nom du secret Vault', async () => {
    // Le navigateur n'a aucun usage du nom d'un secret : le lui donner
    // élargirait inutilement la surface d'attaque.
    const { deps } = environnement({});
    const texte = await (await handleStoreConnect(requete(connexion()), deps)).text();
    expect(texte).not.toContain('vyora_prestashop');
    expect(texte).not.toContain('credential');
  });

  it('ne journalise jamais la clé', async () => {
    const { deps, journal } = environnement({});
    await handleStoreConnect(requete(connexion()), deps);
    const tout = JSON.stringify(journal.logs);
    expect(tout).not.toContain(CLE);
  });

  it('accepte une URL avec sous-dossier sans perdre le chemin', async () => {
    const { deps } = environnement({});
    const reponse = await handleStoreConnect(
      requete(connexion({ url: 'https://boutique.example/prestashop' })),
      deps,
    );
    const corps = await reponse.json() as { data: { endpoint: string } };
    expect(corps.data.endpoint).toBe('https://boutique.example/prestashop');
  });
});

/* -------------------------------------------------------------------------- */
/* Authentification et abonnement                                             */
/* -------------------------------------------------------------------------- */

describe('store-connect — gardes d’accès', () => {
  it('refuse sans session', async () => {
    const { deps } = environnement({ userId: null });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(401);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('refuse sans abonnement, SANS contacter la boutique', async () => {
    // Un compte expiré ne doit pas faire sortir de requête vers une boutique.
    let appels = 0;
    const { deps } = environnement({
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
      api: () => { appels += 1; return { body: {} }; },
    });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(402);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('NO_SUBSCRIPTION');
    expect(appels).toBe(0);
  });

  it('refuse un abonnement expiré en 403', async () => {
    const { deps } = environnement({ allowed: false, reason: 'SUBSCRIPTION_EXPIRED' });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(403);
  });

  it('refuse une entreprise dont l’utilisateur n’est pas membre', async () => {
    const { deps, journal } = environnement({ canRead: false, canWrite: false });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(403);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('WORKSPACE_ACCESS_DENIED');
    // Rien n'a été déposé ni enregistré.
    expect(journal.secrets).toHaveLength(0);
    expect(journal.connexions).toHaveLength(0);
  });

  it('refuse une connexion en lecture seule', async () => {
    const { deps } = environnement({ canRead: true, canWrite: false });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(403);
  });

  it('refuse un identifiant d’entreprise qui n’est pas un UUID', async () => {
    const { deps } = environnement({});
    const reponse = await handleStoreConnect(requete(connexion({ workspaceId: 'autre-entreprise' })), deps);
    expect(reponse.status).toBe(400);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('INVALID_WORKSPACE');
  });

  it('refuse un connecteur inconnu', async () => {
    const { deps } = environnement({});
    const reponse = await handleStoreConnect(requete(connexion({ connectorKey: 'magento' })), deps);
    expect(reponse.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* SSRF                                                                       */
/* -------------------------------------------------------------------------- */

describe('store-connect — refus SSRF', () => {
  it('refuse une adresse privée résolue', async () => {
    // Le domaine résout vers 10.0.0.5 : une seule adresse privée suffit.
    const { deps, journal } = environnement({ dns: ['203.0.113.10', '10.0.0.5'] });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(400);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('URL_REFUSED');
    expect(journal.secrets).toHaveLength(0);
  });

  it('refuse 169.254.169.254 (métadonnées cloud)', async () => {
    const { deps } = environnement({ dns: ['169.254.169.254'] });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(400);
  });

  it('refuse une URL en http clair', async () => {
    const { deps } = environnement({});
    const reponse = await handleStoreConnect(requete(connexion({ url: 'http://boutique.example' })), deps);
    expect(reponse.status).toBe(400);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('URL_REFUSED');
  });

  it('refuse localhost et une adresse littérale', async () => {
    for (const url of ['https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://boutique.internal']) {
      const { deps } = environnement({});
      const reponse = await handleStoreConnect(requete(connexion({ url })), deps);
      expect(reponse.status, `URL acceptée à tort : ${url}`).toBe(400);
    }
  });

  it('refuse un port non standard', async () => {
    const { deps } = environnement({});
    const reponse = await handleStoreConnect(requete(connexion({ url: 'https://boutique.example:8443' })), deps);
    expect(reponse.status).toBe(400);
  });

  it('refuse une résolution DNS en échec', async () => {
    const { deps } = environnement({ dnsLance: true });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(502);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('DNS_FAILED');
  });
});

/* -------------------------------------------------------------------------- */
/* Échecs d'authentification côté boutique                                    */
/* -------------------------------------------------------------------------- */

describe('store-connect — clé refusée par la boutique', () => {
  it('traduit un 401 en clé invalide et journalise l’échec', async () => {
    const { deps, journal } = environnement({
      api: () => ({ status: 401, body: { errors: [] } }),
    });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    const texte = await reponse.text();

    expect(reponse.status).toBe(401);
    sansFuite(texte);
    expect((JSON.parse(texte) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
    // Aucun secret déposé : une clé refusée ne doit pas entrer dans Vault.
    expect(journal.secrets).toHaveLength(0);
    // L'échec est tracé, pour distinguer « jamais essayé » de « refusé ».
    expect(journal.echecs).toHaveLength(1);
    expect(journal.echecs[0]).toMatchObject({ errorCode: 'AUTH_INVALID', connectorKey: 'prestashop' });
    expect(JSON.stringify(journal.echecs)).not.toContain(CLE);
  });

  it('refuse une clé mal formée avant toute requête', async () => {
    const { deps, journal } = environnement({});
    for (const apiKey of ['', 'court', 'cle avec espace 1234567890']) {
      const reponse = await handleStoreConnect(requete(connexion({ apiKey })), deps);
      expect(reponse.status, `clé acceptée à tort : « ${apiKey} »`).toBe(400);
    }
    expect(journal.secrets).toHaveLength(0);
  });

  it('refuse une page HTML (API absente)', async () => {
    const { deps } = environnement({
      api: () => ({ body: '<!DOCTYPE html><html><body>404</body></html>' }),
    });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(400);
  });

  it('signale une limite de débit', async () => {
    const { deps } = environnement({ api: () => ({ status: 429, body: {} }) });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(429);
  });
});

/* -------------------------------------------------------------------------- */
/* Pannes d'infrastructure                                                    */
/* -------------------------------------------------------------------------- */

describe('store-connect — pannes', () => {
  it('n’enregistre rien si le secret ne peut pas être déposé', async () => {
    const { deps, journal } = environnement({ vaultEchoue: true });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(503);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('SECRET_STORE_UNAVAILABLE');
    expect(journal.connexions).toHaveLength(0);
  });

  it('retire le secret orphelin si l’enregistrement échoue', async () => {
    // Sans ce nettoyage, une clé resterait dans Vault sans connexion associée.
    const { deps, journal } = environnement({ enregistrementEchoue: 'panne base' });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(500);
    expect(journal.secrets).toHaveLength(1);
    expect(journal.supprimes).toEqual([`vyora_prestashop_${UTILISATEUR}`]);
  });

  it('traduit un refus d’abonnement renvoyé par la base', async () => {
    const { deps } = environnement({ enregistrementEchoue: 'connect_forbidden:SUBSCRIPTION_REQUIRED:PLAN_INACTIVE' });
    const reponse = await handleStoreConnect(requete(connexion()), deps);
    expect(reponse.status).toBe(403);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('SUBSCRIPTION_REQUIRED');
  });
});

/* -------------------------------------------------------------------------- */
/* État et déconnexion                                                        */
/* -------------------------------------------------------------------------- */

describe('store-connect — état et déconnexion', () => {
  it('lit l’état sans écrire', async () => {
    const etat = { status: 'connected', connected: true, external_account_ref: 'https://boutique.example/' };
    const { deps, journal } = environnement({ etat });
    const reponse = await handleStoreConnect(
      requete({ action: 'status', workspaceId: ENTREPRISE, connectorKey: 'prestashop' }),
      deps,
    );
    expect(reponse.status).toBe(200);
    expect((await reponse.json() as { data: unknown }).data).toEqual(etat);
    expect(journal.secrets).toHaveLength(0);
  });

  it('retire le secret Vault à la déconnexion', async () => {
    const { deps, journal } = environnement({});
    const reponse = await handleStoreConnect(
      requete({ action: 'disconnect', workspaceId: ENTREPRISE, connectorKey: 'prestashop' }),
      deps,
    );
    expect(reponse.status).toBe(200);
    expect(journal.supprimes).toEqual([`vyora_prestashop_${UTILISATEUR}`]);
  });

  it('refuse la déconnexion en lecture seule', async () => {
    const { deps } = environnement({ canRead: true, canWrite: false });
    const reponse = await handleStoreConnect(
      requete({ action: 'disconnect', workspaceId: ENTREPRISE }),
      deps,
    );
    expect(reponse.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* Aperçu                                                                     */
/* -------------------------------------------------------------------------- */

describe('store-connect — aperçu par API', () => {
  it('lit le catalogue avec la clé Vault, sans la redemander', async () => {
    const { deps } = environnement({
      api: (url) => {
        const secondePage = Number((url.searchParams.get('limit') ?? '0,100').split(',')[0]) > 0;
        if (url.pathname.endsWith('/products')) {
          return {
            body: {
              prestashop: {
                products: secondePage
                  ? []
                  : [{ id: '10', name: 'Chemise', reference: 'CHE-1', price: '24.900000' }],
              },
            },
          };
        }
        return { body: { prestashop: { [url.pathname.split('/').pop() ?? 'x']: [] } } };
      },
    });
    const reponse = await handleStoreConnect(
      requete({ action: 'preview', workspaceId: ENTREPRISE, url: 'https://boutique.example' }),
      deps,
    );
    const texte = await reponse.text();
    expect(reponse.status).toBe(200);
    sansFuite(texte);
    const corps = JSON.parse(texte) as { data: { count: number; platform: string; products: Array<{ name: string }> } };
    expect(corps.data.platform).toBe('prestashop');
    expect(corps.data.count).toBe(1);
    expect(corps.data.products[0].name).toBe('Chemise');
  });

  it('refuse l’aperçu sans connexion enregistrée', async () => {
    const { deps } = environnement({});
    const sansCle: ConnectDependencies = { ...deps, readCredential: async () => null };
    const reponse = await handleStoreConnect(
      requete({ action: 'preview', workspaceId: ENTREPRISE, url: 'https://boutique.example' }),
      sansCle,
    );
    expect(reponse.status).toBe(409);
    expect((await reponse.json() as { error: { code: string } }).error.code).toBe('CONNECTION_REQUIRED');
  });
});

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

describe('store-connect — utilitaires', () => {
  it('refuse une clé contenant un espace ou un caractère de contrôle', () => {
    // Un espace dans l'en-tête `Authorization` casserait la requête de façon
    // opaque : on refuse en amont.
    expect(normalizeApiKey('abcdefgh')).toBe('abcdefgh');
    expect(normalizeApiKey('abc defgh')).toBeNull();
    expect(normalizeApiKey('abcdefg\nh')).toBeNull();
    expect(normalizeApiKey('abc')).toBeNull();
  });

  it('dérive un nom de secret stable et sans caractère dangereux', () => {
    const nom = credentialName(UTILISATEUR, 'prestashop');
    expect(nom).toBe(`vyora_prestashop_${UTILISATEUR}`);
    // Le nom contient l'UUID (tirets compris) mais rien d'exploitable comme
    // secret : c'est une clé de recherche, pas un mot de passe.
    expect(nom).toMatch(/^[a-z0-9_-]+$/);
    expect(nom).not.toContain(CLE);
  });
});
