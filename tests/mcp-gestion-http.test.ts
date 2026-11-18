import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { traiterRequeteGestion } from '../supabase/functions/mcp-client/gestion-http';
import type { AccesGestion, DependancesGestion, ServeurGere } from '../supabase/functions/mcp-client/gestion-serveur';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * Routes de gestion MCP — bout en bout contre un VRAI serveur MCP local.
 *
 * Le compteur `tools/call` du serveur de banc vérifie qu'un test de connexion
 * ne fait que `initialize` + `tools/list`, jamais d'exécution d'outil.
 */

const JETON = 'jeton-gestion-0123456789';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const SERVER_ID = '33333333-3333-3333-3333-333333333333';
const WS_ID = '44444444-4444-4444-4444-444444444444';

let serveur: Server;
let port = 0;
const methodesRecues: string[] = [];

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
    const message = JSON.parse(corps) as { id?: number; method?: string };
    methodesRecues.push(String(message.method));
    if (requete.headers.authorization !== `Bearer ${JETON}`) { repondre(reponse, { error: 'invalid_token' }, 401); return; }
    if (message.method === 'initialize') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'banc-gestion', version: '1' } },
      }, 200, { 'mcp-session-id': 'sess-gestion' });
      return;
    }
    if (message.method === 'notifications/initialized') { reponse.writeHead(202).end(); return; }
    if (message.method === 'tools/list') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { tools: [
          { name: 'list_products', description: 'Liste les produits.' },
          { name: 'get_order', description: 'Lit une commande.' },
        ] },
      });
      return;
    }
    if (message.method === 'tools/call') {
      repondre(reponse, { jsonrpc: '2.0', id: message.id ?? null, result: { content: [{ type: 'text', text: 'appel!' }] } });
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

function serveurGere(partiel: Partial<ServeurGere> = {}): ServeurGere {
  return {
    id: SERVER_ID,
    workspaceId: WS_ID,
    nom: 'Serveur de banc',
    url: 'https://banc-gestion.example/mcp',
    authKind: 'bearer',
    aSecret: true,
    status: 'connected',
    protocolVersion: '2025-06-18',
    serverName: 'banc-gestion',
    serverVersion: '1',
    outils: [{ name: 'list_products', description: 'Liste les produits.' }, { name: 'get_order' }],
    toolPermissions: { list_products: 'allowed', get_order: 'pending' },
    dernierTestAt: null,
    derniereErreur: null,
    createdAt: '2026-11-21T00:00:00Z',
    revokedAt: null,
    ...partiel,
  };
}

/** Faux accès base qui trace tous les appels — pour prouver les « zéro appel ». */
function acces(partiel: Partial<AccesGestion> = {}) {
  const appels = {
    lister: vi.fn(async () => [serveurGere()]),
    lire: vi.fn(async () => serveurGere() as ServeurGere | null),
    creer: vi.fn(async () => ({ serverId: SERVER_ID })),
    decouverte: vi.fn(async () => undefined),
    permission: vi.fn(async () => ({ list_products: 'allowed' })),
    revoquer: vi.fn(async () => true),
    secret: vi.fn(async () => JETON as string | null),
  };
  const base: AccesGestion = {
    listerServeurs: appels.lister as unknown as AccesGestion['listerServeurs'],
    lireServeur: appels.lire as unknown as AccesGestion['lireServeur'],
    creerServeur: appels.creer as unknown as AccesGestion['creerServeur'],
    enregistrerDecouverte: appels.decouverte as unknown as AccesGestion['enregistrerDecouverte'],
    definirPermission: appels.permission as unknown as AccesGestion['definirPermission'],
    revoquer: appels.revoquer as unknown as AccesGestion['revoquer'],
    lireSecret: appels.secret as unknown as AccesGestion['lireSecret'],
    ...partiel,
  };
  return { base, appels };
}

function deps(partiel: Partial<AccesGestion> = {}): DependancesGestion & { appels: ReturnType<typeof acces>['appels'] } {
  const { base, appels } = acces(partiel);
  return { base, egress: egressVersBanc(), appels };
}

function requete(
  route: string,
  corps: unknown,
  options: { authorization?: string | null; methode?: string; origine?: string | null } = {},
): Request {
  const entetes: Record<string, string> = { 'content-type': 'application/json' };
  const auto = options.authorization === undefined ? 'Bearer jwt-valide' : options.authorization;
  if (auto !== null) entetes.authorization = auto;
  if (options.origine) entetes.origin = options.origine;
  return new Request(`https://exemple.test/functions/v1/mcp-client/gestion/${route}`, {
    method: options.methode ?? 'POST',
    headers: entetes,
    ...(options.methode === 'OPTIONS' || options.methode === 'GET'
      ? {}
      : { body: typeof corps === 'string' ? corps : JSON.stringify(corps) }),
  });
}

const identiteA = async (auth: string) => (auth === 'Bearer jwt-valide' ? { userId: USER_A } : null);
const silence = () => {};

beforeEach(() => { methodesRecues.length = 0; });

/* -------------------------------------------------------------------------- */

describe('refus AVANT toute lecture en base', () => {
  it('sans jeton : 401 et zéro accès base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('lister', {}, { authorization: null }), () => d, {
      originesSupplementaires: null, identite: async () => null, journal: silence,
    });
    expect(reponse.status).toBe(401);
    expect(d.appels.lister).not.toHaveBeenCalled();
  });

  it('jeton invalide : 401 et zéro accès base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('creer', {}, { authorization: 'Bearer faux' }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(401);
    expect(d.appels.creer).not.toHaveBeenCalled();
  });

  it('méthode autre que POST : 405, zéro accès base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('lister', null, { methode: 'GET' }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(405);
    expect(d.appels.lister).not.toHaveBeenCalled();
  });

  it('corps illisible : 400, zéro accès base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('creer', '{pas du json'), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(400);
    expect(d.appels.creer).not.toHaveBeenCalled();
  });

  it('route inconnue sous /gestion/ : 404 explicite', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('inconnue', {}), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(404);
    const corps = await reponse.json() as { error: string };
    expect(corps.error).toBe('route_inconnue');
  });

  it('création invalide : refusée sans toucher la base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('creer', { workspaceId: WS_ID, nom: 'X', url: 'http://insecure.example/mcp', authKind: 'none' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(400);
    expect(d.appels.creer).not.toHaveBeenCalled();
  });
});

describe('isolation entre utilisateurs', () => {
  it('lister ne demande QUE les serveurs de l’identité GoTrue', async () => {
    const d = deps();
    await traiterRequeteGestion(requete('lister', {}), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(d.appels.lister).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));
  });

  it('un userId dans le corps est IGNORÉ', async () => {
    const d = deps();
    await traiterRequeteGestion(requete('lister', { userId: USER_B, user_id: USER_B }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    const argument = (d.appels.lister as unknown as { mock: { calls: [{ userId: string }][] } }).mock.calls[0][0];
    expect(argument.userId).toBe(USER_A);
    expect(argument.userId).not.toBe(USER_B);
  });

  it('tester un serveur d’un autre compte : 404 et zéro appel secret', async () => {
    const d = deps({ lireServeur: async () => null });
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(404);
    expect(d.appels.secret).not.toHaveBeenCalled();
    expect(methodesRecues).toHaveLength(0);
  });

  it('révoquer un serveur d’un autre compte : 404', async () => {
    const d = deps({ revoquer: async () => false });
    const reponse = await traiterRequeteGestion(requete('revoquer', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(404);
  });

  it('permission sur un serveur d’un autre compte : 404', async () => {
    const d = deps({ lireServeur: async () => null });
    const reponse = await traiterRequeteGestion(
      requete('permissions', { serverId: SERVER_ID, outil: 'list_products', etat: 'allowed' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(404);
    expect(d.appels.permission).not.toHaveBeenCalled();
  });
});

describe('création', () => {
  it('crée et ne renvoie JAMAIS le secret', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('creer', {
        workspaceId: WS_ID, nom: 'Serveur', url: 'https://exemple.example/mcp',
        authKind: 'bearer', secret: 'secret-ultra-sensible-0123456789',
      }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(201);
    const texte = await reponse.text();
    expect(texte).not.toContain('secret-ultra-sensible');
    expect(texte).toContain(USER_A === USER_A ? 'serverId' : '');
  });

  it('transmet le secret à la base (qui le dépose dans Vault), pas ailleurs', async () => {
    const d = deps();
    await traiterRequeteGestion(
      requete('creer', {
        workspaceId: WS_ID, nom: 'Serveur', url: 'https://exemple.example/mcp',
        authKind: 'api_key', secret: 'k-123456',
      }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(d.appels.creer).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_A,
      authKind: 'api_key',
      secret: 'k-123456',
    }));
  });

  it('traduit workspace_forbidden en 403 lisible', async () => {
    const d = deps({ creerServeur: async () => { throw new Error('workspace_forbidden'); } });
    const reponse = await traiterRequeteGestion(
      requete('creer', { workspaceId: WS_ID, nom: 'S', url: 'https://e.example/mcp', authKind: 'none' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(403);
    const corps = await reponse.json() as { error: string };
    expect(corps.error).toBe('workspace_forbidden');
  });
});

describe('test de connexion — découverte réelle', () => {
  it('découvre les outils sans en exécuter un seul', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(200);
    const corps = await reponse.json() as { ok: boolean; outils: { name: string }[] };
    expect(corps.ok).toBe(true);
    expect(corps.outils.map((o) => o.name)).toEqual(['list_products', 'get_order']);

    // Le cœur de la garantie : un test ne fait QUE initialize + tools/list.
    expect(methodesRecues).toContain('initialize');
    expect(methodesRecues).toContain('tools/list');
    expect(methodesRecues).not.toContain('tools/call');
  });

  it('la découverte est persistée, et le secret n’apparaît nulle part', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    const texte = await reponse.text();
    expect(texte).not.toContain(JETON);
    expect(d.appels.decouverte).toHaveBeenCalled();
    const appel = (d.appels.decouverte as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(appel).toMatchObject({ userId: USER_A, serverId: SERVER_ID, status: 'connected' });
  });

  it('secret absent : 409 AVANT tout réseau', async () => {
    const d = deps();
    (d.base as { lireSecret: unknown }).lireSecret = async () => null;
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(409);
    const corps = await reponse.json() as { error: string };
    expect(corps.error).toBe('secret_manquant');
    expect(methodesRecues).toHaveLength(0);
  });

  it('connexion révoquée : 409 AVANT tout réseau', async () => {
    const d = deps({ lireServeur: async () => serveurGere({ status: 'revoked', revokedAt: '2026-11-21T00:00:00Z' }) });
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(409);
    expect(methodesRecues).toHaveLength(0);
    expect(d.appels.secret).not.toHaveBeenCalled();
  });

  it('serveur distant injoignable : 502 lisible, pas 500', async () => {
    const d = deps();
    d.egress = { resolveHost: async () => { throw new Error('dns'); }, connect: async () => { throw new Error('x'); }, timeoutMs: 1000 };
    const reponse = await traiterRequeteGestion(requete('tester', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(502);
    const corps = await reponse.json() as { ok: boolean };
    expect(corps.ok).toBe(false);
  });
});

describe('permissions', () => {
  it('accorde un outil réellement découvert', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('permissions', { serverId: SERVER_ID, outil: 'list_products', etat: 'allowed' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(200);
    expect(d.appels.permission).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_A, serverId: SERVER_ID, outil: 'list_products', etat: 'allowed',
    }));
  });

  it('refuse un outil non découvert, sans toucher la base', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('permissions', { serverId: SERVER_ID, outil: 'delete_all', etat: 'allowed' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.status).toBe(404);
    expect(d.appels.permission).not.toHaveBeenCalled();
  });

  it('aucun champ d’écriture ne traverse', async () => {
    const d = deps();
    await traiterRequeteGestion(
      requete('permissions', {
        serverId: SERVER_ID, outil: 'list_products', etat: 'allowed',
        ecritureAutorisee: true, ecriture_autorisee: true,
      }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    const appel = (d.appels.permission as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(Object.keys(appel).sort()).toEqual(['etat', 'outil', 'serverId', 'userId']);
    expect(JSON.stringify(appel)).not.toContain('ecriture');
  });
});

describe('révocation', () => {
  it('révoque et répond sans détail interne', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(requete('revoquer', { serverId: SERVER_ID }), () => d, {
      originesSupplementaires: null, identite: identiteA, journal: silence,
    });
    expect(reponse.status).toBe(200);
    expect(await reponse.json()).toEqual({ ok: true });
    expect(d.appels.revoquer).toHaveBeenCalledWith({ userId: USER_A, serverId: SERVER_ID });
  });
});

describe('CORS', () => {
  it('une origine du dépôt est autorisée', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('lister', {}, { origine: 'https://vyora-ugc.netlify.app' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.headers.get('access-control-allow-origin')).toBe('https://vyora-ugc.netlify.app');
  });

  it('une origine inconnue reçoit null, jamais *', async () => {
    const d = deps();
    const reponse = await traiterRequeteGestion(
      requete('lister', {}, { origine: 'https://attaquant.example' }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: silence },
    );
    expect(reponse.headers.get('access-control-allow-origin')).toBe('null');
  });
});

describe('journal', () => {
  it('ne contient jamais le secret fourni', async () => {
    const lignes: Record<string, unknown>[] = [];
    const d = deps();
    await traiterRequeteGestion(
      requete('creer', {
        workspaceId: WS_ID, nom: 'S', url: 'https://e.example/mcp',
        authKind: 'bearer', secret: 'secret-a-ne-jamais-journaliser',
      }),
      () => d,
      { originesSupplementaires: null, identite: identiteA, journal: (_m, details) => lignes.push(details) },
    );
    expect(JSON.stringify(lignes)).not.toContain('secret-a-ne-jamais-journaliser');
  });
});
