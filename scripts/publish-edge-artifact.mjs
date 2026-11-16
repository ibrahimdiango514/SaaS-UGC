#!/usr/bin/env node
/**
 * VYORA — publication reproductible des artefacts Edge Functions.
 *
 * ## Le problème que ce script résout
 *
 * Le canal de déploiement Supabase altère les sources longues : au-delà de
 * ~2 000 caractères, un corps envoyé arrive modifié. Les Edge Functions dont le
 * code dépasse cette limite ne peuvent donc pas être déployées directement.
 *
 * La solution est un **chargeur court** déployé à leur place : il ne contient
 * pas le code métier, mais lit un artefact en base, le recompose, vérifie sa
 * taille et son SHA-256, puis l'exécute. Un artefact altéré n'est jamais
 * exécuté.
 *
 * ## Ce que fait ce script
 *
 *   1. **Construit** le bundle depuis les sources officielles (`esbuild`, format
 *      ESM, cible neutre, sortie déterministe).
 *   2. **Compresse et découpe** en tranches de 2 000 caractères maximum, écrites
 *      dans `public._edge_function_artifact_slices`.
 *   3. **Vérifie** le SHA-256 et la taille de ce qui sera réellement lu.
 *   4. **Contrôle la cohérence** entre les trois représentations : source,
 *      paquet déployé (`loader.ts`), migration (`*_artifact.sql`).
 *
 * ## Ce que ce script ne fait JAMAIS
 *
 * Il n'écrit rien en base et ne déploie rien. Il produit des **fichiers** que
 * l'opérateur applique lui-même, après revue. La publication en production reste
 * une décision humaine explicite.
 *
 * ## Utilisation
 *
 *   node scripts/publish-edge-artifact.mjs --list
 *   node scripts/publish-edge-artifact.mjs --check            # tous les artefacts
 *   node scripts/publish-edge-artifact.mjs vyora-oauth        # régénère les fichiers
 *   node scripts/publish-edge-artifact.mjs vyora-oauth --check
 *
 * Codes de sortie : 0 = cohérent, 1 = incohérence détectée.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Charge utile fiable du canal de déploiement, en caractères. */
export const MAX_CHUNK_CHARS = 2000;

/**
 * Artefacts publiables.
 *
 * `entry` est le point d'entrée officiel : le bundle est reconstruit depuis lui,
 * jamais depuis le paquet déjà publié — sinon une altération se propagerait.
 * `migration` est le préfixe de la migration générée.
 */
export const ARTIFACTS = {
  'vyora-oauth': { entry: 'supabase/functions/vyora-oauth/index.ts', migration: '20261116060000' },
};

/** Enveloppe du chargeur : courte, elle passe le canal sans altération. */
function loaderSource({ name, sha256, chars }) {
  return `// ${name} — chargeur de production (seule source déployée).
// Généré par scripts/publish-edge-artifact.mjs : ne pas éditer.
//
// Le canal de déploiement altère les sources longues : ce fichier reste court.
// Le code métier est lu dans public._edge_function_artifact_slices (nom + SHA-256), recomposé,
// puis vérifié AVANT exécution : un artefact absent ou modifié n'est jamais exécuté.
const NAME = ${JSON.stringify(name)};
const SHA256 = ${JSON.stringify(sha256)};
const CHARS = ${chars};

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
    base + "/rest/v1/_edge_function_artifact_slices?select=part,chunk&name=eq.\\"" + NAME + "\\"&order=part.asc",
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

/** SHA-256 hexadécimal d'une chaîne. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Construit le bundle d'un artefact.
 *
 * DÉLÉGUÉ au générateur de référence `scripts/build-edge-loader.mjs`.
 *
 * Dupliquer la construction serait un piège : deux générateurs qui divergent
 * produiraient deux artefacts différents pour la même source, et le SHA-256
 * publié ne correspondrait plus au chargeur déployé. Une seule implémentation,
 * donc une seule vérité. Ce fichier ajoute ce qui manque au générateur : la
 * vérification de cohérence des trois représentations et la publication guidée.
 */
export async function buildBundle(name) {
  const spec = ARTIFACTS[name];
  if (!spec) throw new Error(`artefact inconnu : ${name}`);
  if (!existsSync(join(ROOT, spec.entry))) {
    throw new Error(`point d'entrée absent : ${spec.entry}`);
  }

  const reference = await loadGenerator();
  const built = reference.buildBundle(ROOT, name);

  return {
    name,
    source: built.source,
    sha256: built.sha256,
    chars: built.chars,
    gzipBytes: built.gzBytes,
    base64: built.base64,
    base64Md5: built.base64Md5,
    chunks: splitChunks(built.base64),
  };
}

/**
 * Charge le générateur de référence.
 *
 * Il exécute `main()` à l'import si `process.argv[1]` désigne son propre
 * fichier. On neutralise ce déclencheur le temps du chargement, puis on le
 * restaure : importer ne doit jamais lancer une publication.
 */
async function loadGenerator() {
  const saved = process.argv[1];
  process.argv[1] = 'publish-edge-artifact-import';
  try {
    return await import('./build-edge-loader.mjs');
  } finally {
    process.argv[1] = saved;
  }
}

/**
 * Découpe un base64 en tranches de `max` caractères.
 * Lève si une tranche dépasse la limite : mieux vaut échouer que publier un
 * artefact que le canal altérera.
 */
export function splitChunks(base64, max = MAX_CHUNK_CHARS) {
  const chunks = [];
  for (let index = 0; index < base64.length; index += max) {
    chunks.push(base64.slice(index, index + max));
  }
  for (const chunk of chunks) {
    if (chunk.length > max) throw new Error(`tranche trop longue : ${chunk.length} > ${max}`);
  }
  return chunks;
}

/** Échappe une valeur pour l'insérer dans un littéral SQL. */
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Vérifie la cohérence d'un artefact déjà publié dans le dépôt.
 *
 * Trois sources doivent concorder : le paquet (`loader.ts`), la migration, et le
 * bundle reconstruit depuis les sources. Si l'une diverge, l'artefact déployé ne
 * correspondrait pas au code du dépôt.
 */
export async function verify(name, options = {}) {
  const spec = ARTIFACTS[name];
  if (!spec) throw new Error(`artefact inconnu : ${name}`);

  const problems = [];
  const bundle = await buildBundle(name, options);

  const loaderPath = join(ROOT, `supabase/functions/${name}/loader.ts`);
  if (!existsSync(loaderPath)) {
    problems.push(`chargeur absent : ${loaderPath}`);
  } else {
    const loader = readFileSync(loaderPath, 'utf8');
    if (!loader.includes(`const SHA256 = "${bundle.sha256}"`)) {
      problems.push(`loader.ts : SHA-256 différent de la source (${bundle.sha256.slice(0, 12)}…)`);
    }
    if (!loader.includes(`const CHARS = ${bundle.chars};`)) {
      problems.push(`loader.ts : taille déclarée différente de la source (${bundle.chars})`);
    }
  }

  const migrationPath = join(ROOT, `supabase/migrations/${spec.migration}_${name.replace(/-/g, '_')}_artifact.sql`);
  if (!existsSync(migrationPath)) {
    problems.push(`migration absente : ${migrationPath}`);
  } else {
    const migration = readFileSync(migrationPath, 'utf8');
    if (!migration.includes(bundle.sha256)) {
      problems.push('migration : SHA-256 absent ou différent de la source');
    }
    if (!migration.includes(`${bundle.chunks.length} tranches`)) {
      problems.push('migration : nombre de tranches différent de la source');
    }
    if (!migration.includes(String(bundle.base64.length))) {
      problems.push('migration : longueur base64 attendue non déclarée');
    }
    // Le contenu des tranches doit correspondre exactement.
    const declared = [...migration.matchAll(/\(\s*'[^']*',\s*\d+,\s*'([^']*)'\s*\)/g)].map((m) => m[1]);
    if (declared.length !== bundle.chunks.length) {
      problems.push(`migration : ${declared.length} tranches écrites, ${bundle.chunks.length} attendues`);
    } else if (declared.some((chunk, index) => chunk !== bundle.chunks[index])) {
      problems.push('migration : le contenu des tranches diffère de la source');
    }
  }

  return { ok: problems.length === 0, name, bundle, problems };
}

/**
 * Écrit les trois fichiers d'un artefact.
 *
 * Chargement du paquet et de la migration DÉLÉGUÉ au générateur de référence :
 * un artefact produit ici doit être identique au caractère près à celui produit
 * par `build-edge-loader.mjs`. Deux implémentations concurrentes finiraient par
 * diverger, et la vérification de cohérence signalerait alors une incohérence
 * qui n'existerait que dans nos outils.
 *
 * Ce module ajoute ce que le générateur ne fait pas : la vérification croisée
 * des trois représentations, et la liste explicite de ce qui sera publié.
 */
export async function publish(name) {
  const spec = ARTIFACTS[name];
  if (!spec) throw new Error(`artefact inconnu : ${name}`);

  const reference = await loadGenerator();
  const built = reference.buildBundle(ROOT, name);

  const loaderPath = join(ROOT, `supabase/functions/${name}/loader.ts`);
  const edgePath = join(ROOT, `supabase/functions/${name}.edge.js`);
  const migrationPath = join(ROOT, `supabase/migrations/${spec.migration}_${name.replace(/-/g, '_')}_artifact.sql`);

  writeFileSync(loaderPath, reference.renderLoader(name, built), 'utf8');
  // `.edge.js` reçoit le BUNDLE BRUT, pas le chargeur : c'est la source
  // exécutable telle qu'elle sera recomposée depuis les tranches. La confondre
  // avec le chargeur ferait exécuter le chargeur sur lui-même.
  writeFileSync(edgePath, built.source, 'utf8');
  writeFileSync(migrationPath, reference.renderSeedSql(name, built), 'utf8');

  return {
    bundle: {
      name,
      sha256: built.sha256,
      chars: built.chars,
      gzipBytes: built.gzBytes,
      chunks: splitChunks(built.base64),
    },
    written: [loaderPath, edgePath, migrationPath],
  };
}

// ---------------------------------------------------------------------------
// Interface en ligne de commande
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const list = args.includes('--list');
  const names = args.filter((arg) => !arg.startsWith('--'));

  if (list) {
    for (const [name, spec] of Object.entries(ARTIFACTS)) {
      console.log(`${name}  ${spec.entry}  →  ${spec.migration}_${name.replace(/-/g, '_')}_artifact.sql`);
    }
    return 0;
  }

  const targets = names.length > 0 ? names : Object.keys(ARTIFACTS);
  let failed = false;

  for (const name of targets) {
    if (check) {
      const result = await verify(name);
      if (result.ok) {
        console.log(`${name} : cohérent (${result.bundle.chars} caractères, ${result.bundle.chunks.length} tranches, sha256 ${result.bundle.sha256.slice(0, 16)}…)`);
      } else {
        failed = true;
        console.error(`${name} : INCOHÉRENT`);
        for (const problem of result.problems) console.error(`  - ${problem}`);
      }
    } else {
      const { bundle, written } = await publish(name);
      console.log(`${name} : ${bundle.chars} caractères, ${bundle.gzipBytes} octets gzip, ${bundle.chunks.length} tranches, sha256 ${bundle.sha256.slice(0, 16)}…`);
      for (const path of written) console.log(`  écrit : ${path.replace(ROOT + '/', '')}`);
    }
  }

  if (failed) {
    console.error('\nAucune écriture en base n\'a eu lieu. Corrigez puis relancez.');
    return 1;
  }
  return 0;
}

// Exécution directe uniquement : le module reste importable par les tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
