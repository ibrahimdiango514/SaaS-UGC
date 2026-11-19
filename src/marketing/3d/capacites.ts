/**
 * VYORA — détection des capacités de l'appareil pour la 3D adaptative.
 *
 * ## Ce que ce module ne fait jamais
 *
 * Il ne regarde **jamais** le nom du modèle. Un « Samsung A14 » peut être
 * fluide ; un « Pixel 9 » peut être bridé par le mode économie. On n'évalue que
 * des capacités mesurables.
 *
 * ## Les trois niveaux
 *
 *   0 — statique : visuel pré-rendu + dégradés CSS. Aucun WebGL.
 *   1 — 2,5D     : couches parallaxe CSS/SVG. Pas de WebGL, coût quasi nul.
 *   2 — WebGL    : scène 3D légère, uniquement sur appareil capable.
 *
 * Le niveau de départ est calculé ici ; il peut ensuite être **rétrogradé** en
 * cours de route si la fluidité mesurée est insuffisante (`niveau.ts`).
 */

export type Niveau3D = 0 | 1 | 2;

export interface Capacites {
  webgl: boolean;
  /** Mémoire approximative en Go, si le navigateur l'expose. */
  deviceMemory: number | null;
  coeurs: number | null;
  /** Économie de données activée par l'utilisateur. */
  saveData: boolean;
  /** Type de connexion estimé : 'slow-2g' | '2g' | '3g' | '4g' | null. */
  effectiveType: string | null;
  /** L'utilisateur a demandé à réduire les animations. */
  mouvementReduit: boolean;
  /** Largeur de la fenêtre en px CSS. */
  largeur: number;
  /** Le navigateur est en ligne. */
  enLigne: boolean;
}

function detecterWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return false;
    // Un contexte logiciel (SwiftShader) renvoie souvent un renderer générique ;
    // on l'accepte quand même mais le test de fluidité tranchera.
    return true;
  } catch {
    return false;
  }
}

export function detecterCapacites(): Capacites {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  return {
    webgl: typeof document !== 'undefined' ? detecterWebGL() : false,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    coeurs: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    saveData: Boolean(nav.connection?.saveData),
    effectiveType: nav.connection?.effectiveType ?? null,
    mouvementReduit:
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false,
    largeur: typeof window !== 'undefined' ? window.innerWidth : 1024,
    enLigne: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
  };
}

/**
 * Niveau de départ.
 *
 * Volontairement pessimiste : le niveau 2 est un privilège, pas un défaut. Une
 * landing qui saccade sur un téléphone d'entrée de gamme coûte plus de clients
 * qu'une landing sobre.
 */
export function niveauInitial(c: Capacites): Niveau3D {
  // 1. Empêchements absolus.
  if (!c.webgl) return 0;
  if (c.mouvementReduit) return 0;
  if (!c.enLigne) return 0; // hors ligne : rien ne doit tenter de charger
  if (c.saveData) return 0;

  // 2. Réseau et écran : en dessous de ces seuils, la 2,5D suffit largement.
  const reseauFaible =
    c.effectiveType === 'slow-2g' || c.effectiveType === '2g' || c.effectiveType === '3g';
  if (reseauFaible) return 1;
  if (c.largeur < 380) return 1;

  // 3. Appareil : sans signal fiable, on ne tente pas le WebGL.
  const memoireInconnue = c.deviceMemory === null;
  const memoireFaible = c.deviceMemory !== null && c.deviceMemory < 4;
  const peuDeCoeurs = c.coeurs !== null && c.coeurs < 4;
  if (memoireFaible) return 1;
  if (peuDeCoeurs) return 1;
  // Beaucoup de Safari iOS n'expose pas deviceMemory : on reste prudent (2,5D)
  // sauf si le reste de l'appareil est clairement confortable.
  if (memoireInconnue && (c.coeurs === null || c.coeurs < 6)) return 1;

  return 2;
}

/** Libellé lisible, utile en développement et dans les tests. */
export const NIVEAU_LABEL: Record<Niveau3D, string> = {
  0: 'statique',
  1: '2,5D',
  2: 'WebGL',
};
