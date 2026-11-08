-- Allows the server-side functions to give back a monthly quota unit when an
-- external provider call fails (clients cannot write usage_events directly).
create or replace function public.reelora_refund_quota(p_kind text, p_reference_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('script','prompt','video','image','export') then raise exception 'invalid_quota_kind'; end if;
  select e.id into v_id from saas_ugc.ugc_usage_events e
   where e.user_id = (select auth.uid()) and e.event_kind = p_kind
     and (p_reference_id is null or e.reference_id = p_reference_id)
   order by e.created_at desc limit 1;
  if v_id is null then return false; end if;
  delete from saas_ugc.ugc_usage_events where id = v_id;
  return true;
end $$;

revoke all on function public.reelora_refund_quota(text, uuid) from public, anon;
grant execute on function public.reelora_refund_quota(text, uuid) to authenticated, service_role;
notify pgrst, 'reload schema';
