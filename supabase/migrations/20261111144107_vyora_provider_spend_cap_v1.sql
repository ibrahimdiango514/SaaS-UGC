-- Atomic provider spend guard for paid video generation calls.
-- Customer credit reservations remain independent from this USD budget.

insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'provider_spend_cap',
  '{"enabled":false,"max_usd":0}'::jsonb,
  'Plafond interne de dépenses fournisseur pour les générations vidéo'
)
on conflict (setting_key) do nothing;

create table if not exists saas_ugc.ugc_provider_spend (
  id uuid primary key default gen_random_uuid(),
  generation_job_id uuid not null unique references saas_ugc.ugc_generation_jobs(id) on delete restrict,
  quote_id uuid not null references saas_ugc.ugc_video_quotes(id) on delete restrict,
  provider text not null default 'muapi',
  model_id text not null,
  provider_request_id text,
  estimated_cost_usd numeric(14,6) not null check (estimated_cost_usd > 0),
  reserved_cost_usd numeric(14,6) not null default 0 check (reserved_cost_usd >= 0),
  actual_cost_usd numeric(14,6) check (actual_cost_usd is null or actual_cost_usd >= 0),
  status text not null check (status in ('reserved','submitted','unknown','succeeded','failed','cancelled','blocked')),
  reason_code text,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists ugc_provider_spend_request_idx
  on saas_ugc.ugc_provider_spend(provider, provider_request_id)
  where provider_request_id is not null;
create index if not exists ugc_provider_spend_history_idx
  on saas_ugc.ugc_provider_spend(created_at desc);

alter table saas_ugc.ugc_provider_spend enable row level security;
revoke all on saas_ugc.ugc_provider_spend from public, anon, authenticated;
grant select, insert, update on saas_ugc.ugc_provider_spend to service_role;

create or replace function ugc_private.reelora_sync_provider_spend_job_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('succeeded','failed','cancelled') and old.status is distinct from new.status then
    update saas_ugc.ugc_provider_spend
       set status = case new.status
         when 'succeeded' then 'succeeded'
         when 'cancelled' then 'cancelled'
         else 'failed'
       end,
       released_at = case
         when status = 'reserved' and new.provider_job_id is null then coalesce(released_at, now())
         else released_at
       end,
       completed_at = coalesce(completed_at, now()),
       updated_at = now()
     where generation_job_id = new.id
       and status in ('reserved','submitted','unknown')
       and completed_at is null;
  end if;
  return new;
end $$;

drop trigger if exists reelora_provider_spend_job_status on saas_ugc.ugc_generation_jobs;
create trigger reelora_provider_spend_job_status
after update of status on saas_ugc.ugc_generation_jobs
for each row execute function ugc_private.reelora_sync_provider_spend_job_status();

create or replace function public.reelora_admin_set_provider_spend_cap(
  p_max_usd numeric,
  p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if p_max_usd is null or p_max_usd < 0 or p_max_usd > 1000000 then
    raise exception 'invalid_provider_spend_cap';
  end if;

  select setting_value into v_old
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap'
   for update;
  v_new := jsonb_build_object(
    'enabled', coalesce(p_enabled, false) and p_max_usd > 0,
    'max_usd', p_max_usd
  );
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
  values ('provider_spend_cap', v_new, 'Plafond interne de dépenses fournisseur pour les générations vidéo')
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value, updated_at = now();

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    (select auth.uid()), 'set_provider_spend_cap', 'setting', 'provider_spend_cap',
    jsonb_build_object('previous', coalesce(v_old, '{}'::jsonb), 'new', v_new)
  );
  return true;
end $$;

create or replace function public.reelora_admin_provider_spend_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_config jsonb;
  v_max numeric := 0;
  v_enabled boolean := false;
  v_actual numeric := 0;
  v_reserved numeric := 0;
  v_estimated_terminal numeric := 0;
  v_committed numeric := 0;
begin
  perform ugc_private.reelora_assert_admin();
  select setting_value into v_config
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap';
  v_max := greatest(coalesce((v_config->>'max_usd')::numeric, 0), 0);
  v_enabled := coalesce((v_config->>'enabled')::boolean, false) and v_max > 0;

  select
    coalesce(sum(actual_cost_usd), 0),
    coalesce(sum(reserved_cost_usd) filter (
      where released_at is null and status in ('reserved','submitted','unknown')
    ), 0),
    coalesce(sum(coalesce(actual_cost_usd, estimated_cost_usd)) filter (
      where released_at is null and status in ('succeeded','failed','cancelled') and actual_cost_usd is null
    ), 0),
    coalesce(sum(case
      when released_at is not null or status = 'blocked' then 0
      when status in ('reserved','submitted','unknown') then reserved_cost_usd
      else coalesce(actual_cost_usd, estimated_cost_usd, 0)
    end), 0)
    into v_actual, v_reserved, v_estimated_terminal, v_committed
    from saas_ugc.ugc_provider_spend;

  return jsonb_build_object(
    'enabled', v_enabled,
    'max_usd', v_max,
    'actual_spent_usd', v_actual,
    'reserved_usd', v_reserved,
    'estimated_unpriced_usd', v_estimated_terminal,
    'committed_usd', v_committed,
    'remaining_usd', greatest(v_max - v_committed, 0),
    'tests_count', (select count(*) from saas_ugc.ugc_provider_spend where status <> 'blocked'),
    'blocked_count', (select count(*) from saas_ugc.ugc_provider_spend where status = 'blocked'),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'generation_job_id', s.generation_job_id,
        'provider', s.provider,
        'model_id', s.model_id,
        'provider_request_id', s.provider_request_id,
        'estimated_cost_usd', s.estimated_cost_usd,
        'actual_cost_usd', s.actual_cost_usd,
        'status', s.status,
        'reason_code', s.reason_code,
        'created_at', s.created_at,
        'completed_at', s.completed_at
      ) order by s.created_at desc)
      from (
        select * from saas_ugc.ugc_provider_spend order by created_at desc limit 100
      ) s
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.reelora_reserve_provider_spend(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job saas_ugc.ugc_generation_jobs%rowtype;
  v_quote saas_ugc.ugc_video_quotes%rowtype;
  v_existing saas_ugc.ugc_provider_spend%rowtype;
  v_config jsonb;
  v_enabled boolean := false;
  v_max numeric := 0;
  v_committed numeric := 0;
  v_remaining numeric := 0;
  v_reason text;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_job
    from saas_ugc.ugc_generation_jobs
   where id = p_job_id
   for update;
  if not found or v_job.pricing_quote_id is null then raise exception 'provider_spend_job_invalid'; end if;
  select * into v_quote from saas_ugc.ugc_video_quotes
   where id = v_job.pricing_quote_id
     and user_id = v_job.created_by
     and service_key = v_job.service_key
     and public_model_id::text = v_job.request_payload->>'model_id';
  if not found or v_quote.provider_cost_usd is null or v_quote.provider_cost_usd <= 0 then
    raise exception 'provider_spend_estimate_missing';
  end if;

  select * into v_existing from saas_ugc.ugc_provider_spend
   where generation_job_id = p_job_id
   for update;
  if found then
    return jsonb_build_object('allowed', false, 'reason', 'provider_spend_already_reserved');
  end if;

  select setting_value into v_config
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap'
   for update;
  v_max := greatest(coalesce((v_config->>'max_usd')::numeric, 0), 0);
  v_enabled := coalesce((v_config->>'enabled')::boolean, false) and v_max > 0;

  select coalesce(sum(case
    when released_at is not null or status = 'blocked' then 0
    when status in ('reserved','submitted','unknown') then reserved_cost_usd
    else coalesce(actual_cost_usd, estimated_cost_usd, 0)
  end), 0)
    into v_committed
    from saas_ugc.ugc_provider_spend;
  v_remaining := greatest(v_max - v_committed, 0);

  if not v_enabled then v_reason := 'provider_spend_disabled';
  elsif v_quote.provider_cost_usd > v_remaining then v_reason := 'provider_spend_cap_exceeded';
  end if;

  if v_reason is not null then
    insert into saas_ugc.ugc_provider_spend(
      generation_job_id, quote_id, model_id, estimated_cost_usd, status, reason_code, completed_at
    ) values (
      p_job_id, v_quote.id, v_quote.model_id, v_quote.provider_cost_usd, 'blocked', v_reason, now()
    );
    return jsonb_build_object(
      'allowed', false, 'reason', v_reason, 'max_usd', v_max,
      'committed_usd', v_committed, 'remaining_usd', v_remaining,
      'estimated_cost_usd', v_quote.provider_cost_usd
    );
  end if;

  insert into saas_ugc.ugc_provider_spend(
    generation_job_id, quote_id, model_id, estimated_cost_usd, reserved_cost_usd, status
  ) values (
    p_job_id, v_quote.id, v_quote.model_id, v_quote.provider_cost_usd, v_quote.provider_cost_usd, 'reserved'
  );
  return jsonb_build_object(
    'allowed', true, 'max_usd', v_max, 'committed_usd', v_committed,
    'remaining_usd', v_remaining, 'estimated_cost_usd', v_quote.provider_cost_usd
  );
end $$;

create or replace function public.reelora_update_provider_spend(
  p_job_id uuid,
  p_status text,
  p_provider_request_id text default null,
  p_actual_cost_usd numeric default null,
  p_release boolean default false,
  p_reason_code text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_spend saas_ugc.ugc_provider_spend%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_status not in ('submitted','unknown','succeeded','failed','cancelled')
     or (p_actual_cost_usd is not null and p_actual_cost_usd < 0)
     or (p_release and (p_status not in ('failed','cancelled') or p_provider_request_id is not null)) then
    raise exception 'invalid_provider_spend_update';
  end if;

  perform 1 from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap'
   for update;
  select * into v_spend from saas_ugc.ugc_provider_spend
   where generation_job_id = p_job_id
   for update;
  if not found then raise exception 'provider_spend_reservation_missing'; end if;
  if v_spend.status = 'blocked' then return false; end if;
  if v_spend.completed_at is not null then
    update saas_ugc.ugc_provider_spend
       set actual_cost_usd = coalesce(p_actual_cost_usd, actual_cost_usd),
           provider_request_id = coalesce(p_provider_request_id, provider_request_id),
           updated_at = now()
     where id = v_spend.id;
    return true;
  end if;

  update saas_ugc.ugc_provider_spend
     set status = p_status,
         provider_request_id = coalesce(p_provider_request_id, provider_request_id),
         actual_cost_usd = coalesce(p_actual_cost_usd, actual_cost_usd),
         reason_code = coalesce(nullif(p_reason_code, ''), reason_code),
         released_at = case when p_release then coalesce(released_at, now()) else released_at end,
         completed_at = case when p_status in ('succeeded','failed','cancelled') then coalesce(completed_at, now()) else completed_at end,
         updated_at = now()
   where id = v_spend.id;
  return true;
end $$;

revoke all on function public.reelora_admin_set_provider_spend_cap(numeric, boolean) from public, anon;
grant execute on function public.reelora_admin_set_provider_spend_cap(numeric, boolean) to authenticated;
revoke all on function public.reelora_admin_provider_spend_summary() from public, anon;
grant execute on function public.reelora_admin_provider_spend_summary() to authenticated;
revoke all on function public.reelora_reserve_provider_spend(uuid) from public, anon, authenticated;
grant execute on function public.reelora_reserve_provider_spend(uuid) to service_role;
revoke all on function public.reelora_update_provider_spend(uuid, text, text, numeric, boolean, text) from public, anon, authenticated;
grant execute on function public.reelora_update_provider_spend(uuid, text, text, numeric, boolean, text) to service_role;

notify pgrst, 'reload schema';
