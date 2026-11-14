// Démarrer l'environnement de banc et le GARDER au repos (tests manuels).
//
//   node start.mjs            → monte PG 17 + gateway + mock IA + Edge réel
//                              puis attend (Ctrl+C pour l'arrêter proprement)
//   node stop.mjs             → arrête l'instance démarrée par start.mjs
//
// L'état (pid, ports, utilisateurs de seed, clé JWT de banc) est écrit dans
// .state.json pour stop.mjs et pour générer des tokens de test manuellement.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { setupEnv, startServices, GROQ_TEST_KEY, GEMINI_TEST_KEY, GROQ_MODEL, GEMINI_MODEL } from './env.mjs';

const STATE = join(fileURLToPath(new URL('.', import.meta.url)), '.state.json');

if (existsSync(STATE)) {
  const prev = JSON.parse(readFileSync(STATE, 'utf8'));
  try { process.kill(prev.pid, 0); console.log(`Une instance est déjà démarrée (pid ${prev.pid}). Arrêtez-la d'abord : node stop.mjs`); process.exit(1); }
  catch { /* morte : on écrase */ }
}

console.log('═ Banc PostgREST — montage de l’environnement (100 % local)');
const env = await setupEnv({ fresh: true, log: (m) => console.log(m) });
const services = await startServices({ secret: env.secret, log: (m) => console.log(m) });

const state = {
  pid: process.pid,
  started_at: new Date().toISOString(),
  db: { host: '127.0.0.1', port: 54330, user: 'postgres', password: 'pw' },
  services: { rest: services.baseUrl, ai: services.aiBase, edge: services.edgeUrl },
  jwt: { secret: env.secret, audience: 'authenticated' },
  keys: { anon: 'bench-anon', groq: GROQ_TEST_KEY, gemini: GEMINI_TEST_KEY, groqModel: GROQ_MODEL, geminiModel: GEMINI_MODEL },
  users: Object.fromEntries(Object.entries(env.seedData.users).map(([k, v]) => [k, { id: v.id, email: v.email }])),
  workspaces: { A: env.seedData.workspaces.A, B: env.seedData.workspaces.B, orpheline: env.seedData.workspaces.orpheline },
};
writeFileSync(STATE, JSON.stringify(state, null, 2));

console.log('\n✓ Environnement prêt.');
console.log(`  REST  : ${services.baseUrl}/rest/v1  (API key « bench-anon »)`);
console.log(`  Edge  : ${services.edgeUrl} (POST { action, ... })`);
console.log(`  IA    : ${services.aiBase} (fournisseurs locaux)`);
console.log(`  état  : ${STATE} (tokens : node -e "…" — secret jwt dans l'état)`);
console.log('\nArrêt propre : node stop.mjs (ou Ctrl+C ici)');

let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  console.log('\nArrêt propre…');
  try { await services.close(); } catch {}
  try { await env.pgServer.stop(); } catch {}
  try { if (existsSync(STATE)) unlinkSync(STATE); } catch {}
  console.log('Environnement arrêté. Bye.');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
