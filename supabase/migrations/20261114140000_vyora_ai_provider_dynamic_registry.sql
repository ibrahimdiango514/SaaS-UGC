-- =============================================================================
-- VYORA AI REGISTRY — fournisseurs DYNAMIQUES (2026-11-14)
--
-- Objectif produit : ne plus jamais figer la liste des fournisseurs. Le registre
-- décrit lui-même le protocole de chaque fournisseur ; le moteur ne contient
-- aucune liste fermée et peut servir un fournisseur inconnu du code dès lors
-- qu'une ligne de registre décrit son gabarit de protocole.
--
-- Cette migration est ADDITIVE et NON DESTRUCTIVE :
--   * aucun fournisseur n'est créé (aucun fournisseur fictif, conformément à la
--     consigne du 2026-11-14) ;
--   * aucune donnée existante n'est supprimée ni renommée ;
--   * les fournisseurs déjà enregistrés reçoivent leur gabarit de protocole et
--     leur URL de base par simple correspondance de clé (mise à jour ciblée).
--
-- Sécurité : les lignes ne contiennent AUCUNE clé. Elles ne portent que le NOM
-- de la variable d'environnement (`api_key_env`), la valeur restant dans les
-- secrets Edge Functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Descripteur de protocole sur la ligne fournisseur
-- -----------------------------------------------------------------------------

alter table saas_business.ai_providers
  add column if not exists adapter_kind text not null default 'openai'
    check (adapter_kind in ('openai', 'gemini', 'cloudflare', 'none')),
  add column if not exists default_base_url text,
  add column if not exists models_url text,
  add column if not exists default_headers jsonb not null default '{}'::jsonb,
  add column if not exists api_key_env text,
  add column if not exists account_id_env text;

comment on column saas_business.ai_providers.adapter_kind is
  'Gabarit de protocole utilisé par le moteur : openai (chat/completions), gemini (natif), cloudflare (par compte), none (protocole dédié à écrire).';
comment on column saas_business.ai_providers.default_base_url is
  'URL de base de l''API, ex. https://api.exemple.com/v1. Le moteur en déduit /chat/completions et /models.';
comment on column saas_business.ai_providers.api_key_env is
  'NOM de la variable d''environnement portant la clé (jamais la valeur). Ex. EXEMPLE_API_KEY.';
comment on column saas_business.ai_providers.default_headers is
  'En-têtes supplémentaires (attribution d''agrégateur, version d''API). Aucun secret ici.';

-- -----------------------------------------------------------------------------
-- 2) Renseigner les fournisseurs DÉJÀ enregistrés (aucune création)
--    Correspondance par clé : si la clé n'existe pas, rien ne se passe.
-- -----------------------------------------------------------------------------

update saas_business.ai_providers set adapter_kind = 'gemini',
  default_base_url = coalesce(default_base_url, 'https://generativelanguage.googleapis.com/v1beta'),
  api_key_env = coalesce(api_key_env, 'GEMINI_API_KEY')
where provider_key = 'gemini';

update saas_business.ai_providers set adapter_kind = 'openai',
  default_base_url = coalesce(default_base_url, 'https://api.groq.com/openai/v1'),
  api_key_env = coalesce(api_key_env, 'GROQ_API_KEY')
where provider_key = 'groq';

update saas_business.ai_providers set adapter_kind = 'openai',
  default_base_url = coalesce(default_base_url, 'https://api.deepseek.com'),
  models_url = coalesce(models_url, 'https://api.deepseek.com/models'),
  api_key_env = coalesce(api_key_env, 'DEEPSEEK_API_KEY')
where provider_key = 'deepseek';

update saas_business.ai_providers set adapter_kind = 'openai',
  default_base_url = coalesce(default_base_url, 'https://api.mistral.ai/v1'),
  api_key_env = coalesce(api_key_env, 'MISTRAL_API_KEY')
where provider_key = 'mistral';

update saas_business.ai_providers set adapter_kind = 'openai',
  default_base_url = coalesce(default_base_url, 'https://api.x.ai/v1'),
  api_key_env = coalesce(api_key_env, 'XAI_API_KEY')
where provider_key in ('grok', 'xai');

update saas_business.ai_providers set adapter_kind = 'cloudflare',
  default_base_url = coalesce(default_base_url, 'https://api.cloudflare.com/client/v4'),
  api_key_env = coalesce(api_key_env, 'CLOUDFLARE_API_TOKEN'),
  account_id_env = coalesce(account_id_env, 'CLOUDFLARE_ACCOUNT_ID'),
  is_aggregator = coalesce(is_aggregator, false)
where provider_key = 'cloudflare';

update saas_business.ai_providers set adapter_kind = 'openai', is_aggregator = true,
  default_base_url = coalesce(default_base_url, 'https://openrouter.ai/api/v1'),
  api_key_env = coalesce(api_key_env, 'OPENROUTER_API_KEY'),
  default_headers = case
    when default_headers = '{}'::jsonb
      then '{"HTTP-Referer":"https://vyora-ugc.netlify.app","X-Title":"VYORA"}'::jsonb
    else default_headers
  end
where provider_key = 'openrouter';

-- -----------------------------------------------------------------------------
-- 3) Le snapshot expose le descripteur (le moteur n'a plus de liste en dur)
--    Signature conservée : `bg_ai_registry_snapshot()` reste interne.
-- -----------------------------------------------------------------------------

create or replace function saas_business.bg_ai_registry_snapshot()
returns jsonb
language sql
security definer stable
set search_path = pg_catalog, saas_business
as $$
  select jsonb_build_object(
    'version', 3,
    'generated_at', now(),
    'providers', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', provider_key,
          'name', display_name,
          'status', status,
          'aggregator', is_aggregator,
          'adapter_kind', adapter_kind,
          'base_url', default_base_url,
          'models_url', models_url,
          'api_key_env', api_key_env,
          'account_id_env', account_id_env,
          'headers', default_headers
        ) order by provider_key
      ), '[]'::jsonb)
      from ai_providers
      where enabled
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

-- -----------------------------------------------------------------------------
-- 4) Ajout / mise à jour d'un fournisseur depuis l'administration
--    Aucune clé n'entre ici : uniquement le descripteur de protocole.
--    Le fournisseur est créé `enabled = false` / `unverified` : il ne sera
--    servi qu'après une sonde réelle réussie.
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_admin_provider_upsert(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_key text := lower(btrim(coalesce(p_payload->>'provider_key', '')));
  v_name text := btrim(coalesce(p_payload->>'display_name', ''));
  v_kind text := lower(btrim(coalesce(p_payload->>'adapter_kind', 'openai')));
  v_base text := btrim(coalesce(p_payload->>'base_url', ''));
  v_models_url text := nullif(btrim(coalesce(p_payload->>'models_url', '')), '');
  v_models_suffix text := nullif(btrim(coalesce(p_payload->>'models_path', '')), '');
  v_key_env text := nullif(btrim(coalesce(p_payload->>'api_key_env', '')), '');
  v_account_env text := nullif(btrim(coalesce(p_payload->>'account_id_env', '')), '');
  v_headers jsonb := case when jsonb_typeof(p_payload->'headers') = 'object' then p_payload->'headers' else '{}'::jsonb end;
  v_aggregator boolean := coalesce((p_payload->>'aggregator')::boolean, false);
  v_target_models_url text;
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;

  if v_key = '' or v_key !~ '^[a-z][a-z0-9_-]{1,39}$' then
    raise exception 'provider_key invalide (minuscules, chiffres, - et _, 2 à 40 caractères)';
  end if;
  if v_name = '' then raise exception 'display_name requis'; end if;
  if v_kind not in ('openai', 'gemini', 'cloudflare', 'none') then
    raise exception 'adapter_kind invalide';
  end if;
  if v_base = '' or v_base !~ '^https://' then
    raise exception 'base_url doit être une URL https';
  end if;

  v_target_models_url := coalesce(v_models_url, case
    when v_models_suffix is null then null
    else rtrim(v_base, '/') || v_models_suffix
  end);

  insert into saas_business.ai_providers(
    provider_key, display_name, enabled, status, is_aggregator,
    adapter_kind, default_base_url, models_url, default_headers,
    api_key_env, account_id_env
  ) values (
    v_key, v_name, false, 'unverified', v_aggregator,
    v_kind, rtrim(v_base, '/'), v_target_models_url, v_headers,
    v_key_env, v_account_env
  )
  on conflict (provider_key) do update set
    display_name = excluded.display_name,
    adapter_kind = excluded.adapter_kind,
    default_base_url = excluded.default_base_url,
    models_url = excluded.models_url,
    default_headers = excluded.default_headers,
    api_key_env = excluded.api_key_env,
    account_id_env = excluded.account_id_env,
    is_aggregator = excluded.is_aggregator,
    updated_at = clock_timestamp();

  insert into saas_business.ai_provider_configs(provider_key, config_status)
  values (v_key, 'missing')
  on conflict (provider_key) do nothing;

  return jsonb_build_object(
    'provider_key', v_key,
    'enabled', (select enabled from saas_business.ai_providers where provider_key = v_key),
    'status', (select status from saas_business.ai_providers where provider_key = v_key),
    'adapter_kind', v_kind,
    'base_url', rtrim(v_base, '/')
  );
end $$;

revoke all on function public.vyora_ai_admin_provider_upsert(jsonb) from public, anon;
grant execute on function public.vyora_ai_admin_provider_upsert(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 5) Désactivation d'un fournisseur (jamais de suppression : l'historique
--    d'appels et de coûts doit rester lisible)
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_admin_provider_disable(p_provider_key text)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_key text := lower(btrim(coalesce(p_provider_key, '')));
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  if v_key = '' then raise exception 'provider_key requis'; end if;

  update saas_business.ai_providers
  set enabled = false, updated_at = clock_timestamp()
  where provider_key = v_key;

  if not found then raise exception 'fournisseur inconnu'; end if;

  -- Les règles de routage du fournisseur cessent immédiatement de le proposer.
  update saas_business.ai_routing_rules
  set enabled = false
  where provider_key = v_key and enabled;

  return jsonb_build_object('provider_key', v_key, 'enabled', false);
end $$;

revoke all on function public.vyora_ai_admin_provider_disable(text) from public, anon;
grant execute on function public.vyora_ai_admin_provider_disable(text) to authenticated;
