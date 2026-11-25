/**
 * SORAHNEX — serveur d'autorisation OAuth 2.1 du serveur MCP.
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

/** Portées que SORAHNEX sait accorder. */
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
    resource_name: 'SORAHNEX MCP',
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
): Promise<ResultatOAuth<{ user_id: string; scopes: string[]; client_id: string; resource: string }>> {
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
    value: {
      user_id: codeStocke.user_id,
      scopes: codeStocke.scopes,
      client_id: codeStocke.client_id,
      resource,
    },
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

/* -------------------------------------------------------------------------- */
/* Primitives cryptographiques                                                 */
/* -------------------------------------------------------------------------- */

/**
 * SHA-256 hexadécimal d'une chaîne, en JavaScript pur.
 *
 * Pourquoi pas `crypto.subtle` : il est asynchrone (`Promise<ArrayBuffer>`), et
 * cette dérivation doit être synchrone — elle alimente le rendu d'une page
 * HTML. Un `await` imposé au rendu ferait de chaque page de consentement une
 * occasion de plus d'échouer sur un timeout.
 *
 * Pourquoi pas une bibliothèque : ce module tourne sur une Edge Function, où
 * l'on n'ajoute pas de dépendance pour vingt lignes de cryptographie.
 *
 * Ce que ce hash protège : un jeton anti-rejeu dérivé d'une session déjà
 * authentifiée. Ce qu'il ne protège PAS : les secrets de jeton, dont les
 * empreintes sont calculées en base par `mcp_token_hash` (pgcrypto), jamais ici.
 */
export function creerHash(texte: string, longueur = 32): string {
  const octets = new TextEncoder().encode(texte);
  const mots: number[] = [];
  const bits = octets.length * 8;
  for (let i = 0; i < octets.length; i += 1) {
    mots[i >> 2] = (mots[i >> 2] ?? 0) | (octets[i] << (24 - (i % 4) * 8));
  }
  mots[octets.length >> 2] = (mots[octets.length >> 2] ?? 0) | (0x80 << (24 - (octets.length % 4) * 8));
  const totalMots = (((octets.length + 8) >> 6) + 1) * 16;
  while (mots.length < totalMots) mots.push(0);
  mots[totalMots - 1] = bits;

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;

  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

  for (let bloc = 0; bloc < mots.length; bloc += 16) {
    for (let i = 0; i < 16; i += 1) w[i] = mots[bloc + i] | 0;
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0; let b = h1; let c = h2; let d = h3;
    let e = h4; let f = h5; let g = h6; let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + k[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const hex = [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => (v >>> 0).toString(16).padStart(8, '0'))
    .join('');
  return hex.slice(0, longueur);
}

/** SHA-256 complet, en hexadécimal minuscule (64 caractères). */
export function sha256Hex(texte: string): string {
  return creerHash(texte, 64);
}

/**
 * Comparaison à temps constant.
 *
 * Une comparaison `===` sort au premier octet différent : le temps de réponse
 * révèle alors le préfixe correct. Sur un jeton anti-rejeu de 64 caractères,
 * cela suffit à le reconstituer par mesure. On parcourt donc TOUJOURS tout.
 */
export function tempsConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
