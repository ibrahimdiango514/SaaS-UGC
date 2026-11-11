-- =============================================================================
-- VYORA — cohérence de marque des TEXTES visibles en base.
--
-- Portée STRICTEMENT limitée au contenu éditorial :
--   * noms affichés, accroches, descriptions, listes de fonctionnalités,
--     modèles de prompts système, notifications déjà émises ;
--   * AUCUN objet renommé : tables, colonnes, fonctions, vues, index, rôles,
--     clés étrangères, contraintes, valeurs de clés primaires (`plan_key`,
--     `setting_key`, …) et historiques de migration restent identiques ;
--   * aucune ligne supprimée, aucun privilège/RLS modifié.
--
-- Caractère idempotent : l'instruction est sans effet si « Reelora » n'est plus
-- présent. La migration est réversible par une migration inverse explicite
-- (remplacement de « VYORA » par « Reelora » dans les mêmes colonnes) ; elle
-- n'est PAS appliquée automatiquement en production.
--
-- À exécuter uniquement après validation explicite du propriétaire, pendant
-- une fenêtre de maintenance courte. Sauvegarde recommandée :
--   pg_dump --schema=saas_ugc --data-only --table='saas_ugc.ugc_plans'
--          --table='saas_ugc.ugc_app_settings' ...
-- =============================================================================

begin;

do $$
begin
  if to_regclass('saas_ugc.ugc_plans') is not null then
    update saas_ugc.ugc_plans
       set display_name = replace(display_name, 'Reelora', 'VYORA'),
           tagline = replace(tagline, 'Reelora', 'VYORA'),
           features = replace(features::text, 'Reelora', 'VYORA')::jsonb,
           updated_at = now()
     where display_name <> replace(display_name, 'Reelora', 'VYORA')
        or coalesce(tagline, '') <> replace(coalesce(tagline, ''), 'Reelora', 'VYORA')
        or features::text <> replace(features::text, 'Reelora', 'VYORA');
  end if;

  if to_regclass('saas_ugc.ugc_prompt_templates') is not null then
    update saas_ugc.ugc_prompt_templates
       set title = replace(title, 'Reelora', 'VYORA'),
           content = replace(content, 'Reelora', 'VYORA'),
           updated_at = now()
     where title <> replace(title, 'Reelora', 'VYORA')
        or content <> replace(content, 'Reelora', 'VYORA');
  end if;

  if to_regclass('saas_ugc.ugc_service_catalog') is not null then
    update saas_ugc.ugc_service_catalog
       set display_name = replace(display_name, 'Reelora', 'VYORA')
     where display_name <> replace(display_name, 'Reelora', 'VYORA');
  end if;

  if to_regclass('saas_ugc.ugc_notifications') is not null then
    update saas_ugc.ugc_notifications
       set title = replace(title, 'Reelora', 'VYORA'),
           body = replace(coalesce(body, ''), 'Reelora', 'VYORA')
     where title <> replace(title, 'Reelora', 'VYORA')
        or coalesce(body, '') <> replace(coalesce(body, ''), 'Reelora', 'VYORA');
  end if;

  -- Identité publique de la plateforme : seul le nom change. L'adresse de
  -- support existante est conservée telle quelle (aucune adresse inventée).
  if to_regclass('saas_ugc.ugc_app_settings') is not null then
    update saas_ugc.ugc_app_settings
       set setting_value = jsonb_set(setting_value, '{name}', to_jsonb('VYORA'::text), true),
           updated_at = now()
     where setting_key = 'platform'
       and coalesce(setting_value->>'name', '') = 'Reelora';
  end if;
end $$;

commit;
