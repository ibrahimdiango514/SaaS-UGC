-- Nettoyage du protocole Phase A — supprime TOUT ce qui a été créé pour la vérification.
--
-- ## Ce que ce fichier supprime
--  * comptes de test `*@vyora-test.invalid` et leurs identités/sessions ;
--  * abonnement de test (plan `phasea_test`) et le plan lui-même ;
--  * entreprise de test et ses éventuels produits/connexions ;
--  * table de travail `phasea_identifiants` (jetons de test inclus) ;
--  * fonction d'orchestration `phasea_orchestrer` ;
--  * réponses `pg_net` générées par la vérification.
--
-- ## Ce qu'il ne touche PAS
-- Aucun compte réel, aucun abonnement client, aucun plan commercial : les
-- trois plans réels n'ont jamais été modifiés (ils étaient et restent
-- `active = false`, `billing_enabled = false`).

set search_path = public;

-- 1. Abonnement et entreprise de test.
delete from saas_business.subscriptions s
 using public.phasea_identifiants i
 where s.user_id = i.user_id;

delete from saas_ugc.ugc_workspaces w
 using public.phasea_identifiants i
 where w.owner_user_id = i.user_id and w.name = 'Phase A — entreprise de test';

delete from saas_business.plans where plan_key = 'phasea_test';

-- 2. Fonction d'orchestration.
drop function if exists public.phasea_orchestrer(text);

-- 3. Comptes de test (cascade sur les sessions et identités).
do $$
declare r record;
begin
  for r in select user_id from public.phasea_identifiants loop
    delete from auth.users where id = r.user_id;
  end loop;
end $$;

-- 4. Table de travail.
drop table if exists public.phasea_identifiants;

-- 5. Traces réseau de la vérification.
delete from net._http_response where id >= 11790;

-- 6. Contrôle final : plus rien de test, et rien de réel abîmé.
select
  (select count(*) from auth.users) as comptes_auth,
  (select count(*) from auth.users where email like '%@vyora-test.invalid') as comptes_test,
  (select count(*) from saas_business.subscriptions) as abonnements,
  (select count(*) from saas_business.plans where active) as plans_actifs,
  (select count(*) from saas_business.plans) as plans_total,
  (select count(*) from saas_ugc.ugc_workspaces) as entreprises,
  (select count(*) from saas_ugc.ugc_products) as produits,
  (select count(*) from to_regclass('public.phasea_identifiants')::text
     where to_regclass('public.phasea_identifiants') is not null) as table_test_restante;
