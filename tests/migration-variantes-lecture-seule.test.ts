import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous sur la migration des variantes et du mode lecture seule.
 *
 * ## Ce que ces tests peuvent et ne peuvent pas prouver
 * Ils lisent le SQL, pas la base : ils n'affirment donc **pas** que les
 * politiques sont appliquées. Cette preuve a été faite en production, par des
 * appels HTTP réels (catalogue, export, écriture directe, isolation) — voir
 * `docs/rapport-stabilisation-2026-11-16.md`.
 *
 * Ils empêchent la régression la plus probable : qu'une future modification
 * supprime la garde d'abonnement d'une politique, ou ajoute une suppression de
 * produits liée à l'expiration. Une relecture ne l'attrape pas ; ce test, oui.
 */

const MIGRATION = readFileSync(
  'supabase/migrations/20261118100000_ugc_variants_and_import_history.sql',
  'utf8',
);

/** Retire les commentaires SQL : un mot dans un commentaire n'est pas une règle. */
function sansCommentaires(sql: string): string {
  return sql
    .split('\n')
    .map((ligne) => ligne.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = sansCommentaires(MIGRATION);

describe('migration — variantes', () => {
  it('crée une table de variantes rattachée au produit parent', () => {
    expect(CODE).toMatch(/create table if not exists saas_ugc\.ugc_product_variants/i);
    // `on delete cascade` : supprimer un produit ne doit pas laisser de
    // variantes orphelines, qui seraient invisibles et impossibles à nettoyer.
    expect(CODE).toMatch(/references saas_ugc\.ugc_products\(id\) on delete cascade/i);
  });

  it('conserve prix, devise, stock et référence par variante', () => {
    for (const colonne of ['price_amount', 'price_currency', 'stock', 'sku', 'attribute_value']) {
      expect(CODE).toContain(colonne);
    }
  });

  it('autorise un prix absent sans autoriser un prix négatif', () => {
    // `null` = « prix du parent ». Un check `>= 0` seul laisserait passer null,
    // mais interdirait un prix négatif, qui n'a pas de sens commercial.
    expect(CODE).toMatch(/check \(price_amount is null or price_amount >= 0\)/i);
    expect(CODE).toMatch(/check \(stock is null or stock >= 0\)/i);
  });

  it('interdit deux fois la même option sur un même produit', () => {
    expect(CODE).toMatch(/unique \(product_id, attribute_name, attribute_value\)/i);
  });

  it('active la RLS et n’accorde l’écriture qu’aux abonnés', () => {
    expect(CODE).toMatch(/alter table saas_ugc\.ugc_product_variants enable row level security/i);
    // La politique d'écriture doit citer la garde d'abonnement : sans elle, la
    // table des variantes serait une porte dérobée vers un catalogue expiré.
    const ecriture = CODE.slice(CODE.indexOf('ugc_product_variants_write_subscriber'));
    expect(ecriture.slice(0, 1200)).toMatch(/bg_import_access/i);
  });
});

describe('migration — lecture seule après expiration', () => {
  it('rend la lecture indépendante de l’abonnement', () => {
    const lecture = CODE.slice(
      CODE.indexOf('ugc_product_variants_select_member'),
      CODE.indexOf('ugc_product_variants_write_subscriber'),
    );
    // La lecture ne doit dépendre QUE de l'appartenance : un abonné expiré
    // conserve l'accès à son catalogue.
    expect(lecture).toMatch(/is_workspace_member/i);
    expect(lecture).not.toMatch(/bg_import_access/i);
  });

  it('expose un catalogue qui signale lui-même le mode lecture seule', () => {
    expect(CODE).toMatch(/'read_only'/);
  });

  it('rend l’export disponible sans abonnement', () => {
    const exportFn = CODE.slice(CODE.indexOf('function public.vyora_ugc_export'));
    expect(exportFn).toBeTruthy();
    // L'export ne doit pas appeler la garde d'abonnement : un client qui part
    // doit pouvoir repartir avec ses données.
    expect(exportFn).not.toMatch(/bg_require_import_access/);
  });

  it('exige l’abonnement pour modifier une variante', () => {
    const maj = CODE.slice(
      CODE.indexOf('function public.vyora_ugc_variant_update'),
      CODE.indexOf('function public.vyora_ugc_export'),
    );
    expect(maj).toMatch(/bg_require_import_access/);
    // Et l'appartenance d'abord : on ne révèle pas l'existence d'une variante
    // d'une autre entreprise par un message d'erreur différent.
    expect(maj).toMatch(/can_edit_workspace/);
  });

  it('ne supprime jamais de produit à cause d’un abonnement', () => {
    // Aucun `delete from … ugc_products` ne doit apparaître, où que ce soit.
    expect(CODE).not.toMatch(/delete\s+from\s+saas_ugc\.ugc_products/i);
    // Et aucun abonnement n'est modifié : la migration ne touche pas aux plans.
    expect(CODE).not.toMatch(/update\s+saas_business\.subscriptions/i);
  });
});

describe('migration — historique d’import', () => {
  it('crée un journal lié à l’entreprise', () => {
    expect(CODE).toMatch(/create table if not exists saas_ugc\.ugc_import_jobs/i);
    expect(CODE).toMatch(/references saas_ugc\.ugc_workspaces\(id\) on delete cascade/i);
  });

  it('n’autorise pas un client à fabriquer une ligne d’historique', () => {
    // Un client ne doit pouvoir que LIRE : une ligne d'historique qui
    // prétendrait un import réussi ne doit pas venir du navigateur.
    expect(CODE).toMatch(/grant select on table saas_ugc\.ugc_import_jobs to authenticated/i);
    expect(CODE).not.toMatch(/grant[^;]*insert[^;]*on table saas_ugc\.ugc_import_jobs/i);
  });

  it('compte les variantes créées, pas seulement les produits', () => {
    expect(CODE).toContain('variants_created');
  });
});
