-- Plafonds fournisseur : global + par fournisseur + alertes de consommation.
--
-- Contexte : la v1 ne connaissait qu'un plafond global (`provider_spend_cap`).
-- La v2 ajoute, sans jamais relâcher le verrou global existant :
--   * un plafond optionnel `provider_caps_usd` par fournisseur (MuAPI, etc.) ;
--   * un seuil d'alerte (`alert_percent`, 0 = alertes désactivées) ;
--   * des alertes persistées et dédupliquées (console admin + notification
--     in-app des administrateurs), sur le canal déjà utilisé par
--     `saas_business.provider_health_alert` pour les alertes de fournisseur.
--
-- Aucun montant n'est inventé ici : la configuration reste `{enabled:false,
-- max_usd:0}` et seul un administrateur peut la modifier.

-- ---------------------------------------------------------------------------
-- 1. Journal d'alertes de budget (dédupliqué par clé).
-- ---------------------------------------------------------------------------
create table if not exists saas_ugc.ugc_provider_spend_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_key text not null unique,
  provider text,
  kind text not null check (kind in ('threshold','cap_exceeded','blocked_attempt','cap_reached')),
  severity text not null check (severity in ('info','warning','critical')),
  title text not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ugc_provider_spend_alerts_recent_idx
  on saas_ugc.ugc_provider_spend_alerts(created_at desc);

alter table saas_ugc.ugc_provider_spend_alerts enable row level security;
revoke all on saas_ugc.ugc_provider_spend_alerts from public, anon, authenticated;
grant select on saas_ugc.ugc_provider_spend_alerts to service_role;

-- ---------------------------------------------------------------------------
-- 2. Configuration : plafond par fournisseur + seuil d'alerte.
--    `provider_caps_usd` vide = pas de plafond spécifique : le plafond global
--    s'applique alors seul. Un fournisseur sans plafond dédié n'est jamais
--    traité comme « illimité » tant que le plafond global est armé.
-- ---------------------------------------------------------------------------
create or replace function public.reelora_admin_set_provider_spend_policy(
  p_max_usd numeric,
  p_enabled boolean,
  p_alert_percent integer default 80,
  p_provider_caps_usd jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_caps jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  if p_max_usd is null or p_max_usd < 0 or p_max_usd > 1000000 then
    raise exception 'invalid_provider_spend_cap';
  end if;
  if p_alert_percent is null or p_alert_percent < 0 or p_alert_percent > 100 then
    raise exception 'invalid_provider_alert_percent';
  end if;
  if p_provider_caps_usd is null or jsonb_typeof(p_provider_caps_usd) <> 'object' then
    raise exception 'invalid_provider_caps';
  end if;

  -- Normalise : clés fournisseur non vides, montants numériques >= 0.
  for v_key, v_value in select key, value from jsonb_each(p_provider_caps_usd) loop
    if v_key = '' or length(v_key) > 40 then raise exception 'invalid_provider_key'; end if;
    if jsonb_typeof(v_value) <> 'number' or (v_value)::text::numeric < 0
       or (v_value)::text::numeric > p_max_usd then
      raise exception 'invalid_provider_cap_amount';
    end if;
    v_caps := v_caps || jsonb_build_object(v_key, (v_value)::text::numeric);
  end loop;

  select setting_value into v_old
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap'
   for update;

  v_new := jsonb_build_object(
    'enabled', coalesce(p_enabled, false) and p_max_usd > 0,
    'max_usd', p_max_usd,
    'alert_percent', p_alert_percent,
    'provider_caps_usd', v_caps
  );

  insert into saas_ugc.ugc_app_settings(setting_key, setting_value, description)
  values ('provider_spend_cap', v_new, 'Plafond interne de dépenses fournisseur pour les générations vidéo')
  on conflict (setting_key) do update
    set setting_value = excluded.setting_value, updated_at = now();

  insert into saas_ugc.ugc_audit_logs(actor_user_id, action, target_type, target_id, details)
  values (
    (select auth.uid()), 'set_provider_spend_policy', 'setting', 'provider_spend_cap',
    jsonb_build_object('previous', coalesce(v_old, '{}'::jsonb), 'new', v_new)
  );
  return v_new;
end $$;

-- Conservée pour compatibilité (console admin existante) : même plafond global,
-- seuil par défaut conservé, plafonds par fournisseur préservés.
create or replace function public.reelora_admin_set_provider_spend_cap(
  p_max_usd numeric,
  p_enabled boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_current jsonb;
begin
  perform ugc_private.reelora_assert_admin();
  select setting_value into v_current
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap';
  perform public.reelora_admin_set_provider_spend_policy(
    p_max_usd,
    p_enabled,
    coalesce((v_current->>'alert_percent')::integer, 80),
    coalesce(v_current->'provider_caps_usd', '{}'::jsonb)
  );
  return true;
end $$;

revoke all on function public.reelora_admin_set_provider_spend_policy(numeric, boolean, integer, jsonb)
  from public, anon;
grant execute on function public.reelora_admin_set_provider_spend_policy(numeric, boolean, integer, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Alertes : émission idempotente + enregistrement.
-- ---------------------------------------------------------------------------
create or replace function ugc_private.reelora_provider_spend_alert(
  p_alert_key text,
  p_provider text,
  p_kind text,
  p_severity text,
  p_title text,
  p_reason text,
  p_metadata jsonb default '{}'::jsonb
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_admin uuid;
begin
  insert into saas_ugc.ugc_provider_spend_alerts
    (alert_key, provider, kind, severity, title, reason, metadata)
  values (
    p_alert_key, p_provider, p_kind, p_severity, p_title, p_reason,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'bamako_time', to_char(now() at time zone 'Africa/Bamako', 'DD/MM/YYYY HH24:MI')
    )
  )
  on conflict (alert_key) do nothing
  returning id into v_id;

  -- Alerte déjà émise : ne pas renotifier (déduplication par clé).
  if v_id is null then return false; end if;

  for v_admin in
    select distinct u.user_id
      from (
        select ur.user_id from saas_ugc.ugc_user_roles ur where ur.role = 'admin'
        union
        select pa.user_id from saas_immobilier.platform_admins pa where pa.status = 'active'
      ) u
  loop
    insert into saas_ugc.ugc_notifications (user_id, title, body, kind, href)
    values (
      v_admin, p_title, p_reason,
      case when p_severity = 'critical' then 'error' when p_severity = 'warning' then 'warning' else 'info' end,
      '/app/admin?tab=settings'
    );
  end loop;

  return true;
end $$;

revoke all on function ugc_private.reelora_provider_spend_alert(text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Réservation : verrou global ET verrou par fournisseur, puis alertes.
--    Signature inchangée (les Edge Functions n'ont pas à changer d'appel).
-- ---------------------------------------------------------------------------
create or replace function public.reelora_reserve_provider_spend(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job saas_ugc.ugc_generation_jobs%rowtype;
  v_quote saas_ugc.ugc_video_quotes%rowtype;
  v_existing saas_ugc.ugc_provider_spend%rowtype;
  v_config jsonb;
  v_enabled boolean := false;
  v_max numeric := 0;
  v_alert_percent integer := 0;
  v_provider_cap numeric := null;
  v_provider text := 'muapi';
  v_committed numeric := 0;
  v_provider_committed numeric := 0;
  v_remaining numeric := 0;
  v_provider_remaining numeric := null;
  v_reason text;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_job
    from saas_ugc.ugc_generation_jobs
   where id = p_job_id
   for update;
  if not found or v_job.pricing_quote_id is null then raise exception 'provider_spend_job_invalid'; end if;
  select * into v_quote from saas_ugc.ugc_video_quotes
   where id = v_job.pricing_quote_id
     and user_id = v_job.created_by
     and service_key = v_job.service_key
     and public_model_id::text = v_job.request_payload->>'model_id';
  if not found or v_quote.provider_cost_usd is null or v_quote.provider_cost_usd <= 0 then
    raise exception 'provider_spend_estimate_missing';
  end if;

  select * into v_existing from saas_ugc.ugc_provider_spend
   where generation_job_id = p_job_id
   for update;
  if found then
    return jsonb_build_object('allowed', false, 'reason', 'provider_spend_already_reserved');
  end if;

  select setting_value into v_config
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap'
   for update;
  v_max := greatest(coalesce((v_config->>'max_usd')::numeric, 0), 0);
  v_enabled := coalesce((v_config->>'enabled')::boolean, false) and v_max > 0;
  v_alert_percent := least(greatest(coalesce((v_config->>'alert_percent')::integer, 0), 0), 100);
  if jsonb_typeof(v_config->'provider_caps_usd') = 'object'
     and (v_config->'provider_caps_usd') ? v_provider then
    v_provider_cap := (v_config->'provider_caps_usd'->>v_provider)::numeric;
  end if;

  select coalesce(sum(case
    when released_at is not null or status = 'blocked' then 0
    when status in ('reserved','submitted','unknown') then reserved_cost_usd
    else coalesce(actual_cost_usd, estimated_cost_usd, 0)
  end), 0)
    into v_committed
    from saas_ugc.ugc_provider_spend;

  select coalesce(sum(case
    when released_at is not null or status = 'blocked' then 0
    when status in ('reserved','submitted','unknown') then reserved_cost_usd
    else coalesce(actual_cost_usd, estimated_cost_usd, 0)
  end), 0)
    into v_provider_committed
    from saas_ugc.ugc_provider_spend
   where provider = v_provider;

  v_remaining := greatest(v_max - v_committed, 0);
  if v_provider_cap is not null then
    v_provider_remaining := greatest(v_provider_cap - v_provider_committed, 0);
  end if;

  if not v_enabled then v_reason := 'provider_spend_disabled';
  elsif v_quote.provider_cost_usd > v_remaining then v_reason := 'provider_spend_cap_exceeded';
  elsif v_provider_remaining is not null and v_quote.provider_cost_usd > v_provider_remaining then
    v_reason := 'provider_spend_provider_cap_exceeded';
  end if;

  if v_reason is not null then
    insert into saas_ugc.ugc_provider_spend(
      generation_job_id, quote_id, provider, model_id, estimated_cost_usd, status, reason_code, completed_at
    ) values (
      p_job_id, v_quote.id, v_provider, v_quote.model_id, v_quote.provider_cost_usd, 'blocked', v_reason, now()
    );
    perform ugc_private.reelora_provider_spend_alert(
      'spend:blocked:' || p_job_id::text,
      v_provider,
      'blocked_attempt',
      case when v_reason = 'provider_spend_disabled' then 'info' else 'warning' end,
      case when v_reason = 'provider_spend_disabled'
        then 'Génération payante refusée : budget fournisseur désarmé'
        else 'Génération payante refusée : plafond fournisseur atteint' end,
      format(
        'Tentative bloquée avant tout appel payant (coût estimé %s USD, engagé %s USD sur %s USD).',
        round(v_quote.provider_cost_usd, 6), round(v_committed, 6), round(v_max, 6)
      ),
      jsonb_build_object(
        'generation_job_id', p_job_id, 'reason', v_reason,
        'estimated_cost_usd', v_quote.provider_cost_usd,
        'committed_usd', v_committed, 'max_usd', v_max,
        'provider_cap_usd', v_provider_cap, 'provider_committed_usd', v_provider_committed
      )
    );
    return jsonb_build_object(
      'allowed', false, 'reason', v_reason, 'max_usd', v_max,
      'committed_usd', v_committed, 'remaining_usd', v_remaining,
      'estimated_cost_usd', v_quote.provider_cost_usd,
      'provider', v_provider, 'provider_cap_usd', v_provider_cap,
      'provider_committed_usd', v_provider_committed, 'provider_remaining_usd', v_provider_remaining
    );
  end if;

  insert into saas_ugc.ugc_provider_spend(
    generation_job_id, quote_id, provider, model_id, estimated_cost_usd, reserved_cost_usd, status
  ) values (
    p_job_id, v_quote.id, v_provider, v_quote.model_id, v_quote.provider_cost_usd, v_quote.provider_cost_usd, 'reserved'
  );

  -- Alertes de seuil (une seule fois par palier et par fournisseur).
  if v_alert_percent > 0 and v_max > 0 then
    if (v_committed + v_quote.provider_cost_usd) >= v_max then
      perform ugc_private.reelora_provider_spend_alert(
        'spend:cap_reached:' || v_provider || ':' || v_max::text,
        v_provider, 'cap_reached', 'critical',
        'Budget fournisseur intégralement engagé',
        format('Les %s USD du plafond global sont désormais engagés. Toute nouvelle génération payante sera refusée.',
               round(v_max, 2)),
        jsonb_build_object('max_usd', v_max, 'committed_usd', v_committed + v_quote.provider_cost_usd)
      );
    elsif (v_committed + v_quote.provider_cost_usd) >= v_max * v_alert_percent / 100.0 then
      perform ugc_private.reelora_provider_spend_alert(
        'spend:threshold:' || v_provider || ':' || v_max::text || ':' || v_alert_percent::text,
        v_provider, 'threshold', 'warning',
        format('Budget fournisseur consommé à %s %%', v_alert_percent),
        format('%s USD engagés sur un plafond de %s USD.',
               round(v_committed + v_quote.provider_cost_usd, 2), round(v_max, 2)),
        jsonb_build_object('max_usd', v_max, 'alert_percent', v_alert_percent,
                           'committed_usd', v_committed + v_quote.provider_cost_usd)
      );
    end if;
  end if;

  return jsonb_build_object(
    'allowed', true, 'max_usd', v_max, 'committed_usd', v_committed,
    'remaining_usd', v_remaining, 'estimated_cost_usd', v_quote.provider_cost_usd,
    'provider', v_provider, 'provider_cap_usd', v_provider_cap,
    'provider_committed_usd', v_provider_committed, 'provider_remaining_usd', v_provider_remaining
  );
end $$;

revoke all on function public.reelora_reserve_provider_spend(uuid) from public, anon, authenticated;
grant execute on function public.reelora_reserve_provider_spend(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Résumé administrateur : ajoute plafonds par fournisseur, seuil, alertes.
--    (Le bloc `by_provider` de la migration précédente est conservé.)
-- ---------------------------------------------------------------------------
create or replace function public.reelora_admin_provider_spend_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_config jsonb;
  v_max numeric := 0;
  v_enabled boolean := false;
  v_alert_percent integer := 0;
  v_actual numeric := 0;
  v_reserved numeric := 0;
  v_estimated_terminal numeric := 0;
  v_committed numeric := 0;
begin
  perform ugc_private.reelora_assert_admin();
  select setting_value into v_config
    from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap';
  v_max := greatest(coalesce((v_config->>'max_usd')::numeric, 0), 0);
  v_enabled := coalesce((v_config->>'enabled')::boolean, false) and v_max > 0;
  v_alert_percent := least(greatest(coalesce((v_config->>'alert_percent')::integer, 0), 0), 100);

  select
    coalesce(sum(actual_cost_usd), 0),
    coalesce(sum(reserved_cost_usd) filter (
      where released_at is null and status in ('reserved','submitted','unknown')
    ), 0),
    coalesce(sum(coalesce(actual_cost_usd, estimated_cost_usd)) filter (
      where released_at is null and status in ('succeeded','failed','cancelled') and actual_cost_usd is null
    ), 0),
    coalesce(sum(case
      when released_at is not null or status = 'blocked' then 0
      when status in ('reserved','submitted','unknown') then reserved_cost_usd
      else coalesce(actual_cost_usd, estimated_cost_usd, 0)
    end), 0)
    into v_actual, v_reserved, v_estimated_terminal, v_committed
    from saas_ugc.ugc_provider_spend;

  return jsonb_build_object(
    'enabled', v_enabled,
    'max_usd', v_max,
    'alert_percent', v_alert_percent,
    'provider_caps_usd', coalesce(v_config->'provider_caps_usd', '{}'::jsonb),
    'alert_state', case
      when not v_enabled then 'disabled'
      when v_max > 0 and v_committed >= v_max then 'cap_reached'
      when v_alert_percent > 0 and v_max > 0 and v_committed >= v_max * v_alert_percent / 100.0 then 'threshold'
      else 'ok' end,
    'actual_spent_usd', v_actual,
    'reserved_usd', v_reserved,
    'estimated_unpriced_usd', v_estimated_terminal,
    'committed_usd', v_committed,
    'remaining_usd', greatest(v_max - v_committed, 0),
    'tests_count', (select count(*) from saas_ugc.ugc_provider_spend where status <> 'blocked'),
    'blocked_count', (select count(*) from saas_ugc.ugc_provider_spend where status = 'blocked'),
    'by_provider', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', s.provider,
        'actual_spent_usd', s.actual_spent_usd,
        'reserved_usd', s.reserved_usd,
        'committed_usd', s.committed_usd,
        'cap_usd', v_config->'provider_caps_usd'->>s.provider,
        'remaining_usd', case
          when v_config->'provider_caps_usd'->>s.provider is null then null
          else greatest((v_config->'provider_caps_usd'->>s.provider)::numeric - s.committed_usd, 0) end
      ) order by s.provider)
      from (
        select
          provider,
          coalesce(sum(actual_cost_usd), 0) as actual_spent_usd,
          coalesce(sum(reserved_cost_usd) filter (
            where released_at is null and status in ('reserved','submitted','unknown')
          ), 0) as reserved_usd,
          coalesce(sum(case
            when released_at is not null or status = 'blocked' then 0
            when status in ('reserved','submitted','unknown') then reserved_cost_usd
            else coalesce(actual_cost_usd, estimated_cost_usd, 0)
          end), 0) as committed_usd
        from saas_ugc.ugc_provider_spend
        group by provider
      ) s
    ), '[]'::jsonb),
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'provider', a.provider, 'kind', a.kind, 'severity', a.severity,
        'title', a.title, 'reason', a.reason, 'created_at', a.created_at,
        'acknowledged_at', a.acknowledged_at
      ) order by a.created_at desc)
      from (select * from saas_ugc.ugc_provider_spend_alerts order by created_at desc limit 25) a
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'generation_job_id', s.generation_job_id,
        'provider', s.provider,
        'model_id', s.model_id,
        'provider_request_id', s.provider_request_id,
        'estimated_cost_usd', s.estimated_cost_usd,
        'actual_cost_usd', s.actual_cost_usd,
        'status', s.status,
        'reason_code', s.reason_code,
        'created_at', s.created_at,
        'completed_at', s.completed_at
      ) order by s.created_at desc)
      from (
        select * from saas_ugc.ugc_provider_spend order by created_at desc limit 100
      ) s
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.reelora_admin_provider_spend_summary() from public, anon;
grant execute on function public.reelora_admin_provider_spend_summary() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Acquittement d'une alerte par l'administrateur.
-- ---------------------------------------------------------------------------
create or replace function public.reelora_admin_ack_provider_spend_alert(p_alert_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform ugc_private.reelora_assert_admin();
  update saas_ugc.ugc_provider_spend_alerts
     set acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_alert_id;
  if not found then raise exception 'provider_spend_alert_not_found'; end if;
  return true;
end $$;

revoke all on function public.reelora_admin_ack_provider_spend_alert(uuid) from public, anon;
grant execute on function public.reelora_admin_ack_provider_spend_alert(uuid) to authenticated;

notify pgrst, 'reload schema';
