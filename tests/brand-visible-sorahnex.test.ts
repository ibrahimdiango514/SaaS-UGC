import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Garde de marque visible.
 *
 * L'expérience utilisateur ne doit plus afficher les anciennes marques. Les
 * identifiants techniques (VYORA_BUILD_ENABLED, vyora-ai, vyora_*) restent
 * volontairement inchangés : ils sont retirés avant l'analyse, et leur
 * inventaire est tenu dans docs/renommage-sorahnex/.
 *
 * ## Pourquoi les anciens noms sont assemblés à l'exécution
 *
 * Ce fichier est analysé par `scripts/rename-brand-visible.mjs`. Écrits en
 * clair, les jetons interdits seraient réécrits en SORAHNEX à chaque passage du
 * script — et la garde se mettrait à interdire la marque qu'elle doit protéger.
 * Les fragments concaténés ne forment jamais un mot entier dans le source, donc
 * le script ne peut plus les renommer.
 */
const OLD_BRAND = ['V' + 'YORA', 'V' + 'yora', 'REEL' + 'ORA', 'Reel' + 'ora'];
const LEGACY = new RegExp(`\\b(?:${OLD_BRAND.join('|')})\\b`);
const LEGACY_ENV = [new RegExp('\\b' + 'V' + 'YORA_[A-Z0-9_]+\\b', 'g'), new RegExp('\\b' + 'REEL' + 'ORA_[A-Z0-9_]+\\b', 'g')];

const ROOT = process.cwd();
const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.svg', '.txt']);

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files(path, out);
    else if (TEXT.has(extname(path))) out.push(path);
  }
  return out;
}

function visibleBrandHits(path: string): string[] {
  let text = readFileSync(path, 'utf8');
  for (const rule of LEGACY_ENV) text = text.replace(rule, '');
  return text.match(LEGACY) ?? [];
}

describe('marque visible SORAHNEX', () => {
  it('n’affiche plus les anciennes marques dans le frontend', () => {
    const offenders = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'public'))]
      .map((path) => ({ path: relative(ROOT, path), hits: visibleBrandHits(path) }))
      .filter((entry) => entry.hits.length > 0);

    expect(offenders).toEqual([]);
  });

  it('titre du document et métadonnées en SORAHNEX', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toContain('<title>SORAHNEX');
    expect(html).toContain('og:site_name" content="SORAHNEX"');
    expect(visibleBrandHits(join(ROOT, 'index.html'))).toEqual([]);
  });

  it('le nom d’application est sorahnex', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('sorahnex');
  });
});
