-- Reelora v1 — secure compatibility RPC for the deployed video worker.
-- reelora-ai (v2) uses the service-role reelora_refund_quota(text, uuid, uuid).
-- reelora-video (v1) still calls the two-argument form with the caller's JWT.
-- This compatibility function is NOT a general refund: it only gives back a video
-- quota unit for a job that genuinely failed or was cancelled and belongs to the
-- caller. Script/prompt refunds are impossible through this entry point.

create or replace function public.reelora_refund_quota(p_kind text, p_reference_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_kind <> 'video' then return false; end if;
  if p_reference_id is null then return false; end if;
  if not exists (
    select 1 from saas_ugc.ugc_generation_jobs j
     where j.id = p_reference_id and j.created_by = v_uid
       and j.status in ('failed', 'cancelled')
  ) then return false; end if;

  select e.id into v_id from saas_ugc.ugc_usage_events e
   where e.user_id = v_uid and e.event_kind = 'video' and e.reference_id = p_reference_id
     and e.created_at > now() - interval '45 minutes'
   order by e.created_at desc limit 1;
  if v_id is null then return false; end if;

  delete from saas_ugc.ugc_usage_events where id = v_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (v_uid, 'refund_quota', 'usage_event', v_id::text,
          jsonb_build_object('kind', 'video', 'reference_id', p_reference_id, 'source', 'reelora-video'));
  return true;
end $$;

revoke all on function public.reelora_refund_quota(text, uuid) from public, anon;
grant execute on function public.reelora_refund_quota(text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
