// Banc PostgREST — environnement de test complet et reproductible.
//
//   setupEnv()      : PostgreSQL 17 réel (jetable) + socle Supabase + les 40
//                     migrations du dépôt + données de test (2 entreprises).
//   startServices() : gateway PostgREST-conforme + faux fournisseurs IA locaux
//                     + VRAI Edge Function business-grow (code réel).
//
// Aucun service distant n'est contacté. La clé JWT est générée aléatoirement
// à chaque exécution (aucun secret de production n'est utilisé).
import { start, migrateAll, withClient, BOOTSTRAP, PORT, GATEWAY_PORT, MOCK_AI_PORT, EDGE_PORT } from './pg.mjs';
import { seed } from './seed.mjs';
import { createGateway, createAuthenticatorPool } from './gateway.mjs';
import { startMockAi } from './mock-ai.mjs';
import { startEdgeRunner } from './edge-runner.mjs';
import { generateSecret } from './jwt.mjs';

export const GROQ_TEST_KEY = 'groq-bench-key-0001';
export const GEMINI_TEST_KEY = 'gemini-bench-key-0001';
export const GROQ_MODEL = 'llama-3.3-70b-versatile';
export const GEMINI_MODEL = 'gemini-2.5-flash';

export async function setupEnv({ fresh = true, log = (m) => console.log(m) } = {}) {
  const step = (m) => log(`  ${m}`);
  const pgServer = await start({ fresh });
  step('PostgreSQL 17 réel démarré (127.0.0.1, TLS local, base jetable)');
  await withClient('supabase_admin', async (c) => {
    const { rows } = await c.query(`select 1 from pg_roles where rolname = 'authenticator'`);
    if (rows.length === 0) await c.query(BOOTSTRAP);
  });
  step('socle Supabase (rôles, auth.users, auth.uid()/jwt(), stubs net/cron/vault) ok');
  await migrateAll({ log: step });
  const seedData = await seed({ log: step });
  const secret = generateSecret();
  return { pgServer, seedData, secret };
}

export async function startServices({ secret, port = GATEWAY_PORT, aiPort = MOCK_AI_PORT, edgePort = EDGE_PORT, log = (m) => console.log(m) } = {}) {
  const pool = createAuthenticatorPool({ user: 'authenticator', password: 'pw', port: PORT });
  const gateway = await new Promise((resolve) => {
    const g = createGateway({ secret, port, pool, dbUser: 'supabase_admin', dbPassword: 'pw' });
    g.server.once('listening', () => resolve(g));
  });
  const mockAi = await new Promise((resolve) => {
    const a = startMockAi({ port: aiPort, groqKey: GROQ_TEST_KEY, geminiKey: GEMINI_TEST_KEY, log: () => {} });
    a.server.once('listening', () => resolve(a));
  });
  const gatewayUrl = `http://127.0.0.1:${port}`;
  const aiUrl = `http://127.0.0.1:${aiPort}`;
  const edge = await startEdgeRunner({
    gatewayUrl,
    aiUrl,
    databaseUrl: `postgres://bg_edge:bg-edge-bench-pw@127.0.0.1:${PORT}/postgres?sslmode=require`,
    groqKey: GROQ_TEST_KEY,
    geminiKey: GEMINI_TEST_KEY,
    groqModel: GROQ_MODEL,
    geminiModel: GEMINI_MODEL,
    log: (m) => log(`  [edge] ${m}`),
  });
  log(`  gateway REST   ${gatewayUrl} (PostgREST-conforme + /auth/v1/user)`);
  log(`  faux IA locaux  ${aiUrl} (Groq + Gemini)`);
  log(`  edge business-grow  http://127.0.0.1:${edgePort} (code réel)`);
  return {
    gateway, mockAi, pool, edge,
    baseUrl: gatewayUrl,
    aiBase: aiUrl,
    edgeUrl: `http://127.0.0.1:${edgePort}`,
    close: async () => {
      await edge.close();
      await mockAi.close();
      await gateway.close();
      await pool.end();
    },
  };
}
