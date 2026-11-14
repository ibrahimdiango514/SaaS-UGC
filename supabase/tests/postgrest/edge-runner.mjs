// Banc PostgREST — hôte local de la VRAI Edge Function business-grow.
//
// Exécute le code réel (edge-bundle.cjs, compilé depuis
// supabase/functions/business-grow/index.ts) sur Node, avec :
//   - DEN : global minimal (env + serve) ;
//   - pilote postgres : shim node-postgres (SQL identique, rôle bg_edge) ;
//   - IA : le fetch global redirige api.groq.com /
//     generativelanguage.googleapis.com vers le faux fournisseur local
//     (mock-ai.mjs) — les adaptateurs réels (headers, corps, parsing,
//     erreurs) restent intacts ;
//   - auth : l'Edge Function appelle {SUPABASE_URL}/auth/v1/user sur le
//     GATEWAY local (vérification JWT réelle + auth.users réelle).
//
// Aucun appel sortant n'est possible : tout le trafic est local.
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDGE_PORT } from './pg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const BG_DIR = path.resolve(HERE, '../../functions/business-grow');

// Recompiler le bundle si absent ou périmé (source plus récente) — le banc
// teste TOUJOURS le code réel du dépôt.
function ensureBundle(log) {
  const bundle = path.join(HERE, 'edge-bundle.cjs');
  const sources = ['index.ts', 'handler.ts', 'providers.ts', 'intelligence.ts', 'loader.ts']
    .map((f) => path.join(BG_DIR, f))
    .filter((f) => existsSync(f));
  sources.push(path.join(HERE, 'pg-shim.mjs')); // alias npm:postgres dans le bundle
  const stale = !existsSync(bundle) || sources.some((s) => statSync(s).mtimeMs > statSync(bundle).mtimeMs);
  if (stale) {
    log('  edge : compilation du vrai code business-grow (esbuild) → edge-bundle.cjs');
    execFileSync(process.execPath, [path.join(HERE, 'build-edge-bundle.mjs')], { stdio: 'inherit' });
  }
}

export async function startEdgeRunner({ gatewayUrl, aiUrl, databaseUrl, groqKey, geminiKey, groqModel, geminiModel, log = (m) => console.log(m) } = {}) {
  // --- En environnement de l'Edge Function (équivalents des secrets Edge) ---
  process.env.SUPABASE_URL = gatewayUrl;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'bench-anon';
  process.env.BUSINESS_GROW_DATABASE_URL = databaseUrl;
  process.env.BUSINESS_GROW_GROQ_API_KEY = groqKey;
  process.env.BUSINESS_GROW_GROQ_MODEL = groqModel;
  process.env.BUSINESS_GROW_GEMINI_API_KEY = geminiKey;
  process.env.BUSINESS_GROW_GEMINI_MODEL = geminiModel;
  process.env.BUSINESS_GROW_PROVIDER_ORDER = 'groq,gemini';

  // --- Redirection IA vers le faux fournisseur local (aucun réseau) --------
  const aiBase = new URL(aiUrl);
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const rewritten = url.replace('https://api.groq.com', aiBase.origin).replace('https://generativelanguage.googleapis.com', aiBase.origin);
    log(`fetch → ${rewritten === url ? url : `REDIRIGÉ ${url} → ${rewritten}`}`);
    return realFetch(rewritten, init);
  };

  // --- Runtime Deno minimal --------------------------------------------------
  let handler = null;
  globalThis.Deno = {
    env: { get: (name) => (process.env[name] === undefined ? null : process.env[name]) },
    serve: (h) => { handler = h; },
  };

  // --- Code Edge réel ---------------------------------------------------------
  ensureBundle(log);
  require(path.join(HERE, 'edge-bundle.cjs'));
  if (!handler) throw new Error('Le bundle Edge n’a pas exposé de handler (Deno.serve).');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else headers.set(k, v);
        }
        const request = new Request(`http://edge.local${req.url}`, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        });
        const response = await handler(request);
        const outHeaders = {};
        for (const [k, v] of response.headers.entries()) outHeaders[k] = v;
        res.writeHead(response.status, outHeaders);
        res.end(await response.text());
      } catch (e) {
        log(`edge-runner ERREUR : ${e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'EDGE_BENCH_ERROR', message: e.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(EDGE_PORT, '127.0.0.1', resolve));
  log(`  edge business-grow  http://127.0.0.1:${EDGE_PORT} (code réel, DB bg_edge, auth gateway, IA locales)`);
  return { server, close: async () => { globalThis.fetch = realFetch; delete globalThis.Deno; await new Promise((r) => server.close(r)); } };
}
