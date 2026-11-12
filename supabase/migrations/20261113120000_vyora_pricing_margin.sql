-- =============================================================================
-- VYORA — Tarification, provision commerciale et rapprochement financier
-- =============================================================================
-- Migration ADDITIVE et rejouable. Elle complète
-- `20261113100000_vyora_saspay_payments.sql` et
-- `20261113110000_vyora_saspay_refunds_reconcile.sql` sans les réécrire.
--
-- POLITIQUE COMMUNE à tous les encaissements VYORA (Studio, Business Grow, et
-- tout achat futur : un seul point de calcul, `ugc_private.vyora_price_quote`).
--
--   prix final client = plus petit montant P, arrondi au pas de la devise, tel que
--       P ≥ prix de base + provision                (provision commerciale)
--       P − frais SasPay estimés(P) ≥ prix de base  (net commercial préservé)
--
--   * La provision (1 000 FCFA à l'origine) est CONFIGURABLE et ce n'est pas une
--     garantie : quand un tarif confirmé annonce des frais supérieurs, le prix
--     est relevé d'autant (stratégie `cover_fees`) ; la stratégie
--     `provision_only` s'en tient à base + provision.
--   * Les frais portent sur le TOTAL encaissé (mode « Déduits » : SasPay débite
--     au client le montant demandé et retient ses frais sur ce montant). Le prix
--     est donc résolu par itération en nombres entiers, jamais par
--     « base + pourcentage ». Une ligne de barème peut déclarer l'autre assiette
--     (`fee_base = 'base'`).
--   * AUCUN TARIF N'EST LIVRÉ avec cette migration : le barème est vide. Il se
--     remplit avec des tarifs confirmés (documentation SasPay, tarifs du compte
--     lus par `GET /pricing/my-rates/`, ou valeurs fournies par l'exploitant).
--     Sans tarif, seul « base + provision » s'applique et l'absence est signalée.
--   * Tous les montants sont des ENTIERS en centièmes de l'unité monétaire
--     (même échelle que les montants décimaux échangés avec SasPay). Aucun
--     calcul en virgule flottante.
--   * Le devis est FIGÉ sur la commande (`pricing_quote`, immuable). Après
--     confirmation serveur (`SUCCESS`, montant et devise conformes — règles
--     inchangées), une ligne de rapprochement IMMUABLE est écrite.
--   * Les décaissements (payouts) ont leurs propres lignes de barème et ne
--     reçoivent jamais la provision.
-- =============================================================================

-- 0. Politique (administrable sans redéploiement) -----------------------------------
insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'vyora_pricing_policy',
  jsonb_build_object(
    'enabled', true,
    -- cover_fees     : base + provision, relevé si les frais estimés la dépassent
    -- provision_only : base + provision, sans relèvement
    'strategy', 'cover_fees',
    'fee_charge_mode', 'DEDUCTED',
    'currencies', jsonb_build_object(
      -- 1 000 FCFA de provision ; prix final arrondi au franc supérieur.
      'XOF', jsonb_build_object('provision_cents', 100000, 'rounding_step_cents', 100)
    )
  ),
  'Tarification VYORA : provision par transaction, stratégie de couverture des frais SasPay, arrondi'
)
on conflict (setting_key) do nothing;

create or replace function ugc_private.vyora_pricing_policy()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select s.setting_value from saas_ugc.ugc_app_settings s where s.setting_key = 'vyora_pricing_policy'),
    jsonb_build_object('enabled', false)
  );
$$;

-- Contrôle et normalisation d'une politique saisie par un administrateur.
create or replace function ugc_private.vyora_pricing_policy_check(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
  v_cur jsonb;
  v_out jsonb := '{}'::jsonb;
  v_provision bigint;
  v_step bigint;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'pricing_policy_invalid'; end if;
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' then raise exception 'pricing_policy_invalid'; end if;
  if coalesce(p->>'strategy', '') not in ('cover_fees', 'provision_only') then
    raise exception 'pricing_policy_invalid';
  end if;
  if jsonb_typeof(p->'currencies') is distinct from 'object' then raise exception 'pricing_policy_invalid'; end if;
  for v_key, v_cur in select e.key, e.value from jsonb_each(p->'currencies') e loop
    if v_key !~ '^[A-Z]{3}$' or jsonb_typeof(v_cur) <> 'object'
       or coalesce(v_cur->>'provision_cents', '') !~ '^[0-9]{1,12}$'
       or coalesce(v_cur->>'rounding_step_cents', '') !~ '^[0-9]{1,9}$' then
      raise exception 'pricing_policy_invalid';
    end if;
    v_provision := (v_cur->>'provision_cents')::bigint;
    v_step := (v_cur->>'rounding_step_cents')::bigint;
    -- Les prix sont en unités entières de la devise : pas multiple de 100 centièmes.
    if v_step < 100 or v_step % 100 <> 0 or v_step > 100000000 or v_provision % 100 <> 0 then
      raise exception 'pricing_policy_invalid';
    end if;
    v_out := v_out || jsonb_build_object(v_key,
      jsonb_build_object('provision_cents', v_provision, 'rounding_step_cents', v_step));
  end loop;
  if (p->'enabled')::boolean and v_out = '{}'::jsonb then raise exception 'pricing_policy_invalid'; end if;
  return jsonb_build_object(
    'enabled', (p->'enabled')::boolean, 'strategy', p->>'strategy',
    'fee_charge_mode', 'DEDUCTED', 'currencies', v_out);
end $$;

create or replace function ugc_private.vyora_cents_text(p_cents bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(to_char(p_cents::numeric / 100, 'FM9999999999999990.00'));
$$;

-- =============================================================================
-- 1. BARÈME DES FRAIS — tarifs CONFIRMÉS uniquement, historisés
-- =============================================================================
-- Une ligne = un palier de tarif. `country_code` ou `network_code` NULL = tous.
-- Résolution : la ligne la plus précise l'emporte (opérateur, puis pays), puis
-- la plus récente. Une ligne n'est jamais modifiée ni supprimée : on la clôt
-- (`valid_until`) et on en crée une autre, pour que chaque devis passé reste
-- explicable.
create table if not exists saas_ugc.vyora_fee_schedule (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'saspay' check (provider = 'saspay'),
  -- payin : encaissement d'un client ; payout : décaissement vers un bénéficiaire.
  transaction_type text not null check (transaction_type in ('payin', 'payout')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  network_code text check (network_code is null or network_code ~ '^[a-z0-9_]{2,40}$'),
  -- Palier : montant (assiette des frais) compris entre ces bornes, en centièmes.
  min_amount_cents bigint not null default 0 check (min_amount_cents >= 0),
  max_amount_cents bigint check (max_amount_cents is null or max_amount_cents >= min_amount_cents),
  -- Pourcentage en MILLIÈMES de pour cent (2,5 % = 2500). Borné à 50 %.
  percent_milli integer not null default 0 check (percent_milli between 0 and 50000),
  fixed_cents bigint not null default 0 check (fixed_cents >= 0),
  -- Minimum et maximum des frais.
  floor_fee_cents bigint check (floor_fee_cents is null or floor_fee_cents >= 0),
  cap_fee_cents bigint check (cap_fee_cents is null or cap_fee_cents >= 0),
  -- Assiette : `total` = montant total encaissé (cas du mode « Déduits ») ;
  -- `base` = prix de base hors frais.
  fee_base text not null default 'total' check (fee_base in ('total', 'base')),
  -- Mode de frais annoncé par le compte SasPay pour ce palier (information).
  account_fee_mode text check (account_fee_mode is null or account_fee_mode in ('ADD_ON', 'DEDUCTED')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  -- Origine du tarif : jamais de valeur supposée.
  source text not null check (source in ('saspay_documentation', 'saspay_account_rates', 'owner_provided')),
  source_note text not null check (char_length(trim(source_note)) >= 5),
  created_by uuid,
  created_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz,
  check (valid_until is null or valid_until > valid_from),
  check (cap_fee_cents is null or floor_fee_cents is null or cap_fee_cents >= floor_fee_cents)
);
create index if not exists vyora_fee_schedule_lookup_idx
  on saas_ugc.vyora_fee_schedule(transaction_type, currency, country_code, network_code, valid_from desc);

alter table saas_ugc.vyora_fee_schedule enable row level security;
alter table saas_ugc.vyora_fee_schedule force row level security;
revoke all on saas_ugc.vyora_fee_schedule from public, anon, authenticated, service_role;

create or replace function saas_ugc.vyora_fee_schedule_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'fee_schedule_is_append_only'; end if;
  -- Seule la clôture est permise, une seule fois.
  if (to_jsonb(new) - array['valid_until', 'closed_by', 'closed_at'])
       is distinct from (to_jsonb(old) - array['valid_until', 'closed_by', 'closed_at'])
     or old.closed_at is not null
     or new.valid_until is null or new.closed_at is null then
    raise exception 'fee_schedule_is_append_only';
  end if;
  return new;
end $$;

drop trigger if exists vyora_fee_schedule_guard on saas_ugc.vyora_fee_schedule;
create trigger vyora_fee_schedule_guard
  before update or delete on saas_ugc.vyora_fee_schedule
  for each row execute function saas_ugc.vyora_fee_schedule_guard();

-- Frais d'un palier pour un montant. Entiers uniquement ; la part
-- proportionnelle est arrondie au centième SUPÉRIEUR (estimation prudente).
create or replace function ugc_private.vyora_fee_amount(
  p_amount_cents bigint, p_percent_milli integer, p_fixed_cents bigint, p_floor_cents bigint, p_cap_cents bigint
)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_fee bigint;
begin
  if p_amount_cents is null or p_amount_cents < 0 then return null; end if;
  -- pourcentage en millièmes de pour cent : montant × p / (100 × 1000)
  v_fee := (p_amount_cents * coalesce(p_percent_milli, 0) + 99999) / 100000 + coalesce(p_fixed_cents, 0);
  if p_floor_cents is not null and v_fee < p_floor_cents then v_fee := p_floor_cents; end if;
  if p_cap_cents is not null and v_fee > p_cap_cents then v_fee := p_cap_cents; end if;
  return v_fee;
end $$;

-- Ligne applicable à UN opérateur (ou générique si p_network est NULL).
create or replace function ugc_private.vyora_fee_line(
  p_type text, p_country text, p_currency text, p_network text,
  p_total_cents bigint, p_base_cents bigint, p_at timestamptz
)
returns saas_ugc.vyora_fee_schedule
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
    from saas_ugc.vyora_fee_schedule s
   where s.transaction_type = p_type and s.currency = p_currency
     and s.valid_from <= p_at and (s.valid_until is null or s.valid_until > p_at)
     and (s.country_code is null or s.country_code = p_country)
     and (s.network_code is null or s.network_code = p_network)
     and (case when s.fee_base = 'total' then p_total_cents else p_base_cents end) >= s.min_amount_cents
     and (s.max_amount_cents is null
          or (case when s.fee_base = 'total' then p_total_cents else p_base_cents end) <= s.max_amount_cents)
   order by (s.network_code is not null) desc, (s.country_code is not null) desc,
            s.valid_from desc, s.created_at desc, s.id
   limit 1;
$$;

-- Frais les plus élevés parmi les opérateurs possibles d'un pays : c'est eux
-- qui fixent le prix, afin que le net soit préservé quel que soit l'opérateur
-- choisi. `p_networks` NULL = tous les opérateurs (page de paiement hébergée :
-- le client choisit son opérateur chez SasPay).
create or replace function ugc_private.vyora_fee_worst(
  p_type text, p_country text, p_currency text, p_networks text[],
  p_total_cents bigint, p_base_cents bigint, p_at timestamptz
)
returns table(fee_cents bigint, line_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with resolved as (
    select distinct on (s.network_code)
           s.id, s.fee_base, s.percent_milli, s.fixed_cents, s.floor_fee_cents, s.cap_fee_cents
      from saas_ugc.vyora_fee_schedule s
     where s.transaction_type = p_type and s.currency = p_currency
       and s.valid_from <= p_at and (s.valid_until is null or s.valid_until > p_at)
       and (s.country_code is null or s.country_code = p_country)
       and (s.network_code is null or p_networks is null or s.network_code = any(p_networks))
       and (case when s.fee_base = 'total' then p_total_cents else p_base_cents end) >= s.min_amount_cents
       and (s.max_amount_cents is null
            or (case when s.fee_base = 'total' then p_total_cents else p_base_cents end) <= s.max_amount_cents)
     order by s.network_code, (s.country_code is not null) desc, s.valid_from desc, s.created_at desc, s.id
  )
  select ugc_private.vyora_fee_amount(
           case when r.fee_base = 'total' then p_total_cents else p_base_cents end,
           r.percent_milli, r.fixed_cents, r.floor_fee_cents, r.cap_fee_cents) as fee_cents,
         r.id
    from resolved r
   order by 1 desc, r.id
   limit 1;
$$;

-- =============================================================================
-- 2. DEVIS — point de calcul unique
-- =============================================================================
create or replace function ugc_private.vyora_price_quote(
  p_product text, p_base_cents bigint, p_currency text, p_country text, p_network text,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy jsonb := ugc_private.vyora_pricing_policy();
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_enabled boolean := coalesce((v_policy->>'enabled')::boolean, false);
  v_currency text := upper(trim(coalesce(p_currency, '')));
  v_country text := upper(trim(coalesce(p_country, '')));
  v_network text := nullif(trim(coalesce(p_network, '')), '');
  v_cur jsonb;
  v_strategy text := 'none';
  v_provision bigint := 0;
  v_step bigint := 100;
  v_networks text[];
  v_total bigint;
  v_fee bigint;
  v_line uuid;
  v_iter integer := 0;
  v_est bigint;
  v_est_line saas_ugc.vyora_fee_schedule%rowtype;
begin
  if p_base_cents is null or p_base_cents <= 0 then raise exception 'pricing_invalid_base'; end if;
  if v_enabled then
    v_cur := v_policy->'currencies'->v_currency;
    if v_cur is null or jsonb_typeof(v_cur) <> 'object' then
      -- Pas de provision inventée pour une devise non paramétrée.
      raise exception 'pricing_currency_not_configured';
    end if;
    v_provision := greatest(coalesce((v_cur->>'provision_cents')::bigint, 0), 0);
    v_step := greatest(coalesce((v_cur->>'rounding_step_cents')::bigint, 100), 100);
    v_strategy := case when v_policy->>'strategy' = 'provision_only' then 'provision_only' else 'cover_fees' end;
    v_total := ((p_base_cents + v_provision + v_step - 1) / v_step) * v_step;
  else
    v_total := p_base_cents;
  end if;

  -- Parcours hébergé activé : tout opérateur du pays est possible. Sinon, seuls
  -- ceux proposés par VYORA (et les lignes génériques) comptent.
  if not (coalesce(v_cfg->'flows', '[]'::jsonb) ? 'checkout') then
    select coalesce(array_agg(n.value->>'code'), '{}'::text[]) into v_networks
      from jsonb_array_elements(
             case when jsonb_typeof(v_cfg->'countries'->v_country->'networks') = 'array'
                  then v_cfg->'countries'->v_country->'networks' else '[]'::jsonb end) n;
  end if;

  loop
    select w.fee_cents, w.line_id into v_fee, v_line
      from ugc_private.vyora_fee_worst('payin', v_country, v_currency, v_networks, v_total, p_base_cents, p_at) w;
    if not found then v_fee := null; v_line := null; end if;
    exit when v_fee is null or v_strategy <> 'cover_fees' or v_total - v_fee >= p_base_cents;
    v_iter := v_iter + 1;
    if v_iter > 200 then raise exception 'pricing_not_convergent'; end if;
    -- Les frais portent sur le total : on relève le total et on réévalue.
    v_total := ((p_base_cents + v_fee + v_step - 1) / v_step) * v_step;
  end loop;

  -- Estimation propre à la commande : opérateur connu → sa ligne ; sinon le pire cas.
  if v_network is not null then
    v_est_line := ugc_private.vyora_fee_line('payin', v_country, v_currency, v_network, v_total, p_base_cents, p_at);
    if v_est_line.id is not null then
      v_est := ugc_private.vyora_fee_amount(
        case when v_est_line.fee_base = 'total' then v_total else p_base_cents end,
        v_est_line.percent_milli, v_est_line.fixed_cents, v_est_line.floor_fee_cents, v_est_line.cap_fee_cents);
    end if;
  elsif v_line is not null then
    select * into v_est_line from saas_ugc.vyora_fee_schedule s where s.id = v_line;
    v_est := v_fee;
  end if;

  return jsonb_build_object(
    'version', 1,
    'product', p_product,
    'policy_enabled', v_enabled,
    'strategy', v_strategy,
    'currency', v_currency,
    'country', v_country,
    'network', v_network,
    'base_cents', p_base_cents,
    'provision_cents', v_provision,
    'final_cents', v_total,
    'surcharge_cents', v_total - p_base_cents,
    'rounding_step_cents', v_step,
    'pricing_fee_cents', v_fee,
    'pricing_tariff_id', v_line,
    'estimated_fee_cents', v_est,
    'expected_net_cents', v_total - v_est,
    'expected_margin_cents', v_total - v_est - p_base_cents,
    'tariff_status', case when v_est is null then 'missing' else 'confirmed' end,
    'tariff_id', v_est_line.id,
    'tariff', case when v_est_line.id is null then null else jsonb_build_object(
      'percent_milli', v_est_line.percent_milli, 'fixed_cents', v_est_line.fixed_cents,
      'floor_fee_cents', v_est_line.floor_fee_cents, 'cap_fee_cents', v_est_line.cap_fee_cents,
      'fee_base', v_est_line.fee_base, 'source', v_est_line.source,
      'country_code', v_est_line.country_code, 'network_code', v_est_line.network_code) end,
    'fee_charge_mode', case when v_enabled then 'DEDUCTED' end,
    'iterations', v_iter,
    'computed_at', p_at
  );
end $$;

-- Décaissement (payout) : frais estimés d'après les lignes `payout`, SANS provision
-- et sans relèvement de prix. Aucun décaissement n'est exécuté ici.
create or replace function ugc_private.vyora_payout_quote(
  p_amount_cents bigint, p_currency text, p_country text, p_network text, p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_line saas_ugc.vyora_fee_schedule%rowtype;
  v_fee bigint;
begin
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'pricing_invalid_base'; end if;
  v_line := ugc_private.vyora_fee_line('payout', upper(trim(coalesce(p_country, ''))), upper(trim(coalesce(p_currency, ''))),
                                       nullif(trim(coalesce(p_network, '')), ''), p_amount_cents, p_amount_cents, p_at);
  if v_line.id is not null then
    v_fee := ugc_private.vyora_fee_amount(p_amount_cents, v_line.percent_milli, v_line.fixed_cents,
                                          v_line.floor_fee_cents, v_line.cap_fee_cents);
  end if;
  return jsonb_build_object(
    'transaction_type', 'payout', 'amount_cents', p_amount_cents, 'provision_cents', 0,
    'estimated_fee_cents', v_fee, 'tariff_status', case when v_fee is null then 'missing' else 'confirmed' end,
    'tariff_id', v_line.id, 'account_fee_mode', v_line.account_fee_mode);
end $$;

revoke all on function ugc_private.vyora_pricing_policy() from public, anon, authenticated;
revoke all on function ugc_private.vyora_pricing_policy_check(jsonb) from public, anon, authenticated;
revoke all on function ugc_private.vyora_cents_text(bigint) from public, anon, authenticated;
revoke all on function ugc_private.vyora_fee_amount(bigint, integer, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function ugc_private.vyora_fee_line(text, text, text, text, bigint, bigint, timestamptz) from public, anon, authenticated;
revoke all on function ugc_private.vyora_fee_worst(text, text, text, text[], bigint, bigint, timestamptz) from public, anon, authenticated;
revoke all on function ugc_private.vyora_price_quote(text, bigint, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function ugc_private.vyora_payout_quote(bigint, text, text, text, timestamptz) from public, anon, authenticated;

-- =============================================================================
-- 3. COMMANDES — devis figé
-- =============================================================================
alter table saas_ugc.ugc_recharge_orders add column if not exists pricing_quote jsonb;
alter table saas_business.payment_orders add column if not exists pricing_quote jsonb;

-- Le devis ne change plus après la création, et il doit correspondre au montant
-- de la commande. TG_ARGV[0] : facteur ramenant `amount_minor` en centièmes
-- (Studio : 1 ; Business Grow, dont `amount_minor` est en unités : 100).
create or replace function saas_ugc.vyora_pricing_quote_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.pricing_quote is distinct from old.pricing_quote then
      raise exception 'pricing_quote_is_immutable';
    end if;
    return new;
  end if;
  if new.pricing_quote is not null
     and (new.pricing_quote->>'final_cents')::bigint is distinct from new.amount_minor * tg_argv[0]::bigint then
    raise exception 'pricing_quote_mismatch';
  end if;
  return new;
end $$;

drop trigger if exists vyora_recharge_pricing_quote_guard on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_pricing_quote_guard
  before insert or update on saas_ugc.ugc_recharge_orders
  for each row execute function saas_ugc.vyora_pricing_quote_guard('1');

drop trigger if exists vyora_payment_pricing_quote_guard on saas_business.payment_orders;
create trigger vyora_payment_pricing_quote_guard
  before insert or update on saas_business.payment_orders
  for each row execute function saas_ugc.vyora_pricing_quote_guard('100');

-- 3.1 Création d'une commande Studio --------------------------------------------------
-- Reprise à l'identique de la version d'origine (`…100000`), avec en plus : le
-- montant de la commande est le PRIX FINAL du devis, et le devis est figé.
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
  v_quote jsonb;
  v_policy boolean;
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
  -- Prix final (provision, frais estimés) : calculé ici, côté serveur, et figé.
  v_quote := ugc_private.vyora_price_quote(
    'studio', (v_price->>'price_xof')::bigint * 100, 'XOF', upper(trim(p_country)), v_network);
  v_policy := coalesce((v_quote->>'policy_enabled')::boolean, false);

  -- Une seule création à la fois par utilisateur : pas de course au double clic.
  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-studio:' || p_user_id::text, 0));

  select * into v_order from saas_ugc.ugc_recharge_orders o
   where o.user_id = p_user_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.provider <> 'saspay'
       or v_order.order_kind is distinct from p_kind
       or v_order.pack_key is distinct from (v_price->>'pack_key')
       -- Même article = même prix de BASE : le prix final reste celui figé à la
       -- première demande, même si la politique ou le barème a changé depuis.
       or coalesce((v_order.pricing_quote->>'base_cents')::bigint, v_order.amount_minor)
          <> (v_price->>'price_xof')::bigint * 100
       or v_order.payment_flow is distinct from p_flow
       or v_order.network_code is distinct from v_network then
      raise exception 'idempotency_key_reused';
    end if;
    return ugc_private.vyora_studio_order_json(v_order) || jsonb_build_object(
      'reused', true, 'requested_fee_mode', v_order.pricing_quote->>'fee_charge_mode');
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
    payer_msisdn_masked, quoted_fee_mode, quoted_fee_amount, quoted_total_amount, expires_at, pricing_quote
  ) values (
    p_user_id, (v_quote->>'final_cents')::bigint, 'XOF', upper(trim(p_country)),
    (v_price->>'credits')::bigint, 'saspay', p_idempotency_key,
    'VYS-' || upper(replace(gen_random_uuid()::text, '-', '')),
    p_kind, v_price->>'pack_key', v_price->>'label', v_price, p_flow, v_network,
    nullif(left(coalesce(p_msisdn_masked, ''), 24), ''),
    -- Sous la politique de prix : frais déduits, total débité = prix final.
    case when v_policy then 'DEDUCTED'
         when p_quoted_fee_mode in ('ADD_ON', 'DEDUCTED') then p_quoted_fee_mode end,
    case when v_policy then (v_quote->>'estimated_fee_cents')::numeric / 100 else p_quoted_fee end,
    case when v_policy then (v_quote->>'final_cents')::numeric / 100 else p_quoted_total end,
    now() + make_interval(mins => v_ttl), v_quote
  ) returning * into v_order;

  return ugc_private.vyora_studio_order_json(v_order) || jsonb_build_object(
    'reused', false, 'requested_fee_mode', v_quote->>'fee_charge_mode');
end $$;

-- 3.2 Création d'une commande Business Grow ----------------------------------------------
-- Même principe. `amount_minor` reste en unités de la devise (convention Business Grow).
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
  v_quote jsonb;
  v_policy boolean;
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
  -- Prix final (provision, frais estimés) : calculé ici, côté serveur, et figé.
  v_quote := ugc_private.vyora_price_quote(
    'business', (v_price->>'price')::bigint * 100, v_price->>'currency', upper(trim(p_country)), v_network);
  v_policy := coalesce((v_quote->>'policy_enabled')::boolean, false);

  -- Verrou par utilisateur, partagé avec le règlement (`vyora_payment_bg_settle`) :
  -- tout ce qui suit voit un état que ni une autre création ni un règlement du
  -- même utilisateur ne peut modifier avant la fin de cette transaction.
  perform pg_advisory_xact_lock(hashtextextended('vyora-pay-business:' || p_user_id::text, 0));

  select * into v_order from saas_business.payment_orders o
   where o.user_id = p_user_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.plan_key <> p_plan_key
       -- Même formule = même prix de BASE : le prix final reste celui figé à la
       -- première demande, même si la politique ou le barème a changé depuis.
       or coalesce((v_order.pricing_quote->>'base_cents')::bigint, v_order.amount_minor * 100)
          <> (v_price->>'price')::bigint * 100
       or v_order.payment_flow <> p_flow
       or v_order.network_code is distinct from v_network then
      raise exception 'idempotency_key_reused';
    end if;
    return saas_business.vyora_payment_order_json(v_order) || jsonb_build_object(
      'reused', true, 'requested_fee_mode', v_order.pricing_quote->>'fee_charge_mode');
  end if;

  -- Contrôle d'abonnement SOUS le verrou (il était fait avant : deux créations
  -- simultanées pouvaient toutes deux le franchir).
  v_block := saas_business.vyora_subscription_block(p_user_id, p_plan_key);
  if v_block is not null then raise exception '%', v_block; end if;

  v_ttl := greatest(coalesce((v_cfg->>'order_ttl_minutes')::integer, 30), 5);
  -- Un paiement encore ouvert pour une AUTRE formule : on n'en ouvre pas un
  -- second, sinon le client pourrait régler deux formules dont une seule est
  -- activable. Il termine le premier, ou attend son expiration.
  if exists (
    select 1 from saas_business.payment_orders o
     where o.user_id = p_user_id and o.status in ('pending', 'processing')
       and o.plan_key <> p_plan_key
       and o.failure_code is null
       and o.created_at > now() - make_interval(mins => v_ttl)
  ) then
    raise exception 'business_other_plan_payment_in_progress';
  end if;
  select count(*) into v_open from saas_business.payment_orders o
   where o.user_id = p_user_id and o.status in ('pending', 'processing')
     and o.created_at > now() - make_interval(mins => v_ttl);
  if v_open >= greatest(coalesce((v_cfg->>'max_open_orders')::integer, 3), 1) then
    raise exception 'too_many_open_payments';
  end if;

  insert into saas_business.payment_orders(
    user_id, plan_key, plan_label, amount_minor, currency, country_code, period_days,
    monthly_credit_units, provider, internal_reference, idempotency_key, payment_flow, network_code,
    payer_msisdn_masked, quoted_fee_mode, quoted_fee_amount, quoted_total_amount, expires_at, pricing_quote
  ) values (
    p_user_id, p_plan_key, v_price->>'label', (v_quote->>'final_cents')::bigint / 100, v_price->>'currency',
    upper(trim(p_country)), (v_price->>'period_days')::integer,
    (v_price->>'monthly_credit_units')::integer, 'saspay',
    'VYB-' || upper(replace(gen_random_uuid()::text, '-', '')), p_idempotency_key, p_flow, v_network,
    nullif(left(coalesce(p_msisdn_masked, ''), 24), ''),
    -- Sous la politique de prix : frais déduits, total débité = prix final.
    case when v_policy then 'DEDUCTED'
         when p_quoted_fee_mode in ('ADD_ON', 'DEDUCTED') then p_quoted_fee_mode end,
    case when v_policy then (v_quote->>'estimated_fee_cents')::numeric / 100 else p_quoted_fee end,
    case when v_policy then (v_quote->>'final_cents')::numeric / 100 else p_quoted_total end,
    now() + make_interval(mins => v_ttl), v_quote
  ) returning * into v_order;

  return saas_business.vyora_payment_order_json(v_order) || jsonb_build_object(
    'reused', false, 'requested_fee_mode', v_quote->>'fee_charge_mode');
end $$;

-- 3.3 Devis client : prix FINAL par pays, sans détail interne -----------------------------
-- Même signature qu'à l'origine. `price.amount` et `countries.<code>.price.amount`
-- sont désormais les prix tout compris ; ni le prix de base, ni la provision, ni
-- les frais estimés ne sont transmis au navigateur.
create or replace function public.vyora_payment_quote(p_user_id uuid, p_product text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb := ugc_private.vyora_payment_config();
  v_policy_on boolean := coalesce((ugc_private.vyora_pricing_policy()->>'enabled')::boolean, false);
  v_countries jsonb := case when jsonb_typeof(v_cfg->'countries') = 'object' then v_cfg->'countries' else '{}'::jsonb end;
  v_price jsonb;
  v_base bigint;
  v_currency text;
  v_eligible boolean := true;
  v_reason text;
  v_business jsonb;
  v_code text;
  v_final bigint;
  v_first boolean := true;
  v_items jsonb := '{}'::jsonb;
  v_item record;
  v_min bigint;
  v_max bigint;
  v_has_item boolean := false;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_product = 'studio' then
    if not exists (select 1 from saas_ugc.ugc_customer_accounts a where a.user_id = p_user_id)
       or exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_user_id and r.role = 'admin') then
      v_eligible := false; v_reason := 'not_vyora_customer';
    elsif p_item ? 'kind' then
      v_has_item := true;
      v_price := ugc_private.vyora_studio_price(
        p_item->>'kind', p_item->>'pack_key', nullif(p_item->>'amount_xof', '')::bigint);
      v_base := (v_price->>'price_xof')::bigint * 100;
      v_currency := 'XOF';
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
      v_has_item := true;
      v_reason := saas_business.vyora_subscription_block(p_user_id, p_item->>'plan_key');
      v_eligible := v_reason is null;
      v_price := saas_business.vyora_plan_price(p_item->>'plan_key');
      v_base := (v_price->>'price')::bigint * 100;
      v_currency := v_price->>'currency';
      v_price := jsonb_build_object(
        'amount', (v_price->>'price') || '.00', 'currency', v_price->>'currency',
        'label', v_price->>'label', 'plan_key', v_price->>'plan_key',
        'period_days', (v_price->>'period_days')::integer,
        'monthly_credit_units', v_price->'monthly_credit_units');
    end if;
  else
    raise exception 'invalid_product';
  end if;

  if v_price is not null then
    -- Prix final de l'article, pays par pays ; le premier pays sert de prix par défaut.
    for v_code in select k from jsonb_object_keys(v_countries) k order by k loop
      if coalesce(v_countries->v_code->>'currency', '') = v_currency then
        v_final := (ugc_private.vyora_price_quote(p_product, v_base, v_currency, v_code, null)->>'final_cents')::bigint;
        v_countries := jsonb_set(v_countries, array[v_code, 'price'],
          jsonb_build_object('amount', ugc_private.vyora_cents_text(v_final), 'currency', v_currency));
        if v_first then
          v_price := v_price || jsonb_build_object('amount', ugc_private.vyora_cents_text(v_final));
          v_first := false;
        end if;
      end if;
    end loop;
  elsif not v_has_item and coalesce((v_cfg->>'enabled')::boolean, false) then
    -- Sans article : catalogue des prix finals (fourchette entre pays), pour
    -- que les pages de tarifs affichent le prix réellement payé.
    for v_item in
      select 'studio'::text as product, p.value->>'pack_key' as item_key,
             (p.value->>'price_xof')::bigint * 100 as base_cents, 'XOF'::text as currency
        from saas_ugc.ugc_app_settings s,
             jsonb_array_elements(case when jsonb_typeof(s.setting_value->'packs') = 'array'
                                       then s.setting_value->'packs' else '[]'::jsonb end) p
       where p_product = 'studio' and s.setting_key = 'studio_pricing_config'
         and coalesce(p.value->>'pack_key', '') <> ''
         and coalesce(p.value->>'price_xof', '') ~ '^[0-9]{1,12}$' and (p.value->>'price_xof')::bigint > 0
      union all
      select 'business', pl.plan_key, pl.monthly_price_minor * 100, upper(pl.currency)
        from saas_business.plans pl
       where p_product = 'business' and pl.active and pl.billing_enabled
         and pl.monthly_price_minor is not null and pl.monthly_price_minor > 0
    loop
      v_min := null; v_max := null;
      for v_code in select k from jsonb_object_keys(v_countries) k order by k loop
        if coalesce(v_countries->v_code->>'currency', '') = v_item.currency then
          v_final := (ugc_private.vyora_price_quote(p_product, v_item.base_cents, v_item.currency, v_code, null)->>'final_cents')::bigint;
          v_min := least(coalesce(v_min, v_final), v_final);
          v_max := greatest(coalesce(v_max, v_final), v_final);
        end if;
      end loop;
      if v_min is not null then
        v_items := v_items || jsonb_build_object(v_item.item_key, jsonb_build_object(
          'amount', ugc_private.vyora_cents_text(v_min), 'max_amount', ugc_private.vyora_cents_text(v_max),
          'currency', v_item.currency));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'product', p_product,
    'enabled', coalesce((v_cfg->>'enabled')::boolean, false),
    'mode', coalesce(v_cfg->>'mode', 'test'),
    'flows', coalesce(v_cfg->'flows', '[]'::jsonb),
    'countries', v_countries,
    'eligible', v_eligible,
    'reason', v_reason,
    'price', v_price,
    -- Prix tout compris : aucun frais ne s'ajoute au moment de payer.
    'all_inclusive', v_policy_on,
    'catalog', case when v_has_item then null else v_items end
  );
end $$;

-- 3.4 Vue client des commandes ----------------------------------------------------------
-- Identique à l'origine, à ceci près qu'en frais déduits le montant des frais
-- (estimé ou réel) et le net reçu par VYORA ne sont plus transmis au client :
-- il paie le prix affiché, le partage est une donnée interne.
create or replace function ugc_private.vyora_client_order_view(p_order jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select (p_order - array['user_id', 'provider_payment_id', 'provider_session_id', 'pricing_snapshot',
                          'refund_reason', 'refund_external_reference', 'refund_subscription_status']
                  - case when p_order->>'quoted_fee_mode' = 'DEDUCTED' or p_order->>'fee_charge_mode' = 'DEDUCTED'
                         then array['quoted_fee_amount', 'fee_amount', 'net_amount'] else '{}'::text[] end)
         || jsonb_build_object('has_payment',
              (p_order->>'provider_payment_id') is not null or (p_order->>'provider_session_id') is not null)
$$;
revoke all on function ugc_private.vyora_client_order_view(jsonb) from public, anon, authenticated;

-- =============================================================================
-- 4. RAPPROCHEMENT — registre immuable
-- =============================================================================
-- Une ligne par commande réglée, écrite après la confirmation serveur. Les
-- chiffres ne sont jamais modifiés : si SasPay précise plus tard des montants
-- différents, une RÉVISION est ajoutée ; la dernière révision fait foi.
create table if not exists saas_ugc.vyora_payment_reconciliations (
  id uuid primary key default gen_random_uuid(),
  product text not null check (product in ('studio', 'business')),
  order_id uuid not null,
  revision integer not null default 1 check (revision >= 1),
  user_id uuid,
  internal_reference text,
  provider_payment_id text,
  item_key text,
  item_label text,
  country_code text,
  network_code text,
  payment_flow text,
  currency text not null,
  -- Devis (figé à la commande), en centièmes.
  base_cents bigint not null,
  provision_cents bigint not null,
  final_cents bigint not null,
  estimated_fee_cents bigint,
  expected_net_cents bigint,
  -- Réel, d'après la transaction vérifiée chez SasPay.
  charged_cents bigint not null,
  actual_fee_cents bigint,
  actual_net_cents bigint,
  fee_charge_mode text,
  -- Écarts : frais réels − estimés ; marge = net réel − prix de base.
  fee_variance_cents bigint,
  margin_cents bigint,
  provision_covers_fee boolean,
  flags text[] not null default '{}'::text[],
  tariff_id uuid,
  pricing_quote jsonb,
  paid_at timestamptz,
  recorded_at timestamptz not null default now(),
  unique (product, order_id, revision)
);
create index if not exists vyora_payment_reconciliations_paid_idx
  on saas_ugc.vyora_payment_reconciliations(paid_at desc);

alter table saas_ugc.vyora_payment_reconciliations enable row level security;
alter table saas_ugc.vyora_payment_reconciliations force row level security;
revoke all on saas_ugc.vyora_payment_reconciliations from public, anon, authenticated, service_role;

create or replace function saas_ugc.vyora_payment_reconciliation_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'payment_reconciliation_is_immutable';
end $$;

drop trigger if exists vyora_payment_reconciliation_immutable on saas_ugc.vyora_payment_reconciliations;
create trigger vyora_payment_reconciliation_immutable
  before update or delete on saas_ugc.vyora_payment_reconciliations
  for each row execute function saas_ugc.vyora_payment_reconciliation_immutable();
drop trigger if exists vyora_payment_reconciliation_no_truncate on saas_ugc.vyora_payment_reconciliations;
create trigger vyora_payment_reconciliation_no_truncate
  before truncate on saas_ugc.vyora_payment_reconciliations
  for each statement execute function saas_ugc.vyora_payment_reconciliation_immutable();

-- Nouveaux genres d'anomalie :
--   fee_exceeds_provision  frais réels supérieurs à la provision incluse dans le prix de la transaction
--                          (prix final − prix de base : la provision configurée, plus le relèvement
--                          éventuel décidé au devis pour couvrir un tarif connu)
--   net_below_base         net reçu inférieur au prix commercial de base
--   fee_mode_unexpected    frais ajoutés au client alors que le prix était annoncé tout compris
--   reconciliation_failed  la ligne de rapprochement n'a pas pu être écrite
alter table saas_ugc.vyora_payment_anomalies drop constraint if exists vyora_payment_anomalies_kind_check;
alter table saas_ugc.vyora_payment_anomalies add constraint vyora_payment_anomalies_kind_check
  check (kind in ('order_stuck', 'duplicate_payment', 'payment_conflict', 'amount_mismatch', 'payment_not_found',
                  'subscription_conflict', 'sweep_unreliable', 'initiation_unconfirmed',
                  'fee_exceeds_provision', 'net_below_base', 'fee_mode_unexpected', 'reconciliation_failed'));

-- Identique à la version d'origine, avec les titres des nouveaux genres.
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
    when 'fee_exceeds_provision' then 'Frais SasPay supérieurs à la provision'
    when 'net_below_base' then 'Net encaissé inférieur au prix de base'
    when 'fee_mode_unexpected' then 'Frais SasPay ajoutés au client malgré le prix tout compris'
    when 'reconciliation_failed' then 'Rapprochement financier non enregistré'
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

-- Écrit (ou révise) la ligne de rapprochement d'une commande RÉGLÉE.
-- `o` : la ligne de commande en JSON. Sans effet si les chiffres sont inchangés :
-- un événement rejoué n'ajoute donc rien.
create or replace function ugc_private.vyora_payment_ledger_record(p_product text, o jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scale bigint := case when p_product = 'studio' then 1 else 100 end;
  v_order uuid := (o->>'id')::uuid;
  v_final bigint := (o->>'amount_minor')::bigint * v_scale;
  v_quote jsonb := case when jsonb_typeof(o->'pricing_quote') = 'object' then o->'pricing_quote' end;
  v_policy boolean;
  v_base bigint;
  v_provision bigint;
  v_est bigint;
  v_charged bigint := round((o->>'charged_amount')::numeric * 100)::bigint;
  v_net bigint := round((o->>'net_amount')::numeric * 100)::bigint;
  v_mode text := nullif(o->>'fee_charge_mode', '');
  v_fee bigint;
  v_flags text[] := '{}'::text[];
  v_last saas_ugc.vyora_payment_reconciliations%rowtype;
  v_id uuid;
  v_flag text;
begin
  if p_product not in ('studio', 'business') then raise exception 'invalid_product'; end if;
  if o->>'status' is distinct from 'paid' then return null; end if;

  v_policy := coalesce((v_quote->>'policy_enabled')::boolean, false);
  v_base := coalesce((v_quote->>'base_cents')::bigint, v_final);
  v_provision := coalesce((v_quote->>'provision_cents')::bigint, 0);
  v_est := (v_quote->>'estimated_fee_cents')::bigint;

  if v_quote is null then v_flags := v_flags || 'legacy_pricing'::text;
  elsif v_est is null then v_flags := v_flags || 'tariff_missing'::text; end if;
  -- Montant débité non restitué : le montant demandé (vérifié égal à la commande) fait foi.
  if v_charged is null then v_charged := v_final; v_flags := v_flags || 'charged_assumed'::text; end if;
  if v_net is null then
    v_flags := v_flags || 'fee_unknown'::text;
  else
    -- Frais SasPay réels : ce qui a quitté le compte du client moins ce qui nous revient.
    v_fee := v_charged - v_net;
    -- Provision réellement incluse dans le prix : prix final − prix de base. Un prix relevé au devis
    -- pour couvrir un tarif connu n'est pas une anomalie : seuls des frais NON couverts par le prix alertent.
    if v_policy and v_fee > v_final - v_base then v_flags := v_flags || 'fee_exceeds_provision'::text; end if;
    if v_net < v_base then v_flags := v_flags || 'net_below_base'::text; end if;
  end if;
  if v_policy and (v_charged > v_final or (v_mode is not null and v_mode <> 'DEDUCTED')) then
    v_flags := v_flags || 'fee_mode_unexpected'::text;
  end if;

  select * into v_last from saas_ugc.vyora_payment_reconciliations r
   where r.product = p_product and r.order_id = v_order
   order by r.revision desc limit 1;
  if found
     and v_last.charged_cents = v_charged
     and v_last.actual_net_cents is not distinct from v_net
     and v_last.fee_charge_mode is not distinct from v_mode then
    return v_last.id;
  end if;

  insert into saas_ugc.vyora_payment_reconciliations(
    product, order_id, revision, user_id, internal_reference, provider_payment_id,
    item_key, item_label, country_code, network_code, payment_flow, currency,
    base_cents, provision_cents, final_cents, estimated_fee_cents, expected_net_cents,
    charged_cents, actual_fee_cents, actual_net_cents, fee_charge_mode,
    fee_variance_cents, margin_cents, provision_covers_fee, flags, tariff_id, pricing_quote, paid_at
  ) values (
    p_product, v_order, coalesce(v_last.revision, 0) + 1, (o->>'user_id')::uuid,
    o->>'internal_reference', o->>'provider_payment_id',
    case when p_product = 'studio' then coalesce(o->>'pack_key', o->>'order_kind') else o->>'plan_key' end,
    case when p_product = 'studio' then o->>'order_label' else o->>'plan_label' end,
    trim(o->>'country_code'), o->>'network_code', o->>'payment_flow', trim(o->>'currency'),
    v_base, v_provision, v_final, v_est, (v_quote->>'expected_net_cents')::bigint,
    v_charged, v_fee, v_net, v_mode,
    v_fee - v_est, v_net - v_base,
    case when v_fee is null or not v_policy then null else v_fee <= v_final - v_base end,
    v_flags, (v_quote->>'tariff_id')::uuid, v_quote, coalesce((o->>'paid_at')::timestamptz, now())
  ) returning id into v_id;

  -- Alertes (une seule par commande et par genre), seulement sous la politique de prix.
  if v_policy then
    foreach v_flag in array v_flags loop
      if v_flag in ('fee_exceeds_provision', 'net_below_base', 'fee_mode_unexpected') then
        perform ugc_private.vyora_payment_flag_anomaly(
          v_flag, p_product, v_order, o->>'provider_payment_id', o->>'internal_reference',
          jsonb_build_object(
            'currency', trim(o->>'currency'), 'base_cents', v_base, 'provision_cents', v_provision,
            'final_cents', v_final, 'estimated_fee_cents', v_est, 'charged_cents', v_charged,
            'actual_fee_cents', v_fee, 'actual_net_cents', v_net, 'fee_charge_mode', v_mode));
      end if;
    end loop;
  end if;
  return v_id;
end $$;
revoke all on function ugc_private.vyora_payment_ledger_record(text, jsonb) from public, anon, authenticated;

-- Déclenché quand une commande SasPay est (ou reste) réglée. Une erreur ici ne
-- doit jamais empêcher de livrer un client qui a payé : elle est signalée, et
-- la ligne manquante est rattrapable (`vyora_admin_finance_backfill`).
create or replace function saas_ugc.vyora_payment_ledger_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
begin
  if v_row->>'status' = 'paid' and v_row->>'provider' = 'saspay' then
    begin
      perform ugc_private.vyora_payment_ledger_record(tg_argv[0], v_row);
    exception when others then
      begin
        perform ugc_private.vyora_payment_flag_anomaly(
          'reconciliation_failed', tg_argv[0], (v_row->>'id')::uuid, v_row->>'provider_payment_id',
          v_row->>'internal_reference', jsonb_build_object('error', left(sqlerrm, 200)));
      exception when others then
        raise warning 'vyora_payment_ledger_trigger: %', sqlerrm;
      end;
    end;
  end if;
  return null;
end $$;
revoke all on function saas_ugc.vyora_payment_ledger_trigger() from public, anon, authenticated, service_role;

drop trigger if exists vyora_recharge_ledger on saas_ugc.ugc_recharge_orders;
create trigger vyora_recharge_ledger
  after insert or update on saas_ugc.ugc_recharge_orders
  for each row when (new.status = 'paid') execute function saas_ugc.vyora_payment_ledger_trigger('studio');

drop trigger if exists vyora_payment_ledger on saas_business.payment_orders;
create trigger vyora_payment_ledger
  after insert or update on saas_business.payment_orders
  for each row when (new.status = 'paid') execute function saas_ugc.vyora_payment_ledger_trigger('business');

-- Commandes réglées sans ligne de rapprochement (antérieures à cette migration, ou
-- dont l'écriture a échoué).
create or replace function ugc_private.vyora_payment_ledger_missing()
returns table(product text, row_json jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select 'studio'::text, to_jsonb(o)
    from saas_ugc.ugc_recharge_orders o
   where o.provider = 'saspay' and o.status = 'paid'
     and not exists (select 1 from saas_ugc.vyora_payment_reconciliations r
                      where r.product = 'studio' and r.order_id = o.id)
  union all
  select 'business'::text, to_jsonb(o)
    from saas_business.payment_orders o
   where o.provider = 'saspay' and o.status = 'paid'
     and not exists (select 1 from saas_ugc.vyora_payment_reconciliations r
                      where r.product = 'business' and r.order_id = o.id);
$$;
revoke all on function ugc_private.vyora_payment_ledger_missing() from public, anon, authenticated;

-- =============================================================================
-- 5. ADMINISTRATION — politique, barème, simulation, tableau de bord
-- =============================================================================
create or replace function ugc_private.vyora_fee_schedule_json(s saas_ugc.vyora_fee_schedule)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'transaction_type', s.transaction_type, 'country_code', s.country_code,
    'currency', s.currency, 'network_code', s.network_code,
    'min_amount_cents', s.min_amount_cents, 'max_amount_cents', s.max_amount_cents,
    'percent_milli', s.percent_milli, 'fixed_cents', s.fixed_cents,
    'floor_fee_cents', s.floor_fee_cents, 'cap_fee_cents', s.cap_fee_cents,
    'fee_base', s.fee_base, 'account_fee_mode', s.account_fee_mode,
    'valid_from', s.valid_from, 'valid_until', s.valid_until,
    'source', s.source, 'source_note', s.source_note,
    'created_at', s.created_at, 'closed_at', s.closed_at,
    'active', s.valid_from <= now() and (s.valid_until is null or s.valid_until > now()));
$$;
revoke all on function ugc_private.vyora_fee_schedule_json(saas_ugc.vyora_fee_schedule) from public, anon, authenticated;

-- Couples (pays, opérateur) proposés au paiement SANS tarif d'encaissement confirmé.
create or replace function ugc_private.vyora_pricing_missing_tariffs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cfg as (select ugc_private.vyora_payment_config() as c),
  pairs as (
    select co.key as country_code, co.value->>'currency' as currency, n.value->>'code' as network_code,
           coalesce(n.value->>'label', n.value->>'code') as network_label, 'softpay'::text as flow
      from cfg, jsonb_each(case when jsonb_typeof(cfg.c->'countries') = 'object' then cfg.c->'countries' else '{}'::jsonb end) co,
           jsonb_array_elements(case when jsonb_typeof(co.value->'networks') = 'array' then co.value->'networks' else '[]'::jsonb end) n
    union all
    -- Page hébergée : l'opérateur n'est pas connu d'avance, seule une ligne générique couvre ce cas.
    select co.key, co.value->>'currency', null, 'Page de paiement hébergée (opérateur choisi chez SasPay)', 'checkout'
      from cfg, jsonb_each(case when jsonb_typeof(cfg.c->'countries') = 'object' then cfg.c->'countries' else '{}'::jsonb end) co
     where coalesce(cfg.c->'flows', '[]'::jsonb) ? 'checkout'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'country_code', p.country_code, 'currency', p.currency, 'network_code', p.network_code,
           'network_label', p.network_label, 'flow', p.flow) order by p.country_code, p.network_code nulls last), '[]'::jsonb)
    from pairs p
   where not exists (
     select 1 from saas_ugc.vyora_fee_schedule s
      where s.transaction_type = 'payin' and s.currency = p.currency
        and s.valid_from <= now() and (s.valid_until is null or s.valid_until > now())
        and (s.country_code is null or s.country_code = p.country_code)
        and (s.network_code is null or s.network_code = p.network_code));
$$;
revoke all on function ugc_private.vyora_pricing_missing_tariffs() from public, anon, authenticated;

create or replace function public.vyora_admin_pricing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  return jsonb_build_object(
    'policy', ugc_private.vyora_pricing_policy(),
    'tariffs', (select coalesce(jsonb_agg(ugc_private.vyora_fee_schedule_json(s)
                         order by (s.valid_until is null or s.valid_until > now()) desc, s.transaction_type,
                                  s.country_code nulls first, s.network_code nulls first, s.min_amount_cents, s.valid_from desc), '[]'::jsonb)
                  from (select * from saas_ugc.vyora_fee_schedule order by created_at desc limit 500) s),
    'missing_tariffs', ugc_private.vyora_pricing_missing_tariffs(),
    -- Le compte annonce-t-il des frais ajoutés au client pour l'encaissement ?
    'account_add_on_lines', (select count(*) from saas_ugc.vyora_fee_schedule s
                              where s.transaction_type = 'payin' and s.account_fee_mode = 'ADD_ON'
                                and s.valid_from <= now() and (s.valid_until is null or s.valid_until > now())),
    'missing_reconciliations', (select count(*) from ugc_private.vyora_payment_ledger_missing())
  );
end $$;

create or replace function public.vyora_admin_set_pricing_policy(p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb;
  v_old jsonb := ugc_private.vyora_pricing_policy();
begin
  perform ugc_private.reelora_assert_admin();
  v_new := ugc_private.vyora_pricing_policy_check(p_policy);
  insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
  values ('vyora_pricing_policy', v_new,
          'Tarification VYORA : provision par transaction, stratégie de couverture des frais SasPay, arrondi')
  on conflict (setting_key) do update set setting_value = excluded.setting_value, updated_at = now();
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'vyora_pricing_policy_updated', 'app_setting', 'vyora_pricing_policy',
          jsonb_build_object('before', v_old, 'after', v_new));
  return v_new;
end $$;

-- Ajoute une ligne de barème. Montants en centièmes, pourcentage en millièmes de pour cent.
create or replace function public.vyora_admin_add_tariff(p_tariff jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row saas_ugc.vyora_fee_schedule%rowtype;
  v_int text := '^[0-9]{1,15}$';
  v_key text;
begin
  perform ugc_private.reelora_assert_admin();
  if p_tariff is null or jsonb_typeof(p_tariff) <> 'object' then raise exception 'tariff_invalid'; end if;
  -- Entiers stricts : aucun nombre décimal n'entre dans le barème.
  foreach v_key in array array['min_amount_cents', 'max_amount_cents', 'percent_milli', 'fixed_cents', 'floor_fee_cents', 'cap_fee_cents'] loop
    if p_tariff ? v_key and jsonb_typeof(p_tariff->v_key) <> 'null' and (p_tariff->>v_key) !~ v_int then
      raise exception 'tariff_invalid';
    end if;
  end loop;
  if coalesce(p_tariff->>'source', '') not in ('saspay_documentation', 'owner_provided') then
    -- `saspay_account_rates` est réservé à l'import des tarifs du compte.
    raise exception 'tariff_source_required';
  end if;
  if char_length(trim(coalesce(p_tariff->>'source_note', ''))) < 5 then raise exception 'tariff_source_required'; end if;
  if coalesce((p_tariff->>'percent_milli')::bigint, 0) = 0 and coalesce((p_tariff->>'fixed_cents')::bigint, 0) = 0
     and (p_tariff->>'floor_fee_cents') is null
     and coalesce((p_tariff->>'confirmed_free')::boolean, false) is not true then
    -- Un tarif nul doit être affirmé explicitement, pas obtenu par oubli.
    raise exception 'tariff_invalid';
  end if;
  begin
    insert into saas_ugc.vyora_fee_schedule(
      transaction_type, country_code, currency, network_code, min_amount_cents, max_amount_cents,
      percent_milli, fixed_cents, floor_fee_cents, cap_fee_cents, fee_base, valid_from, valid_until,
      source, source_note, created_by
    ) values (
      coalesce(p_tariff->>'transaction_type', 'payin'),
      nullif(upper(trim(coalesce(p_tariff->>'country_code', ''))), ''),
      upper(trim(coalesce(p_tariff->>'currency', ''))),
      nullif(trim(coalesce(p_tariff->>'network_code', '')), ''),
      coalesce((p_tariff->>'min_amount_cents')::bigint, 0), (p_tariff->>'max_amount_cents')::bigint,
      coalesce((p_tariff->>'percent_milli')::integer, 0), coalesce((p_tariff->>'fixed_cents')::bigint, 0),
      (p_tariff->>'floor_fee_cents')::bigint, (p_tariff->>'cap_fee_cents')::bigint,
      coalesce(p_tariff->>'fee_base', 'total'),
      coalesce((p_tariff->>'valid_from')::timestamptz, now()), (p_tariff->>'valid_until')::timestamptz,
      p_tariff->>'source', trim(p_tariff->>'source_note'), (select auth.uid())
    ) returning * into v_row;
  exception
    when check_violation or not_null_violation or numeric_value_out_of_range
      or invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'tariff_invalid';
  end;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'vyora_tariff_added', 'fee_schedule', v_row.id::text, ugc_private.vyora_fee_schedule_json(v_row));
  return ugc_private.vyora_fee_schedule_json(v_row);
end $$;

-- Clôt une ligne (elle reste consultable ; les devis passés y font référence).
create or replace function public.vyora_admin_close_tariff(p_tariff_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row saas_ugc.vyora_fee_schedule%rowtype;
begin
  perform ugc_private.reelora_assert_admin();
  if char_length(trim(coalesce(p_note, ''))) < 5 then raise exception 'tariff_note_required'; end if;
  select * into v_row from saas_ugc.vyora_fee_schedule s where s.id = p_tariff_id for update;
  if not found then raise exception 'tariff_not_found'; end if;
  if v_row.closed_at is not null then raise exception 'tariff_already_closed'; end if;
  update saas_ugc.vyora_fee_schedule
     set valid_until = least(coalesce(valid_until, 'infinity'::timestamptz),
                             greatest(now(), valid_from + interval '1 microsecond')),
         closed_by = (select auth.uid()), closed_at = now()
   where id = p_tariff_id returning * into v_row;
  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'vyora_tariff_closed', 'fee_schedule', v_row.id::text,
          jsonb_build_object('note', left(trim(p_note), 300)));
  return ugc_private.vyora_fee_schedule_json(v_row);
end $$;

-- Simulation (aucune écriture) : détail complet d'un devis, pour contrôle.
create or replace function public.vyora_admin_price_simulation(
  p_base_cents bigint, p_currency text, p_country text, p_network text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  return ugc_private.vyora_price_quote('simulation', p_base_cents, p_currency, p_country, p_network);
end $$;

-- Estimation des frais d'un décaissement : jamais de provision.
create or replace function public.vyora_admin_payout_simulation(
  p_amount_cents bigint, p_currency text, p_country text, p_network text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform ugc_private.reelora_assert_admin();
  return ugc_private.vyora_payout_quote(p_amount_cents, p_currency, p_country, p_network);
end $$;

-- Rattrape les lignes de rapprochement manquantes.
create or replace function public.vyora_admin_finance_backfill()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_done integer := 0;
begin
  perform ugc_private.reelora_assert_admin();
  for v_item in select m.product, m.row_json from ugc_private.vyora_payment_ledger_missing() m loop
    if ugc_private.vyora_payment_ledger_record(v_item.product, v_item.row_json) is not null then
      v_done := v_done + 1;
    end if;
  end loop;
  return jsonb_build_object('recorded', v_done);
end $$;

-- Import des tarifs du compte SasPay (`GET /pricing/my-rates/`, lecture seule
-- chez SasPay), appelé par l'Edge Function à la demande d'un administrateur.
-- Les lignes absentes de la réponse sont closes ; les lignes identiques sont
-- conservées ; les autres sont ajoutées. Les lignes saisies à la main ne sont
-- pas touchées.
create or replace function public.vyora_payment_import_rates(p_actor uuid, p_rates jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rate jsonb;
  v_dir text;
  v_tier jsonb;
  v_keep uuid[] := '{}'::uuid[];
  v_id uuid;
  v_inserted integer := 0;
  v_unchanged integer := 0;
  v_skipped integer := 0;
  v_closed integer := 0;
  v_country text;
  v_network text;
  v_currency text;
  v_dec text := '^[0-9]{1,13}(\.[0-9]{1,2})?$';
  v_pct text := '^[0-9]{1,2}(\.[0-9]{1,3})?$';
  v_min bigint; v_max bigint; v_percent integer; v_fixed bigint; v_floor bigint; v_cap bigint; v_mode text;
begin
  perform ugc_private.vyora_assert_service_role();
  if p_actor is null or not exists (select 1 from saas_ugc.ugc_user_roles r where r.user_id = p_actor and r.role = 'admin') then
    raise exception 'forbidden';
  end if;
  if p_rates is null or jsonb_typeof(p_rates) <> 'array' or jsonb_array_length(p_rates) = 0 then
    -- Une réponse vide ne doit pas clore tout le barème.
    raise exception 'rates_empty';
  end if;

  for v_rate in select e.value from jsonb_array_elements(p_rates) e loop
    v_country := upper(trim(coalesce(v_rate->>'country_code', '')));
    v_network := trim(coalesce(v_rate->>'network_code', ''));
    if v_country !~ '^[A-Z]{2}$' or v_network !~ '^[a-z0-9_]{2,40}$' then
      v_skipped := v_skipped + 1; continue;
    end if;
    foreach v_dir in array array['payin', 'payout'] loop
      if jsonb_typeof(v_rate->v_dir->'tiers') is distinct from 'array' then continue; end if;
      for v_tier in select e.value from jsonb_array_elements(v_rate->v_dir->'tiers') e loop
        v_currency := upper(trim(coalesce(v_tier->>'currency', v_rate->>'currency', '')));
        -- Toute valeur illisible écarte le palier : rien n'est deviné.
        if v_currency !~ '^[A-Z]{3}$'
           or coalesce(v_tier->>'percent', '0') !~ v_pct
           or coalesce(v_tier->>'fixed', '0') !~ v_dec
           or coalesce(v_tier->>'min_amount', '0') !~ v_dec
           or (v_tier->>'max_amount' is not null and v_tier->>'max_amount' !~ v_dec)
           or (v_tier->>'floor_amount' is not null and v_tier->>'floor_amount' !~ v_dec)
           or (v_tier->>'cap_amount' is not null and v_tier->>'cap_amount' !~ v_dec) then
          v_skipped := v_skipped + 1; continue;
        end if;
        v_percent := (coalesce(v_tier->>'percent', '0')::numeric * 1000)::integer;
        v_fixed := (coalesce(v_tier->>'fixed', '0')::numeric * 100)::bigint;
        v_min := (coalesce(v_tier->>'min_amount', '0')::numeric * 100)::bigint;
        v_max := ((v_tier->>'max_amount')::numeric * 100)::bigint;
        v_floor := ((v_tier->>'floor_amount')::numeric * 100)::bigint;
        v_cap := ((v_tier->>'cap_amount')::numeric * 100)::bigint;
        v_mode := case when v_tier->>'fee_charge_mode' in ('ADD_ON', 'DEDUCTED') then v_tier->>'fee_charge_mode' end;
        if v_percent > 50000 or (v_max is not null and v_max < v_min)
           or (v_cap is not null and v_floor is not null and v_cap < v_floor) then
          v_skipped := v_skipped + 1; continue;
        end if;

        select s.id into v_id from saas_ugc.vyora_fee_schedule s
         where s.source = 'saspay_account_rates' and s.valid_until is null
           and s.transaction_type = v_dir and s.country_code = v_country and s.currency = v_currency
           and s.network_code = v_network and s.min_amount_cents = v_min
           and s.max_amount_cents is not distinct from v_max and s.percent_milli = v_percent
           and s.fixed_cents = v_fixed and s.floor_fee_cents is not distinct from v_floor
           and s.cap_fee_cents is not distinct from v_cap and s.account_fee_mode is not distinct from v_mode
         limit 1;
        if found then
          v_unchanged := v_unchanged + 1;
        else
          insert into saas_ugc.vyora_fee_schedule(
            transaction_type, country_code, currency, network_code, min_amount_cents, max_amount_cents,
            percent_milli, fixed_cents, floor_fee_cents, cap_fee_cents, fee_base, account_fee_mode,
            source, source_note, created_by
          ) values (
            v_dir, v_country, v_currency, v_network, v_min, v_max, v_percent, v_fixed, v_floor, v_cap,
            'total', v_mode, 'saspay_account_rates', 'Tarif du compte lu par GET /pricing/my-rates/', p_actor
          ) returning id into v_id;
          v_inserted := v_inserted + 1;
        end if;
        v_keep := v_keep || v_id;
      end loop;
    end loop;
  end loop;

  if cardinality(v_keep) = 0 then raise exception 'rates_empty'; end if;

  update saas_ugc.vyora_fee_schedule s
     set valid_until = greatest(now(), s.valid_from + interval '1 microsecond'), closed_by = p_actor, closed_at = now()
   where s.source = 'saspay_account_rates' and s.valid_until is null and s.closed_at is null
     and not (s.id = any(v_keep));
  get diagnostics v_closed = row_count;

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (p_actor, 'vyora_tariffs_imported', 'fee_schedule', 'saspay_account_rates',
          jsonb_build_object('inserted', v_inserted, 'unchanged', v_unchanged, 'closed', v_closed, 'skipped', v_skipped));
  return jsonb_build_object('inserted', v_inserted, 'unchanged', v_unchanged, 'closed', v_closed, 'skipped', v_skipped);
end $$;

-- Tableau de bord financier. Filtres : période (sur la date de paiement), pays,
-- opérateur (`checkout` = page hébergée, opérateur non restitué), produit.
create or replace function public.vyora_admin_finance_report(
  p_from timestamptz default null, p_to timestamptz default null,
  p_country text default null, p_network text default null, p_product text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_country text := nullif(upper(trim(coalesce(p_country, ''))), '');
  v_network text := nullif(trim(coalesce(p_network, '')), '');
  v_product text := nullif(trim(coalesce(p_product, '')), '');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_result jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if v_product is not null and v_product not in ('studio', 'business') then raise exception 'invalid_product'; end if;

  with latest as (
    select distinct on (r.product, r.order_id) r.*
      from saas_ugc.vyora_payment_reconciliations r
     order by r.product, r.order_id, r.revision desc
  ),
  lines as (
    select l.*,
           coalesce(l.network_code, case when l.payment_flow = 'checkout' then 'checkout' else 'inconnu' end) as network_key,
           coalesce(
             (select o.refund_amount_minor from saas_ugc.ugc_recharge_orders o
               where l.product = 'studio' and o.id = l.order_id and o.status = 'refunded'),
             (select o.refund_amount_minor * 100 from saas_business.payment_orders o
               where l.product = 'business' and o.id = l.order_id and o.status = 'refunded'),
             0) as refund_cents
      from latest l
     where (p_from is null or l.paid_at >= p_from) and (p_to is null or l.paid_at < p_to)
       and (v_country is null or l.country_code = v_country)
       and (v_product is null or l.product = v_product)
       and (v_network is null
            or coalesce(l.network_code, case when l.payment_flow = 'checkout' then 'checkout' else 'inconnu' end) = v_network)
  ),
  agg as (
    select grouping(country_code, network_key, product, item_key) as g,
           country_code, network_key, product, item_key,
           jsonb_build_object(
             'transactions', count(*),
             'currency', min(currency),
             'currencies', count(distinct currency),
             -- Chiffre d'affaires brut : ce que les clients ont payé.
             'gross_cents', coalesce(sum(charged_cents), 0),
             'base_cents', coalesce(sum(base_cents), 0),
             'provision_cents', coalesce(sum(provision_cents), 0),
             -- Frais et net réels : seulement sur les transactions où SasPay les a restitués.
             'fee_known', count(actual_fee_cents),
             'fee_unknown', count(*) - count(actual_fee_cents),
             'actual_fee_cents', coalesce(sum(actual_fee_cents), 0),
             'actual_net_cents', coalesce(sum(actual_net_cents), 0),
             'margin_cents', coalesce(sum(margin_cents), 0),
             -- Estimé contre réel.
             'estimated', count(estimated_fee_cents),
             'estimated_fee_cents', coalesce(sum(estimated_fee_cents), 0),
             'expected_net_cents', coalesce(sum(expected_net_cents), 0),
             'compared', count(fee_variance_cents),
             'fee_variance_cents', coalesce(sum(fee_variance_cents), 0),
             'refunded_cents', coalesce(sum(refund_cents), 0),
             'refunded', count(*) filter (where refund_cents > 0),
             'unprofitable', count(*) filter (where margin_cents < 0),
             'over_provision', count(*) filter (where provision_covers_fee is false),
             'tariff_missing', count(*) filter (where 'tariff_missing' = any(flags))
           ) as stats
      from lines
     group by grouping sets ((), (country_code), (network_key), (product, item_key))
  )
  select jsonb_build_object(
    'filters', jsonb_build_object('from', p_from, 'to', p_to, 'country', v_country, 'network', v_network, 'product', v_product),
    'totals', (select a.stats from agg a where a.g = 15),
    'by_country', (select coalesce(jsonb_agg(a.stats || jsonb_build_object('country_code', a.country_code)
                           order by (a.stats->>'gross_cents')::bigint desc), '[]'::jsonb) from agg a where a.g = 7),
    'by_network', (select coalesce(jsonb_agg(a.stats || jsonb_build_object('network', a.network_key)
                           order by (a.stats->>'gross_cents')::bigint desc), '[]'::jsonb) from agg a where a.g = 11),
    'by_product', (select coalesce(jsonb_agg(a.stats || jsonb_build_object('product', a.product, 'item_key', a.item_key)
                           order by a.product, (a.stats->>'gross_cents')::bigint desc), '[]'::jsonb) from agg a where a.g = 12),
    -- Transactions insuffisamment rentables : net sous le prix de base, ou frais au-dessus de la provision.
    'unprofitable', (select coalesce(jsonb_agg(x.j order by x.paid_at desc), '[]'::jsonb) from (
        select l.paid_at, jsonb_build_object(
                 'product', l.product, 'order_id', l.order_id, 'internal_reference', l.internal_reference,
                 'item_key', l.item_key, 'country_code', l.country_code, 'network', l.network_key,
                 'currency', l.currency, 'base_cents', l.base_cents, 'provision_cents', l.provision_cents,
                 'final_cents', l.final_cents, 'charged_cents', l.charged_cents,
                 'estimated_fee_cents', l.estimated_fee_cents, 'actual_fee_cents', l.actual_fee_cents,
                 'actual_net_cents', l.actual_net_cents, 'margin_cents', l.margin_cents,
                 'flags', to_jsonb(l.flags), 'paid_at', l.paid_at) as j
          from lines l
         where l.margin_cents < 0 or l.provision_covers_fee is false
         order by l.paid_at desc limit v_limit) x),
    'recent', (select coalesce(jsonb_agg(x.j order by x.paid_at desc), '[]'::jsonb) from (
        select l.paid_at, jsonb_build_object(
                 'product', l.product, 'order_id', l.order_id, 'internal_reference', l.internal_reference,
                 'item_key', l.item_key, 'country_code', l.country_code, 'network', l.network_key,
                 'currency', l.currency, 'base_cents', l.base_cents, 'provision_cents', l.provision_cents,
                 'final_cents', l.final_cents, 'charged_cents', l.charged_cents,
                 'estimated_fee_cents', l.estimated_fee_cents, 'actual_fee_cents', l.actual_fee_cents,
                 'actual_net_cents', l.actual_net_cents, 'margin_cents', l.margin_cents,
                 'fee_variance_cents', l.fee_variance_cents, 'refund_cents', l.refund_cents,
                 'revision', l.revision, 'flags', to_jsonb(l.flags), 'paid_at', l.paid_at) as j
          from lines l order by l.paid_at desc limit v_limit) x)
  ) into v_result;
  return v_result;
end $$;

-- =============================================================================
-- 6. Droits d'exécution
-- =============================================================================
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.vyora_payment_import_rates(uuid, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;

  foreach v_fn in array array[
    'public.vyora_admin_pricing_overview()',
    'public.vyora_admin_set_pricing_policy(jsonb)',
    'public.vyora_admin_add_tariff(jsonb)',
    'public.vyora_admin_close_tariff(uuid, text)',
    'public.vyora_admin_price_simulation(bigint, text, text, text)',
    'public.vyora_admin_payout_simulation(bigint, text, text, text)',
    'public.vyora_admin_finance_backfill()',
    'public.vyora_admin_finance_report(timestamptz, timestamptz, text, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end $$;
