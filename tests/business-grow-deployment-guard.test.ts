import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde de build Netlify (`netlify.toml` → `[build].ignore`).
 *
 * Convention Netlify : code 0 = build ANNULÉ, tout autre code = build normal.
 * La commande est exécutée telle quelle, avec les variables que Netlify fournit
 * (`SITE_ID`, `SITE_NAME`, `BRANCH`, `HEAD`) et celle que le site de production
 * doit déclarer (`VYORA_BUILD_ENABLED`). Rien n'est simulé : c'est le vrai `sh -c`.
 *
 * Contexte (2026-11-22) : l'ancien site et le nouveau portent le MÊME nom
 * `vyora-ugc` et la même URL. Seul `SITE_ID` (UUID attribué à la création)
 * les distingue. Règles vérifiées (voir docs/migration-nouveau-netlify.md) :
 *  - seul le site dont l'identifiant est épinglé dans `netlify.toml` construit ;
 *  - l'ancien site (autre identifiant, même nom) ne construit jamais ;
 *  - un site qui ne déclare pas `VYORA_BUILD_ENABLED=true` ne construit pas ;
 *  - seul `main` construit, jamais une branche de travail ni un Deploy Preview.
 */
describe('Garde de build Netlify', () => {
  const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  const command = config.match(/^\s*ignore\s*=\s*'([^']+)'\s*$/m)?.[1];

  /** Identifiant épinglé dans la configuration : la source de vérité est le fichier. */
  const NOUVEAU_SITE_ID = command?.match(/"\$SITE_ID" != "([0-9a-f-]{36})"/)?.[1];

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

  it('épingle un identifiant de site (UUID) et ne dépend plus du nom du site', () => {
    expect(NOUVEAU_SITE_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(command).not.toContain('SITE_NAME');
  });

  // Les deux sites portent le même nom : c'est précisément ce que la garde doit tolérer.
  const nouveauSite = () => ({ SITE_ID: NOUVEAU_SITE_ID!, SITE_NAME: 'vyora-ugc', VYORA_BUILD_ENABLED: 'true' });
  const ancienSite = () => ({ SITE_ID: '0b7d3a6e-1c2f-4e5a-9d8b-7f6e5d4c3b2a', SITE_NAME: 'vyora-ugc', VYORA_BUILD_ENABLED: 'true' });

  it('construit `main` sur le NOUVEAU site (identifiant épinglé + VYORA_BUILD_ENABLED=true), même nommé vyora-ugc', () => {
    expect(isBuildIgnored({ ...nouveauSite(), BRANCH: 'main', HEAD: 'main' })).toBe(false);
  });

  it("n'autorise jamais l'ANCIEN site (même nom vyora-ugc, autre identifiant) à construire, même main, même activé", () => {
    expect(isBuildIgnored({ ...ancienSite(), BRANCH: 'main', HEAD: 'main' })).toBe(true);
    expect(isBuildIgnored({ SITE_NAME: 'vyora-ugc', BRANCH: 'main' })).toBe(true);
  });

  it("refuse un identifiant qui ne diffère que par la casse ou par un préfixe", () => {
    expect(isBuildIgnored({ ...nouveauSite(), SITE_ID: NOUVEAU_SITE_ID!.toUpperCase(), BRANCH: 'main' })).toBe(true);
    expect(isBuildIgnored({ ...nouveauSite(), SITE_ID: `${NOUVEAU_SITE_ID}0`, BRANCH: 'main' })).toBe(true);
    expect(isBuildIgnored({ ...nouveauSite(), SITE_ID: NOUVEAU_SITE_ID!.slice(0, 35), BRANCH: 'main' })).toBe(true);
  });

  it.each(['', 'false', '1', 'TRUE'])(
    'annule le build quand VYORA_BUILD_ENABLED vaut « %s » (seul « true » active), même sur le bon site',
    (valeur) => {
      expect(isBuildIgnored({ ...nouveauSite(), VYORA_BUILD_ENABLED: valeur, BRANCH: 'main' })).toBe(true);
    },
  );

  it('annule le build sans aucune variable (site relié par erreur)', () => {
    expect(isBuildIgnored({ BRANCH: 'main' })).toBe(true);
    expect(isBuildIgnored({})).toBe(true);
    expect(isBuildIgnored({ VYORA_BUILD_ENABLED: 'true', BRANCH: 'main' })).toBe(true);
  });

  it.each(['arena/51dab05a-saas-ugc', 'develop', 'feature/x'])(
    'annule les builds de la branche %s et de son Deploy Preview, même sur le nouveau site',
    (branch) => {
      expect(isBuildIgnored({ ...nouveauSite(), BRANCH: branch, HEAD: branch })).toBe(true);
      expect(isBuildIgnored({ ...nouveauSite(), BRANCH: branch, HEAD: 'main' })).toBe(true);
    },
  );
});
