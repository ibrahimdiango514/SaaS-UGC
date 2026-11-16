// VYORA OAuth — accès base via PostgREST (`service_role`).
//
// Aucune connexion Postgres directe, aucun secret supplémentaire : seule la
// clé `service_role` auto-injectée est utilisée. Les RPC serveur ne sont
// exécutables que par `service_role` (vérifié en base par `has_function_privilege`),
// et les RPC utilisateur s'appuient sur `auth.uid()` — jamais sur un identifiant
// fourni par le client.
//
// Aucun jeton OAuth en clair ne transite par ce module : il ne manipule que des
// cryptogrammes, déchiffrés plus tard par l'appelant avec la clé d'environnement.

export interface StoredToken {
  readonly cipher: string | null;
  readonly iv: string | null;
  readonly tag: string | null;
}

export interface OAuthAccountRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly external_account_id: string;
  readonly status: string;
  readonly capabilities: string[];
  readonly access_token_cipher: string | null;
  readonly access_token_iv: string | null;
  readonly access_token_tag: string | null;
  readonly refresh_token_cipher: string | null;
  readonly refresh_token_iv: string | null;
  readonly refresh_token_tag: string | null;
  readonly access_expires_at: string | null;
}

export interface StateRow {
  readonly user_id: string;
  readonly provider: string;
  readonly verifier_cipher: string;
  readonly verifier_iv: string;
  readonly verifier_tag: string;
  readonly requested_capabilities: string[];
}

export interface AuditEntry {
  readonly userId?: string | null;
  readonly accountId?: string | null;
  readonly provider?: string | null;
  readonly action: string;
  readonly capability?: string | null;
  readonly outcome?: 'ok' | 'denied' | 'error';
  readonly detail?: string | null;
}

export interface OAuthStore {
  createState(input: {
    state: string;
    userId: string;
    provider: string;
    verifierCipher: string;
    verifierIv: string;
    verifierTag: string;
    capabilities: string[];
  }): Promise<void>;
  consumeState(state: string): Promise<StateRow | null>;
  upsertAccount(payload: Record<string, unknown>): Promise<string | null>;
  getAccountSecret(accountId: string): Promise<OAuthAccountRow | null>;
  setAccountStatus(accountId: string, status: string, error?: string | null): Promise<void>;
  /** Réécrit les cryptogrammes après un rafraîchissement. `false` = compte absent. */
  updateTokens(input: {
    accountId: string;
    access: { cipher: string; iv: string; tag: string };
    /** `null` = Google n'a pas fait tourner le refresh token. */
    refresh: { cipher: string; iv: string; tag: string } | null;
    expiresAt: string;
  }): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
}

const RPC_TIMEOUT_MS = 12_000;

/** Liste blanche : le nom de RPC ne peut pas provenir d'une entrée utilisateur. */
const ALLOWED_RPCS = new Set([
  'oauth_state_create',
  'oauth_state_consume',
  'oauth_account_upsert',
  'oauth_account_secret',
  'oauth_account_set_status',
  'oauth_account_update_tokens',
  'oauth_audit_write',
]);

export interface StoreOptions {
  readonly baseUrl: string;
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
}

export function createStore(options: StoreOptions): OAuthStore {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!ALLOWED_RPCS.has(name)) throw new Error(`rpc_not_allowed:${name}`);
    const response = await doFetch(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: options.serviceKey,
        Authorization: `Bearer ${options.serviceKey}`,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) {
      // Le corps PostgREST peut révéler le schéma : on ne propage que le statut.
      throw new Error(`rpc_failed:${name}:${response.status}`);
    }
    if (response.status === 204) return null as T;
    const text = await response.text();
    if (text.trim() === '') return null as T;
    return JSON.parse(text) as T;
  }

  return {
    async createState(input) {
      await rpc('oauth_state_create', {
        p_state: input.state,
        p_user_id: input.userId,
        p_provider: input.provider,
        p_verifier_cipher: input.verifierCipher,
        p_verifier_iv: input.verifierIv,
        p_verifier_tag: input.verifierTag,
        p_capabilities: input.capabilities,
      });
    },

    async consumeState(state) {
      // `oauth_state_consume` est une fonction `returns table` : PostgREST
      // renvoie un tableau (vide si l'état est inconnu, consommé ou expiré).
      const rows = await rpc<StateRow[] | StateRow | null>('oauth_state_consume', { p_state: state });
      const row = Array.isArray(rows) ? rows[0] : rows;
      return row ?? null;
    },

    async upsertAccount(payload) {
      const id = await rpc<string | null>('oauth_account_upsert', { p_payload: payload });
      return id ?? null;
    },

    async getAccountSecret(accountId) {
      return rpc<OAuthAccountRow | null>('oauth_account_secret', { p_account_id: accountId });
    },

    async setAccountStatus(accountId, status, error = null) {
      await rpc('oauth_account_set_status', {
        p_account_id: accountId,
        p_status: status,
        p_error: error,
      });
    },

    async updateTokens(input) {
      // Chaque cryptogramme porte son PROPRE IV et sa propre étiquette GCM :
      // réutiliser un IV entre deux chiffrements casserait la confidentialité.
      const updated = await rpc<boolean | null>('oauth_account_update_tokens', {
        p_account_id: input.accountId,
        p_access_cipher: input.access.cipher,
        p_access_iv: input.access.iv,
        p_access_tag: input.access.tag,
        p_refresh_cipher: input.refresh?.cipher ?? null,
        p_refresh_iv: input.refresh?.iv ?? null,
        p_refresh_tag: input.refresh?.tag ?? null,
        p_expires_at: input.expiresAt,
      });
      return updated === true;
    },

    async audit(entry) {
      // Le journal ne doit jamais faire échouer une opération métier : la RPC
      // renvoie déjà null en cas d'erreur interne, et on protège l'appel.
      try {
        await rpc('oauth_audit_write', {
          p_payload: {
            user_id: entry.userId ?? null,
            account_id: entry.accountId ?? null,
            provider: entry.provider ?? null,
            action: entry.action,
            capability: entry.capability ?? null,
            outcome: entry.outcome ?? 'ok',
            detail: entry.detail ?? null,
          },
        });
      } catch {
        // Silence volontaire : un journal indisponible ne casse pas l'action.
      }
    },
  };
}
