-- VYORA — diagnostic des échecs de sonde (message réel du fournisseur).
--
-- Problème constaté : LLM7 et Ollama répondaient `PROVIDER_REQUEST_REJECTED`
-- (= un 4xx autre que 401/403/404/429) sans qu'on puisse savoir POURQUOI. Le
-- corps de la réponse du fournisseur était jeté, et `probe_model` n'était
-- jamais persisté (`vyora_ai_record_probe` insérait `model_key = null` en dur).
--
-- Résultat : impossible de distinguer « modèle refusé » de « paramètre
-- refusé », donc impossible de corriger la configuration autrement qu'en
-- devinant. Cette migration rend le diagnostic possible.
--
-- Sécurité : `error_detail` ne reçoit que le message d'erreur du fournisseur,
-- tronqué à 400 caractères et purgé côté Edge par `redactSecrets()` (jeton
-- `Bearer`, préfixes connus). Aucune clé n'est écrite ici : le fournisseur ne
-- la renvoie pas, et le nettoyage est appliqué par précaution.

alter table saas_business.ai_provider_health_checks
  add column if not exists probe_model text,
  add column if not exists http_status integer,
  add column if not exists error_detail text;

-- Modèle de sonde DÉCLARÉ par l'opérateur. Sert aux alias documentés que le
-- fournisseur n'énumère pas dans `/models` (cas réel : `default` chez LLM7,
-- seul accès restant quand le solde est vide). Une déclaration explicite n'est
-- pas une inférence : sans elle, la sonde choisit dans le catalogue et n'invente
-- jamais d'identifiant.
alter table saas_business.ai_providers
  add column if not exists probe_model text;

comment on column saas_business.ai_providers.probe_model is
  'Modèle de sonde déclaré par l''opérateur (alias documenté absent du catalogue). NULL = choix automatique depuis le catalogue.';

comment on column saas_business.ai_provider_health_checks.probe_model is
  'Modèle réellement testé en complétion (identifiant fournisseur), jamais deviné.';
comment on column saas_business.ai_provider_health_checks.http_status is
  'Statut HTTP de la complétion de contrôle (null si non tentée).';
comment on column saas_business.ai_provider_health_checks.error_detail is
  'Message d''erreur du fournisseur, tronqué et purgé de tout secret côté Edge.';

-- Le modèle de sonde devient une information de premier rang : on le conserve.
create or replace function public.vyora_ai_record_probe(p_payload jsonb)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_provider text := lower(btrim(coalesce(p_payload->>'provider_key', '')));
  v_catalog_ok boolean := coalesce((p_payload->>'catalog_ok')::boolean, false);
  v_completion_ok boolean := (p_payload->>'completion_ok')::boolean; -- NULL = non testé
  v_error text := nullif(p_payload->>'error_code', '');
  v_latency integer := coalesce((p_payload->>'latency_ms')::integer, 0);
  v_model text := nullif(p_payload->>'probe_model', '');
  v_http integer := (p_payload->>'http_status')::integer;
  v_detail text := left(nullif(btrim(coalesce(p_payload->>'error_detail', '')), ''), 400);
  v_status text;
  v_check_id uuid;
begin
  if v_provider = '' then raise exception 'provider_key requis'; end if;

  v_status := case
    when v_completion_ok is true then 'available'
    when v_catalog_ok then 'degraded'
    else 'unavailable'
  end;

  update saas_business.ai_providers
     set status = v_status,
         enabled = (v_completion_ok is true),
         checked_at = now(),
         error_code = v_error,
         updated_at = clock_timestamp()
   where provider_key = v_provider;

  if not found then raise exception 'fournisseur inconnu: %', v_provider; end if;

  -- `model_key` porte une clé étrangère vers `ai_models` : y écrire un alias
  -- documenté (`default` chez LLM7) violait la contrainte et faisait échouer
  -- TOUT l'enregistrement — le registre restait figé sur un verdict périmé.
  -- Le modèle testé est donc porté par `probe_model`, colonne libre et dédiée ;
  -- `model_key` ne reçoit que le modèle interne correspondant, s'il existe.
  insert into saas_business.ai_provider_health_checks
    (provider_key, model_key, status, latency_ms, error_code, checked_at,
     probe_model, http_status, error_detail)
  values (v_provider,
          (select m.model_key from saas_business.ai_models m
            where m.provider_key = v_provider and m.provider_model_key = v_model
            limit 1),
          case when v_status = 'available' then 'healthy' else 'failed' end,
          v_latency, v_error, now(), v_model, v_http, v_detail)
  returning id into v_check_id;

  -- Inchangé : le modèle RÉELLEMENT testé entre au registre, vérifié. Un
  -- fournisseur ne peut être `available` sans cette preuve.
  if v_status = 'available' and v_model is not null then
    insert into saas_business.ai_models(
      provider_key, model_key, provider_model_key, display_name, capabilities,
      enabled, verification_status, verified_at, max_input_tokens, max_output_tokens,
      tier, cost_input_per_mtok_usd, cost_output_per_mtok_usd, cost_source, cost_note
    )
    select c.provider_key, c.model_key, c.provider_model_key, c.display_name, c.capabilities,
           true, 'verified', now(), c.context_in, c.max_out,
           c.tier, c.cost_input_per_mtok_usd, c.cost_output_per_mtok_usd,
           case when c.cost_input_per_mtok_usd is null then null else 'announced' end, c.note
      from saas_business.ai_catalog_models c
     where c.provider_key = v_provider and c.provider_model_key = v_model
    on conflict (provider_key, provider_model_key) do update set
      display_name = excluded.display_name,
      capabilities = excluded.capabilities,
      enabled = true,
      verification_status = 'verified',
      verified_at = now(),
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      tier = excluded.tier,
      cost_input_per_mtok_usd = excluded.cost_input_per_mtok_usd,
      cost_output_per_mtok_usd = excluded.cost_output_per_mtok_usd,
      cost_source = excluded.cost_source,
      cost_note = excluded.cost_note;
  elsif v_status = 'available' and v_model is not null then
    -- Modèle déclaré par l'opérateur et absent du catalogue (alias documenté,
    -- cas `default` chez LLM7). Il a répondu à une vraie complétion : il entre
    -- au registre comme vérifié. Ses prix restent inconnus (`null`), jamais
    -- estimés, et sa capacité `writing` est la seule prouvée par l'appel.
    insert into saas_business.ai_models(
      provider_key, model_key, provider_model_key, display_name, capabilities,
      enabled, verification_status, verified_at, cost_source, cost_note
    )
    values (
      v_provider, left(v_model, 80), v_model, v_model, '{"writing": true}'::jsonb,
      true, 'verified', now(), null, 'Vérifié par complétion réelle ; prix non publié.'
    )
    on conflict (provider_key, provider_model_key) do update set
      enabled = true,
      verification_status = 'verified',
      verified_at = now();
  end if;

  -- `provider_health_cron_runs` est la table du cron historique : sa contrainte
  -- n'accepte que ('groq','gemini'). Y écrire les fournisseurs de la phase
  -- d'intégration violait la contrainte et annulait TOUT l'enregistrement —
  -- y compris la mise à jour du statut. Leur historique vit dans
  -- `ai_provider_health_checks`, qui porte désormais le modèle testé, le statut
  -- HTTP et le message d'erreur.

  return jsonb_build_object(
    'provider_key', v_provider,
    'status', v_status,
    'enabled', (v_completion_ok is true),
    'health_check_id', v_check_id,
    'probe_model', v_model
  );
end $$;

revoke all on function public.vyora_ai_record_probe(jsonb) from public, anon, authenticated;
grant execute on function public.vyora_ai_record_probe(jsonb) to service_role;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- Descripteur de sonde : expose le modèle déclaré (jamais un secret)
-- -----------------------------------------------------------------------------

create or replace function public.vyora_ai_provider_descriptors()
returns jsonb
language sql security definer stable
set search_path = pg_catalog, saas_business
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'key', p.provider_key,
      'name', p.display_name,
      'status', p.status,
      'enabled', p.enabled,
      'aggregator', p.is_aggregator,
      'adapter_kind', p.adapter_kind,
      'transport', p.transport,
      'base_url', p.default_base_url,
      'models_url', p.models_url,
      'api_key_env', p.api_key_env,
      'account_id_env', p.account_id_env,
      'gateway_id_env', p.gateway_id_env,
      'headers', p.default_headers,
      'integration_phase', p.integration_phase,
      'probe_model', p.probe_model
    ) order by p.provider_key
  ), '[]'::jsonb)
  from saas_business.ai_providers p
  where p.integration_phase is not null;
$$;

revoke all on function public.vyora_ai_provider_descriptors() from public, anon, authenticated;
grant execute on function public.vyora_ai_provider_descriptors() to service_role;

notify pgrst, 'reload schema';
