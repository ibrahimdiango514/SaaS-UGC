import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import {
  executerOutil,
  testerConnexion,
  type ServeurExterne,
} from '../supabase/functions/mcp-client/external';
import { creerContexte } from '../supabase/functions/mcp-client/client';
import type { EgressDeps } from '../supabase/functions/store-import/safe-egress';
import { PinnedFetchFailure } from '../supabase/functions/store-import/pinned-fetch';

/**
 * Connexion réelle à un VÉRITABLE serveur MCP.
 *
 * Ce fichier ne simule pas le transport : il lance un serveur HTTP Node qui
 * parle JSON-RPC MCP, et le client y accède par la **vraie** sortie épinglée
 * (`safePost` → `buildRequest` → socket TCP), avec un résolveur et un
 * connecteur injectés pour pointer sur `127.0.0.1` du banc de test.
 *
 * Distinction explicite avec les tests simulés :
 * - simulé : `mcp-external.test.ts` (décision, assainissement, en-têtes) ;
 * - réel : ici — TCP, en-têtes, JSON-RPC, sessions, statuts HTTP.
 *
 * Ce qui est réel : le protocole, les octets, les statuts, les sessions.
 * Ce qui reste simulé : la résolution DNS (le banc n'a pas de domaine public)
 * et le chiffrement TLS (le serveur de test parle HTTP en clair). Le contrôle
 * SSRF, lui, est exercé pour de vrai : `assertPublicAddresses` voit
 * `127.0.0.1` et le refuse — c'est pourquoi le connecteur est injecté
 * uniquement dans les tests qui doivent réussir, et une assertion dédiée
 * vérifie le refus sans injection.
 */

const JETON_VALIDE = 'jeton-de-test-0123456789';

interface Outil {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const OUTILS: Outil[] = [
  {
    name: 'list_products',
    description: 'Liste les produits de la boutique.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_product',
    description: 'Récupère un produit par identifiant.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'delete_product',
    description: 'Supprime définitivement un produit.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

interface EtatServeur {
  sessions: Set<string>;
  appelsOutils: string[];
  initialisations: number;
  exigerAuth: boolean;
  /** Force une réponse 302 sur POST, pour le test de redirection. */
  rediriger: boolean;
  /** Force une réponse 401, indépendamment du jeton. */
  refuserTout: boolean;
  /** Mode « réponse malformée ». */
  malforme: boolean;
}

let serveur: Server;
let port = 0;
const etat: EtatServeur = {
  sessions: new Set(),
  appelsOutils: [],
  initialisations: 0,
  exigerAuth: true,
  rediriger: false,
  refuserTout: false,
  malforme: false,
};

function lireCorps(requete: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let corps = '';
    requete.on('data', (tranche) => {
      corps += tranche;
    });
    requete.on('end', () => resolve(corps));
  });
}

function json(reponse: ServerResponse, statut: number, charge: unknown, entetes: Record<string, string> = {}) {
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
    if (requete.method !== 'POST') {
      reponse.writeHead(405).end();
      return;
    }
    const corps = await lireCorps(requete);

    if (etat.rediriger) {
      reponse.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      return;
    }
    if (etat.malforme) {
      reponse.writeHead(200, { 'content-type': 'application/json' });
      reponse.end('{ ceci n est pas du json');
      return;
    }
    if (etat.refuserTout) {
      json(reponse, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      return;
    }
    if (etat.exigerAuth && requete.headers.authorization !== `Bearer ${JETON_VALIDE}`) {
      json(reponse, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
      return;
    }

    let message: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(corps);
    } catch {
      json(reponse, 400, { error: 'invalid_json' });
      return;
    }

    // Une session inconnue est refusée en 404, comme le fait le protocole.
    const sessionFournie = requete.headers['mcp-session-id'];
    if (message.method !== 'initialize') {
      if (!sessionFournie || !etat.sessions.has(String(sessionFournie))) {
        json(reponse, 404, { error: 'session_unknown' });
        return;
      }
    }

    if (message.method === 'initialize') {
      etat.initialisations += 1;
      const session = `sess_${etat.initialisations}`;
      etat.sessions.add(session);
      json(reponse, 200, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'banc-de-test', version: '1.0.0' },
        },
      }, { 'mcp-session-id': session });
      return;
    }

    if (message.method === 'notifications/initialized') {
      reponse.writeHead(202).end();
      return;
    }

    if (message.method === 'tools/list') {
      json(reponse, 200, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: { tools: OUTILS },
      });
      return;
    }

    if (message.method === 'tools/call') {
      const nom = String(message.params?.name ?? '');
      etat.appelsOutils.push(nom);
      if (!OUTILS.some((o) => o.name === nom)) {
        json(reponse, 200, {
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32602, message: `Outil inconnu : ${nom}` },
        });
        return;
      }
      json(reponse, 200, {
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ outil: nom, recu: message.params?.arguments ?? {} }) }],
          isError: false,
        },
      });
      return;
    }

    json(reponse, 200, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32601, message: 'Méthode inconnue' },
    });
  });

  await new Promise<void>((resolve) => {
    serveur.listen(0, '127.0.0.1', () => {
      const adresse = serveur.address();
      if (adresse && typeof adresse === 'object') port = adresse.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
});

/** Transport TCP vers le banc de test (bypass TLS : le serveur de test est en clair). */
function socketDeTest(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.on('error', reject);
  });
}

/**
 * Dépendances de sortie : on résout vers une IP PUBLIQUE fictive et on connecte
 * le socket réel du banc. C'est le seul moyen de parler à `127.0.0.1` sans
 * affaiblir la couche SSRF — elle n'est pas modifiée, on lui donne seulement une
 * résolution et une connexion contrôlées par le test.
 */
/**
 * Adapte un socket TCP Node à l'interface `PinnedSocket` attendue par la sortie
 * épinglée. Le tampon de lecture est UNIQUE et persistant : un `read` qui reçoit
 * plus d'octets que demandé conserve le reliquat pour l'appel suivant, sinon le
 * flux se bloque (c'était le défaut de la première version de ce banc).
 */
function pinnedSocketDepuis(socket: Socket) {
  let tampon = Buffer.alloc(0);
  let fluxTermine = false;
  let reveil: (() => void) | null = null;

  socket.on('data', (tranche: Buffer) => {
    tampon = Buffer.concat([tampon, tranche]);
    if (reveil) {
      const resoudre = reveil;
      reveil = null;
      resoudre();
    }
  });
  socket.on('end', () => {
    fluxTermine = true;
    if (reveil) {
      const resoudre = reveil;
      reveil = null;
      resoudre();
    }
  });
  socket.on('error', () => {
    fluxTermine = true;
    if (reveil) {
      const resoudre = reveil;
      reveil = null;
      resoudre();
    }
  });
  socket.pause();

  return {
    async write(octets: Uint8Array): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        socket.write(octets, (erreur) => (erreur ? reject(erreur) : resolve()));
      });
      return octets.byteLength;
    },
    async read(destination: Uint8Array): Promise<number | null> {
      while (tampon.length === 0) {
        if (fluxTermine) return null;
        socket.resume();
        await new Promise<void>((resolve) => {
          reveil = resolve;
          // Filet de sécurité : un flux muet ne doit pas bloquer indéfiniment
          // le banc, le délai de la couche testée reste le juge.
          setTimeout(() => {
            if (reveil === resolve) {
              reveil = null;
              resolve();
            }
          }, 5_000);
        });
        socket.pause();
      }
      const taille = Math.min(destination.length, tampon.length);
      destination.set(tampon.subarray(0, taille));
      tampon = tampon.subarray(taille);
      return taille;
    },
    async close(): Promise<void> {
      socket.destroy();
    },
  };
}

/**
 * Dépendances de sortie : on résout vers une IP PUBLIQUE fictive et on connecte
 * le socket réel du banc. C'est le seul moyen de parler au serveur de test qui
 * écoute sur `127.0.0.1` sans affaiblir la couche SSRF — elle n'est pas
 * modifiée, on lui fournit seulement une résolution et une connexion
 * contrôlées par le test. Le test « SSRF sans injection » vérifie que le refus
 * reste effectif quand on ne l'injecte pas.
 */
function depsVersBanc(): EgressDeps {
  return {
    resolveHost: async () => ['93.184.216.34'],
    connect: async () => pinnedSocketDepuis(await socketDeTest()),
    timeoutMs: 8_000,
  };
}

const URL_BANC = () => `https://banc-de-test.example/mcp`;

function serveurExterne(jeton: string | null): ServeurExterne {
  return {
    url: URL_BANC(),
    auth: {
      kind: jeton === null ? 'none' : 'bearer',
      fournirEntetes: jeton === null ? undefined : async () => ({ authorization: `Bearer ${jeton}` }),
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('BANC RÉEL — serveur MCP local parlant JSON-RPC', () => {
  it('connexion avec authentification valide : initialize + tools/list', async () => {
    etat.exigerAuth = true;
    etat.rediriger = false;
    etat.malforme = false;
    etat.refuserTout = false;

    const resultat = await testerConnexion(serveurExterne(JETON_VALIDE), depsVersBanc());

    expect(resultat.etat).toBe('connected');
    expect(resultat.protocole).toBe('2025-06-18');
    expect(resultat.serverInfo?.name).toBe('banc-de-test');
    expect(resultat.outils?.map((o) => o.name)).toEqual(['list_products', 'get_product', 'delete_product']);
    // La classification est locale : `delete_product` exige une confirmation.
    const suppression = resultat.outils?.find((o) => o.name === 'delete_product');
    expect(suppression?.exigeConfirmation).toBe(true);
    const lecture = resultat.outils?.find((o) => o.name === 'list_products');
    expect(lecture?.exigeConfirmation).toBe(false);
  });

  it('authentification invalide : état auth_required, aucun outil', async () => {
    etat.refuserTout = false;
    const resultat = await testerConnexion(serveurExterne('mauvais-jeton'), depsVersBanc());
    expect(resultat.etat).toBe('auth_required');
    expect(resultat.outils).toBeUndefined();
    // Le message ne doit pas reprendre le jeton fourni.
    expect(resultat.message).not.toContain('mauvais-jeton');
  });

  it('serveur exigeant une authentification, client sans jeton : auth_required', async () => {
    const resultat = await testerConnexion(serveurExterne(null), depsVersBanc());
    expect(resultat.etat).toBe('auth_required');
  });

  it('appel d’un outil de LECTURE autorisé : la réponse réelle revient', async () => {
    etat.appelsOutils.length = 0;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    const outils = [{ name: 'list_products' }];

    const resultat = await executerOutil(contexte, {
      outil: 'list_products',
      arguments: {},
      permission: { etat: 'allowed' },
      outilsConnus: outils,
      revoque: false,
    });

    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      const texte = JSON.stringify(resultat.value.contenu);
      expect(texte).toContain('list_products');
    }
    expect(etat.appelsOutils).toEqual(['list_products']);
  });

  it('refus d’une ÉCRITURE non autorisée : l’appel n’atteint jamais le serveur', async () => {
    etat.appelsOutils.length = 0;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    const outils = [{ name: 'delete_product' }];

    const resultat = await executerOutil(contexte, {
      outil: 'delete_product',
      arguments: { id: 'p1' },
      permission: { etat: 'allowed' },
      outilsConnus: outils,
      revoque: false,
    });

    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('outil_non_autorise');
    // Preuve : le serveur n'a reçu AUCUN appel d'outil.
    expect(etat.appelsOutils).toEqual([]);
  });

  it('écriture explicitement confirmée : l’appel part réellement', async () => {
    etat.appelsOutils.length = 0;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    const resultat = await executerOutil(contexte, {
      outil: 'delete_product',
      arguments: { id: 'p1' },
      permission: { etat: 'allowed', ecritureAutorisee: true },
      outilsConnus: [{ name: 'delete_product' }],
      revoque: false,
    });
    expect(resultat.ok).toBe(true);
    expect(etat.appelsOutils).toEqual(['delete_product']);
  });

  it('jeton expiré en cours de session : le serveur répond 401', async () => {
    etat.refuserTout = true;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    const resultat = await executerOutil(contexte, {
      outil: 'list_products',
      permission: { etat: 'allowed' },
      outilsConnus: [{ name: 'list_products' }],
      revoque: false,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('authentification');
  });

  it('session perdue (404) : le client rouvre une session et rejoue une fois', async () => {
    etat.refuserTout = false;
    etat.sessions.clear(); // simule une expiration de session côté serveur
    const avant = etat.initialisations;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    // On installe une session périmée : le serveur répondra 404.
    contexte.session = {
      sessionId: 'sess_perimee',
      protocole: '2025-06-18',
      serverInfo: { name: 'banc-de-test', version: '1.0.0' },
      capacites: {},
    };
    const resultat = await executerOutil(contexte, {
      outil: 'list_products',
      permission: { etat: 'allowed' },
      outilsConnus: [{ name: 'list_products' }],
      revoque: false,
    });
    expect(resultat.ok).toBe(true);
    expect(etat.initialisations).toBe(avant + 1);
    expect(contexte.session?.sessionId).not.toBe('sess_perimee');
  });

  it('redirection sur POST : refusée, jamais suivie', async () => {
    etat.rediriger = true;
    try {
      const resultat = await testerConnexion(serveurExterne(JETON_VALIDE), depsVersBanc());
      expect(resultat.etat).toBe('error');
      expect(resultat.codes).toContain('protocole');
      // Aucune tentative vers 169.254.169.254 : le message le dit.
      expect(resultat.message).not.toContain('169.254');
    } finally {
      etat.rediriger = false;
    }
  });

  it('réponse malformée : erreur de protocole, jamais un succès', async () => {
    etat.malforme = true;
    try {
      const resultat = await testerConnexion(serveurExterne(JETON_VALIDE), depsVersBanc());
      expect(resultat.etat).toBe('error');
      expect(resultat.codes?.length).toBeGreaterThan(0);
    } finally {
      etat.malforme = false;
    }
  });

  it('SSRF : sans connecteur injecté, l’adresse locale est refusée', async () => {
    // Ici on n'injecte PAS de connecteur : la couche réelle résout 127.0.0.1
    // et doit refuser. C'est la preuve que le banc ne contourne pas le SSRF.
    const resultat = await testerConnexion(
      { url: 'https://localhost/mcp', auth: { kind: 'none' } },
      { resolveHost: async () => ['127.0.0.1'] },
    );
    expect(resultat.etat).toBe('error');
    expect(resultat.codes).toContain('serveur_invalide');
  });

  it('serveur indisponible : erreur réseau claire', async () => {
    // La connexion échoue exactement comme `connectPinnedTls` le fait en
    // production : une `PinnedFetchFailure('connect_failed')`. Un `Error`
    // générique serait, lui, classé « protocole » par le transport — d'où
    // l'usage de la vraie classe ici.
    const resultat = await testerConnexion(
      { url: 'https://banc-injoignable.example/mcp', auth: { kind: 'none' } },
      {
        resolveHost: async () => ['93.184.216.34'],
        connect: async () => {
          throw new PinnedFetchFailure('connect_failed', 'Connexion impossible.');
        },
        timeoutMs: 2_000,
      },
    );
    expect(resultat.etat).toBe('error');
    expect(resultat.codes).toContain('reseau');
  });

  it('délai dépassé : erreur de timeout distincte', async () => {
    const resultat = await testerConnexion(
      { url: 'https://banc-lent.example/mcp', auth: { kind: 'none' } },
      {
        resolveHost: async () => ['93.184.216.34'],
        connect: async () => {
          // Socket muet : il n'émet jamais rien. `close()` doit débloquer la
          // lecture, comme le fait un socket Deno réel — sinon l'abandon ne
          // serait qu'apparent.
          let debloquer: ((valeur: number | null) => void) | null = null;
          let ferme = false;
          return {
            write: async (octets: Uint8Array) => octets.byteLength,
            read: () => {
              if (ferme) return Promise.resolve(null);
              return new Promise<number | null>((resolve) => {
                debloquer = resolve;
              });
            },
            close: async () => {
              ferme = true;
              if (debloquer) {
                const liberer = debloquer;
                debloquer = null;
                liberer(null);
              }
            },
          };
        },
        timeoutMs: 300,
      },
    );
    expect(resultat.etat).toBe('error');
    expect(resultat.codes).toContain('timeout');
  });

  it('révocation : un outil autorisé ne peut plus être appelé', async () => {
    etat.appelsOutils.length = 0;
    const contexte = creerContexte({ url: URL_BANC(), fournirEntetes: () => ({ authorization: `Bearer ${JETON_VALIDE}` }) }, depsVersBanc());
    const resultat = await executerOutil(contexte, {
      outil: 'list_products',
      permission: { etat: 'allowed' },
      outilsConnus: [{ name: 'list_products' }],
      revoque: true,
    });
    expect(resultat.ok).toBe(false);
    expect(etat.appelsOutils).toEqual([]);
  });

  it('aucun secret dans ce qui est observable côté client', async () => {
    const resultat = await testerConnexion(serveurExterne(JETON_VALIDE), depsVersBanc());
    const observable = JSON.stringify(resultat);
    expect(observable).not.toContain(JETON_VALIDE);
    // L'empreinte du jeton ne doit pas non plus fuiter par un champ d'erreur.
    const empreinte = createHash('sha256').update(JETON_VALIDE).digest('hex');
    expect(observable).not.toContain(empreinte);
  });
});
