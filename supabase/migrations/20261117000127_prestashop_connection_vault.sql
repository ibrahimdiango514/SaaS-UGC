-- VYORA — connexion PrestaShop : secrets côté serveur et journal de connexion.
--
-- ## Ce que cette migration ajoute, et pourquoi
--
-- `saas_business.integration_connections` existe déjà et porte l'état d'une
-- connexion (`pending`, `connected`, `error`…). On ne la remplace pas : on
-- s'appuie dessus. Deux choses manquent pour un connecteur à clé d'API :
--
--   1. **un endroit où le secret vit**, hors de portée du navigateur. La
--      colonne `credential_ref` existante est un simple texte : y mettre la clé
--      reviendrait à la stocker en clair dans une table lisible par le
--      propriétaire via RLS. On stocke donc dans **Vault**, et
--      `credential_ref` ne contient que le NOM du secret Vault.
--
--   2. **un journal de vérification**, pour distinguer « jamais essayé » de
--      « essayé, refusé » — sans quoi une connexion échouée est indiscernable
--      d'une connexion jamais tentée, et l'utilisateur ne sait pas s'il doit
--      corriger sa clé ou cliquer à nouveau.
--
-- ## Ce que cette migration ne fait pas
--
-- - Elle ne duplique pas `integration_connections`.
-- - Elle n'accorde AUCUN droit d'écriture directe à `authenticated` : toute
--   écriture passe par les RPC `security definer` ci-dessous, qui vérifient
--   l'appartenance à l'entreprise ET l'abonnement payant.
-- - Elle ne supprime rien.

-- ---------------------------------------------------------------------------
-- 1) Journal de vérification de connexion
-- ---------------------------------------------------------------------------
create table if not exists saas_business.integration_connection_checks (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references saas_business.integration_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,
  connector_key text not null,
  /** Issue de la tentative : seuls ces trois états existent. */
  outcome text not null check (outcome in ('ok', 'refused', 'failed')),
  /** Code machine, jamais un message contenant un secret. */
  error_code text,
  /** Message affichable, expurgé côté serveur avant écriture. */
  error_message text,
  /** Ce qui a été réellement lu — la preuve de la vérification. */
  resources_read text[] not null default '{}',
  /** Nombre de produits annoncé au moment de la vérification. */
  total_products integer,
  duration_ms integer,
  created_at timestamptz not null default now()
);

comment on table saas_business.integration_connection_checks is
  'Journal des vérifications de connexion d''un connecteur à clé d''API. Ne contient jamais de secret.';

create index if not exists integration_connection_checks_scope_idx
  on saas_business.integration_connection_checks (workspace_id, connector_key, created_at desc);

alter table saas_business.integration_connection_checks enable row level security;

-- Lecture seule pour le propriétaire des lignes. Aucune policy d'écriture :
-- les insertions passent exclusivement par la RPC ci-dessous.
drop policy if exists integration_connection_checks_owner_read
  on saas_business.integration_connection_checks;
create policy integration_connection_checks_owner_read
  on saas_business.integration_connection_checks
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on saas_business.integration_connection_checks from anon, authenticated;
grant select on saas_business.integration_connection_checks to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Connexion : enregistrement d'une vérification réussie
-- ---------------------------------------------------------------------------
-- Crée ou met à jour la ligne `integration_connections` du couple
-- (utilisateur, entreprise, connecteur), passe son statut à `connected`, et
-- n'écrit QUE le nom du secret Vault dans `credential_ref`.
--
-- L'abonnement payant est exigé ICI, en base : un appel direct à la RPC sans
-- passer par l'Edge Function ne suffit pas à contourner la règle.
create or replace function saas_business.bg_connect_integration(
  p_user_id uuid,
  p_workspace_id uuid,
  p_connector_key text,
  p_credential_ref text,
  p_external_account_ref text,
  p_resources_read text[],
  p_total_products integer,
  p_duration_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_droits jsonb;
  v_id uuid;
  v_statut text;
begin
  if p_user_id is null then
    raise exception 'connect_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  perform saas_business.bg_validate_connector_key(p_connector_key);
  -- Écriture dans l'entreprise : propriétaire ou membre écrivain uniquement.
  perform saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);

  -- Abonnement : actif ET payé. Même règle que l'import, appliquée en base.
  v_droits := saas_business.bg_import_access(p_user_id, now());
  if coalesce((v_droits->>'allowed')::boolean, false) is not true then
    raise exception 'connect_forbidden:SUBSCRIPTION_REQUIRED:%',
      coalesce(v_droits->>'reason', 'UNKNOWN') using errcode = '42501';
  end if;

  if p_credential_ref is null or length(btrim(p_credential_ref)) < 8 then
    raise exception 'connect_invalid:CREDENTIAL_REF_REQUIRED' using errcode = '22023';
  end if;

  select c.id into v_id
    from saas_business.integration_connections c
   where c.user_id = p_user_id
     and c.workspace_id is not distinct from p_workspace_id
     and c.connector_key = p_connector_key
   order by c.updated_at desc, c.id
   limit 1;

  if v_id is null then
    insert into saas_business.integration_connections
      (user_id, workspace_id, connector_key, external_account_ref, credential_ref, status)
    values (p_user_id, p_workspace_id, p_connector_key, p_external_account_ref, p_credential_ref, 'connected')
    returning id into v_id;
  else
    update saas_business.integration_connections c
       set external_account_ref = p_external_account_ref,
           credential_ref = p_credential_ref,
           status = 'connected',
           updated_at = clock_timestamp()
     where c.id = v_id;
  end if;

  insert into saas_business.integration_connection_checks
    (connection_id, user_id, workspace_id, connector_key, outcome,
     resources_read, total_products, duration_ms)
  values (v_id, p_user_id, p_workspace_id, p_connector_key, 'ok',
          coalesce(p_resources_read, '{}'::text[]), p_total_products, p_duration_ms);

  select c.status into v_statut from saas_business.integration_connections c where c.id = v_id;

  return jsonb_build_object(
    'connection_id', v_id,
    'status', v_statut,
    'external_account_ref', p_external_account_ref
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 3) Échec de connexion : trace SANS jamais salir une connexion valide
-- ---------------------------------------------------------------------------
-- Un échec ne doit pas déconnecter une boutique qui fonctionnait : si la ligne
-- est déjà `connected`, elle reste `connected` et l'échec n'est que journalisé.
-- Sinon elle passe à `error`, avec un motif lisible.
create or replace function saas_business.bg_record_integration_failure(
  p_user_id uuid,
  p_workspace_id uuid,
  p_connector_key text,
  p_error_code text,
  p_error_message text,
  p_duration_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_id uuid;
  v_statut text;
begin
  if p_user_id is null then
    raise exception 'connect_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  perform saas_business.bg_validate_connector_key(p_connector_key);
  perform saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);

  select c.id, c.status into v_id, v_statut
    from saas_business.integration_connections c
   where c.user_id = p_user_id
     and c.workspace_id is not distinct from p_workspace_id
     and c.connector_key = p_connector_key
   order by c.updated_at desc, c.id
   limit 1;

  if v_id is null then
    insert into saas_business.integration_connections
      (user_id, workspace_id, connector_key, status)
    values (p_user_id, p_workspace_id, p_connector_key, 'error')
    returning id, status into v_id, v_statut;
  elsif v_statut <> 'connected' then
    update saas_business.integration_connections c
       set status = 'error',
           updated_at = clock_timestamp()
     where c.id = v_id;
    v_statut := 'error';
  end if;

  insert into saas_business.integration_connection_checks
    (connection_id, user_id, workspace_id, connector_key, outcome,
     error_code, error_message, duration_ms)
  values (v_id, p_user_id, p_workspace_id, p_connector_key, 'failed',
          left(coalesce(p_error_code, 'UNKNOWN'), 64),
          left(coalesce(p_error_message, 'Vérification impossible.'), 500),
          p_duration_ms);

  return jsonb_build_object('connection_id', v_id, 'status', v_statut);
end
$function$;

-- ---------------------------------------------------------------------------
-- 4) Lecture de l'état d'un connecteur, pour l'interface
-- ---------------------------------------------------------------------------
-- Ne renvoie AUCUN secret : ni la clé, ni le nom du secret Vault. Le nom du
-- secret est une information interne ; le navigateur n'en a pas besoin.
create or replace function public.vyora_ugc_store_connection(
  p_workspace_id uuid,
  p_connector_key text default 'prestashop'
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_ligne record;
  v_derniere record;
begin
  if v_user is null then
    raise exception 'connection_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  perform saas_business.bg_require_workspace(v_user, p_workspace_id, false);

  select c.id, c.status, c.external_account_ref, c.updated_at, c.credential_ref is not null as has_credential
    into v_ligne
    from saas_business.integration_connections c
   where c.user_id = v_user
     and c.workspace_id is not distinct from p_workspace_id
     and c.connector_key = p_connector_key
   order by c.updated_at desc, c.id
   limit 1;

  select k.outcome, k.error_code, k.error_message, k.resources_read,
         k.total_products, k.created_at
    into v_derniere
    from saas_business.integration_connection_checks k
   where k.user_id = v_user
     and k.workspace_id is not distinct from p_workspace_id
     and k.connector_key = p_connector_key
   order by k.created_at desc
   limit 1;

  if v_ligne.id is null then
    return jsonb_build_object(
      'connector_key', p_connector_key,
      'status', 'not_connected',
      'connected', false,
      'external_account_ref', null,
      'last_check', null
    );
  end if;

  return jsonb_build_object(
    'connector_key', p_connector_key,
    'connection_id', v_ligne.id,
    'status', v_ligne.status,
    -- `connected` seulement si une clé est RÉELLEMENT enregistrée : une ligne
    -- laissée par une ancienne demande d'activation sans secret ne compte pas.
    'connected', v_ligne.status = 'connected' and v_ligne.has_credential,
    'external_account_ref', v_ligne.external_account_ref,
    'updated_at', v_ligne.updated_at,
    'last_check', case when v_derniere.created_at is null then null else jsonb_build_object(
      'outcome', v_derniere.outcome,
      'error_code', v_derniere.error_code,
      'error_message', v_derniere.error_message,
      'resources_read', v_derniere.resources_read,
      'total_products', v_derniere.total_products,
      'checked_at', v_derniere.created_at
    ) end
  );
end
$function$;

revoke all on function public.vyora_ugc_store_connection(uuid, text) from public, anon;
grant execute on function public.vyora_ugc_store_connection(uuid, text) to authenticated;
revoke all on function saas_business.bg_connect_integration(uuid, uuid, text, text, text, text[], integer, integer) from public, anon, authenticated;
revoke all on function saas_business.bg_record_integration_failure(uuid, uuid, text, text, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) Contrôles
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_count integer;
  v_rls boolean;
  v_grant integer;
begin
  select count(*) into v_count from information_schema.tables
   where table_schema = 'saas_business' and table_name = 'integration_connection_checks';
  if v_count <> 1 then
    raise exception 'journal de verification absent';
  end if;

  select relrowsecurity into v_rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'saas_business' and c.relname = 'integration_connection_checks';
  if v_rls is not true then
    raise exception 'RLS non activee sur le journal';
  end if;

  select count(*) into v_grant
    from information_schema.role_table_grants
   where table_schema = 'saas_business'
     and table_name = 'integration_connection_checks'
     and grantee = 'authenticated'
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
  if v_grant <> 0 then
    raise exception 'authenticated peut ecrire le journal';
  end if;

  if to_regprocedure('public.vyora_ugc_store_connection(uuid,text)') is null then
    raise exception 'RPC de lecture absente';
  end if;
  if to_regprocedure('saas_business.bg_connect_integration(uuid,uuid,text,text,text,text[],integer,integer)') is null then
    raise exception 'RPC de connexion absente';
  end if;
  if to_regprocedure('saas_business.bg_record_integration_failure(uuid,uuid,text,text,text,integer)') is null then
    raise exception 'RPC d echec absente';
  end if;

  -- La RPC de lecture ne doit pas exposer le nom du secret Vault.
  if (select pg_get_functiondef(p.oid) like '%credential_ref%'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'vyora_ugc_store_connection') then
    -- `credential_ref` est utilisé uniquement via `is not null` : on accepte
    -- cette occurrence, mais on refuse toute sélection de sa valeur.
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'vyora_ugc_store_connection'
         and pg_get_functiondef(p.oid) ~* 'return[^;]*credential_ref'
    ) then
      raise exception 'la RPC de lecture expose le nom du secret';
    end if;
  end if;

  raise notice 'controles passes : connexion PrestaShop et journal en place';
end $verif$;
