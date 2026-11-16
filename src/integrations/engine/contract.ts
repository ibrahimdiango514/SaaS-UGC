/**
 * VYORA — contrat commun des connecteurs.
 *
 * ## Pourquoi un contrat avant une implémentation
 *
 * Sans contrat, chaque fournisseur ajouté invente ses propres conventions :
 * un connecteur qui renvoie `null` en cas d'échec, un autre qui lève, un
 * troisième qui écrit en base avant d'avoir vérifié le jeton. Le résultat est
 * un moteur qu'on ne peut ni tester globalement, ni auditer.
 *
 * Ce fichier fixe trois choses, et rien d'autre :
 *   1. **la forme** que tout connecteur doit respecter (`ConnectorAdapter`) ;
 *   2. **le refus par défaut** : une opération non déclarée est refusée ;
 *   3. **le vocabulaire d'erreur**, pour que l'interface ne déduise jamais un
 *      succès d'une absence de message.
 *
 * ## Ce que ce fichier ne fait pas
 *
 * Il ne contient aucun secret, aucune URL de fournisseur et aucun appel réseau.
 * Il est importable par le frontend comme par les Edge Functions : c'est une
 * description, pas une implémentation.
 *
 * ## Fail-closed
 *
 * `null` signifie « ce connecteur n'existe pas », jamais « débrouille-toi ».
 * Le registre (`registry.ts`) refuse d'enregistrer un fournisseur inconnu du
 * catalogue, et l'interface n'affiche une action que si un connecteur est
 * réellement présent.
 */

/** Modes d'authentification réellement supportés par le moteur. */
export type AuthMode = 'oauth2' | 'api-key' | 'app-install' | 'public-catalog' | 'file-import';

/**
 * Capacités granulaires d'un connecteur.
 *
 * Elles sont volontairement peu nombreuses et fermées : une capacité libre
 * (« tout faire ») rendrait impossible toute vérification de permission. Ces
 * valeurs sont un sur-ensemble strict de celles acceptées par le socle OAuth
 * (`read`, `draft`, `send`, `modify`) — un connecteur qui déclare `write` doit
 * donc prouver un scope fournisseur correspondant, sinon il est rejeté au
 * moment de l'autorisation.
 */
export type ConnectorCapability =
  | 'read'      // lire des données existantes
  | 'draft'     // préparer sans publier
  | 'send'      // envoyer / publier
  | 'modify'    // modifier ou supprimer
  | 'write';    // créer (création de produit, de client…)

/** Capacités du socle OAuth historique — sous-ensemble de `ConnectorCapability`. */
export const OAUTH_BASE_CAPABILITIES: readonly ConnectorCapability[] = ['read', 'draft', 'send', 'modify'];

/** Résultat d'une opération distante : explicite, jamais implicite. */
export type ConnectorResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConnectorError };

/**
 * Erreurs normalisées.
 *
 * `retryable` est le seul champ sur lequel l'appelant peut s'appuyer pour
 * décider d'une reprise automatique. Une erreur d'autorisation n'est jamais
 * rejouable : réessayer ne fera que multiplier les appels refusés.
 */
export type ConnectorErrorCode =
  | 'not_configured'      // identifiants serveur absents
  | 'unauthorized'        // aucun jeton valide
  | 'forbidden'           // jeton valide, permission insuffisante
  | 'rate_limited'        // quota fournisseur atteint
  | 'upstream_error'      // le fournisseur a renvoyé une erreur
  | 'invalid_response'    // réponse inattendue (schéma non respecté)
  | 'network'             // échec de transport
  | 'revoked';            // autorisation retirée côté fournisseur

export interface ConnectorError {
  code: ConnectorErrorCode;
  /** Message sûr à afficher : jamais de jeton, jamais d'URL signée. */
  message: string;
  retryable: boolean;
  /** Statut HTTP distant, pour le diagnostic interne uniquement. */
  status?: number;
}

export function connectorError(
  code: ConnectorErrorCode,
  message: string,
  extra: { retryable?: boolean; status?: number } = {},
): ConnectorError {
  // Seuls trois cas justifient une reprise automatique.
  const retryable = extra.retryable ?? (code === 'rate_limited' || code === 'network' || code === 'upstream_error');
  return { code, message, retryable, ...(extra.status !== undefined ? { status: extra.status } : {}) };
}

/** Jeton tel que manipulé en mémoire, après déchiffrement côté serveur. */
export interface AccessToken {
  value: string;
  expiresAt: string | null;
  scopes: string[];
}

/** Tout ce qu'un connecteur peut demander au moteur, et rien de plus. */
export interface ConnectorContext {
  /** Identifiant du compte interne (jamais l'identifiant fournisseur). */
  accountId: string;
  /** Jeton déchiffré, fourni par le moteur au moment de l'appel. */
  token: AccessToken;
  /** Capacités réellement accordées, intersection déclarée ∩ accordée. */
  capabilities: ConnectorCapability[];
  /** Horloge injectée : rend les tests déterministes. */
  now: () => Date;
  /** Journalisation d'audit, sans secret. */
  audit: (action: string, detail: string) => void;
}

/** Requête de test de connexion : ne doit rien modifier chez le fournisseur. */
export interface ConnectorProbe {
  ok: boolean;
  accountLabel: string | null;
  scopes: string[];
  error?: ConnectorError;
}

/**
 * Description d'un fournisseur pour l'échange OAuth.
 *
 * Les URL sont fournies par le connecteur, mais les **identifiants client**
 * viennent exclusivement de l'environnement serveur : ce contrat ne permet pas
 * de les recevoir depuis le navigateur.
 */
export interface OAuthEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Scopes demandés, dérivés des capacités — jamais libres. */
  scopesFor: (capabilities: ConnectorCapability[]) => string[];
  /** Paramètres supplémentaires (ex. `access_type=offline` pour Google). */
  extraAuthorizeParams?: Record<string, string>;
}

/** Contrat que tout connecteur doit satisfaire. */
export interface ConnectorAdapter {
  /** Clé identique au catalogue frontend (`src/integrations/catalog.ts`). */
  key: string;
  mode: AuthMode;
  /** Capacités que ce connecteur sait réellement exercer. */
  supportedCapabilities: ConnectorCapability[];
  /** Endpoints OAuth — `null` pour un mode sans OAuth (API key, fichier). */
  oauth: OAuthEndpoints | null;
  /**
   * Vérifie qu'un jeton fonctionne et récupère l'identité du compte.
   * Doit être idempotent et sans effet de bord chez le fournisseur.
   */
  probe: (ctx: ConnectorContext) => Promise<ConnectorResult<ConnectorProbe>>;
  /** Révoque l'autorisation chez le fournisseur. */
  revoke: (ctx: ConnectorContext) => Promise<ConnectorResult<void>>;
  /**
   * Synchronisation incrémentale. `cursor` vient du dernier passage réussi.
   * Absent = connecteur en lecture seule à la demande.
   */
  sync?: (ctx: ConnectorContext, cursor: string | null) => Promise<ConnectorResult<{ cursor: string | null; items: unknown[] }>>;
}

/** Une capacité déclarée est-elle couverte par les scopes réellement accordés ? */
export function capabilitiesSatisfied(
  declared: ConnectorCapability[],
  granted: ConnectorCapability[],
): ConnectorCapability[] {
  const accordees = new Set(granted);
  return declared.filter((c) => !accordees.has(c));
}

/**
 * Intersection stricte : le moteur n'utilise jamais plus de droits que ce que
 * l'utilisateur a accordé, même si le connecteur en demande davantage.
 */
export function effectiveCapabilities(
  declared: ConnectorCapability[],
  granted: ConnectorCapability[],
): ConnectorCapability[] {
  const accordees = new Set(granted);
  return declared.filter((c) => accordees.has(c));
}

/**
 * Un connecteur peut-il être proposé à la connexion ?
 *
 * `false` tant que l'implémentation n'existe pas. C'est ce prédicat qui
 * empêche l'interface d'offrir un bouton « Connecter » sans moteur derrière.
 */
export function isConnectorAvailable(
  adapter: ConnectorAdapter | null | undefined,
): adapter is ConnectorAdapter {
  return Boolean(adapter && typeof adapter.probe === 'function' && typeof adapter.revoke === 'function');
}
