// Accès aux outils MCP externes autorisés par un utilisateur, pour les agents
// Business Grow.
//
// ## Pourquoi ce module existe
//
// VYORA MCP sait déjà ajouter un serveur externe, tester la connexion, découvrir
// ses outils et autoriser outil par outil. Mais ces outils n'étaient utilisables
// que manuellement, depuis l'écran des serveurs MCP : aucun agent ne pouvait s'en
// servir, parce que les agents Business Grow n'ont accès qu'à une liste fermée
// (`bg_create_tool_execution` refuse tout autre nom).
//
// Ce module ouvre le chemin manquant, sans reconstruire ce qui existe :
//
//   * les permissions sont relues en base à CHAQUE appel (`tool_permissions`),
//     jamais mises en cache — une révocation prend effet immédiatement ;
//   * l'exécution réutilise `saas_business.tool_executions` et son écran
//     d'approbation : un outil MCP est une proposition comme une autre ;
//   * aucun appel réseau n'est fait ici. Une approbation pose
//     `requires_external_execution = true` ; c'est l'Edge Function `mcp-client`
//     (qui porte déjà la validation d'URL et l'anti-SSRF) qui exécute ensuite.
//
// ## Ce que ce module NE fait pas
//
// Il n'active aucune écriture. La classification (`bg_mcp_tool_is_write` en SQL,
// miroir de `classerOutil` côté TypeScript) marque chaque outil comme lecture ou
// écriture ; seuls les outils de LECTURE sont proposables. Une écriture MCP
// resterait de toute façon refusée par la porte d'exécution, puisque VYORA ne
// dispose d'aucune autorisation d'écriture MCP. Proposer une écriture
// demanderait donc une approbation pour une action qui échouerait à coup sûr.

/** Un outil MCP que l'agent peut proposer à l'utilisateur. */
export interface McpToolCatalogEntry {
  /** Identifiant de la connexion (`public.mcp_servers.id`). */
  serverId: string;
  /** Nom lisible du serveur, choisi par l'utilisateur. */
  serverName: string;
  /** Nom technique de l'outil, tel que le serveur distant l'annonce. */
  toolName: string;
  /** Description fournie par le serveur distant — non fiable, jamais exécutée. */
  description: string;
  /** `true` seulement pour un outil de lecture. */
  executable: boolean;
}

/**
 * Client SQL minimal attendu par ce module.
 *
 * On ne dépend pas du type complet de `postgres` : ce module est testé avec un
 * double, et n'a besoin que d'une balise de requête paramétrée.
 */
export interface McpSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
}

/** Résultat normalisé d'une proposition d'outil MCP. */
export interface McpProposalResult {
  id: string;
  toolName: string;
  status: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Normalise un nom d'outil distant.
 *
 * Le nom vient du serveur MCP, donc d'un tiers. Il finit dans un écran
 * d'approbation : il doit rester court, sans caractère de contrôle, sans espace.
 * La règle est la même que celle de `bg_create_mcp_tool_execution`, pour qu'un
 * nom affiché soit toujours un nom acceptable au moment de la proposition.
 */
export function normalizeMcpToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(trimmed) ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Catalogue des outils MCP autorisés pour un espace de travail.
 *
 * La fonction SQL `bg_list_mcp_tools` applique elle-même l'isolation
 * (utilisateur ET espace de travail), le refus par défaut et la classification
 * lecture/écriture. Ce module ne fait aucune sélection à la place de la base :
 * il normalise seulement le résultat, parce qu'il traverse une frontière de
 * confiance (JSON renvoyé par PostgreSQL, réaffiché dans une interface).
 *
 * En cas d'erreur, on renvoie une liste vide plutôt que de propager l'échec :
 * l'agent doit pouvoir répondre normalement même si les connecteurs MCP sont
 * momentanément indisponibles.
 */
export async function listerOutilsMcp(
  sql: McpSql,
  userId: string,
  workspaceId: string,
): Promise<McpToolCatalogEntry[]> {
  if (!isUuid(userId) || !isUuid(workspaceId)) return [];
  let rows: unknown[];
  try {
    rows = await sql`
      select saas_business.bg_list_mcp_tools(${userId}::uuid, ${workspaceId}::uuid) as outils
    `;
  } catch {
    return [];
  }
  const brut = asRecord(rows[0]).outils;
  if (!Array.isArray(brut)) return [];

  const outils: McpToolCatalogEntry[] = [];
  for (const entree of brut) {
    const record = asRecord(entree);
    const serverId = record.server_id;
    const toolName = normalizeMcpToolName(record.tool_name);
    // Un identifiant venu d'ailleurs ne devient jamais un lien vers un autre
    // serveur : on ne garde que ce qui peut être réutilisé tel quel.
    if (!isUuid(serverId) || !toolName) continue;
    const description = typeof record.description === 'string' ? record.description : '';
    outils.push({
      serverId,
      serverName: typeof record.server_name === 'string' ? record.server_name.slice(0, 200) : 'Serveur MCP',
      toolName,
      description: description.slice(0, 500),
      executable: record.executable === true,
    });
  }
  return outils;
}

/**
 * Propose un outil MCP à l'approbation de l'utilisateur.
 *
 * Renvoie `null` quand la proposition n'est pas permise — sans dire pourquoi, et
 * volontairement : distinguer « serveur inconnu », « outil inconnu » et
 * « permission manquante » confirmerait l'existence d'une connexion d'un tiers à
 * qui tenterait des identifiants au hasard. Le message SQL est déjà générique
 * (`mcp tool not allowed`) ; on ne l'enrichit pas ici.
 *
 * La vérification finale appartient quand même à la base : ce module refuse tôt
 * ce qui est manifestement invalide, mais `bg_create_mcp_tool_execution`
 * revalide tout (isolation, permission, classification) dans sa transaction.
 */
export async function proposerOutilMcp(
  sql: McpSql,
  input: {
    userId: string;
    conversationId: string;
    requestId: string;
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  },
): Promise<string | null> {
  const { userId, conversationId, requestId, serverId } = input;
  if (!isUuid(userId) || !isUuid(conversationId) || !isUuid(requestId) || !isUuid(serverId)) return null;
  const toolName = normalizeMcpToolName(input.toolName);
  if (!toolName) return null;

  const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
    ? input.arguments
    : {};
  // Même plafond que la fonction SQL : refuser ici évite un aller-retour réseau
  // pour une charge qui serait de toute façon rejetée en base.
  let serialise: string;
  try {
    serialise = JSON.stringify(args);
  } catch {
    return null;
  }
  if (serialise.length > 12_000) return null;

  try {
    const rows = await sql`
      select saas_business.bg_create_mcp_tool_execution(
        ${userId}::uuid,
        ${conversationId}::uuid,
        ${requestId}::uuid,
        ${serverId}::uuid,
        ${toolName},
        ${serialise}::jsonb
      ) as id
    `;
    const id = asRecord(rows[0]).id;
    return isUuid(id) ? id : null;
  } catch {
    // Permission absente, serveur révoqué, outil classé écriture, espace de
    // travail différent : la base refuse, et ce refus n'est pas une panne.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Branchement réel : accès SQL, sans dépendre de `index.ts`
// ---------------------------------------------------------------------------

/** Connexion SQL telle que la crée `index.ts` (même bibliothèque, mêmes options). */
export interface McpSqlFactory {
  (): McpSql;
}

/**
 * Construit l'accès SQL aux outils MCP à partir de l'environnement de l'Edge.
 *
 * ## Pourquoi ici et pas dans `index.ts`
 *
 * `index.ts` est le point de démarrage : le modifier oblige à ré-épingler tout
 * l'artefact et élargit le risque d'une régression de démarrage pour un ajout
 * qui ne le justifie pas. Ce module construit donc sa propre connexion, avec
 * exactement la même bibliothèque et les mêmes options que celle de `index.ts`.
 *
 * ## Ce qui se passe si la configuration manque
 *
 * La fabrique renvoie une fonction qui échoue à l'appel, pas au chargement. Un
 * Business Grow sans accès MCP configuré doit continuer de fonctionner pour
 * tout le reste : le catalogue renverra simplement une liste vide, et une
 * proposition MCP sera refusée (`null`). Aucune exception ne remonte au client.
 */
export function creerAccesMcp(options: {
  /** Lecture de l'environnement (`Deno.env.get` en production, un double en test). */
  env?: (nom: string) => string | undefined;
  /** Bibliothèque `postgres`, injectée en production depuis `globalThis`. */
  postgres?: unknown;
} = {}): { listerOutils: (userId: string, workspaceId: string) => Promise<McpToolCatalogEntry[]>; proposerOutil: (input: Parameters<typeof proposerOutilMcp>[1]) => Promise<string | null> } {
  const lireEnv = options.env
    ?? ((nom: string) => {
      try {
        const deno = (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } }).Deno;
        return deno?.env?.get?.(nom);
      } catch {
        return undefined;
      }
    });

  const url = lireEnv('BUSINESS_GROW_DATABASE_URL') || lireEnv('SUPABASE_DB_URL');
  const bibliotheque = options.postgres
    ?? (globalThis as { __bgPostgres?: unknown }).__bgPostgres;

  let connexion: McpSql | null = null;
  let echec = '';

  const obtenir = (): McpSql => {
    if (connexion) return connexion;
    if (echec) throw new Error(echec);
    if (!url) { echec = 'Business Grow MCP: base non configurée.'; throw new Error(echec); }
    if (typeof bibliotheque !== 'function') { echec = 'Business Grow MCP: pilote SQL absent.'; throw new Error(echec); }
    try {
      connexion = (bibliotheque as (u: string, o: Record<string, unknown>) => McpSql)(url, {
        // Une seule connexion : ces appels sont rares (catalogue + proposition)
        // et ne doivent pas épuiser le pool partagé avec le reste du service.
        max: 1,
        idle_timeout: 20,
        connect_timeout: 10,
        ssl: 'require',
        prepare: false,
        connection: { application_name: 'reelora-business-grow-edge-mcp' },
      });
      return connexion;
    } catch (error) {
      echec = `Business Grow MCP: connexion impossible (${error instanceof Error ? error.message : 'inconnue'}).`;
      throw new Error(echec);
    }
  };

  /*
   * `obtenir()` peut lever (configuration absente, pilote SQL manquant). On le
   * convertit ici en résultat vide / refus : une panne de connexion MCP ne doit
   * jamais faire échouer une réponse d'agent qui n'a rien demandé de tel.
   */
  return {
    listerOutils: (userId, workspaceId) => {
      try {
        return listerOutilsMcp(obtenir(), userId, workspaceId);
      } catch {
        return Promise.resolve([]);
      }
    },
    proposerOutil: (input) => {
      try {
        return proposerOutilMcp(obtenir(), input);
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}
