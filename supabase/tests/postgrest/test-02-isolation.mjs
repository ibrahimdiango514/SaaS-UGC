// Parcours 4 — ISOLATION MULTI-ENTREPRISE A/B (appels REST directs) :
//   A lit A, B lit B ; croisements refusés en LECTURE et en ÉCRITURE ;
//   identifiants d'entreprise falsifiés refusés ; utilisateur sans
//   entreprise bloqué ; données personnelles privées ; orphelines
//   inaccessibles ; RPC / EXECUTE isolés.
import { makeHarness } from './harness.mjs';
import { userToken } from './jwt.mjs';

export async function run(ctx) {
  const { services, seedData, tokens } = ctx;
  const h = makeHarness({ baseUrl: services.baseUrl, title: '02 — Isolation multi-entreprise A/B' });
  const { users, workspaces, avatars, projects, notifications, subscriptions, usage } = seedData;

  const T_ALICE = tokens.alice;   // A, propriétaire A, claim company=A
  const T_BOB = tokens.bob;       // B, propriétaire B, claim company=B
  const T_CAROL = tokens.carol;   // A, éditrice A
  const T_DAVE = tokens.dave;     // sans entreprise
  const T_BOSS = tokens.boss;     // administrateur plateforme
  const T_SERVICE = tokens.service;

  // Token forgé : identité réelle alice, mais claim company falsifié « B ».
  const T_ALICE_FAUX = userToken(ctx.secret, { sub: users.alice.id, email: users.alice.email, company: 'B' });

  console.log('\n── 02 — Isolation multi-entreprise A/B (REST direct)');

  // --- 1. Lecture : A lit A, B lit B ----------------------------------------
  let r = await h.get(T_ALICE, '/rest/v1/reelora_avatars?select=name&order=name');
  const aliceAvatars = (r.json ?? []).map((a) => a.name).sort();
  h.check(r.status === 200 && aliceAvatars.length === 2 && !aliceAvatars.some((n) => n.includes('Bob')),
    'A lit A : alice voit les 2 avatars de A, jamais ceux de B', JSON.stringify(aliceAvatars));

  r = await h.get(T_BOB, '/rest/v1/reelora_avatars?select=name&order=name');
  const bobAvatars = (r.json ?? []).map((a) => a.name).sort();
  h.check(r.status === 200 && bobAvatars.length === 2 && bobAvatars.every((n) => n.includes('Bob')),
    'B lit B : bob voit les 2 avatars de B, jamais ceux de A', JSON.stringify(bobAvatars));

  // --- 2. Croisements refusés en lecture (par id ET par workspace) ----------
  r = await h.get(T_ALICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b1.id}&select=name`);
  h.check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
    'lecture croisée refusée : alice ne lit pas l’avatar B (id exact de B)', `status=${r.status} n=${r.json?.length}`);

  r = await h.get(T_ALICE, `/rest/v1/reelora_avatars?workspace_id=eq.${workspaces.B}&select=name`);
  h.check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
    'lecture croisée refusée : alice ne lit rien avec workspace_id=B', `n=${r.json?.length}`);

  r = await h.get(T_BOB, `/rest/v1/reelora_avatars?workspace_id=eq.${workspaces.A}&select=name`);
  h.check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
    'lecture croisée refusée (symétrique) : bob ne lit rien avec workspace_id=A', `n=${r.json?.length}`);

  r = await h.get(T_ALICE, `/rest/v1/reelora_prompt_templates?workspace_id=eq.${workspaces.B}&select=title`);
  h.check(r.status === 200 && Array.isArray(r.json) && r.json.length === 0,
    'prompts : alice ne lit pas le prompt de B', `n=${r.json?.length}`);

  // --- 3. Croisements refusés en écriture ------------------------------------
  // Un INSERT qui viole le RLS « with check » lève 42501 (new row violates
  // row-level security policy) → PostgREST renvoie 403 (requête authentifiée).
  r = await h.post(T_ALICE, '/rest/v1/reelora_avatars', { workspace_id: workspaces.B, created_by: users.alice.id, name: 'INTRUSION_CROISEE' }, { prefer: 'return=representation' });
  h.check(r.status === 403 && /row-level security/i.test(r.json?.message ?? ''),
    'écriture croisée refusée : alice INSERT avatar dans B → 403 (violation RLS with check)', `status=${r.status} msg=${r.json?.message}`);

  r = await h.get(T_SERVICE, `/rest/v1/reelora_avatars?name=eq.INTRUSION_CROISEE&select=id`);
  h.check(r.status === 200 && r.json.length === 0,
    'l’avatar intrus n’existe pas en base (vérifié par service_role)', `n=${r.json?.length}`);

  // PATCH croisé : PostgREST applique le filtre RLS → 0 ligne touchée (sans
  // erreur) : la donnée de B doit rester intacte.
  const avantPatch = await h.get(T_SERVICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b1.id}&select=name`);
  r = await h.patch(T_ALICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b1.id}`, { name: 'PIQUÉ PAR ALICE' }, { prefer: 'return=representation' });
  const apresPatch = await h.get(T_SERVICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b1.id}&select=name`);
  h.check(r.status === 200 && (r.json ?? []).length === 0 && apresPatch.json?.[0]?.name === avantPatch.json?.[0]?.name,
    'PATCH croisé inopérant : 0 ligne touchée, la donnée de B est intacte', `touché=${r.json?.length} nom=${apresPatch.json?.[0]?.name}`);

  // DELETE croisé : idem — la donnée de B doit survivre.
  r = await h.del(T_ALICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b2.id}`);
  const apresDel = await h.get(T_SERVICE, `/rest/v1/reelora_avatars?id=eq.${avatars.b2.id}&select=name`);
  h.check((r.status === 200 || r.status === 204) && apresDel.json?.length === 1,
    'DELETE croisé inopérant : l’avatar de B survit au DELETE d’alice', `status=${r.status} survit=${apresDel.json?.length === 1}`);

  // Écriture légitime : bob (membre de B) peut écrire dans B.
  r = await h.post(T_BOB, '/rest/v1/reelora_avatars', { workspace_id: workspaces.B, created_by: users.bob.id, name: 'Avatar Bob 3' }, { prefer: 'return=representation' });
  h.check(r.status === 201 && r.json?.[0]?.name === 'Avatar Bob 3',
    'écriture légitime : bob INSERT avatar dans B → 201', `status=${r.status}`);

  // Éditrice A (carol) : écrit dans A, pas dans B.
  r = await h.post(T_CAROL, '/rest/v1/reelora_avatars', { workspace_id: workspaces.A, created_by: users.carol.id, name: 'Avatar Carol (A) 2' }, { prefer: 'return=representation' });
  h.check(r.status === 201 && r.json?.[0]?.name === 'Avatar Carol (A) 2', 'carol (éditrice A) écrit dans A → 201 (ligne insérée)', `status=${r.status} n=${r.json?.length}`);
  r = await h.post(T_CAROL, '/rest/v1/reelora_avatars', { workspace_id: workspaces.B, created_by: users.carol.id, name: 'INTRUSION_CAROL_B' }, { prefer: 'return=representation' });
  h.check(r.status === 403 && /row-level security/i.test(r.json?.message ?? ''),
    'carol (éditrice A) ne peut PAS écrire dans B → 403 (violation RLS with check)', `status=${r.status}`);

  // --- 4. Identifiants d'entreprise falsifiés --------------------------------
  r = await h.get(T_ALICE_FAUX, '/rest/v1/bench_claims_probe?select=company,label');
  h.check(r.status === 200 && r.json?.length === 1 && r.json[0].company === 'B',
    'claim falsifié « company:B » transmis dans les politiques (la sonde le reflète)', JSON.stringify(r.json));
  r = await h.get(T_ALICE_FAUX, '/rest/v1/reelora_avatars?select=name&order=name');
  const fauxAvatars = (r.json ?? []).map((a) => a.name).sort();
  h.check(r.status === 200 && !fauxAvatars.some((n) => n.includes('Bob')),
    'mais le claim falsifié n’ouvre RIEN : alice ne voit toujours que A (l’identité = sub vérifié, pas un claim)', JSON.stringify(fauxAvatars));

  // --- 5. Utilisateur sans entreprise (dave) ---------------------------------
  r = await h.get(T_DAVE, '/rest/v1/reelora_avatars?select=id');
  h.check(r.status === 200 && r.json.length === 0, 'dave (sans entreprise) : zéro avatar (données métier bloquées)', `n=${r.json.length}`);
  r = await h.get(T_DAVE, '/rest/v1/reelora_prompt_templates?is_system=eq.false&select=id');
  h.check(r.status === 200 && r.json.length === 0, 'dave : aucun prompt privé d’entreprise', `n=${r.json.length}`);
  r = await h.get(T_DAVE, '/rest/v1/reelora_subscriptions?select=user_id,plan_key');
  h.check(r.status === 200 && r.json.length === 0, 'dave : aucune donnée d’abonnement lue', `n=${r.json.length}`);
  r = await h.post(T_DAVE, '/rest/v1/reelora_avatars', { workspace_id: workspaces.A, created_by: users.dave.id, name: 'Dave intrus' });
  h.check(r.status === 403, 'dave : INSERT dans A refusé (non membre) → 403', `status=${r.status}`);

  // --- 6. Données personnelles privées ----------------------------------------
  r = await h.get(T_BOB, `/rest/v1/reelora_notifications?id=eq.${notifications.alice.id}&select=title`);
  h.check(r.status === 200 && r.json.length === 0, 'personnel : bob ne lit pas la notification d’alice (id exact)', `n=${r.json.length}`);
  r = await h.get(T_BOB, `/rest/v1/reelora_subscriptions?user_id=eq.${subscriptions.alice.user_id}&select=plan_key`);
  h.check(r.status === 200 && r.json.length === 0, 'personnel : bob ne lit pas l’abonnement d’alice', `n=${r.json.length}`);
  r = await h.get(T_BOB, `/rest/v1/reelora_usage_events?id=eq.${usage.alice.id}&select=quantity`);
  h.check(r.status === 200 && r.json.length === 0, 'personnel : bob ne lit pas les événements d’usage d’alice', `n=${r.json.length}`);
  r = await h.patch(T_BOB, `/rest/v1/reelora_notifications?id=eq.${notifications.alice.id}`, { body: 'modifiée par bob' }, { prefer: 'return=representation' });
  const notifAlice = await h.get(T_ALICE, `/rest/v1/reelora_notifications?id=eq.${notifications.alice.id}&select=body`);
  h.check((r.json ?? []).length === 0 && notifAlice.json?.[0]?.body === 'Notification de test',
    'personnel : PATCH croisé sur la notification d’alice inopérant, texte intact', `touché=${r.json?.length}`);

  // --- 7. Données orphelines inaccessibles ------------------------------------
  r = await h.get(T_ALICE, `/rest/v1/reelora_avatars?id=eq.${avatars.orphan.id}&select=name`);
  h.check(r.status === 200 && r.json.length === 0, 'orpheline : alice ne voit pas l’avatar orphelin (workspace sans membre)', `n=${r.json.length}`);
  r = await h.get(T_DAVE, `/rest/v1/reelora_avatars?workspace_id=eq.${workspaces.orphan}&select=name`);
  h.check(r.status === 200 && r.json.length === 0, 'orpheline : dave ne voit rien dans le workspace orphelin', `n=${r.json.length}`);
  r = await h.get(T_SERVICE, `/rest/v1/reelora_avatars?id=eq.${avatars.orphan.id}&select=name`);
  h.check(r.status === 200 && r.json.length === 1,
    'orpheline : seule la clé service_role (BYPASSRLS, jamais exposée au client) la lit — limite documentée', `n=${r.json.length}`);

  // --- 8. RPC / EXECUTE isolés -------------------------------------------------
  // Les fonctions RPC SECURITY DEFINER re-vérifient l'appartenance au workspace
  // de l'utilisateur courant (auth.uid() = sub du JWT vérifié) — pas d'accès
  // croisé possible par EXECUTE.
  const scenes = [{ spoken_text: 'scène légitime', visual_prompt: 'plan produit' }];

  // ÉLÉGIME : bob écrit des scènes SUR SON projet B.
  r = await h.rpc(T_BOB, 'reelora_save_scenes', { p_project_id: projects.B.id, p_scenes: scenes });
  h.check(r.status === 200 && r.json === 1, 'EXECUTE légitime : bob écrit 1 scène sur son projet B', `status=${r.status} n=${r.json}`);

  // CROISÉ : alice tente d'écrire des scènes SUR LE PROJET DE BOB.
  r = await h.rpc(T_ALICE, 'reelora_save_scenes', { p_project_id: projects.B.id, p_scenes: [{ spoken_text: 'hacking' }] });
  h.check(r.status === 400 && /forbidden/i.test(r.json?.message ?? ''),
    'EXECUTE croisée refusée : alice n’écrit PAS de scènes sur le projet B (forbidden)', `status=${r.status} msg=${r.json?.message}`);

  // CONTRÔLE POSITIF : alice écrit sur SON projet A (elle est membre de A).
  r = await h.rpc(T_ALICE, 'reelora_save_scenes', { p_project_id: projects.A.id, p_scenes: scenes });
  h.check(r.status === 200 && r.json === 1, 'EXECUTE légitime : alice écrit bien sur son projet A (contrôle positif)', `status=${r.status} n=${r.json}`);

  // La génération vidéo exige un quote de pricing (flux production) ; sans quote
  // l'appel est refusé AVANT même le check d'appartenance — la protection existe
  // en plusieurs couches (quote → can_edit_workspace → credits).
  r = await h.rpc(T_ALICE, 'reelora_start_generation', { p_project_id: projects.B.id, p_service_key: 'script' });
  h.check(r.status === 400 && /video_quote_required|forbidden/i.test(r.json?.message ?? ''),
    'génération vidéo : protégée (quote de pricing requis, puis appartenance workspace)', `status=${r.status} msg=${r.json?.message}`);

  // Quota : chaque fonction ne lit que le quota de l'utilisateur courant
  // (aucune ne prend l'id d'un autre user). bob lit le sien, intact.
  r = await h.rpc(T_BOB, 'reelora_quota_status', {});
  h.check(r.status === 200 && r.json?.credits === 100,
    'quota : bob lit SEUL son propre quota (100 crédits, intacts)',
    `credits=${r.json?.credits}`);

  // --- 9. Permissions distinctes (administratif) -------------------------------
  r = await h.get(T_BOSS, '/rest/v1/reelora_subscriptions?select=plan_key,user_id&order=plan_key');
  h.check(r.status === 200 && r.json.length >= 2,
    'administratif : le boss (rôle admin) lit les abonnements de TOUT le monde', `n=${r.json?.length}`);
  r = await h.get(T_ALICE, '/rest/v1/reelora_subscriptions?select=plan_key,user_id');
  h.check(r.status === 200 && r.json.length === 1,
    'administratif : alice ne lit que le sien (1 ligne) — droits distincts', `n=${r.json?.length}`);

  return h.finish();
}
