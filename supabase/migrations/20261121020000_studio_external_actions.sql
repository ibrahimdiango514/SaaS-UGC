-- Incrément 18 — Architecture d'action EXTERNE (publication sociale)
--
-- Les 10 outils `*-publish` / `youtube-*` de MuAPI ne sont pas des générateurs :
-- leur entrée désigne un COMPTE connecté (`options_source: social_accounts`) et
-- leur sortie est un identifiant de publication (`publish_id`, `media_id`).
-- Les traiter comme des générations produirait un « résultat » sans contenu et
-- masquerait une action réelle sur un compte tiers.
--
-- Ce fichier installe donc un pipeline séparé :
--   1. une DEMANDE (aucune exécution, aucun crédit, aucun appel fournisseur) ;
--   2. une CONFIRMATION explicite, propriétaire, non expirée, avec note ;
--   3. un AUDIT append-only de chaque transition ;
--   4. une ANNULATION avant exécution.
--
-- Aucune fonction n'appelle le fournisseur et aucune ne déplace de crédit.
-- L'exécution reste impossible : elle exige un compte lié, une autorisation
-- d'administration et un test fournisseur réel, qui n'existent pas ici.
--
-- Aucune table existante n'est modifiée.

begin;

-- 1. Détection bornée par les DÉCLARATIONS de la fiche ------------------------
create or replace function ugc_private.studio_is_external_action(p_input jsonb, p_output jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((
    select true
      from jsonb_each(coalesce(p_input->'schemas'->'input_data'->'properties', '{}'::jsonb)) e
     where e.value->>'options_source' = 'social_accounts'
     limit 1), false)
  or coalesce((p_output->'schemas'->'properties'->'output'->'properties' ? 'publish_id'), false)
  or coalesce((p_output->'schemas'->'properties'->'output'->'properties' ? 'media_id'), false)
  or coalesce((p_output->'schemas'->'properties' ? 'publish_id'), false);
$$;
revoke all on function ugc_private.studio_is_external_action(jsonb,jsonb) from public, anon, authenticated;

-- 2. Tables -------------------------------------------------------------------
create table if not exists saas_ugc.studio_external_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  workspace_id uuid not null,
  model_id uuid not null references saas_ugc.studio_ai_models(id) on delete restrict,
  provider_model_id text not null,
  platform text not null check (platform ~ '^[a-z_]{1,40}$'),
  action_kind text not null check (action_kind in ('publish','update','thumbnail')),
  params jsonb not null,
  params_hash text not null,
  permission_scopes text[] not null,
  status text not null default 'requested'
    check (status in ('requested','confirmed','cancelled','expired')),
  confirmation_text text not null,
  confirmed_at timestamptz,
  confirmed_by uuid,
  confirmed_note text,
  cancelled_at timestamptz,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Une même demande (mêmes paramètres) ne peut pas être empilée deux fois tant
-- qu'elle est encore ouverte : c'est la protection anti-double soumission.
create unique index if not exists studio_external_actions_open_request
  on saas_ugc.studio_external_actions(user_id, model_id, params_hash)
  where status in ('requested','confirmed');
create index if not exists studio_external_actions_user_created
  on saas_ugc.studio_external_actions(user_id, created_at desc);

create table if not exists saas_ugc.studio_external_action_events (
  id bigserial primary key,
  action_id uuid not null references saas_ugc.studio_external_actions(id) on delete restrict,
  user_id uuid not null,
  kind text not null check (kind in ('requested','confirmed','cancelled','expired','refused')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists studio_external_action_events_action
  on saas_ugc.studio_external_action_events(action_id, created_at);

alter table saas_ugc.studio_external_actions enable row level security;
alter table saas_ugc.studio_external_action_events enable row level security;
revoke all on saas_ugc.studio_external_actions from public, anon, authenticated;
revoke all on saas_ugc.studio_external_action_events from public, anon, authenticated;
grant select on saas_ugc.studio_external_actions to authenticated;
grant select on saas_ugc.studio_external_action_events to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'saas_ugc' and tablename = 'studio_external_actions'
                 and policyname = 'studio_external_actions_own_read') then
    create policy studio_external_actions_own_read on saas_ugc.studio_external_actions
      for select to authenticated using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'saas_ugc' and tablename = 'studio_external_action_events'
                 and policyname = 'studio_external_action_events_own_read') then
    create policy studio_external_action_events_own_read on saas_ugc.studio_external_action_events
      for select to authenticated using (user_id = (select auth.uid()));
  end if;
end $$;

-- 3. Demande ------------------------------------------------------------------
create or replace function public.studio_external_action_request(p_model_id uuid, p_params jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  m saas_ugc.studio_ai_models%rowtype;
  props jsonb;
  platform text;
  kind text;
  scopes text[];
  confirmation text;
  v_hash text;
  action saas_ugc.studio_external_actions%rowtype;
  ctx jsonb;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object' or octet_length(p_params::text) > 131072 then
    raise exception 'invalid_params';
  end if;
  select * into m from saas_ugc.studio_ai_models where id = p_model_id and provider_key = 'muapi';
  if not found then raise exception 'unknown_model'; end if;
  if m.public_catalog_present is not true or m.provider_enabled is not true then raise exception 'model_unavailable'; end if;
  if not ugc_private.studio_is_external_action(m.input_schema, m.output_schema) then
    raise exception 'not_an_external_action';
  end if;
  props := coalesce(m.input_schema->'schemas'->'input_data'->'properties', '{}'::jsonb);
  -- Seuls des champs DÉCLARÉS sont acceptés ; aucun identifiant libre.
  if exists (select 1 from jsonb_object_keys(p_params) k where not (props ? k)) then
    raise exception 'invalid_params';
  end if;
  if exists (select 1 from jsonb_array_elements_text(coalesce(m.input_schema->'schemas'->'input_data'->'required','[]'::jsonb)) r
              where not (p_params ? r)) then
    raise exception 'parameter_required';
  end if;
  select e.value->>'options_platform' into platform
    from jsonb_each(props) e
   where e.value->>'options_source' = 'social_accounts'
     and e.value->>'options_platform' in ('facebook','instagram','linkedin','pinterest','threads','tiktok','x','youtube')
   limit 1;
  platform := coalesce(platform, 'unknown');
  kind := case
    when props ? 'thumbnail_url' or props ? 'thumbnail' then 'thumbnail'
    when props ? 'video_id' and not exists (select 1 from jsonb_each(props) e where e.value ? 'field') then 'update'
    else 'publish' end;
  scopes := array['social.' || platform || '.account'] ||
    case kind when 'publish' then array['social.' || platform || '.publish']
              when 'update' then array['social.' || platform || '.update']
              else array['social.' || platform || '.thumbnail'] end;
  confirmation := 'Confirmez la publication sur le compte ' || platform
    || ' (« ' || m.provider_model_id || ' »). Aucune action ne sera exécutée par VYORA dans cet environnement.';
  v_hash := md5(jsonb_build_array(p_model_id, p_params, platform, kind)::text);
  ctx := public.studio_runtime_access();

  insert into saas_ugc.studio_external_actions(
    user_id, workspace_id, model_id, provider_model_id, platform, action_kind,
    params, params_hash, permission_scopes, confirmation_text)
  values (uid, (ctx->>'workspace_id')::uuid, m.id, m.provider_model_id, platform, kind,
    p_params, v_hash, scopes, confirmation)
  on conflict (user_id, model_id, params_hash) where status in ('requested','confirmed') do nothing
  returning * into action;
  if action.id is null then
    select * into action from saas_ugc.studio_external_actions
     where user_id = uid and model_id = m.id and params_hash = v_hash and status in ('requested','confirmed');
    return jsonb_build_object('action_id', action.id, 'status', action.status, 'created', false,
      'platform', action.platform, 'kind', action.action_kind, 'permissions', action.permission_scopes,
      'confirmation', action.confirmation_text, 'expires_at', action.expires_at, 'execution', 'unavailable');
  end if;
  insert into saas_ugc.studio_external_action_events(action_id, user_id, kind, detail)
  values (action.id, uid, 'requested', jsonb_build_object('platform', platform, 'kind', kind, 'scopes', scopes));
  return jsonb_build_object('action_id', action.id, 'status', action.status, 'created', true,
    'platform', action.platform, 'kind', action.action_kind, 'permissions', action.permission_scopes,
    'confirmation', action.confirmation_text, 'expires_at', action.expires_at, 'execution', 'unavailable');
end $$;
revoke all on function public.studio_external_action_request(uuid,jsonb) from public, anon;
grant execute on function public.studio_external_action_request(uuid,jsonb) to authenticated, service_role;

-- 4. Confirmation explicite ---------------------------------------------------
create or replace function public.studio_external_action_confirm(p_action_id uuid, p_confirm boolean default false, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); action saas_ugc.studio_external_actions%rowtype;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_confirm is not true then raise exception 'confirmation_required'; end if;
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'approval_note_required'; end if;
  select * into action from saas_ugc.studio_external_actions
   where id = p_action_id and user_id = uid for update;
  if not found then raise exception 'action_not_found'; end if;
  if action.status = 'cancelled' then raise exception 'action_cancelled'; end if;
  if action.status = 'confirmed' then
    return jsonb_build_object('action_id', action.id, 'status', 'confirmed', 'execution', 'unavailable',
      'remaining', jsonb_build_array('PROVIDER_ACCOUNT_LINK_MISSING','EXECUTION_DISABLED','REAL_TEST_PENDING'));
  end if;
  if action.expires_at <= now() then
    update saas_ugc.studio_external_actions set status = 'expired', updated_at = now() where id = action.id;
    insert into saas_ugc.studio_external_action_events(action_id, user_id, kind) values (action.id, uid, 'expired');
    raise exception 'action_expired';
  end if;
  update saas_ugc.studio_external_actions
     set status = 'confirmed', confirmed_at = now(), confirmed_by = uid, confirmed_note = btrim(p_note), updated_at = now()
   where id = action.id;
  insert into saas_ugc.studio_external_action_events(action_id, user_id, kind, detail)
  values (action.id, uid, 'confirmed', jsonb_build_object('note', btrim(p_note)));
  -- Aucune exécution : le compte lié, l'autorisation d'administration et le
  -- test fournisseur réel manquent. La confirmation est un CONSENTEMENT, pas
  -- un déclenchement.
  return jsonb_build_object('action_id', action.id, 'status', 'confirmed', 'execution', 'unavailable',
    'remaining', jsonb_build_array('PROVIDER_ACCOUNT_LINK_MISSING','EXECUTION_DISABLED','REAL_TEST_PENDING'));
end $$;
revoke all on function public.studio_external_action_confirm(uuid,boolean,text) from public, anon;
grant execute on function public.studio_external_action_confirm(uuid,boolean,text) to authenticated, service_role;

-- 5. Annulation ---------------------------------------------------------------
create or replace function public.studio_external_action_cancel(p_action_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); action saas_ugc.studio_external_actions%rowtype;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  select * into action from saas_ugc.studio_external_actions where id = p_action_id and user_id = uid for update;
  if not found then raise exception 'action_not_found'; end if;
  if action.status in ('cancelled','expired') then
    return jsonb_build_object('action_id', action.id, 'status', action.status);
  end if;
  update saas_ugc.studio_external_actions set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = action.id;
  insert into saas_ugc.studio_external_action_events(action_id, user_id, kind) values (action.id, uid, 'cancelled');
  return jsonb_build_object('action_id', action.id, 'status', 'cancelled');
end $$;
revoke all on function public.studio_external_action_cancel(uuid) from public, anon;
grant execute on function public.studio_external_action_cancel(uuid) to authenticated, service_role;

-- 6. Lecture ------------------------------------------------------------------
create or replace function public.studio_external_action_list(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'action_id', a.id, 'provider_model_id', a.provider_model_id, 'platform', a.platform,
      'kind', a.action_kind, 'status', case when a.status = 'requested' and a.expires_at <= now() then 'expired' else a.status end,
      'permissions', a.permission_scopes, 'confirmation', a.confirmation_text,
      'expires_at', a.expires_at, 'created_at', a.created_at,
      'execution', 'unavailable') order by a.created_at desc)
      from (select * from saas_ugc.studio_external_actions where user_id = uid
             order by created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100)) a), '[]'::jsonb);
end $$;
revoke all on function public.studio_external_action_list(integer) from public, anon;
grant execute on function public.studio_external_action_list(integer) to authenticated, service_role;

commit;
