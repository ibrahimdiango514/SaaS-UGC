// VYORA MCP — adaptateur Supabase pour la couche protocole.
//
// Toutes les opérations passent par l'API PostgREST avec la clé `service_role`
// (variable d'environnement auto-injectée par Supabase, jamais exposée au
// navigateur). Aucune connexion Postgres directe : la fonction n'a donc besoin
// d'aucun secret supplémentaire pour fonctionner.
//
// Rappel des barrières : les RPC MCP n'accordent `execute` qu'à `service_role`
// et reçoivent `p_user_id` explicitement, issu du jeton résolu. PostgREST ne
// peut donc pas les invoquer au nom d'un utilisateur arbitraire.

import type { McpActivityEntry, McpDependencies, McpIdentity } from './protocol.ts';

export interface RestStoreOptions {
  /** `SUPABASE_URL` */
  readonly baseUrl: string;
  /** `SUPABASE_SERVICE_ROLE_KEY` */
  readonly serviceKey: string;
  /** `VYORA_MCP_WRITE_ENABLED` doit valoir exactement `true`. */
  readonly writeEnabled: boolean;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Injecté pour les tests. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface TokenRow {
  token_id: string;
  user_id: string;
  connection_id: string | null;
  scopes: string[] | null;
  token_prefix: string;
}

const RPC_TIMEOUT_MS = 12_000;

/**
 * Noms de RPC autorisés. Liste blanche : le nom vient d'un registre interne,
 * mais la vérifier ici garantit qu'aucune entrée utilisateur ne pourra jamais
 * se transformer en appel arbitraire.
 */
const ALLOWED_RPCS = new Set([
  'mcp_resolve_token',
  'mcp_account_info',
  'mcp_projects_list',
  'mcp_generations_list',
  'mcp_history_list',
  'mcp_integrations_list',
  'mcp_project_create',
]);

export function createDependencies(options: RestStoreOptions): McpDependencies {
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
      // Le corps d'erreur PostgREST peut contenir des détails de schéma : on ne
      // propage que le code HTTP, jamais le message brut.
      throw new Error(`rpc_failed:${name}:${response.status}`);
    }
    const text = await response.text();
    if (!text) return null as T;
    return JSON.parse(text) as T;
  }

  return {
    writeEnabled: options.writeEnabled === true,
    serverInfo: options.serverInfo,
    now: options.now,

    async resolveToken(secret: string): Promise<McpIdentity | null> {
      // PostgREST renvoie un ensemble de lignes pour une fonction `returns table`.
      // Zéro ligne = jeton inconnu, révoqué, expiré, ou connexion révoquée : la
      // fonction SQL ne distingue pas ces cas, et on ne les distingue pas non plus.
      const rows = await rpc<TokenRow[] | null>('mcp_resolve_token', { p_secret: secret });
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const row = rows[0];
      if (!row?.user_id || !row?.token_id) return null;
      return {
        userId: row.user_id,
        tokenId: row.token_id,
        connectionId: row.connection_id ?? null,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
        tokenPrefix: row.token_prefix ?? '',
      };
    },

    async isToolPermitted(identity: McpIdentity, toolName: string): Promise<boolean> {
      // Autorisation par défaut ; seule une ligne explicite `allowed = false`
      // retire l'outil à ce jeton.
      const response = await doFetch(
        `${base}/rest/v1/mcp_tool_permissions?select=allowed&token_id=eq.${encodeURIComponent(identity.tokenId)}&tool_name=eq.${encodeURIComponent(toolName)}&limit=1`,
        {
          headers: {
            apikey: options.serviceKey,
            Authorization: `Bearer ${options.serviceKey}`,
          },
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        },
      );
      if (!response.ok) return false;
      const rows = (await response.json()) as Array<{ allowed?: boolean }>;
      if (rows.length === 0) return true;
      return rows[0].allowed === true;
    },

    async callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
      return rpc<unknown>(name, args);
    },

    async logActivity(entry: McpActivityEntry): Promise<void> {
      try {
        await doFetch(`${base}/rest/v1/rpc/mcp_log_activity`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: options.serviceKey,
            Authorization: `Bearer ${options.serviceKey}`,
          },
          body: JSON.stringify({
            p_payload: {
              user_id: entry.userId,
              token_id: entry.tokenId,
              connection_id: entry.connectionId,
              token_prefix: entry.tokenPrefix,
              method: entry.method,
              tool_name: entry.toolName ?? null,
              outcome: entry.outcome,
              error_code: entry.errorCode ?? null,
              duration_ms: entry.durationMs ?? null,
              result_size: entry.resultSize ?? null,
            },
          }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch {
        // Journalisation best-effort : jamais bloquante.
      }
    },

    async touchToken(tokenId: string): Promise<void> {
      try {
        await doFetch(`${base}/rest/v1/rpc/mcp_touch_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: options.serviceKey,
            Authorization: `Bearer ${options.serviceKey}`,
          },
          body: JSON.stringify({ p_token_id: tokenId }),
          signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        });
      } catch {
        // Best-effort : une trace manquante ne bloque pas un appel valide.
      }
    },
  };
}
