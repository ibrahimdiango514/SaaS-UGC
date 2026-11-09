-- Reelora v1.1 — PostgREST-visible (public schema) wrappers for the MuAPI worker.
-- PostgREST only exposes the `public` schema on this project, so helper RPCs that
-- live in ugc_private need a locked-down public entry point.
-- Both functions are service-role only and never return a provider API key.

create or replace function public.reelora_worker_token()
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_token text;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  select decrypted_secret into v_token from vault.decrypted_secrets
   where name = 'reelora_worker_token';
  return v_token;
end $$;

-- Refresh ONLY descriptive catalog metadata from the live MuAPI GET /api/v1/models
-- response. Endpoints, input fields and parameter schemas stay curated: the live
-- catalog can never introduce an unverified endpoint into Reelora.
create or replace function public.reelora_sync_video_models(p_models jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare m jsonb; v_count integer := 0;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  for m in select value from jsonb_array_elements(coalesce(p_models, '[]'::jsonb)) loop
    update saas_ugc.ugc_video_models
       set cost_usd = case when (m->>'cost') ~ '^[0-9]+(\.[0-9]+)?$'
                           then (m->>'cost')::numeric else cost_usd end,
           cost_currency = coalesce(nullif(m->>'cost_currency', ''), cost_currency),
           description = coalesce(nullif(m->>'description', ''), description),
           is_enabled = coalesce((m->'is_enabled')::boolean, is_enabled),
           is_coming_soon = coalesce((m->'is_coming_soon')::boolean, is_coming_soon),
           synced_at = now(), updated_at = now()
     where model_id = m->>'name';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('reelora_worker_token','reelora_sync_video_models') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

notify pgrst, 'reload schema';
