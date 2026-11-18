import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Garde d'accès Import & Connect : lecture réelle des droits en base.
 *
 * ## Le défaut que ce fichier verrouille
 * `saas_business.bg_import_access` renvoie **un seul `jsonb`**, et non une
 * table. Lire `select * from saas_business.bg_import_access(…)` produit donc
 * UNE colonne nommée d'après la fonction, et `row.allowed` vaut toujours
 * `undefined` : la garde refusait **tout le monde**, abonnés compris.
 *
 * Aucun test ne pouvait le voir : les tests du handler injectent
 * `checkImportConnectAccess` et n'exécutent jamais le SQL. Le 2026-11-16, la
 * production l'a révélé — un compte avec abonnement `active` recevait
 * `403 BUSINESS_GROW_SUBSCRIPTION_REQUIRED / reason: UNKNOWN`, alors que
 * `bg_import_access` répondait `allowed: true` pour le même compte.
 *
 * Ce test lit la source de la fonction et vérifie que la colonne est NAMMÉE,
 * ce qui rend la lecture correcte quel que soit le retour de la fonction.
 */

const source = readFileSync(
  join(process.cwd(), 'supabase/functions/business-grow/index.ts'),
  'utf8',
);

/** Corps de `checkImportConnectAccess`, isolé pour l'inspection. */
const corps = (() => {
  const debut = source.indexOf('async checkImportConnectAccess(');
  if (debut === -1) throw new Error('checkImportConnectAccess introuvable');
  // Fin de la méthode : la déclaration suivante du même objet (`async xxx(`).
  const suivante = source.slice(debut + 10).search(/\n  async [a-zA-Z]+\(/);
  const fin = suivante === -1 ? source.length : debut + 10 + suivante;
  // Commentaires retirés : ce fichier explique justement l'ancien défaut en
  // citant `select *` et `row.allowed`, et se citerait lui-même autrement.
  return source
    .slice(debut, fin)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((ligne) => ligne.replace(/\/\/.*$/, ''))
    .join('\n');
})();

describe('garde Import & Connect — lecture des droits', () => {
  it('nomme la colonne au lieu de faire `select *`', () => {
    // `select *` sur une fonction scalaire expose la fonction comme une seule
    // colonne : c'est exactement ce qui masquait `allowed`, `reason` et `status`.
    expect(corps).not.toMatch(/select\s+\*\s+from\s+saas_business\.bg_import_access/);
    expect(corps).toMatch(/bg_import_access\(.+?\)\s+as\s+droits/s);
  });

  it('lit `allowed` dans l’objet renvoyé, pas dans la ligne', () => {
    expect(corps).toContain('droits.allowed === true');
    expect(corps).not.toContain('row.allowed');
  });

  it('lit la clé `status`, celle que la fonction renvoie réellement', () => {
    // La fonction renvoie `status`. Lire `subscription_status` donnait un motif
    // vide au client, qui affichait un refus sans explication.
    expect(corps).not.toContain('row.subscription_status');
    expect(corps).toContain('droits.status');
  });

  it('échoue fermé quand la lecture ne renvoie rien', () => {
    expect(corps).toMatch(/if \(!row\) return \{ allowed: false/);
    // Aucun « autorisé par défaut » ne doit apparaître.
    expect(corps).not.toMatch(/allowed:\s*true/);
  });

  it('reste aligné sur `store-import`, qui lisait déjà correctement', () => {
    // Deux implémentations de la même garde : si l'une nomme la colonne et
    // l'autre non, un module protège et l'autre refuse tout le monde.
    const store = readFileSync(
      join(process.cwd(), 'supabase/functions/store-import/index.ts'),
      'utf8',
    );
    expect(store).toContain('bg_import_access');
    expect(store).toContain('droits.allowed === true');
    // La colonne est nommée là aussi : les deux implémentations concordent.
    expect(store).toMatch(/bg_import_access\(.+?\)\s+as\s+droits/s);
  });
});
