-- =============================================================================
-- Reelora Business Grow — Extensions IA Central, Outils, Routage & Quotas BG
-- NOTE : Migration additive préparée localement, NON appliquée en production.
-- Aucune modification ni lecture des crédits Studio UGC (ugc_wallets, etc.).
-- =============================================================================

-- 1) Extension catalogue fournisseurs (adaptateurs extensibles prêts)
INSERT INTO saas_business.ai_providers(provider_key, display_name, enabled, status)
VALUES
  ('openai', 'OpenAI', false, 'unverified'),
  ('anthropic', 'Anthropic Claude', false, 'unverified'),
  ('deepseek', 'DeepSeek', false, 'unverified'),
  ('mistral', 'Mistral AI', false, 'unverified')
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO saas_business.ai_provider_configs(provider_key, config_status)
SELECT provider_key, 'missing'
FROM saas_business.ai_providers
WHERE provider_key IN ('openai', 'anthropic', 'deepseek', 'mistral')
ON CONFLICT (provider_key) DO NOTHING;

-- 2) Modèles catalogue (tous non vérifiés par défaut jusqu'à preuve API réelle)
INSERT INTO saas_business.ai_models(
  provider_key, model_key, provider_model_key, display_name, capabilities,
  enabled, verification_status, max_input_tokens, max_output_tokens
)
VALUES
  -- Groq
  ('groq', 'llama-3.3-70b-versatile', 'llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile',
   '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb, false, 'unverified', 131072, 8192),
  ('groq', 'llama-3.1-8b-instant', 'llama-3.1-8b-instant', 'Llama 3.1 8B Instant',
   '{"writing":true,"scripts":true,"hooks":true}'::jsonb, false, 'unverified', 131072, 8192),
  ('groq', 'qwen-3-32b', 'qwen/qwen3-32b', 'Qwen 3 32B',
   '{"writing":true,"reasoning":true,"scripts":true}'::jsonb, false, 'unverified', 131072, 8192),
  -- Google Gemini
  ('gemini', 'gemini-2.5-flash', 'gemini-2.5-flash', 'Gemini 2.5 Flash',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  ('gemini', 'gemini-2.5-pro', 'gemini-2.5-pro', 'Gemini 2.5 Pro',
   '{"writing":true,"reasoning":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  ('gemini', 'gemini-2.0-flash', 'gemini-2.0-flash', 'Gemini 2.0 Flash',
   '{"writing":true,"documents":true,"images":true}'::jsonb, false, 'unverified', 1048576, 8192),
  -- Adaptateurs extensibles préparés (inactifs sans clé et vérification)
  ('openai', 'gpt-4.1-mini', 'gpt-4.1-mini', 'GPT-4.1 Mini',
   '{"writing":true,"reasoning":true}'::jsonb, false, 'unverified', 1047576, 16384),
  ('anthropic', 'claude-sonnet-4', 'claude-sonnet-4-20250514', 'Claude Sonnet 4',
   '{"writing":true,"reasoning":true}'::jsonb, false, 'unverified', 200000, 8192),
  ('deepseek', 'deepseek-chat', 'deepseek-chat', 'DeepSeek Chat',
   '{"writing":true,"reasoning":true}'::jsonb, false, 'unverified', 64000, 8192),
  ('mistral', 'mistral-large-latest', 'mistral-large-latest', 'Mistral Large',
   '{"writing":true,"reasoning":true}'::jsonb, false, 'unverified', 131072, 8192)
ON CONFLICT (provider_key, model_key) DO NOTHING;

-- 3) Rôles métier Business Grow étendus
INSERT INTO saas_business.ai_roles(role_key, description, required_capabilities, enabled)
VALUES
  ('action_plan', 'Plan d’action opérationnel 30/60/90 jours', '{"reasoning":true,"writing":true}'::jsonb, true),
  ('marketing_campaign', 'Conception de campagne marketing & acquisition', '{"writing":true}'::jsonb, true),
  ('sales_analysis', 'Diagnostic ventes, conversion, pricing & rétention', '{"reasoning":true}'::jsonb, true),
  ('tool_planning', 'Planification et proposition d’actions Business Grow', '{"reasoning":true}'::jsonb, true)
ON CONFLICT (role_key) DO NOTHING;

-- Règles de routage multi-fournisseurs (actives seulement si fournisseur + modèle vérifiés sains)
INSERT INTO saas_business.ai_routing_rules(role_key, provider_key, model_key, priority, enabled)
VALUES
  ('business_advisor', 'groq', 'llama-3.3-70b-versatile', 1, true),
  ('business_advisor', 'gemini', 'gemini-2.5-flash', 2, true),
  ('business_analysis', 'gemini', 'gemini-2.5-pro', 1, true),
  ('business_analysis', 'groq', 'llama-3.3-70b-versatile', 2, true),
  ('content_strategy', 'groq', 'llama-3.3-70b-versatile', 1, true),
  ('content_strategy', 'gemini', 'gemini-2.5-flash', 2, true),
  ('action_plan', 'gemini', 'gemini-2.5-pro', 1, true),
  ('action_plan', 'groq', 'llama-3.3-70b-versatile', 2, true),
  ('marketing_campaign', 'groq', 'llama-3.3-70b-versatile', 1, true),
  ('marketing_campaign', 'gemini', 'gemini-2.5-flash', 2, true),
  ('sales_analysis', 'gemini', 'gemini-2.5-pro', 1, true),
  ('sales_analysis', 'groq', 'qwen-3-32b', 2, true),
  ('tool_planning', 'gemini', 'gemini-2.5-flash', 1, true),
  ('tool_planning', 'groq', 'llama-3.3-70b-versatile', 2, true)
ON CONFLICT (role_key, priority) DO NOTHING;

-- 4) Portefeuille et grand livre Business Grow (totalement séparés du Studio UGC)
CREATE TABLE IF NOT EXISTS saas_business.wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  available_units integer NOT NULL DEFAULT 50 CHECK (available_units >= 0),
  reserved_units integer NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  monthly_allowance integer NOT NULL DEFAULT 50 CHECK (monthly_allowance >= 0),
  period_key text NOT NULL DEFAULT to_char(now(), 'YYYY-MM'),
  period_used integer NOT NULL DEFAULT 0 CHECK (period_used >= 0),
  lifetime_consumed integer NOT NULL DEFAULT 0 CHECK (lifetime_consumed >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS saas_business.credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id uuid REFERENCES saas_business.ai_requests(id) ON DELETE SET NULL,
  delta integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  kind text NOT NULL CHECK (kind IN ('monthly_grant','reserve','capture','release','adjustment')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bg_ledger_user_created_idx
  ON saas_business.credit_ledger(user_id, created_at DESC);

-- 5) Préférences utilisateur Auto vs Manuel par tâche
CREATE TABLE IF NOT EXISTS saas_business.user_routing_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_key text NOT NULL REFERENCES saas_business.ai_roles(role_key) ON DELETE CASCADE,
  selection_mode text NOT NULL DEFAULT 'auto' CHECK (selection_mode IN ('auto','manual')),
  preferred_provider_key text REFERENCES saas_business.ai_providers(provider_key) ON DELETE SET NULL,
  preferred_model_key text,
  allow_fallback boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_key),
  FOREIGN KEY (preferred_provider_key, preferred_model_key)
    REFERENCES saas_business.ai_models(provider_key, model_key) ON DELETE SET NULL
);

-- 6) Architecture d'outils IA Business Grow avec approbation utilisateur
CREATE TABLE IF NOT EXISTS saas_business.tool_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  request_id uuid,
  tool_name text NOT NULL,
  risk_level text NOT NULL DEFAULT 'write_requires_approval'
    CHECK (risk_level IN ('read_only','write_requires_approval','external_publish_requires_approval')),
  status text NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','rejected','executed','failed')),
  input_args jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES saas_business.conversations(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (request_id, user_id, conversation_id)
    REFERENCES saas_business.ai_requests(id, user_id, conversation_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS tool_executions_conv_idx
  ON saas_business.tool_executions(user_id, conversation_id, created_at DESC);

ALTER TABLE saas_business.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.user_routing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.tool_executions ENABLE ROW LEVEL SECURITY;

ALTER TABLE saas_business.wallets FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.credit_ledger FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.user_routing_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE saas_business.tool_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY owner_wallets ON saas_business.wallets TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_ledger ON saas_business.credit_ledger TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_routing_prefs ON saas_business.user_routing_preferences TO bg_owner USING (true) WITH CHECK (true);
CREATE POLICY owner_tool_execs ON saas_business.tool_executions TO bg_owner USING (true) WITH CHECK (true);

CREATE TRIGGER wallets_touch BEFORE UPDATE ON saas_business.wallets
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
CREATE TRIGGER routing_prefs_touch BEFORE UPDATE ON saas_business.user_routing_preferences
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();

-- 7) Fonctions quota Business Grow (isolation stricte Studio UGC)
CREATE OR REPLACE FUNCTION saas_business.bg_ensure_wallet(p_user_id uuid)
RETURNS saas_business.wallets
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_period text := to_char(now(), 'YYYY-MM');
  v_wallet saas_business.wallets%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  INSERT INTO saas_business.wallets(user_id, period_key)
  VALUES (p_user_id, v_period)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_wallet FROM saas_business.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_wallet.period_key <> v_period THEN
    UPDATE saas_business.wallets
    SET period_key = v_period,
        available_units = GREATEST(available_units, monthly_allowance),
        period_used = 0
    WHERE user_id = p_user_id
    RETURNING * INTO v_wallet;

    INSERT INTO saas_business.credit_ledger(user_id, delta, balance_after, kind, reason)
    VALUES (p_user_id, v_wallet.monthly_allowance, v_wallet.available_units, 'monthly_grant', 'Renouvellement mensuel Business Grow');
  END IF;
  RETURN v_wallet;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_quota_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_w saas_business.wallets%ROWTYPE;
BEGIN
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  RETURN jsonb_build_object(
    'domain', 'business_grow',
    'studio_ugc_untouched', true,
    'available_units', v_w.available_units,
    'reserved_units', v_w.reserved_units,
    'monthly_allowance', v_w.monthly_allowance,
    'period_key', v_w.period_key,
    'period_used', v_w.period_used,
    'lifetime_consumed', v_w.lifetime_consumed
  );
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_reserve_units(
  p_user_id uuid, p_request_id uuid, p_amount integer, p_reason text DEFAULT 'ai_request'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_w saas_business.wallets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'invalid reserve amount'; END IF;
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  IF v_w.available_units < p_amount THEN
    RAISE EXCEPTION 'BG_INSUFFICIENT_QUOTA';
  END IF;
  UPDATE saas_business.wallets
  SET available_units = available_units - p_amount,
      reserved_units = reserved_units + p_amount
  WHERE user_id = p_user_id
  RETURNING * INTO v_w;

  INSERT INTO saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  VALUES (p_user_id, p_request_id, -p_amount, v_w.available_units, 'reserve', COALESCE(NULLIF(p_reason, ''), 'ai_request'));

  RETURN jsonb_build_object('available_units', v_w.available_units, 'reserved_units', v_w.reserved_units);
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_capture_units(
  p_user_id uuid, p_request_id uuid, p_reserved integer, p_actual integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_w saas_business.wallets%ROWTYPE;
  v_refund integer := GREATEST(0, COALESCE(p_reserved, 0) - GREATEST(1, COALESCE(p_actual, 1)));
  v_charged integer := GREATEST(1, LEAST(COALESCE(p_reserved, 1), COALESCE(p_actual, 1)));
BEGIN
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  UPDATE saas_business.wallets
  SET reserved_units = GREATEST(0, reserved_units - COALESCE(p_reserved, 0)),
      available_units = available_units + v_refund,
      period_used = period_used + v_charged,
      lifetime_consumed = lifetime_consumed + v_charged
  WHERE user_id = p_user_id
  RETURNING * INTO v_w;

  INSERT INTO saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  VALUES (p_user_id, p_request_id, 0, v_w.available_units, 'capture', 'Exécution IA Business Grow');

  RETURN jsonb_build_object(
    'domain', 'business_grow',
    'studio_ugc_untouched', true,
    'available_units', v_w.available_units,
    'reserved_units', v_w.reserved_units,
    'charged_units', v_charged
  );
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_release_units(
  p_user_id uuid, p_request_id uuid, p_amount integer, p_reason text DEFAULT 'ai_refund'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_w saas_business.wallets%ROWTYPE;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN saas_business.bg_quota_status(p_user_id); END IF;
  v_w := saas_business.bg_ensure_wallet(p_user_id);
  UPDATE saas_business.wallets
  SET available_units = available_units + LEAST(p_amount, reserved_units),
      reserved_units = GREATEST(0, reserved_units - p_amount)
  WHERE user_id = p_user_id
  RETURNING * INTO v_w;

  INSERT INTO saas_business.credit_ledger(user_id, request_id, delta, balance_after, kind, reason)
  VALUES (p_user_id, p_request_id, p_amount, v_w.available_units, 'release', COALESCE(NULLIF(p_reason, ''), 'ai_refund'));

  RETURN jsonb_build_object('available_units', v_w.available_units, 'reserved_units', v_w.reserved_units);
END $$;

-- 8) Mise à jour compatible de bg_select_route & bg_complete_attempt + outils/sync
DROP FUNCTION IF EXISTS saas_business.bg_select_route(uuid, uuid, uuid, integer, uuid, text, text[], text[]);
CREATE FUNCTION saas_business.bg_select_route(
  p_request_id uuid, p_user_id uuid, p_conversation_id uuid, p_attempt_number integer,
  p_fallback_from uuid, p_fallback_reason text,
  p_preferred_provider_keys text[] DEFAULT ARRAY[]::text[],
  p_excluded_provider_keys text[] DEFAULT ARRAY[]::text[],
  p_preferred_model_key text DEFAULT NULL
) RETURNS TABLE(attempt_id uuid, provider_key text, model_key text, provider_model_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_role text; v_provider text; v_model text; v_provider_model text;
BEGIN
  SELECT role_key INTO v_role FROM saas_business.ai_requests
   WHERE id = p_request_id AND user_id = p_user_id AND conversation_id = p_conversation_id
     AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'running request not found'; END IF;

  SELECT rr.provider_key, rr.model_key, m.provider_model_key
    INTO v_provider, v_model, v_provider_model
  FROM saas_business.ai_routing_rules rr
  JOIN saas_business.ai_roles ar ON ar.role_key = rr.role_key AND ar.enabled
  JOIN saas_business.ai_providers p ON p.provider_key = rr.provider_key
     AND p.enabled AND p.status = 'available'
  JOIN saas_business.ai_provider_configs pc ON pc.provider_key = p.provider_key
     AND pc.config_status = 'configured'
  JOIN saas_business.ai_models m ON m.provider_key = rr.provider_key
     AND m.model_key = rr.model_key AND m.enabled
     AND m.verification_status = 'verified'
  WHERE rr.role_key = v_role AND rr.enabled
    AND (cardinality(p_preferred_provider_keys) = 0
      OR rr.provider_key = ANY(p_preferred_provider_keys))
    AND NOT (rr.provider_key = ANY(COALESCE(p_excluded_provider_keys, ARRAY[]::text[])))
    AND (p_preferred_model_key IS NULL OR m.provider_model_key = p_preferred_model_key OR m.model_key = p_preferred_model_key)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(ar.required_capabilities) req
      WHERE m.capabilities->req.key IS DISTINCT FROM req.value
    )
    AND EXISTS (SELECT 1 FROM saas_business.ai_provider_health_checks h
      WHERE h.provider_key = p.provider_key AND h.model_key IS NULL
        AND h.status = 'healthy' AND h.checked_at >= now() - interval '24 hours')
    AND EXISTS (SELECT 1 FROM saas_business.ai_provider_health_checks h
      WHERE h.provider_key = m.provider_key AND h.model_key = m.model_key
        AND h.status = 'healthy' AND h.checked_at >= now() - interval '24 hours')
  ORDER BY
    CASE WHEN cardinality(p_preferred_provider_keys) > 0
      THEN array_position(p_preferred_provider_keys, rr.provider_key) END NULLS LAST,
    rr.priority
  LIMIT 1;

  IF v_provider IS NULL THEN RETURN; END IF;
  attempt_id := saas_business.bg_add_attempt(p_request_id, p_user_id, p_conversation_id,
    p_attempt_number, v_provider, v_model, p_fallback_from, p_fallback_reason);
  provider_key := v_provider; model_key := v_model;
  provider_model_key := v_provider_model; RETURN NEXT;
END $$;

DROP FUNCTION IF EXISTS saas_business.bg_complete_attempt(uuid, uuid, uuid, text, integer, integer, integer);
CREATE FUNCTION saas_business.bg_complete_attempt(
  p_attempt_id uuid, p_request_id uuid, p_user_id uuid, p_output_content text,
  p_input_tokens integer, p_output_tokens integer, p_latency_ms integer,
  p_cost_micros bigint DEFAULT NULL, p_currency char(3) DEFAULT 'USD'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_conversation_id uuid; v_message_id uuid;
BEGIN
  IF p_output_content IS NULL OR btrim(p_output_content) = ''
     OR (p_input_tokens IS NOT NULL AND p_input_tokens < 0)
     OR (p_output_tokens IS NOT NULL AND p_output_tokens < 0)
     OR (p_latency_ms IS NOT NULL AND p_latency_ms < 0) THEN
    RAISE EXCEPTION 'invalid provider result';
  END IF;
  SELECT conversation_id INTO v_conversation_id
  FROM saas_business.ai_request_attempts
  WHERE id = p_attempt_id AND request_id = p_request_id AND user_id = p_user_id
    AND status = 'running'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt is not running'; END IF;

  v_message_id := saas_business.bg_append_message(
    p_user_id, v_conversation_id, 'assistant', p_output_content
  );
  PERFORM saas_business.bg_finalize_attempt(
    p_attempt_id, p_request_id, p_user_id, 'succeeded', p_input_tokens, p_output_tokens,
    p_cost_micros, p_latency_ms, NULL, NULL, p_currency, 'succeeded', v_message_id
  );
  RETURN v_message_id;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_sync_provider_config(
  p_provider_key text, p_config_status text, p_config_version text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF p_config_status NOT IN ('missing','configured','error') THEN
    RAISE EXCEPTION 'invalid config status';
  END IF;
  UPDATE saas_business.ai_provider_configs
  SET config_status = p_config_status,
      config_version = COALESCE(p_config_version, config_version),
      verified_at = CASE WHEN p_config_status = 'configured' THEN COALESCE(verified_at, clock_timestamp()) ELSE NULL END
  WHERE provider_key = p_provider_key;

  UPDATE saas_business.ai_providers
  SET enabled = (p_config_status = 'configured'),
      status = CASE WHEN p_config_status = 'missing' THEN 'unverified' ELSE status END
  WHERE provider_key = p_provider_key;
END $$;

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
      '{"writing":true,"reasoning":true,"scripts":true,"hooks":true}'::jsonb,
      (p_status = 'healthy'), 'unverified'
    )
    ON CONFLICT (provider_key, model_key) DO NOTHING;
  ELSE
    UPDATE saas_business.ai_models SET enabled = (p_status = 'healthy')
    WHERE provider_key = p_provider_key AND model_key = v_model_key;
  END IF;

  PERFORM saas_business.bg_record_health_check(p_provider_key, NULL, p_status, p_latency_ms, p_error_code);
  v_check_id := saas_business.bg_record_health_check(p_provider_key, v_model_key, p_status, p_latency_ms, p_error_code);

  IF p_status = 'healthy' THEN
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
  END IF;

  RETURN v_check_id;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_models(p_provider_key text DEFAULT NULL)
RETURNS TABLE(
  provider_key text, model_key text, provider_model_key text, display_name text,
  capabilities jsonb, enabled boolean, verification_status text,
  max_input_tokens integer, max_output_tokens integer, verified_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT m.provider_key, m.model_key, m.provider_model_key, m.display_name,
         m.capabilities, m.enabled, m.verification_status,
         m.max_input_tokens, m.max_output_tokens, m.verified_at
  FROM saas_business.ai_models m
  WHERE (p_provider_key IS NULL OR m.provider_key = p_provider_key)
  ORDER BY m.provider_key, m.display_name;
$$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_roles()
RETURNS TABLE(role_key text, description text, required_capabilities jsonb, enabled boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT role_key, description, required_capabilities, enabled
  FROM saas_business.ai_roles
  WHERE enabled = true
  ORDER BY role_key;
$$;

CREATE OR REPLACE FUNCTION saas_business.bg_get_routing_preferences(p_user_id uuid)
RETURNS TABLE(
  id uuid, role_key text, selection_mode text, preferred_provider_key text,
  preferred_model_key text, allow_fallback boolean, updated_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT id, role_key, selection_mode, preferred_provider_key,
         preferred_model_key, allow_fallback, updated_at
  FROM saas_business.user_routing_preferences
  WHERE user_id = p_user_id
  ORDER BY role_key;
$$;

CREATE OR REPLACE FUNCTION saas_business.bg_upsert_routing_preference(
  p_user_id uuid, p_role_key text, p_selection_mode text,
  p_preferred_provider_key text DEFAULT NULL, p_preferred_model_key text DEFAULT NULL,
  p_allow_fallback boolean DEFAULT true
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_id uuid;
  v_provider text := NULLIF(btrim(p_preferred_provider_key), '');
  v_model_input text := NULLIF(btrim(p_preferred_model_key), '');
  v_resolved_model text := NULL;
BEGIN
  IF v_provider IS NOT NULL AND v_model_input IS NOT NULL THEN
    SELECT model_key INTO v_resolved_model
    FROM saas_business.ai_models
    WHERE provider_key = v_provider
      AND (model_key = v_model_input OR provider_model_key = v_model_input)
    LIMIT 1;
    IF v_resolved_model IS NULL THEN
      RAISE EXCEPTION 'preferred model not found for provider';
    END IF;
  END IF;

  INSERT INTO saas_business.user_routing_preferences(
    user_id, role_key, selection_mode, preferred_provider_key, preferred_model_key, allow_fallback
  ) VALUES (
    p_user_id, COALESCE(NULLIF(p_role_key, ''), 'business_advisor'),
    COALESCE(NULLIF(p_selection_mode, ''), 'auto'),
    v_provider, v_resolved_model,
    COALESCE(p_allow_fallback, true)
  )
  ON CONFLICT (user_id, role_key) DO UPDATE SET
    selection_mode = EXCLUDED.selection_mode,
    preferred_provider_key = EXCLUDED.preferred_provider_key,
    preferred_model_key = EXCLUDED.preferred_model_key,
    allow_fallback = EXCLUDED.allow_fallback
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_create_tool_execution(
  p_user_id uuid, p_conversation_id uuid, p_request_id uuid,
  p_tool_name text, p_risk_level text, p_input_args jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO saas_business.tool_executions(
    user_id, conversation_id, request_id, tool_name, risk_level, status, input_args
  ) VALUES (
    p_user_id, p_conversation_id, p_request_id, p_tool_name,
    COALESCE(NULLIF(p_risk_level, ''), 'write_requires_approval'),
    'pending_approval', COALESCE(p_input_args, '{}'::jsonb)
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_tool_executions(
  p_user_id uuid, p_conversation_id uuid DEFAULT NULL, p_limit integer DEFAULT 30
) RETURNS TABLE(
  id uuid, conversation_id uuid, request_id uuid, tool_name text,
  risk_level text, status text, input_args jsonb, output_result jsonb,
  error_message text, approved_at timestamptz, executed_at timestamptz, created_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT id, conversation_id, request_id, tool_name, risk_level, status,
         input_args, output_result, error_message, approved_at, executed_at, created_at
  FROM saas_business.tool_executions
  WHERE user_id = p_user_id
    AND (p_conversation_id IS NULL OR conversation_id = p_conversation_id)
  ORDER BY created_at DESC
  LIMIT greatest(1, least(COALESCE(p_limit, 30), 100));
$$;

CREATE OR REPLACE FUNCTION saas_business.bg_resolve_tool_execution(
  p_user_id uuid, p_execution_id uuid, p_decision text, p_output_result jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_row saas_business.tool_executions%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('approved','rejected','executed','failed') THEN
    RAISE EXCEPTION 'invalid tool decision';
  END IF;
  UPDATE saas_business.tool_executions
  SET status = p_decision,
      approved_at = CASE WHEN p_decision IN ('approved','executed') THEN COALESCE(approved_at, clock_timestamp()) ELSE approved_at END,
      executed_at = CASE WHEN p_decision = 'executed' THEN clock_timestamp() ELSE executed_at END,
      output_result = COALESCE(p_output_result, output_result)
  WHERE id = p_execution_id AND user_id = p_user_id AND status IN ('pending_approval','approved')
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool execution not found or already resolved'; END IF;
  RETURN jsonb_build_object(
    'id', v_row.id, 'tool_name', v_row.tool_name, 'status', v_row.status,
    'input_args', v_row.input_args, 'output_result', v_row.output_result
  );
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_recent_requests(p_user_id uuid, p_limit integer DEFAULT 20)
RETURNS TABLE(
  id uuid, conversation_id uuid, role_key text, provider_key text, model_key text,
  status text, input_tokens integer, output_tokens integer, provider_cost_micros bigint,
  latency_ms integer, error_code text, created_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT id, conversation_id, role_key, provider_key, model_key, status,
         input_tokens, output_tokens, provider_cost_micros, latency_ms, error_code, created_at
  FROM saas_business.ai_requests
  WHERE user_id = p_user_id
  ORDER BY created_at DESC
  LIMIT greatest(1, least(COALESCE(p_limit, 20), 100));
$$;

-- Lecture autorisée des métadonnées entreprise (marques & produits uniquement, zéro lecture crédits Studio)
CREATE OR REPLACE FUNCTION saas_business.bg_get_workspace_context(p_user_id uuid, p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business, saas_ugc AS $$
DECLARE
  v_ws jsonb;
  v_brands jsonb;
  v_products jsonb;
BEGIN
  IF p_user_id IS NULL OR p_workspace_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM saas_ugc.ugc_workspaces w
    WHERE w.id = p_workspace_id AND (
      w.owner_user_id = p_user_id OR EXISTS (
        SELECT 1 FROM saas_ugc.ugc_workspace_members m
        WHERE m.workspace_id = w.id AND m.user_id = p_user_id
      )
    )
  ) THEN RETURN NULL; END IF;

  SELECT jsonb_build_object('id', id, 'name', name, 'country_code', country_code, 'default_language', default_language)
  INTO v_ws FROM saas_ugc.ugc_workspaces WHERE id = p_workspace_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', name, 'industry', industry, 'description', description, 'voice_guidelines', voice_guidelines
  ) ORDER BY updated_at DESC), '[]'::jsonb)
  INTO v_brands FROM (SELECT * FROM saas_ugc.ugc_brands WHERE workspace_id = p_workspace_id LIMIT 5) b;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', name, 'description', description, 'key_benefits', key_benefits
  ) ORDER BY updated_at DESC), '[]'::jsonb)
  INTO v_products FROM (SELECT * FROM saas_ugc.ugc_products WHERE workspace_id = p_workspace_id LIMIT 8) p;

  RETURN jsonb_build_object('workspace', v_ws, 'brands', v_brands, 'products', v_products);
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_integration_connections(p_user_id uuid)
RETURNS TABLE(
  id uuid, workspace_id uuid, connector_key text, external_account_ref text,
  status text, updated_at timestamptz
) LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
  SELECT id, workspace_id, connector_key, external_account_ref, status, updated_at
  FROM saas_business.integration_connections
  WHERE user_id = p_user_id
  ORDER BY connector_key;
$$;

REVOKE ALL ON saas_business.wallets, saas_business.credit_ledger, saas_business.user_routing_preferences, saas_business.tool_executions
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA saas_business
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

REVOKE EXECUTE ON FUNCTION saas_business.bg_ensure_wallet(uuid) FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_quota_status(uuid) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_reserve_units(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_capture_units(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_release_units(uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_select_route(uuid, uuid, uuid, integer, uuid, text, text[], text[], text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_complete_attempt(uuid, uuid, uuid, text, integer, integer, integer, bigint, char) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_sync_provider_config(text, text, text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_sync_verified_model(text, text, text, integer, text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_models(text) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_roles() FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_get_routing_preferences(uuid) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_upsert_routing_preference(uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_create_tool_execution(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_tool_executions(uuid, uuid, integer) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_resolve_tool_execution(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_recent_requests(uuid, integer) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_get_workspace_context(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_integration_connections(uuid) FROM PUBLIC, anon, authenticated, service_role, bg_billing_worker, bg_erasure;

GRANT EXECUTE ON FUNCTION saas_business.bg_quota_status(uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_reserve_units(uuid, uuid, integer, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_capture_units(uuid, uuid, integer, integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_release_units(uuid, uuid, integer, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_select_route(uuid, uuid, uuid, integer, uuid, text, text[], text[], text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_complete_attempt(uuid, uuid, uuid, text, integer, integer, integer, bigint, char) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_sync_provider_config(text, text, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_sync_verified_model(text, text, text, integer, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_models(text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_roles() TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_get_routing_preferences(uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_upsert_routing_preference(uuid, text, text, text, text, boolean) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_tool_execution(uuid, uuid, uuid, text, text, jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_tool_executions(uuid, uuid, integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_resolve_tool_execution(uuid, uuid, text, jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_recent_requests(uuid, integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_get_workspace_context(uuid, uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_integration_connections(uuid) TO bg_edge;
