import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { MAX_CORPS, entetesCors, traiterRequete } from '../supabase/functions/mcp-client/http';
import type { AccesBase, ConnexionServeur, DependancesP5 } from '../supabase/functions/mcp-client/execution';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * Frontière HTTP de `mcp-client` — la couche qui vivait dans `index.ts` et
 * n'était donc couverte par AUCUN test (ce fichier importe `npm:postgres`, que
 * Vitest ne peut pas charger).
 *
 * Deux familles :
 * - CORS et plafonds, sans base ni réseau ;
 * - bout en bout contre un VRAI serveur MCP local, avec un compteur
 *   `tools/call` côté serveur : un refus doit laisser ce compteur à zéro.
 */

const JETON = 'jeton-http-0123456789';
const USER_A = '11111111-2222-3333-4444-555555555555';
const UUID_VALIDE = '11111111-2222-3333-4444-555555555555';

let serveur: Server;
let port = 0;
const appelsRecus: string[] = [];

function lireCorps(requete: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let corps = '';
    requete.on('data', (t) => { corps += t; });
    requete.on('end', () => resolve(corps));
  });
}

function repondre(reponse: ServerResponse, charge: unknown, statut = 200, entetes: Record<string, string> = {}) {
  const corps = JSON.stringify(charge);
  reponse.writeHead(statut, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(corps)), ...entetes });
  reponse.end(corps);
}

beforeAll(async () => {
  serveur = createServer(async (requete, reponse) => {
    const corps = await lireCorps(requete);
    const message = JSON.parse(corps) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (requete.headers.authorization !== `Bearer ${JETON}`) { repondre(reponse, { error: 'invalid_token' }, 401); return; }
    if (message.method === 'initialize') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'banc-http', version: '1' } },
      }, 200, { 'mcp-session-id': 'sess-http' });
      return;
    }
    if (message.method === 'notifications/initialized') { reponse.writeHead(202).end(); return; }
    if (message.method === 'tools/list') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { tools: [{ name: 'list_products', description: 'Liste les produits.', inputSchema: { type: 'object' } }] },
      });
      return;
    }
    if (message.method === 'tools/call') {
      appelsRecus.push(String(message.params?.name ?? ''));
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { content: [{ type: 'text', text: 'résultat réel du banc' }], isError: false },
      });
      return;
    }
    repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32601, message: 'inconnu' } });
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

function connexion(partiel: Partial<ConnexionServeur> = {}): ConnexionServeur {
  return {
    id: UUID_VALIDE,
    userId: USER_A,
    workspaceId: 'ws-a',
    name: 'Boutique',
    url: 'https://banc-http.example/mcp',
    authKind: 'bearer',
    secretVaultName: 'mcp_server_http',
    status: 'connected',
    revokedAt: null,
    outils: [{ name: 'list_products', description: 'Liste les produits.' }],
    toolPermissions: { list_products: 'allowed' },
    ecrituresAutorisees: {},
    ...partiel,
  };
}

function deps(partiel: { connexion?: ConnexionServeur | null } = {}): DependancesP5 & { lecture: ReturnType<typeof vi.fn> } {
  const lecture = vi.fn(async () => (partiel.connexion === undefined ? connexion() : partiel.connexion));
  const base: AccesBase = {
    lireConnexion: lecture as unknown as AccesBase['lireConnexion'],
    lireSecret: async () => JETON,
  };
  return { base, egress: egressVersBanc(), lecture };
}

/** Requête POST prête à l'emploi. */
function requete(
  corps: unknown,
  options: { authorization?: string | null; origin?: string | null; methode?: string; entetes?: Record<string, string> } = {},
): Request {
  const entetes: Record<string, string> = { 'content-type': 'application/json', ...(options.entetes ?? {}) };
  const autorisation = options.authorization === undefined ? `Bearer ${JETON_JWT}` : options.authorization;
  if (autorisation !== null) entetes.authorization = autorisation;
  if (options.origin) entetes.origin = options.origin;
  return new Request('https://exemple.test/functions/v1/mcp-client', {
    method: options.methode ?? 'POST',
    headers: entetes,
    ...(options.methode === 'GET' || options.methode === 'OPTIONS' ? {} : { body: typeof corps === 'string' ? corps : JSON.stringify(corps) }),
  });
}

const JETON_JWT = 'jwt-de-test';

function identiteOk(authorization: string) {
  return Promise.resolve(
    authorization === `Bearer ${JETON_JWT}` ? { userId: USER_A } : null,
  );
}

function identiteRefusee() {
  return Promise.resolve(null);
}

/* -------------------------------------------------------------------------- */
/* 1. CORS — la régression corrigée                                             */
/* -------------------------------------------------------------------------- */

describe('CORS — les origines par défaut s’appliquent même sans variable d’environnement', () => {
  it('une origine du dépôt est autorisée quand la variable est absente', () => {
    // C'est exactement la panne de `store-connect` : variable vide ⇒ `null`
    // partout ⇒ toutes les requêtes du navigateur bloquées.
    const cors = entetesCors('', 'https://vyora-ugc.netlify.app');
    expect(cors['access-control-allow-origin']).toBe('https://vyora-ugc.netlify.app');
  });

  it('une origine du dépôt est autorisée quand la variable vaut null', () => {
    expect(entetesCors(null, 'https://reelora.netlify.app')['access-control-allow-origin'])
      .toBe('https://reelora.netlify.app');
  });

  it('un motif à joker fonctionne (prévisualisations)', () => {
    const cors = entetesCors(null, 'https://deploy-preview-12--vyora.netlify.app');
    expect(cors['access-control-allow-origin']).toBe('https://deploy-preview-12--vyora.netlify.app');
  });

  it('une origine inconnue reçoit null, JAMAIS *', () => {
    const cors = entetesCors(null, 'https://attaquant.example');
    expect(cors['access-control-allow-origin']).toBe('null');
  });

  it('une origine supplémentaire fournie en configuration est acceptée', () => {
    const cors = entetesCors('https://mon-domaine.example', 'https://mon-domaine.example');
    expect(cors['access-control-allow-origin']).toBe('https://mon-domaine.example');
  });

  it('vary: origin est toujours présent', () => {
    expect(entetesCors(null, null).vary).toBe('origin');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Refus avant toute lecture en base                                         */
/* -------------------------------------------------------------------------- */

describe('refus AVANT la base et AVANT le réseau', () => {
  it('OPTIONS ne touche ni la base ni le réseau', async () => {
    const d = deps();
    const reponse = await traiterRequete(requete(null, { methode: 'OPTIONS' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(200);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('une méthode autre que POST est refusée en 405, sans lecture', async () => {
    const d = deps();
    const reponse = await traiterRequete(requete(null, { methode: 'GET' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(405);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('un corps illisible est refusé en 400, sans lecture', async () => {
    const d = deps();
    const reponse = await traiterRequete(requete('{ceci nest pas du json'), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(400);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('un corps trop volumineux est refusé en 413 (en-tête déclaré)', async () => {
    const d = deps();
    const reponse = await traiterRequete(
      requete({ serverId: UUID_VALIDE, outil: 'list_products' }, { entetes: { 'content-length': String(MAX_CORPS + 1) } }),
      () => d,
      { originesSupplementaires: null, identite: identiteOk },
    );
    expect(reponse.status).toBe(413);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('un en-tête de taille mensonger ne sauve pas un gros corps (413 sur la taille réelle)', async () => {
    const d = deps();
    const gros = JSON.stringify({ serverId: UUID_VALIDE, outil: 'list_products', arguments: { x: 'a'.repeat(MAX_CORPS + 10) } });
    const reponse = await traiterRequete(requete(gros, { entetes: { 'content-length': '10' } }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(413);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('sans jeton valide : 401, et AUCUNE lecture en base', async () => {
    const d = deps();
    const reponse = await traiterRequete(
      requete({ serverId: UUID_VALIDE, outil: 'list_products' }, { authorization: 'Bearer faux' }),
      () => d,
      { originesSupplementaires: null, identite: identiteRefusee },
    );
    expect(reponse.status).toBe(401);
    expect(d.lecture).not.toHaveBeenCalled();
    expect(appelsRecus).toHaveLength(0);
  });

  it('un corps invalide après authentification : 400, aucune lecture', async () => {
    const d = deps();
    const reponse = await traiterRequete(requete({ serverId: 'pas-un-uuid', outil: 'x' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(400);
    expect(d.lecture).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Refus de sécurité : le compteur réseau doit rester à zéro                  */
/* -------------------------------------------------------------------------- */

describe('refus de sécurité — ZÉRO appel `tools/call` au serveur distant', () => {
  it('connexion introuvable (autre utilisateur) : 404, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps({ connexion: null });
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(404);
    expect(appelsRecus).toHaveLength(0);
  });

  it('connexion révoquée : 409, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps({ connexion: connexion({ status: 'revoked', revokedAt: '2026-11-21T00:00:00Z' }) });
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(409);
    expect(appelsRecus).toHaveLength(0);
  });

  it('permission retirée : 403, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps({ connexion: connexion({ toolPermissions: { list_products: 'denied' } }) });
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(403);
    expect(appelsRecus).toHaveLength(0);
  });

  it('outil inconnu : 404, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps();
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'outil_jamais_decouvert' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(404);
    expect(appelsRecus).toHaveLength(0);
  });

  it('écriture non autorisée en base : 403, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps({ connexion: connexion({ toolPermissions: { delete_product: 'allowed' }, outils: [{ name: 'delete_product', description: 'Supprime un produit.' }] }) });
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'delete_product' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(403);
    const corps = await reponse.json() as { error: string; message: string };
    // Le message doit dire la vérité : aucune confirmation ne peut suffire.
    expect(corps.error).toBe('ecriture_desactivee');
    expect(corps.message).toContain('lecture seule');
    expect(appelsRecus).toHaveLength(0);
  });

  it('un refus ne renvoie jamais le secret', async () => {
    const d = deps({ connexion: connexion({ toolPermissions: { list_products: 'denied' } }) });
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    const texte = await reponse.text();
    expect(texte).not.toContain(JETON);
    expect(texte).not.toContain('Authorization');
  });

  it('secret absent dans Vault : 409, zéro appel', async () => {
    appelsRecus.length = 0;
    const d = deps();
    (d.base as { lireSecret: unknown }).lireSecret = async () => null;
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(409);
    const corps = await reponse.json() as { error: string };
    expect(corps.error).toBe('secret_manquant');
    expect(appelsRecus).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Chemin nominal réel                                                       */
/* -------------------------------------------------------------------------- */

describe('chemin nominal contre un vrai serveur MCP', () => {
  it('appel autorisé : 200, réponse réelle, un seul `tools/call`', async () => {
    appelsRecus.length = 0;
    const d = deps();
    const reponse = await traiterRequete(requete({ serverId: UUID_VALIDE, outil: 'list_products' }), () => d, {
      originesSupplementaires: null, identite: identiteOk,
    });
    expect(reponse.status).toBe(200);
    const corps = await reponse.json() as { ok: boolean; contenu: unknown };
    expect(corps.ok).toBe(true);
    expect(JSON.stringify(corps.contenu)).toContain('résultat réel du banc');
    expect(appelsRecus).toEqual(['list_products']);
  });

  it('le journal ne contient ni arguments, ni jeton, ni URL', async () => {
    const lignes: Record<string, unknown>[] = [];
    const d = deps({ connexion: connexion({ toolPermissions: { list_products: 'denied' } }) });
    await traiterRequete(
      requete({ serverId: UUID_VALIDE, outil: 'list_products', arguments: { secret: 'valeur-client' } }),
      () => d,
      { originesSupplementaires: null, identite: identiteOk, journal: (_m, details) => lignes.push(details) },
    );
    const texte = JSON.stringify(lignes);
    expect(texte).not.toContain('valeur-client');
    expect(texte).not.toContain(JETON);
    expect(texte).not.toContain('banc-http.example');
    expect(lignes[0]).toMatchObject({ userId: USER_A, outil: 'list_products', status: 403 });
  });
});
