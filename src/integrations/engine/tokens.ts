/**
 * VYORA — échange de jetons OAuth, côté serveur uniquement.
 *
 * ## Ce que ce module refuse de faire
 *
 * Il ne chiffre pas les jetons : c'est le rôle du socle (`oauth_account_upsert`,
 * `oauth_account_update_tokens`), qui détient la clé AES-GCM. Un module Edge
 * qui chiffrerait lui-même multiplierait les endroits où la clé circule.
 *
 * Il ne stocke rien : il rend un résultat et c'est l'appelant qui décide.
 *
 * ## Défense en profondeur
 *
 * - `client_secret` est exigé ici, jamais dans l'URL d'autorisation ;
 * - la réponse est validée avant usage : un `access_token` absent, un
 *   `token_type` inattendu ou une réponse non JSON sont des échecs explicites ;
 * - le délai d'expiration est calculé avec une marge, pour ne jamais utiliser
 *   un jeton qui expire pendant la requête suivante ;
 * - les erreurs du fournisseur sont traduites, jamais réémises telles quelles :
 *   la réponse d'un endpoint de jeton peut contenir un `error_description`
 *   exploitable, mais aussi des fragments sensibles.
 */
import { connectorError, type ConnectorError, type ConnectorResult } from './contract';

/** Marge de sécurité : on considère un jeton expiré 60 s avant l'heure réelle. */
export const EXPIRY_SKEW_SECONDS = 60;

/** Réponse de jeton normalisée, prête pour le chiffrement par le socle. */
export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** ISO 8601, ou `null` si le fournisseur ne communique pas de durée. */
  expiresAt: string | null;
  scopes: string[];
  tokenType: string;
}

export interface ExchangeInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  /** Vérifieur PKCE — jamais journalisé, jamais rendu à l'appelant. */
  codeVerifier: string;
  now: () => Date;
  /** Injecté pour les tests ; par défaut `fetch`. */
  fetchImpl?: typeof fetch;
  /** Délai maximal, pour ne pas bloquer une Edge Function indéfiniment. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Traduit un statut HTTP de fournisseur en code d'erreur interne. */
function codeFromStatus(status: number): ConnectorError['code'] {
  if (status === 400 || status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'invalid_response';
}

/**
 * Échange un code d'autorisation contre des jetons.
 *
 * Le corps est envoyé en `application/x-www-form-urlencoded`, conformément à
 * la RFC 6749 §4.1.3. `client_secret` reste dans le corps de la requête
 * serveur-à-serveur : il n'apparaît jamais dans une URL.
 */
export async function exchangeAuthorizationCode(input: ExchangeInput): Promise<ConnectorResult<TokenResponse>> {
  if (!input.tokenUrl.startsWith('https://')) {
    return { ok: false, error: connectorError('not_configured', 'tokenUrl doit être en HTTPS') };
  }
  if (!input.clientId || !input.clientSecret) {
    return { ok: false, error: connectorError('not_configured', 'identifiants client serveur absents') };
  }
  if (!input.code) {
    return { ok: false, error: connectorError('unauthorized', 'code d’autorisation absent') };
  }
  if (!input.codeVerifier) {
    return { ok: false, error: connectorError('unauthorized', 'vérifieur PKCE absent') };
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code_verifier: input.codeVerifier,
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(input.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        error: connectorError(codeFromStatus(response.status), 'échange de jetons refusé par le fournisseur', {
          status: response.status,
        }),
      };
    }

    let payload: Record<string, unknown>;
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      return { ok: false, error: connectorError('invalid_response', 'réponse de jeton non JSON') };
    }

    const accessToken = asString(payload.access_token);
    if (!accessToken) {
      return { ok: false, error: connectorError('invalid_response', 'access_token absent de la réponse') };
    }

    const tokenType = (asString(payload.token_type) ?? 'Bearer');
    // `token_type` doit être un type porteur ; un fournisseur qui renvoie autre
    // chose signale une réponse inattendue, pas un cas à tolérer.
    if (tokenType.toLowerCase() !== 'bearer') {
      return { ok: false, error: connectorError('invalid_response', 'token_type inattendu') };
    }

    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
    let expiresAt: string | null = null;
    if (expiresIn !== null && Number.isFinite(expiresIn) && expiresIn > 0) {
      const ms = Math.max(0, expiresIn - EXPIRY_SKEW_SECONDS) * 1000;
      expiresAt = new Date(input.now().getTime() + ms).toISOString();
    }

    const scopeField = asString(payload.scope);
    const scopes = scopeField ? scopeField.split(/[\s,]+/).filter(Boolean) : [];

    return {
      ok: true,
      value: {
        accessToken,
        refreshToken: asString(payload.refresh_token),
        expiresAt,
        scopes,
        tokenType,
      },
    };
  } catch (cause) {
    const abandonne = cause instanceof Error && cause.name === 'AbortError';
    return {
      ok: false,
      error: connectorError('network', abandonne ? 'délai dépassé à l’échange de jetons' : 'connexion au fournisseur impossible'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RefreshInput {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Renouvelle un jeton d'accès.
 *
 * Un fournisseur peut ne pas renvoyer de nouveau `refresh_token` : on renvoie
 * alors `null`, et l'appelant conserve l'ancien. Inventer un remplaçant
 * révoquerait l'autorisation à la prochaine rotation.
 */
export async function refreshAccessToken(input: RefreshInput): Promise<ConnectorResult<TokenResponse>> {
  if (!input.refreshToken) {
    return { ok: false, error: connectorError('unauthorized', 'aucun refresh token disponible', { retryable: false }) };
  }
  if (!input.tokenUrl.startsWith('https://') || !input.clientId || !input.clientSecret) {
    return { ok: false, error: connectorError('not_configured', 'configuration serveur incomplète') };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(input.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: connectorError(codeFromStatus(response.status), 'renouvellement refusé', { status: response.status }),
      };
    }
    const payload = await response.json() as Record<string, unknown>;
    const accessToken = asString(payload.access_token);
    if (!accessToken) {
      return { ok: false, error: connectorError('invalid_response', 'access_token absent') };
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : null;
    const expiresAt = expiresIn !== null && expiresIn > 0
      ? new Date(input.now().getTime() + Math.max(0, expiresIn - EXPIRY_SKEW_SECONDS) * 1000).toISOString()
      : null;
    const scopeField = asString(payload.scope);
    return {
      ok: true,
      value: {
        accessToken,
        refreshToken: asString(payload.refresh_token),
        expiresAt,
        scopes: scopeField ? scopeField.split(/[\s,]+/).filter(Boolean) : [],
        tokenType: asString(payload.token_type) ?? 'Bearer',
      },
    };
  } catch {
    return { ok: false, error: connectorError('network', 'renouvellement impossible (réseau)') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prépare la révocation d'un jeton chez le fournisseur.
 *
 * RFC 7009 : `POST` form-urlencoded avec `token` et éventuellement
 * `token_type_hint`. Certains fournisseurs répondent 200 même pour un jeton
 * déjà invalide — c'est un succès idempotent, pas une erreur.
 */
export async function revokeRemoteToken(input: {
  revokeUrl: string;
  token: string;
  clientId: string;
  clientSecret: string;
  tokenTypeHint?: 'access_token' | 'refresh_token';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ConnectorResult<void>> {
  if (!input.revokeUrl.startsWith('https://')) {
    return { ok: false, error: connectorError('not_configured', 'revokeUrl doit être en HTTPS') };
  }
  if (!input.token) {
    // Rien à révoquer : un jeton déjà absent est un succès, pas une erreur.
    return { ok: true, value: undefined };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ token: input.token, client_id: input.clientId, client_secret: input.clientSecret });
    if (input.tokenTypeHint) body.set('token_type_hint', input.tokenTypeHint);
    const response = await fetchImpl(input.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    // 200 et 400 sont acceptés : 400 signifie « jeton déjà invalide » chez
    // plusieurs fournisseurs, ce qui est le résultat recherché.
    if (response.ok || response.status === 400) return { ok: true, value: undefined };
    return {
      ok: false,
      error: connectorError(codeFromStatus(response.status), 'révocation refusée par le fournisseur', {
        status: response.status,
      }),
    };
  } catch {
    return { ok: false, error: connectorError('network', 'révocation impossible (réseau)') };
  } finally {
    clearTimeout(timer);
  }
}
