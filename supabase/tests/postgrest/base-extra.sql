-- =============================================================================
-- Banc PostgREST — socle additionnel (BENCH ONLY, jamais appliqué en production)
--
-- Le schéma de base `saas_ugc` n'est créé par AUCUNE migration du dépôt : en
-- production il existe depuis avant le dépôt. Le banc reprend le relevé partiel
-- `supabase/tests/saspay/prod_subset.sql` (les 20 tables + 2 fonctions
-- réécrites à la main) et complète ICI les objets absents que les migrations
-- du dépôt référencent. Chaque objet est commenté ; la liste est close.
-- =============================================================================

-- --- Cohérence d'identité (comme en production) ------------------------------
-- Le sous-ensemble relevé n'incluait pas la FK de notifications vers
-- auth.users ; la production l'a (la suppression d'un utilisateur cascade
-- ses notifications — c'est le mécanisme de révocation testé).
alter table saas_ugc.ugc_notifications
  add constraint ugc_notifications_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- --- Espaces de travail (= « entreprises » de Business Grow) ----------------
-- Stub élargi : la migration Business Grow lit country_code / default_language.
create table if not exists saas_ugc.ugc_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid,
  name text not null default 'Espace',
  country_code text not null default 'ML',
  default_language text not null default 'fr',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_workspace_members (
  workspace_id uuid not null references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'member' check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create table if not exists saas_ugc.ugc_brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  name text not null,
  industry text,
  description text,
  voice_guidelines text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  name text not null,
  description text,
  key_benefits text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --- Tarification par pays (bouchon identique au banc saspay) ----------------
create table if not exists saas_ugc.ugc_country_pricing (
  country_code character(2) primary key,
  currency character(3) not null,
  min_amount_minor numeric(18,2) not null,
  max_amount_minor numeric(18,2) not null,
  credits_per_1000_minor numeric(18,6) not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- --- Catalogue de services (crédits par service du Studio) ------------------
create table if not exists saas_ugc.ugc_service_catalog (
  service_key text primary key,
  display_name text not null,
  credits_cost integer not null,
  config jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  sort_order integer not null default 0,
  description text,
  updated_at timestamptz not null default now()
);
insert into saas_ugc.ugc_service_catalog(service_key, display_name, credits_cost, active) values
  ('script', 'Script IA', 2, true),
  ('image_retouch', 'Retouche image', 3, true),
  ('product_image', 'Image produit', 3, true),
  ('cutaway', 'Cutaway', 10, true),
  ('ugc_clip_8s', 'Clip UGC 8 s', 9, true),
  ('ugc_clip_15s', 'Clip UGC 15 s', 16, true),
  ('ugc_ad_4clips', 'Campagne 4 clips', 36, true)
on conflict (service_key) do nothing;

-- --- Projets vidéo / scripts / assets (tables de base du Studio) ------------
create table if not exists saas_ugc.ugc_video_projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  owner_user_id uuid not null,
  created_by uuid,
  title text not null default 'Projet',
  brief text,
  description text,
  platform text not null default 'TikTok',
  language text not null default 'fr',
  aspect_ratio text not null default '9:16',
  campaign_objective text,
  target_audience text,
  target_market text,
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','queued','reserved','processing','completed','succeeded','failed','cancelled','expired','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists saas_ugc.ugc_project_scripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references saas_ugc.ugc_video_projects(id) on delete cascade,
  created_by uuid,
  content text not null default '',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_project_scenes (
  id bigserial primary key,
  project_id uuid not null references saas_ugc.ugc_video_projects(id) on delete cascade,
  script_id uuid,
  scene_order integer not null default 1,
  duration_seconds numeric not null default 3,
  scene_type text not null default 'ugc',
  visual_prompt text,
  spoken_text text,
  subtitle_text text,
  scene_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_generated_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  project_id uuid references saas_ugc.ugc_video_projects(id) on delete cascade,
  generation_job_id uuid,
  storage_path text,
  public_url text,
  asset_type text not null default 'video',
  mime_type text,
  file_size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  project_id uuid references saas_ugc.ugc_video_projects(id) on delete set null,
  created_by uuid not null,
  service_key text not null,
  status text not null default 'queued' check (status in ('queued','reserved','processing','succeeded','failed','cancelled','expired')),
  request_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb,
  request_key text,
  credits_reserved bigint not null default 0,
  credits_charged bigint not null default 0,
  reservation_idempotency_key text,
  provider text,
  provider_model text,
  provider_job_id text,
  video_url text,
  asset_id uuid,
  error_code text,
  error_message text,
  cancellation_requested_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_job_events (
  id bigserial primary key,
  generation_job_id uuid not null references saas_ugc.ugc_generation_jobs(id) on delete cascade,
  actor_user_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- --- Codes promo / consentements --------------------------------------------
create table if not exists saas_ugc.ugc_promo_codes (
  code text primary key,
  bonus_credits integer not null,
  max_redemptions integer,
  per_user_limit integer not null default 1,
  active boolean not null default true,
  redeemed_by uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists saas_ugc.ugc_user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  consent_key text not null,
  granted boolean not null default true,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint ugc_user_consents_user_key unique (user_id, consent_key)
);

-- --- Profils (la table existe en production ; ici elle n'est pas dans le
--     subset) : user_id, display_name + colonnes minimales. -------------------
create table if not exists saas_ugc.ugc_profiles (
  user_id uuid primary key,
  display_name text,
  phone text,
  country_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- --- Fonctions de base absentes du dépôt (équivalents bench documentés) ------
-- has_role / reelora_assert_admin viennent de prod_subset.sql ; les quatre
-- suivantes sont des équivalents fonctionnels de leur version production.

create or replace function ugc_private.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from saas_ugc.ugc_workspaces w
    where w.id = p_workspace_id
      and (
        w.owner_user_id = (select auth.uid())
        or exists (select 1 from saas_ugc.ugc_workspace_members m
                   where m.workspace_id = w.id and m.user_id = (select auth.uid()))
      )
  );
$$;
revoke execute on function ugc_private.is_workspace_member(uuid) from public;
grant execute on function ugc_private.is_workspace_member(uuid) to authenticated, service_role;
grant select on saas_ugc.ugc_workspaces, saas_ugc.ugc_workspace_members to authenticated, service_role;

create or replace function ugc_private.can_edit_workspace(p_workspace_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from saas_ugc.ugc_workspaces w
    where w.id = p_workspace_id
      and (
        w.owner_user_id = (select auth.uid())
        or exists (select 1 from saas_ugc.ugc_workspace_members m
                   where m.workspace_id = w.id and m.user_id = (select auth.uid())
                     and m.role in ('owner','editor'))
      )
  );
$$;
revoke execute on function ugc_private.can_edit_workspace(uuid) from public;
grant execute on function ugc_private.can_edit_workspace(uuid) to authenticated, service_role;

-- ugc_ensure_my_workspace : équivalent bench (fonction de base production
-- absente du dépôt) : renvoie le workspace dont l'utilisateur est
-- propriétaire, sinon en crée un personnel.
create or replace function saas_ugc.ugc_ensure_my_workspace()
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid; v_ws uuid;
begin
  select auth.uid() into v_uid;
  if v_uid is null then raise exception 'not_authenticated'; end if;
  select id into v_ws from saas_ugc.ugc_workspaces where owner_user_id = v_uid limit 1;
  if found then return v_ws; end if;
  insert into saas_ugc.ugc_workspaces(owner_user_id, name, country_code)
  values (v_uid, 'Mon espace', 'ML') returning id into v_ws;
  return v_ws;
end $$;
grant execute on function saas_ugc.ugc_ensure_my_workspace() to authenticated, service_role;

-- is_platform_admin : équivalent bench (la version production est absente du
-- dépôt). Utilisée par des politiques RLS et des requêtes d'administration.
create or replace function public.is_platform_admin()
returns boolean language sql stable as $$
  select coalesce(ugc_private.has_role((select auth.uid()), 'admin'), false);
$$;
grant execute on function public.is_platform_admin() to anon, authenticated, service_role;

-- ugc_is_admin : équivalent bench (fonction de base production absente du
-- dépôt) : l'utilisateur authentifié par le JWT courant est-il administrateur ?
create or replace function saas_ugc.ugc_is_admin()
returns boolean language sql stable as $$
  select coalesce(ugc_private.has_role((select auth.uid()), 'admin'), false);
$$;
grant execute on function saas_ugc.ugc_is_admin() to anon, authenticated, service_role;

-- Deltas de portefeuille + grand livre, idempotents par clé (équivalent bench
-- de la fonction production : upsert du wallet + écriture ledger unique).

-- --- Table de sonde pour la propagation des claims (BENCH ONLY) -------------
-- RLS basée sur un claim arbitraire (`company`) : prouve que request.jwt.claims
-- arrive réellement dans les politiques, au-delà de auth.uid().
create table if not exists public.bench_claims_probe (
  id serial primary key,
  company text not null,
  label text not null
);
alter table public.bench_claims_probe enable row level security;
drop policy if exists bench_claims_probe_select on public.bench_claims_probe;
create policy bench_claims_probe_select on public.bench_claims_probe
  for select to authenticated
  using ((select auth.jwt()->>'company') = company);
grant select on public.bench_claims_probe to authenticated;
