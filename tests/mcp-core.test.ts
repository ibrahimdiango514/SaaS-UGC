// @vitest-environment node
/**
 * Serveur MCP SORAHNEX — tests de protocole.
 *
 * Ces tests exercent le VRAI moteur JSON-RPC (`core.ts`), celui que le handler
 * Edge branche sur HTTP. Ce ne sont pas des mocks du protocole : on envoie des
 * requêtes JSON-RPC complètes et on vérifie les réponses.
 *
 * Couverture exigée par la phase 7 de la mission :
 *   1. initialisation MCP                → `initialize`
 *   2. négociation du protocole          → versions acceptées / repli
 *   3. liste des outils                  → `tools/list`
 *   4. appel d'un outil                  → `tools/call`
 *   5. authentification                  → jeton résolu par le handler (voir
 *                                          `mcp-handler.test.ts`)
 *   6. utilisateur non autorisé           → portée manquante, outil refusé
 *   7. isolation entre deux utilisateurs  → le `userId` du jeton est le seul
 *                                          utilisé, jamais celui du client
 *   8. jeton expiré ou révoqué            → `resolveToken` → null (handler)
 *   9. permissions insuffisantes          → `isToolPermitted` → false
 *  10. erreurs et reprise                → méthode inconnue, RPC en échec,
 *                                          lot vide, notification
 */
import { describe, expect, it, vi } from 'vitest';

import {
  CODES,
  construireCatalogue,
  descriptionOutils,
  traiterCorps,
  RPC_AUTORISEES,
  OUTILS_ECRITURE,
  OUTILS_LECTURE,
  type ContexteJeton,
  type Dependances,
  type JournalEntree,
} from '../supabase/functions/vyora-mcp/core.ts';

const SERVER_INFO = { name: 'vyora-mcp', version: '2.0.0' };

/** Contexte de jeton : ce que le handler produit APRÈS résolution du secret. */
function contexte(surcharge: Partial<ContexteJeton> = {}): ContexteJeton {
  return {
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tokenId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    scopes: ['read'],
    tokenPrefix: 'vyora_mcp_test',
    ...surcharge,
  };
}

interface Options {
  ecritureActive?: boolean;
  rpc?: (nom: string, args: Record<string, unknown>) => Promise<unknown>;
  autorise?: boolean;
}

function deps(options: Options = {}) {
  const appels: Array<{ nom: string; args: Record<string, unknown> }> = [];
  const journal: JournalEntree[] = [];
  const autoriser = vi.fn(
    async (_ctx: unknown, _nom: string, _portee: string) => options.autorise ?? true,
  );
  const d: Dependances = {
    ecritureActive: options.ecritureActive ?? false,
    appelerRpc: async (nom, args) => {
      appels.push({ nom, args });
      if (options.rpc) return options.rpc(nom, args);
      return { ok: true, rpc: nom };
    },
    outilAutorise: (ctx, nom, portee) => autoriser(ctx, nom, portee),
    journaliser: async (entree) => {
      journal.push(entree);
    },
  };
  return { deps: d, appels, journal, autoriser };
}

/** Envoie une requête et renvoie la réponse JSON-RPC. */
async function appeler(
  d: Dependances,
  requete: unknown,
  ctx = contexte(),
): Promise<Record<string, unknown>> {
  const { payload } = await traiterCorps(d, ctx, requete, { serverInfo: SERVER_INFO });
  return payload as Record<string, unknown>;
}

function requete(method: string, params?: unknown, id: number | string | null = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/* -------------------------------------------------------------------------- */
/* 1-2. Initialisation et négociation du protocole                             */
/* -------------------------------------------------------------------------- */

describe('initialisation MCP', () => {
  it('répond à initialize avec protocole, capacités et identité du serveur', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(
      d,
      requete('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } }),
    );

    expect(reponse.jsonrpc).toBe('2.0');
    expect(reponse.id).toBe(1);
    const result = reponse.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo).toEqual({ name: 'vyora-mcp', version: '2.0.0' });
    // Le serveur n'expose que des outils : annoncer d'autres capacités serait
    // un mensonge que le client exploiterait en appelant des méthodes absentes.
    const capabilities = result.capabilities as Record<string, unknown>;
    expect(Object.keys(capabilities)).toEqual(['tools']);
    expect(capabilities.tools).toEqual({ listChanged: false });
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions as string).toMatch(/utilisateur/i);
  });

  it('accepte les trois versions connues du protocole', async () => {
    const { deps: d } = deps();
    for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      const reponse = await appeler(d, requete('initialize', { protocolVersion: version }));
      expect((reponse.result as Record<string, unknown>).protocolVersion, version).toBe(version);
    }
  });

  it('se replie sur la version la plus récente quand le client en propose une inconnue', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, requete('initialize', { protocolVersion: '1999-01-01' }));
    // Se replier est le comportement prescrit ; refuser casserait les clients
    // anciens sans rien apporter en sécurité.
    expect((reponse.result as Record<string, unknown>).protocolVersion).toBe('2025-06-18');
  });

  it('accepte initialize sans paramètres (client minimal)', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, requete('initialize'));
    expect((reponse.result as Record<string, unknown>).protocolVersion).toBe('2025-06-18');
  });

  it('ne répond RIEN aux notifications (initialized, cancelled)', async () => {
    const { deps: d, journal } = deps();
    for (const method of ['notifications/initialized', 'notifications/cancelled']) {
      const { payload, status } = await traiterCorps(d, contexte(), { jsonrpc: '2.0', method }, { serverInfo: SERVER_INFO });
      expect(payload, method).toBeNull();
      expect(status, method).toBe(202);
    }
    // Elles sont tout de même journalisées : un client qui n'arrive pas à
    // terminer son initialisation doit laisser une trace.
    expect(journal.filter((e) => e.method.startsWith('notifications/')).length).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Liste des outils                                                        */
/* -------------------------------------------------------------------------- */

describe('tools/list', () => {
  it('expose le catalogue de lecture avec un schéma d’entrée valide', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, requete('tools/list'));
    const result = reponse.result as { tools: Array<Record<string, unknown>>; count: number };

    expect(result.count).toBe(OUTILS_LECTURE.length);
    expect(result.tools.length).toBe(OUTILS_LECTURE.length);
    expect(result.count).toBe(result.tools.length);

    for (const outil of result.tools) {
      expect(typeof outil.name).toBe('string');
      expect(typeof outil.title).toBe('string');
      expect(outil.name as string).toMatch(/^vyora_[a-z_]+$/);
      const schema = outil.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      // Une description utile : un agent choisit son outil sur ce texte.
      expect((outil.description as string).length).toBeGreaterThan(40);
    }
  });

  it('n’expose AUCUN outil d’écriture quand l’écriture est désactivée', async () => {
    const { deps: d } = deps({ ecritureActive: false });
    const reponse = await appeler(d, requete('tools/list'));
    const noms = (reponse.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const outil of OUTILS_ECRITURE) {
      expect(noms, outil.name).not.toContain(outil.name);
    }
  });

  it('ajoute les outils d’écriture quand ils sont activés', async () => {
    const { deps: d } = deps({ ecritureActive: true });
    const reponse = await appeler(d, requete('tools/list'));
    const noms = (reponse.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const outil of OUTILS_ECRITURE) expect(noms, outil.name).toContain(outil.name);
  });

  it('annote correctement lecture et écriture', async () => {
    const catalogue = construireCatalogue({ ecritureActive: true });
    const vue = descriptionOutils(catalogue);
    for (const outil of vue.tools) {
      const attendu = OUTILS_LECTURE.some((o) => o.name === outil.name);
      expect(outil.annotations.readOnlyHint, outil.name).toBe(attendu);
      // Aucun outil MCP SORAHNEX n'est destructeur, et aucun n'appelle un tiers.
      expect(outil.annotations.destructiveHint).toBe(false);
      expect(outil.annotations.openWorldHint).toBe(false);
    }
  });

  it('refuse un catalogue contenant deux fois le même nom d’outil', () => {
    // Garde-fou de structure : le routage ne doit jamais dépendre de l'ordre.
    const catalogue = construireCatalogue({ ecritureActive: true });
    const noms = catalogue.tools.map((t) => t.name);
    expect(new Set(noms).size).toBe(noms.length);
  });

  it('répond une liste vide à resources/list et prompts/list', async () => {
    const { deps: d } = deps();
    expect((await appeler(d, requete('resources/list'))).result).toEqual({ resources: [] });
    expect((await appeler(d, requete('prompts/list'))).result).toEqual({ prompts: [] });
  });

  it('répond à ping', async () => {
    const { deps: d } = deps();
    expect((await appeler(d, requete('ping'))).result).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Appel d'un outil                                                        */
/* -------------------------------------------------------------------------- */

describe('tools/call', () => {
  it('appelle la RPC avec le userId du JETON, jamais un identifiant client', async () => {
    const { deps: d, appels } = deps();
    const reponse = await appeler(
      d,
      requete('tools/call', { name: 'vyora_account_info', arguments: {} }),
      contexte({ userId: 'jeton-user' }),
    );

    const result = reponse.result as Record<string, unknown>;
    expect(result.isError).toBe(false);
    expect(Array.isArray(result.content)).toBe(true);
    const contenu = (result.content as Array<{ type: string; text: string }>)[0];
    expect(contenu.type).toBe('text');
    expect(JSON.parse(contenu.text)).toMatchObject({ ok: true, rpc: 'mcp_account_info' });

    expect(appels).toHaveLength(1);
    expect(appels[0].nom).toBe('mcp_account_info');
    expect(appels[0].args).toEqual({ p_user_id: 'jeton-user' });
  });

  it('renvoie structuredContent en plus du texte', async () => {
    const { deps: d } = deps({ rpc: async () => ({ items: [{ id: 1 }], total: 1 }) });
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_imports_list', arguments: {} }));
    const result = reponse.result as Record<string, unknown>;
    expect(result.structuredContent).toEqual({ items: [{ id: 1 }], total: 1 });
  });

  it('transmet la pagination validée', async () => {
    const { deps: d, appels } = deps();
    await appeler(d, requete('tools/call', {
      name: 'vyora_products_list',
      arguments: { limit: 5, offset: 10 },
    }));
    expect(appels[0].args).toEqual({ p_user_id: contexte().userId, p_workspace_id: null, p_limit: 5, p_offset: 10 });
  });

  it('applique les valeurs par défaut de pagination', async () => {
    const { deps: d, appels } = deps();
    await appeler(d, requete('tools/call', { name: 'vyora_imports_list', arguments: {} }));
    expect(appels[0].args).toMatchObject({ p_limit: 20, p_offset: 0 });
  });

  it('transmet le workspace_id comme restriction, sans l’inventer', async () => {
    const { deps: d, appels } = deps();
    await appeler(d, requete('tools/call', {
      name: 'vyora_products_list',
      arguments: { workspace_id: 'ws-1' },
    }));
    expect(appels[0].args.p_workspace_id).toBe('ws-1');
  });

  it('refuse un argument inconnu au lieu de l’ignorer', async () => {
    const { deps: d, appels } = deps();
    const reponse = await appeler(d, requete('tools/call', {
      name: 'vyora_products_list',
      arguments: { worksapce_id: 'faute-de-frappe' },
    }));
    const error = reponse.error as Record<string, unknown>;
    expect(error.code).toBe(CODES.invalidParams);
    expect((error.data as Record<string, unknown>).reason).toBe('unknown_argument');
    // Le point capital : aucune RPC n'a été appelée. Sans ce refus, la faute de
    // frappe aurait produit une lecture sur TOUS les espaces.
    expect(appels).toHaveLength(0);
  });

  it('refuse un argument requis manquant', async () => {
    const { deps: d, appels } = deps();
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_product_get', arguments: {} }));
    expect(((reponse.error as Record<string, unknown>).data as Record<string, unknown>).reason).toBe('missing_argument');
    expect(appels).toHaveLength(0);
  });

  it('refuse un entier hors bornes', async () => {
    const { deps: d, appels } = deps();
    for (const limite of [0, 101, 2.5, '20']) {
      const reponse = await appeler(d, requete('tools/call', {
        name: 'vyora_products_list',
        arguments: { limit: limite },
      }));
      expect(reponse.error, String(limite)).toBeDefined();
    }
    expect(appels).toHaveLength(0);
  });

  it('refuse un outil inconnu en listant les outils disponibles', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_fake_tool', arguments: {} }));
    const error = reponse.error as Record<string, unknown>;
    expect(error.code).toBe(CODES.invalidParams);
    expect(error.message).toMatch(/inconnu/i);
    expect(Array.isArray((error.data as Record<string, unknown>).available)).toBe(true);
  });

  it('distingue « outil d’écriture désactivé » d’un outil inexistant', async () => {
    const { deps: d } = deps({ ecritureActive: false });
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_product_create', arguments: { name: 'X' } }));
    const error = reponse.error as Record<string, unknown>;
    // Le message doit dire quoi faire : activer l'écriture, pas « inconnu ».
    expect(error.message).toMatch(/désactivée/i);
    expect((error.data as Record<string, unknown>).reason).toBe('write_disabled');
  });

  it('renvoie isError:true (et non une erreur de protocole) quand la RPC échoue', async () => {
    const { deps: d } = deps({ rpc: async () => { throw new Error('workspace access denied'); } });
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_products_list', arguments: {} }));
    // Erreur d'exécution => résultat, pas erreur JSON-RPC : le client doit
    // pouvoir l'afficher comme un échec d'outil.
    expect(reponse.error).toBeUndefined();
    const result = reponse.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/workspace access denied/);
  });
});

/* -------------------------------------------------------------------------- */
/* 6 et 9. Autorisations                                                      */
/* -------------------------------------------------------------------------- */

describe('permissions insuffisantes', () => {
  it('refuse un outil d’écriture à un jeton en lecture seule', async () => {
    const { deps: d, appels } = deps({ ecritureActive: true });
    const reponse = await appeler(
      d,
      requete('tools/call', { name: 'vyora_product_create', arguments: { name: 'Produit' } }),
      contexte({ scopes: ['read'] }),
    );
    const error = reponse.error as Record<string, unknown>;
    expect(error.code).toBe(CODES.forbidden);
    expect(error.message).toMatch(/portée/i);
    expect(appels).toHaveLength(0);
  });

  it('accepte un outil d’écriture quand la portée write est présente', async () => {
    const { deps: d, appels } = deps({ ecritureActive: true });
    const reponse = await appeler(
      d,
      requete('tools/call', { name: 'vyora_product_create', arguments: { name: 'Produit' } }),
      contexte({ scopes: ['read', 'write'] }),
    );
    expect(reponse.error).toBeUndefined();
    expect((reponse.result as Record<string, unknown>).isError).toBe(false);
    expect(appels[0].nom).toBe('mcp_product_create');
  });

  it('refuse un outil que le jeton n’a pas le droit d’appeler', async () => {
    // Permission par outil : un jeton `read` peut être restreint à un
    // sous-ensemble précis, par exemple en excluant la lecture du catalogue.
    const { deps: d, appels } = deps({ autorise: false });
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_products_list', arguments: {} }));
    const error = reponse.error as Record<string, unknown>;
    expect(error.code).toBe(CODES.forbidden);
    expect(error.message).toMatch(/non autorisé/i);
    expect(appels).toHaveLength(0);
  });

  it('échoue FERMÉ si la vérification de permission lève', async () => {
    const { deps: d, appels } = deps();
    d.outilAutorise = async () => { throw new Error('bd injoignable'); };
    const reponse = await appeler(d, requete('tools/call', { name: 'vyora_account_info', arguments: {} }));
    // Une panne de la vérification ne doit jamais valoir autorisation.
    expect((reponse.error as Record<string, unknown>).code).toBe(CODES.forbidden);
    expect(appels).toHaveLength(0);
  });

  it('n’expose que des RPC de la liste blanche', () => {
    // La liste blanche est la barrière contre une injection par nom d'outil :
    // le handler Edge parle avec la clé de service, donc tout nom absent d'ici
    // ne doit jamais atteindre la base.
    for (const outil of [...OUTILS_LECTURE, ...OUTILS_ECRITURE]) {
      expect(RPC_AUTORISEES.has(outil.rpc), `${outil.name} → ${outil.rpc}`).toBe(true);
    }
    // Les fonctions privilégiées ne doivent PAS y figurer.
    for (const interdit of ['mcp_create_token', 'mcp_revoke_token', 'mcp_rotate_token', 'mcp_resolve_token']) {
      expect(RPC_AUTORISEES.has(interdit), interdit).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Isolation entre deux utilisateurs                                       */
/* -------------------------------------------------------------------------- */

describe('isolation entre utilisateurs', () => {
  it('deux jetons distincts produisent deux appels distincts, jamais mélangés', async () => {
    const { deps: d, appels } = deps();
    const jetonA = contexte({ userId: 'user-a' });
    const jetonB = contexte({ userId: 'user-b' });

    await traiterCorps(d, jetonA, requete('tools/call', { name: 'vyora_imports_list', arguments: {} }), { serverInfo: SERVER_INFO });
    await traiterCorps(d, jetonB, requete('tools/call', { name: 'vyora_imports_list', arguments: {} }), { serverInfo: SERVER_INFO });

    expect(appels.map((a) => a.args.p_user_id)).toEqual(['user-a', 'user-b']);
  });

  it('un userId passé dans les ARGUMENTS de l’outil est rejeté', async () => {
    // Tentative d'escalade évidente : `p_user_id` n'est pas un paramètre
    // exposé. `additionalProperties: false` doit le refuser.
    const { deps: d, appels } = deps();
    const reponse = await appeler(d, requete('tools/call', {
      name: 'vyora_stores_list',
      arguments: { p_user_id: 'victime' },
    }));
    expect(reponse.error).toBeDefined();
    expect(appels).toHaveLength(0);
  });

  it('le journal porte l’identité du jeton utilisé, pas celle d’un autre', async () => {
    const { deps: d, journal } = deps();
    await traiterCorps(d, contexte({ userId: 'user-a', tokenId: 'tok-a' }), requete('tools/list'), { serverInfo: SERVER_INFO });
    await traiterCorps(d, contexte({ userId: 'user-b', tokenId: 'tok-b' }), requete('tools/list'), { serverInfo: SERVER_INFO });

    expect(journal.map((e) => e.userId)).toEqual(['user-a', 'user-b']);
    expect(journal.map((e) => e.tokenId)).toEqual(['tok-a', 'tok-b']);
  });
});

/* -------------------------------------------------------------------------- */
/* 10. Erreurs et reprise                                                     */
/* -------------------------------------------------------------------------- */

describe('erreurs et reprise', () => {
  it('rejette une requête JSON-RPC malformée', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, { method: 'tools/list' });
    expect((reponse.error as Record<string, unknown>).code).toBe(CODES.invalidRequest);
  });

  it('rejette un lot vide', async () => {
    const { deps: d } = deps();
    const { status, payload } = await traiterCorps(d, contexte(), [], { serverInfo: SERVER_INFO });
    expect(status).toBe(400);
    expect(((payload as Record<string, unknown>).error as Record<string, unknown>).message).toMatch(/vide/i);
  });

  it('traite un lot et ne renvoie que les réponses des requêtes', async () => {
    const { deps: d } = deps();
    const { payload } = await traiterCorps(
      d,
      contexte(),
      [
        requete('ping', undefined, 1),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        requete('tools/list', undefined, 2),
      ],
      { serverInfo: SERVER_INFO },
    );
    const reponses = payload as Array<Record<string, unknown>>;
    expect(reponses).toHaveLength(2);
    expect(reponses.map((r) => r.id)).toEqual([1, 2]);
  });

  it('renvoie methodNotFound pour une méthode inconnue, mais ignore une notification inconnue', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, requete('tools/bidule'));
    expect((reponse.error as Record<string, unknown>).code).toBe(CODES.methodNotFound);

    const notification = await traiterCorps(d, contexte(), { jsonrpc: '2.0', method: 'tools/bidule' }, { serverInfo: SERVER_INFO });
    expect(notification.payload).toBeNull();
  });

  it('journalise chaque requête, y compris les refus', async () => {
    const { deps: d, journal } = deps({ autorise: false });
    await appeler(d, requete('tools/call', { name: 'vyora_account_info', arguments: {} }));
    const entree = journal[journal.length - 1];
    expect(entree.outcome).toBe('denied');
    expect(entree.errorCode).toBe('tool_not_permitted');
    expect(entree.toolName).toBe('vyora_account_info');
    expect(typeof entree.durationMs).toBe('number');
  });

  it('une panne du journal NE CASSE PAS la réponse', async () => {
    const { deps: d } = deps();
    d.journaliser = async () => { throw new Error('journal hs'); };
    const reponse = await appeler(d, requete('ping'));
    // Le journal est un observateur : il ne doit jamais devenir un point de
    // panne du service.
    expect(reponse.error).toBeUndefined();
    expect(reponse.result).toEqual({});
  });

  it('reste utilisable après une erreur (reprise de connexion)', async () => {
    const { deps: d } = deps();
    const echec = await appeler(d, requete('tools/call', { name: 'inexistant', arguments: {} }));
    expect(echec.error).toBeDefined();
    // Le client n'a rien à refaire : la requête suivante doit passer.
    const succes = await appeler(d, requete('tools/list'));
    expect((succes.result as { count: number }).count).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 11. Robustesse du contrat JSON-RPC (corrigé après preuve en production)    */
/* -------------------------------------------------------------------------- */

describe('validation stricte des requêtes', () => {
  it('refuse une méthode vide au lieu de la traiter comme notification', async () => {
    // Constaté en production : `{method:""}` recevait 202 et était journalisé
    // « ok ». Une requête malformée doit être signalée, jamais avalée.
    const { deps: d, journal } = deps();
    const reponse = await appeler(d, { jsonrpc: '2.0', id: 1, method: '' });

    expect(reponse.error).toBeDefined();
    expect((reponse.error as { code: number }).code).toBe(-32600);
    expect(journal).toHaveLength(0);
  });

  it('refuse une méthode faite d’espaces', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, { jsonrpc: '2.0', id: 2, method: '   ' });
    expect((reponse.error as { code: number }).code).toBe(-32600);
  });

  it('refuse un jsonrpc qui n’est pas « 2.0 »', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, { jsonrpc: '1.0', id: 3, method: 'tools/list' });
    expect((reponse.error as { code: number }).code).toBe(-32600);
  });

  it('refuse un corps qui n’est pas un objet', async () => {
    const { deps: d } = deps();
    const reponse = await appeler(d, 'pas un objet');
    expect((reponse.error as { code: number }).code).toBe(-32600);
    expect(reponse.id).toBeNull();
  });

  it('ignore une notification inconnue sans réponse et la journalise', async () => {
    const { deps: d, journal } = deps();
    const reponse = await appeler(d, { jsonrpc: '2.0', method: 'une/notification' });
    // Notification : aucune réponse, mais la trace doit exister.
    expect(reponse).toBeNull();
    expect(journal).toHaveLength(1);
  });
});
