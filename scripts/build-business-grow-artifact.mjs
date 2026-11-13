#!/usr/bin/env node
/**
 * Génère l'artefact déployable de `business-grow`.
 *
 * ## Pourquoi
 * La fonction Edge est déployée par un canal qui ne transmet pas fidèlement une
 * source multi-fichiers : un import relatif vers `./handler.ts` produirait un
 * `BOOT_ERROR`. Le code est donc bundlé (esbuild), compressé (gzip
 * déterministe) puis encodé en base64 dans un chargeur court. Le code exécuté
 * en production est exactement celui de ce dépôt.
 *
 * ## Déterminisme
 * `gzipSync` écrit un horodatage (MTIME) : deux exécutions du même code
 * produiraient deux empreintes. MTIME est forcé à 0, l'artefact est donc
 * reproductible octet pour octet — vérifié par `tests/business-grow-artifact.test.ts`.
 *
 * ## Trois fichiers générés
 *  - `business-grow.edge.js` : le bundle exact (39 Ko). C'est lui qui est
 *    publié dans `public._edge_function_artifact` (nom + SHA-256).
 *  - `business-grow/loader.ts` : **la source déployée en production**. Courte
 *    (~2 Ko), elle lit le bundle en base et vérifie taille + SHA-256 avant de
 *    l'exécuter. Le canal de déploiement altère les corps longs (incident v18 :
 *    payload inline de 16 Ko arrivé corrompu ⇒ `WORKER_ERROR`) ; un fichier
 *    court ne peut pas l'être sans que le SHA-256 le révèle.
 *  - `business-grow/bootstrap.ts` : variante autonome (bundle inline
 *    gzip+base64), sans dépendance à la base. À réserver à un canal fiable
 *    (`supabase functions deploy`).
 *
 * ## Usage
 *   node scripts/build-business-grow-artifact.mjs           # écrit les trois fichiers
 *   node scripts/build-business-grow-artifact.mjs --check   # échoue si désynchronisé
 *   node scripts/build-business-grow-artifact.mjs --print   # empreinte seulement
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import esbuild from 'esbuild';

export const ENTRY = 'supabase/functions/business-grow/index.ts';
export const LOADER = 'supabase/functions/business-grow/bootstrap.ts';
export const HOSTED_LOADER = 'supabase/functions/business-grow/loader.ts';
export const BUNDLE = 'supabase/functions/business-grow.edge.js';
export const ARTIFACT_TABLE = '_edge_function_artifact';
export const ARTIFACT_NAME = 'business-grow';
const POSTGRES = 'npm:postgres@3.4.5';

/**
 * `postgres` est fourni par le chargeur (`globalThis.__bgPostgres`).
 *
 * Pourquoi pas un simple `import` : le bundle est exécuté par
 * `new Function(CODE)`, qui refuse une instruction `import` (« Cannot use
 * import statement outside a module »). L'import externe est donc remplacé par
 * une liaison vers la valeur injectée par le chargeur avant l'exécution.
 */
// esbuild peut produire plusieurs formes : `import X from"…";`,
// `import{default as X}from"…";` ou un import groupé en fin de fichier.
const POSTGRES_IMPORT_SIMPLE = /^\s*import\s+(\w+)\s+from\s*(["'])npm:postgres@3\.4\.5\2;?/gm;
const POSTGRES_IMPORT_NAMED = /^\s*import\s*\{\s*default\s+as\s+(\w+)\s*\}\s*from\s*(["'])npm:postgres@3\.4\.5\2;?/gm;
const POSTGRES_IMPORT_BARE = /(["'])npm:postgres@3\.4\.5\1/g;

/** Bundle ES2022 exécutable par `new Function`, sans aucun import. */
export function bundleBusinessGrow(root = process.cwd()) {
  const result = esbuild.buildSync({
    entryPoints: [join(root, ENTRY)],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    external: [POSTGRES],
    logLevel: 'silent',
  });
  const bundled = result.outputFiles[0].text;
  let resolved = false;
  const withBinding = bundled
    .replace(POSTGRES_IMPORT_SIMPLE, (_match, binding) => {
      resolved = true;
      return `\nconst ${binding} = globalThis.__bgPostgres;`;
    })
    .replace(POSTGRES_IMPORT_NAMED, (_match, binding) => {
      resolved = true;
      return `\nconst ${binding} = globalThis.__bgPostgres;`;
    });
  if (!resolved) throw new Error('import postgres introuvable dans le bundle');
  const source = withBinding.replace(POSTGRES_IMPORT_BARE, '"__bgPostgres_missing__"');
  // Aucun import ne doit subsister : le code est exécuté hors module.
  if (/^\s*import\s/m.test(source)) {
    throw new Error('bundle contient encore une instruction import');
  }
  return source;
}

/** gzip reproductible : ni horodatage, ni champ OS variable. */
export function deterministicGzip(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return gzipSync(buf, { level: 9, mtime: 0, portable: true });
}

export function artifact(root = process.cwd()) {
  const source = bundleBusinessGrow(root);
  const gz = deterministicGzip(source);
  const payload = gz.toString('base64');
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (payload.includes('"') || payload.includes('\\')) {
    throw new Error('base64 inattendu : échappement requis');
  }
  return { source, payload, sha256, chars: source.length, gzBytes: gz.length };
}

export function renderLoader({ payload, sha256, chars }) {
  return `// business-grow — artefact de déploiement autonome.
// Généré depuis supabase/functions/business-grow/*.ts par
// scripts/build-business-grow-artifact.mjs (esbuild --bundle --minify).
// Le canal de déploiement n'achemine pas fidèlement une source multi-fichiers :
// le bundle complet voyage compressé (gzip+base64) et son intégrité est vérifiée
// par SHA-256 à froid. Le code exécuté est exactement celui du dépôt.
import postgres from "npm:postgres@3.4.5";
const PAYLOAD = "${payload}";
const ARTIFACT_SHA256 = "${sha256}";
const ARTIFACT_CHARS = ${chars};
const bytes = Uint8Array.from(atob(PAYLOAD), (c) => c.charCodeAt(0));
const CODE = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
if (CODE.length !== ARTIFACT_CHARS) throw new Error("artifact_size_mismatch");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CODE));
const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
if (hex !== ARTIFACT_SHA256) throw new Error("artifact_digest_mismatch");
// Le bundle est exécuté par new Function : il ne peut contenir aucun import.
// Le module postgres lui est donc fourni ici, avant exécution.
(globalThis as { __bgPostgres?: typeof postgres }).__bgPostgres = postgres;
new Function(CODE)();
`;
}

/**
 * Chargeur déployé : lit le bundle dans `public._edge_function_artifact`.
 *
 * Écrit sans gabarit imbriqué (concaténations) pour rester lisible ici, et
 * volontairement court : c'est le seul texte qui transite par le canal de
 * déploiement.
 */
export function renderHostedLoader({ sha256, chars }) {
  return [
    '// business-grow — chargeur de production (seule source déployée).',
    '// Généré par scripts/build-business-grow-artifact.mjs : ne pas éditer.',
    '//',
    '// Le canal de déploiement altère les sources longues : ce fichier reste court.',
    '// Le code métier (bundle esbuild de ce dossier) est lu dans',
    '// public.' + ARTIFACT_TABLE + ' par nom + SHA-256, puis vérifié avant exécution :',
    '// un artefact absent ou modifié n\'est jamais exécuté.',
    'import postgres from "npm:postgres@3.4.5";',
    '',
    'const ARTIFACT_NAME = "' + ARTIFACT_NAME + '";',
    'const ARTIFACT_SHA256 = "' + sha256 + '";',
    'const ARTIFACT_CHARS = ' + chars + ';',
    '',
    'async function readArtifact(): Promise<string> {',
    '  const base = Deno.env.get("SUPABASE_URL") ?? "";',
    '  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";',
    '  if (!base || !key) throw new Error("runtime_env_missing");',
    '  const url = base + "/rest/v1/' + ARTIFACT_TABLE + '?select=source&name=eq." + ARTIFACT_NAME +',
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
    '// Trois essais : une lecture ratée à froid ne doit pas figer l\'instance en panne.',
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
    '  // Le bundle s\'exécute hors module : il ne contient aucun import et reçoit',
    '  // postgres ici, AVANT son exécution. Il enregistre lui-même Deno.serve.',
    '  (globalThis as { __bgPostgres?: typeof postgres }).__bgPostgres = postgres;',
    '  new Function(CODE)();',
    '} else {',
    '  // Panne explicite et lisible par le navigateur (CORS ouvert : la réponse ne',
    '  // contient qu\'un code d\'erreur), au lieu d\'un 500 opaque pris pour une',
    '  // absence de backend.',
    '  console.error("business-grow artifact load failed: " + failure);',
    '  const headers = {',
    '    "Content-Type": "application/json",',
    '    "Access-Control-Allow-Origin": "*",',
    '    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",',
    '    "Access-Control-Allow-Methods": "POST, OPTIONS",',
    '  };',
    '  const body = JSON.stringify({',
    '    error: {',
    '      code: "BUSINESS_GROW_ARTIFACT_UNAVAILABLE",',
    '      message: "Le service Business Grow n\'a pas pu charger son code (" + failure + ").",',
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

const isMain = process.argv[1] && process.argv[1].endsWith('build-business-grow-artifact.mjs');
if (isMain) {
  const built = artifact();
  console.log(`bundle     : ${built.chars} caractères`);
  console.log(`gzip       : ${built.gzBytes} octets`);
  console.log(`payload    : ${built.payload.length} caractères base64`);
  console.log(`sha256     : ${built.sha256}`);
  if (process.argv.includes('--print')) process.exit(0);

  const outputs = [
    [LOADER, renderLoader(built)],
    [HOSTED_LOADER, renderHostedLoader(built)],
    [BUNDLE, built.source],
  ];
  if (process.argv.includes('--check')) {
    const stale = outputs
      .filter(([file, expected]) => {
        try {
          return readFileSync(join(process.cwd(), file), 'utf8') !== expected;
        } catch {
          return true;
        }
      })
      .map(([file]) => file);
    if (stale.length) {
      console.error(`désynchronisé : ${stale.join(', ')} — relancer sans --check.`);
      process.exit(1);
    }
    console.log('artefacts à jour.');
    process.exit(0);
  }
  for (const [file, content] of outputs) {
    writeFileSync(join(process.cwd(), file), content);
    console.log(`écrit      : ${file} (${Buffer.byteLength(content)} octets)`);
  }
}
