-- ============================================================================
-- VYORA — `mcp_account_info` : abonnement, plan et crédits RÉELS
-- ============================================================================
--
-- ## Ce qui était faux
--
-- La version d'origine renvoyait `'credits', null, 'plan', null` : un client
-- MCP n'apprenait donc rien d'utile sur le compte, et surtout rien de fiable.
-- Un modèle qui reçoit `null` a deux réactions possibles, toutes deux mauvaises
-- pour l'utilisateur : inventer un chiffre, ou affirmer que le compte est vide.
--
-- ## D'où viennent les chiffres (aucune source inventée)
--
--   abonnement → `saas_business.subscriptions`
--   plan       → `saas_business.plans` (nom lisible, quota mensuel, prix)
--   crédits    → `saas_business.wallets` (`available_units`, `reserved_units`,
--                `monthly_allowance`, `period_used`)
--
-- Choix explicite : on lit les TABLES, pas les fonctions qui les résument.
-- `saas_business.bg_import_access` mélange l'état de l'abonnement à une
-- politique commerciale (période obligatoire, plan encore au catalogue) et
-- n'était pas la bonne granularité ici. Ces tables sont celles que l'Edge
-- Function `business-grow` et que `mcp_stores_list` / `mcp_integrations_status`
-- lisent déjà : la même vérité partout.
--
-- ## Droits : ce que la fonction refuse de dire
--
-- Rien n'est renvoyé si `p_user_id` est NULL. Rien n'est renvoyé sur un compte
-- inconnu. Aucun identifiant externe de facturation (`external_customer_id`,
-- `external_subscription_id`) n'est exposé : un client MCP n'en a pas besoin,
-- et ce sont des identifiants de prestataire de paiement.
--
-- Les crédits sont exposés en UNITÉS et en état, jamais en montant payé.
--
-- ## Idempotence
--
-- `create or replace` avec la MÊME signature (`p_user_id uuid`) et le même
-- type de retour (`jsonb`) : pas de `42P13`, et la fonction reste appelable par
-- la version déployée du serveur MCP, qui ne change pas.
-- ============================================================================

create or replace function public.mcp_account_info(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'pg_catalog', 'public', 'saas_business', 'saas_ugc'
as $function$
declare
  v_sub    saas_business.subscriptions%rowtype;
  v_plan   saas_business.plans%rowtype;
  v_wallet saas_business.wallets%rowtype;
  v_a_plan boolean := false;
  v_a_wallet boolean := false;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  /*
   * UNE seule ligne d'abonnement : celle qui décrit le mieux la situation
   * actuelle. Le tri place d'abord un abonnement réellement en cours, puis un
   * essai, puis le reste (impayé, expiré, résilié). `current_period_end` peut
   * être NULL : il passe en dernier, il ne doit jamais masquer une échéance
   * connue.
   */
  select s.* into v_sub
    from saas_business.subscriptions s
   where s.user_id = p_user_id
     and s.status in ('active', 'trialing', 'past_due', 'expired', 'canceled')
   order by
     case s.status when 'active' then 0 when 'trialing' then 1 else 2 end,
     s.current_period_end desc nulls last,
     s.created_at desc
   limit 1;

  if found then
    select p.* into v_plan
      from saas_business.plans p
     where p.plan_key = v_sub.plan_key;
    v_a_plan := found;
  end if;

  select w.* into v_wallet
    from saas_business.wallets w
   where w.user_id = p_user_id;
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
     * `null` signifie « aucune ligne » et non « compte à zéro ». La distinction
     * est transmise telle quelle : le client MCP peut alors dire « pas
     * d'abonnement » au lieu d'inventer un plan gratuit.
     */
    'subscription', case when v_sub.user_id is null then null else jsonb_build_object(
      'status', v_sub.status,
      'plan_key', v_sub.plan_key,
      'current_period_start', v_sub.current_period_start,
      'current_period_end', v_sub.current_period_end,
      'billing_provider', v_sub.billing_provider,
      /* `true` seulement si l'accès est réellement ouvert à cet instant. */
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
      'monthly_credit_units', v_plan.monthly_credit_units,
      'monthly_price_minor', v_plan.monthly_price_minor,
      'currency', v_plan.currency,
      'active', v_plan.active
    ) else null end,

    /*
     * `remaining_units` est la somme exploitable tout de suite (disponible +
     * réservé par un travail en cours n'est PAS inclus : le réservé est déjà
     * engagé). `available_units` reste exposé séparément pour que le client
     * puisse expliquer la différence au lieu de la subir.
     */
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

-- La fonction reste réservée au serveur : elle prend un identifiant
-- d'utilisateur en paramètre, et l'accorder à `authenticated` permettrait à
-- n'importe qui de sonder le compte d'un autre en devinant un UUID.
revoke all on function public.mcp_account_info(uuid) from public, anon, authenticated;
grant execute on function public.mcp_account_info(uuid) to service_role;
