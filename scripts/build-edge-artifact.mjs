#!/usr/bin/env node
/**
 * Génère l'artefact déployable d'une Edge Function du dépôt.
 *
 * ## Pourquoi
 * Le canal de déploiement disponible (connecteur Supabase) ne transmet pas
 * fidèlement une source multi-fichiers, et altère les corps longs. Une fonction
 * comme `store-import` importe plusieurs modules (sortie réseau épinglée,
 * pipeline d'import partagé avec le client) : un import relatif produirait un
 * `BOOT_ERROR` en production.
 *
 * La solution est celle déjà éprouvée par `business-grow` :
 *   1. `esbuild` bundle l'entrée en un fichier autonome et minifié ;
 *   2. le bundle est stocké dans `public._edge_function_artifact` avec son
 *      SHA-256 et sa taille ;
 *   3. la source réellement déployée est un **chargeur court** qui relit le
 *      bundle par `name` + `sha256`, vérifie taille et empreinte, puis exécute.
 *
 * Conséquence utile : le code exécuté en production est exactement celui de ce
 * dépôt, et une altération du bundle en base est détectée avant exécution.
 *
 * ## Ce qui n'est PAS inliné
 * - Aucun secret : les valeurs restent lues par `Deno.env.get(...)` à l'exécution.
 * - Aucune dépendance externe au-delà de `npm:postgres` quand la fonction l'utilise
 *   (l'import est remplacé par une liaison fournie par le chargeur).
 *
 * ## Usage
 *   node scripts/build-edge-artifact.mjs store-import            # écrit le chargeur
 *   node scripts/build-edge-artifact.mjs store-import --print    # JSON (sha, taille, bundle)
 *   node scripts/build-edge-artifact.mjs store-import --check    # échoue si désynchronisé
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const POSTGRES = 'npm:postgres@3.4.5';
const ARTIFACT_TABLE = '_edge_function_artifact';

/** Fonctions gérées par ce générateur (entrée + chargeur déployé). */
export const FUNCTIONS = {
  'store-import': {
    entry: 'supabase/functions/store-import/index.ts',
    loader: 'supabase/functions/store-import/loader.ts',
    usesPostgres: true,
  },
};

// esbuild peut placer l'import en fin de ligne, après d'autres instructions :
// le motif n'est donc pas ancré en début de ligne.
const IMPORT_SIMPLE = new RegExp(`import\\s+(\\w+)\\s+from\\s*(["'])${POSTGRES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2;?`, 'g');
const IMPORT_NAMED = new RegExp(`import\\s*\\{\\s*default\\s+as\\s+(\\w+)\\s*\\}\\s*from\\s*(["'])${POSTGRES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2;?`, 'g');
const IMPORT_BARE = new RegExp(`(["'])${POSTGRES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`, 'g');

/** Bundle ES2022 exécutable par `new Function`, sans aucune instruction import. */
export function bundleEdgeFunction(name, root = process.cwd()) {
  const config = FUNCTIONS[name];
  if (!config) throw new Error(`fonction inconnue: ${name}`);
  const result = esbuild.buildSync({
    entryPoints: [join(root, config.entry)],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    external: config.usesPostgres ? [POSTGRES] : [],
    // UTF-8 littéral plutôt que des échappements `\xE9` : le bundle est stocké
    // dans une colonne texte via SQL, où ces séquences deviendraient du texte
    // brut. Le code reste équivalent à l'exécution.
    charset: 'utf8',
    logLevel: 'silent',
  });
  const bundled = result.outputFiles[0].text;
  let source = bundled;
  if (config.usesPostgres) {
    let resolved = false;
    source = source
      .replace(IMPORT_SIMPLE, (_m, binding) => {
        resolved = true;
        return `\nconst ${binding} = globalThis.__edgePostgres;`;
      })
      .replace(IMPORT_NAMED, (_m, binding) => {
        resolved = true;
        return `\nconst ${binding} = globalThis.__edgePostgres;`;
      });
    if (!resolved) throw new Error('import postgres introuvable dans le bundle');
    source = source.replace(IMPORT_BARE, '"__edgePostgres_missing__"');
  }
  if (/(^|[;}\n])\s*import\s*[\w{]/m.test(source)) {
    throw new Error('bundle contient encore une instruction import');
  }
  return source;
}

export function buildArtifact(name, root = process.cwd()) {
  const source = bundleEdgeFunction(name, root);
  return {
    source,
    sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    chars: source.length,
  };
}

/**
 * Chargeur déployé.
 *
 * Volontairement court (le canal altère les corps longs) et sans logique métier :
 * il lit, vérifie, exécute. Une lecture ratée ne doit pas figer l'instance, d'où
 * trois essais. En cas d'échec, la réponse est un JSON lisible, pas un 500 opaque.
 */
export function renderLoader(name, { sha256, chars }) {
  const config = FUNCTIONS[name];
  const pgImport = config.usesPostgres ? 'import postgres from "npm:postgres@3.4.5";\n' : '';
  const pgInject = config.usesPostgres
    ? '  // Le bundle s\'exécute hors module : il reçoit postgres ici, avant exécution.\n  (globalThis as { __edgePostgres?: typeof postgres }).__edgePostgres = postgres;\n'
    : '';
  return [
    `// ${name} — chargeur de production (seule source déployée).`,
    '// Généré par scripts/build-edge-artifact.mjs : ne pas éditer.',
    '//',
    '// Le code métier (bundle esbuild) est lu dans',
    `// public.${ARTIFACT_TABLE} par nom + SHA-256, puis vérifié avant exécution :`,
    "// un artefact absent ou modifié n'est jamais exécuté.",
    pgImport + '',
    `const ARTIFACT_NAME = "${name}";`,
    `const ARTIFACT_SHA256 = "${sha256}";`,
    `const ARTIFACT_CHARS = ${chars};`,
    '',
    'async function readArtifact(): Promise<string> {',
    '  const base = Deno.env.get("SUPABASE_URL") ?? "";',
    '  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";',
    '  if (!base || !key) throw new Error("runtime_env_missing");',
    `  const url = base + "/rest/v1/${ARTIFACT_TABLE}?select=source&name=eq." + ARTIFACT_NAME +`,
    '    "&sha256=eq." + ARTIFACT_SHA256;',
    '  const res = await fetch(url, {',
    '    headers: { apikey: key, Authorization: "Bearer " + key },',
    '    signal: AbortSignal.timeout(15000),',
    '  });',
    '  if (!res.ok) throw new Error("artifact_read_failed:" + res.status);',
    '  const rows = (await res.json()) as Array<{ source?: unknown }>;',
    '  const source = rows[0]?.source;',
    '  if (typeof source !== "string") throw new Error("artifact_missing");',
    '  if (source.length !== ARTIFACT_CHARS) throw new Error("artifact_size_mismatch:" + source.length);',
    '  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));',
    '  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");',
    '  if (hex !== ARTIFACT_SHA256) throw new Error("artifact_digest_mismatch");',
    '  return source;',
    '}',
    '',
    'let CODE = "";',
    'let failure = "";',
    "// Trois essais : une lecture ratée à froid ne doit pas figer l'instance en panne.",
    'for (let attempt = 1; attempt <= 3 && !CODE; attempt++) {',
    '  try {',
    '    CODE = await readArtifact();',
    '    failure = "";',
    '  } catch (error) {',
    '    failure = error instanceof Error ? error.message : String(error);',
    '    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));',
    '  }',
    '}',
    '',
    'if (CODE) {',
    pgInject + '  new Function(CODE)();',
    '} else {',
    '  // Panne explicite et lisible, au lieu d\'un 500 opaque pris pour une absence de backend.',
    `  console.error("${name} artifact load failed: " + failure);`,
    '  const headers = {',
    '    "Content-Type": "application/json",',
    '    "Access-Control-Allow-Origin": "*",',
    '    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",',
    '    "Access-Control-Allow-Methods": "POST, OPTIONS",',
    '  };',
    '  const body = JSON.stringify({',
    '    error: {',
    `      code: "${name.toUpperCase().replace(/-/g, '_')}_ARTIFACT_UNAVAILABLE",`,
    `      message: "Le service ${name} n'a pas pu charger son code (" + failure + ").",`,
    '    },',
    '  });',
    '  Deno.serve((request: Request) =>',
    '    request.method === "OPTIONS"',
    '      ? new Response("ok", { headers })',
    '      : new Response(body, { status: 503, headers })',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** SQL d'insertion de l'artefact, sans secret et sans donnée utilisateur. */
export function artifactSql(name, { source, sha256, chars }) {
  // PostgreSQL refuse un caractère NUL dans une chaîne : on le signale plutôt
  // que de produire un SQL invalide à l'exécution.
  if (source.includes('\u0000')) throw new Error('le bundle contient un caractère NUL');
  const escaped = source.replace(/'/g, "''");
  return [
    `insert into public.${ARTIFACT_TABLE} (name, sha256, chars, source, source_ref)`,
    `values ('${name}', '${sha256}', ${chars}, '${escaped}', 'scripts/build-edge-artifact.mjs')`,
    `on conflict do nothing;`,
  ].join('\n');
}

const name = process.argv[2];
if (name && !process.argv.includes('--import-only')) {
  if (!FUNCTIONS[name]) {
    console.error(`fonction inconnue : ${name} (connues : ${Object.keys(FUNCTIONS).join(', ')})`);
    process.exit(1);
  }
  const built = buildArtifact(name);
  const loaderPath = join(process.cwd(), FUNCTIONS[name].loader);
  const code = renderLoader(name, built);
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ name, sha256: built.sha256, chars: built.chars, loaderChars: code.length }));
  } else if (process.argv.includes('--sql')) {
    console.log(artifactSql(name, built));
  } else if (process.argv.includes('--check')) {
    const current = existsSync(loaderPath) ? readFileSync(loaderPath, 'utf8') : '';
    if (current !== code) {
      console.error(`chargeur désynchronisé : ${FUNCTIONS[name].loader}`);
      process.exit(1);
    }
    console.log(`chargeur à jour (${name}, ${built.chars} caractères de bundle)`);
  } else {
    writeFileSync(loaderPath, code, 'utf8');
    console.log(`écrit ${FUNCTIONS[name].loader} — sha256 ${built.sha256}, ${built.chars} caractères`);
  }
}
