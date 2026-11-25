import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `grantWorkspace` — la requête SQL doit correspondre au CONTRAT réel de
 * `saas_business.bg_can_workspace`.
 *
 * ## Incident du 25/11/2026
 * Production : `column "can_read" does not exist`, HTTP 500 sur TOUTE action
 * authentifiée de Store Connect (connect, status, preview, disconnect,
 * probe-custom, save-custom). Cause : la requête écrivait
 *
 *     select can_read, can_write from saas_business.bg_can_workspace(...)
 *
 * Or la fonction renvoie un **booléen scalaire**, jamais une table :
 *
 *     RETURNS boolean  (migration 20261114120000_business_agent_workspace.sql)
 *
 * `from f(...)` sur une fonction scalaire produit une table à UNE colonne
 * nommée d'après la fonction — d'où `column "can_read" does not exist`.
 * `store-import` faisait correctement `select bg_can_workspace(...) as can_read`.
 *
 * ## Pourquoi aucun test ne l'avait vu
 * Toutes les suites injectent un faux `grantWorkspace` : la requête réelle
 * n'était jamais exécutée. Ces tests-ci lisent la source et vérifient la
 * FORME de la requête, ce qui ne demande pas de base.
 */
const lire = (chemin: string) => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8');

/**
 * Retire les commentaires avant l'analyse.
 *
 * La forme fautive est CITÉE dans la documentation du correctif — c'est utile
 * pour le prochain lecteur, mais ce n'est pas du code exécuté. Sans ce
 * nettoyage, le test se piège lui-même en trouvant le motif dans l'explication.
 */
function sansCommentaires(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/^\s*\/\/.*$/gm, '')        // // ...
    .replace(/^\s*#.*$/gm, '');           // # ... (dans les littéraux SQL)
}

const MIGRATION = 'supabase/migrations/20261114120000_business_agent_workspace.sql';

/** Extrait la requête `grantWorkspace` d'un fichier de fonction. */
function requeteGrant(source: string): string {
  const debut = source.indexOf('async grantWorkspace');
  expect(debut, 'grantWorkspace introuvable').toBeGreaterThan(-1);
  // La requête est dans un littéral gabarit juste après la signature.
  const fin = source.indexOf('finally', debut);
  return source.slice(debut, fin === -1 ? debut + 800 : fin);
}

describe('contrat SQL de bg_can_workspace', () => {
  it('la migration déclare un RETOURS BOOLÉEN, pas une table', () => {
    const migration = lire(MIGRATION);
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION saas_business\.bg_can_workspace\([^)]*\)\s*RETURNS boolean/,
    );
    // Une fonction `RETURNS TABLE` changerait tout le raisonnement ci-dessous.
    expect(migration).not.toMatch(/bg_can_workspace\([^)]*\)\s*RETURNS TABLE/);
  });
});

describe('store-connect : grantWorkspace respecte le contrat', () => {
  const source = lire('supabase/functions/store-connect/index.ts');
  const code = sansCommentaires(source);

  it('n’utilise PAS `from saas_business.bg_can_workspace(...)` (forme fautive)', () => {
    // C'est exactement la requête qui a produit « column "can_read" does not exist ».
    expect(code).not.toMatch(/from\s+saas_business\.bg_can_workspace\s*\(/);
  });

  it('appelle la fonction en expression scalaire, avec ses deux alias', () => {
    const requete = requeteGrant(source);
    expect(requete).toMatch(/saas_business\.bg_can_workspace\([^)]*\)\s+as\s+can_read/);
    expect(requete).toMatch(/saas_business\.bg_can_workspace\([^)]*\)\s+as\s+can_write/);
  });

  it('le drapeau d’écriture vaut TRUE pour can_write et FALSE pour can_read', () => {
    const requete = requeteGrant(source);
    // `true` = rôle d'écriture exigé ; `false` = simple lecture suffisante.
    expect(requete).toMatch(/bg_can_workspace\([^)]*,\s*false\s*\)\s+as\s+can_read/);
    expect(requete).toMatch(/bg_can_workspace\([^)]*,\s*true\s*\)\s+as\s+can_write/);
  });

  it('les paramètres sont castés en uuid (comme store-import)', () => {
    const requete = requeteGrant(source);
    expect(requete).toMatch(/::uuid/);
  });
});

describe('store-import : référence de forme correcte', () => {
  it('store-import garde la forme scalaire qui fonctionne en production', () => {
    const source = lire('supabase/functions/store-import/index.ts');
    const requete = requeteGrant(source);
    expect(requete).toMatch(/saas_business\.bg_can_workspace\([^)]*\)\s+as\s+can_read/);
    expect(sansCommentaires(source)).not.toMatch(/from\s+saas_business\.bg_can_workspace\s*\(/);
  });
});
