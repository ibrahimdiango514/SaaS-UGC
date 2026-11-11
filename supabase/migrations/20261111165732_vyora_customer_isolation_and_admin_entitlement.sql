create table if not exists saas_ugc.ugc_customer_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table saas_ugc.ugc_customer_accounts enable row level security;
revoke all on table saas_ugc.ugc_customer_accounts from public, anon, authenticated;
grant all on table saas_ugc.ugc_customer_accounts to service_role;

create or replace function ugc_private.on_auth_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bonus bigint := 0;
  v_enabled boolean := false;
  v_name text;
begin
  if new.raw_user_meta_data->>'app_scope' is distinct from 'vyora' then
    return new;
  end if;

  v_name := coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name');
  insert into saas_ugc.ugc_customer_accounts(user_id) values (new.id)
  on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_profiles(user_id, display_name) values (new.id, v_name)
  on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_wallets(user_id) values (new.id)
  on conflict (user_id) do nothing;

  select coalesce((setting_value->>'credits')::bigint, 0),
         coalesce((setting_value->>'enabled')::boolean, false)
    into v_bonus, v_enabled
    from saas_ugc.ugc_app_settings
   where setting_key = 'signup_bonus';

  if coalesce(v_enabled, false) and coalesce(v_bonus, 0) > 0 then
    perform ugc_private.apply_wallet_delta(
      new.id, 'signup_bonus', v_bonus, 0,
      'signup_bonus:' || new.id::text,
      'Crédits offerts à l’inscription',
      jsonb_build_object('source', 'auth_signup', 'app_scope', 'vyora')
    );
  end if;
  return new;
end;
$$;

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $$
declare
  v_must_change boolean := false;
begin
  if new.raw_user_meta_data->>'app_scope' in ('vyora', 'vyora_owner') then
    return new;
  end if;

  begin
    if jsonb_typeof(new.raw_user_meta_data -> 'must_change_password') = 'boolean' then
      v_must_change := (new.raw_user_meta_data ->> 'must_change_password')::boolean;
    end if;
  exception when others then
    v_must_change := false;
  end;

  insert into saas_immobilier.user_profiles (
    id, email, full_name, phone, avatar_url, role, must_change_password
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.phone, new.raw_user_meta_data ->> 'phone'),
    new.raw_user_meta_data ->> 'avatar_url',
    'agency',
    v_must_change
  )
  on conflict (id) do update
  set email = coalesce(excluded.email, saas_immobilier.user_profiles.email),
      full_name = coalesce(excluded.full_name, saas_immobilier.user_profiles.full_name),
      phone = coalesce(excluded.phone, saas_immobilier.user_profiles.phone),
      avatar_url = coalesce(excluded.avatar_url, saas_immobilier.user_profiles.avatar_url),
      must_change_password = saas_immobilier.user_profiles.must_change_password or excluded.must_change_password,
      updated_at = now();

  return new;
end;
$$;

create or replace function ugc_private.reelora_assert_vyora_customer()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if saas_ugc.ugc_is_admin() then raise exception 'admin_not_customer'; end if;
  if not exists (
    select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = v_uid
  ) then
    raise exception 'not_vyora_customer';
  end if;
end;
$$;

revoke all on function ugc_private.reelora_assert_vyora_customer() from public, anon, authenticated;

create or replace function ugc_private.reelora_assert_active()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_vyora_customer();
  if exists (
    select 1 from saas_ugc.ugc_subscriptions s
    where s.user_id = (select auth.uid()) and s.status <> 'active'
  ) then
    raise exception 'account_not_active';
  end if;
end;
$$;

create or replace function public.reelora_bootstrap()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_plan text;
  v_credits bigint;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  if saas_ugc.ugc_is_admin() then
    return jsonb_build_object(
      'user_id', v_uid,
      'workspace_id', null,
      'plan', null,
      'credits', 0,
      'is_admin', true
    );
  end if;

  perform ugc_private.reelora_assert_vyora_customer();
  insert into saas_ugc.ugc_profiles(user_id) values (v_uid) on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_wallets(user_id) values (v_uid) on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_subscriptions(user_id, plan_key) values (v_uid, 'free') on conflict (user_id) do nothing;
  insert into saas_ugc.ugc_user_roles(user_id, role) values (v_uid, 'user') on conflict (user_id, role) do nothing;

  v_ws := saas_ugc.ugc_ensure_my_workspace();
  if not exists (
    select 1 from saas_ugc.ugc_generation_presets p where p.workspace_id = v_ws
  ) then
    insert into saas_ugc.ugc_generation_presets(workspace_id, created_by, name, config, is_default)
    values (
      v_ws, v_uid, 'Réglages standard',
      '{"duration_seconds":15,"aspect_ratio":"9:16","style":"ugc_naturel","voice_speed":1,"captions":true,"resolution":"1080p"}'::jsonb,
      true
    );
  end if;

  select s.plan_key into v_plan from saas_ugc.ugc_subscriptions s where s.user_id = v_uid;
  select w.available_balance into v_credits from saas_ugc.ugc_wallets w where w.user_id = v_uid;
  return jsonb_build_object(
    'user_id', v_uid, 'workspace_id', v_ws, 'plan', v_plan,
    'credits', coalesce(v_credits, 0), 'is_admin', false
  );
end;
$$;

create or replace function public.reelora_quota_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_plan saas_ugc.ugc_plans%rowtype;
  v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
begin
  perform ugc_private.reelora_assert_vyora_customer();
  select p.* into v_plan
    from saas_ugc.ugc_subscriptions s
    join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
   where s.user_id = v_uid;
  if not found then
    select * into v_plan from saas_ugc.ugc_plans where plan_key = 'free';
  end if;

  return jsonb_build_object(
    'plan', to_jsonb(v_plan),
    'status', coalesce((select s.status from saas_ugc.ugc_subscriptions s where s.user_id = v_uid), 'active'),
    'credits', coalesce((select w.available_balance from saas_ugc.ugc_wallets w where w.user_id = v_uid), 0),
    'period', v_period,
    'projects', (select count(*) from saas_ugc.ugc_video_projects p where p.created_by = v_uid and p.status <> 'archived'),
    'avatars', (select count(*) from saas_ugc.ugc_avatars a where a.created_by = v_uid and a.status = 'active'),
    'usage', coalesce((select jsonb_object_agg(u.event_kind, u.used) from (
      select e.event_kind, sum(e.quantity) as used from saas_ugc.ugc_usage_events e
      where e.user_id = v_uid and e.period_key = v_period group by e.event_kind
    ) u), '{}'::jsonb),
    'period_end', coalesce((select s.current_period_end from saas_ugc.ugc_subscriptions s where s.user_id = v_uid), now() + interval '1 month')
  );
end;
$$;

create or replace function public.ugc_create_recharge_order(
  p_amount_minor bigint,
  p_country_code character,
  p_provider text,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_pricing saas_ugc.ugc_country_pricing%rowtype;
  v_credits bigint;
  v_order_id uuid;
begin
  perform ugc_private.reelora_assert_vyora_customer();
  if p_amount_minor is null or p_amount_minor <= 0 or length(trim(p_provider)) = 0
     or length(trim(p_idempotency_key)) < 8 then
    raise exception 'Invalid recharge request';
  end if;

  select * into v_pricing from saas_ugc.ugc_country_pricing
  where country_code = upper(p_country_code) and active = true;
  if not found then raise exception 'Recharge pricing is not configured for this country'; end if;
  if p_amount_minor < v_pricing.min_amount_minor or p_amount_minor > v_pricing.max_amount_minor then
    raise exception 'Recharge amount outside configured limits';
  end if;

  select id into v_order_id from saas_ugc.ugc_recharge_orders
  where user_id = v_user and idempotency_key = p_idempotency_key;
  if v_order_id is not null then return v_order_id; end if;

  v_credits := floor((p_amount_minor::numeric * v_pricing.credits_per_1000_minor) / 1000)::bigint;
  if v_credits < 1 then raise exception 'Recharge amount grants less than one credit'; end if;

  insert into saas_ugc.ugc_recharge_orders(
    user_id, amount_minor, currency, country_code, credits_to_grant, provider, idempotency_key
  ) values (
    v_user, p_amount_minor, v_pricing.currency, upper(p_country_code), v_credits, p_provider, p_idempotency_key
  ) returning id into v_order_id;
  return v_order_id;
end;
$$;

create or replace function public.reelora_request_plan_change(p_plan_key text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_plan saas_ugc.ugc_plans%rowtype;
  v_count integer := 0;
begin
  perform ugc_private.reelora_assert_vyora_customer();
  select * into v_plan from saas_ugc.ugc_plans p
  where p.plan_key = p_plan_key and p.active = true;
  if not found then raise exception 'plan_not_found'; end if;

  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  select r.user_id, 'Demande de formule',
         'Un utilisateur demande la formule ' || v_plan.display_name || '.',
         'admin_request', '/admin'
    from saas_ugc.ugc_user_roles r where r.role = 'admin';
  get diagnostics v_count = row_count;

  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (
    v_uid, 'Demande envoyée',
    'Votre demande de passage à la formule ' || v_plan.display_name || ' a été transmise à l’administration.',
    'info', '/app/abonnement'
  );
  return v_count;
end;
$$;

create or replace function public.ugc_redeem_promo_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_promo saas_ugc.ugc_promo_codes%rowtype;
  v_count integer;
  v_ledger_id uuid;
begin
  perform ugc_private.reelora_assert_vyora_customer();
  select * into v_promo from saas_ugc.ugc_promo_codes
  where lower(code) = lower(trim(p_code)) and active = true
  for update;
  if not found then raise exception 'Code promotionnel invalide'; end if;
  if v_promo.starts_at is not null and now() < v_promo.starts_at then raise exception 'Code pas encore actif'; end if;
  if v_promo.expires_at is not null and now() > v_promo.expires_at then raise exception 'Code promotionnel expiré'; end if;

  select count(*) into v_count from saas_ugc.ugc_promo_redemptions where promo_code_id = v_promo.id;
  if v_promo.max_redemptions is not null and v_count >= v_promo.max_redemptions then
    raise exception 'Limite d’utilisation du code atteinte';
  end if;
  select count(*) into v_count from saas_ugc.ugc_promo_redemptions
  where promo_code_id = v_promo.id and user_id = v_user;
  if v_count >= v_promo.per_user_limit then raise exception 'Code déjà utilisé au maximum autorisé'; end if;

  insert into saas_ugc.ugc_promo_redemptions(promo_code_id, user_id, credits_granted)
  values (v_promo.id, v_user, v_promo.bonus_credits);
  v_ledger_id := ugc_private.apply_wallet_delta(
    v_user, 'promo_bonus', v_promo.bonus_credits, 0,
    'promo:' || v_promo.id::text || ':' || v_user::text,
    'Bonus du code promotionnel',
    jsonb_build_object('promo_code_id', v_promo.id)
  );
  return v_ledger_id;
end;
$$;

create or replace function public.ugc_reserve_credits(
  p_generation_job_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_job saas_ugc.ugc_generation_jobs%rowtype;
  v_service saas_ugc.ugc_service_catalog%rowtype;
  v_ledger_id uuid;
begin
  perform ugc_private.reelora_assert_active();
  if p_credits is null or p_credits <= 0 or length(trim(p_idempotency_key)) < 8 then
    raise exception 'Invalid reservation';
  end if;
  select * into v_job from saas_ugc.ugc_generation_jobs
  where id = p_generation_job_id and created_by = v_user for update;
  if not found then raise exception 'Generation job not found'; end if;

  if v_job.status = 'reserved' then
    if v_job.reservation_idempotency_key = p_idempotency_key then
      select id into v_ledger_id from saas_ugc.ugc_credit_ledger
      where user_id = v_user and idempotency_key = p_idempotency_key;
      return v_ledger_id;
    end if;
    raise exception 'Credits already reserved for this job';
  end if;
  if v_job.status <> 'queued' then raise exception 'Job cannot reserve credits in its current state'; end if;

  select * into v_service from saas_ugc.ugc_service_catalog
  where service_key = v_job.service_key and active = true;
  if not found then raise exception 'Service unavailable'; end if;
  if p_credits <> v_service.credits_cost then
    raise exception 'Reservation must match the configured service price';
  end if;

  v_ledger_id := ugc_private.apply_wallet_delta(
    v_user, 'reserve', -v_service.credits_cost, v_service.credits_cost,
    p_idempotency_key, 'Réservation pour génération',
    jsonb_build_object('service_key', v_job.service_key), null, v_job.id
  );
  update saas_ugc.ugc_generation_jobs
  set status = 'reserved', credits_reserved = v_service.credits_cost,
      reservation_idempotency_key = p_idempotency_key, updated_at = now()
  where id = v_job.id;
  insert into saas_ugc.ugc_job_events(generation_job_id, actor_user_id, event_type, from_status, to_status, payload)
  values (v_job.id, v_user, 'credits_reserved', 'queued', 'reserved',
          jsonb_build_object('credits', v_service.credits_cost));
  return v_ledger_id;
end;
$$;

create or replace function public.reelora_admin_list_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', u.id,
      'email', u.email,
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at,
      'display_name', p.display_name,
      'country_code', p.country_code,
      'preferred_language', p.preferred_language,
      'plan_key', s.plan_key,
      'subscription_status', s.status,
      'credits', coalesce(w.available_balance, 0),
      'roles', coalesce((select jsonb_agg(r.role) from saas_ugc.ugc_user_roles r where r.user_id = u.id), '[]'::jsonb),
      'projects', (select count(*) from saas_ugc.ugc_video_projects pr where pr.created_by = u.id),
      'videos', (select count(*) from saas_ugc.ugc_generation_jobs j where j.created_by = u.id and j.status = 'succeeded')
    ) order by u.created_at desc)
    from saas_ugc.ugc_customer_accounts a
    join auth.users u on u.id = a.user_id
    left join saas_ugc.ugc_user_roles admin_role on admin_role.user_id = u.id and admin_role.role = 'admin'
    left join saas_ugc.ugc_profiles p on p.user_id = u.id
    left join saas_ugc.ugc_subscriptions s on s.user_id = u.id
    left join saas_ugc.ugc_wallets w on w.user_id = u.id
    where admin_role.user_id is null
  ), '[]'::jsonb);
end;
$$;

create or replace function public.reelora_admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  return jsonb_build_object(
    'users', (select count(*) from saas_ugc.ugc_customer_accounts a
      where not exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = a.user_id and r.role = 'admin')),
    'projects', (select count(*) from saas_ugc.ugc_video_projects p
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p.created_by)),
    'jobs', (select count(*) from saas_ugc.ugc_generation_jobs j
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = j.created_by)),
    'jobs_succeeded', (select count(*) from saas_ugc.ugc_generation_jobs j
      where j.status = 'succeeded' and exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = j.created_by)),
    'jobs_failed', (select count(*) from saas_ugc.ugc_generation_jobs j
      where j.status = 'failed' and exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = j.created_by)),
    'credits_charged', (select coalesce(sum(j.credits_charged), 0) from saas_ugc.ugc_generation_jobs j
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = j.created_by)),
    'credits_available', (select coalesce(sum(w.available_balance), 0) from saas_ugc.ugc_wallets w
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = w.user_id)
        and not exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = w.user_id and r.role = 'admin')),
    'pending_recharges', (select count(*) from saas_ugc.ugc_recharge_orders r
      where r.status in ('pending', 'processing')
        and exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = r.user_id)),
    'assets', (select count(*) from saas_ugc.ugc_generated_assets g
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = g.created_by)),
    'jobs_by_status', coalesce((select jsonb_object_agg(s.status, s.n) from (
      select j.status, count(*) as n from saas_ugc.ugc_generation_jobs j
      where exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = j.created_by)
      group by j.status
    ) s), '{}'::jsonb),
    'usage_this_month', coalesce((select jsonb_object_agg(u.event_kind, u.n) from (
      select e.event_kind, sum(e.quantity) as n from saas_ugc.ugc_usage_events e
      where e.period_key = to_char((now() at time zone 'UTC'), 'YYYY-MM')
        and exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = e.user_id)
      group by e.event_kind
    ) u), '{}'::jsonb)
  );
end;
$$;

create or replace function public.reelora_admin_adjust_credits(
  p_user_id uuid,
  p_delta bigint,
  p_reason text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
begin
  perform ugc_private.reelora_assert_admin();
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;
  if p_delta is null or p_delta = 0 or p_delta < -100000 or p_delta > 100000 then
    raise exception 'invalid_delta';
  end if;

  perform ugc_private.apply_wallet_delta(
    p_user_id, 'admin_adjustment', p_delta, 0,
    'admin-adjustment:' || p_user_id::text || ':' || gen_random_uuid()::text,
    coalesce(p_reason, 'Ajustement administrateur'), '{}'::jsonb
  );
  select available_balance into v_balance from saas_ugc.ugc_wallets where user_id = p_user_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'adjust_credits', 'user', p_user_id::text, jsonb_build_object('delta', p_delta, 'reason', p_reason));
  return v_balance;
end;
$$;

create or replace function public.reelora_admin_set_plan(p_user_id uuid, p_plan_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;
  if not exists (select 1 from saas_ugc.ugc_plans where plan_key = p_plan_key) then
    raise exception 'plan_not_found';
  end if;

  insert into saas_ugc.ugc_subscriptions(user_id, plan_key, status, current_period_start, current_period_end)
  values (p_user_id, p_plan_key, 'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')
  on conflict (user_id) do update set
    plan_key = excluded.plan_key, status = 'active',
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end, updated_at = now();
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (p_user_id, 'Formule mise à jour', 'Votre formule a été modifiée par un administrateur.', 'success', '/app/abonnement');
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_plan', 'user', p_user_id::text, jsonb_build_object('plan_key', p_plan_key));
  return true;
end;
$$;

create or replace function public.reelora_admin_set_account_status(p_user_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;
  if p_status not in ('active', 'suspended', 'cancelled') then raise exception 'invalid_status'; end if;
  update saas_ugc.ugc_subscriptions
     set status = p_status, updated_at = now()
   where user_id = p_user_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_account_status', 'user', p_user_id::text, jsonb_build_object('status', p_status));
  return true;
end;
$$;

create or replace function public.reelora_admin_set_role(p_user_id uuid, p_role text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_role = 'admin' then raise exception 'admin_role_bootstrap_only'; end if;
  if p_role <> 'user' then raise exception 'invalid_role'; end if;
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'target_not_vyora_customer';
  end if;

  delete from saas_ugc.ugc_user_roles where user_id = p_user_id;
  insert into saas_ugc.ugc_user_roles(user_id, role) values (p_user_id, 'user');
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_role', 'user', p_user_id::text, jsonb_build_object('role', 'user'));
  return true;
end;
$$;

create or replace function public.ugc_confirm_recharge(
  p_order_id uuid,
  p_provider text,
  p_provider_event_id text,
  p_provider_reference text,
  p_amount_minor bigint,
  p_currency character,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_event_id uuid;
  v_ledger_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into v_order from saas_ugc.ugc_recharge_orders where id = p_order_id for update;
  if not found then raise exception 'Recharge order not found'; end if;
  if not exists (
    select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = v_order.user_id
  ) or exists (
    select 1 from saas_ugc.ugc_user_roles r where r.user_id = v_order.user_id and r.role = 'admin'
  ) then
    raise exception 'target_not_vyora_customer';
  end if;

  insert into saas_ugc.ugc_payment_events(provider, provider_event_id, recharge_order_id, event_type, payload)
  values (p_provider, p_provider_event_id, p_order_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    select id into v_ledger_id from saas_ugc.ugc_credit_ledger
    where recharge_order_id = p_order_id and operation_type = 'purchase';
    return v_ledger_id;
  end if;

  if v_order.provider <> p_provider or v_order.amount_minor <> p_amount_minor
     or v_order.currency <> upper(p_currency) then
    update saas_ugc.ugc_payment_events
    set processing_status = 'rejected', processed_at = now()
    where id = v_event_id;
    raise exception 'Payment verification mismatch';
  end if;
  if v_order.status = 'paid' then
    update saas_ugc.ugc_payment_events
    set processing_status = 'processed', processed_at = now()
    where id = v_event_id;
    select id into v_ledger_id from saas_ugc.ugc_credit_ledger
    where recharge_order_id = p_order_id and operation_type = 'purchase';
    return v_ledger_id;
  end if;
  if v_order.status not in ('pending', 'processing') then
    raise exception 'Recharge order is not payable';
  end if;

  update saas_ugc.ugc_recharge_orders
  set status = 'paid', provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now(), updated_at = now()
  where id = p_order_id;
  v_ledger_id := ugc_private.apply_wallet_delta(
    v_order.user_id, 'purchase', v_order.credits_to_grant, 0,
    'recharge:' || v_order.id::text, 'Recharge confirmée',
    jsonb_build_object('provider', p_provider, 'currency', v_order.currency, 'amount_minor', v_order.amount_minor),
    v_order.id, null
  );
  update saas_ugc.ugc_payment_events
  set processing_status = 'processed', processed_at = now()
  where id = v_event_id;
  return v_ledger_id;
end;
$$;

create or replace function public.reelora_admin_confirm_recharge(
  p_order_id uuid,
  p_provider_reference text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
begin
  perform ugc_private.reelora_assert_admin();
  select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if not exists (
    select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = v_order.user_id
  ) or exists (
    select 1 from saas_ugc.ugc_user_roles r where r.user_id = v_order.user_id and r.role = 'admin'
  ) then
    raise exception 'target_not_vyora_customer';
  end if;
  if v_order.status = 'paid' then return true; end if;
  if v_order.status not in ('pending', 'processing') then raise exception 'order_not_payable'; end if;

  perform ugc_private.apply_wallet_delta(
    v_order.user_id, 'purchase', v_order.credits_to_grant, 0,
    'recharge:' || v_order.id::text, 'Recharge validée par un administrateur',
    jsonb_build_object('provider', v_order.provider, 'amount_minor', v_order.amount_minor),
    v_order.id, null
  );
  update saas_ugc.ugc_recharge_orders
  set status = 'paid', provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now(), updated_at = now()
  where id = p_order_id;
  insert into saas_ugc.ugc_payment_events(
    provider, provider_event_id, recharge_order_id, event_type, processing_status, payload, processed_at
  ) values (
    v_order.provider, 'admin:' || v_order.id::text, p_order_id, 'payment_confirmed', 'processed',
    jsonb_build_object('validated_by', (select auth.uid())), now()
  ) on conflict (provider, provider_event_id) do nothing;
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (
    v_order.user_id, 'Recharge créditée',
    v_order.credits_to_grant::text || ' crédits ont été ajoutés à votre solde.',
    'success', '/app/abonnement'
  );
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    (select auth.uid()), 'confirm_recharge', 'recharge_order', p_order_id::text,
    jsonb_build_object('credits', v_order.credits_to_grant, 'amount_minor', v_order.amount_minor)
  );
  return true;
end;
$$;

do $$
declare
  v_admin record;
begin
  for v_admin in
    select w.user_id, w.available_balance, w.reserved_balance
      from saas_ugc.ugc_wallets w
     where exists (
       select 1 from saas_ugc.ugc_user_roles r
       where r.user_id = w.user_id and r.role = 'admin'
     )
     for update
  loop
    if v_admin.reserved_balance <> 0 then
      raise exception 'admin_has_reserved_credits:%', v_admin.user_id;
    end if;
    if v_admin.available_balance < 0 then
      raise exception 'admin_has_invalid_credit_balance:%', v_admin.user_id;
    end if;
    if v_admin.available_balance > 0 then
      perform ugc_private.apply_wallet_delta(
        v_admin.user_id,
        'admin_adjustment',
        -v_admin.available_balance,
        0,
        'admin-customer-exclusion:' || v_admin.user_id::text,
        'Suppression du solde client du compte administrateur',
        '{"reason":"administrator_is_not_a_customer"}'::jsonb
      );
    end if;
  end loop;

  update saas_ugc.ugc_subscriptions s
     set status = 'cancelled', updated_at = now()
   where s.status <> 'cancelled'
     and exists (
       select 1 from saas_ugc.ugc_user_roles r
       where r.user_id = s.user_id and r.role = 'admin'
     );
end;
$$;

notify pgrst, 'reload schema';
