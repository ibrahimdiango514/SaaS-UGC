-- =============================================================================
-- Nettoyage du protocole d'import de fichier.
--
-- Ne supprime QUE ce que `00-protocole-verification.sql` a créé. Aucune donnée
-- réelle n'est touchée : les filtres portent sur des marqueurs explicites
-- (domaine `@vyora-test.invalid`, plan `import_test`, entreprises
-- « Import test import-… »).
--
-- À exécuter dans cet ordre : les produits d'abord (ils référencent
-- l'entreprise), puis l'entreprise, puis les comptes.
-- =============================================================================

-- 1) Produits créés par les essais, dans les entreprises de test uniquement.
delete from saas_ugc.ugc_products
 where workspace_id in (
   select id from saas_ugc.ugc_workspaces where name like 'Import test import-%'
 );

-- 2) Aperçus en attente.
delete from saas_ugc.ugc_import_previews
 where workspace_id in (
   select id from saas_ugc.ugc_workspaces where name like 'Import test import-%'
 );

-- 3) Adhésions puis entreprises.
delete from saas_ugc.ugc_workspace_members
 where workspace_id in (
   select id from saas_ugc.ugc_workspaces where name like 'Import test import-%'
 );

delete from saas_ugc.ugc_workspaces where name like 'Import test import-%';

-- 4) Abonnements et plan internes.
delete from saas_business.subscriptions where plan_key = 'import_test';
delete from saas_business.plans where plan_key = 'import_test';

-- 5) Identités puis comptes.
delete from auth.identities
 where user_id in (select id from auth.users where email like 'import-%@vyora-test.invalid');

delete from auth.users where email like 'import-%@vyora-test.invalid';

-- 6) Tables de travail du protocole.
drop table if exists public.import_essais;
drop table if exists public.import_jetons;
drop table if exists public.import_fichiers;
drop table if exists public.import_identifiants;

-- 7) Contrôle final : tout doit être à zéro.
select 'comptes import-*' as objet, count(*)::text as restant
  from auth.users where email like 'import-%@vyora-test.invalid'
union all
select 'espaces import test', count(*)::text
  from saas_ugc.ugc_workspaces where name like 'Import test import-%'
union all
select 'abonnements import_test', count(*)::text
  from saas_business.subscriptions where plan_key = 'import_test'
union all
select 'plan import_test', count(*)::text
  from saas_business.plans where plan_key = 'import_test'
union all
select 'produits', count(*)::text from saas_ugc.ugc_products
union all
select 'aperçus', count(*)::text from saas_ugc.ugc_import_previews;
