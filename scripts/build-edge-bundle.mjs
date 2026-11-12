#!/usr/bin/env node
/**
 * Génère le bundle autonome déployable de `reelora-video`.
 *
 * ## Pourquoi ce bundle existe
 * La passerelle `reelora-video` importe `_shared/video-quote.ts`. Le canal de
 * déploiement disponible (connecteur Supabase) ne transmet qu'UN fichier : un
 * import relatif vers `_shared` produirait un `BOOT_ERROR` en production.
 * Le bundle inline donc le module partagé avec un vrai bundling ES.
 *
 * ## Pourquoi un bundling et pas une concaténation
 * Une simple concaténation casse le module : `normalizeEstimateEndpoint` est
 * déclaré dans les DEUX fichiers, ce que `esbuild` détecte et renomme
 * correctement (`normalizeEstimateEndpoint2`). La concaténation naïve a été
 * essayée, elle produisait un bundle non compilable — écartée.
 *
 * ## Pourquoi c'est sûr
 * - Le bundle est du JavaScript ES2022 valide, que Deno exécute à l'identique.
 * - Aucune dépendance externe n'est ajoutée (le module partagé est pur).
 * - Aucun secret n'est inliné : les valeurs restent lues via `env(...)`.
 * - `tests/edge-bundle-parity.test.ts` régénère le bundle et exige l'égalité
 *   octet pour octet avec le fichier livré : impossible de dériver en silence.
 * - Les 58 tests fonctionnels de `tests/muapi.test.ts` tournent sur CE bundle.
 *
 * ## Usage
 *   node scripts/build-edge-bundle.mjs           # (re)génère le bundle
 *   node scripts/build-edge-bundle.mjs --check   # échoue si désynchronisé
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

export const ENTRY = 'supabase/functions/reelora-video/index.ts';
export const SHARED = 'supabase/functions/_shared/video-quote.ts';
export const BUNDLE = 'supabase/functions/reelora-video.bundle.ts';

const HEADER = [
  '// @ts-nocheck — artefact esbuild : verifie et execute par les tests.',
  '// ---------------------------------------------------------------------------',
  '// BUNDLE AUTONOME — généré par esbuild depuis',
  '//   supabase/functions/reelora-video/index.ts',
  '//   supabase/functions/_shared/video-quote.ts',
  '// Ne pas editer a la main : node scripts/build-edge-bundle.mjs',
  '// Verifie par tests/edge-bundle-parity.test.ts (egalite octet pour octet).',
  '// ---------------------------------------------------------------------------',
  '',
].join('\n');

/**
 * Construit le contenu du bundle.
 * @param {string} root racine du dépôt
 * @returns {string}
 */
export function buildBundle(root = process.cwd()) {
  const result = esbuild.buildSync({
    entryPoints: [join(root, ENTRY)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild n’a produit aucune sortie');
  const code = new TextDecoder().decode(out.contents);
  if (code.includes('../_shared/')) {
    throw new Error('le bundle contient encore un import relatif vers _shared');
  }
  return HEADER + code;
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-edge-bundle.mjs');
if (isMain) {
  const expected = buildBundle();
  const check = process.argv.includes('--check');
  if (check) {
    const current = readFileSync(join(process.cwd(), BUNDLE), 'utf8');
    if (current !== expected) {
      console.error(`${BUNDLE} désynchronisé : relancer node scripts/build-edge-bundle.mjs`);
      process.exit(1);
    }
    console.log(`${BUNDLE} à jour (${expected.length} octets, ${expected.split('\n').length} lignes).`);
  } else {
    writeFileSync(join(process.cwd(), BUNDLE), expected);
    console.log(`${BUNDLE} régénéré (${expected.length} octets, ${expected.split('\n').length} lignes).`);
  }
}
