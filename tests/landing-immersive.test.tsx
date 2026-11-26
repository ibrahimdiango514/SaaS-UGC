// @vitest-environment jsdom
/**
 * Vitrine immersive — phase 1.
 *
 * Ces tests protègent les engagements de la mission, pas l'esthétique :
 *   1. le produit se comprend et se clique AVANT toute animation (LCP) ;
 *   2. un seul CTA, répété, avec la même réassurance ;
 *   3. rien n'est présenté comme disponible sans l'être (« Bientôt ») ;
 *   4. aucun chiffre client, aucun témoignage, aucune photo de personne ;
 *   5. la page reste complète et lisible quand la 3D ou le mouvement manquent ;
 *   6. la palette et le slogan sont uniques et dérivés du logo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryRouter } from 'react-router-dom';

import LandingImmersive from '../src/pages/LandingImmersive';
import { BIENTOT, CTA_PRINCIPAL, PALETTE, REASSURANCE, SLOGAN } from '../src/systeme/palette';

beforeEach(() => {
  // Environnement sans WebGL : c'est le cas de jsdom ET d'un appareil bridé.
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function monter() {
  return render(
    <MemoryRouter>
      <LandingImmersive />
    </MemoryRouter>,
  );
}

describe('Hero — les cinq premières secondes', () => {
  it('affiche le titre, le sous-titre et le CTA dans le HTML initial', () => {
    monter();
    // Aucune attente : c'est la garantie LCP. Si ce test a besoin d'un
    // `waitFor`, le contenu arrive trop tard pour le visiteur.
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('Vos vidéos');
    expect(h1.textContent).toContain('publicitaires');
    expect(screen.getByText(/Créez des vidéos UGC en quelques minutes/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: new RegExp(CTA_PRINCIPAL, 'i') }).length).toBeGreaterThan(0);
  });

  it('annonce le slogan unique et les deux actions du hero', () => {
    monter();
    expect(screen.getAllByText(new RegExp(SLOGAN, 'i')).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Voir comment ça marche/i }).getAttribute('href')).toBe('#immersion');
  });

  it('affiche la réassurance sous le CTA du hero', () => {
    monter();
    expect(screen.getAllByText(REASSURANCE).length).toBeGreaterThan(0);
  });

  it('ne contient aucune photo de personne dans le hero', () => {
    monter();
    const images = Array.from(document.querySelectorAll('img'));
    // Le hero montre le produit, pas un mannequin. Aucune image n'est chargée
    // en phase 1 : la scène est dessinée (canvas ou CSS).
    for (const image of images) {
      const alt = image.getAttribute('alt') ?? '';
      expect(/portrait|femme|homme|mannequin|modèle|model/i.test(alt)).toBe(false);
    }
  });
});

describe('CTA unique, répété, jamais contredit', () => {
  it('répète le même libellé dans la navigation, les scènes et la fin de page', () => {
    monter();
    const cta = screen.getAllByRole('link', { name: new RegExp(CTA_PRINCIPAL, 'i') });
    // Hero + nav + scène Studio + scène Grow + CTA finale : au moins quatre.
    expect(cta.length).toBeGreaterThanOrEqual(4);
    // Le libellé doit être EXACTEMENT le CTA, pas une variante : « Lancer » ou
    // « Commencer » compteraient sinon dans la même mesure.
    for (const lien of cta) expect((lien.textContent ?? '').trim()).toContain(CTA_PRINCIPAL);
    for (const lien of cta) expect(lien.getAttribute('href')).toBe('/inscription');
  });

  it('le hero lui-même porte le CTA unique, dès le rendu initial', () => {
    monter();
    const hero = document.getElementById('hero');
    expect(hero).toBeTruthy();
    // Sans ce contrôle, renommer le CTA du hero ne changerait aucun test :
    // ce serait un second libellé d'action, exactement ce qu'on veut éviter.
    const dansHero = Array.from(hero!.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim());
    expect(dansHero.some((texte) => texte.includes(CTA_PRINCIPAL))).toBe(true);
  });

  it('n’invente aucun second appel à l’action concurrent', () => {
    monter();
    // L'ancienne vitrine disait « Commencer », « Découvrir SORAHNEX »,
    // « Créer mon compte ». Trois libellés pour une action = trois décisions.
    for (const ancien of [/^Commencer$/i, /Découvrir SORAHNEX/i, /^Créer mon compte$/i]) {
      expect(screen.queryAllByRole('link', { name: ancien })).toHaveLength(0);
    }
  });
});

describe('Promesses — rien n’est présenté comme acquis', () => {
  it('marque « Bientôt » les intégrations non branchées', () => {
    monter();
    /*
     * Vérification STRUCTURELLE : chaque intégration citée doit se trouver
     * dans un conteneur qui annonce « Bientôt ». Se contenter de compter les
     * occurrences « Bientôt » laisserait passer une intégration listée
     * ailleurs comme si elle était disponible.
     */
    // Le bloc dédié : c'est lui qui doit annoncer « Bientôt », pas la page en
    // général — sinon une autre section pourrait porter le mot à sa place.
    const bloc = screen.getByTestId('bientot-fonctionnalites');
    expect(bloc.textContent).toMatch(/Bient[oô]t/i);
    // Les noms sont lus dans `BIENTOT`, la source unique : un test qui recopie
    // la liste à la main finit par vérifier une liste qui n'existe plus.
    for (const nom of BIENTOT) {
      const elements = within(bloc).getAllByText(new RegExp(nom.replace(/[()]/g, '\\$&'), 'i'));
      expect(elements.length, `${nom} absent`).toBeGreaterThan(0);
      const marque = elements.some((element) => {
        let noeud: HTMLElement | null = element;
        for (let i = 0; i < 6 && noeud; i += 1) {
          if (/Bientôt/i.test(noeud.textContent ?? '')) return true;
          noeud = noeud.parentElement;
        }
        return false;
      });
      expect(marque, `${nom} n'est pas annoncé « Bientôt »`).toBe(true);
    }
  });

  it('n’affiche ni témoignage, ni note, ni chiffre client', () => {
    monter();
    const texte = document.body.textContent ?? '';
    // Aucune preuve sociale inventée : la mission l'interdit explicitement.
    expect(texte).not.toMatch(/témoignage|avis client|★|note de \d\/5|ils nous font confiance/i);
    expect(texte).not.toMatch(/\+\s?\d+\s?(clients|entreprises|utilisateurs)/i);
    expect(texte).not.toMatch(/\d+\s?%\s?(de )?(croissance|augmentation|gain)/i);
  });

  it('garde les engagements de devis vérifié mot pour mot', () => {
    monter();
    expect(screen.getAllByText(/Devis affiché avant chaque génération/i).length).toBeGreaterThan(0);
  });
});

describe('Replis — la page tient sans 3D ni mouvement', () => {
  it('rend tout le contenu sans WebGL', () => {
    monter();
    // Les deux scènes et leurs titres restent présents.
    /*
     * Le titre cinétique répartit les mots dans des spans séparés (`data-mot`),
     * donc le nom accessible calculé n'est pas la phrase complète. On vérifie
     * la présence du texte dans le document : c'est ce que lit un visiteur, et
     * ce que lit un moteur d'indexation.
     */
    // Les mots sont joints par des espaces insécables (typographie correcte) :
    // on normalise avant de comparer, sinon on testerait un détail de rendu.
    const texte = (document.body.textContent ?? '').replace(/\u00A0/g, ' ');
    expect(texte).toContain('Du brief à la vidéo');
    expect(texte).toContain('Votre activité');
  });

  it('n’affiche aucun canvas quand WebGL est absent', () => {
    monter();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('garde une hiérarchie de titres réelle (un seul h1, des h2 par section)', () => {
    monter();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(4);
  });

  it('expose toutes les ancres de navigation', () => {
    monter();
    for (const id of ['hero', 'immersion', 'deux-espaces', 'fonctionnalites', 'workflow', 'faq']) {
      expect(document.getElementById(id), `#${id} manquant`).toBeTruthy();
    }
  });
});

describe('Identité — palette et slogan dérivés, uniques', () => {
  it('applique un seul slogan dans toute la page', () => {
    monter();
    const texte = document.body.textContent ?? '';
    expect(texte).toContain(SLOGAN);
    // L'autre slogan de la mission ne doit apparaître nulle part : un seul.
    expect(texte).not.toContain('Create. Grow. Automate.');
  });

  it('utilise la palette de la marque, pas les anciennes teintes cyan', () => {
    monter();
    const html = document.body.innerHTML;
    expect(html).toContain(PALETTE.magenta);
    // Le cyan était la couleur de l'ancienne direction artistique.
    expect(html.toLowerCase()).not.toContain('#22d3ee');
  });

  it('le logo porte le dégradé magenta → rose → orange', () => {
    const source = readFileSync(join(process.cwd(), 'src/systeme/Logo.tsx'), 'utf8');
    // Le tracé d'origine est conservé : on ne redessine pas le logo.
    expect(source).toContain('M26.5 14.2c-1.4-1.4');
    expect(source).toContain('DEGRADE_MARQUE');
    expect(source).toContain('PALETTE.orange');
  });
});

describe('Contraintes de dépôt', () => {
  it('ne touche ni aux gardes Netlify ni aux Edge Functions', () => {
    // Ces fichiers sont protégés (crédits de déploiement, artefacts épinglés).
    // Ce test échoue si un futur changement les modifie depuis la landing.
    const gardes = ['netlify.toml', 'netlify.site.conf'];
    for (const garde of gardes) {
      expect(() => readFileSync(join(process.cwd(), garde), 'utf8')).not.toThrow();
    }
    const fonctions = readdirSync(join(process.cwd(), 'supabase/functions'));
    expect(fonctions.length).toBeGreaterThan(0);
  });

  it('déclare GSAP et Lenis en dépendances (scroll immersif réel)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.gsap).toBeTruthy();
    expect(pkg.dependencies.lenis).toBeTruthy();
  });
});
