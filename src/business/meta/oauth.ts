/**
 * VYORA Meta Integrations — construction du parcours d'autorisation.
 *
 * - `state` : 32 octets aléatoires en base64url, créé et consommé côté
 *   serveur (table `saas_business.meta_oauth_states`, usage unique, expiration
 *   10 minutes). Le navigateur ne fait que le transporter.
 * - URI de redirection : fixe, HTTPS, dérivée de l'URL de la fonction Edge —
 *   jamais reçue du client. Meta la compare au caractère près à la liste
 *   « Valid OAuth Redirect URIs ».
 * - `config_id` : configuration Facebook Login for Business / Embedded Signup
 *   créée dans Meta for Developers ; les permissions y sont déclarées. On
 *   transmet aussi `scope`, ce qui est accepté et documente la demande.
 */
import {
  META_EMBEDDED_SIGNUP_VERSION,
  META_GRAPH_VERSION,
  META_PRODUCT_DEFINITIONS,
  type MetaProduct,
} from './products.ts';

export const META_STATE_TTL_MS = 10 * 60 * 1000;

export function randomState(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64url(buffer);
}

/** Code PIN à 6 chiffres pour l'enregistrement d'un numéro WhatsApp. */
export function randomPin(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return String(buffer[0] % 1_000_000).padStart(6, '0');
}

export function base64url(bytes: Uint8Array): string {
  let binaire = '';
  for (const b of bytes) binaire += String.fromCharCode(b);
  return btoa(binaire).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Un `state` valide est exactement ce que `randomState()` produit. */
export function isWellFormedState(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(value);
}

/** URI de redirection unique de la plateforme : `<fonction Edge>/callback`. */
export function callbackUri(supabaseUrl: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/functions/v1/meta-connect/callback`;
}

/** URL de la boîte de dialogue Facebook Login for Business. */
export function buildLoginForBusinessUrl(input: {
  appId: string;
  product: MetaProduct;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('config_id', input.configId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('scope', META_PRODUCT_DEFINITIONS[input.product].scopes.join(','));
  return url.toString();
}

/**
 * Paramètres remis au navigateur pour lancer WhatsApp Embedded Signup via le
 * SDK Meta. Aucun secret : l'App ID et le `config_id` sont publics par
 * construction (ils figurent dans l'URL de toute boîte de dialogue).
 */
export interface EmbeddedSignupLaunch {
  mode: 'embedded-signup';
  appId: string;
  configId: string;
  state: string;
  graphVersion: string;
  /**
   * Version du parcours Embedded Signup, transmise dans `extras.version`.
   *
   * Meta a retiré v2 et v3 le 15 octobre 2026 ; une requête sans `version`
   * (ou avec une version invalide) est servie en v4. On déclare donc
   * explicitement v5 pour ne pas dépendre de ce comportement par défaut.
   */
  embeddedSignupVersion: string;
  /** Permissions attendues, pour que l'interface les affiche avant le clic. */
  scopes: string[];
}

export function embeddedSignupLaunch(input: { appId: string; configId: string; state: string }): EmbeddedSignupLaunch {
  return {
    mode: 'embedded-signup',
    appId: input.appId,
    configId: input.configId,
    state: input.state,
    graphVersion: META_GRAPH_VERSION,
    embeddedSignupVersion: META_EMBEDDED_SIGNUP_VERSION,
    scopes: [...META_PRODUCT_DEFINITIONS.whatsapp.scopes],
  };
}

/** Où renvoyer l'utilisateur dans le SaaS après le parcours Meta. */
export function returnUrl(appUrl: string, outcome: { product: MetaProduct; ok: boolean; code?: string }): string {
  const url = new URL('/app/business', appUrl.replace(/\/+$/, '') + '/');
  url.searchParams.set('section', 'integrations');
  url.searchParams.set('meta', outcome.ok ? 'connected' : 'error');
  url.searchParams.set('product', outcome.product);
  if (!outcome.ok && outcome.code) url.searchParams.set('code', outcome.code.slice(0, 64));
  return url.toString();
}

/** Expiration absolue déduite d'un `expires_in` Meta (secondes), ou `null`. */
export function expiresAtFrom(expiresIn: number | undefined, now: Date = new Date()): Date | null {
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return new Date(now.getTime() + expiresIn * 1000);
}
