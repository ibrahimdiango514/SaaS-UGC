-- Verrouillage de deux tables techniques sans RLS (audit migration Netlify, 2026-11-18).
-- Appliquée en production le 2026-11-18 (version supabase_migrations 20261118071105) ; vérifiée : RLS active, aucun droit anon/authenticated sur les deux tables.
--
-- Constat mesuré en production (pg_class.relrowsecurity / role_table_grants) :
--   * public._bg_artifact_parts : RLS désactivée, droits COMPLETS (select, insert,
--     update, delete, truncate) accordés à `anon` et `authenticated`. La table
--     est dans le schéma `public`, exposé par PostgREST : n'importe qui muni de la
--     clé publiable pouvait lire, modifier ou vider son contenu. Elle ne sert
--     plus : `business-grow` v33 charge son bundle depuis GitHub (chargeur
--     épinglé), aucun code de `main` ne la référence. Son unique ligne est
--     conservée (aucune suppression de données).
--   * saas_ugc.ugc_provider_balance : RLS désactivée. Seuls `postgres` et
--     `service_role` y ont des droits, donc pas d'exposition directe, mais c'est
--     la seule table métier sans RLS : on l'active par cohérence, sans
--     politique (le backend passe par service_role, qui contourne la RLS).
--
-- Rien n'est supprimé, aucune donnée n'est modifiée.

do $$
begin
  if to_regclass('public._bg_artifact_parts') is not null then
    revoke all on table public._bg_artifact_parts from anon, authenticated;
    alter table public._bg_artifact_parts enable row level security;
    comment on table public._bg_artifact_parts is
      'Historique : fragments d''artefact business-grow (modèle abandonné au profit du chargeur GitHub épinglé). Verrouillée le 2026-11-18 : RLS active, aucun droit anon/authenticated.';
  end if;

  if to_regclass('saas_ugc.ugc_provider_balance') is not null then
    alter table saas_ugc.ugc_provider_balance enable row level security;
  end if;
end $$;
