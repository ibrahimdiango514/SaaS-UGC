#!/usr/bin/env node
/**
 * Génère l'artefact `business-grow` servi en statique (public/edge-artifacts).
 *
 * ## Pourquoi ce second mode
 * Deux formes de déploiement existent :
 *  1. `bootstrap.ts` — artefact inline (gzip+base64) : autonome, mais le corps
 *     pèse ~17 Ko, et un canal de déploiement qui altère une longue chaîne le
 *     casse (`artifact_size_mismatch` / `WORKER_ERROR`).
 *  2. **ce mode** — le bundle est publié en statique et le chargeur déployé ne
 *     fait que le récupérer et vérifier son SHA-256 : ~600 octets de source,
 *     donc plus aucun risque de troncature, et l'artefact est versionné.
 *
 * L'artefact est déterministe (gzip mtime 0, portable) : le SHA-256 publié dans
 * `business-grow.meta.json` est celui du bundle exact.
 *
 * ## Usage
 *   node scripts/build-hosted-artifact.mjs
 *   node scripts/build-hosted-artifact.mjs --check   # échoue si désynchronisé
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

const ENTRY = 'supabase/functions/business-grow/index.ts';
const OUT_DIR = 'public/edge-artifacts';
const BUNDLE = join(OUT_DIR, 'business-grow.bundle.js');
const META = join(OUT_DIR, 'business-grow.meta.json');
const POSTGRES = 'npm:postgres@3.4.5';

const IMPORT_SIMPLE = /^\s*import\s+(\w+)\s+from\s*(["'])npm:postgres@3\.4\.5\2;?/gm;
const IMPORT_NAMED = /^\s*import\s*\{\s*default\s+as\s+(\w+)\s*\}\s*from\s*(["'])npm:postgres@3\.4\.5\2;?/gm;

export function build() {
  const result = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    write: false,
    external: [POSTGRES],
    logLevel: 'silent',
  });
  let resolved = false;
  const bind = (_match, binding) => {
    resolved = true;
    return `\nconst ${binding} = globalThis.__bgPostgres;`;
  };
  const rewritten = result.outputFiles[0].text
    .replace(IMPORT_SIMPLE, bind)
    .replace(IMPORT_NAMED, bind);
  if (!resolved) throw new Error('import postgres introuvable dans le bundle');
  // `new Function` refuse toute instruction import : la référence résiduelle
  // au spécificateur npm est neutralisée.
  const source = rewritten.replace(/(["'])npm:postgres@3\.4\.5\1/g, '"__bgPostgres_missing__"');
  if (/^\s*import\s/m.test(source)) throw new Error('bundle contient encore une instruction import');
  // Servi en clair : un `.gz` statique peut être décodé automatiquement par
  // l'hébergeur ou par `fetch`, ce qui casserait le DecompressionStream du
  // chargeur. Le poids (~39 Ko) est négligeable.
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  return { source, sha256, chars: source.length };
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-hosted-artifact.mjs');
if (isMain) {
  const built = build();
  const meta = {
    chars: built.chars,
    sha256: built.sha256,
  };
  const check = process.argv.includes('--check');
  if (check) {
    const sameFile = readFileSync(BUNDLE, 'utf8') === built.source;
    const saved = JSON.parse(readFileSync(META, 'utf8'));
    const sameMeta = saved.sha256 === meta.sha256 && saved.chars === meta.chars;
    if (!sameFile || !sameMeta) {
      console.error('artefact hébergé désynchronisé : relancer sans --check.');
      process.exit(1);
    }
    console.log(`artefact à jour (${meta.chars} caractères, sha256 ${meta.sha256}).`);
    process.exit(0);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(BUNDLE, built.source);
  writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`artefact   : ${BUNDLE} (${built.chars} octets)`);
  console.log(`bundle     : ${meta.chars} caractères`);
  console.log(`sha256     : ${meta.sha256}`);
}
