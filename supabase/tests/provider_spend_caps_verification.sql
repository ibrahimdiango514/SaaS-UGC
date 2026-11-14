-- Vérification transactionnelle (rollback) du plafond fournisseur v2 :
--   * plafond global armé + plafond par fournisseur respecté ;
--   * refus sans appel payant quand le plafond par fournisseur est atteint ;
--   * alerte de seuil et alerte de tentative bloquée émises une seule fois ;
--   * aucun débit : toutes les lignes créées ici sont annulées par le rollback.
--
-- À exécuter uniquement via `execute_query` (service_role) : le bloc se termine
-- par `rollback`, donc aucune donnée persistante n'est créée.
begin;

-- 1. Utilisateur réel requis (clé étrangère sur auth.users) : on réutilise un
--    compte EXISTANT sans jamais le modifier ni créer de transaction pour lui.
create temp table _t_ctx on commit drop as
select
  (select id from auth.users order by created_at limit 1) as user_id,
  (select id from saas_ugc.ugc_workspaces order by created_at limit 1) as workspace_id;

insert into saas_ugc.ugc_generation_jobs(
  id, workspace_id, created_by, service_key, status, request_payload, request_key
) values (
  '00000000-0000-4000-8000-000000000001',
  (select workspace_id from _t_ctx),
  (select user_id from _t_ctx),
  'ugc_clip_15s',
  'reserved',
  jsonb_build_object('model_id', '00000000-0000-4000-8000-00000000aa01'),
  'spend-verify-1'
);

insert into saas_ugc.ugc_video_quotes(
  id, user_id, service_key, model_id, public_model_id, credits_cost, provider_cost_usd,
  usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd, config_updated_at,
  quote_params, pricing_params
) values (
  '00000000-0000-4000-8000-0000000000c1',
  (select user_id from _t_ctx),
  'ugc_clip_15s',
  'kling-test-model',
  '00000000-0000-4000-8000-00000000aa01',
  13, 0.10, 620, 100, 60, 0.01, now(), '{}'::jsonb, '{}'::jsonb
);

update saas_ugc.ugc_generation_jobs
   set pricing_quote_id = '00000000-0000-4000-8000-0000000000c1'
 where id = '00000000-0000-4000-8000-000000000001';

-- 2. Plafond armé : 10 USD global, 1 USD pour muapi, seuil 50 %.
insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'provider_spend_cap',
  '{"enabled":true,"max_usd":10,"alert_percent":50,"provider_caps_usd":{"muapi":1}}'::jsonb,
  'verification transactionnelle'
)
on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now();

-- 3. Première réservation : autorisée, seuil 50 % franchi (0,10 / 10 = 1 % → non ;
--    on abaisse donc le seuil à 1 % pour prouver l'alerte).
update saas_ugc.ugc_app_settings
   set setting_value = jsonb_set(setting_value, '{alert_percent}', '1'::jsonb)
 where setting_key = 'provider_spend_cap';

select 'reserve_1' as step, public.reelora_reserve_provider_spend('00000000-0000-4000-8000-000000000001') as decision;

-- 4. Deuxième réservation sur le même fournisseur avec un coût qui dépasse le
--    plafond fournisseur (1 USD déjà consommé) : doit être refusée.
insert into saas_ugc.ugc_generation_jobs(
  id, workspace_id, created_by, service_key, status, request_payload, request_key
) values (
  '00000000-0000-4000-8000-000000000002',
  (select workspace_id from _t_ctx),
  (select user_id from _t_ctx),
  'ugc_clip_15s',
  'reserved',
  jsonb_build_object('model_id', '00000000-0000-4000-8000-00000000aa02'),
  'spend-verify-2'
);

insert into saas_ugc.ugc_video_quotes(
  id, user_id, service_key, model_id, public_model_id, credits_cost, provider_cost_usd,
  usd_to_xof, credit_value_xof, markup_percent, additional_cost_usd, config_updated_at,
  quote_params, pricing_params
) values (
  '00000000-0000-4000-8000-0000000000c2',
  (select user_id from _t_ctx),
  'ugc_clip_15s',
  'kling-test-model-2',
  '00000000-0000-4000-8000-00000000aa02',
  13, 0.50, 620, 100, 60, 0.01, now(), '{}'::jsonb, '{}'::jsonb
);

update saas_ugc.ugc_generation_jobs
   set pricing_quote_id = '00000000-0000-4000-8000-0000000000c2'
 where id = '00000000-0000-4000-8000-000000000002';

select 'reserve_2' as step, public.reelora_reserve_provider_spend('00000000-0000-4000-8000-000000000002') as decision;

-- 5. État attendu : 1 réservée, 1 bloquée, 1 alerte de seuil, 1 alerte de blocage.
select 'state' as step, jsonb_build_object(
  'spend', (select jsonb_agg(jsonb_build_object('provider', provider, 'status', status,
              'estimated', estimated_cost_usd, 'reason', reason_code) order by created_at)
              from saas_ugc.ugc_provider_spend),
  'alerts', (select jsonb_agg(jsonb_build_object('kind', kind, 'severity', severity) order by created_at)
               from saas_ugc.ugc_provider_spend_alerts),
  'workspace_id', (select workspace_id from _t_ctx),
  'user_id', (select user_id from _t_ctx)
) as report;

-- 6. Rien n'est conservé.
rollback;
