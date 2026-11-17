-- Connexions MCP sortantes — persistance (non destructif).
--
-- Objet : enregistrer les serveurs MCP externes auxquels un utilisateur VYORA
-- se connecte, sans jamais stocker de secret en clair dans une colonne lisible
-- par le frontend.
--
-- ## Principles
--
-- 1. Aucune table existante n'est modifiée ni supprimée. Seule création.
-- 2. Isolation stricte à deux niveaux : user_id (propriétaire) ET workspace_id
--    (espace de travail UGC). Les deux sont obligatoires : une connexion
--    n'existe jamais « hors sol ».
-- 3. Les secrets vivent dans Supabase Vault (`vault.secrets`), jamais dans une
--    colonne de la table. La table ne porte qu'un UUID de référence. Les
--    politiques RLS et les GRANT interdisent de l'exposer au frontend : le
--    secret n'est lisible QUE par `public.mcp_servers_secret(uuid)`, en
--    SECURITY DEFINER, dont l'EXECUTE est réservé à `service_role`.
-- 4. Aucune suppression automatique : pas de `on delete cascade` depuis une
--    table métier, pas de purge programmée. Un `revoked_at` trace la
--    révocation ; l'historique reste.
-- 5. Aucun droit d'écriture accordé par défaut à un outil distant : la
--    classification (read/write/destructive/unknown) est posée par le serveur
--    VYORA, jamais recopiée depuis les déclarations du serveur distant.
--
-- ## Rôles réellement définis dans ce projet
--
-- `anon`, `authenticated`, `service_role` : rôles API Supabase.
-- `authenticator` : rôle de connexion PostgREST (`pgrst.db_schemas` inclut
-- `public`, donc toute table de `public` est joignable via PostgREST).
--
-- ⚠️ `service_role` possède DÉJÀ, par défaut dans ce projet, un GRANT SELECT
-- sur `vault.secrets` ET `vault.decrypted_secrets`. Ce n'est pas créé ici et
-- ce n'est pas révoqué ici : `vyora-provider-health`, `store-connect` et
-- d'autres fonctions lisent Vault par ce chemin, et révoquer casserait la
-- production. La conséquence est assumée : `service_role` ne doit JAMAIS être
-- exposé à un navigateur. Toute lecture de secret passe par une Edge Function
-- qui l'utilise côté serveur et ne le renvoie jamais.
--
-- `public` n'est pas créable par `anon`/`authenticated`
-- (`has_schema_privilege(...,'create') = false`, vérifié), donc le
-- `search_path` des fonctions SECURITY DEFINER ci-dessous ne peut pas être
-- détourné par un objet homonyme.
--
-- Retour arrière : `drop table public.mcp_servers_secrets` puis
-- `drop table public.mcp_servers` ; les secrets Vault restent et peuvent être
-- supprimés nommément (`vault.decrypted_secrets` n'est qu'une vue).

-- ---------------------------------------------------------------------------
-- 1. Table des connexions
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_servers (
  id uuid primary key default gen_random_uuid(),

  -- Propriétaire. La connexion ne vaut que pour cet utilisateur.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- Espace de travail UGC. Un même utilisateur peut avoir plusieurs
  -- espaces : une connexion est toujours rattachée à un seul.
  workspace_id uuid not null,

  -- Nom lisible choisi par l'utilisateur (unique dans son espace).
  name text not null,

  -- Endpoint MCP. HTTPS obligatoire, contrôlé aussi à l'exécution par
  -- `safe-egress.ts` (validation d'URL + résolution + adresses publiques).
  url text not null,

  -- Mécanisme d'authentification RÉELLEMENT configuré pour ce serveur.
  -- `none` est légitime (serveurs MCP publics en lecture).
  auth_kind text not null default 'none',

  -- Référence Vault du secret. NULL quand auth_kind = 'none'.
  -- Aucune valeur de secret n'est jamais écrite ici.
  secret_ref uuid,

  -- Identifiant public du client OAuth (non secret), quand auth_kind = 'oauth'.
  oauth_client_id text,

  -- Métadonnées de découverte OAuth (RFC 8414 / RFC 9728), non secrètes.
  authorization_server text,

  -- Cycle de vie.
  status text not null default 'unknown',

  -- Ce que le serveur distant a réellement annoncé, figé au dernier test.
  protocol_version text,
  server_name text,
  server_version text,
  capabilities jsonb not null default '{}'::jsonb,
  tools jsonb not null default '[]'::jsonb,

  -- Permissions accordées par l'utilisateur, outil par outil.
  -- Forme : { "<outil>": "allowed" | "denied" | "pending" }.
  -- Absent = refusé (fail-closed).
  tool_permissions jsonb not null default '{}'::jsonb,

  last_checked_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Révocation : la ligne reste, la connexion n'est plus utilisable.
  revoked_at timestamptz,

  constraint mcp_servers_auth_kind_check
    check (auth_kind in ('none', 'bearer', 'api_key', 'oauth')),
  constraint mcp_servers_status_check
    check (status in (
      'unknown',              -- jamais testé
      'connected',            -- initialize + tools/list réussis
      'auth_required',        -- le serveur exige une authentification
      'error',                -- test en échec
      'revoked'               -- révoqué par l'utilisateur
    )),
  -- Un secret n'a de sens que si une authentification est configurée,
  -- et inversement : `none` ne doit pas traîner de référence.
  constraint mcp_servers_secret_coherence check (
    (auth_kind = 'none' and secret_ref is null)
    or (auth_kind in ('bearer', 'api_key', 'oauth'))
  ),
  constraint mcp_servers_name_len check (char_length(name) between 1 and 120),
  constraint mcp_servers_url_https check (url ~ '^https://'),
  constraint mcp_servers_tools_array check (jsonb_typeof(tools) = 'array'),
  constraint mcp_servers_capabilities_object check (jsonb_typeof(capabilities) = 'object'),
  constraint mcp_servers_permissions_object check (jsonb_typeof(tool_permissions) = 'object')
);

-- Un même nom ne se duplique pas dans un espace donné.
create unique index if not exists mcp_servers_workspace_name_key
  on public.mcp_servers (workspace_id, lower(name))
  where revoked_at is null;

create index if not exists mcp_servers_user_idx
  on public.mcp_servers (user_id, created_at desc);

create index if not exists mcp_servers_workspace_idx
  on public.mcp_servers (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. Table des secrets — séparée pour que RLS puisse la fermer COMPLÈTEMENT
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_servers_secrets (
  server_id uuid primary key references public.mcp_servers (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Nom du secret dans Vault. Jamais une valeur.
  vault_name text not null unique,
  -- Empreinte non réversible, pour vérifier qu'une rotation a eu lieu sans
  -- jamais pouvoir reconstituer le secret.
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_servers_secrets_user_idx
  on public.mcp_servers_secrets (user_id);

-- ---------------------------------------------------------------------------
-- 3. Horodatage de modification
-- ---------------------------------------------------------------------------

create or replace function public.mcp_servers_touch()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists mcp_servers_touch on public.mcp_servers;
create trigger mcp_servers_touch
  before update on public.mcp_servers
  for each row execute function public.mcp_servers_touch();

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------

alter table public.mcp_servers enable row level security;
alter table public.mcp_servers_secrets enable row level security;

-- Les politiques sont nominatives : `to anon, authenticated` et vérification
-- d'appartenance. L'écriture directe en table est REFUSÉE : elle passe
-- exclusivement par des fonctions SECURITY DEFINER qui valident l'espace de
-- travail et écrivent le secret dans Vault. Sans cela, un client pourrait
-- insérer une ligne avec un `secret_ref` arbitraire pointant sur le secret
-- d'un autre utilisateur.

drop policy if exists mcp_servers_select_own on public.mcp_servers;
create policy mcp_servers_select_own
  on public.mcp_servers
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- Aucune politique d'INSERT / UPDATE / DELETE : la table est en écriture
-- fermée pour `anon` et `authenticated`. `service_role` contourne la RLS.

drop policy if exists mcp_servers_secrets_none on public.mcp_servers_secrets;
-- Volontairement aucune politique : même le propriétaire ne lit pas cette
-- table. Elle ne sert qu'aux fonctions SECURITY DEFINER.

/*
 * Ce projet accorde par défaut (`pg_default_acl`) `arwdDxtm` à `anon`,
 * `authenticated` et `service_role` sur CHAQUE nouvelle table de `public`
 * (vérifié le 2026-11-21). Un simple `revoke all ... from public, anon` ne
 * retire donc PAS les privilèges d'`authenticated` : il faut le nommer.
 *
 * On retire en particulier TRUNCATE et TRIGGER, qu'aucun usage applicatif ne
 * justifie ici : TRUNCATE contourne la RLS et détruirait l'historique des
 * connexions, ce qui contredirait la règle « aucune suppression automatique ».
 */
revoke all on public.mcp_servers from public, anon, authenticated;
revoke all on public.mcp_servers_secrets from public, anon, authenticated;
grant select on public.mcp_servers to authenticated;
-- `service_role` contourne la RLS, mais n'a pas besoin de TRUNCATE/TRIGGER :
-- les fonctions SECURITY DEFINER suffisent, et un droit en moins vaut mieux
-- qu'un droit en trop sur une table qui porte l'historique des connexions.
grant select, insert, update, delete on public.mcp_servers to service_role;
grant select, insert, update, delete on public.mcp_servers_secrets to service_role;

-- ---------------------------------------------------------------------------
-- 5. Appartenance à un espace de travail — une seule définition, réutilisée
-- ---------------------------------------------------------------------------

create or replace function public.mcp_is_workspace_member(p_user_id uuid, p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.ugc_workspace_members m
    where m.user_id = p_user_id
      and m.workspace_id = p_workspace_id
  );
$$;

revoke all on function public.mcp_is_workspace_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mcp_is_workspace_member(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Écriture contrôlée : création / mise à jour / révocation
-- ---------------------------------------------------------------------------

/**
 * Crée une connexion. Le secret éventuel est écrit dans Vault, jamais dans
 * `mcp_servers`. Refuse un espace de travail dont l'utilisateur n'est pas
 * membre, et refuse un `auth_kind` incohérent avec la présence d'un secret.
 */
create or replace function public.mcp_servers_create(
  p_user_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_url text,
  p_auth_kind text,
  p_secret text default null,
  p_oauth_client_id text default null,
  p_authorization_server text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  v_id uuid;
  v_vault_name text;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if not public.mcp_is_workspace_member(p_user_id, p_workspace_id) then
    raise exception 'workspace_forbidden' using errcode = '42501';
  end if;
  if p_auth_kind not in ('none', 'bearer', 'api_key', 'oauth') then
    raise exception 'auth_kind_invalid' using errcode = '22023';
  end if;
  if p_auth_kind <> 'none' and coalesce(btrim(p_secret), '') = '' then
    raise exception 'secret_required' using errcode = '22023';
  end if;
  if p_auth_kind = 'none' and coalesce(btrim(p_secret), '') <> '' then
    raise exception 'secret_not_allowed' using errcode = '22023';
  end if;

  insert into public.mcp_servers (
    user_id, workspace_id, name, url, auth_kind, oauth_client_id, authorization_server
  )
  values (
    p_user_id, p_workspace_id, btrim(p_name), p_url, p_auth_kind,
    nullif(btrim(p_oauth_client_id), ''), nullif(btrim(p_authorization_server), '')
  )
  returning id into v_id;

  if p_auth_kind <> 'none' then
    v_vault_name := 'mcp_server_' || v_id::text;
    perform vault.create_secret(
      p_secret,
      v_vault_name,
      'Jeton MCP sortant ' || v_id::text || ' (serveur distant, jamais exposé)'
    );
    insert into public.mcp_servers_secrets (server_id, user_id, vault_name)
    values (v_id, p_user_id, v_vault_name);
    update public.mcp_servers set secret_ref = v_id where id = v_id;
  end if;

  return jsonb_build_object('server_id', v_id);
end;
$$;

/** Fait tourner le secret d'une connexion existante. L'ancien est détruit. */
create or replace function public.mcp_servers_rotate_secret(
  p_user_id uuid,
  p_server_id uuid,
  p_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  v_vault_name text;
  v_secret_id uuid;
begin
  if coalesce(btrim(p_secret), '') = '' then
    raise exception 'secret_required' using errcode = '22023';
  end if;

  select s.vault_name into v_vault_name
    from public.mcp_servers_secrets s
    join public.mcp_servers c on c.id = s.server_id
   where s.server_id = p_server_id and c.user_id = p_user_id;
  if v_vault_name is null then
    raise exception 'server_not_found' using errcode = '42501';
  end if;

  select id into v_secret_id from vault.secrets where name = v_vault_name;
  if v_secret_id is null then
    perform vault.create_secret(p_secret, v_vault_name, 'Jeton MCP sortant ' || p_server_id::text);
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;

  update public.mcp_servers_secrets set rotated_at = now() where server_id = p_server_id;
  update public.mcp_servers
     set status = 'unknown', last_error = null
   where id = p_server_id;

  return jsonb_build_object('server_id', p_server_id, 'rotated', true);
end;
$$;

/** Enregistre le résultat d'un test de connexion. */
create or replace function public.mcp_servers_record_probe(
  p_user_id uuid,
  p_server_id uuid,
  p_status text,
  p_protocol_version text default null,
  p_server_name text default null,
  p_server_version text default null,
  p_capabilities jsonb default '{}'::jsonb,
  p_tools jsonb default '[]'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_status not in ('unknown', 'connected', 'auth_required', 'error', 'revoked') then
    raise exception 'status_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.mcp_servers where id = p_server_id and user_id = p_user_id
  ) then
    raise exception 'server_not_found' using errcode = '42501';
  end if;

  update public.mcp_servers
     set status = p_status,
         protocol_version = coalesce(p_protocol_version, protocol_version),
         server_name = coalesce(p_server_name, server_name),
         server_version = coalesce(p_server_version, server_version),
         capabilities = case when p_capabilities is null then capabilities else p_capabilities end,
         tools = case when p_tools is null then tools else p_tools end,
         -- `error` est effacé dès qu'un test réussit : on ne garde pas une
         -- erreur périmée sur une connexion saine.
         last_error = case when p_status = 'connected' then null else p_error end,
         last_checked_at = now()
   where id = p_server_id;

  return jsonb_build_object('server_id', p_server_id, 'status', p_status);
end;
$$;

/** Révocation : la ligne reste, le secret Vault est détruit. */
create or replace function public.mcp_servers_revoke(
  p_user_id uuid,
  p_server_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  v_vault_name text;
  v_secret_id uuid;
begin
  if not exists (
    select 1 from public.mcp_servers where id = p_server_id and user_id = p_user_id
  ) then
    raise exception 'server_not_found' using errcode = '42501';
  end if;

  select vault_name into v_vault_name
    from public.mcp_servers_secrets where server_id = p_server_id;

  if v_vault_name is not null then
    select id into v_secret_id from vault.secrets where name = v_vault_name;
    if v_secret_id is not null then
      delete from vault.secrets where id = v_secret_id;
    end if;
  end if;

  update public.mcp_servers
     set status = 'revoked',
         revoked_at = now(),
         secret_ref = null,
         -- Les outils découverts restent en historique : on ne réécrit pas
         -- ce que le serveur distant avait réellement annoncé.
         last_error = null
   where id = p_server_id;

  return jsonb_build_object('server_id', p_server_id, 'revoked', true);
end;
$$;

/** Accordé ou refusé, outil par outil. Un outil absent est refusé. */
create or replace function public.mcp_servers_set_permissions(
  p_user_id uuid,
  p_server_id uuid,
  p_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_permissions is null or jsonb_typeof(p_permissions) <> 'object' then
    raise exception 'permissions_invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each_text(p_permissions)
     where value not in ('allowed', 'denied', 'pending')
  ) then
    raise exception 'permission_value_invalid' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.mcp_servers where id = p_server_id and user_id = p_user_id
  ) then
    raise exception 'server_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.mcp_servers where id = p_server_id and revoked_at is not null
  ) then
    raise exception 'server_revoked' using errcode = '42501';
  end if;

  -- Fusion, pas remplacement : un outil non mentionné garde son état.
  update public.mcp_servers
     set tool_permissions = coalesce(tool_permissions, '{}'::jsonb) || p_permissions
   where id = p_server_id;

  return jsonb_build_object('server_id', p_server_id, 'tool_permissions', p_permissions);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Lecture du secret — service_role uniquement, jamais via PostgREST
-- ---------------------------------------------------------------------------

create or replace function public.mcp_servers_secret(p_server_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  v_name text;
  v_secret text;
begin
  select vault_name into v_name
    from public.mcp_servers_secrets where server_id = p_server_id;
  if v_name is null then
    return null;
  end if;
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = v_name;
  return v_secret;
end;
$$;

revoke all on function public.mcp_servers_secret(uuid) from public, anon, authenticated;
grant execute on function public.mcp_servers_secret(uuid) to service_role;

-- Les autres fonctions d'écriture : service_role seulement. Le frontend passe
-- par une Edge Function qui vérifie la session puis appelle ces fonctions.
revoke all on function public.mcp_servers_create(uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.mcp_servers_rotate_secret(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.mcp_servers_record_probe(uuid, uuid, text, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.mcp_servers_revoke(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.mcp_servers_set_permissions(uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.mcp_servers_create(uuid, uuid, text, text, text, text, text, text)
  to service_role;
grant execute on function public.mcp_servers_rotate_secret(uuid, uuid, text) to service_role;
grant execute on function public.mcp_servers_record_probe(uuid, uuid, text, text, text, text, jsonb, jsonb, text)
  to service_role;
grant execute on function public.mcp_servers_revoke(uuid, uuid) to service_role;
grant execute on function public.mcp_servers_set_permissions(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Vue de lecture pour le frontend : jamais la référence du secret
-- ---------------------------------------------------------------------------

create or replace view public.mcp_servers_public
with (security_invoker = true)
as
select
  id,
  workspace_id,
  name,
  url,
  auth_kind,
  -- Booléen seulement : le frontend sait SI un secret existe, jamais lequel.
  (secret_ref is not null) as has_secret,
  status,
  protocol_version,
  server_name,
  server_version,
  capabilities,
  tools,
  tool_permissions,
  last_checked_at,
  last_error,
  created_at,
  updated_at,
  revoked_at
from public.mcp_servers
where user_id = (select auth.uid());

revoke all on public.mcp_servers_public from public, anon, authenticated;
grant select on public.mcp_servers_public to authenticated, service_role;

comment on table public.mcp_servers is
  'Serveurs MCP externes enregistrés par les utilisateurs VYORA. Aucun secret ici : voir mcp_servers_secrets et Vault.';
comment on table public.mcp_servers_secrets is
  'Références Vault des jetons MCP sortants. Aucune valeur lisible, aucune politique RLS : service_role seulement.';
comment on column public.mcp_servers.tool_permissions is
  'Permissions outil par outil : allowed | denied | pending. Un outil absent est refusé (fail-closed).';

-- ---------------------------------------------------------------------------
-- 9. Auto-vérification (facultative)
-- ---------------------------------------------------------------------------
--
-- Bloc commenté volontairement : la migration reste purement DDL. Pour
-- contrôler l'état juste après l'exécution, décommentez-le, exécutez, puis
-- re-commentez. Chaque ligne doit renvoyer `true`.
--
-- select
--   to_regclass('public.mcp_servers') is not null          as table_servers,
--   to_regclass('public.mcp_servers_secrets') is not null  as table_secrets,
--   to_regclass('public.mcp_servers_public') is not null   as vue_publique,
--   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname in (
--       'mcp_servers_touch','mcp_is_workspace_member','mcp_servers_create',
--       'mcp_servers_rotate_secret','mcp_servers_record_probe',
--       'mcp_servers_revoke','mcp_servers_set_permissions','mcp_servers_secret'
--     )) = 8                                             as huit_fonctions,
--   (select relrowsecurity from pg_class where oid = 'public.mcp_servers'::regclass) as rls_servers,
--   (select relrowsecurity from pg_class where oid = 'public.mcp_servers_secrets'::regclass) as rls_secrets,
--   -- Aucun droit d'écriture pour le frontend :
--   not has_table_privilege('authenticated', 'public.mcp_servers', 'insert')
--     and not has_table_privilege('authenticated', 'public.mcp_servers', 'update')
--     and not has_table_privilege('authenticated', 'public.mcp_servers', 'delete') as frontend_lecture_seule,
--   not has_table_privilege('authenticated', 'public.mcp_servers_secrets', 'select') as secrets_invisibles,
--   -- La fonction de lecture du secret n'est pas appelable par un utilisateur :
--   not has_function_privilege('authenticated', 'public.mcp_servers_secret(uuid)', 'execute') as secret_non_appelable;
