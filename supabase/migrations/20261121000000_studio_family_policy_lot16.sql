-- -----------------------------------------------------------------------------
-- VYORA Studio — lot 16 : politique de familles DÉRIVÉE, tarif gratuit déclaré
-- et échelle de statuts cohérente.
--
-- Ce que ce fichier change, et ce qu'il ne change pas :
--   * les propositions de quota audio / musique / voix / 3D / LoRA / outil sont
--     désormais CALCULÉES à partir d'un quota déjà approuvé (la vidéo), avec un
--     ratio et un minimum explicites. Aucune valeur n'est choisie « à la main »
--     et aucune limite n'est approuvée ici ;
--   * une famille peut être approuvée par un acte d'administration explicite,
--     plan par plan ou famille entière ; tant que ce n'est pas fait, la
--     consommation reste refusée (`quota_policy_missing:<famille>`), mais la
--     configuration technique du modèle est persistée ;
--   * un prix fournisseur officiellement nul (watermark, Gemini Omni character)
--     est un prix DÉCLARÉ, pas un prix manquant : il est stocké avec sa preuve
--     et donne un modèle à 0 crédit, sans débit client, toujours soumis au
--     quota de sa famille. Aucun tarif n'est inventé ;
--   * les compteurs d'administration exposent l'échelle complète des statuts
--     (catalogué → préparé → configurable → configuré → testé → opérationnel →
--     activé → disponible) et séparent ce qui est bloqué par la technique de ce
--     qui attend un arbitrage produit.
--
-- Rien n'est activé : `enabled`, `verified_*` et les limites globales restent
-- inchangés. Aucun appel fournisseur, aucun crédit débité.
-- -----------------------------------------------------------------------------

-- 1. Règles de dérivation des propositions ------------------------------------------
-- Une famille nouvelle n'a pas de tarif propre : sa proposition est un multiple
-- d'une famille déjà approuvée. Le ratio est une DONNÉE modifiable, jamais une
-- constante du code.
create table if not exists saas_ugc.studio_family_policy_rules (
  family text primary key references saas_ugc.studio_quota_families(family),
  anchor_family text not null references saas_ugc.studio_quota_families(family),
  multiplier numeric(6,2) not null check (multiplier > 0 and multiplier <= 100),
  minimum integer not null default 1 check (minimum >= 0),
  rationale text not null,
  updated_at timestamptz not null default now()
);

insert into saas_ugc.studio_family_policy_rules(family, anchor_family, multiplier, minimum, rationale) values
  ('audio',   'video', 2.00, 1, 'Une piste audio est une unité plus légère qu''une vidéo : deux audios par vidéo autorisée, jamais un quota vidéo emprunté.'),
  ('voice',   'video', 2.00, 1, 'La synthèse vocale suit le même rythme que l''audio : deux synthèses par vidéo autorisée.'),
  ('music',   'video', 1.00, 1, 'Une musique générée reste une création complète : une musique par vidéo autorisée.'),
  ('model_3d','video', 1.00, 1, 'Un modèle 3D est une création lourde : une par vidéo autorisée.'),
  ('lora',    'video', 1.00, 1, 'Une inférence LoRA est une génération complète : une par vidéo autorisée.'),
  ('tool',    'video', 5.00, 5, 'Les outils fournisseur (masquage, modération) ne génèrent pas de création facturée : cinq appels par vidéo autorisée, pour couvrir le travail d''édition.')
on conflict (family) do update set anchor_family = excluded.anchor_family,
  multiplier = excluded.multiplier, minimum = excluded.minimum, rationale = excluded.rationale,
  updated_at = now();

-- 2. Calcul idempotent des propositions ----------------------------------------------
-- N'écrase jamais une politique déjà approuvée. Produit des lignes
-- `approved = false` : elles sont visibles, mesurables, mais inappliquées.
create or replace function public.studio_propose_family_policy(p_family text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_quotas integer := 0; v_plans integer := 0; v_families jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then perform ugc_private.reelora_assert_admin(); end if;
  for r in
    select rule.family, rule.anchor_family, rule.multiplier, rule.minimum
      from saas_ugc.studio_family_policy_rules rule
      join saas_ugc.studio_quota_families f on f.family = rule.family and f.active
     where p_family is null or rule.family = p_family
     order by rule.family
  loop
    insert into saas_ugc.studio_plan_quotas(plan_key, family, monthly_limit, enabled, approved, source_note)
    select p.plan_key, r.family,
           case when aq.monthly_limit is null or aq.monthly_limit <= 0 or not aq.approved then 0
                else greatest(round(aq.monthly_limit * r.multiplier)::integer, r.minimum) end,
           true, false,
           'proposition dérivée de ' || r.anchor_family || ' × ' || r.multiplier || ' — en attente d''arbitrage produit'
      from saas_ugc.ugc_plans p
      left join saas_ugc.studio_plan_quotas aq on aq.plan_key = p.plan_key and aq.family = r.anchor_family
     where p.active
    on conflict (plan_key, family) do update
      set monthly_limit = excluded.monthly_limit, enabled = true, approved = false,
          source_note = excluded.source_note, updated_at = now()
      where not saas_ugc.studio_plan_quotas.approved;
    get diagnostics v_quotas = row_count;

    insert into saas_ugc.studio_plan_families(plan_key, family, allowed, approved)
    select p.plan_key, r.family, coalesce(af.allowed, false), false
      from saas_ugc.ugc_plans p
      left join saas_ugc.studio_plan_families af on af.plan_key = p.plan_key and af.family = r.anchor_family
     where p.active
    on conflict (plan_key, family) do update
      set allowed = excluded.allowed, approved = false, updated_at = now()
      where not saas_ugc.studio_plan_families.approved;
    get diagnostics v_plans = row_count;

    v_families := v_families || jsonb_build_object('family', r.family, 'quotas_written', v_quotas, 'plans_written', v_plans);
  end loop;
  return jsonb_build_object('derived', true, 'proposed_only', true, 'families', v_families);
end $$;
revoke all on function public.studio_propose_family_policy(text) from public, anon;
grant execute on function public.studio_propose_family_policy(text) to authenticated, service_role;

-- 3. Lecture des propositions (administration) ----------------------------------------
create or replace function public.studio_family_policy_proposals()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  return jsonb_build_object(
    'proposed_only', true,
    'families', coalesce((
      select jsonb_agg(jsonb_build_object(
        'family', rule.family,
        'display_name', f.display_name,
        'anchor_family', rule.anchor_family,
        'multiplier', rule.multiplier,
        'minimum', rule.minimum,
        'rationale', rule.rationale,
        'quota_approved_plans', (select count(*) from saas_ugc.studio_plan_quotas q
                                  where q.family = rule.family and q.approved and q.enabled and q.monthly_limit > 0),
        'entitlement_approved_plans', (select count(*) from saas_ugc.studio_plan_families pf
                                        where pf.family = rule.family and pf.approved and pf.allowed),
        'models_prepared', (select count(*) from saas_ugc.studio_runtime_configs c
                             join saas_ugc.studio_model_integrations i on i.model_id = c.model_id
                            where c.quota_kind = rule.family and i.status = 'integration_prepared'),
        'plans', coalesce((
          select jsonb_agg(jsonb_build_object(
            'plan_key', p.plan_key,
            'anchor_limit', aq.monthly_limit,
            'anchor_approved', coalesce(aq.approved, false),
            'proposed_limit', q.monthly_limit,
            'quota_approved', coalesce(q.approved, false),
            'quota_enabled', coalesce(q.enabled, false),
            'entitlement_allowed', coalesce(pf.allowed, false),
            'entitlement_approved', coalesce(pf.approved, false))
            order by p.sort_order, p.plan_key)
          from saas_ugc.ugc_plans p
          left join saas_ugc.studio_plan_quotas aq on aq.plan_key = p.plan_key and aq.family = rule.anchor_family
          left join saas_ugc.studio_plan_quotas q on q.plan_key = p.plan_key and q.family = rule.family
          left join saas_ugc.studio_plan_families pf on pf.plan_key = p.plan_key and pf.family = rule.family
          where p.active), '[]'::jsonb))
        order by rule.family)
      from saas_ugc.studio_family_policy_rules rule
      join saas_ugc.studio_quota_families f on f.family = rule.family and f.active), '[]'::jsonb));
end $$;
revoke all on function public.studio_family_policy_proposals() from public, anon;
grant execute on function public.studio_family_policy_proposals() to authenticated, service_role;

-- 4. Approbation explicite d'une famille ---------------------------------------------
-- Acte d'administration unique et traçable : il approuve les limites DÉRIVÉES
-- déjà calculées (jamais une valeur fournie à la volée), et, seulement si
-- l'administrateur le demande, les droits d'offre déjà proposés.
create or replace function public.studio_approve_family_policy(
  p_family text, p_approve_entitlements boolean default false, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_quotas integer := 0; v_entitlements integer := 0;
begin
  perform ugc_private.reelora_assert_admin();
  if p_family is null or not exists (select 1 from saas_ugc.studio_quota_families where family = p_family and active) then
    raise exception 'invalid_family';
  end if;
  if not exists (select 1 from saas_ugc.studio_family_policy_rules where family = p_family) then
    raise exception 'no_derivation_rule';
  end if;
  if p_family in ('audio','music','voice','model_3d','lora','tool') and (p_note is null or length(trim(p_note)) < 3) then
    raise exception 'approval_note_required';
  end if;
  update saas_ugc.studio_plan_quotas
     set approved = true, enabled = true,
         source_note = coalesce(p_note, 'politique dérivée approuvée par l''administration'),
         updated_at = now()
   where family = p_family and monthly_limit > 0;
  get diagnostics v_quotas = row_count;
  if p_approve_entitlements then
    update saas_ugc.studio_plan_families
       set approved = true, updated_at = now()
     where family = p_family and allowed;
    get diagnostics v_entitlements = row_count;
  end if;
  return jsonb_build_object('family', p_family, 'quota_plans_approved', v_quotas,
    'entitlement_plans_approved', v_entitlements, 'entitlements_approved', p_approve_entitlements);
end $$;
revoke all on function public.studio_approve_family_policy(text,boolean,text) from public, anon;
grant execute on function public.studio_approve_family_policy(text,boolean,text) to authenticated, service_role;

-- 5. Tarif fournisseur officiellement nul ---------------------------------------------
-- `billing = 'free'` n'est accordé que si la fiche officielle déclare un coût
-- nul avec une stratégie de coût nommée (preuve conservée dans
-- `provider_pricing`). Un prix absent reste absent : jamais converti en 0.
--
-- Le validateur de forme est réécrit pour accepter CE cas précis ; toutes les
-- autres règles (devise, plafond, endpoint d'estimation) restent identiques.
create or replace function ugc_private.studio_provider_pricing_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and p ? 'cost_usd'
    and jsonb_typeof(p->'cost_usd') = 'number'
    and (p->>'cost_usd')::numeric >= 0
    and (p->>'cost_usd')::numeric <= 1000
    and p->>'currency' = 'USD'
    and (not p ? 'estimate_path' or p->>'estimate_path' is null
         or p->>'estimate_path' ~ '^/api/v1/models/[A-Za-z0-9._~-]{1,160}/estimate-cost$')
    and (
      ((p->>'cost_usd')::numeric = 0
        and p->>'billing' = 'free'
        and coalesce(p->>'cost_strategy','') ~ '^[A-Za-z0-9._~-]{1,80}$'
        and coalesce(p->>'source_url','') ~ '^https://api\.muapi\.ai/')
      or ((p->>'cost_usd')::numeric > 0 and coalesce(p->>'billing','metered') = 'metered')
    )
    and (select count(*) from jsonb_object_keys(p)) <= 9
  );
$$;
revoke all on function ugc_private.studio_provider_pricing_valid(jsonb) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'studio_ai_models_provider_pricing_shape') then
    alter table saas_ugc.studio_ai_models drop constraint studio_ai_models_provider_pricing_shape;
  end if;
  alter table saas_ugc.studio_ai_models
    add constraint studio_ai_models_provider_pricing_shape
    check (ugc_private.studio_provider_pricing_valid(provider_pricing));
end $$;
alter table saas_ugc.studio_runtime_configs
  add column if not exists billing text not null default 'metered'
  check (billing in ('metered','free'));

-- 6. Préparation runtime : famille par règles + tarif gratuit prouvé ----------------
create or replace function public.studio_prepare_runtime(p_model_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m saas_ugc.studio_ai_models%rowtype; i saas_ugc.studio_model_integrations%rowtype;
        c saas_ugc.studio_runtime_configs%rowtype;
        v_cost numeric; v_credits integer; v_quota text; v_output text; v_estimate text;
        v_billing text; v_free boolean; v_changed boolean := false; v_missing text[] := '{}';
        v_plans text[] := '{}'; v_quota_ok boolean; v_plans_source text; v_material boolean := false;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  select * into m from saas_ugc.studio_ai_models where id = p_model_id for update;
  if not found then raise exception 'unknown_model'; end if;
  select * into i from saas_ugc.studio_model_integrations where model_id = p_model_id;
  if not found or i.status is distinct from 'integration_prepared' then raise exception 'integration_not_prepared'; end if;
  if i.protocol is null then raise exception 'protocol_missing'; end if;
  if coalesce(m.endpoint_evidence->'resolution'->>'status','') <> 'resolved' then raise exception 'endpoint_unverified'; end if;
  if m.provider_pricing is null then raise exception 'provider_pricing_missing'; end if;
  v_cost := (m.provider_pricing->>'cost_usd')::numeric;
  v_estimate := m.provider_pricing->>'estimate_path';
  if v_cost is null then raise exception 'provider_pricing_missing'; end if;
  -- Gratuit déclaré = coût nul ET stratégie de coût officielle conservée.
  v_free := v_cost = 0
    and coalesce(m.provider_pricing->>'billing','') = 'free'
    and length(coalesce(m.provider_pricing->>'cost_strategy','')) > 0
    and length(coalesce(m.provider_pricing->>'source_url','')) > 0;
  if v_cost < 0 or v_cost > 1000 or (v_cost = 0 and not v_free) then raise exception 'provider_pricing_invalid'; end if;
  -- Sans endpoint d'estimation, aucun devis ne peut être émis : ce n'est pas une
  -- configuration incomplète, c'est un modèle non exécutable en l'état.
  if v_estimate is null or v_estimate <> '/api/v1/models/' || m.provider_model_id || '/estimate-cost' then
    raise exception 'estimate_endpoint_missing';
  end if;
  -- Famille de quota résolue par les règles en base, jamais par une condition
  -- propre à un modèle. Une catégorie inconnue reste un refus explicite.
  v_quota := ugc_private.studio_quota_family(
    m.category, i.protocol, coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('integration_family', coalesce(i.family,'')));
  if v_quota is null then raise exception 'quota_policy_missing'; end if;
  v_output := case when i.protocol = 'muapi_output_text_v1' then 'text' else 'media' end;
  v_billing := case when v_free then 'free' else 'metered' end;
  v_credits := case when v_free then 0 else ugc_private.studio_credit_price(v_cost) end;

  insert into saas_ugc.studio_runtime_configs(model_id) values (p_model_id) on conflict do nothing;
  select * into c from saas_ugc.studio_runtime_configs where model_id = p_model_id for update;
  v_plans_source := c.plans_source;
  if v_plans_source = 'policy' then
    select coalesce(array_agg(pf.plan_key order by pf.plan_key), '{}') into v_plans
      from saas_ugc.studio_plan_families pf
      join saas_ugc.ugc_plans p on p.plan_key = pf.plan_key and p.active
     where pf.family = v_quota and pf.allowed and pf.approved;
  end if;
  -- Un changement matériel (prix, coût maximum, endpoint, sortie, famille,
  -- facturation) doit invalider la validation payée. Une simple attribution de
  -- plan n'est pas un changement du contrat fournisseur.
  v_material := c.credits is distinct from v_credits or c.max_cost_usd is distinct from v_cost
     or c.quota_kind is distinct from v_quota or c.output_kind is distinct from v_output
     or c.estimate_path is distinct from v_estimate or c.billing is distinct from v_billing;
  if v_material or (v_plans_source = 'policy' and c.allowed_plans is distinct from v_plans) then
    update saas_ugc.studio_runtime_configs set credits = v_credits, max_cost_usd = v_cost,
      quota_kind = v_quota, output_kind = v_output, estimate_path = v_estimate, billing = v_billing,
      allowed_plans = case when v_plans_source = 'policy' then v_plans else allowed_plans end,
      enabled = case when v_material then false else enabled end,
      verified_hash = case when v_material then null else verified_hash end,
      verified_at = case when v_material then null else verified_at end,
      verification_reference = case when v_material then null else verification_reference end,
      revision = revision + 1, updated_at = now()
    where model_id = p_model_id;
    v_changed := true;
  end if;
  select * into c from saas_ugc.studio_runtime_configs where model_id = p_model_id;

  if m.account_access is distinct from 'available' then v_missing := array_append(v_missing, 'ACCESS_UNCONFIRMED'); end if;
  if coalesce(array_length(c.allowed_plans, 1), 0) = 0 then v_missing := array_append(v_missing, 'PLAN_UNAVAILABLE'); end if;
  -- Une limite de plan approuvée doit exister pour au moins un plan : sinon le
  -- modèle est configuré mais sa consommation est refusée.
  select exists(select 1 from saas_ugc.studio_plan_quotas q join saas_ugc.ugc_plans p on p.plan_key = q.plan_key and p.active
                 where q.family = v_quota and q.enabled and q.approved and q.monthly_limit is not null) into v_quota_ok;
  if not v_quota_ok then v_missing := array_append(v_missing, 'QUOTA_POLICY_MISSING'); end if;
  v_missing := array_append(v_missing, 'PAID_VALIDATION_PENDING');
  v_missing := array_append(v_missing, 'ADMIN_DISABLED');

  return jsonb_build_object(
    'model_id', p_model_id, 'changed', v_changed, 'credits', c.credits, 'max_cost_usd', c.max_cost_usd,
    'quota_kind', c.quota_kind, 'output_kind', c.output_kind, 'estimate_path', c.estimate_path,
    'billing', c.billing,
    'revision', c.revision, 'enabled', c.enabled, 'verified', c.verified_at is not null,
    'access_confirmed', m.account_access = 'available', 'estimate_declared', c.estimate_path is not null,
    'quota_policy', v_quota_ok,
    'plans', c.allowed_plans, 'plans_source', c.plans_source,
    'remaining', to_jsonb(v_missing));
end $$;
revoke all on function public.studio_prepare_runtime(uuid) from public, anon, authenticated;
grant execute on function public.studio_prepare_runtime(uuid) to service_role;

-- 7. Modèle runtime : la famille et le quota sont tranchés par la BASE ---------------
-- Le Edge Function ne redeviendra jamais juge des familles : il lit ici
-- `quota_resolved` (la famille persistée est bien celle des règles) et
-- `quota_policy_ready` (au moins une limite approuvée existe).
create or replace function public.studio_runtime_model(p_model_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 return (
  select to_jsonb(m)
    || jsonb_build_object('runtime_config', to_jsonb(c), 'spec_hash', ugc_private.studio_spec_hash(m.id),
         'runtime_enabled', (select enabled from saas_ugc.studio_runtime_limits where id),
         'quota_resolved', case
           when c.quota_kind is null then false
           else c.quota_kind = ugc_private.studio_quota_family(m.category, i.protocol,
             coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('integration_family', coalesce(i.family, '')))
         end,
         'quota_policy_ready', exists(
           select 1 from saas_ugc.studio_plan_quotas q
             join saas_ugc.ugc_plans p on p.plan_key = q.plan_key and p.active
            where q.family = c.quota_kind and q.enabled and q.approved and q.monthly_limit > 0))
   from saas_ugc.studio_ai_models m
   left join saas_ugc.studio_runtime_configs c on c.model_id = m.id
   left join saas_ugc.studio_model_integrations i on i.model_id = m.id
   where m.provider_key = 'muapi' and m.provider_model_id = p_model_id);
end $$;
revoke all on function public.studio_runtime_model(text) from public, anon, authenticated;
grant execute on function public.studio_runtime_model(text) to service_role;

-- 8. Devis : 0 USD est accepté UNIQUEMENT pour une configuration gratuite --------
create or replace function public.studio_runtime_issue_quote(p_user_id uuid,p_model_id uuid,p_params jsonb,p_cost numeric,p_hash text,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c saas_ugc.studio_runtime_configs%rowtype; q saas_ugc.studio_runtime_quotes%rowtype; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 select * into c from saas_ugc.studio_runtime_configs where model_id=p_model_id;
 if not found or not c.enabled or c.verified_hash is distinct from ugc_private.studio_spec_hash(p_model_id)
    or c.verified_at is null or c.revision is distinct from p_revision or c.verified_hash is distinct from p_hash
    or c.credits is null or p_cost is null or p_cost<0 or p_cost>c.max_cost_usd
    or (c.billing='free' and (p_cost<>0 or c.credits<>0))
    or (c.billing<>'free' and p_cost<=0)
    or octet_length(p_params::text)>131072 then raise exception 'quote_unavailable'; end if;
 if not (select enabled from saas_ugc.studio_runtime_limits where id) then raise exception 'runtime_disabled'; end if;
 insert into saas_ugc.studio_runtime_quotes(user_id,model_id,params,spec_hash,config_revision,credits,estimated_usd)
 values(p_user_id,p_model_id,p_params,p_hash,p_revision,c.credits,p_cost) returning * into q;
 return jsonb_build_object('quote_id',q.id,'credits',q.credits,'expires_at',q.expires_at);
end $$;
revoke all on function public.studio_runtime_issue_quote(uuid,uuid,jsonb,numeric,text,integer) from public, anon, authenticated;
grant execute on function public.studio_runtime_issue_quote(uuid,uuid,jsonb,numeric,text,integer) to service_role;

-- 9. Réservation : aucun mouvement de portefeuille à 0 crédit ---------------------
create or replace function public.studio_runtime_start(p_quote_id uuid,p_request_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); q saas_ugc.studio_runtime_quotes%rowtype; c saas_ugc.studio_runtime_configs%rowtype;
 j saas_ugc.studio_runtime_jobs%rowtype; lim saas_ugc.studio_runtime_limits%rowtype; ctx jsonb; used numeric; jid uuid:=gen_random_uuid(); begin
 ctx:=public.studio_runtime_access();
 perform pg_advisory_xact_lock(hashtext('studio-start-'||uid::text));
 select * into j from saas_ugc.studio_runtime_jobs where user_id=uid and (request_key=p_request_key or quote_id=p_quote_id);
 if found then return jsonb_build_object('id',j.id,'new',false); end if;
 select * into q from saas_ugc.studio_runtime_quotes where id=p_quote_id and user_id=uid for update;
 if not found or q.expires_at<=now() then raise exception 'quote_expired'; end if;
 select * into c from saas_ugc.studio_runtime_configs where model_id=q.model_id for update;
 if not found or not c.enabled or c.credits is null or c.credits<>q.credits or c.verified_at is null
    or c.verified_hash is distinct from ugc_private.studio_spec_hash(q.model_id) or c.verified_hash is distinct from q.spec_hash
    or c.revision<>q.config_revision or not ((ctx->>'plan')=any(c.allowed_plans)) then raise exception 'model_unavailable'; end if;
 if not exists(select 1 from saas_ugc.studio_ai_models where id=q.model_id and account_access='available' and public_catalog_present and provider_enabled is true and coming_soon is not true) then raise exception 'model_unavailable'; end if;
 select * into lim from saas_ugc.studio_runtime_limits where id for update;
 if not lim.enabled or q.estimated_usd>c.max_cost_usd then raise exception 'runtime_disabled'; end if;
 select coalesce(sum(greatest(estimated_usd,coalesce(actual_usd,0))),0) into used from saas_ugc.studio_runtime_jobs where created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC';
 if used+q.estimated_usd>lim.daily_usd then raise exception 'daily_budget_exceeded'; end if;
 if (select count(*) from saas_ugc.studio_runtime_jobs where user_id=uid and status in ('submitting','processing','uncertain'))>=3 then raise exception 'concurrency_limit'; end if;
 perform public.reelora_consume_quota(c.quota_kind,jid,'{"source":"studio_universal"}'::jsonb);
 if q.credits > 0 then
  perform ugc_private.apply_wallet_delta(uid,'reserve',-q.credits::bigint,q.credits::bigint,'studio:reserve:'||jid::text,'Réservation Studio universel',jsonb_build_object('studio_job_id',jid));
 end if;
 insert into saas_ugc.studio_runtime_jobs(id,user_id,workspace_id,quote_id,request_key,model_id,status,credits,estimated_usd,quota_kind)
 values(jid,uid,(ctx->>'workspace_id')::uuid,q.id,p_request_key,q.model_id,'submitting',q.credits,q.estimated_usd,c.quota_kind);
 update saas_ugc.studio_runtime_jobs set output_kind=c.output_kind where id=jid;
 return jsonb_build_object('id',jid,'new',true);
end $$;
revoke all on function public.studio_runtime_start(uuid,uuid) from public, anon;
grant execute on function public.studio_runtime_start(uuid,uuid) to authenticated, service_role;

-- 10. Fin de tâche : capture/restitution seulement si des crédits étaient réservés
create or replace function public.studio_runtime_finish(p_job_id uuid,p_status text,p_outputs jsonb,p_actual_usd numeric) returns boolean language plpgsql security definer set search_path='' as $$
declare j saas_ugc.studio_runtime_jobs%rowtype; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 if p_status not in ('succeeded','failed') or p_outputs is null or jsonb_typeof(p_outputs)<>'array' or jsonb_array_length(p_outputs)>16 or octet_length(p_outputs::text)>200000 then raise exception 'invalid_result'; end if;
 if p_status='succeeded' and (p_actual_usd is null or p_actual_usd<0) then raise exception 'actual_cost_required'; end if;
 if p_status='succeeded' and jsonb_array_length(p_outputs)=0 then raise exception 'empty_result'; end if;
 select * into j from saas_ugc.studio_runtime_jobs where id=p_job_id for update;
 if not found then raise exception 'job_not_found'; end if;
 if j.status in ('succeeded','failed','expired') then return false; end if;
 if j.status<>'processing' then raise exception 'job_not_processing'; end if;
 update saas_ugc.studio_runtime_jobs set status=p_status,outputs=p_outputs,actual_usd=greatest(coalesce(p_actual_usd,estimated_usd),0),error_code=case when p_status='failed' then 'PROVIDER_FAILED' else null end,updated_at=now() where id=j.id;
 if p_status='succeeded' then
  if j.credits > 0 then
   perform ugc_private.apply_wallet_delta(j.user_id,'capture',0,-j.credits::bigint,'studio:capture:'||j.id::text,'Génération Studio terminée',jsonb_build_object('studio_job_id',j.id));
  end if;
 else
  if j.credits > 0 then
   perform ugc_private.apply_wallet_delta(j.user_id,'release',j.credits::bigint,-j.credits::bigint,'studio:release:'||j.id::text,'Génération Studio échouée',jsonb_build_object('studio_job_id',j.id));
  end if;
  delete from saas_ugc.ugc_usage_events where user_id=j.user_id and reference_id=j.id and event_kind=j.quota_kind;
 end if;
 if p_actual_usd>(select max_cost_usd from saas_ugc.studio_runtime_configs where model_id=j.model_id) then
  update saas_ugc.studio_runtime_limits set enabled=false where id;
  update saas_ugc.studio_runtime_configs set enabled=false,verified_hash=null where model_id=j.model_id;
 end if;
 return true;
end $$;
revoke all on function public.studio_runtime_finish(uuid,text,jsonb,numeric) from public, anon, authenticated;
grant execute on function public.studio_runtime_finish(uuid,text,jsonb,numeric) to service_role;

-- 11. Expiration : restitution seulement si des crédits étaient réservés -----------
create or replace function public.studio_runtime_expire() returns integer language plpgsql security definer set search_path='' as $$
declare j saas_ugc.studio_runtime_jobs%rowtype; n integer:=0; begin
 if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
 for j in select * from saas_ugc.studio_runtime_jobs where status in ('submitting','processing','uncertain') and reservation_deadline<=now() order by id for update skip locked limit 100 loop
  if j.credits > 0 then
   perform ugc_private.apply_wallet_delta(j.user_id,'release',j.credits::bigint,-j.credits::bigint,'studio:release:'||j.id::text,'Réservation expirée — coût tardif pris en charge par VYORA',jsonb_build_object('studio_job_id',j.id));
  end if;
  delete from saas_ugc.ugc_usage_events where user_id=j.user_id and reference_id=j.id and event_kind=j.quota_kind;
  update saas_ugc.studio_runtime_jobs set status='expired',error_code='RESERVATION_EXPIRED',updated_at=now() where id=j.id;
  n:=n+1;
 end loop;
 delete from saas_ugc.studio_runtime_requests where created_at<now()-interval '1 day';
 delete from saas_ugc.studio_runtime_quotes q where expires_at<now()-interval '1 day' and not exists(select 1 from saas_ugc.studio_runtime_jobs existing_job where existing_job.quote_id=q.id);
 return n;
end $$;
revoke all on function public.studio_runtime_expire() from public, anon, authenticated;
grant execute on function public.studio_runtime_expire() to service_role;

-- 12. Échelle de statuts et compteurs d'administration ------------------------------
create or replace function public.studio_catalog_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
  perform ugc_private.reelora_assert_admin();
  with states as (
    select m.id, m.category, m.public_catalog_present, d.status as detail_status,
      (i.status = 'integration_prepared' and i.spec_hash = ugc_private.studio_spec_hash(m.id)) as prepared,
      coalesce(c.enabled, false) as enabled,
      coalesce(c.billing, 'metered') = 'free' as free_billing,
      coalesce((c.credits = 0 and c.max_cost_usd = 0 and c.billing = 'free')
               or (c.credits > 0 and c.max_cost_usd > 0), false) as priced,
      coalesce(c.verified_at is not null and c.verified_hash = ugc_private.studio_spec_hash(m.id), false) as tested,
      coalesce(c.estimate_path is not null and c.output_kind in ('media','text'), false) as adaptable,
      coalesce(c.quota_kind = ugc_private.studio_quota_family(m.category, i.protocol,
        coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object('integration_family', coalesce(i.family,''))), false) as family_ok,
      coalesce(exists(select 1 from saas_ugc.studio_plan_quotas q join saas_ugc.ugc_plans p on p.plan_key=q.plan_key and p.active
                      where q.family = c.quota_kind and q.enabled and q.approved and q.monthly_limit is not null), false) as quota_ready,
      coalesce(cardinality(c.allowed_plans) > 0, false) as plans_ready,
      coalesce(c.estimate_path is not null and c.output_kind is not null, false) as runtime_configured,
      coalesce((select enabled from saas_ugc.studio_runtime_limits where id), false) as runtime_enabled,
      coalesce(c.plans_source, 'policy') as plans_source
    from saas_ugc.studio_ai_models m
    left join saas_ugc.studio_ai_model_details d on d.model_id = m.id
    left join saas_ugc.studio_model_integrations i on i.model_id = m.id
    left join saas_ugc.studio_runtime_configs c on c.model_id = m.id
    where m.provider_key = 'muapi'
  ), evaluated as (
    select *,
      (prepared and priced and adaptable and family_ok) as configurable,
      (prepared and priced and adaptable and family_ok and runtime_configured) as configured,
      (prepared and priced and adaptable and family_ok and tested) as technically_tested,
      (prepared and priced and adaptable and family_ok and quota_ready and plans_ready
       and public_catalog_present and tested and runtime_enabled and enabled) as operational
    from states
  )
  select jsonb_build_object(
    'models', count(*), 'present', count(*) filter (where public_catalog_present),
    'removed', count(*) filter (where not public_catalog_present),
    'status', jsonb_build_object(
      'catalogued', count(*),
      'prepared', count(*) filter (where prepared),
      'configurable', count(*) filter (where configurable),
      'runtime_configured', count(*) filter (where configured),
      'technical_test_passed', count(*) filter (where technically_tested),
      'operational', count(*) filter (where operational),
      'enabled', count(*) filter (where enabled),
      'studio_available', count(*) filter (where operational)),
    'prepared', count(*) filter (where prepared),
    'configurable', count(*) filter (where configurable),
    'runtime_configured', count(*) filter (where configured),
    'technical_test_passed', count(*) filter (where technically_tested),
    'integrated', count(*) filter (where configurable),
    'operational', count(*) filter (where operational),
    'enabled', count(*) filter (where enabled),
    'studio_available', count(*) filter (where operational),
    'free_billing', count(*) filter (where free_billing),
    'problems', count(*) filter (where not operational),
    'pricing_missing', count(*) filter (where not priced),
    'real_tests_missing', count(*) filter (where not tested),
    'estimate_missing', count(*) filter (where not adaptable),
    -- Un modèle configurable dont la famille attend un arbitrage n'est pas un
    -- modèle en panne : le compteur le dit séparément.
    'quota_policy_pending', count(*) filter (where not quota_ready),
    'configurable_quota_pending', count(*) filter (where configurable and not quota_ready),
    'configurable_plan_pending', count(*) filter (where configurable and not plans_ready),
    'plan_policy_pending', count(*) filter (where not plans_ready),
    'quota_families', (select count(*) from saas_ugc.studio_quota_families where active),
    'quota_families_proposed_only', (select count(*) from saas_ugc.studio_family_policy_rules),
    'plans', coalesce((select jsonb_agg(plan_key order by plan_key) from saas_ugc.ugc_plans where active), '[]'::jsonb),
    -- Champs conservés pour la santé du catalogue (contrat existant de l'API).
    'details_ok', count(*) filter (where detail_status = 'ok'),
    'detail_errors', count(*) filter (where detail_status is not null and detail_status <> 'ok'),
    'last_sync', (select max(synced_at) from saas_ugc.studio_ai_catalog_syncs where provider_key = 'muapi' and source_scope = 'public'),
    'categories', (select coalesce(jsonb_object_agg(category, n), '{}'::jsonb) from (select category, count(*) n from states group by category) x),
    'measured_at', now()
  ) into result from evaluated;
  return result;
end $$;
revoke all on function public.studio_catalog_admin_summary() from public, anon;
grant execute on function public.studio_catalog_admin_summary() to authenticated;

-- 13. Préparation : ce qui manque, avec la famille et le tarif -----------------------
create or replace function public.studio_runtime_readiness()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(x order by x->>'provider_model_id'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'provider_model_id', m.provider_model_id, 'family', i.family, 'protocol', i.protocol,
      'credits', c.credits, 'max_cost_usd', c.max_cost_usd, 'billing', coalesce(c.billing,'metered'),
      'quota_kind', c.quota_kind,
      'quota_policy', exists(select 1 from saas_ugc.studio_plan_quotas q join saas_ugc.ugc_plans p on p.plan_key=q.plan_key and p.active
                             where q.family=c.quota_kind and q.enabled and q.approved and q.monthly_limit is not null),
      'estimate_path', c.estimate_path, 'runtime_configured', c.estimate_path is not null and c.output_kind is not null,
      'enabled', coalesce(c.enabled, false),
      'verified', c.verified_at is not null, 'access', m.account_access,
      'plans', coalesce(c.allowed_plans, '{}'), 'plans_source', coalesce(c.plans_source,'policy'),
      'scope', case when coalesce(m.metadata->>'group_of','') in ('utility','moderation') then 'tool' else 'generator' end) x
    from saas_ugc.studio_ai_models m
      join saas_ugc.studio_model_integrations i on i.model_id = m.id
      left join saas_ugc.studio_runtime_configs c on c.model_id = m.id
     where i.status = 'integration_prepared') s;
  return v_rows;
end $$;
revoke all on function public.studio_runtime_readiness() from public, anon, authenticated;
grant execute on function public.studio_runtime_readiness() to service_role;

notify pgrst, 'reload schema';
