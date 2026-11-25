import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Contrat SQL des fonctions appelées en `FROM` par le code Edge.
 *
 * ## Incident du 25/11/2026
 * `store-connect` appelait une fonction SCALAIRE comme si elle renvoyait une
 * table :
 *
 *     select can_read, can_write from saas_business.bg_can_workspace(...)
 *
 * `bg_can_workspace` est déclarée `RETURNS boolean`. En PostgreSQL,
 * `from f(...)` sur une fonction scalaire produit une table à UNE colonne
 * nommée d'après la fonction : PostgreSQL répond
 * `column "can_read" does not exist`, la fonction Edge renvoie 500, et TOUTE
 * action authentifiée de Store Connect échoue.
 *
 * ## Ce que fait ce test
 * Il rejoue l'audit qui a trouvé ce bug, sur tout le code livré :
 *   1. relève chaque `from <schema>.<fonction>(` ;
 *   2. lit la DERNIÈRE déclaration de cette fonction dans les migrations,
 *      dans l'ordre chronologique (le tri par NOM est l'ordre d'application) ;
 *   3. exige que la déclaration soit `RETURNS TABLE` ou `RETURNS SETOF`.
 *
 * Une future fonction scalaire appelée en `from` sera donc signalée ici, et
 * non par un 500 en production.
 */

const MIGRATIONS = 'supabase/migrations';

/** Toutes les migrations, dans l'ordre d'application (tri par nom de fichier). */
const schemaSql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
  .join('\n');

/** Type de retour de la dernière déclaration d'une fonction. */
function typeDeRetour(
  nom: string,
  sql: string = schemaSql,
): { type: string; tabulaire: boolean } | null {
  const declarations = [
    ...sql.matchAll(
      // `create function`, `CREATE OR REPLACE FUNCTION`, casse indifférente.
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:saas_[a-z_]+\\.)?${nom}\\s*\\(`, 'gi'),
    ),
  ];
  if (declarations.length === 0) return null;
  const derniere = declarations[declarations.length - 1];
  const bloc = sql.slice(derniere.index, derniere.index + 2_000);
  const m = /RETURNS\s+(TABLE\s*\(|SETOF\b|[A-Za-z_][A-Za-z_0-9]*)/i.exec(bloc);
  if (!m) return null;
  const type = m[1].replace(/\s+/g, ' ').trim();
  return { type, tabulaire: /^TABLE\s*\(/i.test(type) || /^SETOF/i.test(type) };
}

/**
 * Retire les commentaires : le correctif CITE la forme fautive pour expliquer
 * l'incident, et une citation n'est pas un appel.
 */
function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (bloc) => bloc.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

/** Fichiers Edge livrés (les artefacts minifiés ne sont pas du code source). */
function fichiersEdge(dir = 'supabase/functions'): string[] {
  const sortie: string[] = [];
  for (const entree of readdirSync(dir, { withFileTypes: true })) {
    if (entree.name === '_artifacts' || entree.name === 'node_modules') continue;
    const chemin = join(dir, entree.name);
    if (entree.isDirectory()) sortie.push(...fichiersEdge(chemin));
    else if (entree.name.endsWith('.ts')) sortie.push(chemin);
  }
  return sortie;
}

/** `[fonction, fichier, ligne]` pour chaque appel en `FROM`. */
function appelsEnFrom(): { nom: string; fichier: string; ligne: number }[] {
  const sortie: { nom: string; fichier: string; ligne: number }[] = [];
  for (const fichier of fichiersEdge()) {
    sansCommentaires(readFileSync(fichier, 'utf8')).split('\n').forEach((texte, index) => {
      for (const m of texte.matchAll(/from\s+saas_[a-z_]+\.([a-z_]+)\s*\(/gi)) {
        sortie.push({ nom: m[1], fichier, ligne: index + 1 });
      }
    });
  }
  return sortie;
}

describe('détecteur — validation sur des déclarations connues', () => {
  // Sans ces contrôles, un détecteur cassé ferait « passer » tout le reste.
  const sql = readFileSync(`${MIGRATIONS}/20261114120000_business_agent_workspace.sql`, 'utf8');

  it('reconnaît une fonction scalaire', () => {
    expect(typeDeRetour('bg_can_workspace', sql)).toEqual({ type: 'boolean', tabulaire: false });
  });

  it('reconnaît une fonction tabulaire déclarée sur plusieurs lignes', () => {
    const r = typeDeRetour('bg_list_conversations', sql);
    expect(r?.tabulaire).toBe(true);
    expect(r?.type).toMatch(/^TABLE/i);
  });

  it('reconnaît `returns table` en minuscules', () => {
    const minuscules = readFileSync(`${MIGRATIONS}/20261115100000_vyora_ai_core_registry.sql`, 'utf8');
    expect(typeDeRetour('ai_memory_search', minuscules)?.tabulaire).toBe(true);
  });

  it('renvoie null pour une fonction inexistante', () => {
    expect(typeDeRetour('fonction_qui_nexiste_pas', sql)).toBeNull();
  });
});

describe('code Edge — aucun appel en FROM sur une fonction non tabulaire', () => {
  const appels = appelsEnFrom();

  it('relève des appels (le détecteur voit bien le code)', () => {
    expect(appels.length).toBeGreaterThan(10);
  });

  it('chaque fonction appelée en FROM renvoie une table', () => {
    const fautifs = appels
      .map((appel) => ({ ...appel, retour: typeDeRetour(appel.nom) }))
      .filter((appel) => appel.retour && !appel.retour.tabulaire)
      .map((appel) => `${appel.fichier}:${appel.ligne} — ${appel.nom} RETURNS ${appel.retour!.type}`);

    // Message explicite : la cause exacte de l'incident de production.
    expect(
      fautifs,
      `Appel en FROM d'une fonction scalaire (produit « column ... does not exist ») :\n${fautifs.join('\n')}`,
    ).toEqual([]);
  });

  it('chaque fonction appelée en FROM existe dans les migrations', () => {
    // Une fonction absente des migrations ne peut pas être vérifiée ici : le
    // dire explicitement vaut mieux que laisser croire à un contrôle complet.
    const inconnues = [...new Set(appels.map((a) => a.nom))]
      .filter((nom) => typeDeRetour(nom) === null)
      .sort();
    expect(inconnues).toEqual([]);
  });
});

describe('store-connect — la régression précise est verrouillée', () => {
  it('les deux appels de droits sont scalaires et aliasés', () => {
    const source = readFileSync('supabase/functions/store-connect/index.ts', 'utf8');
    expect(source).toMatch(/bg_can_workspace\([^)]*,\s*false\)\s+as\s+can_read/);
    expect(source).toMatch(/bg_can_workspace\([^)]*,\s*true\)\s+as\s+can_write/);
  });
});
