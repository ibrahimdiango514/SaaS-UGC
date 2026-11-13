// Banc PostgREST — cycle de vie de PostgreSQL 17 réel (local, jetable).
//
// Même approche que le banc saspay : binaires du paquet npm « embedded-postgres »,
// base dans un répertoire temporaire, écoute sur 127.0.0.1 uniquement. Ajout
// spécifique : TLS auto-signé (les Edge Functions exigent ssl:'require').
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
export const PORT = Number(process.env.VYORA_PGRST_PG_PORT ?? 54330);
export const GATEWAY_PORT = Number(process.env.VYORA_PGRST_PORT ?? 54331);
export const MOCK_AI_PORT = Number(process.env.VYORA_PGRST_AI_PORT ?? 54332);
export const EDGE_PORT = Number(process.env.VYORA_PGRST_EDGE_PORT ?? 54333);
const WORK = process.env.VYORA_PGRST_DIR ?? path.join(os.tmpdir(), 'vyora-postgrest');
const DATA = path.join(WORK, 'data');
const LOG = path.join(WORK, 'pg.log');
const CERT = path.join(WORK, 'server.crt');
const KEY = path.join(WORK, 'server.key');
export const MIGRATIONS = path.join(REPO, 'supabase/migrations');

export const PG_USER = 'supabase_admin';
export const PG_PASSWORD = 'pw';
export const AUTHENTICATOR_PASSWORD = 'pw';
export const BG_EDGE_PASSWORD = 'bg-edge-bench-pw';
export const BG_BILLING_PASSWORD = 'bg-billing-bench-pw';

const BIN = process.env.VYORA_PGRST_BIN
  ?? path.join(HERE, 'node_modules/@embedded-postgres', `${process.platform}-${process.arch}`, 'native/bin');

function bin(name) {
  if (!existsSync(path.join(BIN, name))) {
    throw new Error(`Binaire PostgreSQL introuvable (${BIN}/${name}). Lancez « npm install » dans supabase/tests/postgrest.`);
  }
  return path.join(BIN, name);
}

// Certificat auto-signé local (jamais exposé hors 127.0.0.1).
function ensureTls() {
  if (existsSync(CERT) && existsSync(KEY)) return;
  mkdirSync(WORK, { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', KEY, '-out', CERT,
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  chmodSync(KEY, 0o600);
}

export async function start({ fresh = true } = {}) {
  ensureTls();
  try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch { /* déjà arrêté */ }
  if (fresh) {
    if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const pwfile = path.join(WORK, 'pwfile');
    writeFileSync(pwfile, `${PG_PASSWORD}\n`);
    execFileSync(bin('initdb'), ['-D', DATA, '-U', PG_USER, `--pwfile=${pwfile}`, '-A', 'password', '-E', 'UTF8'], { stdio: 'ignore' });
  }
  const r = spawnSync(bin('pg_ctl'), ['-D', DATA, '-l', LOG, '-w', '-o', [
    `-p ${PORT}`,
    '-c', 'listen_addresses=127.0.0.1',
    '-c', 'fsync=off',
    '-c', 'ssl=on',
    '-c', `ssl_cert_file=${CERT}`,
    '-c', `ssl_key_file=${KEY}`,
  ].join(' '), 'start'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`pg_ctl start a échoué :\n${r.stdout}\n${r.stderr}\n--- log ---\n${existsSync(LOG) ? readFileSync(LOG, 'utf8') : ''}`);
  return { stop: async () => { try { execFileSync(bin('pg_ctl'), ['-D', DATA, '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch { /* déjà arrêté */ } } };
}

export function client(user = 'postgres', database = 'postgres') {
  return new pg.Client({ host: '127.0.0.1', port: PORT, user, password: PG_PASSWORD, database, ssl: { rejectUnauthorized: false } });
}

export async function withClient(user, fn, database = 'postgres') {
  const c = client(user, database);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

// Socle Supabase minimal : mêmes rôles / mêmes fonctions que le banc saspay
// (source unique de vérité : pg.mjs du banc saspay), pour une base comparable.
export const BOOTSTRAP = `
create role postgres login password 'pw' createrole bypassrls createdb;
create role anon nologin; create role authenticated nologin;
create role service_role nologin bypassrls;
create role authenticator login password 'pw' noinherit;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres with admin option;
grant create on database postgres to postgres;
grant all on schema public to postgres;
alter schema public owner to postgres;
create schema extensions authorization postgres;
-- pgcrypto RÉEL (fourni par le PostgreSQL embarqué) : digest, gen_random_bytes.
create extension if not exists pgcrypto with schema extensions;
-- pg_net / pg_cron : extensions Supabase indisponibles → stubs locaux (jamais
-- d'appel réseau) ; les migrations sont neutralisées (voir migrateAll).
create schema auth authorization supabase_admin;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, banned_until timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt()->>'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
grant usage on schema auth to postgres, anon, authenticated, service_role;
grant all on auth.users to postgres; grant select on auth.users to service_role;
grant execute on all functions in schema auth to public;
create schema storage authorization supabase_admin;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, owner_id text, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant all on all tables in schema storage to postgres with grant option;
alter table storage.objects owner to postgres; alter table storage.buckets owner to postgres;
create schema vault authorization supabase_admin;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text, created_at timestamptz default now(), updated_at timestamptz default now());
create view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$ insert into vault.secrets(secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default '') returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
grant usage on schema vault to postgres; grant all on all tables in schema vault to postgres; grant execute on all functions in schema vault to postgres;
create schema cron authorization supabase_admin;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$ insert into cron.job(jobname, schedule, command) values (job_name, schedule, command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
create function cron.unschedule(job_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = job_id returning true $$;
grant usage on schema cron to postgres; grant all on all tables in schema cron to postgres; grant usage on all sequences in schema cron to postgres; grant execute on all functions in schema cron to postgres;
create schema net authorization supabase_admin;
create table net._http_response (id bigserial primary key, status_code int, content text, headers jsonb, timed_out boolean, error_msg text, created timestamptz default now());
-- Types composites attendus par les migrations (http_collect_response renvoie
-- un résultat empaqueté : .response{status_code, body, headers} + .message).
do $$ begin
  if not exists (select 1 from pg_type where typname = '_http_response_body') then
    create type net._http_response_body as (status_code int, body text, headers jsonb, content text);
  end if;
  if not exists (select 1 from pg_type where typname = 'http_response_result') then
    create type net.http_response_result as (response net._http_response_body, message text);
  end if;
end $$;
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
create function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
-- Réponse factice déterministe (aucun appel réseau) : HTTP 200, corps JSON
-- vide de catalogue → les seeds qui en dépendent insèrent simplement 0 ligne.
create function net.http_collect_response(request_id bigint, block boolean default false) returns net.http_response_result language sql as $$
  select row(row(200, '{"models": []}'::text, '{}'::jsonb, '{"models": []}'::text), 'ok (banc local)')::net.http_response_result $$;
grant usage on schema net to postgres, service_role; grant all on all tables in schema net to postgres; grant execute on all functions in schema net to postgres, service_role;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

// Applique prod_subset + socle bench + TOUTES les migrations du dépôt, dans
// l'ordre chronologique. Échec bruyant au premier écart.
export async function migrateAll({ log = (m) => console.log(m) } = {}) {
  const baseSubset = readFileSync(path.join(REPO, 'supabase/tests/saspay/prod_subset.sql'), 'utf8');
  const baseExtra = readFileSync(path.join(HERE, 'base-extra.sql'), 'utf8');
  // Bouchons de catalogue Business Grow (même contenu que le banc saspay :
  // migration de production 20261112054553 absente du dépôt).
  const bgCatalog = `
    alter table saas_business.plans add column if not exists tagline text, add column if not exists monthly_price_minor bigint,
      add column if not exists currency text not null default 'XOF', add column if not exists monthly_credit_units integer,
      add column if not exists sort_order integer not null default 0, add column if not exists features jsonb not null default '[]'::jsonb,
      add column if not exists target_margin_percent numeric(6,2);
    create table if not exists saas_business.commercial_config (config_key text primary key, value jsonb not null, updated_at timestamptz not null default now());
    insert into saas_business.commercial_config(config_key, value) values ('pricing', '{"usd_to_xof":620,"billing_enabled":false,"payment_providers":[],"renewal_period_days":30,"target_margin_percent":95}') on conflict do nothing;
    insert into saas_business.plans(plan_key, display_name, sort_order) values ('essentiel','Essentiel',10),('croissance','Croissance',20),('scale','Scale',30) on conflict (plan_key) do nothing;`;
  // Comptes de connexion réels pour les rôles serveur (créés NOLOGIN par la
  // migration Business Grow). En production ces secrets vivent dans Supabase
  // Vault / Edge Secrets ; ici des mots de passe de test sur une base jetable.
  const bgRoles = `
    alter role bg_edge login password 'bg-edge-bench-pw';
    alter role bg_billing_worker login password 'bg-billing-bench-pw';`;
  // Les vues public.reelora_* sont créées par la migration v1 (security_invoker).
  // En production, les privilèges par défaut du projet Supabase donnent aux rôles
  // anon/authenticated/service_role les 4 privilèges DML sur les objets public.
  // Le banc les accorde explicitement (équivalent bench documenté) : la
  // RESTRICTION effective vient des GRANT des tables de base saas_ugc + du RLS,
  // exactement comme en production.
  const viewGrantsAll = (names) => `
    grant select, insert, update, delete on ${names.join(', ')} to anon, authenticated, service_role;`;
  const publicViewGrants = viewGrantsAll([
    'public.reelora_avatars', 'public.reelora_prompt_templates',
    'public.reelora_generation_presets', 'public.reelora_plans', 'public.reelora_subscriptions',
    'public.reelora_usage_events', 'public.reelora_notifications', 'public.reelora_audit_logs',
  ]);
  const publicViewGrants2 = viewGrantsAll([
    'public.reelora_avatars', 'public.reelora_prompt_templates',
    'public.reelora_generation_presets', 'public.reelora_plans', 'public.reelora_subscriptions',
    'public.reelora_usage_events', 'public.reelora_notifications', 'public.reelora_audit_logs',
    'public.reelora_video_models',
  ]);
  const steps = [
    ['prod_subset', baseSubset],
    ['bench_base_extra', baseExtra],
    ...migrationFiles().map((f) => [f, readFileSync(path.join(MIGRATIONS, f), 'utf8')]),
    ['bench_bg_roles', bgRoles],
    ['bench_bg_catalog_stub', bgCatalog],
  ];
  // L'ordre : prod_subset + bench_base_extra d'abord, puis les migrations
  // triées. Les bouchons Business Grow doivent précéder la migration saas
  // business qui crée plans (plus ancienne que les migrations saspay).
  const ordered = [];
  const bgRolesStep = ['bench_bg_roles', bgRoles];
  const bgCatalogStep = ['bench_bg_catalog_stub', bgCatalog];
  const viewGrantsStep = ['bench_public_view_grants', publicViewGrants];
  const viewGrantsStep2 = ['bench_public_view_grants_video_models', publicViewGrants2];
  for (const [name, sql] of steps) {
    if (name === 'bench_bg_roles' || name === 'bench_bg_catalog_stub') continue;
    ordered.push([name, sql]);
    if (name === '20261108163920_reelora_v1_schema.sql') ordered.push(viewGrantsStep);
    if (name === '20261110172827_business_grow_saas_business.sql') ordered.push(bgRolesStep);
    if (name === '20261110172909_business_grow_ai_extensions.sql') ordered.push(bgCatalogStep);
    if (name === '20261111143957_vyora_video_pricing_v1.sql') ordered.push(viewGrantsStep2);
  }
  // pg_net / pg_cron sont des extensions Supabase indisponibles dans le banc :
  // les stubs de BOOTSTRAP (schémas net / cron) les remplacent. On neutralise
  // donc les « create extension » des migrations (jamais de création réelle).
  const sanitize = (sql) => sql.replace(/^\s*create extension[^\n]*;/gim, '-- [banc] create extension neutralisée (stub local)');
  for (const [name, sql] of ordered) {
    log(`migration    ${name}`);
    try {
      await withClient('postgres', (db) => db.query(sanitize(sql)));
    } catch (e) {
      const pos = e.position ? `\n  position ${e.position} : …${sql.slice(Math.max(0, Number(e.position) - 260), Number(e.position) + 140).replace(/\n/g, '⏎')}…` : '';
      console.error(`ÉCHEC ${name}: ${e.message}${pos}${e.where ? `\n  where: ${e.where}` : ''}`);
      process.exitCode = 1;
      throw e;
    }
  }
}
