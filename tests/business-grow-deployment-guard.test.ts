import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde de build Netlify (`netlify.toml` → `[build].ignore`).
 *
 * Convention Netlify : code 0 = build ANNULÉ, tout autre code = build normal.
 * La commande est exécutée telle quelle, avec les variables que Netlify fournit
 * (`SITE_NAME`, `BRANCH`, `HEAD`) et celle que le nouveau site doit déclarer
 * (`VYORA_BUILD_ENABLED`). Rien n'est simulé : c'est le vrai `sh -c`.
 *
 * Règles vérifiées (voir docs/migration-nouveau-netlify.md) :
 *  - l'ancien site `vyora-ugc` ne construit plus jamais ;
 *  - un site qui ne déclare pas `VYORA_BUILD_ENABLED=true` ne construit pas ;
 *  - seul `main` construit, jamais une branche de travail ni un Deploy Preview.
 */
describe('Garde de build Netlify', () => {
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const command = config.match(/^\s*ignore\s*=\s*'([^']+)'\s*$/m)?.[1];

  function isBuildIgnored(env: Record<string, string>): boolean {
    expect(command, 'La commande Netlify de protection doit être présente').toBeTruthy();
    const result = spawnSync('sh', ['-c', command!], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    return result.status === 0; // Convention Netlify : 0 annule le build.
  }

  const nouveauSite = { SITE_NAME: 'nouveau-site-vyora', VYORA_BUILD_ENABLED: 'true' };

  it('construit `main` sur un site qui déclare VYORA_BUILD_ENABLED=true', () => {
    expect(isBuildIgnored({ ...nouveauSite, BRANCH: 'main', HEAD: 'main' })).toBe(false);
  });

  it("n'autorise jamais l'ancien site vyora-ugc à construire, même main, même activé", () => {
    expect(isBuildIgnored({ SITE_NAME: 'vyora-ugc', VYORA_BUILD_ENABLED: 'true', BRANCH: 'main', HEAD: 'main' })).toBe(true);
    expect(isBuildIgnored({ SITE_NAME: 'vyora-ugc', BRANCH: 'main' })).toBe(true);
  });

  it.each(['', 'false', '1', 'TRUE'])(
    'annule le build quand VYORA_BUILD_ENABLED vaut « %s » (seul « true » active)',
    (valeur) => {
      expect(isBuildIgnored({ SITE_NAME: 'nouveau-site-vyora', VYORA_BUILD_ENABLED: valeur, BRANCH: 'main' })).toBe(true);
    },
  );

  it('annule le build sans aucune variable (site relié par erreur)', () => {
    expect(isBuildIgnored({ BRANCH: 'main' })).toBe(true);
    expect(isBuildIgnored({})).toBe(true);
  });

  it.each(['arena/0820df15-saas-ugc', 'develop', 'feature/x'])(
    'annule les builds de la branche %s et de son Deploy Preview, même sur le nouveau site',
    (branch) => {
      expect(isBuildIgnored({ ...nouveauSite, BRANCH: branch, HEAD: branch })).toBe(true);
      expect(isBuildIgnored({ ...nouveauSite, BRANCH: branch, HEAD: 'main' })).toBe(true);
    },
  );
});
