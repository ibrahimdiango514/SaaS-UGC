-- Import & Connect — fermer la porte PostgREST sur `ugc_products`.
--
-- ## Le défaut que cette migration corrige
-- La garde d'abonnement de la Phase A vivait dans l'Edge Function
-- `store-import` et dans le panneau d'import du navigateur. Mais la table
-- `saas_ugc.ugc_products` restait écrivable directement :
--
--     POST /rest/v1/ugc_products      (jeton du compte, aucune Edge Function)
--     { "workspace_id": "…", "name": "…" }        → 201 Created
--
-- La politique `ugc_products_insert_editor` ne vérifiait que l'appartenance à
-- l'entreprise (`ugc_private.can_edit_workspace`). Or cette fonction ouvre aussi
-- l'**interface** d'import de fichier : le navigateur analysait le CSV puis
-- écrivait les produits par des insert PostgREST successifs. Un compte SANS
-- abonnement pouvait donc créer des produits en appelant directement l'API,
-- alors qu'il était refusé partout ailleurs. C'est le contournement exact que
-- la Phase A devait rendre impossible.
--
-- Mesuré avant correctif (compte A, aucun abonnement) :
--   POST /rest/v1/ugc_products → 201, produit réellement créé.
--
-- ## Ce que fait la migration
-- 1. Elle remplace les politiques INSERT/UPDATE de `ugc_products` par des
--    politiques qui exigent, en plus de l'appartenance, un abonnement
--    Business Ground valide — la même règle que l'Edge Function, via la même
--    fonction (`saas_business.bg_import_access`), pour qu'il n'existe pas deux
--    définitions du droit d'accès qui puissent diverger.
-- 2. Elle n'accorde PAS d'exécution de cette fonction à `authenticated` : elle
--    est appelée à l'intérieur d'une politique, donc avec les droits de son
--    propriétaire (`SECURITY DEFINER`). Un client ne peut donc pas la sonder,
--    ni pour lui ni pour un autre compte.
-- 3. Elle laisse SELECT et DELETE inchangés : consulter son catalogue et en
--    retirer un produit ne sont pas des opérations d'import. Les restreindre
--    empêcherait un utilisateur dont l'abonnement a expiré de gérer ses
--    données existantes, ce qui n'est pas le but.
--
-- ## Ce qu'elle ne fait pas
-- Elle ne touche à aucune donnée, à aucun plan, à aucun abonnement. Elle ne
-- modifie pas `can_edit_workspace` : d'autres modules s'en servent, et son
-- contrat (« puis-je éditer cette entreprise ? ») reste vrai.

set search_path = '';

-- -----------------------------------------------------------------------------
-- 1) La politique d'écriture exige l'abonnement, en plus de l'appartenance.
-- -----------------------------------------------------------------------------
drop policy if exists ugc_products_insert_editor on saas_ugc.ugc_products;
drop policy if exists ugc_products_update_editor on saas_ugc.ugc_products;

create policy ugc_products_insert_subscriber on saas_ugc.ugc_products
  for insert
  to authenticated
  with check (
    (select ugc_private.can_edit_workspace(ugc_products.workspace_id))
    and coalesce(
      (saas_business.bg_import_access((select auth.uid()), now())->>'allowed')::boolean,
      false
    )
  );

create policy ugc_products_update_subscriber on saas_ugc.ugc_products
  for update
  to authenticated
  using (
    (select ugc_private.can_edit_workspace(ugc_products.workspace_id))
  )
  with check (
    (select ugc_private.can_edit_workspace(ugc_products.workspace_id))
    and coalesce(
      (saas_business.bg_import_access((select auth.uid()), now())->>'allowed')::boolean,
      false
    )
  );

comment on policy ugc_products_insert_subscriber on saas_ugc.ugc_products is
  'Création de produit : appartenance à l''entreprise ET abonnement Business Ground actif. Ferme l''écriture PostgREST directe qui contournait l''import.';

comment on policy ugc_products_update_subscriber on saas_ugc.ugc_products is
  'Modification de produit : abonnement exigé au même titre que la création. Un catalogue ne s''enrichit pas sans abonnement, y compris par mise à jour.';

-- -----------------------------------------------------------------------------
-- 2) Aucun rôle client n'exécute la règle directement.
--    Elle n'est utilisée qu'à l'intérieur des politiques ci-dessus.
-- -----------------------------------------------------------------------------
revoke all on function saas_business.bg_import_access(uuid, timestamptz) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3) Contrôles de non-régression, exécutés à l'application de la migration.
-- -----------------------------------------------------------------------------
do $verif$
declare
  v_insert_check text;
  v_insert_abo boolean;
  v_ancienne boolean;
begin
  -- 3a. L'ancienne politique permissive ne doit plus exister.
  select exists (
    select 1 from pg_policies
     where schemaname = 'saas_ugc' and tablename = 'ugc_products'
       and policyname in ('ugc_products_insert_editor', 'ugc_products_update_editor')
  ) into v_ancienne;
  if v_ancienne then
    raise exception 'les anciennes politiques permissives de ugc_products subsistent';
  end if;

  -- 3b. La nouvelle politique doit mentionner la règle d'abonnement.
  select with_check into v_insert_check
    from pg_policies
   where schemaname = 'saas_ugc' and tablename = 'ugc_products'
     and policyname = 'ugc_products_insert_subscriber';
  if v_insert_check is null or v_insert_check not ilike '%bg_import_access%' then
    raise exception 'la politique d''insertion de ugc_products n''exige pas l''abonnement (%).', v_insert_check;
  end if;

  -- 3c. Aucun rôle client ne doit pouvoir exécuter la règle hors politique.
  select exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'saas_business'
       and p.proname = 'bg_import_access'
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
  ) into v_insert_abo;
  if v_insert_abo then
    raise exception 'bg_import_access est exécutable par un rôle client';
  end if;

  raise notice 'ugc_products : écriture soumise à l''abonnement Business Ground.';
end
$verif$;
