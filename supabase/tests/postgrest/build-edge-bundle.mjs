// Banc PostgREST — compilation du VRAI code Edge business-grow pour Node.
//
// Source : supabase/functions/business-grow/index.ts (identique au bundle
// déployé, cf. bootstrap.ts). Seule adaptation : le pilote `npm:postgres`
// est remplacé par le shim node-postgres (pg-shim.mjs) — le SQL exécuté est
// identique. `Deno` est fourni par edge-runner.mjs à l'exécution.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

await build({
  entryPoints: [path.join(REPO, 'supabase/functions/business-grow/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(HERE, 'edge-bundle.cjs'),
  logLevel: 'warning',
  plugins: [{
    name: 'bench-adaptations',
    setup(b) {
      b.onResolve({ filter: /^npm:postgres/ }, () => ({ path: path.join(HERE, 'pg-shim.mjs') }));
    },
  }],
});
console.log('edge-bundle.cjs généré (code Edge réel, pilote bench)');
