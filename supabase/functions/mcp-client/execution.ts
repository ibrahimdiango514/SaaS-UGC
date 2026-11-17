/**
 * VYORA — porte d'exécution des outils MCP externes (P5).
 *
 * ## Le principe : un seul chemin, sans exception
 *
 * `executerOutilExterne` est le SEUL point d'entrée autorisé pour déclencher un
 * appel d'outil vers un serveur MCP distant. Il ne fait pas confiance à son
 * appelant : il **relit en base** la connexion, l'état de révocation, la liste
 * des outils réellement découverts et les permissions réellement accordées.
 * Une valeur fournie par le navigateur (permission, état, liste d'outils) n'est
 * qu'un indice ignoré : si le navigateur prétend qu'une écriture est autorisée
 * alors que la base dit le contraire, la base gagne.
 *
 * ## Pourquoi relire la base plutôt que faire confiance au client
 *
 * Un appel direct à l'Edge Function contourne l'interface. Si la décision
 * d'autorisation venait du corps de la requête — « permission: allowed » —,
 * n'importe qui pourrait appeler n'importe quel outil, y compris destructeur.
 * C'est pour cette raison que `deciderAppel` (module `external.ts`) reçoit ici
 * des valeurs issues de PostgreSQL, jamais du JSON entrant.
 *
 * ## Aucune écriture par défaut
 *
 * `tool_permissions` ne contient que ce que l'utilisateur a explicitement
 * accordé. Un outil absent du JSON est refusé (fail-closed), et une permission
 * `pending` ou `denied` aussi. L'écriture exige en plus un drapeau
 * `ecritureAutorisee` **persisté** et vérifié ici, pas un booléen de requête.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne décide pas du transport : celui-ci reste `safePost` (SSRF, épinglage,
 * refus de redirection), et il ne construit aucun en-tête d'authentification de
 * sa propre initiative — les en-têtes viennent de `entetesAuthentification`
 * alimenté par un secret lu côté serveur.
 */
import type { EgressDeps } from '../store-import/safe-egress.ts';
import {
  deciderAppel,
  executerOutil,
  entetesAuthentification,
  type PermissionStockee,
  type ServeurExterne,
  type TypeAuthentification,
} from './external.ts';
import {
  classerOutil,
  creerContexte,
  type ContexteClient,
  type ResultatMcp,
} from './client.ts';

/* -------------------------------------------------------------------------- */
/* 1. Ce que la base dit réellement                                             */
/* -------------------------------------------------------------------------- */

/**
 * Vue serveur d'une connexion MCP externe.
 *
 * Ces champs proviennent de `public.mcp_servers` (ligne relue à chaque appel),
 * jamais du corps de la requête. `secretVaultName` est le NOM du secret Vault,
 * pas sa valeur : la valeur n'est lue qu'au moment de l'appel et n'est jamais
 * rendue à l'appelant.
 */
export interface ConnexionServeur {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  url: string;
  authKind: TypeAuthentification;
  /** Nom du secret Vault, `null` si `authKind = 'none'`. */
  secretVaultName: string | null;
  status: 'unknown' | 'connected' | 'auth_required' | 'error' | 'revoked';
  revokedAt: string | null;
  /** Outils réellement découverts lors du dernier test réussi. */
  outils: readonly { name: string; description?: string }[];
  /** Permissions accordées : `{ "<outil>": "allowed" | "denied" | "pending" }`. */
  toolPermissions: Record<string, unknown>;
  /** Écritures explicitement autorisées, outil par outil. */
  ecrituresAutorisees: Record<string, unknown>;
}

/** Accès aux données, injecté pour être testable sans base. */
export interface AccesBase {
  /** Relit une connexion en vérifiant propriétaire ET espace de travail. */
  lireConnexion(input: { userId: string; serverId: string }): Promise<ConnexionServeur | null>;
  /** Lit la VALEUR d'un secret Vault par son nom. Jamais renvoyée au client. */
  lireSecret(vaultName: string): Promise<string | null>;
}

/** Ce que le client demande — un indice, pas une autorisation. */
export interface DemandeAppel {
  serverId: string;
  outil: string;
  arguments?: Record<string, unknown>;
  /**
   * Confirmation d'écriture DONNÉE PAR L'UTILISATEUR pour cet appel précis.
   *
   * Elle est confrontée à `ecrituresAutorisees` en base : une confirmation
   * ponctuelle ne suffit pas si l'écriture n'a jamais été autorisée pour cet
   * outil. Les deux conditions sont exigées.
   */
  confirmationEcriture?: boolean;
}

export interface DependancesP5 {
  base: AccesBase;
  /** Sortie réseau épinglée (SSRF). Jamais remplacée par `fetch`. */
  egress: EgressDeps;
  /**
   * Fournit le contexte d'un serveur : secret Vault, mécanisme d'auth, URL.
   * Injectable pour que les tests n'aient pas besoin de Vault.
   */
  contextePour?: (serveur: ServeurExterne) => ContexteClient;
  delaiMs?: number;
}

/* -------------------------------------------------------------------------- */
/* 2. Traduction base → décision                                                */
/* -------------------------------------------------------------------------- */

/**
 * Extrait la permission stockée d'un outil. Tout ce qui n'est pas exactement
 * `allowed` est un refus : une valeur inattendue, un type inattendu, une clé
 * absente. Le défaut est le refus, jamais l'autorisation.
 */
export function permissionDepuisBase(
  toolPermissions: Record<string, unknown>,
  ecrituresAutorisees: Record<string, unknown>,
  outil: string,
): PermissionStockee {
  const brut = toolPermissions[outil];
  const etat = brut === 'allowed' || brut === 'denied' || brut === 'pending' ? brut : 'denied';
  return {
    etat,
    ecritureAutorisee: ecrituresAutorisees[outil] === true,
  };
}

/** Un état de connexion utilisable pour appeler un outil ? */
export function connexionUtilisable(connexion: ConnexionServeur): boolean {
  return connexion.revokedAt === null
    && connexion.status !== 'revoked'
    && connexion.status === 'connected';
}

/* -------------------------------------------------------------------------- */
/* 3. La porte                                                                  */
/* -------------------------------------------------------------------------- */

export type RefusP5 =
  | 'server_not_found'
  | 'revoked'
  | 'connexion_indisponible'
  | 'secret_manquant'
  | 'outil_inconnu'
  | 'outil_non_autorise'
  | 'ecriture_non_confirmee';

export interface ResultatPorte {
  ok: boolean;
  /** Code stable, utilisable en réponse HTTP. Aucun secret n'y figure. */
  code?: RefusP5 | string;
  message?: string;
  /** Réponse réelle du serveur distant, seulement en cas de succès. */
  contenu?: unknown;
  isError?: boolean;
}

/**
 * Exécute un outil après avoir tout revérifié côté serveur.
 *
 * Ordre strict (le premier refus l'emporte) — aucun appel réseau n'a lieu
 * avant que tous les contrôles soient passés :
 *
 * 1. la connexion existe et appartient à CET utilisateur ;
 * 2. elle n'est pas révoquée et son état est `connected` ;
 * 3. le secret éventuel est lisible (sinon on n'appelle pas) ;
 * 4. l'outil figure dans la découverte persistée ;
 * 5. la permission persistée vaut `allowed` ;
 * 6. si l'outil n'est pas classé lecture, l'écriture est autorisée en base ET
 *    confirmée pour cet appel.
 *
 * Les étapes 4 à 6 sont déléguées à `deciderAppel`, qui est aussi utilisée par
 * les tests unitaires : une seule implémentation de la règle, donc pas de
 * divergence entre la porte et sa documentation.
 */
export async function executerOutilExterne(
  demande: DemandeAppel,
  contexteAppel: { userId: string },
  deps: DependancesP5,
): Promise<ResultatPorte> {
  const connexion = await deps.base.lireConnexion({
    userId: contexteAppel.userId,
    serverId: demande.serverId,
  });
  if (!connexion) {
    return { ok: false, code: 'server_not_found', message: 'Connexion MCP introuvable.' };
  }
  if (!connexionUtilisable(connexion)) {
    if (connexion.revokedAt !== null || connexion.status === 'revoked') {
      return { ok: false, code: 'revoked', message: 'Cette connexion MCP est révoquée.' };
    }
    return {
      ok: false,
      code: 'connexion_indisponible',
      message: 'Cette connexion MCP n’est pas dans un état permettant un appel (testez-la d’abord).',
    };
  }

  // Le secret est lu AVANT la décision : s'il manque alors qu'il est requis,
  // l'appel échouerait de toute façon, mais avec un message trompeur (401).
  let jeton: string | null = null;
  if (connexion.authKind !== 'none') {
    if (!connexion.secretVaultName) {
      return { ok: false, code: 'secret_manquant', message: 'Aucun secret n’est configuré pour cette connexion.' };
    }
    jeton = await deps.base.lireSecret(connexion.secretVaultName);
    if (!jeton) {
      return {
        ok: false,
        code: 'secret_manquant',
        message: 'Le secret de cette connexion est introuvable : reconnectez-la.',
      };
    }
  }

  const permission = permissionDepuisBase(connexion.toolPermissions, connexion.ecrituresAutorisees, demande.outil);

  const decision = deciderAppel({
    revoque: false,
    outil: demande.outil,
    description: connexion.outils.find((o) => o.name === demande.outil)?.description,
    outilsConnus: connexion.outils,
    permission,
  });
  if (!decision.permis) {
    // Une confirmation ponctuelle du client ne peut pas élargir une permission
    // persistée : si la base dit `denied`, l'appel est refusé même confirmé.
    return { ok: false, code: decision.code, message: decision.motif };
  }

  /*
   * L'écriture exige DEUX choses, et les deux sont persistées/vérifiées ici :
   *
   *   - l'autorisation d'écriture pour cet outil (`ecritureAutorisee`, en base) ;
   *   - la confirmation pour CET appel (`confirmationEcriture`, fournie par
   *     l'utilisateur au moment de l'action).
   *
   * `deciderAppel` a déjà refusé le cas où l'outil est une écriture sans
   * autorisation persistée. Il reste donc à exiger la confirmation ponctuelle.
   */
  const estUneEcriture = !classerOutil(
    demande.outil,
    connexion.outils.find((o) => o.name === demande.outil)?.description ?? '',
  ).lecture;
  if (estUneEcriture && demande.confirmationEcriture !== true) {
    return {
      ok: false,
      code: 'ecriture_non_confirmee',
      message: `L’outil « ${demande.outil} » peut modifier des données : confirmation explicite requise pour cet appel.`,
    };
  }

  /*
   * Les en-têtes sont calculés PAR APPEL, pas une fois à la construction : un
   * jeton OAuth peut expirer entre deux appels, et un en-tête figé enverrait un
   * jeton périmé sans que rien ne le signale.
   */
  const entetes = entetesAuthentification(connexion.authKind, jeton);
  const serveur: ServeurExterne = {
    url: connexion.url,
    auth: { kind: connexion.authKind, fournirEntetes: () => entetes },
  };
  const contexte = deps.contextePour?.(serveur)
    ?? creerContexte(
      { url: serveur.url, fournirEntetes: serveur.auth.fournirEntetes, delaiMs: deps.delaiMs },
      deps.egress,
    );

  const resultat: ResultatMcp<{ contenu: unknown; isError: boolean }> = await executerOutil(contexte, {
    outil: demande.outil,
    arguments: demande.arguments,
    description: connexion.outils.find((o) => o.name === demande.outil)?.description,
    permission,
    outilsConnus: connexion.outils,
    revoque: false,
  });

  if (!resultat.ok) {
    return { ok: false, code: resultat.error.code, message: resultat.error.message };
  }
  return { ok: true, contenu: resultat.value.contenu, isError: resultat.value.isError };
}

/* -------------------------------------------------------------------------- */
/* 4. Utilitaires d'usage                                                       */
/* -------------------------------------------------------------------------- */

/** Convertit un refus en réponse HTTP, sans jamais inclure de secret. */
export function statutHttp(refus: string): number {
  switch (refus) {
    case 'server_not_found':
    case 'outil_inconnu':
      return 404;
    case 'revoked':
    case 'connexion_indisponible':
    case 'secret_manquant':
      return 409;
    case 'outil_non_autorise':
    case 'ecriture_non_confirmee':
      return 403;
    case 'authentification':
      return 401;
    case 'timeout':
      return 504;
    case 'serveur_invalide':
      return 400;
    default:
      return 502;
  }
}
