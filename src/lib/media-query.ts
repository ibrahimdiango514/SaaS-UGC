import { useEffect, useState } from 'react';

/**
 * Le point de rupture `sm` de Tailwind, en pixels.
 *
 * Une seule constante : les media queries CSS utilisent `sm:` et ce module s'y
 * aligne. Deux valeurs divergentes produiraient un écran où ni la liste ni le
 * tableau ne s'affichent.
 */
export const RUPTURE_SM_PX = 640;

/**
 * Vrai si la fenêtre est au moins aussi large que `requete`.
 *
 * ## Pourquoi ce hook existe
 * Certains écrans doivent afficher SOIT une liste tactile, SOIT un tableau.
 * Le faire uniquement en CSS (`sm:hidden` / `hidden sm:block`) laisse les deux
 * versions présentes dans le DOM :
 *
 *   - les lecteurs d'écran annoncent deux fois la même donnée ;
 *   - chaque ligne existe en deux exemplaires pour les tests, ce qui rend les
 *     sélecteurs ambigus ;
 *   - le tableau coûte du rendu même quand il n'est jamais visible.
 *
 * Rendre l'un OU l'autre en JavaScript supprime ces trois défauts. Le CSS reste
 * en accord (mêmes points de rupture) pour éviter tout clignotement au montage.
 *
 * ## Rendu serveur et tests
 * Sans `window.matchMedia` (jsdom, pré-rendu), la valeur par défaut est
 * `false` : on considère un petit écran. C'est le choix sûr — la liste tactile,
 * plus compacte, reste lisible partout, alors qu'un tableau large ne l'est pas.
 */
export function useRequeteMedia(requete: string, defaut = false): boolean {
  const [correspond, setCorrespond] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return defaut;
    return window.matchMedia(requete).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const liste = window.matchMedia(requete);
    const appliquer = () => setCorrespond(liste.matches);
    appliquer();
    // `addEventListener` n'existe pas sur les anciens navigateurs Android :
    // on retombe alors sur `addListener`, déprécié mais universel.
    if (typeof liste.addEventListener === 'function') {
      liste.addEventListener('change', appliquer);
      return () => liste.removeEventListener('change', appliquer);
    }
    liste.addListener(appliquer);
    return () => liste.removeListener(appliquer);
  }, [requete]);

  return correspond;
}

/** Vrai à partir de 640 px : écran assez large pour un tableau. */
export function useGrandEcran(): boolean {
  return useRequeteMedia(`(min-width: ${RUPTURE_SM_PX}px)`);
}
