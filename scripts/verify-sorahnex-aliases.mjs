#!/usr/bin/env node
/**
 * Vérifie la couche d'alias SQL SORAHNEX dans un PostgreSQL RÉEL mais ISOLÉ.
 *
 * PGlite est un PostgreSQL compilé en WebAssembly, exécuté dans ce processus :
 * aucun serveur, aucun réseau, aucune connexion à la production. Le script :
 *   1. crée des fonctions historiques `vyora_*` / `reelora_*` avec des rôles
 *      et des grants réalistes (dont une `SECURITY DEFINER`) ;
 *   2. génère le SQL avec `scripts/generate-sorahnex-sql-aliases.mjs` ;
 *   3. l'applique, appelle les alias, et vérifie résultats, droits et
 *      `prosecdef` ;
 *   4. applique le retour arrière et vérifie que seuls les alias disparaissent.
 *
 * Toute divergence fait échouer le script avec un code de sortie non nul.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dir = mkdtempSync(path.join(tmpdir(), 'sorahnex-alias-'));
const snapshotPath = path.join(dir, 'pg-proc.json');
const upPath = path.join(dir, 'up.sql');
const downPath = path.join(dir, 'down.sql');

const snapshot = [
  {
    schema: 'public', name: 'vyora_admin_metrics', args: 'p_months integer',
    result: 'integer', setof: false,
    acl: 'postgres=X/postgres|authenticated=X/postgres|service_role=X/postgres',
  },
  {
    schema: 'public', name: 'reelora_start_generation', args: 'p_project_id uuid, p_service_key text',
    result: 'uuid', setof: false,
    acl: 'postgres=X/postgres|authenticated=X/postgres',
  },
  {
    // Signature ambiguë : le générateur doit la refuser, pas la deviner.
    schema: 'public', name: 'vyora_ambiguous', args: 'uuid',
    result: 'void', setof: false, acl: '',
  },
];
writeFileSync(snapshotPath, JSON.stringify(snapshot), 'utf8');

execFileSync(process.execPath, ['scripts/generate-sorahnex-sql-aliases.mjs', '--snapshot', snapshotPath, '--out', upPath], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/generate-sorahnex-sql-aliases.mjs', '--snapshot', snapshotPath, '--down', '--out', downPath], { stdio: 'inherit' });

const upSql = execFileSync('cat', [upPath], { encoding: 'utf8' });
const downSql = execFileSync('cat', [downPath], { encoding: 'utf8' });

const failures = [];
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!condition) failures.push(name);
};

const db = await PGlite.create();

await db.exec(`
  create role authenticated;
  create role service_role;
  create role anon;

  create table public.vyora_calls (id serial primary key, note text);

  -- Fonction de lecture protégée : le propriétaire est le seul à écrire.
  create function public.vyora_admin_metrics(p_months integer)
  returns integer
  language plpgsql
  security definer
  set search_path = ''
  as $$ begin return p_months * 100; end $$;

  create function public.reelora_start_generation(p_project_id uuid, p_service_key text)
  returns uuid
  language sql
  security definer
  set search_path = ''
  as $$ select p_project_id $$;

  create function public.vyora_ambiguous(uuid)
  returns void language sql as $$ select $$;

  revoke all on function public.vyora_admin_metrics(integer) from public;
  grant execute on function public.vyora_admin_metrics(integer) to authenticated, service_role;
  revoke all on function public.reelora_start_generation(uuid, text) from public;
  grant execute on function public.reelora_start_generation(uuid, text) to authenticated;
`);

await db.exec(upSql);

check('le générateur refuse la signature ambiguë', upSql.includes('vyora_ambiguous — Argument sans nom'), true);
check(
  'aucun alias ambigu créé',
  upSql.includes('sorahnex_ambiguous') === false,
  upSql.includes('sorahnex_ambiguous'),
);

const value = await db.query('select public.sorahnex_admin_metrics(3) as v');
check('l’alias renvoie le résultat de la fonction historique', Number(value.rows[0].v) === 300, value.rows[0]);

const id = '00000000-0000-0000-0000-000000000001';
const generated = await db.query(`select public.sorahnex_start_generation('${id}'::uuid, 'ugc') as v`);
check('le second alias délègue correctement', generated.rows[0].v === id, generated.rows[0]);

const flags = await db.query(`
  select p.proname, p.prosecdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'sorahnex\\_%'
   order by p.proname
`);
check('les alias sont SECURITY INVOKER (aucun élargissement de droits)', flags.rows.every((r) => r.prosecdef === false), flags.rows);
check('deux alias créés, pas trois', flags.rows.length === 2, flags.rows.length);

const grants = await db.query(`
  select has_function_privilege('authenticated', 'public.sorahnex_admin_metrics(integer)', 'EXECUTE') as auth,
         has_function_privilege('anon', 'public.sorahnex_admin_metrics(integer)', 'EXECUTE') as anon
`);
check('les droits d’origine sont recopiés (authenticated autorisé)', grants.rows[0].auth === true, grants.rows[0]);
check('aucun droit élargi à anon', grants.rows[0].anon === false, grants.rows[0]);

const originals = await db.query(`
  select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('vyora_admin_metrics','reelora_start_generation','vyora_ambiguous')
`);
check('les fonctions historiques sont intactes', originals.rows[0].n === 3, originals.rows[0].n);

await db.exec(downSql);

const after = await db.query(`
  select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'sorahnex\\_%'
`);
check('le retour arrière supprime les alias', after.rows[0].n === 0, after.rows[0].n);

const stillThere = await db.query(`select public.vyora_admin_metrics(2) as v`);
check('après retour arrière, la fonction historique répond toujours', Number(stillThere.rows[0].v) === 200, stillThere.rows[0]);

await db.close();

console.log(`\n${failures.length === 0 ? 'Tout est vert' : `${failures.length} échec(s)`} · base isolée PGlite (aucune connexion distante)`);
process.exit(failures.length === 0 ? 0 : 1);
