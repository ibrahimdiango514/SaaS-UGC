-- VYORA — outils MCP de la phase 4 : boutiques, catalogue, imports.
--
-- ## Le principe, répété dans chaque fonction
--
-- Chaque fonction reçoit un `p_user_id` que le serveur MCP a lu dans le jeton,
-- jamais dans la requête du client. Elle vérifie ensuite l'appartenance avec
-- `saas_business.bg_can_workspace(...)` — la même primitive que `store-connect`
-- utilise — avant de renvoyer quoi que ce soit.
--
-- Un `workspace_id` fourni par l'appelant est donc une RESTRICTION, jamais une
-- autorisation : fournir l'identifiant d'une entreprise étrangère ne donne pas
-- accès à ses données, cela produit un refus explicite ou une liste vide.
--
-- ## Aucun secret en sortie
--
-- Ces fonctions ne renvoient ni clé d'API, ni jeton, ni référence de coffre
-- (`credential_ref`). Un client MCP externe ne doit jamais pouvoir lire un
-- identifiant de boutique au sens « comment s'y authentifier » : seulement son
-- état de connexion.

-- ---------------------------------------------------------------------------
-- 1) Boutiques connectées
-- ---------------------------------------------------------------------------

create or replace function public.mcp_stores_list(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_business'
as $function$
declare v_items jsonb;
begin
  if p_user_id is null then raise exception 'user_required'; end if;

  /*
   * On interroge les deux modèles de connexion :
   *   - `integration_connections` : connecteurs déclaratifs (PrestaShop,
   *     Chariow, Shopify, WooCommerce) ;
   *   - `custom_api_connections`  : API personnalisée, dont l'état vit dans sa
   *     propre table.
   *
   * Seules les lignes dont l'entreprise est accessible sont retenues. Une ligne
   * historique sans entreprise est personnelle et reste visible.
   */
  select coalesce(jsonb_agg(ligne order by ligne->>'plateforme'), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'plateforme', c.connector_key,
      'statut', c.status,
      'entreprise_id', c.workspace_id,
      'connectee_depuis', c.created_at,
      'derniere_maj', c.updated_at
    ) as ligne
      from saas_business.integration_connections c
     where c.user_id = p_user_id
       and saas_business.bg_can_workspace(p_user_id, c.workspace_id, false)

    union all

    select jsonb_build_object(
      'plateforme', 'custom-api',
      -- `base_url` est la seule colonne d'adresse : un site configuré signale
      -- une connexion décrite, pas nécessairement vérifiée — le statut de
      -- sonde (`last_probe_status`) dit le reste.
      'statut', case when d.base_url is null then 'unconfigured' else 'connected' end,
      'entreprise_id', d.workspace_id,
      'connectee_depuis', d.created_at,
      'derniere_maj', d.updated_at,
      'read_only', d.read_only,
      'derniere_sonde', d.last_probe_status,
      'sonde_le', d.last_probe_at
    )
      from saas_business.custom_api_connections d
     where d.user_id = p_user_id
       and saas_business.bg_can_workspace(p_user_id, d.workspace_id, false)
  ) s;

  return jsonb_build_object('items', v_items, 'count', jsonb_array_length(v_items));
end;
$function$;

revoke all on function public.mcp_stores_list(uuid) from public, anon, authenticated;
grant execute on function public.mcp_stores_list(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2) Catalogue de produits
-- ---------------------------------------------------------------------------

create or replace function public.mcp_products_list(
  p_user_id uuid,
  p_workspace_id uuid default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_ugc', 'saas_business'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_items jsonb;
  v_total bigint;
begin
  if p_user_id is null then raise exception 'user_required'; end if;

  /*
   * Un `workspace_id` fourni est d'abord VÉRIFIÉ. Le refuser explicitement
   * plutôt que renvoyer une liste vide évite au client de croire que
   * l'entreprise est vide alors qu'elle ne lui appartient pas.
   */
  if p_workspace_id is not null
     and not saas_business.bg_can_workspace(p_user_id, p_workspace_id, false) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  select count(*) into v_total
    from saas_ugc.ugc_products p
   where saas_business.bg_can_workspace(p_user_id, p.workspace_id, false)
     and (p_workspace_id is null or p.workspace_id = p_workspace_id);

  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.updated_at desc), '[]'::jsonb) into v_items
  from (
    select p.id, p.workspace_id, w.name as entreprise, p.name, p.price_amount,
           p.price_currency, p.product_url, p.updated_at,
           (select count(*) from saas_ugc.ugc_product_variants v
             where v.product_id = p.id and v.active) as variantes,
           -- On renvoie le NOMBRE d'images, pas les chemins : un chemin de
           -- stockage n'est pas une donnée métier utile à un agent.
           coalesce(jsonb_array_length(p.reference_image_paths), 0) as images
      from saas_ugc.ugc_products p
      left join saas_ugc.ugc_workspaces w on w.id = p.workspace_id
     where saas_business.bg_can_workspace(p_user_id, p.workspace_id, false)
       and (p_workspace_id is null or p.workspace_id = p_workspace_id)
     order by p.updated_at desc
     limit v_limit offset v_offset
  ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
end;
$function$;

revoke all on function public.mcp_products_list(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_products_list(uuid, uuid, integer, integer) to service_role;

create or replace function public.mcp_product_get(p_user_id uuid, p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_ugc', 'saas_business'
as $function$
declare v_produit jsonb;
begin
  if p_user_id is null then raise exception 'user_required'; end if;
  if p_product_id is null then raise exception 'product_required'; end if;

  /*
   * Le produit est cherché SANS filtre d'appartenance, puis l'accès est
   * vérifié sur son entreprise. Distinguer « inexistant » de « pas le droit »
   * fuiterait l'existence d'un identifiant ; les deux cas renvoient donc la
   * même réponse « introuvable ».
   */
  select jsonb_build_object(
    'id', p.id, 'workspace_id', p.workspace_id, 'name', p.name,
    'description', p.description, 'price_amount', p.price_amount,
    'price_currency', p.price_currency, 'product_url', p.product_url,
    'key_benefits', p.key_benefits, 'features', p.features,
    'created_at', p.created_at, 'updated_at', p.updated_at,
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', v.sku, 'attribut', v.attribute_name, 'valeur', v.attribute_value,
        'prix', v.price_amount, 'devise', v.price_currency,
        'stock', v.stock, 'disponible', v.available
      ) order by v.position)
      from saas_ugc.ugc_product_variants v
      where v.product_id = p.id and v.active
    ), '[]'::jsonb)
  ) into v_produit
  from saas_ugc.ugc_products p
  where p.id = p_product_id;

  if v_produit is null then
    return jsonb_build_object('found', false);
  end if;

  if not saas_business.bg_can_workspace(p_user_id, (v_produit->>'workspace_id')::uuid, false) then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object('found', true, 'product', v_produit);
end;
$function$;

revoke all on function public.mcp_product_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mcp_product_get(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Historique d'import
-- ---------------------------------------------------------------------------

create or replace function public.mcp_imports_list(p_user_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_ugc'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_items jsonb;
  v_total bigint;
begin
  if p_user_id is null then raise exception 'user_required'; end if;

  select count(*) into v_total from saas_ugc.ugc_import_jobs where user_id = p_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', j.id, 'workspace_id', j.workspace_id, 'source', j.source,
    'statut', j.status, 'produits_crees', j.products_created,
    'produits_en_echec', j.products_failed, 'variantes_creees', j.variants_created,
    'echecs', j.failures, 'date', j.created_at
  ) order by j.created_at desc), '[]'::jsonb) into v_items
  from (
    select * from saas_ugc.ugc_import_jobs
     where user_id = p_user_id
     order by created_at desc limit v_limit offset v_offset
  ) j;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
end;
$function$;

revoke all on function public.mcp_imports_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_imports_list(uuid, integer, integer) to service_role;

create or replace function public.mcp_import_preview_list(p_user_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_ugc'
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_items jsonb;
  v_total bigint;
begin
  if p_user_id is null then raise exception 'user_required'; end if;

  select count(*) into v_total
    from saas_ugc.ugc_import_previews
   where user_id = p_user_id and expires_at > now();

  /*
   * On ne renvoie PAS `payload` : il contient la fiche complète des produits
   * lus chez la plateforme, parfois des centaines. On en extrait le résumé
   * utile à un agent — combien de produits, combien de doublons — sans
   * transformer une liste d'aperçus en export de catalogue.
   */
  select coalesce(jsonb_agg(jsonb_build_object(
    'apercu_id', a.id,
    'workspace_id', a.workspace_id,
    'produits_detectes', coalesce(jsonb_array_length(a.payload->'products'), 0),
    'cree_le', a.created_at,
    'expire_le', a.expires_at
  ) order by a.created_at desc), '[]'::jsonb) into v_items
  from (
    select * from saas_ugc.ugc_import_previews
     where user_id = p_user_id and expires_at > now()
     order by created_at desc limit v_limit offset v_offset
  ) a;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'items', v_items);
end;
$function$;

revoke all on function public.mcp_import_preview_list(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.mcp_import_preview_list(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4) État détaillé des intégrations
-- ---------------------------------------------------------------------------

create or replace function public.mcp_integrations_status(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public', 'saas_business'
as $function$
declare v_items jsonb;
begin
  if p_user_id is null then raise exception 'user_required'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'plateforme', c.connector_key,
    'statut', c.status,
    'entreprise_id', c.workspace_id,
    'connectee_depuis', c.created_at,
    'derniere_maj', c.updated_at,
    'dernieres_verifications', coalesce((
      select jsonb_agg(jsonb_build_object(
               'resultat', k.outcome,
               -- On expose le CODE d'erreur, jamais `error_message` brut : un
               -- message d'API tierce peut contenir un fragment d'URL de
               -- boutique, ce qu'un client externe n'a pas à collecter.
               'code_erreur', k.error_code,
               'produits_lus', k.total_products,
               'duree_ms', k.duration_ms,
               'date', k.created_at
             ) order by k.created_at desc)
        from (select * from saas_business.integration_connection_checks cc
               where cc.user_id = p_user_id and cc.connector_key = c.connector_key
               order by cc.created_at desc limit 3) k
    ), '[]'::jsonb)
  ) order by c.connector_key), '[]'::jsonb) into v_items
  from saas_business.integration_connections c
  where c.user_id = p_user_id
    and saas_business.bg_can_workspace(p_user_id, c.workspace_id, false);

  return jsonb_build_object('items', v_items, 'count', jsonb_array_length(v_items));
end;
$function$;

revoke all on function public.mcp_integrations_status(uuid) from public, anon, authenticated;
grant execute on function public.mcp_integrations_status(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Création de produit (outil d'ÉCRITURE)
-- ---------------------------------------------------------------------------

create or replace function public.mcp_product_create(
  p_user_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_description text default null,
  p_price_amount numeric default null,
  p_price_currency text default 'XOF'
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'saas_ugc', 'saas_business'
as $function$
declare
  v_nom text := btrim(coalesce(p_name, ''));
  v_ws uuid := p_workspace_id;
  v_id uuid;
begin
  if p_user_id is null then raise exception 'user_required'; end if;
  if v_nom = '' or length(v_nom) > 200 then raise exception 'invalid_name'; end if;

  -- Sans entreprise précisée, on écrit dans la première dont l'utilisateur est
  -- MEMBRE. Aucun repli silencieux vers « n'importe quelle entreprise ».
  if v_ws is null then
    select m.workspace_id into v_ws
      from saas_ugc.ugc_workspace_members m
     where m.user_id = p_user_id
     order by m.created_at limit 1;
  end if;
  if v_ws is null then raise exception 'no_workspace'; end if;

  -- Écriture : `p_write = true` exige owner/admin/editor. Un lecteur de
  -- l'entreprise ne peut pas créer de produit par MCP.
  if not saas_business.bg_can_workspace(p_user_id, v_ws, true) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;

  insert into saas_ugc.ugc_products (workspace_id, name, description, price_amount, price_currency)
  values (v_ws, v_nom, nullif(btrim(coalesce(p_description, '')), ''), p_price_amount,
          upper(left(coalesce(nullif(btrim(p_price_currency), ''), 'XOF'), 3)))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'workspace_id', v_ws, 'name', v_nom, 'created', true);
end;
$function$;

revoke all on function public.mcp_product_create(uuid, uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.mcp_product_create(uuid, uuid, text, text, numeric, text) to service_role;
