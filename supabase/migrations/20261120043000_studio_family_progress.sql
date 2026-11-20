create or replace function ugc_private.studio_spec_hash(p_id uuid) returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_array(m.input_schema,m.output_schema,m.endpoint_evidence->'endpoint',m.endpoint_evidence->'endpoint_url',m.provider_enabled,m.coming_soon,m.public_catalog_present,m.category,m.metadata->'family',m.metadata->'group_of')::text)
 from saas_ugc.studio_ai_models m where m.id=p_id
$$;
create table saas_ugc.studio_model_integrations (
 model_id uuid primary key references saas_ugc.studio_ai_models(id), spec_hash text not null,
 family text not null, protocol text check(protocol in ('muapi_output_envelope_v1','muapi_output_urls_v1')),
 adapter_version text not null, status text not null check(status in ('blocked','integration_prepared')),
 openapi_evidence jsonb not null default '{}', stages jsonb not null, blockers jsonb not null, input_signature text not null,
 checked_at timestamptz not null default now()
);
alter table saas_ugc.studio_model_integrations enable row level security;
revoke all on saas_ugc.studio_model_integrations from public,anon,authenticated;
alter table saas_ugc.studio_runtime_jobs add column protocol_key text;
create function public.studio_save_integration(p_model_id uuid,p_hash text,p_report jsonb) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 perform 1 from saas_ugc.studio_ai_models where id=p_model_id and provider_key='muapi' for update;
 if not found or p_hash is distinct from ugc_private.studio_spec_hash(p_model_id) then return false; end if;
 if p_report->>'version' is distinct from 'muapi-families-1' or jsonb_typeof(p_report->'stages') is distinct from 'object' or jsonb_typeof(p_report->'blockers') is distinct from 'array' then raise exception 'invalid_report'; end if;
 insert into saas_ugc.studio_model_integrations(model_id,spec_hash,family,protocol,adapter_version,status,stages,blockers,input_signature)
 values(p_model_id,p_hash,p_report->>'family',p_report->>'protocol',p_report->>'version',p_report->>'status',p_report->'stages',p_report->'blockers',p_report->>'input_signature')
 on conflict(model_id) do update set spec_hash=excluded.spec_hash,family=excluded.family,protocol=excluded.protocol,adapter_version=excluded.adapter_version,status=excluded.status,stages=excluded.stages,blockers=excluded.blockers,input_signature=excluded.input_signature,checked_at=now();
 update saas_ugc.studio_model_integrations set openapi_evidence=coalesce(p_report->'openapi_evidence','{}'::jsonb) where model_id=p_model_id;
 return true;
end $$;
revoke all on function public.studio_save_integration(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_save_integration(uuid,text,jsonb) to service_role;

-- Every catalog row is visible even before its batch has been assessed.
create function public.studio_integration_progress(p_after text default '',p_family text default '',p_status text default '',p_query text default '') returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform ugc_private.reelora_assert_admin();
 if p_after is null or p_family is null or p_status is null or p_query is null or length(p_query)>200 then raise exception 'invalid_filter'; end if;
 return jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(x) order by provider_model_id collate "C") from (
 select m.provider_model_id,m.display_name,m.category,coalesce(i.family,'unclassified') family,i.protocol,
 case when i.model_id is null then 'unassessed' when i.spec_hash is distinct from ugc_private.studio_spec_hash(m.id) then 'stale' else coalesce(i.status,'unassessed') end status,
 case when i.spec_hash=ugc_private.studio_spec_hash(m.id) then i.stages else '{}'::jsonb end stages,
 i.blockers,i.checked_at,i.adapter_version,
 (c.credits>0 and c.max_cost_usd>0) as pricing_configured,m.account_access='available' as access_confirmed,
 (c.verified_at is not null and c.verified_hash=ugc_private.studio_spec_hash(m.id)) as real_test_succeeded,
 coalesce(c.enabled,false) as enabled,
 -- Configuration/attestation alone cannot turn a prepared integration into an operational one.
 (coalesce(c.enabled,false) and m.account_access='available' and c.verified_at is not null and c.verified_hash=ugc_private.studio_spec_hash(m.id) and i.spec_hash=ugc_private.studio_spec_hash(m.id) and i.status='integration_prepared' and i.blockers='[]'::jsonb and (select enabled from saas_ugc.studio_runtime_limits where id)) as operational
 from saas_ugc.studio_ai_models m left join saas_ugc.studio_model_integrations i on i.model_id=m.id
 left join saas_ugc.studio_runtime_configs c on c.model_id=m.id
 where m.provider_key='muapi' and m.provider_model_id collate "C">p_after collate "C"
 and (p_family='' or i.family=p_family) and (p_status='' or (case when i.model_id is null then 'unassessed' when i.spec_hash is distinct from ugc_private.studio_spec_hash(m.id) then 'stale' else coalesce(i.status,'unassessed') end)=p_status)
 and (p_query='' or strpos(lower(m.provider_model_id||' '||m.display_name),lower(p_query))>0)
 order by m.provider_model_id collate "C" limit 50)x),'[]'::jsonb),
 'families',coalesce((select jsonb_object_agg(family,n) from(select coalesce(i.family,'unclassified') family,count(*) n from saas_ugc.studio_ai_models m left join saas_ugc.studio_model_integrations i on i.model_id=m.id where m.provider_key='muapi' group by 1)x),'{}'::jsonb),
 'counts',(select jsonb_build_object('total',count(*),'assessed',count(i.model_id),'prepared',count(*) filter(where i.status='integration_prepared' and i.spec_hash=ugc_private.studio_spec_hash(m.id)),'technical_tests',count(*) filter(where i.stages->>'technical_test_succeeded'='true' and i.spec_hash=ugc_private.studio_spec_hash(m.id))) from saas_ugc.studio_ai_models m left join saas_ugc.studio_model_integrations i on i.model_id=m.id where m.provider_key='muapi'));
end $$;
revoke all on function public.studio_integration_progress(text,text,text,text) from public,anon;
grant execute on function public.studio_integration_progress(text,text,text,text) to authenticated;

create function ugc_private.studio_snapshot_protocol() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select protocol into new.protocol_key from saas_ugc.studio_model_integrations where model_id=new.model_id and spec_hash=ugc_private.studio_spec_hash(new.model_id) and status='integration_prepared';
 return new;
end $$;
revoke all on function ugc_private.studio_snapshot_protocol() from public,anon,authenticated;
create trigger studio_snapshot_protocol before insert on saas_ugc.studio_runtime_jobs for each row execute function ugc_private.studio_snapshot_protocol();
notify pgrst,'reload schema';

select cron.schedule('studio-universal-integrations','31 * * * *',$cron$
 select net.http_post(url:='https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/studio-runtime',
 headers:=jsonb_build_object('Content-Type','application/json','x-reelora-worker-token',(select decrypted_secret from vault.decrypted_secrets where name='reelora_worker_token' limit 1)),
 body:='{"action":"worker","task":"integrations"}'::jsonb,timeout_milliseconds:=120000);
$cron$);
