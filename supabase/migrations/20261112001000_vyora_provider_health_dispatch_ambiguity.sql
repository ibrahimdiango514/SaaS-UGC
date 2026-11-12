-- -----------------------------------------------------------------------------
-- Correctif : `public.vyora_provider_health_dispatch()` était ambigu.
--
-- La migration 20261111234500_vyora_provider_health_cron.sql définit la version
-- canonique `vyora_provider_health_dispatch(p_force boolean default false)`.
-- Une surcharge sans argument `vyora_provider_health_dispatch()` a ensuite été
-- créée en base, ce qui rendait tout appel sans argument indécidable (42725) :
--   ERROR: function public.vyora_provider_health_dispatch() is not unique
-- Les jobs pg_cron 7 (vyora-provider-health-daily) et 9
-- (vyora-provider-health-fresh-guard) échouaient donc à chaque exécution,
-- n'envoyaient plus aucun contrôle de santé, et le routage IA finissait par
-- refuser tous les fournisseurs (NO_VERIFIED_PROVIDER) au bout de 24 h.
--
-- Effet : suppression de la surcharge obsolète non utilisée par le code, puis
-- réécriture des deux jobs en appel explicite à la version canonique.
-- Aucune donnée métier n'est touchée (ni requête, ni contrôle, ni crédit).
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'vyora_provider_health_dispatch'
       and p.pronargs = 0
  ) then
    -- Surcharge sans argument : doublon de la version (boolean default false).
    drop function public.vyora_provider_health_dispatch();
  end if;
end $$;

-- La version canonique doit exister et rester réservée au planificateur.
revoke all on function public.vyora_provider_health_dispatch(boolean) from public, anon, authenticated;

-- Jobs réécrits en appel explicite : plus aucune résolution de surcharge.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
      from cron.job
     where jobname in ('vyora-provider-health-daily', 'vyora-provider-health-fresh-guard')
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;

  perform cron.schedule(
    'vyora-provider-health-daily',
    '0 2,14 * * *',
    $job$select public.vyora_provider_health_dispatch(false)$job$
  );
  perform cron.schedule(
    'vyora-provider-health-fresh-guard',
    '20 * * * *',
    $job$select public.vyora_provider_health_dispatch(false)$job$
  );
end $$;

-- Contrôle de lecture seule après application (doit renvoyer 1 seule signature).
-- select p.proname, pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'vyora_provider_health_dispatch';
