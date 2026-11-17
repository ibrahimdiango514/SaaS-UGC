/**
 * VYORA — client MCP sortant (Streamable HTTP).
 *
 * ## Ce que ce module fait, et ce qu'il refuse de faire
 *
 * Il parle à un serveur MCP EXTERNE : initialisation, négociation de protocole,
 * découverte des outils, lecture des schémas, appel d'outil, erreurs et délais.
 * Il ne décide jamais de la sécurité d'une connexion : la sortie réseau passe
 * par `safePost` (épinglage DNS+IP, refus des plages privées, refus de suivre
 * une redirection). Ici, on ne fait que du protocole.
 *
 * ## Aucun outil d'écriture n'est accordé automatiquement
 *
 * `MCP_APPROVAL_REQUIRED_MAX` : un outil est classé « écriture » dès qu'il ne
 * peut pas être raisonnablement décrit comme une lecture. La classification est
 * VOLONTAIREMENT pessimiste — un faux positif coûte une confirmation, un faux
 * négatif coûte une commande passée chez un marchand sans que personne ne l'ait
 * demandé.
 *
 * Le refus des écritures n'est PAS déduit de la coopération du serveur : c'est
 * `appelerOutil` qui vérifie l'autorisation AVANT d'émettre la requête.
 *
 * ## Ne pas supposer un mécanisme d'authentification unique
 *
 * L'authentification est une enveloppe injectée (`fournirEntetes`). Selon le
 * serveur, ce sera OAuth, une clé d'API dans un en-tête maison, un jeton
 * statique… Ce module ne présume rien : il ajoute ce qu'on lui donne, et
 * n'ajoute JAMAIS d'en-tête d'authentification de sa propre initiative.
 */
import type { EgressDeps, EgressResult } from '../store-import/safe-egress.ts';
import { safePost } from '../store-import/safe-egress.ts';

/** Version de protocole demandée par VYORA. */
export const PROTOCOLE_CLIENT = '2025-06-18';

/** Versions que ce client sait réellement parler, la plus récente d'abord. */
export const PROTOCOLES_SUPPORTES = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Délai par défaut d'un appel HTTP au serveur distant. */
export const DELAI_APPEL_MS = 20_000;

/** Plafond de lecture d'une réponse : un catalogue d'outils reste petit. */
export const TAILLE_MAX_REPONSE = 512 * 1024;

/** Identifiant de session renvoyé par certains serveurs (`Mcp-Session-Id`). */
export interface EtatSession {
  sessionId: string | null;
  protocole: string;
  serverInfo: { name: string; version: string };
  capacites: Record<string, unknown>;
  instructions?: string;
}

export interface OutilDecouvert {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `true` si l'appel exige une confirmation explicite de l'utilisateur. */
  exigeConfirmation: boolean;
  /** Raison de la classification, pour l'afficher à l'utilisateur. */
  classement: string;
}

export type CodeErreurMcp =
  | 'reseau'
  | 'timeout'
  | 'http'
  | 'trop_gros'
  | 'protocole'
  | 'json_rpc'
  | 'authentification'
  | 'outil_inconnu'
  | 'outil_non_autorise'
  | 'serveur_invalide';

export interface ErreurMcp {
  code: CodeErreurMcp;
  message: string;
  /** Statut HTTP, quand l'échec vient d'une réponse. */
  httpStatus?: number;
  /** Code JSON-RPC, quand l'échec vient du serveur. */
  rpcCode?: number;
}

export type ResultatMcp<T> = { ok: true; value: T } | { ok: false; error: ErreurMcp };

function echec(code: CodeErreurMcp, message: string, extra: Partial<ErreurMcp> = {}): { ok: false; error: ErreurMcp } {
  return { ok: false, error: { code, message, ...extra } };
}

/* -------------------------------------------------------------------------- */
/* 1. Classification des outils : lecture ou écriture                          */
/* -------------------------------------------------------------------------- */

/**
 * Verbes qui n'écrivent rien. Volontairement courts : tout le reste est classé
 * « écriture ».
 */
const VERBES_LECTURE = [
  'get', 'list', 'search', 'find', 'read', 'fetch', 'query', 'describe',
  'show', 'view', 'retrieve', 'count', 'stat', 'info', 'lookup', 'browse',
  'preview', 'export', 'download', 'check', 'status', 'validate', 'resolve',
  'catalog', 'inspect', 'summarize', 'report', 'analyze',
];

/**
 * Verbes qui écrivent, y compris ceux qu'on oublie souvent.
 *
 * `and` / `then` n'écrivent rien : c'est leur présence qui signale un nom
 * COMPOSÉ. `get_and_delete_order` commence par un verbe de lecture mais en
 * enchaîne un second sur le même objet : la composition l'emporte sur le
 * premier mot, sinon la lecture servirait de couverture à la suppression.
 */
const VERBES_ECRITURE = [
  'create', 'update', 'delete', 'remove', 'insert', 'upsert', 'patch', 'put',
  'set', 'add', 'clear', 'reset', 'cancel', 'refund', 'charge', 'pay', 'send',
  'post', 'publish', 'submit', 'approve', 'reject', 'archive', 'restore',
  'move', 'rename', 'assign', 'grant', 'revoke', 'rotate', 'trigger', 'run',
  'execute', 'invoke', 'apply', 'replace', 'merge', 'clone', 'transfer',
  'upload', 'notify', 'schedule', 'confirm', 'void', 'close', 'purge',
];

/**
 * Classe un outil à partir de son NOM et de sa description.
 *
 * Deux garde-fous, dans cet ordre :
 *
 * 1. un verbe d'écriture l'emporte immédiatement, même mêlé à un verbe de
 *    lecture (`get_and_delete_order` est une écriture) ;
 * 2. à défaut, l'outil n'est une lecture que si son nom commence par un verbe de
 *    lecture CONNU — pas s'il en contient un (`delete_all_get_things`).
 *
 * Un nom qui ne dit rien (`do_thing`) est classé écriture : l'absence
 * d'information n'est pas une preuve d'innocuité.
 */
export function classerOutil(nom: string, description = ''): { lecture: boolean; raison: string } {
  const nomNormalise = nom.toLowerCase();
  const mots = nomNormalise.split(/[^a-z0-9]+/).filter(Boolean);
  const texte = `${nomNormalise} ${description.toLowerCase()}`;

  /*
   * Le PREMIER mot est testé à part : `set_inventory` a pour premier mot
   * `set`, qui n'apparaît pas dans une recherche par segment du nom complet
   * (`set_inventory` est un seul segment si on ne découpe pas). On regarde les
   * deux pour ne rien manquer.
   */
  const segmentsCamel = nom
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tousLesMots = [...new Set([...mots, ...segmentsCamel])];

  const verbeEcriture = VERBES_ECRITURE.find((v) => tousLesMots.includes(v));
  if (verbeEcriture) {
    return { lecture: false, raison: `le nom contient « ${verbeEcriture} »` };
  }
  // Un verbe d'écriture dans la seule description est un signal plus faible,
  // mais suffisant pour exiger une confirmation : on ne peut pas prouver que
  // l'outil est en lecture.
  const dansDescription = VERBES_ECRITURE.find((v) => new RegExp(`\\b${v}\\b`).test(description.toLowerCase()));
  if (dansDescription) {
    return { lecture: false, raison: `la description contient « ${dansDescription} »` };
  }

  const premierMot = tousLesMots[0] ?? '';
  if (VERBES_LECTURE.includes(premierMot)) {
    return { lecture: true, raison: `le nom commence par « ${premierMot} »` };
  }
  // `readOnlyHint` n'est PAS consulté : c'est une affirmation du serveur.
  // Lui faire confiance reviendrait à laisser un serveur décider seul s'il a le
  // droit d'agir sur nos données.
  const sembleLecture = VERBES_LECTURE.some((v) => new RegExp(`\\b${v}\\b`).test(texte));
  return {
    lecture: false,
    raison: sembleLecture
      ? 'verbe de lecture ambigu : confirmation demandée par prudence'
      : 'nom non reconnu : traité comme une écriture',
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Appels HTTP JSON-RPC                                                     */
/* -------------------------------------------------------------------------- */

export interface OptionsClient {
  /** URL du serveur MCP, déjà validée et https. */
  url: string;
  /**
   * En-têtes d'authentification à ajouter, calculés à chaque requête.
   *
   * Injecté parce que les mécanismes diffèrent : OAuth (`Authorization: Bearer`),
   * clé d'API (`X-Api-Key`), jeton statique, en-tête maison. Ce module n'en
   * ajoute aucun de lui-même.
   */
  fournirEntetes?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Délai par appel, en millisecondes. */
  delaiMs?: number;
}

export interface RequeteRpc {
  methode: string;
  params?: Record<string, unknown>;
  /** Identifiant de corrélation. `null` pour une notification. */
  id?: number | null;
}

interface ContexteClient {
  options: OptionsClient;
  deps: EgressDeps;
  session: EtatSession | null;
  prochainId: number;
}

/** Construit un contexte de session vierge. */
export function creerContexte(options: OptionsClient, deps: EgressDeps): ContexteClient {
  return { options, deps, session: null, prochainId: 1 };
}

/**
 * Envoie UN message JSON-RPC et renvoie la réponse brute décodée.
 *
 * Les erreurs HTTP sont traduites en fonction du statut, pas en fonction du
 * corps : c'est le statut qui porte le sens (401 = authentification, 429 =
 * quota, 5xx = serveur). Lire le corps pour deviner serait se fier à une source
 * que l'on ne contrôle pas.
 */
async function envoyer(
  contexte: ContexteClient,
  message: RequeteRpc,
): Promise<ResultatMcp<{ rpc: Record<string, unknown>; entetes: Record<string, string> }>> {
  const entetesAuth = contexte.options.fournirEntetes
    ? await contexte.options.fournirEntetes()
    : {};

  /*
   * L'ordre compte : `authorization` peut venir du fournisseur, mais jamais du
   * serveur distant. Aucun en-tête renvoyé par une réponse n'est réémis ici.
   */
  const entetes: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': contexte.session?.protocole ?? PROTOCOLE_CLIENT,
    ...entetesAuth,
  };
  if (contexte.session?.sessionId) entetes['mcp-session-id'] = contexte.session.sessionId;

  const corps = JSON.stringify({
    jsonrpc: '2.0',
    id: message.id ?? null,
    method: message.methode,
    ...(message.params === undefined ? {} : { params: message.params }),
  });

  const reponse: EgressResult<{ body: string; headers: Record<string, string>; status: number }> =
    await safePost(contexte.options.url, {
      accept: 'application/json, text/event-stream',
      maxBytes: TAILLE_MAX_REPONSE,
      headers: entetes,
      body: corps,
    }, { ...contexte.deps, timeoutMs: contexte.options.delaiMs ?? contexte.deps.timeoutMs });

  if (!reponse.ok) {
    const status = reponse.httpStatus;
    if (status === 401 || status === 403) {
      return echec('authentification', status === 401
        ? 'Le serveur MCP refuse les identifiants fournis (401).'
        : 'Le serveur MCP refuse cet accès (403) : portées ou droits insuffisants.', { httpStatus: status });
    }
    /*
     * 3xx : `safePost` ne les suit pas (le corps de l'appel, donc parfois une
     * écriture, partirait vers une destination choisie par le serveur distant).
     * On ne les présente pas comme une erreur « http » banale : c'est un refus
     * de sécurité, et le message doit le dire.
     */
    if (status !== undefined && status >= 300 && status < 400) {
      return echec(
        'protocole',
        `Le serveur MCP a redirigé la requête (${status}). VYORA ne suit pas une redirection `
        + 'sur un appel MCP : vérifiez l’URL exacte du serveur.',
        { httpStatus: status },
      );
    }
    if (status !== undefined) {
      return echec('http', `Le serveur MCP a répondu ${status}.`, { httpStatus: status });
    }
    const code = reponse.error.code === 'timeout'
      ? 'timeout'
      : reponse.error.code === 'too_large'
        ? 'trop_gros'
        : reponse.error.code === 'blocked_url' || reponse.error.code === 'dns_failed'
          || reponse.error.code === 'dns_empty' || reponse.error.code === 'connect_failed'
          || reponse.error.code === 'tls_failed'
          ? 'reseau'
          : 'protocole';
    return echec(code, reponse.error.message);
  }

  const { body, headers } = reponse.value;
  const sessionId = headers['mcp-session-id'] ?? null;
  if (sessionId && contexte.session) contexte.session.sessionId = sessionId;

  /*
   * `text/event-stream` : un serveur peut répondre en SSE même pour un POST.
   * On lit alors la DERNIÈRE trame `data:` qui contient un `result` ou une
   * `error` — c'est la réponse, les autres sont des notifications. On ne garde
   * jamais la connexion ouverte : une session persistante consommerait une
   * instance Edge sans rien apporter à un appel de catalogue.
   */
  const texte = /text\/event-stream/i.test(headers['content-type'] ?? '')
    ? extraireDerniereTrame(body)
    : body;

  let rpc: unknown;
  try {
    rpc = JSON.parse(texte);
  } catch {
    return echec('protocole', 'La réponse du serveur MCP n’est pas du JSON.');
  }
  if (typeof rpc !== 'object' || rpc === null || Array.isArray(rpc)) {
    return echec('protocole', 'La réponse du serveur MCP n’est pas un objet JSON-RPC.');
  }
  return { ok: true, value: { rpc: rpc as Record<string, unknown>, entetes: headers } };
}

/** Extrait la dernière charge utile d'un flux SSE. Exporté pour les tests. */
export function extraireDerniereTrame(corps: string): string {
  const lignes = corps.split(/\r?\n/);
  let derniere = '';
  for (const ligne of lignes) {
    if (!ligne.startsWith('data:')) continue;
    const donnee = ligne.slice(5).trim();
    if (!donnee || donnee === '[DONE]') continue;
    try {
      const objet = JSON.parse(donnee) as Record<string, unknown>;
      if ('result' in objet || 'error' in objet) derniere = donnee;
    } catch {
      // Une trame illisible n'est pas la réponse : on continue.
    }
  }
  return derniere || corps;
}

/** Traduit une erreur JSON-RPC en `ErreurMcp`. */
function erreurRpc(rpc: Record<string, unknown>): { ok: false; error: ErreurMcp } {
  const brut = rpc.error as { code?: unknown; message?: unknown } | undefined;
  const code = typeof brut?.code === 'number' ? brut.code : undefined;
  const message = typeof brut?.message === 'string' ? brut.message : 'Erreur JSON-RPC sans message.';
  return echec('json_rpc', message.slice(0, 300), { rpcCode: code });
}

/* -------------------------------------------------------------------------- */
/* 3. Cycle de vie : initialisation et négociation                             */
/* -------------------------------------------------------------------------- */

/**
 * Initialise la session : `initialize`, puis `notifications/initialized`.
 *
 * La négociation est réelle : on demande la version la plus récente que l'on
 * sait parler, et on ACCEPTE la réponse du serveur si elle est dans notre
 * liste. Un serveur qui annonce une version inconnue est refusé — parler une
 * version qu'on n'implémente pas produirait des erreurs silencieuses plus tard.
 */
export async function initialiser(
  contexte: ContexteClient,
  infoClient: { name: string; version: string } = { name: 'vyora', version: '1.0.0' },
): Promise<ResultatMcp<EtatSession>> {
  const reponse = await envoyer(contexte, {
    methode: 'initialize',
    id: contexte.prochainId++,
    params: {
      protocolVersion: PROTOCOLE_CLIENT,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: infoClient,
    },
  });
  if (!reponse.ok) return reponse;
  if (reponse.value.rpc.error) return erreurRpc(reponse.value.rpc);

  const resultat = reponse.value.rpc.result as Record<string, unknown> | undefined;
  if (!resultat || typeof resultat !== 'object') {
    return echec('serveur_invalide', 'Le serveur MCP n’a pas renvoyé de résultat d’initialisation.');
  }

  const version = typeof resultat.protocolVersion === 'string' ? resultat.protocolVersion : '';
  if (!(PROTOCOLES_SUPPORTES as readonly string[]).includes(version)) {
    return echec(
      'protocole',
      `Version de protocole non supportée : « ${version.slice(0, 20)} ». `
      + `VYORA sait parler ${PROTOCOLES_SUPPORTES.join(', ')}.`,
    );
  }

  const serveur = (resultat.serverInfo ?? {}) as { name?: unknown; version?: unknown };
  contexte.session = {
    sessionId: reponse.value.entetes['mcp-session-id'] ?? null,
    protocole: version,
    serverInfo: {
      name: typeof serveur.name === 'string' ? serveur.name.slice(0, 120) : 'serveur-mcp',
      version: typeof serveur.version === 'string' ? serveur.version.slice(0, 60) : '',
    },
    capacites: (resultat.capabilities ?? {}) as Record<string, unknown>,
    instructions: typeof resultat.instructions === 'string' ? resultat.instructions.slice(0, 2000) : undefined,
  };

  /*
   * Notification d'initialisation : sans identifiant, donc sans réponse
   * attendue. Un serveur strict refuse tout `tools/list` avant de l'avoir
   * reçue. Son échec n'est pas fatal (certains serveurs répondent 202 ou 204).
   */
  await envoyer(contexte, { methode: 'notifications/initialized', id: null });

  return { ok: true, value: contexte.session };
}

/* -------------------------------------------------------------------------- */
/* 4. Découverte des outils                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `tools/list`, avec pagination bornée.
 *
 * Le curseur vient du serveur : on le renvoie tel quel, mais on borne le nombre
 * de pages. Un serveur hostile peut renvoyer un curseur éternel pour épuiser le
 * temps d'exécution de la fonction.
 */
export async function listerOutils(
  contexte: ContexteClient,
  options: { maxPages?: number } = {},
): Promise<ResultatMcp<OutilDecouvert[]>> {
  const maxPages = options.maxPages ?? 10;
  const outils: OutilDecouvert[] = [];
  const curseursVus = new Set<string>();
  let curseur: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const reponse = await envoyer(contexte, {
      methode: 'tools/list',
      id: contexte.prochainId++,
      params: curseur ? { cursor: curseur } : {},
    });
    if (!reponse.ok) return reponse;
    if (reponse.value.rpc.error) return erreurRpc(reponse.value.rpc);

    const resultat = reponse.value.rpc.result as { tools?: unknown; nextCursor?: unknown } | undefined;
    const liste = Array.isArray(resultat?.tools) ? resultat.tools : [];

    for (const brut of liste) {
      const outil = normaliserOutil(brut);
      if (outil) outils.push(outil);
    }

    const suivant = typeof resultat?.nextCursor === 'string' ? resultat.nextCursor : null;
    if (!suivant || liste.length === 0) break;
    /*
     * Un curseur qui ne progresse pas ferait tourner la boucle à vide. Le
     * garde-fou porte sur l'ENSEMBLE des curseurs déjà vus, pas seulement sur
     * le précédent : un serveur qui alterne `a → b → a` boucle indéfiniment
     * avec un contrôle limité au dernier.
     */
    if (curseursVus.has(suivant)) break;
    curseursVus.add(suivant);
    curseur = suivant;
  }

  return { ok: true, value: outils };
}

/**
 * Normalise un outil annoncé.
 *
 * Un outil sans nom exploitable est IGNORÉ : on ne fabrique pas de nom de
 * remplacement, sinon l'utilisateur verrait un outil qu'il ne peut pas appeler.
 * `inputSchema` absent devient `{}` — un schéma vide veut dire « aucun argument
 * documenté », pas « appelle-le au hasard ».
 */
export function normaliserOutil(brut: unknown): OutilDecouvert | null {
  if (typeof brut !== 'object' || brut === null) return null;
  const objet = brut as Record<string, unknown>;
  const nom = typeof objet.name === 'string' ? objet.name.trim() : '';
  if (!nom || nom.length > 200) return null;
  // Un nom d'outil est utilisé comme clé : on refuse les caractères qui
  // permettraient de le confondre avec un autre outil dans l'interface.
  if (!/^[A-Za-z0-9._\-/]+$/.test(nom)) return null;

  const description = typeof objet.description === 'string' ? objet.description.slice(0, 4000) : '';
  const classement = classerOutil(nom, description);
  const schema = typeof objet.inputSchema === 'object' && objet.inputSchema !== null
    ? (objet.inputSchema as Record<string, unknown>)
    : {};

  return {
    name: nom,
    title: typeof objet.title === 'string' ? objet.title.slice(0, 200) : undefined,
    description,
    inputSchema: schema,
    exigeConfirmation: !classement.lecture,
    classement: classement.raison,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Appel d'outil                                                            */
/* -------------------------------------------------------------------------- */

export interface AutorisationOutil {
  /** Nom de l'outil autorisé. */
  outil: string;
  /** Vrai si l'utilisateur a explicitement autorisé cette écriture-ci. */
  ecritureAutorisee?: boolean;
}

/**
 * Appelle un outil.
 *
 * Trois refus, tous AVANT l'envoi :
 *
 * 1. l'outil n'est pas dans la liste des autorisations accordées ;
 * 2. l'outil est classé écriture et `ecritureAutorisee` n'est pas vrai ;
 * 3. les arguments ne sont pas un objet simple.
 *
 * Le point 2 est le cœur de la consigne « aucun accès automatique aux outils
 * d'écriture » : il ne dépend ni du serveur, ni de la portée du jeton, ni d'un
 * `readOnlyHint`. Un appel d'écriture sans confirmation explicite n'atteint
 * jamais le réseau.
 */
export async function appelerOutil(
  contexte: ContexteClient,
  demande: {
    nom: string;
    arguments?: Record<string, unknown>;
    autorisations: AutorisationOutil[];
    description?: string;
  },
): Promise<ResultatMcp<{ contenu: unknown; isError: boolean }>> {
  const autorisation = demande.autorisations.find((a) => a.outil === demande.nom);
  if (!autorisation) {
    return echec('outil_non_autorise', `L’outil « ${demande.nom} » n’est pas autorisé pour cette connexion.`);
  }

  const classement = classerOutil(demande.nom, demande.description ?? '');
  if (!classement.lecture && autorisation.ecritureAutorisee !== true) {
    return echec(
      'outil_non_autorise',
      `L’outil « ${demande.nom} » peut modifier des données (${classement.raison}). `
      + 'Une confirmation explicite est requise avant chaque écriture.',
    );
  }

  const args = demande.arguments ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return echec('protocole', 'Les arguments d’un outil doivent être un objet JSON.');
  }

  const reponse = await envoyer(contexte, {
    methode: 'tools/call',
    id: contexte.prochainId++,
    params: { name: demande.nom, arguments: args },
  });
  if (!reponse.ok) return reponse;
  if (reponse.value.rpc.error) return erreurRpc(reponse.value.rpc);

  const resultat = reponse.value.rpc.result as { content?: unknown; isError?: unknown } | undefined;
  return {
    ok: true,
    value: {
      contenu: resultat?.content ?? null,
      // `isError` est une erreur d'OUTIL (le serveur a répondu), pas une erreur
      // de transport : l'appelant doit pouvoir la montrer à l'utilisateur.
      isError: resultat?.isError === true,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 6. Déconnexion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ferme la session côté serveur quand il le permet, puis oublie son identifiant.
 *
 * `DELETE` n'est pas envoyé par ce client (notre transport épinglé est
 * `GET`/`POST`) : on préfère ne rien envoyer plutôt que d'implémenter un verbe
 * qui contournerait la couche de sécurité. La révocation réelle des
 * identifiants se fait de notre côté, dans le coffre — c'est elle qui compte.
 */
export function oublierSession(contexte: ContexteClient): void {
  contexte.session = null;
}
