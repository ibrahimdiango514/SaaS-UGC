// @vitest-environment node
/**
 * Client MCP sortant — protocole, découverte, appels et refus.
 *
 * Le réseau est remplacé par un faux serveur MCP qui répond sur un socket en
 * mémoire. On teste donc le VRAI chemin : `client.ts` → `safePost` → validation
 * d'URL → résolution DNS → contrôle d'IP → connexion épinglée → HTTP → JSON-RPC.
 *
 * Les cas « hostile » (redirection, hôte privé, outil d'écriture, curseur
 * infini) sont l'objet principal de ce fichier : c'est là que se joue la
 * sécurité, pas dans le cas nominal.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PROTOCOLE_CLIENT,
  appelerOutil,
  classerOutil,
  creerContexte,
  extraireDerniereTrame,
  initialiser,
  listerOutils,
  normaliserOutil,
  oublierSession,
} from '../supabase/functions/mcp-client/client.ts';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress.ts';
import type { PinnedSocket } from '../supabase/functions/store-import/pinned-fetch.ts';

const IP_PUBLIQUE = '93.184.216.34';

/** Socket en mémoire : joue un serveur HTTP/1.1 qui répond puis ferme. */
function socketFactice(reponse: string): PinnedSocket {
  const octets = new TextEncoder().encode(reponse);
  let envoyes = false;
  let position = 0;
  return {
    async write() {
      envoyes = true;
      return 0;
    },
    async read(tampon: Uint8Array) {
      if (!envoyes) return 0;
      if (position >= octets.length) return null;
      const n = Math.min(tampon.length, octets.length - position);
      tampon.set(octets.slice(position, position + n));
      position += n;
      return n;
    },
    close() {},
  };
}

/** Réponse HTTP 200 JSON. */
function httpJson(corps: unknown, entetes: Record<string, string> = {}): string {
  const texte = typeof corps === 'string' ? corps : JSON.stringify(corps);
  const lignes = Object.entries({ 'content-type': 'application/json', ...entetes })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  return `HTTP/1.1 200 OK\r\n${lignes}\r\ncontent-length: ${new TextEncoder().encode(texte).byteLength}\r\n\r\n${texte}`;
}

function httpStatut(status: number, corps = ''): string {
  return `HTTP/1.1 ${status} Erreur\r\ncontent-type: application/json\r\ncontent-length: ${corps.length}\r\n\r\n${corps}`;
}

/** Ordre des méthodes reçues, pour vérifier le cycle de vie. */
interface Journal {
  requetes: string[];
  entetes: Record<string, string>[];
}

/**
 * Dépendances réseau simulées : DNS public, connexion vers un socket scripté.
 * On enregistre les en-têtes de CHAQUE requête pour vérifier qu'aucune clé ne
 * fuit et que l'authentification n'est pas ajoutée toute seule.
 */
function reseau(reponses: string[]): { deps: EgressDeps; journal: Journal } {
  const journal: Journal = { requetes: [], entetes: [] };
  let index = 0;
  const deps: EgressDeps = {
    async resolveHost(hostname: string) {
      journal.requetes.push(`dns:${hostname}`);
      return [IP_PUBLIQUE];
    },
    async connect() {
      const reponse = reponses[Math.min(index, reponses.length - 1)];
      index += 1;
      return socketFactice(reponse);
    },
  };
  return { deps, journal };
}

function client(deps: EgressDeps, entetes?: Record<string, string>) {
  const contexte = creerContexte(
    {
      url: 'https://mcp.exemple.com/mcp',
      fournirEntetes: entetes ? () => entetes : undefined,
    },
    deps,
  );
  return contexte;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: PROTOCOLE_CLIENT,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'boutique-mcp', version: '2.3.0' },
  },
};

const OUTILS = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    tools: [
      /* `name` et `title` imitent un vrai annuaire : le tri doit rester fiable. */
      { name: 'list_orders', description: 'Liste les commandes', inputSchema: { type: 'object' } },
      { name: 'get_product', description: 'Lit un produit', inputSchema: { type: 'object' } },
      { name: 'create_order', description: 'Crée une commande', inputSchema: { type: 'object' } },
      { name: 'delete_product', description: 'Supprime un produit', inputSchema: { type: 'object' } },
      { name: 'sync_inventory', description: 'Synchronise le stock', inputSchema: { type: 'object' } },
    ],
  },
};

/* -------------------------------------------------------------------------- */

describe('classification lecture / écriture', () => {
  it('classe les lectures évidentes en lecture', () => {
    for (const nom of ['get_order', 'list_products', 'search_customers', 'fetch_report', 'describe_table']) {
      expect(classerOutil(nom).lecture, nom).toBe(true);
    }
  });

  it('classe les écritures en écriture', () => {
    for (const nom of ['create_order', 'update_price', 'delete_product', 'refund_payment', 'publish_post']) {
      expect(classerOutil(nom).lecture, nom).toBe(false);
    }
  });

  it('donne priorité au verbe d’écriture même mêlé à un verbe de lecture', () => {
    // Le piège : le nom COMMENCE par `get`, mais il supprime.
    expect(classerOutil('get_and_delete_order').lecture).toBe(false);
    expect(classerOutil('list_then_purge').lecture).toBe(false);
  });

  it('ne se laisse pas berner par un verbe de lecture en deuxième position', () => {
    expect(classerOutil('delete_all_get_things').lecture).toBe(false);
  });

  it('traite un nom inconnu comme une écriture', () => {
    // L'absence d'information n'est pas une preuve d'innocuité.
    const resultat = classerOutil('do_thing');
    expect(resultat.lecture).toBe(false);
    expect(resultat.raison).toContain('non reconnu');
  });

  it('tient compte de la description quand elle annonce une écriture', () => {
    expect(classerOutil('orders', 'Supprime définitivement une commande').lecture).toBe(false);
  });

  it('ignore un readOnlyHint : seul le nom et la description comptent', () => {
    const outil = normaliserOutil({
      name: 'delete_everything',
      description: 'Supprime tout',
      // Un serveur peut affirmer que c'est en lecture : on ne le croit pas.
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object' },
    });
    expect(outil?.exigeConfirmation).toBe(true);
  });
});

describe('négociation de protocole', () => {
  it('initialise et retient la session et le serveur', async () => {
    const { deps } = reseau([httpJson(INIT, { 'mcp-session-id': 'sess-42' })]);
    const contexte = client(deps);
    const resultat = await initialiser(contexte);

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.protocole).toBe(PROTOCOLE_CLIENT);
    expect(resultat.value.serverInfo.name).toBe('boutique-mcp');
    expect(resultat.value.sessionId).toBe('sess-42');
    expect(resultat.value.capacites).toHaveProperty('tools');
  });

  it('envoie notifications/initialized après initialize', async () => {
    /*
     * On compte les connexions : la notification n'appelle pas `connect` deux
     * fois de la même façon qu'un initialize, mais elle doit bien partir. On
     * vérifie donc le nombre total de connexions (initialize puis notification).
     */
    let connexions = 0;
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() {
        connexions += 1;
        return socketFactice(httpJson(INIT));
      },
    };
    await initialiser(client(deps));
    expect(connexions).toBe(2);
  });

  it('refuse une version de protocole non supportée', async () => {
    const { deps } = reseau([httpJson({ ...INIT, result: { ...INIT.result, protocolVersion: '2030-01-01' } })]);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('protocole');
    expect(resultat.error.message).toContain('2030-01-01');
  });

  it('refuse une réponse sans résultat exploitable', async () => {
    const { deps } = reseau([httpJson({ jsonrpc: '2.0', id: 1 })]);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
  });

  it('traduit une erreur JSON-RPC', async () => {
    const { deps } = reseau([httpJson({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Paramètres invalides' } })]);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('json_rpc');
    expect(resultat.error.rpcCode).toBe(-32602);
  });
});

describe('authentification : aucun mécanisme supposé', () => {
  it('n’ajoute aucun en-tête d’authentification de lui-même', async () => {
    let vus: Record<string, string> = {};
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() {
        return socketFactice(httpJson(INIT));
      },
    };
    // On capture la requête brute en interceptant l'écriture du socket.
    const original: EgressDeps = {
      ...deps,
      async connect(ip, host) {
        const vrai = await deps.connect!(ip, host);
        return {
          async write(octets) {
            const texte = new TextDecoder().decode(octets);
            vus = Object.fromEntries(
              texte.split('\r\n')
                .map((l) => l.split(/:\s*/))
                .filter((p) => p.length === 2)
                .map(([k, v]) => [k.toLowerCase(), v]),
            );
            return vrai.write(octets);
          },
          read: (p) => vrai.read(p),
          close: () => vrai.close(),
        };
      },
    };
    await initialiser(client(original));
    expect(vus.authorization).toBeUndefined();
    expect(vus['x-api-key']).toBeUndefined();
  });

  it('transmet l’en-tête fourni par l’appelant (clé d’API)', async () => {
    const ecrits: string[] = [];
    const base: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() { return socketFactice(httpJson(INIT)); },
    };
    const deps: EgressDeps = {
      ...base,
      async connect(ip, host) {
        const vrai = await base.connect!(ip, host);
        return {
          async write(o) { ecrits.push(new TextDecoder().decode(o)); return vrai.write(o); },
          read: (p) => vrai.read(p),
          close: () => vrai.close(),
        };
      },
    };
    await initialiser(client(deps, { 'x-api-key': 'cle-boutique-123' }));
    expect(ecrits.some((r) => r.includes('X-Api-Key: cle-boutique-123'))).toBe(true);
  });

  it('distingue 401 (identifiants) de 403 (droits)', async () => {
    const r401 = await initialiser(client(reseau([httpStatut(401)]).deps));
    expect(r401.ok).toBe(false);
    if (!r401.ok) expect(r401.error.code).toBe('authentification');

    const r403 = await initialiser(client(reseau([httpStatut(403)]).deps));
    expect(r403.ok).toBe(false);
    if (!r403.ok) {
      expect(r403.error.code).toBe('authentification');
      expect(r403.error.httpStatus).toBe(403);
      expect(r403.error.message).toContain('403');
    }
  });

  it('trace un statut serveur inattendu', async () => {
    const resultat = await initialiser(client(reseau([httpStatut(502, 'bad gateway')]).deps));
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('http');
    expect(resultat.error.httpStatus).toBe(502);
  });
});

describe('découverte des outils', () => {
  it('liste, normalise et classe les outils', async () => {
    const { deps } = reseau([httpJson(INIT), httpJson({}), httpJson(OUTILS)]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await listerOutils(contexte);

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    const noms = resultat.value.map((o) => o.name);
    expect(noms).toEqual(['list_orders', 'get_product', 'create_order', 'delete_product', 'sync_inventory']);

    const lecture = resultat.value.find((o) => o.name === 'list_orders');
    const ecriture = resultat.value.find((o) => o.name === 'create_order');
    expect(lecture?.exigeConfirmation).toBe(false);
    expect(ecriture?.exigeConfirmation).toBe(true);
    expect(ecriture?.classement).toContain('create');
  });

  it('ignore un outil sans nom exploitable', () => {
    expect(normaliserOutil({ description: 'sans nom' })).toBeNull();
    expect(normaliserOutil({ name: '' })).toBeNull();
    expect(normaliserOutil({ name: 'a'.repeat(201) })).toBeNull();
    expect(normaliserOutil('pas un objet')).toBeNull();
    // Un nom hors alphabet permettrait de dupliquer visuellement un autre outil.
    expect(normaliserOutil({ name: 'delete\u0000product' })).toBeNull();
    expect(normaliserOutil({ name: 'supprimer produit' })).toBeNull();
  });

  it('attribue un schéma vide quand il est absent, sans inventer d’arguments', () => {
    const outil = normaliserOutil({ name: 'list_orders' });
    expect(outil?.inputSchema).toEqual({});
  });

  it('suit la pagination quand les pages sont réelles', async () => {
    const page1 = httpJson({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'get_a' }], nextCursor: 'p2' } });
    const page2 = httpJson({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'get_b' }] } });
    const { deps } = reseau([httpJson(INIT), httpJson({}), page1, page2]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await listerOutils(contexte);

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.map((o) => o.name)).toEqual(['get_a', 'get_b']);
  });

  it('s’arrête sur un curseur qui ne progresse pas', async () => {
    /*
     * Un serveur hostile renvoie toujours le même curseur : la boucle doit
     * s'arrêter, pas tourner jusqu'au délai d'exécution. On compte les appels
     * `tools/list` émis, pas les outils reçus : la question est bien « combien
     * de requêtes ».
     */
    let outilsList = 0;
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() {
        outilsList += 1;
        if (outilsList === 1) return socketFactice(httpJson(INIT));
        if (outilsList === 2) return socketFactice(httpJson({}));
        return socketFactice(httpJson({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: 'get_x' }], nextCursor: 'encore' },
        }));
      },
    };
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await listerOutils(contexte, { maxPages: 10 });

    expect(resultat.ok).toBe(true);
    // initialize + notification + 2 pages (la 2e découvre le curseur déjà vu).
    expect(outilsList).toBeLessThanOrEqual(4);
  });

  it('s’arrête sur une alternance de curseurs (a → b → a)', async () => {
    // Un contrôle limité au dernier curseur boucherait ici à l'infini.
    const curseurs = ['a', 'b', 'a', 'b'];
    let index = 0;
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() {
        const n = index++;
        if (n === 0) return socketFactice(httpJson(INIT));
        if (n === 1) return socketFactice(httpJson({}));
        const curseur = curseurs[Math.min(n - 2, curseurs.length - 1 - 1)];
        return socketFactice(httpJson({
          jsonrpc: '2.0',
          id: 2,
          result: { tools: [{ name: `get_${n}` }], nextCursor: curseur },
        }));
      },
    };
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await listerOutils(contexte, { maxPages: 20 });
    expect(resultat.ok).toBe(true);
    // Sans le garde-fou sur l'ensemble des curseurs vus, on atteindrait 20 pages.
    expect(index).toBeLessThanOrEqual(5);
  });

  it('propage un refus du serveur sur tools/list', async () => {
    const refus = httpJson({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } });
    const { deps } = reseau([httpJson(INIT), httpJson({}), refus]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await listerOutils(contexte);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.rpcCode).toBe(-32601);
  });
});

describe('appel d’outil : autorisation avant envoi', () => {
  it('appelle un outil de lecture autorisé', async () => {
    const appel = httpJson({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } });
    const { deps } = reseau([httpJson(INIT), httpJson({}), appel]);
    const contexte = client(deps);
    await initialiser(contexte);

    const resultat = await appelerOutil(contexte, {
      nom: 'list_orders',
      arguments: { limit: 10 },
      autorisations: [{ outil: 'list_orders' }],
    });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.isError).toBe(false);
  });

  it('refuse un outil absent des autorisations', async () => {
    const { deps } = reseau([httpJson(INIT), httpJson({})]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await appelerOutil(contexte, {
      nom: 'list_orders',
      autorisations: [{ outil: 'get_product' }],
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('outil_non_autorise');
  });

  it('refuse une écriture SANS confirmation explicite, sans toucher au réseau', async () => {
    let connexions = 0;
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE]; },
      async connect() {
        connexions += 1;
        return socketFactice(httpJson(INIT));
      },
    };
    const contexte = client(deps);
    await initialiser(contexte);
    const avant = connexions;

    const resultat = await appelerOutil(contexte, {
      nom: 'create_order',
      arguments: { sku: 'X', qty: 1 },
      autorisations: [{ outil: 'create_order' }],
    });

    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      expect(resultat.error.code).toBe('outil_non_autorise');
      expect(resultat.error.message).toContain('confirmation');
    }
    // Le point crucial : aucune requête n'a été émise.
    expect(connexions).toBe(avant);
  });

  it('accepte une écriture avec confirmation explicite', async () => {
    const appel = httpJson({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'créé' }] } });
    const { deps } = reseau([httpJson(INIT), httpJson({}), appel]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await appelerOutil(contexte, {
      nom: 'create_order',
      arguments: { sku: 'X' },
      autorisations: [{ outil: 'create_order', ecritureAutorisee: true }],
    });
    expect(resultat.ok).toBe(true);
  });

  it('refuse des arguments qui ne sont pas un objet', async () => {
    const { deps } = reseau([httpJson(INIT), httpJson({})]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await appelerOutil(contexte, {
      nom: 'list_orders',
      arguments: ['a', 'b'] as unknown as Record<string, unknown>,
      autorisations: [{ outil: 'list_orders' }],
    });
    expect(resultat.ok).toBe(false);
  });

  it('remonte une erreur d’outil sans la confondre avec une panne', async () => {
    const erreurOutil = httpJson({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'commande introuvable' }], isError: true },
    });
    const { deps } = reseau([httpJson(INIT), httpJson({}), erreurOutil]);
    const contexte = client(deps);
    await initialiser(contexte);
    const resultat = await appelerOutil(contexte, {
      nom: 'get_order',
      arguments: { id: 'X' },
      autorisations: [{ outil: 'get_order' }],
    });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.isError).toBe(true);
  });
});

describe('Sécurité réseau : rien n’est assoupli pour MCP', () => {
  it('refuse un hôte privé AVANT toute connexion', async () => {
    const connect = vi.fn();
    const deps: EgressDeps = {
      async resolveHost() { return ['10.0.0.5']; },
      connect,
    };
    const contexte = creerContexte({ url: 'https://mcp.exemple.com/mcp' }, deps);
    const resultat = await initialiser(contexte);
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      // Refus SSRF explicite, distinct d'une panne réseau : l'appelant doit
      // pouvoir dire « adresse non autorisée » et ne pas réessayer.
      expect(resultat.error.code).toBe('serveur_invalide');
      expect(resultat.error.code).not.toBe('reseau');
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuse une IP de métadonnées cloud (169.254.169.254)', async () => {
    const connect = vi.fn();
    const deps: EgressDeps = {
      async resolveHost() { return ['169.254.169.254']; },
      connect,
    };
    const resultat = await initialiser(creerContexte({ url: 'https://mcp.exemple.com/mcp' }, deps));
    expect(resultat.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuse un mélange adresse publique + privée', async () => {
    const connect = vi.fn();
    const deps: EgressDeps = {
      async resolveHost() { return [IP_PUBLIQUE, '192.168.1.10']; },
      connect,
    };
    const resultat = await initialiser(creerContexte({ url: 'https://mcp.exemple.com/mcp' }, deps));
    expect(resultat.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuse une redirection sur un POST au lieu de la suivre', async () => {
    const redirection = 'HTTP/1.1 307 Temporary Redirect\r\nlocation: https://interne.exemple/\r\ncontent-length: 0\r\n\r\n';
    const { deps } = reseau([redirection]);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      expect(resultat.error.code).toBe('protocole');
      expect(resultat.error.message).toContain('redirigé');
    }
  });

  it('refuse http:// (non TLS) pour un serveur MCP', async () => {
    const connect = vi.fn();
    const deps: EgressDeps = { async resolveHost() { return [IP_PUBLIQUE]; }, connect };
    const resultat = await initialiser(creerContexte({ url: 'http://mcp.exemple.com/mcp' }, deps));
    expect(resultat.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuse un hôte littéral (127.0.0.1 écrit en dur)', async () => {
    const connect = vi.fn();
    const deps: EgressDeps = { async resolveHost() { return [IP_PUBLIQUE]; }, connect };
    const resultat = await initialiser(creerContexte({ url: 'https://127.0.0.1:8443/mcp' }, deps));
    expect(resultat.ok).toBe(false);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('robustesse des réponses', () => {
  it('lit une réponse SSE et retient la bonne trame', () => {
    const flux = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}',
      '',
    ].join('\n');
    const extrait = extraireDerniereTrame(flux);
    expect(JSON.parse(extrait).result.protocolVersion).toBe('2025-06-18');
  });

  it('retombe sur le corps brut quand aucune trame n’est exploitable', () => {
    expect(extraireDerniereTrame('pas du SSE')).toBe('pas du SSE');
    expect(extraireDerniereTrame('data: [DONE]')).toBe('data: [DONE]');
  });

  it('refuse une réponse qui n’est pas du JSON', async () => {
    const { deps } = reseau(['HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 5\r\n\r\n<html']);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('protocole');
  });

  it('refuse une réponse JSON qui n’est pas un objet', async () => {
    const { deps } = reseau([httpJson('[1,2,3]')]);
    const resultat = await initialiser(client(deps));
    expect(resultat.ok).toBe(false);
  });

  it('oublie la session à la déconnexion', async () => {
    const { deps } = reseau([httpJson(INIT)]);
    const contexte = client(deps);
    await initialiser(contexte);
    expect((contexte as unknown as { session: unknown }).session).not.toBeNull();
    oublierSession(contexte);
    expect((contexte as unknown as { session: unknown }).session).toBeNull();
  });
});

/**
 * Classement lecture / écriture — régression constatée sur de vrais serveurs.
 *
 * `microsoft_docs_search`, `microsoft_docs_fetch` et
 * `microsoft_code_sample_search` (les trois outils réellement découverts sur
 * Microsoft Learn MCP) étaient classés « écriture » : leur verbe de lecture
 * n'était pas le premier mot, puisque le préfixe est le nom du produit. La
 * fonctionnalité d'exécution refusait donc les trois outils d'un serveur en
 * lecture seule.
 */
describe('classerOutil — outils réels et verbes composés', () => {
  const lecture = (nom: string, description = '') => classerOutil(nom, description).lecture;

  it('les trois outils Microsoft Learn sont des LECTURES', () => {
    const description = 'Search official Microsoft/Azure documentation. Use this tool. Required step.';
    expect(lecture('microsoft_docs_search', description)).toBe(true);
    expect(lecture('microsoft_docs_fetch', description)).toBe(true);
    expect(lecture('microsoft_code_sample_search', description)).toBe(true);
  });

  it('le verbe de lecture en tête reste une lecture', () => {
    expect(lecture('get_order')).toBe(true);
    expect(lecture('list_products')).toBe(true);
  });

  it('un verbe d’écriture l’emporte toujours sur un verbe de lecture', () => {
    expect(lecture('get_and_delete_order')).toBe(false);
    expect(lecture('search_and_destroy')).toBe(false);
    expect(lecture('delete_order')).toBe(false);
    expect(lecture('save_config')).toBe(false);
  });

  it('un nom sans signal est traité comme une écriture', () => {
    expect(lecture('do_thing')).toBe(false);
    expect(lecture('widget')).toBe(false);
    expect(lecture('')).toBe(false);
  });

  it('un verbe d’écriture dans la description suffit à refuser la lecture', () => {
    expect(lecture('microsoft_docs_search', 'Delete every file afterwards.')).toBe(false);
    // Le français compte aussi : la plateforme et ses serveurs le parlent.
    expect(lecture('microsoft_docs_search', 'Supprime ensuite les fichiers.')).toBe(false);
    expect(lecture('microsoft_docs_search', 'Modifie la commande.')).toBe(false);
  });
});
