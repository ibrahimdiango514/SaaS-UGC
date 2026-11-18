/**
 * VYORA — parcours WhatsApp de TEST, réservé à l'administrateur propriétaire.
 *
 * ## Pourquoi ce module existe
 *
 * Le parcours client (`Embedded Signup`) exige un compte WhatsApp réel d'un
 * portefeuille business. Le numéro de test fourni par Meta n'en fait pas
 * partie : il ne peut donc pas passer par ce chemin. Sans un parcours dédié,
 * il est impossible de prouver la chaîne complète (message reçu, réponse
 * envoyée, statut de livraison) avant d'avoir un numéro réel et une revue Meta.
 *
 * ## Le modèle de menace, et comment il est fermé
 *
 * Ce parcours est le seul endroit du code qui écrit une connexion WhatsApp
 * SANS échange OAuth. C'est donc le point le plus sensible de l'intégration.
 * Quatre gardes, toutes côté serveur :
 *
 * 1. **Identité administrateur.** Le rôle vient de la base
 *    (`saas_ugc.ugc_user_roles`, rôle `admin`), lu pour l'identifiant GoTrue
 *    **vérifié**. Aucun en-tête, aucun corps de requête, aucun paramètre d'URL
 *    n'influence cette décision. Un client qui connaît l'URL obtient 403.
 *
 * 2. **Interrupteur explicite.** Le parcours est désactivé par défaut. Il ne
 *    s'active que sur une variable serveur (`META_TEST_FLOW_ENABLED`) que le
 *    navigateur ne peut pas lire ni écrire. Désactiver = retirer la variable ;
 *    le parcours client n'est pas touché.
 *
 * 3. **Identifiants imposés par le serveur.** Le client ne transmet JAMAIS de
 *    WABA ni de numéro. Les valeurs viennent uniquement de variables serveur
 *    (`META_TEST_WABA_ID`, `META_TEST_PHONE_NUMBER_ID`), elles-mêmes recopiées
 *    de l'écran *Premiers pas* de Meta. Il n'existe donc aucune entrée par
 *    laquelle attacher un compte arbitraire : le corps de la requête ne porte
 *    que l'action et l'entreprise.
 *
 * 4. **Vérification auprès de Meta avant écriture.** Détenir un jeton ne suffit
 *    pas : le module relit le numéro chez Meta et exige qu'il appartienne bien
 *    au WABA déclaré. Un identifiant recopié de travers, ou un jeton d'une autre
 *    application, échoue ici — avant qu'aucune ligne ne soit écrite.
 *
 * ## Ce qui n'est jamais exposé
 * Aucun jeton ne sort de ce module : les réponses ne contiennent que des
 * identifiants publics, des noms et des états. Les erreurs sont expurgées par
 * `redactTokens` en amont.
 */
import type { GraphDeps } from './graph.ts';
import { MetaError, getWaba, listPhoneNumbers, subscribeWaba } from './graph.ts';
import type { MetaProduct } from './products.ts';

/** Préfixe des secrets Vault de ce parcours : isolé du parcours client. */
export const TEST_SECRET_PREFIX = 'vyora_meta_test_';

export interface TestFlowConfig {
  /** Interrupteur serveur. Absent ou faux ⇒ parcours indisponible. */
  enabled: boolean;
  /** WABA imposé par le serveur (écran Premiers pas de Meta). */
  wabaId: string;
  /** Identifiant de numéro imposé par le serveur. */
  phoneNumberId: string;
  /** Numéro affiché, pour le diagnostic seulement. Jamais utilisé pour router. */
  displayPhoneNumber: string;
}

/**
 * Lit la configuration depuis l'environnement.
 *
 * `enabled` exige la valeur littérale `'true'` : une variable posée à `'1'`,
 * `'yes'` ou `'TRUE'` laisse le parcours fermé. Un interrupteur de sécurité ne
 * doit pas s'ouvrir par approximation.
 */
export function readTestFlowConfig(env: (name: string) => string): TestFlowConfig {
  const brut = (env('META_TEST_FLOW_ENABLED') ?? '').trim().toLowerCase();
  return {
    enabled: brut === 'true',
    wabaId: (env('META_TEST_WABA_ID') ?? '').trim(),
    phoneNumberId: (env('META_TEST_PHONE_NUMBER_ID') ?? '').trim(),
    displayPhoneNumber: (env('META_TEST_DISPLAY_PHONE_NUMBER') ?? '').trim(),
  };
}

export interface TestFlowState {
  /** Le parcours est-il ouvert (interrupteur + configuration complète) ? */
  available: boolean;
  /** Motif lisible quand il ne l'est pas. Ne révèle aucun secret. */
  reason: string | null;
  /** Identifiants imposés, pour affichage. `null` si non configurés. */
  wabaId: string | null;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
}

/**
 * État public du parcours de test, sans secret.
 *
 * Un identifiant de WABA ou de numéro n'est pas un secret (il apparaît dans
 * l'URL de tout appel Graph) : on peut l'afficher pour que l'utilisateur
 * vérifie qu'il a recopié les bons chiffres. Le jeton, lui, n'apparaît jamais.
 */
export function describeTestFlow(config: TestFlowConfig): TestFlowState {
  const manques: string[] = [];
  if (!config.wabaId) manques.push('META_TEST_WABA_ID');
  if (!config.phoneNumberId) manques.push('META_TEST_PHONE_NUMBER_ID');
  if (!config.enabled) manques.push('META_TEST_FLOW_ENABLED');
  const disponible = manques.length === 0;
  return {
    available: disponible,
    reason: disponible ? null : `Parcours de test indisponible : ${manques.join(', ')} manquant(s).`,
    wabaId: config.wabaId || null,
    phoneNumberId: config.phoneNumberId || null,
    displayPhoneNumber: config.displayPhoneNumber || null,
  };
}

/** Une valeur d'identifiant Meta : uniquement des chiffres, 5 à 32. */
export function isMetaId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{5,32}$/.test(value);
}

export interface TestFlowRejection {
  code: string;
  message: string;
  status: number;
}

/**
 * Décide si l'identité donnée peut utiliser le parcours de test.
 *
 * Fonction pure : elle ne lit ni base ni réseau, donc chaque refus est
 * testable sans infrastructure. Le rôle `admin` est la seule autorisation —
 * pas de liste d'e-mails en dur, pas d'entorse pour un « compte de test ».
 */
export function refuseTestFlow(input: {
  userId: string | null;
  isAdmin: boolean;
  config: TestFlowConfig;
}): TestFlowRejection | null {
  if (!input.userId) {
    return { code: 'UNAUTHENTICATED', message: 'Session VYORA invalide ou expirée.', status: 401 };
  }
  if (!input.isAdmin) {
    // 404 volontaire : un client non administrateur n'apprend pas que ce
    // parcours existe. Un 403 lui dirait « il y a quelque chose ici ».
    return { code: 'TEST_FLOW_UNAVAILABLE', message: 'Parcours de test indisponible.', status: 404 };
  }
  if (!input.config.enabled) {
    return { code: 'TEST_FLOW_DISABLED', message: 'Le parcours de test est désactivé.', status: 404 };
  }
  if (!isMetaId(input.config.wabaId) || !isMetaId(input.config.phoneNumberId)) {
    return {
      code: 'TEST_FLOW_NOT_CONFIGURED',
      message: 'Le parcours de test n’est pas configuré sur le serveur (identifiants Meta manquants).',
      status: 503,
    };
  }
  return null;
}

/**
 * Nom du secret portant le jeton du parcours de test.
 *
 * Préfixe distinct (`vyora_meta_test_`) pour qu'aucune requête du parcours
 * client, qui cherche `vyora_meta_%`, ne puisse le trouver par erreur — et
 * inversement.
 */
export function testTokenSecretName(userId: string, workspaceId: string): string {
  return `${TEST_SECRET_PREFIX}token:${userId}:${workspaceId}`;
}

export interface TestVerification {
  ok: boolean;
  /** Le numéro appartient-il bien au WABA déclaré ? */
  phoneBelongsToWaba: boolean;
  /** L'application est-elle abonnée aux webhooks de ce WABA ? */
  webhookSubscribed: boolean;
  wabaName: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  codeVerificationStatus: string | null;
  /** Motif lisible en cas d'échec. Jamais de jeton. */
  error: string | null;
}

/**
 * Confronte la configuration serveur à ce que Meta répond réellement.
 *
 * ## Pourquoi relire chez Meta plutôt que faire confiance
 * Les identifiants viennent de variables, donc d'une saisie humaine. Un chiffre
 * de travers créerait une connexion qui ne recevrait jamais rien, et le
 * diagnostic serait « le webhook ne marche pas » alors que la cause est une
 * faute de copie. Ici, la comparaison est faite par Meta : soit le numéro est
 * dans le WABA, soit on refuse d'écrire.
 *
 * ## Ce que la fonction fait aussi
 * Elle abonne le WABA aux webhooks de l'application. Sans cet abonnement, Meta
 * n'envoie aucune notification — c'est la cause n°1 d'un « webhook silencieux ».
 * L'abonnement est idempotent côté Meta.
 */
export async function verifyTestTarget(
  config: TestFlowConfig,
  token: string,
  graph: GraphDeps,
): Promise<TestVerification> {
  const vide: TestVerification = {
    ok: false,
    phoneBelongsToWaba: false,
    webhookSubscribed: false,
    wabaName: null,
    displayPhoneNumber: null,
    verifiedName: null,
    qualityRating: null,
    codeVerificationStatus: null,
    error: null,
  };

  if (!isMetaId(config.wabaId) || !isMetaId(config.phoneNumberId)) {
    return { ...vide, error: 'Identifiants Meta du parcours de test absents ou mal formés.' };
  }

  let wabaName: string | null = null;
  try {
    const waba = await getWaba(config.wabaId, token, graph);
    wabaName = waba.name ?? null;
  } catch (erreur) {
    return {
      ...vide,
      error: erreur instanceof MetaError
        ? `Meta refuse l’accès au compte WhatsApp déclaré (${erreur.code}). Vérifiez META_TEST_WABA_ID et les droits du jeton.`
        : 'Meta n’a pas pu être interrogé.',
    };
  }

  let numeros: Awaited<ReturnType<typeof listPhoneNumbers>>;
  try {
    numeros = await listPhoneNumbers(config.wabaId, token, graph);
  } catch (erreur) {
    return {
      ...vide,
      wabaName,
      error: erreur instanceof MetaError
        ? `Meta refuse la liste des numéros (${erreur.code}).`
        : 'Liste des numéros indisponible.',
    };
  }

  const numero = numeros.find((n) => n.id === config.phoneNumberId);
  if (!numero) {
    /*
     * Le refus le plus important du module. On n'écrit PAS cette connexion :
     * un numéro absent du WABA déclaré signifie que la configuration est fausse
     * (ou que quelqu'un tente d'attacher un numéro qui ne nous appartient pas).
     * On ne retombe jamais sur « le premier numéro trouvé » : ce repli
     * connecterait un numéro que l'administrateur n'a pas choisi.
     */
    return {
      ...vide,
      wabaName,
      error: `Le numéro ${config.phoneNumberId} n’appartient pas au compte WhatsApp ${config.wabaId} : rien n’a été enregistré.`,
    };
  }

  let webhookSubscribed = false;
  let erreurAbonnement: string | null = null;
  try {
    webhookSubscribed = await subscribeWaba(config.wabaId, token, graph);
  } catch (erreur) {
    erreurAbonnement = erreur instanceof MetaError
      ? `Abonnement webhook refusé (${erreur.code}).`
      : 'Abonnement webhook impossible.';
  }

  return {
    ok: true,
    phoneBelongsToWaba: true,
    webhookSubscribed,
    wabaName,
    displayPhoneNumber: numero.display_phone_number ?? null,
    verifiedName: numero.verified_name ?? null,
    qualityRating: numero.quality_rating ?? null,
    codeVerificationStatus: numero.code_verification_status ?? null,
    error: erreurAbonnement,
  };
}

/** Produit de la connexion — identique au parcours client : une seule fiche. */
export const TEST_FLOW_PRODUCT: MetaProduct = 'whatsapp';
