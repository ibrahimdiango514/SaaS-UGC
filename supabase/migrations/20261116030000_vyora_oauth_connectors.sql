-- VYORA — socle des connecteurs OAuth (Gmail, Google Drive, Google Calendar).
--
-- Cette migration décrit l'état FINAL appliqué au projet `xbuuhfwobrafcbgtdgjx`.
-- Elle est idempotente : la rejouer ne casse rien et ne détruit aucune donnée
-- (les seules suppressions visent des colonnes de schéma jamais peuplées).
--
-- ## Ce qui est protégé, et comment
--   - `oauth_accounts` : jetons Google CHIFFRÉS (AES-256-GCM côté Edge Function).
--     Chaque jeton (access ET refresh) possède son PROPRE IV et sa PROPRE
--     étiquette GCM. Réutiliser un IV entre deux chiffrements sous la même clé
--     détruirait la confidentialité — d'où des colonnes distinctes.
--     La clé vit uniquement dans le secret `VYORA_OAUTH_ENCRYPTION_KEY` : sans
--     elle, tout cryptogramme en base est inexploitable.
--   - `capabilities` est bornée à `read | draft | send | modify` par contrainte.
--     Une capacité inconnue est refusée par la base, pas seulement par le code.
--   - `oauth_states` : état CSRF + vérificateur PKCE chiffrés, TTL 10 minutes,
--     usage unique (`consumed_at` posé sous `for update` dans la RPC).
--   - `oauth_audit_log` : trace des connexions, révocations, rafraîchissements
--     et refus de capacité.
--
-- ## Privilèges
--   - RLS activée sur les trois tables, aucune politique pour `anon`.
--   - `revoke all` sur `anon` et `authenticated` : aucun accès direct aux tables.
--   - Les RPC qui manipulent des cryptogrammes (`oauth_account_secret`,
--     `oauth_account_upsert`, `oauth_account_update_tokens`, `oauth_state_*`)
--     ne sont exécutables QUE par `service_role`.
--   - Les RPC utilisateur (`oauth_list_accounts`, `oauth_revoke_account`,
--     `oauth_audit_list`) reposent sur `auth.uid()` : un utilisateur ne peut
--     jamais désigner un autre compte. `oauth_list_accounts` n'expose aucun
--     cryptogramme.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.oauth_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('gmail', 'google_drive', 'google_calendar')),
  external_account_id text not null,
  display_name text,
  email text,
  access_token_cipher text,
  refresh_token_cipher text,
  access_expires_at timestamptz,
  capabilities text[] not null default array['read']::text[],
  granted_scopes text[] not null default array[]::text[],
  status text not null default 'pending'
    check (status in ('pending', 'connected', 'expired', 'revoked', 'error')),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, external_account_id)
);

-- Un IV et une étiquette par jeton : jamais partagés entre deux chiffrements.
alter table public.oauth_accounts add column if not exists access_token_iv text;
alter table public.oauth_accounts add column if not exists access_token_tag text;
alter table public.oauth_accounts add column if not exists refresh_token_iv text;
alter table public.oauth_accounts add column if not exists refresh_token_tag text;

-- Colonnes d'une version antérieure du schéma, jamais peuplées (0 ligne) :
-- supprimées pour éviter deux sources de vérité sur le chiffrement.
alter table public.oauth_accounts drop column if exists token_iv;
alter table public.oauth_accounts drop column if exists token_tag;

-- Liste de capacités fermée : la base refuse tout ce qui n'est pas prévu.
alter table public.oauth_accounts drop constraint if exists oauth_accounts_capabilities_check;
alter table public.oauth_accounts add constraint oauth_accounts_capabilities_check
  check (capabilities <@ array['read', 'draft', 'send', 'modify']::text[]);

create index if not exists oauth_accounts_user_idx
  on public.oauth_accounts (user_id, provider, created_at desc);

create table if not exists public.oauth_states (
  state text primary key check (length(state) between 20 and 200),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  code_verifier_cipher text not null,
  code_verifier_iv text not null,
  code_verifier_tag text not null,
  requested_capabilities text[] not null default array['read']::text[],
  redirect_after text,
  consumed_at timestamptz,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);

create index if not exists oauth_states_user_idx on public.oauth_states (user_id, provider);

create table if not exists public.oauth_audit_log (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  account_id uuid references public.oauth_accounts(id) on delete set null,
  provider text,
  action text not null check (action in (
    'connect_start', 'connect_success', 'connect_failure',
    'token_refresh', 'token_refresh_failure',
    'revoke', 'read', 'draft', 'send', 'modify', 'denied'
  )),
  capability text,
  outcome text not null default 'ok' check (outcome in ('ok', 'denied', 'error')),
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists oauth_audit_user_idx
  on public.oauth_audit_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS : refus par défaut
-- ---------------------------------------------------------------------------

alter table public.oauth_accounts enable row level security;
alter table public.oauth_states enable row level security;
alter table public.oauth_audit_log enable row level security;

revoke all on public.oauth_accounts from public, anon, authenticated;
revoke all on public.oauth_states from public, anon, authenticated;
revoke all on public.oauth_audit_log from public, anon, authenticated;

drop policy if exists oauth_accounts_owner_select on public.oauth_accounts;
create policy oauth_accounts_owner_select on public.oauth_accounts
  for select to authenticated using (user_id = auth.uid());

drop policy if exists oauth_audit_owner_select on public.oauth_audit_log;
create policy oauth_audit_owner_select on public.oauth_audit_log
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- RPC utilisateur — bornées par auth.uid(), aucun cryptogramme exposé
-- ---------------------------------------------------------------------------

create or replace function public.oauth_list_accounts()
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare v_user uuid := auth.uid(); v_rows jsonb;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'provider', a.provider,
           'external_account_id', a.external_account_id,
           'display_name', a.display_name, 'email', a.email,
           'capabilities', a.capabilities, 'status', a.status,
           'last_verified_at', a.last_verified_at, 'last_error', a.last_error,
           'created_at', a.created_at
         ) order by a.created_at desc), '[]'::jsonb)
    into v_rows from public.oauth_accounts a where a.user_id = v_user;
  return jsonb_build_object('items', v_rows);
end; $$;

-- La révocation EFFACE les cryptogrammes : un jeton révoqué ne reste pas
-- déchiffrable en base.
create or replace function public.oauth_revoke_account(p_account_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_user uuid := auth.uid(); v_rows integer;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.oauth_accounts set
    status = 'revoked',
    access_token_cipher = null, access_token_iv = null, access_token_tag = null,
    refresh_token_cipher = null, refresh_token_iv = null, refresh_token_tag = null,
    capabilities = array[]::text[], updated_at = now()
  where id = p_account_id and user_id = v_user;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    insert into public.oauth_audit_log (user_id, account_id, action, outcome)
    values (v_user, p_account_id, 'revoke', 'ok');
  end if;
  return jsonb_build_object('revoked', v_rows > 0);
end; $$;

create or replace function public.oauth_audit_list(p_limit integer default 50)
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare v_user uuid := auth.uid(); v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200)); v_rows jsonb;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (select l.id, l.provider, l.action, l.capability, l.outcome, l.detail, l.created_at
            from public.oauth_audit_log l where l.user_id = v_user
           order by l.created_at desc limit v_limit) x;
  return jsonb_build_object('items', v_rows);
end; $$;

revoke all on function public.oauth_list_accounts() from public, anon;
revoke all on function public.oauth_revoke_account(uuid) from public, anon;
revoke all on function public.oauth_audit_list(integer) from public, anon;
grant execute on function public.oauth_list_accounts() to authenticated;
grant execute on function public.oauth_revoke_account(uuid) to authenticated;
grant execute on function public.oauth_audit_list(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC serveur — service_role uniquement
-- ---------------------------------------------------------------------------

create or replace function public.oauth_state_create(
  p_state text, p_user_id uuid, p_provider text,
  p_verifier_cipher text, p_verifier_iv text, p_verifier_tag text,
  p_capabilities text[]
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_user_id is null then raise exception 'user_required'; end if;
  -- Purge des états périmés : la table ne grossit pas indéfiniment.
  delete from public.oauth_states where expires_at < now() - interval '1 hour';
  insert into public.oauth_states (
    state, user_id, provider, code_verifier_cipher, code_verifier_iv, code_verifier_tag, requested_capabilities
  ) values (p_state, p_user_id, p_provider, p_verifier_cipher, p_verifier_iv, p_verifier_tag, p_capabilities);
  return true;
end; $$;

-- Usage unique : `consumed_at` est posé sous verrou, donc un rejeu concurrent
-- ne peut pas aboutir deux fois.
create or replace function public.oauth_state_consume(p_state text)
returns table (
  user_id uuid, provider text, verifier_cipher text, verifier_iv text,
  verifier_tag text, requested_capabilities text[]
)
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_row public.oauth_states%rowtype;
begin
  select * into v_row from public.oauth_states s
   where s.state = p_state and s.consumed_at is null and s.expires_at > now()
   for update;
  if not found then return; end if;
  update public.oauth_states set consumed_at = now() where state = p_state;
  user_id := v_row.user_id;
  provider := v_row.provider;
  verifier_cipher := v_row.code_verifier_cipher;
  verifier_iv := v_row.code_verifier_iv;
  verifier_tag := v_row.code_verifier_tag;
  requested_capabilities := v_row.requested_capabilities;
  return next;
end; $$;

create or replace function public.oauth_account_upsert(p_payload jsonb)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_user uuid := nullif(p_payload->>'user_id', '')::uuid;
  v_provider text := p_payload->>'provider';
begin
  if v_user is null or v_provider is null then raise exception 'invalid_payload'; end if;
  insert into public.oauth_accounts (
    user_id, provider, external_account_id, display_name, email,
    access_token_cipher, access_token_iv, access_token_tag,
    refresh_token_cipher, refresh_token_iv, refresh_token_tag,
    access_expires_at, capabilities, granted_scopes, status, last_verified_at, last_error
  ) values (
    v_user, v_provider, p_payload->>'external_account_id',
    nullif(p_payload->>'display_name', ''), nullif(p_payload->>'email', ''),
    nullif(p_payload->>'access_token_cipher', ''),
    nullif(p_payload->>'access_token_iv', ''),
    nullif(p_payload->>'access_token_tag', ''),
    nullif(p_payload->>'refresh_token_cipher', ''),
    nullif(p_payload->>'refresh_token_iv', ''),
    nullif(p_payload->>'refresh_token_tag', ''),
    nullif(p_payload->>'access_expires_at', '')::timestamptz,
    coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload->'capabilities') as value), array['read']::text[]),
    coalesce((select array_agg(value) from jsonb_array_elements_text(p_payload->'granted_scopes') as value), array[]::text[]),
    coalesce(nullif(p_payload->>'status', ''), 'pending'), now(), nullif(p_payload->>'last_error', '')
  )
  on conflict (user_id, provider, external_account_id) do update set
    display_name = coalesce(excluded.display_name, public.oauth_accounts.display_name),
    email = coalesce(excluded.email, public.oauth_accounts.email),
    access_token_cipher = excluded.access_token_cipher,
    access_token_iv = excluded.access_token_iv,
    access_token_tag = excluded.access_token_tag,
    refresh_token_cipher = coalesce(excluded.refresh_token_cipher, public.oauth_accounts.refresh_token_cipher),
    refresh_token_iv = coalesce(excluded.refresh_token_iv, public.oauth_accounts.refresh_token_iv),
    refresh_token_tag = coalesce(excluded.refresh_token_tag, public.oauth_accounts.refresh_token_tag),
    access_expires_at = excluded.access_expires_at,
    capabilities = excluded.capabilities, granted_scopes = excluded.granted_scopes,
    status = excluded.status, last_verified_at = now(), last_error = excluded.last_error, updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

-- Cible d'un rafraîchissement : ne touche que les jetons, jamais les capacités
-- ni l'identité du compte.
create or replace function public.oauth_account_update_tokens(
  p_account_id uuid, p_access_cipher text, p_access_iv text, p_access_tag text,
  p_refresh_cipher text, p_refresh_iv text, p_refresh_tag text, p_expires_at timestamptz
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  update public.oauth_accounts set
    access_token_cipher = p_access_cipher,
    access_token_iv = p_access_iv,
    access_token_tag = p_access_tag,
    refresh_token_cipher = coalesce(p_refresh_cipher, refresh_token_cipher),
    refresh_token_iv = coalesce(p_refresh_iv, refresh_token_iv),
    refresh_token_tag = coalesce(p_refresh_tag, refresh_token_tag),
    access_expires_at = p_expires_at,
    status = 'connected', last_error = null, last_verified_at = now(), updated_at = now()
  where id = p_account_id;
  return found;
end; $$;

-- Version courte (sans IV séparés) : supprimée pour qu'aucun appelant ne
-- puisse réintroduire le partage d'IV.
drop function if exists public.oauth_account_update_tokens(uuid, text, text, text, text, timestamptz);

create or replace function public.oauth_account_secret(p_account_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = pg_catalog, public
as $$
declare v_row public.oauth_accounts%rowtype;
begin
  select * into v_row from public.oauth_accounts where id = p_account_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', v_row.id, 'user_id', v_row.user_id, 'provider', v_row.provider,
    'external_account_id', v_row.external_account_id,
    'status', v_row.status, 'capabilities', v_row.capabilities,
    'access_token_cipher', v_row.access_token_cipher,
    'access_token_iv', v_row.access_token_iv,
    'access_token_tag', v_row.access_token_tag,
    'refresh_token_cipher', v_row.refresh_token_cipher,
    'refresh_token_iv', v_row.refresh_token_iv,
    'refresh_token_tag', v_row.refresh_token_tag,
    'access_expires_at', v_row.access_expires_at
  );
end; $$;

create or replace function public.oauth_account_set_status(p_account_id uuid, p_status text, p_error text default null)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('pending', 'connected', 'expired', 'revoked', 'error') then
    raise exception 'invalid_status';
  end if;
  update public.oauth_accounts
     set status = p_status, last_error = p_error, updated_at = now()
   where id = p_account_id;
  return found;
end; $$;

create or replace function public.oauth_audit_write(p_payload jsonb)
returns bigint language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_id bigint;
begin
  insert into public.oauth_audit_log (user_id, account_id, provider, action, capability, outcome, detail)
  values (
    nullif(p_payload->>'user_id', '')::uuid, nullif(p_payload->>'account_id', '')::uuid,
    nullif(p_payload->>'provider', ''),
    coalesce(nullif(p_payload->>'action', ''), 'connect_failure'),
    nullif(p_payload->>'capability', ''),
    coalesce(nullif(p_payload->>'outcome', ''), 'error'),
    nullif(p_payload->>'detail', '')
  ) returning id into v_id;
  return v_id;
exception when others then return null;
end; $$;

revoke all on function public.oauth_state_create(text, uuid, text, text, text, text, text[]) from public, anon, authenticated;
revoke all on function public.oauth_state_consume(text) from public, anon, authenticated;
revoke all on function public.oauth_account_upsert(jsonb) from public, anon, authenticated;
revoke all on function public.oauth_account_update_tokens(uuid, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.oauth_account_secret(uuid) from public, anon, authenticated;
revoke all on function public.oauth_account_set_status(uuid, text, text) from public, anon, authenticated;
revoke all on function public.oauth_audit_write(jsonb) from public, anon, authenticated;

grant execute on function public.oauth_state_create(text, uuid, text, text, text, text, text[]) to service_role;
grant execute on function public.oauth_state_consume(text) to service_role;
grant execute on function public.oauth_account_upsert(jsonb) to service_role;
grant execute on function public.oauth_account_update_tokens(uuid, text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.oauth_account_secret(uuid) to service_role;
grant execute on function public.oauth_account_set_status(uuid, text, text) to service_role;
grant execute on function public.oauth_audit_write(jsonb) to service_role;
