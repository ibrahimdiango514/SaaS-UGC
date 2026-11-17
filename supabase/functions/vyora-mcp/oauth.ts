/**
 * VYORA — serveur d'autorisation OAuth 2.1 du serveur MCP.
 *
 * Ce module ne fait aucune entrée/sortie : il valide des requêtes, décide
 * d'une réponse et délègue tout effet de bord aux dépendances injectées. C'est
 * ce qui permet de le tester intégralement, y compris ses cas d'échec.
 *
 * ## Le cadre (spécification MCP 2025-06-18, section Authorization)
 *
 * | Exigence | Où elle est tenue ici |
 * |---|---|
 * | Métadonnées de ressource (RFC 9728) | `metadonneesRessource` + route `/.well-known/oauth-protected-resource` |
 * | Métadonnées du serveur d'autorisation (RFC 8414) | `metadonneesAutorisation` |
 * | Enregistrement dynamique de client (RFC 7591) | `enregistrerClient` |
 * | Indicateurs de ressource (RFC 8707) | `resource` exigé et comparé dans `echangerCode` |
 * | PKCE obligatoire, `S256` seul | `verifierPkce` |
 * | Aucun jeton dans l'URL | `echangerCode` lit le corps, jamais la requête |
 *
 * ## Les trois refus qui comptent
 *
 * 1. **`redirect_uri` exactement égale** à une valeur enregistrée. Accepter un
 *    préfixe suffirait à exfiltrer un code vers un domaine voisin.
 * 2. **`resource` obligatoire et conforme.** Un jeton émis sans ressource, ou
 *    pour une autre ressource, est un jeton qu'un client pourrait rejouer
 *    ailleurs. On refuse plutôt que de deviner.
 * 3. **Un code ne sert qu'une fois.** La consommation est atomique en base ;
 *    ici on refuse même de tenter un second échange avec un code déjà vu.
 *
 * ## Ce que ce module ne prétend pas être
 *
 * Ce n'est pas un serveur d'autorisation généraliste : pas de `implicit`, pas de
 * `client_credentials`, pas de consentement mémorisé, pas de portée par
 * utilisateur final au-delà de `read`/`write`. C'est le sous-ensemble exigé par
 * MCP, et rien de plus — un endpoint non implémenté est un endpoint qui ne peut
 * pas être mal configuré.
 */

/** Durée de vie d'un code d'autorisation, en secondes. */
export const DUREE_CODE_SECONDES = 600;

/** Durée de vie d'un jeton d'accès, en secondes. */
export const DUREE_ACCES_SECONDES = 3600;

/** Méthodes PKCE acceptées : `S256` uniquement (OAuth 2.1 interdit `plain`). */
export const METHODES_PKCE = ['S256'] as const;

/** Portées que VYORA sait accorder. */
export const PORTEES_SUPPORTEES = ['read', 'write'] as const;

export type PorteeOAuth = (typeof PORTEES_SUPPORTEES)[number];

export interface ErreurOAuth {
  /** Code d'erreur OAuth normalisé (RFC 6749 §5.2). */
  error: string;
  /** Message lisible, jamais une trace interne. */
  error_description: string;
  status: number;
}

export type ResultatOAuth<T> = { ok: true; value: T } | { ok: false; error: ErreurOAuth };

function refus(error: string, error_description: string, status = 400): { ok: false; error: ErreurOAuth } {
  return { ok: false, error: { error, error_description, status } };
}

/* -------------------------------------------------------------------------- */
/* 1. Métadonnées de ressource (RFC 9728)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Document `/.well-known/oauth-protected-resource`.
 *
 * `resource` doit être l'URI canonique du serveur MCP, sans barre oblique
 * finale ni fragment (RFC 8707 §2). `authorization_servers` est obligatoire :
 * sans lui, un client ne sait pas où aller et le document est inutile.
 */
export function metadonneesRessource(ressource: string, emetteur: string): Record<string, unknown> {
  return {
    resource: ressource,
    authorization_servers: [emetteur],
    scopes_supported: [...PORTEES_SUPPORTEES],
    bearer_methods_supported: ['header'],
    resource_name: 'VYORA MCP',
  };
}

/**
 * Document `/.well-known/oauth-authorization-server` (RFC 8414).
 *
 * Les endpoints sont dérivés de l'émetteur : le document ne peut pas annoncer
 * une adresse différente de celle qui le sert, ce qui rend une redirection
 * d'autorisation vers un tiers impossible sans changer la configuration.
 */
export function metadonneesAutorisation(emetteur: string): Record<string, unknown> {
  return {
    issuer: emetteur,
    authorization_endpoint: `${emetteur}/oauth/authorize`,
    token_endpoint: `${emetteur}/oauth/token`,
    registration_endpoint: `${emetteur}/oauth/register`,
    scopes_supported: [...PORTEES_SUPPORTEES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: [...METHODES_PKCE],
    // Pas de `implicit`, pas de `password` : OAuth 2.1 les proscrit.
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Enregistrement dynamique de client (RFC 7591)                            */
/* -------------------------------------------------------------------------- */

export interface DemandeEnregistrement {
  client_name?: unknown;
  redirect_uris?: unknown;
  token_endpoint_auth_method?: unknown;
  scope?: unknown;
}

export interface ClientEnregistre {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post';
  scope: string;
  grant_types: string[];
  response_types: string[];
}

/**
 * Valide une demande d'enregistrement.
 *
 * Les `redirect_uris` sont l'entrée la plus dangereuse du protocole : c'est
 * l'adresse vers laquelle un code d'autorisation sera envoyé. On refuse tout
 * ce qui n'est pas un `https:` absolu, sauf la boucle locale en `http:` que
 * RFC 8252 autorise pour les applications de bureau.
 *
 * Cette validation est doublée en base (`mcp_oauth_register_client`) : le code
 * Edge peut être contourné par un appel direct à la RPC, pas la base.
 */
export function validerEnregistrement(demande: DemandeEnregistrement): ResultatOAuth<{
  client_name: string;
  redirect_uris: string[];
  is_public: boolean;
  allowed_scopes: string[];
}> {
  const uris = demande.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return refus('invalid_redirect_uri', 'Au moins une « redirect_uri » est requise.');
  }
  if (uris.length > 10) {
    return refus('invalid_redirect_uri', 'Dix « redirect_uri » au maximum.');
  }
  for (const uri of uris) {
    if (typeof uri !== 'string') {
      return refus('invalid_redirect_uri', 'Chaque « redirect_uri » doit être une chaîne.');
    }
    if (uri.includes('#')) {
      return refus('invalid_redirect_uri', 'Une « redirect_uri » ne peut pas contenir de fragment.');
    }
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return refus('invalid_redirect_uri', `« ${uri} » n’est pas une URL absolue.`);
    }
    const boucleLocale = url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1');
    if (url.protocol !== 'https:' && !boucleLocale) {
      return refus('invalid_redirect_uri', 'Seules les URL HTTPS sont acceptées (boucle locale HTTP tolérée pour un client de bureau).');
    }
  }

  const methode = demande.token_endpoint_auth_method ?? 'none';
  if (methode !== 'none' && methode !== 'client_secret_post') {
    return refus('invalid_client_metadata', 'Seules les méthodes « none » et « client_secret_post » sont supportées.');
  }

  const portees = typeof demande.scope === 'string' && demande.scope.trim()
    ? demande.scope.trim().split(/\s+/)
    : ['read'];
  const porteesInvalides = portees.filter((p) => !(PORTEES_SUPPORTEES as readonly string[]).includes(p));
  if (porteesInvalides.length > 0) {
    return refus('invalid_scope', `Portée inconnue : ${porteesInvalides.join(', ')}.`);
  }

  const nom = typeof demande.client_name === 'string' && demande.client_name.trim()
    ? demande.client_name.trim().slice(0, 120)
    : 'Client MCP';

  return {
    ok: true,
    value: {
      client_name: nom,
      redirect_uris: uris as string[],
      // Un client qui demande un secret est traité comme confidentiel ; sinon
      // client public + PKCE, qui est le cas normal d'un client MCP.
      is_public: methode === 'none',
      allowed_scopes: portees,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Requête d'autorisation                                                   */
/* -------------------------------------------------------------------------- */

export interface ParametresAutorisation {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
  state?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  resource?: string | null;
}

export interface AutorisationValidee {
  client_id: string;
  redirect_uri: string;
  scopes: string[];
  state: string | null;
  code_challenge: string;
  resource: string;
}

/** Longueur d'un `code_verifier` PKCE (RFC 7636 §4.1) : 43 à 128 caractères. */
function longueurVerifierValide(valeur: string): boolean {
  return valeur.length >= 43 && valeur.length <= 128;
}

/**
 * Valide la requête d'autorisation.
 *
 * `client` est fourni par l'appelant après lecture en base : ce module ne sait
 * pas chercher un client, il sait seulement décider si une requête est
 * acceptable pour un client donné.
 *
 * L'ordre des contrôles suit la spécification : `client_id` et `redirect_uri`
 * d'abord (sans quoi l'erreur ne peut pas être renvoyée au bon endroit), puis
 * le reste. Une `redirect_uri` non conforme produit toujours une erreur
 * affichée, jamais une redirection : rediriger vers une adresse non vérifiée
 * est précisément l'attaque à éviter.
 */
export function validerAutorisation(
  parametres: ParametresAutorisation,
  client: { client_id: string; redirect_uris: string[]; allowed_scopes: string[] } | null,
  ressourceAttendue: string,
): ResultatOAuth<AutorisationValidee> {
  if (!client) {
    return refus('unauthorized_client', 'Client inconnu ou révoqué.', 401);
  }

  if (parametres.response_type !== 'code') {
    return refus('unsupported_response_type', 'Seul « response_type=code » est supporté.');
  }

  const redirect = typeof parametres.redirect_uri === 'string' ? parametres.redirect_uri : '';
  if (!client.redirect_uris.includes(redirect)) {
    return refus(
      'invalid_request',
      'La « redirect_uri » ne correspond exactement à aucune adresse enregistrée pour ce client.',
    );
  }

  const challenge = typeof parametres.code_challenge === 'string' ? parametres.code_challenge : '';
  if (!longueurVerifierValide(challenge)) {
    return refus('invalid_request', 'Le paramètre « code_challenge » PKCE est requis (43 à 128 caractères).');
  }
  const methode = parametres.code_challenge_method ?? 'S256';
  if (methode !== 'S256') {
    return refus('invalid_request', 'PKCE « S256 » uniquement : « plain » est refusé.');
  }

  // RFC 8707 : la ressource doit être le serveur MCP lui-même. On compare la
  // forme canonique, sans barre oblique finale ni casse de schéma/hôte.
  const resource = canonicaliserRessource(parametres.resource);
  if (resource === null) {
    return refus('invalid_target', 'Le paramètre « resource » (RFC 8707) est requis et doit être une URL HTTPS.');
  }
  if (resource !== canonicaliserRessource(ressourceAttendue)) {
    return refus('invalid_target', 'La ressource demandée ne correspond pas à ce serveur MCP.');
  }

  const demandees = typeof parametres.scope === 'string' && parametres.scope.trim()
    ? parametres.scope.trim().split(/\s+/)
    : ['read'];
  const horsPortee = demandees.filter((p) => !client.allowed_scopes.includes(p));
  if (horsPortee.length > 0) {
    return refus('invalid_scope', `Portée non autorisée pour ce client : ${horsPortee.join(', ')}.`);
  }

  const state = typeof parametres.state === 'string' ? parametres.state : null;
  if (state !== null && (state.length > 512 || /[\r\n]/.test(state))) {
    return refus('invalid_request', 'Le paramètre « state » est invalide.');
  }

  return {
    ok: true,
    value: {
      client_id: client.client_id,
      redirect_uri: redirect,
      scopes: demandees,
      state,
      code_challenge: challenge,
      resource,
    },
  };
}

/**
 * Forme canonique d'une ressource (RFC 8707 §2, note MCP).
 *
 * Schéma et hôte en minuscules, pas de fragment, pas de barre oblique finale
 * superflue, pas de port par défaut explicite. Renvoie `null` si l'URI n'est
 * pas une URL HTTPS absolue : une ressource en `http:` n'identifie pas un
 * serveur MCP protégé.
 */
export function canonicaliserRessource(valeur: unknown): string | null {
  if (typeof valeur !== 'string' || !valeur.trim()) return null;
  let url: URL;
  try {
    url = new URL(valeur.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hash) return null;
  if (url.username || url.password) return null;
  const chemin = url.pathname.replace(/\/+$/, '');
  const port = url.port === '' || url.port === '443' ? '' : `:${url.port}`;
  return `https://${url.hostname.toLowerCase()}${port}${chemin}`;
}

/* -------------------------------------------------------------------------- */
/* 4. Échange de code contre jeton                                             */
/* -------------------------------------------------------------------------- */

export interface DemandeJeton {
  grant_type?: unknown;
  code?: unknown;
  redirect_uri?: unknown;
  client_id?: unknown;
  code_verifier?: unknown;
  resource?: unknown;
  refresh_token?: unknown;
  client_secret?: unknown;
}

export interface CodeStocke {
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scopes: string[];
  code_challenge: string;
  resource: string;
}

/**
 * Vérifie PKCE : `BASE64URL(SHA-256(code_verifier)) == code_challenge`.
 *
 * La comparaison est faite en temps constant sur les chaînes déjà encodées :
 * comparer avec `===` exposerait, en théorie, une fuite par mesure de temps.
 * Le risque est faible sur un challenge public, mais le coût de la précaution
 * est nul.
 */
export async function verifierPkce(code_verifier: string, code_challenge: string): Promise<boolean> {
  if (!longueurVerifierValide(code_verifier)) return false;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(code_verifier)) return false;
  const donnees = new TextEncoder().encode(code_verifier);
  const digest = await crypto.subtle.digest('SHA-256', donnees);
  const calcule = base64Url(new Uint8Array(digest));
  return egalConstant(calcule, code_challenge);
}

function base64Url(octets: Uint8Array): string {
  let binaire = '';
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Comparaison à durée constante, sans dépendre de `crypto.timingSafeEqual`. */
function egalConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * Valide un échange `authorization_code`.
 *
 * Tous les contrôles sont faits ici, dans cet ordre :
 *   1. `grant_type` supporté ;
 *   2. code présent et exploitable (fourni par l'appelant après consommation) ;
 *   3. `client_id` identique à celui qui a obtenu le code ;
 *   4. `redirect_uri` identique à celle de la demande d'autorisation ;
 *   5. `resource` identique à celle de la demande d'autorisation ;
 *   6. PKCE vérifié.
 *
 * L'étape 2 est faite AVANT l'appel : un code inconnu ne doit pas déclencher de
 * travail inutile, et surtout la consommation est atomique en base.
 */
export async function echangerCode(
  demande: DemandeJeton,
  codeStocke: CodeStocke | null,
  ressourceAttendue: string,
): Promise<ResultatOAuth<{ user_id: string; scopes: string[]; client_id: string }>> {
  if (demande.grant_type !== 'authorization_code') {
    return refus('unsupported_grant_type', 'Seul « authorization_code » est supporté sur ce point d’entrée.');
  }
  if (!codeStocke) {
    return refus('invalid_grant', 'Code d’autorisation inconnu, déjà utilisé ou expiré.');
  }
  if (typeof demande.client_id !== 'string' || demande.client_id !== codeStocke.client_id) {
    return refus('invalid_grant', 'Le code a été émis pour un autre client.', 401);
  }
  if (typeof demande.redirect_uri !== 'string' || demande.redirect_uri !== codeStocke.redirect_uri) {
    return refus('invalid_grant', 'La « redirect_uri » ne correspond pas à celle de la demande d’autorisation.');
  }
  const resource = canonicaliserRessource(demande.resource);
  if (resource === null || resource !== codeStocke.resource) {
    return refus('invalid_target', 'Le paramètre « resource » ne correspond pas à celui de la demande d’autorisation.');
  }
  if (resource !== canonicaliserRessource(ressourceAttendue)) {
    return refus('invalid_target', 'La ressource demandée ne correspond pas à ce serveur MCP.');
  }
  const verifier = typeof demande.code_verifier === 'string' ? demande.code_verifier : '';
  if (!(await verifierPkce(verifier, codeStocke.code_challenge))) {
    return refus('invalid_grant', 'PKCE invalide : le « code_verifier » ne correspond pas au défi.');
  }
  return {
    ok: true,
    value: { user_id: codeStocke.user_id, scopes: codeStocke.scopes, client_id: codeStocke.client_id },
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Réponses d'erreur et d'en-tête                                           */
/* -------------------------------------------------------------------------- */

/**
 * En-tête `WWW-Authenticate` d'un 401 (RFC 9728 §5.1).
 *
 * Le client MCP s'en sert pour découvrir `/.well-known/oauth-protected-resource`.
 * Sans lui, un client conforme ne peut pas démarrer le flux OAuth : c'est la
 * pièce qui relie le serveur de ressources à son serveur d'autorisation.
 */
export function enteteDefi(metadonneesUrl: string, options: { erreur?: string; portees?: string[] } = {}): string {
  const parties = [`realm="vyora-mcp"`, `resource_metadata="${metadonneesUrl}"`];
  if (options.erreur) parties.push(`error="${options.erreur}"`);
  if (options.portees?.length) parties.push(`scope="${options.portees.join(' ')}"`);
  return `Bearer ${parties.join(', ')}`;
}

/** Corps d'erreur OAuth : jamais de trace, jamais de détail interne. */
export function corpsErreur(error: string, error_description: string): Record<string, unknown> {
  return { error, error_description };
}

/**
 * Valide un en-tête `Authorization` de type Bearer.
 *
 * Renvoie uniquement le jeton : le schéma `Basic` d'un client confidentiel est
 * refusé au niveau de la ressource, car un jeton MCP ne se présente jamais en
 * Basic.
 */
export function lireBearer(entete: string | null | undefined): string | null {
  if (!entete) return null;
  const correspondance = /^Bearer\s+(\S+)$/i.exec(entete.trim());
  return correspondance ? correspondance[1] : null;
}
