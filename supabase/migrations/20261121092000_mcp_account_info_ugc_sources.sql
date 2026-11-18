-- ============================================================================
-- VYORA — `mcp_account_info` : les BONNES sources (correction de la 1re passe)
-- ============================================================================
--
-- ## Ce que la première passe a raté
--
-- En appliquant `20261121091000`, deux erreurs ont été trouvées en
-- interrogeant la base de production :
--
-- 1. **Mauvaises tables d'abonnement.** `saas_business.subscriptions` est
--    VIDE (0 ligne) : elle appartient à « Business Ground », un autre produit
--    du même projet Supabase. Les abonnements VYORA vivent dans
--    `saas_ugc.ugc_subscriptions` (4 lignes). Un client MCP recevait donc
--    `subscription: null` pour tout le monde — exactement le « null » qu'on
--    cherchait à supprimer.
--
-- 2. **Statut « cancelled » ignoré.** Les statuts réels sont
--    `active` et `cancelled` (orthographe britannique). Le filtre et le tri
--    n'énuméraient que `canceled` (américain) : un abonnement résilié était
--    invisible et le compte paraissait n'avoir jamais été abonné.
--
-- ## Sources retenues, chacune vérifiée en production
--
--   abonnement → `saas_ugc.ugc_subscriptions`  (table)
--   plan       → `saas_ugc.ugc_plans`          (table)
--   crédits    → `saas_business.wallets`       (table ; VYORA y écrit
--                `monthly_allowance`, `period_used`, `available_units`)
--
-- `public.ugc_wallets` et `public.reelora_subscriptions` sont des VUES sur ces
-- mêmes tables : les lire directement évite de dépendre d'un alias qui peut
-- être redéfini.
--
-- ## Compatibilité
--
-- Même signature, même type de retour : `create or replace`, pas de `42P13`.
-- La clé `credits` garde la même forme (`available_units`, `reserved_units`,
-- `monthly_allowance`, `period_used`, `remaining_units`). Seule la provenance
-- du plan change, et `plan` cesse d'être toujours `null`.
-- ============================================================================

create or replace function public.mcp_account_info(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'pg_catalog', 'public', 'saas_business', 'saas_ugc'
as $function$
declare
  v_sub      saas_ugc.ugc_subscriptions%rowtype;
  v_plan     saas_ugc.ugc_plans%rowtype;
  v_wallet   saas_business.wallets%rowtype;
  v_a_plan   boolean := false;
  v_a_wallet boolean := false;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  /*
   * Une seule ligne, celle qui décrit le mieux la situation : un abonnement
   * réellement en cours d'abord, un essai ensuite, le reste après. Les deux
   * orthographes de « résilié » sont acceptées (`cancelled` est celle qui
   * existe en base, `canceled` est gardée par prudence si une reprise de
   * données en introduit un jour).
   */
  select s.* into v_sub
    from saas_ugc.ugc_subscriptions s
   where s.user_id = p_user_id
     and s.status in ('active', 'trialing', 'past_due', 'expired', 'canceled', 'cancelled')
   order by
     case
       when s.status = 'active' then 0
       when s.status = 'trialing' then 1
       else 2
     end,
     s.current_period_end desc nulls last,
     s.created_at desc
   limit 1;

  if found then
    select p.* into v_plan from saas_ugc.ugc_plans p where p.plan_key = v_sub.plan_key;
    v_a_plan := found;
  end if;

  select w.* into v_wallet from saas_business.wallets w where w.user_id = p_user_id;
  v_a_wallet := found;

  return jsonb_build_object(
    'user_id', p_user_id,

    'member_since', (
      select a.created_at from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id
    ),

    'workspaces', coalesce((
      select jsonb_agg(
               jsonb_build_object('workspace_id', m.workspace_id, 'role', m.member_role, 'since', m.created_at)
               order by m.created_at
             )
        from saas_ugc.ugc_workspace_members m
       where m.user_id = p_user_id
    ), '[]'::jsonb),

    /*
     * `active` est calculé, jamais recopié : un statut `active` dont la période
     * est échue n'ouvre aucun droit. Le client MCP reçoit donc une réponse qui
     * ne peut pas le tromper sur l'état réel de l'abonnement.
     */
    'subscription', case when v_sub.user_id is null then null else jsonb_build_object(
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_start', v_sub.current_period_start,
      'current_period_end', v_sub.current_period_end,
      'active', (
        v_sub.status in ('active', 'trialing')
        and v_sub.current_period_end is not null
        and v_sub.current_period_end > now()
      ),
      'checked_at', now()
    ) end,

    'plan', case when v_a_plan then jsonb_build_object(
      'plan_key', v_plan.plan_key,
      'display_name', v_plan.display_name,
      'tagline', v_plan.tagline,
      'monthly_credits', v_plan.monthly_credits,
      'monthly_price_minor', v_plan.monthly_price_minor,
      'currency', v_plan.currency,
      'active', v_plan.active
    ) else null end,

    'credits', case when v_a_wallet then jsonb_build_object(
      'available_units', v_wallet.available_units,
      'reserved_units', v_wallet.reserved_units,
      'monthly_allowance', v_wallet.monthly_allowance,
      'period_used', v_wallet.period_used,
      'period_key', v_wallet.period_key,
      'remaining_units', greatest(coalesce(v_wallet.monthly_allowance, 0) - coalesce(v_wallet.period_used, 0), 0),
      'unit', 'credit',
      'source', 'saas_business.wallets',
      'checked_at', now()
    ) else null end
  );
end;
$function$;

revoke all on function public.mcp_account_info(uuid) from public, anon, authenticated;
grant execute on function public.mcp_account_info(uuid) to service_role;
