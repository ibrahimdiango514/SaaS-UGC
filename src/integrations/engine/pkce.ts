/**
 * SORAHNEX — PKCE (RFC 7636) et vérification des jetons.
 *
 * ## Pourquoi PKCE et pas seulement `state`
 *
 * Un `state` protège contre le CSRF : il garantit que la réponse correspond à
 * une demande initiée par cet utilisateur. Il ne protège pas contre
 * l'interception du code d'autorisation. PKCE ajoute ce second verrou : le
 * client prouve qu'il connaît le secret qui a servi à créer la demande.
 *
 * Pour un client confidentiel (Edge Function avec secret serveur), PKCE est
 * défense en profondeur : si le code fuit, sans le vérifieur il est inutile.
 *
 * ## Ce que ce module fait volontairement
 *
 * - il n'utilise que `crypto.subtle` (Web Crypto), disponible en Edge Function
 *   comme dans le navigateur de test — aucune dépendance ;
 * - il refuse toute valeur qui ne respecte pas la longueur RFC, plutôt que de
 *   l'accepter « au cas où » ;
 * - il décrit la vérification **sans** manipuler de secret applicatif.
 */

/** Longueur minimale imposée par la RFC 7636 pour un vérifieur (43). */
export const PKCE_VERIFIER_MIN_LENGTH = 43;
/** Longueur maximale imposée par la RFC 7636 (128). */
export const PKCE_VERIFIER_MAX_LENGTH = 128;
/** Alphabet autorisé : base64url non padding. */
const VERIFIER_ALPHABET = /^[A-Za-z0-9\-._~]+$/;
/** Une empreinte S256 est un base64url de 43 caractères (SHA-256 = 32 octets). */
const S256_PATTERN = /^[A-Za-z0-9\-_]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUtf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  // Copie dans un ArrayBuffer propre : `crypto.subtle` refuse un tampon
  // potentiellement partagé (SharedArrayBuffer).
  const buffer = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buffer).set(encoded);
  return new Uint8Array(buffer);
}

/** Génère un vérifieur PKCE conforme : 32 octets aléatoires en base64url. */
export function generateVerifier(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(32));
  if (bytes.length < 32) {
    // Un vérifieur trop court réduirait l'entropie sous le seuil recommandé.
    throw new Error('pkce: entropie insuffisante (32 octets minimum)');
  }
  const verifier = toBase64Url(bytes);
  if (verifier.length < PKCE_VERIFIER_MIN_LENGTH || verifier.length > PKCE_VERIFIER_MAX_LENGTH) {
    throw new Error('pkce: vérifieur hors bornes RFC 7636');
  }
  return verifier;
}

/** Calcule la transformation S256 : `base64url(SHA-256(verifier))`. */
export async function challengeS256(verifier: string): Promise<string> {
  assertVerifier(verifier);
  const digest = await crypto.subtle.digest('SHA-256', fromUtf8(verifier));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Valide la forme d'un vérifieur.
 *
 * On refuse à l'entrée plutôt que de laisser le fournisseur rejeter : le
 * message d'erreur est alors compréhensible et l'échec ne dépend pas d'un
 * appel réseau.
 */
export function assertVerifier(verifier: string): void {
  if (typeof verifier !== 'string'
    || verifier.length < PKCE_VERIFIER_MIN_LENGTH
    || verifier.length > PKCE_VERIFIER_MAX_LENGTH
    || !VERIFIER_ALPHABET.test(verifier)) {
    throw new Error('pkce: vérifieur invalide (longueur ou alphabet)');
  }
}

/** Vérifie qu'un défi transmis a bien la forme attendue pour S256. */
export function isS256Challenge(challenge: string): boolean {
  return S256_PATTERN.test(challenge);
}

/**
 * Génère un `state` opaque.
 *
 * 32 octets aléatoires : la valeur n'est **pas** un identifiant utilisateur,
 * elle ne doit rien révéler. La base la stocke hachée par le socle et la
 * consomme une seule fois (`oauth_state_consume`), ce qui empêche le rejeu.
 */
export function generateState(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(32));
  if (bytes.length < 32) throw new Error('state: entropie insuffisante');
  return toBase64Url(bytes);
}

/**
 * Valide la forme du `state` reçu en retour avant tout appel en base.
 *
 * Une longueur anormale ou un alphabet inattendu signale une requête forgée :
 * on s'arrête là, sans consommer d'état en base.
 */
export function isValidStateShape(state: string | null | undefined): boolean {
  if (typeof state !== 'string') return false;
  return state.length >= 43 && state.length <= 128 && VERIFIER_ALPHABET.test(state);
}

/** Construction de l'URL d'autorisation, sans jamais inclure de secret client. */
export interface AuthorizeParams {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: string[];
  extra?: Record<string, string>;
}

/**
 * Compose l'URL d'autorisation.
 *
 * Vérifications avant construction :
 *   - HTTPS obligatoire : une URL d'autorisation en clair exposerait le code ;
 *   - `state` et `challenge` doivent avoir la forme attendue ;
 *   - aucun paramètre `client_secret` n'est accepté, même fourni par erreur.
 */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(params.authorizeUrl);
  if (url.protocol !== 'https:') throw new Error('oauth: authorizeUrl doit être en HTTPS');
  if (!isValidStateShape(params.state)) throw new Error('oauth: state invalide');
  if (!isS256Challenge(params.challenge)) throw new Error('oauth: code_challenge invalide (S256 attendu)');
  if (!params.clientId) throw new Error('oauth: client_id manquant');
  if (!params.redirectUri) throw new Error('oauth: redirect_uri manquant');

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (params.scopes.length > 0) url.searchParams.set('scope', params.scopes.join(' '));
  for (const [key, value] of Object.entries(params.extra ?? {})) {
    // `client_secret` n'a rien à faire dans une URL d'autorisation : il
    // finirait dans l'historique du navigateur et les journaux du fournisseur.
    if (key.toLowerCase() === 'client_secret') continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}
