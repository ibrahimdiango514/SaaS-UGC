import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import {
  connexionUtilisable,
  executerOutilExterne,
  permissionDepuisBase,
  statutHttp,
  type AccesBase,
  type ConnexionServeur,
  type DependancesP5,
} from '../supabase/functions/mcp-client/execution';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';

/**
 * P5 — la porte d'exécution refuse-t-elle AVANT le réseau ?
 *
 * Ce fichier lance un VRAI serveur MCP local (JSON-RPC sur HTTP) et compte
 * chaque `tools/call` qu'il reçoit. C'est la seule façon de prouver la propriété
 * demandée : « refus côté serveur avant l'appel réseau ». Un test qui se
 * contenterait de vérifier le code de retour ne prouverait pas que rien n'est
 * parti.
 */

const JETON = 'jeton-p5-0123456789';

interface Etat { appelsRecus: string[]; toolsList: number }

let serveur: Server;
let port = 0;
const etat: Etat = { appelsRecus: [], toolsList: 0 };

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

    if (requete.method !== 'POST') { reponse.writeHead(405).end(); return; }
    if (requete.headers.authorization !== `Bearer ${JETON}`) {
      repondre(reponse, { error: 'invalid_token' }, 401);
      return;
    }
    if (message.method === 'initialize') {
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'banc-p5', version: '1' } },
      }, 200, { 'mcp-session-id': 'sess-p5' });
      return;
    }
    if (message.method === 'notifications/initialized') { reponse.writeHead(202).end(); return; }
    if (message.method === 'tools/list') {
      etat.toolsList += 1;
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: {
          tools: [
            { name: 'list_products', description: 'Liste les produits.', inputSchema: { type: 'object' } },
            { name: 'delete_product', description: 'Supprime un produit.', inputSchema: { type: 'object' } },
          ],
        },
      });
      return;
    }
    if (message.method === 'tools/call') {
      const nom = String(message.params?.name ?? '');
      etat.appelsRecus.push(nom);
      repondre(reponse, {
        jsonrpc: '2.0', id: message.id ?? null,
        result: { content: [{ type: 'text', text: 'ok' }], isError: false },
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

/**
 * Socket de test fidèle : tampon persistant, `close()` débloque la lecture.
 * (Les deux pièges rencontrés sur le banc P4, corrigés une fois pour toutes.)
 */
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

function connexion(partiel: Partial<ConnexionServeur> = {}): ConnexionServeur {
  return {
    id: 'srv-1',
    userId: 'user-a',
    workspaceId: 'ws-a',
    name: 'Boutique',
    url: 'https://banc-p5.example/mcp',
    authKind: 'bearer',
    secretVaultName: 'mcp_server_srv-1',
    status: 'connected',
    revokedAt: null,
    outils: [
      { name: 'list_products', description: 'Liste les produits.' },
      { name: 'delete_product', description: 'Supprime un produit.' },
    ],
    toolPermissions: { list_products: 'allowed', delete_product: 'allowed' },
    ecrituresAutorisees: {},
    ...partiel,
  };
}

function deps(partiel: {
  connexion?: ConnexionServeur | null;
  secret?: string | null;
}): DependancesP5 & { lecture: ReturnType<typeof vi.fn> } {
  const lecture = vi.fn(async () => partiel.connexion === undefined ? connexion() : partiel.connexion);
  const base: AccesBase = {
    lireConnexion: lecture as unknown as AccesBase['lireConnexion'],
    lireSecret: async () => (partiel.secret === undefined ? JETON : partiel.secret),
  };
  return { base, egress: egressVersBanc(), lecture };
}

const APPELANT = { userId: 'user-a' };

describe('P5 — refus AVANT le réseau (vrai serveur MCP, compteur côté serveur)', () => {
  it('outil de lecture autorisé : l’appel part réellement et réussit', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'list_products' },
      APPELANT,
      deps({}),
    );
    expect(r.ok).toBe(true);
    expect(etat.appelsRecus).toEqual(['list_products']);
  });

  it('écriture autorisée en base MAIS non confirmée : refus, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'delete_product' },
      APPELANT,
      deps({ connexion: connexion({ ecrituresAutorisees: { delete_product: true } }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ecriture_non_confirmee');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('écriture confirmée par le client SANS autorisation en base : refus, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'delete_product', confirmationEcriture: true },
      APPELANT,
      deps({ connexion: connexion({ ecrituresAutorisees: {} }) }),
    );
    expect(r.ok).toBe(false);
    // `deciderAppel` refuse : la confirmation ponctuelle ne remplace pas
    // l'autorisation persistée. Le code le dit explicitement.
    expect(r.code).toBe('ecriture_desactivee');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('écriture autorisée en base ET confirmée : l’appel part', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'delete_product', confirmationEcriture: true },
      APPELANT,
      deps({ connexion: connexion({ ecrituresAutorisees: { delete_product: true } }) }),
    );
    expect(r.ok).toBe(true);
    expect(etat.appelsRecus).toEqual(['delete_product']);
  });

  it('permission absente de la base : refus (fail-closed), zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'list_products' },
      APPELANT,
      deps({ connexion: connexion({ toolPermissions: {} }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('outil_non_autorise');
    expect(etat.appelsRecus).toEqual([]);
  });

  it.each(['pending', 'denied', 'ALLOWED', 1, null, {}])(
    'permission %s n’autorise pas',
    async (valeur) => {
      etat.appelsRecus.length = 0;
      const r = await executerOutilExterne(
        { serverId: 'srv-1', outil: 'list_products' },
        APPELANT,
        deps({ connexion: connexion({ toolPermissions: { list_products: valeur } }) }),
      );
      expect(r.ok).toBe(false);
      expect(etat.appelsRecus).toEqual([]);
    },
  );

  it('outil jamais découvert : refus, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'drop_database' },
      APPELANT,
      deps({}),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('outil_inconnu');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('connexion révoquée : refus, zéro appel, aucun secret lu', async () => {
    etat.appelsRecus.length = 0;
    const d = deps({ connexion: connexion({ status: 'revoked', revokedAt: '2026-11-21T00:00:00Z' }) });
    const lireSecret = vi.fn(async () => JETON);
    d.base.lireSecret = lireSecret as unknown as AccesBase['lireSecret'];

    const r = await executerOutilExterne({ serverId: 'srv-1', outil: 'list_products' }, APPELANT, d);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('revoked');
    expect(lireSecret).not.toHaveBeenCalled();
    expect(etat.appelsRecus).toEqual([]);
  });

  it('connexion jamais testée (unknown) : refus, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'list_products' },
      APPELANT,
      deps({ connexion: connexion({ status: 'unknown' }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('connexion_indisponible');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('connexion d’un AUTRE utilisateur : introuvable, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    // `lireConnexion` est filtrée par user_id en base ; ici on simule le
    // résultat réel de cette lecture : aucune ligne.
    const r = await executerOutilExterne(
      { serverId: 'srv-autre', outil: 'list_products' },
      { userId: 'user-b' },
      deps({ connexion: null }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('server_not_found');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('secret introuvable dans Vault : refus, zéro appel', async () => {
    etat.appelsRecus.length = 0;
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'list_products' },
      APPELANT,
      deps({ secret: null }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('secret_manquant');
    expect(etat.appelsRecus).toEqual([]);
  });

  it('serveur sans authentification : aucun en-tête ajouté', async () => {
    // Le banc P5 exige un jeton : on vérifie ici que `none` n'envoie rien,
    // donc que le banc répond 401 — preuve indirecte qu'aucun en-tête n'est
    // inventé par la couche.
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'list_products' },
      APPELANT,
      deps({ connexion: connexion({ authKind: 'none', secretVaultName: null }) }),
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe('authentification');
  });

  it('le secret n’apparaît dans aucune réponse de refus', async () => {
    const r = await executerOutilExterne(
      { serverId: 'srv-1', outil: 'delete_product' },
      APPELANT,
      deps({}),
    );
    expect(JSON.stringify(r)).not.toContain(JETON);
  });
});

describe('P5 — helpers purs', () => {
  it('permissionDepuisBase : tout ce qui n’est pas « allowed » est refusé', () => {
    expect(permissionDepuisBase({ o: 'allowed' }, {}, 'o').etat).toBe('allowed');
    expect(permissionDepuisBase({ o: 'pending' }, {}, 'o').etat).toBe('pending');
    expect(permissionDepuisBase({ o: 'denied' }, {}, 'o').etat).toBe('denied');
    expect(permissionDepuisBase({}, {}, 'o').etat).toBe('denied');
    expect(permissionDepuisBase({ o: 'Allowed' }, {}, 'o').etat).toBe('denied');
    expect(permissionDepuisBase({ o: true }, {}, 'o').etat).toBe('denied');
  });

  it('permissionDepuisBase : l’autorisation d’écriture exige strictement true', () => {
    expect(permissionDepuisBase({ o: 'allowed' }, { o: true }, 'o').ecritureAutorisee).toBe(true);
    expect(permissionDepuisBase({ o: 'allowed' }, { o: 'true' }, 'o').ecritureAutorisee).toBe(false);
    expect(permissionDepuisBase({ o: 'allowed' }, { o: 1 }, 'o').ecritureAutorisee).toBe(false);
  });

  it('connexionUtilisable : seul « connected » non révoqué passe', () => {
    expect(connexionUtilisable(connexion())).toBe(true);
    expect(connexionUtilisable(connexion({ status: 'error' }))).toBe(false);
    expect(connexionUtilisable(connexion({ status: 'auth_required' }))).toBe(false);
    expect(connexionUtilisable(connexion({ revokedAt: '2026-01-01' }))).toBe(false);
  });

  it('statutHttp : refus d’autorisation en 403, jamais en 200', () => {
    expect(statutHttp('outil_non_autorise')).toBe(403);
    expect(statutHttp('ecriture_non_confirmee')).toBe(403);
    expect(statutHttp('revoked')).toBe(409);
    expect(statutHttp('server_not_found')).toBe(404);
    expect(statutHttp('authentification')).toBe(401);
  });
});
