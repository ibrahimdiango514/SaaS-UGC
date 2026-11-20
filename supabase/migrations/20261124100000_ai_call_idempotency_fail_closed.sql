-- Replace the legacy claim: the first INSERT must claim the operation, and
-- neither terminal nor expired leases are automatically replayed. An expired
-- lease can represent a provider request whose outcome is still unknown.
-- This additive migration changes request-key semantics only; no rows modified.
create or replace function public.vyora_ai_claim_call(
  p_request_key text, p_space text, p_user_id uuid default null, p_workspace_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row saas_business.ai_call_leases%rowtype;
  v_claimed boolean := false;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if length(coalesce(p_request_key,'')) not between 1 and 200 then raise exception 'invalid request key'; end if;
  insert into saas_business.ai_call_leases(request_key,space,user_id,workspace_id,status)
    values(p_request_key,coalesce(p_space,'system'),p_user_id,p_workspace_id,'in_flight')
    on conflict(request_key) do nothing returning * into v_row;
  if found then
    v_claimed := true;
  else
    select * into strict v_row from saas_business.ai_call_leases where request_key=p_request_key;
  end if;
  return jsonb_build_object('claimed',v_claimed,'status',v_row.status,
    'provider_key',v_row.provider_key,'model_key',v_row.model_key,'outcome_code',v_row.outcome_code);
end $$;
revoke all on function public.vyora_ai_claim_call(text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.vyora_ai_claim_call(text,text,uuid,uuid) to service_role;
