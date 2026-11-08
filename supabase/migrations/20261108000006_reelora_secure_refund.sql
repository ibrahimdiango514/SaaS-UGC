-- Reelora v1 — close the quota-refund bypass.
-- The previous implementation was callable by any authenticated client and could
-- delete its own most recent usage event (quota bypass). Refunds are now strictly
-- service-role only, tied to a verified user id and to a failed generation job
-- for video refunds. Edge Functions call this with SUPABASE_SERVICE_ROLE_KEY.

drop function if exists public.reelora_refund_quota(text, uuid);

create or replace function public.reelora_refund_quota(
  p_kind text, p_reference_id uuid default null, p_user_id uuid default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  if p_user_id is null then raise exception 'invalid_user'; end if;
  if p_kind not in ('script','prompt','video','image','export') then
    raise exception 'invalid_quota_kind';
  end if;

  -- A video quota unit may only be given back when the job really failed/cancelled.
  if p_kind = 'video' then
    if p_reference_id is null then return false; end if;
    if not exists (
      select 1 from saas_ugc.ugc_generation_jobs j
       where j.id = p_reference_id and j.created_by = p_user_id
         and j.status in ('failed','cancelled')
    ) then return false; end if;
  end if;

  select e.id into v_id from saas_ugc.ugc_usage_events e
   where e.user_id = p_user_id and e.event_kind = p_kind
     and (p_reference_id is null or e.reference_id = p_reference_id)
     and e.created_at > now() - interval '15 minutes'
   order by e.created_at desc limit 1;
  if v_id is null then return false; end if;

  delete from saas_ugc.ugc_usage_events where id = v_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (p_user_id, 'refund_quota', 'usage_event', v_id::text,
          jsonb_build_object('kind', p_kind, 'reference_id', p_reference_id, 'source', 'edge_function'));
  return true;
end $$;

revoke all on function public.reelora_refund_quota(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.reelora_refund_quota(text, uuid, uuid) to service_role;

-- Belt and braces: no client may execute any service-only RPC.
revoke all on function public.reelora_set_job_processing(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.reelora_set_job_processing(uuid, text, text, jsonb) to service_role;
revoke all on function public.reelora_finalize_generation(uuid, text, text, text, bigint, jsonb, text) from public, anon, authenticated;
grant execute on function public.reelora_finalize_generation(uuid, text, text, text, bigint, jsonb, text) to service_role;

notify pgrst, 'reload schema';
