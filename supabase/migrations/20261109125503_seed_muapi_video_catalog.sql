-- Reelora V2 — non-destructive MuAPI video catalogue seed.
-- Applied to the shared Supabase project through the management API on
-- 2026-11-09 (version 20261109125503). This file is the reproducible source
-- of that change: it refreshes the EXISTING catalogue table only. It does not
-- create a table, RLS policy, RPC or secret, and it never deletes a row.
--
-- Source of truth: GET https://api.muapi.ai/api/v1/models (public pricing
-- catalogue, no API key required). The catalogue is fetched server-side from
-- Postgres with pg_net; MUAPI_API_KEY stays in the Edge Function secret store.

ALTER TABLE saas_ugc.ugc_video_models DROP CONSTRAINT IF EXISTS ugc_video_models_category_check;
ALTER TABLE saas_ugc.ugc_video_models ADD CONSTRAINT ugc_video_models_category_check
  CHECK (category = ANY (ARRAY[
    'Text to Video'::text, 'Image to Video'::text, 'Video to Video'::text,
    'Audio to Video'::text, 'Lora Support'::text, 'Training'::text,
    'Text to Text'::text, 'other'::text
  ]));

DO $do$
DECLARE
  request_id bigint;
  collected net.http_response_result;
  payload jsonb;
BEGIN
  request_id := net.http_get(
    'https://api.muapi.ai/api/v1/models',
    '{}'::jsonb,
    '{}'::jsonb,
    30000
  );
  collected := net.http_collect_response(request_id, false);
  IF (collected.response).status_code IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'MuAPI public catalogue unavailable: HTTP %, %',
      (collected.response).status_code, collected.message;
  END IF;
  payload := (collected.response).body::jsonb;

  WITH source AS (
    SELECT m FROM jsonb_array_elements(payload -> 'models') m
  ), video AS (
    SELECT m, row_number() OVER (
      ORDER BY coalesce(m->>'category', ''), coalesce(m->>'name', '')
    ) AS ord
    FROM source
    WHERE lower(coalesce(m->>'category', '')) LIKE '%video%'
       OR lower(coalesce(m->>'group_of', '')) IN ('video', 'avatar', 'video-edit', 'video-tools', 'lipsync')
       OR (lower(coalesce(m->>'group_of', '')) = 'ai-effects'
           AND lower(coalesce(m->>'category', '')) LIKE '%video%')
  ), rows AS (
    SELECT
      m->>'name' AS model_id,
      initcap(replace(coalesce(m->>'name', ''), '-', ' ')) AS display_name,
      coalesce(m->>'description', '') AS description,
      coalesce(m->>'category', 'Text to Video') AS category,
      CASE
        WHEN coalesce(m->>'endpoint', '') LIKE '/api/v1/%' THEN m->>'endpoint'
        WHEN coalesce(m->>'endpoint_url', '') LIKE '/api/v1/%' THEN m->>'endpoint_url'
        WHEN coalesce(m->>'endpoint_url', '') <> '' THEN '/api/v1/' || ltrim(m->>'endpoint_url', '/')
        ELSE '/api/v1/' || (m->>'name')
      END AS endpoint,
      CASE WHEN jsonb_typeof(m->'input_fields') = 'array' THEN m->'input_fields' ELSE '[]'::jsonb END AS input_fields,
      CASE WHEN jsonb_typeof(m->'required_fields') = 'array' THEN m->'required_fields' ELSE '[]'::jsonb END AS required_fields,
      (
        SELECT coalesce(jsonb_object_agg(f.field_name, jsonb_build_object('type', 'string')), '{}'::jsonb)
        FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(m->'input_fields') = 'array' THEN m->'input_fields' ELSE '[]'::jsonb END
        ) AS f(field_name)
      ) || jsonb_build_object('__catalog', jsonb_build_object(
        'family', m->>'family',
        'group_of', m->>'group_of',
        'domain', m->>'domain',
        'cost_strategy', m->>'cost_strategy',
        'dynamic_pricing', coalesce((m->>'dynamic_pricing')::boolean, false),
        'endpoint_url', m->>'endpoint_url',
        'estimate_endpoint', m->>'estimate_endpoint',
        'source', 'muapi_public',
        'detected_at', now()::text
      )) AS param_schema,
      nullif(m->>'cost', '')::numeric AS cost_usd,
      coalesce(nullif(m->>'cost_currency', ''), 'USD') AS cost_currency,
      CASE
        WHEN coalesce(nullif(m->>'is_enabled', ''), '1') IN ('1', 'true', 'True', 'TRUE') THEN true
        ELSE false
      END AS is_enabled,
      CASE
        WHEN coalesce(m->>'is_coming_soon', 'false') IN ('1', 'true', 'True', 'TRUE') THEN true
        ELSE false
      END AS is_coming_soon,
      ord::int AS sort_order
    FROM video
  )
  INSERT INTO saas_ugc.ugc_video_models AS t (
    model_id, display_name, description, category, endpoint,
    input_fields, required_fields, param_schema, cost_usd, cost_currency,
    is_enabled, is_coming_soon, active, sort_order, synced_at, updated_at
  )
  SELECT
    model_id, display_name, description, category, endpoint,
    input_fields, required_fields, param_schema, cost_usd, cost_currency,
    is_enabled, is_coming_soon, true, sort_order, now(), now()
  FROM rows
  WHERE coalesce(model_id, '') <> ''
  ON CONFLICT (model_id) DO UPDATE SET
    description = excluded.description,
    category = excluded.category,
    endpoint = excluded.endpoint,
    input_fields = excluded.input_fields,
    required_fields = excluded.required_fields,
    param_schema = CASE
      WHEN t.param_schema IS NOT NULL
       AND jsonb_typeof(t.param_schema) = 'object'
       AND (t.param_schema - '__catalog') <> '{}'::jsonb
        THEN (t.param_schema - '__catalog')
             || jsonb_build_object('__catalog', excluded.param_schema -> '__catalog')
      ELSE excluded.param_schema
    END,
    cost_usd = excluded.cost_usd,
    cost_currency = excluded.cost_currency,
    is_enabled = excluded.is_enabled,
    is_coming_soon = excluded.is_coming_soon,
    active = true,
    sort_order = excluded.sort_order,
    synced_at = now(),
    updated_at = now();
END
$do$;
