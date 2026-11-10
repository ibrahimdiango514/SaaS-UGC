-- Reelora Central AI Engine & Business Grow — Additive Schema & Strict Isolation
-- IMPORTANT:
-- 1. Purely additive migration: preserves all existing Studio UGC tables & RPCs.
-- 2. Business Grow AI credits (`saas_ugc.bg_wallets`, `saas_ugc.bg_credit_ledger`)
--    are 100% independent of Studio UGC (`saas_ugc.ugc_wallets`, `saas_ugc.ugc_usage_events`).
--    Business Grow NEVER consumes Studio UGC credits.
-- 3. API keys and OAuth tokens are NEVER stored in client-readable tables.

-- ============================================================================
-- 1. CENTRAL AI PROVIDER & MODEL REGISTRY (no secrets stored)
-- ============================================================================

create table if not exists saas_ugc.ai_providers (
  provider_key text primary key check (provider_key ~ '^[a-z0-9_-]{2,40}$'),
  display_name text not null,
  adapter_kind text not null check (adapter_kind in ('openai_compatible', 'gemini_rest', 'anthropic_rest')),
  is_implemented boolean not null default false,
  is_active boolean not null default true,
  verification_status text not null default 'unconfigured'
    check (verification_status in ('unconfigured', 'configured_unverified', 'connected', 'error')),
  priority integer not null default 100,
  default_model_id text,
  supports_chat boolean not null default true,
  supports_json boolean not null default true,
  supports_tools boolean not null default false,
  last_verified_at timestamptz,
  last_error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references saas_ugc.ai_providers(provider_key) on delete cascade,
  model_id text not null,
  display_name text not null,
  capabilities jsonb not null default '[]'::jsonb,
  context_window integer not null default 32768 check (context_window > 0),
  max_output_tokens integer not null default 4096 check (max_output_tokens > 0),
  cost_input_per_1m_usd numeric(10, 4) not null default 0,
  cost_output_per_1m_usd numeric(10, 4) not null default 0,
  credits_cost integer not null default 1 check (credits_cost >= 0),
  cost_tier text not null default 'balanced' check (cost_tier in ('economy', 'balanced', 'premium')),
  supports_json boolean not null default true,
  supports_tools boolean not null default false,
  enabled boolean not null default true,
  recommended_tasks jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_key, model_id)
);

-- ============================================================================
-- 2. ROUTING RULES & FALLBACK POLICIES (scoped by workspace / user / space)
-- ============================================================================

create table if not exists saas_ugc.ai_routing_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  space text not null default 'business_grow' check (space in ('business_grow', 'studio_ugc', 'global')),
  task_type text not null default 'default'
    check (task_type in (
      'default', 'chat', 'strategy', 'action_plan', 'marketing_campaign',
      'sales_analysis', 'content_ideas', 'memory_extraction', 'tool_planning', 'script_generation'
    )),
  selection_mode text not null default 'auto' check (selection_mode in ('auto', 'manual')),
  preferred_provider_key text references saas_ugc.ai_providers(provider_key),
  preferred_model_id text,
  fallback_chain jsonb not null default '[]'::jsonb,
  max_cost_tier text not null default 'premium' check (max_cost_tier in ('economy', 'balanced', 'premium')),
  allow_fallback boolean not null default true,
  daily_budget_credits integer check (daily_budget_credits is null or daily_budget_credits > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ai_routing_rules_scope_unique_idx
  on saas_ugc.ai_routing_rules (
    coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    space,
    task_type
  );

-- ============================================================================
-- 3. REQUEST TELEMETRY, FALLBACK TRACE & COST TRACKING
-- ============================================================================

create table if not exists saas_ugc.ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  space text not null check (space in ('business_grow', 'studio_ugc')),
  task_type text not null,
  conversation_id uuid,
  business_profile_id uuid,
  selection_mode text not null default 'auto' check (selection_mode in ('auto', 'manual')),
  requested_provider_key text,
  requested_model_id text,
  actual_provider_key text,
  actual_model_id text,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  fallback_used boolean not null default false,
  attempts_count integer not null default 0,
  latency_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  bg_credits_charged integer not null default 0,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists saas_ugc.ai_request_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references saas_ugc.ai_requests(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  provider_key text not null,
  model_id text not null,
  status text not null check (
    status in ('succeeded', 'failed', 'skipped_unconfigured', 'rate_limited', 'timeout', 'auth_error', 'empty_response')
  ),
  http_status integer,
  error_code text,
  error_message text,
  latency_ms integer,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ai_requests_user_ws_idx on saas_ugc.ai_requests (user_id, workspace_id, created_at desc);
create index if not exists ai_requests_provider_idx on saas_ugc.ai_requests (actual_provider_key, status, created_at desc);
create index if not exists ai_request_attempts_req_idx on saas_ugc.ai_request_attempts (request_id, attempt_number);

-- ============================================================================
-- 4. BUSINESS GROW ISOLATED CREDITS & LEDGER (NEVER touches ugc_wallets)
-- ============================================================================

create table if not exists saas_ugc.bg_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  available_credits bigint not null default 50 check (available_credits >= 0),
  reserved_credits bigint not null default 0 check (reserved_credits >= 0),
  monthly_allowance bigint not null default 50 check (monthly_allowance >= 0),
  period_key text not null default to_char((now() at time zone 'UTC'), 'YYYY-MM'),
  period_used bigint not null default 0 check (period_used >= 0),
  lifetime_consumed bigint not null default 0 check (lifetime_consumed >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, workspace_id)
);

create table if not exists saas_ugc.bg_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references saas_ugc.bg_wallets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  operation_type text not null check (
    operation_type in ('grant', 'monthly_allowance', 'reserve', 'capture', 'release', 'refund', 'admin_adjust')
  ),
  available_delta bigint not null default 0,
  reserved_delta bigint not null default 0,
  request_id uuid references saas_ugc.ai_requests(id) on delete set null,
  idempotency_key text not null unique,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists bg_credit_ledger_wallet_idx on saas_ugc.bg_credit_ledger (wallet_id, created_at desc);

-- ============================================================================
-- 5. BUSINESS GROW PROFILES, STRUCTURED MEMORY, CONVERSATIONS & TOOLS
-- ============================================================================

create table if not exists saas_ugc.bg_business_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null check (length(btrim(company_name)) between 1 and 180),
  industry text,
  tagline text,
  description text,
  website_url text,
  primary_language text not null default 'fr',
  products_services jsonb not null default '[]'::jsonb,
  target_customers jsonb not null default '[]'::jsonb,
  business_goals jsonb not null default '[]'::jsonb,
  positioning text,
  brand_identity jsonb not null default '{}'::jsonb,
  communication_tone text,
  preferences jsonb not null default '{}'::jsonb,
  ai_memory_consent boolean not null default true,
  consent_updated_at timestamptz,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bg_business_profiles_default_idx
  on saas_ugc.bg_business_profiles (workspace_id, user_id)
  where is_default and status = 'active';

create index if not exists bg_business_profiles_ws_user_idx
  on saas_ugc.bg_business_profiles (workspace_id, user_id, status);

create table if not exists saas_ugc.bg_business_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_profile_id uuid not null references saas_ugc.bg_business_profiles(id) on delete cascade,
  category text not null check (
    category in (
      'company', 'product', 'audience', 'goal', 'positioning',
      'tone', 'preference', 'work_history', 'metric', 'insight'
    )
  ),
  memory_key text not null check (length(btrim(memory_key)) between 1 and 120),
  summary text not null check (length(btrim(summary)) between 1 and 4000),
  structured_data jsonb not null default '{}'::jsonb,
  confidence numeric(3, 2) not null default 0.90 check (confidence >= 0 and confidence <= 1),
  source_type text not null default 'explicit_user' check (
    source_type in ('explicit_user', 'conversation_extracted', 'connector_sync', 'action_outcome')
  ),
  source_ref_id uuid,
  pinned boolean not null default false,
  active boolean not null default true,
  last_accessed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_profile_id, category, memory_key)
);

create index if not exists bg_business_memories_lookup_idx
  on saas_ugc.bg_business_memories (workspace_id, user_id, business_profile_id, active, pinned desc, updated_at desc);

create table if not exists saas_ugc.bg_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_profile_id uuid references saas_ugc.bg_business_profiles(id) on delete set null,
  title text not null default 'Nouvelle session Business Grow' check (length(btrim(title)) between 1 and 200),
  objective text,
  active_task_type text not null default 'chat',
  routing_override jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'archived')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bg_conversations_user_ws_idx
  on saas_ugc.bg_conversations (workspace_id, user_id, status, coalesce(last_message_at, created_at) desc);

create table if not exists saas_ugc.bg_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references saas_ugc.bg_conversations(id) on delete cascade,
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  task_type text,
  provider_key text,
  model_id text,
  request_id uuid references saas_ugc.ai_requests(id) on delete set null,
  structured_payload jsonb not null default '{}'::jsonb,
  tool_proposals jsonb not null default '[]'::jsonb,
  token_count integer,
  created_at timestamptz not null default now()
);

create index if not exists bg_messages_conv_idx on saas_ugc.bg_messages (conversation_id, created_at asc);

create table if not exists saas_ugc.bg_tool_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_profile_id uuid references saas_ugc.bg_business_profiles(id) on delete set null,
  conversation_id uuid references saas_ugc.bg_conversations(id) on delete set null,
  message_id uuid references saas_ugc.bg_messages(id) on delete set null,
  request_id uuid references saas_ugc.ai_requests(id) on delete set null,
  tool_name text not null,
  risk_level text not null default 'write_requires_approval'
    check (risk_level in ('read', 'draft', 'write_requires_approval')),
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'approved', 'rejected', 'executed', 'failed')),
  input_args jsonb not null default '{}'::jsonb,
  output_result jsonb not null default '{}'::jsonb,
  error_message text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists bg_tool_executions_user_idx
  on saas_ugc.bg_tool_executions (workspace_id, user_id, status, created_at desc);

-- ============================================================================
-- 6. PREPARED EXTERNAL INTEGRATIONS (Social + E-Commerce — no fake live links)
-- ============================================================================

create table if not exists saas_ugc.bg_external_connectors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  business_profile_id uuid references saas_ugc.bg_business_profiles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (
    platform in ('facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce', 'custom')
  ),
  category text not null check (category in ('social', 'ecommerce')),
  connection_status text not null default 'not_connected' check (
    connection_status in ('not_connected', 'oauth_pending', 'connected_readonly', 'connected_active', 'revoked', 'error')
  ),
  external_account_id text,
  external_account_name text,
  granted_scopes jsonb not null default '[]'::jsonb,
  sync_capabilities jsonb not null default '{}'::jsonb,
  vault_secret_ref text,
  last_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, business_profile_id, platform)
);

create table if not exists saas_ugc.bg_connector_snapshots (
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references saas_ugc.bg_external_connectors(id) on delete cascade,
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  snapshot_type text not null check (
    snapshot_type in ('catalog_summary', 'sales_metrics', 'social_metrics', 'audience_insights', 'campaigns')
  ),
  period_start timestamptz,
  period_end timestamptz,
  payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);

create index if not exists bg_connector_snapshots_idx
  on saas_ugc.bg_connector_snapshots (connector_id, snapshot_type, captured_at desc);

-- ============================================================================
-- 7. UPDATED_AT TRIGGERS
-- ============================================================================

drop trigger if exists ai_providers_touch on saas_ugc.ai_providers;
create trigger ai_providers_touch before update on saas_ugc.ai_providers for each row execute function ugc_private.touch_updated_at();

drop trigger if exists ai_models_touch on saas_ugc.ai_models;
create trigger ai_models_touch before update on saas_ugc.ai_models for each row execute function ugc_private.touch_updated_at();

drop trigger if exists ai_routing_rules_touch on saas_ugc.ai_routing_rules;
create trigger ai_routing_rules_touch before update on saas_ugc.ai_routing_rules for each row execute function ugc_private.touch_updated_at();

drop trigger if exists bg_wallets_touch on saas_ugc.bg_wallets;
create trigger bg_wallets_touch before update on saas_ugc.bg_wallets for each row execute function ugc_private.touch_updated_at();

drop trigger if exists bg_business_profiles_touch on saas_ugc.bg_business_profiles;
create trigger bg_business_profiles_touch before update on saas_ugc.bg_business_profiles for each row execute function ugc_private.touch_updated_at();

drop trigger if exists bg_business_memories_touch on saas_ugc.bg_business_memories;
create trigger bg_business_memories_touch before update on saas_ugc.bg_business_memories for each row execute function ugc_private.touch_updated_at();

drop trigger if exists bg_conversations_touch on saas_ugc.bg_conversations;
create trigger bg_conversations_touch before update on saas_ugc.bg_conversations for each row execute function ugc_private.touch_updated_at();

drop trigger if exists bg_external_connectors_touch on saas_ugc.bg_external_connectors;
create trigger bg_external_connectors_touch before update on saas_ugc.bg_external_connectors for each row execute function ugc_private.touch_updated_at();

-- ============================================================================
-- 8. POSTGREST VIEWS (security_invoker = true so RLS strictly applies)
-- ============================================================================

create or replace view public.reelora_ai_providers with (security_invoker = true) as select * from saas_ugc.ai_providers;
create or replace view public.reelora_ai_models with (security_invoker = true) as select * from saas_ugc.ai_models;
create or replace view public.reelora_ai_routing_rules with (security_invoker = true) as select * from saas_ugc.ai_routing_rules;
create or replace view public.reelora_ai_requests with (security_invoker = true) as select * from saas_ugc.ai_requests;
create or replace view public.reelora_ai_request_attempts with (security_invoker = true) as select * from saas_ugc.ai_request_attempts;
create or replace view public.reelora_bg_wallets with (security_invoker = true) as select * from saas_ugc.bg_wallets;
create or replace view public.reelora_bg_credit_ledger with (security_invoker = true) as select * from saas_ugc.bg_credit_ledger;
create or replace view public.reelora_bg_business_profiles with (security_invoker = true) as select * from saas_ugc.bg_business_profiles;
create or replace view public.reelora_bg_business_memories with (security_invoker = true) as select * from saas_ugc.bg_business_memories;
create or replace view public.reelora_bg_conversations with (security_invoker = true) as select * from saas_ugc.bg_conversations;
create or replace view public.reelora_bg_messages with (security_invoker = true) as select * from saas_ugc.bg_messages;
create or replace view public.reelora_bg_tool_executions with (security_invoker = true) as select * from saas_ugc.bg_tool_executions;
create or replace view public.reelora_bg_external_connectors with (security_invoker = true) as
  select id, workspace_id, business_profile_id, user_id, platform, category, connection_status,
         external_account_id, external_account_name, granted_scopes, sync_capabilities,
         last_sync_at, last_error, metadata, created_at, updated_at
  from saas_ugc.bg_external_connectors;
create or replace view public.reelora_bg_connector_snapshots with (security_invoker = true) as select * from saas_ugc.bg_connector_snapshots;

-- ============================================================================
-- 9. GRANTS & ROW LEVEL SECURITY (strict user + workspace/company isolation)
-- ============================================================================

grant select on saas_ugc.ai_providers, saas_ugc.ai_models to authenticated;
grant select, insert, update, delete on saas_ugc.ai_routing_rules to authenticated;
grant select on saas_ugc.ai_requests, saas_ugc.ai_request_attempts to authenticated;
grant select on saas_ugc.bg_wallets, saas_ugc.bg_credit_ledger to authenticated;
grant select, insert, update, delete on saas_ugc.bg_business_profiles to authenticated;
grant select, insert, update, delete on saas_ugc.bg_business_memories to authenticated;
grant select, insert, update, delete on saas_ugc.bg_conversations to authenticated;
grant select, insert on saas_ugc.bg_messages to authenticated;
grant select, insert, update on saas_ugc.bg_tool_executions to authenticated;
grant select, insert, update, delete on saas_ugc.bg_external_connectors to authenticated;
grant select on saas_ugc.bg_connector_snapshots to authenticated;

grant select on public.reelora_ai_providers, public.reelora_ai_models,
  public.reelora_ai_routing_rules, public.reelora_ai_requests, public.reelora_ai_request_attempts,
  public.reelora_bg_wallets, public.reelora_bg_credit_ledger,
  public.reelora_bg_business_profiles, public.reelora_bg_business_memories,
  public.reelora_bg_conversations, public.reelora_bg_messages,
  public.reelora_bg_tool_executions, public.reelora_bg_external_connectors,
  public.reelora_bg_connector_snapshots to authenticated;
grant insert, update, delete on public.reelora_ai_routing_rules,
  public.reelora_bg_business_profiles, public.reelora_bg_business_memories,
  public.reelora_bg_conversations, public.reelora_bg_external_connectors to authenticated;
grant insert on public.reelora_bg_messages to authenticated;
grant insert, update on public.reelora_bg_tool_executions to authenticated;

grant all on all tables in schema saas_ugc to service_role;

alter table saas_ugc.ai_providers enable row level security;
alter table saas_ugc.ai_models enable row level security;
alter table saas_ugc.ai_routing_rules enable row level security;
alter table saas_ugc.ai_requests enable row level security;
alter table saas_ugc.ai_request_attempts enable row level security;
alter table saas_ugc.bg_wallets enable row level security;
alter table saas_ugc.bg_credit_ledger enable row level security;
alter table saas_ugc.bg_business_profiles enable row level security;
alter table saas_ugc.bg_business_memories enable row level security;
alter table saas_ugc.bg_conversations enable row level security;
alter table saas_ugc.bg_messages enable row level security;
alter table saas_ugc.bg_tool_executions enable row level security;
alter table saas_ugc.bg_external_connectors enable row level security;
alter table saas_ugc.bg_connector_snapshots enable row level security;

-- Providers & models: read-only catalog for authenticated users
drop policy if exists reelora_ai_providers_select on saas_ugc.ai_providers;
create policy reelora_ai_providers_select on saas_ugc.ai_providers
  for select to authenticated using (true);

drop policy if exists reelora_ai_models_select on saas_ugc.ai_models;
create policy reelora_ai_models_select on saas_ugc.ai_models
  for select to authenticated using (enabled or ugc_private.has_role((select auth.uid()), 'admin'));

-- Routing rules: global defaults readable, workspace/user rules editable by member/owner
drop policy if exists reelora_ai_routing_select on saas_ugc.ai_routing_rules;
create policy reelora_ai_routing_select on saas_ugc.ai_routing_rules
  for select to authenticated using (
    (workspace_id is null and user_id is null)
    or (workspace_id is not null and ugc_private.is_workspace_member(workspace_id)
        and (user_id is null or user_id = (select auth.uid())))
    or ugc_private.has_role((select auth.uid()), 'admin')
  );

drop policy if exists reelora_ai_routing_write on saas_ugc.ai_routing_rules;
create policy reelora_ai_routing_write on saas_ugc.ai_routing_rules
  for all to authenticated
  using (workspace_id is not null and ugc_private.can_edit_workspace(workspace_id) and (user_id is null or user_id = (select auth.uid())))
  with check (workspace_id is not null and ugc_private.can_edit_workspace(workspace_id) and (user_id is null or user_id = (select auth.uid())));

-- AI requests & attempts: strictly read-only for caller (inserted server-side by Edge engine)
drop policy if exists reelora_ai_requests_select on saas_ugc.ai_requests;
create policy reelora_ai_requests_select on saas_ugc.ai_requests
  for select to authenticated using (
    (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
    or ugc_private.has_role((select auth.uid()), 'admin')
  );

drop policy if exists reelora_ai_attempts_select on saas_ugc.ai_request_attempts;
create policy reelora_ai_attempts_select on saas_ugc.ai_request_attempts
  for select to authenticated using (
    exists (
      select 1 from saas_ugc.ai_requests r
      where r.id = request_id
        and ((r.user_id = (select auth.uid()) and ugc_private.is_workspace_member(r.workspace_id))
             or ugc_private.has_role((select auth.uid()), 'admin'))
    )
  );

-- Business Grow wallets & ledger: strict owner read-only (mutations via SECURITY DEFINER RPCs)
drop policy if exists reelora_bg_wallets_select on saas_ugc.bg_wallets;
create policy reelora_bg_wallets_select on saas_ugc.bg_wallets
  for select to authenticated using (
    (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
    or ugc_private.has_role((select auth.uid()), 'admin')
  );

drop policy if exists reelora_bg_ledger_select on saas_ugc.bg_credit_ledger;
create policy reelora_bg_ledger_select on saas_ugc.bg_credit_ledger
  for select to authenticated using (
    (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
    or ugc_private.has_role((select auth.uid()), 'admin')
  );

-- Business profiles: strict user + workspace isolation
drop policy if exists reelora_bg_profiles_all on saas_ugc.bg_business_profiles;
create policy reelora_bg_profiles_all on saas_ugc.bg_business_profiles
  for all to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));

-- Business memories: strict user + workspace/profile isolation
drop policy if exists reelora_bg_memories_all on saas_ugc.bg_business_memories;
create policy reelora_bg_memories_all on saas_ugc.bg_business_memories
  for all to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));

-- Conversations & messages: strict user + workspace isolation
drop policy if exists reelora_bg_conversations_all on saas_ugc.bg_conversations;
create policy reelora_bg_conversations_all on saas_ugc.bg_conversations
  for all to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id));

drop policy if exists reelora_bg_messages_select on saas_ugc.bg_messages;
create policy reelora_bg_messages_select on saas_ugc.bg_messages
  for select to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id));

drop policy if exists reelora_bg_messages_insert on saas_ugc.bg_messages;
create policy reelora_bg_messages_insert on saas_ugc.bg_messages
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and ugc_private.is_workspace_member(workspace_id)
    and role = 'user'
  );

-- Tool executions: strictly scoped by user + workspace
drop policy if exists reelora_bg_tools_select on saas_ugc.bg_tool_executions;
create policy reelora_bg_tools_select on saas_ugc.bg_tool_executions
  for select to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id));

drop policy if exists reelora_bg_tools_write on saas_ugc.bg_tool_executions;
create policy reelora_bg_tools_write on saas_ugc.bg_tool_executions
  for all to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));

-- External connectors & snapshots: strictly scoped by user + workspace
drop policy if exists reelora_bg_connectors_all on saas_ugc.bg_external_connectors;
create policy reelora_bg_connectors_all on saas_ugc.bg_external_connectors
  for all to authenticated
  using (user_id = (select auth.uid()) and ugc_private.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));

drop policy if exists reelora_bg_snapshots_select on saas_ugc.bg_connector_snapshots;
create policy reelora_bg_snapshots_select on saas_ugc.bg_connector_snapshots
  for select to authenticated
  using (
    exists (
      select 1 from saas_ugc.bg_external_connectors c
      where c.id = connector_id
        and c.user_id = (select auth.uid())
        and ugc_private.is_workspace_member(c.workspace_id)
    )
  );

-- ============================================================================
-- 10. INITIAL SEED: PROVIDERS, MODELS & DEFAULT SYSTEM ROUTING
-- Notice: verification_status stays 'unconfigured' until real server API check!
-- ============================================================================

insert into saas_ugc.ai_providers (
  provider_key, display_name, adapter_kind, is_implemented, is_active,
  verification_status, priority, default_model_id, supports_chat, supports_json, supports_tools, metadata
) values
  ('groq', 'Groq Cloud', 'openai_compatible', true, true, 'unconfigured', 10, 'llama-3.3-70b-versatile', true, true, true, '{"api_base":"https://api.groq.com/openai/v1","env_secret":"GROQ_API_KEY"}'::jsonb),
  ('gemini', 'Google Gemini', 'gemini_rest', true, true, 'unconfigured', 20, 'gemini-2.5-flash', true, true, true, '{"api_base":"https://generativelanguage.googleapis.com/v1beta","env_secret":"GEMINI_API_KEY"}'::jsonb),
  ('openai', 'OpenAI', 'openai_compatible', false, false, 'unconfigured', 30, 'gpt-4o-mini', true, true, true, '{"api_base":"https://api.openai.com/v1","env_secret":"OPENAI_API_KEY","planned":true}'::jsonb),
  ('anthropic', 'Anthropic Claude', 'anthropic_rest', false, false, 'unconfigured', 40, 'claude-sonnet-4-20250514', true, false, true, '{"api_base":"https://api.anthropic.com/v1","env_secret":"ANTHROPIC_API_KEY","planned":true}'::jsonb),
  ('deepseek', 'DeepSeek', 'openai_compatible', false, false, 'unconfigured', 50, 'deepseek-chat', true, true, true, '{"api_base":"https://api.deepseek.com/v1","env_secret":"DEEPSEEK_API_KEY","planned":true}'::jsonb),
  ('mistral', 'Mistral AI', 'openai_compatible', false, false, 'unconfigured', 60, 'mistral-large-latest', true, true, true, '{"api_base":"https://api.mistral.ai/v1","env_secret":"MISTRAL_API_KEY","planned":true}'::jsonb)
on conflict (provider_key) do update set
  display_name = excluded.display_name,
  adapter_kind = excluded.adapter_kind,
  is_implemented = excluded.is_implemented,
  default_model_id = excluded.default_model_id,
  supports_tools = excluded.supports_tools,
  metadata = excluded.metadata;

insert into saas_ugc.ai_models (
  provider_key, model_id, display_name, capabilities, context_window, max_output_tokens,
  cost_input_per_1m_usd, cost_output_per_1m_usd, credits_cost, cost_tier, supports_json, supports_tools, enabled, recommended_tasks
) values
  ('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile', '["chat","strategy","action_plan","marketing_campaign","content_ideas","json","tools"]'::jsonb, 128000, 8192, 0.59, 0.79, 1, 'economy', true, true, true, '["chat","content_ideas","marketing_campaign","action_plan"]'::jsonb),
  ('groq', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant', '["chat","memory_extraction","fast","json"]'::jsonb, 128000, 8192, 0.05, 0.08, 1, 'economy', true, true, true, '["memory_extraction","chat"]'::jsonb),
  ('groq', 'qwen/qwen3-32b', 'Qwen 3 32B', '["chat","reasoning","sales_analysis","strategy","json","tools"]'::jsonb, 131072, 16384, 0.29, 0.59, 1, 'balanced', true, true, true, '["sales_analysis","strategy","tool_planning"]'::jsonb),
  ('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', '["chat","strategy","action_plan","marketing_campaign","sales_analysis","content_ideas","json","tools","long_context"]'::jsonb, 1048576, 8192, 0.30, 2.50, 1, 'balanced', true, true, true, '["chat","marketing_campaign","action_plan","content_ideas","memory_extraction"]'::jsonb),
  ('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', '["reasoning","strategy","sales_analysis","action_plan","json","tools","long_context"]'::jsonb, 1048576, 8192, 1.25, 10.00, 3, 'premium', true, true, true, '["strategy","sales_analysis","tool_planning"]'::jsonb),
  ('gemini', 'gemini-2.0-flash', 'Gemini 2.0 Flash', '["chat","fast","json","tools"]'::jsonb, 1048576, 8192, 0.10, 0.40, 1, 'economy', true, true, true, '["chat","memory_extraction"]'::jsonb)
on conflict (provider_key, model_id) do update set
  display_name = excluded.display_name,
  capabilities = excluded.capabilities,
  context_window = excluded.context_window,
  max_output_tokens = excluded.max_output_tokens,
  cost_input_per_1m_usd = excluded.cost_input_per_1m_usd,
  cost_output_per_1m_usd = excluded.cost_output_per_1m_usd,
  credits_cost = excluded.credits_cost,
  cost_tier = excluded.cost_tier,
  recommended_tasks = excluded.recommended_tasks;

insert into saas_ugc.ai_routing_rules (
  workspace_id, user_id, space, task_type, selection_mode,
  preferred_provider_key, preferred_model_id, fallback_chain, max_cost_tier, allow_fallback
) values
  (null, null, 'business_grow', 'default', 'auto', 'groq', 'llama-3.3-70b-versatile',
   '[{"provider_key":"gemini","model_id":"gemini-2.5-flash"},{"provider_key":"groq","model_id":"llama-3.1-8b-instant"}]'::jsonb,
   'premium', true),
  (null, null, 'business_grow', 'strategy', 'auto', 'gemini', 'gemini-2.5-pro',
   '[{"provider_key":"groq","model_id":"llama-3.3-70b-versatile"},{"provider_key":"gemini","model_id":"gemini-2.5-flash"}]'::jsonb,
   'premium', true),
  (null, null, 'business_grow', 'sales_analysis', 'auto', 'gemini', 'gemini-2.5-pro',
   '[{"provider_key":"groq","model_id":"qwen/qwen3-32b"},{"provider_key":"gemini","model_id":"gemini-2.5-flash"}]'::jsonb,
   'premium', true),
  (null, null, 'business_grow', 'memory_extraction', 'auto', 'groq', 'llama-3.1-8b-instant',
   '[{"provider_key":"gemini","model_id":"gemini-2.0-flash"}]'::jsonb,
   'economy', true)
on conflict do nothing;

notify pgrst, 'reload schema';
