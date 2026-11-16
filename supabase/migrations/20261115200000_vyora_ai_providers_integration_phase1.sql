-- =============================================================================
-- VYORA AI CORE — INTÉGRATION DES 5 FOURNISSEURS (2026-11-14)
--
-- Autorisation explicite reçue : « COMMENCE L'INTÉGRATION DES FOURNISSEURS IA. »
-- Fournisseurs retenus (et EUX SEULS) : openrouter, gonka, llm7, ollama,
-- cloudflare. Cohere est EXCLU de cette phase et n'est pas enregistré.
--
-- Ce que fait cette migration, et rien de plus :
--   1. descripteurs de protocole (gabarit, URL, transport, variables d'env) sur
--      les 5 lignes de registre — AUCUNE clé, uniquement des NOMS de variables ;
--   2. colonne `transport` (rest | gateway) : la voie d'appel vient du registre ;
--   3. table de catalogue (`ai_catalog_models`) : ce que chaque fournisseur
--      publie réellement, avec prix et capacités publiés ou NULL ;
--   4. table de quota observé par fournisseur et par jour (429, en-têtes) ;
--   5. verrou d'idempotence des appels (`ai_call_leases`) : anti-double-facture ;
--   6. journal de routage (`ai_routing_log`) : pourquoi tel modèle a été choisi ;
--   7. RPC serveur : lire les 5 descripteurs, enregistrer une sonde, synchroniser
--      un catalogue, ouvrir/fermer un bail d'appel, journaliser une décision.
--
-- Politique de vérité (inchangée) : un fournisseur reste `enabled = false` /
-- `unverified` jusqu'à une sonde RÉELLE réussie ; un modèle reste `unverified`
-- jusqu'à une complétion réelle réussie. Aucune disponibilité n'est supposée.
--
-- Additif et non destructif : aucune ligne supprimée, aucun historique réécrit.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Décision produit : les 5 fournisseurs de cette phase
--    `integration_phase` permet à l'administration de distinguer une ligne
--    volontairement active d'une ligne héritée restée inactive.
-- -----------------------------------------------------------------------------

-- Les descripteurs de protocole, eux aussi, doivent exister dans TOUS les
-- environnements : la migration 20261114140000 les a introduits dans le dépôt
-- mais l'historique de production appliqué ne les contient pas. On les repose
-- ici de façon idempotente (aucune donnée existante n'est modifiée).
alter table saas_business.ai_providers
  add column if not exists adapter_kind text not null default 'openai'
    check (adapter_kind in ('openai', 'gemini', 'cloudflare', 'none')),
  add column if not exists default_base_url text,
  add column if not exists models_url text,
  add column if not exists default_headers jsonb not null default '{}'::jsonb,
  add column if not exists api_key_env text,
  add column if not exists account_id_env text,
  add column if not exists gateway_id_env text;

alter table saas_business.ai_providers
  add column if not exists transport text not null default 'rest'
    check (transport in ('rest', 'gateway')),
  add column if not exists is_aggregator boolean not null default false,
  add column if not exists integration_phase text,
  add column if not exists notes text;

comment on column saas_business.ai_providers.transport is
  'Voie d''appel : rest (API officielle du fournisseur) ou gateway (passerelle du fournisseur, ex. Cloudflare AI Gateway).';
comment on column saas_business.ai_providers.integration_phase is
  'Phase d''intégration qui a activé le fournisseur (traçabilité produit).';

-- -----------------------------------------------------------------------------
-- 2) Descripteurs — une ligne de registre par fournisseur, aucun secret
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_provider_upsert(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_key text := lower(btrim(coalesce(p_payload->>'provider_key', '')));
  v_name text := btrim(coalesce(p_payload->>'display_name', ''));
  v_kind text := lower(btrim(coalesce(p_payload->>'adapter_kind', 'openai')));
  v_transport text := lower(btrim(coalesce(p_payload->>'transport', 'rest')));
  v_base text := btrim(coalesce(p_payload->>'base_url', ''));
  v_models_url text := nullif(btrim(coalesce(p_payload->>'models_url', '')), '');
  v_key_env text := nullif(btrim(coalesce(p_payload->>'api_key_env', '')), '');
  v_account_env text := nullif(btrim(coalesce(p_payload->>'account_id_env', '')), '');
  v_gateway_env text := nullif(btrim(coalesce(p_payload->>'gateway_id_env', '')), '');
  v_headers jsonb := coalesce(p_payload->'headers', '{}'::jsonb);
  v_aggregator boolean := coalesce((p_payload->>'aggregator')::boolean, false);
  v_phase text := nullif(btrim(coalesce(p_payload->>'integration_phase', '')), '');
  v_notes text := nullif(btrim(coalesce(p_payload->>'notes', '')), '');
begin
  if v_key = '' or v_key !~ '^[a-z][a-z0-9_-]{1,39}$' then
    raise exception 'provider_key invalide (minuscules, chiffres, - et _, 2 à 40 caractères)';
  end if;
  if v_name = '' then raise exception 'display_name requis'; end if;
  if v_kind not in ('openai', 'gemini', 'cloudflare', 'none') then
    raise exception 'adapter_kind invalide';
  end if;
  if v_transport not in ('rest', 'gateway') then
    raise exception 'transport invalide (rest | gateway)';
  end if;
  if v_base = '' or v_base !~ '^https://' then
    raise exception 'base_url doit être une URL https';
  end if;

  insert into saas_business.ai_providers(
    provider_key, display_name, enabled, status, is_aggregator,
    adapter_kind, default_base_url, models_url, default_headers,
    api_key_env, account_id_env, transport, integration_phase, notes
  ) values (
    v_key, v_name, false, 'unverified', v_aggregator,
    v_kind, rtrim(v_base, '/'), v_models_url, v_headers,
    v_key_env, v_account_env, v_transport, v_phase, v_notes
  )
  on conflict (provider_key) do update set
    display_name = excluded.display_name,
    adapter_kind = excluded.adapter_kind,
    default_base_url = excluded.default_base_url,
    models_url = excluded.models_url,
    default_headers = excluded.default_headers,
    api_key_env = excluded.api_key_env,
    account_id_env = excluded.account_id_env,
    transport = excluded.transport,
    is_aggregator = excluded.is_aggregator,
    integration_phase = coalesce(excluded.integration_phase, saas_business.ai_providers.integration_phase),
    notes = coalesce(excluded.notes, saas_business.ai_providers.notes),
    updated_at = clock_timestamp();

  insert into saas_business.ai_provider_configs(provider_key, config_status)
  values (v_key, 'missing')
  on conflict (provider_key) do nothing;

  return jsonb_build_object(
    'provider_key', v_key,
    'enabled', (select enabled from saas_business.ai_providers where provider_key = v_key),
    'status', (select status from saas_business.ai_providers where provider_key = v_key),
    'adapter_kind', v_kind,
    'transport', v_transport,
    'base_url', rtrim(v_base, '/')
  );
end $$;

revoke all on function public.vyora_ai_provider_upsert(jsonb) from public, anon;
grant execute on function public.vyora_ai_provider_upsert(jsonb) to service_role;

-- La RPC d'administration historique (authenticated + vérification admin
-- interne) continue d'exister : elle délègue à la fonction ci-dessus.
create or replace function public.vyora_ai_admin_provider_upsert(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  return public.vyora_ai_provider_upsert(p_payload);
end $$;

revoke all on function public.vyora_ai_admin_provider_upsert(jsonb) from public, anon;
grant execute on function public.vyora_ai_admin_provider_upsert(jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 3) Descripteurs des 5 fournisseurs de la phase 1
--    Aucun secret : `api_key_env` / `account_id_env` / `gateway_id_env` ne
--    contiennent que des NOMS de variables Edge.
-- -----------------------------------------------------------------------------

select public.vyora_ai_provider_upsert(jsonb_build_object(
  'provider_key', 'openrouter',
  'display_name', 'OpenRouter',
  'adapter_kind', 'openai',
  'transport', 'rest',
  'base_url', 'https://openrouter.ai/api/v1',
  'models_url', 'https://openrouter.ai/api/v1/models',
  'api_key_env', 'BUSINESS_GROW_OPENROUTER_API_KEY',
  'headers', jsonb_build_object('HTTP-Referer', 'https://vyora-ugc.netlify.app', 'X-Title', 'VYORA'),
  'aggregator', true,
  'integration_phase', 'phase-1-2026-11-14',
  'notes', 'Routeur multi-modèles : catalogue live, prix publiés par modèle. Les modèles :free obéissent à un quota de requêtes (jamais illimité).'
));

select public.vyora_ai_provider_upsert(jsonb_build_object(
  'provider_key', 'gonka',
  'display_name', 'Gonka Broker',
  'adapter_kind', 'openai',
  'transport', 'rest',
  'base_url', 'https://proxy.gonkabroker.com/v1',
  'models_url', 'https://proxy.gonkabroker.com/v1/models',
  'api_key_env', 'BUSINESS_GROW_GONKA_API_KEY',
  'aggregator', false,
  'integration_phase', 'phase-1-2026-11-14',
  'notes', 'Proxy d''inférence compatible OpenAI et Anthropic. Pas de multimodal annoncé. Quotas de débit non publiés.'
));

select public.vyora_ai_provider_upsert(jsonb_build_object(
  'provider_key', 'llm7',
  'display_name', 'LLM7.io',
  'adapter_kind', 'openai',
  'transport', 'rest',
  'base_url', 'https://api.llm7.io/v1',
  'models_url', 'https://api.llm7.io/v1/models',
  'api_key_env', 'BUSINESS_GROW_LLM7_API_KEY',
  'aggregator', true,
  'integration_phase', 'phase-1-2026-11-14',
  'notes', 'Passerelle multi-modèles (texte, images, vidéos). Offre gratuite plafonnée à 100 000 jetons/24 h : le débit réel est contraignant.'
));

select public.vyora_ai_provider_upsert(jsonb_build_object(
  'provider_key', 'ollama',
  'display_name', 'Ollama Cloud',
  'adapter_kind', 'openai',
  'transport', 'rest',
  'base_url', 'https://ollama.com/v1',
  'models_url', null,
  'api_key_env', 'BUSINESS_GROW_OLLAMA_API_KEY',
  'aggregator', false,
  'integration_phase', 'phase-1-2026-11-14',
  'notes', 'Accès cloud direct (aucune installation locale). Pas de sorties structurées sur les modèles cloud. Catalogue de modèles cloud non exposé par une URL /models publique : à confirmer.'
));

-- Cloudflare : la voie d'appel dépend du type de jeton réellement déposé.
--   * jeton de passerelle (AI Gateway › Run) → transport = gateway ;
--   * jeton Workers AI (Workers AI › Read)  → transport = rest.
-- Les deux jetons ne sont pas interchangeables ; la sonde tranche, en réel.
select public.vyora_ai_provider_upsert(jsonb_build_object(
  'provider_key', 'cloudflare',
  'display_name', 'Cloudflare Workers AI',
  'adapter_kind', 'cloudflare',
  'transport', 'rest',
  'base_url', 'https://api.cloudflare.com/client/v4',
  'models_url', null,
  'api_key_env', 'BUSINESS_GROW_CLOUDFLARE_API_TOKEN',
  'account_id_env', 'BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID',
  'gateway_id_env', 'BUSINESS_GROW_CLOUDFLARE_GATEWAY_ID',
  'aggregator', false,
  'integration_phase', 'phase-1-2026-11-14',
  'notes', 'Workers AI derrière AI Gateway. Exige ACCOUNT_ID ; la voie gateway exige en plus GATEWAY_ID et un jeton AI Gateway › Run. Facturation en Neurons (10 000/jour offerts).'
));

-- -----------------------------------------------------------------------------
-- 4) Catalogue réel des modèles (`ai_catalog_models`)
--    Séparé de `ai_models` (registre servi) : le catalogue est la MATIÈRE
--    PREMIÈRE, le registre est la décision. Un modèle n'entre au registre
--    qu'après vérification réelle.
-- -----------------------------------------------------------------------------

create table if not exists saas_business.ai_catalog_models (
  provider_key text not null references saas_business.ai_providers(provider_key) on delete cascade,
  model_key text not null,
  provider_model_key text not null,
  display_name text not null,
  capabilities jsonb not null default '{}'::jsonb,
  context_in integer,
  max_out integer,
  cost_input_per_mtok_usd numeric(12,6),
  cost_output_per_mtok_usd numeric(12,6),
  tier text not null default 'standard'
    check (tier in ('fast','economy','standard','advanced','specialized','fallback')),
  note text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  /** Le fournisseur publie-t-il encore ce modèle ? (jamais supprimé : historique) */
  present boolean not null default true,
  primary key (provider_key, model_key)
);

comment on table saas_business.ai_catalog_models is
  'Catalogue normalisé publié par chaque fournisseur (prix et capacités publiés ou NULL). Alimenté par la sonde, jamais saisi à la main.';

alter table saas_business.ai_catalog_models enable row level security;
revoke all on saas_business.ai_catalog_models from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5) Quota observé (en-têtes 429 / limites annoncées)
-- -----------------------------------------------------------------------------

create table if not exists saas_business.ai_quota_observations (
  id bigserial primary key,
  provider_key text not null references saas_business.ai_providers(provider_key) on delete cascade,
  observed_on date not null default current_date,
  requests_blocked integer not null default 0,
  last_error_code text,
  last_limit_header jsonb not null default '{}'::jsonb,
  note text,
  updated_at timestamptz not null default now(),
  unique (provider_key, observed_on)
);

comment on table saas_business.ai_quota_observations is
  'Quotas réellement rencontrés : 429 comptés par fournisseur et par jour, en-têtes de limite quand le fournisseur les publie. Aucune limite inventée.';

alter table saas_business.ai_quota_observations enable row level security;
revoke all on saas_business.ai_quota_observations from public, anon, authenticated;

create or replace function public.vyora_ai_record_quota_signal(
  p_provider_key text,
  p_blocked boolean,
  p_error_code text default null,
  p_headers jsonb default '{}'::jsonb
) returns void
language sql security definer
set search_path = pg_catalog, saas_business
as $$
  insert into saas_business.ai_quota_observations(provider_key, observed_on, requests_blocked, last_error_code, last_limit_header)
  values (lower(p_provider_key), current_date, case when coalesce(p_blocked, false) then 1 else 0 end,
          p_error_code, coalesce(p_headers, '{}'::jsonb))
  on conflict (provider_key, observed_on) do update set
    requests_blocked = saas_business.ai_quota_observations.requests_blocked
      + case when coalesce(p_blocked, false) then 1 else 0 end,
    last_error_code = coalesce(excluded.last_error_code, saas_business.ai_quota_observations.last_error_code),
    last_limit_header = case
      when excluded.last_limit_header = '{}'::jsonb then saas_business.ai_quota_observations.last_limit_header
      else excluded.last_limit_header end,
    updated_at = now();
$$;

revoke all on function public.vyora_ai_record_quota_signal(text, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.vyora_ai_record_quota_signal(text, boolean, text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 6) Verrou d'idempotence des appels — anti-double-facturation
--    Un même `request_key` (décision métier + contenu) ne peut être exécuté
--    qu'une fois : un rejeu après timeout réseau renvoie le résultat existant
--    au lieu de payer un second appel chez le fournisseur.
-- -----------------------------------------------------------------------------

create table if not exists saas_business.ai_call_leases (
  request_key text primary key,
  space text not null default 'system',
  user_id uuid,
  workspace_id uuid,
  provider_key text,
  model_key text,
  status text not null default 'in_flight' check (status in ('in_flight','succeeded','failed')),
  outcome_code text,
  content_chars integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

comment on table saas_business.ai_call_leases is
  'Idempotence des appels IA : un rejeu du même request_key ne rappelle jamais le fournisseur (anti-double-facturation).';

alter table saas_business.ai_call_leases enable row level security;
revoke all on saas_business.ai_call_leases from public, anon, authenticated;

create or replace function public.vyora_ai_claim_call(
  p_request_key text,
  p_space text,
  p_user_id uuid default null,
  p_workspace_id uuid default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_row saas_business.ai_call_leases;
  v_claimed boolean := false;
begin
  if coalesce(p_request_key, '') = '' then
    raise exception 'request_key requis';
  end if;

  insert into saas_business.ai_call_leases(request_key, space, user_id, workspace_id, status)
  values (p_request_key, coalesce(p_space, 'system'), p_user_id, p_workspace_id, 'in_flight')
  on conflict (request_key) do nothing;

  update saas_business.ai_call_leases
     set status = 'in_flight', created_at = now(), expires_at = now() + interval '10 minutes',
         completed_at = null, outcome_code = null, content_chars = null
   where request_key = p_request_key
     and (status <> 'in_flight' or expires_at < now())
  returning * into v_row;

  if found then
    v_claimed := true;
  else
    select * into v_row from saas_business.ai_call_leases where request_key = p_request_key;
  end if;

  return jsonb_build_object(
    'claimed', v_claimed,
    'status', v_row.status,
    'provider_key', v_row.provider_key,
    'model_key', v_row.model_key,
    'outcome_code', v_row.outcome_code
  );
end $$;

revoke all on function public.vyora_ai_claim_call(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.vyora_ai_claim_call(text, text, uuid, uuid) to service_role;

create or replace function public.vyora_ai_release_call(
  p_request_key text,
  p_status text,
  p_provider_key text default null,
  p_model_key text default null,
  p_outcome_code text default null,
  p_content_chars integer default null
) returns void
language sql security definer
set search_path = pg_catalog, saas_business
as $$
  update saas_business.ai_call_leases
     set status = case when p_status in ('succeeded','failed') then p_status else 'failed' end,
         provider_key = coalesce(p_provider_key, provider_key),
         model_key = coalesce(p_model_key, model_key),
         outcome_code = p_outcome_code,
         content_chars = p_content_chars,
         completed_at = now()
   where request_key = p_request_key;
$$;

revoke all on function public.vyora_ai_release_call(text, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.vyora_ai_release_call(text, text, text, text, text, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 7) Journal de routage — traçabilité de la DÉCISION (pas seulement du résultat)
-- -----------------------------------------------------------------------------

create table if not exists saas_business.ai_routing_log (
  id bigserial primary key,
  space text not null default 'system',
  task_key text,
  role_key text,
  level text,
  request_key text,
  chain jsonb not null default '[]'::jsonb,
  chosen_provider text,
  chosen_model text,
  attempts integer not null default 0,
  skip_reason text,
  created_at timestamptz not null default now()
);

comment on table saas_business.ai_routing_log is
  'Décision de routage : chaîne ordonnée, raisons, modèle retenu. Alimente l''écran d''administration sans exposer de secret.';

alter table saas_business.ai_routing_log enable row level security;
revoke all on saas_business.ai_routing_log from public, anon, authenticated;

create or replace function public.vyora_ai_log_routing(p_payload jsonb)
returns void
language sql security definer
set search_path = pg_catalog, saas_business
as $$
  insert into saas_business.ai_routing_log(
    space, task_key, role_key, level, request_key, chain,
    chosen_provider, chosen_model, attempts, skip_reason
  ) values (
    coalesce(nullif(p_payload->>'space', ''), 'system'),
    nullif(p_payload->>'task_key', ''),
    nullif(p_payload->>'role_key', ''),
    nullif(p_payload->>'level', ''),
    nullif(p_payload->>'request_key', ''),
    coalesce(p_payload->'chain', '[]'::jsonb),
    nullif(p_payload->>'chosen_provider', ''),
    nullif(p_payload->>'chosen_model', ''),
    greatest(0, coalesce((p_payload->>'attempts')::integer, 0)),
    nullif(p_payload->>'skip_reason', '')
  );
$$;

revoke all on function public.vyora_ai_log_routing(jsonb) from public, anon, authenticated;
grant execute on function public.vyora_ai_log_routing(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 8) Lecture serveur des descripteurs (le moteur et la sonde n'ont besoin que
--    de ceci : ni clé, ni secret, uniquement la description du protocole)
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
-- 9) Enregistrement d'une sonde réelle
--    Le fournisseur ne devient `available` que si la sonde a réellement abouti.
--    Un échec le laisse indisponible mais ne l'efface pas (historique gardé).
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_record_probe(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_provider text := lower(btrim(coalesce(p_payload->>'provider_key', '')));
  v_catalog_ok boolean := coalesce((p_payload->>'catalog_ok')::boolean, false);
  v_completion_ok boolean := (p_payload->>'completion_ok')::boolean; -- NULL = non testé
  v_error text := nullif(p_payload->>'error_code', '');
  v_latency integer := coalesce((p_payload->>'latency_ms')::integer, 0);
  v_model text := nullif(p_payload->>'probe_model', '');
  v_status text;
begin
  if v_provider = '' then raise exception 'provider_key requis'; end if;

  v_status := case
    when v_completion_ok is true then 'available'
    when v_catalog_ok then 'degraded'
    else 'unavailable'
  end;

  update saas_business.ai_providers
     set status = v_status,
         enabled = (v_completion_ok is true),
         checked_at = now(),
         error_code = v_error,
         updated_at = clock_timestamp()
   where provider_key = v_provider;

  if not found then raise exception 'fournisseur inconnu: %', v_provider; end if;

  insert into saas_business.ai_provider_health_checks(provider_key, model_key, status, latency_ms, error_code, checked_at)
  values (v_provider, null, case when v_status = 'available' then 'healthy' else 'failed' end,
          v_latency, v_error, now());

  insert into saas_business.provider_health_cron_runs
    (provider_key, status, attempt, latency_ms, error_code, checked_at, detail)
  values (v_provider, case when v_status = 'available' then 'healthy' else 'failed' end, 1,
          v_latency, v_error, now(),
          jsonb_build_object('via', 'vyora-ai-providers',
                             'catalog_ok', v_catalog_ok,
                             'completion_ok', v_completion_ok,
                             'probe_model', v_model,
                             'reached', p_payload->>'reached'));

  if v_status = 'available' and v_model is not null then
    -- Le modèle réellement testé entre au registre, vérifié.
    insert into saas_business.ai_models(
      provider_key, model_key, provider_model_key, display_name, capabilities,
      enabled, verification_status, verified_at, max_input_tokens, max_output_tokens,
      tier, cost_input_per_mtok_usd, cost_output_per_mtok_usd, cost_source, cost_note
    )
    select c.provider_key, c.model_key, c.provider_model_key, c.display_name, c.capabilities,
           true, 'verified', now(), c.context_in, c.max_out,
           c.tier, c.cost_input_per_mtok_usd, c.cost_output_per_mtok_usd,
           case when c.cost_input_per_mtok_usd is null then null else 'announced' end, c.note
      from saas_business.ai_catalog_models c
     where c.provider_key = v_provider and c.provider_model_key = v_model
    on conflict (provider_key, provider_model_key) do update set
      display_name = excluded.display_name,
      capabilities = excluded.capabilities,
      enabled = true,
      verification_status = 'verified',
      verified_at = now(),
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      tier = excluded.tier,
      cost_input_per_mtok_usd = excluded.cost_input_per_mtok_usd,
      cost_output_per_mtok_usd = excluded.cost_output_per_mtok_usd,
      cost_source = excluded.cost_source,
      cost_note = excluded.cost_note;
  end if;

  return jsonb_build_object(
    'provider_key', v_provider,
    'status', v_status,
    'enabled', (v_completion_ok is true),
    'probe_model', v_model
  );
end $$;

revoke all on function public.vyora_ai_record_probe(jsonb) from public, anon, authenticated;
grant execute on function public.vyora_ai_record_probe(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 10) Synchronisation du catalogue (insertion + mise à jour, jamais de perte)
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_sync_catalog(p_provider_key text, p_models jsonb)
returns integer
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_provider text := lower(btrim(coalesce(p_provider_key, '')));
  v_count integer := 0;
begin
  if v_provider = '' then raise exception 'provider_key requis'; end if;
  if jsonb_typeof(p_models) <> 'array' then raise exception 'p_models doit être un tableau'; end if;

  -- Le catalogue précédent reste en base mais n'est plus marqué « présent » :
  -- un modèle retiré par le fournisseur disparaît du routage sans effacer son
  -- historique de coûts.
  update saas_business.ai_catalog_models
     set present = false
   where provider_key = v_provider;

  insert into saas_business.ai_catalog_models(
    provider_key, model_key, provider_model_key, display_name, capabilities,
    context_in, max_out, cost_input_per_mtok_usd, cost_output_per_mtok_usd, tier, note
  )
  select
    v_provider,
    left(btrim(m->>'model_key'), 80),
    left(btrim(m->>'provider_model'), 200),
    left(coalesce(nullif(btrim(m->>'display_name'), ''), m->>'provider_model'), 200),
    coalesce(m->'capabilities', '{}'::jsonb),
    (m->>'context_in')::integer,
    (m->>'max_out')::integer,
    (m->>'cost_in')::numeric,
    (m->>'cost_out')::numeric,
    coalesce(nullif(m->>'tier', ''), 'standard'),
    nullif(m->>'note', '')
  from jsonb_array_elements(p_models) m
  where coalesce(btrim(m->>'model_key'), '') <> ''
    and coalesce(btrim(m->>'provider_model'), '') <> ''
  on conflict (provider_key, model_key) do update set
    provider_model_key = excluded.provider_model_key,
    display_name = excluded.display_name,
    capabilities = excluded.capabilities,
    context_in = excluded.context_in,
    max_out = excluded.max_out,
    cost_input_per_mtok_usd = excluded.cost_input_per_mtok_usd,
    cost_output_per_mtok_usd = excluded.cost_output_per_mtok_usd,
    tier = excluded.tier,
    note = excluded.note,
    last_seen_at = now(),
    present = true;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.vyora_ai_sync_catalog(text, jsonb) from public, anon, authenticated;
grant execute on function public.vyora_ai_sync_catalog(text, jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 11) Snapshot du registre — version 4 : descripteur complet + catalogue
--     (le moteur ne relit plus la base pour connaître les protocoles)
-- -----------------------------------------------------------------------------

create or replace function saas_business.bg_ai_registry_snapshot()
returns jsonb
language sql
security definer stable
set search_path = pg_catalog, saas_business
as $$
  select jsonb_build_object(
    'version', 4,
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

-- -----------------------------------------------------------------------------
-- 12) Vue d'administration : quota observé + catalogue + état des fournisseurs
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_admin_integration_status()
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, saas_business
as $$
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  return jsonb_build_object(
    'phase', 'phase-1-2026-11-14',
    'providers', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', p.provider_key,
        'name', p.display_name,
        'status', p.status,
        'enabled', p.enabled,
        'transport', p.transport,
        'adapter_kind', p.adapter_kind,
        'checked_at', p.checked_at,
        'error_code', p.error_code,
        'catalog_models', (select count(*) from saas_business.ai_catalog_models c
                            where c.provider_key = p.provider_key and c.present),
        'verified_models', (select count(*) from saas_business.ai_models m
                             where m.provider_key = p.provider_key
                               and m.verification_status = 'verified'),
        'last_quota', (select to_jsonb(q) from saas_business.ai_quota_observations q
                        where q.provider_key = p.provider_key
                        order by q.observed_on desc limit 1)
      ) order by p.provider_key), '[]'::jsonb)
      from saas_business.ai_providers p
      where p.integration_phase is not null
    ),
    'routing_last_24h', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'role_key', role_key,
        'chosen_provider', chosen_provider,
        'chosen_model', chosen_model,
        'attempts', attempts,
        'skip_reason', skip_reason,
        'created_at', created_at
      ) order by created_at desc), '[]'::jsonb)
      from (select * from saas_business.ai_routing_log
             where created_at > now() - interval '24 hours'
             order by created_at desc limit 50) r
    ),
    'spend_by_provider', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'provider', provider_key,
        'calls', calls,
        'cost_usd', cost_usd
      ) order by cost_usd desc), '[]'::jsonb)
      from (
        select provider_key,
               count(*) as calls,
               round(sum(coalesce(cost_input_usd,0) + coalesce(cost_output_usd,0)), 6) as cost_usd
          from saas_business.ai_calls_log
         where created_at >= date_trunc('month', now())
         group by provider_key
      ) s
    )
  );
end $$;

revoke all on function public.vyora_ai_admin_integration_status() from public, anon;
grant execute on function public.vyora_ai_admin_integration_status() to authenticated;
