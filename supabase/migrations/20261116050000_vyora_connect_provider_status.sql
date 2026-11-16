-- VYORA Connect — état de configuration des fournisseurs OAuth.
--
-- Cette fonction a été créée en base directement (via l'API de gestion) et le
-- fichier de migration n'avait pas été écrit dans le dépôt : il est reproduit
-- ici à l'identique de la définition déployée, pour que le schéma du dépôt et
-- la base ne divergent plus.
--
-- Rôle : l'interface VYORA Connect doit savoir si Google est configuré côté
-- serveur (client_id / client_secret / redirect_uri présents dans
-- l'environnement de l'Edge Function). Cette information n'est PAS lisible en
-- SQL : les variables d'environnement des Edge Functions ne sont pas exposées
-- à Postgres.
--
-- D'où le contrat suivant, volontairement pessimiste :
--   * `google` vaut `null` — « je ne sais pas », et non « configuré ».
--   * `authoritative_source` vaut `'edge_function'` : la source de vérité est
--     l'action `status` de la fonction `vyora-oauth`, que le frontend appelle
--     en priorité.
--
-- L'interface ne doit jamais déduire un état « prêt » de cette fonction seule.
-- En cas d'échec de l'appel à l'Edge Function, elle retombe sur « Configuration
-- requise » plutôt que sur un bouton OAuth qui échouerait de toute façon.
--
-- `security definer` parce que la fonction doit fonctionner pour un utilisateur
-- authentifié sans lui donner de droits directs ; `search_path` est figé pour
-- éviter toute résolution détournée de schéma. L'appel non authentifié est
-- rejeté (SQLSTATE 28000) : cette fonction n'est pas une sonde publique.

create or replace function public.provider_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  -- `google` vaut null quand l'information n'est pas determinate en SQL.
  -- L'interface ne doit JAMAIS interpreter null comme "configure" : elle
  -- interroge l'Edge Function, qui seule lit son environnement.
  return jsonb_build_object(
    'google', null,
    'oauth_function', true,
    'authoritative_source', 'edge_function'
  );
end; $function$;

revoke all on function public.provider_status() from public;
revoke all on function public.provider_status() from anon;
grant execute on function public.provider_status() to authenticated;
grant execute on function public.provider_status() to service_role;

comment on function public.provider_status() is
  'Etat de configuration OAuth par fournisseur. `google` reste null : la source de verite est l''action `status` de l''Edge Function vyora-oauth.';
