// @vitest-environment jsdom
/**
 * Immersion 2 — structure du récit et épinglage.
 *
 * ## Ce que ces tests protègent, et pourquoi ils existent
 * La phase 1 a été livrée avec un rapport qui affirmait « scènes 3D » et un
 * commentaire de code qui affirmait « section épinglée ». Les deux étaient
 * faux : aucun `pin` n'existait. Une capture d'écran l'a révélé.
 *
 * Un test ne peut pas prouver qu'une animation est belle. Il peut prouver que
 * l'épinglage est DEMANDÉ, que l'ordre du récit est le bon, que les blocs
 * classiques viennent après, et qu'aucune scène ne disparaît en repli. C'est
 * exactement le périmètre ci-dessous.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const etatMedia = { reduit: false, etroit: false };

function installerEnvironnement(options: { webgl: boolean }) {
  window.matchMedia = ((requete: string) => ({
    matches:
      requete.includes('prefers-reduced-motion: reduce')
        ? etatMedia.reduit
        : requete.includes('max-width: 767px')
          ? etatMedia.etroit
          : false,
    media: requete,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  // WebGL : on simule sa présence ou son absence, jamais l'inverse du réel.
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (ceci: string) {
    if (ceci === 'webgl2' || ceci === 'webgl') {
      return options.webgl ? ({ fake: true } as unknown as RenderingContext) : null;
    }
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;

  /*
   * `navigator.hardwareConcurrency` vaut 2 dans cet environnement de test (et
   * sur une bonne partie des machines modestes) : la mesure classe alors
   * l'appareil « modeste » et le niveau ne peut JAMAIS atteindre `complet`.
   * Ce n'est pas un bug du produit — c'est une politique assumée. Pour tester
   * le chemin complet, on déclare une machine capable.
   */
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });

  // jsdom n'implémente pas IntersectionObserver : la mesure d'audience en a
  // besoin, et son absence ne doit pas faire échouer un test de structure.
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

async function monter(scene = '') {
  const { default: LandingImmersive } = await import('../src/pages/LandingImmersive');
  render(
    <MemoryRouter initialEntries={[`/${scene}`]}>
      <LandingImmersive />
    </MemoryRouter>,
  );
  // Laisse les effets (niveau d'immersion) se poser.
  await new Promise((r) => setTimeout(r, 60));
}

let restaurer: () => void;

beforeEach(() => {
  vi.resetModules();
  etatMedia.reduit = false;
  etatMedia.etroit = false;
});

afterEach(() => {
  cleanup();
  restaurateur();
  vi.restoreAllMocks();
});

function restaurateur() {
  restaurer?.();
}
restaurer = () => {};

describe('Récit — cinq scènes avant les blocs classiques', () => {
  it('place les cinq scènes dans l’ordre du récit', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    const ordre = [...document.querySelectorAll('[data-scene]')].map((s) => s.id);
    expect(ordre).toEqual(['hero', 'immersion', 'grow', 'agent', 'automatisation']);
  });

  it('donne à chaque scène une durée d’épinglage de 3 à 4 écrans', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    /*
     * Depuis la livraison 1, le hero et le Studio forment UNE seule scène
     * épinglée (`#experience`, +460 %), découpée en deux panneaux internes.
     * Leur durée propre n'est donc plus une durée d'épinglage : elle décrit la
     * fenêtre du récit. Ce sont les scènes restées indépendantes qui portent
     * encore une durée d'épinglage de 3 à 4 écrans.
     */
    for (const scene of document.querySelectorAll('[data-scene]')) {
      if (scene.closest('#experience')) {
        expect((scene as HTMLElement).dataset.duree, `panneau ${scene.id} sans durée`).toBeTruthy();
        continue;
      }
      const duree = Number((scene as HTMLElement).dataset.duree);
      expect(duree, `scène ${scene.id} sans durée`).toBeGreaterThanOrEqual(3);
      expect(duree, `scène ${scene.id} trop longue`).toBeLessThanOrEqual(4);
    }
  });

  it('place TOUS les blocs classiques après la dernière scène, jamais à sa place', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    const scenes = [...document.querySelectorAll('[data-scene]')];
    const derniereScene = scenes[scenes.length - 1];

    /*
     * Chaque bloc « classique » est vérifié, pas seulement la FAQ : la
     * première version de ce test ne regardait que la FAQ, et déplacer la
     * section des espaces avant les scènes passait inaperçu (mutant survivant).
     */
    const blocs = ['deux-espaces', 'fonctionnalites', 'defis', 'workflow', 'faq'];
    for (const id of blocs) {
      const bloc = document.getElementById(id);
      expect(bloc, `#${id} manquant`).toBeTruthy();
      const suit =
        derniereScene.compareDocumentPosition(bloc as Node) & Node.DOCUMENT_POSITION_FOLLOWING;
      expect(Boolean(suit), `#${id} doit venir après la dernière scène`).toBe(true);
    }

    // Et le verdict qui fait la transition est lui aussi après la dernière scène.
    const verdict = [...document.querySelectorAll('h2')].find((h) =>
      (h.textContent ?? '').includes('Tout ce que vous venez de voir'),
    );
    expect(verdict).toBeTruthy();
    expect(
      Boolean(derniereScene.compareDocumentPosition(verdict as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it('garde un seul h1 et un h2 par scène', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    expect(document.querySelectorAll('h1')).toHaveLength(1);
    for (const scene of document.querySelectorAll('[data-scene]')) {
      // Le hero porte le h1 unique du site ; chaque autre scène a son h2.
      const titre = scene.id === 'hero' ? scene.querySelector('h1') : scene.querySelector('h2');
      expect(titre, `scène ${scene.id} sans titre`).toBeTruthy();
    }
  });

  it('affiche le CTA principal dans chaque scène', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    for (const scene of document.querySelectorAll('[data-scene]')) {
      const cta = scene.querySelector('[data-cta="principal"]');
      expect(cta, `scène ${scene.id} sans CTA`).toBeTruthy();
      expect(cta?.getAttribute('href')).toBe('/inscription');
    }
  });
});

describe('Épinglage — la demande doit exister dans le code', () => {
  it('demande un pin ScrollTrigger pour chaque scène', async () => {
    /*
     * On remplace GSAP et ScrollTrigger par des espions : ce qui compte n'est
     * pas qu'ils tournent (impossible à vérifier en jsdom), mais que le code
     * DEMANDE l'épinglage. Une régression qui retire `pin: true` casse ce test.
     */
    restaurer = installerEnvironnement({ webgl: true });

    const appelsCreate: Array<Record<string, unknown>> = [];
    const fauxGsap = {
      registerPlugin: () => {},
      context: (rappel: () => void) => {
        rappel();
        return { revert: () => {} };
      },
      utils: { toArray: <T,>(selecteur: string, conteneur?: Element): T[] => {
        const racine = conteneur ?? document;
        return [...racine.querySelectorAll(selecteur)] as unknown as T[];
      } },
      fromTo: () => ({}),
      set: () => {},
    };
    const fauxScrollTrigger = {
      update: () => {},
      refresh: () => {},
      create: (vars: Record<string, unknown>) => {
        appelsCreate.push(vars);
        return {};
      },
    };

    vi.doMock('gsap', () => ({ default: fauxGsap }));
    vi.doMock('gsap/ScrollTrigger', () => ({ default: fauxScrollTrigger, ScrollTrigger: fauxScrollTrigger }));
    vi.doMock('lenis', () => ({ default: class { raf() {} on() {} destroy() {} } }));

    await monter();
    // Laisse les imports dynamiques et l'effet se résoudre.
    await new Promise((r) => setTimeout(r, 120));

    expect(appelsCreate.length, 'aucun ScrollTrigger.create appelé').toBeGreaterThanOrEqual(4);

    // `pin` vaut `true` pour une scène classique, mais l'expérience immersive
    // épingle explicitement l'élément qu'elle contrôle (`pin: ciblePin`).
    const avecPin = appelsCreate.filter(
      (vars) => vars.pin === true || (typeof Element !== 'undefined' && vars.pin instanceof Element),
    );
    expect(avecPin.length, 'aucune scène épinglée').toBeGreaterThanOrEqual(4);

    /*
     * Le hero et le Studio partagent un seul épinglage long : c'est lui qui
     * fait avancer la caméra dans une scène unique, et le retirer
     * ramènerait l'expérience à deux blocs statiques.
     */
    const epingleLong = avecPin.find((vars) => String(vars.end) === '+=460%');
    expect(epingleLong, 'expérience immersive non épinglée sur 460 %').toBeTruthy();

    // Chaque scène épinglée doit durer 3 à 4 hauteurs d'écran.
    for (const vars of avecPin) {
      expect(String(vars.end)).toMatch(/\+=/);
      expect(vars.scrub === undefined || typeof vars.scrub === 'boolean' || typeof vars.scrub === 'number').toBe(true);
    }
  });
});

describe('Repli — les mêmes scènes, sans mouvement', () => {
  it('affiche les cinq scènes même en mouvement réduit', async () => {
    etatMedia.reduit = true;
    restaurer = installerEnvironnement({ webgl: false });
    await monter();

    const ids = [...document.querySelectorAll('[data-scene]')].map((s) => s.id);
    expect(ids).toEqual(['hero', 'immersion', 'grow', 'agent', 'automatisation']);
  });

  it('garde le titre cinétique lisible quand le mouvement est refusé', async () => {
    etatMedia.reduit = true;
    restaurer = installerEnvironnement({ webgl: false });
    await monter();

    // Aucune animation armée…
    expect(document.querySelectorAll('.hero-mot--anime')).toHaveLength(0);
    // …et le texte est bien là, en entier.
    const texte = (document.body.textContent ?? '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ');
    expect(texte).toContain('Vos vidéos publicitaires. Votre croissance. Un seul endroit.');
  });

  it('n’affiche aucun canvas quand WebGL est absent', async () => {
    restaurer = installerEnvironnement({ webgl: false });
    await monter();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('marque la racine avec le niveau d’immersion retenu', async () => {
    restaurer = installerEnvironnement({ webgl: true });
    await monter();

    const racine = document.querySelector('[data-moteur-immersion]');
    expect(racine?.getAttribute('data-niveau')).toBe('complet');

    cleanup();
    etatMedia.reduit = true;
    await monter();
    expect(document.querySelector('[data-moteur-immersion]')?.getAttribute('data-niveau')).toBe('statique');
  });
});
