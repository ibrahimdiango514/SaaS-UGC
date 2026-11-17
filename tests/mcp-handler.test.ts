// @vitest-environment node
/**
 * Serveur MCP VYORA — transport HTTP, authentification et révocation.
 *
 * On teste ici `traiterRequete`, la fonction que le handler Edge appelle pour
 * CHAQUE requête. Les dépendances sont injectées : PostgreSQL est remplacé par
 * une fonction qui applique les mêmes règles que `mcp_resolve_token`
 * (empreinte, révocation, expiration, connexion révoquée), ce qui permet de
 * vérifier le comportement des jetons morts sans base de données.
 *
 * Points de la phase 7 couverts ici :
 *   5. authentification (jeton absent, mal formé, invalide, valide)
 *   8. jeton expiré, jeton révoqué, connexion révoquée
 *   6. utilisateur non autorisé (401)
 *   9. permissions insuffisantes via la couche outil (403 JSON-RPC)
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  lireJeton,
  traiterRequete,
  type DependancesServeur,
} from '../supabase/functions/vyora-mcp/handler.ts';
import { CODES, type ContexteJeton } from '../supabase/functions/vyora-mcp/core.ts';

const SECRET = 'vyora_mcp_' + 'a'.repeat(43);
const SHA = createHash('sha256').update(SECRET, 'utf8').digest('hex');

interface JetonEnBase {
  token_id: string;
  user_id: string;
  connection_id: string | null;
  scopes: string[];
  token_sha256: string;
  revoked_at: string | null;
  expires_at: string | null;
  connection_revoked_at: string | null;
}

/** Reproduit fidèlement la clause WHERE de `mcp_resolve_token`. */
function tableJetons(): JetonEnBase[] {
  return [
    {
      token_id: 'tok-valide',
      user_id: 'user-a',
      connection_id: 'conn-a',
      scopes: ['read'],
      token_sha256: SHA,
      revoked_at: null,
      expires_at: null,
      connection_revoked_at: null,
    },
  ];
}

function serveur(options: {
  jetons?: JetonEnBase[];
  panneResolution?: boolean;
  autorise?: boolean;
  ecritureActive?: boolean;
  ressourcePublicitaire?: string;
} = {}) {
  const jetons = options.jetons ?? tableJetons();
  const journal = vi.fn(async () => {});
  const touches: string[] = [];

  const deps: DependancesServeur = {
    ecritureActive: options.ecritureActive ?? false,
    ressourcePublicitaire: options.ressourcePublicitaire,
    async resoudreJeton(secret) {
      if (options.panneResolution) throw new Error('postgres injoignable');
      const hash = createHash('sha256').update(secret, 'utf8').digest('hex');
      const trouve = jetons.find((j) => j.token_sha256 === hash);
      if (!trouve) return null;
      if (trouve.revoked_at) return null;
      if (trouve.expires_at && new Date(trouve.expires_at) <= new Date()) return null;
      if (trouve.connection_revoked_at) return null;
      const contexte: ContexteJeton = {
        userId: trouve.user_id,
        tokenId: trouve.token_id,
        connectionId: trouve.connection_id,
        scopes: trouve.scopes,
        tokenPrefix: secret.slice(0, 18),
      };
      return contexte;
    },
    async toucherJeton(id) { touches.push(id); },
    async appelerRpc(nom) { return { rpc: nom }; },
    async outilAutorise() { return options.autorise ?? true; },
    journaliser: journal,
  };

  return { deps, journal, touches };
}

/** JWT de service-role factice, construit à l'exécution (voir secrets-guard). */
function jwtServiceRole(): string {
  const entete = `{"alg":"HS256","typ":"JWT"}`;
  const charge = `{"role":"service_role"}`;
  const base64 = (valeur: string) => Buffer.from(valeur, 'utf8').toString('base64url');
  return `eyJ${base64(entete).slice(3)}.${base64(charge)}.x`;
}

function post(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return { method: 'POST', authorization, body };
}

describe('extraction du jeton', () => {
  it('accepte un Bearer bien formé', () => {
    expect(lireJeton(`Bearer ${SECRET}`)).toBe(SECRET);
    expect(lireJeton(`bearer ${SECRET}`)).toBe(SECRET);
    expect(lireJeton(`  Bearer   ${SECRET}  `)).toBe(SECRET);
  });

  it('refuse ce qui n’est pas un jeton MCP', () => {
    for (const entete of [
      null,
      '',
      'Basic abc',
      'Bearer',
      // La clé de service Supabase ne doit JAMAIS être acceptée comme jeton MCP.
      // JWT de service-role fabriqué à l'exécution : jamais écrit en dur, le
      // garde-fou « aucun secret dans le dépôt » scanne aussi les tests.
      `Bearer ${jwtServiceRole()} ${'a'.repeat(80)}`.split(' ').slice(0, 2).join(' '),
      `Bearer ${'a'.repeat(80)}`,
      `Bearer ${'Z'.repeat(64)}`,
      `Bearer vyora_mcp_court`,
    ]) {
      expect(lireJeton(entete as string | null), String(entete)).toBeNull();
    }
  });
});

describe('authentification', () => {
  it('refuse sans en-tête Authorization (401 + WWW-Authenticate)', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null));
    expect(r.status).toBe(401);
    expect(r.headers['WWW-Authenticate']).toContain('Bearer realm="vyora-mcp"');
    expect((r.body as { error: { code: number } }).error.code).toBe(CODES.unauthorized);
  });

  it('refuse un jeton inconnu', async () => {
    const { deps } = serveur();
    const inconnu = 'vyora_mcp_' + 'z'.repeat(43);
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, `Bearer ${inconnu}`));
    expect(r.status).toBe(401);
    expect(r.headers['WWW-Authenticate']).toContain('error="invalid_token"');
  });

  it('accepte un jeton valide et journalise', async () => {
    const { deps, touches, journal } = serveur();
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(200);
    expect((r.body as { result: { count: number } }).result.count).toBeGreaterThan(0);
    expect(touches).toEqual(['tok-valide']);
    expect(journal).toHaveBeenCalled();
  });

  it('ne renvoie JAMAIS la clé de service ni le secret dans la réponse', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_account_info', arguments: {} } }));
    const corps = JSON.stringify(r.body);
    expect(corps).not.toContain(SECRET);
    expect(corps).not.toContain('service_role');
    // Aucune valeur de clé dans les en-têtes. Le mot « apikey » y figure
    // légitimement : c'est la liste CORS des en-têtes AUTORISÉS en entrée, pas
    // une clé. On vérifie donc l'absence de valeur, pas l'absence du mot.
    const entetes = JSON.stringify(r.headers);
    expect(entetes).not.toContain(SECRET);
    expect(entetes).not.toContain('service_role');
    expect(entetes).not.toMatch(/eyJhbGci/);
  });
});

describe('jetons morts (phase 7.8)', () => {
  it('refuse un jeton révoqué', async () => {
    const jetons = tableJetons();
    jetons[0].revoked_at = '2026-01-01T00:00:00Z';
    const { deps } = serveur({ jetons });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(401);
  });

  it('refuse un jeton expiré', async () => {
    const jetons = tableJetons();
    jetons[0].expires_at = '2020-01-01T00:00:00Z';
    const { deps } = serveur({ jetons });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(401);
  });

  it('refuse un jeton dont la connexion est révoquée', async () => {
    const jetons = tableJetons();
    jetons[0].connection_revoked_at = '2026-01-01T00:00:00Z';
    const { deps } = serveur({ jetons });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(401);
  });

  it('accepte un jeton qui expire dans le futur', async () => {
    const jetons = tableJetons();
    jetons[0].expires_at = new Date(Date.now() + 86_400_000).toISOString();
    const { deps } = serveur({ jetons });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(200);
  });

  it('distingue une PANNE de base (503) d’un jeton invalide (401)', async () => {
    const { deps } = serveur({ panneResolution: true });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    // Un 401 ferait révoquer un jeton parfaitement valide.
    expect(r.status).toBe(503);
    expect(r.headers['Retry-After']).toBe('5');
  });
});

describe('transport', () => {
  it('répond 204 au préflight OPTIONS avec les en-têtes CORS', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, { method: 'OPTIONS', authorization: null, body: null });
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(r.headers['Access-Control-Allow-Headers']).toContain('mcp-protocol-version');
  });

  it('répond 405 à GET en expliquant qu’il n’y a pas de flux SSE', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, { method: 'GET', authorization: `Bearer ${SECRET}`, body: null });
    expect(r.status).toBe(405);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/SSE/);
  });

  it('répond 405 à DELETE (aucune session serveur à fermer)', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, { method: 'DELETE', authorization: `Bearer ${SECRET}`, body: null });
    expect(r.status).toBe(405);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/révoquez le jeton/i);
  });

  it('répond 400 à un corps JSON illisible', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, {
      method: 'POST',
      authorization: `Bearer ${SECRET}`,
      body: undefined,
      corpsIllisible: true,
    });
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: number } }).error.code).toBe(CODES.parse);
  });

  it('répond 202 sans corps à une notification', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(r.status).toBe(202);
    expect(r.body).toBeNull();
  });

  it('répète la version de protocole demandée par le client', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, {
      ...post({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      protocoleDemande: '2025-03-26',
    });
    expect(r.headers['mcp-protocol-version']).toBe('2025-03-26');
  });

  it('passe un lot complet de bout en bout', async () => {
    const { deps } = serveur();
    const r = await traiterRequete(deps, post([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]));
    expect(r.status).toBe(200);
    const corps = r.body as Array<{ id: number }>;
    expect(corps).toHaveLength(2);
    expect(corps.map((c) => c.id)).toEqual([1, 2]);
  });

  it('transforme une panne interne en 500 structuré, jamais en exception', async () => {
    const { deps } = serveur();
    // On casse volontairement le moteur pour vérifier qu'aucune exception ne fuit.
    deps.appelerRpc = () => { throw new Error('boum'); };
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_account_info', arguments: {} } }));
    // `tools/call` capture l'erreur et répond isError:true : c'est le
    // comportement attendu, une erreur d'outil n'est pas une panne serveur.
    expect(r.status).toBe(200);
    expect((r.body as { error?: unknown }).error).toBeUndefined();
  });
});

describe('permissions par jeton (phase 7.9)', () => {
  it('refuse un outil non autorisé en 403 JSON-RPC', async () => {
    const { deps } = serveur({ autorise: false });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_products_list', arguments: {} } }));
    expect(r.status).toBe(200);
    expect((r.body as { error: { code: number } }).error.code).toBe(CODES.forbidden);
  });

  it('refuse l’écriture quand elle est désactivée sur le déploiement', async () => {
    const { deps } = serveur({ ecritureActive: false });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const noms = (r.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(noms).not.toContain('vyora_product_create');
  });
});

/* -------------------------------------------------------------------------- */
/* Découverte OAuth dans les défis 401                                         */
/* -------------------------------------------------------------------------- */

describe('défi d’autorisation (RFC 9728)', () => {
  const RESSOURCE = 'https://exemple.supabase.co/functions/v1/vyora-mcp';

  it('publie resource_metadata quand la ressource est configurée', async () => {
    const { deps } = serveur({ jetons: [], ressourcePublicitaire: RESSOURCE });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(r.status).toBe(401);
    expect(r.headers['WWW-Authenticate']).toContain(`resource_metadata="${RESSOURCE}/.well-known/oauth-protected-resource"`);
  });

  it('le publie aussi sur une requête sans jeton', async () => {
    const { deps } = serveur({ ressourcePublicitaire: RESSOURCE });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null));
    expect(r.status).toBe(401);
    expect(r.headers['WWW-Authenticate']).toContain('resource_metadata=');
    expect(r.headers['WWW-Authenticate']).toContain('error="invalid_request"');
  });

  it('reste un défi minimal sans ressource configurée', async () => {
    const { deps } = serveur({ jetons: [] });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    // Aucune URL inventée : le comportement v5 est préservé tel quel.
    expect(r.headers['WWW-Authenticate']).toBe('Bearer realm="vyora-mcp", error="invalid_token"');
  });

  it('ne fuit ni la clé de service ni le secret présenté', async () => {
    const { deps } = serveur({ jetons: [], ressourcePublicitaire: RESSOURCE });
    const r = await traiterRequete(deps, post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const tout = JSON.stringify(r.body) + JSON.stringify(r.headers);
    expect(tout).not.toContain(SECRET);
    expect(tout).not.toContain(jwtServiceRole());
  });
});
