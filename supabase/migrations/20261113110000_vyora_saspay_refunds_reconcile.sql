-- -----------------------------------------------------------------------------
-- VYORA — paiement SasPay : remboursements, réconciliation automatique,
-- expiration des abonnements Business Grow
--
-- Complète `20261113100000_vyora_saspay_payments.sql`. Additive et idempotente.
--
-- 1. REMBOURSEMENTS
--    SasPay n'expose NI route NI webhook de remboursement : l'argent est rendu
--    par l'exploitant, hors de cette application. Cette migration ne déplace
--    donc aucun argent. Elle garantit qu'un remboursement :
--      * est décidé par un administrateur identifié, motif à l'appui ;
--      * reprend D'ABORD les crédits (ou la période d'abonnement) accordés ;
--      * ne rend jamais plus que la valeur de ce qui a pu être repris : des
--        crédits déjà consommés ne sont pas remboursables par ce parcours ;
--      * est unique, tracé, et irréversible (`refunded` est terminal).
--    Deux temps : `credits_recovered` (crédits repris, argent dû au client) puis
--    `settled` (l'exploitant atteste avoir rendu l'argent, référence à l'appui).
--
-- 2. RÉCONCILIATION
--    Une tâche planifiée revérifie auprès de SasPay les commandes en attente,
--    rattrape les webhooks perdus et signale les anomalies. Elle ne crédite que
--    par la même fonction de règlement que le reste (`*_settle`) : mêmes
--    preuves, même idempotence. Tant qu'aucune commande SasPay n'existe, elle
--    n'émet AUCUN appel réseau.
--
-- 3. ABONNEMENTS BUSINESS GROW
--    Un abonnement payé par SasPay n'est pas reconduit automatiquement : arrivé
--    à échéance, il passe à `expired` et le quota mensuel revient à sa valeur
--    par défaut.
-- -----------------------------------------------------------------------------

-- Appelant autorisé : Edge Function (JWT service_role) ou tâche pg_cron
-- (session postgres sans JWT). Tout autre rôle est refusé.
create or replace function ugc_private.vyora_assert_service_or_cron()
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_jwt_role text := coalesce((select auth.jwt()->>'role'), '');
  v_db_role text := coalesce(nullif(current_setting('role', true), ''), '');
begin
  if v_jwt_role = 'service_role' then return; end if;
  if v_jwt_role = '' and session_user in ('postgres', 'supabase_admin')
     and v_db_role in ('', 'none', 'postgres', 'supabase_admin') then
    return;
  end if;
  raise exception 'service_role_required';
end $$;
revoke all on function ugc_private.vyora_assert_service_or_cron() from public, anon, authenticated;

-- =============================================================================
-- 1. REMBOURSEMENTS — STUDIO
-- =============================================================================
alter table saas_ugc.ugc_recharge_orders
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_state text,
  add column if not exists refund_reason text,
  add column if not exists refund_amount_minor bigint,
  add column if not exists refund_credits_recovered bigint,
  add column if not exists refund_credits_unrecovered bigint,
  add column if not exists refund_recorded_by uuid,
  add column if not exists refund_external_reference text,
  add column if not exists refund_settled_at timestamptz,
  add column if not exists refund_settled_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ugc_recharge_orders_refund_state_check') then
    alter table saas_ugc.ugc_recharge_orders
      add constraint ugc_recharge_orders_refund_state_check
      check (refund_state is null or refund_state in ('credits_recovered', 'settled'));
  end if;
end $$;

-- Garde dédiée aux remboursements des commandes SasPay. Les commandes des autres
-- prestataires (parcours manuel historique) ne sont pas concernées.
create or replace function saas_ugc.vyora_guard_recharge_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider is distinct from 'saspay' then return new; end if;

  if tg_op = 'INSERT' then
    if new.status = 'refunded' or new.refund_state is not null or new.refunded_at is not null then
      raise exception 'refund_requires_refund_service';
    end if;
    return new;
  end if;

  if new.status <> 'refunded' then
    if new.refund_state is not null or new.refunded_at is not null or new.refund_amount_minor is not null
       or new.refund_credits_recovered is not null or new.refund_recorded_by is not null then
      raise exception 'refund_requires_refund_service';
    end if;
    return new;
  end if;

  if old.status <> 'refunded' then
    -- Passage à « remboursée » : uniquement depuis « payée », avec la preuve que
    -- les crédits ont été repris par le grand livre.
    if old.status <> 'paid'
       or new.refund_state is distinct from 'credits_recovered'
       or new.refunded_at is null or new.refund_recorded_by is null
       or nullif(trim(coalesce(new.refund_reason, '')), '') is null
       or new.refund_amount_minor is null or new.refund_amount_minor < 1
       or new.refund_amount_minor > new.amount_minor
       or new.refund_credits_recovered is null or new.refund_credits_recovered < 1
       or new.refund_credits_unrecovered is null or new.refund_credits_unrecovered < 0
       or new.refund_credits_recovered + new.refund_credits_unrecovered <> new.credits_to_grant
       or new.refund_settled_at is not null or new.refund_external_reference is not null then
      raise exception 'refund_requires_refund_service';
    end if;
    if not exists (
      select 1 from saas_ugc.ugc_credit_ledger l
       where l.user_id = new.user_id
         and l.idempotency_key = 'refund:' || new.id::text
         and l.operation_type = 'refund'
         and l.available_delta = -new.refund_credits_recovered
    ) then
      raise exception 'refund_requires_credit_recovery';
    end if;
    return new;
  end if;

  -- Déjà remboursée : le remboursement est immuable ; seule l'attestation de
  -- restitution de l'argent peut être ajoutée, une fois.
  if (new.refunded_at, new.refund_reason, new.refund_amount_minor, new.refund_credits_recovered,
      new.refund_credits_unrecovered, new.refund_recorded_by)
     is distinct from
     (old.refunded_at, old.refund_reason, old.refund_amount_minor, old.refund_credits_recovered,
      old.refund_credits_unrecovered, old.refund_recorded_by) then
    raise exception 'refund_is_immutable';
  end if;
  if old.refund_state = 'settled' then
    if (new.refund_state, new.refund_external_reference, new.refund_settled_at, new.refund_settled_by)
       is distinct from
       (old.refund_state, old.refund_external_reference, old.refund_settled_at, old.refund_settled_by) then
      raise exception 'refund_is_immutable';
    end if;
  elsif new.refund_state = 'settled' then
    if nullif(trim(coalesce(new.refund_external_reference, '')), '') is null
       or new.refund_settled_at is null or new.refund_settled_by is null then
      raise exception 'refund_settlement_requires_reference';
    end if;
  elsif new.refund_state is distinct from old.refund_state
        or new.refund_external_reference is not null or new.refund_settled_at is not null
        or new.refund_settled_by is not null then
    raise exception 'refund_is_immutable';
  end if;
  return new;
end $$;

drop trigger if exists vyora_recharge_refund_guard on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_refund_guard
  before insert or update on saas_ugc.ugc_recharge_orders
  for each row execute function saas_ugc.vyora_guard_recharge_refund();
revoke all on function saas_ugc.vyora_guard_recharge_refund() from public, anon, authenticated;

create or replace function ugc_private.vyora_studio_refund_json(o saas_ugc.ugc_recharge_orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select case when o.refunded_at is null then '{}'::jsonb else jsonb_build_object(
    'refunded_at', o.refunded_at,
    'refund_state', o.refund_state,
    'refund_amount', trim(to_char(o.refund_amount_minor::numeric / 100, 'FM9999999999999990.00')),
    'refund_reason', o.refund_reason,
    'refund_credits_recovered', o.refund_credits_recovered,
    'refund_credits_unrecovered', o.refund_credits_unrecovered,
    'refund_external_reference', o.refund_external_reference,
    'refund_settled_at', o.refund_settled_at
  ) end;
$$;
revoke all on function ugc_private.vyora_studio_refund_json(saas_ugc.ugc_recharge_orders) from public, anon, authenticated;

-- Ce qu'un remboursement reprendrait MAINTENANT. Lecture seule ; la fonction
-- d'enregistrement la rappelle après avoir verrouillé commande et portefeuille.
create or replace function ugc_private.vyora_studio_refund_plan(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_available bigint;
  v_reserved bigint;
  v_price bigint;
  v_recover bigint;
  v_short bigint;
  v_blocked text;
begin
  select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id and o.provider = 'saspay';
  if not found then raise exception 'payment_order_not_found'; end if;
  select w.available_balance, w.reserved_balance into v_available, v_reserved
    from saas_ugc.ugc_wallets w where w.user_id = v_order.user_id;
  v_available := greatest(coalesce(v_available, 0), 0);
  v_reserved := greatest(coalesce(v_reserved, 0), 0);
  v_price := v_order.amount_minor / 100;
  v_recover := least(v_available, v_order.credits_to_grant);
  v_short := v_order.credits_to_grant - v_recover;
  v_blocked := case
    when v_order.status = 'refunded' then 'already_refunded'
    when v_order.status <> 'paid' then 'refund_requires_paid_order'
    -- Des crédits réservés par une génération en cours peuvent revenir au solde :
    -- on attend la fin des générations avant de trancher.
    when v_short > 0 and v_reserved > 0 then 'refund_wallet_has_reserved_credits'
    when v_recover = 0 then 'refund_nothing_recoverable'
    when floor(v_price::numeric * v_recover / v_order.credits_to_grant) < 1 then 'refund_nothing_recoverable'
    else null end;
  return jsonb_build_object(
    'product', 'studio',
    'order_id', v_order.id,
    'status', v_order.status,
    'internal_reference', v_order.internal_reference,
    'price_xof', v_price,
    'credits_granted', v_order.credits_to_grant,
    'wallet_available', v_available,
    'wallet_reserved', v_reserved,
    'credits_recoverable', v_recover,
    'credits_unrecoverable', v_short,
    -- Valeur au prorata des crédits repris : plafond de ce qui peut être rendu.
    'max_refund_xof', floor(v_price::numeric * v_recover / v_order.credits_to_grant)::bigint,
    'needs_partial', v_short > 0,
    'refundable', v_blocked is null,
    'blocked', v_blocked
  );
end $$;
revoke all on function ugc_private.vyora_studio_refund_plan(uuid) from public, anon, authenticated;

-- Enregistre un remboursement Studio : reprend les crédits, clôt la commande.
-- NE DÉPLACE AUCUN ARGENT. Le montant renvoyé est ce que l'exploitant doit
-- ensuite rendre au client, hors de l'application.
create or replace function public.vyora_admin_refund_studio(
  p_order_id uuid,
  p_reason text,
  p_refund_amount_xof bigint,
  p_allow_partial boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_plan jsonb;
  v_recover bigint;
  v_short bigint;
begin
  perform ugc_private.reelora_assert_admin();
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'refund_reason_required';
  end if;

  -- Verrous dans l'ordre commande → portefeuille (le même que le règlement).
  select * into v_order from saas_ugc.ugc_recharge_orders o
   where o.id = p_order_id and o.provider = 'saspay' for update;
  if not found then raise exception 'payment_order_not_found'; end if;
  if v_order.status = 'refunded' then
    return ugc_private.vyora_studio_order_json(v_order) || ugc_private.vyora_studio_refund_json(v_order)
      || jsonb_build_object('outcome', 'already_refunded');
  end if;
  perform 1 from saas_ugc.ugc_wallets w where w.user_id = v_order.user_id for update;
  if not found then raise exception 'refund_wallet_missing'; end if;

  v_plan := ugc_private.vyora_studio_refund_plan(p_order_id);
  if v_plan->>'blocked' is not null then raise exception '%', v_plan->>'blocked'; end if;
  v_recover := (v_plan->>'credits_recoverable')::bigint;
  v_short := (v_plan->>'credits_unrecoverable')::bigint;
  if v_short > 0 and not coalesce(p_allow_partial, false) then
    raise exception 'refund_credits_already_consumed';
  end if;
  if p_refund_amount_xof is null or p_refund_amount_xof < 1
     or p_refund_amount_xof > (v_plan->>'max_refund_xof')::bigint then
    raise exception 'refund_amount_out_of_bounds';
  end if;

  -- Reprise des crédits par la primitive EXISTANTE (grand livre idempotent). Le
  -- solde ne peut pas devenir négatif : la primitive le refuse.
  perform ugc_private.apply_wallet_delta(
    v_order.user_id, 'refund', -v_recover, 0, 'refund:' || v_order.id::text,
    'Remboursement — ' || coalesce(v_order.order_label, 'recharge de crédits Studio'),
    jsonb_build_object('provider', 'saspay', 'internal_reference', v_order.internal_reference,
      'credits_recovered', v_recover, 'credits_unrecovered', v_short,
      'refund_amount_xof', p_refund_amount_xof),
    v_order.id, null
  );

  update saas_ugc.ugc_recharge_orders
     set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered',
         refund_reason = v_reason, refund_amount_minor = p_refund_amount_xof * 100,
         refund_credits_recovered = v_recover, refund_credits_unrecovered = v_short,
         refund_recorded_by = v_admin
   where id = p_order_id returning * into v_order;

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (v_admin, 'saspay_refund_recorded', 'recharge_order', p_order_id::text,
    jsonb_build_object('actor', 'admin', 'customer', v_order.user_id, 'reason', v_reason,
      'refund_amount_xof', p_refund_amount_xof, 'credits_recovered', v_recover,
      'credits_unrecovered', v_short, 'payment_id', v_order.provider_payment_id));
  insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
  values (v_order.user_id, 'Remboursement en cours',
    v_recover::text || ' crédits Studio ont été retirés de votre solde. Le remboursement de '
      || p_refund_amount_xof::text || ' FCFA vous sera versé par le support.',
    'info', '/app/credits');

  return ugc_private.vyora_studio_order_json(v_order) || ugc_private.vyora_studio_refund_json(v_order)
    || jsonb_build_object('outcome', 'refunded');
end $$;

-- =============================================================================
-- 2. REMBOURSEMENTS — BUSINESS GROW
-- =============================================================================
alter table saas_business.payment_orders
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_state text,
  add column if not exists refund_reason text,
  add column if not exists refund_amount_minor bigint,
  add column if not exists refund_days_recovered integer,
  add column if not exists refund_units_recovered integer,
  add column if not exists refund_subscription_status text,
  add column if not exists refund_billing_event_id uuid,
  add column if not exists refund_recorded_by uuid,
  add column if not exists refund_external_reference text,
  add column if not exists refund_settled_at timestamptz,
  add column if not exists refund_settled_by uuid;

alter table saas_business.payment_orders drop constraint if exists payment_orders_status_check;
alter table saas_business.payment_orders add constraint payment_orders_status_check
  check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled', 'refunded'));
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_orders_refund_state_check') then
    alter table saas_business.payment_orders
      add constraint payment_orders_refund_state_check
      check (refund_state is null or refund_state in ('credits_recovered', 'settled'));
  end if;
end $$;

-- Garde des commandes Business Grow : identique à la version d'origine, à ceci
-- près que `paid` peut désormais devenir `refunded` (et seulement cela), et que
-- `refunded` est terminal.
create or replace function saas_business.vyora_guard_payment_order()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.paid_at is not null or new.provider <> 'saspay'
       or new.provider_payment_id is not null or new.provider_session_id is not null
       or new.subscription_id is not null or new.billing_event_id is not null
       or new.refund_state is not null or new.refunded_at is not null then
      raise exception 'payment_order_must_start_pending';
    end if;
    return new;
  end if;
  new.updated_at := now();
  if (new.id, new.user_id, new.plan_key, new.plan_label, new.amount_minor, new.currency, new.country_code,
      new.period_days, new.monthly_credit_units, new.provider, new.internal_reference,
      new.idempotency_key, new.payment_flow, new.network_code, new.created_at)
     is distinct from
     (old.id, old.user_id, old.plan_key, old.plan_label, old.amount_minor, old.currency, old.country_code,
      old.period_days, old.monthly_credit_units, old.provider, old.internal_reference,
      old.idempotency_key, old.payment_flow, old.network_code, old.created_at) then
    raise exception 'payment_order_identity_is_immutable';
  end if;
  if (old.provider_payment_id is not null and new.provider_payment_id is distinct from old.provider_payment_id)
     or (old.provider_session_id is not null and new.provider_session_id is distinct from old.provider_session_id) then
    raise exception 'provider_reference_is_immutable';
  end if;
  if old.status = 'paid' and new.status not in ('paid', 'refunded') then
    raise exception 'paid_order_is_terminal';
  end if;
  if old.status = 'refunded' and new.status <> 'refunded' then
    raise exception 'paid_order_is_terminal';
  end if;
  -- Refus d'activation (encaissement incompatible avec l'abonnement) : définitif.
  -- La commande ne sera jamais activée ; elle garde son état et son motif
  -- jusqu'à sa seule issue possible, le remboursement intégral (plus bas).
  if old.failure_code in ('business_plan_change_not_supported', 'business_subscription_managed_elsewhere')
     and old.provider_status = 'SUCCESS'
     and (new.failure_code is distinct from old.failure_code
          or new.provider_status is distinct from old.provider_status
          or (new.status is distinct from old.status and new.status <> 'refunded')) then
    raise exception 'subscription_conflict_is_final';
  end if;
  if new.status = 'paid' and old.status <> 'paid' then
    if new.provider_payment_id is null or new.billing_event_id is null or not exists (
      select 1 from saas_business.billing_events e
       where e.id = new.billing_event_id
         and e.billing_provider = 'saspay'
         and e.external_event_id = 'saspay:success:' || new.provider_payment_id
         and e.processing_status = 'processed'
    ) then
      raise exception 'saspay_order_requires_verified_payment';
    end if;
  end if;

  -- Remboursement ------------------------------------------------------------
  if new.status <> 'refunded' then
    if new.refund_state is not null or new.refunded_at is not null or new.refund_amount_minor is not null
       or new.refund_billing_event_id is not null or new.refund_recorded_by is not null then
      raise exception 'refund_requires_refund_service';
    end if;
    return new;
  end if;
  if old.status <> 'refunded' then
    -- Encaissement jamais livré (refus d'activation) : rien n'a été activé, donc
    -- rien n'est à reprendre. Le remboursement est INTÉGRAL et ne touche à aucun
    -- abonnement (aucun événement de facturation).
    if old.status <> 'paid' then
      if coalesce(old.failure_code, '') not in ('business_plan_change_not_supported', 'business_subscription_managed_elsewhere')
         or old.provider_status is distinct from 'SUCCESS' or old.provider_payment_id is null
         or old.subscription_id is not null or old.billing_event_id is not null
         or new.subscription_id is not null or new.billing_event_id is not null
         or new.refund_state is distinct from 'credits_recovered'
         or new.refunded_at is null or new.refund_recorded_by is null
         or nullif(trim(coalesce(new.refund_reason, '')), '') is null
         or new.refund_amount_minor is distinct from new.amount_minor
         or new.refund_days_recovered is distinct from 0
         or new.refund_units_recovered is distinct from 0
         or new.refund_subscription_status is not null
         or new.refund_billing_event_id is not null
         or new.refund_settled_at is not null or new.refund_external_reference is not null then
        raise exception 'refund_requires_refund_service';
      end if;
      return new;
    end if;
    if new.refund_state is distinct from 'credits_recovered'
       or new.refunded_at is null or new.refund_recorded_by is null
       or nullif(trim(coalesce(new.refund_reason, '')), '') is null
       or new.refund_amount_minor is null or new.refund_amount_minor < 1
       or new.refund_amount_minor > new.amount_minor
       or new.refund_days_recovered is null or new.refund_days_recovered < 1
       or new.refund_settled_at is not null or new.refund_external_reference is not null
       or new.refund_billing_event_id is null or not exists (
         select 1 from saas_business.billing_events e
          where e.id = new.refund_billing_event_id
            and e.billing_provider = 'saspay'
            and e.external_event_id = 'saspay:refund:' || new.id::text
            and e.processing_status = 'processed'
       ) then
      raise exception 'refund_requires_refund_service';
    end if;
    return new;
  end if;
  if (new.refunded_at, new.refund_reason, new.refund_amount_minor, new.refund_days_recovered,
      new.refund_units_recovered, new.refund_subscription_status, new.refund_billing_event_id,
      new.refund_recorded_by)
     is distinct from
     (old.refunded_at, old.refund_reason, old.refund_amount_minor, old.refund_days_recovered,
      old.refund_units_recovered, old.refund_subscription_status, old.refund_billing_event_id,
      old.refund_recorded_by) then
    raise exception 'refund_is_immutable';
  end if;
  if old.refund_state = 'settled' then
    if (new.refund_state, new.refund_external_reference, new.refund_settled_at, new.refund_settled_by)
       is distinct from
       (old.refund_state, old.refund_external_reference, old.refund_settled_at, old.refund_settled_by) then
      raise exception 'refund_is_immutable';
    end if;
  elsif new.refund_state = 'settled' then
    if nullif(trim(coalesce(new.refund_external_reference, '')), '') is null
       or new.refund_settled_at is null or new.refund_settled_by is null then
      raise exception 'refund_settlement_requires_reference';
    end if;
  elsif new.refund_state is distinct from old.refund_state
        or new.refund_external_reference is not null or new.refund_settled_at is not null
        or new.refund_settled_by is not null then
    raise exception 'refund_is_immutable';
  end if;
  return new;
end $$;
revoke all on function saas_business.vyora_guard_payment_order() from public, anon, authenticated, service_role;

create or replace function saas_business.vyora_payment_refund_json(o saas_business.payment_orders)
returns jsonb
language sql
stable
set search_path = pg_catalog, saas_business
as $$
  select case when o.refunded_at is null then '{}'::jsonb else jsonb_build_object(
    'refunded_at', o.refunded_at,
    'refund_state', o.refund_state,
    'refund_amount', o.refund_amount_minor::text || '.00',
    'refund_reason', o.refund_reason,
    'refund_days_recovered', o.refund_days_recovered,
    'refund_units_recovered', o.refund_units_recovered,
    'refund_subscription_status', o.refund_subscription_status,
    'refund_external_reference', o.refund_external_reference,
    'refund_settled_at', o.refund_settled_at
  ) end;
$$;
revoke all on function saas_business.vyora_payment_refund_json(saas_business.payment_orders) from public, anon, authenticated, service_role;

-- Applique un état d'abonnement par le pipeline EXISTANT (événement de
-- facturation normalisé), comme le fait le règlement d'un paiement.
create or replace function saas_business.vyora_apply_subscription_event(
  p_event_key text,
  p_event_type text,
  p_sub saas_business.subscriptions,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_extra jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_data jsonb;
  v_event uuid;
  v_token uuid := gen_random_uuid();
begin
  v_data := jsonb_build_object(
    'user_id', p_sub.user_id,
    'subscription_id', p_sub.id,
    'plan_key', p_sub.plan_key,
    'status', p_status,
    'external_customer_id', p_sub.external_customer_id,
    'external_subscription_id', p_sub.external_subscription_id,
    'period_start', p_period_start,
    'period_end', p_period_end
  ) || coalesce(p_extra, '{}'::jsonb);
  -- Horodatage pris après les verrous de l'appelant, jamais antérieur à la
  -- dernière écriture de l'abonnement (sinon l'événement serait jugé périmé).
  v_event := saas_business.bg_receive_billing_event('saspay', p_event_key, p_event_type, md5(v_data::text), v_data,
    greatest(clock_timestamp(), coalesce(p_sub.billing_updated_at, '-infinity'::timestamptz)));
  update saas_business.billing_events
     set processing_status = 'processing', lease_token = v_token,
         lease_until = now() + interval '60 seconds', attempt_count = attempt_count + 1
   where id = v_event and processing_status = 'received';
  if not found then raise exception 'billing_event_not_claimable'; end if;
  perform saas_business.bg_apply_billing_event(v_event, v_token);
  return v_event;
end $$;
revoke all on function saas_business.vyora_apply_subscription_event(text, text, saas_business.subscriptions, text, timestamptz, timestamptz, jsonb)
  from public, anon, authenticated, service_role;

-- Ramène le quota mensuel à sa valeur par défaut (fin d'abonnement payant).
-- Renvoie le nombre d'unités retirées du solde disponible.
create or replace function saas_business.vyora_reset_wallet_allowance(p_user_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_before integer;
  v_allowance integer;
  v_after integer;
begin
  perform saas_business.bg_ensure_wallet(p_user_id);
  select w.available_units into v_before from saas_business.wallets w where w.user_id = p_user_id for update;
  update saas_business.wallets set monthly_allowance = default
   where user_id = p_user_id returning monthly_allowance into v_allowance;
  update saas_business.wallets set available_units = least(available_units, v_allowance)
   where user_id = p_user_id returning available_units into v_after;
  if v_after < v_before then
    insert into saas_business.credit_ledger(user_id, delta, balance_after, kind, reason)
    values (p_user_id, v_after - v_before, v_after, 'adjustment', left(p_reason, 200));
  end if;
  return v_before - v_after;
end $$;
revoke all on function saas_business.vyora_reset_wallet_allowance(uuid, text) from public, anon, authenticated, service_role;

create or replace function saas_business.vyora_payment_refund_plan(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_order saas_business.payment_orders%rowtype;
  v_sub saas_business.subscriptions%rowtype;
  v_has_sub boolean := false;
  v_days integer := 0;
  v_period interval;
  v_new_end timestamptz;
  v_cancel boolean := false;
  v_max bigint := 0;
  v_other_plan boolean := false;
  v_undelivered boolean := false;
  v_blocked text;
begin
  select * into v_order from saas_business.payment_orders o where o.id = p_order_id;
  if not found then raise exception 'payment_order_not_found'; end if;
  -- Encaissement constaté par SasPay mais jamais activé (abonnement incompatible
  -- au moment du paiement) : le client n'a rien reçu, tout lui est dû.
  v_undelivered := v_order.status not in ('paid', 'refunded')
    and coalesce(v_order.failure_code, '') in ('business_plan_change_not_supported', 'business_subscription_managed_elsewhere')
    and v_order.provider_status = 'SUCCESS' and v_order.provider_payment_id is not null
    and v_order.subscription_id is null and v_order.billing_event_id is null;
  -- Une « journée » vaut 24 h exactes (86 400 s), comptées à rebours depuis la
  -- fin de période : le calcul ne dépend ni du fuseau horaire de la session ni
  -- des changements d'heure, et ne s'appuie sur aucune date de calendrier.
  v_period := make_interval(secs => v_order.period_days * 86400.0);
  if v_order.subscription_id is not null then
    select * into v_sub from saas_business.subscriptions s where s.id = v_order.subscription_id;
    v_has_sub := found;
  end if;
  -- L'abonnement a changé de formule depuis cette commande (période terminée,
  -- puis achat d'une autre formule) : la période payée ici est consommée, et le
  -- temps restant appartient à une autre commande.
  v_other_plan := v_has_sub and v_sub.plan_key is distinct from v_order.plan_key;
  if v_has_sub and not v_other_plan and v_sub.status in ('trialing', 'active', 'past_due')
     and v_sub.billing_provider = 'saspay' and v_sub.current_period_end > now() then
    -- La période remboursée est la DERNIÈRE payée : ce qu'il en reste à courir,
    -- en jours entamés (une journée commencée reste due au client).
    v_days := least(v_order.period_days,
      ceil(extract(epoch from v_sub.current_period_end - now()) / 86400)::integer);
    v_new_end := v_sub.current_period_end - v_period;
    v_cancel := v_new_end <= now();
    v_max := floor(v_order.amount_minor::numeric * v_days / v_order.period_days);
  end if;
  if v_undelivered then
    v_days := 0; v_new_end := null; v_cancel := false; v_max := v_order.amount_minor;
  end if;
  v_blocked := case
    when v_order.status = 'refunded' then 'already_refunded'
    when v_undelivered then null
    when v_order.status <> 'paid' then 'refund_requires_paid_order'
    when not v_has_sub then 'refund_subscription_missing'
    when v_other_plan then 'refund_subscription_plan_changed'
    when v_max < 1 then 'refund_nothing_recoverable'
    else null end;
  return jsonb_build_object(
    'product', 'business',
    'order_id', v_order.id,
    'status', v_order.status,
    'internal_reference', v_order.internal_reference,
    'price_xof', v_order.amount_minor,
    'plan_key', v_order.plan_key,
    'period_days', v_order.period_days,
    'subscription_status', case when v_has_sub then v_sub.status end,
    'current_period_end', case when v_has_sub then v_sub.current_period_end end,
    'days_recoverable', v_days,
    'new_period_end', case when v_cancel then null else v_new_end end,
    'will_cancel', v_cancel,
    -- Valeur au prorata du temps restant : plafond de ce qui peut être rendu.
    'max_refund_xof', v_max,
    'needs_partial', v_max < v_order.amount_minor,
    -- Encaissement non livré : remboursement intégral, abonnement inchangé.
    'undelivered', v_undelivered,
    'failure_code', v_order.failure_code,
    'refundable', v_blocked is null,
    'blocked', v_blocked
  );
end $$;
revoke all on function saas_business.vyora_payment_refund_plan(uuid) from public, anon, authenticated, service_role;

-- Enregistre un remboursement Business Grow : retire la période payée (ou met
-- fin à l'abonnement), ramène le quota, clôt la commande. AUCUN ARGENT DÉPLACÉ.
create or replace function public.vyora_admin_refund_business(
  p_order_id uuid,
  p_reason text,
  p_refund_amount_xof bigint,
  p_allow_partial boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
  v_order saas_business.payment_orders%rowtype;
  v_sub saas_business.subscriptions%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_plan jsonb;
  v_cancel boolean;
  v_status text;
  v_start timestamptz;
  v_end timestamptz;
  v_event uuid;
  v_units integer := 0;
begin
  perform ugc_private.reelora_assert_admin();
  if v_reason is null or char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception 'refund_reason_required';
  end if;

  select * into v_order from saas_business.payment_orders o where o.id = p_order_id for update;
  if not found then raise exception 'payment_order_not_found'; end if;
  if v_order.status = 'refunded' then
    return saas_business.vyora_payment_order_json(v_order) || saas_business.vyora_payment_refund_json(v_order)
      || jsonb_build_object('outcome', 'already_refunded');
  end if;
  if v_order.subscription_id is not null then
    select * into v_sub from saas_business.subscriptions s where s.id = v_order.subscription_id for update;
  end if;

  v_plan := saas_business.vyora_payment_refund_plan(p_order_id);
  if v_plan->>'blocked' is not null then raise exception '%', v_plan->>'blocked'; end if;
  if (v_plan->>'needs_partial')::boolean and not coalesce(p_allow_partial, false) then
    raise exception 'refund_period_already_consumed';
  end if;
  if p_refund_amount_xof is null or p_refund_amount_xof < 1
     or p_refund_amount_xof > (v_plan->>'max_refund_xof')::bigint then
    raise exception 'refund_amount_out_of_bounds';
  end if;

  if (v_plan->>'undelivered')::boolean then
    -- Rien n'a été livré : le montant rendu est le montant encaissé, ni plus ni
    -- moins, et l'abonnement en cours (payé par une autre commande) reste intact.
    if p_refund_amount_xof <> v_order.amount_minor then raise exception 'refund_amount_out_of_bounds'; end if;
    update saas_business.payment_orders
       set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered',
           refund_reason = v_reason, refund_amount_minor = p_refund_amount_xof,
           refund_days_recovered = 0, refund_units_recovered = 0, refund_recorded_by = v_admin
     where id = p_order_id returning * into v_order;
    insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
    values (v_admin, 'saspay_refund_recorded', 'business_payment_order', p_order_id::text,
      jsonb_build_object('actor', 'admin', 'product', 'business', 'customer', v_order.user_id, 'reason', v_reason,
        'refund_amount_minor', p_refund_amount_xof, 'days_recovered', 0, 'units_recovered', 0,
        'undelivered', true, 'failure_code', v_order.failure_code, 'partial', false));
    return saas_business.vyora_payment_order_json(v_order) || saas_business.vyora_payment_refund_json(v_order)
      || jsonb_build_object('outcome', 'refunded', 'undelivered', true);
  end if;

  v_cancel := (v_plan->>'will_cancel')::boolean;
  v_start := coalesce(v_sub.current_period_start, v_sub.created_at);
  if v_cancel then
    v_status := 'canceled';
    v_end := greatest(now(), v_start + interval '1 second');
  else
    v_status := v_sub.status;
    v_end := (v_plan->>'new_period_end')::timestamptz;
  end if;
  v_event := saas_business.vyora_apply_subscription_event(
    'saspay:refund:' || v_order.id::text, 'transaction.refunded', v_sub, v_status, v_start, v_end,
    jsonb_build_object('payment_order_id', v_order.id, 'reason', 'refund'));
  if v_cancel then
    v_units := saas_business.vyora_reset_wallet_allowance(v_order.user_id, 'Remboursement ' || v_order.plan_label);
  end if;

  update saas_business.payment_orders
     set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered',
         refund_reason = v_reason, refund_amount_minor = p_refund_amount_xof,
         refund_days_recovered = (v_plan->>'days_recoverable')::integer,
         refund_units_recovered = v_units, refund_subscription_status = v_status,
         refund_billing_event_id = v_event, refund_recorded_by = v_admin
   where id = p_order_id returning * into v_order;

  -- Journal d'audit commun de l'administration (qui, quoi, pourquoi).
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (v_admin, 'saspay_refund_recorded', 'business_payment_order', p_order_id::text,
    jsonb_build_object('actor', 'admin', 'product', 'business', 'customer', v_order.user_id, 'reason', v_reason,
      'refund_amount_minor', p_refund_amount_xof, 'days_recovered', (v_plan->>'days_recoverable')::integer,
      'units_recovered', v_units, 'subscription_status', v_status, 'partial', (v_plan->>'needs_partial')::boolean));

  return saas_business.vyora_payment_order_json(v_order) || saas_business.vyora_payment_refund_json(v_order)
    || jsonb_build_object('outcome', 'refunded');
end $$;

-- =============================================================================
-- 3. REMBOURSEMENTS — aperçu et attestation (administrateur)
-- =============================================================================
create or replace function public.vyora_admin_refund_preview(p_product text, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_product = 'studio' then return ugc_private.vyora_studio_refund_plan(p_order_id); end if;
  if p_product = 'business' then return saas_business.vyora_payment_refund_plan(p_order_id); end if;
  raise exception 'invalid_product';
end $$;

-- L'exploitant atteste avoir rendu l'argent (référence du versement à l'appui).
create or replace function public.vyora_admin_refund_settle(p_product text, p_order_id uuid, p_external_reference text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
  v_ref text := nullif(trim(coalesce(p_external_reference, '')), '');
  v_studio saas_ugc.ugc_recharge_orders%rowtype;
  v_bg saas_business.payment_orders%rowtype;
begin
  perform ugc_private.reelora_assert_admin();
  if v_ref is null or char_length(v_ref) < 3 or char_length(v_ref) > 120 then
    raise exception 'refund_settlement_requires_reference';
  end if;
  if p_product = 'studio' then
    select * into v_studio from saas_ugc.ugc_recharge_orders o
     where o.id = p_order_id and o.provider = 'saspay' for update;
    if not found then raise exception 'payment_order_not_found'; end if;
    if v_studio.status <> 'refunded' then raise exception 'refund_not_recorded'; end if;
    if v_studio.refund_state = 'settled' then
      if v_studio.refund_external_reference <> v_ref then raise exception 'refund_already_settled'; end if;
    else
      update saas_ugc.ugc_recharge_orders
         set refund_state = 'settled', refund_external_reference = v_ref,
             refund_settled_at = now(), refund_settled_by = v_admin
       where id = p_order_id returning * into v_studio;
      insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
      values (v_admin, 'saspay_refund_settled', 'recharge_order', p_order_id::text,
        jsonb_build_object('actor', 'admin', 'customer', v_studio.user_id, 'external_reference', v_ref,
          'refund_amount_minor', v_studio.refund_amount_minor));
      insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
      values (v_studio.user_id, 'Remboursement effectué',
        'Votre remboursement de ' || (v_studio.refund_amount_minor / 100)::text || ' FCFA a été versé.',
        'success', '/app/credits');
    end if;
    return ugc_private.vyora_studio_order_json(v_studio) || ugc_private.vyora_studio_refund_json(v_studio);
  elsif p_product = 'business' then
    select * into v_bg from saas_business.payment_orders o where o.id = p_order_id for update;
    if not found then raise exception 'payment_order_not_found'; end if;
    if v_bg.status <> 'refunded' then raise exception 'refund_not_recorded'; end if;
    if v_bg.refund_state = 'settled' then
      if v_bg.refund_external_reference <> v_ref then raise exception 'refund_already_settled'; end if;
    else
      update saas_business.payment_orders
         set refund_state = 'settled', refund_external_reference = v_ref,
             refund_settled_at = now(), refund_settled_by = v_admin
       where id = p_order_id returning * into v_bg;
      insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
      values (v_admin, 'saspay_refund_settled', 'business_payment_order', p_order_id::text,
        jsonb_build_object('actor', 'admin', 'product', 'business', 'customer', v_bg.user_id,
          'external_reference', v_ref, 'refund_amount_minor', v_bg.refund_amount_minor));
      -- L'argent d'un encaissement non activable est rendu : l'anomalie est close.
      -- (La table des anomalies est créée plus bas dans cette migration ; elle
      -- existe toujours au moment où cette fonction est appelée.)
      update saas_ugc.vyora_payment_anomalies a
         set resolved_at = now(), resolved_by = v_admin,
             resolution_note = left('Remboursé au client — versement ' || v_ref, 500)
       where a.kind = 'subscription_conflict' and a.product = 'business'
         and a.order_id = p_order_id and a.resolved_at is null;
    end if;
    return saas_business.vyora_payment_order_json(v_bg) || saas_business.vyora_payment_refund_json(v_bg);
  end if;
  raise exception 'invalid_product';
end $$;

-- Listes : ajout des informations de remboursement.
create or replace function ugc_private.vyora_client_order_view(p_order jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  -- Le motif et la référence du versement sont des notes internes.
  select (p_order - array['user_id', 'provider_payment_id', 'provider_session_id', 'pricing_snapshot',
                          'refund_reason', 'refund_external_reference', 'refund_subscription_status'])
         || jsonb_build_object('has_payment',
              (p_order->>'provider_payment_id') is not null or (p_order->>'provider_session_id') is not null)
$$;
revoke all on function ugc_private.vyora_client_order_view(jsonb) from public, anon, authenticated;

create or replace function public.vyora_my_payments(p_product text, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if p_product = 'studio' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select ugc_private.vyora_client_order_view(
                       ugc_private.vyora_studio_order_json(r) || ugc_private.vyora_studio_refund_json(r)) as j,
                     r.created_at
                from saas_ugc.ugc_recharge_orders r
               where r.user_id = v_user and r.provider = 'saspay'
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  elsif p_product = 'business' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select ugc_private.vyora_client_order_view(
                       saas_business.vyora_payment_order_json(r) || saas_business.vyora_payment_refund_json(r)) as j,
                     r.created_at
                from saas_business.payment_orders r
               where r.user_id = v_user
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  end if;
  raise exception 'invalid_product';
end $$;

create or replace function public.vyora_admin_payments(p_product text, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 300);
begin
  perform ugc_private.reelora_assert_admin();
  if p_product = 'studio' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select ugc_private.vyora_studio_order_json(r) || ugc_private.vyora_studio_refund_json(r)
                     || jsonb_build_object('user_email', (select u.email from auth.users u where u.id = r.user_id)) as j,
                     r.created_at
                from saas_ugc.ugc_recharge_orders r
               where r.provider = 'saspay'
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  elsif p_product = 'business' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select saas_business.vyora_payment_order_json(r) || saas_business.vyora_payment_refund_json(r)
                     || jsonb_build_object('user_email', (select u.email from auth.users u where u.id = r.user_id)) as j,
                     r.created_at
                from saas_business.payment_orders r
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  end if;
  raise exception 'invalid_product';
end $$;

-- =============================================================================
-- 4. RÉCONCILIATION — journaux
-- =============================================================================
-- Journal d'exploitation du service de paiement (les deux produits y figurent,
-- sans aucune donnée de portefeuille). Accès par fonctions uniquement.
create table if not exists saas_ugc.vyora_payment_reconcile_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source text not null default 'cron',
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'error', 'skipped')),
  checked integer not null default 0,
  settled integer not null default 0,
  closed integer not null default 0,
  errors integer not null default 0,
  swept integer not null default 0,
  anomalies integer not null default 0,
  sweep_done boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists vyora_payment_reconcile_runs_started_idx
  on saas_ugc.vyora_payment_reconcile_runs(started_at desc);
-- Une seule exécution « en cours » peut exister : garanti par la base elle-même.
create unique index if not exists vyora_payment_reconcile_runs_single_running_idx
  on saas_ugc.vyora_payment_reconcile_runs((true)) where status = 'running';

create table if not exists saas_ugc.vyora_payment_anomalies (
  id uuid primary key default gen_random_uuid(),
  dedup_key text not null unique,
  kind text not null,
  product text check (product is null or product in ('studio', 'business')),
  order_id uuid,
  internal_reference text,
  provider_payment_id text,
  details jsonb not null default '{}'::jsonb,
  seen_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text
);
-- Genres d'anomalie (contrainte nommée, rejouable) :
--   order_stuck           commande sans issue depuis plus de 24 h
--   duplicate_payment     second encaissement pour une commande déjà réglée
--   payment_conflict      encaissement portant la référence d'une commande liée à un autre paiement
--   amount_mismatch       montant ou devise encaissés différents de la commande
--   payment_not_found     paiement inconnu de SasPay
--   subscription_conflict encaissement Business Grow incompatible avec l'abonnement en cours (rien livré)
--   sweep_unreliable      le balayage des transactions SasPay ne peut pas jouer son rôle de filet
--   initiation_unconfirmed  création softpay restée sans réponse : commande en rapprochement manuel
alter table saas_ugc.vyora_payment_anomalies drop constraint if exists vyora_payment_anomalies_kind_check;
alter table saas_ugc.vyora_payment_anomalies add constraint vyora_payment_anomalies_kind_check
  check (kind in ('order_stuck', 'duplicate_payment', 'payment_conflict', 'amount_mismatch', 'payment_not_found',
                  'subscription_conflict', 'sweep_unreliable', 'initiation_unconfirmed'));
create index if not exists vyora_payment_anomalies_open_idx
  on saas_ugc.vyora_payment_anomalies(last_seen_at desc) where resolved_at is null;

alter table saas_ugc.vyora_payment_reconcile_runs enable row level security;
alter table saas_ugc.vyora_payment_reconcile_runs force row level security;
alter table saas_ugc.vyora_payment_anomalies enable row level security;
alter table saas_ugc.vyora_payment_anomalies force row level security;
revoke all on saas_ugc.vyora_payment_reconcile_runs from public, anon, authenticated, service_role;
revoke all on saas_ugc.vyora_payment_anomalies from public, anon, authenticated, service_role;

-- Signale une anomalie (une seule ligne par anomalie) et prévient les
-- administrateurs la première fois.
create or replace function ugc_private.vyora_payment_flag_anomaly(
  p_kind text, p_product text, p_order_id uuid, p_payment_id text, p_reference text, p_details jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := p_kind || ':' || coalesce(p_order_id::text, '-') || ':' || coalesce(p_payment_id, '-');
  v_new boolean;
  v_title text := case p_kind
    when 'order_stuck' then 'Paiement SasPay bloqué depuis plus de 24 h'
    when 'duplicate_payment' then 'Double paiement SasPay détecté'
    when 'payment_conflict' then 'Paiement SasPay non rattachable'
    when 'amount_mismatch' then 'Montant SasPay différent de la commande'
    when 'subscription_conflict' then 'Paiement Business Grow encaissé mais non activable'
    when 'sweep_unreliable' then 'Filet de sécurité SasPay incomplet'
    when 'initiation_unconfirmed' then 'Paiement Mobile Money à rapprocher manuellement'
    else 'Paiement SasPay introuvable chez le prestataire' end;
begin
  insert into saas_ugc.vyora_payment_anomalies(dedup_key, kind, product, order_id, internal_reference, provider_payment_id, details)
  values (v_key, p_kind, p_product, p_order_id, nullif(left(coalesce(p_reference, ''), 80), ''),
          nullif(left(coalesce(p_payment_id, ''), 80), ''), coalesce(p_details, '{}'::jsonb))
  on conflict (dedup_key) do update
     set seen_count = saas_ugc.vyora_payment_anomalies.seen_count + 1, last_seen_at = now()
  returning (xmax = 0) into v_new;
  if v_new then
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    select ur.user_id, v_title,
           'Référence ' || coalesce(p_reference, '—') || '. Ouvrez la console d’administration, onglet SasPay.',
           'warning', '/admin'
      from saas_ugc.ugc_user_roles ur where ur.role = 'admin';
  end if;
  return v_new;
end $$;
revoke all on function ugc_private.vyora_payment_flag_anomaly(text, text, uuid, text, text, jsonb) from public, anon, authenticated;

create or replace function public.vyora_payment_report_anomaly(
  p_kind text, p_product text, p_order_id uuid, p_payment_id text, p_reference text, p_details jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product is not null and p_product not in ('studio', 'business') then raise exception 'invalid_product'; end if;
  return ugc_private.vyora_payment_flag_anomaly(p_kind, p_product, p_order_id, p_payment_id, p_reference, p_details);
end $$;

-- =============================================================================
-- 4 bis. CRÉATION SOFTPAY RESTÉE SANS RÉPONSE — tentatives et rapprochement manuel
-- =============================================================================
-- Le problème : `POST /payments/softpay/` peut aboutir chez SasPay (la demande
-- est poussée sur le téléphone, le client valide, l'argent est encaissé) sans
-- que sa réponse — donc l'identifiant du paiement — ne nous parvienne. Sans cet
-- identifiant, ni `verify` ni un webhook ne permettent de relier l'encaissement
-- à la commande.
--
-- Ce que la documentation SasPay garantit (lue le 2026-11-12) :
--   * le rejeu de la MÊME requête avec la MÊME `Idempotency-Key` rend la réponse
--     d'origine. Aucune durée de conservation de la clé n'est documentée : le
--     rejeu n'est donc permis que pendant une fenêtre courte après la première
--     tentative, avec le corps EXACT enregistré ici ;
--   * aucune référence marchande n'est recherchable : `GET /transactions/?search=`
--     ne porte que sur la référence SasPay, la référence du réseau, le nom,
--     l'e-mail et le téléphone du client ;
--   * le libellé (`description`) et `metadata` ne figurent dans aucun schéma de
--     réponse — seulement dans des exemples. Ils servent de preuve QUAND ils
--     sont renvoyés, jamais d'hypothèse.
--
-- La règle : une commande dont une tentative a été lancée sans issue connue
-- n'est JAMAIS close comme « non payée » par un automate, et jamais « payée »
-- sans vérification SasPay. Passé la fenêtre de rejeu, elle entre en
-- rapprochement manuel : alerte administrateur, aucun nouveau paiement possible
-- pour ce client tant qu'un humain (ou une preuve) n'a pas tranché.
create table if not exists saas_ugc.vyora_payment_initiations (
  product text not null check (product in ('studio', 'business')),
  order_id uuid not null,
  user_id uuid not null,
  internal_reference text not null,
  -- Corps EXACT envoyé à SasPay (rejeu à l'identique). Contient le numéro du
  -- payeur : effacé dès que l'issue est connue.
  request jsonb,
  -- Montant et numéro masqué conservés pour le rapprochement une fois `request` effacé.
  amount text,
  currency text,
  network_code text,
  payer_msisdn_masked text,
  attempts integer not null default 1,
  -- started : appel en cours · unknown : issue inconnue · attached : paiement
  -- identifié · refused : refus certain · closed : commande close.
  outcome text not null default 'started'
    check (outcome in ('started', 'unknown', 'attached', 'refused', 'closed')),
  last_error text,
  first_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz not null default now(),
  -- Entrée en rapprochement manuel (plus aucun rejeu possible).
  review_at timestamptz,
  -- Transactions SasPay candidates (même numéro, même montant, même fenêtre).
  candidates jsonb not null default '[]'::jsonb,
  last_search_at timestamptz,
  search_count integer not null default 0,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  primary key (product, order_id)
);
create index if not exists vyora_payment_initiations_open_idx
  on saas_ugc.vyora_payment_initiations(user_id) where resolved_at is null;
alter table saas_ugc.vyora_payment_initiations enable row level security;
alter table saas_ugc.vyora_payment_initiations force row level security;
revoke all on saas_ugc.vyora_payment_initiations from public, anon, authenticated, service_role;

-- Une tentative « incertaine » : issue inconnue, ou appel lancé puis jamais
-- conclu (fonction interrompue). Un appel lancé depuis moins de 60 s est
-- simplement en cours.
create or replace function ugc_private.vyora_payment_initiation_uncertain(i saas_ugc.vyora_payment_initiations)
returns boolean
language sql
stable
set search_path = ''
as $$
  select i.resolved_at is null
     and (i.outcome = 'unknown' or (i.outcome = 'started' and i.last_attempt_at < now() - interval '60 seconds'));
$$;
revoke all on function ugc_private.vyora_payment_initiation_uncertain(saas_ugc.vyora_payment_initiations) from public, anon, authenticated;

-- Fenêtre de rejeu (minutes) et nombre maximal de relances par le client.
create or replace function ugc_private.vyora_payment_replay_window()
returns interval
language sql
stable
security definer
set search_path = ''
as $$
  select make_interval(mins => least(greatest(coalesce(
    (ugc_private.vyora_payment_config()->>'initiation_replay_minutes')::integer, 10), 1), 30));
$$;
create or replace function ugc_private.vyora_payment_replay_attempts()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select least(greatest(coalesce(
    (ugc_private.vyora_payment_config()->>'initiation_max_attempts')::integer, 4), 1), 10);
$$;
revoke all on function ugc_private.vyora_payment_replay_window() from public, anon, authenticated;
revoke all on function ugc_private.vyora_payment_replay_attempts() from public, anon, authenticated;

-- Fait entrer une commande en rapprochement manuel. Ordre des verrous, partout :
-- commande → tentative → anomalie.
create or replace function ugc_private.vyora_payment_open_review(p_product text, p_order_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row saas_ugc.vyora_payment_initiations%rowtype;
  v_open boolean;
begin
  if p_product = 'studio' then
    select true into v_open from saas_ugc.ugc_recharge_orders o
     where o.id = p_order_id and o.provider = 'saspay' and o.status = 'pending'
       and o.provider_payment_id is null and o.provider_session_id is null
     for update;
  else
    select true into v_open from saas_business.payment_orders o
     where o.id = p_order_id and o.status = 'pending'
       and o.provider_payment_id is null and o.provider_session_id is null
     for update;
  end if;
  if not coalesce(v_open, false) then return false; end if;

  update saas_ugc.vyora_payment_initiations
     set review_at = now(), outcome = 'unknown'
   where product = p_product and order_id = p_order_id and resolved_at is null and review_at is null
   returning * into v_row;
  if not found then return false; end if;

  if p_product = 'studio' then
    update saas_ugc.ugc_recharge_orders set failure_code = 'manual_review' where id = p_order_id;
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_row.user_id, 'Paiement en cours de vérification',
      'Nous n’avons pas pu confirmer votre paiement ' || v_row.internal_reference
      || '. Notre équipe le vérifie : ne payez pas une seconde fois. Si vous avez été débité, vos crédits seront ajoutés.',
      'info', '/app/credits');
  else
    update saas_business.payment_orders set failure_code = 'manual_review' where id = p_order_id;
  end if;

  perform ugc_private.vyora_payment_flag_anomaly('initiation_unconfirmed', p_product, p_order_id, null,
    v_row.internal_reference, jsonb_build_object(
      'reason', coalesce(p_reason, 'replay_window_elapsed'),
      'amount', v_row.amount, 'currency', v_row.currency, 'network', v_row.network_code,
      'payer_msisdn_masked', v_row.payer_msisdn_masked, 'attempts', v_row.attempts,
      'first_attempt_at', v_row.first_attempt_at, 'last_attempt_at', v_row.last_attempt_at,
      'last_error', v_row.last_error, 'candidates', v_row.candidates));
  return true;
end $$;
revoke all on function ugc_private.vyora_payment_open_review(text, uuid, text) from public, anon, authenticated;

-- Autorise (ou refuse) un appel `POST /payments/softpay/` et l'enregistre AVANT
-- qu'il ne parte. Renvoie le corps à envoyer : celui de la première tentative,
-- à l'identique — un rejeu ne peut donc ni changer de numéro ni être rejeté par
-- SasPay pour « même clé, corps différent ».
create or replace function public.vyora_payment_begin_initiation(p_product text, p_order_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_ref text;
  v_status text;
  v_payment text;
  v_session text;
  v_flow text;
  v_network text;
  v_masked text;
  v_other boolean;
  v_row saas_ugc.vyora_payment_initiations%rowtype;
  v_window interval := ugc_private.vyora_payment_replay_window();
  v_max integer := ugc_private.vyora_payment_replay_attempts();
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product = 'studio' then
    select o.user_id into v_user from saas_ugc.ugc_recharge_orders o where o.id = p_order_id and o.provider = 'saspay';
  elsif p_product = 'business' then
    select o.user_id into v_user from saas_business.payment_orders o where o.id = p_order_id;
  else
    raise exception 'invalid_product';
  end if;
  if v_user is null then raise exception 'payment_order_not_found'; end if;

  -- Un seul paiement incertain à la fois par client, tous produits confondus.
  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-init:' || v_user::text, 0));
  if p_product = 'studio' then
    select o.internal_reference, o.status, o.provider_payment_id, o.provider_session_id, o.payment_flow,
           o.network_code, o.payer_msisdn_masked
      into v_ref, v_status, v_payment, v_session, v_flow, v_network, v_masked
      from saas_ugc.ugc_recharge_orders o where o.id = p_order_id for update;
  else
    select o.internal_reference, o.status, o.provider_payment_id, o.provider_session_id, o.payment_flow,
           o.network_code, o.payer_msisdn_masked
      into v_ref, v_status, v_payment, v_session, v_flow, v_network, v_masked
      from saas_business.payment_orders o where o.id = p_order_id for update;
  end if;
  if v_flow is distinct from 'softpay' then raise exception 'initiation_requires_softpay'; end if;
  if v_status <> 'pending' or v_payment is not null or v_session is not null then
    return jsonb_build_object('allowed', false, 'reason', 'not_pending');
  end if;

  -- Toute AUTRE tentative non soldée du client bloque celle-ci : incertaine
  -- (rapprochement à faire) ou simplement en vol (issue attendue sous peu).
  -- (`bool_or` vaut NULL quand il n'y en a aucune.)
  select bool_or(ugc_private.vyora_payment_initiation_uncertain(i)) into v_other
    from saas_ugc.vyora_payment_initiations i
   where i.user_id = v_user and i.resolved_at is null
     and (i.product, i.order_id) is distinct from (p_product, p_order_id);
  if v_other is not null then
    return jsonb_build_object('allowed', false, 'reason',
      case when v_other then 'other_payment_unconfirmed' else 'other_payment_in_progress' end);
  end if;

  select * into v_row from saas_ugc.vyora_payment_initiations i
   where i.product = p_product and i.order_id = p_order_id for update;
  if found then
    if v_row.resolved_at is not null then
      return jsonb_build_object('allowed', false, 'reason', 'not_pending');
    end if;
    if v_row.review_at is not null then
      return jsonb_build_object('allowed', false, 'reason', 'under_review');
    end if;
    -- Hors fenêtre ou relances épuisées : plus aucun rejeu. La conservation de
    -- la clé d'idempotence n'étant pas documentée, un rejeu tardif pourrait
    -- pousser une SECONDE demande de paiement pour une commande déjà encaissée.
    if v_row.attempts >= v_max or now() > v_row.first_attempt_at + v_window then
      perform ugc_private.vyora_payment_open_review(p_product, p_order_id,
        case when v_row.attempts >= v_max then 'attempts_exhausted' else 'replay_window_elapsed' end);
      return jsonb_build_object('allowed', false, 'reason', 'under_review');
    end if;
    if v_row.outcome = 'started' and v_row.last_attempt_at > now() - interval '20 seconds' then
      return jsonb_build_object('allowed', false, 'reason', 'attempt_in_progress');
    end if;
    update saas_ugc.vyora_payment_initiations
       set attempts = attempts + 1, last_attempt_at = now(), outcome = 'started'
     where product = p_product and order_id = p_order_id
     returning * into v_row;
  else
    if p_request is null or jsonb_typeof(p_request) <> 'object'
       or coalesce(p_request->>'amount', '') = '' or coalesce(p_request->'customer'->>'phone', '') = '' then
      raise exception 'initiation_request_required';
    end if;
    insert into saas_ugc.vyora_payment_initiations(
      product, order_id, user_id, internal_reference, request, amount, currency, network_code, payer_msisdn_masked)
    values (p_product, p_order_id, v_user, v_ref, p_request, p_request->>'amount', p_request->>'currency',
            v_network, v_masked)
    returning * into v_row;
  end if;

  -- Dès que l'appel part, la commande est « à confirmer » : elle ne redevient
  -- ordinaire que lorsqu'un identifiant SasPay lui est rattaché.
  if p_product = 'studio' then
    update saas_ugc.ugc_recharge_orders set failure_code = 'initiation_unconfirmed' where id = p_order_id;
  else
    update saas_business.payment_orders set failure_code = 'initiation_unconfirmed' where id = p_order_id;
  end if;
  return jsonb_build_object('allowed', true, 'attempt', v_row.attempts, 'request', v_row.request,
    'replay_until', v_row.first_attempt_at + v_window);
end $$;

-- L'appel s'est terminé sans issue certaine (délai, coupure, erreur serveur).
create or replace function public.vyora_payment_initiation_unknown(p_product text, p_order_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.vyora_assert_service_role();
  update saas_ugc.vyora_payment_initiations
     set outcome = 'unknown', last_error = nullif(left(coalesce(p_error, ''), 80), '')
   where product = p_product and order_id = p_order_id and resolved_at is null;
end $$;

-- Suit la commande : dès qu'un identifiant SasPay lui est rattaché ou qu'elle
-- est close, la tentative est soldée, le corps de requête effacé et l'alerte
-- levée. Ainsi aucun chemin (webhook, vérification, balayage, administrateur)
-- ne peut laisser une commande réglée « en rapprochement ».
create or replace function saas_ugc.vyora_payment_initiation_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product text := tg_argv[0];
  v_identified boolean := new.provider_payment_id is not null or new.provider_session_id is not null;
begin
  if v_product = 'studio' and new.provider is distinct from 'saspay' then return new; end if;
  if not v_identified and new.status = 'pending' then return new; end if;
  if old.failure_code in ('initiation_unconfirmed', 'manual_review')
     and new.failure_code is not distinct from old.failure_code then
    new.failure_code := null;
  end if;
  update saas_ugc.vyora_payment_initiations
     set resolved_at = now(), request = null,
         outcome = case when new.provider_payment_id is not null then 'attached'
                        when new.status = 'failed' then 'refused' else 'closed' end
   where product = v_product and order_id = new.id and resolved_at is null;
  if found then
    update saas_ugc.vyora_payment_anomalies
       set resolved_at = now(),
           resolution_note = case when new.provider_payment_id is not null
             then 'Levée automatiquement : paiement SasPay identifié et vérifié.'
             else 'Levée automatiquement : commande close.' end
     where kind = 'initiation_unconfirmed' and order_id = new.id and resolved_at is null;
  end if;
  return new;
end $$;

drop trigger if exists vyora_recharge_initiation_sync on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_initiation_sync
  before update on saas_ugc.ugc_recharge_orders
  for each row execute function saas_ugc.vyora_payment_initiation_sync('studio');
drop trigger if exists vyora_payment_initiation_sync on saas_business.payment_orders;
create trigger vyora_payment_initiation_sync
  before update on saas_business.payment_orders
  for each row execute function saas_ugc.vyora_payment_initiation_sync('business');

-- Tant qu'une tentative du client n'est pas soldée, aucune NOUVELLE commande
-- SasPay ne peut naître (Studio comme Business Grow) : pas de second paiement
-- possible pendant le rapprochement, ni pendant les secondes où l'appel est en
-- vol (une fonction interrompue en plein appel ne laisse donc aucune fenêtre).
-- La reprise de la même commande ne crée pas de ligne et n'est pas concernée.
create or replace function saas_ugc.vyora_payment_block_unconfirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uncertain boolean;
begin
  if tg_argv[0] = 'studio' and new.provider is distinct from 'saspay' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-init:' || new.user_id::text, 0));
  select bool_or(ugc_private.vyora_payment_initiation_uncertain(i)) into v_uncertain
    from saas_ugc.vyora_payment_initiations i
   where i.user_id = new.user_id and i.resolved_at is null;
  if v_uncertain then raise exception 'payment_under_review'; end if;
  if v_uncertain is not null then raise exception 'payment_attempt_in_progress'; end if;
  return new;
end $$;

drop trigger if exists vyora_recharge_block_unconfirmed on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_block_unconfirmed
  before insert on saas_ugc.ugc_recharge_orders
  for each row execute function saas_ugc.vyora_payment_block_unconfirmed('studio');
drop trigger if exists vyora_payment_block_unconfirmed on saas_business.payment_orders;
create trigger vyora_payment_block_unconfirmed
  before insert on saas_business.payment_orders
  for each row execute function saas_ugc.vyora_payment_block_unconfirmed('business');

revoke all on function saas_ugc.vyora_payment_initiation_sync() from public, anon, authenticated, service_role;
revoke all on function saas_ugc.vyora_payment_block_unconfirmed() from public, anon, authenticated, service_role;

-- Commandes incertaines à rechercher chez SasPay (lecture seule) : toutes les
-- 4 min la première heure, 30 min le premier jour, 6 h ensuite (30 jours).
-- `p_due_only = false` : toutes les commandes incertaines (webhook entrant).
create or replace function public.vyora_payment_unconfirmed(p_limit integer default 10, p_due_only boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.vyora_assert_service_or_cron();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'product', x.product, 'order_id', x.order_id, 'internal_reference', x.internal_reference,
             'phone', x.request->'customer'->>'phone', 'amount', x.amount, 'currency', x.currency,
             'first_attempt_at', x.first_attempt_at, 'last_attempt_at', x.last_attempt_at,
             'in_review', x.review_at is not null)
           order by coalesce(x.last_search_at, '-infinity'::timestamptz), x.first_attempt_at)
      from (
        select i.* from saas_ugc.vyora_payment_initiations i
         where ugc_private.vyora_payment_initiation_uncertain(i)
           and i.first_attempt_at > now() - interval '30 days'
           and (not coalesce(p_due_only, true)
                or coalesce(i.last_search_at, '-infinity'::timestamptz) < now() - case
                     when i.first_attempt_at > now() - interval '1 hour' then interval '4 minutes'
                     when i.first_attempt_at > now() - interval '24 hours' then interval '30 minutes'
                     else interval '6 hours' end)
         order by coalesce(i.last_search_at, '-infinity'::timestamptz), i.first_attempt_at
         limit least(greatest(coalesce(p_limit, 10), 1), 25)
      ) x), '[]'::jsonb);
end $$;

-- Résultat d'une recherche SasPay pour une commande incertaine : les
-- transactions candidates sont consignées pour l'administrateur. Rien n'est livré.
create or replace function public.vyora_payment_note_candidates(p_product text, p_order_id uuid, p_candidates jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list jsonb := case when jsonb_typeof(p_candidates) = 'array' then p_candidates else '[]'::jsonb end;
begin
  perform ugc_private.vyora_assert_service_role();
  -- Le résultat d'une recherche remplace le précédent, mais conserve les
  -- transactions annoncées par un webhook : la recherche peut ne pas les voir.
  update saas_ugc.vyora_payment_initiations i
     set candidates = coalesce((
           select jsonb_agg(c) from jsonb_array_elements(i.candidates) c
            where c->>'source' = 'webhook'
              and not exists (select 1 from jsonb_array_elements(v_list) n where n->>'id' = c->>'id')), '[]'::jsonb) || v_list,
         last_search_at = now(), search_count = search_count + 1
   where i.product = p_product and i.order_id = p_order_id and i.resolved_at is null
   returning i.candidates into v_list;
  if found then
    update saas_ugc.vyora_payment_anomalies
       set details = details || jsonb_build_object('candidates', v_list, 'searched_at', now())
     where kind = 'initiation_unconfirmed' and order_id = p_order_id and resolved_at is null;
  end if;
end $$;

-- Un webhook signé annonce une transaction inconnue qui RESSEMBLE à la commande
-- (montant, devise, date) sans que SasPay n'en restitue la référence : elle est
-- proposée à l'administrateur. Rien n'est rattaché ni livré.
create or replace function public.vyora_payment_add_candidate(p_product text, p_order_id uuid, p_candidate jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list jsonb;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_candidate is null or jsonb_typeof(p_candidate) <> 'object' or coalesce(p_candidate->>'id', '') = '' then
    raise exception 'candidate_required';
  end if;
  update saas_ugc.vyora_payment_initiations i
     set candidates = i.candidates || jsonb_build_array(p_candidate)
   where i.product = p_product and i.order_id = p_order_id and i.resolved_at is null
     and jsonb_array_length(i.candidates) < 20
     and not exists (select 1 from jsonb_array_elements(i.candidates) c where c->>'id' = p_candidate->>'id')
   returning i.candidates into v_list;
  if found then
    update saas_ugc.vyora_payment_anomalies
       set details = details || jsonb_build_object('candidates', v_list)
     where kind = 'initiation_unconfirmed' and order_id = p_order_id and resolved_at is null;
  end if;
end $$;

-- Trace de la décision « rattacher ce paiement » prise par un administrateur.
-- Le rattachement lui-même passe par le règlement ordinaire (vérification SasPay).
create or replace function public.vyora_payment_review_attached(
  p_admin uuid, p_product text, p_order_id uuid, p_payment_id text, p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_note text := nullif(left(trim(coalesce(p_note, '')), 500), '');
begin
  perform ugc_private.vyora_assert_service_role();
  if not exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_admin and r.role = 'admin') then
    raise exception 'admin_required';
  end if;
  update saas_ugc.vyora_payment_initiations
     set resolved_by = p_admin, resolution_note = v_note
   where product = p_product and order_id = p_order_id;
  update saas_ugc.vyora_payment_anomalies
     set resolved_by = p_admin,
         resolution_note = 'Paiement ' || left(coalesce(p_payment_id, ''), 80) || ' rattaché par un administrateur. ' || coalesce(v_note, '')
   where kind = 'initiation_unconfirmed' and order_id = p_order_id and resolved_at is not null and resolved_by is null;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (p_admin, 'saspay_review_payment_attached', 'payment_order', p_order_id::text,
    jsonb_build_object('actor', 'admin', 'product', p_product, 'payment_id', left(coalesce(p_payment_id, ''), 80), 'note', v_note));
end $$;

-- Décision « aucun encaissement » : l'administrateur atteste avoir vérifié,
-- dans le tableau de bord SasPay, qu'aucune transaction ne correspond. La
-- commande est close sans rien livrer et le client peut de nouveau payer. Si un
-- encaissement apparaissait malgré tout, le règlement rouvrirait la commande.
create or replace function public.vyora_admin_close_unconfirmed(p_product text, p_order_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_row saas_ugc.vyora_payment_initiations%rowtype;
  v_open boolean;
begin
  perform ugc_private.reelora_assert_admin();
  if p_product not in ('studio', 'business') then raise exception 'invalid_product'; end if;
  if v_note is null or char_length(v_note) < 10 or char_length(v_note) > 500 then
    raise exception 'review_note_required';
  end if;
  if p_product = 'studio' then
    select true into v_open from saas_ugc.ugc_recharge_orders o
     where o.id = p_order_id and o.provider = 'saspay' and o.status = 'pending'
       and o.provider_payment_id is null and o.provider_session_id is null
     for update;
  else
    select true into v_open from saas_business.payment_orders o
     where o.id = p_order_id and o.status = 'pending'
       and o.provider_payment_id is null and o.provider_session_id is null
     for update;
  end if;
  select * into v_row from saas_ugc.vyora_payment_initiations i
   where i.product = p_product and i.order_id = p_order_id for update;
  -- Seulement en rapprochement manuel : pendant la fenêtre de rejeu, le client
  -- peut encore relancer la même demande et obtenir l'identifiant.
  if not coalesce(v_open, false) or v_row.order_id is null or v_row.resolved_at is not null
     or v_row.review_at is null then
    raise exception 'payment_not_under_review';
  end if;

  update saas_ugc.vyora_payment_anomalies
     set resolved_at = now(), resolved_by = v_admin,
         resolution_note = 'Aucun encaissement constaté chez SasPay. ' || v_note
   where kind = 'initiation_unconfirmed' and order_id = p_order_id and resolved_at is null;
  if p_product = 'studio' then
    update saas_ugc.ugc_recharge_orders
       set status = 'cancelled', failure_code = 'unconfirmed_closed' where id = p_order_id;
    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_row.user_id, 'Paiement non abouti',
      'Après vérification, aucun encaissement n’a été trouvé pour votre commande ' || v_row.internal_reference
      || '. Vous n’avez pas été débité par VYORA ; vous pouvez relancer un paiement.',
      'info', '/app/credits');
  else
    update saas_business.payment_orders
       set status = 'cancelled', failure_code = 'unconfirmed_closed' where id = p_order_id;
  end if;
  update saas_ugc.vyora_payment_initiations
     set resolved_by = v_admin, resolution_note = v_note
   where product = p_product and order_id = p_order_id;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (v_admin, 'saspay_review_closed_unpaid', 'payment_order', p_order_id::text,
    jsonb_build_object('actor', 'admin', 'product', p_product, 'reference', v_row.internal_reference, 'note', v_note));
  return jsonb_build_object('product', p_product, 'order_id', p_order_id, 'outcome', 'closed_unpaid');
end $$;

-- =============================================================================
-- 5. RÉCONCILIATION — sélection, entretien, exécutions
-- =============================================================================
-- Commandes à revérifier auprès de SasPay.
--   * ouvertes (`pending`/`processing`) ET connues de SasPay : toutes les 4 min
--     la première heure, 30 min le premier jour, 6 h ensuite (30 jours max) ;
--   * closes en échec depuis moins de 72 h : toutes les 6 h — SasPay permet de
--     relancer un paiement échoué, un succès tardif doit être honoré.
create or replace function ugc_private.vyora_payment_due(p_limit integer)
returns table(product text, order_id uuid, internal_reference text, opened_at timestamptz, verified_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select x.product, x.id, x.internal_reference, x.created_at, x.last_verified_at from (
    select 'studio'::text as product, o.id, o.internal_reference, o.created_at, o.last_verified_at, o.status
      from saas_ugc.ugc_recharge_orders o
     where o.provider = 'saspay'
       and (o.provider_payment_id is not null or o.provider_session_id is not null)
       and o.status in ('pending', 'processing', 'failed', 'cancelled')
       and o.created_at > now() - interval '30 days'
    union all
    select 'business'::text, o.id, o.internal_reference, o.created_at, o.last_verified_at, o.status
      from saas_business.payment_orders o
     where (o.provider_payment_id is not null or o.provider_session_id is not null)
       and o.status in ('pending', 'processing', 'failed', 'cancelled')
       and o.created_at > now() - interval '30 days'
  ) x
  where (
      x.status in ('pending', 'processing')
      and x.created_at < now() - interval '2 minutes'
      and coalesce(x.last_verified_at, '-infinity'::timestamptz) < now() - case
            when x.created_at > now() - interval '1 hour' then interval '4 minutes'
            when x.created_at > now() - interval '24 hours' then interval '30 minutes'
            else interval '6 hours' end
    ) or (
      x.status in ('failed', 'cancelled')
      and x.created_at > now() - interval '72 hours'
      and coalesce(x.last_verified_at, '-infinity'::timestamptz) < now() - interval '6 hours'
    )
  order by coalesce(x.last_verified_at, '-infinity'::timestamptz), x.created_at
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
revoke all on function ugc_private.vyora_payment_due(integer) from public, anon, authenticated;

-- Le balayage des transactions SasPay réussies n'a de sens que si une commande
-- SasPay récente existe, et pas plus d'une fois par quart d'heure.
create or replace function ugc_private.vyora_payment_sweep_due()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
      exists (select 1 from saas_ugc.ugc_recharge_orders o
               where o.provider = 'saspay' and o.created_at > now() - interval '72 hours')
      or exists (select 1 from saas_business.payment_orders o
                  where o.created_at > now() - interval '72 hours')
    ) and not exists (
      select 1 from saas_ugc.vyora_payment_reconcile_runs r
       where r.sweep_done and r.finished_at > now() - interval '15 minutes'
    );
$$;
revoke all on function ugc_private.vyora_payment_sweep_due() from public, anon, authenticated;

-- Entretien purement SQL (aucun appel réseau) :
--   * clôt les commandes jamais parvenues à SasPay et arrivées à expiration ;
--   * fait expirer les abonnements Business Grow SasPay arrivés à échéance.
create or replace function public.vyora_payment_housekeeping()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio integer;
  v_business integer;
  v_subs integer := 0;
  v_sub saas_business.subscriptions%rowtype;
  v_reviews integer := 0;
  v_init record;
  v_window interval := ugc_private.vyora_payment_replay_window();
  v_max integer := ugc_private.vyora_payment_replay_attempts();
begin
  perform ugc_private.vyora_assert_service_or_cron();

  -- Création softpay restée sans réponse : passé la fenêtre de rejeu (ou les
  -- relances épuisées), la commande entre en rapprochement manuel. Les lignes
  -- sont lues sans verrou ; chaque passage reprend l'ordre commande → tentative.
  for v_init in
    select i.product, i.order_id, i.attempts from saas_ugc.vyora_payment_initiations i
     where i.resolved_at is null and i.review_at is null
       and i.last_attempt_at < now() - interval '90 seconds'
       and (i.attempts >= v_max or i.first_attempt_at < now() - v_window)
     order by i.first_attempt_at
     limit 100
  loop
    if ugc_private.vyora_payment_open_review(v_init.product, v_init.order_id,
         case when v_init.attempts >= v_max then 'attempts_exhausted' else 'replay_window_elapsed' end) then
      v_reviews := v_reviews + 1;
    end if;
  end loop;

  -- Une commande sans identifiant SasPay ET sans aucune tentative d'appel n'a
  -- jamais été présentée au payeur : elle expire. Dès qu'un appel softpay est
  -- parti sans issue connue, elle n'expire PLUS : la déclarer « non payée »
  -- serait une affirmation sans preuve (voir section 4 bis).
  update saas_ugc.ugc_recharge_orders o
     set status = 'cancelled', failure_code = 'expired_unpaid'
   where o.provider = 'saspay' and o.status = 'pending'
     and o.provider_payment_id is null and o.provider_session_id is null
     and coalesce(o.expires_at, o.created_at + interval '30 minutes') < now() - interval '15 minutes'
     and not exists (select 1 from saas_ugc.vyora_payment_initiations i
                      where i.product = 'studio' and i.order_id = o.id and i.resolved_at is null);
  get diagnostics v_studio = row_count;
  update saas_business.payment_orders o
     set status = 'cancelled', failure_code = 'expired_unpaid'
   where o.status = 'pending'
     and o.provider_payment_id is null and o.provider_session_id is null
     and coalesce(o.expires_at, o.created_at + interval '30 minutes') < now() - interval '15 minutes'
     and not exists (select 1 from saas_ugc.vyora_payment_initiations i
                      where i.product = 'business' and i.order_id = o.id and i.resolved_at is null);
  get diagnostics v_business = row_count;

  for v_sub in
    select * from saas_business.subscriptions s
     where s.billing_provider = 'saspay' and s.status in ('trialing', 'active', 'past_due')
       and s.current_period_end is not null and s.current_period_end < now() - interval '1 hour'
     order by s.current_period_end
     limit 200
     for update skip locked
  loop
    perform saas_business.vyora_apply_subscription_event(
      'saspay:expire:' || v_sub.id::text || ':' || extract(epoch from v_sub.current_period_end)::bigint::text,
      'subscription.expired', v_sub, 'expired',
      coalesce(v_sub.current_period_start, v_sub.created_at), v_sub.current_period_end,
      jsonb_build_object('reason', 'period_ended'));
    perform saas_business.vyora_reset_wallet_allowance(v_sub.user_id, 'Fin d’abonnement Business Grow');
    v_subs := v_subs + 1;
  end loop;

  return jsonb_build_object('expired_studio_orders', v_studio, 'expired_business_orders', v_business,
    'expired_subscriptions', v_subs, 'opened_reviews', v_reviews);
end $$;

-- Lot de travail d'une exécution. Signale au passage les commandes bloquées.
create or replace function public.vyora_payment_reconcile_batch(p_limit integer default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stuck record;
begin
  perform ugc_private.vyora_assert_service_role();
  for v_stuck in
    select d.product, d.order_id, d.internal_reference, d.opened_at
      from ugc_private.vyora_payment_due(50) d
     where d.opened_at < now() - interval '24 hours'
       and exists (
         select 1 from saas_ugc.ugc_recharge_orders o
          where d.product = 'studio' and o.id = d.order_id and o.status in ('pending', 'processing')
         union all
         select 1 from saas_business.payment_orders o
          where d.product = 'business' and o.id = d.order_id and o.status in ('pending', 'processing')
            -- Un refus d'activation a déjà sa propre anomalie (« non activable »).
            and coalesce(o.failure_code, '') not in ('business_plan_change_not_supported', 'business_subscription_managed_elsewhere'))
  loop
    perform ugc_private.vyora_payment_flag_anomaly('order_stuck', v_stuck.product, v_stuck.order_id, null,
      v_stuck.internal_reference, jsonb_build_object('opened_at', v_stuck.opened_at));
  end loop;
  return jsonb_build_object(
    'due', coalesce((
      select jsonb_agg(jsonb_build_object('product', d.product, 'order_id', d.order_id, 'opened_at', d.opened_at))
        from ugc_private.vyora_payment_due(p_limit) d), '[]'::jsonb),
    'sweep', ugc_private.vyora_payment_sweep_due(),
    'sweep_since', now() - interval '72 hours',
    -- Créations softpay sans réponse : à rechercher chez SasPay par numéro.
    'unconfirmed', public.vyora_payment_unconfirmed(10, true)
  );
end $$;

-- Retrouve une commande par sa référence interne (VYS-… / VYB-…).
create or replace function public.vyora_payment_find_by_reference(p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_reference is null or p_reference !~ '^VY[SB]-[0-9A-F]{32}$' then return null; end if;
  if p_reference like 'VYS-%' then
    select o.id into v_id from saas_ugc.ugc_recharge_orders o
     where o.provider = 'saspay' and o.internal_reference = p_reference;
    if v_id is not null then return jsonb_build_object('product', 'studio', 'order_id', v_id); end if;
  else
    select o.id into v_id from saas_business.payment_orders o where o.internal_reference = p_reference;
    if v_id is not null then return jsonb_build_object('product', 'business', 'order_id', v_id); end if;
  end if;
  return null;
end $$;

create or replace function public.vyora_payment_reconcile_start(p_source text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform ugc_private.vyora_assert_service_role();
  -- Deux démarrages simultanés passent l'un après l'autre : le second voit
  -- l'exécution ouverte par le premier et renonce.
  perform pg_advisory_xact_lock(hashtextextended('vyora-payments-reconcile-start', 0));
  -- Une exécution restée « en cours » plus de 10 min a été interrompue.
  update saas_ugc.vyora_payment_reconcile_runs
     set status = 'error', finished_at = now(), detail = detail || '{"error": "interrupted"}'::jsonb
   where status = 'running' and started_at < now() - interval '10 minutes';
  -- Mono-volée : une exécution récente encore en cours fait renoncer la suivante.
  if exists (select 1 from saas_ugc.vyora_payment_reconcile_runs where status = 'running') then
    return null;
  end if;
  insert into saas_ugc.vyora_payment_reconcile_runs(trigger_source)
  values (left(coalesce(nullif(trim(p_source), ''), 'cron'), 40)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.vyora_payment_reconcile_finish(p_run_id uuid, p_status text, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n jsonb := coalesce(p_counts, '{}'::jsonb);
begin
  perform ugc_private.vyora_assert_service_role();
  update saas_ugc.vyora_payment_reconcile_runs
     set status = case when p_status in ('ok', 'partial', 'error', 'skipped') then p_status else 'error' end,
         checked = coalesce((v_n->>'checked')::integer, 0),
         settled = coalesce((v_n->>'settled')::integer, 0),
         closed = coalesce((v_n->>'closed')::integer, 0),
         errors = coalesce((v_n->>'errors')::integer, 0),
         swept = coalesce((v_n->>'swept')::integer, 0),
         anomalies = coalesce((v_n->>'anomalies')::integer, 0),
         sweep_done = coalesce((v_n->>'sweep_done')::boolean, false),
         detail = coalesce(v_n->'detail', '{}'::jsonb),
         finished_at = now()
   where id = p_run_id and status = 'running';
  -- Le journal ne grossit pas indéfiniment.
  delete from saas_ugc.vyora_payment_reconcile_runs where started_at < now() - interval '30 days';
end $$;

-- =============================================================================
-- 6. RÉCONCILIATION — planification (pg_cron → pg_net → Edge Function)
-- =============================================================================
-- Jeton serveur de la tâche : généré une fois dans Vault, jamais affiché.
do $$
begin
  if to_regclass('vault.secrets') is not null then
    if not exists (select 1 from vault.secrets where name = 'vyora_payments_reconcile_token') then
      perform vault.create_secret(
        -- 244 bits d'aléa, sans dépendre de pgcrypto.
        replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
        'vyora_payments_reconcile_token',
        'Jeton serveur de la tâche pg_cron de réconciliation des paiements SasPay (VYORA)'
      );
    end if;
  end if;
end $$;

create or replace function public.vyora_payments_reconcile_token()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  perform ugc_private.vyora_assert_service_or_cron();
  if to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select s.decrypted_secret from vault.decrypted_secrets s where s.name = $1'
    into v_token using 'vyora_payments_reconcile_token';
  return v_token;
end $$;

-- Appelée par pg_cron. Fait l'entretien SQL, puis n'appelle l'Edge Function que
-- s'il y a réellement quelque chose à revérifier auprès de SasPay.
create or replace function public.vyora_payments_reconcile_dispatch()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url constant text := 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-payments-reconcile';
  v_house jsonb;
  v_due integer;
  v_sweep boolean;
  v_unconfirmed integer;
  v_token text;
  v_request bigint;
begin
  perform ugc_private.vyora_assert_service_or_cron();
  if not pg_try_advisory_xact_lock(hashtext('vyora_payments_reconcile')) then
    return jsonb_build_object('dispatched', false, 'reason', 'concurrent_run_in_progress');
  end if;
  v_house := public.vyora_payment_housekeeping();
  select count(*) into v_due from ugc_private.vyora_payment_due(1);
  v_sweep := ugc_private.vyora_payment_sweep_due();
  v_unconfirmed := jsonb_array_length(public.vyora_payment_unconfirmed(1, true));
  if v_due = 0 and not v_sweep and v_unconfirmed = 0 then
    return jsonb_build_object('dispatched', false, 'reason', 'nothing_to_reconcile', 'housekeeping', v_house);
  end if;
  v_token := public.vyora_payments_reconcile_token();
  if coalesce(v_token, '') = '' then
    return jsonb_build_object('dispatched', false, 'reason', 'token_missing', 'housekeeping', v_house);
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 55000)'
    into v_request
    using v_url,
          jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token,
            'x-vyora-cron', 'payments-reconcile'),
          jsonb_build_object('source', 'cron');
  return jsonb_build_object('dispatched', true, 'request_id', v_request, 'due', v_due, 'sweep', v_sweep,
    'unconfirmed', v_unconfirmed, 'housekeeping', v_house);
end $$;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.schedule('vyora-payments-reconcile', '*/5 * * * *',
      'select public.vyora_payments_reconcile_dispatch()');
  end if;
end $$;

-- =============================================================================
-- 7. Vue d'exploitation (administrateur) — consultation
-- =============================================================================
create or replace function public.vyora_admin_payment_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_cron jsonb := jsonb_build_object('available', false, 'scheduled', false);
  v_token boolean := false;
begin
  perform ugc_private.reelora_assert_admin();
  -- Présence du jeton serveur dans Vault (jamais sa valeur).
  if to_regclass('vault.secrets') is not null then
    execute 'select exists (select 1 from vault.secrets s where s.name = $1)'
      into v_token using 'vyora_payments_reconcile_token';
  end if;
  if to_regclass('cron.job') is not null then
    execute 'select coalesce((select jsonb_build_object(''available'', true, ''scheduled'', true,
               ''schedule'', j.schedule, ''active'', j.active) from cron.job j where j.jobname = $1 limit 1),
               jsonb_build_object(''available'', true, ''scheduled'', false))'
      into v_cron using 'vyora-payments-reconcile';
  end if;
  return jsonb_build_object(
    'enabled', coalesce((v_cfg->>'enabled')::boolean, false),
    'mode', coalesce(v_cfg->>'mode', 'test'),
    'cron', v_cron,
    -- Ce dont la tâche planifiée a besoin pour appeler l'Edge Function.
    'dispatch', jsonb_build_object(
      'token_present', v_token,
      'http_available', to_regproc('net.http_post') is not null),
    'open_orders', jsonb_build_object(
      'studio', (select count(*) from saas_ugc.ugc_recharge_orders o
                  where o.provider = 'saspay' and o.status in ('pending', 'processing')),
      'business', (select count(*) from saas_business.payment_orders o
                    where o.status in ('pending', 'processing'))),
    -- Créations softpay sans réponse : en fenêtre de rejeu, puis en rapprochement manuel.
    'unconfirmed', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product', i.product, 'order_id', i.order_id, 'internal_reference', i.internal_reference,
               'user_email', (select u.email from auth.users u where u.id = i.user_id),
               'amount', i.amount, 'currency', i.currency, 'network', i.network_code,
               'payer_msisdn_masked', i.payer_msisdn_masked, 'attempts', i.attempts,
               'first_attempt_at', i.first_attempt_at, 'last_attempt_at', i.last_attempt_at,
               'in_review', i.review_at is not null, 'review_at', i.review_at, 'last_error', i.last_error,
               'candidates', i.candidates, 'last_search_at', i.last_search_at)
             order by i.first_attempt_at)
        from saas_ugc.vyora_payment_initiations i
       where i.resolved_at is null and i.outcome in ('started', 'unknown')
         and (i.outcome = 'unknown' or i.last_attempt_at < now() - interval '60 seconds')), '[]'::jsonb),
    'refunds_awaiting_settlement',
      (select count(*) from saas_ugc.ugc_recharge_orders o
        where o.provider = 'saspay' and o.status = 'refunded' and o.refund_state = 'credits_recovered')
      + (select count(*) from saas_business.payment_orders o
          where o.status = 'refunded' and o.refund_state = 'credits_recovered'),
    'runs', coalesce((
      -- Du détail, seuls les indicateurs du balayage sont exposés.
      select jsonb_agg((to_jsonb(r) - 'detail') || jsonb_build_object(
               'sweep_truncated', coalesce((r.detail->>'sweep_truncated')::boolean, false),
               'sweep_blind', coalesce((r.detail->>'sweep_blind')::boolean, false))
             order by r.started_at desc)
        from (select * from saas_ugc.vyora_payment_reconcile_runs
               order by started_at desc limit 10) r), '[]'::jsonb),
    'anomalies', coalesce((
      select jsonb_agg(to_jsonb(a) - 'dedup_key' order by a.last_seen_at desc)
        from (select * from saas_ugc.vyora_payment_anomalies
               where resolved_at is null order by last_seen_at desc limit 50) a), '[]'::jsonb)
  );
end $$;

create or replace function public.vyora_admin_resolve_anomaly(p_anomaly_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin uuid := (select auth.uid());
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_row saas_ugc.vyora_payment_anomalies%rowtype;
begin
  perform ugc_private.reelora_assert_admin();
  if v_note is null or char_length(v_note) < 5 or char_length(v_note) > 500 then
    raise exception 'anomaly_note_required';
  end if;
  -- Un paiement à l'issue inconnue ne se « classe » pas : il se tranche
  -- (rattacher le paiement SasPay, ou attester qu'aucun encaissement n'existe).
  -- L'alerte se lève alors d'elle-même ; la classer ici la ferait disparaître
  -- en laissant le client bloqué.
  if exists (
    select 1 from saas_ugc.vyora_payment_anomalies a
      join saas_ugc.vyora_payment_initiations i on i.order_id = a.order_id and i.resolved_at is null
     where a.id = p_anomaly_id and a.kind = 'initiation_unconfirmed' and a.resolved_at is null
  ) then
    raise exception 'anomaly_requires_decision';
  end if;
  update saas_ugc.vyora_payment_anomalies
     set resolved_at = now(), resolved_by = v_admin, resolution_note = v_note
   where id = p_anomaly_id and resolved_at is null
   returning * into v_row;
  if not found then raise exception 'anomaly_not_found'; end if;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (v_admin, 'saspay_anomaly_resolved', 'payment_anomaly', p_anomaly_id::text,
    jsonb_build_object('actor', 'admin', 'kind', v_row.kind, 'order_id', v_row.order_id, 'note', v_note));
  return to_jsonb(v_row) - 'dedup_key';
end $$;

-- =============================================================================
-- 8. Droits d'exécution
-- =============================================================================
do $$
declare
  v_fn text;
begin
  -- Edge Functions uniquement.
  foreach v_fn in array array[
    'public.vyora_payment_report_anomaly(text, text, uuid, text, text, jsonb)',
    'public.vyora_payment_reconcile_batch(integer)',
    'public.vyora_payment_find_by_reference(text)',
    'public.vyora_payment_reconcile_start(text)',
    'public.vyora_payment_reconcile_finish(uuid, text, jsonb)',
    'public.vyora_payment_housekeeping()',
    'public.vyora_payments_reconcile_token()',
    'public.vyora_payment_begin_initiation(text, uuid, jsonb)',
    'public.vyora_payment_initiation_unknown(text, uuid, text)',
    'public.vyora_payment_unconfirmed(integer, boolean)',
    'public.vyora_payment_note_candidates(text, uuid, jsonb)',
    'public.vyora_payment_add_candidate(text, uuid, jsonb)',
    'public.vyora_payment_review_attached(uuid, text, uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;

  -- Tâche planifiée : aucun rôle d'API.
  revoke all on function public.vyora_payments_reconcile_dispatch() from public, anon, authenticated, service_role;

  -- Administrateur connecté (contrôle du rôle dans chaque fonction).
  foreach v_fn in array array[
    'public.vyora_admin_refund_preview(text, uuid)',
    'public.vyora_admin_refund_studio(uuid, text, bigint, boolean)',
    'public.vyora_admin_refund_business(uuid, text, bigint, boolean)',
    'public.vyora_admin_refund_settle(text, uuid, text)',
    'public.vyora_admin_payment_health()',
    'public.vyora_admin_resolve_anomaly(uuid, text)',
    'public.vyora_admin_close_unconfirmed(text, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end $$;
