/**
 * VYORA — frontière HTTP de l'exécution d'outils MCP externes.
 *
 * ## Pourquoi une couche distincte de `execution.ts`
 *
 * `execution.ts` décide ; ce module **traduit**. Il reçoit un corps de requête
 * non fiable (le navigateur peut envoyer n'importe quoi), le valide
 * strictement, puis délègue la décision à la porte P5. Séparer les deux permet
 * de tester la validation d'entrée sans base ni réseau, et la décision sans
 * HTTP.
 *
 * ## Ce que cette frontière refuse de faire
 *
 * - **Aucune identité fournie par le client.** `userId` est résolu par
 *   l'appelant auprès de GoTrue ; un `user_id` présent dans le corps est
 *   ignoré, jamais lu.
 * - **Aucune permission fournie par le client.** Le corps ne peut pas porter
 *   `permission` ni `etat` : seuls `serverId`, `outil`, `arguments` et une
 *   confirmation ponctuelle sont acceptés. Tout champ inconnu est ignoré —
 *   pas rejeté, pour ne pas casser un client plus récent, mais jamais utilisé.
 * - **Aucun secret dans la réponse.** Les messages d'erreur viennent de codes
 *   stables ; `execution.ts` ne renvoie jamais le jeton lu.
 *
 * ## Validation d'entrée
 *
 * Un identifiant qui n'est pas un UUID, un nom d'outil vide ou démesuré, des
 * arguments qui ne sont pas un objet JSON, un corps qui dépasse le plafond :
 * tout cela est refusé AVANT toute lecture en base. Sans cela, un appel malformé
 * provoquerait une requête SQL inutile, voire une erreur 500 qui masquerait le
 * vrai problème.
 */
import {
  executerOutilExterne,
  statutHttp,
  type DependancesP5,
  type ResultatPorte,
} from './execution.ts';

/** Plafond du corps accepté : un appel d'outil n'est pas un téléversement. */
export const MAX_CORPS_OCTETS = 256 * 1024;

/** Longueur maximale d'un nom d'outil telle que la spécification l'admet en pratique. */
export const MAX_NOM_OUTIL = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReponseHttp {
  status: number;
  body: Record<string, unknown>;
}

/** Corps entrant, tel que reçu — non fiable par construction. */
export type CorpsEntrant = unknown;

/** Résultat de la résolution d'identité, faite par l'appelant (GoTrue). */
export type Identite = { userId: string } | null;

/**
 * Valide et normalise le corps. Retourne un refus ou une demande propre.
 *
 * Les champs inconnus ne sont pas recopiés : la demande retournée ne contient
 * que ce qui a été explicitement validé, ce qui rend impossible l'injection
 * d'une propriété non prévue dans la couche de décision.
 */
export function validerCorps(corps: CorpsEntrant):
  | { ok: true; demande: { serverId: string; outil: string; arguments?: Record<string, unknown>; confirmationEcriture: boolean } }
  | { ok: false; status: number; code: string; message: string } {
  if (typeof corps !== 'object' || corps === null || Array.isArray(corps)) {
    return { ok: false, status: 400, code: 'corps_invalide', message: 'Le corps doit être un objet JSON.' };
  }
  const objet = corps as Record<string, unknown>;

  const serverId = objet.serverId ?? objet.server_id;
  if (typeof serverId !== 'string' || !UUID.test(serverId)) {
    return { ok: false, status: 400, code: 'server_id_invalide', message: 'Identifiant de connexion invalide.' };
  }

  const outil = objet.outil ?? objet.tool;
  if (typeof outil !== 'string' || outil.trim().length === 0 || outil.length > MAX_NOM_OUTIL) {
    return { ok: false, status: 400, code: 'outil_invalide', message: 'Nom d’outil invalide.' };
  }

  const args = objet.arguments ?? objet.args;
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    return { ok: false, status: 400, code: 'arguments_invalides', message: 'Les arguments doivent être un objet JSON.' };
  }

  // Une confirmation n'est acceptée que si elle vaut strictement `true` : une
  // chaîne « true » ou le nombre 1 ne sont pas des confirmations.
  const confirmation = objet.confirmationEcriture === true || objet.confirmation_ecriture === true;

  return {
    ok: true,
    demande: {
      serverId,
      outil: outil.trim(),
      arguments: args as Record<string, unknown> | undefined,
      confirmationEcriture: confirmation,
    },
  };
}

/**
 * Traite un appel d'outil de bout en bout.
 *
 * L'ordre est celui qui compte pour la sécurité : identité, puis forme du
 * corps, puis décision en base, puis réseau. Aucune lecture en base n'a lieu
 * avant la validation d'entrée, aucune requête réseau avant la décision.
 */
export async function traiterAppelOutil(
  entree: { identite: Identite; corps: CorpsEntrant },
  deps: DependancesP5,
): Promise<ReponseHttp> {
  if (!entree.identite) {
    return {
      status: 401,
      body: { error: 'authentification_requise', message: 'Jeton absent ou invalide.' },
    };
  }

  const validation = validerCorps(entree.corps);
  if (!validation.ok) {
    return { status: validation.status, body: { error: validation.code, message: validation.message } };
  }

  const resultat: ResultatPorte = await executerOutilExterne(
    validation.demande,
    { userId: entree.identite.userId },
    deps,
  );

  if (!resultat.ok) {
    const code = resultat.code ?? 'erreur';
    return {
      // Un refus d'autorisation est un 403, jamais un 200 : un client ne doit
      // pas pouvoir confondre « refusé » et « exécuté sans effet ».
      status: statutHttp(code),
      body: { error: code, message: resultat.message ?? 'Appel refusé.' },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      isError: resultat.isError === true,
      contenu: resultat.contenu,
    },
  };
}

/**
 * Journalisation : ne garde que ce qui est nécessaire au diagnostic.
 *
 * Volontairement limité à des identifiants et à un code. Ni arguments (qui
 * peuvent contenir des données client), ni jeton, ni URL complète avec
 * paramètres : un journal ne doit jamais devenir une fuite.
 */
export function entreeJournal(input: {
  userId: string;
  serverId: string;
  outil: string;
  status: number;
  code?: string;
}): Record<string, string | number> {
  return {
    userId: input.userId,
    serverId: input.serverId,
    outil: input.outil,
    status: input.status,
    ...(input.code ? { code: input.code } : {}),
  };
}
