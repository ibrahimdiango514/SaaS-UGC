// Tests de coexistence/retour arrière sans service distant.
// Les bundles exécutés sont le v22 réellement publié et l'artefact courant ;
// Auth et postgres.js sont remplacés par des adaptateurs locaux PostgreSQL 17.
// Ce banc n'est ni un déploiement réel ni une reproduction complète de Supabase.
import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { BOOTSTRAP, HERE, REPO, client, readMigration, start } from '../saspay/pg.mjs';

const v22Source = readFileSync(path.join(REPO, 'supabase/tests/business-agent/fixtures/business-grow-v22.edge.js'), 'utf8');
const newSource = readFileSync(path.join(REPO, 'supabase/functions/business-grow.edge.js'), 'utf8');
const digest = (source) => createHash('sha256').update(source).digest('hex');
assert.equal(digest(v22Source), '908af379b0eebc8ea89f35d1f912c38bfa59b7ef309ef86118af2f988b417952', 'fixture = bundle v22 publié');
assert.ok(readFileSync(path.join(REPO, 'supabase/functions/business-grow/loader.ts'), 'utf8').includes(digest(newSource)), 'générer l’artefact courant avant le test');

/** Exécute réellement le bundle, en conservant ses fonctions Edge et ses RPC. */
function serveBundle(source, connection, userId) {
  const observations = { queries: [], externalCalls: [] };
  const sql = async (parts, ...values) => {
    let query = parts[0];
    for (let i = 0; i < values.length; i += 1) query += `$${i + 1}${parts[i + 1]}`;
    observations.queries.push(query); // aucune valeur ni secret dans le journal de test
    return (await connection.query(query, values)).rows;
  };
  sql.json = (value) => JSON.stringify(value);
  let handler;
  const env = { SUPABASE_URL: 'https://auth.example.test', SUPABASE_ANON_KEY: 'test-public', BUSINESS_GROW_DATABASE_URL: 'local' };
  const sandbox = {
    __bgPostgres: () => sql,
    Deno: { env: { get: (key) => env[key] ?? '' }, serve: (fn) => { assert.equal(handler, undefined); handler = fn; } },
    fetch: async (url, init) => {
      if (String(url) !== 'https://auth.example.test/auth/v1/user') observations.externalCalls.push(String(url));
      assert.equal(String(url), 'https://auth.example.test/auth/v1/user', 'aucun appel fournisseur ni réseau réel');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer local-test');
      return new Response(JSON.stringify({ id: userId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    Request, Response, Headers, AbortSignal, URL, TextEncoder, TextDecoder, crypto: webcrypto,
    Error, TypeError, console: { error() {}, warn() {}, log() {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, sandbox, { timeout: 5000, filename: 'business-grow-bundle.js' });
  assert.equal(typeof handler, 'function');
  const call = async (body) => {
    const res = await handler(new Request('https://edge.example.test/business-grow', {
      method: 'POST', headers: { Authorization: 'Bearer local-test', Origin: 'https://vyora-ugc.netlify.app', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  call.observations = observations;
  return call;
}

const server = await start({ fresh: true });
let admin, db, edge;
try {
  admin = client(); await admin.connect(); await admin.query(BOOTSTRAP); await admin.end(); admin = null;
  db = client('postgres'); await db.connect();
  await db.query(readFileSync(path.join(HERE, 'prod_subset.sql'), 'utf8'));
  await db.query(`create table saas_ugc.ugc_workspaces (id uuid primary key default gen_random_uuid(),owner_user_id uuid not null,name text not null,country_code text default 'ML',default_language text default 'fr');
    create table saas_ugc.ugc_workspace_members (id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,member_role text not null default 'editor');
    create table saas_ugc.ugc_brands (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,industry text,description text,voice_guidelines text,updated_at timestamptz default now());
    create table saas_ugc.ugc_products (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,description text,key_benefits text[],updated_at timestamptz default now());`);
  for (const name of ['20261110172827_business_grow_saas_business.sql', '20261110172909_business_grow_ai_extensions.sql',
    '20261110180645_business_grow_erasure_fix.sql', '20261114110000_business_grow_integration_requests.sql']) await db.query(readMigration(name));
  const user = (await db.query("insert into auth.users(email) values('compat@test.local') returning id")).rows[0].id;
  const [a, b] = (await db.query("insert into saas_ugc.ugc_workspaces(owner_user_id,name) values($1,'A'),($1,'B') returning id", [user])).rows.map((row) => row.id);
  edge = client('postgres'); await edge.connect(); await edge.query('set role bg_edge');
  const oldEdge = serveBundle(v22Source, edge, user);
  const newEdge = serveBundle(newSource, edge, user);

  // Le v22 et sa base historique fonctionnent ; le nouveau status est 200 mais
  // ce prévol ne garantit pas que le protocole workspace existe déjà en SQL.
  assert.equal((await oldEdge({ action: 'status' })).status, 200);
  const oldConversation = await oldEdge({ action: 'conversations.create', workspaceId: a, title: 'Conversation A' });
  assert.equal(oldConversation.status, 200);
  const conversationA = oldConversation.body.data.conversationId;
  const oldPending = await oldEdge({ action: 'integrations.request', workspaceId: a, connectorKey: 'shopify' });
  assert.equal(oldPending.status, 200);
  assert.equal(oldPending.body.data.status, 'pending');
  assert.equal((await oldEdge({ action: 'integrations.list' })).body.data.connections[0].workspace_id, a);
  assert.equal((await newEdge({ action: 'status' })).status, 200);
  const beforeMigration = await newEdge({ action: 'v3.integrations.request', workspaceId: b, connectorKey: 'instagram' });
  assert.equal(beforeMigration.status, 503);
  assert.equal(beforeMigration.body.error.code, 'AGENT_UNAVAILABLE');
  assert.equal((await db.query("select count(*)::int n from saas_business.integration_connections where connector_key='instagram'")).rows[0].n, 0);
  console.log('✓ Edge récent avant migration : status 200 mais protocole v3 refusé sans écriture');

  await db.query(readMigration('20261114120000_business_agent_workspace.sql'));
  // Le code exact v22 ne comprend jamais les actions préfixées, même après SQL.
  for (const action of ['v3.conversations.list', 'v3.memory.get', 'v3.modules.records', 'v3.integrations.request', 'v3.automation.task.confirm']) {
    const response = await oldEdge({ action, workspaceId: b, connectorKey: 'instagram', category: 'bg_module_lead_rescue', op: 'create', data: { name: 'Ne pas créer' } });
    assert.equal(response.status, 400, action);
    assert.equal(response.body.error.code, 'UNKNOWN_ACTION', action);
  }
  assert.equal((await db.query("select count(*)::int n from saas_business.integration_connections where connector_key='instagram'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from saas_business.module_records")).rows[0].n, 0);
  console.log('✓ client v3 vers bundle v22 exact : UNKNOWN_ACTION, aucune écriture globale');

  // Nouveau frontend / nouvel Edge après migration : données par entreprise.
  const forA = await newEdge({ action: 'v3.modules.records', workspaceId: a, category: 'bg_module_payment_recovery', op: 'create', data: { invoiceRef: 'FAC-A', status: 'en_retard' } });
  const forB = await newEdge({ action: 'v3.modules.records', workspaceId: b, category: 'bg_module_payment_recovery', op: 'create', data: { invoiceRef: 'FAC-B', status: 'en_retard' } });
  assert.equal(forA.status, 200); assert.equal(forB.status, 200);
  const listA = await newEdge({ action: 'v3.modules.records', workspaceId: a, category: 'bg_module_payment_recovery', op: 'list' });
  assert.deepEqual(listA.body.data.records.map((r) => r.data.invoiceRef), ['FAC-A']);
  const listB = await newEdge({ action: 'v3.modules.records', workspaceId: b, category: 'bg_module_payment_recovery', op: 'list' });
  assert.deepEqual(listB.body.data.records.map((r) => r.data.invoiceRef), ['FAC-B']);
  assert.deepEqual((await newEdge({ action: 'v3.integrations.list', workspaceId: a })).body.data.connections.map((r) => r.connector_key), ['shopify']);
  assert.deepEqual((await newEdge({ action: 'v3.integrations.list', workspaceId: b })).body.data.connections, []);
  const newPending = await newEdge({ action: 'v3.integrations.request', workspaceId: b, connectorKey: 'instagram' });
  assert.equal(newPending.body.data.status, 'pending');
  const conversationB = await newEdge({ action: 'v3.conversations.create', workspaceId: b, title: 'Conversation B' });
  assert.equal(conversationB.status, 200);
  assert.equal((await newEdge({ action: 'v3.messages.list', workspaceId: b, conversationId: conversationA })).status, 404);
  const newMessage = await newEdge({ action:'v3.messages.send', workspaceId:a, conversationId:conversationA, content:'Message récent', idempotencyKey:randomUUID() });
  assert.equal(newMessage.status,503); // aucun fournisseur vérifié dans cette base jetable
  assert.equal(newMessage.body.error.code,'ROUTE_SELECTION_FAILED');
  assert.equal((await db.query("select count(*)::int n from saas_business.messages where conversation_id=$1 and content='Message récent'",[conversationA])).rows[0].n,1);
  console.log('✓ nouveau bundle et migration : lectures et écritures isolées par entreprise');

  // Les appels d'un ancien frontend ont toujours un périmètre personnel pour
  // mémoire/modules/intégrations, et listent les conversations accessibles de
  // plusieurs entreprises : ce mode ne satisfait PAS l'isolation de l'UI v3.
  const legacyWrite = await newEdge({ action: 'modules.records', category: 'bg_module_payment_recovery', op: 'create', data: { invoiceRef: 'FAC-PERSONNELLE' } });
  assert.equal(legacyWrite.status, 200);
  assert.deepEqual((await newEdge({ action: 'modules.records', category: 'bg_module_payment_recovery', op: 'list' })).body.data.records.map((r) => r.data.invoiceRef), ['FAC-PERSONNELLE']);
  const allConversations = await newEdge({ action: 'conversations.list' });
  assert.deepEqual(new Set(allConversations.body.data.conversations.map((r) => r.title)), new Set(['Conversation A', 'Conversation B']));
  assert.deepEqual((await newEdge({ action: 'integrations.list' })).body.data.connections, []);
  const legacyIntegration = await newEdge({ action: 'integrations.request', workspaceId: a, connectorKey: 'facebook' });
  assert.equal(legacyIntegration.status, 409);
  assert.equal(legacyIntegration.body.error.code, 'BUSINESS_GROW_UPGRADE_REQUIRED');
  assert.equal((await db.query("select count(*)::int n from saas_business.integration_connections where connector_key='facebook'")).rows[0].n, 0);
  console.log('✓ ancien frontend / nouvel Edge : portée historique constatée, demande ambiguë refusée');

  // Retour arrière Edge v22 après migration : ne réintroduit pas un repli v3,
  // mais les appels historiques restent personnels ou globaux selon leur RPC.
  // v22 construit son prompt avec la mémoire personnelle AVANT soumission.
  // L'ancienne RPC doit bloquer la conversation entreprise avant qu'il puisse
  // contacter un fournisseur, même après migration ou lors d'un rollback.
  const messagesBefore=(await db.query('select count(*)::int n from saas_business.messages where conversation_id=$1',[conversationA])).rows[0].n;
  const oldQueryStart=oldEdge.observations.queries.length;
  const legacyMessage=await oldEdge({ action:'messages.send', conversationId:conversationA, workspaceId:a, content:'Test historique', idempotencyKey:randomUUID() });
  assert.equal(legacyMessage.status,500);
  const legacyQueries=oldEdge.observations.queries.slice(oldQueryStart).join(' ');
  assert.match(legacyQueries,/bg_submit_user_message/);
  assert.doesNotMatch(legacyQueries,/bg_select_route|bg_start_request/);
  assert.deepEqual(oldEdge.observations.externalCalls,[]);
  assert.equal((await db.query('select count(*)::int n from saas_business.messages where conversation_id=$1',[conversationA])).rows[0].n,messagesBefore);
  const personal = await newEdge({ action:'conversations.create', title:'Historique personnel', workspaceId:null });
  assert.equal(personal.status,200);
  const legacyPersonalMessage=await oldEdge({ action:'messages.send', conversationId:personal.body.data.conversationId, workspaceId:a, content:'Contexte mixte interdit', idempotencyKey:randomUUID() });
  assert.equal(legacyPersonalMessage.status,500);
  assert.equal((await db.query('select count(*)::int n from saas_business.messages where conversation_id=$1',[personal.body.data.conversationId])).rows[0].n,0);
  assert.deepEqual((await oldEdge({ action: 'modules.records', category: 'bg_module_payment_recovery', op: 'list' })).body.data.records.map((r) => r.data.invoiceRef), ['FAC-PERSONNELLE']);
  assert.deepEqual((await oldEdge({ action: 'integrations.list' })).body.data.connections, []);
  const rollbackIntegration = await oldEdge({ action: 'integrations.request', workspaceId: a, connectorKey: 'facebook' });
  assert.equal(rollbackIntegration.status, 500); // v22 masque l'exception SQL en erreur générique
  assert.equal((await db.query("select count(*)::int n from saas_business.integration_connections where connector_key='facebook'")).rows[0].n, 0);
  const proposed = await newEdge({ action: 'v3.agent.task.propose', workspaceId: a, conversationId: conversationA,
    sourceCategory: 'bg_module_payment_recovery', sourceRecordId: forA.body.data.recordId, idempotencyKey: randomUUID() });
  assert.equal(proposed.status, 200);
  const rejectedOldApproval = await oldEdge({ action: 'tools.resolve', executionId: proposed.body.data.id, decision: 'approved' });
  assert.equal(rejectedOldApproval.status, 500);
  assert.equal((await db.query("select count(*)::int n from saas_business.module_records where category='bg_module_operations_manager'")).rows[0].n, 0);
  const approved = await newEdge({ action: 'v3.tools.resolve', workspaceId: a, executionId: proposed.body.data.id, decision: 'approved' });
  assert.equal(approved.status, 200); assert.equal(approved.body.data.status, 'executed');
  console.log('✓ rollback Edge v22 simulé : messages v22 et approbations non atomiques refusés');
  console.log('\nCompatibilité locale validée avec le bundle v22 publié et PostgreSQL jetable ; aucun déploiement effectué.');
} finally {
  for (const connection of [admin, edge, db]) if (connection) await connection.end().catch(() => {});
  await server.stop();
}
