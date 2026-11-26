-- Business Grow — autonomie de l'agent, journal des actions et préférences.
--
-- MIGRATION ADDITIVE UNIQUEMENT :
--   * aucune table existante modifiée ;
--   * aucune colonne supprimée ni renommée ;
--   * aucune donnée touchée (les dossiers de litige et les règles existent déjà
--     dans `saas_business.module_records`, ils ne sont pas déplacés).
--
-- Pourquoi trois catégories et une préférence plutôt qu'une table par objet :
-- le socle applicatif (`module_records`) est déjà cloisonné par entreprise, ses
-- lectures/écritures passent par des fonctions SQL qui vérifient l'appartenance
-- (`bg_require_workspace`), et chaque catégorie est validée par
-- `bg_module_validate`. Créer des tables parallèles aurait dupliqué cette
-- sécurité — et une seconde voie d'accès est une seconde occasion de fuite.
--
-- Les trois catégories :
--   bg_module_agent_journal      : qui, quand, quoi, avant/après, résultat
--   bg_module_agent_autonomy     : niveau d'autonomie PAR OUTIL et PAR ESPACE
--   bg_module_agent_write_quota  : garde-fou de volume (voir plus bas)
--
-- Les dossiers de litige (`bg_module_receivable_disputes`) et les règles
-- (`bg_module_automation_rules`) existent déjà : ils sont seulement COMPLÉTÉS
-- par des champs optionnels côté applicatif, sans migration de données.

-- ---------------------------------------------------------------------------
-- 1. Garde-fou de volume du journal
-- ---------------------------------------------------------------------------
-- Le journal grandit à chaque demande et à chaque action. Les 500
-- enregistrements par catégorie imposés par `bg_create_scoped_module_record`
-- arrêteraient un espace de travail actif en quelques semaines. On lève la
-- limite pour la SEULE catégorie du journal, en la remplaçant par une limite
-- plus haute (5 000) et, surtout, sans toucher aux autres catégories.
--
-- Ce n'est pas un contournement : la limite existe pour éviter l'explosion de
-- volume, et 5 000 entrées d'audit restent bornées. Au-delà, l'écriture échoue
-- franchement (l'appelant doit purger), plutôt que de tourner en silence.
CREATE OR REPLACE FUNCTION saas_business.bg_agent_journal_limit()
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 5000 $$;

-- ---------------------------------------------------------------------------
-- 2. Préférences d'autonomie — lecture et écriture
-- ---------------------------------------------------------------------------
-- Une préférence par (espace, outil). Le niveau est FERMÉ par défaut côté
-- applicatif : l'absence de ligne signifie « je prépare, tu valides », jamais
-- « automatique ». Cette fonction ne renvoie donc que ce qui a été
-- explicitement enregistré.
CREATE OR REPLACE FUNCTION saas_business.bg_get_agent_autonomy(
  p_user_id uuid,
  p_workspace_id uuid
) RETURNS TABLE(tool_name text, level text, rule_id text, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
BEGIN
  PERFORM saas_business.bg_require_workspace(p_user_id, p_workspace_id, false);
  RETURN QUERY
    SELECT r.data ->> 'toolName',
           r.data ->> 'level',
           NULLIF(btrim(r.data ->> 'ruleId'), ''),
           r.updated_at
    FROM saas_business.module_records r
    WHERE r.user_id = p_user_id
      AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id
      AND r.category = 'bg_module_agent_autonomy'
    ORDER BY r.data ->> 'toolName';
END $$;

-- Écriture d'un niveau. Trois valeurs acceptées, aucune autre : une valeur
-- inconnue est refusée à la source plutôt que normalisée en silence.
CREATE OR REPLACE FUNCTION saas_business.bg_set_agent_autonomy(
  p_user_id uuid,
  p_workspace_id uuid,
  p_tool_name text,
  p_level text,
  p_rule_id text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_datasets jsonb;
  v_record_id uuid;
BEGIN
  -- L'écriture exige les droits d'écriture sur l'entreprise.
  PERFORM saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);

  IF p_level NOT IN ('lecture', 'preparation', 'automatique') THEN
    RAISE EXCEPTION 'invalid autonomy level' USING ERRCODE = '22023';
  END IF;
  IF p_tool_name IS NULL OR btrim(p_tool_name) = '' OR length(p_tool_name) > 60 THEN
    RAISE EXCEPTION 'invalid tool name' USING ERRCODE = '22023';
  END IF;
  -- Le niveau « automatique » n'est JAMAIS enregistré sans règle nommée.
  -- La décision applicative peut être plus stricte encore (argent/client/envoi),
  -- mais elle ne peut pas être plus permissive que cette contrainte.
  IF p_level = 'automatique' AND (p_rule_id IS NULL OR btrim(p_rule_id) = '') THEN
    RAISE EXCEPTION 'automatic level requires a named rule' USING ERRCODE = '22023';
  END IF;

  v_datasets := jsonb_build_object(
    'toolName', btrim(p_tool_name),
    'level', p_level,
    'ruleId', NULLIF(btrim(p_rule_id), '')
  );

  SELECT r.id INTO v_record_id
  FROM saas_business.module_records r
  WHERE r.user_id = p_user_id
    AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id
    AND r.category = 'bg_module_agent_autonomy'
    AND r.data ->> 'toolName' = btrim(p_tool_name)
  FOR UPDATE;

  IF v_record_id IS NOT NULL THEN
    UPDATE saas_business.module_records
    SET data = v_datasets
    WHERE id = v_record_id;
    RETURN true;
  END IF;

  PERFORM saas_business.bg_create_scoped_module_record(
    p_user_id, p_workspace_id, 'bg_module_agent_autonomy', v_datasets,
    'autonomy:' || btrim(p_tool_name)
  );
  RETURN true;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Journal — écriture bornée et lecture paginée
-- ---------------------------------------------------------------------------
-- `bg_journal_append` n'accepte QUE des champs connus : un appelant ne peut pas
-- écrire un statut arbitraire. Le statut est déduit de l'action, pas choisi.
CREATE OR REPLACE FUNCTION saas_business.bg_journal_append(
  p_user_id uuid,
  p_workspace_id uuid,
  p_entry jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_entry jsonb;
  v_status text;
  v_count integer;
  v_record_id uuid;
BEGIN
  PERFORM saas_business.bg_lock_workspace_access(p_user_id, p_workspace_id, true);

  IF p_entry IS NULL OR jsonb_typeof(p_entry) <> 'object' THEN
    RAISE EXCEPTION 'journal entry must be an object' USING ERRCODE = '22023';
  END IF;

  v_status := COALESCE(p_entry ->> 'statut', 'proposee');
  IF v_status NOT IN ('proposee','validee','refusee','executee','echouee','annulee') THEN
    RAISE EXCEPTION 'invalid journal status' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count
  FROM saas_business.module_records r
  WHERE r.user_id = p_user_id
    AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id
    AND r.category = 'bg_module_agent_journal';
  IF v_count >= saas_business.bg_agent_journal_limit() THEN
    RAISE EXCEPTION 'journal limit reached' USING ERRCODE = '54000';
  END IF;

  -- On reconstruit l'objet : les clés inconnues sont IGNORÉES, pas recopiées.
  v_entry := jsonb_build_object(
    'horodatage', COALESCE(p_entry ->> 'horodatage', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
    'outil', NULLIF(p_entry ->> 'outil', ''),
    'resume', left(COALESCE(p_entry ->> 'resume', ''), 400),
    'statut', v_status,
    'decidePar', CASE WHEN p_entry ->> 'decidePar' = 'regle' THEN 'regle' ELSE 'utilisateur' END,
    'regleId', NULLIF(left(COALESCE(p_entry ->> 'regleId', ''), 80), ''),
    'avant', CASE WHEN jsonb_typeof(p_entry -> 'avant') = 'object' THEN p_entry -> 'avant' ELSE NULL END,
    'apres', CASE WHEN jsonb_typeof(p_entry -> 'apres') = 'object' THEN p_entry -> 'apres' ELSE NULL END,
    'resultat', left(COALESCE(p_entry ->> 'resultat', ''), 600),
    'enregistrementId', NULLIF(left(COALESCE(p_entry ->> 'enregistrementId', ''), 64), ''),
    'categorie', CASE WHEN COALESCE(p_entry ->> 'categorie', '') ~ '^bg_module_[a-z0-9_]{2,60}$'
                      THEN p_entry ->> 'categorie' ELSE NULL END,
    'annulable', COALESCE(p_entry ->> 'annulable', 'false') = 'true'
  );

  PERFORM saas_business.bg_module_validate('bg_module_agent_journal', v_entry);

  -- Insertion DIRECTE, et non via `bg_create_scoped_module_record` : cette
  -- fonction applique une limite de 500 enregistrements par catégorie, ce qui
  -- arrêterait le journal en quelques semaines. La limite dédiée
  -- (`bg_agent_journal_limit`, 5 000) a été vérifiée juste au-dessus, et les
  -- droits d'écriture ont été vérifiés par `bg_lock_workspace_access`.
  -- Modifier la fonction partagée aurait changé le comportement des 9 autres
  -- catégories métier : on ne le fait pas.
  INSERT INTO saas_business.module_records (user_id, workspace_id, category, data, dedupe_key)
  VALUES (p_user_id, p_workspace_id, 'bg_module_agent_journal', v_entry, NULL)
  RETURNING id INTO v_record_id;

  RETURN v_record_id;
END $$;

-- Lecture paginée : `p_before` permet de remonter le journal sans charger
-- 5 000 entrées d'un coup sur un téléphone.
CREATE OR REPLACE FUNCTION saas_business.bg_journal_list(
  p_user_id uuid,
  p_workspace_id uuid,
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
) RETURNS TABLE(id uuid, data jsonb, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, saas_business AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  PERFORM saas_business.bg_require_workspace(p_user_id, p_workspace_id, false);
  RETURN QUERY
    SELECT r.id, r.data, r.created_at
    FROM saas_business.module_records r
    WHERE r.user_id = p_user_id
      AND r.workspace_id IS NOT DISTINCT FROM p_workspace_id
      AND r.category = 'bg_module_agent_journal'
      AND (p_before IS NULL OR r.created_at < p_before)
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT v_limit;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Privilèges — rien pour anon, rien pour les rôles serveur non concernés
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION saas_business.bg_agent_journal_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION saas_business.bg_get_agent_autonomy(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION saas_business.bg_set_agent_autonomy(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION saas_business.bg_journal_append(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION saas_business.bg_journal_list(uuid, uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION saas_business.bg_agent_journal_limit() TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_get_agent_autonomy(uuid, uuid) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_set_agent_autonomy(uuid, uuid, text, text, text) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_journal_append(uuid, uuid, jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_journal_list(uuid, uuid, integer, timestamptz) TO bg_edge;
