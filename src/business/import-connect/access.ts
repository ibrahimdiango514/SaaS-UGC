/**
 * Import & Connect — droits d'accès côté client.
 *
 * ## Rôle de ce module
 * Afficher l'état réel et guider l'utilisateur. **Il ne protège rien.**
 * La décision d'autoriser une opération est prise côté serveur
 * (`saas_business.bg_import_access` + garde dans l'Edge Function
 * `store-import`), et un client modifié ne change rien à l'affaire.
 *
 * Conséquence pratique : ce module ne réimplémente AUCUNE règle
 * d'abonnement. Il lit `public.vyora_import_connect_access()`, qui applique la
 * règle en base, et se contente d'en traduire le résultat.
 *
 * ## Pourquoi les motifs sont exposés tels quels
 * « Abonnement expiré », « paiement échoué » et « jamais souscrit » n'appellent
 * pas la même action de l'utilisateur. Les confondre en un « accès refusé »
 * unique serait plus simple et moins utile.
 */

/** Motifs renvoyés par la base. Toute valeur inconnue est traitée comme un refus. */
export type ImportAccessReason =
  | 'OK'
  | 'NO_SUBSCRIPTION'
  | 'SUBSCRIPTION_INACTIVE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SUBSCRIPTION_CANCELED'
  | 'PAYMENT_FAILED'
  | 'PLAN_INACTIVE'
  | 'PERIOD_UNKNOWN'
  | 'NOT_AUTHENTICATED'
  | 'UNKNOWN';

export interface ImportAccessState {
  /** Vrai seulement si le serveur l'a explicitement accordé. */
  allowed: boolean;
  reason: ImportAccessReason;
  /** Message destiné à l'utilisateur, fourni par le serveur. */
  message: string;
  status: string | null;
  planKey: string | null;
  currentPeriodEnd: string | null;
  /** Instant de la vérification, pour informer sans promettre de durée. */
  checkedAt: string | null;
  /**
   * `true` quand la vérification elle-même a échoué (réseau, base).
   * Distinct d'un refus : on ne dit pas « pas d'abonnement » quand on ne sait
   * pas.
   */
  unknown: boolean;
}

const REASONS: ReadonlySet<string> = new Set<ImportAccessReason>([
  'OK', 'NO_SUBSCRIPTION', 'SUBSCRIPTION_INACTIVE', 'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_CANCELED', 'PAYMENT_FAILED', 'PLAN_INACTIVE', 'PERIOD_UNKNOWN',
  'NOT_AUTHENTICATED', 'UNKNOWN',
]);

/** Règle de lecture : tout ce qui n'est pas explicitement `true` est un refus. */
export function normalizeAccess(raw: unknown): ImportAccessState {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const raison = typeof source.reason === 'string' && REASONS.has(source.reason)
    ? source.reason as ImportAccessReason
    : 'UNKNOWN';
  const str = (value: unknown): string | null => (
    typeof value === 'string' && value.trim() ? value : null
  );
  return {
    // Comparaison stricte : `"true"`, `1` ou absent ne valent pas accord.
    allowed: source.allowed === true,
    reason: raison,
    message: str(source.message) ?? 'Un abonnement Business Grow actif est requis.',
    status: str(source.status),
    planKey: str(source.plan_key) ?? str(source.planKey),
    currentPeriodEnd: str(source.current_period_end) ?? str(source.currentPeriodEnd),
    checkedAt: str(source.checked_at) ?? str(source.checkedAt),
    unknown: false,
  };
}

/** État renvoyé quand la vérification n'a pas pu aboutir. */
export function unknownAccess(message: string): ImportAccessState {
  return {
    allowed: false,
    reason: 'UNKNOWN',
    message,
    status: null,
    planKey: null,
    currentPeriodEnd: null,
    checkedAt: null,
    unknown: true,
  };
}

/** Lien vers la page de souscription existante. Aucune page n'est créée ici. */
export const SUBSCRIPTION_PATH = '/app/business/abonnement';

/**
 * Ce que l'interface doit montrer pour un motif donné.
 *
 * `title` et `detail` sont volontairement distincts : le motif technique ne
 * doit pas être le texte affiché, mais l'utilisateur doit comprendre POURQUOI.
 */
export function accessGuidance(state: ImportAccessState): {
  title: string;
  detail: string;
  /** Faut-il proposer le lien de souscription ? */
  showSubscribe: boolean;
  tone: 'info' | 'warning' | 'danger';
} {
  if (state.allowed) {
    return {
      title: 'Import & Connect est actif',
      detail: state.currentPeriodEnd
        ? `Abonnement Business Grow valable jusqu’au ${new Date(state.currentPeriodEnd).toLocaleDateString('fr-FR')}.`
        : 'Abonnement Business Grow actif.',
      showSubscribe: false,
      tone: 'info',
    };
  }
  if (state.unknown) {
    return {
      title: 'Vérification de l’abonnement indisponible',
      detail: state.message || 'Impossible de vérifier votre abonnement pour le moment. Aucune opération n’a été lancée.',
      showSubscribe: false,
      tone: 'warning',
    };
  }
  switch (state.reason) {
    case 'NOT_AUTHENTICATED':
      return {
        title: 'Session requise',
        detail: 'Reconnectez-vous pour vérifier votre abonnement Business Grow.',
        showSubscribe: false,
        tone: 'warning',
      };
    case 'NO_SUBSCRIPTION':
      return {
        title: 'Abonnement Business Grow requis',
        detail: 'Import & Connect est réservé aux abonnés Business Grow. Souscrivez une offre pour importer et connecter vos boutiques.',
        showSubscribe: true,
        tone: 'info',
      };
    case 'PAYMENT_FAILED':
      return {
        title: 'Paiement de l’abonnement en échec',
        detail: 'L’accès est suspendu tant que le paiement de votre abonnement Business Grow n’est pas régularisé.',
        showSubscribe: true,
        tone: 'danger',
      };
    case 'SUBSCRIPTION_EXPIRED':
      return {
        title: 'Abonnement expiré',
        detail: 'Votre abonnement Business Grow a expiré. Renouvelez-le pour retrouver l’accès à vos boutiques et à vos imports.',
        showSubscribe: true,
        tone: 'warning',
      };
    case 'SUBSCRIPTION_CANCELED':
      return {
        title: 'Abonnement résilié',
        detail: 'Votre abonnement Business Grow a été résilié. Une nouvelle souscription est nécessaire pour accéder au module.',
        showSubscribe: true,
        tone: 'warning',
      };
    case 'PLAN_INACTIVE':
      return {
        title: 'Formule indisponible',
        detail: 'La formule associée à votre abonnement n’est plus proposée. Choisissez une formule active pour continuer.',
        showSubscribe: true,
        tone: 'warning',
      };
    case 'PERIOD_UNKNOWN':
      return {
        title: 'Période d’abonnement non établie',
        detail: 'La période de votre abonnement Business Grow n’est pas encore confirmée. L’accès sera ouvert dès que le paiement sera appliqué.',
        showSubscribe: true,
        tone: 'warning',
      };
    default:
      return {
        title: 'Abonnement Business Grow inactif',
        detail: state.message || 'Un abonnement Business Grow actif est requis pour utiliser Import & Connect.',
        showSubscribe: true,
        tone: 'warning',
      };
  }
}

/**
 * Le module doit-il être visible dans la navigation ?
 *
 * Toujours, y compris sans abonnement : le cahier des charges demande une
 * présentation commerciale. Ce qui change est l'accès aux FONCTIONS, pas la
 * visibilité de l'entrée.
 */
export function shouldShowModuleEntry(): boolean {
  return true;
}

/**
 * Une fonction d'import est-elle utilisable ?
 *
 * Utilisé par l'interface pour désactiver les boutons. Ce n'est PAS une
 * protection : l'Edge Function revérifie de toute façon.
 */
export function canUseImportFeatures(state: ImportAccessState | null): boolean {
  return state?.allowed === true;
}

/* -------------------------------------------------------------------------- */
/* Chargement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lit les droits auprès du serveur.
 *
 * Échoue « fermé » : si l'appel échoue, on renvoie un état `unknown` — jamais
 * un état autorisé. L'interface affichera une vérification indisponible, ce qui
 * est exact.
 */
export async function loadImportAccess(): Promise<ImportAccessState> {
  try {
    // Import statique volontairement évité : ce module est chargé par des
    // écrans qui n'appellent pas toujours le réseau (navigation, tests).
    const { rpc } = await import('../../lib/api');
    const raw = await rpc<unknown>('vyora_import_connect_access');
    return normalizeAccess(raw);
  } catch {
    return unknownAccess(
      'Impossible de vérifier votre abonnement Business Grow pour le moment. Aucune opération n’a été lancée.',
    );
  }
}
