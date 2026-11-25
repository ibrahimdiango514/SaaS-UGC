/**
 * Politiques Storage des fichiers SORAHNEX — garde-fous statiques.
 *
 * Ces tests ne remplacent pas les sondes exécutées en base (elles ont prouvé
 * l'isolation entre entreprises, cf. `20261116150000_grant_storage_policy_functions.sql`).
 * Ils empêchent la régression suivante, silencieuse et grave :
 *
 *   Une politique RLS de `storage.objects` citait une fonction que le rôle
 *   `authenticated` n'avait pas le droit d'exécuter. PostgreSQL évaluant les
 *   politiques AVANT de filtrer, TOUTE requête de ce rôle sur storage.objects
 *   échouait en 42501 — donc plus d'URL signée ni de téléversement, quel que
 *   soit le bucket.
 *
 * Ce qui est vérifié ici :
 *   1. les GRANT correctifs sont présents et limités à `authenticated` ;
 *   2. la garde SQL qui refuse toute fonction inaccessible subsiste ;
 *   3. les quatre politiques du bucket `ugc-assets` restent en place ;
 *   4. aucun accès public au bucket n'est introduit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const MEDIA = 'supabase/migrations/20261116140000_vyora_files_media.sql';
const POLICIES = 'supabase/migrations/20261116160000_ugc_storage_policies.sql';
const GRANTS = 'supabase/migrations/20261116150000_grant_storage_policy_functions.sql';

describe('correctif des fonctions de politique Storage', () => {
  const sql = read(GRANTS);

  it('autorise les DEUX fonctions réellement citées par les politiques', () => {
    expect(sql).toContain(
      'grant execute on function saas_immobilier.can_write_property_object(text) to authenticated;',
    );
    expect(sql).toContain(
      'grant execute on function saas_immobilier.can_delete_property_object(text) to authenticated;',
    );
  });

  it('n’ouvre jamais ces fonctions à `anon`', () => {
    // Un `to anon` ou un `to public` rendrait la correction dangereuse.
    expect(sql).not.toMatch(/grant execute[\s\S]{0,200}\bto\s+(anon|public)\b/i);
  });

  it('conserve la garde qui refuse toute fonction inaccessible', () => {
    expect(sql).toContain("has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    expect(sql).toContain("raise exception 'fonctions de politique Storage inaccessibles");
    expect(sql).toContain("from pg_policies pol");
    expect(sql).toContain("and pol.tablename = 'objects'");
  });

  it('explique le symptôme réel, pas une intention', () => {
    expect(sql).toContain('permission denied for function can_write_property_object');
    expect(sql).toContain('A_lit=1 | B_lit=0');
  });
});

describe('bucket ugc-assets — formats autorisés', () => {
  const sql = read(MEDIA);

  it('garde une liste MIME fermée et couvre les formats demandés', () => {
    for (const mime of [
      'image/png', 'image/jpeg', 'image/webp',
      'video/mp4', 'video/quicktime',
      'application/pdf', 'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(sql).toContain(`'${mime}'`);
    }
  });

  it('plafonne la taille à 50 Mio', () => {
    expect(sql).toContain('file_size_limit = 52428800');
  });
});

describe('politiques du bucket ugc-assets', () => {
  const sql = read(POLICIES);

  it('couvre les quatre opérations', () => {
    for (const policy of [
      'ugc_storage_select_member',
      'ugc_storage_insert_editor',
      'ugc_storage_update_editor',
      'ugc_storage_delete_editor',
    ]) {
      expect(sql).toContain(policy);
    }
  });

  it('dérive toujours l’entreprise du PREMIER segment du chemin', () => {
    // C'est ce qui garantit qu'un utilisateur ne peut pas viser le dossier
    // d'une autre entreprise : le chemin EST le contrôle d'accès.
    expect(sql).toContain("(storage.foldername(name))[1]");
    expect(sql).toMatch(/can_edit_workspace/);
    expect(sql).toMatch(/is_workspace_member/);
  });

  it('exige un UUID de workspace dans le chemin, pas un préfixe libre', () => {
    expect(sql).toContain('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}');
  });

  it('garde le bucket privé', () => {
    // Aucune création publique, et un `public = false` explicite.
    expect(sql).not.toMatch(/public\s*,\s*true/);
    expect(sql).toMatch(/set public = false/);
  });

  it('les politiques sont idempotentes (rejouables sans erreur)', () => {
    for (const policy of [
      'ugc_storage_select_member', 'ugc_storage_insert_editor',
      'ugc_storage_update_editor', 'ugc_storage_delete_editor',
    ]) {
      expect(sql).toContain(`drop policy if exists ${policy} on storage.objects;`);
    }
  });

  it('n’accorde rien à anon sur le bucket', () => {
    expect(sql).not.toMatch(/to\s+anon/);
  });
});
