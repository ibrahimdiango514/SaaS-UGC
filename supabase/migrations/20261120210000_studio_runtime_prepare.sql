-- -----------------------------------------------------------------------------
-- VYORA Studio — préparation des configurations runtime depuis les preuves
--
-- Objectif : transformer un modèle *préparé* (contrat d'entrée/sortie et
-- endpoint prouvés) en configuration runtime **complète et persistée**, sans
-- jamais activer un modèle ni inventer un prix.
--
-- Deux données officielles étaient jetées jusqu'ici, ce qui rendait toute
-- configuration impossible :
--   * le **prix déclaré** par le fournisseur (`cost` en USD) ;
--   * l'**endpoint d'estimation** (`estimate_endpoint`) sans lequel aucun devis
--     ne peut être émis (le runtime refuse un prix non estimé).
-- Elles sont désormais conservées dans `studio_ai_models.provider_pricing`,
-- telles que déclarées, avec leur origine. Aucun coût n'est déduit d'un nom.
--
-- La conversion USD → crédits utilise uniquement la grille serveur existante
-- (`ugc_app_settings.studio_pricing_config`) et refuse de calculer si elle
-- manque. Rien n'est activé : `enabled` reste faux et `verified_*` reste nul
-- tant qu'un test fournisseur réel n'a pas eu lieu.
-- -----------------------------------------------------------------------------

-- 1. Preuve tarifaire déclarée -------------------------------------------------------
alter table saas_ugc.studio_ai_models
  add column if not exists provider_pricing jsonb;

create or replace function ugc_private.studio_provider_pricing_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and p ? 'cost_usd'
    and jsonb_typeof(p->'cost_usd') = 'number'
    and (p->>'cost_usd')::numeric > 0
    and (p->>'cost_usd')::numeric <= 1000
    and p->>'currency' = 'USD'
    and (not p ? 'estimate_path' or p->>'estimate_path' is null
         or p->>'estimate_path' ~ '^/api/v1/models/[A-Za-z0-9._~-]{1,160}/estimate-cost$')
    and (select count(*) from jsonb_object_keys(p)) <= 8
  );
$$;
revoke all on function ugc_private.studio_provider_pricing_valid(jsonb) from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'studio_ai_models_provider_pricing_shape') then
    alter table saas_ugc.studio_ai_models
      add constraint studio_ai_models_provider_pricing_shape
      check (ugc_private.studio_provider_pricing_valid(provider_pricing));
  end if;
end $$;

-- 2. Ingestion : la fiche conserve le prix et l'endpoint d'estimation déclarés --------
-- L'ancienne signature est retirée : garder les deux créerait une surcharge
-- ambiguë pour les workers encore en v5 (5 arguments positionnels).
drop function if exists public.studio_save_muapi_detail(text, text, integer, jsonb, jsonb);

create or replace function public.studio_save_muapi_detail(
  p_model_id text, p_status text, p_http_status integer, p_input_schema jsonb, p_output_schema jsonb,
  p_provider_pricing jsonb default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_status is null or p_status not in ('ok','http_error','invalid','network_error') then raise exception 'invalid_status'; end if;
  if p_status='ok' and (jsonb_typeof(p_input_schema) is distinct from 'object'
    or (p_output_schema is not null and jsonb_typeof(p_output_schema) is distinct from 'object')) then raise exception 'invalid_schema'; end if;
  if not ugc_private.studio_provider_pricing_valid(p_provider_pricing) then raise exception 'invalid_provider_pricing'; end if;
  select id into v_id from saas_ugc.studio_ai_models where provider_key='muapi' and provider_model_id=p_model_id and public_catalog_present for update;
  if v_id is null then return false; end if;
  if p_status='ok' then
    update saas_ugc.studio_ai_models set input_schema=p_input_schema - 'vyora_endpoint_evidence',
      endpoint_evidence=p_input_schema->'vyora_endpoint_evidence',
      -- Une fiche qui ne déclare plus de prix efface l'ancien : jamais de prix périmé.
      provider_pricing=p_provider_pricing,
      output_schema=coalesce(p_output_schema,output_schema), updated_at=now() where id=v_id;
  end if;
  insert into saas_ugc.studio_ai_model_details(model_id,status,http_status,checked_at)
    values(v_id,p_status,p_http_status,now())
    on conflict(model_id) do update set status=excluded.status,http_status=excluded.http_status,checked_at=excluded.checked_at;
  return true;
end $$;
revoke all on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.studio_save_muapi_detail(text,text,integer,jsonb,jsonb,jsonb) to service_role;

-- 3. Conversion USD → crédits, uniquement depuis la grille serveur -------------------
create or replace function ugc_private.studio_credit_price(p_cost_usd numeric)
returns integer language plpgsql security definer set search_path = '' as $$
declare cfg jsonb; usd_xof numeric; credit_xof numeric; margin numeric; processing numeric;
        retail_xof numeric; credits integer;
begin
  if p_cost_usd is null or p_cost_usd <= 0 or p_cost_usd > 1000 then raise exception 'cost_out_of_range'; end if;
  select setting_value into cfg from saas_ugc.ugc_app_settings where setting_key = 'studio_pricing_config';
  if cfg is null then raise exception 'studio_pricing_not_configured'; end if;
  usd_xof := (cfg->>'usd_to_xof')::numeric;
  credit_xof := (cfg->>'credit_value_xof')::numeric;
  margin := coalesce((cfg->>'target_margin_percent')::numeric, 0);
  processing := coalesce((cfg->>'processing_cost_usd')::numeric, 0);
  if usd_xof is null or credit_xof is null or usd_xof <= 0 or credit_xof <= 0 or margin < 0 or margin > 1000 or processing < 0 then
    raise exception 'studio_pricing_not_configured';
  end if;
  -- Prix de revient + coût de traitement, marge cible appliquée au seul coût
  -- fournisseur, puis conversion en crédits au prix de référence de la grille.
  retail_xof := p_cost_usd * usd_xof * (1 + margin / 100) + processing * usd_xof;
  credits := ceil(retail_xof / credit_xof)::integer;
  if credits < 1 or credits > 1000000 then raise exception 'credit_price_out_of_range'; end if;
  return credits;
end $$;
revoke all on function ugc_private.studio_credit_price(numeric) from public, anon, authenticated;

-- 4. Préparation d'une configuration runtime ----------------------------------------
-- Persiste ce qui est prouvé. N'active rien, ne vérifie rien, n'invente rien.
create or replace function public.studio_prepare_runtime(p_model_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m saas_ugc.studio_ai_models%rowtype; i saas_ugc.studio_model_integrations%rowtype;
        c saas_ugc.studio_runtime_configs%rowtype;
        v_cost numeric; v_credits integer; v_quota text; v_output text; v_estimate text;
        v_text_ok boolean; v_auth_ok boolean; v_changed boolean := false; v_missing text[] := '{}';
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
  -- Sans endpoint d'estimation, aucun devis ne peut être émis : ce n'est pas une
  -- configuration incomplète, c'est un modèle non exécutable en l'état.
  if v_estimate is null or v_estimate <> '/api/v1/models/' || m.provider_model_id || '/estimate-cost' then
    raise exception 'estimate_endpoint_missing';
  end if;
  v_quota := case when lower(m.category) like '%video%' then 'video'
                  when lower(m.category) like '%image%' then 'image'
                  when lower(m.category) = 'text to text' then 'script' end;
  if v_quota is null then raise exception 'quota_policy_missing'; end if;
  v_output := case when i.protocol = 'muapi_output_text_v1' then 'text' else 'media' end;
  v_credits := ugc_private.studio_credit_price(v_cost);

  insert into saas_ugc.studio_runtime_configs(model_id) values (p_model_id) on conflict do nothing;
  select * into c from saas_ugc.studio_runtime_configs where model_id = p_model_id for update;
  if c.credits is distinct from v_credits or c.max_cost_usd is distinct from v_cost
     or c.quota_kind is distinct from v_quota or c.output_kind is distinct from v_output
     or c.estimate_path is distinct from v_estimate then
    -- Toute modification matérielle invalide une validation payée antérieure.
    -- On ne peut donc pas changer un prix ou un endpoint sans repasser le test.
    update saas_ugc.studio_runtime_configs set credits = v_credits, max_cost_usd = v_cost,
      quota_kind = v_quota, output_kind = v_output, estimate_path = v_estimate,
      enabled = false, verified_hash = null, verified_at = null, verification_reference = null,
      revision = revision + 1, updated_at = now()
    where model_id = p_model_id;
    v_changed := true;
  end if;
  select * into c from saas_ugc.studio_runtime_configs where model_id = p_model_id;

  -- Portes externes : rapportées, jamais franchies ici.
  if m.account_access is distinct from 'available' then v_missing := array_append(v_missing, 'ACCESS_UNCONFIRMED'); end if;
  if coalesce(array_length(c.allowed_plans, 1), 0) = 0 then v_missing := array_append(v_missing, 'PLAN_UNAVAILABLE'); end if;
  v_text_ok := c.estimate_path is not null;
  v_auth_ok := m.account_access = 'available';
  v_missing := array_append(v_missing, 'PAID_VALIDATION_PENDING');
  v_missing := array_append(v_missing, 'ADMIN_DISABLED');

  return jsonb_build_object(
    'model_id', p_model_id, 'changed', v_changed, 'credits', c.credits, 'max_cost_usd', c.max_cost_usd,
    'quota_kind', c.quota_kind, 'output_kind', c.output_kind, 'estimate_path', c.estimate_path,
    'revision', c.revision, 'enabled', c.enabled, 'verified', c.verified_at is not null,
    'access_confirmed', v_auth_ok, 'estimate_declared', v_text_ok,
    'remaining', to_jsonb(v_missing));
end $$;
revoke all on function public.studio_prepare_runtime(uuid) from public, anon, authenticated;
grant execute on function public.studio_prepare_runtime(uuid) to service_role;

-- 5. Préparation en lot, avec le motif exact de chaque refus -------------------------
create or replace function public.studio_prepare_runtime_batch(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_changed integer := 0; v_same integer := 0; v_step text; v_reasons jsonb := '{}'::jsonb;
        v_scanned integer := 0;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'forbidden'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then raise exception 'invalid_limit'; end if;
  for r in
    select m.id from saas_ugc.studio_ai_models m
      join saas_ugc.studio_model_integrations i on i.model_id = m.id
     where i.status = 'integration_prepared'
     order by m.provider_model_id
     limit p_limit
  loop
    v_scanned := v_scanned + 1;
    begin
      perform public.studio_prepare_runtime(r.id);
      if (select enabled from saas_ugc.studio_runtime_configs where model_id = r.id) then
        raise exception 'unexpected_enabled';
      end if;
      v_changed := v_changed + 1;
    exception when others then
      get stacked diagnostics v_step = message_text;
      v_reasons := jsonb_set(v_reasons, array[v_step], to_jsonb(coalesce((v_reasons->>v_step)::integer, 0) + 1));
    end;
  end loop;
  select count(*) into v_same from saas_ugc.studio_runtime_configs c
    join saas_ugc.studio_model_integrations i on i.model_id = c.model_id
   where i.status = 'integration_prepared' and c.credits is not null and c.max_cost_usd is not null
     and c.estimate_path is not null and c.enabled = false;
  return jsonb_build_object('scanned', v_scanned, 'configured', v_changed,
    'complete_unverified', v_same, 'refused', v_scanned - v_changed, 'reasons', v_reasons);
end $$;
revoke all on function public.studio_prepare_runtime_batch(integer) from public, anon, authenticated;
grant execute on function public.studio_prepare_runtime_batch(integer) to service_role;

-- 6. Lecture d'administration : ce qui manque, par modèle ----------------------------
create or replace function public.studio_runtime_readiness()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(x order by x->>'provider_model_id'), '[]'::jsonb) into v_rows from (
    select jsonb_build_object(
      'provider_model_id', m.provider_model_id, 'family', i.family, 'protocol', i.protocol,
      'credits', c.credits, 'max_cost_usd', c.max_cost_usd, 'quota_kind', c.quota_kind,
      'estimate_path', c.estimate_path, 'enabled', coalesce(c.enabled, false),
      'verified', c.verified_at is not null, 'access', m.account_access,
      'plans', coalesce(c.allowed_plans, '{}'),
      -- Isolation explicite : un utilitaire du fournisseur (publication sociale,
      -- bac à sable, modération) n'est pas un générateur du Studio, même quand
      -- son contrat technique est compris.
      'scope', case when coalesce(m.metadata->>'group_of','') in ('utility','moderation') then 'tool' else 'generator' end) x
    from saas_ugc.studio_ai_models m
      join saas_ugc.studio_model_integrations i on i.model_id = m.id
      left join saas_ugc.studio_runtime_configs c on c.model_id = m.id
     where i.status = 'integration_prepared') s;
  return v_rows;
end $$;
revoke all on function public.studio_runtime_readiness() from public, anon, authenticated;
grant execute on function public.studio_runtime_readiness() to service_role;
