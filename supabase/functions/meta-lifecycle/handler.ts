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
 *
 * ## Trois routes, trois natures
 *   - `deauthorize`    : POST signé par Meta — révoque les autorisations.
 *   - `data-deletion`  : POST signé par Meta — efface tout et renvoie le code.
 *   - `deletion-status`: GET public — lit l'état d'UNE demande, par son code.
 *
 * La troisième est la seule route publique non signée, et c'est assumé : Meta
 * impose une URL de suivi accessible sans authentification. Elle ne renvoie
 * aucun identifiant, seulement un état et des dates.
 */
import { dataDeletionResponse, parseSignedRequest, type DataDeletionResponse } from '../../../src/business/meta/deauthorize.ts';

/** État renvoyé par la page de suivi : jamais d'identifiant, seulement avancement et dates. */
export interface DeletionStatus {
  status: 'pending' | 'completed' | 'no_data';
  requestedAt: string | null;
  completedAt: string | null;
  hasFailure: boolean;
}

export interface LifecycleDeps {
  appSecret: string;
  appUrl: string;
  now(): Date;
  revokeUserConnections(metaUserId: string): Promise<{ removed: number; tokenRefs?: string[] }>;
  /**
   * Supprime les données ET enregistre la demande, dans une seule transaction.
   * Le code de confirmation est calculé côté base : l'appelant ne le choisit pas.
   */
  deleteUserData(metaUserId: string): Promise<{ confirmationCode: string; connectionsRemoved: number }>;
  /** Lecture publique de l'état d'une demande, par son code. */
  readDeletionStatus(confirmationCode: string): Promise<DeletionStatus | null>;
  log?(message: string, details: Record<string, unknown>): void;
}

export interface LifecycleRequest {
  method: string;
  /** Dernier segment du chemin : `deauthorize`, `data-deletion` ou `deletion-status`. */
  route: string;
  contentType: string;
  /** Corps brut, non décodé avant vérification de la signature. */
  rawBody: string;
  /** Paramètres d'URL, pour la page de suivi (`?code=…`). */
  query?: Record<string, string>;
}

export interface LifecycleResponse {
  status: number;
  body: DataDeletionResponse | DeletionStatus | { ok: boolean; error?: string; status?: string };
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
  /* ------------------------- page de suivi (GET) ------------------------- */
  if (requete.route === 'deletion-status') {
    if (requete.method !== 'GET') {
      return { status: 405, body: { ok: false, error: 'Méthode non autorisée.' }, headers: JSON_HEADERS };
    }
    const code = (requete.query?.code ?? '').trim();
    /*
     * Forme stricte : `vyora-` suivi de 32 hexadécimaux. Le code ne contient
     * AUCUN fragment de l'identifiant Meta (vérifié : une version antérieure
     * y laissait l'ASID en clair dans une URL publique).
     *
     * Refuser tôt évite d'interroger la base pour n'importe quelle chaîne — la
     * page est publique, elle sera sondée.
     */
    if (!/^vyora-[0-9a-f]{32}$/.test(code)) {
      return { status: 400, body: { ok: false, error: 'Code de confirmation invalide.' }, headers: JSON_HEADERS };
    }
    const etat = await deps.readDeletionStatus(code);
    if (!etat) {
      // 404 et non 403 : ne pas distinguer « mauvais code » de « demande
      // inexistante » n'apporte rien à l'utilisateur légitime, et évite de
      // confirmer l'existence d'un code à un tiers qui le devine.
      return { status: 404, body: { ok: false, error: 'Aucune demande ne correspond à ce code.' }, headers: JSON_HEADERS };
    }
    return {
      status: 200,
      body: etat,
      /*
       * `no-store` : le code figure dans l'URL. Sans cet en-tête, un cache
       * intermédiaire ou l'historique partagé d'un navigateur conserverait la
       * réponse et l'associerait au code.
       */
      headers: { ...JSON_HEADERS, 'cache-control': 'no-store' },
    };
  }

  /* ----------------------- rappels signés par Meta ----------------------- */
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
     * WhatsApp est volontairement exclu (voir la migration) : ses jetons sont
     * des jetons SYSTÈME du portefeuille Business, indépendants du profil
     * personnel qui vient d'être retiré.
     *
     * Idempotence : une seconde réception pour la même identité ne supprime plus
     * rien et répond 200 — Meta doit cesser de réessayer.
     */
    try {
      const resultat = await deps.revokeUserConnections(verifie.userId);
      deps.log?.('meta-lifecycle: déautorisation traitée', { connexions: resultat.removed });
      return { status: 200, body: { ok: true }, headers: JSON_HEADERS };
    } catch (erreur) {
      /*
       * 500 volontaire : ici, contrairement à la suppression, Meta peut
       * réessayer sans dommage (l'opération est idempotente). Répondre 200 sur
       * un échec laisserait l'utilisateur « déconnecté chez Meta mais connecté
       * chez VYORA », ce qui est exactement le défaut que ce module corrige.
       */
      deps.log?.('meta-lifecycle: déautorisation en échec', {
        erreur: erreur instanceof Error ? erreur.message : 'inconnue',
      });
      return { status: 500, body: { ok: false, error: 'Traitement impossible.' }, headers: JSON_HEADERS };
    }
  }

  /*
   * Suppression de données : tout est effacé, WhatsApp compris, et les jetons
   * système sont retirés de Vault (Meta n'expose aucune API de révocation pour
   * ce type de jeton ; les effacer les rend inutilisables).
   *
   * La suppression ET l'enregistrement de la demande se font dans un seul appel
   * — donc une seule transaction. Un échec annule tout : mieux vaut ne rien
   * supprimer et laisser Meta réessayer que supprimer sans pouvoir prouver
   * l'état de la demande.
   */
  let suppression: { confirmationCode: string; connectionsRemoved: number };
  try {
    suppression = await deps.deleteUserData(verifie.userId);
  } catch (erreur) {
    deps.log?.('meta-lifecycle: suppression en échec', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return { status: 500, body: { ok: false, error: 'Traitement impossible.' }, headers: JSON_HEADERS };
  }

  /*
   * La réponse à Meta doit contenir une URL de suivi et un code, sinon le
   * rappel peut être désactivé et l'application suspendue. On construit l'URL à
   * partir du code RÉELLEMENT enregistré, pas d'un code recalculé : le lien ne
   * peut donc pas pointer vers une demande qui n'existe pas.
   */
  const reponse = dataDeletionResponse(deps.appUrl, suppression.confirmationCode);
  deps.log?.('meta-lifecycle: suppression de données traitée', {
    connexions: suppression.connectionsRemoved,
  });
  return { status: 200, body: reponse, headers: JSON_HEADERS };
}
