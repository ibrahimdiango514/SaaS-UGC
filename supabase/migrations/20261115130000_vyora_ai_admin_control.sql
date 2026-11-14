-- =============================================================================
-- VYORA AI CORE — contrôle admin (20261115130000)
--
-- Deux façades d'ADMINISTRATION pour l'interface « Contrôle IA » (admin) :
--   * public.vyora_ai_admin_registry_get()   — snapshot du registre
--     (fournisseurs, modèles vérifiés, rôles, règles, budgets, dépense du mois),
--     servi à l'administrateur vérifié (jamais au client, jamais à service_role).
--   * public.vyora_ai_admin_calls_list(limit) — journal des appels IA récents
--     (ai_calls_log) : provider/modèle, statut, jetons, coût, latence.
--
-- Sécurité (pattern des réglages IA, migration 20261115100000) :
--   * EXECUTE réservé à `authenticated` ; la VÉRIFICATION du rôle admin est
--     faite À L'INTÉRIEUR (saas_ugc.ugc_is_admin()), pas par le grant.
--   * Le snapshot interne saas_business.bg_ai_registry_snapshot() conserve
--     AUCUN destinataire EXECUTE : seul le propriétaire (postgres), via ces
--     façades SECURITY DEFINER, peut l'invoquer.
--   * Aucune donnée client n'est exposée hors du périmètre d'administration :
--     pas d'identifiants utilisateur dans le journal (espace + fournisseur
--     + modèle + statut + coût seulement).
-- =============================================================================

create or replace function public.vyora_ai_admin_registry_get()
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, saas_business
as $$
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  return saas_business.bg_ai_registry_snapshot();
end $$;

revoke all on function public.vyora_ai_admin_registry_get() from public, anon;
grant execute on function public.vyora_ai_admin_registry_get() to authenticated;

create or replace function public.vyora_ai_admin_calls_list(p_limit integer default 50)
returns jsonb
language plpgsql security definer stable
set search_path = pg_catalog, saas_business
as $$
declare
  v_limit integer;
begin
  if not saas_ugc.ugc_is_admin() then raise exception 'admin required'; end if;
  v_limit := coalesce(nullif(p_limit, 0), 50);
  if v_limit < 1 or v_limit > 200 then v_limit := 50; end if;
  return (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'space', l.space,
        'task_key', l.task_key,
        'provider', l.provider_key,
        'model', l.model_key,
        'provider_model', l.provider_model_key,
        'attempt', l.attempt_number,
        'status', l.status,
        'error_code', l.error_code,
        'input_tokens', l.input_tokens,
        'output_tokens', l.output_tokens,
        'latency_ms', l.latency_ms,
        'cost_usd', coalesce(l.cost_input_usd, 0) + coalesce(l.cost_output_usd, 0),
        'fallback_from', l.fallback_from,
        'created_at', l.created_at
      ) order by l.created_at desc, l.id desc
    ), '[]'::jsonb)
    from (
      select id, space, task_key, provider_key, model_key, provider_model_key,
             attempt_number, status, error_code, input_tokens, output_tokens,
             latency_ms, cost_input_usd, cost_output_usd, fallback_from, created_at
      from ai_calls_log
      order by created_at desc, id desc
      limit v_limit
    ) l
  );
end $$;

revoke all on function public.vyora_ai_admin_calls_list(integer) from public, anon;
grant execute on function public.vyora_ai_admin_calls_list(integer) to authenticated;
