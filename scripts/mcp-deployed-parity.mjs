#!/usr/bin/env node
/**
 * VYORA MCP — contrôle d'INTÉGRITÉ entre la source du dépôt et la fonction
 * déployée.
 *
 * ## Problème résolu
 * `vyora-mcp` a été publié en monofichier, alors que le dépôt contient une
 * source modulaire (`protocol.ts`, `tools.ts`, `supabase-store.ts`, `index.ts`).
 * Ces deux sources peuvent diverger silencieusement : une correction appliquée
 * à l'une seulement laisserait la production sur un code différent de celui qui
 * est testé. C'est exactement le risque que ce contrôle supprime.
 *
 * ## Ce que le script fait
 * 1. il reconstruit le monofichier canonique à partir de la source modulaire
 *    (esbuild, bundle ESM non minifié, sans import résiduel) ;
 * 2. il compare son empreinte SHA-256 à celle du corps réellement déployé,
 *    fourni dans un fichier JSON (`get_edge_function` → champ `body`) ;
 * 3. en cas d'écart, il écrit un rapport de diagnostic et sort en code 1.
 *
 * ## Usage
 *   node scripts/mcp-deployed-parity.mjs --deployed /chemin/vers/deployed.json
 *   node scripts/build-edge-loader.mjs --emit-bundle vyora-mcp   (forme canonique)
 *
 * Le fichier `--deployed` n'est jamais commité : il contient la source de
 * production, régénérable à tout moment depuis la plateforme.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import esbuild from 'esbuild';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ROOT = process.cwd();
const ENTRY = 'supabase/functions/vyora-mcp/index.ts';
const DEPLOYED_FILE = valueOf('deployed', '');
const OUT = valueOf('out', 'supabase/functions/vyora-mcp.edge.ts');

/** Construit le monofichier canonique (aucun import résiduel possible). */
export function buildCanonicalBundle(root = ROOT) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, ENTRY)],
    bundle: true,
    write: false,
    minify: false,
    platform: 'neutral',
    format: 'esm',
    target: 'es2022',
    legalComments: 'inline',
    logLevel: 'silent',
  });
  const source = result.outputFiles[0].text.replace(/\r\n/g, '\n');
  return { source, sha256: createHash('sha256').update(source, 'utf8').digest('hex'), chars: source.length };
}

function main() {
  const built = buildCanonicalBundle();
  console.log(`source modulaire → monofichier : ${built.chars} caractères, sha256 ${built.sha256.slice(0, 16)}…`);

  if (args.includes('--emit')) {
    writeFileSync(path.join(ROOT, OUT), built.source, 'utf8');
    console.log(`écrit : ${OUT}`);
  }

  if (!DEPLOYED_FILE) {
    console.log('\nAucun fichier --deployed fourni : construction seule.');
    console.log('Pour vérifier la parité, exporter le corps déployé :');
    console.log('  get_edge_function("vyora-mcp") → { "body": "..." } dans un fichier JSON');
    return 0;
  }
  if (!existsSync(DEPLOYED_FILE)) {
    console.error(`fichier introuvable : ${DEPLOYED_FILE}`);
    return 2;
  }

  const payload = JSON.parse(readFileSync(DEPLOYED_FILE, 'utf8'));
  const deployed = typeof payload === 'string' ? payload : payload.body;
  if (typeof deployed !== 'string' || deployed.length === 0) {
    console.error('le fichier --deployed ne contient pas de champ « body » exploitable');
    return 2;
  }

  const deployedSha = createHash('sha256').update(deployed, 'utf8').digest('hex');
  console.log(`source déployée            : ${deployed.length} caractères, sha256 ${deployedSha.slice(0, 16)}…`);

  if (deployedSha === built.sha256) {
    console.log('\nPARITÉ VÉRIFIÉE : la source déployée est identique au monofichier canonique du dépôt.');
    return 0;
  }

  // Diagnostic : première ligne qui diffère, sans jamais recopier 13 Ko.
  const builtLines = built.source.split('\n');
  const deployedLines = deployed.split('\n');
  let firstDiff = -1;
  const max = Math.max(builtLines.length, deployedLines.length);
  for (let i = 0; i < max; i += 1) {
    if (builtLines[i] !== deployedLines[i]) {
      firstDiff = i;
      break;
    }
  }

  console.log('\nÉCART DÉTECTÉ');
  console.log(`  lignes dépôt : ${builtLines.length}, lignes déployées : ${deployedLines.length}`);
  if (firstDiff >= 0) {
    console.log(`  première divergence à la ligne ${firstDiff + 1}`);
    const truncate = (value) => (value === undefined ? '<absente>' : value.slice(0, 120));
    console.log(`    dépôt    : ${truncate(builtLines[firstDiff])}`);
    console.log(`    déployée : ${truncate(deployedLines[firstDiff])}`);
  }
  console.log('\nAction : republier la fonction depuis le monofichier canonique, ou');
  console.log('rattacher vyora-mcp au mécanisme d\'artefacts (loader + tranches).');
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith('mcp-deployed-parity.mjs')) {
  process.exit(main());
}
