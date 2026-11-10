-- =============================================================================
-- Reelora Business Grow — Correctifs routage, synchronisation catalogue & modèles vérifiés
-- Protège le statut global fournisseur lors d'un test modèle ponctuel en échec
-- et aligne les règles des 7 rôles métier sur les modèles compatibles réels.
-- =============================================================================

-- 1) Protéger l'état global fournisseur dans bg_sync_verified_model
CREATE OR REPLACE FUNCTION saas_business.bg_sync_verified_model(
  p_provider_key text, p_provider_model_key text, p_status text,
  p_latency_ms integer, p_error_code text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_model_key text;
  v_check_id uuid;
  v_role text;
  v_next_priority smallint;
  v_has_other_healthy boolean := false;
  v_is_global_failure boolean := COALESCE(p_error_code, '') IN ('PROVIDER_AUTH_FAILED', 'PROVIDER_NOT_CONFIGURED');
BEGIN
  SELECT model_key INTO v_model_key
  FROM saas_business.ai_models
  WHERE provider_key = p_provider_key AND provider_model_key = p_provider_model_key;

  IF NOT FOUND THEN
    v_model_key := regexp_replace(lower(p_provider_model_key), '[^a-z0-9._-]+', '-', 'g');
    INSERT INTO saas_business.ai_models(
      provider_key, model_key, provider_model_key, display_name, capabilities, enabled, verification_status
    ) VALUES (
      p_provider_key, v_model_key, p_provider_model_key, p_provider_model_key,
      '{"writing":true,"reasoning":true,"scripts":true,"hooks":true,"documents":true}'::jsonb,
      (p_status = 'healthy'), 'unverified'
    )
    ON CONFLICT (provider_key, model_key) DO NOTHING;
  ELSE
    UPDATE saas_business.ai_models
    SET enabled = (p_status = 'healthy'),
        capabilities = capabilities || '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb
    WHERE provider_key = p_provider_key AND model_key = v_model_key;
  END IF;

  v_check_id := saas_business.bg_record_health_check(p_provider_key, v_model_key, p_status, p_latency_ms, p_error_code);

  IF p_status = 'healthy' THEN
    PERFORM saas_business.bg_record_health_check(p_provider_key, NULL, 'healthy', p_latency_ms, NULL);

    FOR v_role IN SELECT role_key FROM saas_business.ai_roles WHERE enabled LOOP
      IF NOT EXISTS (
        SELECT 1 FROM saas_business.ai_routing_rules r
        WHERE r.role_key = v_role AND r.provider_key = p_provider_key AND r.model_key = v_model_key
      ) THEN
        SELECT COALESCE(max(r2.priority) + 1, 1)::smallint
          INTO v_next_priority
        FROM saas_business.ai_routing_rules r2
        WHERE r2.role_key = v_role;

        INSERT INTO saas_business.ai_routing_rules(role_key, provider_key, model_key, priority, enabled)
        VALUES (v_role, p_provider_key, v_model_key, v_next_priority, true)
        ON CONFLICT (role_key, priority) DO NOTHING;
      END IF;
    END LOOP;
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM saas_business.ai_models m
      JOIN saas_business.ai_provider_health_checks h
        ON h.provider_key = m.provider_key AND h.model_key = m.model_key
      WHERE m.provider_key = p_provider_key
        AND m.model_key <> v_model_key
        AND m.enabled
        AND m.verification_status = 'verified'
        AND h.status = 'healthy'
        AND h.checked_at >= now() - interval '24 hours'
    ) INTO v_has_other_healthy;

    IF v_is_global_failure OR NOT v_has_other_healthy THEN
      PERFORM saas_business.bg_record_health_check(p_provider_key, NULL, p_status, p_latency_ms, p_error_code);
    END IF;
  END IF;

  RETURN v_check_id;
END $$;

-- 2) Normalisation du catalogue modèles compatibles Groq & Gemini
INSERT INTO saas_business.ai_models(
  provider_key, model_key, provider_model_key, display_name, capabilities,
  enabled, verification_status, max_input_tokens, max_output_tokens
)
VALUES
  ('groq', 'openai-gpt-oss-120b', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)',
   '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb, false, 'unverified', 131072, 8192),
  ('groq', 'qwen-qwen3.8-27b', 'qwen/qwen3.8-27b', 'Qwen 3.8 27B (Groq)',
   '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb, false, 'unverified', 131072, 8192),
  ('groq', 'openai-gpt-oss-20b', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)',
   '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb, false, 'unverified', 131072, 8192),
  ('gemini', 'gemini-2.5-flash', 'gemini-2.5-flash', 'Gemini 2.5 Flash',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  ('gemini', 'gemini-3.5-flash', 'gemini-3.5-flash', 'Gemini 3.5 Flash',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  ('gemini', 'gemini-3-flash-preview', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  ('gemini', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192)
ON CONFLICT (provider_key, model_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  capabilities = EXCLUDED.capabilities,
  max_input_tokens = EXCLUDED.max_input_tokens,
  max_output_tokens = EXCLUDED.max_output_tokens;

-- Marquer les anciens modèles seedés incompatibles sur ce compte comme désactivés
UPDATE saas_business.ai_models
SET enabled = false,
    verification_status = 'unavailable'
WHERE (provider_key = 'groq' AND model_key IN ('llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-3-32b'))
   OR (provider_key = 'gemini' AND model_key IN ('gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-pro-latest'));

-- 3) Réalignement propre des règles de routage sur les 7 rôles métier
DELETE FROM saas_business.ai_routing_rules
WHERE role_key IN (
  'business_advisor', 'business_analysis', 'action_plan',
  'marketing_campaign', 'sales_analysis', 'content_strategy', 'tool_planning'
);

INSERT INTO saas_business.ai_routing_rules(role_key, provider_key, model_key, priority, enabled)
VALUES
  -- Conseil business général
  ('business_advisor', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('business_advisor', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('business_advisor', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('business_advisor', 'gemini', 'gemini-2.5-flash', 10, true),
  ('business_advisor', 'gemini', 'gemini-3.5-flash', 11, true),
  ('business_advisor', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('business_advisor', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Analyse d'entreprise (raisonnement avancé)
  ('business_analysis', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('business_analysis', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('business_analysis', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('business_analysis', 'gemini', 'gemini-3.5-flash', 10, true),
  ('business_analysis', 'gemini', 'gemini-2.5-flash', 11, true),
  ('business_analysis', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('business_analysis', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Plan d'action 30/60/90 jours
  ('action_plan', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('action_plan', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('action_plan', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('action_plan', 'gemini', 'gemini-2.5-flash', 10, true),
  ('action_plan', 'gemini', 'gemini-3.5-flash', 11, true),
  ('action_plan', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('action_plan', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Campagne marketing
  ('marketing_campaign', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('marketing_campaign', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('marketing_campaign', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('marketing_campaign', 'gemini', 'gemini-2.5-flash', 10, true),
  ('marketing_campaign', 'gemini', 'gemini-3.5-flash', 11, true),
  ('marketing_campaign', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('marketing_campaign', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Croissance des ventes
  ('sales_analysis', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('sales_analysis', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('sales_analysis', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('sales_analysis', 'gemini', 'gemini-3.5-flash', 10, true),
  ('sales_analysis', 'gemini', 'gemini-2.5-flash', 11, true),
  ('sales_analysis', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('sales_analysis', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Stratégie & idées de contenu
  ('content_strategy', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('content_strategy', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('content_strategy', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('content_strategy', 'gemini', 'gemini-2.5-flash', 10, true),
  ('content_strategy', 'gemini', 'gemini-3.5-flash', 11, true),
  ('content_strategy', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('content_strategy', 'gemini', 'gemini-2.5-flash-lite', 13, true),

  -- Planification d'actions assistées
  ('tool_planning', 'groq', 'openai-gpt-oss-120b', 1, true),
  ('tool_planning', 'groq', 'qwen-qwen3.8-27b', 2, true),
  ('tool_planning', 'groq', 'openai-gpt-oss-20b', 3, true),
  ('tool_planning', 'gemini', 'gemini-2.5-flash', 10, true),
  ('tool_planning', 'gemini', 'gemini-3.5-flash', 11, true),
  ('tool_planning', 'gemini', 'gemini-3-flash-preview', 12, true),
  ('tool_planning', 'gemini', 'gemini-2.5-flash-lite', 13, true);

REVOKE EXECUTE ON FUNCTION saas_business.bg_sync_verified_model(text, text, text, integer, text)
  FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
GRANT EXECUTE ON FUNCTION saas_business.bg_sync_verified_model(text, text, text, integer, text) TO bg_edge;
