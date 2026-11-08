-- Reelora v1 — extension of the existing saas_ugc schema.
-- Existing tables are preserved. Only additive objects + extra permissive SELECT policies.

create table if not exists saas_ugc.ugc_avatars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  created_by uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  description text,
  provider text not null default 'heygen' check (provider in ('heygen','fal','custom')),
  provider_avatar_id text,
  voice_id text,
  preview_storage_path text,
  preview_url text,
  language text not null default 'fr',
  style jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_prompt_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  created_by uuid,
  title text not null check (length(btrim(title)) between 1 and 160),
  category text not null default 'script' check (category in ('script','hook','cta','scene','visual','system')),
  content text not null check (length(btrim(content)) >= 10),
  variables jsonb not null default '[]'::jsonb,
  is_system boolean not null default false,
  is_favorite boolean not null default false,
  usage_count integer not null default 0,
  constraint ugc_prompt_templates_scope_check check ((is_system and workspace_id is null) or (not is_system and workspace_id is not null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_generation_presets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  created_by uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  config jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_plans (
  plan_key text primary key check (plan_key ~ '^[a-z0-9_]+$'),
  display_name text not null,
  tagline text,
  monthly_price_minor bigint not null default 0,
  currency text not null default 'XOF',
  monthly_credits integer not null default 0,
  max_projects integer not null default 1,
  max_scripts_per_month integer not null default 1,
  max_prompts_per_month integer not null default 1,
  max_videos_per_month integer not null default 0,
  max_avatars integer not null default 0,
  features jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_key text not null references saas_ugc.ugc_plans(plan_key),
  status text not null default 'active' check (status in ('active','suspended','cancelled','pending_payment')),
  current_period_start timestamptz not null default date_trunc('month', now()),
  current_period_end timestamptz not null default (date_trunc('month', now()) + interval '1 month'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid,
  event_kind text not null check (event_kind in ('script','prompt','video','image','export')),
  quantity integer not null default 1 check (quantity > 0),
  period_key text not null,
  reference_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text,
  kind text not null default 'info' check (kind in ('info','success','warning','error','admin_request')),
  href text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists saas_ugc.ugc_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  action text not null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ugc_avatars_workspace_idx on saas_ugc.ugc_avatars(workspace_id, status);
create unique index if not exists ugc_avatars_default_idx on saas_ugc.ugc_avatars(workspace_id) where is_default and status = 'active';
create index if not exists ugc_prompts_workspace_idx on saas_ugc.ugc_prompt_templates(workspace_id, category);
create index if not exists ugc_presets_workspace_idx on saas_ugc.ugc_generation_presets(workspace_id);
create index if not exists ugc_usage_events_user_period_idx on saas_ugc.ugc_usage_events(user_id, period_key, event_kind);
create index if not exists ugc_notifications_user_idx on saas_ugc.ugc_notifications(user_id, created_at desc);
create index if not exists ugc_jobs_project_idx on saas_ugc.ugc_generation_jobs(project_id, created_at desc);
create index if not exists ugc_assets_workspace_idx on saas_ugc.ugc_generated_assets(workspace_id, created_at desc);

-- updated_at triggers
drop trigger if exists ugc_avatars_touch on saas_ugc.ugc_avatars;
create trigger ugc_avatars_touch before update on saas_ugc.ugc_avatars for each row execute function ugc_private.touch_updated_at();
drop trigger if exists ugc_prompt_templates_touch on saas_ugc.ugc_prompt_templates;
create trigger ugc_prompt_templates_touch before update on saas_ugc.ugc_prompt_templates for each row execute function ugc_private.touch_updated_at();
drop trigger if exists ugc_generation_presets_touch on saas_ugc.ugc_generation_presets;
create trigger ugc_generation_presets_touch before update on saas_ugc.ugc_generation_presets for each row execute function ugc_private.touch_updated_at();
drop trigger if exists ugc_plans_touch on saas_ugc.ugc_plans;
create trigger ugc_plans_touch before update on saas_ugc.ugc_plans for each row execute function ugc_private.touch_updated_at();
drop trigger if exists ugc_subscriptions_touch on saas_ugc.ugc_subscriptions;
create trigger ugc_subscriptions_touch before update on saas_ugc.ugc_subscriptions for each row execute function ugc_private.touch_updated_at();

-- PostgREST-compatible views (security_invoker => underlying RLS applies)
create or replace view public.reelora_avatars with (security_invoker = true) as select * from saas_ugc.ugc_avatars;
create or replace view public.reelora_prompt_templates with (security_invoker = true) as select * from saas_ugc.ugc_prompt_templates;
create or replace view public.reelora_generation_presets with (security_invoker = true) as select * from saas_ugc.ugc_generation_presets;
create or replace view public.reelora_plans with (security_invoker = true) as select * from saas_ugc.ugc_plans;
create or replace view public.reelora_subscriptions with (security_invoker = true) as select * from saas_ugc.ugc_subscriptions;
create or replace view public.reelora_usage_events with (security_invoker = true) as select * from saas_ugc.ugc_usage_events;
create or replace view public.reelora_notifications with (security_invoker = true) as select * from saas_ugc.ugc_notifications;
create or replace view public.reelora_audit_logs with (security_invoker = true) as select * from saas_ugc.ugc_audit_logs;

-- Base table grants (views are security_invoker)
grant usage on schema saas_ugc to anon, authenticated;
grant select, insert, update, delete on saas_ugc.ugc_avatars, saas_ugc.ugc_prompt_templates, saas_ugc.ugc_generation_presets to authenticated;
grant select on saas_ugc.ugc_plans to anon, authenticated;
grant select on saas_ugc.ugc_subscriptions, saas_ugc.ugc_usage_events, saas_ugc.ugc_notifications, saas_ugc.ugc_audit_logs to authenticated;
grant update, delete on saas_ugc.ugc_notifications to authenticated;
grant select on all tables in schema saas_ugc to service_role;

-- RLS
alter table saas_ugc.ugc_avatars enable row level security;
alter table saas_ugc.ugc_prompt_templates enable row level security;
alter table saas_ugc.ugc_generation_presets enable row level security;
alter table saas_ugc.ugc_plans enable row level security;
alter table saas_ugc.ugc_subscriptions enable row level security;
alter table saas_ugc.ugc_usage_events enable row level security;
alter table saas_ugc.ugc_notifications enable row level security;
alter table saas_ugc.ugc_audit_logs enable row level security;

drop policy if exists reelora_avatars_select on saas_ugc.ugc_avatars;
create policy reelora_avatars_select on saas_ugc.ugc_avatars for select to authenticated using (ugc_private.is_workspace_member(workspace_id));
drop policy if exists reelora_avatars_insert on saas_ugc.ugc_avatars;
create policy reelora_avatars_insert on saas_ugc.ugc_avatars for insert to authenticated with check (created_by = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_avatars_update on saas_ugc.ugc_avatars;
create policy reelora_avatars_update on saas_ugc.ugc_avatars for update to authenticated using (ugc_private.can_edit_workspace(workspace_id)) with check (ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_avatars_delete on saas_ugc.ugc_avatars;
create policy reelora_avatars_delete on saas_ugc.ugc_avatars for delete to authenticated using (ugc_private.can_edit_workspace(workspace_id));

drop policy if exists reelora_prompts_select on saas_ugc.ugc_prompt_templates;
create policy reelora_prompts_select on saas_ugc.ugc_prompt_templates for select to authenticated using (is_system or (workspace_id is not null and ugc_private.is_workspace_member(workspace_id)));
drop policy if exists reelora_prompts_insert on saas_ugc.ugc_prompt_templates;
create policy reelora_prompts_insert on saas_ugc.ugc_prompt_templates for insert to authenticated with check (not is_system and created_by = (select auth.uid()) and workspace_id is not null and ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_prompts_update on saas_ugc.ugc_prompt_templates;
create policy reelora_prompts_update on saas_ugc.ugc_prompt_templates for update to authenticated using (not is_system and workspace_id is not null and ugc_private.can_edit_workspace(workspace_id)) with check (not is_system and workspace_id is not null and ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_prompts_delete on saas_ugc.ugc_prompt_templates;
create policy reelora_prompts_delete on saas_ugc.ugc_prompt_templates for delete to authenticated using (not is_system and workspace_id is not null and ugc_private.can_edit_workspace(workspace_id));

drop policy if exists reelora_presets_select on saas_ugc.ugc_generation_presets;
create policy reelora_presets_select on saas_ugc.ugc_generation_presets for select to authenticated using (ugc_private.is_workspace_member(workspace_id));
drop policy if exists reelora_presets_insert on saas_ugc.ugc_generation_presets;
create policy reelora_presets_insert on saas_ugc.ugc_generation_presets for insert to authenticated with check (created_by = (select auth.uid()) and ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_presets_update on saas_ugc.ugc_generation_presets;
create policy reelora_presets_update on saas_ugc.ugc_generation_presets for update to authenticated using (ugc_private.can_edit_workspace(workspace_id)) with check (ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_presets_delete on saas_ugc.ugc_generation_presets;
create policy reelora_presets_delete on saas_ugc.ugc_generation_presets for delete to authenticated using (ugc_private.can_edit_workspace(workspace_id));

drop policy if exists reelora_plans_select on saas_ugc.ugc_plans;
create policy reelora_plans_select on saas_ugc.ugc_plans for select to anon, authenticated using (active);
drop policy if exists reelora_plans_admin_select on saas_ugc.ugc_plans;
create policy reelora_plans_admin_select on saas_ugc.ugc_plans for select to authenticated using (ugc_private.has_role((select auth.uid()), 'admin'));

drop policy if exists reelora_subscriptions_select on saas_ugc.ugc_subscriptions;
create policy reelora_subscriptions_select on saas_ugc.ugc_subscriptions for select to authenticated using (user_id = (select auth.uid()) or ugc_private.has_role((select auth.uid()), 'admin'));

drop policy if exists reelora_usage_select on saas_ugc.ugc_usage_events;
create policy reelora_usage_select on saas_ugc.ugc_usage_events for select to authenticated using (user_id = (select auth.uid()) or ugc_private.has_role((select auth.uid()), 'admin'));

drop policy if exists reelora_notifications_select on saas_ugc.ugc_notifications;
create policy reelora_notifications_select on saas_ugc.ugc_notifications for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists reelora_notifications_update on saas_ugc.ugc_notifications;
create policy reelora_notifications_update on saas_ugc.ugc_notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists reelora_notifications_delete on saas_ugc.ugc_notifications;
create policy reelora_notifications_delete on saas_ugc.ugc_notifications for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists reelora_audit_select on saas_ugc.ugc_audit_logs;
create policy reelora_audit_select on saas_ugc.ugc_audit_logs for select to authenticated using (ugc_private.has_role((select auth.uid()), 'admin'));

-- Additional permissive SELECT policies for the administration console (never grants writes)
do $$
declare t text;
begin
  foreach t in array array['ugc_profiles','ugc_wallets','ugc_video_projects','ugc_generation_jobs','ugc_recharge_orders','ugc_credit_ledger','ugc_generated_assets','ugc_service_catalog','ugc_app_settings','ugc_promo_codes','ugc_user_roles','ugc_user_consents','ugc_workspaces','ugc_workspace_members'] loop
    execute format('drop policy if exists %I on saas_ugc.%I', 'reelora_admin_read_' || t, t);
    execute format('create policy %I on saas_ugc.%I for select to authenticated using (ugc_private.has_role((select auth.uid()), ''admin''))', 'reelora_admin_read_' || t, t);
    execute format('grant select on saas_ugc.%I to authenticated', t);
  end loop;
end $$;

-- Missing client policies on existing tables
drop policy if exists reelora_profiles_insert_own on saas_ugc.ugc_profiles;
create policy reelora_profiles_insert_own on saas_ugc.ugc_profiles for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists reelora_assets_delete_editor on saas_ugc.ugc_generated_assets;
create policy reelora_assets_delete_editor on saas_ugc.ugc_generated_assets for delete to authenticated using (ugc_private.can_edit_workspace(workspace_id));
drop policy if exists reelora_scripts_delete_editor on saas_ugc.ugc_project_scripts;
create policy reelora_scripts_delete_editor on saas_ugc.ugc_project_scripts for delete to authenticated using (exists (select 1 from saas_ugc.ugc_video_projects p where p.id = project_id and ugc_private.can_edit_workspace(p.workspace_id)));

notify pgrst, 'reload schema';
