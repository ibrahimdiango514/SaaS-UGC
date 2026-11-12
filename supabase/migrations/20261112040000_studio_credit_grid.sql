-- -----------------------------------------------------------------------------
-- VYORA Studio — grille tarifaire en crédits (portefeuille Studio uniquement)
--
-- Périmètre STRICT : ce fichier ne touche QUE `saas_ugc.*` (le produit Studio).
-- Aucune table, aucun portefeuille, aucune règle de `saas_business.*`
-- (Business Grow) n'est lue ni modifiée. Business Grow conserve ses abonnements
-- mensuels et son objectif de marge propre.
--
-- Principe : le serveur est la seule autorité. Le navigateur reçoit un prix,
-- jamais un droit de le fixer. Tous les paramètres sont administrables en base
-- (`ugc_app_settings.studio_pricing_config`) sans redéploiement.
-- -----------------------------------------------------------------------------

-- 1. Configuration tarifaire Studio -------------------------------------------------
insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
values (
  'studio_pricing_config',
  jsonb_build_object(
    -- Devise de référence et valeur faciale d'un crédit.
    'usd_to_xof', 620,
    'credit_value_xof', 100,
    -- Marge cible Studio (distincte de l'objectif de marge de Business Grow).
    'target_margin_percent', 60,
    -- Coût fixe de traitement par opération (stockage, transcodage, suivi worker).
    'processing_cost_usd', 0.01,
    -- Garde-fou commercial : aucune génération si le coût fournisseur est inconnu.
    'require_known_provider_cost', true,
    -- Paliers de dégressivité du prix du crédit selon le volume acheté.
    -- Le prix par crédit DIMINUE quand le pack grandit.
    'packs', jsonb_build_array(
      jsonb_build_object('pack_key', 'creator', 'label', 'Creator', 'price_xof', 5000, 'credits', 27, 'recommended', false),
      jsonb_build_object('pack_key', 'pro_creator', 'label', 'Pro Creator', 'price_xof', 15000, 'credits', 95, 'recommended', true),
      jsonb_build_object('pack_key', 'studio_business', 'label', 'Studio Business', 'price_xof', 35000, 'credits', 265, 'recommended', false)
    ),
    -- Recharge libre : bornes et pas, exprimés en FCFA.
    'custom_recharge', jsonb_build_object('min_xof', 5000, 'max_xof', 350000, 'step_xof', 1000),
    -- Grille indicative affichée avant achat (coût typique observé, pas un plafond).
    -- Aucun coût n'est inventé : les exemples n'annoncent pas de montant tant
    -- que la grille réelle n'a pas été observée sur des générations terminées.
    -- `approx_credits` reste `null` (affiché « Coût calculé à la demande ») et
    -- peut être renseigné par l'administration après mesure réelle.
    'examples', jsonb_build_array(
      jsonb_build_object('label', 'Clip court 8 s', 'approx_credits', null),
      jsonb_build_object('label', 'Clip 15 s', 'approx_credits', null),
      jsonb_build_object('label', 'Publicité 4 clips', 'approx_credits', null)
    )
  ),
  'Grille tarifaire du Studio VYORA (crédits, paliers et recharge libre)'
)
on conflict (setting_key) do nothing;

-- 2. Historique des achats de crédits Studio -----------------------------------------
-- `total_xof` et `credits_granted` sont figés à la création de la commande :
-- une modification ultérieure de la grille ne réécrit jamais un achat passé.
create table if not exists saas_ugc.ugc_credit_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  recharge_order_id uuid references saas_ugc.ugc_recharge_orders(id) on delete set null,
  pack_key text,
  label text not null,
  price_xof bigint not null check (price_xof > 0),
  credits_granted bigint not null check (credits_granted > 0),
  price_per_credit_xof numeric(14,4) not null check (price_per_credit_xof > 0),
  config_updated_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists ugc_credit_purchases_user_idx
  on saas_ugc.ugc_credit_purchases(user_id, created_at desc);

alter table saas_ugc.ugc_credit_purchases enable row level security;
revoke all on saas_ugc.ugc_credit_purchases from public, anon, authenticated;
grant select, insert on saas_ugc.ugc_credit_purchases to service_role;

-- 3. Lecture de la grille (client autorisé, aucune donnée sensible) ------------------
create or replace function public.studio_credit_grid()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg jsonb;
begin
  select s.setting_value into v_cfg
    from saas_ugc.ugc_app_settings s
   where s.setting_key = 'studio_pricing_config';
  if v_cfg is null then
    raise exception 'studio_pricing_not_configured';
  end if;

  return jsonb_build_object(
    'credit_value_xof', (v_cfg->>'credit_value_xof')::numeric,
    'packs', coalesce(v_cfg->'packs', '[]'::jsonb),
    'custom_recharge', v_cfg->'custom_recharge',
    'examples', coalesce(v_cfg->'examples', '[]'::jsonb),
    'target_margin_percent', (v_cfg->>'target_margin_percent')::numeric,
    'updated_at', (select s.updated_at from saas_ugc.ugc_app_settings s
                    where s.setting_key = 'studio_pricing_config')
  );
end $$;

revoke all on function public.studio_credit_grid() from public, anon;
grant execute on function public.studio_credit_grid() to authenticated, service_role;

-- 4. Achat d'un pack : prix et crédits calculés CÔTÉ SERVEUR ------------------------
-- Le client ne transmet qu'une clé de pack. Ni le prix, ni le nombre de crédits
-- ne proviennent du navigateur.
create or replace function public.studio_purchase_pack(
  p_pack_key text,
  p_provider text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg   jsonb;
  v_pack  jsonb;
  v_user  uuid := (select auth.uid());
  v_order uuid;
  v_purchase uuid;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if length(coalesce(trim(p_provider), '')) = 0
     or length(coalesce(trim(p_idempotency_key), '')) < 8 then
    raise exception 'invalid_purchase_request';
  end if;

  select s.setting_value, s.updated_at into v_cfg
    from saas_ugc.ugc_app_settings s
   where s.setting_key = 'studio_pricing_config';
  if v_cfg is null then raise exception 'studio_pricing_not_configured'; end if;

  select p.value into v_pack
    from jsonb_array_elements(coalesce(v_cfg->'packs', '[]'::jsonb)) p
   where p.value->>'pack_key' = p_pack_key
   limit 1;
  if v_pack is null then raise exception 'unknown_pack'; end if;

  -- La commande de recharge reste le seul objet créé : aucun paiement simulé.
  v_order := public.ugc_create_recharge_order(
    (v_pack->>'price_xof')::bigint, 'ML', p_provider, p_idempotency_key
  );

  insert into saas_ugc.ugc_credit_purchases(
    user_id, recharge_order_id, pack_key, label, price_xof, credits_granted,
    price_per_credit_xof, config_updated_at
  ) values (
    v_user, v_order, v_pack->>'pack_key', v_pack->>'label',
    (v_pack->>'price_xof')::bigint, (v_pack->>'credits')::bigint,
    round(((v_pack->>'price_xof')::numeric / (v_pack->>'credits')::numeric), 4),
    (select s.updated_at from saas_ugc.ugc_app_settings s where s.setting_key = 'studio_pricing_config')
  ) returning id into v_purchase;

  return jsonb_build_object(
    'purchase_id', v_purchase,
    'recharge_order_id', v_order,
    'pack_key', v_pack->>'pack_key',
    'price_xof', (v_pack->>'price_xof')::bigint,
    'credits', (v_pack->>'credits')::bigint,
    'status', 'pending'
  );
end $$;

revoke all on function public.studio_purchase_pack(text, text, text) from public, anon;
grant execute on function public.studio_purchase_pack(text, text, text) to authenticated, service_role;

-- 5. Historique unifié des recharges et consommations Studio ------------------------
create or replace function public.studio_credit_history(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  return jsonb_build_object(
    'purchases', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at desc)
        from (select id, pack_key, label, price_xof, credits_granted,
                     price_per_credit_xof, created_at
                from saas_ugc.ugc_credit_purchases
               where user_id = v_user
               order by created_at desc
               limit v_limit) p
    ), '[]'::jsonb),
    'ledger', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.created_at desc)
        from (select id, delta, reason, reference, created_at
                from saas_ugc.ugc_credit_ledger
               where user_id = v_user
               order by created_at desc
               limit v_limit) l
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.studio_credit_history(integer) from public, anon;
grant execute on function public.studio_credit_history(integer) to authenticated, service_role;

-- 6. Réglage administrable de la grille ---------------------------------------------
create or replace function public.studio_admin_set_credit_grid(p_config jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_credit_value numeric;
  v_packs jsonb;
begin
  perform ugc_private.reelora_assert_admin();

  v_credit_value := (p_config->>'credit_value_xof')::numeric;
  v_packs := coalesce(p_config->'packs', '[]'::jsonb);

  if v_credit_value is null or v_credit_value <= 0 or v_credit_value > 1000000 then
    raise exception 'invalid_credit_value';
  end if;
  if jsonb_array_length(v_packs) = 0 then
    raise exception 'packs_required';
  end if;
  -- Cohérence : un pack doit être rentable et strictement positif.
  if exists (
    select 1 from jsonb_array_elements(v_packs) p
     where coalesce((p.value->>'price_xof')::numeric, 0) <= 0
        or coalesce((p.value->>'credits')::numeric, 0) <= 0
  ) then
    raise exception 'invalid_pack_values';
  end if;

  select setting_value into v_old from saas_ugc.ugc_app_settings
   where setting_key = 'studio_pricing_config' for update;

  insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
  values ('studio_pricing_config', p_config, 'Grille tarifaire du Studio VYORA')
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value, updated_at = now();

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values ((select auth.uid()), 'set_studio_credit_grid', 'setting', 'studio_pricing_config',
          jsonb_build_object('previous', coalesce(v_old, '{}'::jsonb), 'new', p_config));
  return true;
end $$;

revoke all on function public.studio_admin_set_credit_grid(jsonb) from public, anon;
grant execute on function public.studio_admin_set_credit_grid(jsonb) to authenticated, service_role;
