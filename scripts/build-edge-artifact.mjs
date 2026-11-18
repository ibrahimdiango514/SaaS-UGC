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
import { renderGithubLoader, verifierChargeur } from './edge-github-loader.mjs';

const POSTGRES = 'npm:postgres@3.4.5';
const ARTIFACT_TABLE = '_edge_function_artifact';

/** Fonctions gérées par ce générateur (entrée + chargeur déployé). */
/**
 * Fonctions gérées par ce générateur.
 *
 * `loader` est le fichier réellement déployé. Il porte le mécanisme
 * « GitHub épinglé » depuis la Phase A : le dépôt doit décrire ce qui tourne,
 * pas un ancien modèle d'artefact en base qui n'existe plus en production.
 * `bootstrap` est conservé comme trace du chargeur historique, mais n'est plus
 * généré : il n'est pas déployé.
 */
export const FUNCTIONS = {
  'store-import': {
    entry: 'supabase/functions/store-import/index.ts',
    loader: 'supabase/functions/store-import/loader.ts',
    artifact: 'supabase/functions/_artifacts/store-import.js',
    usesPostgres: true,
  },
  // Connexion d'une boutique à clé d'API (PrestaShop). Même mécanisme
  // d'artefact épinglé que `store-import` : le code livré est celui du dépôt, à
  // un commit précis, vérifié par taille et empreinte avant exécution.
  'store-connect': {
    entry: 'supabase/functions/store-connect/index.ts',
    loader: 'supabase/functions/store-connect/loader.ts',
    artifact: 'supabase/functions/_artifacts/store-connect.js',
    usesPostgres: true,
  },
  // Porte d'exécution des outils MCP externes. Même mécanisme : le code livré
  // est celui du dépôt, à un commit précis, vérifié par taille et empreinte.
  // Aucun autre réglage n'est nécessaire — `index.ts` n'exporte rien, ce qui
  // le rend exécutable par `new Function`.
  'mcp-client': {
    entry: 'supabase/functions/mcp-client/index.ts',
    loader: 'supabase/functions/mcp-client/loader.ts',
    artifact: 'supabase/functions/_artifacts/mcp-client.js',
    usesPostgres: true,
  },
  // Connexion des comptes Meta (Facebook Page, WhatsApp Business, Messenger,
  // Instagram). `index.ts` importe trois modules situés HORS de
  // `supabase/functions/` : `./handler.ts` (local), et surtout
  // `../../../src/business/meta/*.ts` + `../../../src/lib/origin-allowlist.ts`.
  // Un déploiement de la source seule ne transporte pas ces fichiers : le
  // gestionnaire échouerait au démarrage. D'où le bundle, comme pour
  // `store-connect`. `index.ts` n'exporte rien et appelle `runtime.serve` en fin
  // de module : il est donc exécutable par `new Function`.
  'meta-connect': {
    entry: 'supabase/functions/meta-connect/index.ts',
    loader: 'supabase/functions/meta-connect/loader.ts',
    artifact: 'supabase/functions/_artifacts/meta-connect.js',
    usesPostgres: true,
  },
  // Réception des notifications Meta (vérification GET + POST signés HMAC).
  // Même besoin d'import hors `supabase/functions/`, même remède. Cette fonction
  // ÉCRIT en base (événements, messages, statuts) : `usesPostgres` est vrai.
  'meta-webhook': {
    entry: 'supabase/functions/meta-webhook/index.ts',
    loader: 'supabase/functions/meta-webhook/loader.ts',
    artifact: 'supabase/functions/_artifacts/meta-webhook.js',
    usesPostgres: true,
  },
};

// esbuild peut placer l'import en fin de ligne, après d'autres instructions :
// le motif n'est donc pas ancré en début de ligne.
// Le nom de liaison peut contenir `$` : esbuild renomme en `$r`, `$a`… quand un
// export du module d'entrée occupe déjà le nom court. Ne pas restreindre à `\w`,
// sous peine de laisser une instruction `import` dans le bundle (erreur levée
// plus bas, sans indiquer la vraie cause).
const IMPORT_SIMPLE = new RegExp(`import\\s+([\\w$]+)\\s+from\\s*(["'])${POSTGRES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2;?`, 'g');
const IMPORT_NAMED = new RegExp(`import\\s*\\{\\s*default\\s+as\\s+([\\w$]+)\\s*\\}\\s*from\\s*(["'])${POSTGRES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2;?`, 'g');
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
 * Chargeur déployé — délègue au générateur partagé.
 *
 * L'implémentation vit dans `scripts/edge-github-loader.mjs` pour que
 * `business-grow` et `store-import` ne puissent plus diverger : c'est
 * exactement la divergence qui avait fait perdre la garde d'abonnement dans
 * le bundle committé.
 */
export function renderLoader(name, { sha256, chars }, commit) {
  const config = FUNCTIONS[name];
  if (!config.artifact) {
    throw new Error(`chemin d'artefact inconnu pour ${name}`);
  }
  const code = renderGithubLoader({
    fonction: name,
    path: config.artifact,
    sha256,
    chars,
    commit,
    chargeur: config.usesPostgres ? '__edgePostgres' : undefined,
  });
  const problemes = verifierChargeur(code);
  if (problemes.length) {
    throw new Error(`chargeur ${name} non conforme : ${problemes.join(', ')}`);
  }
  return code;
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
  const commit = (process.env.EDGE_PIN_COMMIT || '').trim().toLowerCase();
  const code = renderLoader(name, built, commit || '0'.repeat(40));
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ name, sha256: built.sha256, chars: built.chars, loaderChars: code.length }));
    process.exit(0);
  }
  if (process.argv.includes('--sql')) {
    // Conservé pour l'historique : n'est plus le mode de déploiement.
    console.log(artifactSql(name, built));
    process.exit(0);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    // Sans commit épinglé, le chargeur généré pointerait sur une URL invalide.
    // On refuse plutôt que d'écrire un fichier inutilisable.
    console.error('EDGE_PIN_COMMIT doit être un SHA de commit complet (40 hexadécimaux).');
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    const current = existsSync(loaderPath) ? readFileSync(loaderPath, 'utf8') : '';
    if (current !== code) {
      console.error(`chargeur désynchronisé : ${FUNCTIONS[name].loader}`);
      process.exit(1);
    }
    console.log(`chargeur à jour (${name}, ${built.chars} caractères de bundle)`);
  } else {
    // Le chargeur télécharge l'artefact depuis le commit épinglé : si le fichier
    // n'est pas écrit ET committé, la production charge un ancien bundle, ou
    // échoue sur une empreinte qui ne correspond plus. Écrire le chargeur sans
    // l'artefact produisait exactement cette dérive silencieuse.
    const artifactPath = join(process.cwd(), FUNCTIONS[name].artifact);
    writeFileSync(artifactPath, built.source, 'utf8');
    writeFileSync(loaderPath, code, 'utf8');
    console.log(`écrit ${FUNCTIONS[name].artifact} — sha256 ${built.sha256}, ${built.chars} caractères`);
    console.log(`écrit ${FUNCTIONS[name].loader} — épinglé sur le commit ${commit}`);
  }
}
