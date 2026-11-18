-- VYORA — socle OAuth 2.1 du serveur MCP (RFC 9728 / RFC 8414 / RFC 7591 / RFC 8707).
--
-- ## Ce que cette migration ajoute, et ce qu'elle ne touche pas
--
-- Elle ajoute le socle OAuth **à côté** des jetons opaques existants. Aucune
-- colonne de `mcp_tokens`, aucun jeton en service n'est modifié : la migration
-- est strictement additive, donc réversible par simple suppression des objets
-- créés ici.
--
-- ## Pourquoi l'AS vit dans la même fonction Edge
--
-- Le serveur MCP est déjà une fonction Edge sans état. Y loger aussi le
-- serveur d'autorisation évite un second service à sécuriser, à déployer et à
-- faire évoluer. Les deux rôles restent néanmoins séparés par le code : les
-- routes `/oauth/*` ne touchent jamais aux outils, et `/mcp` ne touche jamais
-- aux codes d'autorisation.
--
-- ## Ce qui n'est jamais stocké en clair
--
--   - le secret d'un client : seule son empreinte SHA-256 est enregistrée ;
--   - le code d'autorisation : seule son empreinte SHA-256 est enregistrée ;
--   - le `code_verifier` PKCE : seule son empreinte est enregistrée ;
--   - le jeton d'accès et le jeton de rafraîchissement : **ce sont les mêmes
--     jetons opaques que la v5** (`vyora_mcp_…`), donc une empreinte seule, et
--     ils restent révocables depuis l'écran existant.

/* -------------------------------------------------------------------------- */
/* 1. Clients OAuth enregistrés dynamiquement (RFC 7591)                       */
/* -------------------------------------------------------------------------- */

create table if not exists public.mcp_oauth_clients (
  id uuid primary key default gen_random_uuid(),
  -- Identifiant public du client, présenté au endpoint /oauth/authorize.
  client_id text not null unique,
  client_name text not null,
  -- Un client public (application de bureau, CLI) n'a pas de secret : PKCE seul.
  is_public boolean not null default true,
  -- Empreinte du secret pour un client confidentiel ; NULL pour un client public.
  client_secret_sha256 text,
  redirect_uris text[] not null default '{}',
  grant_types text[] not null default array['authorization_code', 'refresh_token'],
  response_types text[] not null default array['code'],
  token_endpoint_auth_method text not null default 'none',
  -- Portées que ce client est autorisé à demander. Fermé par défaut.
  allowed_scopes text[] not null default array['read'],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint mcp_oauth_clients_redirect_check check (cardinality(redirect_uris) between 1 and 10),
  constraint mcp_oauth_clients_scope_check check (allowed_scopes <@ array['read', 'write']::text[]),
  constraint mcp_oauth_clients_secret_check check (
    (is_public and client_secret_sha256 is null and token_endpoint_auth_method = 'none')
    or (not is_public and length(client_secret_sha256) = 64)
  )
);

comment on table public.mcp_oauth_clients is
  'Clients OAuth enregistrés dynamiquement par des clients MCP (RFC 7591). Le secret n''est stocké qu''en SHA-256.';

/* -------------------------------------------------------------------------- */
/* 2. Codes d'autorisation (durée de vie courte, usage unique)                 */
/* -------------------------------------------------------------------------- */

create table if not exists public.mcp_oauth_codes (
  id uuid primary key default gen_random_uuid(),
  code_sha256 text not null unique,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  redirect_uri text not null,
  scopes text[] not null,
  -- Empreinte du code_verifier PKCE : le vérificateur lui-même n'est jamais stocké.
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  -- RFC 8707 : ressource destinée à ce jeton. Doit correspondre au serveur MCP.
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  -- Renseigné à l'échange : un code ne peut servir qu'une fois.
  used_at timestamptz,
  constraint mcp_oauth_codes_challenge_check check (code_challenge_method = 'S256' and length(code_challenge) between 43 and 128),
  constraint mcp_oauth_codes_scopes_check check (scopes <@ array['read', 'write']::text[])
);

comment on table public.mcp_oauth_codes is
  'Codes d''autorisation OAuth (usage unique, 10 minutes, PKCE S256 obligatoire).';

/* -------------------------------------------------------------------------- */
/* 3. Jetons de rafraîchissement                                               */
/* -------------------------------------------------------------------------- */

create table if not exists public.mcp_oauth_refresh (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.mcp_tokens(id) on delete cascade,
  -- Empreinte du refresh token : la valeur en clair n'existe que dans la réponse HTTP.
  refresh_sha256 text not null unique,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scopes text[] not null,
  resource text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  used_at timestamptz,
  revoked_at timestamptz
);

comment on table public.mcp_oauth_refresh is
  'Jetons de rafraîchissement OAuth : rotation à chaque usage, empreinte SHA-256 seule.';

/* -------------------------------------------------------------------------- */
/* 4. Index                                                                     */
/* -------------------------------------------------------------------------- */

create index if not exists mcp_oauth_codes_expiry_idx on public.mcp_oauth_codes (expires_at);
create index if not exists mcp_oauth_codes_user_idx on public.mcp_oauth_codes (user_id, created_at desc);
create index if not exists mcp_oauth_refresh_token_idx on public.mcp_oauth_refresh (token_id);
create index if not exists mcp_oauth_refresh_user_idx on public.mcp_oauth_refresh (user_id, created_at desc);

/* -------------------------------------------------------------------------- */
/* 5. RLS : lecture du propriétaire uniquement, écriture réservée au serveur   */
/* -------------------------------------------------------------------------- */

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;
alter table public.mcp_oauth_refresh enable row level security;

/*
 * Aucune politique d'écriture : les trois tables ne sont alimentées que par les
 * fonctions SECURITY DEFINER ci-dessous, appelées en service_role depuis la
 * fonction Edge. Un utilisateur ne peut donc ni créer un client, ni fabriquer
 * un code, ni s'attribuer un rafraîchissement.
 */
revoke insert, update, delete on public.mcp_oauth_clients from anon, authenticated;
revoke insert, update, delete on public.mcp_oauth_codes from anon, authenticated;
revoke insert, update, delete on public.mcp_oauth_refresh from anon, authenticated;

drop policy if exists mcp_oauth_codes_owner on public.mcp_oauth_codes;
create policy mcp_oauth_codes_owner on public.mcp_oauth_codes
  for select to authenticated using (user_id = auth.uid());

drop policy if exists mcp_oauth_refresh_owner on public.mcp_oauth_refresh;
create policy mcp_oauth_refresh_owner on public.mcp_oauth_refresh
  for select to authenticated using (user_id = auth.uid());

/* -------------------------------------------------------------------------- */
/* 6. Nettoyage des éléments périmés                                           */
/* -------------------------------------------------------------------------- */

/*
 * Purge des codes expirés et des rafraîchissements morts. Appelée par la
 * fonction Edge au début d'un flux d'autorisation : pas de tâche planifiée à
 * installer, et un volume qui reste borné même sans trafic de maintenance.
 */
create or replace function public.mcp_oauth_purge()
returns integer
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare v_total integer := 0; v_n integer := 0;
begin
  delete from public.mcp_oauth_codes where expires_at < now() - interval '1 day';
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  delete from public.mcp_oauth_refresh
   where expires_at < now() - interval '1 day'
      or revoked_at < now() - interval '1 day';
  get diagnostics v_n = row_count; v_total := v_total + v_n;

  return v_total;
end;
$function$;

revoke all on function public.mcp_oauth_purge() from public, anon, authenticated;
grant execute on function public.mcp_oauth_purge() to service_role;

/* -------------------------------------------------------------------------- */
/* 7. Enregistrement d'un client (RFC 7591)                                    */
/* -------------------------------------------------------------------------- */

/*
 * Enregistre un client et renvoie son identifiant public — et son secret, UNE
 * SEULE FOIS, uniquement s'il s'agit d'un client confidentiel.
 *
 * Les redirect_uris sont validées ici en plus du code Edge : une redirection
 * `javascript:` ou un fragment transformerait le endpoint d'autorisation en
 * vecteur d'injection. Une garde qu'on peut oublier d'appeler n'est pas une
 * garde, donc elle est aussi en base.
 */
create or replace function public.mcp_oauth_register_client(
  p_client_name text,
  p_redirect_uris text[],
  p_is_public boolean default true,
  p_allowed_scopes text[] default array['read']
)
returns jsonb
language plpgsql
security definer
set search_path = 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_id text;
  v_secret text;
  v_uri text;
  v_scopes text[] := coalesce(p_allowed_scopes, array['read']::text[]);
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) = 0 then
    raise exception 'redirect_uri_required' using errcode = '22023';
  end if;
  if cardinality(p_redirect_uris) > 10 then
    raise exception 'too_many_redirect_uris' using errcode = '22023';
  end if;
  foreach v_uri in array p_redirect_uris loop
    -- HTTPS obligatoire, sauf pour un client de bureau qui revient sur la
    -- boucle locale (RFC 8252) : c'est le seul cas en clair toléré.
    if v_uri !~ '^https://[^[:space:]]+$'
       and v_uri !~ '^http://(127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
      raise exception 'invalid_redirect_uri' using errcode = '22023';
    end if;
    if position('#' in v_uri) > 0 then
      raise exception 'invalid_redirect_uri' using errcode = '22023';
    end if;
  end loop;
  if cardinality(v_scopes) = 0 or not (v_scopes <@ array['read', 'write']::text[]) then
    raise exception 'invalid_scopes' using errcode = '22023';
  end if;

  v_id := 'vyora_client_' || translate(rtrim(encode(gen_random_bytes(18), 'base64'), '='), '+/', '-_');

  if coalesce(p_is_public, true) then
    insert into public.mcp_oauth_clients (client_id, client_name, is_public, allowed_scopes, redirect_uris)
    values (v_id, coalesce(nullif(btrim(p_client_name), ''), 'Client MCP'), true, v_scopes, p_redirect_uris);
  else
    v_secret := translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    insert into public.mcp_oauth_clients (
      client_id, client_name, is_public, client_secret_sha256, allowed_scopes, redirect_uris, token_endpoint_auth_method
    ) values (
      v_id, coalesce(nullif(btrim(p_client_name), ''), 'Client MCP'), false,
      public.mcp_token_hash(v_secret), v_scopes, p_redirect_uris, 'client_secret_post'
    );
  end if;

  return jsonb_build_object(
    'client_id', v_id,
    'client_secret', v_secret,
    'client_id_issued_at', extract(epoch from now())::bigint,
    'client_name', coalesce(nullif(btrim(p_client_name), ''), 'Client MCP'),
    'redirect_uris', p_redirect_uris,
    'grant_types', array['authorization_code', 'refresh_token'],
    'response_types', array['code'],
    'token_endpoint_auth_method', case when coalesce(p_is_public, true) then 'none' else 'client_secret_post' end,
    'scope', array_to_string(v_scopes, ' ')
  );
end;
$function$;

revoke all on function public.mcp_oauth_register_client(text, text[], boolean, text[]) from public, anon, authenticated;
grant execute on function public.mcp_oauth_register_client(text, text[], boolean, text[]) to service_role;

/* -------------------------------------------------------------------------- */
/* 8. Lecture d'un client par son identifiant public                           */
/* -------------------------------------------------------------------------- */

create or replace function public.mcp_oauth_client_get(p_client_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare v_client public.mcp_oauth_clients%rowtype;
begin
  select * into v_client from public.mcp_oauth_clients
   where client_id = p_client_id and revoked_at is null;
  if not found then return null; end if;
  return jsonb_build_object(
    'client_id', v_client.client_id,
    'client_name', v_client.client_name,
    'is_public', v_client.is_public,
    'client_secret_sha256', v_client.client_secret_sha256,
    'redirect_uris', v_client.redirect_uris,
    'allowed_scopes', v_client.allowed_scopes,
    'token_endpoint_auth_method', v_client.token_endpoint_auth_method
  );
end;
$function$;

revoke all on function public.mcp_oauth_client_get(text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_client_get(text) to service_role;

/* -------------------------------------------------------------------------- */
/* 9. Émission d'un code d'autorisation                                        */
/* -------------------------------------------------------------------------- */

/*
 * Le code en clair est renvoyé à l'appelant, qui le place dans la redirection.
 * Seule son empreinte reste en base : une fuite de la table ne permet pas de
 * rejouer un code.
 */
create or replace function public.mcp_oauth_code_create(
  p_client_id text,
  p_user_id uuid,
  p_redirect_uri text,
  p_scopes text[],
  p_code_challenge text,
  p_resource text
)
returns text
language plpgsql
security definer
set search_path = 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_client public.mcp_oauth_clients%rowtype;
  v_code text;
  v_scopes text[] := coalesce(p_scopes, array['read']::text[]);
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;

  select * into v_client from public.mcp_oauth_clients
   where client_id = p_client_id and revoked_at is null;
  if not found then raise exception 'unknown_client' using errcode = '22023'; end if;

  -- La redirection doit être EXACTEMENT l'une de celles enregistrées : accepter
  -- un préfixe permettrait d'exfiltrer un code vers un domaine voisin.
  if not (p_redirect_uri = any (v_client.redirect_uris)) then
    raise exception 'redirect_uri_mismatch' using errcode = '22023';
  end if;

  -- Un client ne peut pas obtenir plus que ce qu'il a été enregistré pour.
  if cardinality(v_scopes) = 0 or not (v_scopes <@ v_client.allowed_scopes) then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  perform public.mcp_oauth_purge();

  v_code := translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');

  insert into public.mcp_oauth_codes (
    code_sha256, client_id, user_id, redirect_uri, scopes, code_challenge, resource
  ) values (
    public.mcp_token_hash(v_code), p_client_id, p_user_id, p_redirect_uri, v_scopes, p_code_challenge,
    coalesce(nullif(p_resource, ''), '')
  );

  return v_code;
end;
$function$;

revoke all on function public.mcp_oauth_code_create(text, uuid, text, text[], text, text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_code_create(text, uuid, text, text[], text, text) to service_role;

/* -------------------------------------------------------------------------- */
/* 10. Consommation d'un code : usage unique, vérifié par empreinte            */
/* -------------------------------------------------------------------------- */

/*
 * Renvoie la ligne si et seulement si le code existe, n'a jamais servi, n'est
 * pas expiré, et concerne bien la ressource demandée. `used_at` est posé dans
 * la même instruction : deux échanges concurrents ne peuvent pas réussir, la
 * seconde mise à jour ne trouvant plus la ligne (`and used_at is null`).
 */
create or replace function public.mcp_oauth_code_consume(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare v_code public.mcp_oauth_codes%rowtype;
begin
  if p_code is null or length(p_code) < 20 then return null; end if;

  update public.mcp_oauth_codes c
     set used_at = now()
   where c.code_sha256 = public.mcp_token_hash(p_code)
     and c.used_at is null
     and c.expires_at > now()
  returning * into v_code;

  if not found then return null; end if;

  return jsonb_build_object(
    'client_id', v_code.client_id,
    'user_id', v_code.user_id,
    'redirect_uri', v_code.redirect_uri,
    'scopes', v_code.scopes,
    'code_challenge', v_code.code_challenge,
    'resource', v_code.resource
  );
end;
$function$;

revoke all on function public.mcp_oauth_code_consume(text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_code_consume(text) to service_role;

/* -------------------------------------------------------------------------- */
/* 11. Émission du jeton d'accès + rafraîchissement                            */
/* -------------------------------------------------------------------------- */

/*
 * Le jeton d'accès réutilise `mcp_tokens` : il apparaît donc dans l'écran
 * « MCP et connexions IA », se révoque avec le même bouton, et bénéficie des
 * mêmes contrôles (empreinte, expiration, connexion révoquée). C'est
 * exactement ce que demande la consigne « conserver les jetons opaques tant
 * que la migration OAuth n'est pas validée ».
 */
create or replace function public.mcp_oauth_issue_tokens(
  p_client_id text,
  p_user_id uuid,
  p_scopes text[],
  p_resource text,
  p_label text default 'Client OAuth'
)
returns jsonb
language plpgsql
security definer
set search_path = 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_client public.mcp_oauth_clients%rowtype;
  v_connection uuid;
  v_token uuid;
  v_access text;
  v_refresh text;
  v_prefix text;
  v_kind text := 'generic';
  v_scopes text[] := coalesce(p_scopes, array['read']::text[]);
begin
  if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;

  select * into v_client from public.mcp_oauth_clients
   where client_id = p_client_id and revoked_at is null;
  if not found then raise exception 'unknown_client' using errcode = '22023'; end if;
  if cardinality(v_scopes) = 0 or not (v_scopes <@ v_client.allowed_scopes) then
    raise exception 'invalid_scope' using errcode = '22023';
  end if;

  v_access := 'vyora_mcp_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_prefix := left(v_access, 18);

  insert into public.mcp_connections (user_id, client_name, client_kind)
  values (p_user_id, left(v_client.client_name, 120), v_kind)
  returning id into v_connection;

  insert into public.mcp_tokens (user_id, connection_id, label, token_prefix, token_sha256, scopes, expires_at)
  values (
    p_user_id, v_connection,
    left(coalesce(nullif(btrim(p_label), ''), v_client.client_name), 120),
    v_prefix, public.mcp_token_hash(v_access), v_scopes,
    now() + interval '1 hour'
  )
  returning id into v_token;

  v_refresh := 'vyora_rt_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');

  insert into public.mcp_oauth_refresh (token_id, refresh_sha256, client_id, user_id, scopes, resource)
  values (v_token, public.mcp_token_hash(v_refresh), p_client_id, p_user_id, v_scopes, coalesce(nullif(p_resource, ''), ''));

  update public.mcp_oauth_clients set last_used_at = now() where client_id = p_client_id;

  return jsonb_build_object(
    'access_token', v_access,
    'token_type', 'Bearer',
    'expires_in', 3600,
    'scope', array_to_string(v_scopes, ' '),
    'refresh_token', v_refresh,
    'token_id', v_token,
    'connection_id', v_connection
  );
end;
$function$;

revoke all on function public.mcp_oauth_issue_tokens(text, uuid, text[], text, text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_issue_tokens(text, uuid, text[], text, text) to service_role;

/* -------------------------------------------------------------------------- */
/* 12. Rafraîchissement : rotation systématique                                */
/* -------------------------------------------------------------------------- */

/*
 * Le jeton de rafraîchissement présenté est consommé (`used_at`) avant d'en
 * émettre un nouveau. Un rejeu du même rafraîchissement échoue donc au lieu de
 * prolonger silencieusement une session volée.
 */
create or replace function public.mcp_oauth_refresh_rotate(p_refresh text)
returns jsonb
language plpgsql
security definer
set search_path = 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_row public.mcp_oauth_refresh%rowtype;
  v_access text;
  v_refresh text;
  v_prefix text;
begin
  if p_refresh is null or length(p_refresh) < 20 then return null; end if;

  update public.mcp_oauth_refresh r
     set used_at = now()
   where r.refresh_sha256 = public.mcp_token_hash(p_refresh)
     and r.used_at is null
     and r.revoked_at is null
     and r.expires_at > now()
  returning * into v_row;

  if not found then return null; end if;

  -- Le jeton d'accès associé doit encore être valide côté jeton (non révoqué) :
  -- révoquer depuis l'écran doit tuer le rafraîchissement aussi.
  if not exists (
    select 1 from public.mcp_tokens t
     where t.id = v_row.token_id and t.revoked_at is null
  ) then
    update public.mcp_oauth_refresh set revoked_at = now() where id = v_row.id;
    return null;
  end if;

  v_access := 'vyora_mcp_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');
  v_prefix := left(v_access, 18);

  -- Le nouveau jeton d'accès remplace le précédent : l'ancien est révoqué pour
  -- qu'une copie interceptée ne reste pas utilisable une heure de plus.
  update public.mcp_tokens t
     set revoked_at = now()
   where t.id = v_row.token_id and t.revoked_at is null;

  insert into public.mcp_tokens (user_id, connection_id, label, token_prefix, token_sha256, scopes, expires_at)
  select t.user_id, t.connection_id, t.label, v_prefix, public.mcp_token_hash(v_access), v_row.scopes, now() + interval '1 hour'
    from public.mcp_tokens t where t.id = v_row.token_id
  returning id into v_row.token_id;

  v_refresh := 'vyora_rt_' || translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_');

  insert into public.mcp_oauth_refresh (token_id, refresh_sha256, client_id, user_id, scopes, resource)
  values (v_row.token_id, public.mcp_token_hash(v_refresh), v_row.client_id, v_row.user_id, v_row.scopes, v_row.resource);

  return jsonb_build_object(
    'access_token', v_access,
    'token_type', 'Bearer',
    'expires_in', 3600,
    'scope', array_to_string(v_row.scopes, ' '),
    'refresh_token', v_refresh,
    'token_id', v_row.token_id
  );
end;
$function$;

revoke all on function public.mcp_oauth_refresh_rotate(text) from public, anon, authenticated;
grant execute on function public.mcp_oauth_refresh_rotate(text) to service_role;

/* -------------------------------------------------------------------------- */
/* 13. Métadonnées de ressource (RFC 9728)                                     */
/* -------------------------------------------------------------------------- */

/*
 * Ce que le document doit contenir : la ressource elle-même, la ou les
 * autorités d'autorisation, et les portées supportées. Aucune donnée
 * utilisateur ici — le document est public par conception.
 */
create or replace function public.mcp_oauth_resource_metadata(p_resource text, p_issuer text)
returns jsonb
language sql
immutable
as $function$
  select jsonb_build_object(
    'resource', p_resource,
    'authorization_servers', jsonb_build_array(p_issuer),
    'scopes_supported', jsonb_build_array('read', 'write'),
    'bearer_methods_supported', jsonb_build_array('header'),
    'resource_documentation', p_resource
  );
$function$;

grant execute on function public.mcp_oauth_resource_metadata(text, text) to service_role;

/* -------------------------------------------------------------------------- */
/* 14. Inventaire des connexions OAuth pour l'écran                            */
/* -------------------------------------------------------------------------- */

/*
 * L'écran existant liste déjà les jetons. Cette vue y ajoute le client OAuth
 * d'origine et la présence d'un rafraîchissement, pour que l'utilisateur voie
 * « ce jeton vient de Claude, il se renouvelle tout seul ».
 */
create or replace function public.mcp_oauth_list_connections()
returns jsonb
language plpgsql
stable
security definer
set search_path = 'pg_catalog', 'public'
as $function$
declare v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'client_id', c.client_id,
      'client_name', c.client_name,
      'is_public', c.is_public,
      'last_used_at', c.last_used_at,
      'tokens', coalesce((
        select jsonb_agg(jsonb_build_object(
          'token_id', t.id,
          'label', t.label,
          'scopes', t.scopes,
          'created_at', t.created_at,
          'expires_at', t.expires_at,
          'revoked_at', t.revoked_at,
          'has_refresh', exists(
            select 1 from public.mcp_oauth_refresh r
             where r.token_id = t.id and r.revoked_at is null and r.used_at is null
          )
        ) order by t.created_at desc)
        from public.mcp_tokens t
        join public.mcp_oauth_refresh r2 on r2.token_id = t.id
        where t.user_id = v_user and r2.client_id = c.client_id
      ), '[]'::jsonb)
    ) order by c.last_used_at desc nulls last)
    from public.mcp_oauth_clients c
    where exists (
      select 1 from public.mcp_oauth_refresh r
       where r.client_id = c.client_id and r.user_id = v_user
    )
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.mcp_oauth_list_connections() from public, anon;
grant execute on function public.mcp_oauth_list_connections() to authenticated;
