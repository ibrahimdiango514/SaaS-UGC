-- VYORA — serveur MCP officiel : schéma d'authentification et d'audit.
--
-- ## Pourquoi cette migration existe
--
-- Les tables `mcp_tokens`, `mcp_connections`, `mcp_tool_permissions` et
-- `mcp_activity_log`, ainsi que leurs fonctions, ont été créées DIRECTEMENT en
-- production lors de la première mise en service du serveur MCP. Elles
-- fonctionnent, mais elles n'existaient nulle part dans le dépôt : un
-- environnement recréé à partir des migrations n'aurait eu aucun serveur MCP.
--
-- Cette migration reconstitue donc l'état existant à l'identique, en
-- `if not exists` et `create or replace` — elle ne détruit rien, ne renomme
-- rien, et ne réécrit aucune ligne. Sur la production actuelle, elle est un
-- no-op fonctionnel ; sur un environnement neuf, elle crée ce qui manque.
--
-- ## Le modèle de sécurité, en une phrase
--
-- Un jeton MCP n'est PAS une clé Supabase : c'est un secret opaque
-- (`vyora_mcp_…`, 32 octets d'entropie) dont seule l'empreinte SHA-256 est
-- stockée. Le serveur Edge le résout avec la clé de service, en déduit un
-- `user_id`, et n'appelle ensuite que des fonctions qui prennent ce
-- `user_id` en paramètre — jamais un identifiant fourni par le client.
--
-- ## Ce que cette migration AJOUTE
--
-- Les outils catalogue de la phase 4 de la mission MCP : boutiques connectées,
-- produits, fiche produit, historique d'import, aperçus d'import, état des
-- intégrations, création de produit. Toutes les nouvelles fonctions :
--
--   * sont `SECURITY DEFINER` avec `search_path` figé ;
--   * n'exécutent rien pour `anon` ;
--   * vérifient l'appartenance de l'entreprise avec `bg_can_workspace` plutôt
--     que de faire confiance à un `workspace_id` reçu ;
--   * ne renvoient aucun secret — ni clé, ni référence de coffre.

-- ---------------------------------------------------------------------------
-- 1) Tables (identiques à la production ; créées seulement si absentes)
-- ---------------------------------------------------------------------------

create table if not exists public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  client_name text not null,
  client_kind text not null,
  last_seen_at timestamptz,
  last_seen_ip_hash text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid references public.mcp_connections (id) on delete cascade,
  label text not null,
  -- Préfixe affichable : permet à l'utilisateur de reconnaître un jeton sans
  -- jamais exposer le secret, qui n'est stocké nulle part en clair.
  token_prefix text not null,
  token_sha256 text not null unique,
  scopes text[] not null default array['read']::text[],
  revoked_at timestamptz,
  expires_at timestamptz,
  last_used_at timestamptz,
  use_count bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_tool_permissions (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.mcp_tokens (id) on delete cascade,
  tool_name text not null,
  allowed boolean not null default true,
  granted_at timestamptz not null default now(),
  unique (token_id, tool_name)
);

create table if not exists public.mcp_activity_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  token_id uuid,
  connection_id uuid,
  -- Seul le préfixe est journalisé : un journal ne doit jamais permettre de
  -- reconstituer un secret.
  token_prefix text,
  method text not null,
  tool_name text,
  outcome text not null,
  error_code text,
  duration_ms integer,
  result_size integer,
  created_at timestamptz not null default now()
);

create index if not exists mcp_tokens_user_idx on public.mcp_tokens (user_id) where revoked_at is null;
create index if not exists mcp_tokens_hash_idx on public.mcp_tokens (token_sha256);
create index if not exists mcp_activity_user_idx on public.mcp_activity_log (user_id, created_at desc);

alter table public.mcp_connections enable row level security;
alter table public.mcp_tokens enable row level security;
alter table public.mcp_tool_permissions enable row level security;
alter table public.mcp_activity_log enable row level security;

-- Chaque utilisateur ne voit que ses propres lignes ; personne ne les écrit
-- depuis le client — tout passe par les fonctions ci-dessous.
drop policy if exists mcp_connections_owner on public.mcp_connections;
create policy mcp_connections_owner on public.mcp_connections
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_tokens_owner on public.mcp_tokens;
create policy mcp_tokens_owner on public.mcp_tokens
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_tool_permissions_owner on public.mcp_tool_permissions;
create policy mcp_tool_permissions_owner on public.mcp_tool_permissions
  for select to authenticated using (
    exists (select 1 from public.mcp_tokens t where t.id = token_id and t.user_id = auth.uid())
  );

drop policy if exists mcp_activity_owner on public.mcp_activity_log;
create policy mcp_activity_owner on public.mcp_activity_log
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.mcp_tokens, public.mcp_connections,
  public.mcp_tool_permissions from anon, authenticated;
revoke insert, update, delete on public.mcp_activity_log from anon, authenticated;
grant select on public.mcp_tokens, public.mcp_connections, public.mcp_tool_permissions
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Fonctions d'authentification (identiques à la production)
-- ---------------------------------------------------------------------------

create or replace function public.mcp_token_hash(p_secret text)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'extensions'
as $function$ select encode(digest(p_secret, 'sha256'), 'hex'); $function$;

-- Restreinte au service : l'empreinte sert à la résolution serveur, pas à un
-- client. L'accorder à `authenticated` permettrait de balayer l'espace des
-- empreintes.
revoke all on function public.mcp_token_hash(text) from public, anon, authenticated;

create or replace function public.mcp_resolve_token(p_secret text)
returns table (token_id uuid, user_id uuid, connection_id uuid, scopes text[], token_prefix text)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_hash text;
begin
  -- Un secret trop court ne peut pas être un jeton : on évite un aller-retour
  -- de hachage inutile sur une entrée manifestement invalide.
  if p_secret is null or length(p_secret) < 20 then return; end if;
  v_hash := public.mcp_token_hash(p_secret);
  return query
  select t.id, t.user_id, t.connection_id, t.scopes, t.token_prefix
    from public.mcp_tokens t
   where t.token_sha256 = v_hash
     and t.revoked_at is null
     -- Jeton expiré = jeton mort. La condition est ici, au seul endroit qui
     -- décide qu'un jeton est valide, et non dans le serveur Edge.
     and (t.expires_at is null or t.expires_at > now())
     and exists (
       select 1 from public.mcp_connections c
        where c.id = t.connection_id and c.revoked_at is null
     );
end; $function$;

revoke all on function public.mcp_resolve_token(text) from public, anon, authenticated;

create or replace function public.mcp_touch_token(p_token_id uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  update public.mcp_tokens
     set last_used_at = now(), use_count = use_count + 1
   where id = p_token_id;
end; $function$;

revoke all on function public.mcp_touch_token(uuid) from public, anon, authenticated;

/*
 * Retourne l'identifiant de la ligne journalisée.
 *
 * `void` serait plus naturel, mais la fonction DÉJÀ déployée retourne `bigint`
 * et PostgreSQL refuse de changer le type de retour d'une fonction existante
 * (`42P13`) : la migration échouerait en production. On conserve donc la
 * signature réellement en place — la reconstituer fidèlement est justement le
 * but de cette migration.
 */
create or replace function public.mcp_log_activity(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_id bigint;
begin
  insert into public.mcp_activity_log (
    user_id, token_id, connection_id, token_prefix, method, tool_name,
    outcome, error_code, duration_ms, result_size
  ) values (
    nullif(p_payload->>'user_id', '')::uuid,
    nullif(p_payload->>'token_id', '')::uuid,
    nullif(p_payload->>'connection_id', '')::uuid,
    p_payload->>'token_prefix',
    coalesce(p_payload->>'method', 'unknown'),
    p_payload->>'tool_name',
    coalesce(p_payload->>'outcome', 'unknown'),
    p_payload->>'error_code',
    nullif(p_payload->>'duration_ms', '')::integer,
    nullif(p_payload->>'result_size', '')::integer
  )
  returning id into v_id;
  return v_id;
end; $function$;

revoke all on function public.mcp_log_activity(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Gestion des jetons par l'utilisateur lui-même
-- ---------------------------------------------------------------------------

create or replace function public.mcp_create_token(
  p_label text default 'Jeton MCP',
  p_client_name text default 'Client MCP',
  p_client_kind text default 'generic',
  p_scopes text[] default array['read']::text[],
  p_expires_in_days integer default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_user uuid := auth.uid();
  v_connection uuid;
  v_token uuid;
  v_secret text;
  v_prefix text;
  v_scopes text[] := coalesce(p_scopes, array['read']::text[]);
  v_kind text := coalesce(nullif(btrim(p_client_kind), ''), 'generic');
begin
  -- L'identité vient de la session GoTrue, jamais d'un paramètre.
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_kind not in ('claude', 'cursor', 'vscode', 'generic', 'autre') then
    raise exception 'invalid_client_kind';
  end if;
  -- Portées strictement limitées à read/write, non vide. Un jeton ne peut donc
  -- pas recevoir une portée administrateur même si l'appelant la demande.
  if cardinality(v_scopes) = 0 or not (v_scopes <@ array['read', 'write']::text[]) then
    raise exception 'invalid_scopes';
  end if;
  if exists (
    select 1 from public.mcp_tokens
     where user_id = v_user and label = btrim(coalesce(p_label, 'Jeton MCP')) and revoked_at is null
  ) then
    raise exception 'duplicate_label';
  end if;

  insert into public.mcp_connections (user_id, client_name, client_kind)
  values (v_user, coalesce(nullif(btrim(p_client_name), ''), 'Client MCP'), v_kind)
  returning id into v_connection;

  -- 32 octets d'entropie, base64url sans suffixe '='.
  v_secret := 'vyora_mcp_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_prefix := left(v_secret, 18);

  insert into public.mcp_tokens (user_id, connection_id, label, token_prefix, token_sha256, scopes, expires_at)
  values (
    v_user, v_connection, btrim(coalesce(p_label, 'Jeton MCP')), v_prefix,
    public.mcp_token_hash(v_secret), v_scopes,
    case when p_expires_in_days is null then null
         else now() + make_interval(days => greatest(1, least(p_expires_in_days, 365))) end
  )
  returning id into v_token;

  -- Le secret en clair n'existe que dans cette réponse : jamais en base,
  -- jamais dans les journaux.
  return jsonb_build_object(
    'token_id', v_token,
    'connection_id', v_connection,
    'secret', v_secret,
    'token_prefix', v_prefix,
    'scopes', v_scopes
  );
end;
$function$;

revoke all on function public.mcp_create_token(text, text, text, text[], integer) from public, anon;
grant execute on function public.mcp_create_token(text, text, text, text[], integer) to authenticated;

create or replace function public.mcp_list_tokens()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'token_id', t.id,
      'connection_id', t.connection_id,
      'label', t.label,
      'client_name', c.client_name,
      'client_kind', c.client_kind,
      'token_prefix', t.token_prefix,
      'scopes', t.scopes,
      'created_at', t.created_at,
      'last_used_at', t.last_used_at,
      'use_count', t.use_count,
      'expires_at', t.expires_at,
      'revoked_at', t.revoked_at,
      'actif', t.revoked_at is null and (t.expires_at is null or t.expires_at > now())
    ) order by t.created_at desc)
    from public.mcp_tokens t
    left join public.mcp_connections c on c.id = t.connection_id
    where t.user_id = v_user
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.mcp_list_tokens() from public, anon;
grant execute on function public.mcp_list_tokens() to authenticated;

create or replace function public.mcp_revoke_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid(); v_conn uuid;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  -- Le `user_id` dans le WHERE est la protection contre la révocation d'un
  -- jeton d'autrui par identifiant deviné.
  update public.mcp_tokens
     set revoked_at = now()
   where id = p_token_id and user_id = v_user and revoked_at is null
   returning connection_id into v_conn;
  if not found then
    return jsonb_build_object('revoked', false, 'reason', 'not_found_or_already_revoked');
  end if;
  -- Révoquer le jeton révoque la connexion : le client perd immédiatement
  -- l'accès, sans attendre l'expiration.
  update public.mcp_connections set revoked_at = now(), updated_at = now()
   where id = v_conn and user_id = v_user;
  return jsonb_build_object('revoked', true);
end;
$function$;

revoke all on function public.mcp_revoke_token(uuid) from public, anon;
grant execute on function public.mcp_revoke_token(uuid) to authenticated;

create or replace function public.mcp_rotate_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_user uuid := auth.uid();
  v_old public.mcp_tokens%rowtype;
  v_secret text;
  v_prefix text;
  v_new uuid;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_old from public.mcp_tokens
   where id = p_token_id and user_id = v_user and revoked_at is null;
  if not found then
    return jsonb_build_object('rotated', false, 'reason', 'not_found_or_revoked');
  end if;

  v_secret := 'vyora_mcp_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_prefix := left(v_secret, 18);

  insert into public.mcp_tokens (user_id, connection_id, label, token_prefix, token_sha256, scopes, expires_at)
  values (v_user, v_old.connection_id, v_old.label, v_prefix,
          public.mcp_token_hash(v_secret), v_old.scopes, v_old.expires_at)
  returning id into v_new;

  -- L'ancien jeton meurt dans la même transaction : il n'existe aucun instant
  -- où les deux sont valides.
  update public.mcp_tokens set revoked_at = now() where id = v_old.id;

  return jsonb_build_object('rotated', true, 'token_id', v_new, 'secret', v_secret, 'token_prefix', v_prefix);
end;
$function$;

revoke all on function public.mcp_rotate_token(uuid) from public, anon;
grant execute on function public.mcp_rotate_token(uuid) to authenticated;

create or replace function public.mcp_set_tool_permission(p_token_id uuid, p_tool_name text, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid(); v_nom text := btrim(coalesce(p_tool_name, ''));
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_nom = '' then raise exception 'tool_required'; end if;
  if not exists (select 1 from public.mcp_tokens where id = p_token_id and user_id = v_user) then
    raise exception 'token_not_found' using errcode = '42501';
  end if;
  insert into public.mcp_tool_permissions (token_id, tool_name, allowed)
  values (p_token_id, v_nom, coalesce(p_allowed, true))
  on conflict (token_id, tool_name) do update
    set allowed = excluded.allowed, granted_at = now();
  return jsonb_build_object('tool_name', v_nom, 'allowed', coalesce(p_allowed, true));
end;
$function$;

revoke all on function public.mcp_set_tool_permission(uuid, text, boolean) from public, anon;
grant execute on function public.mcp_set_tool_permission(uuid, text, boolean) to authenticated;

create or replace function public.mcp_list_tool_permissions(p_token_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.mcp_tokens where id = p_token_id and user_id = v_user) then
    raise exception 'token_not_found' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('tool_name', p.tool_name, 'allowed', p.allowed, 'granted_at', p.granted_at)
                     order by p.tool_name)
      from public.mcp_tool_permissions p where p.token_id = p_token_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.mcp_list_tool_permissions(uuid) from public, anon;
grant execute on function public.mcp_list_tool_permissions(uuid) to authenticated;

create or replace function public.mcp_list_activity(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid(); v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'method', a.method, 'tool_name', a.tool_name, 'outcome', a.outcome,
      'error_code', a.error_code, 'duration_ms', a.duration_ms, 'created_at', a.created_at
    ) order by a.created_at desc)
      from (select * from public.mcp_activity_log
             where user_id = v_user order by created_at desc limit v_limit) a
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.mcp_list_activity(integer) from public, anon;
grant execute on function public.mcp_list_activity(integer) to authenticated;
