// VYORA OAuth — gestion des comptes connectés et des capacités.
//
// Ce module est indépendant de HTTP : il reçoit un store, une clé de
// chiffrement et des identifiants Google, et rend des résultats explicites.
// Il est donc testable sans réseau et sans secret réel.

import {
  CapabilityDeniedError,
  assertCapability,
  capabilitiesFromScopes,
  decryptSecret,
  encryptSecret,
  isCapabilitySupported,
  refreshAccessToken,
  revokeToken,
  type EncryptedValue,
  type GoogleProvider,
  type OAuthCapability,
} from '../_shared/oauth/index.ts';
import type { OAuthAccountRow, OAuthStore } from './store.ts';

export const ALL_CAPABILITIES: readonly OAuthCapability[] = ['read', 'draft', 'send', 'modify'];

export class OAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400, message?: string) {
    super(message ?? code);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/** Ne garde que les capacités connues, en dédoublonnant. Refuse les inconnues. */
export function normalizeCapabilities(input: unknown): OAuthCapability[] {
  if (input === undefined || input === null) return ['read'];
  if (!Array.isArray(input)) throw new OAuthError('capabilities_invalid');
  const seen = new Set<OAuthCapability>();
  for (const raw of input) {
    if (typeof raw !== 'string') throw new OAuthError('capabilities_invalid');
    if (!ALL_CAPABILITIES.includes(raw as OAuthCapability)) throw new OAuthError(`capability_unknown:${raw}`);
    seen.add(raw as OAuthCapability);
  }
  // Une demande sans capacité n'a pas de sens : au minimum la lecture.
  if (seen.size === 0) return ['read'];
  return ALL_CAPABILITIES.filter((capability) => seen.has(capability));
}

/** Refuse d'avance une capacité que le fournisseur ne sait pas fournir. */
export function assertCapabilitiesSupported(provider: GoogleProvider, capabilities: readonly OAuthCapability[]): void {
  for (const capability of capabilities) {
    if (!isCapabilitySupported(provider, capability)) {
      throw new OAuthError(`capability_not_supported:${provider}:${capability}`);
    }
  }
}

/** Chaque jeton a son propre IV et sa propre étiquette : jamais de partage. */
function secretOf(row: OAuthAccountRow, which: 'access' | 'refresh'): EncryptedValue | null {
  const cipher = which === 'access' ? row.access_token_cipher : row.refresh_token_cipher;
  const iv = which === 'access' ? row.access_token_iv : row.refresh_token_iv;
  const tag = which === 'access' ? row.access_token_tag : row.refresh_token_tag;
  if (!cipher || !iv || !tag) return null;
  return { cipher, iv, tag };
}

/**
 * Charge un compte et vérifie qu'il est utilisable pour la capacité demandée.
 *
 * Refus explicites, jamais de repli silencieux :
 *   - compte inconnu            → account_not_found (404)
 *   - compte révoqué/expiré     → account_not_usable
 *   - capacité absente          → capability_not_granted (403)
 */
export async function loadUsableAccount(input: {
  store: OAuthStore;
  accountId: string;
  capability: OAuthCapability;
  encryptionKey: string;
}): Promise<{ row: OAuthAccountRow; accessToken: string; provider: GoogleProvider }> {
  const row = await input.store.getAccountSecret(input.accountId);
  if (!row) throw new OAuthError('account_not_found', 404);
  if (row.status === 'revoked') throw new OAuthError('account_revoked', 409);
  if (row.status === 'expired') throw new OAuthError('account_expired', 409);
  if (row.status !== 'connected' && row.status !== 'error') {
    throw new OAuthError(`account_not_usable:${row.status}`, 409);
  }
  const provider = row.provider as GoogleProvider;
  const granted = row.capabilities ?? [];
  if (!granted.includes(input.capability)) {
    await input.store.audit({
      userId: row.user_id,
      accountId: row.id,
      provider: row.provider,
      action: 'denied',
      capability: input.capability,
      outcome: 'denied',
      detail: 'capacite_non_accordee',
    });
    throw new OAuthError('capability_not_granted', 403);
  }
  // Double vérification : la liste de capacités vient de la base, mais on
  // revérifie que le fournisseur sait réellement faire cette action.
  assertCapability(granted, input.capability, provider);

  const sealed = secretOf(row, 'access');
  if (!sealed) throw new OAuthError('access_token_missing', 409);
  let accessToken: string;
  try {
    accessToken = await decryptSecret(sealed, input.encryptionKey);
  } catch {
    await input.store.audit({
      userId: row.user_id,
      accountId: row.id,
      provider: row.provider,
      action: 'denied',
      capability: input.capability,
      outcome: 'error',
      detail: 'dechiffrement_impossible',
    });
    throw new OAuthError('decrypt_failed', 500);
  }
  return { row, accessToken, provider };
}

/** Vrai si le jeton d'accès est expiré (ou expire dans moins de 60 s). */
export function isAccessTokenExpired(row: OAuthAccountRow, now: number = Date.now()): boolean {
  if (!row.access_expires_at) return true;
  const expiresAt = Date.parse(row.access_expires_at);
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt - now < 60_000;
}

export interface RefreshDeps {
  store: OAuthStore;
  encryptionKey: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Rafraîchit un jeton expiré et persiste le nouveau cryptogramme.
 * Le refresh token d'origine est conservé si Google n'en renvoie pas.
 */
export async function refreshAccount(row: OAuthAccountRow, deps: RefreshDeps): Promise<string> {
  const sealed = secretOf(row, 'refresh');
  if (!sealed) {
    await deps.store.setAccountStatus(row.id, 'expired', 'refresh_token_absent');
    throw new OAuthError('refresh_token_missing', 409);
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(sealed, deps.encryptionKey);
  } catch {
    await deps.store.setAccountStatus(row.id, 'error', 'refresh_token_indechiffrable');
    throw new OAuthError('decrypt_failed', 500);
  }
  try {
    const tokens = await refreshAccessToken({
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      refreshToken,
      fetchImpl: deps.fetchImpl,
    });
    const access = await encryptSecret(tokens.accessToken, deps.encryptionKey);
    // Google ne renvoie pas toujours un refresh token : on ne réécrit la
    // colonne que s'il en fournit réellement un nouveau (rotation).
    const rotated = tokens.refreshToken && tokens.refreshToken !== refreshToken
      ? await encryptSecret(tokens.refreshToken, deps.encryptionKey)
      : null;
    const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
    const updated = await deps.store.updateTokens({
      accountId: row.id,
      access,
      refresh: rotated,
      expiresAt,
    });
    if (!updated) throw new OAuthError('account_not_found', 404);
    await deps.store.audit({
      userId: row.user_id,
      accountId: row.id,
      provider: row.provider,
      action: 'token_refresh',
      outcome: 'ok',
    });
    return tokens.accessToken;
  } catch (error) {
    await deps.store.audit({
      userId: row.user_id,
      accountId: row.id,
      provider: row.provider,
      action: 'token_refresh_failure',
      outcome: 'error',
      detail: error instanceof Error ? error.message.slice(0, 120) : 'inconnu',
    });
    await deps.store.setAccountStatus(row.id, 'expired', 'refresh_refuse');
    throw new OAuthError('refresh_failed', 502);
  }
}

/**
 * Révocation complète : Google d'abord, puis effacement local des jetons.
 *
 * Si Google refuse (jeton déjà invalide, réseau), on efface quand même
 * localement : un jeton que l'on ne peut plus révoquer ne doit pas rester
 * utilisable chez nous. C'est consigné dans le journal.
 */
export async function revokeAccount(input: {
  store: OAuthStore;
  encryptionKey: string;
  accountId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ revoked: boolean; remoteRevoked: boolean }> {
  const row = await input.store.getAccountSecret(input.accountId);
  if (!row) throw new OAuthError('account_not_found', 404);

  let remoteRevoked = false;
  const sealed = secretOf(row, 'refresh') ?? secretOf(row, 'access');
  if (sealed) {
    try {
      const token = await decryptSecret(sealed, input.encryptionKey);
      remoteRevoked = await revokeToken({ token, fetchImpl: input.fetchImpl });
    } catch {
      // Déchiffrement impossible : le jeton local est de toute façon effacé.
      remoteRevoked = false;
    }
  }

  await input.store.setAccountStatus(row.id, 'revoked', remoteRevoked ? null : 'revocation_distante_non_confirmee');
  await input.store.audit({
    userId: row.user_id,
    accountId: row.id,
    provider: row.provider,
    action: 'revoke',
    outcome: 'ok',
    detail: remoteRevoked ? 'google_revoque' : 'google_non_confirme',
  });

  return { revoked: true, remoteRevoked };
}

export { CapabilityDeniedError, capabilitiesFromScopes };
