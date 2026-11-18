/**
 * Logique des rappels de cycle de vie Meta — pure, sans accès réseau ni base.
 *
 * Toutes les dépendances sont injectées, ce qui permet de tester intégralement
 * les décisions qui comptent : signature valide ou non, route connue ou non,
 * forme du corps, contenu de la réponse.
 *
 * ## Règle directrice : échouer fermé
 * Une route inconnue, un corps illisible ou une signature absente renvoient une
 * erreur et ne touchent RIEN. Le seul cas où l'on écrit est celui d'un
 * `signed_request` prouvé authentique.
 */
import { dataDeletionResponse, parseSignedRequest, type DataDeletionResponse } from '../../../src/business/meta/deauthorize.ts';

export interface LifecycleDeps {
  appSecret: string;
  appUrl: string;
  now(): Date;
  revokeUserConnections(metaUserId: string): Promise<{ removed: number; tokenRefs: string[] }>;
  deleteUserData(metaUserId: string): Promise<{ connectionsRemoved: number; tokenRefs: string[] }>;
  recordDeletionRequest(metaUserId: string, confirmationCode: string, connectionsRemoved: number): Promise<void>;
  deleteSecrets(refs: string[]): Promise<number>;
  log?(message: string, details: Record<string, unknown>): void;
}

export interface LifecycleRequest {
  method: string;
  /** Dernier segment du chemin : `deauthorize` ou `data-deletion`. */
  route: string;
  contentType: string;
  /** Corps brut, non décodé avant vérification de la signature. */
  rawBody: string;
}

export interface LifecycleResponse {
  status: number;
  body: DataDeletionResponse | { ok: boolean; error?: string };
  headers: Record<string, string>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/**
 * Extrait `signed_request` d'un corps de formulaire.
 *
 * Meta poste en `application/x-www-form-urlencoded`. On ne décode QUE ce champ :
 * le reste du corps n'a aucun intérêt et n'est jamais interprété.
 */
export function extractSignedRequest(rawBody: string): string | null {
  if (!rawBody) return null;
  // Accepte aussi un corps JSON, au cas où Meta changerait d'encodage.
  const debut = rawBody.trimStart();
  if (debut.startsWith('{')) {
    try {
      const objet = JSON.parse(debut) as { signed_request?: unknown };
      return typeof objet.signed_request === 'string' ? objet.signed_request : null;
    } catch {
      return null;
    }
  }
  for (const morceau of rawBody.split('&')) {
    const egal = morceau.indexOf('=');
    if (egal <= 0) continue;
    if (morceau.slice(0, egal) !== 'signed_request') continue;
    try {
      return decodeURIComponent(morceau.slice(egal + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Traite une requête de rappel Meta.
 *
 * Les routes ne sont pas décoratives : `/deauthorize` révoque les autorisations
 * d'utilisateur, `/data-deletion` efface tout. Les confondre reviendrait soit à
 * conserver des données qu'on devait supprimer, soit à couper une messagerie
 * WhatsApp que le client n'a pas demandé à interrompre.
 */
export async function handleMetaLifecycle(
  requete: LifecycleRequest,
  deps: LifecycleDeps,
): Promise<LifecycleResponse> {
  if (requete.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'Méthode non autorisée.' }, headers: JSON_HEADERS };
  }
  if (requete.route !== 'deauthorize' && requete.route !== 'data-deletion') {
    return { status: 404, body: { ok: false, error: 'Route inconnue.' }, headers: JSON_HEADERS };
  }

  const signedRequest = extractSignedRequest(requete.rawBody);
  const verifie = await parseSignedRequest(signedRequest, deps.appSecret);
  if (!verifie.ok) {
    /*
     * 401 et rien d'autre. On ne dit pas POURQUOI la signature a échoué : un
     * message détaillé aiderait à distinguer « mauvais secret » de « signature
     * falsifiée », ce qui est une information utile à un attaquant.
     */
    deps.log?.('meta-lifecycle: signed_request refusé', { route: requete.route, raison: verifie.reason });
    return { status: 401, body: { ok: false, error: 'Signature invalide.' }, headers: JSON_HEADERS };
  }

  if (requete.route === 'deauthorize') {
    /*
     * La personne a retiré VYORA de son compte Facebook. On efface les
     * connexions Login for Business / Pages / Instagram et leurs jetons.
     *
     * WhatsApp n'est volontairement pas inclus (voir la migration) : ses jetons
     * sont des jetons SYSTÈME du portefeuille Business, indépendants du profil
     * personnel qui vient d'être retiré. Les effacer couperait une messagerie
     * en production pour une action qui ne la visait pas.
     */
    const resultat = await deps.revokeUserConnections(verifie.userId);
    const secrets = await deps.deleteSecrets(resultat.tokenRefs);
    deps.log?.('meta-lifecycle: déautorisation traitée', {
      connexions: resultat.removed,
      secrets,
    });
    // Meta attend un 200 sans forme imposée.
    return { status: 200, body: { ok: true }, headers: JSON_HEADERS };
  }

  /*
   * Suppression de données : cette fois tout est effacé, WhatsApp compris, et
   * les jetons système sont supprimés de Vault (Meta n'expose aucune API de
   * révocation pour ce type de jeton ; les effacer les rend inutilisables).
   *
   * On répond AVANT de considérer l'échec comme bloquant : Meta exige une URL
   * de suivi et un code, sinon le rappel est désactivé et l'application peut
   * être suspendue. La suppression est faite d'abord, la réponse ensuite.
   */
  const suppression = await deps.deleteUserData(verifie.userId);
  const secrets = await deps.deleteSecrets(suppression.tokenRefs);

  const now = deps.now();
  const reponse = dataDeletionResponse(deps.appUrl, verifie.userId, now);
  try {
    await deps.recordDeletionRequest(verifie.userId, reponse.confirmation_code, suppression.connectionsRemoved);
  } catch (erreur) {
    // Ne pas faire échouer la réponse : la suppression est faite, et Meta n'a
    // aucun moyen de rejouer. On garde une trace pour la purge du journal.
    deps.log?.('meta-lifecycle: journal de suppression non écrit', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
  }

  deps.log?.('meta-lifecycle: suppression de données traitée', {
    connexions: suppression.connectionsRemoved,
    secrets,
  });
  return { status: 200, body: reponse, headers: JSON_HEADERS };
}
