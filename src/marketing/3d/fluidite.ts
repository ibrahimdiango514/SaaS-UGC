/**
 * VYORA — supervision de fluidité et rétrogradation.
 *
 * Une scène 3D peut démarrer correctement puis s'effondrer (téléphone chaud,
 * onglet en arrière-plan, pilote graphique capricieux). On mesure donc la durée
 * réelle des images pendant les deux premières secondes et on rétrograde dès que
 * le seuil est franchi, sans jamais remonter — une interface qui oscille entre
 * deux niveaux est plus dérangeante qu'une interface sobre.
 */

import type { Niveau3D } from './capacites';

/** En dessous de ce taux, la scène est jugée saccadée. */
const FPS_MIN = 40;
/** Durée de la fenêtre de mesure initiale. */
const FENETRE_MS = 2000;
/** Nombre d'images consécutives trop lentes avant de rétrograder. */
const SEUIL_IMAGES_LENTES = 12;

export interface Supervision {
  /** Arrête la mesure et libère les écouteurs. */
  stop(): void;
}

export function superviserFluidite(
  onRetrograder: (vers: Niveau3D) => void,
  niveauActuel: Niveau3D,
): Supervision {
  let raf = 0;
  let debut = 0;
  let dernier = 0;
  let imagesLentes = 0;
  let arret = false;

  const cible: Niveau3D = niveauActuel === 2 ? 1 : 0;

  const tick = (t: number) => {
    if (arret) return;
    if (debut === 0) {
      debut = t;
      dernier = t;
      raf = requestAnimationFrame(tick);
      return;
    }

    const delta = t - dernier;
    dernier = t;

    // Une image au-delà de ~33 ms signifie moins de 30 fps : saccade franche.
    if (delta > 1000 / FPS_MIN) {
      imagesLentes += 1;
      if (imagesLentes >= SEUIL_IMAGES_LENTES) {
        onRetrograder(cible);
        arret = true;
        return;
      }
    } else {
      // Une image correcte remet le compteur à zéro : on ne compte que les
      // ralentissements **consécutifs**, pas les à-coups isolés.
      imagesLentes = 0;
    }

    if (t - debut >= FENETRE_MS) {
      arret = true;
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return {
    stop() {
      arret = true;
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

/**
 * Une perte de contexte WebGL est irrécupérable proprement : on retombe au
 * niveau 0 (statique), pas au niveau 1, pour ne pas rejouer un rendu qui vient
 * d'échouer.
 */
export function surPerteContexte(canvas: HTMLCanvasElement, onPerte: () => void): () => void {
  const handler = (e: Event) => {
    e.preventDefault();
    onPerte();
  };
  canvas.addEventListener('webglcontextlost', handler);
  return () => canvas.removeEventListener('webglcontextlost', handler);
}
