-- Business Growth — demandes d'intégration et cycle de vie des connexions.
--
-- Aucun connecteur n'est présenté comme opérationnel avant une connexion
-- réelle. Ces fonctions permettent de tracer une demande utilisateur, de
-- l'annuler et, lorsqu'une connexion existe, de la révoquer proprement.

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_pending_idx
  ON saas_business.integration_connections(user_id, connector_key)
  WHERE status = 'pending' AND external_account_ref IS NULL;

CREATE OR REPLACE FUNCTION saas_business.bg_validate_connector_key(p_connector_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog AS $$
BEGIN
  IF p_connector_key IS NULL OR p_connector_key NOT IN
    ('facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce') THEN
    RAISE EXCEPTION 'invalid connector key' USING ERRCODE = '22023';
  END IF;
  RETURN p_connector_key;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_request_integration_connection(
  p_user_id uuid,
  p_connector_key text,
  p_workspace_id uuid DEFAULT NULL
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business, saas_ugc AS $$
DECLARE
  v_status text;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = '23503';
  END IF;
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);

  IF p_workspace_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM saas_ugc.ugc_workspaces w
    WHERE w.id = p_workspace_id AND (
      w.owner_user_id = p_user_id OR EXISTS (
        SELECT 1 FROM saas_ugc.ugc_workspace_members m
        WHERE m.workspace_id = w.id AND m.user_id = p_user_id
      )
    )
  ) THEN
    RAISE EXCEPTION 'workspace not found' USING ERRCODE = '42501';
  END IF;

  -- Une connexion réelle (avec référence externe) prime sur toute demande.
  IF EXISTS (
    SELECT 1 FROM saas_business.integration_connections c
    WHERE c.user_id = p_user_id AND c.connector_key = p_connector_key
      AND c.status = 'connected'
  ) THEN
    RETURN 'connected';
  END IF;

  SELECT c.status INTO v_status
  FROM saas_business.integration_connections c
  WHERE c.user_id = p_user_id AND c.connector_key = p_connector_key
    AND c.external_account_ref IS NULL
  ORDER BY c.updated_at DESC
  LIMIT 1;

  IF v_status = 'pending' THEN RETURN 'pending'; END IF;

  UPDATE saas_business.integration_connections c
  SET status = 'pending', workspace_id = COALESCE(p_workspace_id, c.workspace_id), updated_at = now()
  WHERE c.user_id = p_user_id AND c.connector_key = p_connector_key
    AND c.external_account_ref IS NULL AND c.status <> 'connected';

  IF FOUND THEN RETURN 'pending'; END IF;

  BEGIN
    INSERT INTO saas_business.integration_connections
      (user_id, workspace_id, connector_key, status)
    VALUES (p_user_id, p_workspace_id, p_connector_key, 'pending');
  EXCEPTION WHEN unique_violation THEN
    -- Demande concurrente déjà enregistrée (index partiel pending).
    RETURN 'pending';
  END;
  RETURN 'pending';
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_cancel_integration_request(
  p_user_id uuid,
  p_connector_key text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_count integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);
  DELETE FROM saas_business.integration_connections c
  WHERE c.user_id = p_user_id AND c.connector_key = p_connector_key
    AND c.status = 'pending' AND c.external_account_ref IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_disconnect_integration_connection(
  p_user_id uuid,
  p_connector_key text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE v_count integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);
  -- La révocation efface aussi la référence externe : la ligne redevient une
  -- demande réutilisable et ne bloque pas une future activation.
  UPDATE saas_business.integration_connections c
  SET status = 'disconnected', credential_ref = NULL, external_account_ref = NULL, updated_at = now()
  WHERE c.user_id = p_user_id AND c.connector_key = p_connector_key
    AND c.status IN ('connected', 'error');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END $$;

REVOKE EXECUTE ON FUNCTION saas_business.bg_validate_connector_key(text)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_request_integration_connection(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_cancel_integration_request(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_disconnect_integration_connection(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

GRANT EXECUTE ON FUNCTION saas_business.bg_request_integration_connection(uuid, text, uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_cancel_integration_request(uuid, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_disconnect_integration_connection(uuid, text) TO bg_edge;

-- Effacement de compte : les demandes de connexion et les enregistrements
-- métier suivent le compte. Le drapeau `erasure_active` autorise la
-- suppression des événements de consentement (append-only hors effacement).
CREATE OR REPLACE FUNCTION saas_business.bg_prepare_account_erasure(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:' || p_user_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN RAISE EXCEPTION 'user not found'; END IF;
  PERFORM pg_catalog.set_config('saas_business.erasure_active', 'on', true);
  DELETE FROM saas_business.integration_connections WHERE user_id = p_user_id;
  DELETE FROM saas_business.module_records WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_consent_events WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_profiles WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id = p_user_id;
  PERFORM pg_catalog.set_config('saas_business.erasure_active', 'off', true);
END $$;

GRANT EXECUTE ON FUNCTION saas_business.bg_prepare_account_erasure(uuid) TO bg_erasure;
