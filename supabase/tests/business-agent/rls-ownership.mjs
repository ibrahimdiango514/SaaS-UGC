// Audit de pré-livraison : un propriétaire SECURITY DEFINER ne doit pas
// court-circuiter RLS. Ce banc crée uniquement un schéma PostgreSQL jetable,
// sans utilisateur métier, sans données distantes et sans appel réseau externe.
// Il reste volontairement en échec tant que l'architecture ne satisfait pas
// cette exigence. Il ne prouve pas à lui seul l'isolation multi-entreprise.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Un nouveau répertoire évite de réinitialiser une base de test préexistante.
process.env.VYORA_PGTEST_DIR = mkdtempSync(path.join(os.tmpdir(), 'vyora-business-rls-audit-'));
const freePort = await new Promise((resolve, reject) => {
  const listener = createServer();
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const address = listener.address();
    if (!address || typeof address === 'string') return reject(new Error('Port local indisponible'));
    listener.close((error) => error ? reject(error) : resolve(address.port));
  });
});
process.env.VYORA_PGTEST_PORT = String(freePort);
const { start, client, BOOTSTRAP, readMigration, HERE } = await import('../saspay/pg.mjs');

const criticalFunctions = [
  'bg_create_conversation', 'bg_list_messages', 'bg_get_workspace_context',
  'bg_workspace_protocol', 'bg_lock_workspace_access', 'bg_submit_scoped_user_message',
  'bg_list_scoped_conversations', 'bg_list_scoped_module_records', 'bg_create_scoped_module_record',
  'bg_get_scoped_memory', 'bg_set_scoped_memory_consent', 'bg_business_snapshot',
  'bg_save_agent_report', 'bg_list_agent_reports', 'bg_agent_propose_task',
  'bg_agent_resolve_scoped_tool', 'bg_confirm_automation_task', 'bg_list_scoped_integration_connections',
];
const criticalTables = ['module_records', 'workspace_memory_consent_events', 'workspace_memory_profiles', 'workspace_memory_items', 'agent_reports'];

const server = await start({ fresh: true });
let admin, db;
try {
  admin = client(); await admin.connect(); await admin.query(BOOTSTRAP); await admin.end(); admin = null;
  db = client('postgres'); await db.connect();
  await db.query(readFileSync(path.join(HERE, 'prod_subset.sql'), 'utf8'));
  await db.query(`create table saas_ugc.ugc_workspaces (id uuid primary key default gen_random_uuid(),owner_user_id uuid not null,name text not null,country_code text default 'ML',default_language text default 'fr');
    create table saas_ugc.ugc_workspace_members (id uuid primary key default gen_random_uuid(),workspace_id uuid not null,user_id uuid not null,member_role text not null default 'editor');
    create table saas_ugc.ugc_brands (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,industry text,description text,voice_guidelines text,updated_at timestamptz default now());
    create table saas_ugc.ugc_products (id uuid primary key default gen_random_uuid(),workspace_id uuid,name text,description text,key_benefits text[],updated_at timestamptz default now());`);
  for (const migration of ['20261110172827_business_grow_saas_business.sql', '20261110172909_business_grow_ai_extensions.sql',
    '20261110180645_business_grow_erasure_fix.sql', '20261114110000_business_grow_integration_requests.sql',
    '20261114120000_business_agent_workspace.sql']) await db.query(readMigration(migration));

  // Lecture du catalogue seulement : ni lecture ni modification de données
  // utilisateur sous un rôle privilégié. Les tables du banc sont vides.
  const functions = (await db.query(`select p.proname, p.prosecdef, r.rolname as owner,
      r.rolsuper, r.rolbypassrls
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    join pg_catalog.pg_roles r on r.oid=p.proowner
    where n.nspname='saas_business' and p.proname=any($1::text[])
    order by p.proname`, [criticalFunctions])).rows;
  const tables = (await db.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='saas_business' and c.relname=any($1::text[])`, [criticalTables])).rows;
  const found = new Set(functions.map((row) => row.proname));
  const missing = criticalFunctions.filter((name) => !found.has(name));
  const unsafe = functions.filter((row) => row.prosecdef && (row.rolsuper || row.rolbypassrls));
  const badTables = criticalTables.filter((name) => !tables.some((row) => row.relname === name && row.relrowsecurity && row.relforcerowsecurity));
  console.log(`Tables Phase 3 avec RLS activée et forcée : ${criticalTables.length - badTables.length}/${criticalTables.length}`);
  console.log(`Fonctions critiques inspectées : ${found.size}/${criticalFunctions.length}`);
  if (missing.length) console.error(`BLOQUÉ : fonctions manquantes : ${missing.join(', ')}`);
  if (badTables.length) console.error(`BLOQUÉ : RLS absente ou non forcée : ${badTables.join(', ')}`);
  if (unsafe.length) {
    console.error(`BLOQUÉ : ${unsafe.length} fonction(s) SECURITY DEFINER ont un propriétaire superutilisateur ou BYPASSRLS :`);
    for (const row of unsafe) console.error(`  ${row.proname} : propriétaire ${row.owner}, superuser=${row.rolsuper}, bypassrls=${row.rolbypassrls}`);
  }
  if (missing.length || badTables.length || unsafe.length) {
    console.error('Ne pas déployer : FORCE ROW LEVEL SECURITY ne contraint pas un rôle BYPASSRLS. Revoir les propriétaires, les politiques et les accès de bout en bout.');
    process.exitCode = 1;
  } else {
    console.log('Propriétaires contrôlés sans BYPASSRLS ; les autorisations et l’isolation restent à démontrer en préproduction.');
  }
} finally {
  for (const connection of [admin, db]) if (connection) await connection.end().catch(() => {});
  await server.stop();
}
