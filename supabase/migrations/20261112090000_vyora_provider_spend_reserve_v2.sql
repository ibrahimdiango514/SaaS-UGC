-- Réservation de dépense fournisseur v2 : double verrou.
--
-- Verrou 1 : plafond global (`max_usd`), inchangé.
-- Verrou 2 : plafond dédié au fournisseur (`provider_caps_usd`), optionnel.
-- Les deux sont lus sous `for update` sur la ligne de configuration, donc
-- deux réservations concurrentes ne peuvent pas franchir le plafond ensemble.
--
-- Le motif renvoyé au client pour un plafond par fournisseur est aligné sur
-- celui du plafond global (`provider_spend_cap_exceeded`) afin que l'Edge
-- Function déjà déployée affiche le message prévu ; le motif précis
-- (`provider_spend_provider_cap_exceeded`) reste journalisé dans
-- `ugc_provider_spend.reason_code` et renvoyé dans `detail`.
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
  v_detail text;
  v_reason text;
begin
  if coalesce((select auth.jwt()->>'role'), '') <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select * into v_job from saas_ugc.ugc_generation_jobs where id = p_job_id for update;
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
   where generation_job_id = p_job_id for update;
  if found then
    return jsonb_build_object('allowed', false, 'reason', 'provider_spend_already_reserved');
  end if;

  select setting_value into v_config from saas_ugc.ugc_app_settings
   where setting_key = 'provider_spend_cap' for update;
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
    else coalesce(actual_cost_usd, estimated_cost_usd, 0) end), 0)
    into v_committed from saas_ugc.ugc_provider_spend;

  select coalesce(sum(case
    when released_at is not null or status = 'blocked' then 0
    when status in ('reserved','submitted','unknown') then reserved_cost_usd
    else coalesce(actual_cost_usd, estimated_cost_usd, 0) end), 0)
    into v_provider_committed from saas_ugc.ugc_provider_spend where provider = v_provider;

  v_remaining := greatest(v_max - v_committed, 0);
  if v_provider_cap is not null then
    v_provider_remaining := greatest(v_provider_cap - v_provider_committed, 0);
  end if;

  if not v_enabled then
    v_detail := 'provider_spend_disabled'; v_reason := v_detail;
  elsif v_quote.provider_cost_usd > v_remaining then
    v_detail := 'provider_spend_cap_exceeded'; v_reason := v_detail;
  elsif v_provider_remaining is not null and v_quote.provider_cost_usd > v_provider_remaining then
    v_detail := 'provider_spend_provider_cap_exceeded';
    v_reason := 'provider_spend_cap_exceeded';
  end if;

  if v_detail is not null then
    insert into saas_ugc.ugc_provider_spend(
      generation_job_id, quote_id, provider, model_id, estimated_cost_usd, status, reason_code, completed_at
    ) values (p_job_id, v_quote.id, v_provider, v_quote.model_id, v_quote.provider_cost_usd, 'blocked', v_detail, now());
    perform ugc_private.reelora_provider_spend_alert(
      'spend:blocked:' || p_job_id::text, v_provider, 'blocked_attempt',
      case when v_enabled then 'warning' else 'info' end,
      case when not v_enabled then 'Generation payante refusee : budget fournisseur desarme'
           when v_detail = 'provider_spend_provider_cap_exceeded'
             then 'Generation payante refusee : plafond fournisseur atteint'
           else 'Generation payante refusee : plafond global atteint' end,
      format('Tentative bloquee avant tout appel payant (cout estime %s USD, engage %s USD sur %s USD).',
             round(v_quote.provider_cost_usd, 6), round(v_committed, 6), round(v_max, 6)),
      jsonb_build_object('generation_job_id', p_job_id, 'reason', v_detail,
        'estimated_cost_usd', v_quote.provider_cost_usd, 'committed_usd', v_committed, 'max_usd', v_max,
        'provider_cap_usd', v_provider_cap, 'provider_committed_usd', v_provider_committed));
    return jsonb_build_object('allowed', false, 'reason', v_reason, 'detail', v_detail,
      'max_usd', v_max, 'committed_usd', v_committed, 'remaining_usd', v_remaining,
      'estimated_cost_usd', v_quote.provider_cost_usd, 'provider', v_provider,
      'provider_cap_usd', v_provider_cap, 'provider_committed_usd', v_provider_committed,
      'provider_remaining_usd', v_provider_remaining);
  end if;

  insert into saas_ugc.ugc_provider_spend(
    generation_job_id, quote_id, provider, model_id, estimated_cost_usd, reserved_cost_usd, status
  ) values (p_job_id, v_quote.id, v_provider, v_quote.model_id, v_quote.provider_cost_usd, v_quote.provider_cost_usd, 'reserved');

  if v_alert_percent > 0 and v_max > 0 then
    if (v_committed + v_quote.provider_cost_usd) >= v_max then
      perform ugc_private.reelora_provider_spend_alert(
        'spend:cap_reached:' || v_provider || ':' || v_max::text, v_provider, 'cap_reached', 'critical',
        'Budget fournisseur integralement engage',
        format('Les %s USD du plafond global sont desormais engages. Toute nouvelle generation payante sera refusee.',
               round(v_max, 2)),
        jsonb_build_object('max_usd', v_max, 'committed_usd', v_committed + v_quote.provider_cost_usd));
    elsif (v_committed + v_quote.provider_cost_usd) >= v_max * v_alert_percent / 100.0 then
      perform ugc_private.reelora_provider_spend_alert(
        'spend:threshold:' || v_provider || ':' || v_max::text || ':' || v_alert_percent::text,
        v_provider, 'threshold', 'warning',
        format('Budget fournisseur consomme a %s %%', v_alert_percent),
        format('%s USD engages sur un plafond de %s USD.',
               round(v_committed + v_quote.provider_cost_usd, 2), round(v_max, 2)),
        jsonb_build_object('max_usd', v_max, 'alert_percent', v_alert_percent,
                           'committed_usd', v_committed + v_quote.provider_cost_usd));
    end if;
  end if;

  return jsonb_build_object('allowed', true, 'max_usd', v_max, 'committed_usd', v_committed,
    'remaining_usd', v_remaining, 'estimated_cost_usd', v_quote.provider_cost_usd,
    'provider', v_provider, 'provider_cap_usd', v_provider_cap,
    'provider_committed_usd', v_provider_committed, 'provider_remaining_usd', v_provider_remaining);
end $$;

revoke all on function public.reelora_reserve_provider_spend(uuid) from public, anon, authenticated;
grant execute on function public.reelora_reserve_provider_spend(uuid) to service_role;

notify pgrst, 'reload schema';
