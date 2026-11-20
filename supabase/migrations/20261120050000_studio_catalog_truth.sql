create or replace function public.studio_catalog_admin_summary()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; begin
 perform ugc_private.reelora_assert_admin();
 with states as (
 select m.id,m.category,m.public_catalog_present,
  d.status detail_status,
  (i.status='integration_prepared' and i.spec_hash=ugc_private.studio_spec_hash(m.id)) as prepared,
  coalesce(c.enabled,false) as enabled,
  coalesce(c.credits>0 and c.max_cost_usd>0,false) as priced,
  coalesce(c.verified_at is not null and c.verified_hash=ugc_private.studio_spec_hash(m.id),false) as tested,
  coalesce(i.status='integration_prepared' and i.spec_hash=ugc_private.studio_spec_hash(m.id)
   and m.public_catalog_present and m.provider_enabled is true and m.coming_soon is not true and m.account_access='available'
   and c.credits>0 and c.max_cost_usd>0 and c.verified_at is not null and c.verified_hash=ugc_private.studio_spec_hash(m.id)
   and c.quota_kind=(case when lower(m.category) like '%video%' then 'video' when lower(m.category) like '%image%' then 'image' when lower(m.category)='text to text' then 'script' else null end)
   and not exists(select 1 from jsonb_object_keys(coalesce(m.input_schema#>'{schemas,input_data,properties}','{}'::jsonb)) k where lower(k) in ('webhook','callback_url','api_key','authorization','endpoint'))
   and c.adapter='muapi_prediction_v1' and c.estimate_path ~ '^/api/v1/models/[A-Za-z0-9._~-]{1,160}/estimate-cost$' and cardinality(c.allowed_plans)>0,false) as integrated,
  coalesce((select enabled from saas_ugc.studio_runtime_limits where id),false) as runtime_enabled
 from saas_ugc.studio_ai_models m
 left join saas_ugc.studio_ai_model_details d on d.model_id=m.id
 left join saas_ugc.studio_model_integrations i on i.model_id=m.id
 left join saas_ugc.studio_runtime_configs c on c.model_id=m.id
 where m.provider_key='muapi'
 ) select jsonb_build_object(
 'models',count(*),'present',count(*) filter(where public_catalog_present),'removed',count(*) filter(where not public_catalog_present),
 'prepared',count(*) filter(where prepared),'integrated',count(*) filter(where integrated),
 'operational',count(*) filter(where integrated and runtime_enabled and enabled),
 'enabled',count(*) filter(where enabled),
 'studio_available',count(*) filter(where integrated and runtime_enabled and enabled),
 'problems',count(*) filter(where not (integrated and runtime_enabled and enabled)),
 'pricing_missing',count(*) filter(where not priced),'real_tests_missing',count(*) filter(where not tested),
 'details_ok',count(*) filter(where detail_status='ok'),'detail_errors',count(*) filter(where detail_status is not null and detail_status<>'ok'),
 'last_sync',(select max(synced_at) from saas_ugc.studio_ai_catalog_syncs where provider_key='muapi' and source_scope='public'),
 'categories',(select coalesce(jsonb_object_agg(category,n),'{}'::jsonb) from(select category,count(*) n from states group by category)x),
 'measured_at',now()
 ) into result from states;
 return result;
end $$;
-- Function permissions remain admin-gated and unchanged by CREATE OR REPLACE.
notify pgrst,'reload schema';
