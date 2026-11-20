-- Additive, read-only admin access. No pricing, account access, activation or
-- generation state is inferred or modified. Pagination limits response size,
-- not the number of models an administrator can browse.
create function public.studio_catalog_admin_models(
  p_query text default '', p_category text default '', p_status text default '',
  p_after text default '', p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if p_query is null or length(p_query)>200 or p_category is null or length(p_category)>100
    or p_status is null or p_status not in ('','catalog_only','partial','integrated','e2e_verified','enabled','disabled','missing')
    or p_after is null or length(p_after)>160 or p_limit is null or p_limit<1 or p_limit>100 then
    raise exception 'invalid_filter';
  end if;
  with matches as (
    select m.provider_model_id,m.provider_key,m.display_name,m.category,m.public_catalog_present,
      m.account_access,m.integration_status,m.studio_enabled,m.adapter_key,d.status as detail_status,d.http_status as detail_http_status
    from saas_ugc.studio_ai_models m left join saas_ugc.studio_ai_model_details d on d.model_id=m.id
    where m.provider_key='muapi'
      and (p_query='' or strpos(lower(m.provider_model_id || ' ' || m.display_name || ' ' || m.category),lower(p_query))>0)
      and (p_category='' or m.category=p_category)
      and (p_status='' or m.integration_status=p_status or (p_status='enabled' and m.studio_enabled)
        or (p_status='disabled' and not m.studio_enabled) or (p_status='missing' and not m.public_catalog_present))
  ), page as (
    select * from matches where provider_model_id collate "C" > p_after collate "C"
    order by provider_model_id collate "C" limit p_limit
  )
  select jsonb_build_object('total',(select count(*) from matches),
    'items',coalesce((select jsonb_agg(to_jsonb(page) order by provider_model_id collate "C") from page),'[]'::jsonb),
    'next_cursor', case when (select count(*) from page)=p_limit and exists (
      select 1 from matches where provider_model_id collate "C" > (select provider_model_id from page order by provider_model_id collate "C" desc limit 1) collate "C"
    ) then (select provider_model_id from page order by provider_model_id collate "C" desc limit 1) else null end)
    into v_result;
  return v_result;
end $$;
revoke all on function public.studio_catalog_admin_models(text,text,text,text,integer) from public, anon;
grant execute on function public.studio_catalog_admin_models(text,text,text,text,integer) to authenticated;

create function public.studio_catalog_admin_model_detail(p_model_id text)
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
    'adapter_key',m.adapter_key,'detail_status',d.status,'detail_http_status',d.http_status,'detail_checked_at',d.checked_at,
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
