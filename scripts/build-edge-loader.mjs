#!/usr/bin/env node
/**
 * Prépare la publication d'une Edge Function dont la source dépasse la charge
 * fiable du canal de déploiement (connecteur Supabase).
 *
 * ## Pourquoi
 * Le canal existant ne transmet fidèlement qu'une charge courte (constat déjà
 * documenté : un corps de ~16 Ko arrive altéré). Les fonctions IA les plus
 * longues (`vyora-ai`, `vyora-ai-providers`, `vyora-provider-health`) sont donc
 * publiées en TROIS temps :
 *   1. le bundle esbuild déterministe (gzip + base64) est découpé en tranches
 *      de 2 000 caractères, écrites dans `public._edge_function_artifact_slices` ;
 *   2. la fonction déployée n'est qu'un CHARGEUR court : il recompose les
 *      tranches, vérifie la taille et le SHA-256, puis exécute le code ;
 *   3. un test (`tests/edge-loader-parity.test.ts`) vérifie que le chargeur du
 *      dépôt et le bundle sont identiques octet pour octet.
 *
 * ## Déterminisme
 * `gzipSync` écrit un horodatage (MTIME) : il est forcé à 0, l'artefact est
 * donc reproductible octet pour octet.
 *
 * ## Sorties (par fonction)
 *   supabase/functions/<slug>.edge.js       — bundle esbuild (référence lisible)
 *   supabase/functions/<slug>/loader.ts     — chargeur court (source déployée)
 *   supabase/migrations/<ts>_<slug>_artifact.sql — écriture des tranches
 *
 * ## Usage
 *   node scripts/build-edge-loader.mjs vyora-ai-providers
 *   node scripts/build-edge-loader.mjs --all
 *   node scripts/build-edge-loader.mjs --check vyora-ai-providers
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import esbuild from 'esbuild';

export const SLICE_CHARS = 2000;
export const SLICES_TABLE = '_edge_function_artifact_slices';

/** Fonctions publiées par chargeur (source longue). */
export const LOADER_TARGETS = {
  'vyora-ai': { migration: '20261115220000' },
  'vyora-ai-providers': { migration: '20261115220100' },
  'vyora-provider-health': { migration: '20261115220200' },
  // Serveur MCP : publié par chargeur comme les trois fonctions IA. Le code
  // exécuté est exactement le bundle du dépôt, recomposé depuis les tranches et
  // vérifié par SHA-256 avant exécution — la divergence entre source du dépôt et
  // source déployée devient donc détectable et, en pratique, impossible.
  'vyora-mcp': { migration: '20261116020000' },
  // Connecteurs OAuth Google (Gmail, Drive, Calendar). Même raison d'être :
  // la fonction porte du chiffrement AES-256-GCM et une machine d'état OAuth ;
  // la publier par tranches vérifiées par SHA-256 évite qu'une altération en
  // transit modifie silencieusement un contrôle de sécurité.
  'vyora-oauth': { migration: '20261116040000' },
};

/**
 * Retire la syntaxe de module du bundle.
 *
 * Le code est exécuté par `new Function(...)`, qui refuse `export` / `import`.
 * Le handler est déjà publié sur `globalThis` par la fonction elle-même
 * (`globalThis.__vyoraXHandler`), donc les `export` ne servent qu'aux tests
 * Node — qui importent la source TypeScript, pas cet artefact.
 */
export function stripModuleSyntax(source) {
  const withoutExports = source
    // `export{...}` (forme minifiée) : supprimé intégralement, jamais réécrit —
    // le réécrire en `void{...}` laisserait une assertion de type invalide.
    .replace(/export\s*\{[^}]*\}\s*;?/g, '')
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '');
  if (/^\s*(export|import)\s/m.test(withoutExports)) {
    throw new Error('le bundle contient encore une instruction de module');
  }
  return withoutExports.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** gzip reproductible : ni horodatage, ni champ OS variable. */
export function deterministicGzip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return gzipSync(buffer, { level: 9, mtime: 0, portable: true });
}

/**
 * Construit le bundle d'une fonction (aucune dépendance externe ajoutée).
 *
 * `minify` n'est pas cosmétique : le canal de déploiement altère les sources
 * longues. Minifié, `vyora-ai` passe sous la limite fiable ; les deux autres
 * fonctions restent livrées par chargeur (tranches + SHA-256) pour la même
 * raison. Le code exécuté reste exactement celui du dépôt.
 */
export function buildBundle(root, slug) {
  const result = esbuild.buildSync({
    entryPoints: [join(root, 'supabase/functions', slug, 'index.ts')],
    bundle: true,
    write: false,
    minify: true,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const source = stripModuleSyntax(result.outputFiles[0].text.replace(/\r\n/g, '\n'));
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  const gz = deterministicGzip(source);
  const base64 = gz.toString('base64');
  const slices = [];
  for (let i = 0; i < base64.length; i += SLICE_CHARS) slices.push(base64.slice(i, i + SLICE_CHARS));
  // Empreinte des tranches : ce que la publication SQL vérifie, et ce que le
  // test de parité compare à la base (détecte une tranche altérée en transit).
  const base64Md5 = createHash('md5').update(base64, 'utf8').digest('hex');
  return { source, sha256, base64, base64Md5, slices, chars: source.length, gzBytes: gz.length };
}

/** Source du chargeur : court, sans logique métier, vérifie taille + SHA-256. */
export function renderLoader(slug, built) {
  return `// ${slug} — chargeur de production (seule source déployée).
// Généré par scripts/build-edge-loader.mjs : ne pas éditer.
//
// Le canal de déploiement altère les sources longues : ce fichier reste court.
// Le code métier est lu dans public.${SLICES_TABLE} (nom + SHA-256), recomposé,
// puis vérifié AVANT exécution : un artefact absent ou modifié n'est jamais exécuté.
const NAME = "${slug}";
const SHA256 = "${built.sha256}";
const CHARS = ${built.chars};

function env(name: string): string {
  const g = globalThis as unknown as {
    Deno?: { env?: { get(k: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name] ?? "";
}

async function readArtifact(): Promise<string> {
  const base = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("runtime_env_missing");
  const res = await fetch(
    base + "/rest/v1/${SLICES_TABLE}?select=part,chunk&name=eq." + NAME + "&order=part.asc",
    { headers: { apikey: key, Authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000) },
  );
  if (!res.ok) throw new Error("artifact_read_failed:" + res.status);
  const rows = (await res.json()) as Array<{ part?: unknown; chunk?: unknown }>;
  const base64 = rows.map((row) => (typeof row.chunk === "string" ? row.chunk : "")).join("");
  if (!base64) throw new Error("artifact_missing");
  const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const stream = new Blob([binary]).stream().pipeThrough(new DecompressionStream("gzip"));
  const source = await new Response(stream).text();
  if (source.length !== CHARS) throw new Error("artifact_size_mismatch:" + source.length);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== SHA256) throw new Error("artifact_digest_mismatch");
  return source;
}

const failures: string[] = [];
let CODE = "";
// Trois essais : une lecture ratée à froid ne doit pas figer l'instance.
for (let attempt = 1; attempt <= 3 && !CODE; attempt += 1) {
  try {
    CODE = await readArtifact();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
}

if (CODE) {
  // Le bundle s'exécute hors module : il enregistre lui-même Deno.serve.
  new Function(CODE)();
} else {
  const failure = failures[failures.length - 1] ?? "unknown";
  console.error(NAME + " artifact load failed: " + failure);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  const body = JSON.stringify({
    error: {
      code: "EDGE_ARTIFACT_UNAVAILABLE",
      message: "Le service " + NAME + " n'a pas pu charger son code (" + failure + ").",
    },
  });
  const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Response) => void } };
  runtime.Deno?.serve?.((request: Request) =>
    request.method === "OPTIONS" ? new Response("ok", { headers }) : new Response(body, { status: 503, headers }),
  );
}
`;
}

/** Échappement d'un texte en littéral SQL (quotes simples doublées). */
export function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * SQL de publication de l'artefact.
 *
 * Le chargeur lit `_edge_function_artifact_slices` : la publication vérifie
 * donc exactement ce qu'il recomposera. Un `do $$ ... $$` concatène les
 * tranches telles qu'elles viennent d'être écrites et échoue si le nombre de
 * tranches, leur taille (tranche 0..n-1, ≤ 2 000 caractères) ou l'empreinte
 * MD5 de la concaténation diffèrent de ce que le générateur a produit. Une
 * publication incohérente est annulée — plus de tranche périmée silencieuse.
 *
 * Pourquoi MD5 et pas le SHA-256 du bundle : ce SHA-256 porte sur le source
 * décompressé, et Postgres ici n'expose aucune fonction gzip
 * (`pgp_gunzip` absent de `extensions`). Le SHA-256 du source est de toute
 * façon revérifié en production par le chargeur lui-même avant exécution
 * (`artifact_digest_mismatch`) ; ici on garantit l'intégrité du transport, ce
 * que MD5 suffit à détecter (aucune adversité en jeu : une ligne altérée
 * accidentellement).
 *
 * Ne PAS recopier `source` dans `_edge_function_artifact` : sa clé est
 * (name, sha256) — `on conflict (name)` y répond 42P10 — et un littéral de
 * 35 Ko rendrait ce fichier illisible sans rien garantir de plus.
 */
export function renderSeedSql(slug, built) {
  const values = built.slices
    .map((chunk, index) => `  (${index}, ${sqlLiteral(chunk)})`)
    .join(',\n')
    .split('\n')
    .map((line) => line.replace('  (', `  (${sqlLiteral(slug)}, `))
    .join('\n');
  return `-- ${slug} — publication de l'artefact (${built.chars} caractères, ${built.slices.length} tranches).
-- Généré par scripts/build-edge-loader.mjs : ne pas éditer.
delete from public.${SLICES_TABLE} where name = ${sqlLiteral(slug)};

insert into public.${SLICES_TABLE}(name, part, chunk)
values
${values};

-- Le chargeur déployé recompose exactement ces tranches : on vérifie ici ce
-- qu'il lira, et non une constante recopiée à la main.
do $artifact$
declare
  assembled text;
  parts integer;
begin
  select count(*), string_agg(chunk, '' order by part)
    into parts, assembled
  from public.${SLICES_TABLE} where name = ${sqlLiteral(slug)};

  if assembled is null or parts <> ${built.slices.length} then
    raise exception 'artefact % : % tranches publiées au lieu de %',
      ${sqlLiteral(slug)}, coalesce(parts, 0), ${built.slices.length};
  end if;
  if exists (
    select 1 from public.${SLICES_TABLE}
    where name = ${sqlLiteral(slug)}
      and (part < 0 or part >= ${built.slices.length}
           or length(chunk) = 0 or length(chunk) > ${SLICE_CHARS})
  ) then
    raise exception 'artefact % : numérotation ou taille de tranche invalide', ${sqlLiteral(slug)};
  end if;
  if length(assembled) <> ${built.base64.length} then
    raise exception 'artefact % : % caractères base64 au lieu de %',
      ${sqlLiteral(slug)}, length(assembled), ${built.base64.length};
  end if;
  if md5(assembled) <> ${sqlLiteral(built.base64Md5)} then
    raise exception 'artefact % : empreinte des tranches différente du chargeur', ${sqlLiteral(slug)};
  end if;
  raise notice 'artefact % publié : % caractères, % tranches, sha256 %',
    ${sqlLiteral(slug)}, ${built.chars}, ${built.slices.length}, ${sqlLiteral(built.sha256)};
end
$artifact$;
`;
}

function targetsFromArgs(argv) {
  const rest = argv.slice(2);
  if (rest[0] === '--all') return Object.keys(LOADER_TARGETS);
  const filtered = rest.filter((arg) => !arg.startsWith('--'));
  if (filtered.length === 0) {
    console.error('usage: node scripts/build-edge-loader.mjs [--all|--check] <slug...>');
    process.exit(2);
  }
  for (const slug of filtered) {
    if (!(slug in LOADER_TARGETS)) {
      console.error(`fonction inconnue : ${slug} (attendu : ${Object.keys(LOADER_TARGETS).join(', ')})`);
      process.exit(2);
    }
  }
  return filtered;
}

function main() {
  const argv = process.argv;
  const check = argv.includes('--check');
  const write = !check;
  const root = process.cwd();
  const targets = targetsFromArgs(argv);
  let stale = false;

  for (const slug of targets) {
    const built = buildBundle(root, slug);
    const loader = renderLoader(slug, built);
    const bundlePath = join(root, 'supabase/functions', `${slug}.edge.js`);
    const loaderPath = join(root, 'supabase/functions', slug, 'loader.ts');
    const migrationPath = join(
      root, 'supabase/migrations',
      `${LOADER_TARGETS[slug].migration}_${slug.replace(/-/g, '_')}_artifact.sql`,
    );

    if (check) {
      for (const [path, expected] of [
        [loaderPath, loader],
        [bundlePath, built.source],
        [migrationPath, renderSeedSql(slug, built)],
      ]) {
        const actual = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
        if (actual !== expected) {
          console.error(`désynchronisé : ${path.replace(root + '/', '')}`);
          stale = true;
        }
      }
      continue;
    }

    writeFileSync(loaderPath, loader);
    writeFileSync(bundlePath, built.source);
    writeFileSync(migrationPath, renderSeedSql(slug, built));
    console.log(
      `${slug} : ${built.chars} caractères, ${built.gzBytes} octets gzip, ` +
      `${built.slices.length} tranches, sha256 ${built.sha256.slice(0, 16)}…`,
    );
    console.log(`  écrit : supabase/functions/${slug}/loader.ts (${loader.length} octets)`);
    console.log(`  écrit : supabase/functions/${slug}.edge.js (${built.chars} octets)`);
    console.log(`  écrit : supabase/migrations/${migrationPath.split('/').pop()}`);
  }

  if (check && stale) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
