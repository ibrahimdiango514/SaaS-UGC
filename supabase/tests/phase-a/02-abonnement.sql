-- Protocole Phase A — abonnement admissible du compte B.
--
-- ## Pourquoi un plan dédié
-- Les trois plans réels (`essentiel`, `croissance`, `scale`) sont tous
-- `active = false` et `billing_enabled = false` : les activer pour tester
-- modifierait l'état commercial réel. On crée donc un plan interne
-- `phasea_test`, identifiable et supprimable, jamais affiché comme achetable
-- (l'interface exige `active` ET un prix > 0 ET `billing_enabled` au niveau
-- catalogue).
--
-- `billing_enabled = true` est nécessaire : `guard_subscription_activation`
-- refuse un abonnement `active`/`trialing` sur un plan non facturable. Ce n'est
-- pas un contournement du garde-fou, c'est la condition que le garde-fou exige.

set search_path = public;

-- 1. Plan interne de test.
insert into saas_business.plans (
  plan_key, display_name, billing_enabled, active, tagline,
  monthly_price_minor, currency, sort_order, features
) values (
  'phasea_test', 'Phase A — plan de test (jamais commercialisé)',
  true, true, 'Plan interne de vérification', 0, 'XOF', 99, '[]'::jsonb
)
on conflict (plan_key) do update
  set active = true, billing_enabled = true;

-- 2. Abonnement admissible du compte B.
insert into saas_business.subscriptions (
  user_id, plan_key, status, billing_provider,
  external_customer_id, external_subscription_id,
  current_period_start, current_period_end, billing_updated_at
)
select
  i.user_id, 'phasea_test', 'active', 'test_phase_a',
  'phasea-test-customer', 'phasea-test-subscription',
  now() - interval '1 day', now() + interval '30 days', now()
from public.phasea_identifiants i
where i.email = 'phasea-b@vyora-test.invalid';

-- 3. Contrôle : les droits des deux comptes doivent désormais différer.
select
  i.email,
  saas_business.bg_import_access(i.user_id, now())->>'allowed' as autorise,
  saas_business.bg_import_access(i.user_id, now())->>'reason' as motif
from public.phasea_identifiants i
order by i.email;

-- ## Variantes à rejouer pour les états du cycle de vie
--
--   -- expiration : la période est échue
--   update saas_business.subscriptions
--      set status = 'expired', current_period_end = now() - interval '1 day'
--    where plan_key = 'phasea_test';
--
--   -- suspension (paiement en retard)
--   update saas_business.subscriptions
--      set status = 'past_due', current_period_end = now() + interval '10 days'
--    where plan_key = 'phasea_test';
--
--   -- résiliation
--   update saas_business.subscriptions
--      set status = 'canceled'
--    where plan_key = 'phasea_test';
--
--   -- rétablissement (pour tester l'accès autorisé complet)
--   update saas_business.subscriptions
--      set status = 'active', current_period_start = now() - interval '1 day',
--          current_period_end = now() + interval '30 days'
--    where plan_key = 'phasea_test';
