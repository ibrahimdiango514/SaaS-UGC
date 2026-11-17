/**
 * VYORA — cœur du serveur MCP officiel : catalogue d'outils et moteur JSON-RPC.
 *
 * ## Pourquoi ce fichier existe séparément du handler
 *
 * Le serveur MCP v3 tournait déjà en production, mais son code ne vivait QUE
 * dans un artefact gzip stocké en base, absent du dépôt : il était donc
 * impossible de le tester, de le relire en revue, ou de le corriger sans
 * manipuler une base de données. Ce module remet le protocole dans le dépôt,
 * avec des dépendances injectées, pour qu'il soit vérifiable par des tests
 * ordinaires.
 *
 * Toute la logique de protocole vit ici : aucune dépendance à Deno, à
 * Supabase ou au réseau. Le handler ne fait que brancher le transport HTTP et
 * les appels PostgreSQL.
 *
 * ## Ce que le module garantit
 *
 * - **Un seul point d'autorisation.** `executer()` reçoit un `ContexteJeton`
 *   déjà résolu et ne fait jamais confiance à un identifiant fourni dans les
 *   arguments. Le `userId` vient du jeton, jamais de l'appel JSON-RPC.
 * - **Refus par défaut.** Une méthode non reconnue, un outil absent, une portée
 *   manquante ou une permission non accordée renvoient une erreur explicite —
 *   jamais un succès silencieux.
 * - **Erreurs compréhensibles.** Chaque refus porte un code machine stable et
 *   un message en français qui dit quoi faire.
 */

/** Version du protocole retenue quand le client n'en propose pas de connue. */
export const PROTOCOLE_PAR_DEFAUT = '2025-06-18';

/**
 * Versions supportées, de la plus récente à la plus ancienne.
 *
 * `initialize` répond la version du client si elle figure ici, sinon la plus
 * récente : c'est ce que demande la spécification MCP, et c'est aussi ce qui
 * permet à un client ancien de continuer à fonctionner.
 */
export const PROTOCOLES_SUPPORTES = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type Portee = 'read' | 'write';

/** Identité résolue à partir d'un jeton MCP. Rien ici ne vient du client. */
export interface ContexteJeton {
  userId: string;
  tokenId: string;
  connectionId: string | null;
  scopes: string[];
  tokenPrefix: string;
}

/** Dépendances injectées : le handler fournit les appels PostgreSQL réels. */
export interface Dependances {
  /** Indique si les outils d'écriture sont activés sur ce déploiement. */
  ecritureActive: boolean;
  /** Exécute une fonction RPC en lecture, déjà validée contre la liste blanche. */
  appelerRpc(nom: string, args: Record<string, unknown>): Promise<unknown>;
  /** Vrai si le jeton a le droit d'appeler cet outil (table de permissions). */
  outilAutorise(contexte: ContexteJeton, nomOutil: string, portee: Portee): Promise<boolean>;
  /** Journalise une requête. Ne doit jamais faire échouer la requête. */
  journaliser(entree: JournalEntree): Promise<void>;
}

export interface JournalEntree {
  userId: string;
  tokenId: string;
  connectionId: string | null;
  tokenPrefix: string;
  method: string;
  toolName?: string;
  outcome: string;
  errorCode?: string;
  durationMs?: number;
  resultSize?: number;
}

/* -------------------------------------------------------------------------- */
/* Catalogue d'outils                                                          */
/* -------------------------------------------------------------------------- */

export interface ChampSchema {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: string | number | boolean;
  enum?: string[];
}

export interface SchemaEntree {
  type: 'object';
  properties: Record<string, ChampSchema>;
  required?: string[];
  additionalProperties: false;
}

export interface Outil {
  name: string;
  title: string;
  description: string;
  /** Portée exigée : un jeton `read` ne peut pas appeler un outil `write`. */
  scope: Portee;
  /** RPC PostgreSQL appelée, validée contre `RPC_AUTORISEES`. */
  rpc: string;
  /** Construit les arguments SQL — le `userId` vient du jeton, jamais du client. */
  args: (entree: Record<string, unknown>, userId: string) => Record<string, unknown>;
  inputSchema: SchemaEntree;
}

/**
 * Liste blanche des RPC que le serveur peut appeler.
 *
 * C'est la barrière contre une injection par le nom d'outil : même si le
 * catalogue était corrompu ou étendu par erreur, un nom absent de cet
 * ensemble ne peut pas atteindre la base. Le serveur Edge parle avec la clé
 * de service : cette liste est donc la seule chose qui l'empêche d'appeler
 * `mcp_create_token` ou n'importe quelle autre fonction privilégiée.
 */
export const RPC_AUTORISEES: ReadonlySet<string> = new Set([
  'mcp_account_info',
  'mcp_projects_list',
  'mcp_generations_list',
  'mcp_history_list',
  'mcp_integrations_list',
  'mcp_stores_list',
  'mcp_products_list',
  'mcp_product_get',
  'mcp_imports_list',
  'mcp_import_preview_list',
  'mcp_integrations_status',
  'mcp_product_create',
  // Outil d'écriture vidéo hérité de la v3 : il était appelé par le serveur
  // déployé mais ABSENT de cette liste, ce qui l'aurait rendu inopérant dès la
  // première exécution du nouveau handler. Le test de liste blanche l'a
  // attrapé avant le déploiement.
  'mcp_project_create',
]);

const LIMITE: ChampSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  default: 20,
  description: "Nombre maximum d'éléments renvoyés (1 à 100).",
};

const DECALAGE: ChampSchema = {
  type: 'integer',
  minimum: 0,
  maximum: 100000,
  default: 0,
  description: 'Décalage de pagination.',
};

/** Arguments limit/offset, avec le `userId` du jeton injecté. */
function argsPagine(e: Record<string, unknown>, userId: string) {
  return { p_user_id: userId, p_limit: e.limit ?? 20, p_offset: e.offset ?? 0 };
}

/** Arguments sans pagination : le `userId` seul. */
function argsSimple(_e: Record<string, unknown>, userId: string) {
  return { p_user_id: userId };
}

/**
 * Outils de LECTURE, toujours proposés.
 *
 * Chacun correspond à une fonction SQL réellement présente en base. Aucun
 * outil n'est déclaré « au cas où » : un outil annoncé sans implémentation
 * serait exactement la fonction fictive que la mission interdit.
 */
export const OUTILS_LECTURE: Outil[] = [
  {
    name: 'vyora_account_info',
    title: 'Mon compte VYORA',
    description:
      "Renvoie l'identité VYORA de l'utilisateur du jeton : identifiant de compte, date d'adhésion "
      + 'et espaces de travail accessibles avec leur rôle. Aucune donnée d’un autre utilisateur '
      + "n'est accessible.",
    scope: 'read',
    rpc: 'mcp_account_info',
    args: argsSimple,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vyora_stores_list',
    title: 'Lister mes boutiques connectées',
    description:
      "Liste les boutiques connectées à VYORA pour l'utilisateur du jeton : plateforme, statut "
      + 'de la connexion et date de dernière vérification. Ne renvoie JAMAIS de secret, de clé '
      + "d'API ni de référence de coffre — seulement l'état de la connexion.",
    scope: 'read',
    rpc: 'mcp_stores_list',
    args: argsSimple,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vyora_products_list',
    title: 'Parcourir mon catalogue de produits',
    description:
      "Liste les produits importés dans un espace de travail de l'utilisateur du jeton : nom, "
      + 'prix, devise, nombre de variantes et image de référence. Paginé, trié par dernière '
      + 'modification. Un `workspace_id` peut restreindre la lecture à une entreprise ; il est '
      + "vérifié côté serveur, et un identifiant d'une entreprise dont l'utilisateur n'est pas "
      + "membre est refusé.",
    scope: 'read',
    rpc: 'mcp_products_list',
    args: (e, userId) => ({
      p_user_id: userId,
      p_workspace_id: e.workspace_id ?? null,
      p_limit: e.limit ?? 20,
      p_offset: e.offset ?? 0,
    }),
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          maxLength: 64,
          description: "Identifiant d'entreprise pour restreindre la lecture. Omis : tous les espaces accessibles.",
        },
        limit: LIMITE,
        offset: DECALAGE,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_product_get',
    title: 'Lire la fiche complète d’un produit',
    description:
      "Renvoie un produit et ses variantes (SKU, prix, stock) par son identifiant, si l'utilisateur "
      + "du jeton a accès à l'espace de travail qui le contient. Un identifiant appartenant à un "
      + 'autre compte renvoie « introuvable », jamais une fiche partielle.',
    scope: 'read',
    rpc: 'mcp_product_get',
    args: (e, userId) => ({ p_user_id: userId, p_product_id: e.product_id }),
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', minLength: 36, maxLength: 36, description: 'Identifiant UUID du produit.' },
      },
      required: ['product_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_imports_list',
    title: 'Consulter mon historique d’importation',
    description:
      "Liste les imports réalisés par l'utilisateur du jeton : source, statut, nombre de produits "
      + 'créés ou en échec, date. Permet de reprendre un import interrompu et de vérifier ce qui '
      + 'a réellement été écrit.',
    scope: 'read',
    rpc: 'mcp_imports_list',
    args: argsPagine,
    inputSchema: { type: 'object', properties: { limit: LIMITE, offset: DECALAGE }, additionalProperties: false },
  },
  {
    name: 'vyora_import_previews_list',
    title: 'Consulter mes aperçus d’import',
    description:
      "Liste les aperçus d'import préparés pour l'utilisateur du jeton : plateforme, nombre de "
      + 'produits détectés, doublons rapprochés et date. Un aperçu est une LECTURE : rien n’est '
      + 'écrit dans la boutique ni dans le catalogue avant confirmation explicite côté interface.',
    scope: 'read',
    rpc: 'mcp_import_preview_list',
    args: argsPagine,
    inputSchema: { type: 'object', properties: { limit: LIMITE, offset: DECALAGE }, additionalProperties: false },
  },
  {
    name: 'vyora_integrations_status',
    title: 'État de mes intégrations',
    description:
      "Renvoie, pour chaque plateforme connectée, son état (connectée, identifiants refusés, "
      + 'expirée, non configurée) et la date de la dernière vérification réussie. Aucune clé, '
      + "aucun jeton, aucune référence de coffre n'est renvoyée.",
    scope: 'read',
    rpc: 'mcp_integrations_status',
    args: argsSimple,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'vyora_projects_list',
    title: 'Lister mes projets vidéo',
    description:
      "Liste les projets vidéo appartenant à l'utilisateur du jeton, ou hébergés dans un espace "
      + 'de travail dont il est membre. Triés par dernière modification, avec pagination.',
    scope: 'read',
    rpc: 'mcp_projects_list',
    args: argsPagine,
    inputSchema: { type: 'object', properties: { limit: LIMITE, offset: DECALAGE }, additionalProperties: false },
  },
  {
    name: 'vyora_generations_list',
    title: 'Lister mes générations',
    description:
      "Liste les tâches de génération vidéo lancées par l'utilisateur du jeton : statut, "
      + 'fournisseur, crédits débités et horodatages. Aucun contenu d’un autre compte.',
    scope: 'read',
    rpc: 'mcp_generations_list',
    args: argsPagine,
    inputSchema: { type: 'object', properties: { limit: LIMITE, offset: DECALAGE }, additionalProperties: false },
  },
  {
    name: 'vyora_history_list',
    title: 'Consulter mon historique d’usage',
    description:
      "Liste les événements d'usage (consommation, crédits) de l'utilisateur du jeton, du plus "
      + 'récent au plus ancien.',
    scope: 'read',
    rpc: 'mcp_history_list',
    args: argsPagine,
    inputSchema: { type: 'object', properties: { limit: LIMITE, offset: DECALAGE }, additionalProperties: false },
  },
  {
    name: 'vyora_integrations_list',
    title: 'Lister mes intégrations',
    description:
      "Indique, pour chaque connecteur (Gmail, Drive, Calendar, Instagram, TikTok, Facebook, "
      + "YouTube, WhatsApp Business), si l'utilisateur du jeton l'a connecté. Ne renvoie jamais "
      + 'de jeton OAuth ni de référence de credential.',
    scope: 'read',
    rpc: 'mcp_integrations_list',
    args: argsSimple,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * Outils d'ÉCRITURE.
 *
 * Proposés uniquement si `VYORA_MCP_WRITE_ENABLED=true` sur le déploiement ET
 * si le jeton porte la portée `write` ET si la permission de l'outil est
 * accordée. Trois verrous indépendants : en ouvrir un ne suffit pas.
 */
export const OUTILS_ECRITURE: Outil[] = [
  {
    name: 'vyora_product_create',
    title: 'Créer un produit',
    description:
      "Crée un produit dans l'espace de travail principal de l'utilisateur du jeton. Action "
      + "d'écriture : elle n'est disponible que si elle a été explicitement autorisée pour ce "
      + 'jeton, et le produit créé n’est jamais poussé vers une boutique — VYORA n’écrit pas chez '
      + 'les plateformes.',
    scope: 'write',
    rpc: 'mcp_product_create',
    args: (e, userId) => ({
      p_user_id: userId,
      p_workspace_id: e.workspace_id ?? null,
      p_name: e.name,
      p_description: e.description ?? null,
      p_price_amount: e.price_amount ?? null,
      p_price_currency: e.price_currency ?? 'XOF',
    }),
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200, description: 'Nom du produit.' },
        description: { type: 'string', maxLength: 4000, description: 'Description facultative.' },
        price_amount: { type: 'integer', minimum: 0, maximum: 1000000000, description: 'Prix en unité mineure.' },
        price_currency: { type: 'string', minLength: 3, maxLength: 3, description: 'Code devise ISO 4217.' },
        workspace_id: { type: 'string', maxLength: 64, description: "Entreprise cible. Omis : espace principal." },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'vyora_project_create',
    title: 'Créer un projet vidéo',
    description:
      "Crée un projet vidéo en brouillon dans l'espace de travail principal de l'utilisateur du "
      + "jeton. Action d'écriture : elle n'est disponible que si elle a été explicitement "
      + 'autorisée pour ce jeton.',
    scope: 'write',
    rpc: 'mcp_project_create',
    args: (e, userId) => ({
      p_user_id: userId,
      p_title: e.title,
      p_platform: e.platform ?? 'TikTok',
      p_language: e.language ?? 'fr',
    }),
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Titre du projet.' },
        platform: { type: 'string', maxLength: 40, default: 'TikTok', description: 'Plateforme cible.' },
        language: { type: 'string', maxLength: 10, default: 'fr', description: 'Code langue du projet.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
];

export interface Catalogue {
  tools: Outil[];
  byName: Map<string, Outil>;
  /** Nombre d'outils exposés, tel qu'un client MCP le compte. */
  count: number;
}

/**
 * Construit le catalogue pour un déploiement donné.
 *
 * Un nom d'outil en double lève : deux définitions du même nom rendraient le
 * routage dépendant de l'ordre de déclaration, ce qui est ingérable.
 */
export function construireCatalogue(options: { ecritureActive: boolean }): Catalogue {
  const tools = [...OUTILS_LECTURE];
  if (options.ecritureActive) tools.push(...OUTILS_ECRITURE);
  const byName = new Map<string, Outil>();
  for (const outil of tools) {
    if (byName.has(outil.name)) throw new Error(`outil en double: ${outil.name}`);
    byName.set(outil.name, outil);
  }
  return { tools, byName, count: tools.length };
}

/** Vue `tools/list` : le schéma exposé au client, sans les détails internes. */
export function descriptionOutils(catalogue: Catalogue) {
  return {
    // `count` accompagne la liste : un client qui veut afficher « 11 outils »
    // n'a pas à compter lui-même, et un test peut vérifier la cohérence.
    count: catalogue.count,
    tools: catalogue.tools.map((outil) => ({
      name: outil.name,
      title: outil.title,
      description: outil.description,
      inputSchema: outil.inputSchema,
      /*
       * Les annotations disent au client ce qu'il peut déduire sans appeler :
       * un outil de lecture ne modifie rien, n'est pas destructeur et ne sort
       * pas du périmètre VYORA. `openWorldHint: false` signale qu'aucun appel
       * réseau vers un tiers n'est effectué pendant l'outil.
       */
      annotations: {
        readOnlyHint: outil.scope === 'read',
        destructiveHint: false,
        idempotentHint: outil.scope === 'read',
        openWorldHint: false,
      },
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Validation des arguments                                                    */
/* -------------------------------------------------------------------------- */

/** Erreur d'argument, distinguée d'une panne pour produire le bon code JSON-RPC. */
export class ErreurArgument extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ErreurArgument';
    this.code = code;
  }
}

/** Arguments laissés tels quels (pas de `trim`) : ce sont des entiers. */
const NON_TRIMES = new Set(['limit', 'offset']);

/**
 * Valide les arguments contre le schéma de l'outil.
 *
 * Refuser un argument inconnu n'est pas de la sévérité gratuite : un client
 * qui envoie `{ workspaceID: … }` au lieu de `{ workspace_id: … }` obtiendrait
 * silencieusement le périmètre complet au lieu du périmètre demandé. Un rejet
 * explicite vaut mieux qu'un résultat trompeur.
 */
export function validerArguments(outil: Outil, bruts: unknown): Record<string, unknown> {
  const entree = bruts == null ? {} : bruts;
  if (typeof entree !== 'object' || Array.isArray(entree)) {
    throw new ErreurArgument('invalid_arguments', 'Les arguments doivent être un objet JSON.');
  }
  const objet = entree as Record<string, unknown>;
  const schema = outil.inputSchema;
  const proprietes = schema.properties ?? {};

  if (schema.additionalProperties === false) {
    for (const cle of Object.keys(objet)) {
      if (!(cle in proprietes)) throw new ErreurArgument('unknown_argument', `Argument non supporté : ${cle}`);
    }
  }

  for (const requise of schema.required ?? []) {
    const valeur = objet[requise];
    if (valeur == null || (typeof valeur === 'string' && valeur.trim() === '')) {
      throw new ErreurArgument('missing_argument', `Argument requis manquant : ${requise}`);
    }
  }

  for (const [cle, valeur] of Object.entries(objet)) {
    if (valeur == null) continue;
    const champ = proprietes[cle];
    if (!champ) continue;
    if (champ.type === 'string') {
      if (typeof valeur !== 'string') throw new ErreurArgument('invalid_argument', `${cle} doit être une chaîne.`);
      if (champ.minLength !== undefined && valeur.length < champ.minLength) {
        throw new ErreurArgument('invalid_argument', `${cle} est trop court (minimum ${champ.minLength}).`);
      }
      if (champ.maxLength !== undefined && valeur.length > champ.maxLength) {
        throw new ErreurArgument('invalid_argument', `${cle} est trop long (maximum ${champ.maxLength}).`);
      }
      if (champ.enum && !champ.enum.includes(valeur)) {
        throw new ErreurArgument('invalid_argument', `${cle} doit valoir : ${champ.enum.join(', ')}.`);
      }
    } else if (champ.type === 'integer') {
      if (typeof valeur !== 'number' || !Number.isInteger(valeur)) {
        throw new ErreurArgument('invalid_argument', `${cle} doit être un entier.`);
      }
      if (champ.minimum !== undefined && valeur < champ.minimum) {
        throw new ErreurArgument('invalid_argument', `${cle} est inférieur au minimum (${champ.minimum}).`);
      }
      if (champ.maximum !== undefined && valeur > champ.maximum) {
        throw new ErreurArgument('invalid_argument', `${cle} est supérieur au maximum (${champ.maximum}).`);
      }
    } else if (champ.type === 'boolean' && typeof valeur !== 'boolean') {
      throw new ErreurArgument('invalid_argument', `${cle} doit être un booléen.`);
    }
  }

  // Les valeurs textuelles sont trimées : un identifiant entouré d'espaces est
  // une faute de saisie fréquente, pas une intention.
  const propre: Record<string, unknown> = {};
  for (const [cle, valeur] of Object.entries(objet)) {
    if (valeur == null) continue;
    propre[cle] = NON_TRIMES.has(cle) ? valeur : typeof valeur === 'string' ? valeur.trim() : valeur;
  }
  return propre;
}

/* -------------------------------------------------------------------------- */
/* JSON-RPC 2.0                                                                */
/* -------------------------------------------------------------------------- */

export const CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  /** Jeton absent, invalide, révoqué ou expiré. */
  unauthorized: -32001,
  /** Portée ou permission d'outil insuffisante. */
  forbidden: -32003,
} as const;

export interface ErreurJsonRpc {
  code: number;
  message: string;
  data?: unknown;
}

export interface ReponseJsonRpc {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: ErreurJsonRpc;
}

export function erreur(id: string | number | null, code: number, message: string, data?: unknown): ReponseJsonRpc {
  const e: ErreurJsonRpc = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id, error: e };
}

export function succes(id: string | number | null, result: unknown): ReponseJsonRpc {
  return { jsonrpc: '2.0', id, result };
}

/** Vrai si la valeur est une requête JSON-RPC plausible. */
export function estRequete(valeur: unknown): valeur is { jsonrpc: string; method: string; id?: unknown; params?: unknown } {
  if (typeof valeur !== 'object' || valeur === null || Array.isArray(valeur)) return false;
  const v = valeur as Record<string, unknown>;
  /*
   * `method` doit être une chaîne NON VIDE. Sans cette condition, une méthode
   * vide passait pour une notification inconnue : elle était ignorée (202) et
   * journalisée « ok », alors qu'il s'agit d'une requête invalide (-32600).
   * Un journal qui annonce « ok » sur une requête malformée trompe l'utilisateur
   * au moment précis où il cherche pourquoi son client ne fonctionne pas.
   */
  return v.jsonrpc === '2.0' && typeof v.method === 'string' && v.method.trim() !== '';
}

export interface ResultatTraitement {
  /** `null` pour une notification : aucune réponse ne doit être renvoyée. */
  reponse: ReponseJsonRpc | null;
  outcome: string;
  toolName?: string;
  errorCode?: string;
  resultSize?: number;
}

/**
 * Traite une requête JSON-RPC authentifiée.
 *
 * `contexte` est fourni par l'appelant APRÈS résolution du jeton : cette
 * fonction ne lit jamais d'identifiant utilisateur dans la requête.
 */
export async function traiter(
  deps: Dependances,
  contexte: ContexteJeton,
  requete: unknown,
  options: { serverInfo: { name: string; version: string }; now?: () => number },
): Promise<ResultatTraitement> {
  const horloge = options.now ?? (() => Date.now());
  const debut = horloge();

  if (!estRequete(requete)) {
    const id = typeof requete === 'object' && requete !== null && 'id' in requete
      ? (requete as { id?: unknown }).id ?? null
      : null;
    return {
      reponse: erreur(
        typeof id === 'string' || typeof id === 'number' ? id : null,
        CODES.invalidRequest,
        'Requête JSON-RPC invalide : « jsonrpc » doit valoir « 2.0 » et « method » doit être une chaîne.',
      ),
      outcome: 'invalid',
      errorCode: 'invalid_request',
    };
  }

  const r = requete;
  const estNotification = r.id === undefined || r.id === null;
  const id = estNotification ? null : (r.id as string | number);
  const catalogue = construireCatalogue({ ecritureActive: deps.ecritureActive });

  /** Journalise puis renvoie : un échec de journal ne casse jamais la réponse. */
  const tracer = async (reponse: ReponseJsonRpc | null, extra: Omit<ResultatTraitement, 'reponse'>) => {
    try {
      await deps.journaliser({
        userId: contexte.userId,
        tokenId: contexte.tokenId,
        connectionId: contexte.connectionId,
        tokenPrefix: contexte.tokenPrefix,
        method: r.method,
        ...extra,
        durationMs: Math.max(0, horloge() - debut),
      });
    } catch {
      /* Le journal ne doit jamais faire échouer une requête valide. */
    }
    return { reponse, ...extra };
  };

  switch (r.method) {
    case 'initialize': {
      const params = (r.params ?? {}) as Record<string, unknown>;
      const demandee = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (PROTOCOLES_SUPPORTES as readonly string[]).includes(demandee)
        ? demandee
        : PROTOCOLE_PAR_DEFAUT;
      return tracer(
        succes(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.serverInfo.name, version: options.serverInfo.version },
          instructions:
            'Serveur VYORA MCP. Les outils n’accèdent qu’aux ressources de l’utilisateur '
            + 'propriétaire du jeton. Les outils d’écriture sont désactivés par défaut et, '
            + 'quand ils sont activés, exigent une permission explicite par jeton.',
        }),
        { outcome: 'ok' },
      );
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/roots/list_changed':
      // Notifications : aucune réponse, mais on les journalise.
      return tracer(null, { outcome: 'ok' });

    case 'ping':
      return tracer(succes(id, {}), { outcome: 'ok' });

    case 'tools/list':
      return tracer(succes(id, descriptionOutils(catalogue)), { outcome: 'ok' });

    /*
     * Le serveur ne publie ni ressources ni prompts. Répondre une liste vide
     * est correct et suffisant : un client qui interroge ces méthodes reçoit
     * une réponse valide au lieu d'une erreur de méthode inconnue.
     */
    case 'resources/list':
      return tracer(succes(id, { resources: [] }), { outcome: 'ok' });
    case 'prompts/list':
      return tracer(succes(id, { prompts: [] }), { outcome: 'ok' });

    case 'tools/call': {
      const params = (r.params ?? {}) as Record<string, unknown>;
      const nom = typeof params.name === 'string' ? params.name : '';
      if (!nom) {
        return tracer(erreur(id, CODES.invalidParams, 'Le paramètre « name » est requis pour tools/call.'), {
          outcome: 'invalid',
          errorCode: 'missing_tool_name',
        });
      }

      const outil = catalogue.byName.get(nom);
      if (!outil) {
        /*
         * Un outil d'écriture existant mais désactivé sur ce déploiement doit
         * être distingué d'un nom inventé : le premier dit quoi faire.
         */
        const existeEnEcriture = OUTILS_ECRITURE.some((o) => o.name === nom);
        const message = existeEnEcriture
          ? `L’outil ${nom} existe mais l’écriture est désactivée sur ce déploiement.`
          : `Outil inconnu : ${nom}`;
        return tracer(
          erreur(id, CODES.invalidParams, message, {
            available: catalogue.tools.map((o) => o.name),
            ...(existeEnEcriture ? { reason: 'write_disabled' } : {}),
          }),
          { outcome: 'invalid', toolName: nom, errorCode: existeEnEcriture ? 'write_disabled' : 'unknown_tool' },
        );
      }

      // Verrou 1 : la portée du jeton.
      if (!contexte.scopes.includes(outil.scope)) {
        return tracer(
          erreur(
            id,
            CODES.forbidden,
            `Le jeton ne possède pas la portée « ${outil.scope} » requise par ${nom}.`,
          ),
          { outcome: 'denied', toolName: nom, errorCode: 'scope_missing' },
        );
      }

      // Verrou 2 : la permission par outil (défaut = autorisé, révocable).
      let permis = false;
      try {
        permis = await deps.outilAutorise(contexte, outil.name, outil.scope);
      } catch {
        permis = false;
      }
      if (!permis) {
        return tracer(erreur(id, CODES.forbidden, `Outil non autorisé pour ce jeton : ${nom}`), {
          outcome: 'denied',
          toolName: nom,
          errorCode: 'tool_not_permitted',
        });
      }

      let args: Record<string, unknown>;
      try {
        args = outil.args(validerArguments(outil, params.arguments), contexte.userId);
      } catch (cause) {
        const code = cause instanceof ErreurArgument ? cause.code : 'invalid_arguments';
        const message = cause instanceof Error ? cause.message : 'Arguments invalides.';
        return tracer(erreur(id, CODES.invalidParams, message, { reason: code }), {
          outcome: 'invalid',
          toolName: nom,
          errorCode: code,
        });
      }

      try {
        const donnees = await deps.appelerRpc(outil.rpc, args);
        const texte = JSON.stringify(donnees ?? null);
        return tracer(
          succes(id, {
            content: [{ type: 'text', text: texte }],
            structuredContent: donnees ?? null,
            isError: false,
          }),
          { outcome: 'ok', toolName: nom, resultSize: texte.length },
        );
      } catch (cause) {
        /*
         * Une erreur d'exécution n'est PAS une erreur de protocole : la
         * spécification demande de la renvoyer dans le résultat, avec
         * `isError: true`, pour que le client la présente à l'utilisateur au
         * lieu de croire à une panne de transport.
         */
        const message = cause instanceof Error ? cause.message : "Échec de l'exécution de l'outil.";
        return tracer(
          succes(id, { content: [{ type: 'text', text: `Erreur d'exécution : ${message}` }], isError: true }),
          { outcome: 'error', toolName: nom, errorCode: 'rpc_failed' },
        );
      }
    }

    default:
      // Une notification inconnue est ignorée sans réponse, conformément à la spec.
      if (estNotification) return tracer(null, { outcome: 'ok' });
      return tracer(erreur(id, CODES.methodNotFound, `Méthode non supportée : ${r.method}`), {
        outcome: 'invalid',
        errorCode: 'method_not_found',
      });
  }
}

/**
 * Traite un corps POST : requête unique ou lot.
 *
 * Un lot vide est refusé (la spécification JSON-RPC l'interdit). Un lot dont
 * toutes les entrées sont des notifications renvoie `payload: null`, que le
 * transport traduit en 202 sans corps.
 */
export async function traiterCorps(
  deps: Dependances,
  contexte: ContexteJeton,
  corps: unknown,
  options: { serverInfo: { name: string; version: string }; now?: () => number },
): Promise<{ status: number; payload: unknown }> {
  if (Array.isArray(corps)) {
    if (corps.length === 0) {
      return { status: 400, payload: erreur(null, CODES.invalidRequest, 'Lot JSON-RPC vide.') };
    }
    const reponses = [];
    for (const entree of corps) {
      const resultat = await traiter(deps, contexte, entree, options);
      if (resultat.reponse) reponses.push(resultat.reponse);
    }
    return { status: 200, payload: reponses.length > 0 ? reponses : null };
  }

  const resultat = await traiter(deps, contexte, corps, options);
  if (resultat.reponse === null) return { status: 202, payload: null };
  return { status: 200, payload: resultat.reponse };
}
