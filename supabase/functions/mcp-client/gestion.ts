/**
 * SORAHNEX — règles de gestion des connexions MCP SORTANTES (P6).
 *
 * ## Ce que ce module est
 *
 * La partie **pure** de la gestion : validation des entrées, liste blanche des
 * routes, règles de permission. Aucune base, aucun réseau, aucun secret. Tout
 * est donc testable sans rien simuler d'autre que des objets.
 *
 * ## Ce qu'il n'est pas
 *
 * Il ne décide pas si un appel d'outil peut partir — c'est `execution.ts`, qui
 * relit la base à chaque appel. Ce module ne fait que préparer et valider des
 * *demandes de gestion* (créer, tester, lister, révoquer).
 *
 * ## Le principe de sécurité
 *
 * Toute route de gestion exige une identité GoTrue. Le `userId` vient
 * exclusivement du jeton vérifié, **jamais** du corps de la requête : un
 * `user_id` présent dans le JSON est ignoré. Sans cela, n'importe qui pourrait
 * révoquer le serveur d'un autre en changeant un champ.
 */

/* -------------------------------------------------------------------------- */
/* 1. Routes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Routes de gestion, exposées sous `/gestion/<route>`.
 *
 * Une liste blanche explicite plutôt qu'un routage par préfixe : une route
 * inconnue doit être un refus, pas une tentative d'interprétation.
 */
export const ROUTES_GESTION = [
  'lister',
  'creer',
  'tester',
  'permissions',
  'revoquer',
  'executer',
  'oauth-demarrer',
  'oauth-revoquer',
] as const;

export type RouteGestion = typeof ROUTES_GESTION[number];

/**
 * Extrait la route de gestion d'un chemin.
 *
 * Le préfixe de fonction (`/functions/v1/mcp-client`) et le suffixe
 * `/gestion/...` peuvent varier selon l'appelant ; on ne s'appuie donc pas sur
 * le début du chemin, mais sur le dernier segment significatif. Un chemin qui
 * ne contient pas `/gestion/` n'est pas une route de gestion : c'est le
 * transport MCP d'appel d'outil, traité ailleurs.
 */
export function routeGestion(chemin: string): RouteGestion | null {
  const marqueur = '/gestion/';
  const index = (chemin || '').lastIndexOf(marqueur);
  if (index < 0) return null;
  const brut = chemin.slice(index + marqueur.length).replace(/\/+$/, '').toLowerCase();
  return (ROUTES_GESTION as readonly string[]).includes(brut) ? brut as RouteGestion : null;
}

/** Vrai si le chemin désigne une route de gestion, même inconnue. */
export function estCheminGestion(chemin: string): boolean {
  return (chemin || '').includes('/gestion/');
}

/* -------------------------------------------------------------------------- */
/* 2. Validation des entrées                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_NOM_SERVEUR = 120;
export const MAX_URL = 2048;
export const MAX_SECRET = 8192;
export const MAX_OUTILS_GERES = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RefusValidation = { ok: false; status: number; code: string; message: string };

/**
 * Modes d'authentification, alignés exactement sur la contrainte CHECK de
 * `mcp_servers.auth_kind`. Toute autre valeur serait rejetée par PostgreSQL
 * avec une erreur 500 opaque : on refuse ici, avec un message utile.
 */
export const MODES_AUTH = ['none', 'bearer', 'api_key', 'oauth'] as const;
export type ModeAuth = typeof MODES_AUTH[number];

export interface DemandeCreation {
  workspaceId: string;
  nom: string;
  url: string;
  authKind: ModeAuth;
  /** Valeur du secret. Jamais journalisée, jamais renvoyée. */
  secret?: string;
  oauthClientId?: string;
  authorizationServer?: string;
}

export function validerCreation(corps: unknown): { ok: true; demande: DemandeCreation } | RefusValidation {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return refus(400, 'corps_invalide', 'Le corps doit être un objet JSON.');
  }
  const o = corps as Record<string, unknown>;

  const workspaceId = o.workspaceId ?? o.workspace_id;
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) {
    return refus(400, 'workspace_id_invalide', 'Identifiant d’espace de travail invalide.');
  }

  const nom = typeof o.nom === 'string' ? o.nom.trim() : (typeof o.name === 'string' ? o.name.trim() : '');
  if (nom.length < 1 || nom.length > MAX_NOM_SERVEUR) {
    return refus(400, 'nom_invalide', `Le nom doit contenir entre 1 et ${MAX_NOM_SERVEUR} caractères.`);
  }

  const url = typeof o.url === 'string' ? o.url.trim() : '';
  if (url.length === 0 || url.length > MAX_URL) {
    return refus(400, 'url_invalide', 'URL invalide.');
  }
  /*
   * Seul `https://` est accepté, et on le vérifie AVANT la base.
   *
   * La contrainte `mcp_servers_url_https` le refuserait de toute façon, mais
   * avec une erreur SQL illisible. Et surtout : accepter `http://` ici
   * laisserait croire qu'un transport en clair est possible. Les protections
   * SSRF de `safePost` restent la barrière réelle contre une adresse privée ;
   * elles ne sont pas contournées.
   */
  if (!/^https:\/\//i.test(url)) {
    return refus(400, 'url_non_https', 'Seules les URL https:// sont acceptées.');
  }

  const authKindBrut = o.authKind ?? o.auth_kind;
  if (typeof authKindBrut !== 'string' || !(MODES_AUTH as readonly string[]).includes(authKindBrut)) {
    return refus(400, 'auth_kind_invalide', `Mode d’authentification invalide (${MODES_AUTH.join(', ')}).`);
  }
  const authKind = authKindBrut as ModeAuth;

  const secretBrut = o.secret;
  if (secretBrut !== undefined && secretBrut !== null && typeof secretBrut !== 'string') {
    return refus(400, 'secret_invalide', 'Le secret doit être une chaîne.');
  }
  const secret = typeof secretBrut === 'string' ? secretBrut : undefined;

  /*
   * `oauth` est le seul mode où le secret peut manquer à la création : le
   * jeton est obtenu ENSUITE par le flux d'autorisation (P6c). Exiger un
   * secret ici obligeait l'utilisateur à coller un jeton pour pouvoir… lancer
   * le flux qui sert à ne pas coller de jeton. Un jeton fourni reste accepté
   * (mode « jeton d'accès stocké » de P6b).
   */
  if (authKind !== 'none' && authKind !== 'oauth' && (!secret || secret.trim() === '')) {
    return refus(400, 'secret_requis', 'Ce mode d’authentification exige un secret.');
  }
  if (authKind === 'none' && secret && secret.trim() !== '') {
    // Cohérent avec la contrainte `mcp_servers_secret_coherence` : un secret
    // fourni sans authentification serait stocké dans Vault sans jamais servir.
    return refus(400, 'secret_non_autorise', 'Aucun secret ne doit être fourni en mode « none ».');
  }
  if (secret && secret.length > MAX_SECRET) {
    return refus(400, 'secret_trop_long', 'Le secret est trop volumineux.');
  }

  const oauthClientId = typeof o.oauthClientId === 'string' && o.oauthClientId.trim()
    ? o.oauthClientId.trim() : undefined;
  const authorizationServer = typeof o.authorizationServer === 'string' && o.authorizationServer.trim()
    ? o.authorizationServer.trim() : undefined;

  return {
    ok: true,
    demande: {
      workspaceId,
      nom,
      url,
      authKind,
      ...(secret === undefined ? {} : { secret }),
      ...(oauthClientId === undefined ? {} : { oauthClientId }),
      ...(authorizationServer === undefined ? {} : { authorizationServer }),
    },
  };
}

export interface DemandeCible {
  serverId: string;
}

/** Valide la présence d'un identifiant de serveur. */
export function validerCible(corps: unknown): { ok: true; demande: DemandeCible } | RefusValidation {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return refus(400, 'corps_invalide', 'Le corps doit être un objet JSON.');
  }
  const o = corps as Record<string, unknown>;
  const serverId = o.serverId ?? o.server_id;
  if (typeof serverId !== 'string' || !UUID.test(serverId)) {
    return refus(400, 'server_id_invalide', 'Identifiant de connexion invalide.');
  }
  return { ok: true, demande: { serverId } };
}

/* -------------------------------------------------------------------------- */
/* 3. Permissions                                                               */
/* -------------------------------------------------------------------------- */

export type EtatPermission = 'allowed' | 'denied' | 'pending';

/** Ce que l'utilisateur peut demander pour un outil. `pending` est un état
 * interne (jamais accordé explicitement), on ne l'accepte donc pas en entrée. */
export const ETATS_ACCORDABLES: readonly EtatPermission[] = ['allowed', 'denied'];

/**
 * Valide une demande de permission.
 *
 * Deux garde-fous :
 *
 * 1. **L'outil doit avoir été réellement découvert.** Sinon un utilisateur
 *    pourrait préparer une autorisation pour un outil qu'un serveur distant
 *    ajouterait plus tard, et l'appel passerait sans qu'il ait jamais vu
 *    l'outil. `outilsConnus` vient de la base, pas du corps de la requête.
 * 2. **Aucune écriture.** `ecritureAutorisee` n'est pas un paramètre de cette
 *    fonction : il n'existe aucun chemin, dans cette API, permettant d'accorder
 *    une écriture. La colonne n'existe pas en base et la consigne est explicite.
 */
export function validerPermission(
  corps: unknown,
  outilsConnus: readonly string[],
): { ok: true; demande: { outil: string; etat: EtatPermission } } | RefusValidation {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return refus(400, 'corps_invalide', 'Le corps doit être un objet JSON.');
  }
  const o = corps as Record<string, unknown>;

  const outil = o.outil ?? o.tool;
  if (typeof outil !== 'string' || outil.trim() === '' || outil.length > 200) {
    return refus(400, 'outil_invalide', 'Nom d’outil invalide.');
  }
  const nom = outil.trim();

  if (!outilsConnus.includes(nom)) {
    return refus(404, 'outil_inconnu', `L’outil « ${nom} » n’a pas été découvert sur ce serveur.`);
  }

  const etat = o.etat ?? o.state;
  if (typeof etat !== 'string' || !(ETATS_ACCORDABLES as readonly string[]).includes(etat)) {
    return refus(400, 'etat_invalide', 'L’état doit valoir « allowed » ou « denied ».');
  }

  // Un champ d'écriture fourni par le client est ignoré, pas rejeté — mais il
  // n'a aucun effet. On le signale pour que personne ne croie l'avoir activé.
  return { ok: true, demande: { outil: nom, etat: etat as EtatPermission } };
}

/**
 * Fusionne une permission dans l'objet existant.
 *
 * `tool_permissions` est un JSON libre : on ne fait pas confiance à sa forme.
 * Toute valeur qui n'est pas un objet devient un objet vide, ce qui rend toutes
 * les permissions absentes — donc refusées (fail-closed).
 */
export function appliquerPermission(
  existant: unknown,
  outil: string,
  etat: EtatPermission,
): Record<string, unknown> {
  const base = typeof existant === 'object' && existant !== null && !Array.isArray(existant)
    ? { ...(existant as Record<string, unknown>) }
    : {};
  base[outil] = etat;
  return base;
}

/**
 * Construit l'état initial des permissions après une découverte.
 *
 * **Tout est `pending`, donc rien n'est utilisable.** C'est le cœur de la
 * promesse : découvrir des outils n'accorde aucune permission. L'utilisateur
 * doit en accorder une, outil par outil. Une permission déjà décidée est
 * conservée telle quelle : re-tester un serveur ne doit pas réinitialiser un
 * choix explicite.
 */
export function permissionsInitiales(
  outils: readonly { name: string }[],
  existant: unknown,
): Record<string, unknown> {
  const dejaLa = typeof existant === 'object' && existant !== null && !Array.isArray(existant)
    ? existant as Record<string, unknown>
    : {};
  const sortie: Record<string, unknown> = {};
  for (const outil of outils.slice(0, MAX_OUTILS_GERES)) {
    const nom = outil.name;
    const ancien = dejaLa[nom];
    sortie[nom] = ancien === 'allowed' || ancien === 'denied' ? ancien : 'pending';
  }
  return sortie;
}

/* -------------------------------------------------------------------------- */
/* 3 bis. Exécution d'un outil (demande d'appel)                                */
/* -------------------------------------------------------------------------- */

/** Longueur maximale d'un nom d'outil accepté en entrée. */
export const MAX_NOM_OUTIL = 200;

/** Plafond des arguments d'un appel, en caractères JSON. */
export const MAX_ARGUMENTS_CHARS = 16 * 1024;

export interface DemandeExecution {
  serverId: string;
  outil: string;
  arguments?: Record<string, unknown>;
}

/**
 * Valide une demande d'exécution.
 *
 * Ce validateur ne décide **pas** si l'appel est autorisé : il vérifie
 * seulement que la demande est bien formée. L'autorisation est relue en base par
 * `executerOutilExterne`, qui ne fait aucune confiance au corps de la requête.
 *
 * Ce que ce validateur refuse explicitement, et pourquoi :
 *
 * - un `outil` absent, vide ou trop long : on ne part pas sonder un serveur
 *   distant avec un nom arbitraire ;
 * - des `arguments` qui ne sont pas un objet JSON : `tools/call` attend un
 *   objet, une chaîne ou un tableau serait une tentative de contourner le
 *   contrat ;
 * - des arguments trop volumineux : un appel n'est pas un téléversement ;
 * - toute clé d'autorisation fournie par le client (`permission`,
 *   `ecritureAutorisee`, `confirmationEcriture`, `allowed`, `userId`…). Elles
 *   sont déjà ignorées par la porte ; les refuser ici rend l'intention visible
 *   au lieu de la laisser silencieusement sans effet.
 */
export function validerExecution(corps: unknown): { ok: true; demande: DemandeExecution } | RefusValidation {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return refus(400, 'corps_invalide', 'Le corps doit être un objet JSON.');
  }
  const o = corps as Record<string, unknown>;

  const serverId = o.serverId ?? o.server_id;
  if (typeof serverId !== 'string' || !UUID.test(serverId)) {
    return refus(400, 'server_id_invalide', 'Identifiant de connexion invalide.');
  }

  const outil = o.outil ?? o.tool;
  if (typeof outil !== 'string' || outil.trim() === '' || outil.length > MAX_NOM_OUTIL) {
    return refus(400, 'outil_invalide', 'Nom d’outil absent ou invalide.');
  }

  const clesInterdites = [
    'permission', 'permissions', 'ecritureAutorisee', 'ecriture_autorisee',
    'confirmationEcriture', 'confirmation', 'allowed', 'allowedTools',
    'userId', 'user_id', 'workspaceId', 'workspace_id', 'secret', 'token',
  ];
  const fournie = clesInterdites.find((cle) => Object.prototype.hasOwnProperty.call(o, cle));
  if (fournie) {
    /*
     * Refus explicite, pas ignoré en silence : un client qui envoie
     * `ecritureAutorisee: true` croit obtenir un droit. Lui répondre « champ
     * non accepté » dit la vérité (aucune écriture n'est accordable par cette
     * route) au lieu de laisser croire que le champ a été pris en compte.
     */
    return refus(
      400,
      'champ_non_accepte',
      `Le champ « ${fournie} » n’est pas accepté : les autorisations sont lues en base, jamais du corps de la requête.`,
    );
  }

  let args: Record<string, unknown> | undefined;
  const brut = o.arguments ?? o.args;
  if (brut !== undefined && brut !== null) {
    if (typeof brut !== 'object' || Array.isArray(brut)) {
      return refus(400, 'arguments_invalides', 'Les arguments doivent être un objet JSON.');
    }
    let serialise: string;
    try {
      serialise = JSON.stringify(brut);
    } catch {
      return refus(400, 'arguments_invalides', 'Les arguments ne sont pas sérialisables.');
    }
    if (serialise.length > MAX_ARGUMENTS_CHARS) {
      return refus(413, 'arguments_trop_volumineux', 'Les arguments de l’appel sont trop volumineux.');
    }
    args = brut as Record<string, unknown>;
  }

  return {
    ok: true,
    demande: { serverId, outil: outil.trim(), ...(args ? { arguments: args } : {}) },
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Outils interdits en écriture (aucune écriture, jamais)                     */
/* -------------------------------------------------------------------------- */

/**
 * Réponse d'une route de gestion, sans secret.
 *
 * `ResultatTest` contient déjà des outils assainis et un message ; on n'y
 * ajoute rien. Aucun jeton, aucune valeur Vault, aucun en-tête ne doit
 * traverser cette frontière — c'est la raison d'être de ce type.
 */
export interface ReponseGestion {
  status: number;
  body: Record<string, unknown>;
}

function refus(status: number, code: string, message: string): RefusValidation {
  return { ok: false, status, code, message };
}
