// Suite 05 — Frontières critiques : idempotence des crédits, journal immuable,
// réservations orphelines, règlements de paiement SASPAY.
//
// Cible : les défauts de double-consommation, de falsification du grand livre
// financier et de confirmation de paiement non vérifiée. Chaque scénario est
// joué en conditions réelles (PG 17, migrations du dépôt, rôles réels).
import pg from 'pg';
import crypto from 'node:crypto';
import { makeHarness } from './harness.mjs';
import { PORT, BG_EDGE_PASSWORD, BG_BILLING_PASSWORD } from './pg.mjs';

const DIRECT = (user, password) => new pg.Client({ host: '127.0.0.1', port: PORT, user, password, database: 'postgres', ssl: { rejectUnauthorized: false } });

export async function run(ctx) {
  const h = makeHarness({ baseUrl: ctx.services.baseUrl, title: '05 — Crédits & règlements (frontières critiques)' });
  const { seedData } = ctx;
  const dave = seedData.users.dave;

  // État de banc connu pour les scénarios de crédit (dave est le compte
  // “sans quota” des autres suites ; ici il reçoit un solde de test).
  await ctx.adminQuery('update saas_business.wallets set available_units = 10, reserved_units = 0 where user_id = $1', [dave.id]);

  // ─── A. Idempotence des opérations de crédit (rôle serveur bg_edge) ────────
  const edge = DIRECT('bg_edge', BG_EDGE_PASSWORD);
  await edge.connect();
  // Lecture du portefeuille par le chemin légitime (bg_quota_status, EXECUTE
  // bg_edge) — bg_edge n'a AUCUN accès direct aux tables.
  const wallet = async () => (await edge.query('select saas_business.bg_quota_status($1::uuid) as q', [dave.id])).rows[0].q;

  // Demandes IA réelles (la FK du journal exige une demande existante).
  const daveConv = (await ctx.adminQuery('insert into saas_business.conversations(user_id) values ($1) returning id', [dave.id]))[0].id;
  const newRequest = async (status = 'queued') => (
    await ctx.adminQuery(
      'insert into saas_business.ai_requests(user_id, conversation_id, idempotency_key, request_hash, status, updated_at) values ($1, $2, $3, $4, $5, now()) returning id',
      [dave.id, daveConv, crypto.randomUUID().slice(0, 24), 'bench', status])
  )[0].id;

  const req1 = await newRequest();
  const w0 = await wallet();
  let r1 = (await edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 2, $3) as q', [dave.id, req1, 'bg:test'])).rows[0].q;
  h.check(r1.already_processed === false,
    'crédit : la réservation d’une demande est appliquée (2 unités, premier appel)',
    `available=${r1.available_units}`);
  const w1 = await wallet();
  h.check(w1.available_units === w0.available_units - 2 && w1.reserved_units === w0.reserved_units + 2,
    'crédit : le solde reflète UNE SEULE déduction', `before=${w0.available_units} after=${w1.available_units}`);
  let r2 = (await edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 2, $3) as q', [dave.id, req1, 'bg:test'])).rows[0].q;
  const w2 = await wallet();
  h.check(r2.already_processed === true && w2.available_units === w1.available_units,
    'crédit : le REJEU de la réservation est sans effet (idempotent, pas de double débit)',
    `already=${r2.already_processed} available=${w2.available_units} (invarié)`);

  let c1 = (await edge.query('select saas_business.bg_capture_units($1::uuid, $2::uuid, 2, 2) as q', [dave.id, req1])).rows[0].q;
  h.check(c1.already_processed === false && c1.charged_units === 2,
    'crédit : la capture (consommation réelle) est appliquée', `charged=${c1.charged_units}`);
  const w3 = await wallet();
  let c2 = (await edge.query('select saas_business.bg_capture_units($1::uuid, $2::uuid, 2, 2) as q', [dave.id, req1])).rows[0].q;
  const w4 = await wallet();
  h.check(c2.already_processed === true && w4.available_units === w3.available_units && w4.period_used === w3.period_used,
    'crédit : le REJEU de la capture n’accorde PAS un second remboursement et ne double PAS le comptage de période',
    `already=${c2.already_processed} available=${w4.available_units} period_used=${w4.period_used} (invariants)`);

  const req2 = await newRequest();
  await edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 1, $3) as q', [dave.id, req2, 'bg:test']);
  const rel1 = (await edge.query('select saas_business.bg_release_units($1::uuid, $2::uuid, 1, $3) as q', [dave.id, req2, 'bg:echec'])).rows[0].q;
  const w5 = await wallet();
  const rel2 = (await edge.query('select saas_business.bg_release_units($1::uuid, $2::uuid, 1, $3) as q', [dave.id, req2, 'bg:echec'])).rows[0].q;
  const w6 = await wallet();
  h.check(rel1.already_processed === false && rel2.already_processed === true && w6.available_units === w5.available_units,
    'crédit : le REJEU de la libération (remboursement d’échec) est sans effet (pas de double crédit)',
    `already=${rel2.already_processed} available=${w6.available_units} (invarié)`);

  // Concurrence : deux réservations SIMULTANÉES de la même demande.
  const req3 = await newRequest();
  const wA = await wallet();
  const e2 = DIRECT('bg_edge', BG_EDGE_PASSWORD);
  await e2.connect();
  const [ra, rb] = await Promise.all([
    edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 2, $3) as q', [dave.id, req3, 'bg:conc']).then((x) => x.rows[0].q),
    e2.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 2, $3) as q', [dave.id, req3, 'bg:conc']).then((x) => x.rows[0].q),
  ]);
  const wB = await wallet();
  const applied = [ra, rb].filter((x) => x.already_processed === false).length;
  h.check(applied === 1 && wB.available_units === wA.available_units - 2,
    'crédit : deux réservations CONCURRENTES de la même demande — exactement une est appliquée (verrou de ligne + journal idempotent)',
    `appliquées=${applied} available=${wA.available_units} → ${wB.available_units}`);
  await e2.end();

  // ─── B. Journal financier immuable (append-only) ───────────────────────────
  const admin = DIRECT('postgres', 'pw');
  await admin.connect();
  let tamper = null;
  try {
    await admin.query('update saas_business.credit_ledger set delta = 0 where request_id = $1', [req1]);
  } catch (e) { tamper = e; }
  h.check(tamper?.message?.includes('append-only') === true,
    'grand livre : la MODIFICATION d’une ligne du journal Business Grow est REFUSÉE même par le rôle administrateur (append-only)',
    `erreur=${tamper?.message || 'aucune'}`);
  let del = null;
  try {
    await admin.query('delete from saas_business.credit_ledger where request_id = $1', [req1]);
  } catch (e) { del = e; }
  h.check(del?.message?.includes('append-only') === true,
    'grand livre : la SUPPRESSION d’une ligne du journal est REFUSÉE (traçabilité financière intacte)',
    `erreur=${del?.message || 'aucune'}`);

  // Anonymisation de compte : la suppression de l'utilisateur anonymise le
  // journal (user_id → NULL) au lieu de l'effacer, sans bloquer la suppression.
  const tempUser = (await admin.query("insert into auth.users(email, raw_user_meta_data, email_confirmed_at) values ($1, $2::jsonb, now()) returning id", [`erasure-${crypto.randomUUID().slice(0, 8)}@bench.test`, '{}'])).rows[0];
  const tempConv = (await admin.query('insert into saas_business.conversations(user_id) values ($1) returning id', [tempUser.id])).rows[0];
  const tempReq = (await admin.query("insert into saas_business.ai_requests(user_id, conversation_id, idempotency_key, request_hash) values ($1, $2, $3, 'h') returning id", [tempUser.id, tempConv.id, crypto.randomUUID().slice(0, 20)])).rows[0];
  await edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 1, $3) as q', [tempUser.id, tempReq.id, 'bg:temp']);
  const ledgerRow = (await admin.query('select id, user_id from saas_business.credit_ledger where request_id = $1', [tempReq.id])).rows[0];
  let deleteError = null;
  try { await admin.query('delete from auth.users where id = $1', [tempUser.id]); } catch (e) { deleteError = e; }
  // Après suppression : la ligne du journal reste (user_id et request_id → NULL
  // par SET NULL), seule la référence au compte disparaît.
  const ledgerAfter = (await admin.query('select user_id, request_id, delta, reason from saas_business.credit_ledger where id = $1', [ledgerRow.id])).rows[0];
  h.check(deleteError === null && ledgerRow.user_id === tempUser.id && ledgerAfter !== undefined && ledgerAfter.user_id === null && ledgerAfter.request_id === null,
    'effacement de compte : la suppression de l’utilisateur RÉUSSIT et ANONYMISE le journal (ligne conservée, références → NULL) — ni blocage ni effacement de l’historique financier',
    `suppression=${deleteError ? deleteError.message : 'ok'} ligne=${ledgerAfter ? 'conservée' : 'MANQUANTE'} user_id=${ledgerAfter?.user_id}`);

  // ─── C. Libération des réservations orphelines (crash de l'Edge Function) ──
  // (client admin toujours connecté — pg ne permet pas de reconnecter un Client)
  // Un état historique (demande “running” abandonnée il y a 2 h) : on contourne
  // temporairement le trigger de horodatage uniquement pour FABRIQUER le jeu de
  // test — c'est l'état qu'une vraie demande abandonnée porte en production.
  const staleConv = (await admin.query('insert into saas_business.conversations(user_id) values ($1) returning id', [dave.id])).rows[0];
  await admin.query('alter table saas_business.ai_requests disable trigger requests_touch');
  const staleReq = (await admin.query("insert into saas_business.ai_requests(user_id, conversation_id, idempotency_key, request_hash, status, created_at, updated_at) values ($1, $2, $3, 'h', 'queued', now() - interval '2 hours', now() - interval '2 hours') returning id", [dave.id, staleConv.id, crypto.randomUUID().slice(0, 20)])).rows[0];
  await admin.query("update saas_business.ai_requests set status = 'running', started_at = now() - interval '2 hours' where id = $1", [staleReq.id]);
  await admin.query('alter table saas_business.ai_requests enable trigger requests_touch');
  await edge.query('select saas_business.bg_reserve_units($1::uuid, $2::uuid, 2, $3) as q', [dave.id, staleReq.id, 'bg:stale']);
  const wPre = await wallet();

  const worker = DIRECT('bg_billing_worker', BG_BILLING_PASSWORD);
  await worker.connect();
  const run1 = (await worker.query('select saas_business.bg_release_stale_reservations($1::interval) as q', ['15 minutes'])).rows[0].q;
  const wPost = await wallet();
  h.check(run1.released_requests >= 1 && wPost.available_units === wPre.available_units + 2 && wPost.reserved_units === wPre.reserved_units - 2,
    'orphelines : une réservation bloquée depuis 2 h (demande “running” abandonnée) est LIBÉRÉE par la maintenance',
    `released=${run1.released_requests} available ${wPre.available_units} → ${wPost.available_units}`);
  const run2 = (await worker.query('select saas_business.bg_release_stale_reservations($1::interval) as q', ['15 minutes'])).rows[0].q;
  const wPost2 = await wallet();
  h.check(run2.released_requests === 0 && wPost2.available_units === wPost.available_units,
    'orphelines : la maintenance est IDEMPOTENTE — un second passage ne libère rien (pas de création de crédits au fil du cron)',
    `released=${run2.released_requests} available=${wPost2.available_units} (invarié)`);
  const guard = (await worker.query('select has_function_privilege($1, (select oid from pg_proc where proname=$2 and pronamespace=(select oid from pg_namespace where nspname=$3)), $4) as ok', ['bg_edge', 'bg_release_stale_reservations', 'saas_business', 'EXECUTE'])).rows[0];
  h.check(guard.ok === false,
    'orphelines : la libération est réservée au rôle worker (bg_edge — l’Edge Function — ne peut pas se libérer elle-même)',
    `bg_edge=${guard.ok}`);
  await worker.end();
  await admin.end();

  // ─── D. Règlements de paiement (SASPAY) — service_role uniquement ──────────
  const rpc = (fn, args) => h.rpc(ctx.tokens.service, fn, args);

  // Ordre de paiement créé côté serveur (état “pending”) — l’Edge Function le
  // crée ainsi en production après le devis ; ici on reproduit l’état réel.
  const makeOrder = async (amount, tag) => {
    const rows = await ctx.adminQuery(`
      insert into saas_business.payment_orders(
        user_id, plan_key, plan_label, amount_minor, currency, country_code, period_days,
        monthly_credit_units, internal_reference, idempotency_key, payment_flow, status
      ) values ($1, 'test-400', 'Formule de banc', $2, 'XOF', 'ML', 30, 400,
        $3, $4, 'checkout', 'pending')
      returning id, amount_minor, currency`, [dave.id, amount, `bench-ord-${tag}`, `bench-idem-${tag}`]);
    return rows[0];
  };
  const settle = (order, status, amount, paymentId) => rpc('vyora_payment_bg_settle', {
    p_order_id: order.id,
    p_payment_id: paymentId,
    p_provider_status: status,
    p_requested_amount: amount,
    p_currency: 'XOF',
    p_fee: null, p_charged: null, p_net: null,
    p_fee_mode: null, p_reference: `bench-ref-${paymentId}`,
    p_source: 'verify', p_failure_code: null,
  });

  // d : un paiement réussi mais avec un MONTANT différent → rien n’est livré.
  const orderBad = await makeOrder(5000, 'bad');
  let s = await settle(orderBad, 'SUCCESS', 4999, 'PAY-BAD-1');
  h.check(s.status === 200 && s.json?.outcome === 'amount_mismatch' && s.json?.credited === false,
    'paiement : une confirmation dont le MONTANT ne correspond pas à la commande est REFUSÉE (rien n’est livré, aucune souscription)',
    `outcome=${s.json?.outcome}`);

  // b : le règlement légitime → souscription + quota, exactement UNE fois.
  const orderOk = await makeOrder(5000, 'ok');
  s = await settle(orderOk, 'SUCCESS', 5000, 'PAY-OK-1');
  const subOk = (await ctx.adminQuery("select count(*)::int as n from saas_business.subscriptions where user_id = $1 and status in ('active','trialing')", [dave.id]))[0];
  h.check(s.status === 200 && s.json?.outcome === 'paid' && s.json?.credited === true && subOk.n === 1,
    'paiement : le règlement VÉRIFIÉ (montant + devise conformes) livre la souscription et le quota (400 unités)',
    `outcome=${s.json?.outcome} sub=${subOk.n} allowance=${s.json?.monthly_credit_units ?? 'n/a'}`);
  s = await settle(orderOk, 'SUCCESS', 5000, 'PAY-OK-1');
  const subAfter = (await ctx.adminQuery("select count(*)::int as n from saas_business.subscriptions where user_id = $1 and status in ('active','trialing')", [dave.id]))[0];
  h.check(s.status === 200 && s.json?.outcome === 'already_paid' && s.json?.credited === false && subAfter.n === 1,
    'paiement : le REJEU du même règlement (webhook dupliqué) est SANS EFFET — already_paid, aucune seconde livraison',
    `outcome=${s.json?.outcome} sub=${subAfter.n}`);

  // c : un paiement ÉCHOUÉ ne livre rien.
  const orderFail = await makeOrder(5000, 'fail');
  s = await settle(orderFail, 'FAILED', 5000, 'PAY-FAIL-1');
  const orderFailState = (await ctx.adminQuery('select status from saas_business.payment_orders where id = $1', [orderFail.id]))[0];
  h.check(s.status === 200 && s.json?.outcome === 'failed' && s.json?.credited === false && orderFailState.status === 'failed',
    'paiement : une confirmation FAILED ne livre rien (commande marquée failed, aucun crédit)',
    `outcome=${s.json?.outcome} status=${orderFailState.status}`);

  // e : les RPC de règlement exigent service_role — un utilisateur ne peut PAS
  //    régler un paiement lui-même (pas d'EXECUTE).
  const asUser = await h.rpc(ctx.tokens.dave, 'vyora_payment_bg_settle', {
    p_order_id: orderFail.id, p_payment_id: 'PAY-HACK', p_provider_status: 'SUCCESS',
    p_requested_amount: 5000, p_currency: 'XOF', p_fee: null, p_charged: null, p_net: null,
    p_fee_mode: null, p_reference: 'x', p_source: 'verify', p_failure_code: null,
  });
  const orderFailState2 = (await ctx.adminQuery('select status from saas_business.payment_orders where id = $1', [orderFail.id]))[0];
  h.check(asUser.status >= 400 && orderFailState2.status === 'failed',
    'paiement : un utilisateur ne peut PAS appeler le règlement (EXECUTE réservé à service_role + contrôle service_role interne) — aucune confirmation auto-déclarée, commande inchangée',
    `status=${asUser.status} commande=${orderFailState2.status}`);

  // f : l’enregistrement des événements webhook est idempotent.
  const rec1 = await rpc('vyora_payment_record_webhook', { p_product: 'business', p_event_key: 'evt-bench-0001', p_event_type: 'payment.success', p_payload: {} });
  const rec2 = await rpc('vyora_payment_record_webhook', { p_product: 'business', p_event_key: 'evt-bench-0001', p_event_type: 'payment.success', p_payload: {} });
  h.check(rec1.status === 200 && rec1.json?.first === true && rec2.status === 200 && rec2.json?.first === false,
    'paiement : un événement webhook dupliqué n’est traité qu’une fois (enregistré, first=false au rejeu)',
    `first1=${rec1.json?.first} first2=${rec2.json?.first}`);

  await edge.end();
  return h.finish();
}
