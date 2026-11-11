-- Keep the confirmed first-admin bootstrap as the only way to create an owner admin.
create unique index if not exists ugc_user_roles_single_admin_idx
  on saas_ugc.ugc_user_roles(role)
  where role = 'admin';

create or replace function public.reelora_admin_set_role(p_user_id uuid, p_role text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_role = 'admin' then raise exception 'admin_role_bootstrap_only'; end if;
  if p_role <> 'user' then raise exception 'invalid_role'; end if;
  if exists (
    select 1 from saas_ugc.ugc_user_roles
     where user_id = p_user_id and role = 'admin'
  ) then
    raise exception 'owner_admin_role_immutable';
  end if;

  delete from saas_ugc.ugc_user_roles where user_id = p_user_id;
  insert into saas_ugc.ugc_user_roles(user_id, role) values (p_user_id, 'user');
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_role', 'user', p_user_id::text, jsonb_build_object('role', 'user'));
  return true;
end $$;

create or replace function public.reelora_admin_set_setting(p_key text, p_value jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_key in ('video_pricing_config', 'provider_spend_cap') then
    raise exception 'use_dedicated_admin_settings_rpc';
  end if;
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value)
  values (p_key, coalesce(p_value, '{}'::jsonb))
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value, updated_at = now();
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_setting', 'setting', p_key, jsonb_build_object('value', p_value));
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
    'by_provider', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', s.provider,
        'actual_spent_usd', s.actual_spent_usd,
        'reserved_usd', s.reserved_usd,
        'committed_usd', s.committed_usd
      ) order by s.provider)
      from (
        select
          provider,
          coalesce(sum(actual_cost_usd), 0) as actual_spent_usd,
          coalesce(sum(reserved_cost_usd) filter (
            where released_at is null and status in ('reserved','submitted','unknown')
          ), 0) as reserved_usd,
          coalesce(sum(case
            when released_at is not null or status = 'blocked' then 0
            when status in ('reserved','submitted','unknown') then reserved_cost_usd
            else coalesce(actual_cost_usd, estimated_cost_usd, 0)
          end), 0) as committed_usd
        from saas_ugc.ugc_provider_spend
        group by provider
      ) s
    ), '[]'::jsonb),
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

revoke all on function public.reelora_admin_set_role(uuid, text) from public, anon;
grant execute on function public.reelora_admin_set_role(uuid, text) to authenticated, service_role;
revoke all on function public.reelora_admin_set_setting(text, jsonb) from public, anon;
grant execute on function public.reelora_admin_set_setting(text, jsonb) to authenticated, service_role;
revoke all on function public.reelora_admin_provider_spend_summary() from public, anon;
grant execute on function public.reelora_admin_provider_spend_summary() to authenticated, service_role;

notify pgrst, 'reload schema';
