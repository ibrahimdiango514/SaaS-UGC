-- VYORA — métriques réelles de l'espace administrateur.
--
-- Lecture seule, aucune donnée modifiée, aucune donnée fabriquée.
-- Accès réservé : la fonction vérifie elle-même le rôle admin côté serveur
-- (ugc_private.reelora_assert_admin), l'interface ne fait que refléter ce droit.
--
-- Méthode MRR (documentée dans l'admin) :
--   * seuls les abonnements dont le statut est réellement 'active' comptent ;
--   * le prix récurrent vient de ugc_plans.monthly_price_minor (plan 'free' = 0) ;
--   * le MRR d'un mois = somme des abonnements actifs créés au plus tard à la
--     fin de ce mois, moins ceux annulés pendant ce mois ;
--   * le MRR « perdu » utilise la date de dernière mise à jour d'un abonnement
--     annulé (seule date de résiliation disponible) ;
--   * aucune reconstitution historique n'est inventée : si aucun événement
--     n'existe sur une période, la période exploitable est renvoyée telle quelle.

create or replace function public.vyora_admin_metrics(p_months integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_months integer := greatest(1, least(36, coalesce(p_months, 12)));
  v_now date := (now() at time zone 'UTC')::date;
  v_start date := (date_trunc('month', (now() at time zone 'UTC')) - make_interval(months => v_months - 1))::date;
  v_first_activity timestamptz;
  v_result jsonb;
begin
  perform ugc_private.reelora_assert_admin();

  select min(ts) into v_first_activity from (
    select min(created_at) as ts from saas_ugc.ugc_customer_accounts
    union all select min(created_at) from saas_ugc.ugc_subscriptions
    union all select min(created_at) from saas_ugc.ugc_recharge_orders
    union all select min(created_at) from saas_ugc.ugc_generation_jobs
    union all select min(created_at) from saas_business.ai_requests
  ) sources;

  with months as (
    select generate_series(
      v_start,
      date_trunc('month', (now() at time zone 'UTC'))::date,
      interval '1 month'
    )::date as month
  ),
  revenue as (
    select date_trunc('month', (o.paid_at at time zone 'UTC'))::date as month,
           coalesce(sum(o.amount_minor), 0)::bigint as collected_minor,
           count(*)::bigint as orders
    from saas_ugc.ugc_recharge_orders o
    where o.status = 'paid' and o.paid_at is not null
    group by 1
  ),
  sub_prices as (
    select s.user_id, s.plan_key, s.status, s.created_at, s.updated_at,
           coalesce(p.monthly_price_minor, 0)::bigint as price_minor
    from saas_ugc.ugc_subscriptions s
    left join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
  ),
  mrr as (
    select m.month,
      coalesce((
        select sum(sp.price_minor) from sub_prices sp
        where sp.status = 'active'
          and sp.created_at < (m.month + interval '1 month')
          and not exists (
            select 1 from sub_prices c
            where c.user_id = sp.user_id and c.status = 'cancelled'
              and c.updated_at < (m.month + interval '1 month')
          )
      ), 0)::bigint as mrr_minor,
      coalesce((
        select sum(sp.price_minor) from sub_prices sp
        where sp.status = 'active'
          and sp.created_at >= m.month and sp.created_at < (m.month + interval '1 month')
      ), 0)::bigint as new_mrr_minor,
      coalesce((
        select sum(sp.price_minor) from sub_prices sp
        where sp.status = 'cancelled'
          and sp.updated_at >= m.month and sp.updated_at < (m.month + interval '1 month')
      ), 0)::bigint as lost_mrr_minor,
      coalesce((
        select count(*) from sub_prices sp
        where sp.status = 'active' and sp.created_at < (m.month + interval '1 month')
      ), 0)::bigint as active_subs
    from months m
  ),
  new_subs as (
    select date_trunc('month', (s.created_at at time zone 'UTC'))::date as month, count(*)::bigint as n
    from saas_ugc.ugc_subscriptions s
    group by 1
  ),
  cancelled_subs as (
    select date_trunc('month', (s.updated_at at time zone 'UTC'))::date as month, count(*)::bigint as n
    from saas_ugc.ugc_subscriptions s
    where s.status = 'cancelled'
    group by 1
  ),
  new_customers as (
    select date_trunc('month', (a.created_at at time zone 'UTC'))::date as month, count(*)::bigint as n
    from saas_ugc.ugc_customer_accounts a
    group by 1
  ),
  jobs as (
    select date_trunc('month', (j.created_at at time zone 'UTC'))::date as month,
           count(*)::bigint as total,
           count(*) filter (where j.status = 'succeeded')::bigint as succeeded,
           count(*) filter (where j.status = 'failed')::bigint as failed,
           coalesce(sum(j.credits_charged), 0)::bigint as credits_charged
    from saas_ugc.ugc_generation_jobs j
    group by 1
  ),
  bg as (
    select date_trunc('month', (r.created_at at time zone 'UTC'))::date as month,
           count(*)::bigint as requests,
           count(*) filter (where r.status = 'succeeded')::bigint as succeeded,
           count(*) filter (where r.status = 'failed')::bigint as failed,
           coalesce(sum(r.input_tokens), 0)::bigint as input_tokens,
           coalesce(sum(r.output_tokens), 0)::bigint as output_tokens,
           coalesce(sum(r.provider_cost_micros), 0)::bigint as provider_cost_micros
    from saas_business.ai_requests r
    group by 1
  )
  select jsonb_build_object(
    'generated_at', now(),
    'months', v_months,
    'period_start', v_start,
    'period_end', date_trunc('month', (now() at time zone 'UTC'))::date,
    'history', jsonb_build_object(
      'first_activity_at', v_first_activity,
      'exploitable_from', greatest(v_start, coalesce(v_first_activity::date, v_now)),
      'has_history', v_first_activity is not null,
      'months_of_history', case
        when v_first_activity is null then 0
        else greatest(1, (extract(year from age(now(), v_first_activity)) * 12
                        + extract(month from age(now(), v_first_activity)))::integer + 1)
      end
    ),
    'revenue', jsonb_build_object(
      'currency', 'XOF',
      'collected_total_minor', (select coalesce(sum(o.amount_minor), 0) from saas_ugc.ugc_recharge_orders o where o.status = 'paid'),
      'collected_orders', (select count(*) from saas_ugc.ugc_recharge_orders o where o.status = 'paid'),
      'pending_orders', (select count(*) from saas_ugc.ugc_recharge_orders o where o.status in ('pending', 'processing')),
      'by_month', coalesce((
        select jsonb_agg(jsonb_build_object(
          'month', to_char(m.month, 'YYYY-MM'),
          'collected_minor', coalesce(r.collected_minor, 0),
          'orders', coalesce(r.orders, 0)
        ) order by m.month)
        from months m left join revenue r on r.month = m.month
      ), '[]'::jsonb)
    ),
    'mrr', jsonb_build_object(
      'currency', 'XOF',
      'current_minor', coalesce((
        select sum(sp.price_minor) from sub_prices sp
        where sp.status = 'active'
          and not exists (select 1 from sub_prices c where c.user_id = sp.user_id and c.status = 'cancelled')
      ), 0),
      'active_recurring_subscriptions', coalesce((
        select count(*) from sub_prices sp
        where sp.status = 'active' and sp.price_minor > 0
          and not exists (select 1 from sub_prices c where c.user_id = sp.user_id and c.status = 'cancelled')
      ), 0),
      'by_month', coalesce((
        select jsonb_agg(jsonb_build_object(
          'month', to_char(m.month, 'YYYY-MM'),
          'mrr_minor', coalesce(x.mrr_minor, 0),
          'new_mrr_minor', coalesce(x.new_mrr_minor, 0),
          'lost_mrr_minor', coalesce(x.lost_mrr_minor, 0),
          'net_mrr_minor', coalesce(x.new_mrr_minor, 0) - coalesce(x.lost_mrr_minor, 0),
          'active_subscriptions', coalesce(x.active_subs, 0)
        ) order by m.month)
        from months m left join mrr x on x.month = m.month
      ), '[]'::jsonb)
    ),
    'subscriptions', jsonb_build_object(
      'total', (select count(*) from saas_ugc.ugc_subscriptions),
      'active', (select count(*) from saas_ugc.ugc_subscriptions where status = 'active'),
      'cancelled', (select count(*) from saas_ugc.ugc_subscriptions where status = 'cancelled'),
      'by_plan', coalesce((
        select jsonb_agg(jsonb_build_object(
          'plan_key', s.plan_key,
          'plan_name', coalesce(p.display_name, s.plan_key),
          'status', s.status,
          'count', s.n,
          'monthly_price_minor', coalesce(p.monthly_price_minor, 0)
        ) order by s.plan_key, s.status)
        from (
          select plan_key, status, count(*)::bigint as n
          from saas_ugc.ugc_subscriptions group by plan_key, status
        ) s left join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
      ), '[]'::jsonb),
      'new_by_month', coalesce((
        select jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'count', coalesce(n.n, 0)) order by m.month)
        from months m left join new_subs n on n.month = m.month
      ), '[]'::jsonb),
      'cancelled_by_month', coalesce((
        select jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'count', coalesce(c.n, 0)) order by m.month)
        from months m left join cancelled_subs c on c.month = m.month
      ), '[]'::jsonb)
    ),
    'users', jsonb_build_object(
      'customers', (select count(*) from saas_ugc.ugc_customer_accounts),
      'with_subscription', (select count(distinct user_id) from saas_ugc.ugc_subscriptions),
      'new_by_month', coalesce((
        select jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM'), 'count', coalesce(n.n, 0)) order by m.month)
        from months m left join new_customers n on n.month = m.month
      ), '[]'::jsonb)
    ),
    'studio', jsonb_build_object(
      'jobs_total', (select count(*) from saas_ugc.ugc_generation_jobs),
      'jobs_succeeded', (select count(*) from saas_ugc.ugc_generation_jobs where status = 'succeeded'),
      'jobs_failed', (select count(*) from saas_ugc.ugc_generation_jobs where status = 'failed'),
      'credits_charged_total', (select coalesce(sum(credits_charged), 0) from saas_ugc.ugc_generation_jobs),
      'usage_by_kind', coalesce((
        select jsonb_object_agg(u.event_kind, u.total) from (
          select event_kind, sum(quantity)::bigint as total from saas_ugc.ugc_usage_events group by event_kind
        ) u
      ), '{}'::jsonb),
      'by_month', coalesce((
        select jsonb_agg(jsonb_build_object(
          'month', to_char(m.month, 'YYYY-MM'),
          'jobs', coalesce(j.total, 0),
          'succeeded', coalesce(j.succeeded, 0),
          'failed', coalesce(j.failed, 0),
          'credits_charged', coalesce(j.credits_charged, 0)
        ) order by m.month)
        from months m left join jobs j on j.month = m.month
      ), '[]'::jsonb)
    ),
    'business_growth', jsonb_build_object(
      'requests_total', (select count(*) from saas_business.ai_requests),
      'requests_succeeded', (select count(*) from saas_business.ai_requests where status = 'succeeded'),
      'requests_failed', (select count(*) from saas_business.ai_requests where status = 'failed'),
      'conversations', (select count(*) from saas_business.conversations),
      'messages', (select count(*) from saas_business.messages),
      'memory_items', (select count(*) from saas_business.memory_items),
      'tool_executions', (select count(*) from saas_business.tool_executions),
      'tokens_total', (select coalesce(sum(input_tokens + output_tokens), 0) from saas_business.ai_requests),
      'by_month', coalesce((
        select jsonb_agg(jsonb_build_object(
          'month', to_char(m.month, 'YYYY-MM'),
          'requests', coalesce(b.requests, 0),
          'succeeded', coalesce(b.succeeded, 0),
          'failed', coalesce(b.failed, 0),
          'input_tokens', coalesce(b.input_tokens, 0),
          'output_tokens', coalesce(b.output_tokens, 0),
          'provider_cost_micros', coalesce(b.provider_cost_micros, 0)
        ) order by m.month)
        from months m left join bg b on b.month = m.month
      ), '[]'::jsonb)
    ),
    'providers', jsonb_build_object(
      'business_growth', coalesce((
        select jsonb_agg(jsonb_build_object(
          'provider_key', a.provider_key,
          'attempts', a.attempts,
          'succeeded', a.succeeded,
          'failed', a.failed,
          'provider_cost_micros', a.cost_micros,
          'last_attempt_at', a.last_at
        ) order by a.attempts desc)
        from (
          select provider_key,
                 count(*)::bigint as attempts,
                 count(*) filter (where status = 'succeeded')::bigint as succeeded,
                 count(*) filter (where status = 'failed')::bigint as failed,
                 coalesce(sum(provider_cost_micros), 0)::bigint as cost_micros,
                 max(started_at) as last_at
          from saas_business.ai_request_attempts group by provider_key
        ) a
      ), '[]'::jsonb),
      'studio_cost_events', coalesce((
        select jsonb_agg(jsonb_build_object(
          'provider', c.provider,
          'currency', c.currency,
          'amount', c.amount,
          'events', c.events,
          'last_event_at', c.last_at
        ) order by c.events desc)
        from (
          select provider, currency, sum(amount)::numeric as amount, count(*)::bigint as events, max(occurred_at) as last_at
          from saas_ugc.ugc_provider_cost_events group by provider, currency
        ) c
      ), '[]'::jsonb)
    ),
    'models', jsonb_build_object(
      'total', (select count(*) from public.reelora_video_models),
      'selectable', (select count(*) from public.reelora_video_models where active and is_enabled and not is_coming_soon),
      'coming_soon', (select count(*) from public.reelora_video_models where is_coming_soon),
      'synced_at', (select max(synced_at) from public.reelora_video_models)
    )
  ) into v_result;

  return v_result;
end;
$function$;

comment on function public.vyora_admin_metrics(integer) is
  'Métriques admin VYORA : revenus encaissés, MRR réel, abonnements, utilisateurs, activité Studio et Business Growth, coûts fournisseurs. Lecture seule, réservée aux administrateurs.';

revoke all on function public.vyora_admin_metrics(integer) from public;
grant execute on function public.vyora_admin_metrics(integer) to authenticated;
