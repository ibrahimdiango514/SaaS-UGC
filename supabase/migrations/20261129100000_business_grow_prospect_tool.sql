-- =============================================================================
-- VYORA Business Grow — l'agent peut ENREGISTRER un prospect (réellement)
-- =============================================================================
--
-- ## Le défaut corrigé
--
-- L'assistant affirmait avoir enregistré des prospects qui n'existaient nulle
-- part en base. La cause n'était pas un bug de persistance : il n'existait
-- AUCUN outil permettant à l'agent d'en créer.
--
-- La liste fermée de `bg_create_tool_execution` comptait cinq entrées :
-- `propose_memory_save`, `propose_action_plan`, `propose_campaign_brief`,
-- `handoff_ugc_brief`, `request_connector_read`. Aucune ne produit un
-- `growth_prospect`. Un modèle sans outil disponible ne peut que répondre
-- « c'est noté » — et l'utilisateur découvre le mensonge en cherchant la donnée.
--
-- ## Ce qui est ajouté
--
-- 1. `propose_prospect_save` : nouvel outil proposable, soumis à approbation
--    humaine comme les autres (statut initial `pending_approval`).
-- 2. Son exécution : à l'approbation, le prospect est écrit dans
--    `saas_business.workspace_memory_items` (catégorie `growth_prospect`),
--    exactement là où le cockpit de croissance lit les prospects
--    (`src/business/growth/model.ts`, `GROWTH_CATEGORY.prospect`).
--
-- Aucune table nouvelle, aucun second système : on écrit au même endroit que le
-- formulaire manuel, donc l'agent et l'interface voient les mêmes lignes.
--
-- ## Vérification de persistance
--
-- `bg_save_scoped_prospect` écrit puis RELIT la ligne. Si la relecture ne trouve
-- rien, elle lève ; l'exécution passe en `failed` et l'interface affiche
-- l'échec, au lieu d'un succès de façade.
--
-- ## Idempotence
--
-- `bg_agent_resolve_tool` renvoie l'état d'une exécution déjà `executed` ou
-- `rejected` sans second effet : un double clic ne crée pas deux prospects.
--
-- ## Portée du correctif
--
-- Les fonctions `bg_create_tool_execution` et `bg_agent_resolve_tool` sont
-- recopiées à l'identique, à la seule exception de la nouvelle branche et de la
-- nouvelle entrée dans la liste fermée. `tests/prospect-tool-sql.test.ts`
-- compare ces deux versions aux originaux et échoue sur toute autre divergence.
--
-- La liste fermée reste fermée : ajouter `propose_prospect_save` ne l'ouvre pas
-- aux noms arbitraires, ce qui empêcherait un modèle d'inventer un outil qui
-- écrirait ailleurs.

begin;

CREATE OR REPLACE FUNCTION saas_business.bg_create_tool_execution(p_user_id uuid,p_conversation_id uuid,p_request_id uuid,p_tool_name text,p_risk_level text,p_input_args jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE v_id uuid; v_workspace uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bg_mem:'||p_user_id::text,0));
  SELECT workspace_id INTO v_workspace FROM saas_business.conversations WHERE id=p_conversation_id AND user_id=p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation not found'; END IF;
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,v_workspace,false);
  IF p_tool_name NOT IN ('propose_memory_save','propose_action_plan','propose_campaign_brief','handoff_ugc_brief','request_connector_read','propose_prospect_save')
    OR p_input_args IS NULL OR jsonb_typeof(p_input_args)<>'object' OR length(p_input_args::text)>12000 THEN RAISE EXCEPTION 'invalid tool proposal'; END IF;
  IF NOT EXISTS(SELECT 1 FROM saas_business.ai_requests WHERE id=p_request_id AND user_id=p_user_id AND conversation_id=p_conversation_id) THEN RAISE EXCEPTION 'request not found'; END IF;
  INSERT INTO saas_business.tool_executions(user_id,conversation_id,request_id,tool_name,risk_level,status,input_args)
  VALUES(p_user_id,p_conversation_id,p_request_id,p_tool_name,COALESCE(NULLIF(p_risk_level,''),'write_requires_approval'),'pending_approval',p_input_args) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------------------
-- Écriture du prospect, avec contrôle de persistance
-- ---------------------------------------------------------------------------
--
-- Fonction séparée pour deux raisons : `bg_agent_resolve_tool` dispatche déjà six
-- outils et deviendrait illisible, et la relecture de vérification doit être
-- testable isolément.
--
-- Le contenu produit respecte le schéma lu par l'interface (`GrowthProspect`
-- dans `src/business/growth/model.ts`) : name, company, email, phone, stage,
-- value, currency, nextAction, nextActionAt, notes.
CREATE OR REPLACE FUNCTION saas_business.bg_save_scoped_prospect(
  p_user_id uuid,
  p_workspace_id uuid,
  p_input jsonb,
  p_source text DEFAULT 'manual',
  p_source_ref uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,saas_business AS $$
DECLARE
  v_name text; v_company text; v_email text; v_phone text; v_stage text;
  v_value numeric; v_currency text; v_next_action text; v_next_action_at text;
  v_notes text; v_content jsonb; v_id uuid; v_relu jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
    RAISE EXCEPTION 'invalid prospect input';
  END IF;

  -- Écriture : le verrou d'accès est pris en mode écriture.
  PERFORM saas_business.bg_lock_workspace_access(p_user_id,p_workspace_id,true);

  -- Les prospects contiennent des données personnelles de tiers (nom, e-mail,
  -- téléphone) : le consentement de mémoire métier est exigé, comme pour le
  -- formulaire manuel. L'écrire sans consentement contournerait une règle déjà
  -- appliquée ailleurs.
  PERFORM saas_business.bg_require_scoped_consent(p_user_id,p_workspace_id);

  v_name:=NULLIF(btrim(COALESCE(p_input->>'name',p_input->>'nom',p_input->>'title')),'');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'prospect name required' USING ERRCODE='22023';
  END IF;
  v_name:=left(v_name,160);

  v_company:=left(btrim(COALESCE(p_input->>'company',p_input->>'entreprise','')),160);
  v_email:=left(btrim(COALESCE(p_input->>'email',p_input->>'mail','')),200);
  v_phone:=left(btrim(COALESCE(p_input->>'phone',p_input->>'telephone','')),60);

  -- L'étape est contrainte aux valeurs connues de l'interface : une valeur
  -- inventée par le modèle ferait disparaître le prospect du pipeline, qui
  -- filtre par étape. On retombe sur 'prospect' plutôt que d'accepter la chaîne.
  v_stage:=lower(btrim(COALESCE(p_input->>'stage',p_input->>'etape','')));
  IF v_stage NOT IN ('prospect','contacte','qualifie','proposition','gagne','perdu') THEN
    v_stage:='prospect';
  END IF;

  -- La valeur est facultative. `pg_input_is_valid` évite qu'une chaîne comme
  -- « environ 5000 » fasse échouer toute l'approbation : un prospect sans montant
  -- reste utile, un enregistrement rejeté ne l'est pas.
  IF jsonb_typeof(p_input->'value') IN ('number','string')
     AND pg_input_is_valid(btrim(p_input->>'value'),'numeric') THEN
    v_value:=btrim(p_input->>'value')::numeric;
    IF v_value<0 THEN v_value:=NULL; END IF;  -- un montant négatif n'a pas de sens ici
  ELSE
    v_value:=NULL;
  END IF;

  v_currency:=upper(left(COALESCE(NULLIF(btrim(p_input->>'currency'),''),'XOF'),8));
  v_next_action:=left(btrim(COALESCE(p_input->>'nextAction',p_input->>'prochaineAction','')),300);

  -- Une échéance invalide est ignorée, jamais devinée.
  v_next_action_at:=btrim(COALESCE(p_input->>'nextActionAt',''));
  IF v_next_action_at='' OR NOT pg_input_is_valid(v_next_action_at,'date') THEN
    v_next_action_at:='';
  END IF;

  v_notes:=left(btrim(COALESCE(p_input->>'notes',p_input->>'note','')),2000);

  -- `bg_put_scoped_memory_item` n'accepte que 'manual' ou 'conversation'. On
  -- normalise ici plutôt que de propager l'erreur : un libellé de source
  -- inattendu ne doit pas faire perdre le prospect déjà validé par l'utilisateur.
  IF p_source NOT IN ('manual','conversation') THEN p_source:='manual'; END IF;

  v_content:=jsonb_build_object(
    'name',v_name,'company',v_company,'email',v_email,'phone',v_phone,
    'stage',v_stage,'value',v_value,'currency',v_currency,
    'nextAction',v_next_action,'nextActionAt',v_next_action_at,'notes',v_notes,
    'source',p_source,
    'createdAt',clock_timestamp()
  );

  v_id:=saas_business.bg_put_scoped_memory_item(p_user_id,p_workspace_id,NULL,'growth_prospect',v_content,p_source,p_source_ref);

  -- VÉRIFICATION DE PERSISTANCE : on relit la ligne écrite. Sans cette relecture,
  -- une écriture silencieusement perdue (trigger, contrainte, isolation)
  -- produirait quand même un `executed` — exactement le mensonge qu'on corrige.
  SELECT i.content INTO v_relu FROM saas_business.workspace_memory_items i
   WHERE i.id=v_id AND i.user_id=p_user_id AND i.workspace_id=p_workspace_id
     AND i.category='growth_prospect';
  IF NOT FOUND OR v_relu IS NULL THEN
    RAISE EXCEPTION 'prospect persistence check failed';
  END IF;

  RETURN jsonb_build_object(
    'prospectId',v_id,'category','growth_prospect','name',v_relu->>'name',
    'stage',v_relu->>'stage','persisted',true
  );
END $$;

REVOKE ALL ON FUNCTION saas_business.bg_save_scoped_prospect(uuid,uuid,jsonb,text,uuid) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION saas_business.bg_save_scoped_prospect(uuid,uuid,jsonb,text,uuid) TO bg_edge;


-- ---------------------------------------------------------------------------
-- Branchement dans le résolveur existant
-- ---------------------------------------------------------------------------
-- Recopie de `bg_agent_resolve_tool` à l'identique, plus une seule branche
-- `propose_prospect_save`. Toute autre différence avec l'original est un défaut,
-- et `tests/prospect-tool-sql.test.ts` la détecte.
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
  ELSIF v_tool.tool_name='propose_prospect_save' THEN
    -- NOUVEAU : enregistrement réel d'un prospect, écrit dans la mémoire métier
    -- consentie (catégorie growth_prospect) puis RELU pour vérifier la persistance.
    BEGIN
      v_result:=saas_business.bg_save_scoped_prospect(p_user_id,v_workspace,v_tool.input_args,'conversation',v_tool.id);
    EXCEPTION WHEN OTHERS THEN
      UPDATE saas_business.tool_executions SET status='failed',error_message=left('PROSPECT_SAVE_FAILED: '||sqlerrm,500),output_result=jsonb_build_object('error','PROSPECT_SAVE_FAILED') WHERE id=v_tool.id;
      RETURN jsonb_build_object('id',v_tool.id,'tool_name',v_tool.tool_name,'status','failed','input_args',v_tool.input_args,'output_result',jsonb_build_object('error','PROSPECT_SAVE_FAILED'));
    END;
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

GRANT EXECUTE ON FUNCTION saas_business.bg_agent_resolve_tool(uuid,uuid,text) TO bg_edge;

commit;
