-- Reelora v1.1 — expose the live MuAPI provider state in the existing public
-- `result_payload` column. The legacy public view ugc_generation_jobs has an
-- explicit column list (created before the new tracking columns), so mirroring
-- the state into result_payload keeps the Studio/History progress readable
-- WITHOUT altering any existing view, table, policy or business rule.

create or replace function public.reelora_record_video_poll(
  p_job_id uuid, p_provider_status text, p_next_poll_seconds integer default 30,
  p_cost jsonb default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then raise exception 'forbidden'; end if;
  update saas_ugc.ugc_generation_jobs
     set provider_status = p_provider_status, last_polled_at = now(), last_heartbeat_at = now(),
         next_poll_at = now() + (least(greatest(coalesce(p_next_poll_seconds, 30), 5), 300) || ' seconds')::interval,
         muapi_cost = coalesce(p_cost, muapi_cost),
         result_payload = case
           when status = 'processing' then jsonb_set(
             coalesce(result_payload, '{}'::jsonb), '{provider_status}',
             to_jsonb(coalesce(p_provider_status, 'processing')), true)
           else result_payload end,
         updated_at = now()
   where id = p_job_id and status = 'processing';
  return found;
end $$;

revoke all on function public.reelora_record_video_poll(uuid, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.reelora_record_video_poll(uuid, text, integer, jsonb) to service_role;

notify pgrst, 'reload schema';
