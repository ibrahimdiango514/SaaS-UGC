-- =============================================================================
-- P6d — OAuth sortant : corrections démontrées en réel.
--
-- 1) `mcp_servers_create` : en mode `oauth`, le secret est OPTIONNEL. Le jeton
--    est obtenu par le flux d'autorisation ; exiger un jeton à la création
--    rendait ce flux inutilisable depuis le navigateur (constaté : la page
--    forçait un « placeholder »). Sans secret, la connexion naît en
--    `auth_required`, ce que l'interface traduit par « Autoriser ».
--
-- 2) `mcp_oauth_detruire` : détruit AUSSI le secret client et la ligne de
--    `mcp_servers_secrets`, vide `secret_ref`, et remet la connexion en
--    `auth_required` (sauf si elle est déjà `revoked`). Avant, le secret
--    `mcp_oauth_client_secret_<id>` survivait et `secret_ref` pointait vers un
--    secret détruit (« secret introuvable : supprimez-la et recréez-la »).
--
-- 3) `mcp_servers_revoke` : appelle `mcp_oauth_detruire` AVANT de poser
--    `revoked`. Constaté en base réelle : après une révocation complète, le
--    refresh token et le secret client restaient en Vault et le flux en attente
--    survivait (2 secrets, 1 flux). Une révocation doit ne rien laisser.
--
-- Aucune donnée existante n'est modifiée : seules des fonctions sont remplacées.
-- =============================================================================

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
set search_path to 'pg_catalog', 'public', 'vault'
as $$
declare
  v_id uuid;
  v_vault_name text;
  v_a_secret boolean := coalesce(btrim(p_secret), '') <> '';
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
  -- `oauth` : le secret peut venir plus tard, par le flux d'autorisation.
  if p_auth_kind in ('bearer', 'api_key') and not v_a_secret then
    raise exception 'secret_required' using errcode = '22023';
  end if;
  if p_auth_kind = 'none' and v_a_secret then
    raise exception 'secret_not_allowed' using errcode = '22023';
  end if;

  insert into public.mcp_servers (
    user_id, workspace_id, name, url, auth_kind, oauth_client_id, authorization_server, status
  )
  values (
    p_user_id, p_workspace_id, btrim(p_name), p_url, p_auth_kind,
    nullif(btrim(p_oauth_client_id), ''), nullif(btrim(p_authorization_server), ''),
    case when p_auth_kind = 'oauth' and not v_a_secret then 'auth_required' else 'unknown' end
  )
  returning id into v_id;

  if v_a_secret then
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

create or replace function public.mcp_oauth_detruire(p_server uuid)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'vault'
as $$
declare
  v_nom text;
begin
  -- Jeton d'accès, jeton de rafraîchissement, secret client : tout ce qui
  -- permettrait d'agir au nom de l'utilisateur disparaît. L'identifiant client
  -- (public) est conservé : une réautorisation réutilise l'enregistrement.
  foreach v_nom in array array[
    'mcp_server_' || p_server::text,
    'mcp_oauth_refresh_' || p_server::text,
    'mcp_oauth_client_secret_' || p_server::text
  ] loop
    delete from vault.secrets s where s.name = v_nom;
  end loop;

  delete from public.mcp_servers_secrets where server_id = p_server;

  update public.mcp_servers
     set secret_ref = null,
         oauth_expire_le = null,
         oauth_scope = null,
         status = case when status = 'revoked' then 'revoked' else 'auth_required' end,
         last_error = null
   where id = p_server;

  delete from public.mcp_oauth_flows f where f.server_id = p_server;
end;
$$;

create or replace function public.mcp_servers_revoke(p_user_id uuid, p_server_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'vault'
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

  -- OAuth ou non : détruit jeton, refresh, secret client et flux en attente.
  -- Idempotent et sans effet s'il n'y a rien.
  perform public.mcp_oauth_detruire(p_server_id);

  -- Ceinture et bretelles pour les connexions créées AVANT la convention
  -- `mcp_server_<id>` : on suit la référence enregistrée.
  select vault_name into v_vault_name
    from public.mcp_servers_secrets where server_id = p_server_id;
  if v_vault_name is not null then
    select id into v_secret_id from vault.secrets where name = v_vault_name;
    if v_secret_id is not null then
      delete from vault.secrets where id = v_secret_id;
    end if;
    delete from public.mcp_servers_secrets where server_id = p_server_id;
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

revoke all on function public.mcp_servers_create(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.mcp_oauth_detruire(uuid) from public, anon, authenticated;
revoke all on function public.mcp_servers_revoke(uuid, uuid) from public, anon, authenticated;
