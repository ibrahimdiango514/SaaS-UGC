-- VYORA MCP — API utilisateur pour l'interface (phase 2)
-- Version appliquée en base : 20261116001121 (vyora_mcp_user_api)
--
-- Ces fonctions prennent l'identité dans `auth.uid()` : un utilisateur connecté
-- ne peut agir que sur SES connexions et SES jetons. Elles sont distinctes des
-- RPC `service_role` du serveur MCP (qui reçoivent `p_user_id` explicitement).
--
-- Le secret d'un jeton est généré ici, renvoyé UNE SEULE FOIS, et seul son
-- SHA-256 est conservé : aucune fonction ne peut le relire ensuite.

-- ---------------------------------------------------------------------------
-- 1) Création d'un jeton
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
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_connection uuid;
  v_token uuid;
  v_secret text;
  v_prefix text;
  v_scopes text[] := coalesce(p_scopes, array['read']::text[]);
  v_kind text := coalesce(nullif(btrim(p_client_kind), ''), 'generic');
  v_label text := btrim(coalesce(p_label, 'Jeton MCP'));
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_kind not in ('claude', 'cursor', 'vscode', 'generic') then
    raise exception 'invalid_client_kind';
  end if;
  -- Portées strictement limitées à read/write, et non vides.
  if cardinality(v_scopes) = 0 or not (v_scopes <@ array['read', 'write']::text[]) then
    raise exception 'invalid_scopes';
  end if;
  if length(v_label) = 0 or length(v_label) > 80 then
    raise exception 'invalid_label';
  end if;
  -- Un seul jeton actif par libellé et par utilisateur : évite les doublons
  -- indémêlables dans la liste des jetons.
  if exists (
    select 1 from public.mcp_tokens
     where user_id = v_user and label = v_label and revoked_at is null
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
    v_user, v_connection, v_label, v_prefix,
    public.mcp_token_hash(v_secret), v_scopes,
    case
      when p_expires_in_days is null then null
      else now() + make_interval(days => greatest(1, least(p_expires_in_days, 365)))
    end
  )
  returning id into v_token;

  -- Le secret en clair n'existe que dans cette réponse : jamais en base, jamais
  -- dans les journaux, jamais relisible par une autre fonction.
  return jsonb_build_object(
    'token_id', v_token,
    'connection_id', v_connection,
    'secret', v_secret,
    'token_prefix', v_prefix,
    'scopes', v_scopes
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Liste des jetons : aucun secret, aucune empreinte
-- ---------------------------------------------------------------------------
create or replace function public.mcp_list_tokens()
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id,
           'label', t.label,
           'token_prefix', t.token_prefix,
           'scopes', t.scopes,
           'client_name', c.client_name,
           'client_kind', c.client_kind,
           'created_at', t.created_at,
           'last_used_at', t.last_used_at,
           'use_count', t.use_count,
           'expires_at', t.expires_at,
           'revoked', t.revoked_at is not null
         ) order by t.created_at desc), '[]'::jsonb)
    into v_rows
    from public.mcp_tokens t
    left join public.mcp_connections c on c.id = t.connection_id
   where t.user_id = v_user;

  return jsonb_build_object('items', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Révocation (idempotente, restreinte au propriétaire)
-- ---------------------------------------------------------------------------
create or replace function public.mcp_revoke_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_rows integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  update public.mcp_tokens
     set revoked_at = coalesce(revoked_at, now())
   where id = p_token_id and user_id = v_user;
  get diagnostics v_rows = row_count;

  -- `revoked = false` signifie « rien d'applicable » : jeton inconnu ou
  -- appartenant à un autre utilisateur. On ne distingue pas les deux cas.
  return jsonb_build_object('revoked', v_rows > 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Rotation : révoque l'ancien et crée le nouveau dans la même transaction
-- ---------------------------------------------------------------------------
create or replace function public.mcp_rotate_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_old public.mcp_tokens%rowtype;
  v_new_id uuid;
  v_secret text;
  v_prefix text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select * into v_old
    from public.mcp_tokens
   where id = p_token_id and user_id = v_user and revoked_at is null
   for update;
  if not found then
    raise exception 'token_not_found';
  end if;

  update public.mcp_tokens set revoked_at = now() where id = v_old.id;

  v_secret := 'vyora_mcp_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_prefix := left(v_secret, 18);

  insert into public.mcp_tokens (user_id, connection_id, label, token_prefix, token_sha256, scopes, expires_at)
  values (v_user, v_old.connection_id, v_old.label, v_prefix, public.mcp_token_hash(v_secret), v_old.scopes, v_old.expires_at)
  returning id into v_new_id;

  return jsonb_build_object('token_id', v_new_id, 'secret', v_secret, 'token_prefix', v_prefix, 'scopes', v_old.scopes);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Journal d'appels de l'utilisateur courant
-- ---------------------------------------------------------------------------
create or replace function public.mcp_list_activity(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_rows jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select a.id, a.method, a.tool_name, a.outcome, a.error_code,
             a.duration_ms, a.token_prefix, a.created_at
        from public.mcp_activity_log a
       where a.user_id = v_user
       order by a.created_at desc
       limit v_limit
    ) x;

  return jsonb_build_object('items', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Autorisations par outil
-- ---------------------------------------------------------------------------
create or replace function public.mcp_set_tool_permission(p_token_id uuid, p_tool_name text, p_allowed boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if p_tool_name !~ '^[a-z][a-z0-9_]{2,63}$' then
    raise exception 'invalid_tool_name';
  end if;
  if not exists (select 1 from public.mcp_tokens where id = p_token_id and user_id = v_user) then
    raise exception 'token_not_found';
  end if;

  insert into public.mcp_tool_permissions (token_id, tool_name, allowed)
  values (p_token_id, p_tool_name, coalesce(p_allowed, false))
  on conflict (token_id, tool_name) do update set allowed = excluded.allowed, granted_at = now();

  return jsonb_build_object('ok', true, 'tool_name', p_tool_name, 'allowed', coalesce(p_allowed, false));
end;
$$;

create or replace function public.mcp_list_tool_permissions(p_token_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_rows jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from public.mcp_tokens where id = p_token_id and user_id = v_user) then
    raise exception 'token_not_found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('tool_name', p.tool_name, 'allowed', p.allowed) order by p.tool_name), '[]'::jsonb)
    into v_rows
    from public.mcp_tool_permissions p
   where p.token_id = p_token_id;

  return jsonb_build_object('items', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Privilèges : utilisateur connecté uniquement
-- ---------------------------------------------------------------------------
revoke all on function public.mcp_create_token(text, text, text, text[], integer) from public, anon;
revoke all on function public.mcp_list_tokens() from public, anon;
revoke all on function public.mcp_revoke_token(uuid) from public, anon;
revoke all on function public.mcp_rotate_token(uuid) from public, anon;
revoke all on function public.mcp_list_activity(integer) from public, anon;
revoke all on function public.mcp_set_tool_permission(uuid, text, boolean) from public, anon;
revoke all on function public.mcp_list_tool_permissions(uuid) from public, anon;

grant execute on function public.mcp_create_token(text, text, text, text[], integer) to authenticated;
grant execute on function public.mcp_list_tokens() to authenticated;
grant execute on function public.mcp_revoke_token(uuid) to authenticated;
grant execute on function public.mcp_rotate_token(uuid) to authenticated;
grant execute on function public.mcp_list_activity(integer) to authenticated;
grant execute on function public.mcp_set_tool_permission(uuid, text, boolean) to authenticated;
grant execute on function public.mcp_list_tool_permissions(uuid) to authenticated;
