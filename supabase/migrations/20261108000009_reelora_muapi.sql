-- Reelora v1.1 — MuAPI as the PRIMARY video provider.
-- Strictly additive: no existing table, column, policy, view or datum is removed.
-- Existing credit rules (reserve -> capture/release through ugc_private.apply_wallet_delta)
-- are preserved; this migration only adds idempotency, a verified model catalog and
-- server-side tracking (webhook + pg_cron/pg_net reconciliation).
--
-- MuAPI facts used here come from the official documentation:
--   https://muapi.ai/docs/api-reference          (x-api-key, submit/poll, status values, cost)
--   https://muapi.ai/docs/webhooks               (?webhook= on submit, payload shape)
--   https://muapi.ai/docs/models                 (GET /api/v1/models catalog)
--   https://muapi.ai/playground/<model>/llms.txt (per-model endpoints & input schemas)

create extension if not exists pg_net with schema extensions;

/* -------------------------------------------------------------------------- */
/* 1. Verified MuAPI video model catalog                                       */
/* -------------------------------------------------------------------------- */

create table if not exists saas_ugc.ugc_video_models (
  model_id        text primary key check (model_id ~ '^[a-z0-9._-]+$'),
  display_name    text not null,
  description     text,
  category        text not null check (category in ('Text to Video', 'Image to Video')),
  endpoint        text not null check (endpoint like '/api/v1/%'),
  input_fields    jsonb not null default '[]'::jsonb,
  required_fields jsonb not null default '[]'::jsonb,
  param_schema    jsonb not null default '{}'::jsonb,
  cost_usd        numeric(12,4),
  cost_currency   text not null default 'USD',
  is_enabled      boolean not null default true,
  is_coming_soon  boolean not null default false,
  active          boolean not null default true,
  sort_order      integer not null default 0,
  synced_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists ugc_video_models_touch on saas_ugc.ugc_video_models;
create trigger ugc_video_models_touch before update on saas_ugc.ugc_video_models
  for each row execute function ugc_private.touch_updated_at();

create or replace view public.reelora_video_models with (security_invoker = true) as
  select * from saas_ugc.ugc_video_models;

grant select on saas_ugc.ugc_video_models to anon, authenticated;
alter table saas_ugc.ugc_video_models enable row level security;
drop policy if exists reelora_video_models_select on saas_ugc.ugc_video_models;
create policy reelora_video_models_select on saas_ugc.ugc_video_models
  for select to anon, authenticated using (active and is_enabled and not is_coming_soon);

-- Only endpoints and input parameters verified against the official per-model docs
-- are exposed. The live GET /api/v1/models catalog is used to refresh metadata
-- (cost, description, availability), never to invent an endpoint.
insert into saas_ugc.ugc_video_models
  (model_id, display_name, description, category, endpoint, input_fields, required_fields, param_schema, cost_usd, sort_order)
values
 ('seedance-lite-t2v', 'Seedance Lite — Texte → Vidéo',
  'Génération rapide et économique depuis un prompt. Idéale pour les prototypes UGC.',
  'Text to Video', '/api/v1/seedance-lite-t2v',
  '["prompt","aspect_ratio","resolution","duration","camera_fixed"]'::jsonb, '["prompt"]'::jsonb,
  '{"aspect_ratio":{"type":"select","label":"Format","options":["16:9","9:16","1:1","4:3","3:4","9:21"],"default":"9:16"},
    "resolution":{"type":"select","label":"Résolution","options":["480p","720p","1080p"],"default":"480p"},
    "duration":{"type":"number","label":"Durée (s)","min":5,"max":30,"default":5},
    "camera_fixed":{"type":"boolean","label":"Caméra fixe","default":false}}'::jsonb,
  0.1000, 1),
 ('veo3-fast-text-to-video', 'Veo 3 Fast — Texte → Vidéo',
  'Rendu cinématique rapide depuis un prompt, formats 16:9 et 9:16.',
  'Text to Video', '/api/v1/veo3-fast-text-to-video',
  '["prompt","aspect_ratio"]'::jsonb, '["prompt"]'::jsonb,
  '{"aspect_ratio":{"type":"select","label":"Format","options":["16:9","9:16"],"default":"9:16"}}'::jsonb,
  0.6000, 2),
 ('grok-imagine-text-to-video', 'Grok Imagine — Texte → Vidéo',
  'Clips créatifs de 6 à 30 secondes avec ambiance sonore, modes normal/fun/spicy.',
  'Text to Video', '/api/v1/grok-imagine-text-to-video',
  '["prompt","aspect_ratio","mode","resolution","duration"]'::jsonb, '["prompt"]'::jsonb,
  '{"aspect_ratio":{"type":"select","label":"Format","options":["9:16","16:9","2:3","3:2","1:1"],"default":"9:16"},
    "mode":{"type":"select","label":"Style","options":["normal","fun","spicy"],"default":"normal"},
    "resolution":{"type":"select","label":"Résolution","options":["480p","720p"],"default":"480p"},
    "duration":{"type":"number","label":"Durée (s)","min":6,"max":30,"default":6}}'::jsonb,
  0.1500, 3),
 ('seedance-lite-i2v', 'Seedance Lite — Image → Vidéo',
  'Anime une image de référence (produit ou avatar) avec un prompt de mouvement.',
  'Image to Video', '/api/v1/seedance-lite-i2v',
  '["prompt","image_url","last_image","resolution","duration","camera_fixed"]'::jsonb, '["prompt","image_url"]'::jsonb,
  '{"resolution":{"type":"select","label":"Résolution","options":["480p","720p","1080p"],"default":"480p"},
    "duration":{"type":"number","label":"Durée (s)","min":5,"max":30,"default":5},
    "camera_fixed":{"type":"boolean","label":"Caméra fixe","default":false}}'::jsonb,
  0.1000, 4),
 ('kling-o1-standard-image-to-video', 'Kling O1 Standard — Image → Vidéo',
  'Animation réaliste et stable d’une image de référence, durées 5 ou 10 secondes.',
  'Image to Video', '/api/v1/kling-o1-standard-image-to-video',
  '["prompt","image_url","last_image","duration"]'::jsonb, '["prompt","image_url"]'::jsonb,
  '{"duration":{"type":"select","label":"Durée (s)","options":[5,10],"default":5}}'::jsonb,
  0.5000, 5)
on conflict (model_id) do update set
  display_name = excluded.display_name, description = excluded.description,
  category = excluded.category, endpoint = excluded.endpoint,
  input_fields = excluded.input_fields, required_fields = excluded.required_fields,
  param_schema = excluded.param_schema, cost_usd = excluded.cost_usd,
  sort_order = excluded.sort_order, updated_at = now();

/* -------------------------------------------------------------------------- */
/* 2. Additive tracking columns on existing jobs                              */
/* -------------------------------------------------------------------------- */

alter table saas_ugc.ugc_generation_jobs
  add column if not exists provider_status      text,
  add column if not exists next_poll_at         timestamptz,
  add column if not exists last_polled_at       timestamptz,
  add column if not exists poll_attempts        integer not null default 0,
  add column if not exists expires_at           timestamptz,
  add column if not exists webhook_received_at  timestamptz,
  add column if not exists submission_claim_id  text,
  add column if not exists muapi_cost           jsonb;

create unique index if not exists ugc_jobs_provider_job_idx
  on saas_ugc.ugc_generation_jobs (provider, provider_job_id)
  where provider_job_id is not null;
create index if not exists ugc_jobs_due_poll_idx
  on saas_ugc.ugc_generation_jobs (status, next_poll_at)
  where status = 'processing';

/* -------------------------------------------------------------------------- */
/* 3. Worker token (Supabase Vault) — one source of truth for the webhook URL  */
/*    and for the cron caller. Never exposed to the browser.                   */
/* -------------------------------------------------------------------------- */

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'reelora_worker_token') then
    perform vault.create_secret(
      gen_random_uuid()::text || gen_random_uuid()::text,
      'reelora_worker_token',
      'Reelora MuAPI worker/webhook shared token (server-side only)'
    );
  end if;
end $$;

-- service-role-only accessor. Used by the Edge Functions to build the webhook URL
-- and to validate incoming callbacks. MuAPI does not publish a signature scheme,
-- so callbacks are additionally re-verified against GET /predictions/{id}/result.
create or replace function ugc_private.reelora_worker_token()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_token text;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets
   where name = 'reelora_worker_token';
  return v_token;
end $$;

revoke all on function ugc_private.reelora_worker_token() from public, anon, authenticated;
grant execute on function ugc_private.reelora_worker_token() to service_role;

/* -------------------------------------------------------------------------- */
/* 4. Idempotent generation start (existing credit rules unchanged)           */
/* -------------------------------------------------------------------------- */

drop function if exists public.reelora_start_generation(uuid, text, jsonb);

create or replace function public.reelora_start_generation(
  p_project_id uuid, p_service_key text, p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_project saas_ugc.ugc_video_projects%rowtype;
        v_service saas_ugc.ugc_service_catalog%rowtype; v_balance bigint;
        v_job uuid; v_key text;
begin
  perform ugc_private.reelora_assert_active();
  select * into v_project from saas_ugc.ugc_video_projects p where p.id = p_project_id;
  if not found or not ugc_private.can_edit_workspace(v_project.workspace_id) then raise exception 'forbidden'; end if;
  select * into v_service from saas_ugc.ugc_service_catalog s where s.service_key = p_service_key and s.active = true;
  if not found then raise exception 'service_unavailable'; end if;

  if p_idempotency_key is not null then
    v_key := btrim(p_idempotency_key);
    if length(v_key) < 8 or length(v_key) > 120 or v_key !~ '^[A-Za-z0-9._:-]+$' then
      raise exception 'invalid_idempotency_key';
    end if;
  else
    v_key := 'reelora-' || gen_random_uuid()::text;
  end if;

  -- Atomic claim of the idempotency key. A repeated call returns the SAME job
  -- without creating a second reservation or a second ledger entry.
  insert into saas_ugc.ugc_generation_jobs(
      workspace_id, project_id, created_by, service_key, status,
      request_payload, request_key, expires_at, next_poll_at)
  values (v_project.workspace_id, p_project_id, v_uid, p_service_key, 'queued',
      coalesce(p_payload, '{}'::jsonb), v_key,
      now() + interval '45 minutes', now() + interval '15 seconds')
  on conflict (created_by, request_key) do nothing
  returning id into v_job;

  if v_job is null then
    select j.id into v_job from saas_ugc.ugc_generation_jobs j
     where j.created_by = v_uid and j.request_key = v_key;
    return v_job;
  end if;

  select w.available_balance into v_balance from saas_ugc.ugc_wallets w where w.user_id = v_uid;
  if coalesce(v_balance, 0) < v_service.credits_cost then raise exception 'insufficient_credits'; end if;

  perform public.reelora_consume_quota('video', v_job, jsonb_build_object('service_key', p_service_key));
  perform ugc_private.apply_wallet_delta(v_uid, 'reserve', -v_service.credits_cost, v_service.credits_cost,
      'reserve-job:' || v_job::text, 'Réservation de crédits pour génération MuAPI',
      jsonb_build_object('service_key', p_service_key), null, v_job);
  update saas_ugc.ugc_generation_jobs
     set status = 'reserved', credits_reserved = v_service.credits_cost,
         reservation_idempotency_key = 'reserve-job:' || v_job::text, updated_at = now()
   where id = v_job;
  insert into saas_ugc.ugc_job_events(generation_job_id, actor_user_id, event_type, from_status, to_status, payload)
  values (v_job, v_uid, 'submitted', 'queued', 'reserved', jsonb_build_object('credits', v_service.credits_cost));
  update saas_ugc.ugc_video_projects set status = 'queued', updated_at = now() where id = p_project_id;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_uid, 'Génération lancée', 'Votre vidéo est en file d’attente. Le suivi continue côté serveur, même si vous fermez cette page.', 'info', '/app/historique');
  return v_job;
end $$;

revoke all on function public.reelora_start_generation(uuid, text, jsonb, text) from public, anon;
grant execute on function public.reelora_start_generation(uuid, text, jsonb, text) to authenticated, service_role;

/* -------------------------------------------------------------------------- */
/* 5. Server-side RPCs (service_role only)                                    */
/* -------------------------------------------------------------------------- */

-- Only one caller may submit a job to MuAPI. Prevents duplicate provider charges.
create or replace function public.reelora_claim_generation_submission(p_job_id uuid, p_claim_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  update saas_ugc.ugc_generation_jobs
     set submission_claim_id = p_claim_id, updated_at = now()
   where id = p_job_id and submission_claim_id is null and status in ('queued','reserved')
   returning id into v_id;
  if v_id is null then return false; end if;
  insert into saas_ugc.ugc_job_events(generation_job_id, event_type, to_status, payload)
  values (p_job_id, 'submission_claimed', 'reserved', jsonb_build_object('claim_id', p_claim_id));
  return true;
end $$;

-- Give back the monthly quota unit ONLY for a job that really failed/cancelled.
-- Job-scoped (no time window, no arbitrary "latest event" refund).
create or replace function public.reelora_release_video_quota(p_job_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_job_id is null or p_user_id is null then return false; end if;
  if not exists (select 1 from saas_ugc.ugc_generation_jobs j
                  where j.id = p_job_id and j.created_by = p_user_id
                    and j.status in ('failed','cancelled')) then return false; end if;
  select e.id into v_id from saas_ugc.ugc_usage_events e
   where e.user_id = p_user_id and e.event_kind = 'video' and e.reference_id = p_job_id
   order by e.created_at desc limit 1;
  if v_id is null then return false; end if;
  delete from saas_ugc.ugc_usage_events where id = v_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (p_user_id, 'release_video_quota', 'usage_event', v_id::text,
          jsonb_build_object('job_id', p_job_id, 'source', 'muapi_worker'));
  return true;
end $$;

create or replace function public.reelora_record_video_poll(
  p_job_id uuid, p_provider_status text, p_next_poll_seconds integer default 30,
  p_cost jsonb default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  update saas_ugc.ugc_generation_jobs
     set provider_status = p_provider_status, last_polled_at = now(), last_heartbeat_at = now(),
         next_poll_at = now() + (least(greatest(coalesce(p_next_poll_seconds, 30), 5), 300) || ' seconds')::interval,
         muapi_cost = coalesce(p_cost, muapi_cost), updated_at = now()
   where id = p_job_id and status = 'processing';
  return found;
end $$;

-- One transaction: expire abandoned jobs (credits + quota released), then claim
-- due jobs for a single MuAPI poll each. Called every minute by pg_cron.
create or replace function public.reelora_video_tick(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job record; v_expired integer := 0; v_due jsonb;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;

  for v_job in
    select * from saas_ugc.ugc_generation_jobs j
     where j.status in ('queued','reserved','processing')
       and j.expires_at is not null and j.expires_at < now()
     order by j.created_at limit 50 for update skip locked
  loop
    if v_job.credits_reserved > 0 then
      perform ugc_private.apply_wallet_delta(v_job.created_by, 'release',
        v_job.credits_reserved, -v_job.credits_reserved,
        'release-job:' || v_job.id::text, 'Génération expirée, crédits restitués',
        '{}'::jsonb, null, v_job.id);
    end if;
    delete from saas_ugc.ugc_usage_events e
     where e.reference_id = v_job.id and e.event_kind = 'video' and e.user_id = v_job.created_by;
    update saas_ugc.ugc_generation_jobs
       set status = 'failed', credits_reserved = 0, error_code = 'timeout',
           error_message = 'Délai d’attente MuAPI dépassé (45 minutes). Crédits restitués.',
           completed_at = now(), updated_at = now()
     where id = v_job.id;
    update saas_ugc.ugc_video_projects set status = 'failed', updated_at = now() where id = v_job.project_id;
    insert into saas_ugc.ugc_job_events(generation_job_id, event_type, from_status, to_status, payload)
    values (v_job.id, 'expired', v_job.status, 'failed', jsonb_build_object('provider_job_id', v_job.provider_job_id));
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_job.created_by, 'Génération expirée', 'Le fournisseur n’a pas répondu à temps. Vos crédits ont été restitués.', 'error', '/app/historique');
    insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
    values (v_job.created_by, 'generation_timeout', 'generation_job', v_job.id::text,
            jsonb_build_object('provider_job_id', v_job.provider_job_id));
    v_expired := v_expired + 1;
  end loop;

  with due as (
    select id from saas_ugc.ugc_generation_jobs j
     where j.status = 'processing' and j.provider_job_id is not null
       and j.poll_attempts < 120
       and (j.next_poll_at is null or j.next_poll_at <= now())
       and (j.expires_at is null or j.expires_at > now())
     order by coalesce(j.next_poll_at, j.created_at)
     limit least(greatest(coalesce(p_limit, 10), 1), 50)
     for update skip locked
  ), upd as (
    update saas_ugc.ugc_generation_jobs j
       set next_poll_at = now() + interval '30 seconds', last_polled_at = now(),
           poll_attempts = j.poll_attempts + 1, last_heartbeat_at = now(), updated_at = now()
      from due where j.id = due.id
    returning jsonb_build_object(
      'job_id', j.id, 'created_by', j.created_by, 'workspace_id', j.workspace_id,
      'project_id', j.project_id, 'provider_job_id', j.provider_job_id,
      'provider', j.provider, 'expires_at', j.expires_at, 'request_key', j.request_key) as row
  )
  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_due from upd;

  return jsonb_build_object('expired', v_expired, 'due', v_due, 'checked_at', now());
end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('reelora_claim_generation_submission','reelora_release_video_quota',
                               'reelora_record_video_poll','reelora_video_tick') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

/* -------------------------------------------------------------------------- */
/* 6. Configuration (no free monthly credits added)                           */
/* -------------------------------------------------------------------------- */

insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description) values
 ('video_defaults',
  '{"provider":"muapi","default_model":"seedance-lite-t2v","poll_interval_seconds":30,"timeout_minutes":45,"webhook_enabled":true,"max_poll_attempts":120}'::jsonb,
  'Fournisseur vidéo principal et paramètres de suivi serveur')
on conflict (setting_key) do update set setting_value = excluded.setting_value,
  description = excluded.description, updated_at = now();

/* -------------------------------------------------------------------------- */
/* 7. Server-side reconciliation: webhook is primary, cron is the safety net  */
/* -------------------------------------------------------------------------- */

do $$
begin
  perform cron.unschedule('reelora-video-tick');
exception when others then null;
end $$;

select cron.schedule(
  'reelora-video-tick',
  '* * * * *',
  $cmd$
    select net.http_post(
      url := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/reelora-video-worker?mode=tick',
      body := '{"mode":"tick"}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-reelora-worker-token',
        coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'reelora_worker_token'), '')),
      timeout_milliseconds := 10000
    );
  $cmd$
);

notify pgrst, 'reload schema';
