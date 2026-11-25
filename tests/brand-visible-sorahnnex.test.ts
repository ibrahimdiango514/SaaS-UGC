import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

/**
 * Garde de marque visible.
 *
 * L'expérience utilisateur ne doit plus afficher VYORA ni REELORA. Les
 * identifiants techniques (VYORA_BUILD_ENABLED, vyora-ai, vyora_*) restent
 * volontairement inchangés : ils sont retirés avant l'analyse, et leur
 * inventaire est tenu dans docs/renommage-sorahnnex/.
 */
const ROOT = process.cwd();
const TEXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json', '.svg', '.txt']);
const PROTECTED = [/\bVYORA_[A-Z0-9_]+\b/g, /\bREELORA_[A-Z0-9_]+\b/g];

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
  for (const rule of PROTECTED) text = text.replace(rule, '');
  return text.match(/\b(?:VYORA|Vyora|REELORA|Reelora)\b/g) ?? [];
}

describe('marque visible SORAHNEX', () => {
  it('n’affiche plus VYORA ni REELORA dans le frontend', () => {
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

  it('le nom d’application est sorahnnex', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('sorahnnex');
  });
});
