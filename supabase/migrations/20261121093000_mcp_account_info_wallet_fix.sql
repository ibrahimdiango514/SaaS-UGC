-- ============================================================================
-- VYORA — `mcp_account_info` : le portefeuille VYORA, pas celui de Business Grow
-- ============================================================================
--
-- ## Troisième correction, et la bonne
--
-- Les deux passes précédentes ont été appliquées puis vérifiées sur les données
-- réelles. La seconde lisait `saas_business.wallets` : des chiffres cohérents...
-- mais ceux d'un AUTRE solde. Le dépôt tranche sans ambiguïté :
--
--   - `saas_ugc.ugc_wallets.available_balance` est le solde du client VYORA :
--     c'est ce que `ugc_private.apply_wallet_delta` débite et crédite, ce que
--     l'écran admin agrège en `credits_available` / `credits_charged`, et ce que
--     renvoie `saas_ugc.ugc_admin_overview` ;
--   - `saas_business.wallets` porte l'allocation mensuelle de Business Grow
--     (produit distinct du même projet Supabase).
--
-- Annoncer 50 crédits à un utilisateur qui en possède 5 est exactement le genre
-- d'erreur que la consigne « uniquement depuis des sources fiables » interdit.
-- Un utilisateur avait 5 en portefeuille VYORA et 37 dans l'autre table : les
-- deux chiffres divergent réellement, ce n'est pas un détail de nommage.
--
-- ## Ce que la fonction expose désormais
--
--   credits.available_units  ← `saas_ugc.ugc_wallets.available_balance`
--   credits.reserved_units   ← `reserved_balance`
--   credits.lifetime_purchased / lifetime_bonus
--   credits.remaining_units  = available_units (les deux noms sont conservés
--                              pour ne pas casser un client déjà branché)
--
-- Aucune unité n'est inventée : `null` quand le portefeuille n'existe pas.
--
-- Même signature, même type de retour : `create or replace`, pas de `42P13`.
-- ============================================================================

create or replace function public.mcp_account_info(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'pg_catalog', 'public', 'saas_business', 'saas_ugc'
as $function$
declare
  v_sub    saas_ugc.ugc_subscriptions%rowtype;
  v_plan   saas_ugc.ugc_plans%rowtype;
  v_wallet saas_ugc.ugc_wallets%rowtype;
  v_a_plan boolean := false;
  v_a_wallet boolean := false;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

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

  select w.* into v_wallet from saas_ugc.ugc_wallets w where w.user_id = p_user_id;
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
      'available_units', v_wallet.available_balance,
      'remaining_units', v_wallet.available_balance,
      'reserved_units', v_wallet.reserved_balance,
      'lifetime_purchased', v_wallet.lifetime_purchased,
      'lifetime_bonus', v_wallet.lifetime_bonus,
      'unit', 'credit',
      'source', 'saas_ugc.ugc_wallets',
      'checked_at', now()
    ) else null end
  );
end;
$function$;

revoke all on function public.mcp_account_info(uuid) from public, anon, authenticated;
grant execute on function public.mcp_account_info(uuid) to service_role;
