-- Incrément 17 — capacité d'exécution : données déclarées, entraînements LoRA
--
-- 1. Le protocole `muapi_output_json_v1` restitue un `result` DÉCLARÉ par la
--    fiche fournisseur (objet/tableau/chaîne) en texte JSON borné. Aucune
--    donnée n'est inventée, aucun champ n'est deviné.
-- 2. Un entraînement LoRA consomme la famille de quota `lora` (règle de
--    données, priorité 82). Les limites restent PROPOSÉES : rien n'est approuvé.
-- 3. `studio_prepare_runtime` classe la sortie du nouveau protocole en
--    `text` (comme le protocole texte existant), sans changer aucune autre
--    décision ni activer quoi que ce soit.
--
-- Aucune donnée, aucun quota, aucun prix existant n'est modifié.

begin;

-- 1. Contrat de sortie : ajout du protocole de donnée déclarée ----------------
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'studio_model_integrations_protocol_check') then
    alter table saas_ugc.studio_model_integrations drop constraint studio_model_integrations_protocol_check;
  end if;
  alter table saas_ugc.studio_model_integrations
    add constraint studio_model_integrations_protocol_check
    check (protocol in ('muapi_output_envelope_v1','muapi_output_urls_v1','muapi_output_media_v1','muapi_output_media_list_v1','muapi_output_text_v1','muapi_output_json_v1'));
end $$;

-- 2. Famille de quota d'un entraînement LoRA (règle de données) ----------------
insert into saas_ugc.studio_family_rules(rule_key, priority, pattern, family) values
  ('training', 82, '(^|[^a-z])training([^a-z]|$)', 'lora')
on conflict (rule_key) do nothing;

-- 3. Préparation runtime : sortie texte pour la donnée déclarée ----------------
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
  v_output := case when i.protocol in ('muapi_output_text_v1','muapi_output_json_v1') then 'text' else 'media' end;
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

commit;
