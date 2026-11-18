-- VYORA — déconnexion d'une boutique : le statut suit le secret.
--
-- ## Le défaut que cette migration corrige
-- `store-connect` action `disconnect` supprimait bien le secret Vault, mais
-- laissait la ligne `saas_business.integration_connections` au statut
-- `connected`. L'écran affichait donc « connecté » pour une boutique dont la
-- clé n'existait plus : l'utilisateur ne comprenait pas pourquoi l'aperçu
-- répondait `CONNECTION_REQUIRED`, et la seule façon de rétablir la vérité
-- aurait été de reconnecter pour déconnecter.
--
-- ## Ce que la fonction fait
-- Elle remet la ligne à `disconnected`, efface `credential_ref` (le nom du
-- secret, qui n'existe plus) et conserve `external_account_ref` — l'adresse de
-- la boutique — pour que l'utilisateur reconnaisse laquelle il a déconnectée.
-- Rien n'est supprimé : l'historique des vérifications reste lisible.
--
-- ## Garde-fous
-- - `security definer` avec `search_path = ''`.
-- - Exige l'appartenance en écriture à l'entreprise.
-- - N'accepte jamais un identifiant d'entreprise fourni sans contrôle : la
--   fonction vérifie le droit, elle ne le suppose pas.
-- - Aucun droit direct à `authenticated` sur la table : seule la RPC écrit.

create or replace function saas_business.bg_disconnect_integration(
  p_user_id uuid,
  p_workspace_id uuid,
  p_connector_key text
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
    raise exception 'disconnect_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  perform saas_business.bg_validate_connector_key(p_connector_key);
  -- Écriture dans l'entreprise : propriétaire ou membre écrivain uniquement.
  perform saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);

  select c.id into v_id
    from saas_business.integration_connections c
   where c.user_id = p_user_id
     and c.workspace_id is not distinct from p_workspace_id
     and c.connector_key = p_connector_key
   order by c.updated_at desc, c.id
   limit 1;

  if v_id is null then
    -- Rien à déconnecter : ce n'est pas une erreur, c'est un état.
    return jsonb_build_object(
      'connection_id', null,
      'status', 'not_connected',
      'disconnected', true
    );
  end if;

  update saas_business.integration_connections c
     set status = 'disconnected',
         credential_ref = null,
         updated_at = clock_timestamp()
   where c.id = v_id;

  select c.status into v_statut from saas_business.integration_connections c where c.id = v_id;

  return jsonb_build_object(
    'connection_id', v_id,
    'status', v_statut,
    'disconnected', true
  );
end
$function$;

-- Aucune exécution directe par un rôle client : la fonction est appelée par
-- l'Edge Function, avec l'identité vérifiée côté serveur.
revoke all on function saas_business.bg_disconnect_integration(uuid, uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Contrôles
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_count integer;
begin
  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'saas_business' and p.proname = 'bg_disconnect_integration';
  if v_count <> 1 then
    raise exception 'fonction de déconnexion absente';
  end if;

  -- Elle doit vider la référence du secret ET changer le statut : une
  -- déconnexion qui ne ferait que l'un des deux mentirait sur l'état.
  if not exists (
    select 1 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'saas_business'
      and p.proname = 'bg_disconnect_integration'
      and pg_get_functiondef(p.oid) like '%credential_ref = null%'
      and pg_get_functiondef(p.oid) like '%disconnected%'
  ) then
    raise exception 'deconnexion incomplete : statut ou secret non traite';
  end if;
end
$verif$;
