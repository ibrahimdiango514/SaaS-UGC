-- Endpoint conflict resolution bound to the official MuAPI OpenAPI document.
--
-- The integration worker resolves a model's contradictory endpoint declarations
-- only when the official document proves it (single documented POST, or two
-- documented POST operations with an identical functional contract). It then
-- submits the proof in `endpoint_resolution`. This migration persists that proof
-- on the model row, keeps the original declarations, and invalidates any runtime
-- attestation when the proof (path or contract fingerprint) changes.
--
-- Nothing is activated here: no `studio_enabled`, no runtime config, no credit.
-- The previous declarations remain available (`declared_paths`), never erased.

create or replace function ugc_private.studio_spec_hash(p_id uuid) returns text language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_array(
   m.input_schema,
   m.output_schema,
   m.endpoint_evidence->'endpoint',
   m.endpoint_evidence->'endpoint_url',
   m.endpoint_evidence->'resolution'->>'path',
   m.endpoint_evidence->'resolution'->>'contract_fingerprint',
   m.provider_enabled,
   m.coming_soon,
   m.public_catalog_present,
   m.category,
   m.metadata->'family',
   m.metadata->'group_of'
 )::text)
 from saas_ugc.studio_ai_models m where m.id=p_id
$$;
revoke all on function ugc_private.studio_spec_hash(uuid) from public,anon,authenticated;

create or replace function ugc_private.studio_endpoint_resolution(p_resolution jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare v_path text; v_resolution text; v_sha text; v_fingerprint text;
begin
 if p_resolution is null or jsonb_typeof(p_resolution) is distinct from 'object' then return null; end if;
 if exists(select 1 from jsonb_object_keys(p_resolution) k where k not in
   ('status','path','resolution','operation_id','contract_fingerprint','document_sha256','declared_paths','documented_paths')) then
  raise exception 'invalid_report';
 end if;
 if p_resolution->>'status' is distinct from 'resolved' then raise exception 'invalid_report'; end if;
 v_path:=p_resolution->>'path';
 v_resolution:=p_resolution->>'resolution';
 v_sha:=nullif(p_resolution->>'document_sha256','');
 v_fingerprint:=coalesce(p_resolution->>'contract_fingerprint','');
 if v_path is null or length(v_path)>240 or v_path !~ '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$' then raise exception 'invalid_report'; end if;
 if v_resolution is null or v_resolution not in ('declared','openapi_single','openapi_equivalent_contracts') then raise exception 'invalid_report'; end if;
 if v_sha is not null and v_sha !~ '^[0-9a-f]{64}$' then raise exception 'invalid_report'; end if;
 if length(v_fingerprint)>64 then raise exception 'invalid_report'; end if;
 if jsonb_typeof(p_resolution->'declared_paths') is distinct from 'array'
  or jsonb_array_length(p_resolution->'declared_paths')<1
  or jsonb_array_length(p_resolution->'declared_paths')>8 then raise exception 'invalid_report'; end if;
 if exists(select 1 from jsonb_array_elements(p_resolution->'declared_paths') e
   where jsonb_typeof(e) is distinct from 'string'
     or (e #>> '{}') !~ '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$') then raise exception 'invalid_report'; end if;
 if not exists(select 1 from jsonb_array_elements_text(p_resolution->'declared_paths') e where e=v_path) then raise exception 'invalid_report'; end if;
 if jsonb_typeof(coalesce(p_resolution->'documented_paths','[]'::jsonb)) is distinct from 'array'
  or jsonb_array_length(coalesce(p_resolution->'documented_paths','[]'::jsonb))>8 then raise exception 'invalid_report'; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(p_resolution->'documented_paths','[]'::jsonb)) e
   where jsonb_typeof(e) is distinct from 'string'
     or (e #>> '{}') !~ '^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$') then raise exception 'invalid_report'; end if;
 return jsonb_build_object(
   'status','resolved',
   'path',v_path,
   'resolution',v_resolution,
   'operation_id',nullif(p_resolution->>'operation_id',''),
   'contract_fingerprint',v_fingerprint,
   'document_sha256',v_sha,
   'declared_paths',p_resolution->'declared_paths',
   'documented_paths',coalesce(p_resolution->'documented_paths','[]'::jsonb)
 );
end $$;
revoke all on function ugc_private.studio_endpoint_resolution(jsonb) from public,anon,authenticated;

create or replace function public.studio_save_integration(p_model_id uuid,p_hash text,p_report jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare v_evidence jsonb; v_resolution jsonb; v_previous jsonb; v_new text; v_changed boolean:=false;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 select m.endpoint_evidence, m.endpoint_evidence->'resolution'
   into v_evidence, v_previous
   from saas_ugc.studio_ai_models m
   where m.id=p_model_id and m.provider_key='muapi' for update;
 if not found or p_hash is distinct from ugc_private.studio_spec_hash(p_model_id) then return false; end if;
 if coalesce(p_report->>'version','') not in ('muapi-families-2','muapi-families-3','muapi-families-4','muapi-families-5')
  or jsonb_typeof(p_report->'stages') is distinct from 'object'
  or jsonb_typeof(p_report->'blockers') is distinct from 'array' then raise exception 'invalid_report'; end if;

 v_resolution:=ugc_private.studio_endpoint_resolution(p_report->'endpoint_resolution');
 if v_resolution is null then
  v_evidence:=coalesce(v_evidence,'{}'::jsonb) - 'resolution';
 else
  v_evidence:=jsonb_set(coalesce(v_evidence,'{}'::jsonb),'{resolution}',v_resolution,true);
 end if;

 -- Invalidate an attestation before changing the proof it was bound to.
 if exists(select 1 from saas_ugc.studio_model_integrations i where i.model_id=p_model_id
   and (i.openapi_evidence is distinct from coalesce(p_report->'openapi_evidence','{}'::jsonb)
     or i.protocol is distinct from p_report->>'protocol'
     or i.result_field is distinct from p_report->>'result_field'
     or i.adapter_version is distinct from p_report->>'version'
     or i.spec_hash is distinct from ugc_private.studio_spec_hash(p_model_id)))
  or v_previous is distinct from v_resolution then
  update saas_ugc.studio_runtime_configs set enabled=false,verified_hash=null,verified_at=null,revision=revision+1 where model_id=p_model_id;
  v_changed:=true;
 end if;

 if v_evidence is distinct from coalesce((select endpoint_evidence from saas_ugc.studio_ai_models where id=p_model_id),'{}'::jsonb) then
  update saas_ugc.studio_ai_models set endpoint_evidence=v_evidence, updated_at=now() where id=p_model_id;
 end if;

 -- Hash AFTER persisting the resolution so the row never lags a proof change.
 v_new:=ugc_private.studio_spec_hash(p_model_id);
 insert into saas_ugc.studio_model_integrations(model_id,spec_hash,family,protocol,adapter_version,status,stages,blockers,input_signature)
 values(p_model_id,v_new,p_report->>'family',p_report->>'protocol',p_report->>'version',p_report->>'status',p_report->'stages',p_report->'blockers',p_report->>'input_signature')
 on conflict(model_id) do update set spec_hash=excluded.spec_hash,family=excluded.family,protocol=excluded.protocol,adapter_version=excluded.adapter_version,status=excluded.status,stages=excluded.stages,blockers=excluded.blockers,input_signature=excluded.input_signature,checked_at=now();
 update saas_ugc.studio_model_integrations set result_field=p_report->>'result_field',openapi_evidence=coalesce(p_report->'openapi_evidence','{}'::jsonb) where model_id=p_model_id;
 return true;
end $$;
revoke all on function public.studio_save_integration(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.studio_save_integration(uuid,text,jsonb) to service_role;
