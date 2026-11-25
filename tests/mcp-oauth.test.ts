import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import {
  dateExpiration,
  decouvrir,
  defiDepuisVerificateur,
  echangerCode,
  enregistrerClient,
  fautRafraichir,
  genererEtat,
  genererVerificateur,
  rafraichirJetons,
  urlAutorisation,
  urlsMetadonneesAutorisation,
  urlsMetadonneesRessource,
} from '../supabase/functions/mcp-client/oauth';
import {
  echapperHtml,
  resoudreUrlCallback,
  traiterCallbackOAuth,
  traiterDemarrageOAuth,
  traiterRevocationOAuth,
  urlCallback,
} from '../supabase/functions/mcp-client/oauth-http';
import { validerCreation } from '../supabase/functions/mcp-client/gestion';
import { executerOutilExterne, type AccesBase, type ConnexionServeur, type DependancesP5 } from '../supabase/functions/mcp-client/execution';
import type { AccesGestion, DependancesGestion, ServeurGere } from '../supabase/functions/mcp-client/gestion-serveur';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * P6c — OAuth 2.1 sortant.
 *
 * ## Ce qui est réellement exercé
 *
 * Un **vrai serveur HTTP local** sert les métadonnées (RFC 9728 et 8414), le
 * point d'enregistrement et le point de jeton. Les requêtes sont donc de vraies
 * requêtes : méthode, chemin, en-têtes, corps de formulaire, codes de statut,
 * parsing des réponses.
 *
 * ## Ce qui est simulé, et pourquoi c'est dit
 *
 * - **TLS non exercé** : la sortie épinglée établit un TLS vers `*.example`
 *   impossible à satisfaire en local ; on injecte donc `connect`, ce que le
 *   module d'égression prévoit explicitement. La validation d'URL (`https://`
 *   obligatoire) et le refus des redirections restent, eux, du code réel.
 * - **Aucun fournisseur OAuth public** n'est contacté : ces tests prouvent le
 *   protocole, pas la compatibilité avec un fournisseur précis. C'est le banc
 *   `tests/banc-auth/index.ts` qui sert à l'essai réel.
 * - **Base et Vault simulés** : l'accès base est un espion, donc les écritures
 *   Vault sont vérifiées par leurs appels, pas par une lecture Vault.
 */

const USER_A = '11111111-1111-1111-1111-111111111111';
const SERVER_ID = '33333333-3333-3333-3333-333333333333';
const WS_ID = '44444444-4444-4444-4444-444444444444';

let serveur: Server;
let port = 0;

/** Journal des requêtes OAuth réellement reçues par le banc. */
const recu: { methode: string; chemin: string; corps: string; entetes: IncomingMessage['headers'] }[] = [];

/** Réglages du banc : chaque test ajuste ce qu'il veut obtenir. */
const banc = {
  /** Métadonnées du serveur d'autorisation renvoyées (null = 404). */
  metadonneesAs: null as Record<string, unknown> | null,
  /** Métadonnées de ressource protégée. */
  metadonneesRessource: null as Record<string, unknown> | null,
  /** Réponse du point de jeton. */
  reponseJeton: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' } as Record<string, unknown>,
  statutJeton: 200,
  /** Réponse de l'enregistrement dynamique. */
  reponseEnregistrement: { client_id: 'client-banc' } as Record<string, unknown>,
  /** Statut du point de révocation (RFC 7009 : 200 vide = succès). */
  statutRevocation: 200,
};

function lireCorps(requete: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let corps = '';
    requete.on('data', (t) => { corps += t; });
    requete.on('end', () => resolve(corps));
  });
}

function repondre(reponse: ServerResponse, charge: unknown, statut = 200) {
  const corps = JSON.stringify(charge);
  reponse.writeHead(statut, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(corps)) });
  reponse.end(corps);
}

/*
 * Hôte SANS port : la sortie épinglée refuse un port non standard, et c'est
 * une protection qu'on ne veut pas contourner dans un test. La connexion est
 * réelle mais le socket est redirigé vers le banc local par `connect`.
 */
const BASE = () => 'https://banc-oauth.example';

/**
 * Premier argument du premier appel d'un espion.
 *
 * `vi.fn(async () => undefined)` déclare une liste d'arguments vide, donc
 * `mock.calls[0][0]` ne compile pas. Le transtypage est confiné ici, et le
 * type attendu est fourni par l'appelant : aucune perte de vérification.
 */
function premierArgument<T>(espion: { mock: { calls: unknown[] } }): T | undefined {
  return (espion.mock.calls as unknown as [T][])[0]?.[0];
}

beforeAll(async () => {
  serveur = createServer(async (requete, reponse) => {
    const corps = await lireCorps(requete);
    const chemin = (requete.url ?? '').split('?')[0] ?? '';
    recu.push({ methode: requete.method ?? '', chemin, corps, entetes: requete.headers });

    if (chemin === '/.well-known/oauth-protected-resource/mcp' || chemin === '/.well-known/oauth-protected-resource') {
      if (!banc.metadonneesRessource) { repondre(reponse, { error: 'not_found' }, 404); return; }
      repondre(reponse, banc.metadonneesRessource);
      return;
    }
    if (chemin === '/.well-known/oauth-authorization-server') {
      if (!banc.metadonneesAs) { repondre(reponse, { error: 'not_found' }, 404); return; }
      repondre(reponse, banc.metadonneesAs);
      return;
    }
    if (chemin === '/register') { repondre(reponse, banc.reponseEnregistrement); return; }
    if (chemin === '/token') { repondre(reponse, banc.reponseJeton, banc.statutJeton); return; }
    if (chemin === '/revoke') { repondre(reponse, {}, banc.statutRevocation); return; }
    if (chemin === '/mcp') {
      // Serveur MCP minimal : suffisant pour prouver quel jeton a été envoyé.
      const message = JSON.parse(corps || '{}') as { id?: number; method?: string };
      if (message.method === 'initialize') {
        repondre(reponse, {
          jsonrpc: '2.0', id: message.id ?? null,
          result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'banc-oauth', version: '1' } },
        });
        return;
      }
      if (message.method === 'tools/list') {
        repondre(reponse, {
          jsonrpc: '2.0', id: message.id ?? null,
          result: { tools: [{ name: 'list_products', description: 'Liste les produits.' }] },
        });
        return;
      }
      if (message.method === 'tools/call') {
        repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, result: { content: [{ type: 'text', text: 'ok' }] } });
        return;
      }
      repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'inconnu' } });
      return;
    }
    repondre(reponse, { error: 'not_found' }, 404);
  });
  await new Promise<void>((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      const a = serveur.address();
      if (a && typeof a === 'object') port = a.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
});

beforeEach(() => {
  recu.length = 0;
  banc.metadonneesAs = {
    issuer: BASE(),
    authorization_endpoint: `${BASE()}/authorize`,
    token_endpoint: `${BASE()}/token`,
    registration_endpoint: `${BASE()}/register`,
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:read'],
  };
  banc.metadonneesRessource = {
    resource: `${BASE()}/mcp`,
    authorization_servers: [BASE()],
  };
  banc.reponseJeton = { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' };
  banc.statutJeton = 200;
  banc.reponseEnregistrement = { client_id: 'client-banc' };
  banc.statutRevocation = 200;
});

function pinnedSocket(socket: Socket) {
  let tampon = Buffer.alloc(0);
  let fini = false;
  let reveil: (() => void) | null = null;
  const signaler = () => { if (reveil) { const r = reveil; reveil = null; r(); } };
  socket.on('data', (t: Buffer) => { tampon = Buffer.concat([tampon, t]); signaler(); });
  socket.on('end', () => { fini = true; signaler(); });
  socket.on('error', () => { fini = true; signaler(); });
  socket.pause();
  return {
    async write(octets: Uint8Array) {
      await new Promise<void>((res, rej) => socket.write(octets, (e) => (e ? rej(e) : res())));
      return octets.byteLength;
    },
    async read(destination: Uint8Array) {
      while (tampon.length === 0) {
        if (fini) return null;
        socket.resume();
        await new Promise<void>((res) => { reveil = res; setTimeout(() => { if (reveil === res) { reveil = null; res(); } }, 5000); });
        socket.pause();
      }
      const n = Math.min(destination.length, tampon.length);
      destination.set(tampon.subarray(0, n));
      tampon = tampon.subarray(n);
      return n;
    },
    async close() { socket.destroy(); },
  };
}

function egressVersBanc(): EgressDeps {
  return {
    resolveHost: async () => ['93.184.216.34'],
    connect: async () => pinnedSocket(await new Promise<Socket>((res, rej) => {
      const s = netConnect({ host: '127.0.0.1', port }, () => res(s));
      s.on('error', rej);
    })),
    timeoutMs: 5_000,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. PKCE, état, URL                                                          */
/* -------------------------------------------------------------------------- */

describe('OAuth — PKCE et URL d’autorisation', () => {
  it('reproduit le vecteur de la RFC 7636 (S256)', async () => {
    // Vecteur officiel de l'annexe B : si cette valeur change, le hachage est faux.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(defiDepuisVerificateur(verifier)).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('génère des verifiers conformes (43–128 caractères base64url, jamais réutilisés)', () => {
    const vus = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const v = genererVerificateur();
      expect(v).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(vus.has(v)).toBe(false);
      vus.add(v);
    }
  });

  it('génère des états imprévisibles', () => {
    const vus = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const s = genererEtat();
      expect(s).toMatch(/^[0-9a-f]{64}$/);
      vus.add(s);
    }
    expect(vus.size).toBe(50);
  });

  it('compose une URL d’autorisation en S256 avec état et ressource', () => {
    const r = urlAutorisation({
      metadonnees: { authorization_endpoint: 'https://as.example/authorize', token_endpoint: 'https://as.example/token' },
      clientId: 'client-1',
      redirectUri: 'https://fn.example/oauth/callback',
      state: 'etat-1',
      challenge: 'defi-1',
      scope: 'mcp:read',
      resource: 'https://mcp.example/mcp',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.valeur);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('defi-1');
    expect(url.searchParams.get('state')).toBe('etat-1');
    expect(url.searchParams.get('resource')).toBe('https://mcp.example/mcp');
    // `plain` n'apparaît nulle part : c'est la méthode refusée.
    expect(r.valeur).not.toContain('plain');
  });

  it('refuse un point d’autorisation non https', () => {
    const r = urlAutorisation({
      metadonnees: { authorization_endpoint: 'http://as.example/authorize', token_endpoint: 'https://as.example/token' },
      clientId: 'c', redirectUri: 'https://fn/cb', state: 's', challenge: 'x',
    });
    expect(r.ok).toBe(false);
  });

  it('construit les URL de métadonnées selon RFC 9728 / 8414', () => {
    const ressource = urlsMetadonneesRessource(new URL('https://mcp.example/mcp'));
    expect(ressource).toContain('https://mcp.example/.well-known/oauth-protected-resource/mcp');
    expect(ressource).toContain('https://mcp.example/.well-known/oauth-protected-resource');

    const as = urlsMetadonneesAutorisation(new URL('https://as.example'));
    expect(as).toContain('https://as.example/.well-known/oauth-authorization-server');
    expect(as).toContain('https://as.example/.well-known/openid-configuration');
  });
});

describe('OAuth — expiration', () => {
  it('ne renouvelle pas un jeton sans date connue', () => {
    expect(fautRafraichir(null)).toBe(false);
    expect(fautRafraichir('pas-une-date')).toBe(false);
  });

  it('renouvelle dans la marge de 60 s, pas avant', () => {
    const maintenant = Date.parse('2026-11-14T12:00:00Z');
    expect(fautRafraichir('2026-11-14T12:05:00Z', maintenant)).toBe(false);
    expect(fautRafraichir('2026-11-14T12:00:30Z', maintenant)).toBe(true);
    expect(fautRafraichir('2026-11-14T11:59:00Z', maintenant)).toBe(true);
  });

  it('convertit une durée en date absolue, refuse l’absurde', () => {
    const t = Date.parse('2026-11-14T12:00:00Z');
    expect(dateExpiration(60, t)).toBe('2026-11-14T12:01:00.000Z');
    expect(dateExpiration(0, t)).toBeNull();
    expect(dateExpiration(Number.NaN, t)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Découverte, enregistrement, échange — HTTP réel local                    */
/* -------------------------------------------------------------------------- */

describe('OAuth — découverte et échange (HTTP réel local)', () => {
  it('découvre le serveur d’autorisation via la métadonnée de ressource', async () => {
    const r = await decouvrir(new URL(`${BASE()}/mcp`), egressVersBanc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.serveurAutorisation).toBe(BASE());
    expect(r.metadonnees.token_endpoint).toBe(`${BASE()}/token`);
    expect(r.pkceS256).toBe(true);
    expect(recu.some((x) => x.chemin === '/.well-known/oauth-protected-resource/mcp')).toBe(true);
    expect(recu.some((x) => x.chemin === '/.well-known/oauth-authorization-server')).toBe(true);
  });

  it('distingue « non annoncé » de « refusé » pour PKCE', async () => {
    // Absence de `code_challenge_methods_supported` : la spec MCP exige PKCE,
    // beaucoup de serveurs l'omettent et l'appliquent. On poursuit, mais
    // l'information « non annoncé » remonte jusqu'à l'interface.
    banc.metadonneesAs = {
      authorization_endpoint: `${BASE()}/authorize`,
      token_endpoint: `${BASE()}/token`,
    };
    const sansAnnonce = await decouvrir(new URL(`${BASE()}/mcp`), egressVersBanc());
    expect(sansAnnonce.ok).toBe(true);
    if (!sansAnnonce.ok) return;
    expect(sansAnnonce.pkceS256).toBe(true);
    expect(sansAnnonce.metadonnees.code_challenge_methods_supported).toBeUndefined();

    // Une liste qui ne contient QUE `plain` est un refus explicite de S256.
    banc.metadonneesAs = {
      authorization_endpoint: `${BASE()}/authorize`,
      token_endpoint: `${BASE()}/token`,
      code_challenge_methods_supported: ['plain'],
    };
    const refuse = await decouvrir(new URL(`${BASE()}/mcp`), egressVersBanc());
    expect(refuse.ok).toBe(true);
    if (!refuse.ok) return;
    expect(refuse.pkceS256).toBe(false);
  });

  it('échoue proprement quand aucune métadonnée n’existe', async () => {
    banc.metadonneesAs = null;
    banc.metadonneesRessource = null;
    const r = await decouvrir(new URL(`${BASE()}/mcp`), egressVersBanc());
    expect(r.ok).toBe(false);
  });

  it('enregistre un client dynamiquement et récupère son identifiant', async () => {
    const decouverte = await decouvrir(new URL(`${BASE()}/mcp`), egressVersBanc());
    expect(decouverte.ok).toBe(true);
    if (!decouverte.ok) return;
    const r = await enregistrerClient(decouverte.metadonnees, 'https://fn.example/oauth/callback', egressVersBanc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valeur.clientId).toBe('client-banc');
    expect(r.valeur.enregistre).toBe(true);

    const envoi = recu.find((x) => x.chemin === '/register');
    const corps = JSON.parse(envoi?.corps ?? '{}') as { redirect_uris?: string[]; grant_types?: string[] };
    expect(corps.redirect_uris).toEqual(['https://fn.example/oauth/callback']);
    expect(corps.grant_types).toContain('refresh_token');
  });

  it('échange le code en envoyant le verifier PKCE et le redirect_uri', async () => {
    const r = await echangerCode({
      tokenEndpoint: `${BASE()}/token`,
      code: 'code-1',
      verifier: 'verifier-1',
      redirectUri: 'https://fn.example/oauth/callback',
      client: { clientId: 'client-banc', enregistre: true },
    }, egressVersBanc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valeur.access).toBe('at-1');
    expect(r.valeur.refresh).toBe('rt-1');
    expect(r.valeur.expireDans).toBe(3600);

    const envoi = recu.find((x) => x.chemin === '/token');
    const params = new URLSearchParams(envoi?.corps ?? '');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code_verifier')).toBe('verifier-1');
    expect(params.get('redirect_uri')).toBe('https://fn.example/oauth/callback');
    expect(params.get('client_id')).toBe('client-banc');
  });

  it('renouvelle avec grant_type=refresh_token', async () => {
    banc.reponseJeton = { access_token: 'at-2', expires_in: 3600 };
    const r = await rafraichirJetons({
      tokenEndpoint: `${BASE()}/token`,
      refresh: 'rt-1',
      client: { clientId: 'client-banc', enregistre: false },
    }, egressVersBanc());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valeur.access).toBe('at-2');
    // Pas de nouveau refresh_token : l'appelant DOIT conserver l'ancien.
    expect(r.valeur.refresh).toBeUndefined();

    const params = new URLSearchParams(recu.find((x) => x.chemin === '/token')?.corps ?? '');
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt-1');
  });

  it('remonte un refus du point de jeton sans inventer de jeton', async () => {
    banc.statutJeton = 400;
    banc.reponseJeton = { error: 'invalid_grant' };
    const r = await echangerCode({
      tokenEndpoint: `${BASE()}/token`, code: 'c', verifier: 'v',
      redirectUri: 'https://fn/cb', client: { clientId: 'x', enregistre: false },
    }, egressVersBanc());
    expect(r.ok).toBe(false);
  });

  it('refuse un point de jeton non https SANS aucun appel réseau', async () => {
    recu.length = 0;
    const r = await rafraichirJetons({
      tokenEndpoint: 'http://as.example/token', refresh: 'rt', client: { clientId: 'x', enregistre: false },
    }, egressVersBanc());
    expect(r.ok).toBe(false);
    expect(recu).toHaveLength(0);
  });

  it('refuse un point d’enregistrement non https SANS aucun appel réseau', async () => {
    recu.length = 0;
    const r = await enregistrerClient(
      { authorization_endpoint: 'https://a.example/authorize', token_endpoint: 'https://a.example/token', registration_endpoint: 'http://a.example/register' },
      'https://fn/cb',
      egressVersBanc(),
    );
    expect(r.ok).toBe(false);
    expect(recu).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Routes : démarrage et callback                                           */
/* -------------------------------------------------------------------------- */

function serveurGere(partiel: Partial<ServeurGere> = {}): ServeurGere {
  return {
    id: SERVER_ID, workspaceId: WS_ID, nom: 'Banc OAuth',
    url: `${BASE()}/mcp`, authKind: 'oauth', aSecret: true, status: 'connected',
    protocolVersion: '2025-06-18', serverName: 'banc', serverVersion: '1',
    outils: [{ name: 'list_products' }], toolPermissions: { list_products: 'allowed' },
    dernierTestAt: null, derniereErreur: null, createdAt: '2026-11-14T00:00:00Z', revokedAt: null,
    oauthClientId: null, authorizationServer: null, oauthExpireLe: null, oauthScope: null, oauthAs: null,
    ...partiel,
  };
}

function accesGestion(partiel: Partial<AccesGestion> = {}) {
  const appels = {
    fluxCreer: vi.fn(async () => undefined),
    client: vi.fn(async () => undefined),
    jetons: vi.fn(async () => undefined),
    detruire: vi.fn(async () => undefined),
  };
  const base: AccesGestion = {
    listerServeurs: async () => [serveurGere()],
    lireServeur: async () => serveurGere(),
    creerServeur: async () => ({ serverId: SERVER_ID }),
    enregistrerDecouverte: async () => undefined,
    definirPermission: async () => ({}),
    revoquer: async () => true,
    lireSecret: async () => null,
    creerFluxOAuth: appels.fluxCreer as unknown as AccesGestion['creerFluxOAuth'],
    consommerFluxOAuth: (async () => null) as AccesGestion['consommerFluxOAuth'],
    enregistrerClientOAuth: appels.client as unknown as AccesGestion['enregistrerClientOAuth'],
    lireOAuth: async () => null,
    stockerJetonsOAuth: appels.jetons as unknown as AccesGestion['stockerJetonsOAuth'],
    detruireOAuth: appels.detruire as unknown as AccesGestion['detruireOAuth'],
    ...partiel,
  };
  return { base, appels };
}

function depsGestion(base: AccesGestion): DependancesGestion {
  return { base, egress: egressVersBanc() };
}

const silence = () => {};
const identiteA = async (entete: string) => (
  entete === 'Bearer jwt-a' ? { userId: USER_A } : null
);

function requeteDemarrage(_corps: unknown, authorization: string | null = 'Bearer jwt-a'): Request {
  const entetes: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) entetes.authorization = authorization;
  return new Request(`https://fn.example/functions/v1/mcp-client/gestion/oauth-demarrer`, {
    method: 'POST', headers: entetes, body: '{}',
  });
}

/** Le handler reçoit le corps déjà analysé, comme le fait le transport HTTP. */
const CORPS_DEMARRAGE = { serverId: SERVER_ID };

const options = (base: AccesGestion) => ({
  originesSupplementaires: null,
  identite: identiteA,
  journal: silence,
  deps: () => depsGestion(base),
});

describe('Route oauth-demarrer', () => {
  it('refuse sans jeton SORAHNEX (401)', async () => {
    const { base, appels } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE, null), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(401);
    expect(appels.fluxCreer).not.toHaveBeenCalled();
  });

  it('refuse une connexion non OAuth (400), sans réseau', async () => {
    const { base, appels } = accesGestion({ lireServeur: async () => serveurGere({ authKind: 'bearer' }) });
    recu.length = 0;
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('mode_non_oauth');
    expect(appels.fluxCreer).not.toHaveBeenCalled();
    expect(recu).toHaveLength(0);
  });

  it('refuse une connexion révoquée (409)', async () => {
    const { base } = accesGestion({ lireServeur: async () => serveurGere({ status: 'revoked', revokedAt: '2026-11-14T00:00:00Z' }) });
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(409);
  });

  it('refuse un serveur d’autorisation qui n’accepte QUE `plain` (422), sans enregistrer', async () => {
    banc.metadonneesAs = {
      authorization_endpoint: `${BASE()}/authorize`,
      token_endpoint: `${BASE()}/token`,
      registration_endpoint: `${BASE()}/register`,
      code_challenge_methods_supported: ['plain'],
    };
    const { base, appels } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe('pkce_non_supporte');
    expect(appels.fluxCreer).not.toHaveBeenCalled();
  });

  it('prépare l’autorisation : PKCE, état stocké, URL cohérente', async () => {
    const { base, appels } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { autorisationUrl: string; state: string; clientEnregistre: boolean; pkceAnnonce: boolean };
    expect(corps.clientEnregistre).toBe(true);
    // Le banc annonce S256 : la vérification a bien eu lieu.
    expect(corps.pkceAnnonce).toBe(true);

    const url = new URL(corps.autorisationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(corps.state);

    // Le défi stocké correspond au verifier stocké — le coeur de PKCE.
    expect(appels.fluxCreer).toHaveBeenCalledTimes(1);
    const flux = premierArgument<{ state: string; verifier: string; userId: string }>(appels.fluxCreer) as { state: string; verifier: string; userId: string };
    expect(flux.state).toBe(corps.state);
    expect(flux.userId).toBe(USER_A);
    await expect(defiDepuisVerificateur(flux.verifier)).resolves.toBe(url.searchParams.get('code_challenge'));
  });

  it('ne renvoie jamais le secret client dans la réponse', async () => {
    banc.reponseEnregistrement = { client_id: 'client-banc', client_secret: 'secret-client-tres-sensible' };
    const { base, appels } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    const texte = await r.text();
    expect(texte).not.toContain('secret-client-tres-sensible');
    // Mais il EST bien transmis à la base, qui le range dans Vault.
    expect(appels.client).toHaveBeenCalledTimes(1);
    expect(premierArgument<{ clientSecret: string }>(appels.client)?.clientSecret)
      .toBe('secret-client-tres-sensible');
  });

  it('réutilise un client déjà enregistré au lieu d’en créer un second', async () => {
    banc.reponseEnregistrement = { client_id: 'ne-devrait-pas-servir' };
    const { base, appels } = accesGestion({
      lireServeur: async () => serveurGere({ oauthClientId: 'client-existant', authorizationServer: BASE() }),
    });
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { clientEnregistre: boolean; autorisationUrl: string };
    expect(corps.clientEnregistre).toBe(false);
    expect(new URL(corps.autorisationUrl).searchParams.get('client_id')).toBe('client-existant');
    expect(appels.client).not.toHaveBeenCalled();
  });

  it('dérive l’URL de retour de la requête réelle, pas d’une constante', () => {
    expect(urlCallback(new Request('https://fn.example/functions/v1/mcp-client/gestion/oauth-demarrer')))
      .toBe('https://fn.example/functions/v1/mcp-client/oauth/callback');
    expect(urlCallback(new Request('https://mcps.vyora.app/gestion/oauth-demarrer')))
      .toBe('https://mcps.vyora.app/oauth/callback');
  });
});

describe('Callback OAuth', () => {
  function requeteCallback(params: Record<string, string>): Request {
    const url = new URL('https://fn.example/functions/v1/mcp-client/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString());
  }

  const fluxValide = async () => ({
    serverId: SERVER_ID, userId: USER_A, verifier: 'verifier-1', redirectUri: 'https://fn.example/oauth/callback',
  });

  it('refuse un état inconnu (400) et n’échange rien', async () => {
    const { base, appels } = accesGestion();
    recu.length = 0;
    const r = await traiterCallbackOAuth(requeteCallback({ state: 'inconnu', code: 'c' }), () => depsGestion(base));
    expect(r.status).toBe(400);
    expect(recu).toHaveLength(0);
    expect(appels.jetons).not.toHaveBeenCalled();
  });

  it('refuse un refus explicite du fournisseur sans échanger', async () => {
    const { base, appels } = accesGestion({ consommerFluxOAuth: fluxValide });
    recu.length = 0;
    const r = await traiterCallbackOAuth(
      requeteCallback({ error: 'access_denied', error_description: 'refusé par l’utilisateur', state: 's', code: '' }),
      () => depsGestion(base),
    );
    expect(r.status).toBe(400);
    expect(recu).toHaveLength(0);
    expect(appels.fluxCreer).not.toHaveBeenCalled();
    expect(appels.jetons).not.toHaveBeenCalled();
  });

  it('refuse un retour sans code', async () => {
    const { base } = accesGestion({ consommerFluxOAuth: fluxValide });
    const r = await traiterCallbackOAuth(requeteCallback({ state: 's' }), () => depsGestion(base));
    expect(r.status).toBe(400);
  });

  it('échange le code, stocke les jetons, et n’affiche aucun jeton', async () => {
    const { base, appels } = accesGestion({
      consommerFluxOAuth: fluxValide,
      lireServeur: async () => serveurGere({
        oauthClientId: 'client-banc',
        oauthAs: { token_endpoint: `${BASE()}/token` },
      }),
      lireOAuth: async () => ({ access: null, refresh: null, expireLe: null, scope: null, clientId: 'client-banc', clientSecret: null }),
    });

    const r = await traiterCallbackOAuth(requeteCallback({ state: 's', code: 'code-1' }), () => depsGestion(base));
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(appels.jetons).toHaveBeenCalledTimes(1);

    const depot = premierArgument<{
      userId: string; serverId: string; access: string; refresh?: string; expireLe: string | null;
    }>(appels.jetons) as {
      userId: string; serverId: string; access: string; refresh?: string; expireLe: string | null;
    };
    expect(depot.userId).toBe(USER_A);
    expect(depot.serverId).toBe(SERVER_ID);
    expect(depot.access).toBe('at-1');
    expect(depot.refresh).toBe('rt-1');
    expect(typeof depot.expireLe).toBe('string');

    // Ni le jeton, ni le refresh ne reviennent au navigateur.
    expect(html).not.toContain('at-1');
    expect(html).not.toContain('rt-1');
    expect(html).toContain('Autorisation accordée');
  });

  it('un état déjà consommé est refusé (usage unique)', async () => {
    let usage = 0;
    const { base, appels } = accesGestion({
      consommerFluxOAuth: async () => {
        usage += 1;
        return usage === 1
          ? { serverId: SERVER_ID, userId: USER_A, verifier: 'v', redirectUri: 'https://fn.example/oauth/callback' }
          : null;
      },
      lireServeur: async () => serveurGere({ oauthClientId: 'c', oauthAs: { token_endpoint: `${BASE()}/token` } }),
      lireOAuth: async () => ({ access: null, refresh: null, expireLe: null, scope: null, clientId: 'c', clientSecret: null }),
    });
    const d = () => depsGestion(base);
    await traiterCallbackOAuth(requeteCallback({ state: 's', code: 'code-1' }), d);
    const second = await traiterCallbackOAuth(requeteCallback({ state: 's', code: 'code-1' }), d);
    expect(second.status).toBe(400);
    // Un seul jeu de jetons délivré malgré deux retours.
    expect(appels.jetons).toHaveBeenCalledTimes(1);
  });

  it('refuse quand le point de jeton est inconnu, sans appel réseau', async () => {
    const { base, appels } = accesGestion({
      consommerFluxOAuth: fluxValide,
      lireServeur: async () => serveurGere({ oauthClientId: 'c', oauthAs: null }),
      lireOAuth: async () => ({ access: null, refresh: null, expireLe: null, scope: null, clientId: 'c', clientSecret: null }),
    });
    recu.length = 0;
    const r = await traiterCallbackOAuth(requeteCallback({ state: 's', code: 'c' }), () => depsGestion(base));
    expect(r.status).toBe(422);
    expect(recu).toHaveLength(0);
    expect(appels.jetons).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Renouvellement automatique dans la porte d'exécution                     */
/* -------------------------------------------------------------------------- */

describe('Exécution — renouvellement automatique du jeton', () => {
  function connexionOAuth(partiel: Partial<ConnexionServeur> = {}): ConnexionServeur {
    return {
      id: SERVER_ID, userId: USER_A, workspaceId: WS_ID, name: 'Banc OAuth',
      url: `${BASE()}/mcp`, authKind: 'oauth', secretVaultName: null,
      status: 'connected', revokedAt: null,
      outils: [{ name: 'list_products', description: 'Liste les produits.' }],
      toolPermissions: { list_products: 'allowed' },
      ecrituresAutorisees: {},
      oauthAs: { token_endpoint: `${BASE()}/token` },
      ...partiel,
    };
  }

  function depsP5(partiel: {
    connexion?: ConnexionServeur;
    jetons?: { access: string | null; refresh: string | null; expireLe: string | null; scope: string | null; clientId: string | null; clientSecret: string | null };
    sansStockage?: boolean;
  } = {}) {
    const stockage = vi.fn(async () => undefined);
    const base: AccesBase = {
      lireConnexion: async () => partiel.connexion ?? connexionOAuth(),
      lireSecret: async () => null,
      lireOAuth: async () => partiel.jetons ?? null,
      ...(partiel.sansStockage ? {} : { stockerJetonsOAuth: stockage as unknown as AccesBase['stockerJetonsOAuth'] }),
    };
    return { deps: { base, egress: egressVersBanc() } as DependancesP5, stockage };
  }

  it('utilise directement un jeton valide, sans appeler le point de jeton', async () => {
    recu.length = 0;
    const { deps: d, stockage } = depsP5({
      jetons: { access: 'at-valide', refresh: 'rt', expireLe: new Date(Date.now() + 3_600_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(true);
    expect(recu.some((x) => x.chemin === '/token')).toBe(false);
    expect(stockage).not.toHaveBeenCalled();
  });

  it('renouvelle un jeton expiré, réécrit les jetons, puis appelle avec le nouveau', async () => {
    recu.length = 0;
    banc.reponseJeton = { access_token: 'at-frais', refresh_token: 'rt-2', expires_in: 3600 };
    const { deps: d, stockage } = depsP5({
      jetons: { access: 'at-perime', refresh: 'rt-1', expireLe: new Date(Date.now() - 60_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(true);

    expect(stockage).toHaveBeenCalledTimes(1);
    const depot = premierArgument<{ access: string; refresh?: string; expireLe: string | null }>(stockage) as { access: string; refresh?: string; expireLe: string | null };
    expect(depot.access).toBe('at-frais');
    expect(depot.refresh).toBe('rt-2');
    expect(depot.expireLe).not.toBeNull();
  });

  it('conserve l’ancien refresh quand le fournisseur n’en renvoie pas', async () => {
    banc.reponseJeton = { access_token: 'at-frais', expires_in: 3600 };
    const { deps: d, stockage } = depsP5({
      jetons: { access: 'at-perime', refresh: 'rt-ancien', expireLe: new Date(Date.now() - 60_000).toISOString(), scope: 'mcp:read', clientId: 'c', clientSecret: null },
    });
    await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    const depot = premierArgument<{ refresh?: string; scope?: string | null }>(stockage) as { refresh?: string; scope?: string | null };
    // Sans cette conservation, le renouvellement suivant serait impossible.
    expect(depot.refresh).toBe('rt-ancien');
    expect(depot.scope).toBe('mcp:read');
  });

  it('refuse AVANT le réseau quand le renouvellement échoue et que le jeton est mort', async () => {
    banc.statutJeton = 400;
    banc.reponseJeton = { error: 'invalid_grant' };
    recu.length = 0;
    const { deps: d, stockage } = depsP5({
      jetons: { access: 'at-mort', refresh: 'rt-perime', expireLe: new Date(Date.now() - 60_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('auth_required');
    // Le serveur MCP n'a jamais été contacté : seul /token l'a été.
    expect(recu.every((x) => x.chemin === '/token')).toBe(true);
    expect(stockage).not.toHaveBeenCalled();
  });

  it('utilise encore un jeton NON expiré si le renouvellement anticipé échoue', async () => {
    banc.statutJeton = 400;
    banc.reponseJeton = { error: 'temporarily_unavailable' };
    const { deps: d } = depsP5({
      // Expire dans 30 s : dans la marge de renouvellement, mais encore valide.
      jetons: { access: 'at-encore-bon', refresh: 'rt', expireLe: new Date(Date.now() + 30_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(true);
  });

  it('refuse quand aucun jeton n’a encore été obtenu', async () => {
    recu.length = 0;
    const { deps: d } = depsP5({
      jetons: { access: null, refresh: null, expireLe: null, scope: null, clientId: null, clientSecret: null },
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('auth_required');
    expect(recu).toHaveLength(0);
  });

  it('refuse d’appeler si le jeton renouvelé ne peut pas être persisté', async () => {
    banc.reponseJeton = { access_token: 'at-frais', expires_in: 3600 };
    recu.length = 0;
    const { deps: d } = depsP5({
      jetons: { access: 'at-perime', refresh: 'rt', expireLe: new Date(Date.now() - 60_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
      sansStockage: true,
    });
    const r = await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Échouer ici vaut mieux que réussir une fois puis casser la connexion.
    expect(r.code).toBe('renouvellement_non_persiste');
    expect(recu.every((x) => x.chemin === '/token')).toBe(true);
  });

  it('un fournisseur qui ne renvoie pas d’expiration n’est pas renouvelé en boucle', async () => {
    banc.reponseJeton = { access_token: 'at-frais', expires_in: 3600 };
    const { deps: d, stockage } = depsP5({
      jetons: { access: 'at-perime', refresh: 'rt', expireLe: new Date(Date.now() - 60_000).toISOString(), scope: null, clientId: 'c', clientSecret: null },
    });
    await executerOutilExterne({ serverId: SERVER_ID, outil: 'list_products' }, { userId: USER_A }, d);
    const depot = premierArgument<{ expireLe: string | null }>(stockage) as { expireLe: string | null };
    expect(depot.expireLe).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* P6d — défauts constatés en réel, corrigés, et verrouillés ici              */
/* -------------------------------------------------------------------------- */

describe('P6d — URL de retour fixée par la configuration', () => {
  it('préfère l’URL configurée à celle déduite de la requête', () => {
    const requete = new Request('http://localhost:9000/functions/v1/mcp-client/gestion/oauth-demarrer');
    expect(resoudreUrlCallback(requete, 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/oauth/callback'))
      .toBe('https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/oauth/callback');
  });

  it('refuse une URL de retour non https, configurée ou déduite', () => {
    const http = new Request('http://localhost:9000/functions/v1/mcp-client/gestion/oauth-demarrer');
    expect(resoudreUrlCallback(http, undefined)).toBeNull();
    expect(resoudreUrlCallback(http, 'http://exemple.test/oauth/callback')).toBeNull();
    // Ni paramètres ni fragment : un redirect_uri est une constante exacte.
    expect(resoudreUrlCallback(http, 'https://exemple.test/oauth/callback?x=1')).toBeNull();
  });

  it('la route refuse de démarrer (500) plutôt que d’enregistrer un retour en http', async () => {
    const { base, appels } = accesGestion();
    const requete = new Request('http://localhost:9000/functions/v1/mcp-client/gestion/oauth-demarrer', {
      method: 'POST', headers: { authorization: 'Bearer jwt-a' }, body: '{}',
    });
    recu.length = 0;
    const r = await traiterDemarrageOAuth(requete, CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(500);
    expect(((await r.json()) as { error: string }).error).toBe('callback_non_https');
    // La découverte a eu lieu (métadonnées), mais AUCUN enregistrement.
    expect(recu.some((x) => x.chemin === '/register')).toBe(false);
    expect(appels.client).not.toHaveBeenCalled();
  });

  it('la route utilise l’URL configurée dans l’enregistrement ET l’URL d’autorisation', async () => {
    const { base } = accesGestion();
    const fixe = 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/mcp-client/oauth/callback';
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, {
      ...options(base), urlCallback: fixe,
    });
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { autorisationUrl: string; redirectUri: string };
    expect(corps.redirectUri).toBe(fixe);
    expect(new URL(corps.autorisationUrl).searchParams.get('redirect_uri')).toBe(fixe);
    const enregistrement = recu.find((x) => x.chemin === '/register');
    expect(JSON.parse(enregistrement?.corps ?? '{}')).toMatchObject({ redirect_uris: [fixe] });
  });
});

describe('P6d — portées : la ressource prime sur le serveur d’autorisation', () => {
  it('demande les portées de la ressource (RFC 9728) quand elle en annonce', async () => {
    // Cas réel Linear : l’AS liste `read write openid email`, la ressource `read write`.
    banc.metadonneesAs = { ...banc.metadonneesAs, scopes_supported: ['read', 'write', 'openid', 'email'] };
    banc.metadonneesRessource = { ...banc.metadonneesRessource, scopes_supported: ['read', 'write'] };
    const { base } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { autorisationUrl: string; portees: string[] };
    expect(corps.portees).toEqual(['read', 'write']);
    expect(new URL(corps.autorisationUrl).searchParams.get('scope')).toBe('read write');
  });

  it('retombe sur les portées de l’AS quand la ressource n’en annonce pas', async () => {
    const { base } = accesGestion();
    const r = await traiterDemarrageOAuth(requeteDemarrage(CORPS_DEMARRAGE), CORPS_DEMARRAGE, options(base).deps, options(base));
    const corps = (await r.json()) as { portees: string[] };
    expect(corps.portees).toEqual(['mcp:read']);
  });
});

describe('P6d — aucune injection HTML dans la page de retour', () => {
  function requeteCallback(params: Record<string, string>): Request {
    const url = new URL('https://fn.example/functions/v1/mcp-client/oauth/callback');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString());
  }

  it('échappe les cinq caractères significatifs', () => {
    expect(echapperHtml(`<b a="1" c='2'>&</b>`)).toBe('&lt;b a=&quot;1&quot; c=&#39;2&#39;&gt;&amp;&lt;/b&gt;');
  });

  it('un error_description hostile ressort inerte (constaté en réel sur v8)', async () => {
    const { base } = accesGestion();
    const r = await traiterCallbackOAuth(
      requeteCallback({ error: 'access_denied', error_description: 'refus</code><b>gras</b><code>' }),
      () => depsGestion(base),
    );
    const html = await r.text();
    expect(r.status).toBe(400);
    expect(html).not.toContain('<b>gras</b>');
    expect(html).toContain('&lt;b&gt;gras&lt;/b&gt;');
  });

  it('un message d’erreur du point de jeton est échappé lui aussi', async () => {
    banc.statutJeton = 400;
    banc.reponseJeton = { error: 'invalid_grant', error_description: '<img src=x>' };
    const { base } = accesGestion({
      consommerFluxOAuth: async () => ({ serverId: SERVER_ID, userId: USER_A, verifier: 'v', redirectUri: 'https://fn.example/oauth/callback' }),
      lireServeur: async () => serveurGere({ oauthClientId: 'client-banc', oauthAs: { token_endpoint: `${BASE()}/token` } }),
      lireOAuth: async () => ({ access: null, refresh: null, expireLe: null, scope: null, clientId: 'client-banc', clientSecret: null }),
    });
    const r = await traiterCallbackOAuth(requeteCallback({ state: 's', code: 'c' }), () => depsGestion(base));
    const html = await r.text();
    expect(r.status).toBe(502);
    expect(html).not.toContain('<img');
    expect(html).toContain('invalid_grant');
  });
});

describe('P6d — création OAuth sans secret', () => {
  const base = { workspaceId: WS_ID, nom: 'X', url: 'https://x.example/mcp' };
  it('accepte `oauth` sans secret (le jeton viendra du flux)', () => {
    const v = validerCreation({ ...base, authKind: 'oauth' });
    expect(v.ok).toBe(true);
  });
  it('accepte toujours `oauth` AVEC un jeton déjà obtenu', () => {
    const v = validerCreation({ ...base, authKind: 'oauth', secret: 'jeton' });
    expect(v.ok && v.demande.secret).toBe('jeton');
  });
  it('exige toujours un secret pour `bearer` et `api_key`', () => {
    for (const authKind of ['bearer', 'api_key']) {
      const v = validerCreation({ ...base, authKind });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe('secret_requis');
    }
  });
});

describe('P6d — route oauth-revoquer', () => {
  const CORPS = { serverId: SERVER_ID };
  function requete(authorization: string | null = 'Bearer jwt-a'): Request {
    const entetes: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization !== null) entetes.authorization = authorization;
    return new Request('https://fn.example/functions/v1/mcp-client/gestion/oauth-revoquer', { method: 'POST', headers: entetes, body: '{}' });
  }
  const jetons = (partiel: Partial<{ access: string | null; refresh: string | null }> = {}) => async () => ({
    access: 'at-1', refresh: 'rt-1', expireLe: null, scope: null, clientId: 'client-banc', clientSecret: null, ...partiel,
  });
  const avecRevocation = () => serveurGere({ oauthAs: { token_endpoint: `${BASE()}/token`, revocation_endpoint: `${BASE()}/revoke` } });

  it('refuse sans jeton SORAHNEX (401), sans réseau ni destruction', async () => {
    const { base, appels } = accesGestion({ lireOAuth: jetons() });
    recu.length = 0;
    const r = await traiterRevocationOAuth(requete(null), CORPS, options(base).deps, options(base));
    expect(r.status).toBe(401);
    expect(recu).toHaveLength(0);
    expect(appels.detruire).not.toHaveBeenCalled();
  });

  it('refuse une connexion qui n’appartient pas à l’utilisateur (404)', async () => {
    const { base, appels } = accesGestion({ lireServeur: async () => null, lireOAuth: jetons() });
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(r.status).toBe(404);
    expect(appels.detruire).not.toHaveBeenCalled();
  });

  it('refuse une connexion non OAuth (400)', async () => {
    const { base, appels } = accesGestion({ lireServeur: async () => serveurGere({ authKind: 'bearer' }) });
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(r.status).toBe(400);
    expect(appels.detruire).not.toHaveBeenCalled();
  });

  it('révoque refresh PUIS access chez le fournisseur (RFC 7009), puis détruit en local', async () => {
    const { base, appels } = accesGestion({ lireServeur: async () => avecRevocation(), lireOAuth: jetons() });
    recu.length = 0;
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(r.status).toBe(200);
    const corps = (await r.json()) as { distant: string; jetonsDetruits: number; status: string };
    expect(corps).toMatchObject({ distant: 'revoque', jetonsDetruits: 2, status: 'auth_required' });

    const revocations = recu.filter((x) => x.chemin === '/revoke');
    expect(revocations).toHaveLength(2);
    expect(revocations[0]?.entetes['content-type']).toContain('application/x-www-form-urlencoded');
    expect(new URLSearchParams(revocations[0]?.corps).get('token')).toBe('rt-1');
    expect(new URLSearchParams(revocations[0]?.corps).get('token_type_hint')).toBe('refresh_token');
    expect(new URLSearchParams(revocations[1]?.corps).get('token')).toBe('at-1');
    expect(new URLSearchParams(revocations[1]?.corps).get('token_type_hint')).toBe('access_token');
    expect(appels.detruire).toHaveBeenCalledTimes(1);
    // Rien de secret dans la réponse.
    const texte = JSON.stringify(corps);
    expect(texte).not.toContain('at-1');
    expect(texte).not.toContain('rt-1');
  });

  it('détruit en local même si le fournisseur refuse, et le dit (`refuse`)', async () => {
    banc.statutRevocation = 400;
    const { base, appels } = accesGestion({ lireServeur: async () => avecRevocation(), lireOAuth: jetons() });
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { distant: string }).distant).toBe('refuse');
    expect(appels.detruire).toHaveBeenCalledTimes(1);
  });

  it('fournisseur sans point de révocation : destruction locale, `indisponible`, aucun réseau', async () => {
    const { base, appels } = accesGestion({ lireOAuth: jetons() });
    recu.length = 0;
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(((await r.json()) as { distant: string }).distant).toBe('indisponible');
    expect(recu).toHaveLength(0);
    expect(appels.detruire).toHaveBeenCalledTimes(1);
  });

  it('sans aucun jeton : `aucun_jeton`, destruction locale idempotente, aucun réseau', async () => {
    const { base, appels } = accesGestion({ lireServeur: async () => avecRevocation(), lireOAuth: jetons({ access: null, refresh: null }) });
    recu.length = 0;
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(((await r.json()) as { distant: string; jetonsDetruits: number })).toMatchObject({ distant: 'aucun_jeton', jetonsDetruits: 0 });
    expect(recu).toHaveLength(0);
    expect(appels.detruire).toHaveBeenCalledTimes(1);
  });

  it('un point de révocation non https n’est jamais appelé', async () => {
    const { base, appels } = accesGestion({
      lireServeur: async () => serveurGere({ oauthAs: { revocation_endpoint: 'http://banc-oauth.example/revoke' } }),
      lireOAuth: jetons(),
    });
    recu.length = 0;
    const r = await traiterRevocationOAuth(requete(), CORPS, options(base).deps, options(base));
    expect(((await r.json()) as { distant: string }).distant).toBe('indisponible');
    expect(recu).toHaveLength(0);
    expect(appels.detruire).toHaveBeenCalledTimes(1);
  });
});
