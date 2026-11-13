-- Sous-ensemble du schéma de PRODUCTION nécessaire aux paiements SasPay.
-- Relevé par introspection (pg_attribute / pg_get_constraintdef /
-- pg_get_functiondef) du projet xbuuhfwobrafcbgtdgjx le 2026-11-12, en lecture
-- seule. Sert uniquement au banc d'essai local (voir run.mjs) : ce fichier n'est
-- jamais appliqué à un projet Supabase.
create schema saas_ugc;
create schema ugc_private;
grant usage on schema saas_ugc to authenticated, service_role, anon;
grant usage on schema ugc_private to authenticated, service_role;

create table saas_ugc.ugc_app_settings (setting_key text not null, setting_value jsonb not null, description text, updated_at timestamp with time zone not null default now());
create table saas_ugc.ugc_audit_logs (id uuid not null default gen_random_uuid(), actor_user_id uuid not null, action text not null, target_type text, target_id text, details jsonb not null default '{}'::jsonb, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_credit_ledger (id uuid not null default gen_random_uuid(), user_id uuid, recharge_order_id uuid, generation_job_id uuid, operation_type text not null, available_delta bigint not null default 0, reserved_delta bigint not null default 0, idempotency_key text not null, description text, metadata jsonb not null default '{}'::jsonb, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_credit_purchases (id uuid not null default gen_random_uuid(), user_id uuid not null, recharge_order_id uuid, pack_key text, label text not null, price_xof bigint not null, credits_granted bigint not null, price_per_credit_xof numeric(14,4) not null, config_updated_at timestamp with time zone not null, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_customer_accounts (user_id uuid not null, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_notifications (id uuid not null default gen_random_uuid(), user_id uuid not null, title text not null, body text, kind text not null default 'info'::text, href text, read_at timestamp with time zone, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_payment_events (id uuid not null default gen_random_uuid(), provider text not null, provider_event_id text not null, recharge_order_id uuid, event_type text not null, processing_status text not null default 'received'::text, payload jsonb not null default '{}'::jsonb, received_at timestamp with time zone not null default now(), processed_at timestamp with time zone);
create table saas_ugc.ugc_recharge_orders (id uuid not null default gen_random_uuid(), user_id uuid not null, amount_minor bigint not null, currency character(3) not null, country_code character(2) not null, credits_to_grant bigint not null, provider text not null, provider_reference text, checkout_url text, idempotency_key text not null, status text not null default 'pending'::text, paid_at timestamp with time zone, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now());
create table saas_ugc.ugc_user_roles (id uuid not null default gen_random_uuid(), user_id uuid not null, role text not null, created_at timestamp with time zone not null default now());
create table saas_ugc.ugc_wallets (user_id uuid not null, available_balance bigint not null default 0, reserved_balance bigint not null default 0, lifetime_purchased bigint not null default 0, lifetime_bonus bigint not null default 0, created_at timestamp with time zone not null default now(), updated_at timestamp with time zone not null default now());
create table saas_ugc.ugc_webhook_events (id uuid not null default gen_random_uuid(), channel text not null, provider text not null, provider_event_id text not null, event_type text not null, payload jsonb not null default '{}'::jsonb, processing_status text not null default 'received'::text, received_at timestamp with time zone not null default now(), processed_at timestamp with time zone, error_message text);
alter table saas_ugc.ugc_app_settings add constraint ugc_app_settings_pkey PRIMARY KEY (setting_key);
alter table saas_ugc.ugc_audit_logs add constraint ugc_audit_logs_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_credit_ledger add constraint ugc_credit_ledger_check CHECK (((available_delta <> 0) OR (reserved_delta <> 0)));
alter table saas_ugc.ugc_credit_ledger add constraint ugc_credit_ledger_operation_type_check CHECK ((operation_type = ANY (ARRAY['purchase'::text, 'signup_bonus'::text, 'promo_bonus'::text, 'reserve'::text, 'capture'::text, 'release'::text, 'refund'::text, 'admin_adjustment'::text])));
alter table saas_ugc.ugc_credit_ledger add constraint ugc_credit_ledger_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_credit_ledger add constraint ugc_credit_ledger_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);
alter table saas_ugc.ugc_credit_purchases add constraint ugc_credit_purchases_credits_granted_check CHECK ((credits_granted > 0));
alter table saas_ugc.ugc_credit_purchases add constraint ugc_credit_purchases_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_credit_purchases add constraint ugc_credit_purchases_price_per_credit_xof_check CHECK ((price_per_credit_xof > (0)::numeric));
alter table saas_ugc.ugc_credit_purchases add constraint ugc_credit_purchases_price_xof_check CHECK ((price_xof > 0));
alter table saas_ugc.ugc_customer_accounts add constraint ugc_customer_accounts_pkey PRIMARY KEY (user_id);
alter table saas_ugc.ugc_notifications add constraint ugc_notifications_kind_check CHECK ((kind = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'error'::text, 'admin_request'::text])));
alter table saas_ugc.ugc_notifications add constraint ugc_notifications_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_payment_events add constraint ugc_payment_events_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_payment_events add constraint ugc_payment_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'processed'::text, 'rejected'::text])));
alter table saas_ugc.ugc_payment_events add constraint ugc_payment_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);
alter table saas_ugc.ugc_recharge_orders add constraint ugc_recharge_orders_amount_minor_check CHECK ((amount_minor > 0));
alter table saas_ugc.ugc_recharge_orders add constraint ugc_recharge_orders_credits_to_grant_check CHECK ((credits_to_grant > 0));
alter table saas_ugc.ugc_recharge_orders add constraint ugc_recharge_orders_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_recharge_orders add constraint ugc_recharge_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'paid'::text, 'failed'::text, 'cancelled'::text, 'refunded'::text])));
alter table saas_ugc.ugc_recharge_orders add constraint ugc_recharge_orders_user_id_idempotency_key_key UNIQUE (user_id, idempotency_key);
alter table saas_ugc.ugc_user_roles add constraint ugc_user_roles_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_user_roles add constraint ugc_user_roles_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text])));
alter table saas_ugc.ugc_user_roles add constraint ugc_user_roles_user_id_role_key UNIQUE (user_id, role);
alter table saas_ugc.ugc_wallets add constraint ugc_wallets_available_balance_check CHECK ((available_balance >= 0));
alter table saas_ugc.ugc_wallets add constraint ugc_wallets_lifetime_bonus_check CHECK ((lifetime_bonus >= 0));
alter table saas_ugc.ugc_wallets add constraint ugc_wallets_lifetime_purchased_check CHECK ((lifetime_purchased >= 0));
alter table saas_ugc.ugc_wallets add constraint ugc_wallets_pkey PRIMARY KEY (user_id);
alter table saas_ugc.ugc_wallets add constraint ugc_wallets_reserved_balance_check CHECK ((reserved_balance >= 0));
alter table saas_ugc.ugc_webhook_events add constraint ugc_webhook_events_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'payment'::text, 'other'::text])));
alter table saas_ugc.ugc_webhook_events add constraint ugc_webhook_events_pkey PRIMARY KEY (id);
alter table saas_ugc.ugc_webhook_events add constraint ugc_webhook_events_processing_status_check CHECK ((processing_status = ANY (ARRAY['received'::text, 'processing'::text, 'processed'::text, 'rejected'::text, 'failed'::text])));
alter table saas_ugc.ugc_webhook_events add constraint ugc_webhook_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);
alter table saas_ugc.ugc_credit_ledger add constraint ugc_credit_ledger_recharge_order_id_fkey FOREIGN KEY (recharge_order_id) REFERENCES saas_ugc.ugc_recharge_orders(id) ON DELETE RESTRICT;
alter table saas_ugc.ugc_credit_purchases add constraint ugc_credit_purchases_recharge_order_id_fkey FOREIGN KEY (recharge_order_id) REFERENCES saas_ugc.ugc_recharge_orders(id) ON DELETE SET NULL;
alter table saas_ugc.ugc_payment_events add constraint ugc_payment_events_recharge_order_id_fkey FOREIGN KEY (recharge_order_id) REFERENCES saas_ugc.ugc_recharge_orders(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX ugc_recharge_provider_ref_uidx ON saas_ugc.ugc_recharge_orders USING btree (provider, provider_reference) WHERE (provider_reference IS NOT NULL);
CREATE UNIQUE INDEX ugc_user_roles_single_admin_idx ON saas_ugc.ugc_user_roles USING btree (role) WHERE (role = 'admin'::text);

CREATE OR REPLACE FUNCTION ugc_private.touch_updated_at()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO ''
AS $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;
CREATE TRIGGER ugc_app_settings_touch_updated_at BEFORE UPDATE ON saas_ugc.ugc_app_settings FOR EACH ROW EXECUTE FUNCTION ugc_private.touch_updated_at();
CREATE TRIGGER ugc_wallets_touch_updated_at BEFORE UPDATE ON saas_ugc.ugc_wallets FOR EACH ROW EXECUTE FUNCTION ugc_private.touch_updated_at();
CREATE TRIGGER ugc_recharge_orders_touch_updated_at BEFORE UPDATE ON saas_ugc.ugc_recharge_orders FOR EACH ROW EXECUTE FUNCTION ugc_private.touch_updated_at();

CREATE OR REPLACE FUNCTION ugc_private.has_role(p_user_id uuid, p_role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$ select exists (select 1 from saas_ugc.ugc_user_roles where user_id = p_user_id and role = p_role) $function$;

CREATE OR REPLACE FUNCTION ugc_private.reelora_assert_admin()
 RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not ugc_private.has_role((select auth.uid()), 'admin') then raise exception 'forbidden'; end if;
end $function$;

CREATE OR REPLACE FUNCTION ugc_private.apply_wallet_delta(p_user_id uuid, p_operation_type text, p_available_delta bigint, p_reserved_delta bigint, p_idempotency_key text, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_recharge_order_id uuid DEFAULT NULL::uuid, p_generation_job_id uuid DEFAULT NULL::uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_wallet saas_ugc.ugc_wallets%rowtype;
  v_ledger_id uuid;
begin
  select id into v_ledger_id
  from saas_ugc.ugc_credit_ledger
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if v_ledger_id is not null then return v_ledger_id; end if;

  select * into v_wallet
  from saas_ugc.ugc_wallets
  where user_id = p_user_id
  for update;

  if not found then raise exception 'Wallet not found'; end if;
  if v_wallet.available_balance + p_available_delta < 0
     or v_wallet.reserved_balance + p_reserved_delta < 0 then
    raise exception 'Insufficient or inconsistent credit balance';
  end if;

  insert into saas_ugc.ugc_credit_ledger(
    user_id,recharge_order_id,generation_job_id,operation_type,
    available_delta,reserved_delta,idempotency_key,description,metadata
  ) values (
    p_user_id,p_recharge_order_id,p_generation_job_id,p_operation_type,
    p_available_delta,p_reserved_delta,p_idempotency_key,p_description,coalesce(p_metadata,'{}'::jsonb)
  )
  on conflict (user_id,idempotency_key) do nothing
  returning id into v_ledger_id;

  if v_ledger_id is null then
    select id into v_ledger_id from saas_ugc.ugc_credit_ledger
    where user_id=p_user_id and idempotency_key=p_idempotency_key;
    return v_ledger_id;
  end if;

  update saas_ugc.ugc_wallets
  set available_balance = available_balance + p_available_delta,
      reserved_balance = reserved_balance + p_reserved_delta,
      lifetime_purchased = lifetime_purchased + case when p_operation_type='purchase' then p_available_delta else 0 end,
      lifetime_bonus = lifetime_bonus + case when p_operation_type in ('signup_bonus','promo_bonus') then p_available_delta else 0 end,
      updated_at = now()
  where user_id = p_user_id;

  return v_ledger_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.ugc_confirm_recharge(p_order_id uuid, p_provider text, p_provider_event_id text, p_provider_reference text, p_amount_minor bigint, p_currency character, p_event_type text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_event_id uuid;
  v_ledger_id uuid;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  select * into v_order from saas_ugc.ugc_recharge_orders where id = p_order_id for update;
  if not found then raise exception 'Recharge order not found'; end if;
  if not exists (
    select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = v_order.user_id
  ) or exists (
    select 1 from saas_ugc.ugc_user_roles r where r.user_id = v_order.user_id and r.role = 'admin'
  ) then
    raise exception 'target_not_vyora_customer';
  end if;

  insert into saas_ugc.ugc_payment_events(provider, provider_event_id, recharge_order_id, event_type, payload)
  values (p_provider, p_provider_event_id, p_order_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;
  if v_event_id is null then
    select id into v_ledger_id from saas_ugc.ugc_credit_ledger
    where recharge_order_id = p_order_id and operation_type = 'purchase';
    return v_ledger_id;
  end if;

  if v_order.provider <> p_provider or v_order.amount_minor <> p_amount_minor
     or v_order.currency <> upper(p_currency) then
    update saas_ugc.ugc_payment_events
    set processing_status = 'rejected', processed_at = now()
    where id = v_event_id;
    raise exception 'Payment verification mismatch';
  end if;
  if v_order.status = 'paid' then
    update saas_ugc.ugc_payment_events
    set processing_status = 'processed', processed_at = now()
    where id = v_event_id;
    select id into v_ledger_id from saas_ugc.ugc_credit_ledger
    where recharge_order_id = p_order_id and operation_type = 'purchase';
    return v_ledger_id;
  end if;
  if v_order.status not in ('pending', 'processing') then
    raise exception 'Recharge order is not payable';
  end if;

  update saas_ugc.ugc_recharge_orders
  set status = 'paid', provider_reference = coalesce(p_provider_reference, provider_reference),
      paid_at = now(), updated_at = now()
  where id = p_order_id;
  v_ledger_id := ugc_private.apply_wallet_delta(
    v_order.user_id, 'purchase', v_order.credits_to_grant, 0,
    'recharge:' || v_order.id::text, 'Recharge confirmée',
    jsonb_build_object('provider', p_provider, 'currency', v_order.currency, 'amount_minor', v_order.amount_minor),
    v_order.id, null
  );
  update saas_ugc.ugc_payment_events
  set processing_status = 'processed', processed_at = now()
  where id = v_event_id;
  return v_ledger_id;
end;
$function$;
revoke all on function public.ugc_confirm_recharge(uuid, text, text, text, bigint, character, text, jsonb) from public, anon, authenticated;
grant execute on function public.ugc_confirm_recharge(uuid, text, text, text, bigint, character, text, jsonb) to service_role;

-- Données de production utiles (grille Studio).
insert into saas_ugc.ugc_app_settings(setting_key, setting_value) values ('studio_pricing_config',
  '{"packs": [{"label": "Creator", "credits": 27, "pack_key": "creator", "price_xof": 5000, "recommended": false}, {"label": "Pro Creator", "credits": 95, "pack_key": "pro_creator", "price_xof": 15000, "recommended": true}, {"label": "Studio Business", "credits": 265, "pack_key": "studio_business", "price_xof": 35000, "recommended": false}], "usd_to_xof": 620, "custom_recharge": {"max_xof": 350000, "min_xof": 5000, "step_xof": 1000}, "credit_value_xof": 100, "processing_cost_usd": 0.01, "target_margin_percent": 60, "require_known_provider_cost": true}'::jsonb);
