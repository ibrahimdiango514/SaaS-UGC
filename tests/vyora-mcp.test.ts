// VYORA MCP — tests du cœur protocole : JSON-RPC, authentification, et surtout
// ISOLATION MULTI-UTILISATEUR. Ces tests n'ont besoin ni de Deno ni de base :
// la couche `protocol.ts` est pure et reçoit ses dépendances.
import { describe, expect, it, vi } from 'vitest';
import {
  bearerToken,
  handleJsonRpcBody,
  handleJsonRpcMessage,
  handleMcpHttp,
  FORBIDDEN,
  INVALID_PARAMS,
  LATEST_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  UNAUTHORIZED,
  type McpActivityEntry,
  type McpDependencies,
  type McpIdentity,
} from '../supabase/functions/vyora-mcp/protocol.ts';
import { READ_TOOLS, WRITE_TOOLS, buildToolRegistry } from '../supabase/functions/vyora-mcp/tools.ts';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'abababab-abab-4bab-8bab-abababababab';
const TOKEN_A = 'token-a';
const TOKEN_B = 'token-b';
const SECRET_A = 'vyora_mcp_secretA_secretA_secretA';
const SECRET_B = 'vyora_mcp_secretB_secretB_secretB';

// Deux jeux de données strictement séparés, comme en base réelle.
const PROJECTS: Record<string, Array<{ id: string; title: string }>> = {
  [USER_A]: [{ id: 'p-a', title: 'PROJET SECRET A' }],
  [USER_B]: [{ id: 'p-b', title: 'PROJET SECRET B' }],
};

const IDENTITIES: Record<string, McpIdentity> = {
  [SECRET_A]: {
    userId: USER_A,
    tokenId: TOKEN_A,
    connectionId: 'conn-a',
    scopes: ['read', 'write'],
    tokenPrefix: 'vyora_mcp_secretA',
  },
  [SECRET_B]: {
    userId: USER_B,
    tokenId: TOKEN_B,
    connectionId: 'conn-b',
    scopes: ['read'],
    tokenPrefix: 'vyora_mcp_secretB',
  },
};

interface Harness {
  deps: McpDependencies;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  activity: McpActivityEntry[];
  permitted: Map<string, boolean>;
  touched: string[];
}

function harness(overrides: Partial<McpDependencies> = {}): Harness {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const activity: McpActivityEntry[] = [];
  const permitted = new Map<string, boolean>();
  const touched: string[] = [];

  const deps: McpDependencies = {
    writeEnabled: false,
    serverInfo: { name: 'vyora-mcp', version: 'test' },
    now: () => 1_000,
    async resolveToken(secret) {
      return IDENTITIES[secret] ?? null;
    },
    async callRpc(name, args) {
      rpcCalls.push({ name, args });
      const userId = String(args.p_user_id);
      if (name === 'mcp_projects_list') {
        const items = PROJECTS[userId] ?? [];
        return { total: items.length, items, limit: args.p_limit, offset: args.p_offset };
      }
      if (name === 'mcp_account_info') return { user_id: userId };
      return { items: [] };
    },
    async isToolPermitted(identity, toolName) {
      return permitted.get(`${identity.tokenId}:${toolName}`) ?? true;
    },
    async logActivity(entry) {
      activity.push(entry);
    },
    async touchToken(tokenId) {
      touched.push(tokenId);
    },
    ...overrides,
  };
  return { deps, rpcCalls, activity, permitted, touched };
}

function identityA(): McpIdentity {
  return IDENTITIES[SECRET_A];
}

describe('vyora-mcp / extraction du jeton', () => {
  it('accepte un jeton porteur bien formé', () => {
    expect(bearerToken(`Bearer ${SECRET_A}`)).toBe(SECRET_A);
    expect(bearerToken(`bearer ${SECRET_A}`)).toBe(SECRET_A);
  });

  it('refuse un en-tête absent, un autre schéma ou un jeton trop court', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer token-trop-court')).toBeNull();
    // Un JWT Supabase n'est pas un jeton MCP.
    expect(bearerToken('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBeNull();
  });
});

describe('vyora-mcp / transport HTTP', () => {
  it('refuse GET : pas de flux SSE persistant sur une Edge Function', async () => {
    const { deps } = harness();
    const result = await handleMcpHttp(deps, { method: 'GET', authorization: `Bearer ${SECRET_A}` });
    expect(result.status).toBe(405);
    expect(result.headers?.Allow).toContain('POST');
  });

  it('renvoie 401 sans jeton, et ne touche ni la base ni le journal', async () => {
    const { deps, rpcCalls, activity, touched } = harness();
    const result = await handleMcpHttp(deps, { method: 'POST', authorization: null, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    expect(result.status).toBe(401);
    expect((result.body as { error: { code: number } }).error.code).toBe(UNAUTHORIZED);
    expect(rpcCalls).toHaveLength(0);
    expect(activity).toHaveLength(0);
    expect(touched).toHaveLength(0);
  });

  it('renvoie 401 avec un jeton inconnu, sans distinguer le motif de rejet', async () => {
    const { deps } = harness();
    const inconnu = await handleMcpHttp(deps, { method: 'POST', authorization: 'Bearer vyora_mcp_inconnu_inconnu_inconnu', body: {} });
    const revoque = await handleMcpHttp(deps, {
      method: 'POST',
      authorization: 'Bearer vyora_mcp_revoque_revoque_revoque',
      body: {},
    });
    expect(inconnu.status).toBe(401);
    expect(revoque.status).toBe(401);
    // Message identique : aucun oracle pour un porteur de jeton volé.
    expect((inconnu.body as { error: { message: string } }).error.message).toBe(
      (revoque.body as { error: { message: string } }).error.message,
    );
  });

  it('renvoie 401 si la résolution de jeton lève une exception', async () => {
    const { deps } = harness({
      async resolveToken() {
        throw new Error('database down');
      },
    });
    const result = await handleMcpHttp(deps, { method: 'POST', authorization: `Bearer ${SECRET_A}`, body: {} });
    expect(result.status).toBe(401);
  });

  it('renvoie 400 sur un corps JSON illisible', async () => {
    const { deps } = harness();
    const result = await handleMcpHttp(deps, { method: 'POST', authorization: `Bearer ${SECRET_A}`, parseError: true });
    expect(result.status).toBe(400);
    expect((result.body as { error: { code: number } }).error.code).toBe(PARSE_ERROR);
  });

  it('met à jour last_used_at après authentification réussie', async () => {
    const { deps, touched } = harness();
    await handleMcpHttp(deps, {
      method: 'POST',
      authorization: `Bearer ${SECRET_A}`,
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(touched).toEqual([TOKEN_A]);
  });
});

describe('vyora-mcp / initialize', () => {
  it('négocie la version demandée quand elle est supportée', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } },
    });
    const result = response?.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe('2025-03-26');
    expect(result.serverInfo.name).toBe('vyora-mcp');
    expect(result.capabilities.tools).toBeDefined();
  });

  it('retombe sur la dernière version pour une version inconnue', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    expect((response?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('vyora-mcp / notifications', () => {
  it('ne produit aucune réponse pour une notification', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(response).toBeNull();
  });

  it('renvoie 202 sans corps pour une notification HTTP', async () => {
    const { deps } = harness();
    const result = await handleMcpHttp(deps, {
      method: 'POST',
      authorization: `Bearer ${SECRET_A}`,
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
  });
});

describe('vyora-mcp / tools/list', () => {
  it('annonce les cinq outils de lecture, sans outil d\'écriture par défaut', async () => {
    const { deps } = harness({ writeEnabled: false });
    const response = await handleJsonRpcMessage(deps, identityA(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (response?.result as { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'vyora_account_info',
      'vyora_projects_list',
      'vyora_generations_list',
      'vyora_history_list',
      'vyora_integrations_list',
    ]);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it('n\'expose l\'outil d\'écriture que si VYORA_MCP_WRITE_ENABLED=true', async () => {
    const { deps } = harness({ writeEnabled: true });
    const response = await handleJsonRpcMessage(deps, identityA(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain('vyora_project_create');
  });

  it('le registre refuse les doublons de nom', () => {
    expect(buildToolRegistry({ writeEnabled: false }).tools).toHaveLength(READ_TOOLS.length);
    expect(buildToolRegistry({ writeEnabled: true }).tools).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length);
  });
});

describe('vyora-mcp / ISOLATION MULTI-UTILISATEUR', () => {
  it('l\'utilisateur A ne reçoit que ses projets, l\'utilisateur B que les siens', async () => {
    const { deps, rpcCalls } = harness();

    const responseA = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_projects_list', arguments: {} },
    });
    const dataA = (responseA?.result as { structuredContent: { items: Array<{ title: string }> } }).structuredContent;
    expect(dataA.items.map((item) => item.title)).toEqual(['PROJET SECRET A']);

    const responseB = await handleJsonRpcMessage(deps, IDENTITIES[SECRET_B], {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'vyora_projects_list', arguments: {} },
    });
    const dataB = (responseB?.result as { structuredContent: { items: Array<{ title: string }> } }).structuredContent;
    expect(dataB.items.map((item) => item.title)).toEqual(['PROJET SECRET B']);
    expect(JSON.stringify(dataA)).not.toContain('PROJET SECRET B');
    expect(JSON.stringify(dataB)).not.toContain('PROJET SECRET A');

    // Chaque appel porte le p_user_id de SON jeton.
    expect(rpcCalls.map((call) => call.args.p_user_id)).toEqual([USER_A, USER_B]);
  });

  it('un client ne peut pas imposer user_id / workspace_id par les arguments', async () => {
    const { deps, rpcCalls } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'vyora_projects_list',
        arguments: { limit: 5, user_id: USER_B, p_user_id: USER_B, workspace_id: 'ws-b' },
      },
    });
    expect((response?.error as { code: number }).code).toBe(INVALID_PARAMS);
    expect(rpcCalls).toHaveLength(0);
  });

  it('les arguments transmis à la RPC ne contiennent que p_user_id et la pagination', async () => {
    const { deps, rpcCalls } = harness();
    await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_generations_list', arguments: { limit: 2, offset: 4 } },
    });
    expect(rpcCalls[0]).toEqual({
      name: 'mcp_generations_list',
      args: { p_user_id: USER_A, p_limit: 2, p_offset: 4 },
    });
  });

  it('la pagination est bornée : limit hors plage refusée', async () => {
    const { deps, rpcCalls } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_projects_list', arguments: { limit: 5000 } },
    });
    expect((response?.error as { code: number }).code).toBe(INVALID_PARAMS);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('vyora-mcp / autorisations', () => {
  it('refuse un outil dont la portée manque au jeton', async () => {
    const { deps } = harness({ writeEnabled: true });
    // B n'a que la portée `read`.
    const response = await handleJsonRpcMessage(deps, IDENTITIES[SECRET_B], {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_project_create', arguments: { title: 'Test' } },
    });
    expect((response?.error as { code: number }).code).toBe(FORBIDDEN);
  });

  it('refuse un outil explicitement retiré par mcp_tool_permissions', async () => {
    const { deps, permitted, rpcCalls } = harness();
    permitted.set(`${TOKEN_A}:vyora_projects_list`, false);
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_projects_list', arguments: {} },
    });
    expect((response?.error as { code: number }).code).toBe(FORBIDDEN);
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuse un outil inconnu et liste les outils disponibles', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_sql_execute', arguments: { sql: 'select 1' } },
    });
    const error = response?.error as { code: number; data: { available: string[] } };
    expect(error.code).toBe(INVALID_PARAMS);
    expect(error.data.available).toContain('vyora_projects_list');
  });

  it('refuse l\'outil d\'écriture quand l\'écriture est désactivée, même avec la portée write', async () => {
    const { deps, rpcCalls } = harness({ writeEnabled: false });
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_project_create', arguments: { title: 'Test' } },
    });
    expect((response?.error as { code: number }).code).toBe(INVALID_PARAMS);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('vyora-mcp / erreurs et journalisation', () => {
  it('renvoie METHOD_NOT_FOUND pour une méthode inconnue', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), { jsonrpc: '2.0', id: 9, method: 'resources/read' });
    expect((response?.error as { code: number }).code).toBe(METHOD_NOT_FOUND);
  });

  it('signale isError quand la RPC échoue, sans fuiter de détail interne', async () => {
    const { deps } = harness({
      async callRpc() {
        throw new Error('permission denied for table ugc_tokens');
      },
    });
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_account_info', arguments: {} },
    });
    const result = response?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Erreur d\'exécution');
    expect(response?.error).toBeUndefined();
  });

  it('journalise chaque appel avec le préfixe public seulement, jamais le jeton', async () => {
    const { deps, activity } = harness();
    await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_projects_list', arguments: {} },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      userId: USER_A,
      tokenId: TOKEN_A,
      tokenPrefix: 'vyora_mcp_secretA',
      method: 'tools/call',
      toolName: 'vyora_projects_list',
      outcome: 'ok',
    });
    expect(JSON.stringify(activity)).not.toContain(SECRET_A);
    expect(JSON.stringify(activity)).not.toContain('secretA_secretA');
  });

  it('une panne du journal ne fait pas échouer un appel réussi', async () => {
    const { deps } = harness({
      async logActivity() {
        throw new Error('log down');
      },
    });
    const response = await handleJsonRpcMessage(deps, identityA(), { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response?.result).toEqual({});
  });

  it('une panne de touchToken ne bloque pas la réponse HTTP', async () => {
    const { deps } = harness({
      async touchToken() {
        throw new Error('touch down');
      },
    });
    const result = await handleMcpHttp(deps, {
      method: 'POST',
      authorization: `Bearer ${SECRET_A}`,
      body: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(result.status).toBe(200);
  });
});

describe('vyora-mcp / lots JSON-RPC', () => {
  it('traite un lot et ne renvoie que les réponses non vides', async () => {
    const { deps } = harness();
    const { status, payload } = await handleJsonRpcBody(deps, identityA(), [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    expect(status).toBe(200);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload as unknown[]).toHaveLength(2);
  });

  it('rejette un lot vide', async () => {
    const { deps } = harness();
    const { status, payload } = await handleJsonRpcBody(deps, identityA(), []);
    expect(status).toBe(400);
    expect((payload as { error: { code: number } }).error.code).toBe(-32600);
  });

  it('rejette un message dont jsonrpc ne vaut pas 2.0', async () => {
    const { deps } = harness();
    const response = await handleJsonRpcMessage(deps, identityA(), { jsonrpc: '1.0', id: 4, method: 'ping' });
    expect((response?.error as { code: number }).code).toBe(-32600);
  });
});

describe('vyora-mcp / schémas exposés', () => {
  it('chaque outil déclare un schéma d\'objet fermé', () => {
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      const schema = tool.inputSchema as { type: string; additionalProperties?: boolean };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('aucun outil n\'expose un argument d\'identité utilisateur', () => {
    for (const tool of [...READ_TOOLS, ...WRITE_TOOLS]) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const forbidden of ['user_id', 'p_user_id', 'userId', 'workspace_id']) {
        expect(Object.keys(properties)).not.toContain(forbidden);
      }
    }
  });

  it('l\'outil de création exige un titre', async () => {
    const { deps, rpcCalls } = harness({ writeEnabled: true });
    const response = await handleJsonRpcMessage(deps, identityA(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vyora_project_create', arguments: {} },
    });
    expect((response?.error as { code: number }).code).toBe(INVALID_PARAMS);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('vyora-mcp / cas réel : deux jetons, deux comptes', () => {
  it('simule un cycle complet par utilisateur avec des dépendances indépendantes', async () => {
    const calls: string[] = [];
    const mk = (): McpDependencies => ({
      writeEnabled: false,
      serverInfo: { name: 'vyora-mcp', version: 'test' },
      async resolveToken(secret) {
        return secret === SECRET_A ? IDENTITIES[SECRET_A] : secret === SECRET_B ? IDENTITIES[SECRET_B] : null;
      },
      async callRpc(name, args) {
        calls.push(`${name}:${args.p_user_id}`);
        return { items: PROJECTS[String(args.p_user_id)] ?? [] };
      },
      async isToolPermitted() {
        return true;
      },
      async logActivity() {},
      async touchToken() {},
    });

    const depsA = mk();
    const depsB = mk();

    const ra = await handleMcpHttp(depsA, {
      method: 'POST',
      authorization: `Bearer ${SECRET_A}`,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_projects_list', arguments: {} } },
    });
    const rb = await handleMcpHttp(depsB, {
      method: 'POST',
      authorization: `Bearer ${SECRET_B}`,
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_projects_list', arguments: {} } },
    });

    const textA = (ra.body as { result: { structuredContent: { items: Array<{ title: string }> } } }).result.structuredContent.items.map((i) => i.title);
    const textB = (rb.body as { result: { structuredContent: { items: Array<{ title: string }> } } }).result.structuredContent.items.map((i) => i.title);
    expect(textA).toEqual(['PROJET SECRET A']);
    expect(textB).toEqual(['PROJET SECRET B']);
    expect(calls).toEqual([`mcp_projects_list:${USER_A}`, `mcp_projects_list:${USER_B}`]);
  });

  it('un jeton de A ne peut jamais produire une identité B', async () => {
    const { deps } = harness();
    const spy = vi.fn();
    const result = await handleMcpHttp(
      { ...deps, logActivity: spy },
      { method: 'POST', authorization: `Bearer ${SECRET_A}`, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vyora_account_info', arguments: { user_id: USER_B } } } },
    );
    // L'argument est refusé avant tout appel.
    expect((result.body as { error?: { code: number } }).error?.code).toBe(INVALID_PARAMS);
  });
});
