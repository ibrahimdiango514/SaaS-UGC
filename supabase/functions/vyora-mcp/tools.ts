// VYORA MCP — registre des outils exposés au protocole Model Context Protocol.
//
// Chaque outil déclare :
//   * son schéma d'entrée (JSON Schema, exposé tel quel dans `tools/list`) ;
//   * la portée requise (`read` ou `write`) ;
//   * la RPC Postgres qui l'exécute, TOUJOURS filtrée par `p_user_id`.
//
// Règle structurante : aucun outil ne reçoit d'identifiant utilisateur depuis le
// client MCP. Le `p_user_id` provient du jeton résolu côté serveur ; il est
// injecté ici, jamais lu dans les arguments. C'est la première des deux
// barrières d'isolation (la seconde étant la RPC `security definer` elle-même).
//
// Aucun outil d'écriture n'est exposé tant que `VYORA_MCP_WRITE_ENABLED` n'est
// pas explicitement positionné à `true` : voir `buildToolRegistry`.

export type ToolScope = 'read' | 'write';

export interface McpToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly scope: ToolScope;
  /** Nom de la RPC Postgres. Elle DOIT accepter `p_user_id` en premier argument. */
  readonly rpc: string;
  /** Convertit les arguments MCP validés en arguments nommés de la RPC. */
  readonly args: (input: Record<string, unknown>, userId: string) => Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
}

const LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  default: 20,
  description: 'Nombre maximum d\'éléments renvoyés (1 à 100).',
} as const;

const OFFSET_SCHEMA = {
  type: 'integer',
  minimum: 0,
  maximum: 100000,
  default: 0,
  description: 'Décalage de pagination.',
} as const;

function paginationArgs(input: Record<string, unknown>, userId: string): Record<string, unknown> {
  return {
    p_user_id: userId,
    p_limit: input.limit ?? 20,
    p_offset: input.offset ?? 0,
  };
}

function identityArgs(_input: Record<string, unknown>, userId: string): Record<string, unknown> {
  return { p_user_id: userId };
}

/**
 * Outils en LECTURE SEULE, actifs dès que la fonction est déployée.
 * Chacun est strictement limité aux ressources de l'utilisateur du jeton.
 */
export const READ_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'vyora_account_info',
    title: 'Mon compte VYORA',
    description:
      'Renvoie l\'identité VYORA de l\'utilisateur du jeton : identifiant de compte, date d\'adhésion et espaces de travail accessibles avec leur rôle. Aucune donnée d\'un autre utilisateur n\'est accessible.',
    scope: 'read',
    rpc: 'mcp_account_info',
    args: identityArgs,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vyora_projects_list',
    title: 'Lister mes projets vidéo',
    description:
      'Liste les projets vidéo appartenant à l\'utilisateur du jeton, ou hébergés dans un espace de travail dont il est membre. Triés par dernière modification, avec pagination.',
    scope: 'read',
    rpc: 'mcp_projects_list',
    args: paginationArgs,
    inputSchema: {
      type: 'object',
      properties: { limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_generations_list',
    title: 'Lister mes générations',
    description:
      'Liste les tâches de génération vidéo lancées par l\'utilisateur du jeton : statut, fournisseur, crédits débités et horodatages. Aucun contenu d\'un autre compte.',
    scope: 'read',
    rpc: 'mcp_generations_list',
    args: paginationArgs,
    inputSchema: {
      type: 'object',
      properties: { limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_history_list',
    title: 'Consulter mon historique d\'usage',
    description:
      'Liste les événements d\'usage (consommation, crédits) de l\'utilisateur du jeton, du plus récent au plus ancien.',
    scope: 'read',
    rpc: 'mcp_history_list',
    args: paginationArgs,
    inputSchema: {
      type: 'object',
      properties: { limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_integrations_list',
    title: 'Lister mes intégrations',
    description:
      'Indique, pour chaque connecteur (Gmail, Drive, Calendar, Instagram, TikTok, Facebook, YouTube, WhatsApp Business), si l\'utilisateur du jeton l\'a connecté. Ne renvoie jamais de jeton OAuth ni de référence de credential.',
    scope: 'read',
    rpc: 'mcp_integrations_list',
    args: identityArgs,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * Outils d'ÉCRITURE, préparés mais désactivés par défaut.
 * Ils ne sont annoncés dans `tools/list` que si `VYORA_MCP_WRITE_ENABLED=true`,
 * et restent soumis à la portée `write` du jeton et aux autorisations par outil.
 */
export const WRITE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'vyora_project_create',
    title: 'Créer un projet vidéo',
    description:
      'Crée un projet vidéo en brouillon dans l\'espace de travail principal de l\'utilisateur du jeton. Action d\'écriture : elle n\'est disponible que si elle a été explicitement autorisée pour ce jeton.',
    scope: 'write',
    rpc: 'mcp_project_create',
    args: (input, userId) => ({
      p_user_id: userId,
      p_title: input.title,
      p_platform: input.platform ?? 'TikTok',
      p_language: input.language ?? 'fr',
    }),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Titre du projet.' },
        platform: {
          type: 'string',
          maxLength: 40,
          default: 'TikTok',
          description: 'Plateforme cible (TikTok, Instagram, YouTube…).',
        },
        language: { type: 'string', maxLength: 10, default: 'fr', description: 'Code langue du projet.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
];

export interface ToolRegistryOptions {
  /** Valeur de `VYORA_MCP_WRITE_ENABLED`. Seul `true` active les outils d'écriture. */
  readonly writeEnabled: boolean;
}

export interface BuiltToolRegistry {
  readonly tools: readonly McpToolDefinition[];
  readonly byName: ReadonlyMap<string, McpToolDefinition>;
}

/**
 * Construit le registre effectif. Les outils d'écriture sont absents — et donc
 * non appelables, pas seulement « refusés » — tant que l'écriture n'est pas
 * explicitement activée sur le déploiement.
 */
export function buildToolRegistry(options: ToolRegistryOptions): BuiltToolRegistry {
  const tools: McpToolDefinition[] = [...READ_TOOLS];
  if (options.writeEnabled === true) tools.push(...WRITE_TOOLS);
  const byName = new Map<string, McpToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`outil en double: ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return { tools, byName };
}

/** Charge utile `tools/list`. */
export function toolsListPayload(registry: BuiltToolRegistry): { tools: unknown[] } {
  return {
    tools: registry.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.scope === 'read',
        destructiveHint: false,
        idempotentHint: tool.scope === 'read',
        openWorldHint: false,
      },
    })),
  };
}

export class ToolArgumentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = code;
  }
}

const INTEGER_KEYS = new Set(['limit', 'offset']);

/**
 * Valide les arguments d'un outil contre son JSON Schema (sous-ensemble
 * volontairement restreint : object/string/integer, required, additionalProperties).
 * Un argument inconnu est REJETÉ, jamais ignoré silencieusement : un client ne
 * peut pas espérer faire passer `user_id` ou `workspace_id` par ce chemin.
 */
export function validateToolArguments(
  tool: McpToolDefinition,
  raw: unknown,
): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ToolArgumentError('invalid_arguments', 'Les arguments doivent être un objet JSON.');
  }
  const input = raw as Record<string, unknown>;
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
  const properties = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) {
        throw new ToolArgumentError('unknown_argument', `Argument non supporté : ${key}`);
      }
    }
  }
  for (const key of schema.required ?? []) {
    const value = input[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      throw new ToolArgumentError('missing_argument', `Argument requis manquant : ${key}`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const spec = properties[key];
    if (!spec) continue;
    if (spec.type === 'string') {
      if (typeof value !== 'string') throw new ToolArgumentError('invalid_argument', `${key} doit être une chaîne.`);
      const length = value.length;
      if (spec.minLength !== undefined && length < spec.minLength) {
        throw new ToolArgumentError('invalid_argument', `${key} est trop court (minimum ${spec.minLength}).`);
      }
      if (spec.maxLength !== undefined && length > spec.maxLength) {
        throw new ToolArgumentError('invalid_argument', `${key} est trop long (maximum ${spec.maxLength}).`);
      }
    } else if (spec.type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ToolArgumentError('invalid_argument', `${key} doit être un entier.`);
      }
      if (spec.minimum !== undefined && value < spec.minimum) {
        throw new ToolArgumentError('invalid_argument', `${key} est inférieur au minimum (${spec.minimum}).`);
      }
      if (spec.maximum !== undefined && value > spec.maximum) {
        throw new ToolArgumentError('invalid_argument', `${key} est supérieur au maximum (${spec.maximum}).`);
      }
    }
  }
  // Normalisation : les entiers absents reçoivent leur valeur par défaut côté
  // registre (`paginationArgs`), pas ici — on ne mute pas l'entrée du client.
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    normalized[key] = INTEGER_KEYS.has(key) ? value : typeof value === 'string' ? value.trim() : value;
  }
  return normalized;
}
