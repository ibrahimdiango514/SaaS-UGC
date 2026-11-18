/**
 * Validité d'un aperçu d'import temporaire — logique pure.
 *
 * ## Pourquoi un module séparé
 * Cette règle décide si le bouton de confirmation doit être actif. Elle est
 * testable directement, sans DOM ni horloge simulée : un test de composant
 * obligerait à faire avancer le temps de React pour vérifier… une soustraction.
 *
 * Elle ne remplace pas le serveur : le serveur refuse un aperçu échu, quel que
 * soit l'affichage. Ici, on évite seulement de proposer une action vouée à
 * l'échec, et on prévient avant l'expiration.
 */

/* ------------------------- validité de l'aperçu -------------------------- */

/**
 * Seuil à partir duquel on prévient l'utilisateur que l'aperçu va expirer.
 *
 * Deux minutes : assez tôt pour qu'il ait le temps de confirmer ou de relancer,
 * assez tard pour ne pas crier au loup dès l'affichage d'un aperçu qu'il vient
 * de demander. En dessous, le message devient une alerte ; au-delà, il n'y a
 * rien à dire.
 */
export const PREVIEW_WARNING_MS = 2 * 60 * 1000;

export type PreviewValidity =
  /** Valide, largement le temps de confirmer. */
  | { state: 'valid'; remainingMs: number; label: string }
  /** Valide, mais l'échéance approche. */
  | { state: 'expiring'; remainingMs: number; label: string }
  /** Échu : la confirmation est refusée par le serveur. */
  | { state: 'expired'; remainingMs: 0; label: string }
  /** Le serveur n'a pas fourni d'échéance lisible : on n'affirme rien. */
  | { state: 'unknown'; remainingMs: null; label: string };

/**
 * Traduit une échéance ISO en état affichable.
 *
 * ## Pourquoi c'est ici et pas dans le composant
 * C'est une règle, pas de la mise en page : elle décide si le bouton de
 * confirmation doit être actif. La tester dans un composant obligerait à faire
 * avancer une horloge React ; ici, c'est une fonction pure, vérifiable
 * directement — et c'est elle qui garantit qu'on ne propose **jamais** de
 * confirmer un aperçu expiré.
 *
 * `remainingMs` peut être négatif en entrée (horloge locale en retard sur le
 * serveur) : on le ramène à 0 plutôt que d'afficher une durée négative.
 */
export function previewValidity(expiresAt: string | null | undefined, now: number): PreviewValidity {
  if (!expiresAt) {
    return { state: 'unknown', remainingMs: null, label: 'Durée de validité inconnue.' };
  }
  const echeance = Date.parse(expiresAt);
  if (!Number.isFinite(echeance)) {
    return { state: 'unknown', remainingMs: null, label: 'Durée de validité inconnue.' };
  }
  const reste = Math.max(0, echeance - now);
  if (reste === 0) {
    return {
      state: 'expired',
      remainingMs: 0,
      label: 'Aperçu expiré. Relancez l’analyse du fichier pour confirmer.',
    };
  }
  const label = `Aperçu valable encore ${formaterDuree(reste)} : confirmez avant l’expiration.`;
  if (reste <= PREVIEW_WARNING_MS) {
    return { state: 'expiring', remainingMs: reste, label };
  }
  return { state: 'valid', remainingMs: reste, label };
}

/**
 * Formate une durée courte en français lisible.
 *
 * Arrondi à la seconde inférieure : afficher « 1 min » quand il reste 59 s
 * ferait confirmer l'utilisateur à une seconde de l'échec.
 */
export function formaterDuree(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const secondes = total % 60;
  if (minutes === 0) return `${secondes} s`;
  if (secondes === 0) return `${minutes} min`;
  return `${minutes} min ${secondes} s`;
}
