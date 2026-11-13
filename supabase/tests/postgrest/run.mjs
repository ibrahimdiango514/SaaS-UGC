// Banc PostgREST — orchestrateur : environnement + suites + résultats.
//
//   npm test          : base neuve → migrations → seed → toutes les suites.
//   VYORA_KEEP=1      : laisse PostgreSQL démarré après la fin (inspection).
//
// Les résultats (JSON + Markdown) sont écrits dans results/.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setupEnv, startServices } from './env.mjs';
import { userToken, serviceToken } from './jwt.mjs';
import { withClient } from './pg.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RESULTS = path.join(HERE, 'results');

const suites = [
  ['./test-01-jwt.mjs', 'Vrai parcours JWT (signature, expiration, audience, rôle, claims, auth.uid(), RLS)'],
  ['./test-02-isolation.mjs', 'Isolation multi-entreprise A/B + identifiants falsifiés + orphelins + RPC/EXECUTE'],
  ['./test-03-revocation.mjs', 'Révocation : expiré vs révoqué vs valide ; anti-falsification par les rôles serveur'],
  ['./test-04-edge.mjs', 'Intégration Edge : business-grow réel contre gateway + PostgreSQL + IA locales'],
  ['./audit-functions.mjs', 'Audit des fonctions : matrice EXECUTE × rôles + invariants de partition'],
];

const log = (m) => console.log(m);
let env = null;
let services = null;
const results = [];

try {
  log('═══ Banc PostgREST VYORA — démarrage de l’environnement ═══');
  env = await setupEnv({ fresh: true, log });
  services = await startServices({ secret: env.secret, log });
  const { seedData } = env;

  const ctx = {
    services,
    seedData,
    secret: env.secret,
    // Accès direct (rôle superuser postgres) pour les mutations d'état du
    // test (suppression utilisateur, transfert d'entreprise, etc.) — c'est
    // l'équivalent local de l'API d'administration Supabase, pas un chemin
    // client.
    adminQuery: async (sql, params = []) => withClient('postgres', (db) => db.query(sql, params)).then((r) => r.rows),
    tokens: {
      alice: userToken(env.secret, { sub: seedData.users.alice.id, email: seedData.users.alice.email, company: 'A' }),
      bob: userToken(env.secret, { sub: seedData.users.bob.id, email: seedData.users.bob.email, company: 'B' }),
      carol: userToken(env.secret, { sub: seedData.users.carol.id, email: seedData.users.carol.email, company: 'A' }),
      dave: userToken(env.secret, { sub: seedData.users.dave.id, email: seedData.users.dave.email }),
      boss: userToken(env.secret, { sub: seedData.users.boss.id, email: seedData.users.boss.email }),
      service: serviceToken(env.secret),
    },
  };

  for (const [file, description] of suites) {
    log(`\n╔══ ${description}`);
    const mod = await import(pathToFileURL(path.resolve(HERE, file)));
    try {
      const res = await mod.run(ctx);
      results.push(res);
      log(`╚══ ${res.title} : ${res.passed}/${res.total} vérifications réussies`);
    } catch (e) {
      results.push({ title: description, passed: 0, failed: 1, total: 1, checks: [{ ok: false, label: e.message, detail: e.stack?.split('\n')[1] }] });
      log(`╚══ ${description} : ÉCHEC — ${e.message}`);
      break;
    }
  }
} finally {
  if (process.env.VYORA_KEEP) {
    log('\nVYORA_KEEP=1 : PostgreSQL laissé démarré (port 54330, données dans /tmp/vyora-postgrest) pour inspection.');
    if (services) await services.close();
  } else {
    log('\nArrêt propre de l’environnement…');
    if (services) await services.close();
    if (env) await env.pgServer.stop();
  }
}

// ─── Résultats persistés ────────────────────────────────────────────────────
mkdirSync(RESULTS, { recursive: true });
const failed = results.filter((r) => r.failed > 0);
const summary = {
  generated_at: new Date().toISOString(),
  postgres: 'embedded-postgres 17.5.0-beta.15 (binaire réel, local, jetable)',
  gateway: 'PostgREST v12.2.3-conformant (contrat JWT→rôle→RLS vérifié sur le source du binaire)',
  suites: results,
  total_passed: results.reduce((a, r) => a + r.passed, 0),
  total: results.reduce((a, r) => a + r.total, 0),
  ok: failed.length === 0,
};
writeFileSync(path.join(RESULTS, 'results.json'), JSON.stringify(summary, null, 2));
const md = [
  '# Résultats du banc PostgREST',
  '',
  `_Généré le ${summary.generated_at}_`,
  '',
  summary.ok ? '**RÉSULTAT GÉNÉRAL : ✅ toutes les suites passent.**' : '**RÉSULTAT GÉNÉRAL : ❌ des vérifications échouent.**',
  '',
  '| Suite | Réussies | Total |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.title} | ${r.passed} | ${r.total} |`),
  '',
  ...results.flatMap((r) => [
    `## ${r.title}`,
    '',
    ...r.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? ` — \`${c.detail}\`` : ''}`),
    '',
  ]),
].join('\n');
writeFileSync(path.join(RESULTS, 'results.md'), md);
log(`\nRésultats écrits dans ${RESULTS}/ (results.json, results.md)`);
process.exit(failed.length ? 1 : 0);
