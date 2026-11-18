-- Import & Connect — gestion des variantes dans le catalogue, et historique par RPC.
--
-- ## Ce que cette migration ajoute, et pourquoi
--
-- ### 1. Les variantes deviennent éditables dans la fiche produit
-- La table `ugc_product_variants` existe et l'import l'alimente. Il manquait de
-- quoi la gérer au quotidien : ajouter une taille, changer un stock, retirer une
-- option. Trois RPC le font, toutes soumises à la même règle que le produit
-- parent — appartenance à l'entreprise ET abonnement actif pour écrire.
--
-- **Désactiver ≠ supprimer.** `p_active` permet de retirer une variante de la
-- vente sans effacer son historique de stock ni sa référence. Une suppression
-- ne doit jamais être le seul moyen de retirer une taille.
--
-- ### 2. L'historique d'import passe par une RPC, pas par PostgREST
-- `saas_ugc` n'est pas exposé à PostgREST (`config.toml` : `schemas = ["public"]`).
-- L'interface ne peut donc pas lire `ugc_import_jobs` directement, et c'est très
-- bien ainsi : une RPC `SECURITY DEFINER` peut filtrer sur `auth.uid()` sans
-- qu'aucun identifiant fourni par le client ne décide de la portée.
--
-- Toutes les fonctions ci-dessous :
--   * n'acceptent AUCUN identifiant d'utilisateur (seul `auth.uid()` compte) ;
--   * valident l'entreprise par `is_workspace_member` AVANT toute lecture ;
--   * ne renvoient que des champs utiles à l'écran, jamais la charge interne
--     (pas de `payload`, pas d'`user_id` d'un tiers, pas de clé technique) ;
--   * restent lisibles sans abonnement : un compte expiré consulte son
--     historique, il ne peut simplement plus importer.

set search_path = '';

-- -----------------------------------------------------------------------------
-- 1) Une variante peut être retirée de la vente sans être effacée.
-- -----------------------------------------------------------------------------
alter table saas_ugc.ugc_product_variants
  add column if not exists active boolean not null default true;

comment on column saas_ugc.ugc_product_variants.active is
  'Variante proposée à la vente. false = retirée du catalogue sans perdre sa référence ni son stock.';

-- L'unicité ne doit pas empêcher de réactiver une option retirée : elle porte
-- sur les variantes actives uniquement. On remplace donc la contrainte par un
-- index partiel équivalent.
alter table saas_ugc.ugc_product_variants
  drop constraint if exists ugc_product_variants_unique_option;

create unique index if not exists ugc_product_variants_unique_active_option
  on saas_ugc.ugc_product_variants (product_id, attribute_name, attribute_value)
  where active;

-- -----------------------------------------------------------------------------
-- 2) Ajouter une variante.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_variant_create(
  p_product_id uuid,
  p_attribute_value text,
  p_attribute_name text default null,
  p_sku text default null,
  p_price_amount numeric default null,
  p_price_currency text default null,
  p_stock integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_ordre integer;
  v_ligne saas_ugc.ugc_product_variants;
begin
  if v_user is null then
    raise exception 'variant_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  if coalesce(length(trim(p_attribute_value)), 0) = 0 then
    raise exception 'variant_invalid:EMPTY_OPTION' using errcode = '22023';
  end if;

  select p.workspace_id into v_workspace
    from saas_ugc.ugc_products p where p.id = p_product_id;
  if v_workspace is null then
    raise exception 'variant_forbidden:PRODUCT_NOT_FOUND' using errcode = '42501';
  end if;
  if not (select ugc_private.can_edit_workspace(v_workspace)) then
    raise exception 'variant_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- L'abonnement avant toute écriture, comme pour la mise à jour.
  perform saas_business.bg_require_import_access(v_user, now());

  -- On ajoute à la fin : l'ordre du fichier importé est conservé, et une
  -- variante ajoutée à la main ne vient pas s'intercaler au milieu.
  select coalesce(max(position), -1) + 1 into v_ordre
    from saas_ugc.ugc_product_variants where product_id = p_product_id;

  insert into saas_ugc.ugc_product_variants (
    product_id, attribute_name, attribute_value, sku,
    price_amount, price_currency, stock, available, position
  ) values (
    p_product_id,
    nullif(trim(p_attribute_name), ''),
    trim(p_attribute_value),
    nullif(trim(p_sku), ''),
    p_price_amount,
    nullif(upper(trim(p_price_currency)), ''),
    p_stock,
    case when p_stock is null then null else p_stock > 0 end,
    v_ordre
  )
  returning * into v_ligne;

  return jsonb_build_object(
    'id', v_ligne.id,
    'product_id', v_ligne.product_id,
    'attribute_name', v_ligne.attribute_name,
    'attribute_value', v_ligne.attribute_value,
    'sku', v_ligne.sku,
    'price_amount', v_ligne.price_amount,
    'price_currency', v_ligne.price_currency,
    'stock', v_ligne.stock,
    'available', v_ligne.available,
    'active', v_ligne.active,
    'position', v_ligne.position
  );
exception
  when unique_violation then
    raise exception 'variant_invalid:DUPLICATE_OPTION' using errcode = '23505';
end
$function$;

comment on function public.vyora_ugc_variant_create(uuid, text, text, text, numeric, text, integer) is
  'Ajoute une variante à un produit. Appartenance + abonnement vérifiés en base, aucun identifiant client pour la portée.';

-- -----------------------------------------------------------------------------
-- 3) Désactiver / réactiver une variante (sans la supprimer).
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_variant_set_active(
  p_variant_id uuid,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_ligne saas_ugc.ugc_product_variants;
begin
  if v_user is null then
    raise exception 'variant_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select p.workspace_id into v_workspace
    from saas_ugc.ugc_product_variants v
    join saas_ugc.ugc_products p on p.id = v.product_id
   where v.id = p_variant_id;
  if v_workspace is null then
    raise exception 'variant_forbidden:VARIANT_NOT_FOUND' using errcode = '42501';
  end if;
  if not (select ugc_private.can_edit_workspace(v_workspace)) then
    raise exception 'variant_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  perform saas_business.bg_require_import_access(v_user, now());

  update saas_ugc.ugc_product_variants
     set active = coalesce(p_active, false), updated_at = now()
   where id = p_variant_id
  returning * into v_ligne;

  return jsonb_build_object(
    'id', v_ligne.id,
    'active', v_ligne.active
  );
exception
  when unique_violation then
    -- Réactiver une option dont une autre variante active porte déjà le nom.
    raise exception 'variant_invalid:DUPLICATE_OPTION' using errcode = '23505';
end
$function$;

comment on function public.vyora_ugc_variant_set_active(uuid, boolean) is
  'Retire ou remet une variante en vente. Suppression impossible : la référence et le stock sont conservés.';

-- -----------------------------------------------------------------------------
-- 4) Mise à jour d'une variante : on peut enfin vider un champ.
--    L'ancienne version utilisait `coalesce`, donc un prix ne pouvait jamais
--    revenir à « même prix que le parent ». `p_champs` porte les seuls champs
--    à changer ; une clé absente reste intacte, une clé à `null` efface.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_variant_update(
  p_variant_id uuid,
  p_attribute_value text default null,
  p_sku text default null,
  p_price_amount numeric default null,
  p_price_currency text default null,
  p_stock integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_ligne saas_ugc.ugc_product_variants;
begin
  if v_user is null then
    raise exception 'variant_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select p.workspace_id into v_workspace
    from saas_ugc.ugc_product_variants v
    join saas_ugc.ugc_products p on p.id = v.product_id
   where v.id = p_variant_id;
  if v_workspace is null then
    raise exception 'variant_forbidden:VARIANT_NOT_FOUND' using errcode = '42501';
  end if;
  if not (select ugc_private.can_edit_workspace(v_workspace)) then
    raise exception 'variant_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  perform saas_business.bg_require_import_access(v_user, now());

  update saas_ugc.ugc_product_variants
     set attribute_value = coalesce(nullif(trim(p_attribute_value), ''), attribute_value),
         sku = case when p_sku is null then sku else nullif(trim(p_sku), '') end,
         price_amount = p_price_amount,
         price_currency = case when p_price_currency is null then price_currency
                               else nullif(upper(trim(p_price_currency)), '') end,
         stock = coalesce(p_stock, stock),
         available = case when p_stock is null then available else p_stock > 0 end,
         updated_at = now()
   where id = p_variant_id
  returning * into v_ligne;

  return jsonb_build_object(
    'id', v_ligne.id,
    'attribute_name', v_ligne.attribute_name,
    'attribute_value', v_ligne.attribute_value,
    'sku', v_ligne.sku,
    'price_amount', v_ligne.price_amount,
    'price_currency', v_ligne.price_currency,
    'stock', v_ligne.stock,
    'available', v_ligne.available,
    'active', v_ligne.active
  );
exception
  when unique_violation then
    raise exception 'variant_invalid:DUPLICATE_OPTION' using errcode = '23505';
end
$function$;

-- -----------------------------------------------------------------------------
-- 5) Le catalogue expose désormais l'état actif et les compteurs utiles.
--    On remplace la fonction : sa forme de retour évolue (champ `active`).
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_catalog(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_acces jsonb;
begin
  if v_user is null then
    raise exception 'catalog_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from saas_ugc.ugc_workspaces w
     where w.id = p_workspace_id
       and (select ugc_private.is_workspace_member(w.id))
  ) then
    raise exception 'catalog_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  v_acces := saas_business.bg_import_access(v_user, now());

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    'read_only', coalesce((v_acces->>'allowed')::boolean, false) is not true,
    'access', v_acces,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'description', p.description,
        'price_amount', p.price_amount,
        'price_currency', p.price_currency,
        'product_url', p.product_url,
        'created_at', p.created_at,
        'updated_at', p.updated_at,
        'variants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', v.id,
            'attribute_name', v.attribute_name,
            'attribute_value', v.attribute_value,
            'sku', v.sku,
            'price_amount', v.price_amount,
            'price_currency', v.price_currency,
            'stock', v.stock,
            'available', v.available,
            'active', v.active,
            'position', v.position
          ) order by v.position, v.attribute_value)
          from saas_ugc.ugc_product_variants v
         where v.product_id = p.id
        ), '[]'::jsonb)
      ) order by p.name)
      from saas_ugc.ugc_products p
     where p.workspace_id = p_workspace_id
    ), '[]'::jsonb)
  );
end
$function$;

-- -----------------------------------------------------------------------------
-- 6) Historique des imports — la RPC de l'interface.
--
--    Elle rend les champs exactement nécessaires à l'écran, paginés, et rien
--    d'autre. Le `payload` d'un aperçu, l'identifiant de l'utilisateur qui a
--    lancé l'import et les clés techniques restent en base.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_import_history(
  p_workspace_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_limite integer;
  v_decalage integer;
  v_total integer;
begin
  if v_user is null then
    raise exception 'history_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  -- Appartenance AVANT lecture. Le paramètre d'entreprise vient du client, mais
  -- il ne sert qu'à désigner l'espace DANS LEQUEL l'utilisateur doit déjà être
  -- membre : il ne peut donc pas élargir la portée.
  if not exists (
    select 1 from saas_ugc.ugc_workspaces w
     where w.id = p_workspace_id
       and (select ugc_private.is_workspace_member(w.id))
  ) then
    raise exception 'history_forbidden:WORKSPACE_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Bornes : une limite énorme ne doit pas transformer un écran en export
  -- complet involontaire.
  v_limite := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_decalage := greatest(coalesce(p_offset, 0), 0);

  -- ## Portée personnelle
  -- L'historique est celui de l'appelant : dans une entreprise à plusieurs
  -- membres, chacun voit SES imports. Un propriétaire qui voudrait l'activité
  -- de son équipe relèverait d'un écran d'administration distinct, pas de cet
  -- historique — et la demande est explicite : jamais les imports d'un autre
  -- utilisateur. Le filtre est donc sur `user_id`, en plus de l'entreprise.
  select count(*)::integer into v_total
    from saas_ugc.ugc_import_jobs j
   where j.workspace_id = p_workspace_id
     and j.user_id = v_user;

  return jsonb_build_object(
    'workspace_id', p_workspace_id,
    -- La lecture de l'historique ne dépend pas de l'abonnement : un compte
    -- expiré consulte ce qu'il a fait, il ne peut simplement plus importer.
    'total', v_total,
    'limit', v_limite,
    'offset', v_decalage,
    'jobs', coalesce((
      select jsonb_agg(ligne order by ligne->>'created_at' desc)
      from (
        select jsonb_build_object(
          'id', j.id,
          'created_at', j.created_at,
          'source', j.source,
          'reference', j.reference,
          'status', j.status,
          'products_created', j.products_created,
          'products_failed', j.products_failed,
          'variants_created', j.variants_created,
          -- Le nombre d'erreurs est un compteur ; le détail est à la demande,
          -- via `vyora_ugc_import_report`.
          'errors_count', coalesce(jsonb_array_length(j.failures), 0),
          'format', case
            when j.source = 'url' then 'url'
            when j.reference ~* '\.xlsx?$' then 'xlsx'
            when j.reference ~* '\.csv$' then 'csv'
            else 'fichier'
          end
        ) as ligne
        from saas_ugc.ugc_import_jobs j
        where j.workspace_id = p_workspace_id
          and j.user_id = v_user
        order by j.created_at desc
        limit v_limite offset v_decalage
      ) as page
    ), '[]'::jsonb)
  );
end
$function$;

comment on function public.vyora_ugc_import_history(uuid, integer, integer) is
  'Historique paginé des imports d''une entreprise. Membre vérifié en base, champs d''affichage seulement, lisible sans abonnement.';

-- -----------------------------------------------------------------------------
-- 7) Rapport détaillé d'un import.
--
--    Séparé de l'historique : la liste reste légère, et le détail n'est chargé
--    que si l'utilisateur ouvre un rapport. L'identifiant d'import ne peut
--    désigner qu'un import de SON entreprise — un identifiant d'une autre
--    entreprise rend « introuvable », sans révéler son existence.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_import_report(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := (select auth.uid());
  v_job saas_ugc.ugc_import_jobs;
begin
  if v_user is null then
    raise exception 'history_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  -- Même portée que la liste : l'import doit appartenir à l'appelant ET à un
  -- espace dont il est membre. Sans le filtre sur `user_id`, le rapport
  -- donnerait le détail d'un import absent de la liste.
  select * into v_job
    from saas_ugc.ugc_import_jobs j
   where j.id = p_job_id
     and j.user_id = v_user;

  if v_job.id is null
     or not (select ugc_private.is_workspace_member(v_job.workspace_id)) then
    -- Même message dans tous les cas : l'existence d'un import d'un autre
    -- utilisateur ou d'une autre entreprise n'est pas une information à donner.
    raise exception 'history_forbidden:NOT_FOUND' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'id', v_job.id,
    'created_at', v_job.created_at,
    'source', v_job.source,
    'reference', v_job.reference,
    'status', v_job.status,
    'products_created', v_job.products_created,
    'products_failed', v_job.products_failed,
    'variants_created', v_job.variants_created,
    'failures', coalesce(v_job.failures, '[]'::jsonb)
  );
end
$function$;

comment on function public.vyora_ugc_import_report(uuid) is
  'Rapport détaillé d''un import. Un identifiant d''une autre entreprise répond « introuvable », jamais « interdit ».';

-- -----------------------------------------------------------------------------
-- 8) Droits : `authenticated` seulement, jamais `anon`.
-- -----------------------------------------------------------------------------
revoke all on function public.vyora_ugc_variant_create(uuid, text, text, text, numeric, text, integer) from public, anon;
revoke all on function public.vyora_ugc_variant_set_active(uuid, boolean) from public, anon;
revoke all on function public.vyora_ugc_import_history(uuid, integer, integer) from public, anon;
revoke all on function public.vyora_ugc_import_report(uuid) from public, anon;

grant execute on function public.vyora_ugc_variant_create(uuid, text, text, text, numeric, text, integer) to authenticated;
grant execute on function public.vyora_ugc_variant_set_active(uuid, boolean) to authenticated;
grant execute on function public.vyora_ugc_import_history(uuid, integer, integer) to authenticated;
grant execute on function public.vyora_ugc_import_report(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 9) Contrôles de non-régression, exécutés à l'application.
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_nb integer;
begin
  -- 9a. Aucune des nouvelles fonctions n'est exécutable par `anon`.
  select count(*) into v_nb
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'vyora_ugc_variant_create', 'vyora_ugc_variant_set_active',
       'vyora_ugc_import_history', 'vyora_ugc_import_report'
     )
     and has_function_privilege('anon', p.oid, 'execute');
  if v_nb > 0 then
    raise exception 'anon peut exécuter une RPC d''import : interdit (%).', v_nb;
  end if;

  -- 9b. Aucune ne prend d'identifiant d'utilisateur en paramètre : la portée
  --     vient de `auth.uid()`, jamais du client.
  select count(*) into v_nb
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('vyora_ugc_import_history', 'vyora_ugc_import_report')
     and pg_get_function_arguments(p.oid) ~* '(^|,)\s*p_user_id';
  if v_nb > 0 then
    raise exception 'une RPC d''historique accepte un identifiant d''utilisateur (%).', v_nb;
  end if;

  -- 9c. L'unicité partielle des options actives existe : sans elle, réactiver
  --     une variante retirée pourrait dupliquer une option.
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'saas_ugc'
       and indexname = 'ugc_product_variants_unique_active_option'
  ) then
    raise exception 'index d''unicité des variantes actives absent';
  end if;

  -- 9d. La colonne `active` existe et vaut true par défaut : aucune variante
  --     existante ne doit disparaître du catalogue après la migration.
  select count(*) into v_nb
    from saas_ugc.ugc_product_variants where active is distinct from true;
  if v_nb > 0 then
    raise exception 'des variantes existantes ont été désactivées par la migration (%).', v_nb;
  end if;

  raise notice 'variantes éditables + historique par RPC : en place.';
end
$verif$;
