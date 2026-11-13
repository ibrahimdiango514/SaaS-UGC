/**
 * Suppression de compte et journal de crédits.
 *
 * Vérifié en base (transactions annulées, aucun compte réel touché) :
 *   - `update` arbitraire du journal → « UGC credit ledger is append-only » ;
 *   - `update` du seul `user_id` vers NULL (FK ON DELETE SET NULL) → accepté ;
 *   - `delete from auth.users` → accepté, journal conservé et anonymisé ;
 *   - portefeuille de l'utilisateur supprimé → supprimé (CASCADE).
 *
 * En prod, la suppression du compte purgé s'est d'abord soldée par une erreur
 * « UGC credit ledger is append-only » : l'effacement RGPD était impossible.
 * Ce fichier verrouille le correctif.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const MIGRATION = read('supabase/migrations/20261112100000_vyora_ledger_account_erasure.sql');

const body = MIGRATION.slice(
  MIGRATION.indexOf('create or replace function ugc_private.reject_ledger_mutation'),
  MIGRATION.indexOf('do $$'),
);

describe('Journal de crédits append-only et effacement de compte', () => {
  it('reste immuable par défaut', () => {
    expect(body).toContain("raise exception 'UGC credit ledger is append-only'");
    // Le trigger couvre toujours DELETE et UPDATE.
    expect(MIGRATION).toContain('before delete or update on saas_ugc.ugc_credit_ledger');
  });

  it('n’autorise que l’anonymisation produite par la suppression du compte', () => {
    expect(body).toContain("tg_op = 'UPDATE'");
    expect(body).toContain('old.user_id is not null');
    expect(body).toContain('new.user_id is null');
    // Aucun autre champ ne peut changer dans la même opération.
    for (const column of [
      'new.id = old.id',
      'new.operation_type = old.operation_type',
      'new.available_delta = old.available_delta',
      'new.reserved_delta = old.reserved_delta',
      'new.idempotency_key is not distinct from old.idempotency_key',
      'new.generation_job_id is not distinct from old.generation_job_id',
      'new.recharge_order_id is not distinct from old.recharge_order_id',
      'new.created_at = old.created_at',
    ]) {
      expect(body).toContain(column);
    }
  });

  it('ne supprime jamais l’exception pour un DELETE explicite', () => {
    // Le garde-fou ne concerne que UPDATE : un delete direct reste bloqué.
    expect(body).not.toContain("tg_op = 'DELETE'");
  });

  it('ne recrée pas un trigger déjà présent', () => {
    expect(MIGRATION).toContain("and tgname = 'ugc_credit_ledger_immutable'");
    expect(MIGRATION).toContain('if not exists (');
  });
});
