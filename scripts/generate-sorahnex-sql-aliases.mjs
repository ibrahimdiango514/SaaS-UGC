#!/usr/bin/env node
/**
 * Génère la couche d'alias SQL `sorahnex_*` à partir d'un instantané `pg_proc`.
 *
 * Pourquoi un instantané et pas une introspection directe ?
 *   Le fichier produit doit être relu, relu en revue de code et rejouable.
 *   Un script qui interroge la base au moment du déploiement produirait un SQL
 *   différent à chaque exécution, impossible à relire.
 *
 * Le script n'applique RIEN. Il écrit du SQL sur la sortie standard (ou dans
 * `--out`). L'application reste une décision humaine, dans un projet de
 * développement, jamais en production directement.
 *
 * Instantané attendu (JSON) — une ligne par fonction :
 *   [{
 *     "schema": "public",
 *     "name": "vyora_admin_metrics",
 *     "args": "p_months integer",
 *     "result": "jsonb",
 *     "setof": false,
 *     "acl": "postgres=X/postgres|authenticated=X/postgres|service_role=X/postgres"
 *   }]
 *
 * Requête de collecte (lecture seule, à exécuter dans un projet de DEV) :
 *   select n.nspname as schema, p.proname as name,
 *          pg_get_function_identity_arguments(p.oid) as args,
 *          pg_get_function_result(p.oid) as result,
 *          p.proretset as setof,
 *          coalesce(array_to_string(p.proacl, '|'), '') as acl
 *     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 *    where n.nspname in ('public','ugc_private','saas_ugc','saas_business')
 *      and p.prokind = 'f'
 *      and (p.proname like 'vyora%' or p.proname like 'reelora%')
 *    order by 1, 2;
 *
 * Usage :
 *   node scripts/generate-sorahnex-sql-aliases.mjs --snapshot pg-proc.json
 *   node scripts/generate-sorahnex-sql-aliases.mjs --snapshot pg-proc.json --down
 *   node scripts/generate-sorahnex-sql-aliases.mjs --snapshot pg-proc.json --out supabase/naming/up.sql
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SCHEMAS = new Set(['public', 'ugc_private', 'saas_ugc', 'saas_business']);
const PREFIXES = ['vyora_', 'reelora_'];
const TARGET_PREFIX = 'sorahnex_';

function parseArgs(argv) {
  const options = { snapshot: '', out: '', down: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') options.snapshot = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--down') options.down = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: --snapshot <pg-proc.json> [--out <fichier.sql>] [--down]');
      process.exit(0);
    } else {
      throw new Error(`Argument inconnu : ${arg}`);
    }
  }
  if (!options.snapshot) throw new Error('--snapshot est obligatoire.');
  return options;
}

function canonicalName(name) {
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) return `${TARGET_PREFIX}${name.slice(prefix.length)}`;
  }
  return null;
}

/** Découpe une liste d'arguments SQL au niveau des virgules de premier niveau. */
function splitDeclarations(args) {
  if (!args.trim()) return [];
  const items = [];
  let current = '';
  let depth = 0;
  for (const char of args) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

/** « p_alert_id uuid, p_note text » → [{ declared, ref }] */
function parseSignatureArgs(args) {
  return splitDeclarations(args).map((declared) => {
    const match = /^([a-z_][a-z0-9_]*)\s+(.+)$/i.exec(declared);
    if (!match) throw new Error(`Argument sans nom, impossible de générer un appel sûr : « ${declared} »`);
    return { declared, ref: match[1], type: match[2] };
  });
}

function grantRoles(acl) {
  if (!acl) return [];
  return acl.split('|')
    .map((entry) => entry.split('=')[0])
    .filter((role) => role && role !== 'postgres');
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function buildUp(rows) {
  const lines = [
    '-- Généré par scripts/generate-sorahnex-sql-aliases.mjs — NE PAS ÉDITER À LA MAIN.',
    '--',
    '-- Couche de compatibilité : chaque fonction `sorahnex_*` délègue à la fonction',
    '-- historique. Aucune donnée n’est déplacée, aucun `DROP`, aucun grant retiré',
    '-- à l’original. Les droits sont recopiés depuis la fonction source.',
    '--',
    '-- À APPLIQUER DANS UN PROJET DE DÉVELOPPEMENT, JAMAIS EN PRODUCTION SANS',
    '-- VALIDATION. Voir docs/sorahnex-migration-technique.md.',
    '',
    'begin;',
    '',
  ];
  const skipped = [];

  for (const row of rows) {
    const target = canonicalName(row.name);
    if (!target || !SCHEMAS.has(row.schema)) continue;
    let args;
    try {
      args = parseSignatureArgs(row.args ?? '');
    } catch (error) {
      skipped.push(`${row.schema}.${row.name} — ${error.message}`);
      continue;
    }
    const signature = args.map((arg) => arg.declared).join(', ');
    const refs = args.map((arg) => arg.ref).join(', ');
    const qualifiedSource = `${quoteIdent(row.schema)}.${quoteIdent(row.name)}`;
    const qualifiedTarget = `${quoteIdent(row.schema)}.${quoteIdent(target)}`;
    const body = row.setof
      ? `select * from ${qualifiedSource}(${refs})`
      : `select ${qualifiedSource}(${refs})`;

    lines.push(`-- ${row.schema}.${row.name} → ${target}`);
    lines.push(
      `create or replace function ${qualifiedTarget}(${signature})\n`
      + `returns ${row.result}\n`
      + 'language sql\n'
      + 'security invoker\n'
      + 'set search_path = \'\'\n'
      + `as $$ ${body} $$;`,
    );
    lines.push(`revoke all on function ${qualifiedTarget}(${signature}) from public;`);
    const roles = grantRoles(row.acl ?? '');
    if (roles.length > 0) {
      for (const role of roles) {
        lines.push(`grant execute on function ${qualifiedTarget}(${signature}) to ${quoteIdent(role)};`);
      }
    } else {
      lines.push(`-- Aucun rôle explicite dans l’ACL d’origine : droits par défaut conservés.`);
    }
    lines.push('');
  }

  lines.push('commit;');
  if (skipped.length > 0) {
    lines.push('', '-- Fonctions NON générées (signature ambiguë, à traiter à la main) :');
    for (const entry of skipped) lines.push(`--   ${entry}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildDown(rows) {
  const lines = [
    '-- Retour arrière de la couche d’alias SORAHNEX.',
    '-- Seules les fonctions `sorahnex_*` sont retirées : les fonctions',
    '-- historiques, leurs données et leurs permissions ne sont pas touchées.',
    '',
    'begin;',
    '',
  ];
  for (const row of rows) {
    const target = canonicalName(row.name);
    if (!target || !SCHEMAS.has(row.schema)) continue;
    const args = splitDeclarations(row.args ?? '').join(', ');
    lines.push(`drop function if exists ${quoteIdent(row.schema)}.${quoteIdent(target)}(${args});`);
  }
  lines.push('', 'commit;');
  return `${lines.join('\n')}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = JSON.parse(readFileSync(options.snapshot, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('L’instantané doit être un tableau JSON.');
  const sql = options.down ? buildDown(rows) : buildUp(rows);
  if (options.out) {
    writeFileSync(options.out, sql, 'utf8');
    console.log(`${options.out} écrit (${sql.split('\n').length} lignes).`);
  } else {
    process.stdout.write(sql);
  }
}

main();
