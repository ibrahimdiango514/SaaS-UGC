#!/usr/bin/env node
/**
 * Génère l'artefact de production des trois Edge Functions de paiement SasPay.
 *
 * ## Pourquoi
 * Le canal de déploiement disponible n'écrit qu'un seul `body` par fonction et
 * altère les textes longs (incident business-grow v18, voir
 * docs/incident-business-grow-prod-20261112.md). Or `vyora-payments`,
 * `vyora-saspay-webhook` et `vyora-payments-reconcile` importent
 * `../_shared/saspay/*.ts` (≈ 150 Ko). Même remède que pour `business-grow` :
 *
 *   - `supabase/functions/vyora-saspay.edge.js` : bundle unique, sans import,
 *     commun aux trois fonctions (entrée `_shared/saspay/edge-entry.ts`) ;
 *   - `supabase/functions/<fonction>/loader.ts` : seule source déployée, courte.
 *     Elle lit le bundle dans `public._edge_function_artifact` par nom +
 *     SHA-256, vérifie taille et empreinte, désigne son gestionnaire puis
 *     exécute le bundle. Un artefact absent ou modifié n'est jamais exécuté.
 *
 * `index.ts` reste la source lisible et testée de chaque fonction ; le bundle
 * est construit depuis les mêmes modules, et `tests/saspay-loader.test.ts`
 * vérifie que les fichiers générés sont à jour et que le chargeur démarre le
 * bon gestionnaire.
 *
 * ## Usage
 *   node scripts/build-saspay-artifact.mjs           # (re)génère les 4 fichiers
 *   node scripts/build-saspay-artifact.mjs --check   # échoue si désynchronisé
 *   node scripts/build-saspay-artifact.mjs --print   # empreinte seulement
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import esbuild from 'esbuild';

export const ENTRY = 'supabase/functions/_shared/saspay/edge-entry.ts';
export const BUNDLE = 'supabase/functions/vyora-saspay.edge.js';
export const ARTIFACT_TABLE = '_edge_function_artifact';
export const ARTIFACT_NAME = 'vyora-saspay';
export const FUNCTIONS = ['vyora-payments', 'vyora-saspay-webhook', 'vyora-payments-reconcile'];
export const loaderPath = (name) => `supabase/functions/${name}/loader.ts`;

/** Bundle ES2022 en ASCII, exécutable par `new Function`, sans aucun import. */
export function bundleSaspay(root = process.cwd()) {
  const result = esbuild.buildSync({
    entryPoints: [join(root, ENTRY)],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    platform: 'neutral',
    charset: 'ascii',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const source = result.outputFiles[0].text;
  if (/^\s*(import|export)\s/m.test(source)) throw new Error('bundle contient un import ou un export');
  // ASCII strict : `char_length` (base) et `String.length` (chargeur) coïncident,
  // et aucun transcodage ne peut modifier l'empreinte.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(source)) throw new Error('bundle non ASCII');
  return source;
}

export function artifact(root = process.cwd()) {
  const source = bundleSaspay(root);
  const sha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  return { source, sha256, chars: source.length };
}

/**
 * Chargeur déployé. Volontairement court et sans gabarit imbriqué : c'est le
 * seul texte qui transite par le canal de déploiement.
 */
export function renderLoader(name, { sha256, chars }) {
  if (!FUNCTIONS.includes(name)) throw new Error(`fonction inconnue : ${name}`);
  return [
    '// ' + name + ' — chargeur de production (seule source déployée).',
    '// Généré par scripts/build-saspay-artifact.mjs : ne pas éditer.',
    '//',
    '// Le code métier (bundle de supabase/functions/_shared/saspay) est lu dans',
    '// public.' + ARTIFACT_TABLE + ' par nom + SHA-256, puis vérifié avant exécution :',
    '// un artefact absent ou modifié n\'est jamais exécuté.',
    'const FUNCTION_NAME = "' + name + '";',
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
    '  // Le bundle ne contient aucun import ; il lit ce nom et enregistre lui-même',
    '  // Deno.serve avec le gestionnaire correspondant.',
    '  (globalThis as { __vyoraSaspayFunction?: string }).__vyoraSaspayFunction = FUNCTION_NAME;',
    '  new Function(CODE)();',
    '} else {',
    '  // Panne explicite : 503, jamais un succès. SasPay et la réconciliation',
    '  // réessaient ; le navigateur reçoit un code lisible. Le motif reste dans',
    '  // les journaux, pas dans la réponse.',
    '  console.error(FUNCTION_NAME + " artifact load failed: " + failure);',
    '  const headers = {',
    '    "Content-Type": "application/json",',
    '    "Access-Control-Allow-Origin": "*",',
    '    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",',
    '    "Access-Control-Allow-Methods": "POST, OPTIONS",',
    '  };',
    '  const body = JSON.stringify({',
    '    error: {',
    '      code: "PAYMENT_ARTIFACT_UNAVAILABLE",',
    '      message: "Le service de paiement est momentanément indisponible.",',
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

export function outputs(root = process.cwd()) {
  const built = artifact(root);
  return {
    built,
    files: [[BUNDLE, built.source], ...FUNCTIONS.map((name) => [loaderPath(name), renderLoader(name, built)])],
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('build-saspay-artifact.mjs');
if (isMain) {
  const { built, files } = outputs();
  console.log(`bundle     : ${built.chars} caractères`);
  console.log(`sha256     : ${built.sha256}`);
  if (process.argv.includes('--print')) process.exit(0);
  if (process.argv.includes('--check')) {
    const stale = files
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
  for (const [file, content] of files) {
    writeFileSync(join(process.cwd(), file), content);
    console.log(`écrit      : ${file} (${Buffer.byteLength(content)} octets)`);
  }
}
