/**
 * Progrès partagé entre le défilement (DOM) et la scène 3D.
 *
 * ## Pourquoi un objet mutable et pas un état React
 * Le progrès change à chaque image (60 fois par seconde). Le passer par
 * `useState` re-rendrait tout l'arbre React à 60 Hz : c'est exactement le
 * genre de choix qui fait tomber une landing à 23 fps. La 3D lit `lireProgres`
 * dans sa boucle de rendu ; seul le texte des panneaux (3 à 4 changements par
 * scène) passe par React.
 */
export type PhaseExperience = 'hero' | 'transition' | 'studio';

export const storeExperience = { progres: 0 };

export function ecrireProgres(valeur: number): void {
  storeExperience.progres = valeur;
}

export function lireProgres(): number {
  return storeExperience.progres;
}

/** Phase du récit, pour les panneaux HTML. */
export function phaseExperience(progres: number): PhaseExperience {
  if (progres < 0.15) return 'hero';
  if (progres < 0.22) return 'transition';
  return 'studio';
}
