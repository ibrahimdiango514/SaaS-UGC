-- =============================================================================
-- VYORA AI CORE — accès registre pour le moteur central (20261115110000)
--
-- Une seule lecture JSON compacte du registre multi-fournisseurs pour le
-- moteur IA central (Edge functions) : fournisseurs, modèles (coûts, capacités,
-- niveaux, limites), rôles avec leurs capacités requises, règles de routage,
-- budgets et dépense du mois.
--
-- Sécurité (partitions du dépôt, vérifiées par le banc d'audit) :
--   * saas_business.bg_ai_registry_snapshot() — fonction INTERNE : SECURITY
--     DEFINER, AUCUN destinataire EXECUTE (ni client, ni service_role) ; elle
--     n'est appelée que par la façade public ci-dessous (propriétaire postgres).
--   * public.vyora_ai_registry_snapshot() — surface SERVEUR : réservée au
--     service_role (le moteur central s'authentifie avec la clé de service).
--     Le moteur ne reçoit AUCUN secret : seuls les fournisseurs/modèles
--     apparaissent, la configuration (clés) reste dans les secrets Edge.
-- =============================================================================

create or replace function saas_business.bg_ai_registry_snapshot()
returns jsonb
language sql
security definer stable
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
          'aggregator', is_aggregator
        ) order by provider_key
      ), '[]'::jsonb)
      from ai_providers
      where enabled
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

-- Fonction interne : aucun destinataire EXECUTE (aucun rôle client, ni
-- service_role direct) ; seule la façade public ci-dessous l'invoque.
revoke all on function saas_business.bg_ai_registry_snapshot()
  from public, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

-- Façade serveur : le moteur central (Edge) la lit avec la clé de service.
create or replace function public.vyora_ai_registry_snapshot()
returns jsonb
language sql
security definer stable
set search_path = pg_catalog, saas_business
as $$
  select saas_business.bg_ai_registry_snapshot()
$$;

revoke all on function public.vyora_ai_registry_snapshot()
  from public, anon, authenticated, bg_edge, bg_billing_worker, bg_erasure;
grant execute on function public.vyora_ai_registry_snapshot() to service_role;
