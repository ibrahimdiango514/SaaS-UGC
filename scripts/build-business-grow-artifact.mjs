#!/usr/bin/env node
/**
 * Génère l'artefact déployable de `business-grow`.
 *
 * ## Pourquoi
 * La fonction Edge est déployée par un canal qui ne transmet pas fidèlement une
 * source multi-fichiers : un import relatif vers `./handler.ts` produirait un
 * `BOOT_ERROR`, et un corps long arrive tronqué. Le code est donc bundlé
 * (esbuild), puis **lu par un chargeur court depuis un commit épinglé** du
 * dépôt public. Le code exécuté en production est exactement celui de ce dépôt.
 *
 * ## Déterminisme
 * Le bundle est reproductible caractère pour caractère : `artifact()` recompile
 * la source et les tests comparent le résultat au fichier committé. C'est ce qui
 * garantit que l'empreinte épinglée désigne bien un contenu connu.
 *
 * ## Deux fichiers, pas plus
 *  - `business-grow.edge.js` : le bundle exact (88 231 caractères). C'est lui
 *    qui est publié, donc épinglé par empreinte.
 *  - `business-grow/loader.ts` : **la seule source déployée**. Courte (~3,4 Ko),
 *    elle télécharge ce bundle au commit épinglé, vérifie taille puis SHA-256,
 *    et n'exécute rien si l'un des deux diffère.
 *
 * Le chargeur « artefact en base » et la variante gzip inline ont été retirés :
 * aucun des deux n'était déployé, et laisser croire l'inverse a déjà fait
 * valider un chargeur que la production n'exécutait pas.
 *
 * ## Usage
 *   BG_PIN_COMMIT=<sha40> node scripts/build-business-grow-artifact.mjs          # écrit les deux fichiers
 *   BG_PIN_COMMIT=<sha40> node scripts/build-business-grow-artifact.mjs --check  # échoue si désynchronisé
 *   node scripts/build-business-grow-artifact.mjs --print                        # empreinte seulement
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';
import { renderGithubLoader as rendreChargeurGithub, verifierChargeur } from './edge-github-loader.mjs';

export const ENTRY = 'supabase/functions/business-grow/index.ts';
/**
 * Le chargeur RÉELLEMENT déployé porte le mécanisme « GitHub épinglé » depuis
 * la Phase A. `bootstrap.ts` a été retiré : il n'était pas déployé, contenait
 * des placeholders de gabarit, et prétendre le contraire a déjà coûté une phase
 * entière de vérification. L'historique Git en garde la trace.
 */
export const LOADER = 'supabase/functions/business-grow/loader.ts';
export const HOSTED_LOADER = 'supabase/functions/business-grow/loader.ts';
export const BUNDLE = 'supabase/functions/business-grow.edge.js';
/**
 * Chargeur épinglé sur un commit du dépôt public.
 *
 * Le canal de déploiement n'accepte que des corps courts : ni le bundle (88 k)
 * ni son SQL d'insertion ne passent. Une URL contenant un SHA de commit ne peut
 * pas changer de contenu — c'est ce qui rend l'empreinte vérifiable.
 */
export const GITHUB_LOADER = 'supabase/functions/business-grow/loader.ts';
export const GITHUB_REPO = 'ibrahimdiango514/SaaS-UGC';
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

export function artifact(root = process.cwd()) {
  const source = bundleBusinessGrow(root);
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  return { source, sha256, chars: source.length };
}

/** Chargeur déployé : bundle lu à un commit épinglé, vérifié avant exécution. */
export function renderGithubLoader({ sha256, chars }, commit) {
  const code = rendreChargeurGithub({
    fonction: 'business-grow',
    path: BUNDLE,
    sha256,
    chars,
    commit,
    chargeur: '__bgPostgres',
    codeIndisponible: 'BUSINESS_GROW_ARTIFACT_UNAVAILABLE',
  });
  const problemes = verifierChargeur(code);
  if (problemes.length) {
    throw new Error(`chargeur business-grow non conforme : ${problemes.join(', ')}`);
  }
  return code;
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-business-grow-artifact.mjs');
if (isMain) {
  const built = artifact();
  console.log(`bundle     : ${built.chars} caractères`);
  console.log(`sha256     : ${built.sha256}`);
  if (process.argv.includes('--print')) process.exit(0);

  // Un seul chargeur est produit : celui réellement déployé (GitHub épinglé).
  // Le bundle est écrit à part, car c'est lui qui est committé puis épinglé.
  const commit = (process.env.BG_PIN_COMMIT || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error('BG_PIN_COMMIT doit être un SHA de commit complet (40 hexadécimaux).');
    process.exit(1);
  }
  const outputs = [
    [LOADER, renderGithubLoader(built, commit)],
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
