// VYORA MCP — couche d'accès pour l'interface du dashboard.
//
// L'interface ne parle JAMAIS directement au serveur MCP : elle appelle des RPC
// `security definer` qui prennent l'identité dans `auth.uid()`. Un utilisateur
// connecté ne peut donc lister, révoquer ou faire tourner que SES jetons.
//
// Le secret d'un jeton n'est renvoyé qu'au moment de sa création (ou d'une
// rotation), par la RPC elle-même. Il n'est jamais stocké côté client au-delà de
// l'affichage : aucune écriture en localStorage, aucun envoi vers un tiers.

import { supabase, SUPABASE_URL } from './supabase';
import { AppError, humanizeError } from './errors';

/** URL publique du serveur MCP, déduite de l'URL Supabase du projet. */
export function mcpEndpoint(): string {
  const base = SUPABASE_URL.replace(/\/+$/, '');
  return `${base}/functions/v1/vyora-mcp`;
}

export type McpClientKind = 'claude' | 'cursor' | 'vscode' | 'generic';
export type McpScope = 'read' | 'write';

export interface McpToken {
  id: string;
  label: string;
  token_prefix: string;
  scopes: McpScope[];
  client_name: string | null;
  client_kind: McpClientKind | null;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  expires_at: string | null;
  revoked: boolean;
}

export interface McpCreatedToken {
  token_id: string;
  connection_id: string;
  secret: string;
  token_prefix: string;
  scopes: McpScope[];
}

export interface McpActivityEntry {
  id: number;
  method: string;
  tool_name: string | null;
  outcome: 'ok' | 'denied' | 'error' | 'invalid';
  error_code: string | null;
  duration_ms: number | null;
  token_prefix: string | null;
  created_at: string;
}

export interface McpToolPermission {
  tool_name: string;
  allowed: boolean;
}

async function callRpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.rpc as any)(name, args);
  if (error) throw new AppError(humanizeError(error.message), error.code ?? 'MCP_RPC_ERROR');
  return data as T;
}

export async function listMcpTokens(): Promise<McpToken[]> {
  const data = await callRpc<{ items: McpToken[] }>('mcp_list_tokens');
  return Array.isArray(data?.items) ? data.items : [];
}

export async function createMcpToken(input: {
  label: string;
  clientName: string;
  clientKind: McpClientKind;
  scopes: McpScope[];
  expiresInDays?: number | null;
}): Promise<McpCreatedToken> {
  return callRpc<McpCreatedToken>('mcp_create_token', {
    p_label: input.label.trim(),
    p_client_name: input.clientName.trim() || 'Client MCP',
    p_client_kind: input.clientKind,
    p_scopes: input.scopes,
    p_expires_in_days: input.expiresInDays ?? null,
  });
}

export async function revokeMcpToken(tokenId: string): Promise<boolean> {
  const data = await callRpc<{ revoked: boolean }>('mcp_revoke_token', { p_token_id: tokenId });
  return data?.revoked === true;
}

export async function rotateMcpToken(tokenId: string): Promise<McpCreatedToken> {
  return callRpc<McpCreatedToken>('mcp_rotate_token', { p_token_id: tokenId });
}

export async function listMcpActivity(limit = 50): Promise<McpActivityEntry[]> {
  const data = await callRpc<{ items: McpActivityEntry[] }>('mcp_list_activity', { p_limit: limit });
  return Array.isArray(data?.items) ? data.items : [];
}

export async function listMcpToolPermissions(tokenId: string): Promise<McpToolPermission[]> {
  const data = await callRpc<{ items: McpToolPermission[] }>('mcp_list_tool_permissions', { p_token_id: tokenId });
  return Array.isArray(data?.items) ? data.items : [];
}

export async function setMcpToolPermission(tokenId: string, toolName: string, allowed: boolean): Promise<void> {
  await callRpc('mcp_set_tool_permission', { p_token_id: tokenId, p_tool_name: toolName, allowed });
}

/**
 * Outils RÉELLEMENT exposés par le serveur déployé.
 *
 * Cette liste est alignée sur `supabase/functions/vyora-mcp/tools.ts`. Elle
 * n'affiche aucun outil fantôme : les outils d'écriture ne sont pas listés tant
 * que `VYORA_MCP_WRITE_ENABLED` n'est pas activé côté serveur.
 */
export const MCP_TOOLS = [
  {
    name: 'vyora_account_info',
    label: 'Mon compte VYORA',
    description: 'Identité du compte, date d’adhésion et espaces de travail accessibles.',
    scope: 'read' as const,
  },
  {
    name: 'vyora_projects_list',
    label: 'Mes projets vidéo',
    description: 'Projets vidéo de l’utilisateur, triés par dernière modification.',
    scope: 'read' as const,
  },
  {
    name: 'vyora_generations_list',
    label: 'Mes générations',
    description: 'Tâches de génération : statut, fournisseur, crédits débités.',
    scope: 'read' as const,
  },
  {
    name: 'vyora_history_list',
    label: 'Mon historique d’usage',
    description: 'Événements de consommation et de crédits.',
    scope: 'read' as const,
  },
  {
    name: 'vyora_integrations_list',
    label: 'Mes intégrations',
    description: 'État des connecteurs — jamais de jeton OAuth.',
    scope: 'read' as const,
  },
] as const;

export const MCP_WRITE_TOOL = {
  name: 'vyora_project_create',
  label: 'Créer un projet vidéo',
  description: 'Écriture : création d’un brouillon. Désactivée par défaut sur le serveur.',
  scope: 'write' as const,
};

/**
 * Configuration à copier dans un client MCP.
 * `mcpServers` est le format utilisé par Claude Desktop et Cursor ; VS Code
 * utilise `servers` avec `type: "http"`.
 */
export function mcpClientConfig(secret: string, clientKind: McpClientKind): string {
  const url = mcpEndpoint();
  if (clientKind === 'vscode') {
    return JSON.stringify(
      {
        servers: {
          vyora: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${secret}` },
          },
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      mcpServers: {
        vyora: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    },
    null,
    2,
  );
}
