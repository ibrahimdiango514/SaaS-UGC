import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = [
  'src/pages/Landing.tsx',
  'src/components/landing/visuals.tsx',
  'src/components/landing/motion.tsx',
];

function landingSources() {
  return SOURCES.map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');
}

describe('ressources visuelles de la vitrine', () => {
  it('ne référence que des fichiers locaux présents dans public/', () => {
    const source = landingSources();
    const referenced = [...source.matchAll(/["'](\/(?:brand|studio-examples)\/[^"']+\.(?:jpg|jpeg|png|webp|svg))["']/g)]
      .map((match) => match[1]);
    const unique = [...new Set(referenced)];

    expect(unique.length).toBeGreaterThanOrEqual(6);
    for (const asset of unique) {
      expect(fs.existsSync(path.resolve(process.cwd(), 'public', asset.slice(1))), `${asset} introuvable`).toBe(true);
    }
  });

  it('n’introduit aucune image distante non vérifiée', () => {
    const source = landingSources();
    const remoteImages = source.match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|svg)/gi) ?? [];
    expect(remoteImages).toEqual([]);
  });

  it('décrit les visuels de contenu et masque uniquement les décors', () => {
    const source = landingSources();
    // Les visuels porteurs de sens (créatrice, produit) ont un alt descriptif.
    expect(source).toMatch(/alt="Créatrice UGC présentant un sérum/);
    expect(source).toMatch(/alt="Produit cosmétique mis en scène/);
    // Le décor du CTA final reste décoratif et est retiré de l’arbre d’accessibilité.
    expect(source).toMatch(/alt=""\s+aria-hidden="true"/);
  });
});
