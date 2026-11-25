import { useEffect } from 'react';

/**
 * Hauteur réelle du clavier virtuel, publiée en CSS.
 *
 * ## Le problème qu'il résout
 * Sur Android, quand le clavier s'ouvre, le navigateur ne redimensionne pas
 * toujours la page : une modale en `70vh` garde sa hauteur et son bouton
 * « Enregistrer » se retrouve DERRIÈRE le clavier. L'utilisateur remplit le
 * formulaire et ne peut plus le valider — c'est un blocage total du parcours
 * de création, et c'est exactement ce qui remontait des tests Android.
 *
 * ## La mesure
 * On compare la hauteur de la fenêtre VISUELLE (`visualViewport`, qui rétrécit
 * quand le clavier apparaît) à la hauteur de la mise en page. L'écart est la
 * place prise par le clavier.
 *
 * Ce choix évite `window.innerHeight`, qui reste inchangé sur de nombreux
 * navigateurs Android et donnerait 0 en permanence.
 *
 * ## Ce qui est écrit
 * Une seule variable CSS, `--clavier-hauteur`, consommée par les classes
 * `.modale-clavier*` et `.champ-actif-visible` (src/index.css). Aucune valeur
 * devinée : clavier fermé, la variable vaut 0 et rien ne bouge.
 *
 * ## Limites assumées
 * - Sur navigateur de bureau, `visualViewport` ne change pas : 0 partout.
 * - Un petit écart (< 120 px) est ignoré : c'est une barre d'outils qui
 *   apparaît, pas un clavier, et réserver cette place ferait sauter l'interface.
 * - Ce module ne devine pas QUEL champ est actif ; il rend la place disponible
 *   et `champ-actif-visible` fait défiler le champ dans cette place.
 */
export const SEUIL_CLAVIER_PX = 120;

/** Hauteur du clavier en pixels, 0 si aucun clavier n'est ouvert. */
export function hauteurClavier(
  hauteurVisuelle: number | undefined,
  hauteurMiseEnPage: number | undefined,
  seuil: number = SEUIL_CLAVIER_PX,
): number {
  if (!hauteurVisuelle || !hauteurMiseEnPage) return 0;
  const ecart = hauteurMiseEnPage - hauteurVisuelle;
  // Un écart négatif (zoom, barre repliable) n'est pas un clavier.
  return ecart > seuil ? Math.round(ecart) : 0;
}

/**
 * Branche la mesure sur `visualViewport` et l'écrit dans `--clavier-hauteur`.
 *
 * À appeler une fois, au niveau de l'application (voir `Layout`). Le nettoyage
 * retire la variable : aucun état résiduel entre deux écrans.
 */
export function useViewportClavier(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vue = window.visualViewport;
    const racine = document.documentElement;

    const appliquer = () => {
      const hauteur = hauteurClavier(vue?.height, window.innerHeight);
      racine.style.setProperty('--clavier-hauteur', `${hauteur}px`);
      // Marqueur exploité par les styles de repli et les tests.
      racine.dataset.clavierOuvert = hauteur > 0 ? 'oui' : 'non';
    };

    appliquer();
    // `resize` suffit sur les navigateurs récents ; `scroll` couvre Android
    // lorsque seule la position de la vue visuelle change.
    vue?.addEventListener('resize', appliquer);
    vue?.addEventListener('scroll', appliquer);
    window.addEventListener('resize', appliquer);
    window.addEventListener('orientationchange', appliquer);

    return () => {
      vue?.removeEventListener('resize', appliquer);
      vue?.removeEventListener('scroll', appliquer);
      window.removeEventListener('resize', appliquer);
      window.removeEventListener('orientationchange', appliquer);
      racine.style.removeProperty('--clavier-hauteur');
      delete racine.dataset.clavierOuvert;
    };
  }, []);
}
