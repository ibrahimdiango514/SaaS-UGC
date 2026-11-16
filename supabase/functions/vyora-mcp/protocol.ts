// VYORA MCP — cœur du protocole JSON-RPC 2.0 / Model Context Protocol.
//
// Ce module est volontairement PUR : aucune lecture d'environnement, aucun
// accès réseau, aucun import Deno. Il reçoit ses dépendances (résolution de
// jeton, appel de RPC, journalisation) et peut donc être testé intégralement
// sous vitest, sans Edge Function ni base de données.
//
// Transport retenu : Streamable HTTP en mode « réponse JSON directe ».
//   POST /functions/v1/vyora-mcp   -> corps JSON-RPC, réponse JSON-RPC
//   GET  /functions/v1/vyora-mcp   -> 405 (pas de flux SSE persistant : une
//        Edge Function est sans état et a un temps d'exécution borné)
//
// Isolation : l'identité provient EXCLUSIVEMENT du jeton porteur résolu côté
// serveur. Aucun champ utilisateur n'est lu dans le corps JSON-RPC.

import {
  buildToolRegistry,
  toolsListPayload,
  validateToolArguments,
  ToolArgumentError,
  type BuiltToolRegistry,
  type McpToolDefinition,
} from './tools.ts';

/** Versions du protocole MCP que ce serveur sait servir. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface McpIdentity {
  readonly userId: string;
  readonly tokenId: string;
  readonly connectionId: string | null;
  readonly scopes: readonly string[];
  readonly tokenPrefix: string;
}

export interface McpDependencies {
  /** Résout un jeton porteur en identité, ou `null` si inconnu/révoqué/expiré. */
  resolveToken(secret: string): Promise<McpIdentity | null>;
  /** Appelle une RPC Postgres `service_role`, arguments nommés. */
  callRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Autorisation fine par jeton et par outil (table `mcp_tool_permissions`). */
  isToolPermitted(identity: McpIdentity, toolName: string, scope: 'read' | 'write'): Promise<boolean>;
  /** Journalise un appel. Ne doit jamais lever : le journal ne bloque pas la réponse. */
  logActivity(entry: McpActivityEntry): Promise<void>;
  /** Met à jour `last_used_at` / `use_count`. Ne doit jamais lever. */
  touchToken(tokenId: string): Promise<void>;
  /** `VYORA_MCP_WRITE_ENABLED` doit valoir exactement `true`. */
  readonly writeEnabled: boolean;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Horloge injectable pour rendre les tests déterministes. */
  now?(): number;
}

export interface McpActivityEntry {
  readonly userId: string;
  readonly tokenId: string;
  readonly connectionId: string | null;
  readonly tokenPrefix: string;
  readonly method: string;
  readonly toolName?: string;
  readonly outcome: 'ok' | 'denied' | 'error' | 'invalid';
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly resultSize?: number;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

// Codes JSON-RPC 2.0.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
// Codes d'application (plage réservée -32000..-32099).
export const UNAUTHORIZED = -32001;
export const FORBIDDEN = -32003;
export const TOOL_EXECUTION_ERROR = -32010;

export function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

export function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Extrait le jeton porteur d'un en-tête `Authorization`. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const secret = match[1].trim();
  if (!secret.startsWith('vyora_mcp_')) return null;
  if (secret.length < 24 || secret.length > 200) return null;
  return secret;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

function registry(deps: McpDependencies): BuiltToolRegistry {
  return buildToolRegistry({ writeEnabled: deps.writeEnabled === true });
}

/**
 * Exécute un message JSON-RPC unique et renvoie la réponse, ou `null` quand le
 * message est une notification (aucune réponse ne doit être produite).
 */
export async function handleJsonRpcMessage(
  deps: McpDependencies,
  identity: McpIdentity,
  message: unknown,
): Promise<JsonRpcResponse | null> {
  const clock = deps.now ?? (() => Date.now());
  const startedAt = clock();

  if (!isJsonRpcRequest(message)) {
    const id = typeof message === 'object' && message !== null && 'id' in message
      ? ((message as { id?: string | number | null }).id ?? null)
      : null;
    return jsonRpcError(
      typeof id === 'string' || typeof id === 'number' ? id : null,
      INVALID_REQUEST,
      'Requête JSON-RPC invalide : « jsonrpc » doit valoir « 2.0 » et « method » doit être une chaîne.',
    );
  }

  const request = message;
  const isNotification = request.id === undefined || request.id === null;
  const id = isNotification ? null : (request.id as string | number);
  const toolRegistry = registry(deps);

  const finish = async (
    response: JsonRpcResponse | null,
    entry: Omit<McpActivityEntry, 'userId' | 'tokenId' | 'connectionId' | 'tokenPrefix' | 'method' | 'durationMs'>,
  ): Promise<JsonRpcResponse | null> => {
    try {
      await deps.logActivity({
        userId: identity.userId,
        tokenId: identity.tokenId,
        connectionId: identity.connectionId,
        tokenPrefix: identity.tokenPrefix,
        method: request.method,
        ...entry,
        durationMs: Math.max(0, clock() - startedAt),
      });
    } catch {
      // Le journal ne doit jamais faire échouer un appel réussi.
    }
    return response;
  };

  switch (request.method) {
    case 'initialize': {
      const params = (request.params ?? {}) as { protocolVersion?: unknown };
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return finish(
        jsonRpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: deps.serverInfo.name, version: deps.serverInfo.version },
          instructions:
            'Serveur VYORA MCP. Les outils n\'accèdent qu\'aux ressources de l\'utilisateur propriétaire du jeton. Les outils d\'écriture sont désactivés par défaut.',
        }),
        { outcome: 'ok' },
      );
    }

    // Notifications : aucune réponse, même en cas de succès.
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      return finish(null, { outcome: 'ok' });

    case 'ping':
      return finish(jsonRpcResult(id, {}), { outcome: 'ok' });

    case 'tools/list':
      return finish(jsonRpcResult(id, toolsListPayload(toolRegistry)), { outcome: 'ok' });

    case 'resources/list':
      // Aucune ressource exposée en phase 1 : réponse vide, jamais une erreur.
      return finish(jsonRpcResult(id, { resources: [] }), { outcome: 'ok' });

    case 'prompts/list':
      return finish(jsonRpcResult(id, { prompts: [] }), { outcome: 'ok' });

    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!toolName) {
        return finish(
          jsonRpcError(id, INVALID_PARAMS, 'Le paramètre « name » est requis pour tools/call.'),
          { outcome: 'invalid', errorCode: 'missing_tool_name' },
        );
      }
      const tool: McpToolDefinition | undefined = toolRegistry.byName.get(toolName);
      if (!tool) {
        return finish(
          jsonRpcError(id, INVALID_PARAMS, `Outil inconnu ou non activé sur ce serveur : ${toolName}`, {
            available: toolRegistry.tools.map((entry) => entry.name),
          }),
          { outcome: 'invalid', toolName, errorCode: 'unknown_tool' },
        );
      }

      // Barrière 1a : portée du jeton.
      if (!identity.scopes.includes(tool.scope)) {
        return finish(
          jsonRpcError(id, FORBIDDEN, `Le jeton ne possède pas la portée « ${tool.scope} » requise par ${toolName}.`),
          { outcome: 'denied', toolName, errorCode: 'scope_missing' },
        );
      }

      // Barrière 1b : autorisation explicite par outil.
      let permitted = false;
      try {
        permitted = await deps.isToolPermitted(identity, tool.name, tool.scope);
      } catch {
        permitted = false;
      }
      if (!permitted) {
        return finish(
          jsonRpcError(id, FORBIDDEN, `Outil non autorisé pour ce jeton : ${toolName}`),
          { outcome: 'denied', toolName, errorCode: 'tool_not_permitted' },
        );
      }

      let args: Record<string, unknown>;
      try {
        const validated = validateToolArguments(tool, params.arguments);
        // Barrière 2 : `p_user_id` vient du jeton, jamais du client.
        args = tool.args(validated, identity.userId);
      } catch (error) {
        const code = error instanceof ToolArgumentError ? error.code : 'invalid_arguments';
        const message = error instanceof Error ? error.message : 'Arguments invalides.';
        return finish(jsonRpcError(id, INVALID_PARAMS, message, { reason: code }), {
          outcome: 'invalid',
          toolName,
          errorCode: code,
        });
      }

      try {
        const data = await deps.callRpc(tool.rpc, args);
        const text = JSON.stringify(data ?? null);
        return finish(
          jsonRpcResult(id, {
            content: [{ type: 'text', text }],
            structuredContent: data ?? null,
            isError: false,
          }),
          { outcome: 'ok', toolName, resultSize: text.length },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Échec de l\'exécution de l\'outil.';
        return finish(
          jsonRpcResult(id, {
            content: [{ type: 'text', text: `Erreur d'exécution : ${message}` }],
            isError: true,
          }),
          { outcome: 'error', toolName, errorCode: 'rpc_failed' },
        );
      }
    }

    default:
      if (isNotification) return finish(null, { outcome: 'ok' });
      return finish(
        jsonRpcError(id, METHOD_NOT_FOUND, `Méthode non supportée : ${request.method}`),
        { outcome: 'invalid', errorCode: 'method_not_found' },
      );
  }
}

/**
 * Traite un corps JSON-RPC complet : message unique ou lot (batch).
 * Un lot vide est une requête invalide (spécification JSON-RPC 2.0).
 */
export async function handleJsonRpcBody(
  deps: McpDependencies,
  identity: McpIdentity,
  body: unknown,
): Promise<{ status: number; payload: JsonRpcResponse | JsonRpcResponse[] | null }> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { status: 400, payload: jsonRpcError(null, INVALID_REQUEST, 'Lot JSON-RPC vide.') };
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of body) {
      const response = await handleJsonRpcMessage(deps, identity, message);
      if (response) responses.push(response);
    }
    return { status: 200, payload: responses.length > 0 ? responses : null };
  }
  const response = await handleJsonRpcMessage(deps, identity, body);
  if (response === null) return { status: 202, payload: null };
  return { status: 200, payload: response };
}

export interface McpHttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * Couche HTTP complète, indépendante de Deno : à partir de l'en-tête
 * d'autorisation et du corps déjà analysé, produit le statut et la charge utile.
 * `index.ts` se contente de sérialiser le résultat.
 */
export async function handleMcpHttp(
  deps: McpDependencies,
  context: { method: string; authorization: string | null; body?: unknown; parseError?: boolean },
): Promise<McpHttpResult> {
  if (context.method === 'GET') {
    return {
      status: 405,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: METHOD_NOT_FOUND,
          message:
            'Ce serveur MCP expose le transport Streamable HTTP en réponse JSON directe : utilisez POST. Aucun flux SSE persistant n\'est proposé.',
        },
      },
      headers: { Allow: 'POST, OPTIONS' },
    };
  }
  if (context.method !== 'POST') {
    return {
      status: 405,
      body: jsonRpcError(null, METHOD_NOT_FOUND, `Méthode HTTP non supportée : ${context.method}`),
      headers: { Allow: 'POST, OPTIONS' },
    };
  }

  const secret = bearerToken(context.authorization);
  if (!secret) {
    return {
      status: 401,
      body: jsonRpcError(
        null,
        UNAUTHORIZED,
        'Jeton MCP absent ou mal formé. En-tête attendu : « Authorization: Bearer vyora_mcp_… ».',
      ),
      headers: { 'WWW-Authenticate': 'Bearer realm="vyora-mcp"' },
    };
  }

  let identity: McpIdentity | null = null;
  try {
    identity = await deps.resolveToken(secret);
  } catch {
    identity = null;
  }
  if (!identity) {
    // Message volontairement identique pour jeton inconnu, révoqué ou expiré :
    // ne pas donner d'indice exploitable à un porteur de jeton volé.
    return {
      status: 401,
      body: jsonRpcError(null, UNAUTHORIZED, 'Jeton MCP invalide.'),
      headers: { 'WWW-Authenticate': 'Bearer realm="vyora-mcp", error="invalid_token"' },
    };
  }

  if (context.parseError) {
    return { status: 400, body: jsonRpcError(null, PARSE_ERROR, 'Corps JSON illisible.') };
  }

  try {
    await deps.touchToken(identity.tokenId);
  } catch {
    // Sans effet sur la réponse : une trace manquante ne doit pas bloquer.
  }

  const { status, payload } = await handleJsonRpcBody(deps, identity, context.body);
  if (payload === null) return { status: 202, body: null };
  return { status, body: payload };
}
