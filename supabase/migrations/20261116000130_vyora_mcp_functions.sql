-- VYORA MCP — fonctions serveur (phase 1)
-- Version appliquée en base : 20261116000130 (vyora_mcp_functions)
--
-- Deux familles :
--   A) jetons : hachage, résolution, trace d'usage — réservées à `service_role` ;
--   B) données : lecture (et une écriture préparée) STRICTEMENT filtrées par
--      `p_user_id`, qui provient du jeton résolu, jamais du client MCP.
--
-- Toutes les fonctions figent leur `search_path` et n'accordent `execute` qu'à
-- `service_role` : ni `anon` ni `authenticated` ne peuvent les appeler
-- directement depuis le navigateur.

-- ---------------------------------------------------------------------------
-- A) Jetons
-- ---------------------------------------------------------------------------

-- Empreinte SHA-256 en hexadécimal (pgcrypto est installé dans `extensions`).
create or replace function public.mcp_token_hash(p_secret text)
returns text
language sql
immutable
set search_path = pg_catalog, extensions
as $$
  select encode(digest(p_secret, 'sha256'), 'hex');
$$;

revoke all on function public.mcp_token_hash(text) from public, anon, authenticated;
grant execute on function public.mcp_token_hash(text) to service_role;

-- Résolution d'un jeton porteur.
--
-- Renvoie zéro ligne — et non une erreur distincte — pour un jeton inconnu,
-- révoqué, expiré ou rattaché à une connexion révoquée : l'appelant ne peut pas
-- déduire le motif de rejet. La table renvoyée porte l'identité à utiliser pour
-- toutes les lectures suivantes.
create or replace function public.mcp_resolve_token(p_secret text)
returns table (token_id uuid, user_id uuid, connection_id uuid, scopes text[], token_prefix text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hash text;
begin
  -- Refus des entrées triviales avant tout calcul.
  if p_secret is null or length(p_secret) < 20 then
    return;
  end if;

  v_hash := public.mcp_token_hash(p_secret);

  return query
  select t.id, t.user_id, t.connection_id, t.scopes, t.token_prefix
    from public.mcp_tokens t
   where t.token_sha256 = v_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
     and exists (
       select 1 from public.mcp_connections c
        where c.id = t.connection_id and c.revoked_at is null
     );
end;
$$;

revoke all on function public.mcp_resolve_token(text) from public, anon, authenticated;
grant execute on function public.mcp_resolve_token(text) to service_role;

-- Trace d'usage : horodatage + compteur. Appelée après authentification réussie.
create or replace function public.mcp_touch_token(p_token_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  update public.mcp_tokens
     set last_used_at = now(),
         use_count = use_count + 1
   where id = p_token_id;
$$;

revoke all on function public.mcp_touch_token(uuid) from public, anon, authenticated;
grant execute on function public.mcp_touch_token(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- B) Données — lecture seule, filtrée par propriétaire
-- ---------------------------------------------------------------------------

create or replace function public.mcp_account_info(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, saas_ugc
as $$
declare
  v_result jsonb;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;

  select jsonb_build_object(
    'user_id', p_user_id,
    'member_since', (
      select a.created_at from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id
    ),
    'workspaces', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'workspace_id', m.workspace_id,
                 'role', m.member_role,
                 'since', m.created_at
               ) order by m.created_at
             )
        from saas_ugc.ugc_workspace_members m
       where m.user_id = p_user_id
    ), '[]'::jsonb),
    'credits', null,
    'plan', null
  )
  into v_result;

  return v_result;
end;
$$;

-- Projets vidéo : ceux créés par l'utilisateur OU hébergés dans un espace dont
-- il est membre. Aucune autre ligne n'est atteignable.
create or replace function public.mcp_projects_list(
  p_user_id uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, saas_ugc
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows jsonb;
  v_total bigint;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;

  select count(*)
    into v_total
    from saas_ugc.ugc_video_projects p
   where p.created_by = p_user_id
      or exists (
        select 1 from saas_ugc.ugc_workspace_members m
         where m.workspace_id = p.workspace_id and m.user_id = p_user_id
      );

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.updated_at desc), '[]'::jsonb)
    into v_rows
    from (
      select p.id, p.title, p.status, p.platform, p.language,
             p.aspect_ratio, p.created_at, p.updated_at
        from saas_ugc.ugc_video_projects p
       where p.created_by = p_user_id
          or exists (
            select 1 from saas_ugc.ugc_workspace_members m
             where m.workspace_id = p.workspace_id and m.user_id = p_user_id
          )
       order by p.updated_at desc
       limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_rows);
end;
$$;

create or replace function public.mcp_generations_list(
  p_user_id uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, saas_ugc
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows jsonb;
  v_total bigint;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;

  select count(*) into v_total
    from saas_ugc.ugc_generation_jobs j
   where j.created_by = p_user_id;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select j.id, j.project_id, j.status, j.provider, j.credits_charged,
             j.error_code, j.created_at, j.completed_at
        from saas_ugc.ugc_generation_jobs j
       where j.created_by = p_user_id
       order by j.created_at desc
       limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_rows);
end;
$$;

create or replace function public.mcp_history_list(
  p_user_id uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, saas_ugc
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_rows jsonb;
  v_total bigint;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;

  select count(*) into v_total
    from saas_ugc.ugc_usage_events e
   where e.user_id = p_user_id;

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select e.id, e.event_kind, e.quantity, e.reference_id, e.created_at
        from saas_ugc.ugc_usage_events e
       where e.user_id = p_user_id
       order by e.created_at desc
       limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_rows);
end;
$$;

-- Intégrations : état de connexion seulement.
-- La table réelle est `saas_business.integration_connections` (colonne
-- `connector_key`), et NON `public.integration_connections` : vérifié en base.
-- Ni `credential_ref` ni un quelconque jeton OAuth ne sortent d'ici.
create or replace function public.mcp_integrations_list(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, saas_business
as $$
declare
  v_rows jsonb;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'connector', c.connector_key,
             'status', c.status,
             'connected_at', c.created_at
           ) order by c.connector_key
         ), '[]'::jsonb)
    into v_rows
    from saas_business.integration_connections c
   where c.user_id = p_user_id;

  return jsonb_build_object('items', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- C) Écriture : préparée, non exposée par défaut
-- ---------------------------------------------------------------------------
-- L'Edge Function n'annonce `vyora_project_create` que si le secret
-- `VYORA_MCP_WRITE_ENABLED` vaut exactement `true`. La fonction existe pour que
-- l'activation ne demande aucun changement de schéma.
create or replace function public.mcp_project_create(
  p_user_id uuid,
  p_title text,
  p_platform text default 'TikTok',
  p_language text default 'fr'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, saas_ugc
as $$
declare
  v_workspace uuid;
  v_title text := btrim(coalesce(p_title, ''));
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;
  if v_title = '' or length(v_title) > 200 then
    raise exception 'invalid_title';
  end if;

  -- Espace de travail principal = la plus ancienne adhésion de l'utilisateur.
  -- Aucun workspace_id n'est accepté en paramètre.
  select m.workspace_id
    into v_workspace
    from saas_ugc.ugc_workspace_members m
   where m.user_id = p_user_id
   order by m.created_at
   limit 1;

  if v_workspace is null then
    raise exception 'no_workspace';
  end if;

  insert into saas_ugc.ugc_video_projects (workspace_id, created_by, title, platform, language, status)
  values (
    v_workspace,
    p_user_id,
    v_title,
    coalesce(nullif(btrim(p_platform), ''), 'TikTok'),
    coalesce(nullif(btrim(p_language), ''), 'fr'),
    'draft'
  )
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'title', v_title, 'status', 'draft');
end;
$$;

-- ---------------------------------------------------------------------------
-- D) Journal d'activité
-- ---------------------------------------------------------------------------
-- Best-effort : une défaillance de journalisation ne doit jamais faire échouer
-- un appel réussi. Aucun contenu métier n'est stocké, seulement la méthode,
-- l'outil, le verdict et des mesures.
create or replace function public.mcp_log_activity(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id bigint;
begin
  insert into public.mcp_activity_log (
    user_id, token_id, connection_id, token_prefix,
    method, tool_name, outcome, error_code, duration_ms, result_size
  )
  values (
    nullif(p_payload->>'user_id', '')::uuid,
    nullif(p_payload->>'token_id', '')::uuid,
    nullif(p_payload->>'connection_id', '')::uuid,
    nullif(p_payload->>'token_prefix', ''),
    coalesce(nullif(p_payload->>'method', ''), 'unknown'),
    nullif(p_payload->>'tool_name', ''),
    coalesce(nullif(p_payload->>'outcome', ''), 'error'),
    nullif(p_payload->>'error_code', ''),
    nullif(p_payload->>'duration_ms', '')::integer,
    nullif(p_payload->>'result_size', '')::integer
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- E) Privilèges : `service_role` uniquement
-- ---------------------------------------------------------------------------
revoke all on function public.mcp_account_info(uuid) from public, anon, authenticated;
grant execute on function public.mcp_account_info(uuid) to service_role;

revoke all on function public.mcp_projects_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_projects_list(uuid, integer, integer) to service_role;

revoke all on function public.mcp_generations_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_generations_list(uuid, integer, integer) to service_role;

revoke all on function public.mcp_history_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_history_list(uuid, integer, integer) to service_role;

revoke all on function public.mcp_integrations_list(uuid) from public, anon, authenticated;
grant execute on function public.mcp_integrations_list(uuid) to service_role;

revoke all on function public.mcp_project_create(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mcp_project_create(uuid, text, text, text) to service_role;

revoke all on function public.mcp_log_activity(jsonb) from public, anon, authenticated;
grant execute on function public.mcp_log_activity(jsonb) to service_role;
