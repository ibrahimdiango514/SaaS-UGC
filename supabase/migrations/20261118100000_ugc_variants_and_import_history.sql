-- Import & Connect — variantes réellement persistées + lecture seule après expiration.
--
-- ## Pourquoi cette migration existe
-- L'aperçu XLSX détectait les variantes, les additionnait, affichait les bonnes
-- quantités — puis les jetait à la confirmation. Le prix et le stock par
-- variante vivaient dans un tableau JavaScript, jamais en base. Un utilisateur
-- pouvait donc lire « S: 12, M: 15, L: 5 » dans l'aperçu et ne retrouver qu'une
-- fiche nue dans son catalogue. C'est exactement le genre d'écart qui fait perdre
-- confiance dans un import : l'aperçu promet, la base ne tient pas.
--
-- ## Le choix de structure
-- Une table `saas_ugc.ugc_product_variants`, liée au produit parent par
-- `product_id` en `ON DELETE CASCADE`. Pas de colonne `jsonb` sur
-- `ugc_products` : une variante a son propre prix, sa propre devise, son propre
-- stock et sa propre référence, et on doit pouvoir les interroger, les agréger
-- et les modifier indépendamment. Un `jsonb` obligerait à relire et réécrire
-- tout le document pour changer un stock.
--
-- ## Compatibilité
-- Aucune colonne de `ugc_products` n'est modifiée, renommée ou supprimée.
-- Un produit sans variante reste exactement ce qu'il était : zéro ligne dans la
-- nouvelle table. Le catalogue existant est lisible et éditable comme avant —
-- c'est aussi ce que vérifie le bloc de contrôle en fin de fichier.
--
-- ## Portée des droits
-- Les politiques reprennent celles de `ugc_products`, volontairement :
--   * lire      → membre de l'entreprise (donc lecture possible même sans
--                 abonnement : un catalogue expiré reste consultable) ;
--   * écrire    → abonnement actif ET droit d'édition, comme le produit parent.
-- Les suppressions d'entreprise cascadent, donc l'isolation suit le parent.

set search_path = '';

-- -----------------------------------------------------------------------------
-- 1) Les variantes.
-- -----------------------------------------------------------------------------
create table if not exists saas_ugc.ugc_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null
    references saas_ugc.ugc_products(id) on delete cascade,
  -- Attributs propres à la variante (taille, couleur, pointure…). Le nom du
  -- critère est conservé tel que la source l'écrit ; on ne devine pas.
  attribute_name text,
  attribute_value text not null,
  sku text,
  -- Prix et devise de LA VARIANTE : une taille peut coûter plus cher que sa
  -- voisine du même produit. `null` = « même prix que le parent », ce qui
  -- distingue « pas de prix propre » de « gratuit ».
  price_amount numeric,
  price_currency character(3),
  stock integer,
  -- `available` est la disponibilité déclarée par la source quand elle la
  -- fournit ; `stock` dit la quantité. Les deux peuvent coexister.
  available boolean,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ugc_product_variants_value_check
    check (length(trim(attribute_value)) between 1 and 120),
  constraint ugc_product_variants_stock_check
    check (stock is null or stock >= 0),
  constraint ugc_product_variants_price_check
    check (price_amount is null or price_amount >= 0),
  constraint ugc_product_variants_currency_check
    check (price_currency is null or price_currency ~ '^[A-Z]{3}$'),
  -- Une option n'apparaît qu'une fois par produit : deux lignes « M » seraient
  -- deux vérités contradictoires sur le même stock.
  constraint ugc_product_variants_unique_option
    unique (product_id, attribute_name, attribute_value)
);

comment on table saas_ugc.ugc_product_variants is
  'Déclinaisons d''un produit (taille, couleur…), avec leur prix, devise, stock et référence propres. Un produit sans variante n''a aucune ligne ici.';

comment on column saas_ugc.ugc_product_variants.price_amount is
  'Prix de la variante. NULL = prix du produit parent, et non « gratuit ».';

comment on column saas_ugc.ugc_product_variants.attribute_name is
  'Nom du critère tel que fourni par la source (Taille, Couleur…). NULL si la source ne fournit qu''une option.';

create index if not exists ugc_product_variants_product_idx
  on saas_ugc.ugc_product_variants (product_id, position);

-- -----------------------------------------------------------------------------
-- 2) Historique d'import.
--
--    Demande produit : « consulter son historique » même après expiration de
--    l'abonnement. Encore faut-il qu'un historique existe : jusqu'ici, une
--    confirmation ne laissait aucune trace au-delà des lignes créées. On ne
--    pouvait donc ni montrer ce qui a été importé, ni distinguer un import
--    partiel d'un import complet.
-- -----------------------------------------------------------------------------
create table if not exists saas_ugc.ugc_import_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null
    references saas_ugc.ugc_workspaces(id) on delete cascade,
  user_id uuid not null,
  source text not null,
  reference text,
  status text not null,
  products_created integer not null default 0,
  products_failed integer not null default 0,
  variants_created integer not null default 0,
  failures jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint ugc_import_jobs_status_check
    check (status in ('completed', 'partial', 'failed')),
  constraint ugc_import_jobs_source_check
    check (source in ('file', 'url'))
);

comment on table saas_ugc.ugc_import_jobs is
  'Journal des imports confirmés : ce qui a été créé, ce qui a échoué et pourquoi. Consultable même sans abonnement actif.';

create index if not exists ugc_import_jobs_workspace_idx
  on saas_ugc.ugc_import_jobs (workspace_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 3) RLS et droits.
-- -----------------------------------------------------------------------------
alter table saas_ugc.ugc_product_variants enable row level security;
alter table saas_ugc.ugc_import_jobs enable row level security;

-- Lecture : membre de l'entreprise, abonnement ou non. On passe par le produit
-- parent pour éviter toute jointure côté client et toute donnée d'un autre
-- espace.
drop policy if exists ugc_product_variants_select_member on saas_ugc.ugc_product_variants;
create policy ugc_product_variants_select_member on saas_ugc.ugc_product_variants
  for select
  to authenticated
  using (
    exists (
      select 1 from saas_ugc.ugc_products p
       where p.id = ugc_product_variants.product_id
         and (select ugc_private.is_workspace_member(p.workspace_id))
    )
  );

-- Écriture : mêmes conditions que le produit parent — abonnement actif ET
-- droit d'édition. Sans cela, la table des variantes serait une porte dérobée
-- pour modifier un catalogue expiré.
drop policy if exists ugc_product_variants_write_subscriber on saas_ugc.ugc_product_variants;
create policy ugc_product_variants_write_subscriber on saas_ugc.ugc_product_variants
  for all
  to authenticated
  using (
    exists (
      select 1 from saas_ugc.ugc_products p
       where p.id = ugc_product_variants.product_id
         and (select ugc_private.can_edit_workspace(p.workspace_id))
    )
    and coalesce(
      (saas_business.bg_import_access((select auth.uid()), now())->>'allowed')::boolean,
      false
    )
  )
  with check (
    exists (
      select 1 from saas_ugc.ugc_products p
       where p.id = ugc_product_variants.product_id
         and (select ugc_private.can_edit_workspace(p.workspace_id))
    )
    and coalesce(
      (saas_business.bg_import_access((select auth.uid()), now())->>'allowed')::boolean,
      false
    )
  );

-- Historique : lisible par les membres, y compris sans abonnement. Écrit
-- uniquement par les Edge Functions (service_role), jamais par un client :
-- une ligne d'historique qui prétendrait un import réussi ne doit pas pouvoir
-- être fabriquée depuis le navigateur.
drop policy if exists ugc_import_jobs_select_member on saas_ugc.ugc_import_jobs;
create policy ugc_import_jobs_select_member on saas_ugc.ugc_import_jobs
  for select
  to authenticated
  using ((select ugc_private.is_workspace_member(ugc_import_jobs.workspace_id)));

revoke all on table saas_ugc.ugc_product_variants from public, anon;
revoke all on table saas_ugc.ugc_import_jobs from public, anon;

grant select, insert, update, delete on table saas_ugc.ugc_product_variants to authenticated;
grant select on table saas_ugc.ugc_import_jobs to authenticated;

-- -----------------------------------------------------------------------------
-- 4) Lecture et mise à jour : RPC d'agrégation.
--
--    Lire un catalogue avec ses variantes demanderait sinon une requête par
--    produit. La fonction renvoie le tout en une payload, filtrée par la loi
--    d'accès de l'entreprise — jamais par un identifiant fourni sans contrôle.
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

  -- La lecture reste ouverte sans abonnement : c'est la promesse du mode
  -- lecture seule. Seul le droit d'appartenance est exigé.
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

comment on function public.vyora_ugc_catalog(uuid) is
  'Catalogue complet d''une entreprise avec ses variantes. Lisible sans abonnement (mode lecture seule), jamais pour une entreprise d''autrui.';

-- Mise à jour d'une variante : exige l'abonnement, en base.
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

  -- Première instruction métier : l'abonnement. Un compte expiré ne modifie
  -- rien, même sa propre variante, même via un appel direct à cette RPC.
  perform saas_business.bg_require_import_access(v_user, now());

  update saas_ugc.ugc_product_variants
     set attribute_value = coalesce(nullif(trim(p_attribute_value), ''), attribute_value),
         sku = coalesce(p_sku, sku),
         price_amount = coalesce(p_price_amount, price_amount),
         price_currency = coalesce(nullif(upper(trim(p_price_currency)), ''), price_currency),
         stock = coalesce(p_stock, stock),
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
    'available', v_ligne.available
  );
end
$function$;

comment on function public.vyora_ugc_variant_update(uuid, text, text, numeric, text, integer) is
  'Met à jour une variante. Exige l''appartenance ET un abonnement actif, vérifiés en base (42501 sinon).';

revoke all on function public.vyora_ugc_catalog(uuid) from public, anon;
revoke all on function public.vyora_ugc_variant_update(uuid, text, text, numeric, text, integer) from public, anon;
grant execute on function public.vyora_ugc_catalog(uuid) to authenticated;
grant execute on function public.vyora_ugc_variant_update(uuid, text, text, numeric, text, integer) to authenticated;

-- -----------------------------------------------------------------------------
-- 5) Expiration : la lecture seule n'efface rien.
--
--    Demande explicite du produit : « ne supprime jamais les produits d'un
--    client à cause de l'expiration de son abonnement ». On ne crée donc aucune
--    tâche de purge liée aux abonnements, et on vérifie ici qu'aucun déclencheur
--    ne supprime de produit sur changement d'abonnement.
-- -----------------------------------------------------------------------------
create or replace function public.vyora_ugc_export(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_catalogue jsonb;
begin
  -- Export = lecture. Il ne dépend donc pas de l'abonnement, seulement de
  -- l'appartenance — un client qui part doit pouvoir repartir avec ses données.
  v_catalogue := public.vyora_ugc_catalog(p_workspace_id);
  return jsonb_build_object(
    'exported_at', now(),
    'workspace_id', p_workspace_id,
    'products', v_catalogue->'products',
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', j.id,
        'source', j.source,
        'reference', j.reference,
        'status', j.status,
        'products_created', j.products_created,
        'products_failed', j.products_failed,
        'variants_created', j.variants_created,
        'failures', j.failures,
        'created_at', j.created_at
      ) order by j.created_at desc)
      from saas_ugc.ugc_import_jobs j
     where j.workspace_id = p_workspace_id
       and (select ugc_private.is_workspace_member(j.workspace_id))
    ), '[]'::jsonb)
  );
end
$function$;

comment on function public.vyora_ugc_export(uuid) is
  'Export complet du catalogue et de l''historique. Disponible sans abonnement : le client reste propriétaire de ses données.';

revoke all on function public.vyora_ugc_export(uuid) from public, anon;
grant execute on function public.vyora_ugc_export(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 6) Contrôles de non-régression, exécutés à l'application.
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_nb integer;
begin
  -- 6a. Les deux tables existent et ont la RLS active.
  select count(*) into v_nb
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'saas_ugc'
     and c.relname in ('ugc_product_variants', 'ugc_import_jobs')
     and c.relrowsecurity;
  if v_nb <> 2 then
    raise exception 'variantes/historique : RLS absente (%).', v_nb;
  end if;

  -- 6b. `ugc_products` n'a pas perdu de colonne : la compatibilité est
  --     vérifiée sur les colonnes, pas supposée.
  select count(*) into v_nb
    from information_schema.columns
   where table_schema = 'saas_ugc' and table_name = 'ugc_products';
  if v_nb < 14 then
    raise exception 'ugc_products a perdu des colonnes (%).', v_nb;
  end if;

  -- 6c. Aucun déclencheur ne supprime de produit : l'expiration ne doit jamais
  --     vider un catalogue. Le contrôle porte sur `ugc_products` uniquement —
  --     les déclencheurs d'immuabilité qui REFUSENT les suppressions sur les
  --     journaux (crédits, consentements) sont légitimes et sans rapport.
  --     Le seul déclencheur légitime sur cette table est `touch_updated_at`
  --     (BEFORE UPDATE). On refuse donc tout déclencheur qui se déclenche sur
  --     DELETE, pas la présence d'un déclencheur en soi.
  select count(*) into v_nb
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal
     and n.nspname = 'saas_ugc'
     and c.relname = 'ugc_products'
     and (t.tgtype & 8) <> 0;  -- 8 = TRIGGER_TYPE_DELETE
  if v_nb > 0 then
    raise exception 'un déclencheur DELETE existe sur ugc_products : interdit (%).', v_nb;
  end if;

  -- 6d. Aucune tâche planifiée ne purge les produits.
  select count(*) into v_nb
    from cron.job
   where command ilike '%ugc_products%' and command ilike '%delete%';
  if v_nb > 0 then
    raise exception 'une tâche planifiée supprime des produits : interdit (%).', v_nb;
  end if;

  -- 6e. Aucun rôle client ne fabrique une ligne d'historique.
  if has_table_privilege('authenticated', 'saas_ugc.ugc_import_jobs', 'insert') then
    raise exception 'authenticated peut écrire l''historique d''import : interdit';
  end if;

  raise notice 'variantes + historique : tables, RLS et RPC en place.';
end
$verif$;
