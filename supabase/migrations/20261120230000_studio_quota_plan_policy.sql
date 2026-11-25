-- -----------------------------------------------------------------------------
-- VYORA Studio — quotas extensibles, plans autorisés et parcours de consommation
--
-- Objectif du lot 15 : sortir les quotas du codage en dur (« video/image/script »)
-- sans jamais détourner un quota existant. Une famille de quota est une DONNÉE :
--   * `studio_quota_families`      : familles consommables (audio, musique, voix,
--                                   3D, LoRA, outil…) ;
--   * `studio_family_rules`        : règles de rattachement catégorie → famille,
--                                   ordonnées par priorité, modifiables en base ;
--   * `studio_plan_quotas`         : limite mensuelle par plan et par famille ;
--   * `studio_plan_families`       : droits plan → famille (accordés/validés).
--
-- Aucune limite n'est inventée ni activée : les quotas historiques (script,
-- prompt, vidéo, image, export) sont repris TELLES QUELLES des colonnes de
-- `ugc_plans` et marqués approuvés. Les familles nouvelles sont seulement
-- PROPOSÉES (`approved = false`) : la consommation refuse tant qu'un arbitrage
-- produit ne les a pas validées, avec un motif explicite.
--
-- Rien n'est activé ici : ce fichier ne touche ni `enabled`, ni `verified_*`,
-- ni le portefeuille. Aucun appel fournisseur, aucun crédit débité.
-- -----------------------------------------------------------------------------

-- 1. Catalogue des familles de quota ------------------------------------------------
create table if not exists saas_ugc.studio_quota_families (
  family text primary key check (family ~ '^[a-z0-9_]{1,40}$'),
  display_name text not null,
  generator boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into saas_ugc.studio_quota_families(family, display_name, generator) values
  ('script',   'Script / texte',           true),
  ('prompt',   'Prompt IA',                false),
  ('video',    'Vidéo',                    true),
  ('image',    'Image',                    true),
  ('audio',    'Audio',                    true),
  ('music',    'Musique et chansons',      true),
  ('voice',    'Voix / synthèse vocale',   true),
  ('model_3d', 'Modèle 3D',                true),
  ('lora',     'LoRA / adaptation',        true),
  ('tool',     'Outil fournisseur',        false),
  ('export',   'Export',                   false)
on conflict (family) do nothing;

-- 2. Les événements d'usage acceptent les nouvelles familles ------------------------
alter table saas_ugc.ugc_usage_events drop constraint if exists ugc_usage_events_event_kind_check;
alter table saas_ugc.ugc_usage_events add constraint ugc_usage_events_event_kind_check
  check (event_kind in ('script','prompt','video','image','export',
                        'audio','music','voice','model_3d','lora','tool'));

-- 3. `quota_kind` devient une référence extensible à une famille -------------------
alter table saas_ugc.studio_runtime_configs drop constraint if exists studio_runtime_configs_quota_kind_check;
alter table saas_ugc.studio_runtime_configs
  add constraint studio_runtime_configs_quota_kind_family
  foreign key (quota_kind) references saas_ugc.studio_quota_families(family);

-- Une configuration dont les plans sont gérés à la main ne doit pas être écrasée
-- par la politique automatique lors d'une nouvelle préparation.
alter table saas_ugc.studio_runtime_configs
  add column if not exists plans_source text not null default 'policy'
  check (plans_source in ('policy','manual'));

-- 4. Règles de rattachement catégorie → famille ------------------------------------
-- Données, pas de condition par modèle : ajouter une famille = ajouter une règle.
create table if not exists saas_ugc.studio_family_rules (
  rule_key text primary key,
  priority integer not null,
  pattern text not null,
  family text not null references saas_ugc.studio_quota_families(family),
  active boolean not null default true
);
insert into saas_ugc.studio_family_rules(rule_key, priority, pattern, family) values
  ('3d',     100, '(^|[^a-z])(3d|three[ -]dimensional|mesh|glb)([^a-z]|$)', 'model_3d'),
  ('tts',     90, 'text[ -]?to[ -]?speech|(^|[^a-z])tts([^a-z]|$)|voice|speech synthesis', 'voice'),
  ('music',   85, 'music|song|soundtrack|melod', 'music'),
  ('lora',    80, 'lora|fine[ -]?tun', 'lora'),
  ('audio',   75, 'audio|sfx|sound[ -]?effect', 'audio'),
  ('video',   70, 'video', 'video'),
  ('image',   60, 'image|photo|illustration', 'image'),
  ('text',    50, 'text[ -]?to[ -]?text|text generation|chat|completion|llm', 'script')
on conflict (rule_key) do nothing;

create or replace function ugc_private.studio_quota_family(
  p_category text, p_protocol text default null, p_metadata jsonb default '{}'::jsonb
) returns text language sql stable set search_path = '' as $$
  select case
    -- Un utilitaire fournisseur (publication sociale, bac à sable, modération)
    -- n'est jamais un générateur, même si sa catégorie contient « image ».
    when coalesce(p_metadata->>'group_of','') in ('utility','moderation') then 'tool'
    else (
      select r.family from saas_ugc.studio_family_rules r
       where r.active
         and lower(coalesce(p_category,'') || ' ' || coalesce(p_metadata->>'integration_family','')) ~* r.pattern
       order by r.priority desc, r.rule_key
       limit 1
    )
  end;
$$;
revoke all on function ugc_private.studio_quota_family(text,text,jsonb) from public, anon, authenticated;

-- 5. Quotas par plan et par famille -------------------------------------------------
create table if not exists saas_ugc.studio_plan_quotas (
  plan_key text not null references saas_ugc.ugc_plans(plan_key) on update cascade,
  family text not null references saas_ugc.studio_quota_families(family),
  monthly_limit integer check (monthly_limit >= 0),
  enabled boolean not null default true,
  approved boolean not null default false,
  source_note text,
  updated_at timestamptz not null default now(),
  primary key (plan_key, family)
);

-- Reprise EXACTE de la politique existante (aucun quota détourné, aucune valeur
-- nouvelle) : les formules sont celles de `reelora_consume_quota` d'origine.
insert into saas_ugc.studio_plan_quotas(plan_key, family, monthly_limit, enabled, approved, source_note)
select plan_key, 'script', max_scripts_per_month, true, true, 'politique existante max_scripts_per_month' from saas_ugc.ugc_plans
union all
select plan_key, 'prompt', max_prompts_per_month, true, true, 'politique existante max_prompts_per_month' from saas_ugc.ugc_plans
union all
select plan_key, 'video', max_videos_per_month, true, true, 'politique existante max_videos_per_month' from saas_ugc.ugc_plans
union all
select plan_key, 'image', greatest(max_videos_per_month * 2, 1), true, true, 'politique existante : 2 images par vidéo autorisée' from saas_ugc.ugc_plans
union all
select plan_key, 'export', 100, true, true, 'politique existante : plafond export fixe à 100' from saas_ugc.ugc_plans
on conflict (plan_key, family) do nothing;

-- PROPOSITIONS en attente d'arbitrage produit (`approved = false`).
-- Ces valeurs ne sont PAS appliquées : `reelora_consume_quota` refuse tant
-- qu'elles ne sont pas approuvées, avec `quota_policy_missing:<famille>`.
insert into saas_ugc.studio_plan_quotas(plan_key, family, monthly_limit, enabled, approved, source_note)
select p.plan_key, v.family, v.monthly_limit, true, false, 'proposition lot 15 - en attente arbitrage produit'
  from (values
    ('free','audio',2),('free','music',1),('free','voice',2),('free','model_3d',1),('free','lora',1),('free','tool',5),
    ('studio','audio',30),('studio','music',15),('studio','voice',30),('studio','model_3d',10),('studio','lora',10),('studio','tool',100),
    ('pro','audio',120),('pro','music',60),('pro','voice',120),('pro','model_3d',40),('pro','lora',40),('pro','tool',500),
    ('enterprise','audio',1000),('enterprise','music',500),('enterprise','voice',1000),('enterprise','model_3d',300),('enterprise','lora',300),('enterprise','tool',5000)
  ) as v(plan_key, family, monthly_limit)
  join saas_ugc.ugc_plans p on p.plan_key = v.plan_key
on conflict (plan_key, family) do nothing;

-- 6. Droits plan → famille (proposition, non approuvée) -----------------------------
create table if not exists saas_ugc.studio_plan_families (
  plan_key text not null references saas_ugc.ugc_plans(plan_key) on update cascade,
  family text not null references saas_ugc.studio_quota_families(family),
  allowed boolean not null default false,
  approved boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (plan_key, family)
);
insert into saas_ugc.studio_plan_families(plan_key, family, allowed, approved)
select p.plan_key, v.family, v.allowed, false
  from (values
    ('free','script',true),('free','image',true),('free','video',true),('free','audio',true),('free','voice',true),('free','model_3d',true),
    ('free','music',false),('free','lora',false),('free','tool',false),
    ('studio','script',true),('studio','image',true),('studio','video',true),('studio','audio',true),('studio','voice',true),('studio','model_3d',true),
    ('studio','music',false),('studio','lora',false),('studio','tool',false),
    ('pro','script',true),('pro','image',true),('pro','video',true),('pro','audio',true),('pro','voice',true),('pro','model_3d',true),
    ('pro','music',true),('pro','lora',true),('pro','tool',false),
    ('enterprise','script',true),('enterprise','image',true),('enterprise','video',true),('enterprise','audio',true),('enterprise','voice',true),('enterprise','model_3d',true),
    ('enterprise','music',true),('enterprise','lora',true),('enterprise','tool',true)
  ) as v(plan_key, family, allowed)
  join saas_ugc.ugc_plans p on p.plan_key = v.plan_key
on conflict (plan_key, family) do nothing;

-- 7. Consommation générique (remplace les conditions codées en dur) -----------------
-- Même signature que l'ancienne fonction : les appelants historiques sont
-- préservés, mais la limite vient désormais de la table de politique.
create or replace function public.reelora_consume_quota(
  p_kind text, p_reference_id uuid default null, p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
        v_plan saas_ugc.ugc_plans%rowtype;
        v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
        v_limit integer; v_used integer;
begin
  perform ugc_private.reelora_assert_active();
  perform pg_advisory_xact_lock(hashtext('vyora-quota-' || auth.uid()::text));
  if not exists (select 1 from saas_ugc.studio_quota_families f where f.family = p_kind and f.active) then
    raise exception 'invalid_quota_kind';
  end if;
  select p.* into v_plan from saas_ugc.ugc_subscriptions s
    join saas_ugc.ugc_plans p on p.plan_key = s.plan_key
    where s.user_id = v_uid and s.status = 'active';
  if not found then select * into v_plan from saas_ugc.ugc_plans where plan_key = 'free'; end if;
  -- Une politique non approuvée n'est jamais appliquée silencieusement.
  select q.monthly_limit into v_limit from saas_ugc.studio_plan_quotas q
    where q.plan_key = v_plan.plan_key and q.family = p_kind and q.enabled and q.approved;
  if v_limit is null then raise exception 'quota_policy_missing:%', p_kind; end if;
  select coalesce(sum(e.quantity), 0) into v_used from saas_ugc.ugc_usage_events e
    where e.user_id = v_uid and e.period_key = v_period and e.event_kind = p_kind;
  if v_used + 1 > v_limit then
    raise exception 'quota_exceeded:%:%:%', p_kind, v_used, v_limit;
  end if;
  insert into saas_ugc.ugc_usage_events(user_id, event_kind, period_key, reference_id, metadata)
  values (v_uid, p_kind, v_period, p_reference_id, coalesce(p_metadata, '{}'::jsonb));
  return jsonb_build_object('family', p_kind, 'used', v_used + 1, 'limit', v_limit,
    'remaining', v_limit - v_used - 1, 'plan', v_plan.plan_key);
end $$;
revoke all on function public.reelora_consume_quota(text,uuid,jsonb) from public, anon;
grant execute on function public.reelora_consume_quota(text,uuid,jsonb) to authenticated, service_role;

-- 8. Préparation runtime : famille par règles + droits de plan approuvés ------------
create or replace function public.studio_prepare_runtime(p_model_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m saas_ugc.studio_ai_models%rowtype; i saas_ugc.studio_model_integrations%rowtype;
        c saas_ugc.studio_runtime_configs%rowtype;
        v_cost numeric; v_credits integer; v_quota text; v_output text; v_estimate text;
        v_text_ok boolean; v_auth_ok boolean; v_changed boolean := false; v_missing text[] := '{}';
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
  if v_estimate is null or v_estimate <> '/api/v1/models/' || m.provider_model_id || '/estimate-cost' then
    raise exception 'estimate_endpoint_missing';
  end if;
  -- Famille de quota résolue par les règles en base, jamais par une condition
  -- propre à un modèle. Une catégorie inconnue reste un refus explicite.
  v_quota := ugc_private.studio_quota_family(
    m.category, i.protocol, coalesce(m.metadata, '{}'::jsonb) || jsonb_build_object('integration_family', coalesce(i.family,'')));
  if v_quota is null then raise exception 'quota_policy_missing'; end if;
  v_output := case when i.protocol = 'muapi_output_text_v1' then 'text' else 'media' end;
  v_credits := ugc_private.studio_credit_price(v_cost);

  insert into saas_ugc.studio_runtime_configs(model_id) values (p_model_id) on conflict do nothing;
  select * into c from saas_ugc.studio_runtime_configs where model_id = p_model_id for update;
  v_plans_source := c.plans_source;
  if v_plans_source = 'policy' then
    select coalesce(array_agg(pf.plan_key order by pf.plan_key), '{}') into v_plans
      from saas_ugc.studio_plan_families pf
      join saas_ugc.ugc_plans p on p.plan_key = pf.plan_key and p.active
     where pf.family = v_quota and pf.allowed and pf.approved;
  end if;
  -- Un changement matériel (prix, coût maximum, endpoint, sortie, famille) doit
  -- invalider la validation payée. Une simple attribution de plan n'est pas un
  -- changement du contrat fournisseur : elle ne doit pas forcer un nouveau test.
  v_material := c.credits is distinct from v_credits or c.max_cost_usd is distinct from v_cost
     or c.quota_kind is distinct from v_quota or c.output_kind is distinct from v_output
     or c.estimate_path is distinct from v_estimate;
  if v_material or (v_plans_source = 'policy' and c.allowed_plans is distinct from v_plans) then
    update saas_ugc.studio_runtime_configs set credits = v_credits, max_cost_usd = v_cost,
      quota_kind = v_quota, output_kind = v_output, estimate_path = v_estimate,
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
  v_text_ok := c.estimate_path is not null;
  v_auth_ok := m.account_access = 'available';
  v_missing := array_append(v_missing, 'PAID_VALIDATION_PENDING');
  v_missing := array_append(v_missing, 'ADMIN_DISABLED');

  return jsonb_build_object(
    'model_id', p_model_id, 'changed', v_changed, 'credits', c.credits, 'max_cost_usd', c.max_cost_usd,
    'quota_kind', c.quota_kind, 'output_kind', c.output_kind, 'estimate_path', c.estimate_path,
    'revision', c.revision, 'enabled', c.enabled, 'verified', c.verified_at is not null,
    'access_confirmed', v_auth_ok, 'estimate_declared', v_text_ok, 'quota_policy', v_quota_ok,
    'plans', c.allowed_plans, 'plans_source', c.plans_source,
    'remaining', to_jsonb(v_missing));
end $$;
revoke all on function public.studio_prepare_runtime(uuid) from public, anon, authenticated;
grant execute on function public.studio_prepare_runtime(uuid) to service_role;

-- 9. Lecture de préparation : ce qui manque, par modèle -----------------------------
create or replace function public.studio_runtime_readiness()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(x order by x->>'provider_model_id'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'provider_model_id', m.provider_model_id, 'family', i.family, 'protocol', i.protocol,
      'credits', c.credits, 'max_cost_usd', c.max_cost_usd, 'quota_kind', c.quota_kind,
      'quota_policy', exists(select 1 from saas_ugc.studio_plan_quotas q join saas_ugc.ugc_plans p on p.plan_key=q.plan_key and p.active
                             where q.family=c.quota_kind and q.enabled and q.approved and q.monthly_limit is not null),
      'estimate_path', c.estimate_path, 'enabled', coalesce(c.enabled, false),
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

-- 10. Compteurs d'administration cohérents (même définition que le runtime) ---------
create or replace function public.studio_catalog_admin_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; begin
  perform ugc_private.reelora_assert_admin();
  with states as (
    select m.id, m.category, m.public_catalog_present,
      (i.status = 'integration_prepared' and i.spec_hash = ugc_private.studio_spec_hash(m.id)) as prepared,
      coalesce(c.enabled, false) as enabled,
      coalesce(c.credits > 0 and c.max_cost_usd > 0, false) as priced,
      coalesce(c.verified_at is not null and c.verified_hash = ugc_private.studio_spec_hash(m.id), false) as tested,
      coalesce(c.estimate_path is not null and c.output_kind in ('media','text'), false) as adaptable,
      coalesce(c.quota_kind = ugc_private.studio_quota_family(m.category, i.protocol,
        coalesce(m.metadata,'{}'::jsonb) || jsonb_build_object('integration_family', coalesce(i.family,''))), false) as family_ok,
      coalesce(exists(select 1 from saas_ugc.studio_plan_quotas q join saas_ugc.ugc_plans p on p.plan_key=q.plan_key and p.active
                      where q.family = c.quota_kind and q.enabled and q.approved and q.monthly_limit is not null), false) as quota_ready,
      coalesce(cardinality(c.allowed_plans) > 0, false) as plans_ready,
      coalesce((select enabled from saas_ugc.studio_runtime_limits where id), false) as runtime_enabled,
      coalesce(c.plans_source, 'policy') as plans_source
    from saas_ugc.studio_ai_models m
    left join saas_ugc.studio_model_integrations i on i.model_id = m.id
    left join saas_ugc.studio_runtime_configs c on c.model_id = m.id
    where m.provider_key = 'muapi'
  ), evaluated as (
    select *,
      (prepared and priced and adaptable and family_ok) as configurable,
      (prepared and priced and adaptable and family_ok and quota_ready and plans_ready
       and public_catalog_present and tested and runtime_enabled and enabled) as operational
    from states
  )
  select jsonb_build_object(
    'models', count(*), 'present', count(*) filter (where public_catalog_present),
    'removed', count(*) filter (where not public_catalog_present),
    'prepared', count(*) filter (where prepared),
    'configurable', count(*) filter (where configurable),
    'integrated', count(*) filter (where configurable),
    'operational', count(*) filter (where operational),
    'enabled', count(*) filter (where enabled),
    'studio_available', count(*) filter (where operational),
    'problems', count(*) filter (where not operational),
    'pricing_missing', count(*) filter (where not priced),
    'real_tests_missing', count(*) filter (where not tested),
    'estimate_missing', count(*) filter (where not adaptable),
    'quota_policy_pending', count(*) filter (where not quota_ready),
    'plan_policy_pending', count(*) filter (where not plans_ready),
    'quota_families', (select count(*) from saas_ugc.studio_quota_families where active),
    'plans', coalesce((select jsonb_agg(plan_key order by plan_key) from saas_ugc.ugc_plans where active), '[]'::jsonb)
  ) into result from evaluated;
  return result;
end $$;
revoke all on function public.studio_catalog_admin_summary() from public, anon;
grant execute on function public.studio_catalog_admin_summary() to authenticated;

-- 11. Lecture des quotas côté client ------------------------------------------------
create or replace function public.studio_runtime_quotas()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
        v_plan text;
        v_period text := to_char((now() at time zone 'UTC'), 'YYYY-MM');
begin
  perform ugc_private.reelora_assert_active();
  select coalesce((select s.plan_key from saas_ugc.ugc_subscriptions s
                    where s.user_id = uid and s.status = 'active'), 'free') into v_plan;
  return jsonb_build_object('plan', v_plan, 'period', v_period, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'family', f.family, 'display_name', f.display_name, 'generator', f.generator,
      'limit', q.monthly_limit, 'used', coalesce(u.used, 0),
      'remaining', case when q.monthly_limit is null then null else greatest(q.monthly_limit - coalesce(u.used, 0), 0) end,
      'policy', case when q.family is null then 'missing'
                     when not q.approved then 'pending_approval'
                     when not q.enabled then 'disabled'
                     else 'active' end)
      order by f.family)
    from saas_ugc.studio_quota_families f
    left join saas_ugc.studio_plan_quotas q on q.plan_key = v_plan and q.family = f.family
    left join (select event_kind, sum(quantity) as used from saas_ugc.ugc_usage_events
                where user_id = uid and period_key = v_period group by event_kind) u on u.event_kind = f.family
    where f.active), '[]'::jsonb));
end $$;
revoke all on function public.studio_runtime_quotas() from public, anon;
grant execute on function public.studio_runtime_quotas() to authenticated, service_role;

-- 12. Matrice de plans et gestion administrateur ------------------------------------
create or replace function public.studio_runtime_plan_matrix()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'plan_key', p.plan_key, 'display_name', p.display_name,
      'families', coalesce((select jsonb_agg(jsonb_build_object(
          'family', f.family, 'display_name', f.display_name,
          'allowed', coalesce(pf.allowed, false), 'entitlement_approved', coalesce(pf.approved, false),
          'monthly_limit', q.monthly_limit, 'quota_enabled', coalesce(q.enabled, false),
          'quota_approved', coalesce(q.approved, false),
          'source_note', q.source_note)
          order by f.family)
        from saas_ugc.studio_quota_families f
        left join saas_ugc.studio_plan_families pf on pf.plan_key = p.plan_key and pf.family = f.family
        left join saas_ugc.studio_plan_quotas q on q.plan_key = p.plan_key and q.family = f.family
        where f.active), '[]'::jsonb))
      order by p.sort_order, p.plan_key)
    from saas_ugc.ugc_plans p where p.active), '[]'::jsonb);
end $$;
revoke all on function public.studio_runtime_plan_matrix() from public, anon;
grant execute on function public.studio_runtime_plan_matrix() to authenticated, service_role;

create or replace function public.studio_set_plan_family(
  p_plan_key text, p_family text, p_allowed boolean, p_approved boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_plan_key is null or p_family is null or p_allowed is null or p_approved is null then raise exception 'invalid_policy'; end if;
  if not exists (select 1 from saas_ugc.ugc_plans where plan_key = p_plan_key and active) then raise exception 'invalid_plan'; end if;
  if not exists (select 1 from saas_ugc.studio_quota_families where family = p_family and active) then raise exception 'invalid_family'; end if;
  insert into saas_ugc.studio_plan_families(plan_key, family, allowed, approved)
  values (p_plan_key, p_family, p_allowed, p_approved)
  on conflict (plan_key, family) do update set allowed = excluded.allowed, approved = excluded.approved, updated_at = now();
  return true;
end $$;
revoke all on function public.studio_set_plan_family(text,text,boolean,boolean) from public, anon;
grant execute on function public.studio_set_plan_family(text,text,boolean,boolean) to authenticated, service_role;

create or replace function public.studio_set_plan_quota(
  p_plan_key text, p_family text, p_limit integer, p_enabled boolean, p_approved boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  if p_plan_key is null or p_family is null or p_enabled is null or p_approved is null then raise exception 'invalid_policy'; end if;
  if p_limit is not null and (p_limit < 0 or p_limit > 1000000) then raise exception 'invalid_limit'; end if;
  if p_approved and (p_limit is null or p_limit <= 0 or not p_enabled) then raise exception 'approved_quota_incomplete'; end if;
  if not exists (select 1 from saas_ugc.ugc_plans where plan_key = p_plan_key and active) then raise exception 'invalid_plan'; end if;
  if not exists (select 1 from saas_ugc.studio_quota_families where family = p_family and active) then raise exception 'invalid_family'; end if;
  insert into saas_ugc.studio_plan_quotas(plan_key, family, monthly_limit, enabled, approved, source_note)
  values (p_plan_key, p_family, p_limit, p_enabled, p_approved, 'fixé par l''administration Studio')
  on conflict (plan_key, family) do update set monthly_limit = excluded.monthly_limit,
    enabled = excluded.enabled, approved = excluded.approved, source_note = excluded.source_note, updated_at = now();
  return true;
end $$;
revoke all on function public.studio_set_plan_quota(text,text,integer,boolean,boolean) from public, anon;
grant execute on function public.studio_set_plan_quota(text,text,integer,boolean,boolean) to authenticated, service_role;

-- 13. Configuration administrateur : familles disponibles + gestion manuelle des plans
create or replace function public.studio_runtime_admin_config(p_model_id text, p_config jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare mid uuid; c saas_ugc.studio_runtime_configs%rowtype; begin
  perform ugc_private.reelora_assert_admin();
  select id into mid from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id for update;
  if mid is null then raise exception 'model_not_found'; end if;
  if p_config is not null then
    if jsonb_typeof(p_config)<>'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in ('credits','max_cost_usd','quota_kind','allowed_plans','enabled','output_kind')) then raise exception 'invalid_config'; end if;
    insert into saas_ugc.studio_runtime_configs(model_id) values(mid) on conflict do nothing;
    select * into c from saas_ugc.studio_runtime_configs where model_id=mid for update;
    if coalesce((p_config->>'enabled')::boolean,false) and
    (c.verified_hash is distinct from ugc_private.studio_spec_hash(mid) or c.verified_at is null or c.max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric) then raise exception 'verification_required'; end if;
    if jsonb_typeof(p_config->'allowed_plans') is distinct from 'array' then raise exception 'plans_required'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_config->'allowed_plans') k where not exists(select 1 from saas_ugc.ugc_plans p where p.plan_key=k and p.active)) then raise exception 'invalid_plan'; end if;
    update saas_ugc.studio_runtime_configs set credits=(p_config->>'credits')::integer,max_cost_usd=(p_config->>'max_cost_usd')::numeric,
    quota_kind=p_config->>'quota_kind',output_kind=p_config->>'output_kind',allowed_plans=array(select jsonb_array_elements_text(p_config->'allowed_plans')),
    enabled=coalesce((p_config->>'enabled')::boolean,false),plans_source='manual',revision=revision+1,
    verified_hash=case when max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric or output_kind is distinct from p_config->>'output_kind' then null else verified_hash end,
    verified_at=case when max_cost_usd is distinct from (p_config->>'max_cost_usd')::numeric or output_kind is distinct from p_config->>'output_kind' then null else verified_at end,
    updated_at=now() where model_id=mid;
  end if;
  return jsonb_build_object('config',(select to_jsonb(x) from saas_ugc.studio_runtime_configs x where model_id=mid),'spec_hash',ugc_private.studio_spec_hash(mid),
  'limits',(select to_jsonb(l) from saas_ugc.studio_runtime_limits l where id),
  'plans',coalesce((select jsonb_agg(plan_key order by plan_key) from saas_ugc.ugc_plans where active),'[]'::jsonb),
  'families',coalesce((select jsonb_agg(jsonb_build_object('family',family,'display_name',display_name,'generator',generator) order by family)
    from saas_ugc.studio_quota_families where active),'[]'::jsonb));
end $$;
revoke all on function public.studio_runtime_admin_config(text,jsonb) from public, anon;
grant execute on function public.studio_runtime_admin_config(text,jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';
