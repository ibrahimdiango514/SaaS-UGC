/**
 * Connexions MCP sortantes — cycle de vie d'un serveur externe.
 *
 * Ce module est la couche *métier* posée au-dessus du transport
 * (`client.ts` : JSON-RPC sur Streamable HTTP via `safePost`) et de la couche
 * SSRF (`safe-egress.ts` / `pinned-fetch.ts`). Il ne réimplémente ni le
 * transport, ni la validation d'URL : il les appelle.
 *
 * ## Ce qu'il garantit
 *
 * 1. **Aucune confiance dans le serveur distant.** Ni son nom, ni sa
 *    description, ni un éventuel `readOnlyHint` ne décident d'un droit. La
 *    classification locale (`classerOutil`, pessimiste) fait foi, et une
 *    permission accordée par l'utilisateur doit EXISTER pour que l'outil soit
 *    appelable.
 * 2. **Refus côté serveur SORAHNEX, avant tout appel réseau.** Les trois refus de
 *    `appelerOutil` (non autorisé / écriture non confirmée / arguments
 *    invalides) s'appliquent avant `safePost`.
 * 3. **Aucun secret en clair dans un résultat.** Ce module reçoit un
 *    fournisseur d'en-têtes, il ne reçoit jamais le secret lui-même : il ne
 *    peut donc ni le journaliser, ni le retourner.
 * 4. **Réponses bornées.** `TAILLE_MAX_REPONSE` s'applique au transport ; ici on
 *    borne en plus la taille des outils conservés (`MAX_OUTILS`, `MAX_SCHEMA`).
 *
 * ## Ce qu'il ne fait pas
 *
 * - Il ne décide pas *quel* mécanisme d'authentification utiliser : l'appelant
 *   le lui dit (`auth.kind`). Aucun repli automatique d'un mode à l'autre.
 * - Il ne suit pas de redirection (`safePost` refuse tout 3xx sur un POST).
 * - Il n'active aucune écriture : `ecritureAutorisee` est toujours fourni par
 *   l'appelant, et vaut `false` sauf confirmation explicite.
 */

import {
  appelerOutil,
  classerOutil,
  creerContexte,
  initialiser,
  listerOutils,
  oublierSession,
  type ContexteClient,
  type ErreurMcp,
  type OutilDecouvert,
  type ResultatMcp,
} from './client.ts';
import type { EgressDeps } from '../store-import/safe-egress.ts';

/** Nombre maximal d'outils conservés pour une connexion. */
export const MAX_OUTILS = 500;

/** Taille maximale d'un `inputSchema` conservé, en caractères JSON. */
export const MAX_SCHEMA_CHARS = 20_000;

/** Profondeur maximale d'une valeur conservée depuis le serveur distant. */
const PROFONDEUR_MAX = 6;

/**
 * Mécanismes d'authentification réellement supportés.
 *
 * Volontairement séparés : un `bearer` n'est pas un `api_key`, et un serveur qui
 * n'annonce rien n'obtient pas `none` par défaut — c'est à l'appelant de
 * choisir explicitement.
 */
export type TypeAuthentification = 'none' | 'bearer' | 'api_key' | 'oauth';

export interface Authentification {
  kind: TypeAuthentification;
  /**
   * Fournisseur d'en-têtes. Appelé à CHAQUE requête (pas une fois au début) :
   * un jeton OAuth peut expirer entre deux appels, et un en-tête figé
   * enverrait un jeton périmé sans le dire.
   *
   * Il ne retourne que des en-têtes d'authentification ; le transport ajoute
   * les siens et refuse tout le reste.
   */
  fournirEntetes?: () => Promise<Record<string, string>> | Record<string, string>;
}

/** Étiquettes d'état exposables à l'interface. */
export type EtatConnexion =
  | 'connected'
  | 'auth_required'
  | 'error'
  | 'revoked'
  | 'unknown';

export interface ServeurExterne {
  /** URL HTTPS du serveur, telle que saisie par l'utilisateur. */
  url: string;
  auth: Authentification;
}

export interface ResultatTest {
  etat: EtatConnexion;
  /** Message affichable. Ne contient jamais d'en-tête ni de jeton. */
  message: string;
  protocole?: string;
  serverInfo?: { name: string; version: string };
  capacites?: Record<string, unknown>;
  outils?: OutilDecouvert[];
  /** Codes d'erreur du transport, pour un diagnostic sans fuite. */
  codes?: string[];
}

/* -------------------------------------------------------------------------- */
/* 1. Assainissement des valeurs venues du serveur distant                     */
/* -------------------------------------------------------------------------- */

/**
 * Réduit une valeur JSON arbitraire à une forme sûre et bornée.
 *
 * Un serveur MCP hostile peut renvoyer un `inputSchema` de plusieurs mégaoctets,
 * une profondeur de 10 000 niveaux, ou des clés `__proto__`. On ne stocke donc
 * que des types simples, bornés en profondeur, en taille, et en nombre de clés.
 */
export function assainir(valeur: unknown, profondeur = 0): unknown {
  if (profondeur > PROFONDEUR_MAX) return null;
  if (valeur === null) return null;
  const type = typeof valeur;
  if (type === 'string') return (valeur as string).slice(0, 2_000);
  if (type === 'number') return Number.isFinite(valeur) ? valeur : null;
  if (type === 'boolean') return valeur;

  if (Array.isArray(valeur)) {
    return valeur.slice(0, 100).map((element) => assainir(element, profondeur + 1));
  }

  if (type === 'object') {
    const source = valeur as Record<string, unknown>;
    const sortie: Record<string, unknown> = {};
    let cles = 0;
    for (const [cle, contenu] of Object.entries(source)) {
      // `__proto__` et `constructor` ne sont pas des données : les recopier
      // dans un objet manipulé ensuite ouvrirait une pollution de prototype.
      if (cle === '__proto__' || cle === 'constructor' || cle === 'prototype') continue;
      if (cles >= 100) break;
      sortie[cle.slice(0, 200)] = assainir(contenu, profondeur + 1);
      cles += 1;
    }
    return sortie;
  }

  // `undefined`, `function`, `symbol`, `bigint` : rien de stockable.
  return null;
}

/**
 * Normalise un outil découvert pour la persistance.
 *
 * Le schéma est ré-assaini puis re-sérialisé : si la forme nettoyée dépasse
 * `MAX_SCHEMA_CHARS`, l'outil est conservé mais sans schéma exploitable —
 * mieux vaut un outil affiché sans formulaire qu'un refus global.
 */
export function normaliserPourStockage(outil: OutilDecouvert): {
  name: string;
  title: string | null;
  description: string;
  classification: 'read' | 'write';
  classification_reason: string;
  requires_confirmation: boolean;
  input_schema: Record<string, unknown>;
} {
  const schema = assainir(outil.inputSchema) as Record<string, unknown> | null;
  const schemaSur = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {};
  const serialise = JSON.stringify(schemaSur);
  return {
    name: outil.name.slice(0, 200),
    title: outil.title ? outil.title.slice(0, 200) : null,
    description: outil.description.slice(0, 2_000),
    // La classification est LOCALE : on ne recopie jamais un `readOnlyHint`.
    classification: outil.exigeConfirmation ? 'write' : 'read',
    classification_reason: outil.classement.slice(0, 300),
    requires_confirmation: outil.exigeConfirmation,
    input_schema: serialise.length <= MAX_SCHEMA_CHARS ? schemaSur : {},
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Test de connexion                                                        */
/* -------------------------------------------------------------------------- */

function messageEchec(erreur: ErreurMcp): { etat: EtatConnexion; message: string } {
  switch (erreur.code) {
    case 'authentification':
      return {
        etat: 'auth_required',
        message: 'Le serveur MCP exige une authentification valide (identifiants refusés).',
      };
    case 'timeout':
      return { etat: 'error', message: 'Le serveur MCP n’a pas répondu dans le délai imparti.' };
    case 'reseau':
      return { etat: 'error', message: 'Le serveur MCP est injoignable.' };
    case 'serveur_invalide':
      return { etat: 'error', message: 'L’URL ne permet pas d’atteindre un serveur MCP.' };
    case 'trop_gros':
      return { etat: 'error', message: 'Le serveur MCP renvoie une réponse trop volumineuse.' };
    case 'protocole':
    case 'json_rpc':
      return { etat: 'error', message: 'La réponse du serveur n’est pas du protocole MCP attendu.' };
    default:
      return { etat: 'error', message: 'La connexion au serveur MCP a échoué.' };
  }
}

/**
 * Ouvre une session, négocie le protocole, découvre les outils.
 *
 * Une seule tentative de `initialize` : réessayer sur un échec
 * d'authentification ne ferait que multiplier les requêtes refusées. En
 * revanche, un échec *réseau* est retenté par l'appelant s'il le souhaite
 * (le transport ne réessaie pas de lui-même).
 */
export async function testerConnexion(
  serveur: ServeurExterne,
  deps: EgressDeps,
  options: { delaiMs?: number } = {},
): Promise<ResultatTest> {
  const contexte = creerContexte(
    {
      url: serveur.url,
      fournirEntetes: serveur.auth.fournirEntetes,
      delaiMs: options.delaiMs,
    },
    deps,
  );

  const init = await initialiser(contexte);
  if (!init.ok) {
    const { etat, message } = messageEchec(init.error);
    return { etat, message, codes: [init.error.code] };
  }

  const outils = await listerOutils(contexte, { maxPages: 10 });
  if (!outils.ok) {
    // Le serveur a répondu à `initialize` mais refuse `tools/list` : la
    // connexion existe, la découverte non. On ne prétend pas qu'elle est saine.
    const { etat, message } = messageEchec(outils.error);
    return {
      etat,
      message: `Session ouverte, mais la liste des outils est inaccessible. ${message}`,
      protocole: init.value.protocole,
      serverInfo: init.value.serverInfo,
      capacites: init.value.capacites,
      codes: [outils.error.code],
    };
  }

  return {
    etat: 'connected',
    message: `Connecté : ${outils.value.length} outil(s) découvert(s).`,
    protocole: init.value.protocole,
    serverInfo: init.value.serverInfo,
    capacites: init.value.capacites,
    outils: outils.value.slice(0, MAX_OUTILS),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Exécution d'un outil autorisé                                            */
/* -------------------------------------------------------------------------- */

/** Ce que SORAHNEX sait d'un outil, indépendamment de ce qu'en dit le serveur. */
export interface PermissionStockee {
  /** `allowed` seulement si l'utilisateur l'a explicitement accordé. */
  etat: 'allowed' | 'denied' | 'pending';
  /** Confirmation explicite pour une écriture, donnée pour CET appel. */
  ecritureAutorisee?: boolean;
}

/** Décision prise AVANT tout appel réseau. */
export type Decision = { permis: true } | { permis: false; motif: string; code: string };

/**
 * Décide si un appel peut partir. Fonction pure, testable sans réseau.
 *
 * Ordre des contrôles (le premier refus l'emporte) :
 *
 * 1. la connexion n'est pas révoquée ;
 * 2. l'outil existe dans la découverte ;
 * 3. une permission explicite existe et vaut `allowed` ;
 * 4. l'outil est classé lecture, ou l'écriture a été confirmée pour cet appel.
 *
 * Le point 4 ne consulte jamais le serveur : `classerOutil` est local.
 */
export function deciderAppel(entree: {
  revoque: boolean;
  outil: string;
  description?: string;
  outilsConnus: readonly { name: string }[];
  permission?: PermissionStockee;
}): Decision {
  if (entree.revoque) {
    return { permis: false, motif: 'Cette connexion est révoquée.', code: 'revoked' };
  }
  if (!entree.outilsConnus.some((o) => o.name === entree.outil)) {
    return {
      permis: false,
      motif: `L’outil « ${entree.outil} » n’a pas été découvert sur ce serveur.`,
      code: 'outil_inconnu',
    };
  }
  if (!entree.permission || entree.permission.etat !== 'allowed') {
    return {
      permis: false,
      motif: `L’outil « ${entree.outil} » n’est pas autorisé pour cette connexion.`,
      code: 'outil_non_autorise',
    };
  }
  const classement = classerOutil(entree.outil, entree.description ?? '');
  if (!classement.lecture && entree.permission.ecritureAutorisee !== true) {
    /*
     * Un seul refus ici, et il dit la vérité.
     *
     * Cette fonction ne reçoit PAS la confirmation ponctuelle de l'appel : elle
     * ne peut donc pas savoir si l'utilisateur a confirmé. Annoncer
     * « confirmation requise » y serait structurellement faux — et l'était :
     * la migration P2 ne porte aucune colonne d'autorisation d'écriture, donc
     * aucune confirmation ne peut jamais débloquer l'appel. L'utilisateur
     * chercherait un bouton qui n'existe pas.
     *
     * Le cas « autorisation en base mais confirmation absente » est traité plus
     * loin, dans `execution.ts`, qui EST le seul endroit où la confirmation de
     * l'appel est connue : il renvoie alors `ecriture_non_confirmee`.
     */
    return {
      permis: false,
      motif: `L’outil « ${entree.outil} » peut modifier des données (${classement.raison}). `
        + 'Les écritures ne sont pas activées sur cette connexion : lecture seule.',
      code: 'ecriture_desactivee',
    };
  }
  return { permis: true };
}

/**
 * Appelle un outil après décision locale.
 *
 * La session est rouverte si elle a été perdue (`initialize` puis rappel) : un
 * serveur peut fermer une session entre deux appels, et renvoyer une erreur à
 * l'utilisateur pour cela serait trompeur. Une seule reprise, jamais en boucle.
 */
export async function executerOutil(
  contexte: ContexteClient,
  demande: {
    outil: string;
    arguments?: Record<string, unknown>;
    description?: string;
    permission: PermissionStockee;
    outilsConnus: readonly { name: string }[];
    revoque: boolean;
  },
): Promise<ResultatMcp<{ contenu: unknown; isError: boolean }>> {
  const decision = deciderAppel({
    revoque: demande.revoque,
    outil: demande.outil,
    description: demande.description,
    outilsConnus: demande.outilsConnus,
    permission: demande.permission,
  });
  if (!decision.permis) {
    return { ok: false, error: { code: 'outil_non_autorise', message: decision.motif } };
  }

  const autorisations = [{
    outil: demande.outil,
    ecritureAutorisee: demande.permission.ecritureAutorisee === true,
  }];

  const premier = await appelerOutil(contexte, {
    nom: demande.outil,
    arguments: demande.arguments,
    autorisations,
    description: demande.description,
  });
  if (premier.ok) return premier;

  // Session expirée côté serveur (HTTP 404 sur une session inconnue) ou perdue :
  // on rouvre une fois, puis on rejoue. Aucun autre code n'est rejoué.
  if (premier.error.code === 'http' && premier.error.httpStatus === 404) {
    oublierSession(contexte);
    const reouverture = await initialiser(contexte);
    if (!reouverture.ok) return reouverture;
    return appelerOutil(contexte, {
      nom: demande.outil,
      arguments: demande.arguments,
      autorisations,
      description: demande.description,
    });
  }
  return premier;
}

/* -------------------------------------------------------------------------- */
/* 4. Fermeture                                                                */
/* -------------------------------------------------------------------------- */

/** Oublie la session locale. Appelé à la révocation. */
export function fermerConnexion(contexte: ContexteClient): void {
  oublierSession(contexte);
}

/**
 * Construit les en-têtes d'authentification pour un mécanisme donné.
 *
 * `bearer` et `oauth` produisent tous deux `Authorization: Bearer`, ce qui est
 * correct : la différence est *qui* produit le jeton (un jeton statique saisi
 * par l'utilisateur, ou un jeton OAuth rafraîchi par le socle). `api_key`
 * utilise `X-Api-Key`, en-tête générique admis par la couche de transport.
 *
 * Aucun en-tête n'est ajouté pour `none` : un serveur public ne doit pas
 * recevoir d'identifiant vide, qui serait interprété comme une tentative
 * d'authentification ratée.
 */
export function entetesAuthentification(
  kind: TypeAuthentification,
  secret: string | null,
): Record<string, string> {
  if (kind === 'none') return {};
  const valeur = (secret ?? '').trim();
  if (!valeur) return {};
  if (kind === 'api_key') return { 'x-api-key': valeur };
  return { authorization: `Bearer ${valeur}` };
}
