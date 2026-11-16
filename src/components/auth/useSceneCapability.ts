import { useEffect, useState } from 'react';

/**
 * Détecte si l'environnement peut afficher une scène 3D.
 *
 * - `prefers-reduced-motion: reduce` → repli statique (accessibilité) ;
 * - WebGL absent (navigateur ancien, appareil bridé, jsdom) → repli statique ;
 * - `saveData` actif ou mémoire très faible → repli statique (sobriété).
 *
 * Le repli n'est pas une dégradation : `AuthStage` affiche une composition
 * CSS (anneaux + noyau lumineux) de même structure visuelle.
 */
export function useSceneCapability(): { canRender3d: boolean; reducedMotion: boolean } {
  const [state, setState] = useState({ canRender3d: false, reducedMotion: true });

  useEffect(() => {
    let reduced = false;
    try {
      reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      reduced = false;
    }

    let webgl = false;
    try {
      const canvas = document.createElement('canvas');
      webgl = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
      webgl = false;
    }

    // `deviceMemory` n'est pas standard : présent uniquement sur Chromium.
    const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const frugal = nav.connection?.saveData === true || (typeof nav.deviceMemory === 'number' && nav.deviceMemory <= 2);

    setState({ canRender3d: webgl && !reduced && !frugal, reducedMotion: reduced });
  }, []);

  return state;
}
