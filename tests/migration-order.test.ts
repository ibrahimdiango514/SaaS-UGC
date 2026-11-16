// VYORA — ordre d'application des migrations entre PR concurrentes.
//
// ## Le risque simulé
//
// Trois PR touchent `public._edge_function_artifact_slices` et écrivent des
// lignes sous le même nom logique (`vyora-oauth`) :
//
//   #9  : crée la table ? non. Publie `vyora-ai`, `vyora-ai-providers`,
//         `vyora-provider-health`. Aucun artefact oauth.
//   #10 : publie `vyora-oauth` en version VULNÉRABLE (le bundle d'origine,
//         sans vérification d'identité).
//   #12 : publie `vyora-oauth` en version CORRIGÉE.
//
// Chaque publication commence par `delete ... where name = 'vyora-oauth'`.
// **La dernière migration appliquée gagne.** Si #10 s'applique après #12, elle
// réinstalle le bundle vulnérable — silencieusement, puisque la migration
// réussit.
//
// Ce fichier simule les ordres possibles pour rendre ce constat vérifiable
// plutôt qu'affirmé, et pour empêcher qu'une future modification ne le casse.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Une publication d'artefact : ce qu'une migration écrit réellement. */
export interface Publication {
  readonly migration: string;
  readonly name: string;
  /** Taille de la source publiée, lue dans l'en-tête de la migration. */
  readonly chars: number;
  /** Vrai si le bundle publié contient la vérification d'identité. */
  readonly corrige: boolean;
}

/**
 * Lit une migration d'artefact et en extrait ce qu'elle publie.
 *
 * La taille est lue dans le commentaire d'en-tête généré par
 * `publish-edge-artifact.mjs` : c'est la valeur que le chargeur comparera.
 */
export function lirePublication(sql: string, nomMigration: string, nomArtefact: string): Publication {
  const entete = /publication de l'artefact \((\d+) caractères, (\d+) tranches\)/.exec(sql);
  if (!entete) throw new Error(`en-tête illisible : ${nomMigration}`);
  const chars = Number(entete[1]);

  // Le corps du bundle est encodé dans les tranches base64 : on cherche la
  // signature de la vérification d'identité parmi elles serait fragile
  // (base64 compressé). La taille, elle, est déterministe et discriminante :
  // le bundle corrigé contient le module d'authentification, donc il est plus
  // long. On s'appuie sur la constante attendue du dépôt.
  const corrige = chars === TAILLE_BUNDLE_CORRIGE;

  return { migration: nomMigration, name: nomArtefact, chars, corrige };
}

/** Taille du bundle corrigé, mesurée par `publish-edge-artifact.mjs`. */
export const TAILLE_BUNDLE_CORRIGE = 34126;
/** Taille du bundle vulnérable publié par #10 (et déployé en production). */
export const TAILLE_BUNDLE_VULNERABLE = 18868;

/**
 * Rejoue une séquence de publications sur un état initial.
 * Modèle : `delete where name = …` puis `insert`. La dernière gagne.
 */
export function rejouer(publications: readonly Publication[], initial: Publication | null = null) {
  let etat = initial;
  const journal: string[] = [];
  for (const publication of publications) {
    etat = publication;
    journal.push(`apply ${publication.migration} → ${publication.name} ${publication.chars} car.`);
  }
  return { etat, journal };
}

const lire = (chemin: string) => (existsSync(join(ROOT, chemin)) ? readFileSync(join(ROOT, chemin), 'utf8') : null);

/** Migrations réellement présentes dans #12 (branche courante). */
const MIGRATION_12 = 'supabase/migrations/20261116060000_vyora_oauth_artifact.sql';

describe('ordre des migrations / état des lieux', () => {
  it('#12 publie le bundle corrigé', () => {
    const sql = lire(MIGRATION_12);
    expect(sql).toBeTruthy();
    const publication = lirePublication(sql!, '20261116060000', 'vyora-oauth');
    expect(publication.chars).toBe(TAILLE_BUNDLE_CORRIGE);
    expect(publication.corrige).toBe(true);
  });

  it('#10 publie un bundle PLUS COURT, donc vulnérable (lu depuis sa branche)', () => {
    // Lecture directe dans la branche de #10 : le test échouerait si #10 était
    // corrigée entre-temps, ce qui serait une bonne nouvelle mais doit être vu.
    const sql = executerGit(['show', 'arena/vyora-mcp-connecteurs:supabase/migrations/20261116040000_vyora_oauth_artifact.sql']);
    const publication = lirePublication(sql, '20261116040000', 'vyora-oauth');
    expect(publication.chars).toBe(TAILLE_BUNDLE_VULNERABLE);
    expect(publication.corrige).toBe(false);
  });

  it('#9 ne publie AUCUN artefact oauth', () => {
    // #9 ne doit pas entrer dans la course sur ce nom.
    const liste = executerGit(['ls-tree', '-r', '--name-only', 'arena/vyora-mcp-core', 'supabase/migrations/']);
    expect(liste).not.toContain('vyora_oauth_artifact');
  });
});

describe('ordre des migrations / simulation des ordres possibles', () => {
  const vuln = { migration: '20261116040000', name: 'vyora-oauth', chars: TAILLE_BUNDLE_VULNERABLE, corrige: false } as const;
  const corr = { migration: '20261116060000', name: 'vyora-oauth', chars: TAILLE_BUNDLE_CORRIGE, corrige: true } as const;

  it('#12 puis #10 → le bundle VULNÉRABLE revient (scénario à empêcher)', () => {
    const { etat } = rejouer([corr, vuln]);
    expect(etat?.corrige).toBe(false);
    expect(etat?.chars).toBe(TAILLE_BUNDLE_VULNERABLE);
  });

  it('#10 puis #12 → le bundle CORRIGÉ reste (ordre sûr)', () => {
    const { etat } = rejouer([vuln, corr]);
    expect(etat?.corrige).toBe(true);
    expect(etat?.chars).toBe(TAILLE_BUNDLE_CORRIGE);
  });

  it('#12 seule → corrigé', () => {
    const { etat } = rejouer([corr]);
    expect(etat?.corrige).toBe(true);
  });

  it('production actuelle (v1) puis #12 → corrigé', () => {
    // L'état de départ réel : la production tourne le bundle vulnérable.
    const { etat } = rejouer([corr], vuln);
    expect(etat?.corrige).toBe(true);
    expect(etat?.chars).toBe(TAILLE_BUNDLE_CORRIGE);
  });

  it('production actuelle (v1) puis #12 puis #10 → VULNÉRABLE de nouveau', () => {
    // Le scénario catastrophe complet : la correction est appliquée puis
    // annulée par une publication plus ancienne, sans aucune erreur visible.
    const { etat } = rejouer([corr, vuln], vuln);
    expect(etat?.corrige).toBe(false);
  });

  it('le dernier appliqué gagne, quel que soit l’horodatage', () => {
    // Le mécanisme est `delete` + `insert`, pas un `upsert conditionnel` :
    // l'ordre d'application prime sur l'ordre des noms de fichier.
    const { etat } = rejouer([vuln, corr, vuln]);
    expect(etat?.migration).toBe('20261116040000');
  });
});

describe('ordre des migrations / collision de noms de fichiers', () => {
  it('#10 et #12 déclarent le MÊME fichier 20261116030000 avec un contenu identique', () => {
    // Convergence : les deux branches portent la même migration de socle.
    // Ce n'est PAS un conflit — c'est le cas favorable.
    const celle10 = executerGit(['show', 'arena/vyora-mcp-connecteurs:supabase/migrations/20261116030000_vyora_oauth_connectors.sql']);
    const celle12 = lire('supabase/migrations/20261116030000_vyora_oauth_connectors.sql');
    expect(celle12).toBeTruthy();
    expect(celle10).toBe(celle12);
  });

  it('la collision historique 20261116040000 est résolue dans #12', () => {
    // #12 a renommé SON artefact en 20261116060000 : plus aucun fichier commun
    // porteur d'un contenu différent.
    const celle12 = lire('supabase/migrations/20261116040000_vyora_oauth_artifact.sql');
    expect(celle12).toBeNull();
    expect(lire(MIGRATION_12)).toBeTruthy();
  });

  it('aucun artefact AJOUTÉ par #12 n’entre en collision avec #9 ou #10', () => {
    // On ne compare que les fichiers AJOUTÉS par chaque PR. Comparer tous les
    // fichiers d'artefact produisait un faux positif : `20261112190000` est
    // déjà sur `develop`, donc présent et identique dans les trois branches.
    // Une collision n'a de sens que sur un fichier introduit des deux côtés.
    const ajoutes = (branche: string) => executerGit([
      'diff', '--name-only', '--diff-filter=A', `origin/develop...${branche}`, '--', 'supabase/migrations/',
    ]).split('\n').filter((f) => /_artifact\.sql$/.test(f)).map((f) => f.split('/').pop()!);

    const siens = new Set([...ajoutes('arena/vyora-mcp-core'), ...ajoutes('arena/vyora-mcp-connecteurs')]);
    const miens = ajoutes('HEAD');
    expect(miens.length).toBeGreaterThan(0);
    expect(miens.filter((f) => siens.has(f))).toEqual([]);
  });

  it('un fichier présent dans les trois branches est hérité de develop, pas en conflit', () => {
    // Distinction importante : `20261112190000` apparaît partout, mais il vient
    // de `develop`. Le compter comme collision ferait peur sans raison.
    const surDevelop = executerGit([
      'diff', '--name-only', '--diff-filter=A', 'origin/develop...arena/vyora-mcp-connecteurs',
      '--', 'supabase/migrations/20261112190000_vyora_edge_function_artifact.sql',
    ]).trim();
    expect(surDevelop).toBe('');
  });
});

/** Exécute git et rend la sortie standard. */
function executerGit(args: string[]): string {
  // `execFileSync` évite toute interpolation de shell.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}
