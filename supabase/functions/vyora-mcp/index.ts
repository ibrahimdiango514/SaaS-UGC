// VYORA MCP — Edge Function « vyora-mcp ».
//
// Serveur Model Context Protocol distant, multi-utilisateur, en transport
// Streamable HTTP (réponse JSON directe). L'authentification ne repose PAS sur
// un JWT Supabase mais sur un jeton personnel VYORA MCP (`vyora_mcp_…`), haché
// en SHA-256 côté base : la fonction est donc déployée `verify_jwt: false` et
// applique elle-même le contrôle d'identité (voir `protocol.ts`).
//
// Double barrière d'isolation :
//   1. l'identité provient uniquement du jeton résolu (`mcp_resolve_token`) ;
//      aucun identifiant utilisateur n'est accepté depuis le corps JSON-RPC ;
//   2. chaque RPC est `security definer` et reçoit `p_user_id` explicitement,
//      avec un `search_path` figé.
//
// Ce que cette fonction n'écrit jamais : un jeton en clair (seul le SHA-256 est
// stocké), une clé de fournisseur, un jeton OAuth. Les journaux ne contiennent
// que le préfixe public du jeton et le nom de l'outil.

import postgres from 'npm:postgres@3.4.5';
import {
  handleMcpHttp,
  UNAUTHORIZED,
  type McpDependencies,
  type McpIdentity,
} from './protocol.ts';
import { READ_TOOLS, WRITE_TOOLS } from './tools.ts';

type Sql = ReturnType<typeof postgres>;

function env(name: string): string {
  const globalScope = globalThis as unknown as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return globalScope.Deno?.env?.get?.(name) ?? globalScope.process?.env?.[name] ?? '';
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version',
};

const SERVER_INFO = { name: 'vyora-mcp', version: '1.0.0' } as const;

/** Écriture activée seulement sur valeur explicite `true`. */
function writeEnabled(): boolean {
  return env('VYORA_MCP_WRITE_ENABLED').trim().toLowerCase() === 'true';
}

let cachedSql: Sql | null = null;
function databaseUrl(): string {
  return env('VYORA_MCP_DATABASE_URL') || env('SUPABASE_DB_URL');
}

function sqlOrNull(): Sql | null {
  if (cachedSql) return cachedSql;
  const url = databaseUrl();
  if (!url) return null;
  cachedSql = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  });
  return cachedSql;
}

interface TokenRow {
  token_id: string;
  user_id: string;
  connection_id: string | null;
  scopes: string[];
  token_prefix: string;
}

/** Ensemble des outils connus, toutes portées confondues. */
const KNOWN_TOOL_NAMES = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS].map((tool) => tool.name));

export function createDependencies(sql: Sql | null): McpDependencies {
  return {
    writeEnabled: writeEnabled(),
    serverInfo: SERVER_INFO,

    async resolveToken(secret: string): Promise<McpIdentity | null> {
      if (!sql) throw new Error('database_unavailable');
      const rows = await sql<TokenRow[]>`
        select token_id, user_id, connection_id, scopes, token_prefix
          from public.mcp_resolve_token(${secret})
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        userId: row.user_id,
        tokenId: row.token_id,
        connectionId: row.connection_id,
        scopes: Array.isArray(row.scopes) ? row.scopes : [],
        tokenPrefix: row.token_prefix,
      };
    },

    async isToolPermitted(identity: McpIdentity, toolName: string): Promise<boolean> {
      // Tout outil actif est autorisé par défaut ; une ligne explicite
      // `allowed = false` le retire. Une révocation est donc un simple UPDATE.
      if (!KNOWN_TOOL_NAMES.has(toolName)) return false;
      if (!sql) throw new Error('database_unavailable');
      const rows = await sql<{ allowed: boolean }[]>`
        select allowed
          from public.mcp_tool_permissions
         where token_id = ${identity.tokenId}
           and tool_name = ${toolName}
         limit 1
      `;
      if (rows.length === 0) return true;
      return rows[0].allowed === true;
    },

    async callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
      if (!sql) throw new Error('database_unavailable');
      // Le nom de la RPC provient du registre interne (liste blanche), jamais
      // du corps de la requête.
      const result = await sql.unsafe(`select public.${name}(${Object.keys(args).map((key, index) => `$${index + 1}`).join(', ')}) as data`, Object.values(args));
      const first = (result as unknown as Array<{ data: unknown }>)[0];
      return first ? first.data : null;
    },

    async logActivity(entry): Promise<void> {
      if (!sql) return;
      try {
        await sql`
          select public.mcp_log_activity(${sql.json({
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
          })}::jsonb)
        `;
      } catch {
        // Journalisation best-effort : jamais bloquante.
      }
    },

    async touchToken(tokenId: string): Promise<void> {
      if (!sql) return;
      try {
        await sql`select public.mcp_touch_token(${tokenId}::uuid)`;
      } catch {
        // Idem : best-effort.
      }
    },
  };
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra });
  if (body === null || body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const sql = sqlOrNull();
  if (!sql) {
    // Configuration absente : on refuse explicitement plutôt que de servir
    // un serveur muet. Aucun secret n'est révélé dans le message.
    return jsonResponse(503, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Serveur MCP indisponible : base de données non configurée.' },
    });
  }

  let body: unknown;
  let parseError = false;
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.trim() === '') {
      parseError = true;
    } else {
      try {
        body = JSON.parse(text);
      } catch {
        parseError = true;
      }
    }
  }

  const result = await handleMcpHttp(createDependencies(sql), {
    method: request.method,
    authorization: request.headers.get('authorization'),
    body,
    parseError,
  });

  const extra: Record<string, string> = { ...(result.headers ?? {}) };
  // Le client annonce sa version : on répond dans le même dialecte quand elle
  // est supportée, ce que les clients MCP utilisent pour détecter un serveur
  // moderne derrière un proxy.
  const requestedVersion = request.headers.get('mcp-protocol-version');
  if (requestedVersion) extra['mcp-protocol-version'] = requestedVersion;

  return jsonResponse(result.status, result.body, extra);
});

// Marqueur exporté pour les tests d'isolation et la parité d'artefact.
export const __serverInfo = SERVER_INFO;
export const __unauthorizedCode = UNAUTHORIZED;
