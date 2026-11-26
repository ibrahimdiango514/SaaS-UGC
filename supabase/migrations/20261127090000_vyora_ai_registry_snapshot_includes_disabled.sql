-- SORAHNEX — le snapshot du registre IA inclut les fournisseurs DÉSACTIVÉS.
--
-- ## Le défaut corrigé
-- `vyora_ai_registry_snapshot()` filtrait `where enabled` sur `ai_providers`.
-- Un fournisseur désactivé — exactement l'état de FreeLLMAPI quand sa sonde
-- échoue (`vyora_ai_record_probe` met `enabled = false` dès qu'une complétion
-- n'est pas validée) — devenait donc INVISIBLE du diagnostic.
--
-- Conséquence constatée : l'écran Admin affichait « registre indisponible »
-- alors que le registre était parfaitement lisible, et l'administrateur ne
-- pouvait pas savoir que la cause était une désactivation. Le moteur, lui,
-- continuait de refuser de servir ce fournisseur, sans que rien ne l'explique.
--
-- ## Pourquoi l'inclusion est sans risque pour le routage
-- Le routeur ne choisit ses candidats que parmi les modèles VÉRIFIÉS
-- (`router.ts` : `filtered.filter((c) => c.model.verified)`) et exige une clé
-- résolue. Un fournisseur désactivé n'a, par construction, aucun modèle vérifié
-- (`vyora_ai_record_probe` n'insère le modèle vérifié que si
-- `completion_ok is true`, et c'est la même condition qui met `enabled = true`).
-- L'inclure dans le snapshot n'ajoute donc AUCUN candidat : cela rend
-- seulement son état lisible.
--
-- ## Ce que la migration fait
-- Redéfinit `saas_business.bg_ai_registry_snapshot()` (la fonction interne qui
-- alimente la façade serveur `public.vyora_ai_registry_snapshot()`) :
-- 1. ajoute aux fournisseurs les champs d'état utiles au diagnostic :
--    `enabled`, `error_code`, `checked_at`, `base_url_env` ;
--    aucune URL n'est exposée, seule la variable qui la porte est nommée ;
-- 2. cesse de filtrer `where enabled` sur les fournisseurs.
--
-- ADDITIVE : aucun objet supprimé, aucune ligne modifiée, `create or replace`
-- de la même fonction, mêmes droits (service_role uniquement).

create or replace function saas_business.bg_ai_registry_snapshot()
returns jsonb
language sql security definer stable
set search_path = pg_catalog, saas_business
as $$
  select jsonb_build_object(
    'version', 2,
    'generated_at', now(),
    'providers', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', provider_key,
          'name', display_name,
          'status', status,
          'aggregator', is_aggregator,
          -- État de diagnostic : un fournisseur désactivé reste LISIBLE.
          'enabled', enabled,
          'error_code', error_code,
          'checked_at', checked_at,
          -- Nom de la variable portant l'URL, jamais sa valeur.
          'base_url_env', base_url_env,
          -- URL par défaut du registre : sert au diagnostic de FORME
          -- (publique / locale / privée). Elle ne contient aucun secret.
          'default_base_url', default_base_url
        ) order by provider_key
      ), '[]'::jsonb)
      from ai_providers
    ),
    'models', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'provider', m.provider_key,
          'key', m.model_key,
          'provider_model', m.provider_model_key,
          'name', m.display_name,
          'verified', (m.verification_status = 'verified'),
          'tier', m.tier,
          'capabilities', m.capabilities,
          'context_in', m.max_input_tokens,
          'max_out', m.max_output_tokens,
          'cost_in', m.cost_input_per_mtok_usd,
          'cost_out', m.cost_output_per_mtok_usd,
          'rpm', m.announced_rpm,
          'tpm', m.announced_tpm
        ) order by m.provider_key, m.model_key
      ), '[]'::jsonb)
      from ai_models m
      where m.enabled
    ),
    'roles', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'key', r.role_key,
          'capabilities', r.required_capabilities,
          'enabled', r.enabled
        ) order by r.role_key
      ), '[]'::jsonb)
      from ai_roles r
    ),
    'rules', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'role', r.role_key,
          'provider', r.provider_key,
          'model', r.model_key,
          'priority', r.priority
        ) order by r.role_key, r.priority, r.provider_key
      ), '[]'::jsonb)
      from ai_routing_rules r
      where r.enabled
    ),
    'budget', (
      select coalesce(
        jsonb_build_object(
          'monthly', monthly_budget_usd,
          'alert', alert_threshold_pct,
          'daily', max_daily_cost_usd
        ),
        '{}'::jsonb
      )
      from ai_admin_settings
      where key = 'global'
    ),
    'monthly_spend_usd', (
      select coalesce(sum(coalesce(cost_input_usd, 0) + coalesce(cost_output_usd, 0)), 0)
      from ai_calls_log
      where created_at >= date_trunc('month', now())
    )
  );
$$;

comment on function saas_business.bg_ai_registry_snapshot() is
  'Instantané du registre IA pour la façade serveur. Inclut les fournisseurs désactivés pour que le diagnostic puisse nommer la cause ; le routage ne retient que les modèles vérifiés.';

-- Droits INCHANGÉS : fonction interne, aucun destinataire EXECUTE.
revoke all on function saas_business.bg_ai_registry_snapshot()
  from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
