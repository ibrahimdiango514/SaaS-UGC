-- =============================================================================
-- VYORA AI GATEWAY — FOURNISSEUR CENTRAL UNIQUE : FreeLLMAPI (2026-11-23)
--
-- Décision produit : VYORA ne gère plus plusieurs fournisseurs IA. Toutes les
-- requêtes passent par le routeur central (VYORA AI GATEWAY), qui parle UN SEUL
-- protocole — OpenAI-compatible — vers FreeLLMAPI, lequel agrège les modèles.
--
-- Ce que fait cette migration :
--   1. `base_url_env` : l'URL de base peut venir d'un secret Edge, sans
--      redéploiement et sans figer l'hôte dans la base ;
--   2. `adapter_kind` est restreint à ('openai', 'none') — plus d'adaptateur
--      natif Gemini / Cloudflare ;
--   3. la ligne de registre `freellmapi` est créée (aucun modèle en dur : le
--      catalogue se remplit par sondes réelles) ;
--   4. les lignes des anciens fournisseurs, leurs modèles et leurs règles de
--      routage sont RETIRÉES (migration demandée explicitement) ;
--   5. les fonctions serveur (descripteurs + snapshot) exposent `base_url_env`.
--
-- Aucune clé n'est écrite ici : uniquement les NOMS des variables d'environnement.
-- Cette migration n'est pas appliquée en production par l'agent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Colonne base_url_env
-- -----------------------------------------------------------------------------
alter table saas_business.ai_providers
  add column if not exists base_url_env text;

comment on column saas_business.ai_providers.base_url_env is
  'Nom de la variable d''environnement portant l''URL de base (jamais la valeur). Prioritaire sur default_base_url quand elle est définie.';

-- -----------------------------------------------------------------------------
-- 2) Purge des fournisseurs historiques (données uniquement, pas de secret)
--    Ordre : dépendances d'abord (règles → modèles → catalogue → fournisseurs).
-- -----------------------------------------------------------------------------
delete from saas_business.ai_routing_rules
  where provider_key <> 'freellmapi';

delete from saas_business.ai_models
  where provider_key <> 'freellmapi';

delete from saas_business.ai_catalog_models
  where provider_key <> 'freellmapi';

delete from saas_business.ai_quota_observations
  where provider_key <> 'freellmapi';

delete from saas_business.ai_providers
  where provider_key <> 'freellmapi';

-- -----------------------------------------------------------------------------
-- 3) Contrainte de protocole : openai | none (plus d'adaptateur natif)
-- -----------------------------------------------------------------------------
do $$
declare
  v_constraint text;
begin
  for v_constraint in
    select conname
      from pg_constraint
     where conrelid = 'saas_business.ai_providers'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%adapter_kind%'
  loop
    execute format('alter table saas_business.ai_providers drop constraint %I', v_constraint);
  end loop;
end $$;

update saas_business.ai_providers
   set adapter_kind = 'openai'
 where adapter_kind not in ('openai', 'none');

alter table saas_business.ai_providers
  add constraint ai_providers_adapter_kind_check
  check (adapter_kind in ('openai', 'none'));

-- -----------------------------------------------------------------------------
-- 4) Ligne de registre FreeLLMAPI (idempotente)
--    - base_url : valeur publique par défaut, surchargée par FREE_LLM_API_BASE_URL
--    - api_key_env : FREE_LLM_API_KEY (secret Edge, jamais en base)
--    - status `unverified` : le fournisseur ne devient `available` qu'après une
--      sonde RÉELLE réussie (politique de vérité inchangée).
--    127.0.0.1 n'est pas joignable depuis une Edge Function : l'URL par défaut
--    est donc volontairement absente et DOIT être fournie par le secret.
-- -----------------------------------------------------------------------------
insert into saas_business.ai_providers (
  provider_key, display_name, status, enabled,
  adapter_kind, transport, default_base_url, base_url_env, models_url,
  default_headers, api_key_env, account_id_env, gateway_id_env,
  is_aggregator, integration_phase, notes
) values (
  'freellmapi', 'FreeLLMAPI', 'unverified', true,
  'openai', 'rest', null, 'FREE_LLM_API_BASE_URL', null,
  '{}'::jsonb, 'FREE_LLM_API_KEY', null, null,
  true, 'freellmapi-2026-11-23',
  'Fournisseur central unique de VYORA. Agrège les modèles ; catalogue rempli par sondes réelles.'
)
on conflict (provider_key) do update set
  display_name = excluded.display_name,
  adapter_kind = 'openai',
  transport = 'rest',
  base_url_env = excluded.base_url_env,
  api_key_env = excluded.api_key_env,
  account_id_env = null,
  gateway_id_env = null,
  is_aggregator = true,
  integration_phase = excluded.integration_phase,
  notes = excluded.notes,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 5) Descripteurs serveur : ajout de base_url_env
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ai_provider_descriptors()
returns jsonb
language sql security definer stable
set search_path = pg_catalog, saas_business
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', p.provider_key,
      'name', p.display_name,
      'status', p.status,
      'enabled', p.enabled,
      'aggregator', p.is_aggregator,
      'adapter_kind', p.adapter_kind,
      'transport', p.transport,
      'base_url', p.default_base_url,
      'base_url_env', p.base_url_env,
      'models_url', p.models_url,
      'api_key_env', p.api_key_env,
      'account_id_env', p.account_id_env,
      'gateway_id_env', p.gateway_id_env,
      'headers', p.default_headers,
      'integration_phase', p.integration_phase
    ) order by p.provider_key
  ), '[]'::jsonb)
  from saas_business.ai_providers p
  where p.integration_phase is not null;
$$;

revoke all on function public.vyora_ai_provider_descriptors() from public, anon, authenticated;
grant execute on function public.vyora_ai_provider_descriptors() to service_role;

-- -----------------------------------------------------------------------------
-- 6) Snapshot du registre — version 5 : descripteur + base_url_env
-- -----------------------------------------------------------------------------
create or replace function saas_business.bg_ai_registry_snapshot()
returns jsonb
language sql
security definer stable
set search_path = pg_catalog, saas_business
as $$
  select jsonb_build_object(
    'version', 5,
    'generated_at', now(),
    'providers', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', provider_key,
          'name', display_name,
          'status', status,
          'aggregator', is_aggregator,
          'adapter_kind', adapter_kind,
          'transport', transport,
          'base_url', default_base_url,
          'base_url_env', base_url_env,
          'models_url', models_url,
          'api_key_env', api_key_env,
          'account_id_env', account_id_env,
          'gateway_id_env', gateway_id_env,
          'headers', default_headers
        ) order by provider_key
      ), '[]'::jsonb)
      from ai_providers
      where enabled or integration_phase is not null
    ),
    'models', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'provider', m.provider_key,
          'key', m.model_key,
          'provider_model', m.provider_model_key,
          'name', m.display_name,
          'verified', (m.verification_status = 'verified'),
          'tier', m.tier,
          'capabilities', m.capabilities,
          'context_in', m.max_input_tokens,
          'max_out', m.max_output_tokens,
          'cost_in', m.cost_input_per_mtok_usd,
          'cost_out', m.cost_output_per_mtok_usd,
          'rpm', m.announced_rpm,
          'tpm', m.announced_tpm
        ) order by m.provider_key, m.model_key
      ), '[]'::jsonb)
      from ai_models m
      where m.enabled
    ),
    'roles', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', r.role_key,
          'capabilities', r.required_capabilities,
          'enabled', r.enabled
        ) order by r.role_key
      ), '[]'::jsonb)
      from ai_roles r
    ),
    'rules', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'role', r.role_key,
          'provider', r.provider_key,
          'model', r.model_key,
          'priority', r.priority
        ) order by r.role_key, r.priority, r.provider_key
      ), '[]'::jsonb)
      from ai_routing_rules r
    ),
    'budget', jsonb_build_object(
      'monthly', (select monthly_budget_usd from ai_admin_settings where key = 'global'),
      'alert', (select alert_threshold_pct from ai_admin_settings where key = 'global'),
      'daily', (select max_daily_cost_usd from ai_admin_settings where key = 'global')
    ),
    'monthly_spend_usd', coalesce((
      select sum(coalesce(cost_input_usd, 0) + coalesce(cost_output_usd, 0))
      from ai_calls_log
      where created_at >= date_trunc('month', now())
    ), 0)
  );
$$;

revoke all on function saas_business.bg_ai_registry_snapshot()
  from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
