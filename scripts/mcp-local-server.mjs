#!/usr/bin/env node
/**
 * VYORA MCP — serveur LOCAL de test de compatibilité.
 *
 * ## Pourquoi
 * Le sandbox de développement n'a pas d'accès réseau vers `*.supabase.co`, et le
 * serveur déployé ne peut donc pas être joint directement. Ce pont exécute le
 * code de `supabase/functions/vyora-mcp/index.ts` **tel quel** sur localhost, en
 * remplaçant uniquement :
 *   - les variables d'environnement (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
 *     par celles du projet réel, et
 *   - `fetch` vers `https://<projet>.supabase.co/rest/v1/...` par un relais
 *     local qui interroge la vraie base par le connecteur Supabase.
 *
 * ## Conséquence honnête
 * La logique MCP testée est **réellement celle du dépôt**. La base interrogée est
 * **réellement la production**. Seul le saut réseau vers PostgREST est relaisé.
 * Ce test prouve donc la compatibilité protocole ↔ client MCP officiel, et le
 * comportement réel des RPC — il ne prouve pas l'accessibilité réseau publique de
 * la fonction déployée (déjà prouvée séparément via `pg_net`).
 *
 * ## Usage
 *   node scripts/mcp-local-server.mjs --port 8799 --bridge <fichier-requetes>
 *
 * Le script écrit dans `--bridge` une ligne JSON par requête PostgREST à exécuter,
 * et lit les réponses depuis un fichier jumeau `<bridge>.responses`.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const PORT = Number(arg('port', '8799'));
const BRIDGE = arg('bridge', '/tmp/vyora-mcp-bridge.jsonl');
const SUPABASE_URL = arg('supabase-url', '');
const SERVICE_KEY = arg('service-key', '');

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('--supabase-url et --service-key sont requis');
  process.exit(2);
}

// Le code de la fonction lit Deno.env et appelle Deno.serve.
const served = [];
globalThis.Deno = {
  env: {
    get: (name) => {
      if (name === 'SUPABASE_URL') return SUPABASE_URL;
      if (name === 'SUPABASE_SERVICE_ROLE_KEY') return SERVICE_KEY;
      if (name === 'VYORA_MCP_WRITE_ENABLED') return arg('write-enabled', 'false');
      return undefined;
    },
  },
  serve: (handler) => {
    served.push(handler);
  },
};

// Les requêtes PostgREST partent vers le relais local, jamais vers le réseau.
const RELAY = `http://127.0.0.1:${PORT}/__relay`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(SUPABASE_URL)) {
    const relayed = url.replace(SUPABASE_URL, RELAY);
    return realFetch(relayed, init);
  }
  return realFetch(input, init);
};

// Charge la fonction Edge du dépôt (aucune copie, aucun fork).
await import('../supabase/functions/vyora-mcp/index.ts');

if (served.length !== 1) {
  console.error(`Deno.serve attendu 1 fois, reçu ${served.length}`);
  process.exit(3);
}
const handler = served[0];

if (existsSync(BRIDGE)) rmSync(BRIDGE);
if (existsSync(`${BRIDGE}.responses`)) rmSync(`${BRIDGE}.responses`);

/**
 * Relais PostgREST : écrit la requête dans le fichier-pont, attend la réponse
 * écrite par l'orchestrateur, puis la renvoie au `fetch` de la fonction.
 */
async function relay(request) {
  const path = new URL(request.url).pathname.replace('/__relay', '');
  const body = await request.text();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { id, method: request.method, path, body };
  writeFileSync(BRIDGE, `${JSON.stringify(payload)}\n`, { flag: 'a' });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (existsSync(`${BRIDGE}.responses`)) {
      const lines = readFileSync(`${BRIDGE}.responses`, 'utf8').trim().split('\n').filter(Boolean);
      const match = lines.map((line) => JSON.parse(line)).find((entry) => entry.id === id);
      if (match) {
        return new Response(match.text ?? '', {
          status: match.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return new Response('{"message":"bridge timeout"}', { status: 504 });
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyBuffer = Buffer.concat(chunks);

  let request;
  if (req.url.startsWith('/__relay')) {
    request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer,
    });
    const response = await relay(request);
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(await response.text());
    return;
  }

  request = new Request(`http://127.0.0.1:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer,
  });

  try {
    const response = await handler(request);
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    const text = await response.text();
    res.end(text);
  } catch (error) {
    console.error('handler error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`vyora-mcp (source du dépôt) à l'écoute sur http://127.0.0.1:${PORT}/`);
});
