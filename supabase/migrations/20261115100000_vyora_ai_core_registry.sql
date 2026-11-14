-- =============================================================================
-- VYORA AI CORE — Registre multi-fournisseurs, coûts, mémoire persistante,
-- gouvernance (migration 20261115100000)
--
-- Additive, non-destructive. S'appuie sur le registre créé par
-- 20261110172827 / 20261110172909 (ai_providers, ai_provider_configs,
-- ai_models, ai_roles, ai_routing_rules, ai_provider_health_checks).
--
-- Prix officiels vérifiés le 2026-11-13 (sources) :
--   Groq       : console.groq.com/docs/models
--   Gemini     : aistudio.google.com/docs/pricing
--   DeepSeek   : api-docs.deepseek.com/quick_start/pricing (valeurs pic)
--   Mistral    : docs.mistral.ai (prix non publiés sur les pages récupérées → NULL)
--   Grok (xAI) : docs.x.ai/developers/models
--   OpenRouter : openrouter.ai/api/v1/models (catalogue officiel vivant)
--   Cloudflare : developers.cloudflare.com/workers-ai/models
--
-- Politique de vérité : tout modèle reste enabled=false / 'unverified'
-- jusqu'à preuve par une sonde API réelle (bg_record_health_check).
-- Aucun quota ni disponibilité n'est inventé : les limites annoncées ne
-- sont portées que quand la source officielle les publie.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Fournisseurs : agrégateur, limites annoncées/configurées, free tiers
-- -----------------------------------------------------------------------------

alter table saas_business.ai_providers
  add column if not exists is_aggregator boolean not null default false,
  add column if not exists announced_rpm integer check (announced_rpm is null or announced_rpm > 0),
  add column if not exists configured_rpm integer check (configured_rpm is null or configured_rpm > 0),
  add column if not exists announced_tpm integer check (announced_tpm is null or announced_tpm > 0),
  add column if not exists configured_tpm integer check (configured_tpm is null or configured_tpm > 0),
  add column if not exists free_tier_note text;

insert into saas_business.ai_providers(provider_key, display_name, enabled, status, is_aggregator, free_tier_note)
values
  ('openrouter', 'OpenRouter', false, 'unverified', true,
   'Agrégateur de modèles : les prix et limites proviennent du catalogue officiel (openrouter.ai/api/v1/models) et sont resynchronisés à chaque sonde. Les modèles “free” y sont limités par quota — jamais illimités ni garantis.'),
  ('cloudflare', 'Cloudflare Workers AI', false, 'unverified', false,
   'Le forfait gratuit Cloudflare est journalier et limité en jetons (jamais illimité). Nécessite CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AUTH_TOKEN (secrets serveur).'),
  ('grok', 'Grok (xAI)', false, 'unverified', false, NULL)
on conflict (provider_key) do nothing;

insert into saas_business.ai_provider_configs(provider_key, config_status)
values
  ('openrouter', 'missing'),
  ('cloudflare', 'missing'),
  ('grok', 'missing')
on conflict (provider_key) do nothing;

-- Groq : plusieurs modèles passés en “Enterprise / Contact Sales” (docs officiel
-- récupéré 2026-11-13) — le prix public n'est plus publié pour ces références.
update saas_business.ai_providers
set free_tier_note = coalesce(
      free_tier_note,
      'Plusieurs modèles Groq (llama-3.1-8b-instant, llama-3.3-70b-versatile) sont listés “Enterprise — Contact Sales” dans la documentation officielle : prix public indisponible, coût inconnu tant qu''un contrat n''est pas signé.'
    )
where provider_key = 'groq';

-- -----------------------------------------------------------------------------
-- 2) Modèles : niveaux (tiers), coûts par 1M tokens, limites annoncées
-- -----------------------------------------------------------------------------

alter table saas_business.ai_models
  add column if not exists tier text not null default 'standard'
    check (tier in ('fast','economy','standard','advanced','specialized','fallback')),
  add column if not exists cost_input_per_mtok_usd numeric(10,6)
    check (cost_input_per_mtok_usd is null or cost_input_per_mtok_usd >= 0),
  add column if not exists cost_output_per_mtok_usd numeric(10,6)
    check (cost_output_per_mtok_usd is null or cost_output_per_mtok_usd >= 0),
  add column if not exists cost_source text
    check (cost_source is null or cost_source in ('announced','configured','observed')),
  add column if not exists cost_note text,
  add column if not exists announced_rpm integer check (announced_rpm is null or announced_rpm > 0),
  add column if not exists announced_tpm integer check (announced_tpm is null or announced_tpm > 0);

-- Niveaux + coûts des modèles déjà présents au catalogue (seedés par les
-- migrations 20261110172909 et 20261110175418 — enrichis, jamais dupliqués).
update saas_business.ai_models
set tier = 'fast', cost_input_per_mtok_usd = 0.075, cost_output_per_mtok_usd = 0.30,
    cost_source = 'announced', announced_rpm = 1000, announced_tpm = 250000,
    capabilities = capabilities || '{"tools":true}'::jsonb
where provider_key = 'groq' and model_key = 'openai-gpt-oss-20b';
update saas_business.ai_models
set tier = 'advanced', cost_input_per_mtok_usd = 0.15, cost_output_per_mtok_usd = 0.60,
    cost_source = 'announced', announced_rpm = 1000, announced_tpm = 250000
where provider_key = 'groq' and model_key = 'openai-gpt-oss-120b';
update saas_business.ai_models
set tier = 'advanced', cost_input_per_mtok_usd = 0.80, cost_output_per_mtok_usd = 4.00,
    cost_source = 'announced', cost_note = 'Modèle “preview” dans la documentation Groq.',
    announced_rpm = 1000, announced_tpm = 250000
where provider_key = 'groq' and model_key = 'qwen-qwen3.8-27b';
update saas_business.ai_models set tier = 'fast'
where provider_key = 'gemini' and model_key in ('gemini-2.5-flash','gemini-2.5-flash-lite','gemini-3-flash-preview');
update saas_business.ai_models set tier = 'economy'
where provider_key = 'gemini' and model_key = 'gemini-3.5-flash';
update saas_business.ai_models set tier = 'standard',
  cost_note = 'Modèle legacy : plus listé sur la page de prix officielle DeepSeek (2026-11-13). Coût inconnu.'
where provider_key = 'deepseek' and model_key = 'deepseek-chat';
update saas_business.ai_models set tier = 'advanced'
where provider_key = 'mistral' and model_key = 'mistral-large-latest';

insert into saas_business.ai_models(
  provider_key, model_key, provider_model_key, display_name, capabilities,
  enabled, verification_status, max_input_tokens, max_output_tokens,
  tier, cost_input_per_mtok_usd, cost_output_per_mtok_usd, cost_source, cost_note,
  announced_rpm, announced_tpm
) values
  -- Gemini (aistudio.google.com/docs/pricing)
  ('gemini', 'gemini-4-hydrogen', 'gemini-4-hydrogen', 'Gemini 4 Hydrogen',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'economy', 1.50, 7.50, 'announced', 'Disponible sur le free tier (quotas journaliers limités, jamais garantis).', NULL, NULL),
  ('gemini', 'gemini-4-carbon', 'gemini-4-carbon', 'Gemini 4 Carbon',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'advanced', 2.00, 10.00, 'announced', 'Tarif promo jusqu''au 30/11/2026, puis 4,00 / 20,00 USD par 1M tokens.', NULL, NULL),
  ('gemini', 'gemini-4-argon', 'gemini-4-argon', 'Gemini 4 Argon',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'advanced', 2.00, 10.00, 'announced', 'Tarif promo jusqu''au 30/11/2026, puis 4,00 / 20,00 USD par 1M tokens.', NULL, NULL),
  ('gemini', 'gemini-3.8-flash', 'gemini-3.8-flash', 'Gemini 3.8 Flash',
   '{"writing":true,"documents":true,"images":true,"tools":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'fast', 0.75, 3.75, 'announced', 'Disponible sur le free tier. Tarif promo jusqu''au 31/12/2026, puis 1,50 / 7,50 USD par 1M tokens.', NULL, NULL),
  -- DeepSeek (api-docs.deepseek.com — valeurs PIC ; l''off-peak est à 50 %)
  ('deepseek', 'deepseek-flash', 'deepseek-flash', 'DeepSeek Flash (V4.1)',
   '{"writing":true,"reasoning":true,"documents":true,"images":true,"tools":true}'::jsonb, false, 'unverified', 1048576, 32768,
   'economy', 0.30, 1.20, 'announced', 'Prix pic (cache manqué). Off-peak : 0,15 / 0,60. Cache hit : 0,006.', NULL, NULL),
  ('deepseek', 'deepseek-v4-pro', 'deepseek-v4-pro', 'DeepSeek V4 Pro',
   '{"writing":true,"reasoning":true,"documents":true,"tools":true}'::jsonb, false, 'unverified', 1048576, 32768,
   'advanced', 0.044, 0.396, 'announced', 'Prix pic. Off-peak : 0,022 / 0,198.', NULL, NULL),
  -- Mistral (docs.mistral.ai — prix non publiés sur les pages récupérées)
  ('mistral', 'mistral-small-latest', 'mistral-small-latest', 'Mistral Small',
   '{"writing":true,"documents":true,"tools":true}'::jsonb, false, 'unverified', 131072, 8192,
   'economy', NULL, NULL, NULL, 'Prix non public sur la documentation récupérée le 2026-11-13 : à confirmer sur le console avant activation.', NULL, NULL),
  ('mistral', 'open-mistral-nemo', 'open-mistral-nemo', 'Open Mistral Nemo',
   '{"writing":true,"documents":true}'::jsonb, false, 'unverified', 131072, 8192,
   'economy', NULL, NULL, NULL, 'Prix non public sur la documentation récupérée le 2026-11-13 : à confirmer sur le console avant activation.', NULL, NULL),
  -- Grok / xAI (docs.x.ai/developers/models)
  ('grok', 'grok-4.7', 'grok-4.7', 'Grok 4.7',
   '{"writing":true,"reasoning":true,"documents":true,"images":true,"tools":true}'::jsonb, false, 'unverified', 524288, 16384,
   'advanced', 2.00, 6.00, 'announced', 'Prompt < 200k tokens ; au-delà : 4,00 / 12,00.', NULL, NULL),
  ('grok', 'grok-4.3', 'grok-4.3', 'Grok 4.3',
   '{"writing":true,"reasoning":true,"documents":true,"images":true,"tools":true}'::jsonb, false, 'unverified', 1048576, 16384,
   'standard', 1.25, 2.50, 'announced', 'Prompt < 200k tokens ; au-delà : 2,50 / 5,00.', NULL, NULL),
  ('grok', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-reasoning', 'Grok 4.20 (raisonnement)',
   '{"reasoning":true,"tools":true}'::jsonb, false, 'unverified', 1048576, 16384,
   'specialized', 1.25, 2.50, 'announced', 'Variante reasoning du 03/09 ; prompt < 200k tokens.', NULL, NULL),
  -- OpenRouter (catalogue officiel vivant openrouter.ai/api/v1/models)
  ('openrouter', 'gemini-4-hydrogen', 'google/gemini-4-hydrogen', 'Gemini 4 Hydrogen (via OpenRouter)',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'economy', 1.50, 7.50, 'announced',
   'Accès agrégé du modèle déjà disponible directement chez Google : la garde de routage interdit le double routage du même modèle pour un même rôle.', NULL, NULL),
  ('openrouter', 'ernie-5.5-flash-free', 'baidu/ernie-5.5-flash-preview:free', 'ERNIE 5.5 Flash (free, via OpenRouter)',
   '{"writing":true,"reasoning":true}'::jsonb, false, 'unverified', 1024000, 65536,
   'fallback', 0, 0, 'announced', 'Modèle free OpenRouter : quotas limités, jamais illimités ni garantis.', NULL, NULL),
  ('openrouter', 'ling-3.2-flash-free', 'inclusionai/ling-3.2-flash:free', 'Ling 3.2 Flash (free, via OpenRouter)',
   '{"writing":true,"reasoning":true,"images":true}'::jsonb, false, 'unverified', 1048576, 65536,
   'fallback', 0, 0, 'announced', 'Modèle free OpenRouter : quotas limités, jamais illimités ni garantis.', NULL, NULL),
  -- Cloudflare Workers AI (developers.cloudflare.com/workers-ai/models)
  ('cloudflare', 'qwen3.8-27b-cf', '@cf/qwen/qwen3.8-27b', 'Qwen 3.8 27B (Workers AI)',
   '{"writing":true,"reasoning":true,"documents":true,"images":true,"tools":true}'::jsonb, false, 'unverified', 262144, 32768,
   'economy', 0.45, 3.20, 'announced', 'Zéro rétention de données ; cache : 0,05 / 1M tokens.', NULL, NULL),
  ('cloudflare', 'embeddinggemma-2-cf', '@cf/google/embeddinggemma-2', 'EmbeddingGemma 2 (Workers AI)',
   '{"embeddings":true}'::jsonb, false, 'unverified', 8192, NULL,
   'specialized', NULL, NULL, NULL, 'Modèle d''embeddings 768 dimensions — utilisé pour la mémoire sémantique de l''agent.', NULL, NULL)
on conflict (provider_key, model_key) do nothing;

-- -----------------------------------------------------------------------------
-- 3) Garde anti-double-routage : un même modèle de base ne peut être routé
--    qu'une seule fois par rôle (agrégateur OU accès direct, jamais les deux)
-- -----------------------------------------------------------------------------

-- Clé de base normalisée d'un modèle : dernier segment après "/" (les
-- agrégateurs préfixent “éditeur/modèle”, l'accès direct non) —
-- ex. “google/gemini-4-hydrogen” → “gemini-4-hydrogen”.
create or replace function saas_business.bg_model_base_key(p_provider_model_key text)
returns text
language sql security definer immutable strict set search_path = '' as $$
  select lower(regexp_split_to_table(p_provider_model_key, '/'))
  order by 1 desc limit 1
$$;

revoke all on function saas_business.bg_model_base_key(text)
  from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

create or replace function saas_business.bg_routing_duplicate_guard()
returns trigger
language plpgsql set search_path = pg_catalog, saas_business as $$
declare
  v_norm text;
begin
  select saas_business.bg_model_base_key(m.provider_model_key) into v_norm
  from saas_business.ai_models m
  where m.provider_key = new.provider_key and m.model_key = new.model_key;
  if v_norm is null then
    raise exception 'unknown model in routing rule (% / %)', new.provider_key, new.model_key;
  end if;
  if exists (
    select 1
    from saas_business.ai_routing_rules r
    join saas_business.ai_models rm
      on rm.provider_key = r.provider_key and rm.model_key = r.model_key
    where r.role_key = new.role_key
      and r.id is distinct from new.id
      and saas_business.bg_model_base_key(rm.provider_model_key) = v_norm
  ) then
    raise exception
      'duplicate model routing for role % : the model % is already routed for this role via another access path. Keep a single path to avoid double routing and double billing.',
      new.role_key, v_norm;
  end if;
  return new;
end $$;

create trigger routing_duplicate_guard
before insert or update on saas_business.ai_routing_rules
for each row execute function saas_business.bg_routing_duplicate_guard();

revoke all on function saas_business.bg_routing_duplicate_guard() from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

-- -----------------------------------------------------------------------------
-- 4) Règles de routage pour les nouveaux fournisseurs
--    (actives dès que fournisseur + modèle seront vérifiés sains par les sondes)
-- -----------------------------------------------------------------------------

-- Priorité 4 : après le trio Groq (1-3), avant la pile Gemini (10-13).
-- NB : le modèle Cloudflare qwen3.8-27b est volontairement NON routé — son
-- modèle de base “qwen3.8-27b” est déjà routé via Groq (garde anti-doublon) ;
-- l'administrateur pourra l'activer en secours une fois la duplication levée.
insert into saas_business.ai_routing_rules(role_key, provider_key, model_key, priority, enabled)
values
  ('business_advisor',  'deepseek',   'deepseek-flash',       4, true),
  ('business_analysis', 'grok',       'grok-4.3',             4, true),
  ('content_strategy',  'deepseek',   'deepseek-v4-pro',      4, true),
  ('marketing_campaign','mistral',    'mistral-small-latest', 4, true),
  ('sales_analysis',    'gemini',     'gemini-4-hydrogen',    4, true)
on conflict (role_key, priority) do nothing;

-- -----------------------------------------------------------------------------
-- 5) Journal d'appels IA central (tokens, coûts, latence, statut)
-- -----------------------------------------------------------------------------

create table saas_business.ai_calls_log (
  id uuid primary key default gen_random_uuid(),
  space text not null check (space in ('business','studio','system')),
  user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete set null,
  task_key text,
  provider_key text not null references saas_business.ai_providers on delete restrict,
  model_key text,
  provider_model_key text,
  attempt_number integer not null default 1 check (attempt_number >= 1),
  status text not null check (status in ('success','error','timeout','blocked')),
  error_code text,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  cost_input_usd numeric(12,6) check (cost_input_usd is null or cost_input_usd >= 0),
  cost_output_usd numeric(12,6) check (cost_output_usd is null or cost_output_usd >= 0),
  fallback_from text,
  created_at timestamptz not null default now()
);

create index ai_calls_provider_created_idx on saas_business.ai_calls_log(provider_key, created_at desc);
create index ai_calls_user_created_idx on saas_business.ai_calls_log(user_id, created_at desc) where user_id is not null;
create index ai_calls_space_created_idx on saas_business.ai_calls_log(space, created_at desc);
create index ai_calls_task_idx on saas_business.ai_calls_log(task_key, created_at desc) where task_key is not null;

alter table saas_business.ai_calls_log enable row level security;
-- Aucune politique client : journal serveur uniquement (lecture par l'admin via
-- des fonctions SECURITY DEFINER, écriture par les fonctions de log serveur).

-- Écriture serveur (moteur vyora-ai en service_role + handler business-grow en
-- bg_edge). Jamais accessible à anon / authenticated.
create or replace function public.vyora_ai_log_call(
  p_space text,
  p_user_id uuid,
  p_workspace_id uuid,
  p_task_key text,
  p_provider_key text,
  p_model_key text,
  p_provider_model_key text,
  p_attempt_number integer,
  p_status text,
  p_error_code text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer,
  p_cost_input_usd numeric,
  p_cost_output_usd numeric,
  p_fallback_from text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
declare v_id uuid;
begin
  if p_space not in ('business','studio','system')
     or p_status not in ('success','error','timeout','blocked')
     or p_provider_key is null or btrim(p_provider_key) = ''
     or p_attempt_number is null or p_attempt_number < 1 then
    raise exception 'invalid ai call log payload';
  end if;
  insert into saas_business.ai_calls_log(
    space, user_id, workspace_id, task_key, provider_key, model_key,
    provider_model_key, attempt_number, status, error_code,
    input_tokens, output_tokens, latency_ms, cost_input_usd, cost_output_usd,
    fallback_from
  ) values (
    p_space, p_user_id, p_workspace_id, p_task_key, p_provider_key, p_model_key,
    p_provider_model_key, p_attempt_number, p_status, p_error_code,
    p_input_tokens, p_output_tokens, p_latency_ms, p_cost_input_usd, p_cost_output_usd,
    p_fallback_from
  ) returning id into v_id;
  return v_id;
end $$;

revoke all on function public.vyora_ai_log_call(text,uuid,uuid,text,text,text,text,integer,text,text,integer,integer,integer,numeric,numeric,text) from public, anon, authenticated;
grant execute on function public.vyora_ai_log_call(text,uuid,uuid,text,text,text,text,integer,text,text,integer,integer,integer,numeric,numeric,text) to service_role, bg_edge;

-- -----------------------------------------------------------------------------
-- 6) Réglages d'administration IA (budgets, seuils d'alerte)
-- -----------------------------------------------------------------------------

create table saas_business.ai_admin_settings (
  key text primary key default 'global' check (key = 'global'),
  monthly_budget_usd numeric(10,2) check (monthly_budget_usd is null or monthly_budget_usd >= 0),
  alert_threshold_pct integer not null default 80 check (alert_threshold_pct between 0 and 100),
  max_daily_cost_usd numeric(10,2) check (max_daily_cost_usd is null or max_daily_cost_usd >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into saas_business.ai_admin_settings(key, monthly_budget_usd, alert_threshold_pct, max_daily_cost_usd)
values ('global', null, 80, null)
on conflict (key) do nothing;

alter table saas_business.ai_admin_settings enable row level security;
-- Aucune politique client : les réglages ne se lisent/s'écrivent que via les
-- fonctions administratives ci-dessous (vérification admin interne).

create or replace function public.vyora_ai_admin_settings_get()
returns jsonb
language plpgsql security definer stable set search_path = pg_catalog, saas_business as $$
declare v_settings saas_business.ai_admin_settings%rowtype;
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  select * into v_settings from saas_business.ai_admin_settings where key = 'global';
  if not found then return '{}'::jsonb; end if;
  return jsonb_build_object(
    'monthly_budget_usd', v_settings.monthly_budget_usd,
    'alert_threshold_pct', v_settings.alert_threshold_pct,
    'max_daily_cost_usd', v_settings.max_daily_cost_usd,
    'updated_at', v_settings.updated_at
  );
end $$;

create or replace function public.vyora_ai_admin_settings_set(
  p_monthly_budget_usd numeric,
  p_alert_threshold_pct integer,
  p_max_daily_cost_usd numeric
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, saas_business as $$
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  if p_alert_threshold_pct is not null and (p_alert_threshold_pct < 0 or p_alert_threshold_pct > 100) then
    raise exception 'invalid alert threshold';
  end if;
  if (p_monthly_budget_usd is not null and p_monthly_budget_usd < 0)
     or (p_max_daily_cost_usd is not null and p_max_daily_cost_usd < 0) then
    raise exception 'invalid budget';
  end if;
  update saas_business.ai_admin_settings
  set monthly_budget_usd = coalesce(p_monthly_budget_usd, monthly_budget_usd),
      alert_threshold_pct = coalesce(p_alert_threshold_pct, alert_threshold_pct),
      max_daily_cost_usd = coalesce(p_max_daily_cost_usd, max_daily_cost_usd),
      updated_by = auth.uid(),
      updated_at = clock_timestamp()
  where key = 'global';
  return public.vyora_ai_admin_settings_get();
end $$;

revoke all on function public.vyora_ai_admin_settings_get() from public, anon;
revoke all on function public.vyora_ai_admin_settings_set(numeric,integer,numeric) from public, anon;
grant execute on function public.vyora_ai_admin_settings_get() to authenticated;
grant execute on function public.vyora_ai_admin_settings_set(numeric,integer,numeric) to authenticated;

-- -----------------------------------------------------------------------------
-- 7) Mémoire persistante de l'agent IA (indépendante du fournisseur)
--
-- Catégories : conversation, user, company, domain (métier), decision,
-- operational, document. La mémoire est versionnée (supersedes /
-- superseded_by), expirable (valid_until), oubliable (deleted_at — tombstone,
-- jamais de hard delete de l'audit) et distinguée par niveau de confiance
-- (fact / hypothesis / uncertain).
--
-- Isolement multi-entreprise : chaque ligne porte user_id ET workspace_id ;
-- la recherche ne mélange jamais deux workspaces (filtre + vérification
-- d'appartenance). L'embedding est un tableau double precision (portable) ;
-- en production, pgvector ajoute un index HNSW sur une colonne miroir.
-- -----------------------------------------------------------------------------

create table saas_business.ai_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  category text not null
    check (category in ('conversation','user','company','domain','decision','operational','document')),
  title text check (title is null or char_length(title) <= 200),
  content text not null check (char_length(content) between 1 and 8000),
  confidence text not null default 'fact' check (confidence in ('fact','hypothesis','uncertain')),
  source text check (source is null or char_length(source) <= 300),
  embedding double precision[] check (cardinality(embedding) = 0 or cardinality(embedding) between 32 and 4096),
  search_tsv tsvector generated always as (to_tsvector('simple', coalesce(title, '') || ' ' || content)) stored,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  supersedes uuid references saas_business.ai_memories(id) on delete set null,
  superseded_by uuid references saas_business.ai_memories(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_memories_not_both_supersede check (not (supersedes is not null and superseded_by is not null))
);

create index ai_memories_user_idx on saas_business.ai_memories(user_id, created_at desc) where deleted_at is null;
create index ai_memories_workspace_idx on saas_business.ai_memories(workspace_id, category)
  where workspace_id is not null and deleted_at is null;
create index ai_memories_tsv_idx on saas_business.ai_memories using gin(search_tsv);
create index ai_memories_active_idx on saas_business.ai_memories(user_id, category)
  where deleted_at is null and superseded_by is null;

alter table saas_business.ai_memories enable row level security;
-- Politique d'accès adaptée (deny-by-default) : RLS activée et AUCUNE politique
-- client → toute lecture ou écriture DIRECTE est refusée (le rôle bg_owner ne
-- dispose d'ailleurs d'aucun grant sur la table). L'isolation
-- par-utilisateur/workspace est forcée ET testée dans les RPC ci-dessous
-- (bg_assert_workspace_access sur chaque appel) : un utilisateur ne voit que
-- sa propre mémoire ou celle d'un workspace dont il est propriétaire/membre,
-- jamais celle d'une autre entreprise.

-- Similarité cosinus portable (sans dépendre de pgvector)
create or replace function saas_business.cosine_similarity(a double precision[], b double precision[])
returns double precision
language plpgsql security definer immutable strict set search_path = '' as $$
declare
  n integer;
  i integer;
  v_dot double precision := 0;
  v_na double precision := 0;
  v_nb double precision := 0;
begin
  if a is null or b is null then return null; end if;
  n := array_length(a, 1);
  if n is distinct from array_length(b, 1) then return null; end if;
  for i in 1..n loop
    v_dot := v_dot + a[i] * b[i];
    v_na := v_na + a[i] * a[i];
    v_nb := v_nb + b[i] * b[i];
  end loop;
  if v_na = 0 or v_nb = 0 then return 0; end if;
  return v_dot / (sqrt(v_na) * sqrt(v_nb));
end $$;

-- Vérifie que p_user_id appartient au workspace (propriétaire ou membre)
create or replace function saas_business.bg_assert_workspace_access(p_user_id uuid, p_workspace_id uuid)
returns void
language plpgsql security definer stable set search_path = pg_catalog, saas_business, saas_ugc as $$
begin
  if p_workspace_id is null then return; end if;
  if not exists (
    select 1 from saas_ugc.ugc_workspaces w
    where w.id = p_workspace_id
      and (w.owner_user_id = p_user_id or exists (
        select 1 from saas_ugc.ugc_workspace_members m
        where m.workspace_id = w.id and m.user_id = p_user_id
      ))
  ) then
    raise exception 'workspace access denied';
  end if;
end $$;

-- Écriture d'une mémoire (avec versionnement : supersedes l'ancienne ligne)
create or replace function saas_business.ai_memory_save(
  p_user_id uuid,
  p_workspace_id uuid,
  p_category text,
  p_title text,
  p_content text,
  p_confidence text,
  p_source text,
  p_supersedes uuid
) returns uuid
language plpgsql security definer set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v_new uuid;
  v_old record;
begin
  if p_user_id is null
     or p_category not in ('conversation','user','company','domain','decision','operational','document')
     or p_content is null or char_length(btrim(p_content)) < 3 or char_length(p_content) > 8000
     or p_confidence not in ('fact','hypothesis','uncertain') then
    raise exception 'invalid memory payload';
  end if;
  perform saas_business.bg_assert_workspace_access(p_user_id, p_workspace_id);

  if p_supersedes is not null then
    select id, user_id, workspace_id into v_old
    from saas_business.ai_memories
    where id = p_supersedes for update;
    if not found or v_old.deleted_at is not null then
      raise exception 'memory to supersede not found';
    end if;
    if v_old.user_id <> p_user_id or v_old.workspace_id is distinct from p_workspace_id then
      raise exception 'cannot supersede a memory from another scope';
    end if;
  end if;

  insert into saas_business.ai_memories(
    user_id, workspace_id, category, title, content, confidence, source, supersedes
  ) values (
    p_user_id, p_workspace_id, p_category, p_title, btrim(p_content),
    coalesce(p_confidence, 'fact'), p_source, p_supersedes
  ) returning id into v_new;

  if p_supersedes is not null then
    update saas_business.ai_memories set superseded_by = v_new, updated_at = clock_timestamp()
    where id = p_supersedes;
  end if;
  return v_new;
end $$;

-- Recherche : plein texte + fraîcheur + similarité sémantique (si embedding
-- fourni) ; jamais de mélange de workspaces ; mémoire expirée ou remplacée
-- exclue. Score lisible et déterministe.
create or replace function saas_business.ai_memory_search(
  p_user_id uuid,
  p_workspace_id uuid,
  p_query text,
  p_embedding double precision[],
  p_limit integer,
  p_categories text[]
) returns table (
  id uuid, category text, title text, content text, confidence text,
  score double precision, created_at timestamptz
)
language plpgsql security definer stable set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v_limit integer;
  v_query_tsv tsvector;
begin
  v_limit := coalesce(nullif(p_limit, 0), 8);
  if v_limit < 1 or v_limit > 25 then v_limit := 8; end if;
  perform saas_business.bg_assert_workspace_access(p_user_id, p_workspace_id);
  v_query_tsv := to_tsvector('simple', coalesce(btrim(p_query), ''));

  return query
  select m.id, m.category, m.title, m.content, m.confidence,
         (case when p_embedding is null
               then 0.60 * ts_rank_cd(v_query_tsv, m.search_tsv)
                    + 0.40 * exp(-extract(epoch from (now() - m.created_at)) / (90.0 * 86400))
               else 0.45 * ts_rank_cd(v_query_tsv, m.search_tsv)
                    + 0.30 * exp(-extract(epoch from (now() - m.created_at)) / (90.0 * 86400))
                    + 0.25 * coalesce(saas_business.cosine_similarity(m.embedding, p_embedding), 0)
          end)
         * (case m.confidence when 'fact' then 1.0 when 'hypothesis' then 0.85 else 0.70 end) as score,
         m.created_at
  from saas_business.ai_memories m
  where m.deleted_at is null
    and m.superseded_by is null
    and (m.valid_until is null or m.valid_until > now())
    and (
      m.user_id = p_user_id
      or (p_workspace_id is not null and m.workspace_id = p_workspace_id)
    )
    and (p_categories is null or m.category = any(p_categories))
    and m.search_tsv @@ v_query_tsv
  order by score desc, m.created_at desc
  limit v_limit;
end $$;

-- Liste (pour l'interface mémoire) — même scope strict
create or replace function saas_business.ai_memory_list(
  p_user_id uuid,
  p_workspace_id uuid,
  p_category text,
  p_limit integer
) returns table (
  id uuid, category text, title text, content text, confidence text,
  source text, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer stable set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v_limit integer;
begin
  v_limit := coalesce(nullif(p_limit, 0), 20);
  if v_limit < 1 or v_limit > 100 then v_limit := 20; end if;
  perform saas_business.bg_assert_workspace_access(p_user_id, p_workspace_id);

  return query
  select m.id, m.category, m.title, m.content, m.confidence, m.source, m.created_at, m.updated_at
  from saas_business.ai_memories m
  where m.deleted_at is null
    and m.superseded_by is null
    and (m.valid_until is null or m.valid_until > now())
    and (
      m.user_id = p_user_id
      or (p_workspace_id is not null and m.workspace_id = p_workspace_id)
    )
    and (p_category is null or m.category = p_category)
  order by m.created_at desc
  limit v_limit;
end $$;

-- Oubli à la demande : tombstone (jamais de hard delete de l'audit)
create or replace function saas_business.ai_memory_forget(p_user_id uuid, p_memory_id uuid)
returns boolean
language plpgsql security definer set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v record;
begin
  if p_user_id is null or p_memory_id is null then raise exception 'invalid memory id'; end if;
  select user_id, workspace_id into v
  from saas_business.ai_memories where id = p_memory_id for update;
  if not found then raise exception 'memory not found'; end if;
  if v.user_id <> p_user_id and (v.workspace_id is null or not exists (
    select 1 from saas_ugc.ugc_workspaces w
    where w.id = v.workspace_id
      and (w.owner_user_id = p_user_id or exists (
        select 1 from saas_ugc.ugc_workspace_members m
        where m.workspace_id = w.id and m.user_id = p_user_id))
  )) then
    raise exception 'memory access denied';
  end if;
  update saas_business.ai_memories
  set deleted_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_memory_id;
  return true;
end $$;

-- Obsolescence : expire une mémoire (valid_until)
create or replace function saas_business.ai_memory_set_valid(p_user_id uuid, p_memory_id uuid, p_valid_until timestamptz)
returns boolean
language plpgsql security definer set search_path = pg_catalog, saas_business, saas_ugc as $$
declare
  v record;
begin
  if p_user_id is null or p_memory_id is null then raise exception 'invalid memory id'; end if;
  select user_id, workspace_id into v
  from saas_business.ai_memories where id = p_memory_id for update;
  if not found then raise exception 'memory not found'; end if;
  if v.user_id <> p_user_id and (v.workspace_id is null or not exists (
    select 1 from saas_ugc.ugc_workspaces w
    where w.id = v.workspace_id
      and (w.owner_user_id = p_user_id or exists (
        select 1 from saas_ugc.ugc_workspace_members m
        where m.workspace_id = w.id and m.user_id = p_user_id))
  )) then
    raise exception 'memory access denied';
  end if;
  update saas_business.ai_memories
  set valid_until = p_valid_until, updated_at = clock_timestamp()
  where id = p_memory_id;
  return true;
end $$;

revoke all on function saas_business.ai_memory_save(uuid,uuid,text,text,text,text,text,uuid) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
revoke all on function saas_business.ai_memory_search(uuid,uuid,text,double precision[],integer,text[]) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
revoke all on function saas_business.ai_memory_list(uuid,uuid,text,integer) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
revoke all on function saas_business.ai_memory_forget(uuid,uuid) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
revoke all on function saas_business.ai_memory_set_valid(uuid,uuid,timestamptz) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
revoke all on function saas_business.cosine_similarity(double precision[],double precision[]) from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
revoke all on function saas_business.bg_assert_workspace_access(uuid,uuid) from public, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
grant execute on function saas_business.ai_memory_save(uuid,uuid,text,text,text,text,text,uuid) to bg_edge;
grant execute on function saas_business.ai_memory_search(uuid,uuid,text,double precision[],integer,text[]) to bg_edge;
grant execute on function saas_business.ai_memory_list(uuid,uuid,text,integer) to bg_edge;
grant execute on function saas_business.ai_memory_forget(uuid,uuid) to bg_edge;
grant execute on function saas_business.ai_memory_set_valid(uuid,uuid,timestamptz) to bg_edge;

-- -----------------------------------------------------------------------------
-- 8) pgvector : index HNSW sur colonne miroir, uniquement si l'extension est
--    disponible (production Supabase). Aucun effet en local sans l'extension.
-- -----------------------------------------------------------------------------

do $pgv$
begin
  if exists (select 1 from pg_available_extensions where name = 'vector') then
    execute 'create extension if not exists vector';
    execute format(
      'alter table saas_business.ai_memories add column if not exists embedding_vector vector(768)');
    execute format(
      'create or replace function saas_business.ai_memories_embedding_sync()
       returns trigger language plpgsql set search_path = pg_catalog, saas_business as $$
       begin
         if new.embedding is not null and cardinality(new.embedding) = 768 then
           new.embedding_vector := new.embedding::vector(768);
         else
           new.embedding_vector := null;
         end if;
         return new;
       end $$');
    execute format(
      'drop trigger if exists ai_memories_embedding_sync on saas_business.ai_memories');
    execute format(
      'create trigger ai_memories_embedding_sync before insert or update of embedding
       on saas_business.ai_memories for each row execute function saas_business.ai_memories_embedding_sync()');
    execute format(
      'revoke all on function saas_business.ai_memories_embedding_sync()
       from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure');
    execute format(
      'create index if not exists ai_memories_vector_hnsw_idx
       on saas_business.ai_memories using hnsw (embedding_vector vector_cosine_ops)
       where embedding_vector is not null');
  end if;
end
$pgv$;
