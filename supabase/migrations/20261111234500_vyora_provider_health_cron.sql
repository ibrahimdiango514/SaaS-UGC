-- =============================================================================
-- VYORA — surveillance quotidienne de la santé des fournisseurs IA (Groq, Gemini)
-- =============================================================================
--
-- Objectif : ne plus jamais retomber sur `NO_VERIFIED_PROVIDER` (503) parce que
-- les contrôles de santé ont plus de 24 h. `saas_business.bg_select_route()`
-- exige une ligne `ai_provider_health_checks` `healthy` de moins de 24 h pour le
-- fournisseur ET pour le modèle.
--
-- Contraintes respectées :
--   1. Vérification quotidienne (02:00 UTC) + surveillance d'une fraîcheur > 20 h
--      toutes les heures : les deux fournisseurs sont contrôlés bien avant
--      l'expiration des 24 h.
--   2. Authentification serveur : jeton aléatoire stocké dans Supabase Vault et
--      lu en base par `vyora_provider_health_cron_token()` (EXECUTE réservé à
--      service_role). Aucune clé fournisseur ne quitte Edge Functions ; le jeton
--      n'est jamais exposé au navigateur ni journalisé.
--   3. Aucune génération IA : le contrôle n'appelle que les endpoints de
--      catalogue (`GET /models`) de chaque fournisseur, via l'Edge Function
--      `business-grow` (action `providers.verify`). Aucun crédit, aucun quota,
--      aucune écriture dans les tables de facturation.
--   4. Aucune exécution concurrente : nom de job unique dans pg_cron, verrou
--      consultatif transactionnel `pg_try_advisory_xact_lock` (mono-volée) et
--      verrou de ligne sur l'état (`FOR UPDATE SKIP LOCKED`).
--   5. Résultats enregistrés : `saas_business.ai_provider_health_checks` (source
--      de vérité du routage) + historique détaillé dans
--      `saas_business.provider_health_cron_runs` (statut, latence, code d'erreur,
--      id pg_net, horodatages).
--   6. Gestion des échecs et alertes : 3 tentatives avec temporisation, alerte
--      `admin_alerts` (visible dans la console admin, dédupliquée) + notification
--      in-app pour les administrateurs plateforme ; alerte « surveillance
--      silencieuse » si aucun contrôle réussi n'a eu lieu depuis 26 h, et
--      « réponse non enregistrée » si pg_net n'a rien collecté après 5 min.
--   7. Activation vérifiable : `cron.job` (jobid + nom) et
--      `cron.job_run_details` alimentent une vue de lecture réservée aux
--      administrateurs plateforme.
--
-- Aucune table métier, aucun crédit, aucune clé fournisseur n'est modifié.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Jeton serveur (Vault) — généré une seule fois, jamais affiché
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'vyora_provider_health_token') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'vyora_provider_health_token',
      'Jeton serveur du job pg_cron de santé des fournisseurs IA (Groq, Gemini)'
    );
  end if;
end $$;

-- Lecture du jeton réservée au service_role (= Edge Function, jamais le navigateur).
create or replace function public.vyora_provider_health_cron_token()
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v_token text; v_jwt_role text; v_db_role text;
begin
  v_jwt_role := coalesce((select auth.jwt() ->> 'role'), '');
  v_db_role  := coalesce(nullif(current_setting('role', true), ''), '');

  -- Appelants autorises : l'Edge Function (JWT service_role) et le job pg_cron
  -- (session postgres sans JWT). Tout autre role est refuse.
  if not (
    v_jwt_role = 'service_role'
    or (
      v_jwt_role = ''
      and session_user in ('postgres', 'supabase_admin')
      and v_db_role in ('', 'none', 'postgres', 'supabase_admin')
    )
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select s.decrypted_secret into v_token
    from vault.decrypted_secrets s
   where s.name = 'vyora_provider_health_token';
  return v_token;
end;
$$;

revoke all on function public.vyora_provider_health_cron_token() from public, anon, authenticated;
grant execute on function public.vyora_provider_health_cron_token() to service_role;

-- -----------------------------------------------------------------------------
-- 2. Historique détaillé des exécutions du job (le détail que
--    ai_provider_health_checks ne conserve pas : id pg_net, tentative, erreur)
-- -----------------------------------------------------------------------------
create table if not exists saas_business.provider_health_cron_runs (
  id                  bigserial primary key,
  provider_key        text        not null
                      check (provider_key in ('groq', 'gemini')),
  model_key           text,
  status              text        not null default 'dispatched'
                      check (status in ('dispatched', 'collected', 'healthy', 'failed', 'no_response', 'skipped')),
  attempt             smallint    not null default 1 check (attempt between 1 and 5),
  http_status         integer,
  latency_ms          integer,
  error_code          text,
  provider_model_key  text,
  pg_net_request_id   bigint,
  checked_at          timestamptz,
  detail              jsonb       not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

comment on table saas_business.provider_health_cron_runs is
  'Historique du job pg_cron de surveillance des fournisseurs IA (Groq, Gemini) : statut, latence, erreur, id pg_net. Aucune donnée de facturation.';

create index if not exists provider_health_cron_runs_recent_idx
  on saas_business.provider_health_cron_runs (provider_key, created_at desc);

alter table saas_business.provider_health_cron_runs enable row level security;

drop policy if exists provider_health_cron_runs_admin_read on saas_business.provider_health_cron_runs;
create policy provider_health_cron_runs_admin_read
  on saas_business.provider_health_cron_runs
  for select
  to authenticated
  using (public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 3. État de la surveillance (une ligne par fournisseur) — sert de verrou
--    de série, de compteur de tentatives et de mémoire des alertes
-- -----------------------------------------------------------------------------
create table if not exists saas_business.provider_health_cron_state (
  provider_key          text primary key check (provider_key in ('groq', 'gemini')),
  last_dispatch_at      timestamptz,
  last_attempts         smallint    not null default 0,
  last_checked_at       timestamptz,
  last_status           text,
  last_latency_ms       integer,
  last_error_code       text,
  consecutive_failures  smallint    not null default 0,
  alert_open            boolean     not null default false,
  alert_opened_at       timestamptz,
  updated_at            timestamptz not null default now()
);

comment on table saas_business.provider_health_cron_state is
  'État du job pg_cron de santé fournisseur : dernière vérification, échecs consécutifs, alerte ouverte.';

insert into saas_business.provider_health_cron_state (provider_key)
values ('groq'), ('gemini')
on conflict (provider_key) do nothing;

alter table saas_business.provider_health_cron_state enable row level security;

drop policy if exists provider_health_cron_state_admin_read on saas_business.provider_health_cron_state;
create policy provider_health_cron_state_admin_read
  on saas_business.provider_health_cron_state
  for select
  to authenticated
  using (public.is_platform_admin());

-- -----------------------------------------------------------------------------
-- 4. Alertes : console admin (dédupliquées) + notification in-app des admins
--    plateforme. Les deux canaux existent déjà ; rien n'est inventé.
-- -----------------------------------------------------------------------------
create or replace function saas_business.provider_health_alert(
  p_provider_key text,
  p_alert_key    text,
  p_priority     text,
  p_title        text,
  p_reason       text,
  p_metadata     jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_alert_id uuid;
  v_admin    uuid;
  v_key      text := 'admin:provider-health:' || p_provider_key || ':' || p_alert_key;
begin
  -- Console admin : une seule alerte par (fournisseur, type), grâce à la
  -- contrainte unique sur admin_alerts.alert_key.
  insert into saas_immobilier.admin_alerts
    (agency_id, alert_key, kind, title, reason, priority, action_href, action_label, metadata)
  values
    (null, v_key, 'ai_provider_health', p_title, p_reason,
     case when p_priority in ('low', 'normal', 'high', 'critical') then p_priority else 'high' end,
     '/admin?tab=providers', 'Ouvrir les fournisseurs',
     coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
       'provider_key', p_provider_key,
       'timezone', 'Africa/Bamako',
       'bamako_time', to_char(now() at time zone 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')
     ))
  on conflict (alert_key) do nothing
  returning id into v_alert_id;

  -- Notification in-app : opérateurs de l'application (rôle VYORA 'admin') et
  -- administrateurs plateforme actifs. Pas de jointure sur le compte client :
  -- une notification est adressée à un user_id, et les administrateurs de la
  -- console n'ont pas nécessairement de compte Studio.
  for v_admin in
    select distinct u.user_id
      from (
        select ur.user_id from saas_ugc.ugc_user_roles ur where ur.role = 'admin'
        union
        select pa.user_id from saas_immobilier.platform_admins pa where pa.status = 'active'
      ) u
  loop
    if not exists (
      select 1 from saas_ugc.ugc_notifications n
       where n.user_id = v_admin
         and n.title = p_title
         and n.created_at > now() - interval '12 hours'
    ) then
      insert into saas_ugc.ugc_notifications (user_id, title, body, kind, href)
      values (v_admin, p_title, p_reason, 'error', '/app/admin?tab=providers');
    end if;
  end loop;

  return v_alert_id;
end;
$$;

revoke all on function saas_business.provider_health_alert(text, text, text, text, text, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Résolution d'une alerte (retour à la normale)
-- -----------------------------------------------------------------------------
create or replace function saas_business.provider_health_resolve(
  p_provider_key text
) returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare v_count integer;
begin
  update saas_immobilier.admin_alerts
     set is_read = true, read_at = now()
   where alert_key like 'admin:provider-health:' || p_provider_key || ':%'
     and is_read = false;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function saas_business.provider_health_resolve(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Enregistrement du verdict (écrit par l'Edge Function avec service_role)
--    - reprend exactement les RPC existantes pour que le routage les voie
--    - alimente l'historique détaillé du job
--    - ouvre / referme l'alerte selon le résultat
-- -----------------------------------------------------------------------------
create or replace function saas_business.vyora_record_provider_verification(
  p_provider_key        text,
  p_status              text,
  p_latency_ms          integer,
  p_error_code          text    default null,
  p_provider_model_key  text    default null,
  p_http_status         integer default null,
  p_attempt             integer default 1,
  p_pg_net_request_id   bigint  default null,
  p_detail              jsonb   default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_check_id  uuid;
  v_run_id    bigint;
  v_alerts    integer := 0;
  v_resolved  integer := 0;
  v_failures  smallint;
begin
  if p_status not in ('healthy', 'degraded', 'unavailable', 'failed') then
    raise exception 'invalid health status: %', p_status;
  end if;

  -- 1) Source de vérité du routage : mêmes RPC que `providers.verify`.
  if p_provider_model_key is not null then
    v_check_id := saas_business.bg_sync_verified_model(
      p_provider_key, p_provider_model_key, p_status, p_latency_ms, p_error_code
    );
  else
    v_check_id := saas_business.bg_record_health_check(
      p_provider_key, null, p_status, p_latency_ms, p_error_code
    );
  end if;

  -- 2) Historique détaillé de l'exécution du job.
  insert into saas_business.provider_health_cron_runs
    (provider_key, model_key, status, attempt, http_status, latency_ms, error_code,
     provider_model_key, pg_net_request_id, checked_at, detail)
  select
    p_provider_key, m.model_key,
    case when p_status = 'healthy' then 'healthy' else 'failed' end,
    greatest(1, least(5, coalesce(p_attempt, 1))),
    p_http_status, p_latency_ms, p_error_code,
    p_provider_model_key, p_pg_net_request_id, now(), coalesce(p_detail, '{}'::jsonb)
  from (select 1) x
  left join saas_business.ai_models m
    on m.provider_key = p_provider_key
   and m.provider_model_key = p_provider_model_key
  returning id into v_run_id;

  -- 3) État + alertes.
  update saas_business.provider_health_cron_state
     set last_checked_at = now(),
         last_status     = p_status,
         last_latency_ms = p_latency_ms,
         last_error_code = p_error_code,
         consecutive_failures = case when p_status = 'healthy' then 0
                                     else consecutive_failures + 1 end,
         updated_at = now()
   where provider_key = p_provider_key
   returning consecutive_failures into v_failures;

  if p_status = 'healthy' then
    v_resolved := saas_business.provider_health_resolve(p_provider_key);
    update saas_business.provider_health_cron_state
       set alert_open = false, alert_opened_at = null
     where provider_key = p_provider_key;
  elsif coalesce((select alert_open from saas_business.provider_health_cron_state
                   where provider_key = p_provider_key), false) = false
     or coalesce(v_failures, 0) >= 3 then
    -- Une alerte par épisode : ouverte au premier échec, ré-alertée tous les
    -- 3 échecs consécutifs pour ne pas noyer la console.
    perform saas_business.provider_health_alert(
      p_provider_key,
      'unavailable-' || to_char(now(), 'YYYYMMDD'),
      'high',
      format('Fournisseur IA %s indisponible', initcap(p_provider_key)),
      format('%s : le contrôle de santé a échoué (%s). Le repli est sollicité.',
             initcap(p_provider_key), coalesce(p_error_code, 'PROVIDER_UNAVAILABLE')),
      jsonb_build_object('latency_ms', p_latency_ms, 'failures', v_failures,
                         'http_status', p_http_status)
    );
    update saas_business.provider_health_cron_state
       set alert_open = true, alert_opened_at = coalesce(alert_opened_at, now())
     where provider_key = p_provider_key;
    v_alerts := 1;
  end if;

  return jsonb_build_object(
    'provider_key', p_provider_key,
    'health_check_id', v_check_id,
    'run_id', v_run_id,
    'consecutive_failures', v_failures,
    'alert_opened', v_alerts,
    'alerts_resolved', v_resolved
  );
end;
$$;

revoke all on function saas_business.vyora_record_provider_verification(text, text, integer, text, text, integer, integer, bigint, jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 7. Planification : un seul job, envoi concurrent-free
-- -----------------------------------------------------------------------------
create or replace function public.vyora_provider_health_dispatch(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_url       constant text := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-provider-health';
  v_token     text;
  v_provider  text;
  v_state     record;
  v_request   bigint;
  v_sent      jsonb := '[]'::jsonb;
  v_checked   timestamptz;
begin
  -- (4) Mono-volée : si une exécution est déjà en cours (appel HTTP ou collecte),
  -- la seconde sort immédiatement sans envoyer de requête.
  if not pg_try_advisory_xact_lock(hashtext('vyora_provider_health')) then
    return jsonb_build_object('skipped', 'concurrent_run_in_progress', 'at', now());
  end if;

  select public.vyora_provider_health_cron_token() into v_token;
  if coalesce(v_token, '') = '' then
    perform saas_business.provider_health_alert(
      'groq', 'cron-token-missing', 'critical',
      'Surveillance des fournisseurs IA non configurée',
      'Le jeton serveur Vault vyora_provider_health_token est absent : aucune vérification ne peut être envoyée.',
      '{}'::jsonb
    );
    return jsonb_build_object('error', 'TOKEN_MISSING', 'at', now());
  end if;

  for v_provider in select unnest(array['groq', 'gemini']) loop
    -- (4) Verrou de ligne : deux exécutions ne peuvent pas traiter le même
    -- fournisseur en parallèle.
    select * into v_state
      from saas_business.provider_health_cron_state
     where provider_key = v_provider
       for update skip locked;
    if not found then
      continue;
    end if;

    -- (1) Fraîcheur : un contrôle réussi de moins de 20 h rend l'appel inutile.
    if not coalesce(p_force, false) then
      select max(h.checked_at) into v_checked
        from saas_business.ai_provider_health_checks h
       where h.provider_key = v_provider
         and h.model_key is null
         and h.status = 'healthy';
      if coalesce(v_checked, '-infinity'::timestamptz) > now() - interval '20 hours' then
        update saas_business.provider_health_cron_state
           set last_attempts = 0, updated_at = now()
         where provider_key = v_provider;
        v_sent := v_sent || jsonb_build_object(
          'provider_key', v_provider, 'skipped', 'recent_health_check', 'last_healthy_at', v_checked
        );
        continue;
      end if;
    end if;

    -- (2) Appel authentifié de l'Edge Function ; (3) aucune génération : l'action
    -- `providers.verify` ne fait qu'interroger le catalogue du fournisseur.
    v_request := net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'x-vyora-cron', 'provider-health'
      ),
      body := jsonb_build_object('providerKey', v_provider),
      timeout_milliseconds := 45000
    );

    update saas_business.provider_health_cron_state
       set last_dispatch_at = now(),
           last_attempts = last_attempts + 1,
           updated_at = now()
     where provider_key = v_provider;

    -- (5) Trace immédiate : la requête est partie, même si la réponse arrive après.
    insert into saas_business.provider_health_cron_runs
      (provider_key, status, attempt, pg_net_request_id, detail)
    values (v_provider, 'dispatched', 1, v_request,
            jsonb_build_object('dispatched_at', now(), 'forced', coalesce(p_force, false)));

    v_sent := v_sent || jsonb_build_object(
      'provider_key', v_provider, 'pg_net_request_id', v_request,
      'previous_status', v_state.last_status
    );
  end loop;

  return jsonb_build_object('dispatched_at', now(), 'forced', coalesce(p_force, false), 'providers', v_sent);
end;
$$;

revoke all on function public.vyora_provider_health_dispatch(boolean) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Collecte des réponses pg_net (5 min après l'envoi)
--    - 200 : verdict écrit par l'Edge Function -> juste marqué `collected`
--    - 401/403 : authentification du job refusée (alerte critique)
--    - 404/5xx : fonction ou fournisseur en échec (alerte)
--    - pas de réponse après 5 min : `no_response` (alerte)
-- -----------------------------------------------------------------------------
create or replace function public.vyora_provider_health_collect()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_row    record;
  v_result jsonb;
  v_count  integer := 0;
  v_summary jsonb := '[]'::jsonb;
begin
  -- (4) Toujours mono-volée : la collecte partage le verrou de l'envoi.
  if not pg_try_advisory_xact_lock(hashtext('vyora_provider_health')) then
    return jsonb_build_object('skipped', 'concurrent_run_in_progress', 'at', now());
  end if;

  for v_row in
    select r.*
      from saas_business.provider_health_cron_runs r
     where r.status = 'dispatched'
       and r.pg_net_request_id is not null
       and r.created_at < now() - interval '45 seconds'
     order by r.created_at
     limit 20
       for update skip locked
  loop
    v_result := null;
    select jsonb_build_object(
             'status_code', resp.status_code,
             'body', left(coalesce(resp.content, ''), 4000)
           )
      into v_result
      from net._http_response resp
     where resp.id = v_row.pg_net_request_id;

    if v_result is null then
      -- La réponse n'est pas encore arrivée : on repasse plus tard, sauf si
      -- 5 minutes se sont écoulées (fonction muette -> incident).
      if v_row.created_at > now() - interval '5 minutes' then
        continue;
      end if;
      update saas_business.provider_health_cron_runs
         set status = 'no_response', error_code = 'CRON_NO_RESPONSE', checked_at = now()
       where id = v_row.id;
      perform saas_business.provider_health_alert(
        v_row.provider_key, 'cron-no-response-' || to_char(now(), 'YYYYMMDDHH24'), 'high',
        format('Surveillance %s sans réponse', initcap(v_row.provider_key)),
        'La fonction Edge business-grow n''a pas répondu au contrôle planifié en 5 minutes.',
        jsonb_build_object('pg_net_request_id', v_row.pg_net_request_id)
      );
      v_summary := v_summary || jsonb_build_object(
        'provider_key', v_row.provider_key, 'run_id', v_row.id, 'outcome', 'no_response'
      );
      v_count := v_count + 1;
      continue;
    end if;

    update saas_business.provider_health_cron_runs
       set http_status = (v_result ->> 'status_code')::integer,
           checked_at  = now(),
           detail      = detail || v_result,
           status      = case
                           when (v_result ->> 'status_code')::integer = 200 then 'collected'
                           when (v_result ->> 'status_code')::integer in (401, 403) then 'failed'
                           else 'failed'
                         end,
           error_code  = case
                           when (v_result ->> 'status_code')::integer = 200 then null
                           when (v_result ->> 'status_code')::integer in (401, 403) then 'CRON_AUTH_FAILED'
                           when (v_result ->> 'status_code')::integer = 404 then 'CRON_FUNCTION_NOT_FOUND'
                           else 'CRON_HTTP_' || (v_result ->> 'status_code')
                         end
     where id = v_row.id;

    if (v_result ->> 'status_code')::integer in (401, 403) then
      perform saas_business.provider_health_alert(
        v_row.provider_key, 'cron-auth-failed-' || to_char(now(), 'YYYYMMDDHH24'), 'critical',
        'Surveillance des fournisseurs IA refusée',
        format('L''appel planifié a été rejeté (HTTP %s) : jeton Vault ou configuration Edge à vérifier.',
               v_result ->> 'status_code'),
        jsonb_build_object('pg_net_request_id', v_row.pg_net_request_id)
      );
    elsif (v_result ->> 'status_code')::integer <> 200 then
      perform saas_business.provider_health_alert(
        v_row.provider_key, 'cron-http-' || to_char(now(), 'YYYYMMDDHH24'), 'high',
        format('Surveillance %s en échec', initcap(v_row.provider_key)),
        format('La fonction Edge a répondu HTTP %s au contrôle planifié.', v_result ->> 'status_code'),
        jsonb_build_object('pg_net_request_id', v_row.pg_net_request_id)
      );
    end if;

    v_summary := v_summary || jsonb_build_object(
      'provider_key', v_row.provider_key, 'run_id', v_row.id,
      'http_status', (v_result ->> 'status_code')::integer
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('collected', v_count, 'results', v_summary, 'at', now());
end;
$$;

revoke all on function public.vyora_provider_health_collect() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 9. Garde-fou : la surveillance elle-même est-elle vivante ?
--    Si aucun contrôle réussi depuis 26 h, le job ne tourne plus (ou les deux
--    fournisseurs sont tombés) -> alerte critique, même sans exécution.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_provider_health_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_provider text;
  v_last     timestamptz;
  v_overdue  jsonb := '[]'::jsonb;
begin
  foreach v_provider in array array['groq', 'gemini'] loop
    select max(h.checked_at) into v_last
      from saas_business.ai_provider_health_checks h
     where h.provider_key = v_provider
       and h.model_key is null
       and h.status = 'healthy';

    if coalesce(v_last, '-infinity'::timestamptz) < now() - interval '26 hours' then
      perform saas_business.provider_health_alert(
        v_provider, 'stale-' || to_char(now(), 'YYYYMMDD'), 'critical',
        format('Contrôle de santé %s périmé', initcap(v_provider)),
        format('Aucun contrôle réussi depuis %s. Sans contrôle de moins de 24 h, le routage refusera ce fournisseur (NO_VERIFIED_PROVIDER).',
               coalesce(to_char(v_last at time zone 'Africa/Bamako', 'DD/MM/YYYY HH24:MI'), 'jamais')),
        jsonb_build_object('last_healthy_at', v_last)
      );
      update saas_business.provider_health_cron_state
         set alert_open = true, alert_opened_at = coalesce(alert_opened_at, now())
       where provider_key = v_provider;
      v_overdue := v_overdue || to_jsonb(v_provider);
    end if;
  end loop;

  return jsonb_build_object('overdue', v_overdue, 'checked_at', now());
end;
$$;

revoke all on function public.vyora_provider_health_watchdog() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 10. Création des jobs (idempotente : un seul job par nom)
-- -----------------------------------------------------------------------------
do $$
declare v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname = 'vyora-provider-health-daily' loop
    perform cron.unschedule(v_job);
  end loop;
  for v_job in select jobid from cron.job where jobname = 'vyora-provider-health-collect' loop
    perform cron.unschedule(v_job);
  end loop;
  for v_job in select jobid from cron.job where jobname = 'vyora-provider-health-fresh-guard' loop
    perform cron.unschedule(v_job);
  end loop;
  for v_job in select jobid from cron.job where jobname = 'vyora-provider-health-watchdog' loop
    perform cron.unschedule(v_job);
  end loop;
end $$;

-- Envoi du contrôle : deux fois par jour (02:00 et 14:00 UTC).
select cron.schedule(
  'vyora-provider-health-daily',
  '0 2,14 * * *',
  $$select public.vyora_provider_health_dispatch(false)$$
);

-- Collecte des réponses : toutes les 5 minutes.
select cron.schedule(
  'vyora-provider-health-collect',
  '*/5 * * * *',
  $$select public.vyora_provider_health_collect()$$
);

-- Garde de fraîcheur : toutes les heures, ré-envoie si un fournisseur n'a plus
-- de contrôle réussi de moins de 20 h (marge de 4 h avant l'expiration des 24 h).
select cron.schedule(
  'vyora-provider-health-fresh-guard',
  '20 * * * *',
  $$select public.vyora_provider_health_dispatch(false)$$
);

-- Garde-fou : une fois par jour, contrôle que la surveillance tourne encore.
select cron.schedule(
  'vyora-provider-health-watchdog',
  '40 6 * * *',
  $$select public.vyora_provider_health_watchdog()$$
);

-- -----------------------------------------------------------------------------
-- 11. Lecture administrateur : job actif, dernières exécutions, dernières
--     vérifications des deux fournisseurs (une seule requête, côté serveur)
-- -----------------------------------------------------------------------------
create or replace function public.vyora_provider_health_status()
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare v_result jsonb;
begin
  if not (
    coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or (((select auth.uid()) is not null) and (
      public.is_platform_admin() or ugc_private.has_role((select auth.uid()), 'admin')
    ))
  ) then
    raise exception 'Administrateur VYORA requis.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'jobid', j.jobid,
               'jobname', j.jobname,
               'schedule', j.schedule,
               'active', j.active,
               'command', j.command
             ) order by j.jobid)
        from cron.job j
       where j.jobname like 'vyora-provider-health-%'
    ), '[]'::jsonb),
    'last_runs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'jobid', d.jobid,
               'jobname', j2.jobname,
               'status', d.status,
               'return_message', d.return_message,
               'start_time', d.start_time,
               'end_time', d.end_time
             ) order by d.start_time desc)
        from (
          select * from cron.job_run_details
           where jobid in (select jobid from cron.job where jobname like 'vyora-provider-health-%')
           order by start_time desc
           limit 8
        ) d
        left join cron.job j2 on j2.jobid = d.jobid
    ), '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(row_to_json(p) order by p.provider_key)
        from (
          select s.provider_key,
                 s.last_checked_at,
                 s.last_status,
                 s.last_latency_ms,
                 s.last_error_code,
                 s.consecutive_failures,
                 s.alert_open,
                 s.last_dispatch_at,
                 (select max(h.checked_at) from saas_business.ai_provider_health_checks h
                   where h.provider_key = s.provider_key and h.model_key is null
                     and h.status = 'healthy') as last_healthy_at,
                 (select m.provider_model_key
                    from saas_business.ai_models m
                   where m.provider_key = s.provider_key
                     and m.verification_status = 'verified'
                   order by m.verified_at desc nulls last
                   limit 1) as verified_model,
                 (select p2.status from saas_business.ai_providers p2
                   where p2.provider_key = s.provider_key) as provider_status,
                 (select p2.enabled from saas_business.ai_providers p2
                   where p2.provider_key = s.provider_key) as provider_enabled
            from saas_business.provider_health_cron_state s
        ) p
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider_key', r.provider_key,
               'status', r.status,
               'attempt', r.attempt,
               'http_status', r.http_status,
               'latency_ms', r.latency_ms,
               'error_code', r.error_code,
               'provider_model_key', r.provider_model_key,
               'checked_at', r.checked_at,
               'created_at', r.created_at
             ) order by r.created_at desc)
        from (
          select * from saas_business.provider_health_cron_runs
           order by created_at desc
           limit 12
        ) r
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.vyora_provider_health_status() from public, anon;
grant execute on function public.vyora_provider_health_status() to authenticated, service_role;

commit;
