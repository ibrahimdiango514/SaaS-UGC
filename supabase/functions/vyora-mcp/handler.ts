/**
 * VYORA — serveur MCP officiel : transport HTTP et authentification.
 *
 * ## Transport
 *
 * Streamable HTTP en réponse JSON directe : `POST` uniquement. Il n'y a pas de
 * flux SSE persistant, et c'est un choix assumé, pas une limitation subie :
 *
 *   - tous les outils VYORA sont des lectures courtes (une requête SQL), pas
 *     des tâches de longue durée qui justifieraient une progression poussée ;
 *   - un flux SSE maintenu ouvert consomme une instance Edge pendant toute la
 *     durée de la connexion, sans rien apporter ici ;
 *   - la spécification autorise explicitement un serveur à répondre en JSON
 *     direct, et `GET` doit alors renvoyer 405 — ce que fait ce handler.
 *
 * `Mcp-Session-Id` n'est pas émis : sans état côté transport, il n'y a rien à
 * rattacher. La continuité vient du jeton, pas d'une session en mémoire — ce
 * qui rend le serveur insensible à un redémarrage d'instance.
 *
 * ## Authentification
 *
 * `Authorization: Bearer vyora_mcp_…`. Le secret est haché en SHA-256 et
 * confronté à `mcp_tokens`. **Aucune clé Supabase n'est jamais transmise au
 * client** : le serveur Edge détient la clé de service et ne l'expose ni en
 * réponse, ni en en-tête, ni en erreur.
 *
 * Un jeton absent, mal formé, inconnu, révoqué, expiré ou rattaché à une
 * connexion révoquée produit un 401 avec `WWW-Authenticate`, ce qui indique au
 * client qu'il doit réauthentifier — c'est le mécanisme de reprise prévu par
 * le protocole.
 */
import {
  CODES,
  erreur,
  traiterCorps,
  type ContexteJeton,
  type Dependances,
  type JournalEntree,
} from './core.ts';

export const SERVER_INFO = { name: 'vyora-mcp', version: '2.0.0' } as const;

/** Longueur minimale acceptée pour un secret, avant tout appel base. */
const SECRET_MIN = 24;
const SECRET_MAX = 200;
const PREFIXE = 'vyora_mcp_';

/** Dépendances du handler : tout est injectable, donc tout est testable. */
export interface DependancesServeur {
  /** Résout un jeton en contexte, ou `null` s'il est invalide/révoqué/expiré. */
  resoudreJeton(secret: string): Promise<ContexteJeton | null>;
  /** Met à jour `last_used_at` et le compteur d'usage. Ne doit pas échouer. */
  toucherJeton(tokenId: string): Promise<void>;
  appelerRpc(nom: string, args: Record<string, unknown>): Promise<unknown>;
  outilAutorise(contexte: ContexteJeton, nomOutil: string, portee: string): Promise<boolean>;
  journaliser(entree: JournalEntree): Promise<void>;
  ecritureActive: boolean;
  maintenant?: () => number;
  /**
   * URL publique de ce serveur MCP, utilisée pour publier l'adresse des
   * métadonnées OAuth dans les défis 401. Optionnelle : sans elle, le serveur
   * se comporte exactement comme en v5.
   */
  ressourcePublicitaire?: string;
}

export interface ReponseHttp {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export const ENTETES_CORS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'mcp-protocol-version',
};

/**
 * Extrait le secret d'un en-tête `Authorization`.
 *
 * Le préfixe et les bornes de longueur sont vérifiés AVANT tout appel réseau ou
 * base : une requête manifestement invalide ne doit pas coûter une connexion
 * PostgreSQL.
 */
export function lireJeton(enteteAuthorization: string | null | undefined): string | null {
  if (!enteteAuthorization) return null;
  const correspondance = /^Bearer\s+(.+)$/i.exec(enteteAuthorization.trim());
  if (!correspondance) return null;
  const secret = correspondance[1].trim();
  if (!secret.startsWith(PREFIXE)) return null;
  if (secret.length < SECRET_MIN || secret.length > SECRET_MAX) return null;
  return secret;
}

/**
 * Traduit une erreur d'accès en réponse 401 avec l'en-tête attendu.
 *
 * ## `resource_metadata` : la moitié du travail d'un client inconnu
 *
 * Un client MCP qui reçoit un simple 401 ne sait pas où demander un jeton : il
 * n'a que l'URL du serveur MCP, rien d'autre. La spécification d'autorisation
 * MCP impose donc d'ajouter `resource_metadata`, l'URL du document RFC 9728
 * qui décrit la ressource, son serveur d'autorisation et les portées valides.
 *
 * C'est ce qui rend le branchement possible SANS configuration manuelle : le
 * client découvre `authorization_servers`, puis le document RFC 8414, puis
 * s'enregistre dynamiquement. Sans cet en-tête, le client devrait deviner, et
 * un client qui devine est un client qui n'essaie pas.
 *
 * `deps.ressourcePublicitaire` est fourni par `index.ts` ; absent (tests, ou
 * configuration incomplète), l'en-tête reste ce qu'il était en v5 : un défi
 * minimal, jamais une URL inventée.
 */
function nonAutorise(
  message: string,
  codeErreur = 'invalid_token',
  ressourcePublicitaire?: string,
): ReponseHttp {
  const defi = [`Bearer realm="vyora-mcp"`, `error="${codeErreur}"`];
  if (ressourcePublicitaire) {
    defi.push(`resource_metadata="${adresseMetadonnees(ressourcePublicitaire)}"`);
  }
  return {
    status: 401,
    body: erreur(null, CODES.unauthorized, message),
    headers: {
      ...ENTETES_CORS,
      'WWW-Authenticate': defi.join(', '),
    },
  };
}

/**
 * Adresse du document de ressource, dérivée de l'URL du serveur MCP.
 *
 * L'URL relative (`.well-known` sous le chemin de la fonction) est la forme que
 * `index.ts` sert réellement : la fonction Edge ne peut pas répondre à la
 * racine du domaine. On n'invente donc rien, on pointe sur une route qui existe.
 */
function adresseMetadonnees(ressource: string): string {
  return `${ressource.replace(/\/+$/, '')}/.well-known/oauth-protected-resource`;
}

/**
 * Traite une requête HTTP MCP.
 *
 * Ne lève jamais : toute panne devient une réponse structurée. Un 500 opaque
 * empêcherait le client MCP de distinguer « jeton invalide » de « serveur en
 * panne », et il réessaierait indéfiniment dans le second cas.
 */
export async function traiterRequete(
  deps: DependancesServeur,
  entree: {
    method: string;
    authorization: string | null;
    body: unknown;
    /** Vrai si le corps n'a pas pu être lu comme du JSON. */
    corpsIllisible?: boolean;
    /** En-tête `mcp-protocol-version` éventuel, renvoyé tel quel. */
    protocoleDemande?: string | null;
  },
): Promise<ReponseHttp> {
  const { method, authorization, body, corpsIllisible, protocoleDemande } = entree;

  // Préflight CORS : indispensable pour un client web (navigateur).
  if (method === 'OPTIONS') return { status: 204, body: null, headers: ENTETES_CORS };

  if (method === 'GET') {
    /*
     * Un GET sur un serveur sans flux SSE doit être refusé explicitement :
     * renvoyer 200 laisserait le client attendre un flux qui n'arrivera jamais.
     */
    return {
      status: 405,
      body: erreur(
        null,
        CODES.methodNotFound,
        'Ce serveur MCP répond en JSON direct : utilisez POST. Aucun flux SSE persistant n’est proposé.',
      ),
      headers: { ...ENTETES_CORS, Allow: 'POST, OPTIONS' },
    };
  }

  if (method !== 'POST' && method !== 'DELETE') {
    return {
      status: 405,
      body: erreur(null, CODES.methodNotFound, `Méthode HTTP non supportée : ${method}`),
      headers: { ...ENTETES_CORS, Allow: 'POST, OPTIONS' },
    };
  }

  if (method === 'DELETE') {
    /*
     * `DELETE` clôt une session. Comme le serveur n'en tient aucune, la réponse
     * honnête est 405 : prétendre avoir fermé une session inexistante ferait
     * croire au client que son jeton est révoqué.
     */
    return {
      status: 405,
      body: erreur(null, CODES.methodNotFound, 'Aucune session côté serveur à fermer : révoquez le jeton depuis VYORA.'),
      headers: { ...ENTETES_CORS, Allow: 'POST, OPTIONS' },
    };
  }

  const secret = lireJeton(authorization);
  if (!secret) {
    return nonAutorise(
      'Jeton MCP absent ou mal formé. En-tête attendu : « Authorization: Bearer vyora_mcp_… ».',
      'invalid_request',
      deps.ressourcePublicitaire,
    );
  }

  let contexte: ContexteJeton | null = null;
  try {
    contexte = await deps.resoudreJeton(secret);
  } catch {
    // Une panne de la base ne doit pas être annoncée comme « jeton invalide » :
    // le client conclurait à tort que son jeton est mort et le révoquerait.
    return {
      status: 503,
      body: erreur(null, -32603, 'Le service MCP n’a pas pu vérifier le jeton. Réessayez dans un instant.'),
      headers: { ...ENTETES_CORS, 'Retry-After': '5' },
    };
  }
  if (!contexte) {
    return nonAutorise('Jeton MCP invalide, révoqué ou expiré.', 'invalid_token', deps.ressourcePublicitaire);
  }

  if (corpsIllisible) {
    return {
      status: 400,
      body: erreur(null, CODES.parse, 'Corps JSON illisible.'),
      headers: ENTETES_CORS,
    };
  }

  // Le compteur d'usage est best-effort : son échec ne bloque pas la requête.
  try {
    await deps.toucherJeton(contexte.tokenId);
  } catch {
    /* ignoré volontairement */
  }

  const dependances: Dependances = {
    ecritureActive: deps.ecritureActive,
    appelerRpc: deps.appelerRpc,
    outilAutorise: (ctx, nom, portee) => deps.outilAutorise(ctx, nom, portee),
    journaliser: deps.journaliser,
  };

  let resultat: { status: number; payload: unknown };
  try {
    resultat = await traiterCorps(dependances, contexte, body, {
      serverInfo: SERVER_INFO,
      now: deps.maintenant,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'erreur inconnue';
    return {
      status: 500,
      body: erreur(null, -32603, `Erreur interne du serveur MCP : ${message}`),
      headers: ENTETES_CORS,
    };
  }

  const headers: Record<string, string> = { ...ENTETES_CORS };
  // Le serveur répète la version négociée : certains clients la vérifient sur
  // chaque réponse, pas seulement à l'initialisation.
  if (protocoleDemande) headers['mcp-protocol-version'] = protocoleDemande;

  if (resultat.payload === null) return { status: resultat.status, body: null, headers };
  return { status: resultat.status, body: resultat.payload, headers };
}
