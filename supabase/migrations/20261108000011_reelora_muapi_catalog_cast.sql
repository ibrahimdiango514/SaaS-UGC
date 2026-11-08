-- Reelora v1.1 — the live MuAPI catalog returns is_enabled as a NUMBER (1/0),
-- not a JSON boolean. Casting that jsonb value directly to boolean fails.
-- Normalise both numeric and boolean representations.

create or replace function public.reelora_sync_video_models(p_models jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare m jsonb; v_count integer := 0; v_enabled boolean; v_soon boolean;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  for m in select value from jsonb_array_elements(coalesce(p_models, '[]'::jsonb)) loop
    v_enabled := case m->>'is_enabled'
                   when '1' then true when 'true' then true
                   when '0' then false when 'false' then false
                   else null end;
    v_soon := case m->>'is_coming_soon'
                when '1' then true when 'true' then true
                when '0' then false when 'false' then false
                else null end;
    update saas_ugc.ugc_video_models
       set cost_usd = case when (m->>'cost') ~ '^[0-9]+(\.[0-9]+)?$'
                           then (m->>'cost')::numeric else cost_usd end,
           cost_currency = coalesce(nullif(m->>'cost_currency', ''), cost_currency),
           description = coalesce(nullif(m->>'description', ''), description),
           is_enabled = coalesce(v_enabled, is_enabled),
           is_coming_soon = coalesce(v_soon, is_coming_soon),
           synced_at = now(), updated_at = now()
     where model_id = m->>'name';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

revoke all on function public.reelora_sync_video_models(jsonb) from public, anon, authenticated;
grant execute on function public.reelora_sync_video_models(jsonb) to service_role;

notify pgrst, 'reload schema';
