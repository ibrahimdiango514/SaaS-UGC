#!/usr/bin/env node
/**
 * Migration de marque VYORA / REELORA -> SORAHNEX.
 *
 * Remplacements UNIQUEMENT sur les chaînes de marque visibles (UI, documentation,
 * métadonnées, textes). Les identifiants techniques ne sont jamais touchés :
 *
 *   - variables d'environnement    VYORA_* / REELORA_*
 *   - Edge Functions               vyora-ai, vyora-mcp, vyora-payments, ...
 *   - fonctions SQL / RPC          vyora_admin_*, reelora_*
 *   - tables, buckets, sites       vyora_files, vyora-ugc, vyora-saas-ugc
 *   - classes CSS / animations     vyora-card, vyora-reveal-in, ...
 *   - types TypeScript             ReeloraModelStatus, VyoraFile
 *
 * Le remplacement s'appuie sur `\b` : « VYORA » suivi de `_` (VYORA_BUILD_ENABLED)
 * n'est donc pas un mot isolé et reste intact.
 *
 * Usage :
 *   node scripts/rename-brand.mjs           applique
 *   node scripts/rename-brand.mjs --check   liste les occurrences de marque restantes
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const TEXT_EXT = /\.(tsx?|jsx?|mjs|cjs|json|md|html|css|toml|ya?ml|txt|sh)$/;
// Zones exclues : artefacts générés, ressources techniques déployées, verrou.
//
// `supabase/**` et `scripts/**` sont volontairement hors périmètre : les bundles
// Edge déployés sont épinglés par commit + empreinte SHA-256, et les générateurs
// doivent rester bit-à-bit ceux qui ont produit ces artefacts. Renommer la marque
// dans cette couche exige un cycle dédié : régénérer, commiter l'artefact, puis
// réépingler le chargeur sur le commit de `main` qui le contient (cf.
// docs/renommage-sorahnex.md).
// Modules `src/` inlinés dans les bundles Edge épinglés : leur texte fait partie
// des octets du bundle déployé. Les renommer ici désynchroniserait l'artefact
// de son empreinte SHA-256 (503 BUSINESS_GROW_ARTIFACT_UNAVAILABLE). Ils passent
// dans la seconde PR, avec régénération + réépinglage.
const INLINED_IN_EDGE_BUNDLES = /^src\/(business\/importer\/|lib\/origin-allowlist\.ts$)/;
const EXCLUDED = [
  /^supabase\//,
  /^scripts\//,
  /^artifacts\//,
  /^freebuff-sites-build\//,
  /^node_modules\//,
  /^package-lock\.json$/,
  /^tsconfig\.tsbuildinfo$/,
];

// Ordre significatif : les libellés composés d'abord.
const RULES = [
  // Un code promo réel existe en base (REELORA2026) : on ne renomme pas le
  // placeholder, sinon l'UI suggérerait un code invalide.
  [/placeholder="VYORA2026"/g, 'placeholder="Code promo"'],
  [/\bVYORA Business Growth\b/g, 'SORAHNEX Grow'],
  [/\bVYORA Business Grow\b/g, 'SORAHNEX Grow'],
  [/\bVYORA Studio\b/g, 'SORAHNEX Studio'],
  [/\bReelora Studio\b/g, 'SORAHNEX Studio'],
  [/\bVYORA AI CORE\b/g, 'SORAHNEX AI CORE'],
  [/\bVYORA AI GATEWAY\b/g, 'SORAHNEX AI'],
  [/\bREELORA\b/g, 'SORAHNEX STUDIO'],
  [/\bReelora\b/g, 'SORAHNEX Studio'],
  [/\bVYORA\b/g, 'SORAHNEX'],
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((f) => TEXT_EXT.test(f))
    .filter((f) => !EXCLUDED.some((re) => re.test(f)))
    .filter((f) => !INLINED_IN_EDGE_BUNDLES.test(f));
}

function walk(files) {
  const changed = [];
  for (const file of files) {
    const abs = `${ROOT}${file}`;
    const before = readFileSync(abs, 'utf8');
    let after = before;
    for (const [re, to] of RULES) after = after.replace(re, to);
    if (after !== before) {
      writeFileSync(abs, after);
      changed.push(file);
    }
  }
  return changed;
}

// Vérification : ce qui reste doit être un identifiant technique justifié.
function check(files) {
  const leftovers = [];
  for (const file of files) {
    const lines = readFileSync(`${ROOT}${file}`, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bVYORA\b(?!_)/.test(line) || /\b(Vyora|REELORA|Reelora)\b/.test(line)) {
        leftovers.push(`${file}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    });
  }
  return leftovers;
}

const files = trackedFiles();
if (process.argv.includes('--check')) {
  const leftovers = check(files);
  console.log(leftovers.length === 0 ? 'Aucune occurrence de marque restante.' : leftovers.join('\n'));
  process.exitCode = leftovers.length === 0 ? 0 : 1;
} else {
  const changed = walk(files);
  console.log(`${changed.length} fichier(s) migré(s).`);
  const leftovers = check(files);
  console.log(
    leftovers.length === 0
      ? 'Aucune occurrence de marque restante.'
      : `Occurrences restantes :\n${leftovers.join('\n')}`,
  );
}
