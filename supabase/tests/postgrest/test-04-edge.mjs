// Parcours 6 — INTÉGRATION EDGE : la VRAI Edge Function business-grow
// (supabase/functions/business-grow/index.ts, code réel compilé pour Node)
// tourne contre le gateway local + PostgreSQL local + fournisseurs IA
// locaux. On vérifie : authentification via /auth/v1/user, création de
// conversation, envoi de messages (quota + routage + IA), historique,
// mémoire, diagnostics, rapports/quotas, confirmations d'actions, et
// permissions distinctes.
import crypto from 'node:crypto';
import { makeHarness } from './harness.mjs';
import { userToken } from './jwt.mjs';

export async function run(ctx) {
  const { services, seedData, secret, tokens } = ctx;
  const h = makeHarness({ baseUrl: services.baseUrl, title: '04 — Intégration Edge (business-grow réel)' });
  const { users, workspaces } = seedData;
  const T_ALICE = tokens.alice;
  const T_BOB = tokens.bob;
  const T_DAVE = tokens.dave; // sans wallet BG → quota 0

  const edge = async (action, body = {}, token = T_ALICE) => {
    const r = await fetch(services.edgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: 'bench-anon', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body }),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* pas de JSON */ }
    return { status: r.status, json, text };
  };

  console.log('\n── 04 — Intégration Edge (business-grow réel, IA locales)');

  // --- 0. Authentification Edge via /auth/v1/user (JWT réel) ----------------
  let r = await edge('roles.list', {}, T_ALICE);
  h.check(r.status === 200 && Array.isArray(r.json?.data?.roles),
    'auth Edge : token validé via GET /auth/v1/user (gateway) → rôles listés', `status=${r.status} n=${r.json?.data?.roles?.length}`);

  r = await edge('roles.list', {}, userToken(secret, { sub: '99999999-9999-4999-8999-999999999999', email: 'ghost' }));
  h.check(r.status === 401 && /UNAUTHENTICATED/i.test(r.json?.error?.code ?? ''),
    'auth Edge : token dont le sub n’existe pas → 401 UNAUTHENTICATED (pas de session fantôme)', `status=${r.status}`);

  r = await edge('roles.list', {}, userToken(secret, { sub: users.alice.id, email: 'x', exp: Math.floor(Date.now() / 1000) - 3600 }));
  h.check(r.status === 401, 'auth Edge : token expiré → 401', `status=${r.status}`);

  // --- 1. Vérification fournisseurs (diagnostics IA) --------------------------
  r = await edge('providers.verify', { providerKey: 'groq', modelKey: 'llama-3.3-70b-versatile' });
  h.check(r.status === 200 && r.json?.data?.status === 'healthy' && r.json?.data?.availableModels?.length >= 2,
    'diagnostics : providers.verify(groq) → healthy + modèles listés (adaptateur réel → mock local)',
    `status=${r.status} models=${r.json?.data?.availableModels?.join(',')}`);

  r = await edge('providers.verify', { providerKey: 'gemini', modelKey: 'gemini-2.5-flash' });
  h.check(r.status === 200 && r.json?.data?.status === 'healthy',
    'diagnostics : providers.verify(gemini) → healthy (x-goog-api-key réel → mock local)', `status=${r.status}`);

  // --- 2. Création de conversation (A) + contexte entreprise ------------------
  r = await edge('conversations.create', { title: 'Stratégie Q4', workspaceId: workspaces.A });
  h.check(r.status === 200 && typeof r.json?.data?.conversationId === 'string',
    'conversation créée dans l’entreprise A', `id=${String(r.json?.data?.conversationId).slice(0, 13)}…`);
  const convA = r.json.data.conversationId;

  // Bob (B) ne voit PAS la conversation d'alice.
  r = await edge('conversations.list', {}, T_BOB);
  h.check(r.status === 200 && !r.json?.data?.conversations?.some((c) => c.id === convA),
    'isolation Edge : bob ne liste pas la conversation d’alice (bg_list_conversations filtre sur user_id)', `n=${r.json?.data?.conversations?.length}`);

  // --- 3. Envoi de message : quota + routage + IA + historique ----------------
  r = await edge('messages.send', {
    conversationId: convA,
    content: 'Diagnostique mon épicerie fine de Bamako : positionnement, prix, canaux de vente.',
    idempotencyKey: crypto.randomUUID(),
    roleKey: 'business_advisor',
    workspaceId: workspaces.A,
  });
  h.check(r.status === 200 && r.json?.data?.status === 'succeeded' && r.json?.data?.provider?.key === 'groq',
    'messages.send : routé groq (healthy), statut succeeded, réponse IA locale reçue',
    `status=${r.status} provider=${r.json?.data?.provider?.key}/${r.json?.data?.provider?.model}`);
  h.check(r.json?.data?.assistantReply?.includes('[mock-groq'),
    'l’appel IA a TRAVERSÉ le vrai code de l’Edge Function (réponse du fournisseur local marquée [mock-groq])',
    `réponse=${String(r.json?.data?.assistantReply).slice(0, 80)}…`);

  r = await edge('messages.list', { conversationId: convA });
  const msgs = r.json?.data?.messages ?? [];
  h.check(r.status === 200 && msgs.length === 2 && msgs[0].author_role === 'user' && msgs[1].author_role === 'assistant',
    'historique : 2 messages (user + assistant) persistés dans PostgreSQL', `n=${msgs.length}`);
  h.check(msgs[1].request_provider_key === 'groq',
    'historique : le message assistant porte la trace du fournisseur utilisé (routage auditable)', `provider=${msgs[1].request_provider_key}`);

  // Idempotence : même clé → pas de double comptage.
  const idemKey = crypto.randomUUID();
  const s1 = await edge('messages.send', { conversationId: convA, content: 'Message d’idempotence.', idempotencyKey: idemKey, roleKey: 'business_advisor' });
  const s2 = await edge('messages.send', { conversationId: convA, content: 'Message d’idempotence.', idempotencyKey: idemKey, roleKey: 'business_advisor' });
  h.check(s1.status === 200 && s1.json?.data?.created === true && s2.json?.data?.created === false,
    'idempotence : 2e envoi avec la même clé → created=false (pas de double facturation/quota)',
    `1er=${s1.json?.data?.created} 2e=${s2.json?.data?.created}`);

  // --- 4. Quota : réservation, 402, séparabilité Studio ----------------------
  r = await edge('quota.status', {});
  const quotaA = r.json?.data;
  h.check(r.status === 200 && quotaA?.available_units == 398 && quotaA?.domain === 'business_grow',
    'quota : 2 messages réussis (399 - 1 = 398, l’idempotent n’est pas compté), domaine business_grow',
    `dispo=${quotaA?.available_units} consommé=${quotaA?.lifetime_consumed}`);
  h.check(quotaA?.studio_ugc_untouched === true,
    'quota : le portefeuille Studio UGC est SÉPARÉ de Business Grow (studio_ugc_untouched=true)', `flag=${quotaA?.studio_ugc_untouched}`);

  // dave : sans wallet BG → 402 BG_INSUFFICIENT_QUOTA.
  const cD = await edge('conversations.create', { title: 'Dave test' }, T_DAVE);
  const convD = cD.json?.data?.conversationId;
  r = await edge('messages.send', { conversationId: convD, content: 'Bonjour, suis sans quota.', idempotencyKey: crypto.randomUUID(), roleKey: 'business_advisor' }, T_DAVE);
  h.check(r.status === 402 && r.json?.error?.code === 'BG_INSUFFICIENT_QUOTA',
    'quota : dave (sans wallet BG) → 402 BG_INSUFFICIENT_QUOTA (le message n’est pas traité par l’IA)', `status=${r.status} code=${r.json?.error?.code}`);

  // business_analysis réserve 2 unités.
  const before = (await edge('quota.status', {})).json?.data?.available_units;
  r = await edge('messages.send', { conversationId: convA, content: 'Analyse approfondie du positionnement.', idempotencyKey: crypto.randomUUID(), roleKey: 'business_analysis', workspaceId: workspaces.A });
  const after = (await edge('quota.status', {})).json?.data?.available_units;
  h.check(r.status === 200 && before - after === 2,
    'quota : le rôle business_analysis réserve 2 unités (avant=before après=after → Δ=2)', `avant=${before} après=${after}`);

  // --- 5. Mémoire (consentement, profil, items) --------------------------------
  r = await edge('memory.get', {});
  h.check(r.status === 200 && r.json?.data != null, 'mémoire : memory.get renvoie la structure mémoire (consent/profile/items)', `status=${r.status}`);

  r = await edge('memory.consent', { enabled: true, policyVersion: 'v1' });
  h.check(r.status === 200, 'mémoire : consentement activé (v1)', `status=${r.status}`);

  r = await edge('memory.profile.save', { profile: { segment: 'épicerie fine', ville: 'Bamako' } });
  h.check(r.status === 200, 'mémoire : profil enregistré', `status=${r.status}`);

  r = await edge('memory.item.put', { category: 'objectif', content: 'Double le CA en 12 mois' });
  const itemId = r.json?.data?.itemId;
  h.check(r.status === 200 && typeof itemId === 'string', 'mémoire : item ajouté (consentement requis d’abord)', `id=${String(itemId).slice(0, 13)}…`);

  r = await edge('memory.get', {});
  h.check(r.status === 200 && JSON.stringify(r.json?.data).includes('Double le CA en 12 mois'),
    'mémoire : l’item est relu dans memory.get', `contenu=${JSON.stringify(r.json?.data).slice(0, 100)}…`);

  r = await edge('memory.item.delete', { itemId });
  h.check(r.status === 200 && r.json?.data?.deleted === true, 'mémoire : item supprimé', `status=${r.status}`);

  // Isolation mémoire : bob ne lit pas la mémoire d'alice.
  const memA = (await edge('memory.get', {})).json?.data;
  const memB = (await edge('memory.get', {}, T_BOB)).json?.data;
  h.check(JSON.stringify(memA) !== JSON.stringify(memB),
    'isolation Edge : la mémoire est par utilisateur (A ≠ B)', `A=${JSON.stringify(memA).slice(0, 60)}… B=${JSON.stringify(memB).slice(0, 60)}…`);

  // --- 6. Rapports / recommandations / diagnostics (quotas, rôles, routing) ----
  r = await edge('roles.list', {});
  h.check(r.status === 200 && r.json?.data?.roles?.some((x) => x.role_key === 'business_advisor'),
    'rôles IA : liste des rôles disponibles (conseil, analyse, stratégie…)', `n=${r.json?.data?.roles?.length}`);

  r = await edge('routing.get', {});
  h.check(r.status === 200, 'routing : préférences de routage lues', `status=${r.status}`);
  r = await edge('routing.save', { roleKey: 'business_advisor', selectionMode: 'manual', preferredProviderKey: 'groq', allowFallback: true });
  h.check(r.status === 200 && r.json?.data?.saved === true, 'routing : préférence manuelle (groq) enregistrée', `status=${r.status}`);
  const qBefore = (await edge('quota.status', {})).json?.data?.available_units;
  r = await edge('messages.send', { conversationId: convA, content: 'Message avec routage manuel groq.', idempotencyKey: crypto.randomUUID(), roleKey: 'business_advisor' });
  const qAfter = (await edge('quota.status', {})).json?.data?.available_units;
  h.check(r.status === 200 && r.json?.data?.provider?.key === 'groq' && qBefore - qAfter === 1,
    'routing : le routage manuel groq est respecté et compte 1 unité', `provider=${r.json?.data?.provider?.key} Δ=${qBefore - qAfter}`);

  r = await edge('requests.list', {});
  h.check(r.status === 200 && (r.json?.data?.requests?.length ?? 0) >= 3,
    'historique des requêtes : les demandes IA sont journalisées (requests.list)', `n=${r.json?.data?.requests?.length}`);

  // --- 7. Fallback de fournisseur (groq coupé → gemini) -------------------------
  // On neutralise temporairement groq côté catalogue (rôle serveur, pas un
  // chemin client) pour prouver le fallback réel de l'Edge Function.
  await ctx.adminQuery(`
    update saas_business.ai_providers set enabled = false where provider_key = 'groq'`);
  r = await edge('messages.send', { conversationId: convA, content: 'Message pour tester le fallback.', idempotencyKey: crypto.randomUUID(), roleKey: 'business_advisor' });
  const usedGemini = r.json?.data?.provider?.key === 'gemini' && r.json?.data?.assistantReply?.includes('[mock-gemini');
  h.check(r.status === 200 && usedGemini,
    'repli : groq désactivé → l’Edge Function route sur gemini (réponse [mock-gemini], statut succeeded)',
    `provider=${r.json?.data?.provider?.key} status=${r.json?.data?.status}`);
  await ctx.adminQuery(`
    update saas_business.ai_providers set enabled = true where provider_key = 'groq'`);

  // --- 8. Confirmations d'actions (outils) -------------------------------------
  r = await edge('tools.list', { conversationId: convA });
  h.check(r.status === 200 && Array.isArray(r.json?.data?.tools), 'outils : liste des exécutions d’outils (confirmations d’actions)', `status=${r.status} n=${r.json?.data?.tools?.length}`);

  // --- 9. Séparation Studio UGC vs Business Grow (aucun crédit croisé) ---------
  // Business Grow consomme son propre wallet ; le portefeuille Studio (crédits
  // UGC) d'alice doit rester intact malgré les messages BG.
  const studio = await h.rpc(T_ALICE, 'reelora_quota_status', {});
  h.check(studio.status === 200 && studio.json?.credits === 100,
    'séparation : le portefeuille Studio UGC d’alice (100 crédits) n’a PAS été entamé par Business Grow',
    `studio_credits=${studio.json?.credits}`);

  // --- 10. VYORA AI CORE — surface registre (service_role uniquement) ----------
  // Le moteur central lit le registre multi-fournisseurs via une RPC public
  // réservée au service_role. Un jeton utilisateur ne doit ni lire le
  // registre, ni journaliser des appels, ni toucher les paramètres admin.
  r = await h.rpc(tokens.service, 'vyora_ai_registry_snapshot', {});
  h.check(r.status === 200 && r.json && Array.isArray(r.json.providers)
      && Array.isArray(r.json.models) && Array.isArray(r.json.rules)
      && r.json.budget && typeof r.json.monthly_spend_usd === 'number',
    'AI CORE : le snapshot du registre est lisible par service_role (providers/modèles/règles/budget)',
    `providers=${r.json?.providers?.length} models=${r.json?.models?.length} rules=${r.json?.rules?.length}`);

  r = await h.rpc(T_ALICE, 'vyora_ai_registry_snapshot', {});
  h.check(r.status >= 400,
    'AI CORE : un jeton utilisateur ne peut PAS lire le registre (EXECUTE réservé à service_role)',
    `status=${r.status}`);

  r = await h.rpc(T_ALICE, 'vyora_ai_log_call', {
    p_space: 'business', p_user_id: users.alice.id, p_workspace_id: null, p_task_key: 'hack',
    p_provider_key: 'groq', p_model_key: 'x', p_provider_model_key: 'x', p_attempt_number: 1,
    p_status: 'success', p_error_code: null, p_input_tokens: 1, p_output_tokens: 1,
    p_latency_ms: 1, p_cost_input_usd: null, p_cost_output_usd: null, p_fallback_from: null,
  });
  h.check(r.status >= 400,
    'AI CORE : un utilisateur ne peut PAS écrire au journal des appels IA (EXECUTE service_role/bg_edge)',
    `status=${r.status}`);

  r = await h.rpc(T_ALICE, 'vyora_ai_admin_settings_get', {});
  h.check(r.status >= 400,
    'AI CORE : les paramètres admin (budgets IA) sont refusés à un utilisateur non admin',
    `status=${r.status}`);

  r = await h.get(T_ALICE, '/rest/v1/ai_memories?select=*');
  h.check(r.status === 404 || r.status === 403,
    'AI CORE : la table mémoire saas_business n’est JAMAIS exposée au client (pas de schéma public, RLS deny-by-default)',
    `status=${r.status}`);

  return h.finish();
}
