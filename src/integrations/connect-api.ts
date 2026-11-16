// VYORA Connect — accès aux données réelles du socle OAuth.
//
// Ce module ne contient AUCUNE règle d'autorisation : il se contente d'appeler
// l'Edge Function `vyora-oauth` et les RPC utilisateur déjà durcies en base.
// L'isolation est donc celle de la base, pas celle du navigateur.
//
// ## Ce qui n'est jamais fait ici
// - Aucun identifiant utilisateur n'est envoyé dans le corps : `auth.uid()` le
//   déduit du JWT, un utilisateur ne peut pas agir sur le compte d'un autre.
// - Aucun jeton OAuth n'est demandé ni manipulé. La liste des comptes ne
//   contient que des métadonnées.
// - Aucun secret OAuth n'est lu ni transmis. L'action `status` de l'Edge
//   Function ne renvoie que des booléens.

import { supabase } from '../lib/supabase';
import type { OAuthCapability, OAuthProviderKey } from './providers';

/** Configuration serveur telle que rapportée par l'Edge Function. Booléens only. */
export interface ProviderAvailability {
  readonly google: boolean;
  /** `false` si l'Edge Function est injoignable : rien n'est alors promis. */
  readonly oauth_function: boolean;
  /** Sans clé de chiffrement, connecter un compte stockerait des jetons illisibles. */
  readonly encryption: boolean;
}

export interface ConnectedAccount {
  readonly id: string;
  readonly provider: string;
  readonly external_account_id: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly capabilities: readonly string[];
  readonly status: 'pending' | 'connected' | 'expired' | 'revoked' | 'error';
  readonly last_verified_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
}

export interface AuditEvent {
  readonly id: number;
  readonly provider: string | null;
  readonly action: string;
  readonly capability: string | null;
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly detail: string | null;
  readonly created_at: string;
}

export interface StartAuthorizationResult {
  readonly authorization_url: string;
  readonly state: string;
  readonly capabilities: readonly OAuthCapability[];
  readonly expires_in: number;
}

/** Erreur lisible : jamais de détail technique brut exposé à l'utilisateur. */
export class ConnectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConnectError';
    this.code = code;
  }
}

const MESSAGES: Record<string, string> = {
  google_not_configured:
    'Les identifiants Google ne sont pas encore configurés. Un administrateur doit les ajouter.',
  oauth_not_configured:
    'Le service de connexion n’est pas encore configuré sur le serveur.',
  unauthorized: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  state_invalid:
    'Ce lien de connexion n’est plus valide (trop ancien ou déjà utilisé). Relancez la connexion.',
  no_capability_granted:
    'Aucune permission n’a été accordée. Aucun accès n’a été enregistré.',
  capability_not_granted:
    'Cette action demande une permission que ce compte ne possède pas.',
  account_revoked: 'Ce compte a été déconnecté. Reconnectez-le pour continuer.',
  account_expired:
    'L’autorisation a expiré. Reconnectez le compte pour rétablir l’accès.',
  account_not_found: 'Ce compte connecté n’existe plus.',
  forbidden: 'Vous n’avez pas accès à ce compte.',
  authorization_denied:
    'Vous avez refusé l’autorisation. Aucun accès n’a été accordé.',
  provider_invalid: 'Ce fournisseur n’est pas reconnu.',
  capability_not_supported:
    'Ce fournisseur ne propose pas cette permission.',
  token_exchange_failed:
    'Le fournisseur a refusé la connexion. Réessayez ou vérifiez votre compte.',
  refresh_failed:
    'L’autorisation n’a pas pu être renouvelée. Reconnectez le compte.',
  decrypt_failed:
    'Les jetons enregistrés sont illisibles. Reconnectez le compte.',
};

export function humanizeConnectError(code: string | undefined, fallback?: string): string {
  if (code && MESSAGES[code]) return MESSAGES[code];
  return fallback?.trim() || 'Une erreur est survenue. Réessayez dans un instant.';
}

interface EdgeError {
  error?: string;
  message?: string;
}

/**
 * Appelle l'Edge Function `vyora-oauth` en transmettant le JWT de session.
 *
 * On ne passe PAS par `supabase.functions.invoke` seul : on a besoin du corps
 * d'erreur JSON pour distinguer `state_invalid` de `google_not_configured` et
 * afficher un message utile plutôt qu'une erreur générique.
 */
async function callOAuth<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new ConnectError('unauthorized', humanizeConnectError('unauthorized'));

  const url = `${import.meta.env.VITE_SUPABASE_URL || 'https://xbuuhfwobrafcbgtdgjx.supabase.co'}/functions/v1/vyora-oauth`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ConnectError('network', 'Connexion au serveur impossible. Vérifiez votre réseau.');
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const error = (parsed ?? {}) as EdgeError;
    const code = error.error ?? `http_${response.status}`;
    throw new ConnectError(code, humanizeConnectError(code, error.message));
  }
  return parsed as T;
}

/**
 * Identifiants serveur présents ? Booléens uniquement.
 *
 * Source d'autorité : l'Edge Function `vyora-oauth`, action `status`. C'est le
 * seul endroit qui lit réellement l'environnement où Supabase injecte les
 * secrets. La RPC SQL `provider_status` existe mais renvoie `null` pour Google :
 * les secrets Edge Functions ne sont lisibles par aucune vue SQL dans ce projet.
 *
 * Repli volontairement pessimiste : si l'appel échoue, on répond « non
 * configuré ». Le pire résultat est un bouton désactivé — jamais un faux bouton
 * actif qui échouerait ensuite devant l'utilisateur.
 */
export async function fetchProviderAvailability(): Promise<ProviderAvailability> {
  try {
    const payload = await callOAuth<{
      google?: boolean;
      encryption_configured?: boolean;
      providers?: Record<string, boolean>;
    }>({ action: 'status' });
    return {
      google: payload.google === true,
      oauth_function: true,
      encryption: payload.encryption_configured === true,
    };
  } catch {
    return { google: false, oauth_function: false, encryption: false };
  }
}

/** Comptes connectés de l'utilisateur courant. Aucun jeton dans la réponse. */
export async function fetchConnectedAccounts(): Promise<ConnectedAccount[]> {
  const { data, error } = await supabase.rpc('oauth_list_accounts');
  if (error) throw new ConnectError(error.code ?? 'db_error', humanizeConnectError(error.code ?? undefined, error.message));
  const payload = (data ?? {}) as { items?: ConnectedAccount[] };
  const items = Array.isArray(payload.items) ? payload.items : [];
  // Ceinture et bretelles : même si la RPC changeait un jour, on retire tout
  // champ ressemblant à un cryptogramme avant que ça n'atteigne l'écran.
  return items.map((item) => {
    const record = { ...item } as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (/token|cipher|iv|tag|secret/i.test(key)) delete record[key];
    }
    return record as unknown as ConnectedAccount;
  });
}

/** Journal des événements et erreurs du compte. */
export async function fetchAuditEvents(limit = 50): Promise<AuditEvent[]> {
  const { data, error } = await supabase.rpc('oauth_audit_list', { p_limit: limit });
  if (error) throw new ConnectError(error.code ?? 'db_error', humanizeConnectError(error.code ?? undefined, error.message));
  const payload = (data ?? {}) as { items?: AuditEvent[] };
  return Array.isArray(payload.items) ? payload.items : [];
}

/** Démarre une autorisation : rend l'URL du fournisseur, jamais un jeton. */
export async function startAuthorization(
  provider: OAuthProviderKey,
  capabilities: readonly OAuthCapability[],
): Promise<StartAuthorizationResult> {
  // Une demande sans capacité n'a pas de sens et serait refusée côté serveur.
  const requested = capabilities.length > 0 ? capabilities : (['read'] as OAuthCapability[]);
  const raw = await callOAuth<Record<string, unknown>>({
    action: 'start',
    provider,
    capabilities: requested,
  });

  // Le serveur ne renvoie qu'une URL et un état ; il ne renvoie AUCUN jeton.
  // On reconstruit néanmoins l'objet champ par champ plutôt que de le
  // repasser tel quel : si une évolution serveur ajoutait un jour un jeton au
  // corps, il ne pourrait pas atteindre le navigateur par cette voie.
  const authorizationUrl = typeof raw.authorization_url === 'string' ? raw.authorization_url : '';
  if (!authorizationUrl) {
    throw new ConnectError('invalid_response', 'Le serveur n’a pas fourni d’URL d’autorisation.');
  }
  return {
    authorization_url: authorizationUrl,
    state: typeof raw.state === 'string' ? raw.state : '',
    capabilities: Array.isArray(raw.capabilities)
      ? (raw.capabilities as OAuthCapability[])
      : requested,
    expires_in: typeof raw.expires_in === 'number' ? raw.expires_in : 600,
  };
}

/** Révoque chez le fournisseur puis efface les jetons en base. */
export async function revokeAccount(accountId: string): Promise<{ revoked: boolean; remoteRevoked: boolean }> {
  return callOAuth<{ revoked: boolean; remoteRevoked: boolean }>({
    action: 'revoke',
    account_id: accountId,
  });
}

/** Force un rafraîchissement (diagnostic d'un compte expiré). */
export async function refreshAccount(accountId: string): Promise<{ refreshed: boolean }> {
  return callOAuth<{ refreshed: boolean }>({ action: 'refresh', account_id: accountId });
}

/**
 * Enregistre l'intention de connexion avant la redirection.
 *
 * Ce n'est PAS un état d'autorisation : c'est un simple aide-mémoire local qui
 * permet, au retour du fournisseur, de savoir quel fournisseur l'utilisateur
 * tentait de connecter et d'afficher un message pertinent. Rien de sensible.
 */
const PENDING_KEY = 'vyora.connect.pending.v1';

export interface PendingAuthorization {
  readonly provider: OAuthProviderKey;
  readonly capabilities: readonly OAuthCapability[];
  readonly startedAt: number;
}

export function rememberPendingAuthorization(intent: PendingAuthorization): void {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
  } catch {
    // Stockage indisponible : ce n'est qu'un confort, jamais une condition.
  }
}

export function readPendingAuthorization(): PendingAuthorization | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingAuthorization>;
    if (typeof parsed.provider !== 'string' || typeof parsed.startedAt !== 'number') return null;
    return {
      provider: parsed.provider as OAuthProviderKey,
      capabilities: Array.isArray(parsed.capabilities) ? (parsed.capabilities as OAuthCapability[]) : [],
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingAuthorization(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Sans conséquence.
  }
}
