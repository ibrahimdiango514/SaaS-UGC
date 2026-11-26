import { useEffect, useRef } from 'react';
import { useCurseurPersonnalise } from './immersion';
import { PALETTE } from './palette';

/**
 * Curseur personnalisé — desktop uniquement.
 *
 * Règles tenues ici, et pas seulement souhaitées :
 * - Aucun rendu tant qu'un pointeur fin + survol n'est pas prouvé : sur mobile
 *   et sur tablette, le composant ne produit pas un seul nœud.
 * - `prefers-reduced-motion` désactive tout (déjà câblé dans le crochet).
 * - Le curseur système reste visible : on ajoute un halo, on ne retire jamais
 *   l'affordance native (accessible au clavier, aux lecteurs d'écran et aux
 *   utilisateurs qui ont besoin du vrai pointeur).
 * - Aucun écouteur sur `window` tant que le composant n'est pas monté, et tout
 *   est retiré au démontage.
 * - Le suivi passe par `requestAnimationFrame`, jamais par React : un état
 *   relancé à chaque `mousemove` ferait des dizaines de rendus par seconde.
 */
export function CurseurPersonnalise() {
  const autorise = useCurseurPersonnalise();
  const halo = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!autorise) return;
    const element = halo.current;
    if (!element) return;

    let frame = 0;
    let cibleX = 0;
    let cibleY = 0;
    let x = 0;
    let y = 0;

    const animer = () => {
      // Amortissement doux : le halo suit avec un léger retard, sans à-coup.
      x += (cibleX - x) * 0.18;
      y += (cibleY - y) * 0.18;
      element.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) translate(-50%, -50%)`;
      frame = window.requestAnimationFrame(animer);
    };

    const deplacer = (evenement: PointerEvent) => {
      cibleX = evenement.clientX;
      cibleY = evenement.clientY;
      element.dataset.actif = 'true';
    };

    const masquer = () => {
      element.dataset.actif = 'false';
    };

    // La mise en évidence signale les zones cliquables : c'est le seul rôle
    // informatif du halo, il ne remplace aucune affordance existante.
    const survoler = (evenement: PointerEvent) => {
      const cible = evenement.target as Element | null;
      const interactif = cible?.closest?.('a, button, [role="button"], input, select, textarea, summary');
      element.dataset.survol = interactif ? 'true' : 'false';
    };

    window.addEventListener('pointermove', deplacer, { passive: true });
    window.addEventListener('pointerover', survoler, { passive: true });
    window.addEventListener('pointerdown', survoler, { passive: true });
    document.addEventListener('pointerleave', masquer);
    frame = window.requestAnimationFrame(animer);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', deplacer);
      window.removeEventListener('pointerover', survoler);
      window.removeEventListener('pointerdown', survoler);
      document.removeEventListener('pointerleave', masquer);
    };
  }, [autorise]);

  if (!autorise) return null;

  return (
    <div
      ref={halo}
      aria-hidden="true"
      data-testid="curseur-personnalise"
      className="curseur-halo"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: 26,
        height: 26,
        borderRadius: '9999px',
        pointerEvents: 'none',
        zIndex: 70,
        opacity: 0.55,
        border: `1px solid ${PALETTE.rose}`,
        background: `radial-gradient(circle, ${PALETTE.magenta}33 0%, transparent 70%)`,
        willChange: 'transform',
      }}
    />
  );
}
