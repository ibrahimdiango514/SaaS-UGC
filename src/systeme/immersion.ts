import { useEffect, useState } from 'react';

/**
 * Décide du niveau d'immersion que l'appareil peut supporter.
 *
 * ## Pourquoi trois niveaux et non un booléen
 * « 3D ou pas 3D » ne suffit pas : un téléphone Android à 360 px peut afficher
 * un canvas simple mais s'effondre sur une scène lourde. Trois niveaux laissent
 * la landing vivante partout, sans jamais promettre 60 fps sur un appareil
 * qui ne peut pas les tenir.
 *
 * - `complet` : desktop capable, WebGL2, mouvement accepté → scène 3D + scroll
 *   cinématique.
 * - `allege`  : mobile ou appareil modeste → même récit, sans 3D lourde :
 *   dégradés CSS, images plus petites, transitions courtes.
 * - `statique` : WebGL absent, `prefers-reduced-motion`, mode économie de
 *   données ou mémoire faible → page entièrement lisible sans aucune animation.
 *
 * Le niveau est calculé APRÈS le montage : au rendu serveur ou dans un
 * environnement sans `window`, on ne peut rien mesurer, et deviner produirait
 * un écran blanc sur les appareils modestes.
 */
export type NiveauImmersion = 'complet' | 'allege' | 'statique';

export function useNiveauImmersion(): { niveau: NiveauImmersion; pret: boolean } {
  // Par défaut le plus sobre : si la mesure échoue, on ne casse rien.
  const [etat, setEtat] = useState<{ niveau: NiveauImmersion; pret: boolean }>({
    niveau: 'statique',
    pret: false,
  });

  useEffect(() => {
    let mouvementReduit = false;
    try {
      mouvementReduit = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      mouvementReduit = false;
    }

    let webgl2 = false;
    try {
      const canvas = document.createElement('canvas');
      webgl2 = Boolean(canvas.getContext('webgl2'));
    } catch {
      webgl2 = false;
    }

    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { saveData?: boolean; effectiveType?: string };
      hardwareConcurrency?: number;
    };
    const economieDonnees =
      nav.connection?.saveData === true || /(^|-)2g$/.test(nav.connection?.effectiveType ?? '');
    const memoireFaible = typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2;
    const coeursFaibles = typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency <= 2;

    // Mobile d'abord : un écran étroit reçoit la version allégée même s'il
    // annonce WebGL2 — un canvas plein écran y coûte trop de batterie.
    const ecranEtroit = window.matchMedia?.('(max-width: 767px)').matches ?? false;

    let niveau: NiveauImmersion;
    if (mouvementReduit || economieDonnees || memoireFaible) niveau = 'statique';
    else if (!webgl2 || ecranEtroit || coeursFaibles) niveau = 'allege';
    else niveau = 'complet';

    setEtat({ niveau, pret: true });
  }, []);

  return etat;
}

/**
 * Vrai quand l'appareil accepte le curseur personnalisé.
 *
 * Un pointeur grossier (doigt) n'a pas de survol : afficher un curseur
 * personnalisé y ajoute un élément qui ne sert à rien et peut bloquer un tap.
 * On l'exclut, ainsi que le mouvement réduit.
 */
export function useCurseurPersonnalise(): boolean {
  const [autorise, setAutorise] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const fin = window.matchMedia('(pointer: fine)');
    const survol = window.matchMedia('(hover: hover)');
    const reduit = window.matchMedia('(prefers-reduced-motion: reduce)');

    const evaluer = () => setAutorise(fin.matches && survol.matches && !reduit.matches);
    evaluer();

    const evenements: Array<[MediaQueryList, () => void]> = [
      [fin, evaluer],
      [survol, evaluer],
      [reduit, evaluer],
    ];
    for (const [liste, ecouteur] of evenements) liste.addEventListener('change', ecouteur);
    return () => {
      for (const [liste, ecouteur] of evenements) liste.removeEventListener('change', ecouteur);
    };
  }, []);

  return autorise;
}
