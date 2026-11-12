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
 * ## Usage
 *   node scripts/build-business-grow-artifact.mjs           # écrit le chargeur
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

const isMain = process.argv[1] && process.argv[1].endsWith('build-business-grow-artifact.mjs');
if (isMain) {
  const built = artifact();
  console.log(`bundle     : ${built.chars} caractères`);
  console.log(`gzip       : ${built.gzBytes} octets`);
  console.log(`payload    : ${built.payload.length} caractères base64`);
  console.log(`sha256     : ${built.sha256}`);
  if (process.argv.includes('--print')) process.exit(0);

  const loader = renderLoader(built);
  const target = join(process.cwd(), LOADER);
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== loader) {
      console.error('bootstrap.ts désynchronisé : relancer sans --check.');
      process.exit(1);
    }
    console.log('bootstrap.ts à jour.');
    process.exit(0);
  }
  writeFileSync(target, loader);
  console.log(`chargeur écrit : ${LOADER}`);
}
