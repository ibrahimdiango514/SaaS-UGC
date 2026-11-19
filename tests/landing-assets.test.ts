// Ressources visuelles de la vitrine — vérité des chemins et du poids.
//
// Un visuel manquant sur la landing est une page cassée au premier regard : le
// visiteur voit une icône brisée avant de lire la promesse. Un visuel trop
// lourd est une landing qui n'arrive jamais sur 3G. Ces tests couvrent les deux.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SOURCES = [
  'src/pages/Landing.tsx',
  'src/marketing/3d/SceneHero.tsx',
];

function sources() {
  return SOURCES.map((file) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8')).join('\n');
}

describe('ressources visuelles de la vitrine', () => {
  it('ne référence que des fichiers locaux présents dans public/', () => {
    const source = sources();
    const referenced = [...source.matchAll(/["'](\/(?:brand|studio-examples|vyora-mark)\/[^"']+\.(?:jpg|jpeg|png|webp|svg))["']/g)].map(
      (m) => m[1],
    );
    const unique = [...new Set(referenced)];
    for (const asset of unique) {
      expect(fs.existsSync(path.resolve(process.cwd(), 'public', asset.slice(1))), `${asset} introuvable`).toBe(true);
    }
  });

  it('n’introduit aucune image distante non vérifiée', () => {
    const remote = sources().match(/https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|svg)/gi) ?? [];
    expect(remote).toEqual([]);
  });

  it('déclare une image sociale aux bonnes dimensions et sous 300 Ko', () => {
    // Open Graph : 1200×630 est le format attendu par WhatsApp, Facebook,
    // LinkedIn et X. Une mauvaise taille = aperçu rogné ou étiré.
    const file = path.resolve(process.cwd(), 'public/brand/og-vyora.png');
    expect(fs.existsSync(file)).toBe(true);
    const buf = fs.readFileSync(file);
    const largeur = buf.readUInt32BE(16);
    const hauteur = buf.readUInt32BE(20);
    expect(largeur).toBe(1200);
    expect(hauteur).toBe(630);
    expect(buf.length).toBeLessThan(300 * 1024);
  });

  it('fournit une icône d’écran d’accueil carrée en 180 px', () => {
    const file = path.resolve(process.cwd(), 'public/brand/apple-touch-icon.png');
    expect(fs.existsSync(file)).toBe(true);
    const buf = fs.readFileSync(file);
    expect(buf.readUInt32BE(16)).toBe(180);
    expect(buf.readUInt32BE(20)).toBe(180);
  });

  it('déclare un manifeste installable cohérent', () => {
    const file = path.resolve(process.cwd(), 'public/manifest.webmanifest');
    expect(fs.existsSync(file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(manifest.name).toBeTruthy();
    expect(manifest.start_url).toBe('/app');
    expect(manifest.display).toBe('standalone');
    expect(manifest.lang).toBe('fr');
    const icones = manifest.icons as Array<{ src: string }>;
    expect(icones.length).toBeGreaterThanOrEqual(2);
    for (const i of icones) {
      expect(fs.existsSync(path.resolve(process.cwd(), 'public', i.src.slice(1))), `${i.src} introuvable`).toBe(true);
    }
  });

  it('porte les balises sociales essentielles dans index.html', () => {
    const html = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    for (const balise of ['og:title', 'og:description', 'og:image', 'twitter:card', 'canonical']) {
      expect(html, `balise ${balise} absente`).toContain(balise);
    }
    expect(html).toContain('lang="fr"');
  });
});
