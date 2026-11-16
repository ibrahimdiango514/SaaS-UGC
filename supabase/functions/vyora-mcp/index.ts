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
//   2. chaque RPC est `security definer`, reçoit `p_user_id` explicitement et
//      n'accorde `execute` qu'à `service_role`.
//
// Ce que cette fonction n'écrit jamais : un jeton en clair (seul le SHA-256 est
// stocké), une clé de fournisseur, un jeton OAuth. Les journaux ne contiennent
// que le préfixe public du jeton et le nom de l'outil.
//
// Aucun secret supplémentaire n'est requis : la clé `service_role` et l'URL du
// projet sont injectées par Supabase dans l'environnement de la fonction.
// `VYORA_MCP_WRITE_ENABLED=true` est le seul commutateur d'activation des
// outils d'écriture.

import { handleMcpHttp } from './protocol.ts';
import { createDependencies } from './supabase-store.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'mcp-protocol-version',
};

const SERVER_INFO = { name: 'vyora-mcp', version: '1.0.0' } as const;

function env(name: string): string {
  const globalScope = globalThis as unknown as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return globalScope.Deno?.env?.get?.(name) ?? globalScope.process?.env?.[name] ?? '';
}

/** Écriture activée seulement sur valeur explicite `true`. */
export function writeEnabled(): boolean {
  return env('VYORA_MCP_WRITE_ENABLED').trim().toLowerCase() === 'true';
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra });
  if (body === null || body === undefined) return new Response(null, { status, headers });
  return new Response(JSON.stringify(body), { status, headers });
}

function unavailable(message: string): Response {
  // Refus explicite plutôt qu'un serveur muet. Aucun nom de variable n'est
  // révélé : le message reste générique.
  return jsonResponse(503, {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32603, message },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const baseUrl = env('SUPABASE_URL');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!baseUrl || !serviceKey) {
    return unavailable('Serveur MCP indisponible : configuration serveur incomplète.');
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

  const dependencies = createDependencies({
    baseUrl,
    serviceKey,
    writeEnabled: writeEnabled(),
    serverInfo: SERVER_INFO,
  });

  const result = await handleMcpHttp(dependencies, {
    method: request.method,
    authorization: request.headers.get('authorization'),
    body,
    parseError,
  });

  const extra: Record<string, string> = { ...(result.headers ?? {}) };
  // Renvoyer la version annoncée permet aux clients MCP de détecter un serveur
  // moderne derrière un proxy.
  const requestedVersion = request.headers.get('mcp-protocol-version');
  if (requestedVersion) extra['mcp-protocol-version'] = requestedVersion;

  return jsonResponse(result.status, result.body, extra);
});

export const __serverInfo = SERVER_INFO;
