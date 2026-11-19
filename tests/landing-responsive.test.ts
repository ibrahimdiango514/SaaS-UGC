// Garde-fous responsive de la landing, vérifiables sans navigateur.
//
// Les défauts d'affichage mobile viennent presque toujours des mêmes causes :
// une largeur fixe trop grande, un `min-width` sur un élément flex, un
// `white-space: nowrap` sur un texte long, un `vw` mal utilisé, ou une cible
// tactile trop petite. Ces motifs se détectent par lecture du code source, et
// c'est ce que fait ce test — de façon reproductible, à chaque exécution.
//
// Ce test ne remplace pas une capture d'écran (voir /dev/matrice pour les onze
// largeurs) ; il empêche la réintroduction des erreurs les plus fréquentes.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const FICHIERS = [
  'src/pages/Landing.tsx',
  'src/components/SpaceSwitcher.tsx',
  'src/components/ThemeToggle.tsx',
  'src/components/QuotaBlocage.tsx',
  'src/marketing/3d/SceneHero.tsx',
];

function lire(f: string) {
  return fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');
}

describe('garde-fous responsive de la landing', () => {
  it('n’utilise aucune largeur fixe en pixels sur un conteneur de page', () => {
    for (const f of FICHIERS) {
      const src = lire(f);
      // `w-[900px]` sur un conteneur force un débordement à 320 px.
      const largeursFixes = [...src.matchAll(/\bw-\[(\d{3,})px\]/g)].map((m) => Number(m[1]));
      const tropGrandes = largeursFixes.filter((px) => px > 320);
      expect(tropGrandes, `${f} contient une largeur fixe > 320 px`).toEqual([]);
    }
  });

  it('n’interdit jamais la césure sur un texte long', () => {
    for (const f of FICHIERS) {
      const src = lire(f);
      // `whitespace-nowrap` sur un paragraphe pousse la page en largeur.
      const lignes = src.split('\n').filter((l) => l.includes('whitespace-nowrap'));
      for (const ligne of lignes) {
        // Toléré uniquement sur des montants courts explicitement balisés.
        expect(ligne, `nowrap risqué dans ${f}`).toMatch(/tabular-nums|vy-nowrap|montant|FCFA/);
      }
    }
  });

  it('utilise des unités de hauteur dynamiques (dvh), pas vh', () => {
    for (const f of FICHIERS) {
      const src = lire(f);
      // `100vh` inclut la barre d'URL mobile et crée un décalage au défilement.
      const vh = [...src.matchAll(/\b(\d+)vh\b/g)].map((m) => m[0]);
      expect(vh, `${f} utilise vh au lieu de dvh`).toEqual([]);
    }
  });

  it('protège les textes longs contre le débordement', () => {
    const src = lire('src/pages/Landing.tsx');
    // Les blocs qui contiennent un titre ou un paragraphe long portent la
    // classe de largeur minimale nulle, sans quoi flex les empêche de rétrécir.
    expect(src).toMatch(/vy-min0/);
    const index = lire('src/index.css');
    expect(index).toMatch(/overflow-wrap:\s*break-word/);
    expect(index).toMatch(/overflow-x:\s*hidden/);
  });

  it('déclare des cibles tactiles d’au moins 44 px', () => {
    const index = lire('src/index.css');
    expect(index).toMatch(/min-height:\s*44px/);
    expect(index).toMatch(/\.tap\s*\{[^}]*min-height:\s*44px/);
  });

  it('respecte la préférence de mouvement réduit', () => {
    const tokens = lire('src/styles/tokens.css');
    expect(tokens).toMatch(/prefers-reduced-motion:\s*reduce/);
    // Le hero 3D doit aussi couper sa parallaxe au toucher.
    const hero = lire('src/marketing/3d/SceneHero.tsx');
    expect(hero).toMatch(/prefers-reduced-motion/);
    expect(hero).toMatch(/hover:\s*none/);
  });

  it('borne la scène 3D dans un conteneur à hauteur maximale', () => {
    const hero = lire('src/marketing/3d/SceneHero.tsx');
    // Jamais plein écran, jamais en fond de page : aspect-ratio + maxHeight.
    expect(hero).toMatch(/aspectRatio/);
    expect(hero).toMatch(/maxHeight/);
    // Et le conteneur ne capte aucun événement : la 3D ne masque pas un CTA.
    expect(hero).toMatch(/pointer-events-none|aria-hidden/);
  });

  it('prévoit un repli de mêmes dimensions que la scène', () => {
    const hero = lire('src/marketing/3d/SceneHero.tsx');
    // Le conteneur du premier rendu et celui du rendu final doivent avoir la
    // même géométrie, sinon la page saute quand la 3D arrive.
    const occurrences = [...hero.matchAll(/aspectRatio: '4 \/ 3'/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});
