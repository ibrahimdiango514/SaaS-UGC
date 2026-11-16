// VYORA — fournisseur Google (Gmail, Drive, Calendar).
//
// Ce module ne détient aucun état : il construit des URL, échange des codes et
// appelle les API officielles. Il est entièrement testable via injection de
// `fetch` — aucun test ne dépend du réseau.
//
// ## Permissions séparées
// Chaque capacité demande ses propres scopes, et RIEN de plus :
//   read   → gmail.readonly            / drive.readonly  / calendar.readonly
//   draft  → gmail.compose             / —               / —
//   send   → gmail.send                / —               / —
//   modify → gmail.modify              / drive.file      / calendar.events
//
// Une capacité n'est JAMAIS impliquée par une autre : un jeton `read` ne peut
// pas rédiger, et un jeton `draft` ne peut pas envoyer. C'est vérifié à deux
// endroits — au moment de l'autorisation (scopes demandés) et au moment de
// l'appel (contrôle de capacité avant toute requête).

export type OAuthCapability = 'read' | 'draft' | 'send' | 'modify';
export type GoogleProvider = 'gmail' | 'google_drive' | 'google_calendar';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

interface ProviderSpec {
  /** Scope minimal par capacité. `null` = capacité non applicable. */
  readonly scopes: Record<OAuthCapability, string | null>;
  /** Scopes demandés en plus, sans lesquels l'API ne répond pas. */
  readonly baseScopes: readonly string[];
  /** Point d'entrée « profil » pour vérifier réellement le compte. */
  readonly profileUrl: string;
  readonly label: string;
}

export const PROVIDERS: Record<GoogleProvider, ProviderSpec> = {
  gmail: {
    baseScopes: ['openid', 'email', 'profile'],
    scopes: {
      // `gmail.readonly` : lecture seule, y compris les messages.
      read: 'https://www.googleapis.com/auth/gmail.readonly',
      // `gmail.compose` : créer des brouillons SANS les envoyer.
      draft: 'https://www.googleapis.com/auth/gmail.compose',
      // `gmail.send` : envoyer. Volontairement distinct de compose.
      send: 'https://www.googleapis.com/auth/gmail.send',
      // `gmail.modify` : étiquettes et modification de messages.
      modify: 'https://www.googleapis.com/auth/gmail.modify',
    },
    profileUrl: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    label: 'Gmail',
  },
  google_drive: {
    baseScopes: ['openid', 'email', 'profile'],
    scopes: {
      read: 'https://www.googleapis.com/auth/drive.readonly',
      draft: null,
      send: null,
      // `drive.file` : accès UNIQUEMENT aux fichiers créés par l'application.
      modify: 'https://www.googleapis.com/auth/drive.file',
    },
    profileUrl: 'https://www.googleapis.com/drive/v3/about?fields=user',
    label: 'Google Drive',
  },
  google_calendar: {
    baseScopes: ['openid', 'email', 'profile'],
    scopes: {
      read: 'https://www.googleapis.com/auth/calendar.readonly',
      draft: null,
      send: null,
      modify: 'https://www.googleapis.com/auth/calendar.events',
    },
    profileUrl: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
    label: 'Google Calendar',
  },
};

export class CapabilityDeniedError extends Error {
  readonly capability: OAuthCapability;
  constructor(capability: OAuthCapability, provider: GoogleProvider) {
    super(`capacité « ${capability} » non accordée pour ${provider}`);
    this.name = 'CapabilityDeniedError';
    this.capability = capability;
  }
}

/** Vérifie qu'une capacité est applicable au fournisseur. */
export function isCapabilitySupported(provider: GoogleProvider, capability: OAuthCapability): boolean {
  return PROVIDERS[provider].scopes[capability] !== null;
}

/**
 * Construit la liste de scopes pour les capacités demandées.
 * Toute capacité non supportée est une erreur, jamais ignorée en silence.
 */
export function scopesFor(provider: GoogleProvider, capabilities: readonly OAuthCapability[]): string[] {
  const spec = PROVIDERS[provider];
  const scopes = new Set<string>(spec.baseScopes);
  for (const capability of capabilities) {
    const scope = spec.scopes[capability];
    if (!scope) throw new Error(`capacité non supportée: ${provider}/${capability}`);
    scopes.add(scope);
  }
  return [...scopes];
}

/** Lève CapabilityDeniedError si la capacité n'est pas dans la liste accordée. */
export function assertCapability(granted: readonly string[], capability: OAuthCapability, provider: GoogleProvider): void {
  if (!granted.includes(capability)) throw new CapabilityDeniedError(capability, provider);
}

export interface AuthorizationUrlInput {
  provider: GoogleProvider;
  clientId: string;
  redirectUri: string;
  capabilities: readonly OAuthCapability[];
  state: string;
  codeChallenge: string;
}

/**
 * URL d'autorisation.
 *
 * `access_type=offline` + `prompt=consent` : sans ces deux paramètres, Google ne
 * renvoie pas de refresh token et le connecteur mourrait au bout d'une heure.
 * `include_granted_scopes=true` n'est PAS utilisé : il élargirait
 * silencieusement les permissions d'une autorisation précédente.
 */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: scopesFor(input.provider, input.capabilities).join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scopes: string[];
  idToken: string | null;
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function parseTokenResponse(response: Response): Promise<TokenSet> {
  const payload = (await response.json()) as RawTokenResponse;
  if (!response.ok || payload.error) {
    const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`;
    throw new Error(`token_exchange_failed:${code}`);
  }
  if (typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw new Error('token_exchange_failed:no_access_token');
  }
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresInSeconds: typeof payload.expires_in === 'number' ? payload.expires_in : 3600,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
    idToken: typeof payload.id_token === 'string' ? payload.id_token : null,
  };
}

export interface TokenExchangeInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}

/** Échange le code d'autorisation contre des jetons. Appel serveur uniquement. */
export async function exchangeCode(input: TokenExchangeInput): Promise<TokenSet> {
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return parseTokenResponse(response);
}

/** Rafraîchit un access token expiré. */
export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: typeof fetch;
}): Promise<TokenSet> {
  const doFetch = input.fetchImpl ?? fetch;
  const response = await doFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  // Google ne renvoie pas de nouveau refresh token : on conserve l'ancien.
  const tokens = await parseTokenResponse(response);
  return { ...tokens, refreshToken: tokens.refreshToken ?? input.refreshToken };
}

/** Révocation côté Google (avant toute suppression locale). */
export async function revokeToken(input: { token: string; fetchImpl?: typeof fetch }): Promise<boolean> {
  const doFetch = input.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(input.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Décode la partie « payload » d'un id_token JWT SANS vérifier la signature.
 *
 * Usage strictement interne : identifier le compte (email, sub) juste après un
 * échange de code serveur-à-serveur, où le canal est déjà authentifié. Aucune
 * décision d'autorisation ne repose sur cette valeur non vérifiée.
 */
export function decodeIdTokenClaims(idToken: string): { sub: string; email: string | null; name: string | null } | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    const claims = JSON.parse(atob(padded)) as { sub?: unknown; email?: unknown; name?: unknown };
    if (typeof claims.sub !== 'string' || claims.sub === '') return null;
    return {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : null,
      name: typeof claims.name === 'string' ? claims.name : null,
    };
  } catch {
    return null;
  }
}

/** Capacités effectivement accordées, déduites des scopes renvoyés par Google. */
export function capabilitiesFromScopes(provider: GoogleProvider, grantedScopes: readonly string[]): OAuthCapability[] {
  const spec = PROVIDERS[provider];
  const capabilities: OAuthCapability[] = [];
  for (const capability of ['read', 'draft', 'send', 'modify'] as OAuthCapability[]) {
    const scope = spec.scopes[capability];
    if (scope && grantedScopes.includes(scope)) capabilities.push(capability);
  }
  return capabilities;
}
