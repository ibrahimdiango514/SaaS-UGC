import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde de build Netlify à deux rideaux (`netlify.toml`).
 *
 * Rideau 1 — `[build].ignore` : code 0 = build ANNULÉ avant toute installation.
 * Rideau 2 — `scripts/netlify-build-guard.sh` en tête de `[build].command` :
 * code ≠ 0 = build en ÉCHEC, donc aucun déploiement.
 *
 * Rien n'est simulé : les deux sont exécutés par le vrai `sh`, avec les
 * variables que Netlify fournit (`SITE_ID`, `SITE_NAME`, `BRANCH`) et celle que
 * le site de production doit déclarer (`VYORA_BUILD_ENABLED`).
 *
 * Contexte (2026-11-18) : le déploiement de `14a61ec` a été ignoré alors que le
 * site était le bon — la variable `SITE_ID` n'est pas exposée de façon fiable à
 * l'étape `ignore` (la garde précédente par `SITE_NAME` n'avait d'ailleurs
 * jamais bloqué un site pourtant nommé `vyora-ugc`). Règles vérifiées ici :
 *  - `ignore` ne tranche l'identité que si la variable est PRÉSENTE ; absente,
 *    il laisse passer vers le rideau 2 (qui, lui, exige la variable) ;
 *  - le NOUVEAU site (ID épinglé, nom `vyora-saas-ugc`) construit `main` ;
 *  - l'ANCIEN site est refusé par son nom `vyora-ugc` ET par tout autre ID ;
 *  - seul `main`, seulement avec `VYORA_BUILD_ENABLED=true` ;
 *  - l'identifiant est le même aux deux endroits (une seule source de vérité).
 */
const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const ignoreCommand = config.match(/^\s*ignore\s*=\s*'([^']+)'\s*$/m)?.[1];
const buildCommand = config.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Identifiant épinglé : la source de vérité est le fichier, pas le test. */
const NOUVEAU_SITE_ID = buildCommand?.match(/netlify-build-guard\.sh ([0-9a-f-]{36})/)?.[1];
const ANCIEN_SITE_NAME = 'vyora-ugc';
const NOUVEAU_SITE_NAME = 'vyora-saas-ugc';
/** L'identifiant réel de l'ancien site est inconnu : tout identifiant ≠ épinglé doit être refusé. */
const ANCIEN_SITE_ID = '0b7d3a6e-1c2f-4e5a-9d8b-7f6e5d4c3b2a';

type Env = Record<string, string>;
const nouveauSite = (extra: Env = {}): Env => ({
  SITE_ID: NOUVEAU_SITE_ID!, SITE_NAME: NOUVEAU_SITE_NAME, VYORA_BUILD_ENABLED: 'true', BRANCH: 'main', HEAD: 'main', ...extra,
});
const ancienSite = (extra: Env = {}): Env => ({
  SITE_ID: ANCIEN_SITE_ID, SITE_NAME: ANCIEN_SITE_NAME, VYORA_BUILD_ENABLED: 'true', BRANCH: 'main', HEAD: 'main', ...extra,
});
/** Retire des variables de l'environnement (Netlify ne les fournit pas toujours). */
const sans = (env: Env, ...cles: string[]): Env => Object.fromEntries(Object.entries(env).filter(([k]) => !cles.includes(k)));

function run(command: string, env: Env) {
  const result = spawnSync('sh', ['-c', command], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBeNull();
  return result;
}

/** Rideau 1 : vrai = Netlify annule le build. */
function ignoreAnnule(env: Env): boolean {
  expect(ignoreCommand, 'La commande ignore doit être présente').toBeTruthy();
  return run(ignoreCommand!, env).status === 0;
}

/** Rideau 2 : le script réel, avec l'identifiant tel qu'écrit dans la commande de build. */
function garde(env: Env, siteAutorise = NOUVEAU_SITE_ID!) {
  const result = run(`sh scripts/netlify-build-guard.sh ${siteAutorise}`, env);
  return { refuse: result.status !== 0, sortie: `${result.stdout}${result.stderr}` };
}

describe('Garde de build Netlify — configuration', () => {
  it('épingle un identifiant de site (UUID) identique dans la commande de build et dans ignore', () => {
    expect(NOUVEAU_SITE_ID).toMatch(UUID);
    expect(buildCommand).toBe(`sh scripts/netlify-build-guard.sh ${NOUVEAU_SITE_ID} && npm ci && npm run build`);
    const idsDansIgnore = [...ignoreCommand!.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
    expect(idsDansIgnore).toEqual([NOUVEAU_SITE_ID]);
  });

  it("la garde s'exécute AVANT npm ci : un refus ne consomme ni installation ni build", () => {
    expect(buildCommand!.indexOf('netlify-build-guard.sh')).toBeLessThan(buildCommand!.indexOf('npm ci'));
    expect(buildCommand).toContain('&& npm ci');
  });

  it("nomme explicitement l'ancien site (vyora-ugc) dans les deux rideaux", () => {
    expect(ignoreCommand).toContain(`[ "$SITE_NAME" = "${ANCIEN_SITE_NAME}" ]`);
    expect(readFileSync('scripts/netlify-build-guard.sh', 'utf8')).toContain(`ANCIEN_SITE_NAME="${ANCIEN_SITE_NAME}"`);
  });
});

describe('Rideau 1 — ignore (avant installation)', () => {
  it('laisse construire main sur le NOUVEAU site, que SITE_ID soit exposé ou non', () => {
    expect(ignoreAnnule(nouveauSite())).toBe(false);
    // Cas réel de 14a61ec : Netlify n'expose pas SITE_ID / SITE_NAME ici → on ne doit PAS annuler.
    expect(ignoreAnnule(sans(nouveauSite(), 'SITE_ID', 'SITE_NAME'))).toBe(false);
    expect(ignoreAnnule(nouveauSite({ SITE_ID: '' }))).toBe(false);
  });

  it("annule sur l'ANCIEN site dès qu'il est identifiable (nom vyora-ugc ou autre identifiant)", () => {
    expect(ignoreAnnule(ancienSite())).toBe(true);
    expect(ignoreAnnule(ancienSite({ SITE_NAME: 'renomme' }))).toBe(true); // autre ID, même renommé
    expect(ignoreAnnule(sans(ancienSite(), 'SITE_ID'))).toBe(true); // nom seul
    expect(ignoreAnnule(nouveauSite({ SITE_NAME: ANCIEN_SITE_NAME }))).toBe(true); // bon ID mais nom de l'ancien site : refus explicite
  });

  it('refuse un identifiant qui ne diffère que par la casse, un préfixe ou une troncature', () => {
    expect(ignoreAnnule(nouveauSite({ SITE_ID: NOUVEAU_SITE_ID!.toUpperCase() }))).toBe(true);
    expect(ignoreAnnule(nouveauSite({ SITE_ID: `${NOUVEAU_SITE_ID}0` }))).toBe(true);
    expect(ignoreAnnule(nouveauSite({ SITE_ID: NOUVEAU_SITE_ID!.slice(0, 35) }))).toBe(true);
  });

  it.each(['', 'false', '1', 'TRUE'])('annule quand VYORA_BUILD_ENABLED vaut « %s », même sur le nouveau site', (valeur) => {
    expect(ignoreAnnule(nouveauSite({ VYORA_BUILD_ENABLED: valeur }))).toBe(true);
    expect(ignoreAnnule(sans(nouveauSite({ VYORA_BUILD_ENABLED: valeur }), 'SITE_ID', 'SITE_NAME'))).toBe(true);
  });

  it('annule sans aucune variable (site relié par erreur, sans opt-in)', () => {
    expect(ignoreAnnule({})).toBe(true);
    expect(ignoreAnnule({ BRANCH: 'main' })).toBe(true);
  });

  it.each(['arena/da71bd73-saas-ugc', 'develop', 'feature/x'])(
    'annule la branche %s et son Deploy Preview sur les deux sites',
    (branch) => {
      expect(ignoreAnnule(nouveauSite({ BRANCH: branch, HEAD: branch }))).toBe(true);
      expect(ignoreAnnule(nouveauSite({ BRANCH: branch, HEAD: 'main' }))).toBe(true);
      expect(ignoreAnnule(sans(nouveauSite({ BRANCH: branch }), 'SITE_ID', 'SITE_NAME'))).toBe(true);
      expect(ignoreAnnule(ancienSite({ BRANCH: branch, HEAD: branch }))).toBe(true);
    },
  );

  it('ne contient pas d’apostrophe (chaîne TOML littérale) et journalise les valeurs reçues', () => {
    expect(ignoreCommand).not.toContain("'");
    const result = run(ignoreCommand!, sans(nouveauSite(), 'SITE_ID'));
    expect(result.stdout).toContain('garde ignore: BRANCH=main VYORA_BUILD_ENABLED=true SITE_ID=absent SITE_NAME=vyora-saas-ugc');
  });
});

describe('Rideau 2 — scripts/netlify-build-guard.sh (environnement de build complet)', () => {
  it('autorise main sur le NOUVEAU site et le dit dans le journal', () => {
    const r = garde(nouveauSite());
    expect(r.refuse).toBe(false);
    expect(r.sortie).toContain(`build autorisé : site ${NOUVEAU_SITE_ID} (${NOUVEAU_SITE_NAME}), branche main`);
  });

  it("refuse l'ANCIEN site par son identifiant ET par son nom, en écrivant les valeurs reçues", () => {
    const parId = garde(ancienSite({ SITE_NAME: 'renomme' }));
    expect(parId.refuse).toBe(true);
    expect(parId.sortie).toContain(`ce site (${ANCIEN_SITE_ID}) n'est pas le site de production autorisé`);
    expect(parId.sortie).toContain(`SITE_ID=${ANCIEN_SITE_ID}`);
    const parNom = garde(nouveauSite({ SITE_NAME: ANCIEN_SITE_NAME }));
    expect(parNom.refuse).toBe(true);
    expect(parNom.sortie).toContain(`nom de l'ANCIEN site (${ANCIEN_SITE_NAME})`);
  });

  it('refuse (fermé) quand SITE_ID est absent ou vide : l’identité doit être prouvée ici', () => {
    expect(garde(sans(nouveauSite(), 'SITE_ID')).refuse).toBe(true);
    expect(garde(sans(nouveauSite(), 'SITE_ID')).sortie).toContain('SITE_ID absent');
    expect(garde(nouveauSite({ SITE_ID: '' })).refuse).toBe(true);
  });

  it('refuse un identifiant qui ne diffère que par la casse, un préfixe ou une troncature', () => {
    expect(garde(nouveauSite({ SITE_ID: NOUVEAU_SITE_ID!.toUpperCase() })).refuse).toBe(true);
    expect(garde(nouveauSite({ SITE_ID: `${NOUVEAU_SITE_ID}0` })).refuse).toBe(true);
    expect(garde(nouveauSite({ SITE_ID: NOUVEAU_SITE_ID!.slice(0, 35) })).refuse).toBe(true);
  });

  it.each(['', 'false', '1', 'TRUE'])('refuse quand VYORA_BUILD_ENABLED vaut « %s »', (valeur) => {
    const r = garde(nouveauSite({ VYORA_BUILD_ENABLED: valeur }));
    expect(r.refuse).toBe(true);
    expect(r.sortie).toContain('VYORA_BUILD_ENABLED doit valoir exactement « true »');
  });

  it.each(['arena/da71bd73-saas-ugc', 'develop', 'feature/x'])('refuse la branche %s sur les deux sites', (branch) => {
    expect(garde(nouveauSite({ BRANCH: branch })).refuse).toBe(true);
    expect(garde(nouveauSite({ BRANCH: branch })).sortie).toContain(`branche reçue : ${branch}`);
    expect(garde(ancienSite({ BRANCH: branch })).refuse).toBe(true);
  });

  it("refuse si l'identifiant autorisé passé en argument est absent ou mal formé (configuration cassée)", () => {
    expect(garde(nouveauSite(), '').refuse).toBe(true);
    expect(garde(nouveauSite(), 'pas-un-uuid').refuse).toBe(true);
    expect(garde(nouveauSite(), NOUVEAU_SITE_ID!.toUpperCase()).refuse).toBe(true);
  });

  it("n'autorise jamais un autre identifiant que celui passé en argument", () => {
    // Si quelqu'un épingle un autre site, seul ce site passe : pas de liste implicite.
    expect(garde(ancienSite({ SITE_NAME: 'renomme' }), ANCIEN_SITE_ID).refuse).toBe(false);
    expect(garde(nouveauSite(), ANCIEN_SITE_ID).refuse).toBe(true);
  });
});
