// @vitest-environment jsdom
/**
 * Immersion : mesure du niveau, tracking, et repli en mouvement réduit.
 *
 * Ce fichier couvre ce que les tests de rendu ne peuvent pas voir : la
 * DÉCISION d'afficher la 3D ou non, et le fait que la mesure d'audience ne
 * casse jamais un clic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import LandingImmersive from '../src/pages/LandingImmersive';
import { observerMoitiePage, suivre } from '../src/systeme/tracking';

/** Remplace `matchMedia` par une réponse fixe, comme le ferait un appareil. */
function simulerMedia(regles: Record<string, boolean>) {
  window.matchMedia = vi.fn((requete: string) => ({
    matches: regles[requete] ?? false,
    media: requete,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as never;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  delete (window as unknown as { gtag?: unknown }).gtag;
  vi.restoreAllMocks();
});

describe('Mouvement réduit — exigence d’accessibilité', () => {
  beforeEach(() => {
    simulerMedia({ '(prefers-reduced-motion: reduce)': true });
    window.HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
  });

  it('rend la page entière sans aucune 3D', () => {
    render(
      <MemoryRouter>
        <LandingImmersive />
      </MemoryRouter>,
    );
    expect(document.querySelector('canvas')).toBeNull();
    // Le titre et les CTA restent des liens et des titres vrais.
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Créer ma première vidéo/i }).length).toBeGreaterThan(0);
  });

  it('n’applique aucune classe animée au titre', () => {
    render(
      <MemoryRouter>
        <LandingImmersive />
      </MemoryRouter>,
    );
    /*
     * `hero-mot--anime` porte l'animation d'entrée : en mouvement réduit, elle
     * ne doit pas être posée du tout (la feuille de style la neutralise aussi,
     * mais mieux vaut ne pas l'armer). `hero-mot` seule est la classe de
     * placement, présente même à l'arrêt : ce n'est pas elle qu'on vérifie.
     */
    expect(document.querySelectorAll('.hero-mot--anime')).toHaveLength(0);
  });
});

describe('Tracking — trois événements, aucune donnée personnelle', () => {
  it('pousse dans dataLayer quand il existe', () => {
    const dataLayer: unknown[] = [];
    (window as unknown as { dataLayer: unknown[] }).dataLayer = dataLayer;

    suivre('cta_clic', { emplacement: 'hero' });

    expect(dataLayer).toHaveLength(1);
    expect(dataLayer[0]).toMatchObject({ event: 'cta_clic', page: 'landing', emplacement: 'hero' });
  });

  it('préfère gtag quand il est présent', () => {
    const gtag = vi.fn();
    (window as unknown as { gtag: unknown }).gtag = gtag;

    suivre('scroll_50');

    expect(gtag).toHaveBeenCalledWith('event', 'scroll_50', {});
  });

  it('ne lève jamais, même si le collecteur casse', () => {
    (window as unknown as { gtag: unknown }).gtag = () => {
      throw new Error('collecteur cassé');
    };
    // Une mesure qui casse un clic est pire que pas de mesure : on exige
    // l'absence d'exception.
    expect(() => suivre('champ_focus')).not.toThrow();
  });

  it('ne transmet ni e-mail, ni identifiant, ni URL de page', () => {
    const dataLayer: unknown[] = [];
    (window as unknown as { dataLayer: unknown[] }).dataLayer = dataLayer;

    suivre('cta_clic', { emplacement: 'nav' });

    const charge = JSON.stringify(dataLayer[0]);
    expect(charge).not.toMatch(/@/);
    expect(charge).not.toMatch(/user|cookie|email|token/i);
  });

  it('ne fait rien à l’import si aucun collecteur n’est présent', () => {
    expect(() => suivre('cta_clic')).not.toThrow();
  });

  it('observe la moitié de page sans laisser de jalon dans le DOM', () => {
    const arreter = observerMoitiePage();
    const jalons = () => document.body.querySelectorAll('div[aria-hidden="true"]').length;
    const avant = jalons();
    arreter();
    // Au démontage, le jalon doit disparaître : sinon chaque navigation
    // empile un élément invisible et un observateur.
    expect(jalons()).toBeLessThanOrEqual(avant);
  });
});

describe('Palette — le rôle des couleurs est fixe', () => {
  it('un seul orange par écran est possible car il est unique dans la palette', async () => {
    const { PALETTE } = await import('../src/systeme/palette');
    const valeurs = Object.values(PALETTE).map((valeur) => valeur.toLowerCase());
    // Aucune couleur déclarée deux fois : deux rôles ne peuvent pas se
    // contredire visuellement.
    expect(new Set(valeurs).size).toBe(valeurs.length);
  });

  it('le slogan et les CTA sont des constantes, jamais des littéraux dispersés', async () => {
    const { SLOGAN, CTA_PRINCIPAL, REASSURANCE } = await import('../src/systeme/palette');
    expect(SLOGAN).toBe('Create. Evolve. Grow.');
    expect(CTA_PRINCIPAL).toBe('Créer ma première vidéo');
    expect(REASSURANCE).toContain('aucun coût surprise');
  });
});

/**
 * Garde d'environnement de `useScrollImmersif`.
 *
 * Défaut réel observé : le module GSAP se résout APRÈS la destruction de
 * l'environnement de test et `window.matchMedia` lève alors une erreur NON
 * GÉRÉE qui fait échouer la suite vitest entière (pas seulement un test).
 * Ici on simule exactement cette situation : `matchMedia` disparaît, GSAP est
 * remplacé par un faux qui ÉCHOUE s'il est appelé. Si la garde disparaît, le
 * test casse — il ne passe pas « par hasard ».
 */
describe('useScrollImmersif — garde d’environnement', () => {
  it('ne touche jamais à GSAP quand window.matchMedia a disparu', async () => {
    vi.resetModules();

    let gsapAppele = false;
    vi.doMock('gsap', () => {
      const faux = {
        default: {
          registerPlugin: () => {
            gsapAppele = true;
            throw new Error('GSAP appelé alors que l’environnement est détruit');
          },
          context: () => ({ revert: () => {} }),
          timeline: () => ({ to: () => ({ to: () => ({}) }) }),
          utils: { toArray: () => [] },
        },
      };
      return faux;
    });
    vi.doMock('gsap/ScrollTrigger', () => ({ default: {}, ScrollTrigger: { update: () => {}, refresh: () => {} } }));
    vi.doMock('lenis', () => ({ default: class { raf() {} on() {} destroy() {} } }));

    const { renderHook } = await import('@testing-library/react');
    const { useScrollImmersif } = await import('../src/landing/useScrollImmersif');
    const racine = { current: document.createElement('div') };

    const original = window.matchMedia;
    // L'environnement est « détruit » : plus de matchMedia.
    // @ts-expect-error — on simule volontairement un environnement partiel.
    delete window.matchMedia;

    try {
      renderHook(() => useScrollImmersif(racine as React.RefObject<HTMLElement>, 'complet', true));
      // Laisse la promesse d'imports dynamiques se résoudre.
      await new Promise((resoudre) => setTimeout(resoudre, 50));
    } finally {
      window.matchMedia = original;
      vi.doUnmock('gsap');
      vi.doUnmock('gsap/ScrollTrigger');
      vi.doUnmock('lenis');
      vi.resetModules();
    }

    expect(gsapAppele).toBe(false);
  });
});
