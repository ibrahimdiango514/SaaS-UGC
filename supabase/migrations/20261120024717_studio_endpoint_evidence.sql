-- Seven top-level endpoint declarations verified by GET on 2026-11-20.
-- Evidence is not account access, an adapter, a price or a successful generation.
-- No activation, credit mutation, historical video write or inferred mapping.
alter table saas_ugc.studio_ai_models add column endpoint_evidence jsonb;
update saas_ugc.studio_ai_models set endpoint_evidence=jsonb_build_object(
  'endpoint_url',provider_model_id,'endpoint','/api/v1/' || provider_model_id,
  'source_url','https://api.muapi.ai/api/v1/models/' || provider_model_id,
  'observed_on','2026-11-20','http_status',200)
where provider_key='muapi' and provider_model_id in (
  'minimax-h3-open-reference-to-video',
  'qwen-image-text-to-image-2512-lora',
  'qwen-image-text-to-image-lora',
  'qwen3-image-to-image',
  'qwen3-pro-image-to-image',
  'qwen3-pro-text-to-image',
  'qwen3-text-to-image');

create or replace function public.studio_catalog_admin_model_detail(p_model_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if p_model_id is null or length(p_model_id)<1 or length(p_model_id)>160 then raise exception 'invalid_model'; end if;
  select jsonb_build_object(
    'provider_model_id',m.provider_model_id,'provider_key',m.provider_key,'display_name',m.display_name,
    'category',m.category,'description',m.description,'input_fields',m.input_fields,'required_fields',m.required_fields,
    'input_schema',m.input_schema,'output_schema',m.output_schema,'metadata',m.metadata,
    'provider_enabled',m.provider_enabled,'coming_soon',m.coming_soon,'public_catalog_present',m.public_catalog_present,
    'account_access',m.account_access,'integration_status',m.integration_status,'studio_enabled',m.studio_enabled,
    'endpoint_evidence',m.endpoint_evidence,'adapter_key',m.adapter_key,'detail_status',d.status,'detail_http_status',d.http_status,'detail_checked_at',d.checked_at,
    'recent_changes',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc,c.id desc) from (
       select ch.id,ch.change_type,ch.created_at from saas_ugc.studio_ai_catalog_changes ch
       where ch.model_id=m.id order by ch.created_at desc,ch.id desc limit 20
    ) c),'[]'::jsonb)
  ) into v_result
  from saas_ugc.studio_ai_models m left join saas_ugc.studio_ai_model_details d on d.model_id=m.id
  where m.provider_key='muapi' and m.provider_model_id=p_model_id;
  return v_result;
end $$;
revoke all on function public.studio_catalog_admin_model_detail(text) from public, anon;
grant execute on function public.studio_catalog_admin_model_detail(text) to authenticated;

create or replace function public.studio_save_muapi_detail(
  p_model_id text, p_status text, p_http_status integer, p_input_schema jsonb, p_output_schema jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_status is null or p_status not in ('ok','http_error','invalid','network_error') then raise exception 'invalid_status'; end if;
  if p_status='ok' and (jsonb_typeof(p_input_schema) is distinct from 'object'
    or (p_output_schema is not null and jsonb_typeof(p_output_schema) is distinct from 'object')) then raise exception 'invalid_schema'; end if;
  select id into v_id from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id and public_catalog_present for update;
  if v_id is null then return false; end if;
  if p_status='ok' then
    update saas_ugc.studio_ai_models set input_schema=p_input_schema - 'vyora_endpoint_evidence',
      endpoint_evidence=p_input_schema->'vyora_endpoint_evidence',
      output_schema=coalesce(p_output_schema,output_schema), updated_at=now() where id=v_id;
  end if;
  insert into saas_ugc.studio_ai_model_details(model_id,status,http_status,checked_at)
    values(v_id,p_status,p_http_status,now())
    on conflict(model_id) do update set status=excluded.status,http_status=excluded.http_status,checked_at=excluded.checked_at;
  return true;
end $$;
revoke all on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb) to service_role;
