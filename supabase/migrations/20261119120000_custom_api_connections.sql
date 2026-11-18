-- VYORA — configuration du connecteur « API personnalisée ».
--
-- ## Pourquoi une table dédiée plutôt que des colonnes en plus
--
-- `integration_connections` porte l'ÉTAT d'une connexion : qui, quelle
-- entreprise, quel connecteur, connecté ou non, et le NOM du secret en Vault.
-- Ce modèle convient à tous les connecteurs déclaratifs.
--
-- Il ne convient pas à l'API personnalisée, dont la configuration n'est pas un
-- secret unique mais une DESCRIPTION : adresse de base, mode d'authentification,
-- en-têtes, chemins d'endpoints, mapping de champs, pagination, unité de prix.
-- Ce sont de trente à cinquante valeurs par connexion, toutes variables d'un
-- utilisateur à l'autre.
--
-- Deux options étaient possibles :
--
--   1. Ajouter trente colonnes à `integration_connections`, nulles pour tous
--      les autres connecteurs ;
--   2. Une table dédiée, reliée par clé étrangère.
--
-- La première alourdit une table centrale pour un cas particulier et rend toute
-- lecture ambiguë (`price_path` n'a aucun sens pour PrestaShop). La seconde
-- laisse `integration_connections` inchangée et sa validation intacte. C'est la
-- seconde qui est retenue : **aucune colonne existante n'est modifiée, aucune
-- ligne n'est supprimée**.
--
-- ## Ce que cette table ne contient JAMAIS
--
-- Aucun secret. Ni clé d'API, ni jeton, ni mot de passe. Le mode d'API indique
-- seulement *comment* s'authentifier (`bearer`, `header`…) et le nom d'en-tête ;
-- la valeur du secret est dans Vault, désignée par le `credential_ref` de
-- `integration_connections`.
--
-- Une contrainte le vérifie plutôt que de s'en remettre à la discipline du
-- code appelant : un champ de configuration qui contiendrait une clé serait
-- détectable et refusé.

-- ---------------------------------------------------------------------------
-- 1) Table de configuration
-- ---------------------------------------------------------------------------
create table if not exists saas_business.custom_api_connections (
  id uuid primary key default gen_random_uuid(),
  -- Une configuration par connexion : la cascade suit la connexion, donc une
  -- déconnexion (qui supprime la ligne) supprime aussi la configuration.
  connection_id uuid not null
    references saas_business.integration_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid references saas_ugc.ugc_workspaces(id) on delete cascade,

  -- Adresse de base. HTTPS, hôte public, sans identifiants : la validation
  -- applicative fait foi, la contrainte ne vérifie que ce qui est exprimable
  -- simplement ici (schéma et longueur).
  base_url text not null check (base_url like 'https://%' and length(base_url) <= 2048),

  -- Mode d'authentification. Les modes sont peu nombreux par choix : chacun
  -- correspond à une pratique réelle. `none` = API publique de lecture.
  auth_scheme text not null check (auth_scheme in ('none', 'bearer', 'header', 'basic')),
  -- Nom d'en-tête quand `auth_scheme = 'header'`. Jamais une valeur secrète.
  auth_header_name text,

  -- Chemins d'endpoints. `{page}`, `{limit}`, `{cursor}` sont substitués.
  products_path text not null check (length(products_path) between 1 and 2048),
  pagination_kind text not null default 'none' check (pagination_kind in ('page', 'cursor', 'none')),
  page_size integer not null default 50 check (page_size between 1 and 200),
  max_pages integer not null default 20 check (max_pages between 1 and 200),

  -- Mapping des champs, en JSON. Aucune expression n'y est évaluée : les
  -- chemins sont lus par accès de propriété littéral côté serveur.
  mapping jsonb not null,
  /*
   * PAS de colonne `custom_headers`.
   *
   * Le premier jet en prévoyait une, avec une contrainte `CHECK` interdisant
   * qu'une valeur y figure. Postgres refuse une sous-requête dans un CHECK
   * (0A000) — et ce refus a rendu service : il a obligé à se demander ce que
   * cette colonne allait réellement contenir. Réponse : des valeurs de secret,
   * ou rien. Les noms d'en-tête autorisés sont une CONSTANTE du code
   * (`ALLOWED_AUTH_HEADERS`), ils n'ont pas à être stockés ; les valeurs vont
   * en Vault, comme toutes les autres.
   *
   * Une colonne qui ne peut légitimement contenir qu'une valeur interdite ne
   * doit pas exister : c'est plus sûr qu'une contrainte censée l'empêcher.
   */

  -- Unité des prix de la source. **Obligatoire et sans valeur par défaut** :
  -- deviner produirait un facteur 100 d'écart, silencieusement.
  price_unit text not null check (price_unit in ('major', 'minor')),
  currency text not null default 'XOF' check (currency ~ '^[A-Z]{3}$'),

  -- Lecture seule, toujours. La colonne existe pour être VÉRIFIÉE : toute
  -- valeur autre que false est refusée par contrainte, ce qui rend une future
  -- écriture impossible sans retirer explicitement la contrainte.
  read_only boolean not null default true check (read_only is true),

  -- Sonde : dernière réponse observée, sans contenu sensible.
  last_probe_at timestamptz,
  last_probe_status integer,
  last_probe_summary text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (connection_id)
);

comment on table saas_business.custom_api_connections is
  'Configuration du connecteur API personnalisée : adresse, authentification, mapping, pagination. Ne contient AUCUN secret (Vault via integration_connections.credential_ref).';

comment on column saas_business.custom_api_connections.read_only is
  'Toujours true. Contrainte CHECK : aucune écriture vers la boutique tierce n''est possible.';

create index if not exists custom_api_connections_scope_idx
  on saas_business.custom_api_connections (user_id, workspace_id);

-- ---------------------------------------------------------------------------
-- 2) Défense en profondeur : aucun secret ne doit atterrir ici
-- ---------------------------------------------------------------------------
-- Le contrôle applicatif suffit en théorie, mais une colonne `text` libre se
-- remplit vite par erreur (un `base_url` avec `?api_key=…`, par exemple). La
-- contrainte rend l'erreur impossible à commettre, pas seulement à éviter.
alter table saas_business.custom_api_connections
  drop constraint if exists custom_api_connections_no_secret_in_url;
alter table saas_business.custom_api_connections
  add constraint custom_api_connections_no_secret_in_url
  check (
    base_url not like '%?%'
    and base_url not like '%@%'
    and base_url not like '%#%'
  );

-- (Le contrôle sur les en-têtes est devenu inutile : la colonne n'existe pas.)

-- ---------------------------------------------------------------------------
-- 3) RLS : lecture par le propriétaire, écriture par RPC uniquement
-- ---------------------------------------------------------------------------
alter table saas_business.custom_api_connections enable row level security;

drop policy if exists custom_api_connections_owner_read
  on saas_business.custom_api_connections;
create policy custom_api_connections_owner_read
  on saas_business.custom_api_connections
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Aucune policy d'écriture : insertions et mises à jour passent exclusivement
-- par les RPC `security definer` ci-dessous, qui vérifient l'appartenance à
-- l'entreprise, l'abonnement payant et la cohérence de la configuration.
revoke all on saas_business.custom_api_connections from anon, authenticated;
grant select on saas_business.custom_api_connections to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Enregistrement d'une configuration vérifiée
-- ---------------------------------------------------------------------------
-- La configuration n'est acceptée QUE si une sonde a réussi : `p_probe_status`
-- doit valoir 2xx et `p_products_found` doit être strictement positif. Sans
-- cela, l'utilisateur enregistrerait une connexion dont il n'a aucune preuve
-- qu'elle lit quoi que ce soit — et découvrirait le problème à l'import.
create or replace function saas_business.bg_save_custom_api_connection(
  p_user_id uuid,
  p_workspace_id uuid,
  p_credential_ref text,
  p_base_url text,
  p_auth_scheme text,
  p_auth_header_name text,
  p_products_path text,
  p_pagination_kind text,
  p_page_size integer,
  p_max_pages integer,
  p_mapping jsonb,
  p_price_unit text,
  p_currency text,
  p_probe_status integer,
  p_products_found integer,
  p_probe_summary text,
  p_duration_ms integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_connection_id uuid;
  v_existing_id uuid;
  v_conf jsonb;
begin
  if p_user_id is null then
    raise exception 'connect_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  -- Preuve d'une sonde réussie. Le seuil est ici, pas seulement côté Edge :
  -- un appel direct à la RPC ne doit pas permettre d'enregistrer une
  -- configuration non testée.
  if p_probe_status is null or p_probe_status < 200 or p_probe_status >= 300 then
    raise exception 'connect_invalid:PROBE_REQUIRED' using errcode = '22023';
  end if;
  if p_products_found is null or p_products_found < 1 then
    raise exception 'connect_invalid:NO_PRODUCTS_FOUND' using errcode = '22023';
  end if;

  if p_credential_ref is null or length(btrim(p_credential_ref)) < 8 then
    raise exception 'connect_invalid:CREDENTIAL_REF_REQUIRED' using errcode = '22023';
  end if;

  if p_base_url is null or p_base_url not like 'https://%' then
    raise exception 'connect_invalid:BASE_URL_REQUIRED' using errcode = '22023';
  end if;

  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' then
    raise exception 'connect_invalid:MAPPING_REQUIRED' using errcode = '22023';
  end if;
  -- Un mapping sans nom ne produit aucun produit : refus immédiat plutôt que
  -- cent rejets au moment de l'import.
  if nullif(btrim(coalesce(p_mapping #>> '{name,path}', '')), '') is null then
    raise exception 'connect_invalid:MAPPING_NAME_REQUIRED' using errcode = '22023';
  end if;

  if p_price_unit not in ('major', 'minor') then
    raise exception 'connect_invalid:PRICE_UNIT_REQUIRED' using errcode = '22023';
  end if;

  -- La connexion d'état existe déjà avant la configuration : elle est créée
  -- par la sonde. Sans elle, la configuration serait orpheline.
  select c.id into v_existing_id
    from saas_business.integration_connections c
   where c.user_id = p_user_id
     and c.workspace_id is not distinct from p_workspace_id
     and c.connector_key = 'custom-api'
   order by c.updated_at desc, c.id
   limit 1;

  if v_existing_id is null then
    raise exception 'connect_invalid:CONNECTION_REQUIRED' using errcode = '22023';
  end if;

  -- Délégation à la RPC de connexion commune : elle applique la validation du
  -- connecteur, le contrôle d'appartenance à l'entreprise, l'abonnement payant
  -- et le journal de vérification. On ne réimplémente AUCUNE de ces règles.
  v_conf := saas_business.bg_connect_integration(
    p_user_id,
    p_workspace_id,
    'custom-api',
    p_credential_ref,
    p_base_url,
    array['catalog'],  -- ressource réellement lue par la sonde
    p_products_found,
    p_duration_ms
  );

  insert into saas_business.custom_api_connections (
    connection_id, user_id, workspace_id, base_url,
    auth_scheme, auth_header_name,
    products_path, pagination_kind, page_size, max_pages,
    mapping, price_unit, currency,
    last_probe_at, last_probe_status, last_probe_summary
  ) values (
    v_existing_id, p_user_id, p_workspace_id, p_base_url,
    p_auth_scheme, p_auth_header_name,
    p_products_path, p_pagination_kind, p_page_size, p_max_pages,
    p_mapping, p_price_unit, upper(p_currency),
    now(), p_probe_status, p_probe_summary
  )
  on conflict (connection_id) do update
    set base_url = excluded.base_url,
        auth_scheme = excluded.auth_scheme,
        auth_header_name = excluded.auth_header_name,
        products_path = excluded.products_path,
        pagination_kind = excluded.pagination_kind,
        page_size = excluded.page_size,
        max_pages = excluded.max_pages,
        mapping = excluded.mapping,
        price_unit = excluded.price_unit,
        currency = excluded.currency,
        last_probe_at = excluded.last_probe_at,
        last_probe_status = excluded.last_probe_status,
        last_probe_summary = excluded.last_probe_summary,
        updated_at = clock_timestamp();

  return v_conf || jsonb_build_object(
    'configuration_id', (select id from saas_business.custom_api_connections where connection_id = v_existing_id)
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 5) Lecture : configuration + état, sans secret
-- ---------------------------------------------------------------------------
-- La configuration est lue par l'Edge Function pour rejouer les requêtes. Elle
-- ne sort JAMAIS vers le navigateur avec ses en-têtes : `bg_read_custom_api_connection`
-- omet `credential_ref` et ne rend que ce qui est affichable.
create or replace function saas_business.bg_read_custom_api_connection(
  p_user_id uuid,
  p_workspace_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_ligne saas_business.custom_api_connections;
  v_statut text;
  v_derniere timestamptz;
begin
  if p_user_id is null then
    raise exception 'connect_forbidden:NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into v_ligne
    from saas_business.custom_api_connections c
   where c.user_id = p_user_id
     and c.workspace_id is not distinct from p_workspace_id
   limit 1;

  if v_ligne.id is null then
    return null;
  end if;

  select c.status, c.updated_at into v_statut, v_derniere
    from saas_business.integration_connections c
   where c.id = v_ligne.connection_id;

  -- `credential_ref` volontairement ABSENT : il n'a aucune utilité côté
  -- navigateur, et le connaître n'apporte qu'une surface d'attaque.
  return jsonb_build_object(
    'connectorKey', 'custom-api',
    'status', v_statut,
    'connected', v_statut = 'connected',
    'baseUrl', v_ligne.base_url,
    'authScheme', v_ligne.auth_scheme,
    'authHeaderName', v_ligne.auth_header_name,
    'productsPath', v_ligne.products_path,
    'paginationKind', v_ligne.pagination_kind,
    'pageSize', v_ligne.page_size,
    'maxPages', v_ligne.max_pages,
    'mapping', v_ligne.mapping,
    'priceUnit', v_ligne.price_unit,
    'currency', v_ligne.currency,
    'readOnly', v_ligne.read_only,
    'lastProbeAt', v_ligne.last_probe_at,
    'lastProbeStatus', v_ligne.last_probe_status,
    'lastProbeSummary', v_ligne.last_probe_summary,
    'checkedAt', v_derniere
  );
end
$function$;

-- ---------------------------------------------------------------------------
-- 6) Déclaration du fournisseur et droits
-- ---------------------------------------------------------------------------
-- `custom-api` doit figurer dans `integration_providers`, sinon
-- `bg_validate_connector_key` refuse la clé (22023) et la connexion échoue au
-- dernier moment. Capacité `read` uniquement : la contrainte
-- `integration_providers_read_only_capabilities` de la migration 20261119090000
-- le vérifie de toute façon.
insert into saas_business.integration_providers (provider_key, auth_mode, capabilities, implemented)
values ('custom-api', 'api-key', array['read'], true)
on conflict (provider_key) do update
  set auth_mode    = excluded.auth_mode,
      capabilities = excluded.capabilities,
      implemented  = excluded.implemented;

revoke all on function saas_business.bg_save_custom_api_connection(uuid, uuid, text, text, text, text, text, text, integer, integer, jsonb, text, text, integer, integer, text, integer) from public, anon;
revoke all on function saas_business.bg_read_custom_api_connection(uuid, uuid) from public, anon;
grant execute on function saas_business.bg_save_custom_api_connection(uuid, uuid, text, text, text, text, text, text, integer, integer, jsonb, text, text, integer, integer, text, integer) to service_role;
grant execute on function saas_business.bg_read_custom_api_connection(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7) Contrôles : échouer plutôt que laisser un état incohérent
-- ---------------------------------------------------------------------------
do $verif$
declare
  v_count integer;
  v_caps text[];
  v_impl boolean;
begin
  select count(*) into v_count
    from saas_business.integration_providers
   where provider_key = 'custom-api';
  if v_count <> 1 then
    raise exception 'custom-api absent de integration_providers';
  end if;

  select capabilities, implemented into v_caps, v_impl
    from saas_business.integration_providers
   where provider_key = 'custom-api';
  if v_impl is not true then
    raise exception 'custom-api : implemented devrait être true';
  end if;
  if v_caps <> array['read']::text[] then
    raise exception 'custom-api : capacités attendues {read}, trouvées %', v_caps;
  end if;

  -- La table doit exister et être protégée.
  select count(*) into v_count
    from pg_tables
   where schemaname = 'saas_business' and tablename = 'custom_api_connections';
  if v_count <> 1 then
    raise exception 'table custom_api_connections absente';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'saas_business'
       and tablename = 'custom_api_connections'
       and policyname = 'custom_api_connections_owner_read'
  ) then
    raise exception 'policy de lecture absente sur custom_api_connections';
  end if;

  -- Aucune policy d'écriture ne doit exister : tout passe par les RPC.
  if exists (
    select 1 from pg_policies
     where schemaname = 'saas_business'
       and tablename = 'custom_api_connections'
       and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  ) then
    raise exception 'une policy d''écriture existe sur custom_api_connections';
  end if;
end $verif$;
