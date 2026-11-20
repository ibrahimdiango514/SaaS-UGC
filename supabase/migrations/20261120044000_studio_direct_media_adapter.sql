-- Additional adapter selected from a single officially typed URL output.
alter table saas_ugc.studio_model_integrations drop constraint studio_model_integrations_protocol_check;
alter table saas_ugc.studio_model_integrations add constraint studio_model_integrations_protocol_check check(protocol in ('muapi_output_envelope_v1','muapi_output_urls_v1','muapi_output_media_v1'));
alter table saas_ugc.studio_model_integrations add column result_field text;
alter table saas_ugc.studio_runtime_jobs add column result_field text;
create or replace function public.studio_save_integration(p_model_id uuid,p_hash text,p_report jsonb) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 perform 1 from saas_ugc.studio_ai_models where id=p_model_id and provider_key='muapi' for update;
 if not found or p_hash is distinct from ugc_private.studio_spec_hash(p_model_id) then return false; end if;
 if p_report->>'version' is distinct from 'muapi-families-2' or jsonb_typeof(p_report->'stages') is distinct from 'object' or jsonb_typeof(p_report->'blockers') is distinct from 'array' then raise exception 'invalid_report'; end if;
 if exists(select 1 from saas_ugc.studio_model_integrations where model_id=p_model_id and openapi_evidence is distinct from coalesce(p_report->'openapi_evidence','{}'::jsonb)) then
  update saas_ugc.studio_runtime_configs set enabled=false,verified_hash=null,verified_at=null,revision=revision+1 where model_id=p_model_id;
 end if;
 insert into saas_ugc.studio_model_integrations(model_id,spec_hash,family,protocol,adapter_version,status,stages,blockers,input_signature)
 values(p_model_id,p_hash,p_report->>'family',p_report->>'protocol',p_report->>'version',p_report->>'status',p_report->'stages',p_report->'blockers',p_report->>'input_signature')
 on conflict(model_id) do update set spec_hash=excluded.spec_hash,family=excluded.family,protocol=excluded.protocol,adapter_version=excluded.adapter_version,status=excluded.status,stages=excluded.stages,blockers=excluded.blockers,input_signature=excluded.input_signature,checked_at=now();
 update saas_ugc.studio_model_integrations set result_field=p_report->>'result_field',openapi_evidence=coalesce(p_report->'openapi_evidence','{}'::jsonb) where model_id=p_model_id;
 return true;
end $$;

create or replace function ugc_private.studio_snapshot_protocol() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select protocol,result_field into new.protocol_key,new.result_field from saas_ugc.studio_model_integrations where model_id=new.model_id and spec_hash=ugc_private.studio_spec_hash(new.model_id) and status='integration_prepared';
 return new;
end $$;
notify pgrst,'reload schema';
