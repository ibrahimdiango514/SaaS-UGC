-- Server-validated video pricing. Client-visible credit quotes are opaque and
-- are reserved atomically against the exact quote that produced them.

alter table saas_ugc.ugc_generation_jobs
  add column if not exists pricing_quote_id uuid;

alter table saas_ugc.ugc_video_models
  add column if not exists public_id uuid not null default gen_random_uuid();

create or replace view public.reelora_video_models with (security_invoker = true) as
  select * from saas_ugc.ugc_video_models;

create unique index if not exists ugc_video_models_public_id_idx
  on saas_ugc.ugc_video_models(public_id);

revoke all on public.reelora_video_models from public, anon, authenticated;
grant select on public.reelora_video_models to service_role;
revoke all on saas_ugc.ugc_video_models from public, anon, authenticated;
grant select on saas_ugc.ugc_video_models to service_role;

insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'video_pricing_config',
  '{"enabled":false,"usd_to_xof":null,"credit_value_xof":null,"markup_percent":110,"additional_cost_usd":null}'::jsonb,
  'Configuration interne des tarifs de génération vidéo'
)
on conflict (setting_key) do nothing;

create table if not exists saas_ugc.ugc_video_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  service_key text not null,
  model_id text not null,
  public_model_id uuid not null,
  credits_cost integer not null check (credits_cost > 0),
  provider_cost_usd numeric(12,6) not null check (provider_cost_usd > 0),
  usd_to_xof numeric(14,4) not null check (usd_to_xof > 0),
  credit_value_xof numeric(14,4) not null check (credit_value_xof > 0),
  markup_percent numeric(8,4) not null check (markup_percent >= 0),
  additional_cost_usd numeric(12,6) not null check (additional_cost_usd >= 0),
  config_updated_at timestamptz not null,
  quote_params jsonb not null default '{}'::jsonb,
  pricing_params jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ugc_video_quotes_user_expiry_idx
  on saas_ugc.ugc_video_quotes(user_id, expires_at desc);

alter table saas_ugc.ugc_video_quotes enable row level security;
revoke all on saas_ugc.ugc_video_quotes from public, anon, authenticated;
grant select, insert, update on saas_ugc.ugc_video_quotes to service_role;

create or replace function public.reelora_admin_set_video_pricing(
  p_usd_to_xof numeric,
  p_credit_value_xof numeric,
  p_markup_percent numeric,
  p_additional_cost_usd numeric,
  p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if p_usd_to_xof is null or p_usd_to_xof <= 0 or p_usd_to_xof > 10000
     or p_credit_value_xof is null or p_credit_value_xof <= 0 or p_credit_value_xof > 100000000
     or p_markup_percent is null or p_markup_percent < 0 or p_markup_percent > 10000
     or p_additional_cost_usd is null or p_additional_cost_usd < 0 or p_additional_cost_usd > 100000 then
    raise exception 'invalid_video_pricing';
  end if;
  if coalesce(p_enabled, false) and not exists (
    select 1 from saas_ugc.ugc_video_models
     where synced_at >= now() - interval '24 hours'
       and is_enabled and not is_coming_soon
  ) then
    raise exception 'video_catalog_not_verified';
  end if;

  select setting_value into v_old
    from saas_ugc.ugc_app_settings
   where setting_key = 'video_pricing_config'
   for update;
  v_new := jsonb_build_object(
    'enabled', coalesce(p_enabled, false),
    'usd_to_xof', p_usd_to_xof,
    'credit_value_xof', p_credit_value_xof,
    'markup_percent', p_markup_percent,
    'additional_cost_usd', p_additional_cost_usd
  );
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
  values ('video_pricing_config', v_new, 'Configuration interne des tarifs de génération vidéo')
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value, updated_at = now();

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    (select auth.uid()), 'set_video_pricing', 'setting', 'video_pricing_config',
    jsonb_build_object('previous', coalesce(v_old, '{}'::jsonb), 'new', v_new)
  );
  return true;
end $$;

create or replace function public.reelora_record_video_quote(
  p_user_id uuid,
  p_service_key text,
  p_model_id text,
  p_public_model_id uuid,
  p_credits_cost integer,
  p_provider_cost_usd numeric,
  p_usd_to_xof numeric,
  p_credit_value_xof numeric,
  p_markup_percent numeric,
  p_additional_cost_usd numeric,
  p_config_updated_at timestamptz,
  p_quote_params jsonb,
  p_pricing_params jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_user_id is null or p_service_key is null or p_model_id is null or p_public_model_id is null
     or p_credits_cost is null or p_credits_cost <= 0
     or p_provider_cost_usd is null or p_provider_cost_usd <= 0
     or p_usd_to_xof is null or p_usd_to_xof <= 0
     or p_credit_value_xof is null or p_credit_value_xof <= 0
     or p_markup_percent is null or p_markup_percent < 0
     or p_additional_cost_usd is null or p_additional_cost_usd < 0
     or p_config_updated_at is null then
    raise exception 'invalid_video_quote';
  end if;
  if not exists (
    select 1 from saas_ugc.ugc_app_settings s
     where s.setting_key = 'video_pricing_config'
       and s.updated_at = p_config_updated_at
       and coalesce((s.setting_value->>'enabled')::boolean, false)
  ) then
    raise exception 'video_pricing_changed';
  end if;
  insert into saas_ugc.ugc_video_quotes(
    user_id, service_key, model_id, public_model_id, credits_cost, provider_cost_usd,
    usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd,
    config_updated_at, quote_params, pricing_params
  ) values (
    p_user_id, p_service_key, p_model_id, p_public_model_id, p_credits_cost, p_provider_cost_usd,
    p_usd_to_xof, p_credit_value_xof, p_markup_percent, p_additional_cost_usd,
    p_config_updated_at, coalesce(p_quote_params, '{}'::jsonb), coalesce(p_pricing_params, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.reelora_get_video_quote(p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  return (
    select to_jsonb(q)
      from saas_ugc.ugc_video_quotes q
     where q.id = p_quote_id
     limit 1
  );
end $$;

drop function if exists public.reelora_start_generation(uuid, text, jsonb, text);

create or replace function public.reelora_start_generation(
  p_project_id uuid,
  p_service_key text,
  p_payload jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_quote_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_project saas_ugc.ugc_video_projects%rowtype;
  v_service saas_ugc.ugc_service_catalog%rowtype;
  v_quote saas_ugc.ugc_video_quotes%rowtype;
  v_balance bigint;
  v_job uuid;
  v_existing_quote uuid;
  v_key text;
  v_model_id text;
  v_setting_updated_at timestamptz;
  v_setting_enabled boolean;
begin
  perform ugc_private.reelora_assert_active();
  if p_quote_id is null then raise exception 'video_quote_required'; end if;

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

  select j.id, j.pricing_quote_id into v_job, v_existing_quote
    from saas_ugc.ugc_generation_jobs j
   where j.created_by = v_uid and j.request_key = v_key;
  if found then
    if v_existing_quote is distinct from p_quote_id then raise exception 'idempotency_quote_mismatch'; end if;
    return v_job;
  end if;

  select coalesce((setting_value->>'enabled')::boolean, false), updated_at
    into v_setting_enabled, v_setting_updated_at
    from saas_ugc.ugc_app_settings
   where setting_key = 'video_pricing_config';
  if not coalesce(v_setting_enabled, false) then raise exception 'video_pricing_unavailable'; end if;

  v_model_id := coalesce(p_payload->>'model_id', '');
  select * into v_quote from saas_ugc.ugc_video_quotes q
   where q.id = p_quote_id
     and q.user_id = v_uid
     and q.service_key = p_service_key
     and q.public_model_id::text = v_model_id
     and q.consumed_at is null
     and q.expires_at > now()
     and q.config_updated_at = v_setting_updated_at
   for update;
  if not found then
    select j.id, j.pricing_quote_id into v_job, v_existing_quote
      from saas_ugc.ugc_generation_jobs j
     where j.created_by = v_uid and j.request_key = v_key;
    if found then
      if v_existing_quote is distinct from p_quote_id then raise exception 'idempotency_quote_mismatch'; end if;
      return v_job;
    end if;
    raise exception 'video_quote_invalid';
  end if;

  insert into saas_ugc.ugc_generation_jobs(
      workspace_id, project_id, created_by, service_key, status,
      request_payload, request_key, expires_at, next_poll_at, pricing_quote_id)
  values (v_project.workspace_id, p_project_id, v_uid, p_service_key, 'queued',
      coalesce(p_payload, '{}'::jsonb), v_key,
      now() + interval '45 minutes', now() + interval '15 seconds', p_quote_id)
  on conflict (created_by, request_key) do nothing
  returning id into v_job;

  if v_job is null then
    select j.id, j.pricing_quote_id into v_job, v_existing_quote
      from saas_ugc.ugc_generation_jobs j
     where j.created_by = v_uid and j.request_key = v_key;
    if v_existing_quote is distinct from p_quote_id then raise exception 'idempotency_quote_mismatch'; end if;
    return v_job;
  end if;

  select w.available_balance into v_balance from saas_ugc.ugc_wallets w where w.user_id = v_uid;
  if coalesce(v_balance, 0) < v_quote.credits_cost then raise exception 'insufficient_credits'; end if;

  perform public.reelora_consume_quota('video', v_job, jsonb_build_object('service_key', p_service_key));
  perform ugc_private.apply_wallet_delta(v_uid, 'reserve', -v_quote.credits_cost, v_quote.credits_cost,
      'reserve-job:' || v_job::text, 'Réservation de crédits pour génération vidéo',
      jsonb_build_object('service_key', p_service_key, 'pricing_quote_id', p_quote_id), null, v_job);
  update saas_ugc.ugc_generation_jobs
     set status = 'reserved', credits_reserved = v_quote.credits_cost,
         reservation_idempotency_key = 'reserve-job:' || v_job::text, updated_at = now()
   where id = v_job;
  update saas_ugc.ugc_video_quotes set consumed_at = now() where id = p_quote_id;
  insert into saas_ugc.ugc_job_events(generation_job_id, actor_user_id, event_type, from_status, to_status, payload)
  values (v_job, v_uid, 'submitted', 'queued', 'reserved',
          jsonb_build_object('credits', v_quote.credits_cost, 'pricing_quote_id', p_quote_id));
  update saas_ugc.ugc_video_projects set status = 'queued', updated_at = now() where id = p_project_id;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_uid, 'Génération lancée', 'Votre vidéo est en file d’attente. Le suivi continue automatiquement.', 'info', '/app/historique');
  return v_job;
end $$;

create or replace function public.reelora_admin_set_setting(p_key text, p_value jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_key = 'video_pricing_config' then raise exception 'use_video_pricing_settings'; end if;
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value) values (p_key, coalesce(p_value, '{}'::jsonb))
  on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now();
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_setting', 'setting', p_key, jsonb_build_object('value', p_value));
  return true;
end $$;

revoke all on function public.reelora_admin_set_video_pricing(numeric, numeric, numeric, numeric, boolean) from public, anon;
grant execute on function public.reelora_admin_set_video_pricing(numeric, numeric, numeric, numeric, boolean) to authenticated;
revoke all on function public.reelora_record_video_quote(uuid, text, text, uuid, integer, numeric, numeric, numeric, numeric, numeric, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.reelora_record_video_quote(uuid, text, text, uuid, integer, numeric, numeric, numeric, numeric, numeric, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.reelora_get_video_quote(uuid) from public, anon, authenticated;
grant execute on function public.reelora_get_video_quote(uuid) to service_role;
revoke all on function public.reelora_start_generation(uuid, text, jsonb, text, uuid) from public, anon;
grant execute on function public.reelora_start_generation(uuid, text, jsonb, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
