-- VYORA MCP — Core (phase 1)
-- Version appliquée en base : 20261116000118 (vyora_mcp_core)
--
-- Objet : stocker les connexions MCP de chaque utilisateur, les jetons
-- personnels SOUS FORME HACHÉE, les autorisations par outil et le journal des
-- appels.
--
-- Principes non négociables :
--   * aucun jeton en clair n'est stocké : seule l'empreinte SHA-256 l'est, plus
--     un préfixe public de 8 caractères permettant à l'utilisateur de
--     reconnaître son jeton dans l'interface ;
--   * aucune table MCP n'est lisible par `anon` ni par `authenticated` : les
--     jetons ne transitent que par la couche `service_role` (Edge Function) ;
--   * chaque lecture/écriture applicative passe par une RPC `security definer`
--     recevant explicitement `p_user_id`.

-- ---------------------------------------------------------------------------
-- 1) Connexions (un client MCP = une connexion)
-- ---------------------------------------------------------------------------
create table if not exists public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null check (length(btrim(client_name)) between 1 and 80),
  client_kind text not null default 'generic'
    check (client_kind in ('claude', 'cursor', 'vscode', 'generic')),
  last_seen_at timestamptz,
  last_seen_ip_hash text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2) Jetons personnels
-- ---------------------------------------------------------------------------
create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid references public.mcp_connections(id) on delete cascade,
  label text not null default 'Jeton MCP'
    check (length(btrim(label)) between 1 and 80),
  -- Préfixe public : `vyora_mcp_` + 8 caractères, affiché dans l'interface.
  token_prefix text not null check (token_prefix ~ '^vyora_mcp_[A-Za-z0-9_-]{8}$'),
  -- Empreinte SHA-256 en hexadécimal. Unique : un même secret ne peut pas
  -- exister deux fois.
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default array['read']::text[],
  revoked_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  use_count bigint not null default 0,
  created_at timestamptz not null default now()
);

-- Portées autorisées : lecture seule ou lecture + écriture, jamais autre chose.
alter table public.mcp_tokens drop constraint if exists mcp_tokens_scopes_check;
alter table public.mcp_tokens add constraint mcp_tokens_scopes_check
  check (scopes <@ array['read', 'write']::text[] and cardinality(scopes) > 0);

-- ---------------------------------------------------------------------------
-- 3) Autorisations fines par jeton et par outil
-- ---------------------------------------------------------------------------
create table if not exists public.mcp_tool_permissions (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.mcp_tokens(id) on delete cascade,
  tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{2,63}$'),
  allowed boolean not null default true,
  granted_at timestamptz not null default now(),
  unique (token_id, tool_name)
);

-- ---------------------------------------------------------------------------
-- 4) Journal des appels (sans contenu métier, sans jeton)
-- ---------------------------------------------------------------------------
create table if not exists public.mcp_activity_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  token_id uuid references public.mcp_tokens(id) on delete set null,
  connection_id uuid references public.mcp_connections(id) on delete set null,
  token_prefix text,
  method text not null,
  tool_name text,
  outcome text not null check (outcome in ('ok', 'denied', 'error', 'invalid')),
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  result_size integer check (result_size is null or result_size >= 0),
  created_at timestamptz not null default now()
);

create index if not exists mcp_connections_user_idx
  on public.mcp_connections (user_id, created_at desc);
create index if not exists mcp_tokens_user_idx
  on public.mcp_tokens (user_id, created_at desc);
create index if not exists mcp_tokens_prefix_idx
  on public.mcp_tokens (token_prefix);
create index if not exists mcp_activity_user_idx
  on public.mcp_activity_log (user_id, created_at desc);
create index if not exists mcp_activity_token_idx
  on public.mcp_activity_log (token_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5) RLS : deny-by-default, plus les privilèges directs retirés
-- ---------------------------------------------------------------------------
alter table public.mcp_connections      enable row level security;
alter table public.mcp_tokens           enable row level security;
alter table public.mcp_tool_permissions enable row level security;
alter table public.mcp_activity_log     enable row level security;

revoke all on public.mcp_connections      from public, anon, authenticated;
revoke all on public.mcp_tokens           from public, anon, authenticated;
revoke all on public.mcp_tool_permissions from public, anon, authenticated;
revoke all on public.mcp_activity_log     from public, anon, authenticated;

-- Défense en profondeur : si un GRANT revenait un jour, la politique ci-dessous
-- n'exposerait toujours que les lignes de l'appelant. Vérifié en base :
-- has_table_privilege('authenticated', 'public.mcp_tokens', 'select') = false.
drop policy if exists mcp_connections_owner_select on public.mcp_connections;
create policy mcp_connections_owner_select on public.mcp_connections
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_tokens_owner_select on public.mcp_tokens;
create policy mcp_tokens_owner_select on public.mcp_tokens
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_activity_owner_select on public.mcp_activity_log;
create policy mcp_activity_owner_select on public.mcp_activity_log
  for select to authenticated using (user_id = auth.uid());
