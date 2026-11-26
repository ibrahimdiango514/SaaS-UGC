-- Business Grow — l'agent propose une ACTION MÉTIER, sans l'exécuter.
--
-- MIGRATION ADDITIVE UNIQUEMENT :
--   * aucune table créée, aucune colonne supprimée ni renommée ;
--   * aucune donnée existante déplacée ;
--   * les deux fonctions redéfinies gardent leur signature et leur comportement
--     pour tous les outils existants — seule une branche est ajoutée.
--
-- ## Pourquoi cette migration
-- Le chat savait produire des propositions de mémoire, de plan, de campagne et
-- de brief vidéo. Il ne savait pas proposer une action du socle (créer une
-- facture, planifier une relance, ouvrir un litige, enregistrer un paiement…).
-- Résultat : « l'agent qui agit » s'arrêtait à la porte des actes métier.
--
-- ## Ce que fait la nouvelle branche
-- `propose_business_action` est ACCEPTÉ, puis, à l'approbation, il dépose une
-- entrée `proposee` dans le journal de l'agent (`bg_module_agent_journal`).
--
-- Elle n'écrit AUCUNE donnée métier :
--   * la facture, la relance ou le litige ne sont pas créés ;
--   * l'entrée est `proposee`, `annulable = false`, `enregistrementId = NULL` ;
--   * l'utilisateur retrouve la proposition dans l'historique et décide.
--
-- C'est la seule façon de tenir la promesse « je prépare, tu valides » : si
-- l'approbation créait directement la facture, approuver et exécuter seraient
-- le même geste, et l'écran d'historique n'aurait plus rien à annuler.

-- ---------------------------------------------------------------------------
-- 1. Accepter le nouvel outil à la création de la proposition
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_business.bg_create_tool_execution(
  p_user_id uuid,
  p_conversation_id uuid,
  p_request_id uuid,
  p_tool_name text,
  p_risk_level text,
  p_input_args jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid; v_workspace uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  SELECT workspace_id INTO v_workspace FROM saas_business.conversations WHERE id=p_conversation_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);

  /*
   * Liste FERMÉE : un nom d'outil inconnu est refusé, pas rangé dans un cas
   * générique. Un fournisseur IA ne doit pas pouvoir inventer un outil.
   */
  IF p_tool_name NOT IN (
      'propose_memory_save','propose_action_plan','propose_campaign_brief',
      'handoff_ugc_brief','request_connector_read','propose_business_action'
  )
    OR p_input_args IS NULL OR jsonb_typeof(p_input_args)<>'object' OR length(p_input_args::text)>12000
  THEN RAISE EXCEPTION 'invalid tool proposal'; END IF;

  /*
   * Contrôles SPÉCIFIQUES à l'action métier, faits ici et pas seulement dans le
   * handler : la fonction SQL est appelable indépendamment de l'Edge.
   */
  IF p_tool_name = 'propose_business_action' THEN
    IF COALESCE(p_input_args->>'outil','') NOT IN (
      'creer_facture','modifier_facture','creer_devis','planifier_relance','creer_tache',
      'ajouter_contact','ouvrir_litige','enregistrer_paiement','preparer_message'
    ) THEN RAISE EXCEPTION 'invalid business action tool'; END IF;
    IF length(btrim(COALESCE(p_input_args->>'resume',''))) = 0 THEN
      RAISE EXCEPTION 'invalid business action summary';
    END IF;
    IF jsonb_typeof(p_input_args->'donnees') <> 'object' THEN
      RAISE EXCEPTION 'invalid business action payload';
    END IF;
    -- Une proposition ne s'exécute pas : le drapeau doit être explicitement faux.
    IF COALESCE(p_input_args->>'execute','false') <> 'false' THEN
      RAISE EXCEPTION 'business action cannot self-execute';
    END IF;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM saas_business.ai_requests WHERE id=p_request_id AND user_id=p_user_id AND conversation_id=p_conversation_id) THEN RAISE EXCEPTION 'request not found'; END IF;
  INSERT INTO saas_business.tool_executions(user_id,conversation_id,request_id,tool_name,risk_level,status,input_args)
  VALUES(p_user_id,p_conversation_id,p_request_id,p_tool_name,COALESCE(NULLIF(p_risk_level,''),'write_requires_approval'),'pending_approval',p_input_args) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Résoudre la proposition : déposer une entrée `proposee`, rien de plus
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_business.bg_agent_resolve_tool(
  p_user_id uuid, p_execution_id uuid, p_decision text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_tool saas_business.tool_executions%ROWTYPE; v_workspace uuid; v_source jsonb; v_status text; v_result jsonb;
  v_record_id uuid; v_memory_id uuid; v_category text; v_content jsonb; v_summary text; v_task jsonb;
  v_journal_id uuid;
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
  ELSIF v_tool.tool_name = 'propose_business_action' THEN
    /*
     * APPROBATION D'UNE ACTION MÉTIER = une proposition journalisée.
     *
     * Aucune écriture métier ici : `bg_journal_append` reconstruit l'entrée à
     * partir des seuls champs connus, ignore les clés inconnues, et le statut
     * est fixé à « proposee ». Une seconde approbation de la même exécution
     * renvoie le résultat initial (statut déjà `executed`), donc aucun doublon.
     */
    IF v_workspace IS NULL THEN RAISE EXCEPTION 'workspace required'; END IF;
    v_journal_id := saas_business.bg_journal_append(
      p_user_id,
      v_workspace,
      jsonb_build_object(
        'outil',          v_tool.input_args->>'outil',
        'resume',         left(COALESCE(v_tool.input_args->>'resume','Action préparée'), 400),
        'statut',         'proposee',
        'decidePar',      'utilisateur',
        'apres',          CASE WHEN jsonb_typeof(v_tool.input_args->'donnees')='object'
                               THEN v_tool.input_args->'donnees' ELSE NULL END,
        'resultat',       'Proposition approuvée : rien n’a été exécuté. L’action attend votre décision dans l’historique.',
        'categorie',      NULLIF(left(COALESCE(v_tool.input_args->>'categorie',''),80),''),
        'enregistrementId', NULL,
        'annulable',      'false'
      )
    );
    v_result:=jsonb_build_object(
      'journalEntryId', v_journal_id,
      'executed', false,
      'externalAction', false
    );
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

-- ---------------------------------------------------------------------------
-- 3. Privilèges inchangés, mais re-affirmés
-- ---------------------------------------------------------------------------
-- Redéfinir une fonction peut réinitialiser ses privilèges : on les remet à
-- l'identique (aucun accès anonyme, exécution réservée au rôle serveur).
REVOKE ALL ON FUNCTION saas_business.bg_create_tool_execution(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION saas_business.bg_agent_resolve_tool(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION saas_business.bg_create_tool_execution(uuid, uuid, uuid, text, text, jsonb) TO bg_edge;
GRANT EXECUTE ON FUNCTION saas_business.bg_agent_resolve_tool(uuid, uuid, text) TO bg_edge;
