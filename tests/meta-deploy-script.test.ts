import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

/**
 * Garde-fous du script de déploiement Meta.
 *
 * `scripts/deploy-meta-functions.sh` est le seul fichier du dépôt qui puisse
 * écrire en production. Il est exécuté par une personne pressée, parfois en
 * copiant une commande depuis une documentation. Deux erreurs y seraient
 * coûteuses et silencieuses :
 *   1. déployer `index.ts` au lieu du chargeur → la fonction démarre puis
 *      échoue, ou pire, sert une version inattendue ;
 *   2. déployer sans contrôle préalable → épingle pointant sur un commit non
 *      poussé, donc 503 à froid, découvert par l'utilisateur final.
 *
 * Ces tests lisent le script, ils ne l'exécutent pas : aucun accès réseau, et
 * aucune possibilité qu'un test lance un déploiement.
 */

const SCRIPT = readFileSync('scripts/deploy-meta-functions.sh', 'utf8');

describe('script de déploiement Meta — confinement', () => {
  it('ne déploie QUE les fonctions Meta', () => {
    const deploiees = [...SCRIPT.matchAll(/supabase functions deploy (\S+)/g)].map((m) => m[1]);
    // Liste blanche exhaustive : toute fonction ajoutée ici doit être Meta.
    // C'est la garantie que ce script ne redéploie pas du code hors périmètre.
    expect(deploiees).toEqual(['meta-connect', 'meta-webhook', 'meta-lifecycle']);
    for (const f of deploiees) expect(f).toMatch(/^meta-/);
  });

  it('ne touche à aucune autre fonction du projet', () => {
    // Les cinq fonctions Reelora et Business Grow sont hors périmètre : une
    // exécution ne doit jamais les redéployer par effet de bord.
    for (const horsPerimetre of [
      'reelora-ai',
      'reelora-video',
      'business-grow',
      'reelora-health',
      'reelora-video-worker',
      'store-import',
      'store-connect',
      'mcp-client',
    ]) {
      expect(SCRIPT).not.toMatch(new RegExp(`deploy ${horsPerimetre}`));
    }
  });

  it('ne pose, ne supprime et ne lit AUCUN secret', () => {
    /*
     * Le script MONTRE la commande à taper (« posez-les d'abord : supabase
     * secrets set … »). C'est une consigne affichée, pas une action. La
     * distinction qui compte est donc : la ligne est-elle EXÉCUTÉE, ou
     * seulement imprimée ? On n'examine que les lignes exécutables.
     */
    const executables = SCRIPT.split('\n')
      .map((ligne) => ligne.trim())
      .filter((ligne) => ligne.length > 0 && !ligne.startsWith('#'))
      // Une ligne préfixée par `echo` est une consigne, pas une commande.
      .filter((ligne) => !/^echo\b/.test(ligne));

    for (const interdite of [/secrets set/, /secrets unset/, /secrets reveal/]) {
      expect(
        executables.filter((ligne) => interdite.test(ligne)),
        `commande ${interdite} réellement exécutée par le script`,
      ).toEqual([]);
    }
    // `list` est permis : il ne renvoie que des noms, afin de signaler un manque.
    expect(executables.some((ligne) => ligne.includes('secrets list'))).toBe(true);
  });

  it('ne déploie pas index.ts mais le chargeur', () => {
    expect(SCRIPT).toContain('--entrypoint loader.ts');
    expect(SCRIPT).not.toContain('--entrypoint index.ts');
  });

  it('exige --apply : sans ce drapeau, rien ne part', () => {
    expect(SCRIPT).toContain('APPLIQUER=0');
    expect(SCRIPT).toContain('[ "${1:-}" = "--apply" ]');
    // Le garde-fou doit précéder le déploiement dans le flux du script.
    expect(SCRIPT.indexOf('APPLIQUER')).toBeLessThan(SCRIPT.indexOf('supabase functions deploy'));
  });

  it('vérifie la parité des chargeurs avant toute écriture', () => {
    const controle = SCRIPT.indexOf('build-edge-artifact.mjs "$f" --check');
    const deploiement = SCRIPT.indexOf('supabase functions deploy');
    expect(controle).toBeGreaterThan(-1);
    expect(controle).toBeLessThan(deploiement);
  });

  it('exige que le commit épinglé soit joignable, pas seulement local', () => {
    // C'est la panne la plus probable d'un chargeur : le commit existe dans le
    // clone du développeur, pas sur GitHub. La fonction démarre, télécharge,
    // échoue, et répond 503 sans que rien ne l'ait signalé avant.
    expect(SCRIPT).toContain('git ls-remote');
    expect(SCRIPT).toContain('gh api');
  });

  it('fixe verify_jwt = false sur chacune, et le justifie', () => {
    // Meta ne peut présenter aucun JWT Supabase : chaque déploiement doit donc
    // désactiver la vérification de la passerelle, sinon Meta reçoit un 401.
    const deploiements = [...SCRIPT.matchAll(/supabase functions deploy (\S+)([\s\S]*?)(?=supabase functions deploy|$)/g)];
    expect(deploiements).toHaveLength(3);
    for (const [, nom, bloc] of deploiements) {
      expect(bloc, `${nom} doit être déployée avec --no-verify-jwt`).toContain('--no-verify-jwt');
      expect(bloc, `${nom} doit déployer le chargeur`).toContain('--entrypoint loader.ts');
    }
    expect(SCRIPT).toMatch(/Meta ne peut présenter aucun JWT|verify_jwt/);
  });

  it('est exécutable', () => {
    expect(statSync('scripts/deploy-meta-functions.sh').mode & 0o111).not.toBe(0);
  });

  it('ne contient aucune valeur de secret', () => {
    expect(SCRIPT).not.toMatch(/EAA[A-Za-z0-9]{10,}/);
    expect(SCRIPT).not.toMatch(/eyJhbGciOi/);
    expect(SCRIPT).not.toMatch(/sb_secret_/);
  });

  it('n’écrase pas le script de déploiement historique', () => {
    // Deux fichiers distincts : modifier l'un ne doit pas changer l'autre.
    expect(SCRIPT).not.toContain('reelora-health');
  });
});
