import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde de build Netlify à deux rideaux (`netlify.toml`).
 *
 * Rideau 1 — `[build].ignore` : code 0 = build ANNULÉ avant toute installation
 * (Netlify affiche alors « Canceled build due to no content change », libellé
 * générique de toute annulation par `ignore`).
 * Rideau 2 — `scripts/netlify-build-guard.sh` en tête de `[build].command` :
 * code ≠ 0 = build en ÉCHEC, donc aucun déploiement.
 *
 * Rien n'est simulé : les deux sont exécutés par le vrai `sh`, avec les
 * variables que Netlify fournit (`SITE_ID`, `SITE_NAME`, `BRANCH`) et celle que
 * le site de production doit déclarer (`VYORA_BUILD_ENABLED`).
 *
 * Preuve de terrain (journal du déploiement `ca410d5`, 2026-11-18) :
 *   BRANCH=main VYORA_BUILD_ENABLED=absent SITE_ID=fc88d197-… SITE_NAME=vyora-saas-ugc
 * Netlify expose donc bien `SITE_ID` et `SITE_NAME` à l'étape `ignore` ; seule
 * la variable d'opt-in manquait. Les deux rideaux exigent désormais les CINQ
 * conditions, fermés par défaut, et l'ancien site reste refusé explicitement.
 *
 * 2026-11-25 — cinquième condition, `SORAHNEX_DEPLOY_AUTHORIZED` : un déploiement
 * de production réussi coûte 15 crédits Netlify. Les quatre conditions
 * historiques étaient toutes vraies sur le site en service, donc une fusion vers
 * `main` suffisait à publier. Cette variable n'est déclarée nulle part : publier
 * exige maintenant une autorisation humaine, et non un effet de bord de Git.
 */
const config = readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
const ignoreCommand = config.match(/^\s*ignore\s*=\s*'([^']+)'\s*$/m)?.[1];
const buildCommand = config.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Identité épinglée : la source de vérité est le fichier, pas le test. */
const epingle = buildCommand?.match(/netlify-build-guard\.sh ([0-9a-f-]{36}) ([a-z0-9-]+) &&/);
const NOUVEAU_SITE_ID = epingle?.[1];
const NOUVEAU_SITE_NAME = epingle?.[2];
/** Identité réelle du site de production, telle que lue dans le journal Netlify de ca410d5. */
const SITE_ID_PROD = 'fc88d197-fe0b-47c7-a6e3-fba44eeccda9';
const SITE_NAME_PROD = 'vyora-saas-ugc';
const ANCIEN_SITE_NAME = 'vyora-ugc';
/**
 * UUID DE TEST, bien formé mais fictif : l'identifiant réel de l'ancien site (`vyora-ugc`) n'est pas
 * connu. La garde n'a pas de liste noire d'identifiants : tout identifiant ≠ épinglé doit être refusé.
 */
const SITE_ID_TEST_INCONNU = '0b7d3a6e-1c2f-4e5a-9d8b-7f6e5d4c3b2a';

type Env = Record<string, string>;
const nouveauSite = (extra: Env = {}): Env => ({
  SITE_ID: NOUVEAU_SITE_ID!, SITE_NAME: NOUVEAU_SITE_NAME!, VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true', BRANCH: 'main', HEAD: 'main', ...extra,
});
const ancienSite = (extra: Env = {}): Env => ({
  SITE_ID: SITE_ID_TEST_INCONNU, SITE_NAME: ANCIEN_SITE_NAME, VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true', BRANCH: 'main', HEAD: 'main', ...extra,
});
/**
 * État RÉEL du site en service au 2026-11-25 : les quatre conditions historiques
 * sont vraies (il publie), l'autorisation n'est pas déclarée. C'est exactement la
 * configuration dans laquelle une fusion vers `main` coûtait 15 crédits.
 */
const siteEnServiceSansAutorisation = (extra: Env = {}): Env => ({
  ...sans(nouveauSite(), 'SORAHNEX_DEPLOY_AUTHORIZED'),
  ...extra,
});
/** Retire des variables de l'environnement (variable non déclarée sur le site). */
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

/** Rideau 2 : le script réel, avec l'identité telle qu'écrite dans la commande de build. */
function garde(env: Env, siteId = NOUVEAU_SITE_ID!, siteName = NOUVEAU_SITE_NAME!) {
  const result = run(`sh scripts/netlify-build-guard.sh ${siteId} ${siteName}`, env);
  return { refuse: result.status !== 0, sortie: `${result.stdout}${result.stderr}` };
}

/** Les deux rideaux, ensemble : la publication n'a lieu que si aucun des deux ne refuse. */
function publicationAutorisee(env: Env): boolean {
  return !ignoreAnnule(env) && !garde(env).refuse;
}

describe('Garde de build Netlify — configuration', () => {
  it('épingle l’identité RÉELLE du site de production (journal ca410d5) dans la commande de build et dans ignore', () => {
    expect(NOUVEAU_SITE_ID).toMatch(UUID);
    expect(NOUVEAU_SITE_ID).toBe(SITE_ID_PROD);
    expect(NOUVEAU_SITE_NAME).toBe(SITE_NAME_PROD);
    expect(buildCommand).toBe(`sh scripts/netlify-build-guard.sh ${SITE_ID_PROD} ${SITE_NAME_PROD} && npm ci && npm run build`);
    const idsDansIgnore = [...ignoreCommand!.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
    expect(idsDansIgnore).toEqual([SITE_ID_PROD]);
    expect(ignoreCommand).toContain(`[ "$SITE_NAME" = "${SITE_NAME_PROD}" ]`);
  });

  it("la garde s'exécute AVANT npm ci : un refus ne consomme ni installation ni build", () => {
    expect(buildCommand!.indexOf('netlify-build-guard.sh')).toBeLessThan(buildCommand!.indexOf('npm ci'));
    expect(buildCommand).toContain('&& npm ci');
  });

  it("nomme explicitement l'ancien site (vyora-ugc) dans les deux rideaux", () => {
    expect(ignoreCommand).toContain(`[ "$SITE_NAME" != "${ANCIEN_SITE_NAME}" ]`);
    expect(readFileSync('scripts/netlify-build-guard.sh', 'utf8')).toContain(`ANCIEN_SITE_NAME="${ANCIEN_SITE_NAME}"`);
  });

  it('ignore est une chaîne TOML littérale valide (sans apostrophe) et journalise les valeurs reçues', () => {
    expect(ignoreCommand).not.toContain("'");
    const result = run(ignoreCommand!, sans(nouveauSite(), 'VYORA_BUILD_ENABLED'));
    expect(result.stdout).toContain(`garde ignore: BRANCH=main VYORA_BUILD_ENABLED=absent SITE_ID=${SITE_ID_PROD} SITE_NAME=${SITE_NAME_PROD}`);
    expect(result.stdout).toContain('garde ignore: build annule');
    expect(run(ignoreCommand!, nouveauSite()).stdout).toContain('garde ignore: build autorise');
  });
});

describe('Scénarios exigés — les deux rideaux ensemble', () => {
  it('REJEU EXACT du journal ca410d5 : variable absente → publication bloquée (cause confirmée du blocage)', () => {
    const journal: Env = { BRANCH: 'main', SITE_ID: SITE_ID_PROD, SITE_NAME: SITE_NAME_PROD }; // VYORA_BUILD_ENABLED=absent
    expect(ignoreAnnule(journal)).toBe(true);
    const r = garde(journal);
    expect(r.refuse).toBe(true);
    expect(r.sortie).toContain('VYORA_BUILD_ENABLED doit valoir exactement « true »');
    expect(r.sortie).toContain('VYORA_BUILD_ENABLED=<absent>');
    expect(publicationAutorisee(journal)).toBe(false);
  });

  it('variable à « false » → publication bloquée', () => {
    expect(publicationAutorisee(nouveauSite({ VYORA_BUILD_ENABLED: 'false' }))).toBe(false);
    expect(ignoreAnnule(nouveauSite({ VYORA_BUILD_ENABLED: 'false' }))).toBe(true);
  });

  it('variable à « true », bon Site ID, bon nom, main → publication AUTORISÉE par les deux rideaux', () => {
    const env = nouveauSite();
    expect(ignoreAnnule(env)).toBe(false);
    const r = garde(env);
    expect(r.refuse).toBe(false);
    expect(r.sortie).toContain(`build autorisé : site ${SITE_ID_PROD} (${SITE_NAME_PROD}), branche main`);
    expect(publicationAutorisee(env)).toBe(true);
    // Preuve de terrain : les valeurs exactes du journal + les variables déclarées.
    expect(publicationAutorisee({ BRANCH: 'main', SITE_ID: SITE_ID_PROD, SITE_NAME: SITE_NAME_PROD, VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true' })).toBe(true);
  });

  it('mauvais Site ID → publication bloquée (autre UUID, casse, préfixe, troncature, absent)', () => {
    for (const SITE_ID of [SITE_ID_TEST_INCONNU, SITE_ID_PROD.toUpperCase(), `${SITE_ID_PROD}0`, SITE_ID_PROD.slice(0, 35), '']) {
      expect(publicationAutorisee(nouveauSite({ SITE_ID })), `SITE_ID=${JSON.stringify(SITE_ID)}`).toBe(false);
      expect(ignoreAnnule(nouveauSite({ SITE_ID }))).toBe(true);
    }
    expect(publicationAutorisee(sans(nouveauSite(), 'SITE_ID'))).toBe(false);
    expect(garde(nouveauSite({ SITE_ID: SITE_ID_TEST_INCONNU })).sortie).toContain(`ce site (${SITE_ID_TEST_INCONNU}) n'est pas le site de production autorisé`);
  });

  it("ancienne identité du site → publication bloquée (nom vyora-ugc, même avec le bon ID ; autre ID, même renommé)", () => {
    expect(publicationAutorisee(ancienSite())).toBe(false);
    expect(publicationAutorisee(ancienSite({ SITE_NAME: 'renomme' }))).toBe(false);
    expect(publicationAutorisee(nouveauSite({ SITE_NAME: ANCIEN_SITE_NAME }))).toBe(false);
    expect(garde(nouveauSite({ SITE_NAME: ANCIEN_SITE_NAME })).sortie).toContain(`nom de l'ANCIEN site (${ANCIEN_SITE_NAME})`);
    // Nom inattendu (ni l'ancien ni le nouveau) : refusé aussi — l'identité est positive.
    expect(publicationAutorisee(nouveauSite({ SITE_NAME: 'autre-site' }))).toBe(false);
    expect(garde(nouveauSite({ SITE_NAME: 'autre-site' })).sortie).toContain(`le site autorisé s'appelle « ${SITE_NAME_PROD} »`);
    expect(publicationAutorisee(sans(nouveauSite(), 'SITE_NAME'))).toBe(false);
  });

  it.each(['arena/63f6c56a-saas-ugc', 'develop', 'feature/x'])('autre branche (%s) → publication bloquée, sur les deux sites', (branch) => {
    expect(publicationAutorisee(nouveauSite({ BRANCH: branch, HEAD: branch }))).toBe(false);
    expect(ignoreAnnule(nouveauSite({ BRANCH: branch, HEAD: 'main' }))).toBe(true); // Deploy Preview visant main
    expect(publicationAutorisee(ancienSite({ BRANCH: branch, HEAD: branch }))).toBe(false);
    expect(garde(nouveauSite({ BRANCH: branch })).sortie).toContain(`branche reçue : ${branch}`);
  });
});

describe('Verrou de crédits — autorisation humaine explicite (2026-11-25)', () => {
  it('le cas qui coûtait 15 crédits : site en service + fusion vers main, SANS autorisation → bloqué par les deux rideaux', () => {
    const env = siteEnServiceSansAutorisation();
    // Les quatre conditions historiques sont bien toutes vraies…
    expect(env.BRANCH).toBe('main');
    expect(env.SITE_ID).toBe(SITE_ID_PROD);
    expect(env.SITE_NAME).toBe(SITE_NAME_PROD);
    expect(env.VYORA_BUILD_ENABLED).toBe('true');
    // …et pourtant rien ne se publie : l'autorisation manque.
    expect(ignoreAnnule(env)).toBe(true);
    const r = garde(env);
    expect(r.refuse).toBe(true);
    expect(r.sortie).toContain('SORAHNEX_DEPLOY_AUTHORIZED doit valoir exactement « true »');
    expect(r.sortie).toContain('15 crédits Netlify');
    expect(r.sortie).toContain('SORAHNEX_DEPLOY_AUTHORIZED=<absent>');
    expect(publicationAutorisee(env)).toBe(false);
  });

  it('déclarer l’autorisation lève le verrou, sans affaiblir aucune autre condition', () => {
    expect(publicationAutorisee(siteEnServiceSansAutorisation({ SORAHNEX_DEPLOY_AUTHORIZED: 'true' }))).toBe(true);
    // Autorisation présente mais autre condition manquante : toujours refusé.
    expect(publicationAutorisee(sans(nouveauSite(), 'VYORA_BUILD_ENABLED'))).toBe(false);
    expect(publicationAutorisee(nouveauSite({ BRANCH: 'arena/x' }))).toBe(false);
    expect(publicationAutorisee(nouveauSite({ SITE_ID: SITE_ID_TEST_INCONNU }))).toBe(false);
    expect(publicationAutorisee(ancienSite())).toBe(false);
  });

  it.each(['', 'false', '1', 'TRUE', ' true', 'oui'])('valeur « %s » ≠ « true » exact → publication bloquée', (valeur) => {
    const env = siteEnServiceSansAutorisation({ SORAHNEX_DEPLOY_AUTHORIZED: valeur });
    expect(ignoreAnnule(env)).toBe(true);
    expect(garde(env).refuse).toBe(true);
  });

  it("l’autorisation SEULE ne suffit pas (site relié par erreur, environnement vide)", () => {
    expect(ignoreAnnule({ SORAHNEX_DEPLOY_AUTHORIZED: 'true' })).toBe(true);
    expect(garde({ SORAHNEX_DEPLOY_AUTHORIZED: 'true' }).refuse).toBe(true);
  });

  it('les deux rideaux exigent la même variable, et elle est journalisée pour être diagnostiquable', () => {
    expect(ignoreCommand).toContain('[ "$SORAHNEX_DEPLOY_AUTHORIZED" = "true" ]');
    expect(readFileSync('scripts/netlify-build-guard.sh', 'utf8')).toContain('[ "${SORAHNEX_DEPLOY_AUTHORIZED:-}" = "true" ]');
    expect(run(ignoreCommand!, siteEnServiceSansAutorisation()).stdout)
      .toContain('SORAHNEX_DEPLOY_AUTHORIZED=absent');
    expect(run(ignoreCommand!, nouveauSite()).stdout)
      .toContain('SORAHNEX_DEPLOY_AUTHORIZED=true');
  });
});

describe('Rideau 1 — ignore, détails', () => {
  it.each(['', '1', 'TRUE', ' true'])('annule quand VYORA_BUILD_ENABLED vaut « %s » (seul « true » exact active)', (valeur) => {
    expect(ignoreAnnule(nouveauSite({ VYORA_BUILD_ENABLED: valeur }))).toBe(true);
  });

  it('annule sans aucune variable (site relié par erreur) et avec l’opt-in seul', () => {
    expect(ignoreAnnule({})).toBe(true);
    expect(ignoreAnnule({ BRANCH: 'main' })).toBe(true);
    expect(ignoreAnnule({ BRANCH: 'main', VYORA_BUILD_ENABLED: 'true' })).toBe(true);
  });
});

describe('Rideau 2 — scripts/netlify-build-guard.sh, détails', () => {
  it.each(['', '1', 'TRUE', ' true'])('refuse quand VYORA_BUILD_ENABLED vaut « %s »', (valeur) => {
    const r = garde(nouveauSite({ VYORA_BUILD_ENABLED: valeur }));
    expect(r.refuse).toBe(true);
    expect(r.sortie).toContain('VYORA_BUILD_ENABLED doit valoir exactement « true »');
  });

  it("refuse une configuration cassée : arguments absents, mal formés, ou nom de l'ancien site passé comme autorisé", () => {
    expect(garde(nouveauSite(), '', NOUVEAU_SITE_NAME!).refuse).toBe(true);
    expect(garde(nouveauSite(), 'pas-un-uuid', NOUVEAU_SITE_NAME!).refuse).toBe(true);
    expect(garde(nouveauSite(), NOUVEAU_SITE_ID!.toUpperCase(), NOUVEAU_SITE_NAME!).refuse).toBe(true);
    expect(garde(nouveauSite(), NOUVEAU_SITE_ID!, '').refuse).toBe(true);
    expect(garde(nouveauSite({ SITE_NAME: ANCIEN_SITE_NAME }), NOUVEAU_SITE_ID!, ANCIEN_SITE_NAME).refuse).toBe(true);
  });

  it("n'autorise jamais une autre identité que celle passée en arguments (pas de liste implicite)", () => {
    expect(garde(ancienSite({ SITE_NAME: 'renomme' }), SITE_ID_TEST_INCONNU, 'renomme').refuse).toBe(false);
    expect(garde(nouveauSite(), SITE_ID_TEST_INCONNU, NOUVEAU_SITE_NAME!).refuse).toBe(true);
    expect(garde(nouveauSite(), NOUVEAU_SITE_ID!, 'renomme').refuse).toBe(true);
  });
});
