#!/usr/bin/env node
/**
 * Garde-fou de résolution des Edge Functions Supabase.
 *
 * Le bundler Deno utilisé par `supabase functions deploy` (eszip côté CLI
 * lorsque Docker tourne, bundle côté API sinon) exige une extension explicite
 * sur chaque import relatif. Un import `./intelligence` échoue avec :
 *   "Cannot find module ... Maybe add a '.ts' extension"
 * alors qu'esbuild/Vite le tolèrent — d'où ce contrôle, indépendant de Vite.
 *
 * Usage : node scripts/check-edge-imports.mjs
 * Sortie : code 1 si un import relatif est ambigu ou pointe vers un fichier absent.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.argv[2] ?? 'supabase/functions');
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'];
// Spécificateurs Deno/npm/URL : hors périmètre.
const isRemote = (spec) => /^(npm:|jsr:|node:|https?:|data:)/.test(spec);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const findings = [];
const specifierPattern = /(?:from\s*|import\s*\(\s*)['"]((?:\.{1,2}\/)[^'"]*)['"]/g;

for (const file of await walk(ROOT)) {
  const source = await readFile(file, 'utf8');
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(specifierPattern)) {
      const spec = match[1];
      if (isRemote(spec)) continue;
      const hasExtension = EXTENSIONS.some((ext) => spec.endsWith(ext));
      const target = path.resolve(path.dirname(file), spec);
      const relative = path.relative(process.cwd(), file);
      if (!hasExtension) {
        findings.push(`${relative}:${index + 1} — import « ${spec} » sans extension explicite (Deno échoue, Vite non)`);
        continue;
      }
      stat(target).catch(() => {
        findings.push(`${relative}:${index + 1} — import « ${spec} » : fichier introuvable`);
      });
    }
  });
}

if (findings.length > 0) {
  console.error('Imports relatifs incompatibles avec le bundler Deno :');
  for (const finding of findings) console.error('  - ' + finding);
  console.error('\nAjoutez l’extension explicite (ex. « ./intelligence » → « ./intelligence.ts »).');
  process.exit(1);
}

console.log(`Imports relatifs conformes au bundler Deno (${path.relative(process.cwd(), ROOT)}).`);
