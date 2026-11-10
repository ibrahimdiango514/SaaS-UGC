-- Reelora Central AI Engine & Business Grow — Server-side RPCs
-- Strictly enforces:
-- 1. Zero interaction with Studio UGC credits (`saas_ugc.ugc_wallets` / `ugc_usage_events`).
-- 2. Strict user_id + workspace_id isolation.
-- 3. Service-role-only financial mutations (`reserve`, `capture`, `release`) & verification updates.

-- Ensure an isolated Business Grow credit wallet for the authenticated user & workspace.
create or replace function public.reelora_bg_ensure_wallet(p_workspace_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
  v_wallet saas_ugc.bg_wallets%rowtype;
begin
  perform ugc_private.reelora_assert_active();
  v_ws := coalesce(p_workspace_id, saas_ugc.ugc_ensure_my_workspace());
  if not ugc_private.is_workspace_member(v_ws) then
    raise exception 'forbidden';
  end if;

  insert into saas_ugc.bg_wallets (user_id, workspace_id, available_credits, monthly_allowance, period_key)
  values (v_uid, v_ws, 50, 50, v_period)
  on conflict (user_id, workspace_id) do nothing;

  select * into v_wallet
  from saas_ugc.bg_wallets
  where user_id = v_uid and workspace_id = v_ws
  for update;

  if v_wallet.period_key <> v_period then
    update saas_ugc.bg_wallets
    set period_key = v_period,
        period_used = 0,
        available_credits = greatest(available_credits, monthly_allowance),
        updated_at = now()
    where id = v_wallet.id
    returning * into v_wallet;

    insert into saas_ugc.bg_credit_ledger (
      wallet_id, user_id, workspace_id, operation_type, available_delta, reserved_delta,
      idempotency_key, description
    ) values (
      v_wallet.id, v_uid, v_ws, 'monthly_allowance', v_wallet.monthly_allowance, 0,
      'bg-monthly:' || v_wallet.id::text || ':' || v_period,
      'Renouvellement mensuel Business Grow'
    ) on conflict (idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'wallet_id', v_wallet.id,
    'workspace_id', v_ws,
    'credit_domain', 'business_grow',
    'studio_ugc_credits_untouched', true,
    'available_credits', v_wallet.available_credits,
    'reserved_credits', v_wallet.reserved_credits,
    'monthly_allowance', v_wallet.monthly_allowance,
    'period_key', v_wallet.period_key,
    'period_used', v_wallet.period_used,
    'lifetime_consumed', v_wallet.lifetime_consumed
  );
end $$;

create or replace function public.reelora_bg_quota_status(p_workspace_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.reelora_bg_ensure_wallet(p_workspace_id);
end $$;

-- Service-role only: atomically reserve Business Grow credits before calling AI providers.
create or replace function public.reelora_bg_reserve_credits(
  p_user_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_credits bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
  v_wallet saas_ugc.bg_wallets%rowtype;
  v_existing saas_ugc.bg_credit_ledger%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_credits < 0 then
    raise exception 'invalid_credits_amount';
  end if;

  select * into v_existing from saas_ugc.bg_credit_ledger where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('ok', true, 'idempotent', true, 'reserved', p_credits);
  end if;

  insert into saas_ugc.bg_wallets (user_id, workspace_id, available_credits, monthly_allowance, period_key)
  values (p_user_id, p_workspace_id, 50, 50, v_period)
  on conflict (user_id, workspace_id) do nothing;

  select * into v_wallet
  from saas_ugc.bg_wallets
  where user_id = p_user_id and workspace_id = p_workspace_id
  for update;

  if v_wallet.period_key <> v_period then
    update saas_ugc.bg_wallets
    set period_key = v_period,
        period_used = 0,
        available_credits = greatest(available_credits, monthly_allowance),
        updated_at = now()
    where id = v_wallet.id
    returning * into v_wallet;
  end if;

  if v_wallet.available_credits < p_credits then
    raise exception 'bg_insufficient_credits';
  end if;

  update saas_ugc.bg_wallets
  set available_credits = available_credits - p_credits,
      reserved_credits = reserved_credits + p_credits,
      updated_at = now()
  where id = v_wallet.id
  returning * into v_wallet;

  insert into saas_ugc.bg_credit_ledger (
    wallet_id, user_id, workspace_id, operation_type, available_delta, reserved_delta,
    request_id, idempotency_key, description
  ) values (
    v_wallet.id, p_user_id, p_workspace_id, 'reserve', -p_credits, p_credits,
    p_request_id, p_idempotency_key, 'Réservation requête Business Grow IA'
  );

  return jsonb_build_object(
    'ok', true,
    'available_credits', v_wallet.available_credits,
    'reserved_credits', v_wallet.reserved_credits
  );
end $$;

-- Service-role only: capture final actual credits and refund any difference if a cheaper fallback was used.
create or replace function public.reelora_bg_capture_credits(
  p_user_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_reserved bigint,
  p_charged bigint,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet saas_ugc.bg_wallets%rowtype;
  v_refund bigint;
  v_charged bigint := least(greatest(p_charged, 0), greatest(p_reserved, 0));
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if exists (select 1 from saas_ugc.bg_credit_ledger where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'idempotent', true, 'charged', v_charged);
  end if;

  select * into v_wallet
  from saas_ugc.bg_wallets
  where user_id = p_user_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'bg_wallet_not_found';
  end if;

  v_refund := greatest(0, p_reserved - v_charged);

  update saas_ugc.bg_wallets
  set reserved_credits = greatest(0, reserved_credits - p_reserved),
      available_credits = available_credits + v_refund,
      period_used = period_used + v_charged,
      lifetime_consumed = lifetime_consumed + v_charged,
      updated_at = now()
  where id = v_wallet.id
  returning * into v_wallet;

  insert into saas_ugc.bg_credit_ledger (
    wallet_id, user_id, workspace_id, operation_type, available_delta, reserved_delta,
    request_id, idempotency_key, description
  ) values (
    v_wallet.id, p_user_id, p_workspace_id, 'capture', v_refund, -p_reserved,
    p_request_id, p_idempotency_key, 'Consommation Business Grow IA confirmée'
  );

  return jsonb_build_object(
    'ok', true,
    'charged', v_charged,
    'refunded_difference', v_refund,
    'available_credits', v_wallet.available_credits
  );
end $$;

-- Service-role only: release full reserved Business Grow credits when all providers fail.
create or replace function public.reelora_bg_release_credits(
  p_user_id uuid,
  p_workspace_id uuid,
  p_request_id uuid,
  p_reserved bigint,
  p_idempotency_key text,
  p_reason text default 'provider_failure'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet saas_ugc.bg_wallets%rowtype;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  if exists (select 1 from saas_ugc.bg_credit_ledger where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('ok', true, 'idempotent', true, 'released', p_reserved);
  end if;

  select * into v_wallet
  from saas_ugc.bg_wallets
  where user_id = p_user_id and workspace_id = p_workspace_id
  for update;

  if not found then
    return jsonb_build_object('ok', true, 'released', 0);
  end if;

  update saas_ugc.bg_wallets
  set reserved_credits = greatest(0, reserved_credits - p_reserved),
      available_credits = available_credits + p_reserved,
      updated_at = now()
  where id = v_wallet.id
  returning * into v_wallet;

  insert into saas_ugc.bg_credit_ledger (
    wallet_id, user_id, workspace_id, operation_type, available_delta, reserved_delta,
    request_id, idempotency_key, description, metadata
  ) values (
    v_wallet.id, p_user_id, p_workspace_id, 'release', p_reserved, -p_reserved,
    p_request_id, p_idempotency_key, 'Restitution automatique Business Grow IA',
    jsonb_build_object('reason', coalesce(p_reason, 'provider_failure'))
  );

  return jsonb_build_object(
    'ok', true,
    'released', p_reserved,
    'available_credits', v_wallet.available_credits
  );
end $$;

-- Service-role only: updates provider verification state after an authentic live call.
create or replace function public.reelora_ai_set_provider_verification(
  p_provider_key text,
  p_status text,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_status not in ('unconfigured', 'configured_unverified', 'connected', 'error') then
    raise exception 'invalid_verification_status';
  end if;
  update saas_ugc.ai_providers
  set verification_status = p_status,
      last_verified_at = case when p_status = 'connected' then now() else last_verified_at end,
      last_error_code = p_error_code,
      updated_at = now()
  where provider_key = p_provider_key;
end $$;

-- Authenticated: upsert structured business memory with explicit consent & isolation checks.
create or replace function public.reelora_bg_upsert_memory(
  p_business_profile_id uuid,
  p_category text,
  p_memory_key text,
  p_summary text,
  p_structured_data jsonb default '{}'::jsonb,
  p_source_type text default 'explicit_user',
  p_confidence numeric default 0.95,
  p_pinned boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_prof saas_ugc.bg_business_profiles%rowtype;
  v_id uuid;
begin
  perform ugc_private.reelora_assert_active();
  select * into v_prof
  from saas_ugc.bg_business_profiles
  where id = p_business_profile_id;

  if not found or v_prof.user_id <> v_uid or not ugc_private.can_edit_workspace(v_prof.workspace_id) then
    raise exception 'forbidden';
  end if;

  if not v_prof.ai_memory_consent then
    raise exception 'business_memory_consent_required';
  end if;

  insert into saas_ugc.bg_business_memories (
    workspace_id, user_id, business_profile_id, category, memory_key, summary,
    structured_data, confidence, source_type, pinned, active, last_accessed_at
  ) values (
    v_prof.workspace_id, v_uid, p_business_profile_id, p_category, btrim(p_memory_key), btrim(p_summary),
    coalesce(p_structured_data, '{}'::jsonb), least(greatest(p_confidence, 0), 1), p_source_type, p_pinned, true, now()
  )
  on conflict (business_profile_id, category, memory_key) do update set
    summary = excluded.summary,
    structured_data = excluded.structured_data,
    confidence = excluded.confidence,
    source_type = excluded.source_type,
    pinned = excluded.pinned,
    active = true,
    last_accessed_at = now(),
    updated_at = now()
  returning id into v_id;

  return v_id;
end $$;

-- Authenticated: approve or reject a pending Business Grow AI tool proposal.
create or replace function public.reelora_bg_resolve_tool_execution(
  p_execution_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_exec saas_ugc.bg_tool_executions%rowtype;
begin
  perform ugc_private.reelora_assert_active();
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid_decision';
  end if;

  select * into v_exec
  from saas_ugc.bg_tool_executions
  where id = p_execution_id
  for update;

  if not found or v_exec.user_id <> v_uid or not ugc_private.can_edit_workspace(v_exec.workspace_id) then
    raise exception 'forbidden';
  end if;

  if v_exec.status <> 'pending_approval' then
    raise exception 'tool_already_resolved';
  end if;

  update saas_ugc.bg_tool_executions
  set status = p_decision,
      approved_by = v_uid,
      approved_at = now()
  where id = p_execution_id
  returning * into v_exec;

  return jsonb_build_object(
    'id', v_exec.id,
    'status', v_exec.status,
    'tool_name', v_exec.tool_name,
    'approved_at', v_exec.approved_at
  );
end $$;

-- Grants: strictly isolate service-role RPCs vs authenticated user RPCs
revoke all on function public.reelora_bg_reserve_credits(uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.reelora_bg_capture_credits(uuid, uuid, uuid, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.reelora_bg_release_credits(uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.reelora_ai_set_provider_verification(text, text, text) from public, anon, authenticated;

grant execute on function public.reelora_bg_reserve_credits(uuid, uuid, uuid, bigint, text) to service_role;
grant execute on function public.reelora_bg_capture_credits(uuid, uuid, uuid, bigint, bigint, text) to service_role;
grant execute on function public.reelora_bg_release_credits(uuid, uuid, uuid, bigint, text, text) to service_role;
grant execute on function public.reelora_ai_set_provider_verification(text, text, text) to service_role;

grant execute on function public.reelora_bg_ensure_wallet(uuid) to authenticated;
grant execute on function public.reelora_bg_quota_status(uuid) to authenticated;
grant execute on function public.reelora_bg_upsert_memory(uuid, text, text, text, jsonb, text, numeric, boolean) to authenticated;
grant execute on function public.reelora_bg_resolve_tool_execution(uuid, text) to authenticated;

notify pgrst, 'reload schema';
