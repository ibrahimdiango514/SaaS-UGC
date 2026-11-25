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
    // Le message doit nommer la valeur EXACTE attendue, en clair, pas seulement
    // le nom de la variable : c'est ce qui permet de corriger sans deviner.
    expect(executer(commandeBuild!.split(' && ')[0], env).sortie)
      .toMatch(/SORAHNEX_DEPLOY_AUTHORIZED_NAME doit valoir EXACTEMENT « sorahnex-deploy »/);
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
    // Un site inconnu est nommé, et le message renvoie au fichier d'identité.
    expect(executer(commandeBuild!.split(' && ')[0], env).sortie).toMatch(/n'est pas le site autorisé/);
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
      [autorise({ SITE_ID: SITE_ID_AUTRE }), "n'est pas le site autorisé"],
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

// ===========================================================================
describe('Documentation des variables — cohérente avec le code', () => {
  it('.env.example n’assigne AUCUNE variable hors VITE_ (une valeur réelle finirait par y être collée)', () => {
    const assignables = lire('.env.example')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[A-Z0-9_]+=/.test(l));
    expect(assignables.length).toBeGreaterThan(0);
    for (const ligne of assignables) {
      expect(ligne.split('=')[0], `variable non publique assignable : ${ligne}`).toMatch(/^VITE_/);
    }
  });

  it('les variables frontend réellement lues sont toutes documentées', () => {
    const lues = new Set<string>();
    const parcourir = (chemin: string) => {
      const { readdirSync, statSync, readFileSync } = require('node:fs') as typeof import('node:fs');
      for (const entree of readdirSync(join(RACINE, chemin))) {
        const complet = join(chemin, entree);
        if (statSync(join(RACINE, complet)).isDirectory()) parcourir(complet);
        else if (/\.(ts|tsx)$/.test(entree)) {
          for (const m of readFileSync(join(RACINE, complet), 'utf8').matchAll(/VITE_[A-Z0-9_]+/g)) lues.add(m[0]);
        }
      }
    };
    parcourir('src');
    const exemple = lire('.env.example');
    for (const nom of lues) {
      expect(exemple, `variable lue mais non documentée : ${nom}`).toContain(nom);
    }
  });

  it('la checklist d’environnement cite les quatre familles et le jeton d’autorisation', () => {
    const checklist = lire('docs/NETLIFY_ENVIRONMENT_CHECKLIST.md');
    expect(checklist).toContain('VITE_SITE_URL');
    expect(checklist).toContain('VYORA_BUILD_ENABLED');
    expect(checklist).toContain('SORAHNEX_DEPLOY_AUTHORIZED_NAME');
    expect(checklist).toContain('BUSINESS_GROW_');
    expect(checklist).toContain('CORS');
    // Le piège des deux noms d'IA doit rester documenté.
    expect(checklist).toMatch(/FREE_LLM_.*\n?.*BUSINESS_GROW_|BUSINESS_GROW_.*\n?.*FREE_LLM_/);
  });
});

// ===========================================================================
describe('Harnais de vérification — aucun repli vers un site mort', () => {
  it('verify-production refuse de deviner l’adresse du site', () => {
    const source = lire('scripts/verify-production.mjs');
    // Un repli sur l'ancien domaine produirait un rapport vert contre un site
    // fermé : c'est un faux positif, pire que pas de vérification du tout.
    expect(source).not.toMatch(/vyora-ugc\.netlify\.app/);
    expect(source).toContain('Adresse du site inconnue');
  });

  it('verify-production sort en code 2 (mesure impossible) sans adresse', () => {
    const r = spawnSync('node', ['scripts/verify-production.mjs'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Aucun repli');
  });

  it('l’audit d’origines signale l’ancien domaine quand il est encore codé en dur', () => {
    const r = spawnSync('node', ['scripts/audit-origins.mjs', '--json'], { encoding: 'utf8' });
    const rapport = JSON.parse(r.stdout);
    const mortes = rapport.constats.filter((c: { message: string }) => c.message.includes('HISTORIQUE'));
    expect(mortes.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe('Message de refus — dire la VRAIE cause, celle du journal Netlify', () => {
  /**
   * Le site `saas-ugc` a été refusé le 25/11/2026 parce qu'il n'était pas encore
   * déclaré. Depuis, le propriétaire l'a autorisé : il est devenu le site de
   * production, et `vyora-saas-ugc` l'ancien. Le cas de test qui compte
   * maintenant est celui de l'ANCIEN site, qui doit rester refusé.
   */
  const envAncienSite = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    SITE_ID: 'fc88d197-fe0b-47c7-a6e3-fba44eeccda9',
    SITE_NAME: 'vyora-saas-ugc',
    BRANCH: 'main',
    VYORA_BUILD_ENABLED: 'true',
  };

  it('un ANCIEN site est refusé pour cette raison précise, pas par un message générique', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], { encoding: 'utf8', env: envAncienSite as NodeJS.ProcessEnv });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ANCIEN site, explicitement écarté/);
  });

  it('le refus ne reproche JAMAIS une variable absente quand la cause est l’identité', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], { encoding: 'utf8', env: envAncienSite as NodeJS.ProcessEnv });
    // C'était le défaut du 25/11 : « VYORA_BUILD_ENABLED doit valoir true »
    // accusait une variable alors que le site n'était pas le bon.
    expect(r.stderr).not.toMatch(/Raison : VYORA_BUILD_ENABLED/);
    expect(r.stderr).not.toMatch(/Raison : AUTORISATION HUMAINE/);
  });

  it('un site ancien reste refusé même si TOUT le reste est correct (verrou inclus)', () => {
    // Le scénario dangereux : quelqu'un déclare les trois variables d'autorisation
    // sur l'ancien site « pour voir ». L'identité doit primer sur le verrou.
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], {
      encoding: 'utf8',
      env: {
        ...envAncienSite,
        SORAHNEX_DEPLOY_AUTHORIZED: 'true',
        SORAHNEX_DEPLOY_AUTHORIZED_NAME: 'sorahnex-deploy',
      } as NodeJS.ProcessEnv,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ANCIEN site/);
  });

  it('cite le site autorisé dans l’état du refus', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], { encoding: 'utf8', env: envAncienSite as NodeJS.ProcessEnv });
    expect(r.stderr).toMatch(/Site autorisé/);
    expect(r.stderr).toContain('6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803');
  });

  it('n’accuse pas la variable d’opt-in pour un site totalement inconnu', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', SITE_ID: '11111111-2222-3333-4444-555555555555', SITE_NAME: 'autre', BRANCH: 'main' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/n'est pas le site autorisé/);
    // Et surtout : il ne met pas la faute sur une variable.
    expect(r.stderr).not.toMatch(/Raison : VYORA_BUILD_ENABLED doit valoir/);
  });

  it('pour le site autorisé sans autorisation humaine, dit la vraie raison', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SITE_ID: '6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803',
        SITE_NAME: 'saas-ugc',
        BRANCH: 'main',
        VYORA_BUILD_ENABLED: 'true',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AUTORISATION HUMAINE ABSENTE/);
    expect(r.stderr).not.toMatch(/VYORA_BUILD_ENABLED doit valoir/);
  });

  it('le cas entièrement autorisé passe (le durcissement n’a rien cassé)', () => {
    const r = spawnSync('sh', ['scripts/netlify-build-guard.sh'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SITE_ID: '6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803',
        SITE_NAME: 'saas-ugc',
        BRANCH: 'main',
        VYORA_BUILD_ENABLED: 'true',
        SORAHNEX_DEPLOY_AUTHORIZED: 'true',
        SORAHNEX_DEPLOY_AUTHORIZED_NAME: 'sorahnex-deploy',
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/build autorisé/);
  });

  it('le rideau 1 ANNULE (code 0) pour l’ancien site : zéro crédit', () => {
    const r = spawnSync('sh', ['scripts/netlify-ignore.sh'], { encoding: 'utf8', env: envAncienSite as NodeJS.ProcessEnv, timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/build annule/);
  });

  it('netlify.toml de la branche ne contient AUCUN identifiant de site en dur', () => {
    // La version de main envoyait l'identifiant en argument de la commande : une
    // migration imposait de modifier deux endroits. La garde lit le fichier.
    const directives = lire('netlify.toml')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(directives).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(directives).toMatch(/command = "sh scripts\/netlify-build-guard\.sh && npm ci && npm run build"/);
    expect(directives).toMatch(/ignore = "sh scripts\/netlify-ignore\.sh"/);
  });
});

describe('Identité autorisée — le site choisi, et les anciens écartés', () => {
  it('netlify.site.conf autorise saas-ugc et écarte explicitement l’ancien site', () => {
    const conf = lire('netlify.site.conf');
    const autorise = conf.split('\n').find((l) => /^SITE_ID=/.test(l.trim()));
    expect(autorise).toContain('6ec85a76');
    expect(autorise).not.toContain('fc88d197');
    // L'ancien identifiant n'est pas supprimé : il est REFUSÉ nommément.
    expect(conf).toContain('ANCIEN_SITE_ID=fc88d197-fe0b-47c7-a6e3-fba44eeccda9');
    expect(conf).toContain('ANCIEN_SITE_NAME=vyora-ugc');
  });

  it('la documentation explique comment autoriser un site, par PR', () => {
    const checklist = lire('docs/NETLIFY_DEPLOYMENT_CHECKLIST.md');
    expect(checklist).toMatch(/ANCIEN_SITE_ID/);
    expect(checklist).toMatch(/par PR/i);
  });
});

// ===========================================================================
describe('Diagnostic d’une valeur PRESQUE correcte — le cas du 25/11 07:2x', () => {
  /**
   * Contexte réel : Netlify a affiché VYORA_BUILD_ENABLED=true,
   * SORAHNEX_DEPLOY_AUTHORIZED=true et un nom masqué « **** », puis a refusé.
   * Le site et les trois variables étaient bons. La cause était donc une
   * comparaison de valeur EXACTE — et elle était écrite AVANT les lignes que
   * Netlify a conservées, donc invisible. Ces tests vérifient que le diagnostic
   * est désormais impossible à manquer.
   */
  const base = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    SITE_ID: '6ec85a76-bf5f-4eed-9d9e-0a8f6b7f9803',
    SITE_NAME: 'saas-ugc',
    BRANCH: 'main',
    VYORA_BUILD_ENABLED: 'true',
    SORAHNEX_DEPLOY_AUTHORIZED: 'true',
  } as NodeJS.ProcessEnv;

  const lancer = (nom: string) =>
    spawnSync('sh', ['scripts/netlify-build-guard.sh'], {
      encoding: 'utf8',
      env: { ...base, SORAHNEX_DEPLOY_AUTHORIZED_NAME: nom },
    });

  it('la valeur exacte passe (le verrou reste utilisable)', () => {
    const r = lancer('sorahnex-deploy');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/build autorisé/);
  });

  it('un espace final est nommé comme un problème de SAISIE, pas de valeur', () => {
    const r = lancer('sorahnex-deploy ');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/contient des espaces ou un retour chariot/);
    expect(r.stderr).toMatch(/La valeur est bonne, la saisie ne l'est pas/);
  });

  it('un retour chariot (copier-coller depuis Windows) est nommé aussi', () => {
    const r = lancer('sorahnex-deploy\r');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/retour chariot/);
  });

  it('une majuscule est signalée avec la casse et la longueur', () => {
    const r = lancer('SORAHNEX-DEPLOY');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/vaut « SORAHNEX-DEPLOY » \(15 caractères\)/);
    expect(r.stderr).toMatch(/y compris la casse/);
  });

  it('un tiret oublié est signalé avec le nombre de caractères', () => {
    const r = lancer('sorahnexdeploy');
    expect(r.stderr).toMatch(/\(14 caractères\)/);
    expect(r.stderr).toMatch(/sorahnex-deploy/);
  });

  it('la raison est RÉPÉTÉE en dernière ligne (Netlify tronque le début)', () => {
    const r = lancer('sorahnex-deploy ');
    const lignes = r.stderr.trim().split('\n');
    // La dernière ligne utile doit suffire à comprendre quoi corriger.
    const fin = lignes.slice(-2).join('\n');
    expect(fin).toMatch(/À CORRIGER/);
    expect(fin).toMatch(/SORAHNEX_DEPLOY_AUTHORIZED_NAME/);
  });

  it('chaque refus commence par un numéro de règle, pour se repérer', () => {
    const r = lancer('sorahnex-deploy ');
    expect(r.stderr).toMatch(/règle 7\/8/);
  });

  it('un refus garde un code de sortie 1, distinct d’une erreur shell', () => {
    // Le journal Netlify annonçait « exit code 2 » : c'était le code du shell
    // appelant, pas celui de la garde. La garde sort TOUJOURS en 1.
    const r = lancer('mauvais-nom');
    expect(r.status).toBe(1);
  });
});

describe('La documentation couvre le refus « variables bonnes mais saisie fausse »', () => {
  it('explique le piège de l’espace final et déconseille de retirer la garde', () => {
    const doc = lire('docs/NETLIFY_DEPLOYMENT_CHECKLIST.md');
    expect(doc).toMatch(/espace final/);
    expect(doc).toMatch(/À CORRIGER/);
    // Retirer la garde est la « solution » proposée par les outils automatiques :
    // la documentation doit dire explicitement que c'est le contraire à faire.
    expect(doc).toMatch(/ne faut surtout pas faire/);
    expect(doc).toMatch(/command = "npm ci && npm run build"/);
  });
});

describe('Le journal tronqué suffit encore à agir', () => {
  /**
   * Constat sur DEUX journaux Netlify (25/11, matin et 7h38) : les deux extraits
   * transmis commençaient à « État observé » et s'arrêtaient juste après
   * « Site autorisé ». La ligne `Raison :`, située au-dessus, n'a jamais été
   * visible. Résultat : deux diagnostics successifs ont accusé les variables
   * alors que le script s'était arrêté AVANT de les examiner, sur l'identité.
   *
   * Le bas du bloc est donc la seule zone sur laquelle compter.
   */
  const journal = (env: NodeJS.ProcessEnv) =>
    spawnSync('sh', ['scripts/netlify-build-guard.sh'], { encoding: 'utf8', env }).stderr;

  it('un site non autorisé : les 2 dernières lignes disent l’identité ET la cause', () => {
    const r = journal({
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SITE_ID: '09412497-1111-2222-3333-444444444444',
      SITE_NAME: 'saas-ugc-0d54',
      BRANCH: 'main',
      VYORA_BUILD_ENABLED: 'true',
      SORAHNEX_DEPLOY_AUTHORIZED: 'true',
      SORAHNEX_DEPLOY_AUTHORIZED_NAME: 'sorahnex-deploy',
    });
    // Les deux dernières lignes utiles : l'identité, puis la cause. La toute
    // dernière est le trait de fermeture.
    const fin = r.trim().split('\n').slice(-3, -1).join('\n');
    expect(fin).toMatch(/Site déployé : SITE_ID=09412497/);
    expect(fin).toMatch(/À CORRIGER : .*n'est pas le site autorisé/);
    // Et surtout : le lecteur ne peut plus croire que la cause est une variable.
    expect(fin).not.toMatch(/VYORA_BUILD_ENABLED doit valoir/);
  });

  it('un refus n’est jamais suivi d’un second bloc (une seule cause à la fois)', () => {
    const r = journal({
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      SITE_ID: '09412497-1111-2222-3333-444444444444',
      SITE_NAME: 'saas-ugc-0d54',
      BRANCH: 'main',
    });
    expect(r.match(/déploiement REFUSÉ/g) ?? []).toHaveLength(1);
    expect(r.match(/À CORRIGER/g) ?? []).toHaveLength(1);
  });

  it('netlify.site.conf tolère un préfixe // sans casser l’identité', () => {
    // Certains éditeurs enregistrent un « // » de commentaire différent du « # ».
    // La conf doit rester inerte : aucune ligne non reconnue ne doit être
    // interprétée comme une identité.
    const conf = lire('netlify.site.conf');
    const lignesIdentite = conf.split('\n').filter((l) => /^\s*(SITE_ID|SITE_NAME|ANCIEN_SITE_ID|ANCIEN_SITE_NAME)=/.test(l));
    expect(lignesIdentite).toHaveLength(4);
  });
});

describe('Bascule d’identité — un seul geste, vérifié', () => {
  /** Copie le dépôt minimal nécessaire pour tester sans toucher au vrai fichier. */
  async function depotTemporaire() {
    const { mkdtempSync, mkdirSync, copyFileSync } = await import('node:fs');
    const { join: joindre } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(joindre(tmpdir(), 'bascule-'));
    mkdirSync(joindre(dir, 'scripts'), { recursive: true });
    for (const f of ['netlify-autoriser-site.sh', 'netlify-build-guard.sh', 'netlify-guard-lib.sh']) {
      copyFileSync(joindre(process.cwd(), 'scripts', f), joindre(dir, 'scripts', f));
    }
    copyFileSync(joindre(process.cwd(), 'netlify.site.conf'), joindre(dir, 'netlify.site.conf'));
    return dir;
  }

  it('affiche l’identité actuelle puis la nouvelle, et vérifie les deux', async () => {
    const dir = await depotTemporaire();
    const { rmSync } = await import('node:fs');
    try {
      const r = spawnSync('sh', ['scripts/netlify-autoriser-site.sh', '09412497-abcd-4abc-8abc-abcdefabcdef', 'saas-ugc-0d54'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/nouveau site : build AUTORISÉ/);
      expect(r.stdout).toMatch(/ancien site : refusé/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse un identifiant mal formé (avant toute écriture)', async () => {
    const dir = await depotTemporaire();
    const { rmSync } = await import('node:fs');
    try {
      const r = spawnSync('sh', ['scripts/netlify-autoriser-site.sh', 'pas-un-uuid', 'saas-ugc'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/identifiant mal formé/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse de revenir sur un site explicitement écarté', async () => {
    const dir = await depotTemporaire();
    const { rmSync } = await import('node:fs');
    try {
      const r = spawnSync('sh', ['scripts/netlify-autoriser-site.sh', 'fc88d197-fe0b-47c7-a6e3-fba44eeccda9', 'vyora-saas-ugc'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/explicitement écarté/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ne laisse JAMAIS l’ancien site autorisé après une bascule', async () => {
    const dir = await depotTemporaire();
    const { rmSync, readFileSync } = await import('node:fs');
    const { join: joindre } = await import('node:path');
    try {
      spawnSync('sh', ['scripts/netlify-autoriser-site.sh', '09412497-abcd-4abc-8abc-abcdefabcdef', 'saas-ugc-0d54'], { cwd: dir, encoding: 'utf8' });
      const conf = readFileSync(joindre(dir, 'netlify.site.conf'), 'utf8');
      const autorise = conf.split('\n').find((l) => /^SITE_ID=/.test(l));
      // L'ancien identifiant doit avoir QUITTÉ la ligne d'autorisation.
      expect(autorise).not.toContain('6ec85a76');
      expect(conf).toContain('ANCIEN_SITE_ID=6ec85a76');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('le vrai netlify.site.conf n’a pas été modifié par les tests', () => {
    const conf = lire('netlify.site.conf');
    expect(conf.split('\n').find((l) => /^SITE_ID=/.test(l))).toContain('6ec85a76');
  });
});
