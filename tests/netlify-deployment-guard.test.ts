import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Garde de déploiement Netlify — deux rideaux, une seule source de vérité.
 *
 * Architecture vérifiée ici :
 *   `netlify.site.conf`          identité autorisée (SITE_ID, SITE_NAME, ancien nom)
 *   `scripts/netlify-guard-lib.sh`  logique commune, sourcée par les deux rideaux
 *   `scripts/netlify-ignore.sh`     rideau 1 — `[build].ignore` (code 0 = annulé)
 *   `scripts/netlify-build-guard.sh` rideau 2 — tête de `[build].command`
 *
 * Rien n'est simulé : les scripts sont exécutés par le vrai `sh`, avec les
 * variables que Netlify fournit. Un dépôt temporaire est utilisé pour les cas
 * qui exigent de modifier l'identité autorisée (vérifier qu'une migration de
 * site fonctionne sans rien casser d'autre).
 */

const RACINE = process.cwd();
const lire = (chemin: string) => readFileSync(join(RACINE, chemin), 'utf8');
const config = lire('netlify.toml');
const commandeBuild = config.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];
const commandeIgnore = config.match(/^\s*ignore\s*=\s*"([^"]+)"\s*$/m)?.[1];

/** Identité lue dans le fichier de configuration : la source de vérité. */
const identite = Object.fromEntries(
  lire('netlify.site.conf')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
) as { SITE_ID: string; SITE_NAME: string; ANCIEN_SITE_NAME: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SITE_ID_AUTRE = '0b7d3a6e-1c2f-4e5a-9d8b-7f6e5d4c3b2a';
const NOUVEAU_POUR_INJECTION = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
const JETON = 'sorahnex-deploy';

type Env = Record<string, string>;

/** Environnement d'un déploiement LÉGITIME : toutes les conditions réunies. */
const autorise = (extra: Env = {}): Env => ({
  SITE_ID: identite.SITE_ID,
  SITE_NAME: identite.SITE_NAME,
  BRANCH: 'main',
  VYORA_BUILD_ENABLED: 'true',
  SORAHNEX_DEPLOY_AUTHORIZED: 'true',
  SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON,
  ...extra,
});

/** Retire des variables (une variable non déclarée sur le site). */
const sans = (env: Env, ...cles: string[]): Env =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !cles.includes(k)));

function executer(commande: string, env: Env) {
  const r = spawnSync('sh', ['-c', commande], {
    cwd: RACINE,
    // PATH minimal : reproduit un environnement Netlify, sans variables héritées.
    env: { PATH: process.env.PATH ?? '' , ...env },
    encoding: 'utf8',
  });
  expect(r.error).toBeUndefined();
  expect(r.status).not.toBeNull();
  return { code: r.status as number, sortie: `${r.stdout}${r.stderr}` };
}

/** Rideau 1 : `true` = Netlify annule le build (aucun crédit consommé). */
const ignoreAnnule = (env: Env) => executer(commandeIgnore!, env).code === 0;
/** Rideau 2 : `true` = build refusé. */
const rideau2Refuse = (env: Env) => executer(commandeBuild!.split(' && ')[0], env).code !== 0;
/** Les deux ensemble : publication seulement si aucun ne refuse. */
const publicationAutorisee = (env: Env) => !ignoreAnnule(env) && !rideau2Refuse(env);

/** Dépôt temporaire où l'identité autorisée peut être remplacée (cas de migration). */
const temporaires: string[] = [];
afterAll(() => { for (const d of temporaires) rmSync(d, { recursive: true, force: true }); });

function depotTemporaire(nouvelleIdentite: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sorahnex-garde-'));
  temporaires.push(dir);
  cpSync(join(RACINE, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(RACINE, 'netlify.site.conf'), join(dir, 'netlify.site.conf'));
  writeFileSync(join(dir, 'netlify.site.conf'), nouvelleIdentite, 'utf8');
  return dir;
}

function executerDans(dir: string, script: string, env: Env) {
  const r = spawnSync('sh', [`scripts/${script}`], {
    cwd: dir, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8',
  });
  return { code: r.status as number, sortie: `${r.stdout}${r.stderr}` };
}

// ===========================================================================
describe('Configuration — portable, sans identité en dur', () => {
  it('netlify.site.conf est la SEULE source de l’identité autorisée', () => {
    expect(identite.SITE_ID).toMatch(UUID);
    expect(identite.SITE_NAME).toMatch(/^[a-z0-9-]+$/);
    expect(identite.ANCIEN_SITE_NAME).toBe('vyora-ugc');
    // Aucun identifiant ne doit subsister dans les DIRECTIVES de netlify.toml :
    // c'est précisément ce qui imposait de modifier deux fichiers lors d'une
    // migration. Les commentaires, eux, peuvent (et doivent) expliquer l'ancien
    // site : ils ne configurent rien.
    const directives = config
      .split('\n')
      .filter((ligne) => !ligne.trim().startsWith('#'))
      .join('\n');
    expect(directives).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(directives).not.toContain(identite.SITE_NAME);
    expect(directives).not.toContain(identite.ANCIEN_SITE_NAME);
  });

  it('les deux rideaux sont branchés sur les scripts, et le rideau 2 précède npm ci', () => {
    expect(commandeIgnore).toBe('sh scripts/netlify-ignore.sh');
    expect(commandeBuild).toBe('sh scripts/netlify-build-guard.sh && npm ci && npm run build');
    expect(commandeBuild!.indexOf('netlify-build-guard.sh')).toBeLessThan(commandeBuild!.indexOf('npm ci'));
  });

  it('les deux rideaux partagent la même bibliothèque : ils ne peuvent pas diverger', () => {
    for (const script of ['scripts/netlify-ignore.sh', 'scripts/netlify-build-guard.sh']) {
      expect(lire(script), script).toContain('. "$ICI/netlify-guard-lib.sh"');
    }
    // Aucune condition dupliquée dans les scripts d'entrée : tout est dans la lib.
    for (const script of ['scripts/netlify-ignore.sh', 'scripts/netlify-build-guard.sh']) {
      expect(lire(script), script).not.toContain('SORAHNEX_DEPLOY_AUTHORIZED" = "true');
    }
  });

  it('aucun fichier de configuration Netlify versionné ne contient de secret', () => {
    const textes = [config, lire('netlify.site.conf'), lire('scripts/netlify-guard-lib.sh')];
    for (const texte of textes) {
      expect(texte).not.toMatch(/sb_secret_|service_role|SUPABASE_SERVICE_ROLE_KEY\s*=/);
    }
  });
});

// ===========================================================================
describe('Cas légitime — publication autorisée', () => {
  it('bon site, main, opt-in, autorisation + jeton → les deux rideaux laissent passer', () => {
    const env = autorise();
    expect(ignoreAnnule(env)).toBe(false);
    expect(rideau2Refuse(env)).toBe(false);
    expect(publicationAutorisee(env)).toBe(true);
    expect(executer(commandeBuild!.split(' && ')[0], env).sortie)
      .toContain(`build autorisé : site ${identite.SITE_ID} (${identite.SITE_NAME}), branche main`);
  });
});

// ===========================================================================
describe('Verrou de crédits — autorisation humaine', () => {
  it('le cas qui coûtait 15 crédits : site autorisé + main, SANS autorisation → bloqué', () => {
    const env = sans(autorise(), 'SORAHNEX_DEPLOY_AUTHORIZED', 'SORAHNEX_DEPLOY_AUTHORIZED_NAME');
    expect(ignoreAnnule(env)).toBe(true);
    const r = executer(commandeBuild!.split(' && ')[0], env);
    expect(r.code).not.toBe(0);
    expect(r.sortie).toContain('AUTORISATION HUMAINE ABSENTE');
    expect(r.sortie).toContain('15 crédits Netlify');
    expect(publicationAutorisee(env)).toBe(false);
  });

  it('sans le jeton, l’autorisation seule ne suffit pas (pas de contournement par le nom)', () => {
    const env = sans(autorise(), 'SORAHNEX_DEPLOY_AUTHORIZED_NAME');
    expect(publicationAutorisee(env)).toBe(false);
    expect(executer(commandeBuild!.split(' && ')[0], env).sortie)
      .toContain('SORAHNEX_DEPLOY_AUTHORIZED_NAME=sorahnex-deploy');
  });

  it.each(['sorahnex', 'SORAHNEX-DEPLOY', 'sorahnex-deploy ', 'true', 'autorise'])(
    'un jeton inventé (%s) ne lève pas le verrou', (jeton) => {
      expect(publicationAutorisee(autorise({ SORAHNEX_DEPLOY_AUTHORIZED_NAME: jeton }))).toBe(false);
    },
  );

  it('autorisation SEULE, sans identité de site : refusée (site relié par erreur)', () => {
    const env = { SORAHNEX_DEPLOY_AUTHORIZED: 'true', SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON };
    expect(ignoreAnnule(env)).toBe(true);
    expect(rideau2Refuse(env)).toBe(true);
  });

  it.each(['', 'false', '1', 'TRUE', ' true', 'oui'])(
    'valeur d’autorisation « %s » ≠ « true » exact → bloqué', (valeur) => {
      const env = autorise({ SORAHNEX_DEPLOY_AUTHORIZED: valeur });
      expect(ignoreAnnule(env)).toBe(true);
      expect(rideau2Refuse(env)).toBe(true);
    },
  );
});

// ===========================================================================
describe('Identité du site — positive, sans liste noire', () => {
  it('un site INCONNU est refusé, même avec toutes les autorisations', () => {
    const env = autorise({ SITE_ID: SITE_ID_AUTRE });
    expect(publicationAutorisee(env)).toBe(false);
    expect(executer(commandeBuild!.split(' && ')[0], env).sortie).toContain('n\'est pas le site autorisé');
  });

  it('un nom inconnu est refusé même avec le bon identifiant', () => {
    expect(publicationAutorisee(autorise({ SITE_NAME: 'autre-site' }))).toBe(false);
  });

  it('l’ancien site reste refusé explicitement, avec ou sans le bon identifiant', () => {
    const ancienNom = autorise({ SITE_NAME: identite.ANCIEN_SITE_NAME });
    expect(publicationAutorisee(ancienNom)).toBe(false);
    expect(executer(commandeBuild!.split(' && ')[0], ancienNom).sortie).toContain('ANCIEN site');
    // Identifiant inconnu ET ancien nom : refusé aussi.
    expect(publicationAutorisee(autorise({ SITE_ID: SITE_ID_AUTRE, SITE_NAME: identite.ANCIEN_SITE_NAME }))).toBe(false);
  });

  it('variantes d’identifiant refusées : casse, préfixe, troncature, suffixe', () => {
    for (const SITE_ID of [
      identite.SITE_ID.toUpperCase(), `${identite.SITE_ID}0`,
      identite.SITE_ID.slice(0, 35), `x${identite.SITE_ID.slice(1)}`,
    ]) {
      expect(publicationAutorisee(autorise({ SITE_ID })), SITE_ID).toBe(false);
    }
  });

  it('identité absente (pas un environnement Netlify) → fermé', () => {
    for (const env of [{}, { BRANCH: 'main' }, sans(autorise(), 'SITE_ID'), sans(autorise(), 'SITE_NAME')]) {
      expect(ignoreAnnule(env)).toBe(true);
      expect(rideau2Refuse(env)).toBe(true);
    }
  });
});

// ===========================================================================
describe('Branche et opt-in', () => {
  it.each(['arena/397677d5-saas-ugc', 'develop', 'feature/x', 'main2', ''])(
    'branche « %s » → aucune publication', (branche) => {
      expect(publicationAutorisee(autorise({ BRANCH: branche }))).toBe(false);
    },
  );

  it.each(['', 'false', '1', 'TRUE', ' true'])(
    'opt-in de build « %s » ≠ « true » → bloqué', (valeur) => {
      expect(publicationAutorisee(autorise({ VYORA_BUILD_ENABLED: valeur }))).toBe(false);
    },
  );
});

// ===========================================================================
describe('Migration de site — changer un seul fichier doit suffire', () => {
  const NOUVEAU = 'aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb';
  const contenu = `SITE_ID=${NOUVEAU}\nSITE_NAME=mon-nouveau-site\nANCIEN_SITE_NAME=vyora-ugc\n`;

  it('après remplacement de l’identité, le NOUVEAU site passe et l’ancien est refusé', () => {
    const dir = depotTemporaire(contenu);
    const envNouveau: Env = {
      SITE_ID: NOUVEAU, SITE_NAME: 'mon-nouveau-site', BRANCH: 'main',
      VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true',
      SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON,
    };
    expect(executerDans(dir, 'netlify-ignore.sh', envNouveau).code).toBe(1); // 1 = on continue
    expect(executerDans(dir, 'netlify-build-guard.sh', envNouveau).code).toBe(0); // 0 = autorisé
    // L'ancien site reste refusé : le refus de l'ancien nom n'est pas une cible.
    expect(executerDans(dir, 'netlify-build-guard.sh', { ...envNouveau, SITE_NAME: 'vyora-ugc' }).code).not.toBe(0);
    expect(executerDans(dir, 'netlify-build-guard.sh', { ...envNouveau, SITE_ID: SITE_ID_AUTRE }).code).not.toBe(0);
  });

  it('un fichier d’identité mal formé est refusé, jamais toléré', () => {
    for (const mauvais of [
      '',
      'SITE_NAME=mon-site\n',
      'SITE_ID=pas-un-uuid\nSITE_NAME=mon-site\n',
      'SITE_ID=aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb\n',
      'SITE_ID=aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb\nSITE_NAME=Mon_Site_Majuscules\n',
      `SITE_ID=${NOUVEAU}\nSITE_NAME=vyora-ugc\n`,
    ]) {
      const dir = depotTemporaire(mauvais);
      const env: Env = {
        SITE_ID: NOUVEAU, SITE_NAME: 'mon-site', BRANCH: 'main',
        VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true',
        SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON,
      };
      expect(executerDans(dir, 'netlify-build-guard.sh', env).code, JSON.stringify(mauvais)).not.toBe(0);
    }
  });

  it('fichier d’identité absent → refus (configuration introuvable, pas de repli permissif)', () => {
    const dir = depotTemporaire('');
    rmSync(join(dir, 'netlify.site.conf'));
    const env: Env = {
      SITE_ID: NOUVEAU, SITE_NAME: 'mon-site', BRANCH: 'main',
      VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true',
      SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON,
    };
    const r = executerDans(dir, 'netlify-build-guard.sh', env);
    expect(r.code).not.toBe(0);
    expect(r.sortie).toContain('introuvable');
  });
});

// ===========================================================================
describe('Diagnostic — le message dit exactement ce qui manque', () => {
  it('l’état observé et l’identité attendue sont écrits, avec la procédure', () => {
    const r = executer(commandeBuild!.split(' && ')[0], { SITE_ID: SITE_ID_AUTRE, SITE_NAME: 'inconnu', BRANCH: 'main' });
    expect(r.sortie).toContain('déploiement REFUSÉ');
    expect(r.sortie).toContain('Raison :');
    expect(r.sortie).toContain(`SITE_ID   = ${identite.SITE_ID}`);
    expect(r.sortie).toContain(`SITE_NAME = ${identite.SITE_NAME}`);
    expect(r.sortie).toContain('Aucun déploiement n\'a eu lieu');
    expect(r.sortie).toContain('docs/NETLIFY_DEPLOYMENT_CHECKLIST.md');
    expect(r.sortie).toContain('netlify.site.conf');
  });

  it('chaque condition manquante a son message propre, pas un refus muet', () => {
    const cas: [Env, string][] = [
      [autorise({ SITE_ID: SITE_ID_AUTRE }), 'n\'est pas le site autorisé'],
      [autorise({ SITE_NAME: 'autre-site' }), 'le site autorisé s\'appelle'],
      [autorise({ BRANCH: 'dev' }), 'seule la branche main'],
      [sans(autorise(), 'VYORA_BUILD_ENABLED'), 'VYORA_BUILD_ENABLED doit valoir'],
      [sans(autorise(), 'SORAHNEX_DEPLOY_AUTHORIZED', 'SORAHNEX_DEPLOY_AUTHORIZED_NAME'), 'AUTORISATION HUMAINE ABSENTE'],
      [sans(autorise(), 'SORAHNEX_DEPLOY_AUTHORIZED_NAME'), 'jeton d\'autorisation'],
    ];
    for (const [env, attendu] of cas) {
      const r = executer(commandeBuild!.split(' && ')[0], env);
      expect(r.code, attendu).not.toBe(0);
      expect(r.sortie, attendu).toContain(attendu);
    }
  });
});

// ===========================================================================
describe('Développement local — ne doit jamais ressembler à une publication', () => {
  it('sans variables Netlify, la garde annule et n’écrit rien', () => {
    const r = executer(commandeIgnore!, {});
    expect(r.code).toBe(0); // annulé
    expect(r.sortie).toContain('build annule');
  });

  it('la commande de build local ne fait pas partie de la garde', () => {
    // `npm run build` reste utilisable en local : la garde est dans la commande
    // Netlify, pas dans le script npm.
    const pkg = JSON.parse(lire('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('tsc -b && vite build');
    expect(pkg.scripts.build).not.toContain('netlify');
  });

  it('aucun script npm ne déclenche Netlify (build hook, CLI, déploiement)', () => {
    const pkg = JSON.parse(lire('package.json')) as { scripts: Record<string, string> };
    for (const [nom, commande] of Object.entries(pkg.scripts)) {
      expect(commande, nom).not.toMatch(/netlify (deploy|build|link)|build_hook|BUILD_HOOK/);
    }
  });
});

// ===========================================================================
describe('Défense en profondeur — ce que la garde NE doit pas permettre', () => {
  it('le fichier d’identité est lu comme des données, jamais exécuté', () => {
    // Un `$(commande)` dans le fichier ne doit pas s'exécuter : la valeur est
    // prise littéralement, puis rejetée comme nom mal formé.
    const dir = depotTemporaire(
      'SITE_ID=$(touch /tmp/sorahnex-injection)\nSITE_NAME=mon-site\n',
    );
    const env: Env = {
      SITE_ID: NOUVEAU_POUR_INJECTION, SITE_NAME: 'mon-site', BRANCH: 'main',
      VYORA_BUILD_ENABLED: 'true', SORAHNEX_DEPLOY_AUTHORIZED: 'true',
      SORAHNEX_DEPLOY_AUTHORIZED_NAME: JETON,
    };
    const r = executerDans(dir, 'netlify-build-guard.sh', env);
    expect(r.code).not.toBe(0);
    expect(r.sortie).toContain('mal formé');
  });

  it('les noms de variables d’autorisation sont constants : les renommer ne sert à rien', () => {
    const lib = lire('scripts/netlify-guard-lib.sh');
    // Les deux noms sont affectés en dur, jamais relus depuis l'environnement.
    expect(lib).toMatch(/AUTORISATION_DEPLOIEMENT="SORAHNEX_DEPLOY_AUTHORIZED"/);
    expect(lib).toMatch(/AUTORISATION_DEPLOIEMENT_NOM="sorahnex-deploy"/);
    // Une variable d'environnement portant ces noms ne les remplace pas.
    const r = executer(commandeBuild!.split(' && ')[0], {
      ...autorise(),
      AUTORISATION_DEPLOIEMENT: 'N_IMPORTE_QUOI',
      SORAHNEX_DEPLOY_AUTHORIZED_NAME: 'sorahnex-deploy',
    });
    expect(r.code).toBe(0); // le jeton reste celui du code, pas celui de l'environnement
  });

  it('les scripts de garde sont syntaxiquement valides et exécutables', () => {
    for (const script of ['scripts/netlify-ignore.sh', 'scripts/netlify-build-guard.sh', 'scripts/netlify-guard-lib.sh']) {
      const r = spawnSync('sh', ['-n', join(RACINE, script)], { encoding: 'utf8' });
      expect(r.status, `${script}: ${r.stderr}`).toBe(0);
    }
  });
});
