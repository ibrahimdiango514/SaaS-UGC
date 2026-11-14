-- VYORA Business Agent : stockage borné et cloisonné par compte ET entreprise.
-- La migration de modules 20261114100000 peut manquer sur une installation
-- existante : on crée son socle si nécessaire, sans remplacer l'effacement de
-- compte par son ancienne version. Les données historiques sans workspace ne
-- sont ni attribuées ni importées automatiquement dans une entreprise.

CREATE TABLE IF NOT EXISTS saas_business.module_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category ~ '^bg_module_[a-z0-9_]{2,60}$'),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  dedupe_key text CHECK (dedupe_key IS NULL OR char_length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
-- Une entreprise supprimée ne doit jamais devenir de la mémoire personnelle.
-- Les conversations et fiches associées sont supprimées avec leur entreprise.
ALTER TABLE saas_business.module_records DROP CONSTRAINT IF EXISTS module_records_workspace_id_fkey;
ALTER TABLE saas_business.module_records ADD CONSTRAINT module_records_workspace_id_fkey
  FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
ALTER TABLE saas_business.conversations DROP CONSTRAINT IF EXISTS conversations_workspace_id_fkey;
ALTER TABLE saas_business.conversations ADD CONSTRAINT conversations_workspace_id_fkey
  FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
-- La FK composite historique doit conserver l'utilisateur et la conversation
-- si seule la requête est supprimée ; seule la référence de requête est nullable.
ALTER TABLE saas_business.tool_executions DROP CONSTRAINT IF EXISTS tool_executions_request_id_user_id_conversation_id_fkey;
ALTER TABLE saas_business.tool_executions ADD CONSTRAINT tool_executions_request_id_user_id_conversation_id_fkey
  FOREIGN KEY(request_id,user_id,conversation_id) REFERENCES saas_business.ai_requests(id,user_id,conversation_id) ON DELETE SET NULL (request_id);
CREATE INDEX IF NOT EXISTS module_records_owner_category_idx ON saas_business.module_records(user_id, category, updated_at DESC);
CREATE INDEX IF NOT EXISTS module_records_workspace_idx ON saas_business.module_records(workspace_id) WHERE workspace_id IS NOT NULL;
DROP INDEX IF EXISTS saas_business.module_records_dedupe_idx;
CREATE UNIQUE INDEX IF NOT EXISTS module_records_scoped_dedupe_idx
  ON saas_business.module_records(user_id, workspace_id, category, dedupe_key)
  WHERE workspace_id IS NOT NULL AND dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS module_records_legacy_dedupe_idx
  ON saas_business.module_records(user_id, category, dedupe_key)
  WHERE workspace_id IS NULL AND dedupe_key IS NOT NULL;
DROP TRIGGER IF EXISTS module_records_touch ON saas_business.module_records;
CREATE TRIGGER module_records_touch BEFORE UPDATE ON saas_business.module_records
  FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
ALTER TABLE saas_business.module_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE saas_business.module_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_module_records ON saas_business.module_records;
CREATE POLICY owner_module_records ON saas_business.module_records TO bg_owner USING (true) WITH CHECK (true);
REVOKE ALL ON saas_business.module_records FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

-- Tous les appels Edge sont identifiés par l'utilisateur authentifié. Les
-- propriétaires et membres peuvent lire leur propre périmètre ; seuls owner,
-- admin et editor peuvent modifier des données d'entreprise. NULL désigne
-- exclusivement le périmètre personnel historique, jamais une entreprise.
CREATE OR REPLACE FUNCTION saas_business.bg_can_workspace(p_user_id uuid, p_workspace_id uuid, p_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas_ugc AS $$
  SELECT p_user_id IS NOT NULL AND (
    p_workspace_id IS NULL OR EXISTS (
      SELECT 1 FROM saas_ugc.ugc_workspaces w
      WHERE w.id = p_workspace_id AND (
        w.owner_user_id = p_user_id OR EXISTS (
          SELECT 1 FROM saas_ugc.ugc_workspace_members m
          WHERE m.workspace_id = w.id AND m.user_id = p_user_id
            AND (NOT p_write OR m.member_role IN ('owner','admin','editor'))
        )
      )
    )
  )
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_require_workspace(p_user_id uuid, p_workspace_id uuid, p_write boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  IF NOT saas_business.bg_can_workspace(p_user_id, p_workspace_id, p_write) THEN
    RAISE EXCEPTION 'workspace access denied' USING ERRCODE = '42501';
  END IF;
END $$;

-- Les mutations verrouillent les lignes qui portent l'autorisation jusqu'au
-- COMMIT. Un retrait ou changement de rôle déjà commencé ne peut ainsi pas être
-- ignoré après l'attente d'un autre verrou. Ordre : utilisateur, espace, membre.
CREATE OR REPLACE FUNCTION saas_business.bg_lock_workspace_access(p_user_id uuid,p_workspace_id uuid,p_write boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_ugc AS $$
DECLARE v_owner uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'workspace access denied' USING ERRCODE='42501'; END IF;
  IF p_workspace_id IS NULL THEN RETURN; END IF; -- historique personnel uniquement
  SELECT w.owner_user_id INTO v_owner FROM saas_ugc.ugc_workspaces w WHERE w.id=p_workspace_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace access denied' USING ERRCODE='42501'; END IF;
  IF v_owner=p_user_id THEN RETURN; END IF;
  PERFORM 1 FROM saas_ugc.ugc_workspace_members m
  WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id
    AND (NOT p_write OR m.member_role IN ('owner','admin','editor')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace access denied' USING ERRCODE='42501'; END IF;
END $$;

-- Les intégrations sont elles aussi isolées par utilisateur ET entreprise.
-- Les lignes historiques sans entreprise restent personnelles : aucun
-- rattachement automatique lors d'une demande ou d'une suppression d'espace.
ALTER TABLE saas_business.integration_connections DROP CONSTRAINT IF EXISTS integration_connections_workspace_id_fkey;
ALTER TABLE saas_business.integration_connections ADD CONSTRAINT integration_connections_workspace_id_fkey
  FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS saas_business.integration_connections_pending_idx;
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_scoped_pending_idx
  ON saas_business.integration_connections(user_id,workspace_id,connector_key)
  WHERE workspace_id IS NOT NULL AND status='pending' AND external_account_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_legacy_pending_idx
  ON saas_business.integration_connections(user_id,connector_key)
  WHERE workspace_id IS NULL AND status='pending' AND external_account_ref IS NULL;
-- Une même référence externe ne peut être dupliquée dans un périmètre, mais
-- une association explicite dans une autre entreprise reste indépendante.
ALTER TABLE saas_business.integration_connections DROP CONSTRAINT IF EXISTS integration_connections_user_id_connector_key_external_acco_key;
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_scoped_account_idx
  ON saas_business.integration_connections(user_id,workspace_id,connector_key,external_account_ref)
  WHERE workspace_id IS NOT NULL AND external_account_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_legacy_account_idx
  ON saas_business.integration_connections(user_id,connector_key,external_account_ref)
  WHERE workspace_id IS NULL AND external_account_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION saas_business.bg_list_scoped_integration_connections(p_user_id uuid,p_workspace_id uuid)
RETURNS TABLE(id uuid,workspace_id uuid,connector_key text,external_account_ref text,status text,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  RETURN QUERY SELECT c.id,c.workspace_id,c.connector_key,c.external_account_ref,c.status,c.updated_at
    FROM saas_business.integration_connections c
    WHERE c.user_id=p_user_id AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id
    ORDER BY c.connector_key,c.updated_at DESC,c.id;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_request_scoped_integration_connection(p_user_id uuid,p_workspace_id uuid,p_connector_key text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'user not found' USING ERRCODE='23503'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  IF EXISTS(SELECT 1 FROM saas_business.integration_connections c WHERE c.user_id=p_user_id
    AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id AND c.connector_key=p_connector_key AND c.status='connected') THEN
    RETURN 'connected';
  END IF;
  IF EXISTS(SELECT 1 FROM saas_business.integration_connections c WHERE c.user_id=p_user_id
    AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id AND c.connector_key=p_connector_key AND c.status='pending' AND c.external_account_ref IS NULL) THEN
    RETURN 'pending';
  END IF;
  SELECT c.id INTO v_id FROM saas_business.integration_connections c
    WHERE c.user_id=p_user_id AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id AND c.connector_key=p_connector_key
      AND c.external_account_ref IS NULL AND c.status<>'connected'
    ORDER BY c.updated_at DESC,c.id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO saas_business.integration_connections(user_id,workspace_id,connector_key,status)
    VALUES(p_user_id,p_workspace_id,p_connector_key,'pending');
  ELSE
    UPDATE saas_business.integration_connections SET status='pending',updated_at=clock_timestamp() WHERE id=v_id;
  END IF;
  RETURN 'pending';
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_cancel_scoped_integration_request(p_user_id uuid,p_workspace_id uuid,p_connector_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  DELETE FROM saas_business.integration_connections c WHERE c.user_id=p_user_id
    AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id AND c.connector_key=p_connector_key
    AND c.status='pending' AND c.external_account_ref IS NULL;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_disconnect_scoped_integration_connection(p_user_id uuid,p_workspace_id uuid,p_connector_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  PERFORM saas_business.bg_validate_connector_key(p_connector_key);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  -- Retire uniquement l'association locale ; aucune révocation fournisseur ou
  -- suppression de secret Vault n'est implicitement prétendue ni exécutée.
  UPDATE saas_business.integration_connections c
    SET status='disconnected',credential_ref=NULL,external_account_ref=NULL,updated_at=clock_timestamp()
    WHERE c.user_id=p_user_id AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id
      AND c.connector_key=p_connector_key AND c.status IN ('connected','error');
  RETURN FOUND;
END $$;

-- Les anciens clients sans workspace ne peuvent voir ou modifier que leurs
-- lignes personnelles. Une demande historique avec workspace serait invisible
-- à leur liste personnelle : la refuser au lieu d'annoncer un succès trompeur.
CREATE OR REPLACE FUNCTION saas_business.bg_list_integration_connections(p_user_id uuid)
RETURNS TABLE(id uuid,workspace_id uuid,connector_key text,external_account_ref text,status text,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT * FROM saas_business.bg_list_scoped_integration_connections(p_user_id,NULL)
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_request_integration_connection(p_user_id uuid,p_connector_key text,p_workspace_id uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NOT NULL THEN RAISE EXCEPTION 'workspace integration requires v3 protocol' USING ERRCODE='0A000'; END IF;
  RETURN saas_business.bg_request_scoped_integration_connection(p_user_id,NULL,p_connector_key);
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_cancel_integration_request(p_user_id uuid,p_connector_key text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT saas_business.bg_cancel_scoped_integration_request(p_user_id,NULL,p_connector_key)
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_disconnect_integration_connection(p_user_id uuid,p_connector_key text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT saas_business.bg_disconnect_scoped_integration_connection(p_user_id,NULL,p_connector_key)
$$;

-- La création historique conserve sa signature, mais sérialise désormais le
-- contrôle d'appartenance avec les retraits de membres et l'effacement.
CREATE OR REPLACE FUNCTION saas_business.bg_create_conversation(p_user_id uuid,p_title text,p_workspace_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_title IS NULL OR btrim(p_title)='' OR length(p_title)>160 THEN RAISE EXCEPTION 'invalid conversation'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,false);
  INSERT INTO saas_business.conversations(user_id,title,workspace_id) VALUES(p_user_id,btrim(p_title),p_workspace_id) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_module_validate(p_category text, p_data jsonb)
RETURNS void LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
BEGIN
  IF p_category IS NULL OR p_category !~ '^bg_module_[a-z0-9_]{2,60}$' THEN
    RAISE EXCEPTION 'invalid module category' USING ERRCODE = '22023';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION 'module data must be a json object' USING ERRCODE = '22023';
  END IF;
  IF pg_column_size(p_data) > 20000 THEN RAISE EXCEPTION 'module data too large' USING ERRCODE = '22001'; END IF;
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_list_scoped_module_records(p_user_id uuid, p_workspace_id uuid, p_category text)
RETURNS TABLE(id uuid, category text, data jsonb, created_at timestamptz, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
BEGIN
  PERFORM saas_business.bg_require_workspace(p_user_id, p_workspace_id, false);
  PERFORM saas_business.bg_module_validate(p_category, '{}'::jsonb);
  RETURN QUERY SELECT r.id, r.category, r.data, r.created_at, r.updated_at
  FROM saas_business.module_records r
  WHERE r.user_id = p_user_id AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id AND r.category = p_category
  ORDER BY r.updated_at DESC, r.id DESC LIMIT 500;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_create_scoped_module_record(
  p_user_id uuid, p_workspace_id uuid, p_category text, p_data jsonb, p_dedupe_key text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_id uuid; v_key text := NULLIF(btrim(p_dedupe_key), ''); v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);
  PERFORM saas_business.bg_module_validate(p_category, p_data);
  IF v_key IS NOT NULL AND length(v_key) > 200 THEN RAISE EXCEPTION 'invalid dedupe key' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_module:' || p_user_id::text || ':' || COALESCE(p_workspace_id::text, 'legacy') || ':' || p_category, 0));
  IF v_key IS NOT NULL THEN
    SELECT r.id INTO v_id FROM saas_business.module_records r
    WHERE r.user_id=p_user_id AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id AND r.category=p_category AND r.dedupe_key=v_key;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  SELECT count(*) INTO v_count FROM saas_business.module_records r
  WHERE r.user_id=p_user_id AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id AND r.category=p_category;
  IF v_count >= 500 THEN RAISE EXCEPTION 'module record limit reached' USING ERRCODE = '54000'; END IF;
  INSERT INTO saas_business.module_records(user_id,workspace_id,category,data,dedupe_key)
  VALUES(p_user_id,p_workspace_id,p_category,p_data,v_key) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_update_scoped_module_record(
  p_user_id uuid, p_workspace_id uuid, p_record_id uuid, p_category text, p_data jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
DECLARE v_merged jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM saas_business.bg_module_validate(p_category,p_data);
  SELECT r.data || p_data INTO v_merged FROM saas_business.module_records r
  WHERE r.id=p_record_id AND r.user_id=p_user_id AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id AND r.category=p_category FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM saas_business.bg_module_validate(p_category,v_merged);
  UPDATE saas_business.module_records SET data=v_merged WHERE id=p_record_id;
  RETURN true;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_delete_scoped_module_record(
  p_user_id uuid, p_workspace_id uuid, p_record_id uuid, p_category text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, saas_business AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM saas_business.bg_module_validate(p_category,'{}'::jsonb);
  DELETE FROM saas_business.module_records r WHERE r.id=p_record_id AND r.user_id=p_user_id
    AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id AND r.category=p_category;
  RETURN FOUND;
END $$;

-- Les anciennes RPC ne voient que les données personnelles non affectées.
CREATE OR REPLACE FUNCTION saas_business.bg_list_module_records(p_user_id uuid,p_category text)
RETURNS TABLE(id uuid,category text,data jsonb,created_at timestamptz,updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT * FROM saas_business.bg_list_scoped_module_records(p_user_id,NULL,p_category)
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_create_module_record(p_user_id uuid,p_category text,p_data jsonb,p_dedupe_key text DEFAULT NULL)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT saas_business.bg_create_scoped_module_record(p_user_id,NULL,p_category,p_data,p_dedupe_key)
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_update_module_record(p_user_id uuid,p_record_id uuid,p_data jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_category text;
BEGIN
  SELECT category INTO v_category FROM saas_business.module_records WHERE id=p_record_id AND user_id=p_user_id AND workspace_id IS NULL;
  IF v_category IS NULL THEN RETURN false; END IF;
  RETURN saas_business.bg_update_scoped_module_record(p_user_id,NULL,p_record_id,v_category,p_data);
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_delete_module_record(p_user_id uuid,p_record_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_category text;
BEGIN
  SELECT category INTO v_category FROM saas_business.module_records WHERE id=p_record_id AND user_id=p_user_id AND workspace_id IS NULL;
  IF v_category IS NULL THEN RETURN false; END IF;
  RETURN saas_business.bg_delete_scoped_module_record(p_user_id,NULL,p_record_id,v_category);
END $$;

-- La mémoire historique reste intacte. Les nouvelles tables sont strictement
-- personnelles ET rattachées à une entreprise ; consentement indépendant.
CREATE TABLE IF NOT EXISTS saas_business.workspace_memory_consent_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('granted','revoked')),
  policy_version text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS workspace_memory_consent_idx ON saas_business.workspace_memory_consent_events(user_id,workspace_id,event_id DESC);
-- Journal inviolable en fonctionnement normal. Sa suppression n'est permise
-- que pour l'effacement du compte ou la cascade effective du parent supprimé.
CREATE OR REPLACE FUNCTION saas_business.reject_workspace_consent_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_ugc AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    pg_catalog.current_setting('saas_business.erasure_active',true)='on'
    OR (pg_trigger_depth()>1 AND NOT EXISTS(SELECT 1 FROM saas_ugc.ugc_workspaces WHERE id=OLD.workspace_id))
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'workspace memory consent events are append-only';
END $$;
DROP TRIGGER IF EXISTS workspace_consent_append_only ON saas_business.workspace_memory_consent_events;
CREATE TRIGGER workspace_consent_append_only BEFORE DELETE OR UPDATE ON saas_business.workspace_memory_consent_events
  FOR EACH ROW EXECUTE FUNCTION saas_business.reject_workspace_consent_mutation();
CREATE TABLE IF NOT EXISTS saas_business.workspace_memory_profiles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE,
  profile_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(profile_data)='object'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,workspace_id)
);
CREATE TABLE IF NOT EXISTS saas_business.workspace_memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category ~ '^[a-z][a-z0-9_]{1,79}$'),
  content jsonb NOT NULL,
  source_kind text NOT NULL DEFAULT 'manual' CHECK(source_kind IN ('manual','conversation','legacy_import')),
  source_ref uuid,
  legacy_source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE saas_business.workspace_memory_consent_events DROP CONSTRAINT IF EXISTS workspace_memory_consent_events_workspace_id_fkey;
ALTER TABLE saas_business.workspace_memory_consent_events ADD CONSTRAINT workspace_memory_consent_events_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
ALTER TABLE saas_business.workspace_memory_profiles DROP CONSTRAINT IF EXISTS workspace_memory_profiles_workspace_id_fkey;
ALTER TABLE saas_business.workspace_memory_profiles ADD CONSTRAINT workspace_memory_profiles_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
ALTER TABLE saas_business.workspace_memory_items DROP CONSTRAINT IF EXISTS workspace_memory_items_workspace_id_fkey;
ALTER TABLE saas_business.workspace_memory_items ADD CONSTRAINT workspace_memory_items_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS workspace_memory_items_scope_idx ON saas_business.workspace_memory_items(user_id,workspace_id,category,updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_memory_legacy_import_idx ON saas_business.workspace_memory_items(user_id,workspace_id,legacy_source_id) WHERE legacy_source_id IS NOT NULL;
DROP TRIGGER IF EXISTS workspace_memory_items_touch ON saas_business.workspace_memory_items;
CREATE TRIGGER workspace_memory_items_touch BEFORE UPDATE ON saas_business.workspace_memory_items FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();
DROP TRIGGER IF EXISTS workspace_memory_profiles_touch ON saas_business.workspace_memory_profiles;
CREATE TRIGGER workspace_memory_profiles_touch BEFORE UPDATE ON saas_business.workspace_memory_profiles FOR EACH ROW EXECUTE FUNCTION saas_business.touch_updated_at();

CREATE OR REPLACE FUNCTION saas_business.bg_get_scoped_memory(p_user_id uuid,p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_action text; v_policy text; v_profile jsonb; v_items jsonb;
BEGIN
  IF p_workspace_id IS NULL THEN RETURN saas_business.bg_get_memory(p_user_id); END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  SELECT action,policy_version INTO v_action,v_policy FROM saas_business.workspace_memory_consent_events
  WHERE user_id=p_user_id AND workspace_id=p_workspace_id ORDER BY event_id DESC LIMIT 1;
  IF v_action='granted' THEN
    SELECT profile_data INTO v_profile FROM saas_business.workspace_memory_profiles WHERE user_id=p_user_id AND workspace_id=p_workspace_id;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'category',category,'content',content,'created_at',created_at,'updated_at',updated_at) ORDER BY updated_at DESC,id),'[]'::jsonb)
    INTO v_items FROM (SELECT * FROM saas_business.workspace_memory_items WHERE user_id=p_user_id AND workspace_id=p_workspace_id ORDER BY updated_at DESC,id LIMIT 500) i;
  END IF;
  RETURN jsonb_build_object('consent',COALESCE(v_action='granted',false),'policyVersion',v_policy,'profile',v_profile,'items',COALESCE(v_items,'[]'::jsonb));
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_set_scoped_memory_consent(p_user_id uuid,p_workspace_id uuid,p_enabled boolean,p_policy_version text)
RETURNS TABLE(event_id bigint,occurred_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN RETURN QUERY SELECT * FROM saas_business.bg_set_memory_consent(p_user_id,p_enabled,p_policy_version); RETURN; END IF;
  IF p_enabled IS NULL OR p_policy_version IS NULL OR length(btrim(p_policy_version))=0 THEN RAISE EXCEPTION 'invalid consent request'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_workspace_mem:'||p_user_id::text||':'||p_workspace_id::text,0));
  INSERT INTO saas_business.workspace_memory_consent_events(user_id,workspace_id,action,policy_version)
  VALUES(p_user_id,p_workspace_id,CASE WHEN p_enabled THEN 'granted' ELSE 'revoked' END,p_policy_version)
  RETURNING workspace_memory_consent_events.event_id,workspace_memory_consent_events.occurred_at INTO event_id,occurred_at;
  IF NOT p_enabled THEN
    DELETE FROM saas_business.workspace_memory_profiles WHERE user_id=p_user_id AND workspace_id=p_workspace_id;
    DELETE FROM saas_business.workspace_memory_items WHERE user_id=p_user_id AND workspace_id=p_workspace_id;
  END IF;
  RETURN NEXT;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_require_scoped_consent(p_user_id uuid,p_workspace_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL OR COALESCE((SELECT action FROM saas_business.workspace_memory_consent_events
    WHERE user_id=p_user_id AND workspace_id=p_workspace_id ORDER BY event_id DESC LIMIT 1),'revoked') <> 'granted'
  THEN RAISE EXCEPTION 'active memory consent required' USING ERRCODE='23514'; END IF;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_upsert_scoped_memory_profile(p_user_id uuid,p_workspace_id uuid,p_profile jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN PERFORM saas_business.bg_upsert_memory_profile(p_user_id,p_profile); RETURN; END IF;
  IF p_profile IS NULL OR jsonb_typeof(p_profile)<>'object' OR pg_column_size(p_profile)>20000 THEN RAISE EXCEPTION 'invalid memory profile'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_workspace_mem:'||p_user_id::text||':'||p_workspace_id::text,0));
  PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id);
  INSERT INTO saas_business.workspace_memory_profiles(user_id,workspace_id,profile_data) VALUES(p_user_id,p_workspace_id,p_profile)
  ON CONFLICT(user_id,workspace_id) DO UPDATE SET profile_data=EXCLUDED.profile_data;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_put_scoped_memory_item(p_user_id uuid,p_workspace_id uuid,p_item_id uuid,p_category text,p_content jsonb,p_source text DEFAULT 'manual',p_source_ref uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid := COALESCE(p_item_id,gen_random_uuid());
BEGIN
  IF p_workspace_id IS NULL THEN RETURN saas_business.bg_put_memory_item(p_user_id,p_item_id,p_category,p_content,p_source,p_source_ref); END IF;
  IF p_category IS NULL OR p_category !~ '^[a-z][a-z0-9_]{1,79}$' OR p_content IS NULL OR pg_column_size(p_content)>20000
    OR p_source NOT IN ('manual','conversation') THEN RAISE EXCEPTION 'invalid memory item'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_workspace_mem:'||p_user_id::text||':'||p_workspace_id::text,0));
  PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id);
  IF p_item_id IS NOT NULL THEN
    UPDATE saas_business.workspace_memory_items SET category=p_category,content=p_content,source_kind=p_source,source_ref=p_source_ref
    WHERE id=p_item_id AND user_id=p_user_id AND workspace_id=p_workspace_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'memory item not found'; END IF;
  ELSE
    IF (SELECT count(*) FROM saas_business.workspace_memory_items WHERE user_id=p_user_id AND workspace_id=p_workspace_id)>=500 THEN
      RAISE EXCEPTION 'memory item limit reached' USING ERRCODE='54000';
    END IF;
    INSERT INTO saas_business.workspace_memory_items(id,user_id,workspace_id,category,content,source_kind,source_ref)
    VALUES(v_id,p_user_id,p_workspace_id,p_category,p_content,p_source,p_source_ref);
  END IF;
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_delete_scoped_memory_item(p_user_id uuid,p_workspace_id uuid,p_item_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF p_workspace_id IS NULL THEN RETURN saas_business.bg_delete_memory_item(p_user_id,p_item_id); END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  DELETE FROM saas_business.workspace_memory_items WHERE user_id=p_user_id AND workspace_id=p_workspace_id AND id=p_item_id;
  RETURN FOUND;
END $$;

-- Import non destructif uniquement sur demande explicite de l'utilisateur.
CREATE OR REPLACE FUNCTION saas_business.bg_import_legacy_memory(p_user_id uuid,p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_count integer; v_profile boolean := false; v_legacy_action text;
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_workspace_mem:'||p_user_id::text||':'||p_workspace_id::text,0));
  PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id);
  SELECT action INTO v_legacy_action FROM saas_business.memory_consent_events WHERE user_id=p_user_id ORDER BY event_id DESC LIMIT 1;
  IF v_legacy_action IS DISTINCT FROM 'granted' THEN RAISE EXCEPTION 'legacy memory consent required'; END IF;
  IF (SELECT count(*) FROM saas_business.workspace_memory_items WHERE user_id=p_user_id AND workspace_id=p_workspace_id)
     + (SELECT count(*) FROM saas_business.memory_items i WHERE i.user_id=p_user_id AND i.category ~ '^[a-z][a-z0-9_]{1,79}$'
        AND pg_column_size(i.content)<=20000 AND NOT EXISTS(SELECT 1 FROM saas_business.workspace_memory_items w WHERE w.user_id=p_user_id AND w.workspace_id=p_workspace_id AND w.legacy_source_id=i.id)) > 500
  THEN RAISE EXCEPTION 'memory item limit reached'; END IF;
  INSERT INTO saas_business.workspace_memory_profiles(user_id,workspace_id,profile_data)
  SELECT p_user_id,p_workspace_id,profile_data FROM saas_business.memory_profiles WHERE user_id=p_user_id AND jsonb_typeof(profile_data)='object' AND pg_column_size(profile_data)<=20000
  ON CONFLICT(user_id,workspace_id) DO NOTHING;
  v_profile := FOUND;
  INSERT INTO saas_business.workspace_memory_items(user_id,workspace_id,category,content,source_kind,legacy_source_id,created_at,updated_at)
  SELECT p_user_id,p_workspace_id,i.category,i.content,'legacy_import',i.id,i.created_at,i.updated_at
  FROM saas_business.memory_items i WHERE i.user_id=p_user_id AND i.category ~ '^[a-z][a-z0-9_]{1,79}$' AND pg_column_size(i.content)<=20000
  ON CONFLICT(user_id,workspace_id,legacy_source_id) WHERE legacy_source_id IS NOT NULL DO NOTHING;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  RETURN jsonb_build_object('importedItems',v_count,'importedProfile',v_profile);
END $$;

-- Une conversation est liée de façon immuable à son entreprise. Les anciennes
-- conversations NULL ne reçoivent jamais de contexte d'une entreprise active.
CREATE OR REPLACE FUNCTION saas_business.bg_conversation_scope(p_user_id uuid,p_conversation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_workspace uuid;
BEGIN
  SELECT c.workspace_id INTO v_workspace FROM saas_business.conversations c WHERE c.id=p_conversation_id AND c.user_id=p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,v_workspace,false);
  RETURN jsonb_build_object('workspaceId',v_workspace);
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_list_scoped_conversations(p_user_id uuid,p_workspace_id uuid,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,title text,created_at timestamptz,updated_at timestamptz,last_message text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  RETURN QUERY SELECT c.id,c.title,c.created_at,c.updated_at,m.content
  FROM saas_business.conversations c LEFT JOIN LATERAL (
    SELECT msg.content FROM saas_business.messages msg WHERE msg.user_id=c.user_id AND msg.conversation_id=c.id ORDER BY msg.created_at DESC,msg.id DESC LIMIT 1
  ) m ON true
  WHERE c.user_id=p_user_id AND c.workspace_id IS NOT DISTINCT FROM p_workspace_id
  ORDER BY c.updated_at DESC,c.id DESC LIMIT greatest(1,least(COALESCE(p_limit,50),100));
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_list_conversations(p_user_id uuid,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,title text,created_at timestamptz,updated_at timestamptz,last_message text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT c.id,c.title,c.created_at,c.updated_at,m.content
  FROM saas_business.conversations c LEFT JOIN LATERAL (
    SELECT msg.content FROM saas_business.messages msg WHERE msg.user_id=c.user_id AND msg.conversation_id=c.id ORDER BY msg.created_at DESC,msg.id DESC LIMIT 1
  ) m ON true
  WHERE c.user_id=p_user_id AND saas_business.bg_can_workspace(p_user_id,c.workspace_id,false)
  ORDER BY c.updated_at DESC,c.id DESC LIMIT greatest(1,least(COALESCE(p_limit,50),100))
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_list_messages(p_user_id uuid,p_conversation_id uuid,p_limit integer DEFAULT 200)
RETURNS TABLE(id uuid,author_role text,content text,created_at timestamptz,request_status text,request_error_code text,request_provider_key text,request_model_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  -- Sélectionner les plus récents avant de rétablir l'ordre chronologique :
  -- une longue conversation ne doit pas masquer ses nouveaux messages.
  WITH recent AS (
    SELECT m.* FROM saas_business.messages m
    JOIN saas_business.conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id
    WHERE m.user_id=p_user_id AND m.conversation_id=p_conversation_id AND saas_business.bg_can_workspace(p_user_id,c.workspace_id,false)
    ORDER BY m.created_at DESC,m.id DESC LIMIT greatest(1,least(COALESCE(p_limit,200),500))
  )
  SELECT m.id,m.author_role,m.content,m.created_at,r.status,r.error_code,r.provider_key,r.model_key
  FROM recent m
  LEFT JOIN LATERAL (
    SELECT req.status,req.error_code,req.provider_key,COALESCE(model.provider_model_key,req.model_key) AS model_key
    FROM saas_business.ai_requests req LEFT JOIN saas_business.ai_models model ON model.provider_key=req.provider_key AND model.model_key=req.model_key
    WHERE req.user_id=m.user_id AND (req.input_message_id=m.id OR req.output_message_id=m.id)
    ORDER BY req.created_at DESC LIMIT 1
  ) r ON true
  ORDER BY m.created_at,m.id
$$;
CREATE OR REPLACE FUNCTION saas_business.bg_rename_conversation(p_user_id uuid,p_conversation_id uuid,p_title text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_workspace uuid;
BEGIN
  IF p_title IS NULL OR btrim(p_title)='' OR length(p_title)>160 THEN RAISE EXCEPTION 'invalid conversation title'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  SELECT c.workspace_id INTO v_workspace FROM saas_business.conversations c WHERE c.id=p_conversation_id AND c.user_id=p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);
  UPDATE saas_business.conversations c SET title=btrim(p_title),updated_at=clock_timestamp()
  WHERE c.id=p_conversation_id AND c.user_id=p_user_id;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_delete_conversation(p_user_id uuid,p_conversation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_workspace uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  SELECT c.workspace_id INTO v_workspace FROM saas_business.conversations c WHERE c.id=p_conversation_id AND c.user_id=p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);
  DELETE FROM saas_business.conversations c WHERE c.id=p_conversation_id AND c.user_id=p_user_id;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_list_tool_executions(p_user_id uuid,p_conversation_id uuid DEFAULT NULL,p_limit integer DEFAULT 30)
RETURNS TABLE(id uuid,conversation_id uuid,request_id uuid,tool_name text,risk_level text,status text,input_args jsonb,output_result jsonb,error_message text,approved_at timestamptz,executed_at timestamptz,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT t.id,t.conversation_id,t.request_id,t.tool_name,t.risk_level,t.status,t.input_args,t.output_result,t.error_message,t.approved_at,t.executed_at,t.created_at
  FROM saas_business.tool_executions t JOIN saas_business.conversations c ON c.id=t.conversation_id AND c.user_id=t.user_id
  WHERE t.user_id=p_user_id AND (p_conversation_id IS NULL OR t.conversation_id=p_conversation_id)
    AND saas_business.bg_can_workspace(p_user_id,c.workspace_id,false)
  ORDER BY t.created_at DESC LIMIT greatest(1,least(COALESCE(p_limit,30),100))
$$;

-- Compatibilité des clients historiques : la liste globale reste disponible,
-- mais exclut tout espace dont l'accès a été retiré.
CREATE OR REPLACE FUNCTION saas_business.bg_list_recent_requests(p_user_id uuid,p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid,conversation_id uuid,role_key text,provider_key text,model_key text,status text,
  input_tokens integer,output_tokens integer,provider_cost_micros bigint,latency_ms integer,error_code text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
  SELECT r.id,r.conversation_id,r.role_key,r.provider_key,r.model_key,r.status,r.input_tokens,r.output_tokens,
    r.provider_cost_micros,r.latency_ms,r.error_code,r.created_at
  FROM saas_business.ai_requests r JOIN saas_business.conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
  WHERE r.user_id=p_user_id AND saas_business.bg_can_workspace(p_user_id,c.workspace_id,false)
  ORDER BY r.created_at DESC LIMIT greatest(1,least(COALESCE(p_limit,20),100))
$$;

-- Les détails d'exécution affichés dans une entreprise ne mélangent pas les autres.
CREATE OR REPLACE FUNCTION saas_business.bg_list_scoped_recent_requests(p_user_id uuid,p_workspace_id uuid,p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid,conversation_id uuid,role_key text,provider_key text,model_key text,status text,
  input_tokens integer,output_tokens integer,provider_cost_micros bigint,latency_ms integer,error_code text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  RETURN QUERY SELECT r.id,r.conversation_id,r.role_key,r.provider_key,r.model_key,r.status,r.input_tokens,r.output_tokens,
    r.provider_cost_micros,r.latency_ms,r.error_code,r.created_at
  FROM saas_business.ai_requests r JOIN saas_business.conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id
  WHERE r.user_id=p_user_id AND c.workspace_id=p_workspace_id
  ORDER BY r.created_at DESC LIMIT greatest(1,least(COALESCE(p_limit,20),100));
END $$;

-- Projection fermée et bornée avant la sortie de PostgreSQL : les contacts,
-- notes, messages et justificatifs ne sont pas nécessaires au diagnostic.
-- Pour le support et les litiges, seule la présence d'un brouillon/preuve est conservée.
CREATE OR REPLACE FUNCTION saas_business.bg_agent_projection(p_data jsonb,p_is_crm boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT COALESCE(jsonb_object_agg(e.key,
    CASE WHEN jsonb_typeof(e.value)='string' THEN to_jsonb(left(e.value#>>'{}',240))
         WHEN jsonb_typeof(e.value)='number' THEN e.value ELSE 'null'::jsonb END),'{}'::jsonb)
    || CASE WHEN p_is_crm THEN '{}'::jsonb ELSE jsonb_build_object(
      'hasDraftReply',COALESCE(jsonb_typeof(p_data->'draftReply')='string' AND length(btrim(p_data->>'draftReply'))>0,false),
      'hasEvidence',COALESCE(jsonb_typeof(p_data->'evidence')='string' AND length(btrim(p_data->>'evidence'))>0,false)) END
  FROM jsonb_each(CASE WHEN jsonb_typeof(p_data)='object' THEN p_data ELSE '{}'::jsonb END) e
  WHERE e.key=ANY(CASE WHEN p_is_crm THEN ARRAY['name','company','stage','nextActionAt']::text[] ELSE ARRAY[
    'name','company','status','stage','nextActionAt','lastContactAt','estimatedValue','trigger','action',
    'invoiceRef','amount','reminderLevel','dueDate','reference','abandonedAt','lastOrderAt','totalSpent',
    'product','sku','stock','threshold','title','priority','subject','supplier','orderRef','expectedAt',
    'label','kind','occurredAt','source','detectedAt','openedAt','scheduledAt'
  ]::text[] END)
$$;

-- Service de lecture borné : aucune table ou requête n'est choisie par le
-- modèle. Seules les catégories listées ici sont accessibles ; notes libres
-- ne sont pas nécessaires au moteur de diagnostic déterministe.
CREATE OR REPLACE FUNCTION saas_business.bg_business_snapshot(p_user_id uuid,p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_category text; v_rows jsonb; v_modules jsonb:='{}'::jsonb; v_crm jsonb:='[]'::jsonb; v_consent boolean:=false;
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  FOREACH v_category IN ARRAY ARRAY[
    'bg_module_lead_rescue','bg_module_sales_automation','bg_module_customer_recovery','bg_module_payment_recovery',
    'bg_module_order_cart_recovery','bg_module_social_growth','bg_module_smart_inventory','bg_module_finance_intelligence',
    'bg_module_operations_manager','bg_module_customer_support_ai','bg_module_supplier_delivery','bg_module_dispute_shield','bg_module_revenue_leak'
  ] LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'data',data,'updated_at',updated_at) ORDER BY updated_at DESC,id DESC),'[]'::jsonb)
    INTO v_rows FROM (SELECT r.id,saas_business.bg_agent_projection(r.data,false) AS data,r.updated_at FROM saas_business.module_records r WHERE r.user_id=p_user_id AND r.workspace_id=p_workspace_id AND r.category=v_category ORDER BY r.updated_at DESC,r.id DESC LIMIT 500) q;
    v_modules := v_modules || jsonb_build_object(v_category,v_rows);
  END LOOP;
  v_consent := COALESCE((SELECT action='granted' FROM saas_business.workspace_memory_consent_events WHERE user_id=p_user_id AND workspace_id=p_workspace_id ORDER BY event_id DESC LIMIT 1),false);
  IF v_consent THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'data',content,'updated_at',updated_at) ORDER BY updated_at DESC,id DESC),'[]'::jsonb)
    INTO v_crm FROM (SELECT i.id,saas_business.bg_agent_projection(i.content,true) AS content,i.updated_at FROM saas_business.workspace_memory_items i WHERE i.user_id=p_user_id AND i.workspace_id=p_workspace_id AND i.category='growth_prospect' ORDER BY i.updated_at DESC,i.id DESC LIMIT 500) q;
  END IF;
  RETURN jsonb_build_object('modules',v_modules,'crm',v_crm,'crmConsent',v_consent);
END $$;

-- Rapports conservés à l'initiative de l'utilisateur (aucun appel fournisseur).
CREATE TABLE IF NOT EXISTS saas_business.agent_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE,
  report_type text NOT NULL CHECK(report_type IN ('commercial','financial','customers','recovery','operations','health')),
  period_from date NOT NULL, period_to date NOT NULL CHECK(period_to>=period_from AND period_to-period_from<=365),
  idempotency_key uuid NOT NULL, document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key)
);
ALTER TABLE saas_business.agent_reports DROP CONSTRAINT IF EXISTS agent_reports_workspace_id_fkey;
ALTER TABLE saas_business.agent_reports ADD CONSTRAINT agent_reports_workspace_id_fkey FOREIGN KEY(workspace_id) REFERENCES saas_ugc.ugc_workspaces(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_reports_scope_idx ON saas_business.agent_reports(user_id,workspace_id,created_at DESC);
CREATE OR REPLACE FUNCTION saas_business.bg_save_agent_report(p_user_id uuid,p_workspace_id uuid,p_type text,p_from date,p_to date,p_idempotency_key uuid,p_document jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_row saas_business.agent_reports%ROWTYPE; v_created boolean:=false;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF p_workspace_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'workspace and idempotency key required'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  IF p_type NOT IN ('commercial','financial','customers','recovery','operations','health') OR p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>365
    OR p_document IS NULL OR jsonb_typeof(p_document)<>'object' OR length(p_document::text)>200000
  THEN RAISE EXCEPTION 'invalid report'; END IF;
  -- Un rejeu d'une sauvegarde déjà enregistrée retourne le même document,
  -- même si le consentement a été révoqué depuis. Les rapports conservés sont
  -- séparés de la mémoire et l'utilisateur en est informé.
  SELECT * INTO v_row FROM saas_business.agent_reports WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_row.workspace_id<>p_workspace_id OR v_row.report_type<>p_type OR v_row.period_from<>p_from OR v_row.period_to<>p_to THEN
      RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('id',v_row.id,'created',false,'report',v_row.document,'createdAt',v_row.created_at);
  END IF;
  -- Le diagnostic et la sauvegarde sont deux appels SQL distincts. Si la
  -- révocation a gagné la course entre les deux, ne pas enregistrer après
  -- coup un instantané qui contenait des données CRM consenties.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_document->'coverage')='array' THEN p_document->'coverage' ELSE '[]'::jsonb END
    ) AS c(value)
    WHERE c.value->>'category'='growth_prospect' AND c.value->>'status'='available'
  ) THEN PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id); END IF;
  IF (SELECT count(*) FROM saas_business.agent_reports WHERE user_id=p_user_id AND workspace_id=p_workspace_id)>=100 THEN
    RAISE EXCEPTION 'report limit reached' USING ERRCODE='54000';
  END IF;
  INSERT INTO saas_business.agent_reports(user_id,workspace_id,report_type,period_from,period_to,idempotency_key,document)
  VALUES(p_user_id,p_workspace_id,p_type,p_from,p_to,p_idempotency_key,p_document)
  ON CONFLICT(user_id,idempotency_key) DO NOTHING RETURNING * INTO v_row;
  v_created:=FOUND;
  IF NOT v_created THEN
    SELECT * INTO v_row FROM saas_business.agent_reports WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
    IF v_row.workspace_id<>p_workspace_id OR v_row.report_type<>p_type OR v_row.period_from<>p_from OR v_row.period_to<>p_to THEN
      RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN jsonb_build_object('id',v_row.id,'created',v_created,'report',v_row.document,'createdAt',v_row.created_at);
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_list_agent_reports(p_user_id uuid,p_workspace_id uuid)
RETURNS TABLE(id uuid,report_type text,period_from date,period_to date,document jsonb,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  RETURN QUERY SELECT r.id,r.report_type,r.period_from,r.period_to,r.document,r.created_at
    FROM saas_business.agent_reports r WHERE r.user_id=p_user_id AND r.workspace_id=p_workspace_id ORDER BY r.created_at DESC,r.id DESC LIMIT 100;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_delete_agent_report(p_user_id uuid,p_workspace_id uuid,p_report_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_report_id IS NULL THEN RAISE EXCEPTION 'workspace and report required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  DELETE FROM saas_business.agent_reports r WHERE r.id=p_report_id AND r.user_id=p_user_id AND r.workspace_id=p_workspace_id;
  RETURN FOUND;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_task_proposal_idempotency_idx
  ON saas_business.tool_executions(user_id,(input_args->>'idempotencyKey'))
  WHERE tool_name='create_follow_up_task' AND input_args ? 'idempotencyKey';

-- Récupère un enregistrement source autorisé ; la liste des catégories est
-- fermée, y compris le CRM consentant. Aucune requête libre n'est exécutée.
CREATE OR REPLACE FUNCTION saas_business.bg_agent_source(p_user_id uuid,p_workspace_id uuid,p_category text,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_data jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_source_id IS NULL THEN RAISE EXCEPTION 'workspace and source required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  IF p_category='growth_prospect' THEN
    PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id);
    SELECT content INTO v_data FROM saas_business.workspace_memory_items WHERE id=p_source_id AND user_id=p_user_id AND workspace_id=p_workspace_id AND category=p_category;
  ELSIF p_category IN ('bg_module_lead_rescue','bg_module_sales_automation','bg_module_customer_recovery','bg_module_payment_recovery',
    'bg_module_order_cart_recovery','bg_module_social_growth','bg_module_smart_inventory','bg_module_finance_intelligence',
    'bg_module_operations_manager','bg_module_customer_support_ai','bg_module_supplier_delivery','bg_module_dispute_shield','bg_module_revenue_leak') THEN
    SELECT data INTO v_data FROM saas_business.module_records WHERE id=p_source_id AND user_id=p_user_id AND workspace_id=p_workspace_id AND category=p_category;
  ELSE RAISE EXCEPTION 'invalid agent source'; END IF;
  IF v_data IS NULL OR jsonb_typeof(v_data)<>'object' THEN RAISE EXCEPTION 'agent source not found'; END IF;
  RETURN v_data;
END $$;
CREATE OR REPLACE FUNCTION saas_business.bg_agent_propose_task(p_user_id uuid,p_workspace_id uuid,p_conversation_id uuid,p_category text,p_source_id uuid,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_source jsonb; v_label text; v_title text; v_source_name text; v_priority text; v_id uuid; v_existing saas_business.tool_executions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF p_workspace_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'workspace and idempotency key required'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  IF NOT EXISTS(SELECT 1 FROM saas_business.conversations WHERE id=p_conversation_id AND user_id=p_user_id AND workspace_id=p_workspace_id) THEN RAISE EXCEPTION 'conversation not found'; END IF;
  -- Rejeu déterministe même si la source a changé ou disparu depuis la création.
  SELECT * INTO v_existing FROM saas_business.tool_executions WHERE user_id=p_user_id AND tool_name='create_follow_up_task' AND input_args->>'idempotencyKey'=p_idempotency_key::text;
  IF FOUND THEN
    IF v_existing.conversation_id<>p_conversation_id OR v_existing.input_args->>'sourceCategory'<>p_category OR v_existing.input_args->>'sourceRecordId'<>p_source_id::text THEN
      RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object('id',v_existing.id,'summary',v_existing.input_args->>'summary','status',v_existing.status);
  END IF;
  v_source:=saas_business.bg_agent_source(p_user_id,p_workspace_id,p_category,p_source_id);
  v_label:=left(regexp_replace(COALESCE(NULLIF(v_source->>'invoiceRef',''),NULLIF(v_source->>'reference',''),NULLIF(v_source->>'product',''),NULLIF(v_source->>'name',''),NULLIF(v_source->>'title',''),NULLIF(v_source->>'subject',''),NULLIF(v_source->>'supplier',''),NULLIF(v_source->>'label',''),'enregistrement'), '[[:cntrl:]]', ' ', 'g'),120);
  v_title:=left(CASE p_category WHEN 'bg_module_smart_inventory' THEN 'Préparer le réapprovisionnement : '
    WHEN 'bg_module_payment_recovery' THEN 'Préparer la relance de facture : '
    WHEN 'bg_module_order_cart_recovery' THEN 'Suivre le panier ou la commande : '
    WHEN 'bg_module_customer_recovery' THEN 'Préparer la réactivation : '
    WHEN 'bg_module_dispute_shield' THEN 'Suivre le litige : '
    WHEN 'bg_module_customer_support_ai' THEN 'Traiter la demande support : '
    WHEN 'bg_module_supplier_delivery' THEN 'Suivre la livraison : '
    WHEN 'bg_module_operations_manager' THEN 'Suivre la tâche : '
    WHEN 'bg_module_social_growth' THEN 'Préparer le contenu : '
    WHEN 'bg_module_finance_intelligence' THEN 'Examiner le mouvement financier : '
    WHEN 'bg_module_revenue_leak' THEN 'Examiner la fuite de revenu : '
    WHEN 'bg_module_sales_automation' THEN 'Examiner la règle commerciale : '
    ELSE 'Préparer le suivi commercial : ' END || v_label,200);
  v_source_name:=CASE p_category WHEN 'bg_module_lead_rescue' THEN 'lead_rescue' WHEN 'bg_module_payment_recovery' THEN 'payment_recovery'
    WHEN 'bg_module_customer_recovery' THEN 'customer_recovery' WHEN 'bg_module_order_cart_recovery' THEN 'order_cart_recovery'
    WHEN 'bg_module_smart_inventory' THEN 'smart_inventory' WHEN 'bg_module_customer_support_ai' THEN 'support'
    WHEN 'bg_module_sales_automation' THEN 'sales_automation' ELSE 'manuel' END;
  v_priority:=CASE WHEN p_category IN ('bg_module_payment_recovery','bg_module_lead_rescue','bg_module_dispute_shield') OR v_source->>'status'='rupture' THEN 'haute' ELSE 'moyenne' END;
  INSERT INTO saas_business.tool_executions(user_id,conversation_id,tool_name,risk_level,status,input_args)
  VALUES(p_user_id,p_conversation_id,'create_follow_up_task','write_requires_approval','pending_approval',jsonb_build_object(
    'summary',v_title,'sourceCategory',p_category,'sourceRecordId',p_source_id,'sourceFingerprint',md5(v_source::text),'idempotencyKey',p_idempotency_key,
    'task',jsonb_build_object('title',v_title,'status','a_faire','priority',v_priority,'dueDate',CURRENT_DATE::text,
      'source',v_source_name,'sourceCategory',p_category,'sourceRecordId',p_source_id,'notes','Proposition de l’agent ; aucun message ni action externe envoyé.')))
  ON CONFLICT(user_id,(input_args->>'idempotencyKey')) WHERE tool_name='create_follow_up_task' AND input_args ? 'idempotencyKey' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT * INTO v_existing FROM saas_business.tool_executions WHERE user_id=p_user_id AND tool_name='create_follow_up_task' AND input_args->>'idempotencyKey'=p_idempotency_key::text;
    IF v_existing.conversation_id<>p_conversation_id OR v_existing.input_args->>'sourceCategory'<>p_category OR v_existing.input_args->>'sourceRecordId'<>p_source_id::text THEN
      RAISE EXCEPTION 'idempotency key conflict' USING ERRCODE='23505';
    END IF;
    v_id:=v_existing.id;
  END IF;
  RETURN jsonb_build_object('id',v_id,'summary',v_title,'status',COALESCE(v_existing.status,'pending_approval'));
END $$;

-- La confirmation et l'effet métier sont atomiques dans la même transaction.
-- Les répétitions de la même décision renvoient le résultat déjà enregistré.
CREATE OR REPLACE FUNCTION saas_business.bg_agent_resolve_tool(p_user_id uuid,p_execution_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_tool saas_business.tool_executions%ROWTYPE; v_workspace uuid; v_source jsonb; v_status text; v_result jsonb;
  v_record_id uuid; v_memory_id uuid; v_category text; v_content jsonb; v_summary text; v_task jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'invalid tool decision'; END IF;
  -- Verrouiller le parent avant l'outil pour éviter l'inversion avec une
  -- suppression d'entreprise en cascade.
  SELECT c.workspace_id INTO v_workspace FROM saas_business.tool_executions t
    JOIN saas_business.conversations c ON c.id=t.conversation_id AND c.user_id=t.user_id
    WHERE t.id=p_execution_id AND t.user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool execution not found'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,true);
  SELECT * INTO v_tool FROM saas_business.tool_executions WHERE id=p_execution_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool execution not found'; END IF;
  IF v_tool.status IN ('executed','rejected','failed') THEN
    IF (v_tool.status='executed' AND p_decision='approved') OR (v_tool.status='rejected' AND p_decision='rejected') THEN
      RETURN jsonb_build_object('id',v_tool.id,'tool_name',v_tool.tool_name,'status',v_tool.status,'input_args',v_tool.input_args,'output_result',v_tool.output_result);
    END IF;
    RAISE EXCEPTION 'tool already resolved';
  END IF;
  IF p_decision='rejected' THEN
    UPDATE saas_business.tool_executions SET status='rejected',output_result=jsonb_build_object('rejectedByUser',true) WHERE id=v_tool.id;
    RETURN jsonb_build_object('id',v_tool.id,'tool_name',v_tool.tool_name,'status','rejected','input_args',v_tool.input_args,'output_result',jsonb_build_object('rejectedByUser',true));
  END IF;

  IF v_tool.tool_name='create_follow_up_task' THEN
    IF v_workspace IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
    v_category:=v_tool.input_args->>'sourceCategory';
    v_source:=saas_business.bg_agent_source(p_user_id,v_workspace,v_category,(v_tool.input_args->>'sourceRecordId')::uuid);
    IF v_tool.input_args->>'sourceFingerprint' IS DISTINCT FROM md5(v_source::text) THEN RAISE EXCEPTION 'agent source changed'; END IF;
    IF COALESCE(v_source->>'status',v_source->>'stage','') IN ('paye','recupere','resolu','termine','reactive','colmate','publie','converti','livre','gagne') THEN
      RAISE EXCEPTION 'agent source already resolved';
    END IF;
    v_task:=v_tool.input_args->'task';
    IF v_task IS NULL OR jsonb_typeof(v_task)<>'object' THEN RAISE EXCEPTION 'invalid task proposal'; END IF;
    SELECT id INTO v_record_id FROM saas_business.module_records
    WHERE user_id=p_user_id AND workspace_id=v_workspace AND category='bg_module_operations_manager'
      AND data->>'sourceCategory'=v_category AND data->>'sourceRecordId'=v_tool.input_args->>'sourceRecordId'
      AND data->>'status' IN ('a_faire','en_cours','bloque')
    ORDER BY created_at DESC LIMIT 1;
    IF v_record_id IS NULL THEN
      v_record_id:=saas_business.bg_create_scoped_module_record(p_user_id,v_workspace,'bg_module_operations_manager',v_task,'agent:'||v_tool.id::text);
    END IF;
    v_result:=jsonb_build_object('taskId',v_record_id,'module','operations-manager','externalAction',false);
  ELSIF v_tool.tool_name IN ('propose_memory_save','propose_action_plan','propose_campaign_brief') THEN
    v_summary:=left(COALESCE(NULLIF(v_tool.input_args->>'summary',''),NULLIF(v_tool.input_args->>'text',''),'Proposition approuvée'),1000);
    IF v_tool.tool_name='propose_action_plan' THEN
      v_category:='growth_strategy';
      v_content:=jsonb_build_object('title',left(COALESCE(NULLIF(v_tool.input_args->>'title',''),v_summary),160),
        'horizon',left(COALESCE(v_tool.input_args->>'horizon','À préciser'),80),'summary',v_summary,
        'actions',CASE WHEN jsonb_typeof(v_tool.input_args->'actions')='array' THEN v_tool.input_args->'actions' ELSE '[]'::jsonb END,
        'source','ia','createdAt',clock_timestamp());
    ELSIF v_tool.tool_name='propose_campaign_brief' THEN
      v_category:='business_campaign'; v_content:=jsonb_build_object('text',v_summary,'brief',v_tool.input_args);
    ELSE
      v_category:=COALESCE(NULLIF(v_tool.input_args->>'category',''),'business_context');
      IF v_category !~ '^[a-z][a-z0-9_]{1,79}$' THEN v_category:='business_context'; END IF;
      v_content:=jsonb_build_object('text',v_summary,'proposal',v_tool.input_args);
    END IF;
    v_memory_id:=saas_business.bg_put_scoped_memory_item(p_user_id,v_workspace,NULL,v_category,v_content,'conversation',v_tool.id);
    v_result:=jsonb_build_object('memoryItemId',v_memory_id,'category',v_category);
  ELSIF v_tool.tool_name='handoff_ugc_brief' THEN
    -- Brouillon uniquement, sans appel Studio ni débit de crédits.
    v_result:=jsonb_build_object('handoffDraft',v_tool.input_args || jsonb_build_object('consumesStudioCredits',false));
  ELSIF v_tool.tool_name='request_connector_read' THEN
    UPDATE saas_business.tool_executions SET status='failed',error_message='CONNECTOR_READ_NOT_IMPLEMENTED',output_result=jsonb_build_object('error','CONNECTOR_READ_NOT_IMPLEMENTED') WHERE id=v_tool.id;
    RETURN jsonb_build_object('id',v_tool.id,'tool_name',v_tool.tool_name,'status','failed','input_args',v_tool.input_args,'output_result',jsonb_build_object('error','CONNECTOR_READ_NOT_IMPLEMENTED'));
  ELSE
    RAISE EXCEPTION 'unsupported tool';
  END IF;
  UPDATE saas_business.tool_executions SET status='executed',approved_at=COALESCE(approved_at,clock_timestamp()),executed_at=clock_timestamp(),output_result=v_result WHERE id=v_tool.id;
  RETURN jsonb_build_object('id',v_tool.id,'tool_name',v_tool.tool_name,'status','executed','input_args',v_tool.input_args,'output_result',v_result);
END $$;

-- Conversion stricte d'une mesure d'automatisation, sans confondre un champ
-- absent/invalide avec zéro. Identique au domaine accepté par l'interface.
CREATE OR REPLACE FUNCTION saas_business.bg_automation_number(p_value jsonb)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE v_text text; v_number numeric;
BEGIN
  IF jsonb_typeof(p_value) NOT IN ('number','string') THEN RETURN NULL; END IF;
  v_text:=btrim(p_value#>>'{}');
  IF v_text !~ '^([0-9]+([.][0-9]*)?|[.][0-9]+)$' OR NOT pg_input_is_valid(v_text,'numeric') THEN RETURN NULL; END IF;
  v_number:=v_text::numeric;
  IF v_number<0 OR v_number>1000000000000 THEN RETURN NULL; END IF;
  RETURN v_number;
END $$;

-- Chaque élément du plan confirmé est créé transactionnellement si et seulement
-- si sa règle, sa source, son jour d'aperçu et son éligibilité sont inchangés.
-- L'appel ne contacte aucun fournisseur. Le lot client reste limité à 25 et
-- peut s'interrompre partiellement ; le rejeu renvoie la tâche déjà présente.
CREATE OR REPLACE FUNCTION saas_business.bg_confirm_automation_task(
  p_user_id uuid,p_workspace_id uuid,p_playbook_id uuid,p_source_category text,p_source_id uuid,
  p_preview_day date,p_expected_playbook jsonb,p_expected_source jsonb,p_task jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_rule jsonb; v_source jsonb; v_trigger text; v_expected_category text; v_status text;
  v_stock numeric; v_threshold numeric; v_delay numeric; v_eligible boolean:=false;
  v_id uuid; v_existing uuid; v_due text; v_key text;
BEGIN
  IF p_user_id IS NULL OR p_workspace_id IS NULL OR p_playbook_id IS NULL OR p_source_id IS NULL
     OR p_preview_day IS NULL OR p_expected_playbook IS NULL OR p_expected_source IS NULL OR p_task IS NULL
     OR jsonb_typeof(p_expected_playbook)<>'object' OR jsonb_typeof(p_expected_source)<>'object' OR jsonb_typeof(p_task)<>'object'
     OR pg_column_size(p_expected_playbook)>20000 OR pg_column_size(p_expected_source)>20000 OR pg_column_size(p_task)>20000
  THEN RAISE EXCEPTION 'invalid automation task'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);
  IF p_task->>'sourcePlaybookId' IS DISTINCT FROM p_playbook_id::text OR p_task->>'sourceRecordId' IS DISTINCT FROM p_source_id::text THEN
    RAISE EXCEPTION 'invalid automation task';
  END IF;
  v_key:=p_playbook_id::text||':'||p_source_id::text;
  SELECT r.id INTO v_existing FROM saas_business.module_records r WHERE r.user_id=p_user_id AND r.workspace_id=p_workspace_id
    AND r.category='bg_module_operations_manager' AND (r.dedupe_key=v_key OR
      (r.data->>'sourcePlaybookId'=p_playbook_id::text AND r.data->>'sourceRecordId'=p_source_id::text))
    ORDER BY r.created_at,r.id LIMIT 1;
  -- Le résultat d'une écriture déjà réalisée reste vérifiable même si sa
  -- source a changé ou que l'aperçu date de la veille : aucun nouvel effet.
  IF v_existing IS NOT NULL THEN RETURN jsonb_build_object('taskId',v_existing,'created',false); END IF;
  IF p_preview_day<>(clock_timestamp() AT TIME ZONE 'UTC')::date THEN RAISE EXCEPTION 'automation preview expired'; END IF;
  SELECT r.data INTO v_rule FROM saas_business.module_records r WHERE r.id=p_playbook_id AND r.user_id=p_user_id
    AND r.workspace_id=p_workspace_id AND r.category='bg_module_sales_automation' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'automation source changed'; END IF;
  SELECT r.data INTO v_source FROM saas_business.module_records r WHERE r.id=p_source_id AND r.user_id=p_user_id
    AND r.workspace_id=p_workspace_id AND r.category=p_source_category FOR SHARE;
  IF NOT FOUND OR v_rule IS DISTINCT FROM p_expected_playbook OR v_source IS DISTINCT FROM p_expected_source THEN
    RAISE EXCEPTION 'automation source changed';
  END IF;
  v_trigger:=v_rule->>'trigger';
  v_expected_category:=CASE v_trigger WHEN 'nouveau_prospect' THEN 'bg_module_lead_rescue'
    WHEN 'panier_abandonne' THEN 'bg_module_order_cart_recovery' WHEN 'facture_echue' THEN 'bg_module_payment_recovery'
    WHEN 'client_inactif' THEN 'bg_module_customer_recovery' WHEN 'stock_bas' THEN 'bg_module_smart_inventory' ELSE NULL END;
  IF v_rule->>'status' IS DISTINCT FROM 'actif' OR v_expected_category IS DISTINCT FROM p_source_category THEN RAISE EXCEPTION 'automation source no longer eligible'; END IF;
  v_status:=COALESCE(v_source->>'status','');
  CASE v_trigger
    WHEN 'nouveau_prospect' THEN v_eligible:=v_status='nouveau';
    WHEN 'panier_abandonne' THEN v_eligible:=v_status IN ('panier','commande');
    WHEN 'client_inactif' THEN v_eligible:=v_status IN ('a_risque','contacte');
    WHEN 'facture_echue' THEN
      v_eligible:=v_status='en_retard'; v_due:=v_source->>'dueDate';
      IF NOT v_eligible AND v_status IN ('a_echeance','relance') AND v_due ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND pg_input_is_valid(v_due,'date') THEN v_eligible:=v_due::date<p_preview_day; END IF;
    WHEN 'stock_bas' THEN
      v_stock:=saas_business.bg_automation_number(v_source->'stock');
      v_threshold:=saas_business.bg_automation_number(v_source->'threshold');
      v_eligible:=v_stock IS NOT NULL AND (v_stock=0 OR (v_threshold IS NOT NULL AND v_stock<=v_threshold));
    ELSE v_eligible:=false;
  END CASE;
  IF NOT v_eligible THEN RAISE EXCEPTION 'automation source no longer eligible'; END IF;
  v_delay:=saas_business.bg_automation_number(v_rule->'delayDays');
  IF v_rule->'delayDays' IS NULL OR v_rule->'delayDays'='null'::jsonb OR v_rule->>'delayDays'='' THEN v_delay:=0; END IF;
  IF v_delay IS NULL OR v_delay<>trunc(v_delay) OR v_delay>3650 THEN RAISE EXCEPTION 'invalid automation delay'; END IF;
  IF p_task->>'status' IS DISTINCT FROM 'a_faire' OR p_task->>'source' IS DISTINCT FROM 'sales_automation'
    OR p_task->>'sourcePlaybookId' IS DISTINCT FROM p_playbook_id::text OR p_task->>'sourceRecordId' IS DISTINCT FROM p_source_id::text
    OR p_task->>'dueDate' IS DISTINCT FROM (p_preview_day+v_delay::integer)::text
    OR p_task->>'priority' IS DISTINCT FROM (CASE WHEN v_trigger='facture_echue' THEN 'haute' ELSE 'moyenne' END)
    OR jsonb_typeof(p_task->'title') IS DISTINCT FROM 'string' OR length(btrim(p_task->>'title'))=0
  THEN RAISE EXCEPTION 'invalid automation task'; END IF;
  v_id:=saas_business.bg_create_scoped_module_record(p_user_id,p_workspace_id,'bg_module_operations_manager',p_task,v_key);
  RETURN jsonb_build_object('taskId',v_id,'created',true);
END $$;

-- Une décision transmise par le frontend d'entreprise doit aussi désigner
-- l'entreprise de la proposition, pas seulement un identifiant appartenant au compte.
CREATE OR REPLACE FUNCTION saas_business.bg_agent_resolve_scoped_tool(p_user_id uuid,p_workspace_id uuid,p_execution_id uuid,p_decision text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  IF NOT EXISTS(SELECT 1 FROM saas_business.tool_executions t
    JOIN saas_business.conversations c ON c.id=t.conversation_id AND c.user_id=t.user_id
    WHERE t.id=p_execution_id AND t.user_id=p_user_id AND c.workspace_id=p_workspace_id) THEN
    RAISE EXCEPTION 'tool execution not found';
  END IF;
  RETURN saas_business.bg_agent_resolve_tool(p_user_id,p_execution_id,p_decision);
END $$;

-- L'ancien resolveur ne réalise pas d'effet atomique et peut écrire dans la
-- mémoire personnelle. Pour une entreprise, il ne peut que rejeter ; les
-- approbations passent obligatoirement par bg_agent_resolve_tool.
CREATE OR REPLACE FUNCTION saas_business.bg_resolve_tool_execution(p_user_id uuid,p_execution_id uuid,p_decision text,p_output_result jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_row saas_business.tool_executions%ROWTYPE; v_workspace uuid;
BEGIN
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected','executed','failed') THEN RAISE EXCEPTION 'invalid tool decision'; END IF;
  SELECT c.workspace_id INTO v_workspace FROM saas_business.tool_executions t
    JOIN saas_business.conversations c ON c.id=t.conversation_id AND c.user_id=t.user_id
    WHERE t.id=p_execution_id AND t.user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool execution not found'; END IF;
  IF v_workspace IS NOT NULL THEN
    IF p_decision='rejected' THEN RETURN saas_business.bg_agent_resolve_tool(p_user_id,p_execution_id,'rejected'); END IF;
    RAISE EXCEPTION 'workspace tool requires atomic service';
  END IF;
  UPDATE saas_business.tool_executions
  SET status=p_decision,
      approved_at=CASE WHEN p_decision IN ('approved','executed') THEN COALESCE(approved_at,clock_timestamp()) ELSE approved_at END,
      executed_at=CASE WHEN p_decision='executed' THEN clock_timestamp() ELSE executed_at END,
      output_result=COALESCE(p_output_result,output_result)
  WHERE id=p_execution_id AND user_id=p_user_id AND status IN ('pending_approval','approved') RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'tool execution not found or already resolved'; END IF;
  RETURN jsonb_build_object('id',v_row.id,'tool_name',v_row.tool_name,'status',v_row.status,'input_args',v_row.input_args,'output_result',v_row.output_result);
END $$;

CREATE OR REPLACE FUNCTION saas_business.bg_create_tool_execution(p_user_id uuid,p_conversation_id uuid,p_request_id uuid,p_tool_name text,p_risk_level text,p_input_args jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid; v_workspace uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  SELECT workspace_id INTO v_workspace FROM saas_business.conversations WHERE id=p_conversation_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);
  IF p_tool_name NOT IN ('propose_memory_save','propose_action_plan','propose_campaign_brief','handoff_ugc_brief','request_connector_read')
    OR p_input_args IS NULL OR jsonb_typeof(p_input_args)<>'object' OR length(p_input_args::text)>12000 THEN RAISE EXCEPTION 'invalid tool proposal'; END IF;
  IF NOT EXISTS(SELECT 1 FROM saas_business.ai_requests WHERE id=p_request_id AND user_id=p_user_id AND conversation_id=p_conversation_id) THEN RAISE EXCEPTION 'request not found'; END IF;
  INSERT INTO saas_business.tool_executions(user_id,conversation_id,request_id,tool_name,risk_level,status,input_args)
  VALUES(p_user_id,p_conversation_id,p_request_id,p_tool_name,COALESCE(NULLIF(p_risk_level,''),'write_requires_approval'),'pending_approval',p_input_args) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_memory_consent_events','workspace_memory_profiles','workspace_memory_items','agent_reports'] LOOP
    EXECUTE format('ALTER TABLE saas_business.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE saas_business.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('DROP POLICY IF EXISTS agent_owner ON saas_business.%I',t);
    EXECUTE format('CREATE POLICY agent_owner ON saas_business.%I TO bg_owner USING (true) WITH CHECK (true)',t);
    EXECUTE format('REVOKE ALL ON saas_business.%I FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure',t);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE saas_business.workspace_memory_consent_events_event_id_seq FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure;

-- Exposition minimale : uniquement les services Edge nommés, jamais les tables
-- ou les aides internes. La fonction SECURITY DEFINER contrôle chaque périmètre.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='saas_business' AND p.proname=ANY(ARRAY[
      'bg_can_workspace','bg_require_workspace','bg_lock_workspace_access','bg_agent_projection','bg_automation_number','bg_module_validate','bg_require_scoped_consent','bg_agent_source','reject_workspace_consent_mutation',
      'bg_list_scoped_module_records','bg_create_scoped_module_record','bg_update_scoped_module_record','bg_delete_scoped_module_record',
      'bg_list_module_records','bg_create_module_record','bg_update_module_record','bg_delete_module_record',
      'bg_get_scoped_memory','bg_set_scoped_memory_consent','bg_upsert_scoped_memory_profile','bg_put_scoped_memory_item','bg_delete_scoped_memory_item','bg_import_legacy_memory',
      'bg_list_scoped_integration_connections','bg_request_scoped_integration_connection','bg_cancel_scoped_integration_request','bg_disconnect_scoped_integration_connection',
      'bg_confirm_automation_task','bg_agent_resolve_scoped_tool','bg_conversation_scope','bg_list_scoped_conversations','bg_list_scoped_recent_requests','bg_business_snapshot','bg_save_agent_report','bg_list_agent_reports','bg_delete_agent_report','bg_agent_propose_task','bg_agent_resolve_tool'
    ])
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, bg_edge, bg_billing_worker, bg_erasure',f.sig); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION saas_business.bg_confirm_automation_task(uuid,uuid,uuid,text,uuid,date,jsonb,jsonb,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_agent_resolve_scoped_tool(uuid,uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_scoped_integration_connections(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_request_scoped_integration_connection(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_cancel_scoped_integration_request(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_disconnect_scoped_integration_connection(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_scoped_module_records(uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_scoped_module_record(uuid,uuid,text,jsonb,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_update_scoped_module_record(uuid,uuid,uuid,text,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_scoped_module_record(uuid,uuid,uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_module_records(uuid,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_create_module_record(uuid,text,jsonb,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_update_module_record(uuid,uuid,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_module_record(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_get_scoped_memory(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_set_scoped_memory_consent(uuid,uuid,boolean,text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_upsert_scoped_memory_profile(uuid,uuid,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_put_scoped_memory_item(uuid,uuid,uuid,text,jsonb,text,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_scoped_memory_item(uuid,uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_import_legacy_memory(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_conversation_scope(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_scoped_conversations(uuid,uuid,integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_scoped_recent_requests(uuid,uuid,integer) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_business_snapshot(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_save_agent_report(uuid,uuid,text,date,date,uuid,jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_list_agent_reports(uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_delete_agent_report(uuid,uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_agent_propose_task(uuid,uuid,uuid,text,uuid,uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_agent_resolve_tool(uuid,uuid,text) TO bg_edge;

-- Conserve l'effacement existant (intégrations + mémoire historique) et couvre
-- les nouvelles tables. Le drapeau autorise la suppression du journal append-only.
CREATE OR REPLACE FUNCTION saas_business.bg_prepare_account_erasure(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_user_id) THEN RAISE EXCEPTION 'user not found'; END IF;
  PERFORM pg_catalog.set_config('saas_business.erasure_active','on',true);
  DELETE FROM saas_business.integration_connections WHERE user_id=p_user_id;
  DELETE FROM saas_business.module_records WHERE user_id=p_user_id;
  DELETE FROM saas_business.agent_reports WHERE user_id=p_user_id;
  DELETE FROM saas_business.workspace_memory_consent_events WHERE user_id=p_user_id;
  DELETE FROM saas_business.workspace_memory_profiles WHERE user_id=p_user_id;
  DELETE FROM saas_business.workspace_memory_items WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_consent_events WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_profiles WHERE user_id=p_user_id;
  DELETE FROM saas_business.memory_items WHERE user_id=p_user_id;
  PERFORM pg_catalog.set_config('saas_business.erasure_active','off',true);
END $$;
GRANT EXECUTE ON FUNCTION saas_business.bg_prepare_account_erasure(uuid) TO bg_erasure;

-- Le service récent enregistre le message en recontrôlant le rattachement et
-- les droits dans la même transaction, avant tout appel au fournisseur.
CREATE OR REPLACE FUNCTION saas_business.bg_submit_scoped_user_message(
  p_user_id uuid,p_conversation_id uuid,p_content text,p_idempotency_key text,
  p_request_hash text,p_role_key text
) RETURNS TABLE(request_id uuid,input_message_id uuid,status text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_request saas_business.ai_requests%ROWTYPE; v_message_id uuid; v_workspace uuid; v_locked_workspace uuid;
BEGIN
  IF p_user_id IS NULL OR p_conversation_id IS NULL OR p_content IS NULL
     OR btrim(p_content)='' OR length(p_content)>12000
     OR p_idempotency_key IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'invalid message request';
  END IF;
  SELECT workspace_id INTO v_workspace FROM saas_business.conversations WHERE id=p_conversation_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);
  -- Empêcher une modification concurrente du rattachement entre contrôle et
  -- insertion, en gardant le même ordre de verrou que les autres mutations.
  SELECT workspace_id INTO v_locked_workspace FROM saas_business.conversations
  WHERE id=p_conversation_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_locked_workspace IS DISTINCT FROM v_workspace THEN RAISE EXCEPTION 'conversation scope changed'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||p_idempotency_key,0));
  SELECT * INTO v_request FROM saas_business.ai_requests
  WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF v_request.request_hash<>p_request_hash OR v_request.conversation_id<>p_conversation_id THEN
      RAISE EXCEPTION 'idempotency key reused with different request';
    END IF;
    request_id:=v_request.id;
    input_message_id:=v_request.input_message_id;
    status:=v_request.status;
    created:=false;
    RETURN NEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM saas_business.conversations
    WHERE id=p_conversation_id AND user_id=p_user_id
  ) THEN RAISE EXCEPTION 'conversation not found'; END IF;
  INSERT INTO saas_business.messages(user_id,conversation_id,author_role,content)
  VALUES(p_user_id,p_conversation_id,'user',p_content)
  RETURNING id INTO v_message_id;
  UPDATE saas_business.conversations SET updated_at=clock_timestamp()
  WHERE id=p_conversation_id AND user_id=p_user_id;
  INSERT INTO saas_business.ai_requests(
    user_id,conversation_id,idempotency_key,request_hash,role_key,input_message_id
  ) VALUES (
    p_user_id,p_conversation_id,p_idempotency_key,p_request_hash,p_role_key,v_message_id
  ) RETURNING id INTO request_id;
  input_message_id:=v_message_id;
  status:='queued';
  created:=true;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION saas_business.bg_submit_scoped_user_message(uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;
GRANT EXECUTE ON FUNCTION saas_business.bg_submit_scoped_user_message(uuid,uuid,text,text,text,text) TO bg_edge;

-- L'Edge v22 ajoute la mémoire personnelle au prompt avant d'appeler cette
-- ancienne RPC. Même une conversation personnelle peut être envoyée avec un
-- workspace dans son corps HTTP, information absente de la signature SQL.
-- Refuser TOUT envoi v22 après migration : les lectures historiques restent
-- possibles, et seul le nouveau service peut appeler la RPC contrôlée ci-dessus.
CREATE OR REPLACE FUNCTION saas_business.bg_submit_user_message(
  p_user_id uuid,p_conversation_id uuid,p_content text,p_idempotency_key text,
  p_request_hash text,p_role_key text
) RETURNS TABLE(request_id uuid,input_message_id uuid,status text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  RAISE EXCEPTION 'legacy message requires v3 protocol' USING ERRCODE='0A000';
END $$;

-- Marqueur transactionnel du protocole d'entreprise : les opérations v3 ne
-- sont acceptées que si cette migration entière a été installée et que le
-- compte conserve l'accès à l'entreprise.
CREATE OR REPLACE FUNCTION saas_business.bg_workspace_protocol(p_user_id uuid,p_workspace_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
BEGIN
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
  PERFORM saas_business.bg_require_workspace(p_user_id,p_workspace_id,false);
  RETURN 'business-workspace-v3';
END $$;

REVOKE ALL ON FUNCTION saas_business.bg_workspace_protocol(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,bg_edge,bg_billing_worker,bg_erasure;
GRANT EXECUTE ON FUNCTION saas_business.bg_workspace_protocol(uuid,uuid) TO bg_edge;
