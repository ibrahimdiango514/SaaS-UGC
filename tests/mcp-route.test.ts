import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import {
  MAX_NOM_OUTIL,
  entreeJournal,
  traiterAppelOutil,
  validerCorps,
} from '../supabase/functions/mcp-client/route';
import type {
  AccesBase,
  ConnexionServeur,
  DependancesP5,
} from '../supabase/functions/mcp-client/execution';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * Frontière HTTP de l'exécution MCP.
 *
 * Deux familles de tests :
 * - validation d'entrée, pure, sans base ni réseau ;
 * - bout en bout contre un VRAI serveur MCP local, pour prouver qu'un refus
 *   n'émet aucune requête `tools/call`.
 */

const JETON = 'jeton-route-0123456789';
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
  reponse.writeHead(statut, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(corps)),
    ...entetes,
  });
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
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'banc-route', version: '1' } },
      }, 200, { 'mcp-session-id': 'sess-route' });
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
        result: { content: [{ type: 'text', text: 'contribution réelle' }], isError: false },
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
    userId: 'user-a',
    workspaceId: 'ws-a',
    name: 'Boutique',
    url: 'https://banc-route.example/mcp',
    authKind: 'bearer',
    secretVaultName: 'mcp_server_route',
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

/* -------------------------------------------------------------------------- */

describe('validation d’entrée (pure)', () => {
  it('refuse un corps non objet', () => {
    for (const corps of [null, 'texte', 42, [1, 2]]) {
      const r = validerCorps(corps);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('corps_invalide');
    }
  });

  it('refuse un serverId qui n’est pas un UUID', () => {
    for (const serverId of ['abc', '', '111', '../../etc/passwd', 123, null]) {
      const r = validerCorps({ serverId, outil: 'list_products' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('server_id_invalide');
    }
  });

  it('refuse un nom d’outil vide ou trop long', () => {
    expect(validerCorps({ serverId: UUID_VALIDE, outil: '' }).ok).toBe(false);
    expect(validerCorps({ serverId: UUID_VALIDE, outil: '   ' }).ok).toBe(false);
    expect(validerCorps({ serverId: UUID_VALIDE, outil: 'a'.repeat(MAX_NOM_OUTIL + 1) }).ok).toBe(false);
    expect(validerCorps({ serverId: UUID_VALIDE, outil: 'a'.repeat(MAX_NOM_OUTIL) }).ok).toBe(true);
  });

  it('refuse des arguments qui ne sont pas un objet', () => {
    for (const args of [[], 'str', 3]) {
      const r = validerCorps({ serverId: UUID_VALIDE, outil: 'x', arguments: args });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('arguments_invalides');
    }
  });

  it('n’accepte une confirmation que si elle vaut strictement true', () => {
    for (const valeur of ['true', 1, 'oui', {}, []]) {
      const r = validerCorps({ serverId: UUID_VALIDE, outil: 'x', confirmationEcriture: valeur });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.demande.confirmationEcriture).toBe(false);
    }
    const vrai = validerCorps({ serverId: UUID_VALIDE, outil: 'x', confirmationEcriture: true });
    expect(vrai.ok && vrai.demande.confirmationEcriture).toBe(true);
  });

  it('ignore une permission fournie par le client', () => {
    const r = validerCorps({
      serverId: UUID_VALIDE,
      outil: 'delete_product',
      permission: { etat: 'allowed' },
      toolPermissions: { delete_product: 'allowed' },
      userId: 'autre-utilisateur',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // La demande normalisée ne recopie AUCUN de ces champs : ni permission,
      // ni liste de permissions, ni identité. Seul ce qui est validé passe.
      expect(r.demande).not.toHaveProperty('permission');
      expect(r.demande).not.toHaveProperty('toolPermissions');
      expect(r.demande).not.toHaveProperty('userId');
      expect(r.demande).not.toHaveProperty('etat');
      expect(r.demande).toMatchObject({ serverId: UUID_VALIDE, outil: 'delete_product' });
    }
  });
});

describe('traiterAppelOutil — bout en bout contre un vrai serveur MCP', () => {
  it('sans identité : 401, aucune lecture en base', async () => {
    const d = deps();
    const r = await traiterAppelOutil(
      { identite: null, corps: { serverId: UUID_VALIDE, outil: 'list_products' } },
      d,
    );
    expect(r.status).toBe(401);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('corps invalide : 400, aucune lecture en base', async () => {
    const d = deps();
    const r = await traiterAppelOutil({ identite: { userId: 'user-a' }, corps: { outil: 'x' } }, d);
    expect(r.status).toBe(400);
    expect(d.lecture).not.toHaveBeenCalled();
  });

  it('appel autorisé : 200 et la réponse réelle du serveur', async () => {
    appelsRecus.length = 0;
    const r = await traiterAppelOutil(
      { identite: { userId: 'user-a' }, corps: { serverId: UUID_VALIDE, outil: 'list_products' } },
      deps(),
    );
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(JSON.stringify(r.body.contenu)).toContain('contribution réelle');
    expect(appelsRecus).toEqual(['list_products']);
    // Aucun jeton dans la réponse.
    expect(JSON.stringify(r.body)).not.toContain(JETON);
  });

  it('le client tente de forcer une permission : 403 et aucun appel', async () => {
    appelsRecus.length = 0;
    const r = await traiterAppelOutil(
      {
        identite: { userId: 'user-a' },
        corps: {
          serverId: UUID_VALIDE,
          outil: 'list_products',
          permission: { etat: 'allowed' },
          // La base, elle, refuse.
        },
      },
      deps({ connexion: connexion({ toolPermissions: {} }) }),
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('outil_non_autorise');
    expect(appelsRecus).toEqual([]);
  });

  it('connexion d’un autre utilisateur : 404 et aucun appel', async () => {
    appelsRecus.length = 0;
    const r = await traiterAppelOutil(
      { identite: { userId: 'user-b' }, corps: { serverId: UUID_VALIDE, outil: 'list_products' } },
      deps({ connexion: null }),
    );
    expect(r.status).toBe(404);
    expect(appelsRecus).toEqual([]);
  });

  it('connexion révoquée : 409 et aucun appel', async () => {
    appelsRecus.length = 0;
    const r = await traiterAppelOutil(
      { identite: { userId: 'user-a' }, corps: { serverId: UUID_VALIDE, outil: 'list_products' } },
      deps({ connexion: connexion({ status: 'revoked', revokedAt: '2026-11-21T00:00:00Z' }) }),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('revoked');
    expect(appelsRecus).toEqual([]);
  });

  it('un refus ne renvoie jamais le secret', async () => {
    const r = await traiterAppelOutil(
      { identite: { userId: 'user-a' }, corps: { serverId: UUID_VALIDE, outil: 'list_products' } },
      deps({ connexion: connexion({ toolPermissions: {} }) }),
    );
    expect(JSON.stringify(r.body)).not.toContain(JETON);
  });
});

describe('journal', () => {
  it('ne contient ni arguments, ni jeton, ni URL', () => {
    const entree = entreeJournal({ userId: 'user-a', serverId: UUID_VALIDE, outil: 'list_products', status: 200 });
    const texte = JSON.stringify(entree);
    expect(texte).not.toContain(JETON);
    expect(texte).not.toContain('https://');
    expect(texte).not.toContain('arguments');
  });
});
