-- Business Growth — socle de persistance des modules métier.
-- Chaque module (Lead Rescue, Payment Recovery, Smart Inventory…) stocke ses
-- enregistrements dans une seule table cloisonnée par utilisateur et catégorie.
-- Aucun accès client direct : lecture/écriture uniquement via les fonctions
-- saas_business.bg_module_* appelées par l'Edge Function business-grow (bg_edge).

CREATE TABLE saas_business.module_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE SET NULL,
  category text NOT NULL CHECK (category ~ '^bg_module_[a-z0-9_]{2,60}$'),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE INDEX module_records_owner_category_idx
  ON saas_business.module_records(user_id, category, updated_at DESC);
CREATE UNIQUE INDEX module_records_dedupe_idx
  ON saas_business.module_records(user_id, category, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX module_records_workspace_idx
  ON saas_business.module_records(workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE TRIGGER module_records_touch BEFORE UPDATE ON saas_business.module_records
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();

ALTER TABLE saas_business.module_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.module_records FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_module_records ON saas_business.module_records
  TO bg_owner USING (true) WITH CHECK (true);

-- Validation commune : catégorie fermée, données JSON objet et taille bornée.
CREATE FUNCTION saas_business.bg_module_validate(p_category text, p_data jsonb)
RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog AS $$
BEGIN
  IF p_category IS NULL OR p_category !~ '^bg_module_[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'invalid module category' USING ERRCODE = '22023';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'module data must be a json object' USING ERRCODE = '22023';
  END IF;
  IF pg_column_size(p_data) > 20000 THEN
    RAISE EXCEPTION 'module data too large' USING ERRCODE = '22001';
  END IF;
END $$;

CREATE FUNCTION saas_business.bg_list_module_records(p_user_id uuid, p_category text)
RETURNS TABLE (id uuid, category text, data jsonb, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM saas_business.bg_module_validate(p_category, '{}'::jsonb);
  RETURN QUERY
    SELECT r.id, r.category, r.data, r.created_at, r.updated_at
    FROM saas_business.module_records r
    WHERE r.user_id = p_user_id AND r.category = p_category
    ORDER BY r.updated_at DESC, r.created_at DESC
    LIMIT 500;
END $$;

CREATE FUNCTION saas_business.bg_create_module_record(
  p_user_id uuid,
  p_category text,
  p_data jsonb,
  p_dedupe_key text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_id uuid;
  v_dedupe text;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'user not found' USING ERRCODE = '23503';
  END IF;
  PERFORM saas_business.bg_module_validate(p_category, p_data);

  v_dedupe := NULLIF(btrim(p_dedupe_key), '');
  IF v_dedupe IS NOT NULL THEN
    SELECT r.id INTO v_id
    FROM saas_business.module_records r
    WHERE r.user_id = p_user_id AND r.category = p_category AND r.dedupe_key = v_dedupe;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  SELECT count(*) INTO v_count
  FROM saas_business.module_records r
  WHERE r.user_id = p_user_id AND r.category = p_category;
  IF v_count >= 500 THEN
    RAISE EXCEPTION 'module record limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO saas_business.module_records (user_id, category, data, dedupe_key)
  VALUES (p_user_id, p_category, p_data, v_dedupe)
  ON CONFLICT (user_id, category, dedupe_key) WHERE dedupe_key IS NOT NULL
  DO UPDATE SET updated_at = saas_business.module_records.updated_at
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

CREATE FUNCTION saas_business.bg_update_module_record(
  p_user_id uuid,
  p_record_id uuid,
  p_data jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_category text;
  v_updated integer;
BEGIN
  IF p_user_id IS NULL OR p_record_id IS NULL THEN RAISE EXCEPTION 'user and record ids required'; END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'module data must be a json object' USING ERRCODE = '22023';
  END IF;
  IF pg_column_size(p_data) > 20000 THEN
    RAISE EXCEPTION 'module data too large' USING ERRCODE = '22001';
  END IF;

  SELECT r.category INTO v_category
  FROM saas_business.module_records r
  WHERE r.id = p_record_id AND r.user_id = p_user_id;
  IF v_category IS NULL THEN RETURN false; END IF;
  PERFORM saas_business.bg_module_validate(v_category, p_data);

  UPDATE saas_business.module_records r
  SET data = r.data || p_data
  WHERE r.id = p_record_id AND r.user_id = p_user_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END $$;

CREATE FUNCTION saas_business.bg_delete_module_record(p_user_id uuid, p_record_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_user_id IS NULL OR p_record_id IS NULL THEN RAISE EXCEPTION 'user and record ids required'; END IF;
  DELETE FROM saas_business.module_records r
  WHERE r.id = p_record_id AND r.user_id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END $$;

-- Le rôle Edge ne voit jamais la table directement.
REVOKE ALL ON saas_business.module_records
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_module_validate(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_list_module_records(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_create_module_record(uuid, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_update_module_record(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;
REVOKE EXECUTE ON FUNCTION saas_business.bg_delete_module_record(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

GRANT EXECUTE ON FUNCTION saas_business.bg_list_module_records(uuid, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_module_record(uuid, text, jsonb, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_update_module_record(uuid, uuid, jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_module_record(uuid, uuid) TO bg_edge;

-- Effacement de compte : les enregistrements métier suivent la même procédure
-- que la mémoire Business Grow (suppression sur demande, avant suppression auth).
CREATE OR REPLACE FUNCTION saas_business.bg_prepare_account_erasure(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:' || p_user_id::text, 0));
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN RAISE EXCEPTION 'user not found'; END IF;
  DELETE FROM saas_business.module_records WHERE user_id = p_user_id;
  DELETE FROM saas_business.memory_consent_events WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_profiles WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id=p_user_id;
END $$;

GRANT EXECUTE ON FUNCTION saas_business.bg_prepare_account_erasure(uuid) TO bg_erasure;
