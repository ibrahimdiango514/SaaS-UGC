-- =============================================================================
-- VYORA MCP — outils MCP externes utilisables par les agents Business Grow
-- =============================================================================
--
-- ## Le manque que ce lot comble
--
-- VYORA MCP savait déjà : ajouter un serveur, tester la connexion, découvrir ses
-- outils, autoriser outil par outil, révoquer. Mais ces outils n'étaient
-- utilisables QUE manuellement, depuis l'écran des serveurs MCP. Aucun agent ne
-- pouvait s'en servir : les agents Business Grow n'ont accès qu'à une liste
-- fermée (`bg_create_tool_execution` refuse tout autre nom).
--
-- Ce lot ajoute ce chemin manquant, en réutilisant l'existant plutôt qu'en le
-- doublonnant :
--
--   * les permissions viennent de `public.mcp_servers.tool_permissions`, écrites
--     uniquement par `mcp_servers_set_permissions` (l'utilisateur) ;
--   * l'exécution passe par la même porte que l'usage manuel
--     (`mcp-client/execution.ts`) : relecture en base, fail-closed, egress épinglé ;
--   * l'approbation humaine réutilise `saas_business.tool_executions` et son
--     interface existante — un outil MCP est une proposition comme une autre.
--
-- ## Trois invariants de sécurité, chacun testé
--
-- 1. **L'agent ne peut pas élargir ses droits.** Une proposition d'outil MCP est
--    acceptée seulement si la permission stockée vaut `allowed`. Ni l'argument
--    `risk_level`, ni le corps de requête ne peuvent l'élever.
-- 2. **Isolation stricte.** La connexion doit appartenir à l'utilisateur ET à
--    l'espace de travail de la conversation. Une connexion d'un autre espace est
--    invisible, pas seulement refusée à l'exécution.
-- 3. **Aucun secret en base lisible.** Le nom du secret Vault n'est jamais
--    recopié dans `tool_executions` : la ligne d'exécution ne porte que
--    `server_id` et le nom de l'outil.
--
-- ## Portée volontairement limitée
--
-- On n'ajoute AUCUN exécuteur réseau ici. Une approbation marque l'exécution
-- `approved` avec `requires_external_execution = true` ; c'est l'Edge Function
-- `mcp-client` (déjà déployable, déjà testée) qui effectue l'appel sortant, sous
-- son propre contrôle SSRF, puis enregistre le résultat. Le SQL ne sort jamais
-- sur le réseau, et une fonction SECURITY DEFINER ne peut pas être détournée
-- pour émettre une requête.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Traçabilité de l'origine MCP d'une proposition d'outil
-- ---------------------------------------------------------------------------
--
-- Deux colonnes, nullables : les exécutions existantes (outils internes) ne
-- sont pas affectées. `requires_external_execution` est le drapeau que lit
-- l'Edge Function pour savoir qu'un appel sortant reste à faire — il évite de
-- confondre « approuvé, effet appliqué en SQL » et « approuvé, à exécuter
-- ailleurs ».
alter table saas_business.tool_executions
  add column if not exists mcp_server_id uuid,
  add column if not exists requires_external_execution boolean not null default false;

create index if not exists tool_executions_mcp_pending_idx
  on saas_business.tool_executions (user_id, mcp_server_id)
  where requires_external_execution and status = 'approved';

-- Une exécution ne peut pas revendiquer un serveur MCP sans nom d'outil
-- distinct : `tool_name` reste le nom distant, et la contrainte empêche une
-- ligne bâtarde qui serait interprétée de deux façons.
alter table saas_business.tool_executions
  drop constraint if exists tool_executions_mcp_coherence;
alter table saas_business.tool_executions
  add constraint tool_executions_mcp_coherence
  check (
    (mcp_server_id is null and requires_external_execution = false)
    or (mcp_server_id is not null and requires_external_execution = true)
  );

-- ---------------------------------------------------------------------------
-- 2. Catalogue des outils MCP autorisés pour un espace de travail
-- ---------------------------------------------------------------------------
--
-- C'est ce que l'agent peut PROPOSER. La liste est calculée, jamais stockée :
-- elle découle de `tool_permissions`, donc elle se met à jour dès que
-- l'utilisateur change une permission, sans risque de dérive entre deux copies.
--
-- Lecture seule, aucune donnée sensible : ni URL de secret, ni jeton. L'URL du
-- serveur est publique par nature (elle a été saisie dans un formulaire).
-- Verbes d'écriture : COPIE EXACTE de `VERBES_ECRITURE` dans
-- `supabase/functions/mcp-client/client.ts`. Ces deux listes doivent rester
-- identiques ; `tests/mcp-agent-tools.test.ts` compare le SQL à la source
-- TypeScript et échoue à la moindre divergence. Sans ce test, les deux
-- classements dériveraient et un outil destructeur pourrait être présenté comme
-- une lecture.
create or replace function saas_business.bg_mcp_tool_is_write(p_name text, p_description text default '')
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  with ecriture(v) as (
    select unnest(array[
      'create','update','delete','remove','insert','upsert','patch','put',
      'set','add','clear','reset','cancel','refund','charge','pay','send',
      'post','publish','submit','approve','reject','archive','restore',
      'move','rename','assign','grant','revoke','rotate','trigger','run',
      'execute','invoke','apply','replace','merge','clone','transfer',
      'upload','notify','schedule','confirm','void','close','purge',
      'destroy','drop','truncate','wipe','erase','write','modify','edit',
      'save','alter','mutate','kill','terminate','disable','enable',
      'suspend','resume','start','stop','deploy','migrate','import',
      'install','uninstall','sync','push','commit','rollback',
      'supprime','supprimer','efface','effacer','cree','creer','modifie',
      'modifier','ajoute','ajouter','envoie','envoyer','publie','publier',
      'remplace','remplacer','annule','annuler','revoque','revoquer',
      'deplace','deplacer','renomme','renommer','execute','executer',
      'lance','lancer','arrete','arreter','desactive','desactiver',
      'transfere','transferer','restaure','restaurer'
    ]::text[])
  ),
  lecture(v) as (
    select unnest(array[
      'get','list','search','find','read','fetch','query','describe',
      'show','view','retrieve','count','stat','info','lookup','browse',
      'preview','export','download','check','status','validate','resolve',
      'catalog','inspect','summarize','report','analyze'
    ]::text[])
  ),
  descr as (select lower(coalesce(p_description, '')) as brut),
  /*
   * Découpage en mots : tout caractère non alphanumérique sépare, et les
   * camelCase sont coupés (`docsSearch` → `docs`,`search`). C'est le pendant de
   * `segmentsCamel` côté TypeScript.
   *
   * On découpe AUSSI la description, plutôt que d'y chercher `\bverbe\b` :
   * un `\m` PostgreSQL dépend du classement de la base et se comporte mal avec
   * les accents (« supprime » vs « supprimé »). Le découpage ne dépend de rien.
   *
   * Différence assumée avec TypeScript : en JS, `\bdelete\b` ne reconnaît pas
   * `delete_order` (`_` est un caractère de mot), alors qu'ici `_` sépare.
   * L'écart va dans le sens sûr : on classe davantage d'outils en écriture.
   */
  mots_nom as (
    select distinct lower(mot) as mot
      from regexp_split_to_table(
             -- La découpe camelCase se fait sur le nom D'ORIGINE : une fois mis
             -- en minuscules, `docsSearch` ne se distingue plus de `docssearch`.
             regexp_replace(coalesce(p_name, ''), '([a-z0-9])([A-Z])', '\1 \2', 'g'),
             '[^a-zA-Z0-9]+'
           ) as mot
     where mot <> ''
  ),
  mots_description as (
    select distinct mot
      from descr,
           regexp_split_to_table(descr.brut, '[^a-zA-Z0-9]+') as mot
     where mot <> ''
  ),
  resultat as (
    select
      -- 1) Un verbe d'écriture dans le NOM l'emporte, même mêlé à un verbe de
      --    lecture : `get_and_delete_order` est une écriture.
      exists (select 1 from mots_nom m join ecriture e on e.v = m.mot) as ecrit_nom,
      -- 2) Un verbe d'écriture dans la DESCRIPTION suffit : on ne peut pas
      --    prouver que l'outil est en lecture.
      exists (select 1 from mots_description m join ecriture e on e.v = m.mot) as ecrit_desc,
      -- 3) À défaut, lecture seulement si le nom contient un verbe de lecture
      --    connu — n'importe où, pas seulement en tête (correction constatée sur
      --    de vrais serveurs : `microsoft_docs_search` était classé écriture).
      exists (select 1 from mots_nom m join lecture l on l.v = m.mot) as lit_nom
  )
  select
    case
      when ecrit_nom or ecrit_desc then true
      when lit_nom then false
      -- 4) Un nom qui ne dit rien (`do_thing`) est une écriture : l'absence
      --    d'information n'est pas une preuve d'innocuité.
      else true
    end
  from resultat;
$$;

revoke all on function saas_business.bg_mcp_tool_is_write(text, text) from public, anon, authenticated;
grant execute on function saas_business.bg_mcp_tool_is_write(text, text) to bg_edge;

-- Catalogue des outils MCP proposables à l'agent.
--
-- `executable` est le fait décisif : seul un outil de LECTURE l'est. Les
-- écritures MCP sont refusées par la porte d'exécution (aucune colonne
-- d'autorisation d'écriture n'existe, `ecrituresAutorisees` est vide). Les
-- exposer comme exécutables ferait promettre à l'agent une action qui échouera
-- systématiquement — exactement le mensonge à éviter.
--
-- Elles restent VISIBLES (`executable: false`) pour que l'interface puisse
-- expliquer pourquoi elles ne sont pas proposées, au lieu de les cacher.
create or replace function saas_business.bg_list_mcp_tools(
  p_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'server_id', s.id,
        'server_name', s.name,
        'tool_name', t.nom,
        'description', left(coalesce(t.description, ''), 500),
        'executable', not t.ecriture,
        'ecriture', t.ecriture
      )
      order by s.name, t.nom
    ),
    '[]'::jsonb
  )
  from public.mcp_servers s
  cross join lateral (
    select
      (outil ->> 'name') as nom,
      (outil ->> 'description') as description,
      saas_business.bg_mcp_tool_is_write(outil ->> 'name', outil ->> 'description') as ecriture
    from jsonb_array_elements(
      case when jsonb_typeof(s.tools) = 'array' then s.tools else '[]'::jsonb end
    ) as outil
  ) t
  where s.user_id = p_user_id
    and s.workspace_id = p_workspace_id
    and s.revoked_at is null
    and s.status = 'connected'
    -- Fail-closed : tout ce qui n'est pas exactement `allowed` est exclu.
    and (s.tool_permissions ->> t.nom) = 'allowed'
    -- Un nom d'outil distant déraisonnable n'entre pas dans le prompt d'un
    -- agent : il doit rester court et sans caractère de contrôle.
    and t.nom ~ '^[A-Za-z0-9_.:-]{1,120}$';
$$;

revoke all on function saas_business.bg_list_mcp_tools(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_list_mcp_tools(uuid, uuid) to bg_edge;

-- ---------------------------------------------------------------------------
-- 3. Proposed par l'agent : une exécution MCP en attente d'approbation
-- ---------------------------------------------------------------------------
--
-- Remplace une éventuelle version antérieure. Elle diffère de
-- `bg_create_tool_execution` sur trois points, chacun nécessaire :
--
--   a) elle accepte un serveur MCP (les outils internes passent par l'autre
--      fonction, inchangée) ;
--   b) elle VÉRIFIE que la permission stockée vaut `allowed` au moment de la
--      proposition — un agent qui invente un nom d'outil est refusé ici, pas
--      plus tard ;
--   c) elle vérifie que le serveur appartient à l'utilisateur ET à l'espace de
--      travail de la conversation.
create or replace function saas_business.bg_create_mcp_tool_execution(
  p_user_id uuid,
  p_conversation_id uuid,
  p_request_id uuid,
  p_server_id uuid,
  p_tool_name text,
  p_input_args jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_id uuid;
  v_workspace uuid;
  v_allowed boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('bg_mem:' || p_user_id::text, 0));

  if p_server_id is null then
    raise exception 'mcp server required' using errcode = '22023';
  end if;
  if p_tool_name is null or p_tool_name !~ '^[A-Za-z0-9_.:-]{1,120}$' then
    raise exception 'invalid mcp tool name' using errcode = '22023';
  end if;
  if p_input_args is null or jsonb_typeof(p_input_args) <> 'object' or length(p_input_args::text) > 12000 then
    raise exception 'invalid mcp tool arguments' using errcode = '22023';
  end if;

  -- La conversation doit appartenir à l'utilisateur : point de départ de tout
  -- le reste (l'espace de travail en découle).
  select c.workspace_id into v_workspace
    from saas_business.conversations c
   where c.id = p_conversation_id and c.user_id = p_user_id;
  if not found then
    raise exception 'conversation not found' using errcode = '42501';
  end if;
  perform saas_business.bg_lock_workspace_access(p_user_id, v_workspace, false);

  /*
   * Le contrôle central. Une connexion d'un AUTRE espace de travail, ou d'un
   * AUTRE utilisateur, ne produit pas un refus explicite : elle est traitée
   * comme inexistante. Renvoyer « interdit » confirmerait l'existence d'une
   * connexion d'un tiers, ce qui est déjà une fuite d'information.
   */
  select exists (
    select 1
      from public.mcp_servers s
     where s.id = p_server_id
       and s.user_id = p_user_id
       and s.workspace_id = v_workspace
       and s.revoked_at is null
       and s.status = 'connected'
       and (s.tool_permissions ->> p_tool_name) = 'allowed'
       /*
        * SÉCURITÉ : un outil classé écriture n'est JAMAIS proposable. Les
        * écritures MCP ne sont pas activées (aucune colonne d'autorisation
        * n'existe) : les laisser passer ici ferait créer une proposition
        * qui échouerait à l'exécution, après avoir demandé une approbation
        * pour rien.
        */
       and not saas_business.bg_mcp_tool_is_write(
         p_tool_name,
         (select (outil ->> 'description') from jsonb_array_elements(
            case when jsonb_typeof(s.tools) = 'array' then s.tools else '[]'::jsonb end
          ) as outil where (outil ->> 'name') = p_tool_name limit 1)
       )
       and exists (
         select 1 from jsonb_array_elements(
           case when jsonb_typeof(s.tools) = 'array' then s.tools else '[]'::jsonb end
         ) as outil where (outil ->> 'name') = p_tool_name
       )
  ) into v_allowed;

  if not v_allowed then
    /*
     * Message délibérément générique : il ne dit pas si le serveur existe, si
     * l'outil existe, ou si la permission manque. L'agent n'a pas à sonder
     * l'état des connexions d'un espace quelconque.
     */
    raise exception 'mcp tool not allowed' using errcode = '42501';
  end if;

  if not exists (
    select 1 from saas_business.ai_requests r
     where r.id = p_request_id and r.user_id = p_user_id and r.conversation_id = p_conversation_id
  ) then
    raise exception 'request not found' using errcode = '42501';
  end if;

  /*
   * `risk_level` est TOUJOURS `external_publish_requires_approval` pour un
   * outil MCP : il sort de VYORA, donc son effet n'est pas vérifiable par la
   * base. Ce n'est pas décoratif — l'interface s'en sert pour afficher un
   * avertissement distinct des actions internes.
   *
   * Le statut initial est `pending_approval` : aucune exécution n'a lieu sans
   * un geste explicite de l'utilisateur.
   */
  insert into saas_business.tool_executions (
    user_id, conversation_id, request_id, tool_name, risk_level, status,
    input_args, mcp_server_id, requires_external_execution
  )
  values (
    p_user_id, p_conversation_id, p_request_id, p_tool_name,
    'external_publish_requires_approval', 'pending_approval',
    p_input_args, p_server_id, true
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function saas_business.bg_create_mcp_tool_execution(uuid, uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_create_mcp_tool_execution(uuid, uuid, uuid, uuid, text, jsonb) to bg_edge;

-- ---------------------------------------------------------------------------
-- 4. Réponse de l'utilisateur à une proposition d'outil MCP
-- ---------------------------------------------------------------------------
--
-- Réutilise `tool_executions`, donc l'interface d'approbation existante
-- fonctionne sans modification. L'appelant doit être l'Edge Function
-- `business-grow` (déjà authentifiée) : la vérification d'appartenance y est
-- répétée, elle ne fait pas confiance à la couche du dessus.
--
-- À l'approbation, on ne marque PAS `executed` : l'effet n'a pas eu lieu. On
-- marque `approved` + `requires_external_execution`, et l'Edge Function
-- `mcp-client` fera l'appel puis passera à `executed` ou `failed`.
create or replace function saas_business.bg_resolve_mcp_tool(
  p_user_id uuid,
  p_execution_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_tool saas_business.tool_executions%rowtype;
  v_workspace uuid;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'invalid tool decision' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bg_mem:' || p_user_id::text, 0));

  select c.workspace_id into v_workspace
    from saas_business.tool_executions t
    join saas_business.conversations c on c.id = t.conversation_id and c.user_id = t.user_id
   where t.id = p_execution_id and t.user_id = p_user_id;
  if not found then
    raise exception 'tool execution not found' using errcode = '42501';
  end if;
  perform saas_business.bg_lock_workspace_access(p_user_id, v_workspace, true);

  select * into v_tool
    from saas_business.tool_executions
   where id = p_execution_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'tool execution not found' using errcode = '42501';
  end if;

  -- Cette fonction ne traite QUE les propositions MCP. Une proposition interne
  -- doit passer par `bg_agent_resolve_tool`, qui applique ses effets en SQL.
  if v_tool.mcp_server_id is null then
    raise exception 'not an mcp tool execution' using errcode = '22023';
  end if;

  /*
   * Idempotence : réappuyer « Approuver » ou « Refuser » ne doit pas produire
   * d'erreur ni d'effet supplémentaire. On renvoie l'état courant, comme le
   * fait déjà le résolveur interne.
   */
  if v_tool.status = 'rejected' and p_decision = 'rejected' then
    return jsonb_build_object(
      'id', v_tool.id, 'tool_name', v_tool.tool_name, 'status', v_tool.status,
      'input_args', v_tool.input_args, 'output_result', v_tool.output_result
    );
  end if;
  if v_tool.status in ('approved', 'executed', 'failed') and p_decision = 'approved' then
    return jsonb_build_object(
      'id', v_tool.id, 'tool_name', v_tool.tool_name, 'status', v_tool.status,
      'input_args', v_tool.input_args, 'output_result', v_tool.output_result,
      'requires_external_execution', v_tool.requires_external_execution
    );
  end if;
  if v_tool.status not in ('pending_approval') then
    raise exception 'tool already resolved' using errcode = '22023';
  end if;

  if p_decision = 'rejected' then
    update saas_business.tool_executions
       set status = 'rejected',
           output_result = jsonb_build_object('rejectedByUser', true)
     where id = v_tool.id;
    return jsonb_build_object(
      'id', v_tool.id, 'tool_name', v_tool.tool_name, 'status', 'rejected',
      'input_args', v_tool.input_args, 'output_result', jsonb_build_object('rejectedByUser', true)
    );
  end if;

  /*
   * Approbation : on revérifie la permission ICI. Le serveur a pu être révoqué,
   * retesté en erreur, ou la permission retirée entre la proposition et
   * l'approbation. Approuver sur la foi d'un état périmé exécuterait un outil
   * devenu interdit.
   */
  if not exists (
    select 1 from public.mcp_servers s
     where s.id = v_tool.mcp_server_id
       and s.user_id = p_user_id
       and s.workspace_id = v_workspace
       and s.revoked_at is null
       and s.status = 'connected'
       and (s.tool_permissions ->> v_tool.tool_name) = 'allowed'
  ) then
    update saas_business.tool_executions
       set status = 'failed',
           error_message = 'MCP_TOOL_NO_LONGER_ALLOWED',
           output_result = jsonb_build_object('error', 'MCP_TOOL_NO_LONGER_ALLOWED')
     where id = v_tool.id;
    return jsonb_build_object(
      'id', v_tool.id, 'tool_name', v_tool.tool_name, 'status', 'failed',
      'input_args', v_tool.input_args,
      'output_result', jsonb_build_object('error', 'MCP_TOOL_NO_LONGER_ALLOWED')
    );
  end if;

  update saas_business.tool_executions
     set status = 'approved',
         approved_at = coalesce(approved_at, clock_timestamp())
   where id = v_tool.id;

  return jsonb_build_object(
    'id', v_tool.id, 'tool_name', v_tool.tool_name, 'status', 'approved',
    'input_args', v_tool.input_args,
    'requires_external_execution', true,
    'mcp_server_id', v_tool.mcp_server_id
  );
end;
$$;

revoke all on function saas_business.bg_resolve_mcp_tool(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_resolve_mcp_tool(uuid, uuid, text) to bg_edge;

-- ---------------------------------------------------------------------------
-- 5. Clôture de l'exécution externe
-- ---------------------------------------------------------------------------
--
-- Appelée par `mcp-client` APRÈS l'appel sortant. Elle n'accepte que les états
-- finaux, et uniquement depuis `approved` : une exécution non approuvée ne peut
-- pas être « clôturée en succès », ce qui empêcherait de fabriquer un résultat
-- sans approbation.
--
-- `p_output` est tronquée et stockée telle quelle : c'est le résultat renvoyé
-- par le serveur distant, potentiellement du texte hostile. L'interface
-- l'affiche comme du texte, jamais comme du HTML.
create or replace function saas_business.bg_finish_mcp_tool(
  p_user_id uuid,
  p_execution_id uuid,
  p_status text,
  p_output jsonb default '{}'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_tool saas_business.tool_executions%rowtype;
begin
  if p_status not in ('executed', 'failed') then
    raise exception 'invalid final status' using errcode = '22023';
  end if;

  select * into v_tool
    from saas_business.tool_executions
   where id = p_execution_id and user_id = p_user_id
   for update;
  if not found then
    raise exception 'tool execution not found' using errcode = '42501';
  end if;
  if v_tool.mcp_server_id is null then
    raise exception 'not an mcp tool execution' using errcode = '22023';
  end if;

  -- Rejeu : un second appel sur un état final renvoie l'état, sans erreur.
  if v_tool.status in ('executed', 'failed') then
    return jsonb_build_object(
      'id', v_tool.id, 'status', v_tool.status,
      'output_result', v_tool.output_result
    );
  end if;
  if v_tool.status not in ('approved') then
    raise exception 'tool not approved' using errcode = '42501';
  end if;

  update saas_business.tool_executions
     set status = p_status,
         executed_at = clock_timestamp(),
         output_result = coalesce(p_output, '{}'::jsonb),
         error_message = case when p_status = 'failed' then left(coalesce(p_error, 'MCP_CALL_FAILED'), 500) else null end
   where id = v_tool.id;

  return jsonb_build_object('id', v_tool.id, 'status', p_status);
end;
$$;

revoke all on function saas_business.bg_finish_mcp_tool(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_finish_mcp_tool(uuid, uuid, text, jsonb, text) to bg_edge;

-- ---------------------------------------------------------------------------
-- 6. Liste des exécutions MCP en attente d'appel sortant
-- ---------------------------------------------------------------------------
--
-- Sert à `mcp-client` : quelles approbations attendent encore un appel ? La
-- fonction est bornée (l'utilisateur est obligatoire) et ne renvoie que des
-- identifiants et des noms d'outils — jamais d'argument, qui peut contenir des
-- données métier.
create or replace function saas_business.bg_pending_mcp_calls(
  p_user_id uuid,
  p_limit integer default 20
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'execution_id', t.id,
    'server_id', t.mcp_server_id,
    'tool_name', t.tool_name,
    'approved_at', t.approved_at
  ) order by t.approved_at), '[]'::jsonb)
  from (
    select * from saas_business.tool_executions
     where user_id = p_user_id
       and requires_external_execution
       and status = 'approved'
       and mcp_server_id is not null
     order by approved_at
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) t;
$$;

revoke all on function saas_business.bg_pending_mcp_calls(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_pending_mcp_calls(uuid, integer) to bg_edge;

-- ---------------------------------------------------------------------------
-- 7. Routage : une approbation d'outil MCP passe par le résolveur MCP
-- ---------------------------------------------------------------------------
--
-- `bg_agent_resolve_scoped_tool` est le point d'entrée que l'Edge Function
-- appelle pour TOUTE décision d'outil dans une entreprise. Il délègue
-- aujourd'hui sans condition à `bg_agent_resolve_tool`, qui applique l'effet
-- MCP... impossible : ce résolveur ne connaît que les outils internes et lève
-- `unsupported tool` sur un nom MCP.
--
-- On insère donc le routage ICI, dans le seul point d'entrée existant. C'est
-- volontaire : ajouter un second chemin obligerait l'Edge à choisir lequel
-- appeler, et un client plus ancien continuerait d'appeler l'ancien — donc de
-- refuser les outils MCP. En routant côté base, l'ancien et le nouveau client
-- obtiennent le même comportement.
--
-- Les contrôles d'appartenance (utilisateur ET entreprise) sont refaits avant
-- la bifurcation, avec exactement ceux d'origine : on ne remplace pas une
-- vérification, on en ajoute une seconde.
create or replace function saas_business.bg_agent_resolve_scoped_tool(
  p_user_id uuid,
  p_workspace_id uuid,
  p_execution_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_mcp_server uuid;
begin
  if p_workspace_id is null then
    raise exception 'workspace required';
  end if;
  perform saas_business.bg_require_workspace(p_user_id, p_workspace_id, false);

  -- La ligne doit appartenir à l'utilisateur ET à une conversation de CETTE
  -- entreprise. On lit `mcp_server_id` au passage : c'est ce qui décide du
  -- résolveur.
  select t.mcp_server_id into v_mcp_server
    from saas_business.tool_executions t
    join saas_business.conversations c
      on c.id = t.conversation_id and c.user_id = t.user_id
   where t.id = p_execution_id
     and t.user_id = p_user_id
     and c.workspace_id = p_workspace_id;
  if not found then
    raise exception 'tool execution not found';
  end if;

  if v_mcp_server is not null then
    /*
     * Outil MCP : `bg_resolve_mcp_tool` revérifie la permission au moment de
     * l'approbation et pose `requires_external_execution`. Aucun effet réseau
     * ici — l'appel sortant reste à la charge de `mcp-client`.
     */
    return saas_business.bg_resolve_mcp_tool(p_user_id, p_execution_id, p_decision);
  end if;

  -- Comportement inchangé pour tous les outils internes.
  return saas_business.bg_agent_resolve_tool(p_user_id, p_execution_id, p_decision);
end;
$$;

revoke all on function saas_business.bg_agent_resolve_scoped_tool(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_agent_resolve_scoped_tool(uuid, uuid, uuid, text) to bg_edge;

-- ---------------------------------------------------------------------------
-- 8. Lecture des sorties d'appel MCP par outil (« le pont est-il branché ? »)
-- ---------------------------------------------------------------------------
--
-- `mcp-client` doit savoir QUOI exécuter : identifiants, serveur, outil et
-- arguments. `bg_pending_mcp_calls` (section 6) ne renvoie pas les arguments —
-- ils peuvent contenir des données métier, et cette liste sert au décompte,
-- pas à l'exécution. Cette fonction-ci les fournit, une exécution à la fois,
-- après vérification d'appartenance.
create or replace function saas_business.bg_get_mcp_tool_call(
  p_user_id uuid,
  p_execution_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, saas_business
as $$
declare
  v_tool saas_business.tool_executions%rowtype;
begin
  select * into v_tool
    from saas_business.tool_executions
   where id = p_execution_id
     and user_id = p_user_id
     and mcp_server_id is not null
     and requires_external_execution
     and status = 'approved';
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'execution_id', v_tool.id,
    'server_id', v_tool.mcp_server_id,
    'tool_name', v_tool.tool_name,
    'input_args', v_tool.input_args,
    'approved_at', v_tool.approved_at
  );
end;
$$;

revoke all on function saas_business.bg_get_mcp_tool_call(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function saas_business.bg_get_mcp_tool_call(uuid, uuid) to bg_edge;

commit;
