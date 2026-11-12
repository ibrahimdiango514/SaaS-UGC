-- -----------------------------------------------------------------------------
-- VYORA — paiement SasPay (encaissement uniquement)
--
-- Cette migration ÉTEND l'architecture de paiement existante, elle n'en crée pas
-- une seconde :
--   * Studio        : `saas_ugc.ugc_recharge_orders` + `ugc_payment_events`
--                     + `public.ugc_confirm_recharge()` (crédit idempotent déjà
--                     en place, clé `recharge:<commande>`).
--   * Business Grow : `saas_business.billing_events` + `bg_apply_billing_event()`
--                     (pipeline d'abonnement déjà en place) — seule une table de
--                     commandes manquait : `saas_business.payment_orders`.
--
-- Séparation stricte : aucune fonction ne crédite un portefeuille d'un produit à
-- partir d'une commande de l'autre. Les seules fonctions qui lisent les deux
-- schémas sont des AIGUILLEURS en lecture (retrouver une commande à partir d'un
-- identifiant SasPay).
--
-- Règles d'intégrité portées par la base, pas par le navigateur :
--   * montant, devise, crédits, utilisateur et référence interne immuables ;
--   * une commande SasPay ne peut passer à `paid` que s'il existe l'événement
--     de paiement vérifié correspondant (aucune validation manuelle possible) ;
--   * identifiants SasPay uniques (un paiement ne règle qu'une commande) ;
--   * toutes les écritures sont réservées à `service_role` (Edge Functions).
--
-- Rien n'est activé par défaut : `saspay_payment_config.enabled = false`.
-- Migration additive : aucune donnée existante n'est modifiée ni supprimée.
-- -----------------------------------------------------------------------------

-- 0. Configuration (administrable sans redéploiement) ------------------------------
insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'saspay_payment_config',
  jsonb_build_object(
    -- Interrupteur général. `false` : aucune commande SasPay ne peut être créée.
    'enabled', false,
    -- `test` exige une clé `sk_test_…`, `live` une clé `sk_live_…`. Une clé de
    -- production ne peut donc jamais être utilisée tant que le mode est `test`.
    'mode', 'test',
    'flows', jsonb_build_array('softpay', 'checkout'),
    'order_ttl_minutes', 30,
    'max_open_orders', 3,
    -- Extensible : ajouter un pays = ajouter une entrée ici (codes réseau du
    -- catalogue SasPay). Les tarifs ne sont PAS stockés : ils sont lus sur le
    -- compte marchand (`GET /pricing/my-rates/`).
    'countries', jsonb_build_object(
      'ML', jsonb_build_object(
        'name', 'Mali',
        'currency', 'XOF',
        'dial_code', '223',
        'national_number_length', 8,
        'networks', jsonb_build_array(
          jsonb_build_object('code', 'orange_ml', 'label', 'Orange Money'),
          jsonb_build_object('code', 'moov_ml', 'label', 'Moov Money'),
          jsonb_build_object('code', 'mobi_cash_ml', 'label', 'Mobi Cash')
        )
      )
    )
  ),
  'Paiement SasPay : activation, mode test/live, pays et réseaux proposés'
)
on conflict (setting_key) do nothing;

-- 1. Aides privées -------------------------------------------------------------------
create or replace function ugc_private.vyora_assert_service_role()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
end $$;

create or replace function ugc_private.vyora_payment_config()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.setting_value from saas_ugc.ugc_app_settings s where s.setting_key = 'saspay_payment_config'),
    jsonb_build_object('enabled', false)
  );
$$;

-- Valide pays / parcours / réseau contre la configuration. Renvoie l'entrée pays.
create or replace function ugc_private.vyora_payment_check_route(
  p_cfg jsonb, p_country text, p_flow text, p_network text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_country jsonb;
begin
  if coalesce((p_cfg->>'enabled')::boolean, false) is not true then
    raise exception 'payments_disabled';
  end if;
  if p_flow is null or p_flow not in ('softpay', 'checkout')
     or not (coalesce(p_cfg->'flows', '[]'::jsonb) ? p_flow) then
    raise exception 'payment_flow_not_allowed';
  end if;
  v_country := p_cfg->'countries'->upper(coalesce(trim(p_country), ''));
  if v_country is null or jsonb_typeof(v_country) <> 'object' then
    raise exception 'payment_country_not_supported';
  end if;
  if p_flow = 'softpay' and not exists (
    select 1 from jsonb_array_elements(coalesce(v_country->'networks', '[]'::jsonb)) n
     where n.value->>'code' = p_network
  ) then
    raise exception 'payment_network_not_supported';
  end if;
  return v_country;
end $$;

revoke all on function ugc_private.vyora_assert_service_role() from public, anon, authenticated;
revoke all on function ugc_private.vyora_payment_config() from public, anon, authenticated;
revoke all on function ugc_private.vyora_payment_check_route(jsonb, text, text, text) from public, anon, authenticated;

-- =============================================================================
-- 2. VYORA STUDIO — commandes de crédits
-- =============================================================================
alter table saas_ugc.ugc_recharge_orders
  add column if not exists internal_reference text,
  add column if not exists order_kind text,
  add column if not exists pack_key text,
  add column if not exists order_label text,
  add column if not exists pricing_snapshot jsonb,
  add column if not exists payment_flow text,
  add column if not exists network_code text,
  add column if not exists payer_msisdn_masked text,
  add column if not exists provider_payment_id text,
  add column if not exists provider_session_id text,
  add column if not exists provider_status text,
  add column if not exists quoted_fee_mode text,
  add column if not exists quoted_fee_amount numeric(18,2),
  add column if not exists quoted_total_amount numeric(18,2),
  add column if not exists fee_charge_mode text,
  add column if not exists fee_amount numeric(18,2),
  add column if not exists charged_amount numeric(18,2),
  add column if not exists net_amount numeric(18,2),
  add column if not exists failure_code text,
  add column if not exists initiated_at timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists verify_count integer not null default 0,
  add column if not exists expires_at timestamptz;

create unique index if not exists ugc_recharge_orders_internal_reference_key
  on saas_ugc.ugc_recharge_orders(internal_reference) where internal_reference is not null;
create unique index if not exists ugc_recharge_orders_provider_payment_key
  on saas_ugc.ugc_recharge_orders(provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists ugc_recharge_orders_provider_session_key
  on saas_ugc.ugc_recharge_orders(provider, provider_session_id) where provider_session_id is not null;
create index if not exists ugc_recharge_orders_open_saspay_idx
  on saas_ugc.ugc_recharge_orders(user_id, created_at desc)
  where provider = 'saspay' and status in ('pending', 'processing');

-- Garde d'intégrité : s'applique à TOUTES les commandes (manuelles comprises).
create or replace function saas_ugc.vyora_guard_recharge_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Une commande SasPay ne naît que par le service de paiement (prix relu côté
    -- serveur, référence interne) et toujours à l'état initial. L'ancienne RPC
    -- `ugc_create_recharge_order`, appelable par le navigateur, ne peut donc pas
    -- fabriquer de commande SasPay.
    -- Le nom est réservé : « SasPay », « SASPAY », « sas-pay », espaces… créeraient
    -- une commande d'apparence SasPay échappant aux gardes ci-dessous, qu'un
    -- administrateur pourrait valider à la main par méprise.
    if new.provider is distinct from 'saspay'
       and regexp_replace(lower(coalesce(new.provider, '')), '[^a-z0-9]', '', 'g') = 'saspay' then
      raise exception 'saspay_provider_name_reserved';
    end if;
    if new.provider = 'saspay' and (
         new.internal_reference is null or new.order_kind is null or new.payment_flow is null
         or new.status <> 'pending' or new.paid_at is not null
         or new.provider_payment_id is not null or new.provider_session_id is not null) then
      raise exception 'saspay_order_requires_payment_service';
    end if;
    return new;
  end if;

  if (new.id, new.user_id, new.amount_minor, new.currency, new.country_code, new.credits_to_grant,
      new.provider, new.idempotency_key, new.created_at,
      new.internal_reference, new.order_kind, new.pack_key, new.order_label, new.pricing_snapshot,
      new.payment_flow, new.network_code)
     is distinct from
     (old.id, old.user_id, old.amount_minor, old.currency, old.country_code, old.credits_to_grant,
      old.provider, old.idempotency_key, old.created_at,
      old.internal_reference, old.order_kind, old.pack_key, old.order_label, old.pricing_snapshot,
      old.payment_flow, old.network_code) then
    raise exception 'recharge_order_identity_is_immutable';
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
  -- Une commande SasPay n'est « payée » que sur preuve : l'événement de paiement
  -- vérifié doit déjà exister. Une validation manuelle est donc impossible.
  if new.status = 'paid' and old.status <> 'paid' and new.provider = 'saspay' then
    if new.provider_payment_id is null or not exists (
      select 1 from saas_ugc.ugc_payment_events e
       where e.provider = 'saspay'
         and e.recharge_order_id = new.id
         and e.provider_event_id = 'saspay:success:' || new.provider_payment_id
    ) then
      raise exception 'saspay_order_requires_verified_payment';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists vyora_recharge_order_guard on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_order_guard
  before insert or update on saas_ugc.ugc_recharge_orders
  for each row execute function saas_ugc.vyora_guard_recharge_order();

-- Prix Studio : relu dans la grille serveur. Le navigateur ne transmet qu'une
-- clé de pack ou un montant libre ; ni prix ni crédits ne viennent du client.
--
-- Recharge libre : la grille définit les packs comme PALIERS DÉGRESSIFS du prix
-- du crédit. Un montant libre est donc converti au prix par crédit du plus grand
-- palier atteint (5 000 → 27, 15 000 → 95, 35 000 → 265 : identique aux packs).
create or replace function ugc_private.vyora_studio_price(p_kind text, p_pack_key text, p_amount_xof bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
  v_cfg_at timestamptz;
  v_pack jsonb;
  v_custom jsonb;
  v_price bigint;
  v_credits bigint;
  v_label text;
  v_key text;
  v_step bigint;
begin
  select s.setting_value, s.updated_at into v_cfg, v_cfg_at
    from saas_ugc.ugc_app_settings s where s.setting_key = 'studio_pricing_config';
  if v_cfg is null then raise exception 'studio_pricing_not_configured'; end if;

  if p_kind = 'pack' then
    select p.value into v_pack
      from jsonb_array_elements(coalesce(v_cfg->'packs', '[]'::jsonb)) p
     where p.value->>'pack_key' = p_pack_key
     limit 1;
    if v_pack is null then raise exception 'unknown_pack'; end if;
    v_price := (v_pack->>'price_xof')::bigint;
    v_credits := (v_pack->>'credits')::bigint;
    v_label := 'Pack ' || coalesce(v_pack->>'label', p_pack_key);
    v_key := v_pack->>'pack_key';
  elsif p_kind = 'custom' then
    v_custom := v_cfg->'custom_recharge';
    if v_custom is null or jsonb_typeof(v_custom) <> 'object' then
      raise exception 'custom_recharge_not_configured';
    end if;
    v_step := greatest(coalesce((v_custom->>'step_xof')::bigint, 1), 1);
    if p_amount_xof is null
       or p_amount_xof < (v_custom->>'min_xof')::bigint
       or p_amount_xof > (v_custom->>'max_xof')::bigint
       or p_amount_xof % v_step <> 0 then
      raise exception 'custom_amount_out_of_bounds';
    end if;
    select p.value into v_pack
      from jsonb_array_elements(coalesce(v_cfg->'packs', '[]'::jsonb)) p
     where (p.value->>'price_xof')::bigint <= p_amount_xof
       and (p.value->>'price_xof')::bigint > 0
       and (p.value->>'credits')::bigint > 0
     order by (p.value->>'price_xof')::bigint desc
     limit 1;
    if v_pack is null then raise exception 'custom_amount_out_of_bounds'; end if;
    v_price := p_amount_xof;
    v_credits := floor(p_amount_xof::numeric * (v_pack->>'credits')::numeric
                       / (v_pack->>'price_xof')::numeric)::bigint;
    v_label := 'Recharge personnalisée';
    v_key := null;
  else
    raise exception 'invalid_order_kind';
  end if;

  if v_price is null or v_price <= 0 or v_credits is null or v_credits <= 0 then
    raise exception 'invalid_pack_values';
  end if;

  return jsonb_build_object(
    'kind', p_kind, 'pack_key', v_key, 'label', v_label,
    'price_xof', v_price, 'credits', v_credits, 'currency', 'XOF',
    'tier_pack_key', v_pack->>'pack_key', 'config_updated_at', v_cfg_at
  );
end $$;

revoke all on function ugc_private.vyora_studio_price(text, text, bigint) from public, anon, authenticated;

-- Représentation JSON d'une commande Studio. `amount` est une CHAÎNE décimale
-- (convention Studio : `amount_minor` est en centièmes).
create or replace function ugc_private.vyora_studio_order_json(o saas_ugc.ugc_recharge_orders)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'product', 'studio',
    'id', o.id,
    'user_id', o.user_id,
    'status', o.status,
    'amount', trim(to_char(o.amount_minor::numeric / 100, 'FM9999999999999990.00')),
    'currency', trim(o.currency::text),
    'country', trim(o.country_code::text),
    'internal_reference', o.internal_reference,
    'label', coalesce(o.order_label, 'Recharge de crédits Studio'),
    'kind', o.order_kind,
    'pack_key', o.pack_key,
    'credits', o.credits_to_grant,
    'payment_flow', o.payment_flow,
    'network_code', o.network_code,
    'payer_msisdn_masked', o.payer_msisdn_masked,
    'provider_payment_id', o.provider_payment_id,
    'provider_session_id', o.provider_session_id,
    'provider_status', o.provider_status,
    'checkout_url', o.checkout_url,
    'quoted_fee_mode', o.quoted_fee_mode,
    'quoted_fee_amount', trim(to_char(o.quoted_fee_amount, 'FM9999999999999990.00')),
    'quoted_total_amount', trim(to_char(o.quoted_total_amount, 'FM9999999999999990.00')),
    'fee_charge_mode', o.fee_charge_mode,
    'fee_amount', trim(to_char(o.fee_amount, 'FM9999999999999990.00')),
    'charged_amount', trim(to_char(o.charged_amount, 'FM9999999999999990.00')),
    'net_amount', trim(to_char(o.net_amount, 'FM9999999999999990.00')),
    'failure_code', o.failure_code,
    'created_at', o.created_at,
    'initiated_at', o.initiated_at,
    'last_verified_at', o.last_verified_at,
    'paid_at', o.paid_at,
    'expires_at', o.expires_at
  );
$$;

revoke all on function ugc_private.vyora_studio_order_json(saas_ugc.ugc_recharge_orders) from public, anon, authenticated;

-- 2.1 Création d'une commande Studio (montant figé côté serveur) ------------------------
create or replace function public.vyora_payment_create_studio_order(
  p_user_id uuid,
  p_kind text,
  p_pack_key text,
  p_amount_xof bigint,
  p_country text,
  p_flow text,
  p_network text,
  p_idempotency_key text,
  p_quoted_fee numeric default null,
  p_quoted_total numeric default null,
  p_quoted_fee_mode text default null,
  p_msisdn_masked text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_country jsonb;
  v_price jsonb;
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_network text;
  v_open integer;
  v_ttl integer;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_user_id is null then raise exception 'not_authenticated'; end if;
  if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
     or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
    raise exception 'not_vyora_customer';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,80}$' then
    raise exception 'invalid_idempotency_key';
  end if;

  v_country := ugc_private.vyora_payment_check_route(v_cfg, p_country, p_flow, p_network);
  if coalesce(v_country->>'currency', '') <> 'XOF' then
    raise exception 'payment_currency_not_supported';
  end if;
  v_network := case when p_flow = 'softpay' then p_network end;
  v_price := ugc_private.vyora_studio_price(p_kind, p_pack_key, p_amount_xof);

  -- Une seule création à la fois par utilisateur : pas de course au double clic.
  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-studio:' || p_user_id::text, 0));

  select * into v_order from saas_ugc.ugc_recharge_orders o
   where o.user_id = p_user_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.provider <> 'saspay'
       or v_order.order_kind is distinct from p_kind
       or v_order.pack_key is distinct from (v_price->>'pack_key')
       or v_order.amount_minor <> (v_price->>'price_xof')::bigint * 100
       or v_order.payment_flow is distinct from p_flow
       or v_order.network_code is distinct from v_network then
      raise exception 'idempotency_key_reused';
    end if;
    return ugc_private.vyora_studio_order_json(v_order) || jsonb_build_object('reused', true);
  end if;

  v_ttl := greatest(coalesce((v_cfg->>'order_ttl_minutes')::integer, 30), 5);
  select count(*) into v_open from saas_ugc.ugc_recharge_orders o
   where o.user_id = p_user_id and o.provider = 'saspay'
     and o.status in ('pending', 'processing')
     and o.created_at > now() - make_interval(mins => v_ttl);
  if v_open >= greatest(coalesce((v_cfg->>'max_open_orders')::integer, 3), 1) then
    raise exception 'too_many_open_payments';
  end if;

  insert into saas_ugc.ugc_recharge_orders(
    user_id, amount_minor, currency, country_code, credits_to_grant, provider, idempotency_key,
    internal_reference, order_kind, pack_key, order_label, pricing_snapshot, payment_flow, network_code,
    payer_msisdn_masked, quoted_fee_mode, quoted_fee_amount, quoted_total_amount, expires_at
  ) values (
    p_user_id, (v_price->>'price_xof')::bigint * 100, 'XOF', upper(trim(p_country)),
    (v_price->>'credits')::bigint, 'saspay', p_idempotency_key,
    'VYS-' || upper(replace(gen_random_uuid()::text, '-', '')),
    p_kind, v_price->>'pack_key', v_price->>'label', v_price, p_flow, v_network,
    nullif(left(coalesce(p_msisdn_masked, ''), 24), ''),
    case when p_quoted_fee_mode in ('ADD_ON', 'DEDUCTED') then p_quoted_fee_mode end,
    p_quoted_fee, p_quoted_total, now() + make_interval(mins => v_ttl)
  ) returning * into v_order;

  return ugc_private.vyora_studio_order_json(v_order) || jsonb_build_object('reused', false);
end $$;

-- 2.2 Rattachement des identifiants SasPay (une seule fois) ------------------------------
create or replace function public.vyora_payment_studio_attach(
  p_order_id uuid,
  p_payment_id text,
  p_session_id text,
  p_checkout_url text,
  p_provider_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
begin
  perform ugc_private.vyora_assert_service_role();
  select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id for update;
  if not found or v_order.provider <> 'saspay' then raise exception 'payment_order_not_found'; end if;
  if v_order.status = 'paid' then return ugc_private.vyora_studio_order_json(v_order); end if;
  if (v_order.provider_payment_id is not null and p_payment_id is not null and v_order.provider_payment_id <> p_payment_id)
     or (v_order.provider_session_id is not null and p_session_id is not null and v_order.provider_session_id <> p_session_id) then
    raise exception 'provider_reference_conflict';
  end if;

  update saas_ugc.ugc_recharge_orders
     set provider_payment_id = coalesce(provider_payment_id, nullif(p_payment_id, '')),
         provider_session_id = coalesce(provider_session_id, nullif(p_session_id, '')),
         checkout_url = coalesce(nullif(p_checkout_url, ''), checkout_url),
         provider_status = coalesce(nullif(upper(p_provider_status), ''), provider_status),
         status = case when status = 'pending' then 'processing' else status end,
         initiated_at = coalesce(initiated_at, now())
   where id = p_order_id
   returning * into v_order;
  return ugc_private.vyora_studio_order_json(v_order);
end $$;

-- 2.3 Règlement d'une commande Studio à partir d'un statut VÉRIFIÉ chez SasPay -----------
-- N'est appelée qu'après `GET /payments/{id}/verify/`. Seul `SUCCESS` crédite, et
-- une seule fois (événement unique + clé de grand livre `recharge:<commande>`).
create or replace function public.vyora_payment_studio_settle(
  p_order_id uuid,
  p_payment_id text,
  p_provider_status text,
  p_requested_amount numeric,
  p_currency text,
  p_fee numeric,
  p_charged numeric,
  p_net numeric,
  p_fee_mode text,
  p_reference text,
  p_source text,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_ugc.ugc_recharge_orders%rowtype;
  v_status text := upper(coalesce(p_provider_status, ''));
  v_payment text := nullif(trim(coalesce(p_payment_id, '')), '');
  v_expected numeric;
  v_ledger uuid;
begin
  perform ugc_private.vyora_assert_service_role();
  if v_status not in ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED') then
    raise exception 'unknown_provider_status';
  end if;
  select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id for update;
  if not found or v_order.provider <> 'saspay' then raise exception 'payment_order_not_found'; end if;
  if v_order.provider_payment_id is not null and v_payment is not null
     and v_order.provider_payment_id <> v_payment then
    raise exception 'provider_reference_conflict';
  end if;
  if v_status = 'SUCCESS' and v_payment is null then raise exception 'payment_id_required'; end if;

  -- Déjà réglée : aucun second crédit, quel que soit le nombre d'appels.
  if v_order.status in ('paid', 'refunded') then
    update saas_ugc.ugc_recharge_orders
       set last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id returning * into v_order;
    return ugc_private.vyora_studio_order_json(v_order)
      || jsonb_build_object('outcome', 'already_paid', 'credited', false);
  end if;

  if v_status = 'SUCCESS' then
    v_expected := v_order.amount_minor::numeric / 100;
    if p_requested_amount is null or p_requested_amount <> v_expected
       or upper(coalesce(trim(p_currency), '')) <> trim(v_order.currency::text) then
      update saas_ugc.ugc_recharge_orders
         set provider_payment_id = coalesce(provider_payment_id, v_payment),
             provider_status = v_status, failure_code = 'amount_mismatch',
             last_verified_at = now(), verify_count = verify_count + 1
       where id = p_order_id returning * into v_order;
      insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
      values (v_order.user_id, 'saspay_amount_mismatch', 'recharge_order', p_order_id::text,
        jsonb_build_object('actor', 'system', 'expected', v_expected::text,
          'received', p_requested_amount::text, 'currency', p_currency, 'source', p_source));
      return ugc_private.vyora_studio_order_json(v_order)
        || jsonb_build_object('outcome', 'amount_mismatch', 'credited', false);
    end if;

    -- SasPay confirme l'encaissement d'une commande marquée échouée/annulée :
    -- l'argent est reçu, la commande est rouverte puis réglée (tracé).
    if v_order.status in ('failed', 'cancelled') then
      update saas_ugc.ugc_recharge_orders set status = 'processing', failure_code = null where id = p_order_id;
      insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
      values (v_order.user_id, 'saspay_order_reopened', 'recharge_order', p_order_id::text,
        jsonb_build_object('actor', 'system', 'previous_status', v_order.status, 'source', p_source));
    end if;

    update saas_ugc.ugc_recharge_orders
       set provider_payment_id = coalesce(provider_payment_id, v_payment),
           provider_status = v_status,
           fee_charge_mode = case when p_fee_mode in ('ADD_ON', 'DEDUCTED') then p_fee_mode else fee_charge_mode end,
           fee_amount = coalesce(p_fee, fee_amount),
           charged_amount = coalesce(p_charged, charged_amount),
           net_amount = coalesce(p_net, net_amount),
           failure_code = null,
           last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id;

    -- Crédit par la primitive EXISTANTE (événement unique + grand livre idempotent).
    v_ledger := public.ugc_confirm_recharge(
      p_order_id, 'saspay', 'saspay:success:' || v_payment, coalesce(nullif(p_reference, ''), v_payment),
      v_order.amount_minor, v_order.currency, 'transaction.success',
      jsonb_build_object('source', p_source, 'payment_id', v_payment,
        'requested_amount', p_requested_amount::text, 'fee', p_fee::text,
        'charged', p_charged::text, 'net', p_net::text, 'fee_charge_mode', p_fee_mode)
    );

    insert into saas_ugc.ugc_credit_purchases(
      user_id, recharge_order_id, pack_key, label, price_xof, credits_granted,
      price_per_credit_xof, config_updated_at
    )
    select v_order.user_id, v_order.id, v_order.pack_key,
           coalesce(v_order.order_label, 'Recharge de crédits Studio'),
           v_order.amount_minor / 100, v_order.credits_to_grant,
           round((v_order.amount_minor::numeric / 100) / v_order.credits_to_grant::numeric, 4),
           coalesce((v_order.pricing_snapshot->>'config_updated_at')::timestamptz, now())
     where not exists (
       select 1 from saas_ugc.ugc_credit_purchases p where p.recharge_order_id = v_order.id
     );

    insert into saas_ugc.ugc_notifications(user_id, title, body, kind, href)
    values (v_order.user_id, 'Paiement confirmé',
      v_order.credits_to_grant::text || ' crédits Studio ont été ajoutés à votre solde.',
      'success', '/app/credits');
    insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
    values (v_order.user_id, 'saspay_payment_confirmed', 'recharge_order', p_order_id::text,
      jsonb_build_object('actor', 'system', 'credits', v_order.credits_to_grant,
        'amount_minor', v_order.amount_minor, 'payment_id', v_payment, 'source', p_source));

    select * into v_order from saas_ugc.ugc_recharge_orders o where o.id = p_order_id;
    return ugc_private.vyora_studio_order_json(v_order)
      || jsonb_build_object('outcome', 'paid', 'credited', true, 'ledger_id', v_ledger);
  end if;

  if v_status in ('FAILED', 'CANCELLED') then
    update saas_ugc.ugc_recharge_orders
       set status = case when status in ('pending', 'processing')
                         then (case when v_status = 'FAILED' then 'failed' else 'cancelled' end)
                         else status end,
           provider_payment_id = coalesce(provider_payment_id, v_payment),
           provider_status = v_status,
           failure_code = coalesce(nullif(p_failure_code, ''), lower(v_status)),
           last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id returning * into v_order;
    return ugc_private.vyora_studio_order_json(v_order)
      || jsonb_build_object('outcome', lower(v_status), 'credited', false);
  end if;

  -- PENDING : rien n'est livré.
  update saas_ugc.ugc_recharge_orders
     set status = case when status = 'pending' then 'processing' else status end,
         provider_payment_id = coalesce(provider_payment_id, v_payment),
         provider_status = v_status,
         last_verified_at = now(), verify_count = verify_count + 1
   where id = p_order_id returning * into v_order;
  return ugc_private.vyora_studio_order_json(v_order)
    || jsonb_build_object('outcome', 'pending', 'credited', false);
end $$;

-- =============================================================================
-- 3. BUSINESS GROW — commandes d'abonnement
-- =============================================================================
-- Convention Business Grow : `monthly_price_minor` est exprimé en unités de la
-- devise (le XOF n'a pas de centimes) — convention propre à ce produit.
create table if not exists saas_business.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  plan_key text not null references saas_business.plans(plan_key) on delete restrict,
  plan_label text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null check (char_length(currency) = 3),
  country_code text not null check (char_length(country_code) = 2),
  period_days integer not null check (period_days > 0),
  monthly_credit_units integer check (monthly_credit_units is null or monthly_credit_units >= 0),
  provider text not null default 'saspay',
  internal_reference text not null unique,
  idempotency_key text not null,
  payment_flow text not null check (payment_flow in ('softpay', 'checkout')),
  network_code text,
  payer_msisdn_masked text,
  provider_payment_id text,
  provider_session_id text,
  provider_status text,
  checkout_url text,
  quoted_fee_mode text,
  quoted_fee_amount numeric(18,2),
  quoted_total_amount numeric(18,2),
  fee_charge_mode text,
  fee_amount numeric(18,2),
  charged_amount numeric(18,2),
  net_amount numeric(18,2),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'paid', 'failed', 'cancelled')),
  failure_code text,
  subscription_id uuid,
  billing_event_id uuid,
  initiated_at timestamptz,
  last_verified_at timestamptz,
  verify_count integer not null default 0,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create unique index if not exists payment_orders_provider_payment_key
  on saas_business.payment_orders(provider, provider_payment_id) where provider_payment_id is not null;
create unique index if not exists payment_orders_provider_session_key
  on saas_business.payment_orders(provider, provider_session_id) where provider_session_id is not null;
create index if not exists payment_orders_user_idx
  on saas_business.payment_orders(user_id, created_at desc);

create table if not exists saas_business.payment_webhook_events (
  event_key text primary key,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processed', 'failed')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table saas_business.payment_orders enable row level security;
alter table saas_business.payment_orders force row level security;
alter table saas_business.payment_webhook_events enable row level security;
alter table saas_business.payment_webhook_events force row level security;
drop policy if exists owner_payment_orders on saas_business.payment_orders;
create policy owner_payment_orders on saas_business.payment_orders to bg_owner using (true) with check (true);
drop policy if exists owner_payment_webhook_events on saas_business.payment_webhook_events;
create policy owner_payment_webhook_events on saas_business.payment_webhook_events to bg_owner using (true) with check (true);
revoke all on saas_business.payment_orders from public, anon, authenticated, service_role;
revoke all on saas_business.payment_webhook_events from public, anon, authenticated, service_role;

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
       or new.subscription_id is not null or new.billing_event_id is not null then
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
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'paid_order_is_terminal';
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
  return new;
end $$;

drop trigger if exists vyora_payment_order_guard on saas_business.payment_orders;
create trigger vyora_payment_order_guard
  before insert or update on saas_business.payment_orders
  for each row execute function saas_business.vyora_guard_payment_order();

create or replace function saas_business.vyora_payment_order_json(o saas_business.payment_orders)
returns jsonb
language sql
stable
set search_path = pg_catalog, saas_business
as $$
  select jsonb_build_object(
    'product', 'business',
    'id', o.id,
    'user_id', o.user_id,
    'status', o.status,
    'amount', o.amount_minor::text || '.00',
    'currency', o.currency,
    'country', o.country_code,
    'internal_reference', o.internal_reference,
    'label', o.plan_label,
    'plan_key', o.plan_key,
    'period_days', o.period_days,
    'monthly_credit_units', o.monthly_credit_units,
    'payment_flow', o.payment_flow,
    'network_code', o.network_code,
    'payer_msisdn_masked', o.payer_msisdn_masked,
    'provider_payment_id', o.provider_payment_id,
    'provider_session_id', o.provider_session_id,
    'provider_status', o.provider_status,
    'checkout_url', o.checkout_url,
    'quoted_fee_mode', o.quoted_fee_mode,
    'quoted_fee_amount', trim(to_char(o.quoted_fee_amount, 'FM9999999999999990.00')),
    'quoted_total_amount', trim(to_char(o.quoted_total_amount, 'FM9999999999999990.00')),
    'fee_charge_mode', o.fee_charge_mode,
    'fee_amount', trim(to_char(o.fee_amount, 'FM9999999999999990.00')),
    'charged_amount', trim(to_char(o.charged_amount, 'FM9999999999999990.00')),
    'net_amount', trim(to_char(o.net_amount, 'FM9999999999999990.00')),
    'failure_code', o.failure_code,
    'subscription_id', o.subscription_id,
    'created_at', o.created_at,
    'initiated_at', o.initiated_at,
    'last_verified_at', o.last_verified_at,
    'paid_at', o.paid_at,
    'expires_at', o.expires_at
  );
$$;

-- Prix d'une formule Business Grow : uniquement si la formule est réellement
-- commercialisée (active, facturable, prix fixé) et si SasPay est déclaré comme
-- prestataire dans la configuration commerciale Business Grow.
create or replace function saas_business.vyora_plan_price(p_plan_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_cfg jsonb;
  v_plan saas_business.plans%rowtype;
begin
  select value into v_cfg from saas_business.commercial_config where config_key = 'pricing';
  if coalesce((v_cfg->>'billing_enabled')::boolean, false) is not true
     or not (coalesce(v_cfg->'payment_providers', '[]'::jsonb) ? 'saspay') then
    raise exception 'business_billing_disabled';
  end if;
  select * into v_plan from saas_business.plans where plan_key = p_plan_key;
  if not found or not v_plan.active or not v_plan.billing_enabled
     or v_plan.monthly_price_minor is null or v_plan.monthly_price_minor <= 0 then
    raise exception 'business_plan_not_purchasable';
  end if;
  if upper(v_plan.currency) <> 'XOF' then raise exception 'payment_currency_not_supported'; end if;
  return jsonb_build_object(
    'plan_key', v_plan.plan_key,
    'label', 'Business Grow — ' || v_plan.display_name,
    'price', v_plan.monthly_price_minor,
    'currency', upper(v_plan.currency),
    'monthly_credit_units', v_plan.monthly_credit_units,
    'period_days', greatest(coalesce((v_cfg->>'renewal_period_days')::integer, 30), 1)
  );
end $$;

-- Un utilisateur n'a qu'UN abonnement courant (index unique existant). Un achat
-- n'est donc possible que pour : un premier abonnement, un renouvellement de la
-- même formule, ou une nouvelle formule une fois la période en cours terminée.
-- Renvoie le motif de refus, ou NULL si l'achat est possible.
create or replace function saas_business.vyora_subscription_block(p_user_id uuid, p_plan_key text)
returns text
language sql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
  select case
           when s.billing_provider is distinct from 'saspay' then 'business_subscription_managed_elsewhere'
           when s.plan_key <> p_plan_key and s.current_period_end is not null and s.current_period_end > now()
             then 'business_plan_change_not_supported'
         end
    from saas_business.subscriptions s
   where s.user_id = p_user_id and s.status in ('trialing', 'active', 'past_due')
   limit 1;
$$;

revoke all on function saas_business.vyora_subscription_block(uuid, text) from public, anon, authenticated, service_role;
revoke all on function saas_business.vyora_guard_payment_order() from public, anon, authenticated, service_role;
revoke all on function saas_business.vyora_payment_order_json(saas_business.payment_orders) from public, anon, authenticated, service_role;
revoke all on function saas_business.vyora_plan_price(text) from public, anon, authenticated, service_role;

-- 3.1 Création d'une commande Business Grow ----------------------------------------------
create or replace function public.vyora_payment_create_bg_order(
  p_user_id uuid,
  p_plan_key text,
  p_country text,
  p_flow text,
  p_network text,
  p_idempotency_key text,
  p_quoted_fee numeric default null,
  p_quoted_total numeric default null,
  p_quoted_fee_mode text default null,
  p_msisdn_masked text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_country jsonb;
  v_price jsonb;
  v_order saas_business.payment_orders%rowtype;
  v_network text;
  v_open integer;
  v_ttl integer;
  v_block text;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'not_authenticated';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9:_-]{8,80}$' then
    raise exception 'invalid_idempotency_key';
  end if;

  v_country := ugc_private.vyora_payment_check_route(v_cfg, p_country, p_flow, p_network);
  v_price := saas_business.vyora_plan_price(p_plan_key);
  if coalesce(v_country->>'currency', '') <> (v_price->>'currency') then
    raise exception 'payment_currency_not_supported';
  end if;
  v_network := case when p_flow = 'softpay' then p_network end;
  v_block := saas_business.vyora_subscription_block(p_user_id, p_plan_key);
  if v_block is not null then raise exception '%', v_block; end if;

  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-business:' || p_user_id::text, 0));

  select * into v_order from saas_business.payment_orders o
   where o.user_id = p_user_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.plan_key <> p_plan_key
       or v_order.amount_minor <> (v_price->>'price')::bigint
       or v_order.payment_flow <> p_flow
       or v_order.network_code is distinct from v_network then
      raise exception 'idempotency_key_reused';
    end if;
    return saas_business.vyora_payment_order_json(v_order) || jsonb_build_object('reused', true);
  end if;

  v_ttl := greatest(coalesce((v_cfg->>'order_ttl_minutes')::integer, 30), 5);
  select count(*) into v_open from saas_business.payment_orders o
   where o.user_id = p_user_id and o.status in ('pending', 'processing')
     and o.created_at > now() - make_interval(mins => v_ttl);
  if v_open >= greatest(coalesce((v_cfg->>'max_open_orders')::integer, 3), 1) then
    raise exception 'too_many_open_payments';
  end if;

  insert into saas_business.payment_orders(
    user_id, plan_key, plan_label, amount_minor, currency, country_code, period_days,
    monthly_credit_units, provider, internal_reference, idempotency_key, payment_flow, network_code,
    payer_msisdn_masked, quoted_fee_mode, quoted_fee_amount, quoted_total_amount, expires_at
  ) values (
    p_user_id, p_plan_key, v_price->>'label', (v_price->>'price')::bigint, v_price->>'currency',
    upper(trim(p_country)), (v_price->>'period_days')::integer,
    (v_price->>'monthly_credit_units')::integer, 'saspay',
    'VYB-' || upper(replace(gen_random_uuid()::text, '-', '')), p_idempotency_key, p_flow, v_network,
    nullif(left(coalesce(p_msisdn_masked, ''), 24), ''),
    case when p_quoted_fee_mode in ('ADD_ON', 'DEDUCTED') then p_quoted_fee_mode end,
    p_quoted_fee, p_quoted_total, now() + make_interval(mins => v_ttl)
  ) returning * into v_order;

  return saas_business.vyora_payment_order_json(v_order) || jsonb_build_object('reused', false);
end $$;

-- 3.2 Rattachement des identifiants SasPay -----------------------------------------------
create or replace function public.vyora_payment_bg_attach(
  p_order_id uuid,
  p_payment_id text,
  p_session_id text,
  p_checkout_url text,
  p_provider_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_business.payment_orders%rowtype;
begin
  perform ugc_private.vyora_assert_service_role();
  select * into v_order from saas_business.payment_orders o where o.id = p_order_id for update;
  if not found then raise exception 'payment_order_not_found'; end if;
  if v_order.status = 'paid' then return saas_business.vyora_payment_order_json(v_order); end if;
  if (v_order.provider_payment_id is not null and p_payment_id is not null and v_order.provider_payment_id <> p_payment_id)
     or (v_order.provider_session_id is not null and p_session_id is not null and v_order.provider_session_id <> p_session_id) then
    raise exception 'provider_reference_conflict';
  end if;

  update saas_business.payment_orders
     set provider_payment_id = coalesce(provider_payment_id, nullif(p_payment_id, '')),
         provider_session_id = coalesce(provider_session_id, nullif(p_session_id, '')),
         checkout_url = coalesce(nullif(p_checkout_url, ''), checkout_url),
         provider_status = coalesce(nullif(upper(p_provider_status), ''), provider_status),
         status = case when status = 'pending' then 'processing' else status end,
         initiated_at = coalesce(initiated_at, now())
   where id = p_order_id
   returning * into v_order;
  return saas_business.vyora_payment_order_json(v_order);
end $$;

-- 3.3 Règlement d'une commande Business Grow --------------------------------------------
-- L'activation passe par le pipeline EXISTANT (`billing_events` →
-- `bg_apply_billing_event`), qui porte déjà les gardes d'abonnement.
create or replace function public.vyora_payment_bg_settle(
  p_order_id uuid,
  p_payment_id text,
  p_provider_status text,
  p_requested_amount numeric,
  p_currency text,
  p_fee numeric,
  p_charged numeric,
  p_net numeric,
  p_fee_mode text,
  p_reference text,
  p_source text,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order saas_business.payment_orders%rowtype;
  v_status text := upper(coalesce(p_provider_status, ''));
  v_payment text := nullif(trim(coalesce(p_payment_id, '')), '');
  v_sub saas_business.subscriptions%rowtype;
  v_sub_id uuid;
  v_customer text;
  v_external text;
  v_start timestamptz;
  v_end timestamptz;
  v_data jsonb;
  v_event uuid;
  v_token uuid := gen_random_uuid();
  v_before integer;
  v_after integer;
begin
  perform ugc_private.vyora_assert_service_role();
  if v_status not in ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED') then
    raise exception 'unknown_provider_status';
  end if;
  select * into v_order from saas_business.payment_orders o where o.id = p_order_id for update;
  if not found then raise exception 'payment_order_not_found'; end if;
  if v_order.provider_payment_id is not null and v_payment is not null
     and v_order.provider_payment_id <> v_payment then
    raise exception 'provider_reference_conflict';
  end if;
  if v_status = 'SUCCESS' and v_payment is null then raise exception 'payment_id_required'; end if;

  -- Déjà réglée (ou remboursée depuis) : aucune seconde activation.
  if v_order.status in ('paid', 'refunded') then
    update saas_business.payment_orders
       set last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id returning * into v_order;
    return saas_business.vyora_payment_order_json(v_order)
      || jsonb_build_object('outcome', 'already_paid', 'credited', false);
  end if;

  if v_status = 'SUCCESS' then
    if p_requested_amount is null or p_requested_amount <> v_order.amount_minor::numeric
       or upper(coalesce(trim(p_currency), '')) <> v_order.currency then
      update saas_business.payment_orders
         set provider_payment_id = coalesce(provider_payment_id, v_payment),
             provider_status = v_status, failure_code = 'amount_mismatch',
             last_verified_at = now(), verify_count = verify_count + 1
       where id = p_order_id returning * into v_order;
      return saas_business.vyora_payment_order_json(v_order)
        || jsonb_build_object('outcome', 'amount_mismatch', 'credited', false);
    end if;

    -- Un seul abonnement courant par utilisateur (index unique existant). Un
    -- renouvellement prolonge donc la MÊME ligne ; son identité (prestataire,
    -- identifiants externes) est immuable et reprise telle quelle.
    select * into v_sub from saas_business.subscriptions s
     where s.user_id = v_order.user_id and s.status in ('trialing', 'active', 'past_due')
     for update;
    if found then
      if v_sub.billing_provider is distinct from 'saspay' then
        raise exception 'business_subscription_managed_elsewhere';
      end if;
      v_sub_id := v_sub.id;
      v_customer := v_sub.external_customer_id;
      v_external := v_sub.external_subscription_id;
      if v_sub.plan_key = v_order.plan_key
         and v_sub.current_period_end is not null and v_sub.current_period_end > now() then
        -- Même formule encore en cours : la période payée s'ajoute à la suite.
        v_start := coalesce(v_sub.current_period_start, now());
        v_end := v_sub.current_period_end + make_interval(days => v_order.period_days);
      else
        v_start := now();
        v_end := now() + make_interval(days => v_order.period_days);
      end if;
    else
      v_sub_id := v_order.id;
      v_customer := v_order.user_id::text;
      v_external := v_order.internal_reference;
      v_start := now();
      v_end := now() + make_interval(days => v_order.period_days);
    end if;

    v_data := jsonb_build_object(
      'user_id', v_order.user_id,
      'subscription_id', v_sub_id,
      'plan_key', v_order.plan_key,
      'status', 'active',
      'external_customer_id', v_customer,
      'external_subscription_id', v_external,
      'period_start', v_start,
      'period_end', v_end,
      'payment_order_id', v_order.id
    );
    v_event := saas_business.bg_receive_billing_event(
      'saspay', 'saspay:success:' || v_payment, 'transaction.success',
      md5(v_data::text), v_data, now()
    );
    update saas_business.billing_events
       set processing_status = 'processing', lease_token = v_token,
           lease_until = now() + interval '60 seconds', attempt_count = attempt_count + 1
     where id = v_event and processing_status = 'received';
    if not found then raise exception 'billing_event_not_claimable'; end if;
    perform saas_business.bg_apply_billing_event(v_event, v_token);

    -- Quota mensuel de la formule (si la formule en définit un).
    if v_order.monthly_credit_units is not null then
      perform saas_business.bg_ensure_wallet(v_order.user_id);
      select w.available_units into v_before from saas_business.wallets w
       where w.user_id = v_order.user_id for update;
      update saas_business.wallets
         set monthly_allowance = v_order.monthly_credit_units,
             available_units = greatest(available_units, v_order.monthly_credit_units)
       where user_id = v_order.user_id
       returning available_units into v_after;
      if v_after > v_before then
        insert into saas_business.credit_ledger(user_id, delta, balance_after, kind, reason)
        values (v_order.user_id, v_after - v_before, v_after, 'monthly_grant',
                'Activation ' || v_order.plan_label);
      end if;
    end if;

    update saas_business.payment_orders
       set status = 'paid', paid_at = now(),
           provider_payment_id = coalesce(provider_payment_id, v_payment),
           provider_status = v_status,
           fee_charge_mode = case when p_fee_mode in ('ADD_ON', 'DEDUCTED') then p_fee_mode else fee_charge_mode end,
           fee_amount = coalesce(p_fee, fee_amount),
           charged_amount = coalesce(p_charged, charged_amount),
           net_amount = coalesce(p_net, net_amount),
           failure_code = null,
           subscription_id = v_sub_id, billing_event_id = v_event,
           last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id returning * into v_order;
    return saas_business.vyora_payment_order_json(v_order)
      || jsonb_build_object('outcome', 'paid', 'credited', true);
  end if;

  if v_status in ('FAILED', 'CANCELLED') then
    update saas_business.payment_orders
       set status = case when status in ('pending', 'processing')
                         then (case when v_status = 'FAILED' then 'failed' else 'cancelled' end)
                         else status end,
           provider_payment_id = coalesce(provider_payment_id, v_payment),
           provider_status = v_status,
           failure_code = coalesce(nullif(p_failure_code, ''), lower(v_status)),
           last_verified_at = now(), verify_count = verify_count + 1
     where id = p_order_id returning * into v_order;
    return saas_business.vyora_payment_order_json(v_order)
      || jsonb_build_object('outcome', lower(v_status), 'credited', false);
  end if;

  update saas_business.payment_orders
     set status = case when status = 'pending' then 'processing' else status end,
         provider_payment_id = coalesce(provider_payment_id, v_payment),
         provider_status = v_status,
         last_verified_at = now(), verify_count = verify_count + 1
   where id = p_order_id returning * into v_order;
  return saas_business.vyora_payment_order_json(v_order)
    || jsonb_build_object('outcome', 'pending', 'credited', false);
end $$;

-- =============================================================================
-- 4. Aiguilleurs (service_role) — lecture seule, aucun mélange de données
-- =============================================================================
-- Devis : configuration publique + prix serveur du produit demandé.
create or replace function public.vyora_payment_quote(p_user_id uuid, p_product text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_price jsonb;
  v_eligible boolean := true;
  v_reason text;
  v_business jsonb;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product = 'studio' then
    if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
       or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
      v_eligible := false; v_reason := 'not_vyora_customer';
    elsif p_item ? 'kind' then
      v_price := ugc_private.vyora_studio_price(
        p_item->>'kind', p_item->>'pack_key', nullif(p_item->>'amount_xof', '')::bigint);
      v_price := jsonb_build_object(
        'amount', (v_price->>'price_xof') || '.00', 'currency', 'XOF',
        'label', v_price->>'label', 'credits', (v_price->>'credits')::bigint,
        'kind', v_price->>'kind', 'pack_key', v_price->>'pack_key');
    end if;
  elsif p_product = 'business' then
    select value into v_business from saas_business.commercial_config where config_key = 'pricing';
    if coalesce((v_business->>'billing_enabled')::boolean, false) is not true
       or not (coalesce(v_business->'payment_providers', '[]'::jsonb) ? 'saspay') then
      v_eligible := false; v_reason := 'business_billing_disabled';
    elsif p_item ? 'plan_key' then
      v_reason := saas_business.vyora_subscription_block(p_user_id, p_item->>'plan_key');
      v_eligible := v_reason is null;
      v_price := saas_business.vyora_plan_price(p_item->>'plan_key');
      v_price := jsonb_build_object(
        'amount', (v_price->>'price') || '.00', 'currency', v_price->>'currency',
        'label', v_price->>'label', 'plan_key', v_price->>'plan_key',
        'period_days', (v_price->>'period_days')::integer,
        'monthly_credit_units', v_price->'monthly_credit_units');
    end if;
  else
    raise exception 'invalid_product';
  end if;

  return jsonb_build_object(
    'product', p_product,
    'enabled', coalesce((v_cfg->>'enabled')::boolean, false),
    'mode', coalesce(v_cfg->>'mode', 'test'),
    'flows', coalesce(v_cfg->'flows', '[]'::jsonb),
    'countries', coalesce(v_cfg->'countries', '{}'::jsonb),
    'eligible', v_eligible,
    'reason', v_reason,
    'price', v_price
  );
end $$;

create or replace function public.vyora_payment_get_order(p_product text, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_json jsonb;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product = 'studio' then
    select ugc_private.vyora_studio_order_json(o) into v_json
      from saas_ugc.ugc_recharge_orders o where o.id = p_order_id and o.provider = 'saspay';
  elsif p_product = 'business' then
    select saas_business.vyora_payment_order_json(o) into v_json
      from saas_business.payment_orders o where o.id = p_order_id;
  else
    raise exception 'invalid_product';
  end if;
  return v_json;
end $$;

-- Retrouve (produit, commande) à partir d'un identifiant SasPay. Ne renvoie
-- aucune donnée métier : uniquement où se trouve la commande.
create or replace function public.vyora_payment_find_order(p_payment_id text, p_session_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform ugc_private.vyora_assert_service_role();
  select o.id into v_id from saas_ugc.ugc_recharge_orders o
   where o.provider = 'saspay'
     and ((p_payment_id is not null and o.provider_payment_id = p_payment_id)
       or (p_session_id is not null and o.provider_session_id = p_session_id))
   limit 1;
  if v_id is not null then return jsonb_build_object('product', 'studio', 'order_id', v_id); end if;
  select o.id into v_id from saas_business.payment_orders o
   where (p_payment_id is not null and o.provider_payment_id = p_payment_id)
      or (p_session_id is not null and o.provider_session_id = p_session_id)
   limit 1;
  if v_id is not null then return jsonb_build_object('product', 'business', 'order_id', v_id); end if;
  return null;
end $$;

-- Sessions de checkout encore ouvertes : sert à rapprocher un webhook dont la
-- transaction n'est pas encore connue (parcours hébergé).
create or replace function public.vyora_payment_open_checkout_orders(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  perform ugc_private.vyora_assert_service_role();
  return coalesce((
    select jsonb_agg(jsonb_build_object('product', x.product, 'order_id', x.id, 'session_id', x.session_id)
                     order by x.created_at desc)
      from (
        (select 'studio'::text as product, o.id, o.provider_session_id as session_id, o.created_at
           from saas_ugc.ugc_recharge_orders o
          where o.provider = 'saspay' and o.payment_flow = 'checkout'
            and o.provider_session_id is not null and o.provider_payment_id is null
            and o.status in ('pending', 'processing') and o.created_at > now() - interval '24 hours'
          order by o.created_at desc limit v_limit)
        union all
        (select 'business'::text, o.id, o.provider_session_id, o.created_at
           from saas_business.payment_orders o
          where o.payment_flow = 'checkout'
            and o.provider_session_id is not null and o.provider_payment_id is null
            and o.status in ('pending', 'processing') and o.created_at > now() - interval '24 hours'
          order by o.created_at desc limit v_limit)
      ) x
  ), '[]'::jsonb);
end $$;

-- Journal des webhooks, tenu dans le schéma du produit concerné.
create or replace function public.vyora_payment_record_webhook(
  p_product text, p_event_key text, p_event_type text, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_first boolean := false;
  v_status text;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_event_key is null or length(p_event_key) < 8 or length(p_event_key) > 200 then
    raise exception 'invalid_event_key';
  end if;
  if p_product = 'studio' then
    insert into saas_ugc.ugc_webhook_events(channel, provider, provider_event_id, event_type, payload)
    values ('payment', 'saspay', p_event_key, p_event_type, coalesce(p_payload, '{}'::jsonb))
    on conflict (provider, provider_event_id) do nothing;
    v_first := found;
    select e.processing_status into v_status from saas_ugc.ugc_webhook_events e
     where e.provider = 'saspay' and e.provider_event_id = p_event_key;
  elsif p_product = 'business' then
    insert into saas_business.payment_webhook_events(event_key, event_type, payload)
    values (p_event_key, p_event_type, coalesce(p_payload, '{}'::jsonb))
    on conflict (event_key) do nothing;
    v_first := found;
    select e.processing_status into v_status from saas_business.payment_webhook_events e
     where e.event_key = p_event_key;
  else
    raise exception 'invalid_product';
  end if;
  return jsonb_build_object('first', v_first, 'processed', coalesce(v_status = 'processed', false));
end $$;

create or replace function public.vyora_payment_finish_webhook(
  p_product text, p_event_key text, p_ok boolean, p_error text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product = 'studio' then
    update saas_ugc.ugc_webhook_events
       set processing_status = case when p_ok then 'processed' else 'failed' end,
           processed_at = now(), error_message = left(p_error, 300)
     where provider = 'saspay' and provider_event_id = p_event_key
       and processing_status <> 'processed';
  elsif p_product = 'business' then
    update saas_business.payment_webhook_events
       set processing_status = case when p_ok then 'processed' else 'failed' end,
           processed_at = now(), error_message = left(p_error, 300)
     where event_key = p_event_key and processing_status <> 'processed';
  else
    raise exception 'invalid_product';
  end if;
end $$;

create or replace function public.vyora_payment_is_admin(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.vyora_assert_service_role();
  return ugc_private.has_role(p_user_id, 'admin');
end $$;

-- =============================================================================
-- 5. Lecture côté client (JWT utilisateur) — consultation uniquement
-- =============================================================================
-- Vue d'une commande destinée au navigateur de son propriétaire : aucun
-- identifiant d'utilisateur ni identifiant SasPay, aucun instantané tarifaire.
-- `has_payment` permet de distinguer « à effectuer » de « en attente ».
create or replace function ugc_private.vyora_client_order_view(p_order jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select (p_order - array['user_id', 'provider_payment_id', 'provider_session_id', 'pricing_snapshot'])
         || jsonb_build_object('has_payment',
              (p_order->>'provider_payment_id') is not null or (p_order->>'provider_session_id') is not null)
$$;
revoke all on function ugc_private.vyora_client_order_view(jsonb) from public, anon, authenticated;

-- Historique de l'utilisateur connecté, pour UN produit à la fois.
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
        from (select ugc_private.vyora_client_order_view(ugc_private.vyora_studio_order_json(r)) as j, r.created_at
                from saas_ugc.ugc_recharge_orders r
               where r.user_id = v_user and r.provider = 'saspay'
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  elsif p_product = 'business' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select ugc_private.vyora_client_order_view(saas_business.vyora_payment_order_json(r)) as j, r.created_at
                from saas_business.payment_orders r
               where r.user_id = v_user
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  end if;
  raise exception 'invalid_product';
end $$;

-- Abonnement Business Grow courant de l'utilisateur connecté (ou NULL).
create or replace function public.vyora_business_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  return (
    select jsonb_build_object(
             'plan_key', s.plan_key,
             'plan_label', p.display_name,
             'status', s.status,
             'current_period_start', s.current_period_start,
             'current_period_end', s.current_period_end,
             'is_current', s.status in ('trialing', 'active')
                           and (s.current_period_end is null or s.current_period_end > now()))
      from saas_business.subscriptions s
      join saas_business.plans p on p.plan_key = s.plan_key
     where s.user_id = v_user and s.status in ('trialing', 'active', 'past_due')
     limit 1
  );
end $$;

-- Vue administrateur : CONSULTATION. Aucune fonction d'écriture n'est fournie :
-- un administrateur ne peut ni créer, ni modifier, ni valider un paiement SasPay.
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
        from (select ugc_private.vyora_studio_order_json(r)
                     || jsonb_build_object('user_email', (select u.email from auth.users u where u.id = r.user_id)) as j,
                     r.created_at
                from saas_ugc.ugc_recharge_orders r
               where r.provider = 'saspay'
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  elsif p_product = 'business' then
    return coalesce((
      select jsonb_agg(x.j order by x.created_at desc)
        from (select saas_business.vyora_payment_order_json(r)
                     || jsonb_build_object('user_email', (select u.email from auth.users u where u.id = r.user_id)) as j,
                     r.created_at
                from saas_business.payment_orders r
               order by r.created_at desc limit v_limit) x
    ), '[]'::jsonb);
  end if;
  raise exception 'invalid_product';
end $$;

-- =============================================================================
-- 6. Droits d'exécution
-- =============================================================================
do $$
declare
  v_fn text;
begin
  -- Écritures et aiguilleurs : Edge Functions uniquement.
  foreach v_fn in array array[
    'public.vyora_payment_create_studio_order(uuid, text, text, bigint, text, text, text, text, numeric, numeric, text, text)',
    'public.vyora_payment_studio_attach(uuid, text, text, text, text)',
    'public.vyora_payment_studio_settle(uuid, text, text, numeric, text, numeric, numeric, numeric, text, text, text, text)',
    'public.vyora_payment_create_bg_order(uuid, text, text, text, text, text, numeric, numeric, text, text)',
    'public.vyora_payment_bg_attach(uuid, text, text, text, text)',
    'public.vyora_payment_bg_settle(uuid, text, text, numeric, text, numeric, numeric, numeric, text, text, text, text)',
    'public.vyora_payment_quote(uuid, text, jsonb)',
    'public.vyora_payment_get_order(text, uuid)',
    'public.vyora_payment_find_order(text, text)',
    'public.vyora_payment_open_checkout_orders(integer)',
    'public.vyora_payment_record_webhook(text, text, text, jsonb)',
    'public.vyora_payment_finish_webhook(text, text, boolean, text)',
    'public.vyora_payment_is_admin(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;

  -- Lectures : utilisateur connecté (ses propres commandes) / administrateur.
  foreach v_fn in array array[
    'public.vyora_my_payments(text, integer)',
    'public.vyora_business_subscription()',
    'public.vyora_admin_payments(text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated, service_role', v_fn);
  end loop;
end $$;

revoke all on function saas_ugc.vyora_guard_recharge_order() from public, anon, authenticated;
