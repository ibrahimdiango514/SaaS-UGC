import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Parité entre les RPC appelées par les Edge Functions Meta et les migrations.
 *
 * ## Le défaut que ce test empêche
 * Une Edge Function qui appelle `saas_business.meta_xxx(...)` alors que la
 * migration n'a jamais été appliquée ne tombe pas au démarrage : elle échoue à
 * l'exécution, au moment précis où Meta poste un rappel. Autrement dit, la panne
 * n'apparaît qu'en production, sur un chemin qui ne se déclenche
 * qu'exceptionnellement (un client qui retire l'application).
 *
 * Les tests unitaires ne peuvent pas voir ce défaut : ils simulent la couche
 * SQL. Ce test ne remplace pas une vérification en base, mais il garantit
 * qu'aucune RPC appelée n'est orpheline de migration.
 */

const MIGRATIONS = 'supabase/migrations';
const FUNCTIONS = 'supabase/functions';

/** Lit toutes les définitions de fonctions présentes dans les migrations. */
function fonctionsDefinies(): Set<string> {
  const definies = new Set<string>();
  const motif = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_]+\.)?([a-z0-9_]+)\s*\(/gi;
  for (const fichier of readdirSync(MIGRATIONS)) {
    if (!fichier.endsWith('.sql')) continue;
    const sql = readFileSync(join(MIGRATIONS, fichier), 'utf8');
    let m: RegExpExecArray | null;
    while ((m = motif.exec(sql)) !== null) definies.add(m[1].toLowerCase());
  }
  return definies;
}

/** Liste les fichiers TypeScript d'une fonction Edge (hors chargeur généré). */
function fichiersDe(fonction: string): string[] {
  const dossier = join(FUNCTIONS, fonction);
  return readdirSync(dossier)
    .filter((f) => f.endsWith('.ts') && f !== 'loader.ts')
    .map((f) => join(dossier, f));
}

/**
 * Extrait les RPC `saas_business.meta_*` invoquées dans un fichier.
 *
 * On ne cherche que le schéma `saas_business` : c'est celui des tables Meta, et
 * un appel sans préfixe de schéma serait de toute façon une erreur de style.
 */
function rpcAppelees(fichier: string): string[] {
  const source = readFileSync(fichier, 'utf8');
  const trouvees = new Set<string>();
  const motif = /saas_business\.(meta_[a-z0-9_]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = motif.exec(source)) !== null) trouvees.add(m[1].toLowerCase());
  return [...trouvees];
}

describe('parité migrations ↔ Edge Functions Meta', () => {
  const definies = fonctionsDefinies();

  for (const fonction of ['meta-lifecycle', 'meta-connect', 'meta-webhook']) {
    it(`${fonction} : chaque RPC appelée existe dans une migration`, () => {
      const appelees = fichiersDe(fonction).flatMap(rpcAppelees);
      // Un fichier vidé ou renommé ferait passer ce test à vide.
      expect(appelees.length, `${fonction} n'appelle aucune RPC meta_*`).toBeGreaterThan(0);
      const orphelines = [...new Set(appelees)].filter((nom) => !definies.has(nom));
      expect(orphelines, `RPC sans migration : ${orphelines.join(', ')}`).toEqual([]);
    });
  }

  it('les RPC de cycle de vie sont bien déclarées', () => {
    // Garde explicite : si quelqu'un renomme la migration ou les fonctions, ce
    // test le dit, au lieu de laisser les deux listes diverger en silence.
    for (const attendu of [
      'meta_revoke_user_connections',
      'meta_delete_user_data',
      'meta_deletion_record',
    ]) {
      expect(definies.has(attendu), `${attendu} absente des migrations`).toBe(true);
    }
  });

  it('les RPC de cycle de vie ne sont pas exposées à anon/authenticated', () => {
    const sql = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
      .join('\n');
    for (const nom of ['meta_revoke_user_connections', 'meta_delete_user_data', 'meta_deletion_record']) {
      // Une RPC security definer accessible au client contournerait la RLS :
      // n'importe quel utilisateur connecté pourrait effacer les données d'un autre.
      const revocation = new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+saas_business\\.${nom}\\s*\\([^)]*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,
        'i',
      );
      expect(revocation.test(sql), `${nom} doit être révoquée pour public/anon/authenticated`).toBe(true);
    }
  });

  it('le journal de suppression est protégé par RLS', () => {
    const sql = readFileSync(
      join(MIGRATIONS, '20261126100000_meta_lifecycle_callbacks.sql'),
      'utf8',
    );
    expect(sql).toMatch(/alter table saas_business\.meta_deletion_requests enable row level security/i);
    expect(sql).toMatch(/alter table saas_business\.meta_deletion_requests force row level security/i);
    expect(sql).toMatch(/revoke all on saas_business\.meta_deletion_requests from anon, authenticated/i);
  });
});
