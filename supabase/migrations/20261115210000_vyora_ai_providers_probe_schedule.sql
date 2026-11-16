-- VYORA — planification de la sonde RÉELLE des fournisseurs de la phase 1.
--
-- POURQUOI
-- La surveillance historique (`vyora-provider-health-*`) ne sonde que `groq` et
-- `gemini`, avec une liste écrite en dur. Les cinq fournisseurs intégrés
-- (`openrouter`, `gonka`, `llm7`, `ollama`, `cloudflare`) ont besoin d'une
-- sonde pilotée par le REGISTRE, qui lit le catalogue puis envoie UNE
-- complétion bornée (16 jetons) pour prouver que le fournisseur répond.
--
-- CE QUE FAIT CE FICHIER
--   1. `public.vyora_ai_providers_dispatch(boolean)` : envoie la sonde à
--      l'Edge Function `vyora-ai-providers` via `pg_net`, authentifiée par le
--      jeton Vault existant (`vyora_provider_health_token`) — aucun secret en
--      clair, aucun secret journalisé.
--   2. `public.vyora_ai_providers_schedule()` : (re)programme le job pg_cron
--      de façon IDEMPOTENTE (supprime puis recrée par nom). Aucun doublon.
--
-- GARDE-FOUS
--   * verrou consultatif : deux exécutions ne se chevauchent jamais ;
--   * anti-rafale : une sonde par heure au maximum, sauf `p_force = true` ;
--   * aucune sonde si le jeton Vault est absent : on échoue explicitement au
--     lieu d'appeler une fonction non authentifiée.
--
-- COÛT
-- La sonde envoie une complétion de 16 jetons de sortie par fournisseur, une
-- fois par heure au plus : coût négligeable, et c'est la SEULE façon honnête de
-- déclarer un fournisseur « opérationnel » plutôt que « clé acceptée ».

-- ---------------------------------------------------------------------------
-- 1) Envoi de la sonde
-- ---------------------------------------------------------------------------

create or replace function public.vyora_ai_providers_dispatch(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_url       constant text := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-ai-providers';
  v_token     text;
  v_last      timestamptz;
  v_request   bigint;
  v_providers text[];
begin
  if not pg_try_advisory_xact_lock(hashtext('vyora_ai_providers_dispatch')) then
    return jsonb_build_object('skipped', 'concurrent_run_in_progress', 'at', now());
  end if;

  select array_agg(p.provider_key order by p.provider_key)
    into v_providers
    from saas_business.ai_providers p
   where p.integration_phase is not null;

  if coalesce(array_length(v_providers, 1), 0) = 0 then
    return jsonb_build_object('skipped', 'no_provider_in_phase', 'at', now());
  end if;

  v_token := public.vyora_provider_health_cron_token();
  if coalesce(v_token, '') = '' then
    raise exception 'Jeton de sonde absent du Vault (vyora_provider_health_token)';
  end if;

  -- Anti-rafale : un contrôle de moins d'une heure rend l'appel inutile.
  if not coalesce(p_force, false) then
    select max(p.checked_at) into v_last
      from saas_business.ai_providers p
     where p.integration_phase is not null;
    if coalesce(v_last, '-infinity'::timestamptz) > now() - interval '60 minutes' then
      return jsonb_build_object('skipped', 'recent_probe', 'last_checked_at', v_last);
    end if;
  end if;

  v_request := net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_token
    ),
    body := jsonb_build_object('action', 'probe'),
    timeout_milliseconds := 60000
  );

  return jsonb_build_object(
    'dispatched_at', now(),
    'pg_net_request_id', v_request,
    'providers', to_jsonb(v_providers),
    'forced', coalesce(p_force, false)
  );
end $$;

comment on function public.vyora_ai_providers_dispatch(boolean) is
  'Sonde réelle des fournisseurs de la phase d''intégration (catalogue + complétion 16 jetons), une fois par heure au plus.';

revoke all on function public.vyora_ai_providers_dispatch(boolean) from public, anon, authenticated;
grant execute on function public.vyora_ai_providers_dispatch(boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Programmation pg_cron (idempotente, sans doublon)
-- ---------------------------------------------------------------------------

create or replace function public.vyora_ai_providers_schedule()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_jobid bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return jsonb_build_object('scheduled', false, 'reason', 'pg_cron absent');
  end if;

  -- Suppression par NOM, quel que soit l'identifiant historique.
  for v_jobid in select jobid from cron.job where jobname = 'vyora-ai-providers-probe' loop
    perform cron.unschedule(v_jobid);
  end loop;

  v_jobid := cron.schedule(
    'vyora-ai-providers-probe',
    '25 * * * *',
    $cron$select public.vyora_ai_providers_dispatch(false)$cron$
  );

  return jsonb_build_object('scheduled', true, 'jobid', v_jobid, 'schedule', '25 * * * *');
end $$;

comment on function public.vyora_ai_providers_schedule() is
  'Programme (une seule fois, sans doublon) la sonde horaire des fournisseurs de la phase 1.';

revoke all on function public.vyora_ai_providers_schedule() from public, anon, authenticated;
grant execute on function public.vyora_ai_providers_schedule() to service_role;

-- Programmation immédiate, sans attendre un déploiement manuel.
select public.vyora_ai_providers_schedule();
