// Monte la base : socle + sous-ensemble prod + migrations Business Grow du dépôt.
import { start, client, BOOTSTRAP, readMigration, HERE } from './pg.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const server = await start({ fresh: true });
const admin = client(); await admin.connect(); await admin.query(BOOTSTRAP); await admin.end();
const db = client('postgres'); await db.connect();
const steps = [
  ['prod_subset', readFileSync(path.join(HERE, 'prod_subset.sql'), 'utf8')],
  ['stubs', `create table saas_ugc.ugc_workspaces (id uuid primary key default gen_random_uuid(), owner_user_id uuid, name text);
    create table saas_ugc.ugc_workspace_members (workspace_id uuid, user_id uuid, role text);
    create table saas_ugc.ugc_brands (id uuid primary key default gen_random_uuid(), workspace_id uuid, name text);
    create table saas_ugc.ugc_products (id uuid primary key default gen_random_uuid(), workspace_id uuid, name text);`],
  ['bg_core', readMigration('20261110172827_business_grow_saas_business.sql')],
  ['bg_ai', readMigration('20261110172909_business_grow_ai_extensions.sql')],
  // Migration prod 20261112054553 (absente du dépôt) : colonnes commerciales des formules.
  ['bg_catalog', `alter table saas_business.plans add column if not exists tagline text, add column if not exists monthly_price_minor bigint,
      add column if not exists currency text not null default 'XOF', add column if not exists monthly_credit_units integer,
      add column if not exists sort_order integer not null default 0, add column if not exists features jsonb not null default '[]'::jsonb,
      add column if not exists target_margin_percent numeric(6,2);
    create table if not exists saas_business.commercial_config (config_key text primary key, value jsonb not null, updated_at timestamptz not null default now());
    insert into saas_business.commercial_config(config_key, value) values ('pricing', '{"usd_to_xof":620,"billing_enabled":false,"payment_providers":[],"renewal_period_days":30,"target_margin_percent":95}') on conflict do nothing;
    insert into saas_business.plans(plan_key, display_name, sort_order) values ('essentiel','Essentiel',10),('croissance','Croissance',20),('scale','Scale',30) on conflict (plan_key) do nothing;`],
];
for (const [name, sql] of steps) {
  try { await db.query(sql); console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, e.message, e.position ? `→ …${sql.slice(Math.max(0, e.position - 200), +e.position + 100)}…` : '', e.where ?? ''); await db.end(); await server.stop(); process.exit(1); }
}
await db.end(); console.log('base ok');
