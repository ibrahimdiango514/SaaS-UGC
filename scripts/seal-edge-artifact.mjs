#!/usr/bin/env node
/**
 * Scelle l'artefact Edge `reelora-video` dans `public._edge_deploy_artifact`.
 *
 * ## Pourquoi
 * Le canal de déploiement disponible n'écrit de façon fiable que des charges
 * courtes (~5 Ko). L'artefact fait plus de 48 Ko : il est donc stocké par
 * tranches gzip+base64, et la fonction déployée ne contient qu'un chargeur.
 *
 * ## Déterminisme — le piège réel déjà rencontré
 * `gzipSync` de Node injecte un horodatage (MTIME) : deux exécutions du même
 * code produisaient deux empreintes différentes, ce qui rendait la vérification
 * « déployé == dépôt » impossible. Le MTIME est donc forcé à 0 ici, ce qui rend
 * l'artefact reproductible octet pour octet (vérifié par
 * `tests/edge-artifact-parity.test.ts`).
 *
 * ## Usage
 *   node scripts/seal-edge-artifact.mjs            # écrit le .sql de scellement
 *   node scripts/seal-edge-artifact.mjs --print    # affiche l'empreinte seulement
 */
import { createHash } from 'node:crypto';
import { gzipSync, constants as zlibConstants } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export const EDGE = 'supabase/functions/reelora-video.edge.js';
export const BOOTSTRAP = 'supabase/functions/reelora-video/bootstrap.ts';
export const TABLE = '_edge_deploy_artifact';
export const SLICE_CHARS = 2000;

/** gzip reproductible : ni horodatage, ni champ OS variable. */
export function deterministicGzip(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return gzipSync(buf, {
    level: 9,
    mtime: 0,
    // Les options ci-dessous figent le reste de l'en-tête.
    portable: true,
  });
}

/**
 * Calcule l'empreinte, les tranches et le SQL de scellement.
 * @param {string} root racine du dépôt
 */
export function seal(root = process.cwd()) {
  const source = readFileSync(join(root, EDGE), 'utf8');
  const normalized = source.replace(/\r\n/g, '\n');
  const sha256 = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const gz = deterministicGzip(normalized);
  const b64 = gz.toString('base64');
  const slices = [];
  for (let i = 0; i < b64.length; i += SLICE_CHARS) {
    slices.push(b64.slice(i, i + SLICE_CHARS));
  }
  const assembly = createHash('sha256').update(slices.join(''), 'utf8').digest('hex');
  return { source: normalized, sha256, slices, assembly, chars: normalized.length, gzBytes: gz.length };
}

const isMain = process.argv[1] && process.argv[1].endsWith('seal-edge-artifact.mjs');
if (isMain) {
  const sealed = seal();
  const print = process.argv.includes('--print');
  console.log(`artefact   : ${sealed.chars} caractères`);
  console.log(`gzip       : ${sealed.gzBytes} octets`);
  console.log(`sha256     : ${sealed.sha256}`);
  console.log(`assemblage : ${sealed.assembly}`);
  console.log(`tranches   : ${sealed.slices.length}`);
  if (print) process.exit(0);

  // Littéral SQL : quotes simples doublées (le base64 n'en contient jamais,
  // mais on reste correct même si le format changeait).
  const values = sealed.slices
    .map((chunk, i) => `  (${i + 1}, '${chunk.replace(/'/g, "''")}')`)
    .join(',\n');
  const sql = `-- Scellement de l'artefact reelora-video (genere par scripts/seal-edge-artifact.mjs).
-- Ne pas editer a la main. Le chargeur decompresse ces tranches a froid.
delete from public.${TABLE};
insert into public.${TABLE} (seq, chunk) values
${values};
select count(*) as slices, sum(length(chunk)) as chars from public.${TABLE};
`;
  writeFileSync(join(process.cwd(), 'supabase', 'edge-artifact-seal.sql'), sql);
  console.log('SQL écrit : supabase/edge-artifact-seal.sql');

  // Le chargeur doit connaître l'empreinte exacte de ce qu'il va charger.
  const bootstrap = readFileSync(join(process.cwd(), BOOTSTRAP), 'utf8');
  const updated = bootstrap
    .replace(/const ARTIFACT_SHA256 = "[0-9a-f]+";/, `const ARTIFACT_SHA256 = "${sealed.sha256}";`)
    .replace(/const ARTIFACT_CHARS = \d+;/, `const ARTIFACT_CHARS = ${sealed.chars};`);
  if (updated !== bootstrap) {
    writeFileSync(join(process.cwd(), BOOTSTRAP), updated);
    console.log('bootstrap.ts mis à jour (sha256 + taille).');
  } else {
    console.log('bootstrap.ts déjà à jour.');
  }
}
