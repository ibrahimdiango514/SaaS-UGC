import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fou : le harnais de captures ne doit jamais faire passer une fonction
 * absente pour une fonction saine. Sans cette couverture, la page Business
 * affichait « backend absent ou injoignable » alors que la preview répondait
 * `{configured:{}}` à tout — c'est exactement ce qui a masqué l'incident v14.
 */
const source = readFileSync(path.resolve(__dirname, '../scripts/studio-preview.mjs'), 'utf8');

describe('studio-preview — couverture des Edge Functions', () => {
  it('simule business-grow (status + providers.verify)', () => {
    expect(source).toContain("fn === 'business-grow'");
    expect(source).toContain('providers.verify');
    expect(source).toContain('provider_key');
  });

  it('ne retombe pas sur un corps générique { configured: {} }', () => {
    expect(source).not.toMatch(/return\s*\{\s*configured:\s*\{\s*\}\s*\}/);
    expect(source).toContain('UNKNOWN_FUNCTION');
  });

  it('couvre chaque fonction déclarée dans supabase/config.toml', () => {
    const config = readFileSync(path.resolve(__dirname, '../supabase/config.toml'), 'utf8');
    const declared = [...config.matchAll(/^\[functions\.([a-z0-9-]+)\]/gm)].map((m) => m[1]);
    const missing = declared.filter((slug) => !source.includes(`'${slug}'`));
    expect(missing).toEqual([]);
  });
});
