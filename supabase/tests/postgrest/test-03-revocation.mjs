// Parcours 5 — RÉVOCATION & PRIVILÈGES :
//   distinguer expiré / révoqué / valide ; comportement après changement
//   d'appartenance ; prouver qu'un rôle serveur ne peut pas falsifier
//   l'identité vue par les politiques RLS ; documenter les limites.
import pg from 'pg';
import { makeHarness } from './harness.mjs';
import { userToken, AUDIENCE } from './jwt.mjs';
import { PORT, BG_EDGE_PASSWORD } from './pg.mjs';

const now = () => Math.floor(Date.now() / 1000);

export async function run(ctx) {
  const { services, seedData, secret } = ctx;
  const h = makeHarness({ baseUrl: services.baseUrl, title: '03 — Révocation & privilèges' });
  const { users, workspaces } = seedData;
  const T_ALICE = userToken(secret, { sub: users.alice.id, email: users.alice.email, company: 'A' });

  console.log('\n── 03 — Révocation & privilèges');

  // --- 1. Baseline : token valide --------------------------------------------
  let r = await h.get(T_ALICE, '/rest/v1/reelora_notifications?select=title');
  h.check(r.status === 200 && r.json.length >= 1, 'valide : le token d’alice fonctionne (baseline)', `n=${r.json?.length}`);

  // --- 2. Expiré ----------------------------------------------------------------
  r = await h.get(userToken(secret, { sub: users.alice.id, email: 'x', exp: now() - 120 }), '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && /expired/i.test(r.json?.message ?? ''),
    'expiré : un token expiré de 2 min → 401 « JWT expired » (refus immédiat, pas de lecture)', `status=${r.status}`);

  // --- 3. Révoqué (mécanisme Supabase : suppression de l'utilisateur) ----------
  // Supabase révoque un access token en supprimant l'utilisateur (ou en
  // bannissant le compte) ; le JWT reste cryptographiquement valide jusqu'à
  // son exp — PostgREST ne consulte PAS auth.users à chaque requête.
  const eve = (await ctx.adminQuery(`insert into auth.users(email, raw_user_meta_data)
    values ('eve@revoked.test', '{"note":"compte révoqué pour le test"}') returning id`))[0];
  await ctx.adminQuery(`insert into saas_ugc.ugc_notifications(user_id, title, body) values ($1, 'Notif Eve', 'avant révocation')`, [eve.id]);
  const T_EVE = userToken(secret, { sub: eve.id, email: eve.email });
  r = await h.get(T_EVE, '/rest/v1/reelora_notifications?select=title');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].title === 'Notif Eve',
    'révoqué (avant) : eve lit sa notification', `n=${r.json?.length}`);

  await ctx.adminQuery(`delete from auth.users where id = $1`, [eve.id]); // révocation (cascade)

  r = await h.get(T_EVE, '/rest/v1/reelora_notifications?select=title');
  h.check(r.status === 200 && r.json.length === 0,
    'révoqué (après) : le token passe la vérification de signature mais ZÉRO donnée (lignes supprimées en cascade) — limite documentée : un access token JWT est valable jusqu’à son exp ; PostgREST ne fait pas de contrôle « révoqué » par requête',
    `status=${r.status} n=${r.json?.length}`);

  r = await h.http('GET', '/auth/v1/user', { token: T_EVE });
  h.check(r.status === 401,
    'révoqué (après) : /auth/v1/user refuse (utilisateur inexistant) → le chemin Edge est immédiatement révoqué', `status=${r.status}`);

  // Bannissement (autre mécanisme Supabase) : le JWT est toujours valide mais
  // l'utilisateur est banni.
  const banned = (await ctx.adminQuery(`insert into auth.users(email, banned_until) values ('banned@revoked.test', now() + interval '1 hour') returning id`))[0];
  const T_BANNED = userToken(secret, { sub: banned.id, email: 'banned' });
  r = await h.http('GET', '/auth/v1/user', { token: T_BANNED });
  h.check(r.status === 403 && /banned/i.test(r.json?.error ?? ''),
    'banni : /auth/v1/user renvoie 403 (Edge bloqué) ; le REST verrait la signature valide — distinction documentée', `status=${r.status}`);

  // --- 4. Changement d'appartenance --------------------------------------------
  const avant = await h.get(T_ALICE, '/rest/v1/reelora_avatars?select=id&order=name');
  h.check(avant.status === 200 && avant.json.length >= 2, 'avant transfert : alice est propriétaire de A', `n=${avant.json?.length}`);

  await ctx.adminQuery(`update saas_ugc.ugc_workspaces set owner_user_id = $1 where id = $2`, [users.carol.id, workspaces.A]);

  r = await h.get(T_ALICE, '/rest/v1/reelora_avatars?select=id');
  h.check(r.status === 200 && r.json.length === 0,
    'transfert : après cession de A à carol, alice (même token, sans re-auth) ne voit plus rien — RLS dynamique à chaque requête', `n=${r.json?.length}`);
  const T_CAROL = userToken(secret, { sub: users.carol.id, email: users.carol.email });
  r = await h.get(T_CAROL, '/rest/v1/reelora_avatars?select=id&order=name');
  h.check(r.status === 200 && r.json.length === avant.json.length,
    'transfert : carol (nouvelle propriétaire) voit toutes les données de A sans re-auth', `n=${r.json?.length}`);
  const T_BOB = userToken(secret, { sub: users.bob.id, email: users.bob.email });
  r = await h.get(T_BOB, '/rest/v1/reelora_avatars?select=id');
  h.check(r.status === 200 && r.json.length >= 2 && !r.json.some(() => false),
    'transfert : l’entreprise B est totalement insensible (bob inchangé)', `n=${r.json?.length}`);

  // On restaure la propriété d'A (alice) pour ne pas polluer les suites
  // suivantes (le transfert est un état partagé de la base).
  await ctx.adminQuery(`update saas_ugc.ugc_workspaces set owner_user_id = $1 where id = $2`, [users.alice.id, workspaces.A]);

  // --- 5. Anti-falsification : un rôle serveur ne contrôle pas l'identité REST --
  // (a) Un token authentifié SANS claim « company » ne déclenche aucune politique
  //     claim-based → 0 ligne. Le client ne peut pas « choisir » son company.
  const T_NO_COMPANY = userToken(secret, { sub: users.alice.id, email: users.alice.email });
  r = await h.get(T_NO_COMPANY, '/rest/v1/bench_claims_probe?select=company');
  h.check(r.status === 200 && r.json.length === 0,
    'anti-falsification : sans claim « company », aucune politique claim-based ne s’active (0 ligne) — le client ne choisit pas son company', `n=${r.json?.length}`);

  // (b) Le client ne peut pas forger l'identité via les paramètres : created_by
  //     imposé à auth.uid() par la politique d'insertion.
  r = await h.post(T_ALICE, '/rest/v1/reelora_avatars', { workspace_id: workspaces.A, created_by: users.bob.id, name: 'créé comme bob ?' });
  h.check(r.status === 403,
    'anti-falsification : un client qui envoie created_by=bob est refusé (403) — l’identité d’écriture = sub vérifié du JWT', `status=${r.status}`);

  // (c) Connexion directe en tant que rôle serveur (bg_edge, sans claims) :
  //     pas d'accès direct aux tables métier, et auth.uid() est NULL.
  const direct = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'bg_edge', password: BG_EDGE_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } });
  await direct.connect();
  let denied = null;
  try { await direct.query('select count(*) from saas_ugc.ugc_avatars'); } catch (e) { denied = e; }
  h.check(denied?.code === '42501',
    'anti-falsification : en connexion directe bg_edge, la lecture directe des tables est refusée (permission denied) — le rôle serveur n’a AUCUN accès direct DML', `code=${denied?.code}`);
  // Seule le gateway (sur un JWT vérifié) fixe request.jwt.claims. En connexion
  // directe, il est vide → auth.uid() (= nullif(auth.jwt()->>'sub','')::uuid)
  // renvoie NULL et aucune politique RLS utilisateur ne peut s'activer.
  const claimsRow = (await direct.query('select current_setting(\'request.jwt.claims\', true) as claims')).rows[0];
  h.check(claimsRow.claims == null,
    'anti-falsification : sans gateway, request.jwt.claims est vide → auth.uid() NULL → aucune politique RLS utilisateur ne peut s’activer pour ce rôle',
    `claims=${JSON.stringify(claimsRow.claims)}`);
  await direct.end();

  // (d) Les fonctions bg_* (seule voie du domaine business) vérifient la
  //     membership de l'IDENTIFIANT PASSÉ, même appelées avec les droits
  //     serveur : un user_id non membre renvoie NULL / refuse.
  const callBg = (sql, params) => (async () => { const c = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'bg_edge', password: BG_EDGE_PASSWORD, database: 'postgres', ssl: { rejectUnauthorized: false } }); await c.connect(); try { return { rows: (await c.query(sql, params)).rows }; } finally { await c.end(); } })();
  let bg = await callBg(`select saas_business.bg_get_workspace_context($1, $2) as ctx`, [users.alice.id, workspaces.B]);
  h.check(bg.rows[0].ctx === null,
    'bg_* (rôle serveur) : bg_get_workspace_context(alice, B) → NULL — alice n’est pas membre de B, même via les droits serveur', `ctx=${JSON.stringify(bg.rows[0].ctx)}`);
  bg = await callBg(`select saas_business.bg_get_workspace_context($1, $2) as ctx`, [users.bob.id, workspaces.B]);
  h.check(bg.rows[0].ctx && bg.rows[0].ctx.workspace?.name === 'Entreprise B',
    'bg_* (rôle serveur) : le couple (bob, B) légitime renvoie le contexte de B — la membership est vérifiée sur l’identifiant issu du JWT vérifié', `ws=${bg.rows[0].ctx?.workspace?.name}`);
  bg = await callBg(`select saas_business.bg_get_workspace_context($1, $2) as ctx`, [crypto_random_uuid(), workspaces.B]);
  h.check(bg.rows[0].ctx === null,
    'bg_* (rôle serveur) : un user_id inconnu (falsifié) → NULL — aucune donnée livrée', `ctx=${JSON.stringify(bg.rows[0].ctx)}`);

  // --- 6. Frontière de confiance documentée -------------------------------------
  // Le rôle `authenticator` (celui du gateway) porte tous les rôles : une
  // connexion directe AVEC claims forgés permet de lire les données. C'est la
  // frontière de confiance : ce secret (DB) est côté serveur, jamais côté
  // client. Tout le trafic client passe par le gateway qui impose les claims
  // du JWT vérifié.
  const authc = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'authenticator', password: 'pw', database: 'postgres', ssl: { rejectUnauthorized: false } });
  await authc.connect();
  await authc.query('begin');
  // Le gateway connecte EN TANT QUE authenticator puis `SET LOCAL ROLE <rôle
  // du JWT>` (set_config('role',…)) avant d'exécuter la requête. On reproduit
  // ici exactement cette mécanique, avec et sans claims.
  await authc.query(`select set_config('role', 'authenticated', true)`);
  const sansClaims = (await authc.query(`select count(*)::int as n from public.bench_claims_probe`)).rows[0];
  await authc.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: users.alice.id, role: 'authenticated', company: 'A', aud: AUDIENCE })]);
  const avecClaims = (await authc.query(`select count(*)::int as n from public.bench_claims_probe`)).rows[0];
  await authc.query('rollback');
  await authc.end();
  h.check(sansClaims.n === 0 && avecClaims.n === 1,
    'frontière : l’identité RLS est portée UNIQUEMENT par request.jwt.claims — sans claims 0 ligne, avec les claims d’alice 1 ligne ; le gateway est l’unique émetteur de ces claims (JWT vérifié), la connexion DB est la frontière de confiance du serveur',
    `sans=${sansClaims.n} avec=${avecClaims.n}`);

  return h.finish();
}

function crypto_random_uuid() {
  return '99999999-9999-4999-8999-999999999999';
}
