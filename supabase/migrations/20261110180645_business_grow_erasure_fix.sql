-- Allow authorized bg_prepare_account_erasure() execution regardless of whether invoked by bg_erasure or postgres admin role,
-- while preserving append-only protection on saas_business.memory_consent_events for all normal updates/deletes.

CREATE OR REPLACE FUNCTION saas_business.reject_consent_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, saas_business
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    session_user = 'bg_erasure'
    OR pg_catalog.current_setting('saas_business.erasure_active', true) = 'on'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'memory consent events are append-only';
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_prepare_account_erasure(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, saas_business
AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:' || p_user_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN RAISE EXCEPTION 'user not found'; END IF;
  PERFORM pg_catalog.set_config('saas_business.erasure_active', 'on', true);
  DELETE FROM saas_business.memory_consent_events WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_profiles WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id = p_user_id;
  PERFORM pg_catalog.set_config('saas_business.erasure_active', 'off', true);
END $$;
