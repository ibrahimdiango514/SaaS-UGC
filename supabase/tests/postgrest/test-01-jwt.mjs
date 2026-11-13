// Parcours 3 — VÉRIFICATION DU VRAI PARCOURS JWT (appels directs au REST,
// sans frontend) : signature, expiration, audience, sélection du rôle
// PostgreSQL, transmission des claims, auth.uid(), RLS effectif.
import { makeHarness } from './harness.mjs';
import { signJwt, userToken, serviceToken } from './jwt.mjs';

export async function run(ctx) {
  const { services, seedData, secret } = ctx;
  const h = makeHarness({ baseUrl: services.baseUrl, title: '01 — Parcours JWT (REST direct)' });
  const { users, workspaces } = seedData;
  const now = Math.floor(Date.now() / 1000);

  const tok = (u, extra = {}) => userToken(secret, { sub: u.id, email: u.email, company: extra.company ?? null, ...extra });
  const T_ALICE = tok(users.alice);
  const T_BOB = tok(users.bob);
  const T_SERVICE = serviceToken(secret);

  console.log('\n── 01 — Vrai parcours JWT (appels REST directs, sans frontend)');

  // --- 1. Validation de signature -------------------------------------------
  let r = await h.get(T_ALICE, '/rest/v1/reelora_notifications');
  h.check(r.status === 200, 'JWT signé avec la clé de test → accepté (200)', `status=${r.status}`);

  const tampered = T_ALICE.slice(0, -4) + 'aaaa'; // signature corrompue
  r = await h.get(tampered, '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && r.json?.code === 'PGRST301',
    'signature falsifiée → 401 PGRST301 (invalid JWT secret)', `status=${r.status} code=${r.json?.code}`);
  h.check(r.headers.get('www-authenticate')?.includes('invalid_token') === true,
    '401 porte l’en-tête WWW-Authenticate: Bearer error="invalid_token" (comportement PostgREST)');

  const wrongKey = signJwt({ sub: users.alice.id, role: 'authenticated', aud: 'authenticated' }, 'autre-cle-de-test');
  r = await h.get(wrongKey, '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && r.json?.code === 'PGRST301',
    'jeton signé avec une autre clé → 401 (la clé de test fait foi)', `status=${r.status}`);

  const algNone = signJwt({ sub: users.alice.id, role: 'authenticated' }, secret).split('.');
  algNone[0] = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  r = await h.get(algNone.join('.'), '/rest/v1/reelora_notifications');
  h.check(r.status === 401, 'algorithme « none »/autre → 401 (HS256 exigé)', `status=${r.status}`);

  // --- 2. Expiration ----------------------------------------------------------
  r = await h.get(userToken(secret, { sub: users.alice.id, email: 'x', exp: now - 3600 }), '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && /expired/i.test(r.json?.message ?? ''),
    'exp dans le passé (−1 h) → 401 « JWT expired »', `status=${r.status} msg=${r.json?.message}`);

  // Jeu de 30 s de PostgREST (allowedSkew) : exp légèrement dépassée → toléré.
  r = await h.get(userToken(secret, { sub: users.alice.id, email: 'x', exp: now - 10 }), '/rest/v1/reelora_notifications');
  h.check(r.status === 200,
    'exp dépassé de 10 s → accepté (jeu de 30 s de PostgREST, allowedSkew)', `status=${r.status}`);

  r = await h.get(userToken(secret, { sub: users.alice.id, email: 'x', exp: now - 400 }), '/rest/v1/reelora_notifications');
  h.check(r.status === 401, 'exp dépassé de 400 s → 401 (hors du jeu)', `status=${r.status}`);

  // --- 3. Audience -------------------------------------------------------------
  const badAud = signJwt({ sub: users.alice.id, role: 'authenticated', aud: 'autre-audience' }, secret);
  r = await h.get(badAud, '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && /audience/i.test(r.json?.message ?? ''),
    'audience incorrecte → 401 (JWT_AUD_INVALID)', `status=${r.status} msg=${r.json?.message}`);

  // --- 4. Sélection du rôle PostgreSQL -----------------------------------------
  r = await h.get(T_ALICE, '/rest/v1/reelora_plans?select=plan_key&order=sort_order');
  h.check(r.status === 200 && Array.isArray(r.json) && r.json.length >= 4,
    'rôle authenticated (claim role) → lit les formules actives', `status=${r.status} n=${r.json?.length}`);

  r = await h.get(null, '/rest/v1/reelora_plans?select=plan_key');
  h.check(r.status === 200 && Array.isArray(r.json),
    'absence de jeton → accès anonyme (rôle anon), sans erreur', `status=${r.status}`);

  r = await h.get(null, '/rest/v1/reelora_notifications');
  h.check(r.status === 401 && /permission denied/i.test(r.json?.message ?? ''),
    'anon : aucune lecture des notifications — le GRANT SELECT est réservé à `authenticated`, donc permission denied (42501) → 401 (comportement PostgREST : 42501 sans jeton valide = 401)',
    `status=${r.status} msg=${r.json?.message}`);

  // Le rôle service_role est sélectionné depuis le claim (bypass RLS côté PG).
  r = await h.get(T_SERVICE, '/rest/v1/reelora_notifications?select=user_id,title');
  h.check(r.status === 200 && r.json.length === 3,
    'claim role=service_role → rôle service_role (BYPASSRLS : 3 notifications visibles)', `status=${r.status} n=${r.json?.length}`);

  // Un rôle inconnu dans le claim est refusé par PostgreSQL (authenticator n'en
  // est pas membre) → mapping 28000 → 403.
  const badRole = signJwt({ sub: users.alice.id, role: 'postgres' }, secret);
  r = await h.get(badRole, '/rest/v1/reelora_plans');
  h.check(r.status === 403 || r.status === 401,
    'claim role=postgres (non membre de authenticator) → refusé par PostgreSQL (403/401)', `status=${r.status}`);

  // --- 5. Transmission des claims ----------------------------------------------
  const T_ALICE_C = tok(users.alice, { company: 'A' });
  const T_BOB_C = tok(users.bob, { company: 'B' });
  r = await h.get(T_ALICE_C, '/rest/v1/bench_claims_probe?select=company,label');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].company === 'A',
    'claim « company:A » transmis dans les politiques (RLS sur claim arbitraire)', JSON.stringify(r.json));

  r = await h.get(T_BOB_C, '/rest/v1/bench_claims_probe?select=company,label');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].company === 'B',
    'claim « company:B » → lignes B uniquement (pas de mélange A/B)', JSON.stringify(r.json));

  // --- 6. auth.uid() -------------------------------------------------------------
  r = await h.get(T_ALICE, '/rest/v1/reelora_notifications?select=title');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].title === 'Notif Alice',
    'auth.uid() = sub du jeton : Alice ne voit que « Notif Alice »', JSON.stringify(r.json));

  r = await h.get(T_BOB, '/rest/v1/reelora_notifications?select=title');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].title === 'Notif Bob',
    'auth.uid() = sub du jeton : Bob ne voit que « Notif Bob »', JSON.stringify(r.json));

  r = await h.get(T_ALICE, '/rest/v1/reelora_subscriptions?select=plan_key');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].plan_key === 'free',
    'subscriptions : user_id = auth.uid() (formule free d’Alice)', JSON.stringify(r.json));

  r = await h.get(T_BOB, '/rest/v1/reelora_subscriptions?select=plan_key');
  h.check(r.status === 200 && r.json.length === 1 && r.json[0].plan_key === 'studio',
    'subscriptions : Bob (formule studio) n’est pas confondu avec Alice', JSON.stringify(r.json));

  // --- 7. Application effective des politiques RLS -------------------------------
  // Même endpoint, mêmes colonnes : le résultat dépend UNIQUEMENT du rôle + sub.
  r = await h.get(T_ALICE, '/rest/v1/reelora_avatars?select=name&order=name');
  const aliceAvatars = (r.json ?? []).map((a) => a.name).sort();
  h.check(r.status === 200 && aliceAvatars.length === 2 && aliceAvatars.every((n) => !n.includes('Bob')),
    'RLS effective : Alice voit les 2 avatars de A, jamais ceux de B', JSON.stringify(aliceAvatars));

  r = await h.get(T_BOB, '/rest/v1/reelora_avatars?select=name&order=name');
  const bobAvatars = (r.json ?? []).map((a) => a.name).sort();
  h.check(r.status === 200 && bobAvatars.length === 2 && bobAvatars.every((n) => n.includes('Bob')),
    'RLS effective : Bob voit ses 2 avatars, jamais ceux de A', JSON.stringify(bobAvatars));

  // Un jeton valide mais dont le sub n'existe pas (utilisateur supprimé) :
  // auth.uid() renvoie un uuid sans ligne → zéro donnée, aucune erreur 5xx.
  r = await h.get(userToken(secret, { sub: '99999999-9999-4999-8999-999999999999', email: 'ghost' }), '/rest/v1/reelora_notifications');
  h.check(r.status === 200 && r.json.length === 0,
    'sub inconnu (compte supprimé) → 200 vide (pas de fuite, pas d’erreur)', `status=${r.status}`);

  return h.finish();
}
