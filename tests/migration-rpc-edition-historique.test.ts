import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Garde-fous sur la migration `20261118120000` (édition des variantes et
 * historique par RPC).
 *
 * ## Ce que ces tests prouvent, et ce qu'ils ne prouvent pas
 * Ils lisent le SQL. Ils n'affirment **pas** que la base se comporte ainsi : la
 * preuve a été faite en production par des appels réels (écriture autorisée,
 * écriture refusée après expiration, isolation entre entreprises).
 *
 * Ils verrouillent les décisions de sécurité qui se perdraient le plus
 * facilement lors d'une réécriture :
 * - aucune RPC n'accepte d'identifiant utilisateur : la portée ne peut donc pas
 *   être élargie par un paramètre ;
 * - l'écriture exige l'abonnement, la lecture d'historique non ;
 * - les fonctions sont `security definer` avec `search_path` vide ;
 * - aucun `grant` à `anon`.
 */

const MIGRATION = readFileSync(
  'supabase/migrations/20261118120000_ugc_variants_editing_and_import_history_rpc.sql',
  'utf8',
);

/** Retire les commentaires : un mot dans un commentaire n'est pas une règle. */
function sansCommentaires(sql: string): string {
  return sql
    .split('\n')
    .map((ligne) => ligne.replace(/--.*$/, ''))
    .join('\n');
}

const CODE = sansCommentaires(MIGRATION);

/** Découpe le fichier par fonction créée, pour analyser chacune séparément. */
function corpsFonction(nom: string): string {
  const debut = CODE.search(new RegExp(`create or replace function public\\.${nom}\\(`, 'i'));
  expect(debut, `fonction ${nom} absente de la migration`).toBeGreaterThan(-1);
  const fin = CODE.indexOf('$function$;', debut);
  return CODE.slice(debut, fin === -1 ? undefined : fin);
}

const FONCTIONS = [
  'vyora_ugc_variant_create',
  'vyora_ugc_variant_update',
  'vyora_ugc_variant_set_active',
  'vyora_ugc_catalog',
  'vyora_ugc_import_history',
  'vyora_ugc_import_report',
] as const;

describe('migration — forme des RPC', () => {
  it('crée les six fonctions attendues', () => {
    for (const nom of FONCTIONS) {
      expect(CODE).toMatch(new RegExp(`create or replace function public\\.${nom}\\(`, 'i'));
    }
  });

  it.each(FONCTIONS)('%s est security definer avec search_path vide', (nom) => {
    const corps = corpsFonction(nom);
    expect(corps).toMatch(/security definer/i);
    // `search_path = ''` : sans cela, une fonction de même nom placée dans un
    // schéma contrôlé par l'appelant pourrait être résolue à la place.
    expect(corps).toMatch(/set search_path\s*=\s*''/i);
  });

  it.each(FONCTIONS)('%s n’accepte aucun identifiant utilisateur', (nom) => {
    const corps = corpsFonction(nom);
    expect(corps).not.toMatch(/p_user_id|p_actor_id|p_created_by|p_member_id/i);
    // L'identité vient de la session, jamais d'un argument.
    expect(corps).toMatch(/auth\.uid\(\)/i);
  });

  it.each(FONCTIONS)('%s ne dépend pas d’un identifiant d’entreprise non validé', (nom) => {
    const corps = corpsFonction(nom);
    if (/p_workspace_id/i.test(corps)) {
      // Un identifiant d'entreprise reçu est acceptable À CONDITION d'être
      // confronté à l'appartenance réelle de l'appelant.
      expect(corps).toMatch(/is_workspace_member|can_edit_workspace|ugc_private\./i);
    }
  });
});

describe('migration — écriture contre lecture', () => {
  it.each(['vyora_ugc_variant_create', 'vyora_ugc_variant_update', 'vyora_ugc_variant_set_active'])(
    '%s exige l’abonnement via la garde d’import',
    (nom) => {
      expect(corpsFonction(nom)).toMatch(/bg_require_import_access/i);
    },
  );

  it('la lecture du catalogue ne dépend pas de l’abonnement', () => {
    const corps = corpsFonction('vyora_ugc_catalog');
    // Le catalogue reste consultable après expiration : il lit l'état d'accès
    // pour le signaler (`read_only`), il ne l'exige pas pour répondre.
    expect(corps).not.toMatch(/bg_require_import_access/i);
    expect(corps).toMatch(/read_only/i);
  });

  it.each(['vyora_ugc_import_history', 'vyora_ugc_import_report'])(
    '%s reste disponible après expiration',
    (nom) => {
      expect(corpsFonction(nom)).not.toMatch(/bg_require_import_access/i);
    },
  );

  it('limite l’historique aux imports de l’appelant, pas à ceux de l’entreprise', () => {
    // Dans une entreprise à plusieurs membres, voir les imports d'un collègue
    // n'a pas été demandé et exposerait son activité : le filtre porte sur
    // `user_id`, en plus de l'entreprise.
    const corps = corpsFonction('vyora_ugc_import_history');
    expect(corps).toMatch(/j\.user_id = v_user/i);
    expect(corps.match(/j\.user_id = v_user/gi)).toHaveLength(2); // total + page
  });

  it('applique la même portée au rapport qu’à la liste', () => {
    // Sans ce filtre, le rapport donnerait le détail d'un import absent de la
    // liste : la portée serait contournable en connaissant un identifiant.
    const corps = corpsFonction('vyora_ugc_import_report');
    expect(corps).toMatch(/j\.user_id = v_user/i);
    expect(corps).toMatch(/is_workspace_member/i);
  });

  it('le rapport ne révèle pas l’existence d’un import d’une autre entreprise', () => {
    const corps = corpsFonction('vyora_ugc_import_report');
    // Même refus pour « inexistant » et « pas à vous » : un message distinct
    // permettrait d'énumérer les imports d'autrui.
    expect(corps).toMatch(/NOT_FOUND/i);
    expect(corps).toMatch(/workspace_id/i);
  });
});

describe('migration — droits', () => {
  it('n’accorde rien à anon', () => {
    expect(CODE).not.toMatch(/grant[^;]*\banon\b/i);
    expect(CODE).toMatch(/grant execute on function public\.vyora_ugc_import_history[^;]*authenticated/i);
  });

  it('borne la pagination de l’historique', () => {
    const corps = corpsFonction('vyora_ugc_import_history');
    expect(corps).toMatch(/least\(|greatest\(/i);
  });

  it('désactive par colonne plutôt que par suppression', () => {
    expect(CODE).toMatch(/add column if not exists active boolean/i);
    // Aucune fonction ne doit supprimer une variante : le stock et la référence
    // disparaîtraient avec elle.
    expect(CODE).not.toMatch(/delete from saas_ugc\.ugc_product_variants/i);
  });

  it('n’expose toujours pas le schéma interne à PostgREST', () => {
    expect(CODE).not.toMatch(/grant[^;]*saas_ugc[^;]*to authenticated/i);
  });
});
