-- Agrégats sans prix, accessibles uniquement après contrôle du rôle admin existant.
create function public.studio_catalog_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  return jsonb_build_object(
    'models', (select count(*) from saas_ugc.studio_ai_models where provider_key='muapi' and public_catalog_present),
    'details_ok', (select count(*) from saas_ugc.studio_ai_model_details d join saas_ugc.studio_ai_models m on m.id=d.model_id where m.provider_key='muapi' and m.public_catalog_present and d.status='ok'),
    'detail_errors', (select count(*) from saas_ugc.studio_ai_model_details d join saas_ugc.studio_ai_models m on m.id=d.model_id where m.provider_key='muapi' and m.public_catalog_present and d.status<>'ok'),
    'enabled', (select count(*) from saas_ugc.studio_ai_models where provider_key='muapi' and public_catalog_present and studio_enabled),
    'last_sync', (select max(synced_at) from saas_ugc.studio_ai_catalog_syncs where provider_key='muapi' and source_scope='public'),
    'categories', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category,count(*) as n from saas_ugc.studio_ai_models where provider_key='muapi' and public_catalog_present group by category) q)
  );
end $$;
revoke all on function public.studio_catalog_admin_summary() from public, anon;
grant execute on function public.studio_catalog_admin_summary() to authenticated;
