// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CurseurPersonnalise } from '../src/systeme/CurseurPersonnalise';

/**
 * Curseur personnalisé.
 *
 * Le risque de ce genre d'effet est double : (1) il s'active là où il ne faut
 * pas (mobile, mouvement réduit) et vole alors l'affordance native ; (2) il
 * laisse des écouteurs sur `window` après démontage, ce qui fuit et réveille
 * React sur une page démontée. Les deux sont testés ici.
 */

type MediaReglages = { fin: boolean; survol: boolean; reduit: boolean };

const etat: MediaReglages = { fin: true, survol: true, reduit: false };

function installerMatchMedia() {
  const original = window.matchMedia;
  window.matchMedia = ((requete: string) => {
    const correspond =
      requete.includes('pointer: fine') ? etat.fin
      : requete.includes('hover: hover') ? etat.survol
      : requete.includes('prefers-reduced-motion: reduce') ? etat.reduit
      : false;
    return {
      matches: correspond,
      media: requete,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

let restaurer: () => void;

beforeEach(() => {
  etat.fin = true;
  etat.survol = true;
  etat.reduit = false;
  restaurer = installerMatchMedia();
});

afterEach(() => {
  // `globals: false` : le nettoyage automatique de React Testing Library n'est
  // pas branché, on le fait explicitement sinon les rendus s'empilent.
  cleanup();
  restaurer();
});

describe('Curseur personnalisé', () => {
  it('n’affiche rien sur un pointeur grossier (mobile, tablette)', () => {
    etat.fin = false;
    etat.survol = false;
    render(<CurseurPersonnalise />);
    expect(screen.queryByTestId('curseur-personnalise')).toBeNull();
  });

  it('n’affiche rien quand le survol n’existe pas, même avec un pointeur fin', () => {
    etat.survol = false;
    render(<CurseurPersonnalise />);
    expect(screen.queryByTestId('curseur-personnalise')).toBeNull();
  });

  it('n’affiche rien en mouvement réduit, même sur desktop', () => {
    etat.reduit = true;
    render(<CurseurPersonnalise />);
    expect(screen.queryByTestId('curseur-personnalise')).toBeNull();
  });

  it('s’affiche sur desktop et reste décoratif (aria-hidden, sans capture du pointeur)', () => {
    render(<CurseurPersonnalise />);
    const halo = screen.getByTestId('curseur-personnalise');
    expect(halo.getAttribute('aria-hidden')).toBe('true');
    // Le curseur système doit rester utilisable : le halo ne capte aucun clic.
    expect(halo.style.pointerEvents).toBe('none');
    // Un halo ajouté ne doit jamais retirer le curseur natif.
    expect(document.body.style.cursor).not.toBe('none');
  });

  it('suit le pointeur sans provoquer de rendu React', () => {
    const frames: FrameRequestCallback[] = [];
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((rappel: FrameRequestCallback) => {
      frames.push(rappel);
      return frames.length;
    }) as typeof window.requestAnimationFrame;

    try {
      render(<CurseurPersonnalise />);
      act(() => {
        window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 120, clientY: 80 }));
      });
      const halo = screen.getByTestId('curseur-personnalise');
      expect(halo.dataset.actif).toBe('true');
      // Une première image doit avoir été demandée par la boucle d'animation.
      expect(frames.length).toBeGreaterThan(0);
    } finally {
      window.requestAnimationFrame = originalRaf;
    }
  });

  it('retire tous ses écouteurs au démontage', () => {
    const retires: string[] = [];
    const original = window.removeEventListener.bind(window);
    // On ne remplace que ce qui nous intéresse : enregistrer le type retiré.
    const espion = (type: string, ...reste: unknown[]) => {
      retires.push(type);
      original(type, ...(reste as [EventListenerOrEventListenerObject]));
    };
    window.removeEventListener = espion as typeof window.removeEventListener;

    try {
      const { unmount } = render(<CurseurPersonnalise />);
      unmount();
    } finally {
      window.removeEventListener = original;
    }

    expect(retires).toContain('pointermove');
    expect(retires).toContain('pointerover');
  });
});
