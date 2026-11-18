import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { traiterRequeteGestion } from '../supabase/functions/mcp-client/gestion-http';
import type { DependancesGestion } from '../supabase/functions/mcp-client/gestion-serveur';
import type { AccesBase, ConnexionServeur } from '../supabase/functions/mcp-client/execution';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * Route `/gestion/executer` — bout en bout contre un VRAI serveur MCP local.
 *
 * Ce fichier ne teste pas « la réponse est 200 » : il teste que le chemin
 * complet fonctionne — jeton → base → décision → `tools/call` réel → réponse —
 * et surtout que les refus ont lieu **avant** tout appel réseau. Pour cela le
 * serveur de banc compte chaque méthode reçue : un refus doit laisser le
 * compteur à zéro, pas seulement renvoyer un code d'erreur.
 */

const JETON = 'jeton-execution-0123456789';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const SERVER_A = '33333333-3333-3333-3333-333333333333';
const SERVER_B = '55555555-5555-5555-5555-555555555555';
const WS_A = '44444444-4444-4444-4444-444444444444';
const WS_B = '66666666-6666-6666-6666-666666666666';

let serveur: Server;
let port = 0;
const methodesRecues: string[] = [];
const outilsAppeles: Array<{ nom: string; arguments: unknown }> = [];

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

/** Outils du banc : deux lectures, une écriture, un lent, un qui répond mal. */
const OUTILS_BANC = [
  { name: 'list_products', description: 'Liste les produits.' },
  { name: 'get_order', description: 'Lit une commande.' },
  { name: 'delete_order', description: 'Supprime une commande.' },
  { name: 'get_slow', description: 'Répond lentement.' },
  { name: 'get_garbage', description: 'Répond n’importe quoi.' },
];

beforeAll(async () => {
  serveur = createServer(async (requete, reponse) => {
    const corps = await lireCorps(requete);
    let message: { id?: number; method?: string; params?: { name?: string; arguments?: unknown } };
    try {
      message = JSON.parse(corps);
    } catch {
      repondre(reponse, { error: 'json_invalide' }, 400);
      return;
    }
    methodesRecues.push(String(message.method));

    if (requete.headers.authorization !== `Bearer ${JETON}`) {
      repondre(reponse, { error: 'invalid_token' }, 401);
      return;
    }
    if (message.method === 'initialize') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'banc-execution', version: '1' },
        },
      }, 200, { 'mcp-session-id': 'sess-exec' });
      return;
    }
    if (message.method === 'notifications/initialized') { reponse.writeHead(202).end(); return; }
    if (message.method === 'tools/list') {
      repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, result: { tools: OUTILS_BANC } });
      return;
    }
    if (message.method === 'tools/call') {
      const nom = String(message.params?.name ?? '');
      outilsAppeles.push({ nom, arguments: message.params?.arguments });
      if (nom === 'get_slow') {
        // Plus long que le délai configuré côté test : doit produire un 504.
        await new Promise((r) => setTimeout(r, 2_000));
        repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, result: { content: [] } });
        return;
      }
      if (nom === 'get_garbage') {
        reponse.writeHead(200, { 'content-type': 'application/json' });
        reponse.end('ceci-n-est-pas-du-json');
        return;
      }
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { content: [{ type: 'text', text: `résultat réel de ${nom}` }] },
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
  // `close` est indispensable : l'abandon sur délai dépassé fait `destroy()`,
  // qui n'émet ni `end` ni `error`. Sans cet écouteur, une lecture en attente
  // ne se réveillerait jamais et le test resterait bloqué au lieu de mesurer
  // le délai.
  socket.on('end', () => { fini = true; signaler(); });
  socket.on('error', () => { fini = true; signaler(); });
  socket.on('close', () => { fini = true; signaler(); });
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
        await new Promise<void>((res) => { reveil = res; setTimeout(() => { if (reveil === res) { reveil = null; res(); } }, 5_000); });
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

function egressVersBanc(timeoutMs = 5_000): EgressDeps {
  return {
    resolveHost: async () => ['93.184.216.34'],
    connect: async () => pinnedSocket(await new Promise<Socket>((res, rej) => {
      const s = netConnect({ host: '127.0.0.1', port }, () => res(s));
      s.on('error', rej);
    })),
    timeoutMs,
  };
}

/** Connexion telle que la BASE la renverrait (jamais telle que le client la décrit). */
function connexion(partiel: Partial<ConnexionServeur> = {}): ConnexionServeur {
  return {
    id: SERVER_A,
    userId: USER_A,
    workspaceId: WS_A,
    name: 'Banc exécution',
    url: 'https://banc-execution.example/mcp',
    authKind: 'bearer',
    secretVaultName: `mcp_server_${SERVER_A}`,
    status: 'connected',
    revokedAt: null,
    outils: OUTILS_BANC,
    toolPermissions: { list_products: 'allowed', get_order: 'allowed' },
    ecrituresAutorisees: {},
    ...partiel,
  };
}

/**
 * Deux utilisateurs, deux connexions : la base simulée applique la MÊME règle
 * que le SQL réel — un serveur n'est visible que par son propriétaire.
 */
function base(connexions: ConnexionServeur[], secret: string | null = JETON) {
  const appels = { lireConnexion: vi.fn(), lireSecret: vi.fn() };
  const acces: AccesBase = {
    async lireConnexion({ userId, serverId }) {
      appels.lireConnexion();
      return connexions.find((c) => c.id === serverId && c.userId === userId) ?? null;
    },
    async lireSecret(vaultName) {
      appels.lireSecret();
      return vaultName.startsWith('mcp_server_') ? secret : null;
    },
  };
  return { acces, appels };
}

function deps(
  connexions: ConnexionServeur[] = [connexion()],
  options: { secret?: string | null; delaiMs?: number } = {},
): DependancesGestion & { appels: ReturnType<typeof base>['appels'] } {
  const { acces, appels } = base(connexions, options.secret === undefined ? JETON : options.secret);
  return {
    base: {} as DependancesGestion['base'],
    egress: egressVersBanc(),
    execution: {
      base: acces,
      egress: egressVersBanc(),
      ...(options.delaiMs !== undefined ? { delaiMs: options.delaiMs } : {}),
    },
    appels,
  };
}

function requete(route: string, corps: unknown, authorization: string | null = 'Bearer jwt-valide'): Request {
  const entetes: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== null) entetes.authorization = authorization;
  return new Request(`https://exemple.test/functions/v1/mcp-client/gestion/${route}`, {
    method: 'POST',
    headers: entetes,
    body: JSON.stringify(corps),
  });
}

const identiteA = async (auth: string) => (auth === 'Bearer jwt-valide' ? { userId: USER_A } : null);
const identiteB = async (auth: string) => (auth === 'Bearer jwt-b' ? { userId: USER_B } : null);

/**
 * Journal capturé sous forme de simples paires : on veut comparer le CONTENU
 * écrit, pas vérifier qu'une fonction mock a été appelée.
 */
let journalAppels: Array<[string, Record<string, unknown>]> = [];
const journaler = (message: string, details: Record<string, unknown>) => {
  journalAppels.push([message, details]);
};

beforeEach(() => {
  methodesRecues.length = 0;
  outilsAppeles.length = 0;
  journalAppels = [];
});

async function executer(
  corps: unknown,
  options: { deps?: ReturnType<typeof deps>; identite?: typeof identiteA; authorization?: string } = {},
) {
  const d = options.deps ?? deps();
  const reponse = await traiterRequeteGestion(
    requete('executer', corps, options.authorization ?? 'Bearer jwt-valide'),
    () => d,
    {
      originesSupplementaires: null,
      identite: options.identite ?? identiteA,
      journal: journaler,
    },
  );
  const texte = await reponse.text();
  return { statut: reponse.status, corps: texte ? JSON.parse(texte) : null, texte, d };
}

/* -------------------------------------------------------------------------- */

describe('exécution réelle d’un outil autorisé', () => {
  it('outil de lecture autorisé : 200, résultat réel du serveur distant', async () => {
    const { statut, corps } = await executer({
      serverId: SERVER_A,
      outil: 'list_products',
      arguments: { limit: 3 },
    });

    expect(statut).toBe(200);
    expect(corps.ok).toBe(true);
    expect(corps.isError).toBe(false);
    // La charge utile vient du serveur, pas d'une reconstruction locale.
    expect(JSON.stringify(corps.contenu)).toContain('résultat réel de list_products');

    // Le vrai `tools/call` a bien eu lieu, avec les arguments transmis.
    expect(outilsAppeles).toHaveLength(1);
    expect(outilsAppeles[0].nom).toBe('list_products');
    expect(outilsAppeles[0].arguments).toEqual({ limit: 3 });
  });

  it('la réponse ne contient jamais le secret utilisé pour l’appel', async () => {
    const { texte } = await executer({ serverId: SERVER_A, outil: 'list_products' });
    expect(texte).not.toContain(JETON);
    expect(texte).not.toContain('Bearer ');
  });

  it('le journal ne contient ni secret ni arguments', async () => {
    await executer({ serverId: SERVER_A, outil: 'list_products', arguments: { motDePasse: 'hunter2' } });
    const trace = JSON.stringify(journalAppels);
    expect(trace).not.toContain(JETON);
    expect(trace).not.toContain('hunter2');
    // Il journalise bien l'opération elle-même.
    expect(trace).toContain('list_products');
    expect(trace).toContain('ok');
  });
});

describe('refus AVANT tout appel réseau', () => {
  const cas: Array<[string, unknown, number, string]> = [
    ['outil inconnu', { serverId: SERVER_A, outil: 'outil_fantome' }, 404, 'outil_inconnu'],
    ['outil en attente (pending)', { serverId: SERVER_A, outil: 'get_order', }, 403, 'outil_non_autorise'],
    ['outil en écriture', { serverId: SERVER_A, outil: 'delete_order' }, 403, 'outil_non_autorise'],
  ];

  for (const [libelle, corps, statut, code] of cas) {
    it(`${libelle} : ${statut} ${code}, zéro octet vers le serveur`, async () => {
      // `get_order` est explicitement `pending` ici ; `delete_order` est refusé
      // parce qu'aucune autorisation d'écriture ne peut exister en base.
      const d = deps([connexion({ toolPermissions: { list_products: 'allowed', get_order: 'pending' } })]);
      const r = await executer(corps, { deps: d });
      expect(r.statut).toBe(statut);
      expect(r.corps.error).toBe(code);
      expect(methodesRecues).toEqual([]);
      expect(outilsAppeles).toEqual([]);
    });
  }

  it('connexion révoquée : 409 revoked, zéro appel', async () => {
    const d = deps([connexion({ status: 'revoked', revokedAt: '2026-11-01T00:00:00Z' })]);
    const r = await executer({ serverId: SERVER_A, outil: 'list_products' }, { deps: d });
    expect(r.statut).toBe(409);
    expect(r.corps.error).toBe('revoked');
    expect(methodesRecues).toEqual([]);
  });

  it('connexion jamais testée (unknown) : 409, zéro appel', async () => {
    const d = deps([connexion({ status: 'unknown' })]);
    const r = await executer({ serverId: SERVER_A, outil: 'list_products' }, { deps: d });
    expect(r.statut).toBe(409);
    expect(r.corps.error).toBe('connexion_indisponible');
    expect(methodesRecues).toEqual([]);
  });

  it('secret absent en base : 409 secret_manquant, zéro appel', async () => {
    const d = deps([connexion()], { secret: null });
    const r = await executer({ serverId: SERVER_A, outil: 'list_products' }, { deps: d });
    expect(r.statut).toBe(409);
    expect(r.corps.error).toBe('secret_manquant');
    expect(methodesRecues).toEqual([]);
  });

  it('un booléen d’écriture envoyé par le client est REFUSÉ, pas ignoré', async () => {
    const r = await executer({
      serverId: SERVER_A,
      outil: 'delete_order',
      ecritureAutorisee: true,
      confirmationEcriture: true,
    });
    expect(r.statut).toBe(400);
    expect(r.corps.error).toBe('champ_non_accepte');
    expect(methodesRecues).toEqual([]);
    expect(outilsAppeles).toEqual([]);
  });

  it('une permission transmise par le client ne peut pas élargir la base', async () => {
    // `get_order` est `pending` en base ; le client prétend `permission: allowed`.
    const d = deps([connexion({ toolPermissions: { list_products: 'allowed', get_order: 'pending' } })]);
    const r = await executer({ serverId: SERVER_A, outil: 'get_order', permission: 'allowed' }, { deps: d });
    expect(r.statut).toBe(400);
    expect(r.corps.error).toBe('champ_non_accepte');
    expect(methodesRecues).toEqual([]);
  });

  it('arguments invalides : 400 sans appel', async () => {
    const r = await executer({ serverId: SERVER_A, outil: 'list_products', arguments: ['pas', 'un', 'objet'] });
    expect(r.statut).toBe(400);
    expect(r.corps.error).toBe('arguments_invalides');
    expect(methodesRecues).toEqual([]);
  });

  it('sans jeton : 401, zéro lecture en base et zéro appel', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('executer', { serverId: SERVER_A, outil: 'list_products' }, null), () => d, {
      originesSupplementaires: null, identite: async () => null, journal: journaler,
    });
    expect(reponse.status).toBe(401);
    expect(d.appels.lireConnexion).not.toHaveBeenCalled();
    expect(methodesRecues).toEqual([]);
  });
});

describe('isolation entre utilisateurs et espaces de travail', () => {
  it('un autre utilisateur ne peut pas exécuter sur ma connexion : 404', async () => {
    const d = deps([connexion()]); // appartient à USER_A
    const r = await executer({ serverId: SERVER_A, outil: 'list_products' }, {
      deps: d, identite: identiteB, authorization: 'Bearer jwt-b',
    });
    expect(r.statut).toBe(404);
    expect(r.corps.error).toBe('server_not_found');
    expect(methodesRecues).toEqual([]);
  });

  it('deux utilisateurs, deux workspaces : chacun n’atteint que la sienne', async () => {
    const d = deps([
      connexion(),
      connexion({
        id: SERVER_B, userId: USER_B, workspaceId: WS_B,
        toolPermissions: { list_products: 'allowed' },
      }),
    ]);

    const pourB = await executer({ serverId: SERVER_B, outil: 'list_products' }, {
      deps: d, identite: identiteB, authorization: 'Bearer jwt-b',
    });
    expect(pourB.statut).toBe(200);
    expect(outilsAppeles).toHaveLength(1);

    // A ne peut pas viser le serveur de B, même en connaissant son identifiant.
    const pourA = await executer({ serverId: SERVER_B, outil: 'list_products' }, { deps: d, identite: identiteA });
    expect(pourA.statut).toBe(404);
  });
});

describe('le serveur distant se comporte mal', () => {
  it('délai d’attente dépassé : 504, pas 200 ni 500', async () => {
    const d = deps([connexion({ toolPermissions: { get_slow: 'allowed' } })], { delaiMs: 250 });
    const debut = Date.now();
    const r = await executer({ serverId: SERVER_A, outil: 'get_slow' }, { deps: d });
    // Le délai doit être respecté : on ne se contente pas du bon code, on
    // vérifie qu'on n'a pas attendu la réponse lente du serveur.
    expect(Date.now() - debut).toBeLessThan(2_000);
    expect(r.statut).toBe(504);
    expect(r.corps.error).toBe('timeout');
    // Le message ne doit pas divulguer d'URL interne ni de secret.
    expect(r.texte).not.toContain(JETON);
  }, 20_000);

  it('réponse illisible : erreur explicite, jamais un faux succès', async () => {
    const d = deps([connexion({ toolPermissions: { get_garbage: 'allowed' } })]);
    const r = await executer({ serverId: SERVER_A, outil: 'get_garbage' }, { deps: d });
    expect(r.statut).toBeGreaterThanOrEqual(400);
    expect(r.corps.ok).toBeUndefined();
    expect(r.texte).not.toContain(JETON);
  }, 20_000);
});
