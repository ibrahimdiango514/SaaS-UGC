-- =============================================================================
-- VYORA AI GATEWAY — FOURNISSEUR CENTRAL UNIQUE : FreeLLMAPI
-- =============================================================================
--
-- Décision produit : VYORA ne gère plus plusieurs fournisseurs IA. Toutes les
-- requêtes passent par le routeur central, qui parle UN SEUL protocole —
-- OpenAI-compatible — vers FreeLLMAPI, lequel agrège les modèles.
--
-- Cette migration est IDEMPOTENTE et a été appliquée sur le projet
-- xbuuhfwobrafcbgtdgjx le 2026-11-23.
--
-- Différence essentielle avec la première version (jamais appliquée telle
-- quelle) : les fournisseurs historiques sont RETIRÉS, pas SUPPRIMÉS.
-- `ai_calls_log`, `ai_provider_health_checks`, `ai_requests` et
-- `ai_request_attempts` les référencent en ON DELETE RESTRICT : un DELETE
-- aurait échoué, et l'aurait fait au prix de la destruction de l'historique
-- de facturation et de santé (652 contrôles, 33 appels réels). Un fournisseur
-- « retiré » = enabled=false, integration_phase=NULL, status='unavailable' :
-- il sort du routage, des descripteurs et des sondes, tout en conservant ses
-- traces comptables.
--
-- Aucune clé n'est écrite ici : uniquement les NOMS des variables d'environnement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Colonne base_url_env
--    L'URL de base peut venir d'un secret Edge (tunnel, reverse proxy…), sans
--    redéploiement et sans figer un hôte éphémère dans la base.
-- -----------------------------------------------------------------------------
alter table saas_business.ai_providers
  add column if not exists base_url_env text;

comment on column saas_business.ai_providers.base_url_env is
  'Nom de la variable d''environnement portant l''URL de base (jamais la valeur). Prioritaire sur default_base_url quand elle est définie.';

-- -----------------------------------------------------------------------------
-- 2) Ligne de registre FreeLLMAPI (idempotente)
--    - default_base_url volontairement NULL : l'hôte n'existe QUE dans le
--      secret FREE_LLM_API_BASE_URL (127.0.0.1 n'est pas joignable depuis Edge).
--    - status `unverified` : le fournisseur ne devient `available` qu'après une
--      sonde RÉELLE réussie.
-- -----------------------------------------------------------------------------
insert into saas_business.ai_providers (
  provider_key, display_name, status, enabled,
  adapter_kind, transport, default_base_url, base_url_env, models_url,
  default_headers, api_key_env, account_id_env, gateway_id_env,
  is_aggregator, integration_phase, probe_model, notes
) values (
  'freellmapi', 'FreeLLMAPI', 'unverified', true,
  'openai', 'rest', null, 'FREE_LLM_API_BASE_URL', null,
  '{}'::jsonb, 'FREE_LLM_API_KEY', null, null,
  true, 'freellmapi-2026-11-23', 'auto',
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
  probe_model = excluded.probe_model,
  notes = excluded.notes,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3) Descripteurs serveur : base_url_env exposé aux sondes
--    `probe_model` est conservé (les consommateurs existants le lisent).
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
      'integration_phase', p.integration_phase,
      'probe_model', p.probe_model
    ) order by p.provider_key
  ), '[]'::jsonb)
  from saas_business.ai_providers p
  where p.integration_phase is not null;
$$;

revoke all on function public.vyora_ai_provider_descriptors() from public, anon, authenticated;
grant execute on function public.vyora_ai_provider_descriptors() to service_role;

-- -----------------------------------------------------------------------------
-- 4) Snapshot du registre — version 5 : descripteur + base_url_env
--    Indispensable au moteur (`vyora-ai`) : sans ce champ, un fournisseur dont
--    l'URL ne vit que dans un secret n'a AUCUNE URL de base et le moteur répond
--    UNSUPPORTED_PROVIDER.
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
grant execute on function saas_business.bg_ai_registry_snapshot() to service_role, postgres;

-- -----------------------------------------------------------------------------
-- 5) Surveillance : les tables d'état acceptent le fournisseur central
--    La contrainte historique énumérait des fournisseurs nommés et rejetait
--    `freellmapi` (23514). On la remplace par une vraie clé étrangère.
-- -----------------------------------------------------------------------------
do $constraints$
declare
  v record;
begin
  for v in
    select c.conname, c.conrelid::regclass as rel
      from pg_constraint c
     where c.contype = 'c'
       and c.conrelid in (
         'saas_business.provider_health_cron_state'::regclass,
         'saas_business.provider_health_cron_runs'::regclass,
         'saas_business.ai_provider_health_checks'::regclass
       )
       and pg_get_constraintdef(c.oid) ilike '%provider_key%'
  loop
    execute format('alter table %s drop constraint %I', v.rel, v.conname);
  end loop;

  if not exists (
    select 1 from pg_constraint
     where conname = 'provider_health_cron_state_provider_key_fkey'
       and conrelid = 'saas_business.provider_health_cron_state'::regclass
  ) then
    alter table saas_business.provider_health_cron_state
      add constraint provider_health_cron_state_provider_key_fkey
      foreign key (provider_key)
      references saas_business.ai_providers(provider_key)
      on delete cascade;
  end if;
end
$constraints$;

-- -----------------------------------------------------------------------------
-- 6) Dispatch de surveillance piloté par le registre
--    La version précédente ne surveillait que `groq` et `gemini`, écrits en
--    dur : après consolidation, plus rien n'était sondé. Désormais tout
--    fournisseur en phase d'intégration est envoyé à `vyora-provider-health`.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_provider_health_dispatch(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $dispatch$
declare
  v_url      constant text := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-provider-health';
  v_token    text;
  v_provider text;
  v_state    record;
  v_request  bigint;
  v_sent     jsonb := '[]'::jsonb;
  v_checked  timestamptz;
begin
  if not pg_try_advisory_xact_lock(hashtext('vyora_provider_health')) then
    return jsonb_build_object('skipped', 'concurrent_run_in_progress', 'at', now());
  end if;

  select public.vyora_provider_health_cron_token() into v_token;
  if coalesce(v_token, '') = '' then
    return jsonb_build_object('error', 'TOKEN_MISSING', 'at', now());
  end if;

  for v_provider in
    select p.provider_key
      from saas_business.ai_providers p
     where p.integration_phase is not null
     order by p.provider_key
  loop
    insert into saas_business.provider_health_cron_state (provider_key)
    values (v_provider)
    on conflict (provider_key) do nothing;

    select * into v_state
      from saas_business.provider_health_cron_state
     where provider_key = v_provider
       for update skip locked;
    if not found then continue; end if;

    if not coalesce(p_force, false) then
      select max(h.checked_at) into v_checked
        from saas_business.ai_provider_health_checks h
       where h.provider_key = v_provider
         and h.model_key is null
         and h.status = 'healthy';
      if coalesce(v_checked, '-infinity'::timestamptz) > now() - interval '20 hours' then
        update saas_business.provider_health_cron_state
           set last_attempts = 0, updated_at = now()
         where provider_key = v_provider;
        v_sent := v_sent || jsonb_build_object(
          'provider_key', v_provider, 'skipped', 'recent_health_check', 'last_healthy_at', v_checked
        );
        continue;
      end if;
    end if;

    v_request := net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'x-vyora-cron', 'provider-health'
      ),
      body := jsonb_build_object('providerKey', v_provider),
      timeout_milliseconds := 45000
    );

    update saas_business.provider_health_cron_state
       set last_dispatch_at = now(),
           last_attempts = last_attempts + 1,
           updated_at = now()
     where provider_key = v_provider;

    insert into saas_business.provider_health_cron_runs
      (provider_key, status, attempt, pg_net_request_id, detail)
    values (v_provider, 'dispatched', 1, v_request,
            jsonb_build_object('dispatched_at', now(), 'forced', coalesce(p_force, false), 'source', 'registry'));

    v_sent := v_sent || jsonb_build_object(
      'provider_key', v_provider, 'pg_net_request_id', v_request, 'previous_status', v_state.last_status
    );
  end loop;

  return jsonb_build_object('dispatched_at', now(), 'forced', coalesce(p_force, false), 'providers', v_sent);
end
$dispatch$;

revoke all on function public.vyora_provider_health_dispatch(boolean) from public, anon, authenticated;
grant execute on function public.vyora_provider_health_dispatch(boolean) to service_role, postgres;

-- -----------------------------------------------------------------------------
-- 7) Modèles du fournisseur central
--    `auto` et `auto:fast` sont des alias RÉELS du routeur, vérifiés par appels
--    réels. `fusion` reste désactivé tant qu'il n'a pas été vérifié.
-- -----------------------------------------------------------------------------
insert into saas_business.ai_models (
  provider_key, model_key, provider_model_key, display_name, capabilities,
  enabled, verification_status, verified_at, max_input_tokens, max_output_tokens, tier, cost_note
) values
  ('freellmapi', 'auto', 'auto', 'FreeLLMAPI Auto (routeur)',
   '{"reasoning":true,"writing":true,"documents":true,"hooks":true,"scripts":true,"tools":true}'::jsonb,
   true, 'verified', now(), 104857, 32768, 'standard',
   'Alias de routage du fournisseur central, vérifié par sonde réelle le 2026-11-23.'),
  ('freellmapi', 'auto-fast', 'auto:fast', 'FreeLLMAPI Auto Fast',
   '{"reasoning":true,"writing":true,"documents":true,"hooks":true,"scripts":true,"tools":true}'::jsonb,
   true, 'verified', now(), 104857, 32768, 'fast',
   'Alias rapide, vérifié par appel réel le 2026-11-23.'),
  ('freellmapi', 'fusion', 'fusion', 'FreeLLMAPI Fusion (panel + juge)',
   '{"reasoning":true,"writing":true,"documents":true}'::jsonb,
   false, 'unverified', null, 104857, 32768, 'advanced',
   'Panel de modèles, non activé sans vérification dédiée.')
on conflict (provider_key, provider_model_key) do update set
  display_name = excluded.display_name,
  capabilities = excluded.capabilities,
  enabled = excluded.enabled,
  verification_status = excluded.verification_status,
  verified_at = excluded.verified_at,
  tier = excluded.tier,
  cost_note = excluded.cost_note;

-- -----------------------------------------------------------------------------
-- 8) Retrait des fournisseurs historiques
--    Ordre : règles → catalogue → quotas → configs → révocation des modèles →
--    retrait des fournisseurs. Les lignes `ai_providers` et `ai_models` sont
--    conservées (historique comptable) mais désactivées.
-- -----------------------------------------------------------------------------
delete from saas_business.ai_routing_rules
  where provider_key <> 'freellmapi';

do $roles$
declare
  v_role text;
begin
  for v_role in select role_key from saas_business.ai_roles where enabled loop
    if not exists (
      select 1 from saas_business.ai_routing_rules
       where role_key = v_role and provider_key = 'freellmapi'
    ) then
      insert into saas_business.ai_routing_rules (role_key, provider_key, model_key, priority, enabled)
      values (v_role, 'freellmapi', 'auto', 1, true);
    else
      update saas_business.ai_routing_rules
         set priority = 1, enabled = true, updated_at = now()
       where role_key = v_role and provider_key = 'freellmapi';
    end if;
  end loop;
end
$roles$;

delete from saas_business.ai_catalog_models
  where provider_key <> 'freellmapi';

delete from saas_business.ai_quota_observations
  where provider_key <> 'freellmapi';

delete from saas_business.ai_provider_configs
  where provider_key <> 'freellmapi';

update saas_business.ai_models
   set enabled = false
 where provider_key <> 'freellmapi'
   and enabled;

update saas_business.ai_providers
   set enabled = false,
       status = 'unavailable',
       integration_phase = null,
       error_code = 'RETIRED_CONSOLIDATED',
       updated_at = now()
 where provider_key <> 'freellmapi';

-- -----------------------------------------------------------------------------
-- 9) Contrainte de protocole : openai | none (plus d'adaptateur natif)
-- -----------------------------------------------------------------------------
do $adapter$
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
end
$adapter$;

update saas_business.ai_providers
   set adapter_kind = 'openai'
 where adapter_kind not in ('openai', 'none');

alter table saas_business.ai_providers
  add constraint ai_providers_adapter_kind_check
  check (adapter_kind in ('openai', 'none'));

-- -----------------------------------------------------------------------------
-- 10) Job historique supprimé
--     `vyora-ai-providers-probe` sondait la flotte multi-fournisseurs. Il est
--     remplacé par le dispatch de surveillance ci-dessus, désormais piloté par
--     le registre (et par la sonde `vyora-provider-health`, qui lit
--     `base_url_env`).
-- -----------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'vyora-ai-providers-probe') then
    perform cron.unschedule('vyora-ai-providers-probe');
  end if;
end
$cron$;
