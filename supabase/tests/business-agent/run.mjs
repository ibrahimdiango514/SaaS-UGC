// Banc PostgreSQL local jetable pour Business Agent, sans accès ni données distantes.
// Prérequis : npm ci --prefix supabase/tests/saspay
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { start, client, BOOTSTRAP, readMigration, HERE } from '../saspay/pg.mjs';

async function waitBlocked(db, waitingPid, blockerPid) {
  const deadline = Date.now() + 3000;
  do {
    const { rows } = await db.query('select pg_blocking_pids($1::int) as blockers', [waitingPid]);
    if (rows[0].blockers.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Backend ${waitingPid} did not block on ${blockerPid}`);
}

const server = await start({ fresh: true });
let admin, db, edge, edge2;
try {
  admin = client(); await admin.connect(); await admin.query(BOOTSTRAP); await admin.end(); admin = null;
  db = client('postgres'); await db.connect();
  await db.query(readFileSync(path.join(HERE, 'prod_subset.sql'), 'utf8'));
  await db.query(`create table saas_ugc.ugc_workspaces (id uuid primary key default gen_random_uuid(),owner_user_id uuid not null,name text not null,country_code text default 'ML',default_language text default 'fr');
    create table saas_ugc.ugc_workspace_members (id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,member_role text not null default 'editor');
    create table saas_ugc.ugc_brands (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,industry text,description text,voice_guidelines text,updated_at timestamptz default now());
    create table saas_ugc.ugc_products (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,description text,key_benefits text[],updated_at timestamptz default now());`);
  for (const name of ['20261110172827_business_grow_saas_business.sql', '20261110172909_business_grow_ai_extensions.sql',
    '20261110180645_business_grow_erasure_fix.sql','20261114110000_business_grow_integration_requests.sql']) await db.query(readMigration(name));
  assert.equal((await db.query("select to_regclass('saas_business.module_records') as t")).rows[0].t, null, 'simule une installation sans migration modules');
  await db.query(readMigration('20261114120000_business_agent_workspace.sql'));
  // Récurrence sûre sur une installation ayant déjà la table et ses données.
  await db.query(readMigration('20261114120000_business_agent_workspace.sql'));
  edge=client('postgres'); await edge.connect(); await edge.query('set role bg_edge');
  edge2=client('postgres'); await edge2.connect(); await edge2.query('set role bg_edge');
  const users = (await db.query("insert into auth.users(email) values('agent-owner@test.local'),('agent-other@test.local'),('agent-viewer@test.local'),('agent-editor@test.local') returning id")).rows.map(r=>r.id);
  const [owner, other, viewer, editor] = users;
  const spaces=(await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'A'),($1,'B'),($2,'C') returning id",[owner,other])).rows.map(r=>r.id);
  const [a,b,c]=spaces;
  await db.query("insert into saas_ugc.ugc_workspace_members(workspace_id,user_id,member_role) values($1,$2,'viewer'),($1,$3,'editor')",[a,viewer,editor]);
  const edgePid=(await edge.query('select pg_backend_pid() as pid')).rows[0].pid;
  const edge2Pid=(await edge2.query('select pg_backend_pid() as pid')).rows[0].pid;
  const dbPid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid;
  const sql = async (q, p=[]) => (await edge.query(q,p)).rows;
  const memory = async (u,w) => (await sql('select saas_business.bg_get_scoped_memory($1,$2) as v',[u,w]))[0].v;
  const consent = (u,w,enabled=true) => sql('select * from saas_business.bg_set_scoped_memory_consent($1,$2,$3,$4)',[u,w,enabled,'test-v1']);
  const put = async (u,w,category,content) => (await sql('select saas_business.bg_put_scoped_memory_item($1,$2,null,$3,$4::jsonb) as id',[u,w,category,JSON.stringify(content)]))[0].id;
  const create = async (u,w,cat,data,key=null) => (await sql('select saas_business.bg_create_scoped_module_record($1,$2,$3,$4::jsonb,$5) as id',[u,w,cat,JSON.stringify(data),key]))[0].id;
  const list = (u,w,cat) => sql('select * from saas_business.bg_list_scoped_module_records($1,$2,$3)',[u,w,cat]);
  const conversation = async (u,w) => (await sql("select saas_business.bg_create_conversation($1,'Test', $2) as id",[u,w]))[0].id;
  const propose = async (u,w,conv,cat,id,key=randomUUID()) => (await sql('select saas_business.bg_agent_propose_task($1,$2,$3,$4,$5,$6) as v',[u,w,conv,cat,id,key]))[0].v;
  const resolve = async (u,id,decision) => (await sql('select saas_business.bg_agent_resolve_tool($1,$2,$3) as v',[u,id,decision]))[0].v;
  const payment='bg_module_payment_recovery', operations='bg_module_operations_manager';

  // Mémoire historique conservée, consentement et données distincts par entreprise.
  await sql("select * from saas_business.bg_set_memory_consent($1,true,'legacy')",[owner]);
  const legacy=(await sql("select saas_business.bg_put_memory_item($1,null,'business_context','{\"text\":\"ancien\"}'::jsonb,'manual',null) as id",[owner]))[0].id;
  assert.equal((await memory(owner,a)).consent,false);
  await consent(owner,a); await consent(owner,b);
  assert.deepEqual((await memory(owner,a)).items,[]); assert.deepEqual((await memory(owner,b)).items,[]);
  const itemA=await put(owner,a,'goals',{text:'objectif A'}); await put(owner,b,'goals',{text:'objectif B'});
  assert.equal((await memory(owner,a)).items[0].content.text,'objectif A');
  assert.equal((await memory(owner,b)).items[0].content.text,'objectif B');
  assert.equal((await sql('select saas_business.bg_delete_scoped_memory_item($1,$2,$3) as ok',[owner,b,itemA]))[0].ok,false);
  const imported=(await sql('select saas_business.bg_import_legacy_memory($1,$2) as v',[owner,a]))[0].v;
  assert.equal(imported.importedItems,1); assert.equal((await sql('select saas_business.bg_import_legacy_memory($1,$2) as v',[owner,a]))[0].v.importedItems,0);
  assert.equal((await memory(owner,b)).items.length,1); assert.ok((await sql('select saas_business.bg_get_memory($1) as m',[owner]))[0].m.items.some(x=>x.id===legacy));
  await consent(owner,a,false); assert.equal((await memory(owner,a)).items.length,0); assert.equal((await memory(owner,b)).items.length,1);
  await consent(owner,a);
  console.log('✓ consentement indépendant, isolation, import historique explicite et révocation ciblée');

  const invoiceA=await create(owner,a,payment,{invoiceRef:'FAC-A',amount:75000,status:'en_retard',dueDate:'2026-01-01'});
  const invoiceB=await create(owner,b,payment,{invoiceRef:'FAC-B',amount:1000,status:'en_retard',dueDate:'2026-01-01'});
  assert.deepEqual((await list(owner,a,payment)).map(r=>r.id),[invoiceA]);
  assert.deepEqual((await list(owner,b,payment)).map(r=>r.id),[invoiceB]);
  assert.deepEqual(await sql('select * from saas_business.bg_list_module_records($1,$2)',[owner,payment]),[]);
  assert.equal((await sql('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb) as v',[owner,b,invoiceA,payment,'{"amount":9}']))[0].v,false);
  await assert.rejects(()=>list(other,a,payment),/workspace access denied/);
  assert.deepEqual(await list(viewer,a,payment),[]); // pas de partage entre utilisateurs
  await assert.rejects(()=>create(viewer,a,payment,{invoiceRef:'non autorisé'}),/workspace access denied/);
  assert.deepEqual((await sql('select saas_business.bg_business_snapshot($1,$2) as v',[owner,a]))[0].v.modules[payment].map(r=>r.id),[invoiceA]);
  console.log('✓ modules bornés, utilisateur + entreprise, refus viewer et accès croisés');

  // Les demandes d'intégration de deux entreprises d'un même compte ne sont
  // ni regroupées ni annulées ensemble ; NULL reste strictement personnel.
  const requestIntegration=async(u,w,k)=>(await sql('select saas_business.bg_request_scoped_integration_connection($1,$2,$3) as v',[u,w,k]))[0].v;
  const listIntegrations=(u,w)=>sql('select * from saas_business.bg_list_scoped_integration_connections($1,$2)',[u,w]);
  const cancelIntegration=async(u,w,k)=>(await sql('select saas_business.bg_cancel_scoped_integration_request($1,$2,$3) as v',[u,w,k]))[0].v;
  const disconnectIntegration=async(u,w,k)=>(await sql('select saas_business.bg_disconnect_scoped_integration_connection($1,$2,$3) as v',[u,w,k]))[0].v;
  const [pendingA,pendingB]=await Promise.all([
    requestIntegration(owner,a,'shopify'),
    edge2.query('select saas_business.bg_request_scoped_integration_connection($1,$2,$3) as v',[owner,b,'shopify']).then(r=>r.rows[0].v),
  ]);
  assert.equal(pendingA,'pending'); assert.equal(pendingB,'pending');
  assert.deepEqual((await listIntegrations(owner,a)).map(r=>r.workspace_id),[a]);
  assert.deepEqual((await listIntegrations(owner,b)).map(r=>r.workspace_id),[b]);
  assert.deepEqual(await sql('select * from saas_business.bg_list_integration_connections($1)',[owner]),[]);
  assert.equal((await sql("select saas_business.bg_cancel_integration_request($1,'shopify') as v",[owner]))[0].v,false);
  assert.equal(await cancelIntegration(owner,b,'shopify'),true);
  assert.equal((await listIntegrations(owner,a))[0].status,'pending');
  await requestIntegration(owner,b,'shopify');
  assert.equal((await sql("select saas_business.bg_request_integration_connection($1,'facebook',null) as v",[owner]))[0].v,'pending');
  await assert.rejects(()=>sql("select saas_business.bg_request_integration_connection($1,'instagram',$2)",[owner,a]),/workspace integration requires v3 protocol/);
  assert.equal((await listIntegrations(owner,a)).some(r=>r.connector_key==='instagram'),false);
  assert.deepEqual((await sql('select * from saas_business.bg_list_integration_connections($1)',[owner])).map(r=>r.connector_key),['facebook']);
  await assert.rejects(()=>listIntegrations(other,a),/workspace access denied/);
  await assert.rejects(()=>requestIntegration(viewer,a,'instagram'),/workspace access denied/);
  await assert.rejects(()=>cancelIntegration(viewer,a,'shopify'),/workspace access denied/);
  await assert.rejects(()=>requestIntegration(owner,a,'invalid'),/invalid connector key/);
  // Les références ci-dessous sont des données de test locales, pas des secrets.
  await db.query(`insert into saas_business.integration_connections(user_id,workspace_id,connector_key,external_account_ref,credential_ref,status)
    values($1,$2,'woocommerce','compte-test','reference-locale-a','connected'),($1,$3,'woocommerce','compte-test','reference-locale-b','connected')`,[owner,a,b]);
  assert.equal(await disconnectIntegration(owner,a,'woocommerce'),true);
  assert.equal((await listIntegrations(owner,a)).find(r=>r.connector_key==='woocommerce').status,'disconnected');
  assert.equal((await listIntegrations(owner,b)).find(r=>r.connector_key==='woocommerce').status,'connected');
  assert.equal((await db.query("select credential_ref from saas_business.integration_connections where user_id=$1 and workspace_id=$2 and connector_key='woocommerce'",[owner,b])).rows[0].credential_ref,'reference-locale-b');
  assert.equal((await sql("select saas_business.bg_disconnect_integration_connection($1,'woocommerce') as v",[owner]))[0].v,false);
  assert.equal((await db.query("select has_function_privilege('authenticated','saas_business.bg_list_scoped_integration_connections(uuid,uuid)','execute') as v")).rows[0].v,false);
  await assert.rejects(()=>edge.query('select * from saas_business.integration_connections'),/permission denied/);
  // Une demande déjà en attente lors du retrait d'un membre est refusée.
  await db.query('begin');
  await db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,editor]);
  const pendingMember=edge2.query('select saas_business.bg_request_scoped_integration_connection($1,$2,$3)',[editor,a,'instagram']).then(value=>({value}),error=>({error}));
  await waitBlocked(edge,edge2Pid,dbPid); await db.query('commit');
  assert.match((await pendingMember).error.message,/workspace access denied/);
  await db.query("insert into saas_ugc.ugc_workspace_members(workspace_id,user_id,member_role) values($1,$2,'editor')",[a,editor]);
  console.log('✓ intégrations isolées par compte et entreprise ; retrait de membre sérialisé');

  // La projection SQL retire les données sensibles AVANT qu'elles quittent la
  // base. Seules les présences de brouillons/preuves sont exposées.
  const longRef='F'.repeat(500);
  await sql('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,a,invoiceA,payment,JSON.stringify({ invoiceRef:longRef, customer:'Client privé', email:'client@example.test', notes:'Note secrète', hidden:{private:'cache'}, amount:75000 })]);
  const support=await create(owner,a,'bg_module_customer_support_ai',{subject:'Ticket support',status:'ouvert',priority:'haute',draftReply:'Brouillon confidentiel',message:'Message confidentiel',customer:'Autre client'});
  const dispute=await create(owner,a,'bg_module_dispute_shield',{reference:'LIT-1',status:'ouvert',evidence:'Preuve confidentielle',notes:'Note de litige'});
  const privateCrm=await put(owner,a,'growth_prospect',{name:'Prospect privé',stage:'qualifie',nextActionAt:'2026-11-10',email:'crm@example.test',phone:'123456789',notes:'Note CRM'});
  const snap=(await sql('select saas_business.bg_business_snapshot($1,$2) as v',[owner,a]))[0].v;
  const projectedInvoice=snap.modules[payment].find(r=>r.id===invoiceA).data;
  assert.equal(projectedInvoice.invoiceRef.length,240);
  assert.equal(projectedInvoice.amount,75000);
  const projectedSupport=snap.modules.bg_module_customer_support_ai.find(r=>r.id===support).data;
  assert.equal(projectedSupport.hasDraftReply,true);
  assert.equal(projectedSupport.hasEvidence,false);
  const projectedDispute=snap.modules.bg_module_dispute_shield.find(r=>r.id===dispute).data;
  assert.equal(projectedDispute.hasEvidence,true);
  assert.equal(snap.crm.find(r=>r.id===privateCrm).data.stage,'qualifie');
  const projectedJson=JSON.stringify(snap);
  for (const secret of ['Client privé','client@example.test','Note secrète','Brouillon confidentiel','Message confidentiel','Autre client','Preuve confidentielle','Note de litige','crm@example.test','123456789','Note CRM','cache']) assert.ok(!projectedJson.includes(secret),`projection ne doit pas exposer : ${secret}`);
  await sql('select saas_business.bg_delete_scoped_memory_item($1,$2,$3)',[owner,a,privateCrm]);
  await consent(owner,a,false);
  const noConsent=(await sql('select saas_business.bg_business_snapshot($1,$2) as v',[owner,a]))[0].v;
  assert.equal(noConsent.crmConsent,false); assert.deepEqual(noConsent.crm,[]);
  await consent(owner,a);
  await assert.rejects(()=>edge.query('select saas_business.bg_agent_projection($1::jsonb,false)', ['{}']),/permission denied/);
  console.log('✓ projection bornée : absence de coordonnées, notes, messages, brouillons et preuves ; CRM conditionné au consentement');

  assert.equal((await sql('select saas_business.bg_workspace_protocol($1,$2) as v',[owner,a]))[0].v,'business-workspace-v3');
  await assert.rejects(()=>sql('select saas_business.bg_workspace_protocol($1,$2)',[other,a]),/workspace access denied/);
  const convA=await conversation(owner,a), convB=await conversation(owner,b);
  assert.equal((await sql('select saas_business.bg_conversation_scope($1,$2) as v',[owner,convA]))[0].v.workspaceId,a);
  assert.deepEqual((await sql('select * from saas_business.bg_list_scoped_conversations($1,$2,50)',[owner,b])).map(r=>r.id),[convB]);
  const viewConv=await conversation(viewer,a);
  const submit = async (u,conv) => (await sql('select * from saas_business.bg_submit_scoped_user_message($1,$2,$3,$4,$5,$6)',[u,conv,'bonjour',randomUUID(),randomUUID(),'business_advisor']))[0];
  const requestA=await submit(owner,convA), requestB=await submit(owner,convB), viewRequest=await submit(viewer,viewConv);
  await assert.rejects(()=>sql('select * from saas_business.bg_submit_user_message($1,$2,$3,$4,$5,$6)',[owner,convA,'ne pas transmettre la mémoire personnelle',randomUUID(),'hash','business_advisor']),/legacy message requires v3 protocol/);
  const personalConv=await conversation(owner,null);
  await assert.rejects(()=>sql('select * from saas_business.bg_submit_user_message($1,$2,$3,$4,$5,$6)',[owner,personalConv,'ne pas combiner avec un contexte entreprise',randomUUID(),'legacy-hash','business_advisor']),/legacy message requires v3 protocol/);
  const personalSubmit=await submit(owner,personalConv);
  assert.equal(personalSubmit.created,true); // service récent, même en personnel
  assert.deepEqual((await sql('select * from saas_business.bg_list_scoped_recent_requests($1,$2,20)',[owner,a])).map(r=>r.id),[requestA.request_id]);
  assert.deepEqual((await sql('select * from saas_business.bg_list_scoped_recent_requests($1,$2,20)',[owner,b])).map(r=>r.id),[requestB.request_id]);
  assert.deepEqual((await sql('select * from saas_business.bg_list_scoped_recent_requests($1,$2,20)',[viewer,a])).map(r=>r.id),[viewRequest.request_id]);
  await db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,viewer]);
  await assert.rejects(()=>sql('select saas_business.bg_conversation_scope($1,$2)',[viewer,viewConv]),/workspace access denied/);
  await assert.rejects(()=>sql('select * from saas_business.bg_list_scoped_recent_requests($1,$2,20)',[viewer,a]),/workspace access denied/);
  assert.deepEqual(await sql('select * from saas_business.bg_list_recent_requests($1,20)',[viewer]),[]);
  await assert.rejects(()=>sql('select * from saas_business.bg_submit_scoped_user_message($1,$2,$3,$4,$5,$6)',[viewer,viewConv,'bonjour',randomUUID(),'hash','business_advisor']),/workspace access denied/);
  await assert.rejects(()=>sql('select * from saas_business.bg_submit_user_message($1,$2,$3,$4,$5,$6)',[viewer,viewConv,'bonjour',randomUUID(),'hash','business_advisor']),/legacy message requires v3 protocol/);
  // Au-delà de la limite, conserver la fin de l'historique plutôt que le début.
  const longConv=await conversation(owner,b);
  await db.query(`insert into saas_business.messages(user_id,conversation_id,author_role,content,created_at)
    select $1,$2,'user','message-'||n, timestamptz '2026-01-01 00:00:00Z' + n * interval '1 second' from generate_series(1,205) n`,[owner,longConv]);
  const recent=await sql('select * from saas_business.bg_list_messages($1,$2,200)',[owner,longConv]);
  assert.equal(recent.length,200);
  assert.equal(recent[0].content,'message-6'); assert.equal(recent.at(-1).content,'message-205');
  // Même les opérations historiques de création, renommage et suppression
  // attendent le retrait d'un membre au lieu d'utiliser une autorisation périmée.
  for (const action of [
    () => conversation(viewer,a),
    () => sql('select saas_business.bg_rename_conversation($1,$2,$3)',[viewer,viewConv,'Ne doit pas changer']),
    () => sql('select saas_business.bg_delete_conversation($1,$2)',[viewer,viewConv]),
    () => submit(viewer,viewConv),
  ]) {
    await db.query("insert into saas_ugc.ugc_workspace_members(workspace_id,user_id,member_role) values($1,$2,'viewer')",[a,viewer]);
    await db.query('begin');
    await db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,viewer]);
    const waiting=action().then(value=>({value}),error=>({error}));
    await waitBlocked(edge2,edgePid,dbPid);
    await db.query('commit');
    assert.match((await waiting).error.message,/workspace access denied/);
  }
  assert.equal((await db.query('select title from saas_business.conversations where id=$1',[viewConv])).rows[0].title,'Test');
  // Deux transmissions identiques en concurrence sur la même conversation
  // se sérialisent puis retrouvent une seule requête et un seul message.
  const messageKey=randomUUID();
  const messageArgs=[owner,convB,'idempotence concurrente',messageKey,'same-hash','business_advisor'];
  await edge2.query('begin');
  const firstConcurrent=(await edge2.query('select * from saas_business.bg_submit_scoped_user_message($1,$2,$3,$4,$5,$6)',messageArgs)).rows[0];
  const nextConcurrent=edge.query('select * from saas_business.bg_submit_scoped_user_message($1,$2,$3,$4,$5,$6)',messageArgs);
  await waitBlocked(db,edgePid,edge2Pid); await edge2.query('commit');
  const replayConcurrent=(await nextConcurrent).rows[0];
  assert.equal(firstConcurrent.created,true); assert.equal(replayConcurrent.created,false);
  assert.equal(firstConcurrent.request_id,replayConcurrent.request_id);
  assert.equal((await db.query("select count(*)::int n from saas_business.messages where conversation_id=$1 and content='idempotence concurrente'",[convB])).rows[0].n,1);
  console.log('✓ conversations et requêtes par entreprise ; retrait d’accès et historique long récent');

  await assert.rejects(()=>propose(owner,b,convB,payment,invoiceA),/agent source not found/);
  await assert.rejects(()=>propose(owner,a,convB,payment,invoiceA),/conversation not found/);
  const key=randomUUID(); const first=await propose(owner,a,convA,payment,invoiceA,key);
  assert.equal(first.status,'pending_approval'); assert.equal((await list(owner,a,operations)).length,0);
  await assert.rejects(()=>sql('select saas_business.bg_agent_resolve_scoped_tool($1,$2,$3,$4)',[owner,b,first.id,'approved']),/tool execution not found/);
  assert.equal((await list(owner,a,operations)).length,0);
  await assert.rejects(()=>resolve(owner,first.id,null),/invalid tool decision/);
  await assert.rejects(()=>sql("select saas_business.bg_resolve_tool_execution($1,$2,'approved','{}'::jsonb)",[owner,first.id]),/workspace tool requires atomic service/);
  assert.equal((await list(owner,a,operations)).length,0);
  assert.equal((await propose(owner,a,convA,payment,invoiceA,key)).id,first.id);
  await assert.rejects(()=>propose(owner,b,convB,payment,invoiceB,key),/idempotency key conflict/);
  await assert.rejects(()=>resolve(other,first.id,'approved'),/tool execution not found/);
  const rejected=await propose(owner,b,convB,payment,invoiceB);
  assert.equal((await sql("select saas_business.bg_resolve_tool_execution($1,$2,'rejected','{}'::jsonb) as v",[owner,rejected.id]))[0].v.status,'rejected');
  assert.equal((await resolve(owner,rejected.id,'rejected')).status,'rejected'); assert.equal((await list(owner,b,operations)).length,0);
  const [r1,r2]=await Promise.all([
    sql('select saas_business.bg_agent_resolve_scoped_tool($1,$2,$3,$4) as v',[owner,a,first.id,'approved']).then(rows=>rows[0].v),
    edge2.query('select saas_business.bg_agent_resolve_tool($1,$2,$3) as v',[owner,first.id,'approved']).then(x=>x.rows[0].v),
  ]);
  assert.equal(r1.output_result.taskId,r2.output_result.taskId); assert.equal((await list(owner,a,operations)).length,1);
  const duplicate=await propose(owner,a,convA,payment,invoiceA);
  assert.equal((await resolve(owner,duplicate.id,'approved')).output_result.taskId,r1.output_result.taskId);
  assert.equal((await list(owner,a,operations)).length,1);
  await assert.rejects(()=>resolve(owner,first.id,'rejected'),/tool already resolved/);
  const stale=await propose(owner,b,convB,payment,invoiceB);
  await sql('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,b,invoiceB,payment,'{"status":"paye"}']);
  await assert.rejects(()=>resolve(owner,stale.id,'approved'),/source changed/);
  assert.equal((await list(owner,b,operations)).length,0);
  console.log('✓ confirmation, rejet, source périmée, idempotence et confirmations concurrentes');

  // Rejouer une création déjà confirmée doit rester déterministe, même si la source disparaît.
  const replaySource=await create(owner,b,payment,{invoiceRef:'REPLAY',amount:15,status:'en_retard'});
  const replayKey=randomUUID(), replay=await propose(owner,b,convB,payment,replaySource,replayKey);
  await sql('select saas_business.bg_delete_scoped_module_record($1,$2,$3,$4)',[owner,b,replaySource,payment]);
  assert.equal((await propose(owner,b,convB,payment,replaySource,replayKey)).id,replay.id);
  await assert.rejects(()=>resolve(owner,replay.id,'approved'),/source not found/);

  // La modification et la confirmation se sérialisent ; après la modification,
  // l'empreinte de la proposition ne correspond plus, aucune tâche n'est créée.
  const raceSource=await create(owner,a,payment,{invoiceRef:'RACE',amount:100,status:'en_retard'});
  const race=await propose(owner,a,convA,payment,raceSource);
  const tasksBefore=(await list(owner,a,operations)).length;
  await edge2.query('begin');
  await edge2.query('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,a,raceSource,payment,'{"amount":200}']);
  const raceResult=resolve(owner,race.id,'approved').then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid);
  await edge2.query('commit');
  assert.match((await raceResult).error.message,/source changed/);
  assert.equal((await list(owner,a,operations)).length,tasksBefore);

  // La révocation de consentement précède une confirmation en attente : le CRM
  // est effacé et la proposition ne peut plus produire de tâche.
  const crm=await put(owner,a,'growth_prospect',{name:'CRM test',stage:'qualifie'});
  const crmTask=await propose(owner,a,convA,'growth_prospect',crm);
  await edge2.query('begin');
  await edge2.query("select * from saas_business.bg_set_scoped_memory_consent($1,$2,false,'test-v1')",[owner,a]);
  const revokedResult=resolve(owner,crmTask.id,'approved').then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid);
  await edge2.query('commit');
  assert.match((await revokedResult).error.message,/memory consent required/);
  assert.equal((await list(owner,a,operations)).length,tasksBefore);
  await consent(owner,a);

  // Retrait de membre commencé avant la confirmation : l'écriture attend le
  // retrait et est refusée ; l'ordre inverse se termine avant la révocation.
  const memberInvoice=await create(editor,a,payment,{invoiceRef:'EDITOR',amount:12,status:'en_retard'});
  const memberConv=await conversation(editor,a);
  const memberTask=await propose(editor,a,memberConv,payment,memberInvoice);
  await db.query('begin');
  await db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,editor]);
  const memberResult=resolve(editor,memberTask.id,'approved').then(value=>({value}),error=>({error}));
  await waitBlocked(edge2,edgePid,dbPid);
  await db.query('commit');
  assert.match((await memberResult).error.message,/workspace access denied/);
  assert.equal((await db.query("select count(*)::int as n from saas_business.module_records where user_id=$1 and category=$2",[editor,operations])).rows[0].n,0);
  await db.query("insert into saas_ugc.ugc_workspace_members(workspace_id,user_id,member_role) values($1,$2,'editor')",[a,editor]);
  await edge2.query('begin');
  const accepted=(await edge2.query('select saas_business.bg_agent_resolve_tool($1,$2,$3) as v',[editor,memberTask.id,'approved'])).rows[0].v;
  const deletion=db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,editor]);
  await waitBlocked(edge,dbPid,edge2Pid);
  await edge2.query('commit'); await deletion;
  assert.equal(accepted.status,'executed');
  assert.equal((await db.query("select count(*)::int as n from saas_business.module_records where user_id=$1 and category=$2",[editor,operations])).rows[0].n,1);
  await assert.rejects(()=>resolve(editor,memberTask.id,'approved'),/workspace access denied/);
  console.log('✓ courses source, révocation de consentement et retrait de membre sérialisées');

  // Sales Automation : une décision humaine explicite dans l'interface précède
  // chaque appel ; la base vérifie atomiquement l'aperçu et sa source.
  const today=(await db.query("select (clock_timestamp() at time zone 'UTC')::date::text as day")).rows[0].day;
  const ruleData={name:'Relance panier',status:'actif',trigger:'panier_abandonne',delayDays:0};
  const cartData={reference:'CMD-TEST',status:'panier'};
  const rule=await create(owner,a,'bg_module_sales_automation',ruleData);
  const cart=await create(owner,a,'bg_module_order_cart_recovery',cartData);
  const autoTask=(ruleId,sourceId)=>({title:'Relance panier · CMD-TEST',owner:'',dueDate:today,priority:'moyenne',source:'sales_automation',sourcePlaybookId:ruleId,sourceRecordId:sourceId,notes:'À vérifier.',status:'a_faire'});
  const confirmAuto=async(u,w,ruleId,cat,sourceId,day,ruleSnapshot,sourceSnapshot,task)=>(await sql(
    'select saas_business.bg_confirm_automation_task($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as v',
    [u,w,ruleId,cat,sourceId,day,JSON.stringify(ruleSnapshot),JSON.stringify(sourceSnapshot),JSON.stringify(task)]))[0].v;
  const beforeAuto=(await list(owner,a,operations)).length;
  await assert.rejects(()=>confirmAuto(owner,b,rule,'bg_module_order_cart_recovery',cart,today,ruleData,cartData,autoTask(rule,cart)),/automation source changed/);
  await assert.rejects(()=>confirmAuto(viewer,a,rule,'bg_module_order_cart_recovery',cart,today,ruleData,cartData,autoTask(rule,cart)),/workspace access denied/);
  await assert.rejects(()=>confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',cart,'2000-01-01',ruleData,cartData,autoTask(rule,cart)),/automation preview expired/);
  await assert.rejects(()=>confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',cart,today,ruleData,cartData,{...autoTask(rule,cart),dueDate:'2000-01-01'}),/invalid automation task/);
  assert.equal((await list(owner,a,operations)).length,beforeAuto);
  const auto=await confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',cart,today,ruleData,cartData,autoTask(rule,cart));
  assert.equal(auto.created,true);
  const autoReplay=await confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',cart,today,ruleData,cartData,autoTask(rule,cart));
  assert.deepEqual(autoReplay,{taskId:auto.taskId,created:false});
  await sql('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,a,cart,'bg_module_order_cart_recovery','{"status":"recupere"}']);
  assert.deepEqual(await confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',cart,'2000-01-01',ruleData,cartData,autoTask(rule,cart)),{taskId:auto.taskId,created:false});
  const raceCart=await create(owner,a,'bg_module_order_cart_recovery',cartData);
  await edge2.query('begin');
  await edge2.query('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,a,raceCart,'bg_module_order_cart_recovery','{"status":"recupere"}']);
  const staleAuto=confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',raceCart,today,ruleData,cartData,autoTask(rule,raceCart)).then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid); await edge2.query('commit');
  assert.match((await staleAuto).error.message,/automation source changed/);
  assert.equal((await list(owner,a,operations)).length,beforeAuto+1);
  const ineligibleData={reference:'CMD-RÉCUPÉRÉE',status:'recupere'};
  const ineligible=await create(owner,a,'bg_module_order_cart_recovery',ineligibleData);
  await assert.rejects(()=>confirmAuto(owner,a,rule,'bg_module_order_cart_recovery',ineligible,today,ruleData,ineligibleData,autoTask(rule,ineligible)),/automation source no longer eligible/);
  // Une modification de règle déjà engagée doit également précéder et bloquer
  // la création ; comparer seulement la source ne suffirait pas.
  const raceRule=await create(owner,a,'bg_module_sales_automation',ruleData);
  const forRuleRace=await create(owner,a,'bg_module_order_cart_recovery',cartData);
  await edge2.query('begin');
  await edge2.query('select saas_business.bg_update_scoped_module_record($1,$2,$3,$4,$5::jsonb)',[owner,a,raceRule,'bg_module_sales_automation','{"status":"pause"}']);
  const changedRule=confirmAuto(owner,a,raceRule,'bg_module_order_cart_recovery',forRuleRace,today,ruleData,cartData,autoTask(raceRule,forRuleRace)).then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid); await edge2.query('commit');
  assert.match((await changedRule).error.message,/automation source changed/);
  const concurrentCart=await create(owner,a,'bg_module_order_cart_recovery',cartData);
  const simultaneousArgs=[owner,a,rule,'bg_module_order_cart_recovery',concurrentCart,today,JSON.stringify(ruleData),JSON.stringify(cartData),JSON.stringify(autoTask(rule,concurrentCart))];
  const [auto1,auto2]=await Promise.all([
    edge.query('select saas_business.bg_confirm_automation_task($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as v',simultaneousArgs),
    edge2.query('select saas_business.bg_confirm_automation_task($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as v',simultaneousArgs),
  ]);
  assert.equal(auto1.rows[0].v.taskId,auto2.rows[0].v.taskId);
  assert.deepEqual([auto1.rows[0].v.created,auto2.rows[0].v.created].sort(),[false,true]);

  // Tous les déclencheurs reposent sur des valeurs connues, avec dates et
  // mesures strictes ; une valeur manquante ne devient jamais un stock nul.
  const cases=[
    ['nouveau_prospect','bg_module_lead_rescue',{status:'nouveau'},true],
    ['nouveau_prospect','bg_module_lead_rescue',{status:'qualifie'},false],
    ['client_inactif','bg_module_customer_recovery',{status:'a_risque'},true],
    ['client_inactif','bg_module_customer_recovery',{status:'fidele'},false],
    ['facture_echue','bg_module_payment_recovery',{status:'a_echeance',dueDate:'2000-01-01'},true],
    ['facture_echue','bg_module_payment_recovery',{status:'relance',dueDate:'not-a-date'},false],
    ['facture_echue','bg_module_payment_recovery',{status:'relance',dueDate:today},false],
    ['stock_bas','bg_module_smart_inventory',{stock:0},true],
    ['stock_bas','bg_module_smart_inventory',{stock:'2',threshold:'3'},true],
    ['stock_bas','bg_module_smart_inventory',{stock:null,threshold:3},false],
    ['stock_bas','bg_module_smart_inventory',{stock:'0x10',threshold:30},false],
    ['stock_bas','bg_module_smart_inventory',{stock:2},false],
  ];
  for (const [trigger,category,sourceData,eligible] of cases) {
    const data={name:trigger,status:'actif',trigger,delayDays:0};
    const ruleId=await create(owner,a,'bg_module_sales_automation',data);
    const sourceId=await create(owner,a,category,sourceData);
    const task={...autoTask(ruleId,sourceId),priority:trigger==='facture_echue'?'haute':'moyenne'};
    const call=()=>confirmAuto(owner,a,ruleId,category,sourceId,today,data,sourceData,task);
    if (eligible) assert.equal((await call()).created,true,`${trigger} eligible`);
    else await assert.rejects(call,/automation source no longer eligible/);
  }
  const badDelay={name:'Délai invalide',status:'actif',trigger:'panier_abandonne',delayDays:2.5};
  const invalidRule=await create(owner,a,'bg_module_sales_automation',badDelay);
  const freshCart=await create(owner,a,'bg_module_order_cart_recovery',cartData);
  await assert.rejects(()=>confirmAuto(owner,a,invalidRule,'bg_module_order_cart_recovery',freshCart,today,badDelay,cartData,autoTask(invalidRule,freshCart)),/invalid automation delay/);
  await assert.rejects(()=>edge.query('select saas_business.bg_automation_number($1::jsonb)',['0']),/permission denied/);
  console.log('✓ aperçu Sales Automation confirmé, idempotence et sources vérifiées transactionnellement');

  // Deux écritures se disputent la dernière place, dans les deux ordres. La
  // capacité calculée par l'interface n'est qu'un instantané : c'est la RPC
  // de création sous verrou qui doit faire respecter la limite à 500.
  const autoCapSpace=(await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'Capacité automatisation') returning id",[owner])).rows[0].id;
  const capRule=await create(owner,autoCapSpace,'bg_module_sales_automation',ruleData);
  const capCart=await create(owner,autoCapSpace,'bg_module_order_cart_recovery',cartData);
  await db.query(`insert into saas_business.module_records(user_id,workspace_id,category,data)
    select $1,$2,$3,jsonb_build_object('title','Tâche '||n,'status','a_faire') from generate_series(1,499) n`,[owner,autoCapSpace,operations]);
  const capArgs=[owner,autoCapSpace,capRule,'bg_module_order_cart_recovery',capCart,today,JSON.stringify(ruleData),JSON.stringify(cartData),JSON.stringify(autoTask(capRule,capCart))];
  const capCount=async()=>(await db.query('select count(*)::int as n from saas_business.module_records where user_id=$1 and workspace_id=$2 and category=$3',[owner,autoCapSpace,operations])).rows[0].n;
  const createManual=(connection)=>connection.query('select saas_business.bg_create_scoped_module_record($1,$2,$3,$4::jsonb,null) as id',
    [owner,autoCapSpace,operations,JSON.stringify({title:'Dernière tâche manuelle',status:'a_faire'})]);
  const confirmCap=(connection)=>connection.query('select saas_business.bg_confirm_automation_task($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as v',capArgs);
  await edge2.query('begin');
  const manualLast=(await createManual(edge2)).rows[0].id;
  const waitingAuto=confirmCap(edge).then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid); await edge2.query('commit');
  assert.match((await waitingAuto).error.message,/module record limit reached/);
  assert.equal(await capCount(),500);
  assert.equal((await list(owner,autoCapSpace,operations)).length,500);
  assert.equal((await sql('select saas_business.bg_delete_scoped_module_record($1,$2,$3,$4) as v',[owner,autoCapSpace,manualLast,operations]))[0].v,true);
  assert.equal(await capCount(),499);
  await edge2.query('begin');
  const autoLast=(await confirmCap(edge2)).rows[0].v;
  const waitingManual=createManual(edge).then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid); await edge2.query('commit');
  assert.equal(autoLast.created,true);
  assert.match((await waitingManual).error.message,/module record limit reached/);
  assert.equal(await capCount(),500);
  assert.deepEqual((await confirmCap(edge)).rows[0].v,{taskId:autoLast.taskId,created:false});
  assert.equal(await capCount(),500);
  console.log('✓ dernière place : créations manuelle et automatique sérialisées ; rejeu vérifiable même à capacité pleine');

  const request=(await sql('select * from saas_business.bg_submit_scoped_user_message($1,$2,$3,$4,$5,$6)',[owner,convA,'plan',randomUUID(),'unique-hash','business_advisor']))[0];
  const tool=(await sql("select saas_business.bg_create_tool_execution($1,$2,$3,'propose_action_plan','write_requires_approval',$4::jsonb) as id",[owner,convA,request.request_id,JSON.stringify({summary:'Plan test',actions:['Étape 1']})]))[0].id;
  const done=await resolve(owner,tool,'approved');
  assert.equal(done.output_result.category,'growth_strategy');
  assert.equal((await memory(owner,a)).items.filter(x=>x.category==='growth_strategy').length,1);
  await resolve(owner,tool,'approved'); assert.equal((await memory(owner,a)).items.filter(x=>x.category==='growth_strategy').length,1);
  await db.query('delete from saas_business.ai_requests where id=$1',[request.request_id]);
  const detached=(await db.query('select request_id,user_id,conversation_id from saas_business.tool_executions where id=$1',[tool])).rows[0];
  assert.deepEqual(detached,{request_id:null,user_id:owner,conversation_id:convA});
  console.log('✓ plan enregistré une seule fois ; suppression ciblée de requête sans perdre propriétaire/conversation');

  const reportKey=randomUUID(); const doc={type:'health',test:true};
  const save=async(w,type='health',payload=doc) => (await sql('select saas_business.bg_save_agent_report($1,$2,$3,$4,$5,$6,$7::jsonb) as v',[owner,w,type,'2026-01-01','2026-01-31',reportKey,JSON.stringify(payload)]))[0].v;
  assert.equal((await save(a)).created,true); assert.equal((await save(a,'health',{changed:true})).report.test,true);
  await assert.rejects(()=>save(b),/idempotency key conflict/);
  assert.equal((await sql('select * from saas_business.bg_list_agent_reports($1,$2)',[owner,b])).length,0);
  // Une sauvegarde dont l'instantané CRM précède une révocation doit attendre
  // celle-ci puis refuser d'enregistrer de nouvelles informations CRM.
  const crmReportDoc={type:'health',coverage:[{category:'growth_prospect',status:'available'}]};
  const crmReportKey=randomUUID();
  const saveCrmReport=(key) => sql('select saas_business.bg_save_agent_report($1,$2,$3,$4,$5,$6,$7::jsonb) as v',
    [owner,a,'health','2026-01-01','2026-01-31',key,JSON.stringify(crmReportDoc)]).then(rows=>rows[0].v);
  const beforeRevoke=await saveCrmReport(crmReportKey);
  await edge2.query('begin');
  await edge2.query("select * from saas_business.bg_set_scoped_memory_consent($1,$2,false,'test-v1')",[owner,a]);
  const newKey=randomUUID();
  const saveAfterRevoke=saveCrmReport(newKey).then(value=>({value}),error=>({error}));
  await waitBlocked(db,edgePid,edge2Pid);
  await edge2.query('commit');
  assert.match((await saveAfterRevoke).error.message,/memory consent required/);
  assert.equal((await db.query('select count(*)::int as n from saas_business.agent_reports where user_id=$1 and idempotency_key=$2',[owner,newKey])).rows[0].n,0);
  const replayed=await saveCrmReport(crmReportKey);
  assert.equal(replayed.created,false); assert.equal(replayed.id,beforeRevoke.id);
  await consent(owner,a);
  // Les rapports conservés peuvent être supprimés sans toucher une autre
  // entreprise ou un autre compte. La limite ne bloque pas un rejeu existant.
  const delReport=async(u,w,id)=>(await sql('select saas_business.bg_delete_agent_report($1,$2,$3) as v',[u,w,id]))[0].v;
  assert.equal(await delReport(owner,b,beforeRevoke.id),false);
  await db.query("insert into saas_ugc.ugc_workspace_members(workspace_id,user_id,member_role) values($1,$2,'editor')",[a,other]);
  assert.equal(await delReport(other,a,beforeRevoke.id),false); // éditeur d'une entreprise, mais rapport d'un autre compte
  await db.query('delete from saas_ugc.ugc_workspace_members where workspace_id=$1 and user_id=$2',[a,other]);
  assert.equal(await delReport(owner,a,beforeRevoke.id),true);
  assert.equal(await delReport(owner,a,beforeRevoke.id),false);
  await assert.rejects(()=>delReport(other,a,beforeRevoke.id),/workspace access denied/);
  const capSpace=(await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'Limite rapports') returning id",[owner])).rows[0].id;
  await db.query(`insert into saas_business.agent_reports(user_id,workspace_id,report_type,period_from,period_to,idempotency_key,document)
    select $1,$2,'health','2026-01-01','2026-01-31',gen_random_uuid(),'{}'::jsonb from generate_series(1,100)`,[owner,capSpace]);
  const capped=await sql('select * from saas_business.bg_list_agent_reports($1,$2)',[owner,capSpace]);
  assert.equal(capped.length,100);
  const saveCapped=()=>sql('select saas_business.bg_save_agent_report($1,$2,$3,$4,$5,$6,$7::jsonb)',[owner,capSpace,'health','2026-01-01','2026-01-31',randomUUID(),'{}']);
  await assert.rejects(saveCapped,/report limit reached/);
  assert.equal(await delReport(owner,capSpace,capped[0].id),true); await saveCapped();
  await assert.rejects(()=>edge.query('select * from saas_business.agent_reports'),/permission denied/);
  await assert.rejects(()=>edge.query('select * from saas_business.module_records'),/permission denied/);
  await assert.rejects(()=>edge.query('select saas_business.bg_agent_source($1,$2,$3,$4)',[owner,a,payment,invoiceA]),/permission denied/);
  await assert.rejects(()=>edge.query('select saas_business.bg_lock_workspace_access($1,$2,true)',[owner,a]),/permission denied/);
  await assert.rejects(()=>db.query('delete from saas_business.workspace_memory_consent_events where user_id=$1',[owner]),/append-only/);
  // Une confirmation et une suppression d'entreprise ne doivent ni se croiser
  // ni produire de tâche orpheline, quel que soit l'ordre d'acquisition.
  const deletedFirst=(await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'Deletion first') returning id",[owner])).rows[0].id;
  const delSource=await create(owner,deletedFirst,payment,{invoiceRef:'DELETE-FIRST',status:'en_retard'});
  const delConv=await conversation(owner,deletedFirst);
  const delTask=await propose(owner,deletedFirst,delConv,payment,delSource);
  await db.query('begin');
  await db.query('delete from saas_ugc.ugc_workspaces where id=$1',[deletedFirst]);
  const waitingConfirm=resolve(owner,delTask.id,'approved').then(value=>({value}),error=>({error}));
  await waitBlocked(edge2,edgePid,dbPid);
  await db.query('commit');
  assert.match((await waitingConfirm).error.message,/workspace access denied|tool execution not found/);
  assert.equal((await db.query('select count(*)::int as n from saas_business.module_records where workspace_id=$1',[deletedFirst])).rows[0].n,0);
  const confirmedFirst=(await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'Confirmation first') returning id",[owner])).rows[0].id;
  const acceptedSource=await create(owner,confirmedFirst,payment,{invoiceRef:'CONFIRM-FIRST',status:'en_retard'});
  const acceptedConv=await conversation(owner,confirmedFirst);
  const acceptedTask=await propose(owner,confirmedFirst,acceptedConv,payment,acceptedSource);
  await edge2.query('begin');
  const executed=(await edge2.query('select saas_business.bg_agent_resolve_tool($1,$2,$3) as v',[owner,acceptedTask.id,'approved'])).rows[0].v;
  const waitingDelete=db.query('delete from saas_ugc.ugc_workspaces where id=$1',[confirmedFirst]);
  await waitBlocked(edge,dbPid,edge2Pid);
  await edge2.query('commit'); await waitingDelete;
  assert.equal(executed.status,'executed');
  assert.equal((await db.query('select count(*)::int as n from saas_business.module_records where workspace_id=$1',[confirmedFirst])).rows[0].n,0);
  console.log('✓ courses suppression d’entreprise/confirmation : résultat atomique et aucune tâche orpheline');

  // Une suppression du parent ne convertit jamais des données d'entreprise en données personnelles.
  await db.query('delete from saas_ugc.ugc_workspaces where id=$1',[a]);
  assert.equal((await db.query('select count(*)::int as n from saas_business.integration_connections where workspace_id=$1',[a])).rows[0].n,0);
  assert.equal((await listIntegrations(owner,b)).find(r=>r.connector_key==='shopify').status,'pending');
  assert.deepEqual((await sql('select * from saas_business.bg_list_integration_connections($1)',[owner])).map(r=>r.connector_key),['facebook']);
  assert.equal((await db.query('select count(*)::int as n from saas_business.workspace_memory_consent_events where workspace_id=$1',[a])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from saas_business.module_records where id=$1',[invoiceA])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from saas_business.conversations where id=$1',[convA])).rows[0].n,0);
  assert.deepEqual(await sql('select * from saas_business.bg_list_module_records($1,$2)',[owner,payment]),[]);
  assert.deepEqual((await list(owner,b,payment)).map(r=>r.id),[invoiceB]);
  console.log('✓ suppression d’entreprise : cascade ciblée sans transfert vers les données personnelles');

  const anon=client('authenticator'); await anon.connect(); await anon.query('set role authenticated');
  await assert.rejects(()=>anon.query('select saas_business.bg_business_snapshot($1,$2)',[owner,a]),/permission denied/); await anon.end();
  await db.query('select saas_business.bg_prepare_account_erasure($1)',[owner]);
  assert.equal((await db.query('select count(*)::int as n from saas_business.workspace_memory_consent_events where user_id=$1',[owner])).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from saas_business.agent_reports where user_id=$1',[owner])).rows[0].n,0);
  console.log('✓ rapports isolés et idempotents, RLS, privilèges minimaux et effacement de compte');
  console.log('\nToutes les vérifications Business Agent PostgreSQL sont passées.');
} finally {
  for (const c of [admin,edge2,edge,db]) if (c) await c.end().catch(()=>{});
  await server.stop();
}

// Seconde installation jetable : l'ancienne migration de modules existe déjà
// et contient des données avant la migration Phase 3 (scénario différent de la production relevée).
const legacyServer = await start({ fresh: true });
let legacyAdmin, legacyDb, legacyEdge;
try {
  legacyAdmin=client(); await legacyAdmin.connect(); await legacyAdmin.query(BOOTSTRAP); await legacyAdmin.end(); legacyAdmin=null;
  legacyDb=client('postgres'); await legacyDb.connect();
  await legacyDb.query(readFileSync(path.join(HERE,'prod_subset.sql'),'utf8'));
  await legacyDb.query(`create table saas_ugc.ugc_workspaces (id uuid primary key default gen_random_uuid(),owner_user_id uuid not null,name text not null,country_code text default 'ML',default_language text default 'fr');
    create table saas_ugc.ugc_workspace_members (id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,member_role text not null default 'editor');
    create table saas_ugc.ugc_brands (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,industry text,description text,voice_guidelines text,updated_at timestamptz default now());
    create table saas_ugc.ugc_products (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,description text,key_benefits text[],updated_at timestamptz default now());`);
  for (const name of ['20261110172827_business_grow_saas_business.sql','20261110172909_business_grow_ai_extensions.sql',
    '20261110180645_business_grow_erasure_fix.sql','20261114100000_business_grow_module_records.sql','20261114110000_business_grow_integration_requests.sql']) {
    await legacyDb.query(readMigration(name));
  }
  const u=(await legacyDb.query("insert into auth.users(email) values('legacy@test.local') returning id")).rows[0].id;
  const [wa,wb]=(await legacyDb.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'Ancienne entreprise'),($1,'Autre entreprise') returning id",[u])).rows.map(r=>r.id);
  const category='bg_module_lead_rescue';
  const personal=(await legacyDb.query("select saas_business.bg_create_module_record($1,$2,'{\"name\":\"Historique personnel\"}'::jsonb,'legacy-key') as id",[u,category])).rows[0].id;
  const scoped=(await legacyDb.query("insert into saas_business.module_records(user_id,workspace_id,category,data,dedupe_key) values($1,$2,$3,'{\"name\":\"Historique entreprise\"}'::jsonb,'scoped-key') returning id",[u,wa,category])).rows[0].id;
  const personalIntegration=(await legacyDb.query("insert into saas_business.integration_connections(user_id,connector_key,status) values($1,'shopify','pending') returning id",[u])).rows[0].id;
  const workspaceIntegration=(await legacyDb.query("insert into saas_business.integration_connections(user_id,workspace_id,connector_key,status) values($1,$2,'facebook','pending') returning id",[u,wa])).rows[0].id;
  await legacyDb.query(readMigration('20261114120000_business_agent_workspace.sql'));
  await legacyDb.query(readMigration('20261114120000_business_agent_workspace.sql')); // rejouée avec données préexistantes
  legacyEdge=client('postgres'); await legacyEdge.connect(); await legacyEdge.query('set role bg_edge');
  const personalRows=(await legacyEdge.query('select * from saas_business.bg_list_module_records($1,$2)',[u,category])).rows;
  const scopedRows=(await legacyEdge.query('select * from saas_business.bg_list_scoped_module_records($1,$2,$3)',[u,wa,category])).rows;
  assert.deepEqual(personalRows.map(r=>r.id),[personal]);
  assert.deepEqual(scopedRows.map(r=>r.id),[scoped]);
  assert.deepEqual((await legacyEdge.query('select * from saas_business.bg_list_integration_connections($1)',[u])).rows.map(r=>r.id),[personalIntegration]);
  assert.deepEqual((await legacyEdge.query('select * from saas_business.bg_list_scoped_integration_connections($1,$2)',[u,wa])).rows.map(r=>r.id),[workspaceIntegration]);
  assert.equal((await legacyEdge.query("select saas_business.bg_request_scoped_integration_connection($1,$2,'facebook') as status",[u,wb])).rows[0].status,'pending');
  assert.equal((await legacyEdge.query("select saas_business.bg_cancel_integration_request($1,'facebook') as ok",[u])).rows[0].ok,false);
  assert.equal((await legacyEdge.query('select saas_business.bg_update_module_record($1,$2,$3::jsonb) as ok',[u,scoped,'{"name":"ne doit pas modifier"}'])).rows[0].ok,false);
  const sameKey=(await legacyEdge.query("select saas_business.bg_create_scoped_module_record($1,$2,$3,'{\"name\":\"Autre espace\"}'::jsonb,'scoped-key') as id",[u,wb,category])).rows[0].id;
  assert.notEqual(sameKey,scoped);
  await legacyDb.query('delete from saas_ugc.ugc_workspaces where id=$1',[wa]);
  assert.deepEqual((await legacyEdge.query('select * from saas_business.bg_list_integration_connections($1)',[u])).rows.map(r=>r.id),[personalIntegration]);
  assert.equal((await legacyEdge.query('select * from saas_business.bg_list_scoped_integration_connections($1,$2)',[u,wb])).rows.length,1);
  assert.deepEqual((await legacyEdge.query('select * from saas_business.bg_list_module_records($1,$2)',[u,category])).rows.map(r=>r.id),[personal]);
  assert.deepEqual((await legacyEdge.query('select * from saas_business.bg_list_scoped_module_records($1,$2,$3)',[u,wb,category])).rows.map(r=>r.id),[sameKey]);
  console.log('✓ migration depuis ancienne table modules avec données : préservation, séparation, déduplication et cascade');
} finally {
  for (const c of [legacyAdmin,legacyEdge,legacyDb]) if (c) await c.end().catch(()=>{});
  await legacyServer.stop();
}
console.log('\nLes deux configurations PostgreSQL jetables ont été validées.');
