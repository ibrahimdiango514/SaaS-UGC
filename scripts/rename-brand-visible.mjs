#!/usr/bin/env node
/**
 * Renommage de la MARQUE VISIBLE VYORA / REELORA → SORAHNEX.
 *
 * Ce script ne touche QUE des textes affichés (JSX, libellés, docs, titres).
 * Il protège explicitement, par jetons, tout identifiant technique :
 *   - variables d'environnement   VYORA_*, REELORA_*
 *   - slugs d'Edge Functions      'vyora-ai', "reelora-video", …
 *   - URLs contenant la marque    https://vyora.app, vyora.netlify.app
 *   - noms d'outils MCP / SQL     vyora_*, reelora_*  (minuscules, non touchés)
 *   - classes CSS                 vyora-card, vyora-btn-sheen (minuscules)
 *
 * Usage :
 *   node scripts/rename-brand-visible.mjs            # simulation + rapport
 *   node scripts/rename-brand-visible.mjs --apply    # écrit les fichiers
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');

const TARGETS = ['src', 'tests', 'docs', 'supabase/functions', 'index.html', 'README.md'];

/**
 * Fichiers qui doivent continuer à nommer les anciennes marques : la garde de
 * tests les interdit, donc les renommer ici inverserait son sens (elle se
 * mettrait à interdire SORAHNEX). Le script ne les analyse jamais.
 */
const EXCLUDED = new Set([
  'tests/brand-visible-sorahnnex.test.ts',
  'scripts/rename-brand-visible.mjs',
]);
const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.md', '.html', '.json', '.css', '.txt',
]);

/** Jetons techniques à ne jamais modifier, remplacés par des sentinelles. */
const PROTECTIONS = [
  /\bVYORA_[A-Z0-9_]+\b/g,
  /\bREELORA_[A-Z0-9_]+\b/g,
  /https?:\/\/[^\s'"`)<>\]]*(?:vyora|reelora)[^\s'"`)<>\]]*/gi,
  /\bvyora-(?:saas-ugc|ugc)\b/gi,
  /(['"`])(?:vyora|reelora)-[a-z0-9][a-z0-9-]*\1/g,
  /\bx-(?:vyora|reelora)-[a-z-]+\b/g,
];

/** Remplacements, dans l'ordre : le plus spécifique d'abord. */
const RULES = [
  ['VYORA Business Growth', 'SORAHNEX Grow'],
  ['VYORA Business', 'SORAHNEX Grow'],
  ['VYORA · Studio & Business', 'SORAHNEX · Studio & Grow'],
  ['REELORA', 'SORAHNEX'],
  ['Reelora', 'Sorahnnex'],
  ['VYORA', 'SORAHNEX'],
  ['Vyora', 'Sorahnnex'],
  ['Business Growth', 'Grow'],
  ['Business Grow', 'Grow'],
  ['Studio & Business', 'Studio & Grow'],
];

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(join(path, entry), out);
    }
  } else if (EXTENSIONS.has(extname(path))) {
    out.push(path);
  }
  return out;
}

const files = TARGETS.flatMap((t) => {
  try { return walk(join(ROOT, t)); } catch { return []; }
});

const report = [];
let changedFiles = 0;

for (const file of files) {
  if (EXCLUDED.has(relative(ROOT, file).split('\\').join('/'))) continue;
  const before = readFileSync(file, 'utf8');
  if (!/vyora|reelora/i.test(before)) continue;

  const saved = [];
  let text = before;
  PROTECTIONS.forEach((re, i) => {
    text = text.replace(re, (m) => {
      saved.push(m);
      return `\u0000PROTECT${i}_${saved.length - 1}\u0000`;
    });
  });

  for (const [from, to] of RULES) text = text.split(from).join(to);

  text = text.replace(/\u0000PROTECT(\d+)_(\d+)\u0000/g, (_m, _i, idx) => saved[Number(idx)]);

  if (text !== before) {
    changedFiles += 1;
    const remaining = (text.match(/\b(?:VYORA|Vyora|REELORA|Reelora)\b/g) ?? []);
    report.push({ file: relative(ROOT, file), remaining: [...new Set(remaining)] });
    if (APPLY) writeFileSync(file, text, 'utf8');
  }
}

const leftovers = new Map();
for (const entry of report) {
  for (const token of entry.remaining) leftovers.set(token, (leftovers.get(token) ?? 0) + 1);
}

console.log(`${APPLY ? 'APPLIQUÉ' : 'SIMULATION'} — ${changedFiles} fichier(s) modifiés sur ${files.length} analysés.`);
console.log('Jetons de marque restants (attendu : uniquement des identifiants protégés) :');
for (const [token, count] of [...leftovers.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${token} : ${count} fichier(s)`);
}
if (!APPLY) {
  console.log('\n5 premiers fichiers :');
  for (const entry of report.slice(0, 5)) console.log(`  ${entry.file}`);
}
