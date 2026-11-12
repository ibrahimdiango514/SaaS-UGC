// Harnais local : PostgreSQL 17 réel + socle minimal « façon Supabase ».
//
// Aucune donnée ni aucun service distant : la base vit dans un répertoire
// temporaire et n'écoute que sur 127.0.0.1. Voir README.md.
import pg from 'pg';
import { readFileSync, readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../../..');
export const PORT = Number(process.env.VYORA_PGTEST_PORT ?? 54329);
const WORK = process.env.VYORA_PGTEST_DIR ?? path.join(os.tmpdir(), 'vyora-pgtest');
const DATA = path.join(WORK, 'data');
const PWFILE = path.join(WORK, 'pwfile');
const LOG = path.join(WORK, 'pg.log');
export const MIGRATIONS = path.join(REPO, 'supabase/migrations');

// Binaires PostgreSQL fournis par le paquet npm « embedded-postgres ».
const BIN = process.env.VYORA_PGTEST_BIN
  ?? path.join(HERE, 'node_modules/@embedded-postgres', `${process.platform}-${process.arch}`, 'native/bin');
export async function start({ fresh = true } = {}) {
  const { execFileSync } = await import('node:child_process');
  try { execFileSync(`${BIN}/pg_ctl`, ['-D', DATA, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch {}
  if (!existsSync(`${BIN}/initdb`)) {
    throw new Error(`Binaires PostgreSQL introuvables (${BIN}). Lancez « npm install » dans supabase/tests/saspay.`);
  }
  if (fresh) {
    if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    writeFileSync(PWFILE, 'pw\n'); // mot de passe d'une base jetable, locale uniquement
    execFileSync(`${BIN}/initdb`, ['-D', DATA, '-U', 'supabase_admin', `--pwfile=${PWFILE}`, '-A', 'password'], { stdio: 'ignore' });
  }
  execFileSync(`${BIN}/pg_ctl`, ['-D', DATA, '-l', LOG, '-w', '-o', `-p ${PORT} -c listen_addresses=127.0.0.1 -c fsync=off`, 'start'], { stdio: 'ignore' });
  return { stop: async () => { try { execFileSync(`${BIN}/pg_ctl`, ['-D', DATA, '-m', 'fast', 'stop'], { stdio: 'ignore' }); } catch {} } };
}

export function client(user = 'supabase_admin') {
  return new pg.Client({ host: '127.0.0.1', port: PORT, user, password: 'pw', database: 'postgres' });
}

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
create schema auth authorization supabase_admin;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, banned_until timestamptz);
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
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
grant usage on schema vault to postgres; grant all on all tables in schema vault to postgres; grant execute on all functions in schema vault to postgres;
create schema cron authorization supabase_admin;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$ insert into cron.job(jobname, schedule, command) values (job_name, schedule, command) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(job_name text) returns boolean language sql as $$ delete from cron.job where jobname = job_name returning true $$;
grant usage on schema cron to postgres; grant all on all tables in schema cron to postgres; grant usage on all sequences in schema cron to postgres; grant execute on all functions in schema cron to postgres;
create schema net authorization supabase_admin;
create table net._http_response (id bigserial primary key, status_code int, content text, headers jsonb, timed_out boolean, error_msg text, created timestamptz default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
create function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as $$ select 1::bigint $$;
grant usage on schema net to postgres, service_role; grant all on all tables in schema net to postgres; grant execute on all functions in schema net to postgres, service_role;
`;

export function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}
export function readMigration(file) {
  return readFileSync(path.join(MIGRATIONS, file), 'utf8');
}
