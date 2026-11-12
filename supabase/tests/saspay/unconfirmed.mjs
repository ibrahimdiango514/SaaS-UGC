// Création softpay restée sans réponse : tentatives, blocage d'un second
// paiement, rapprochement manuel. PostgreSQL 17 réel, rejouable (suffixe `tag`).
import { client } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const svc = await connectAs('service_role');
const svc2 = await connectAs('service_role');
const tag = `u${Date.now().toString(36)}`;

await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);

let seq = 0;
const next = (p) => `${p}-${tag}-${String(++seq).padStart(4, '0')}`;
async function person(name) {
  return (await one(`insert into auth.users(email) values ($1) returning id`, [`${name}-${tag}@test.local`])).id;
}
async function customer(name) {
  const id = await person(name);
  await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [id]);
  await admin.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1)`, [id]);
  return id;
}
const boss = await person('chef');
await admin.query(`delete from saas_ugc.ugc_user_roles`);
await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin')`, [boss]);
const asBoss = await connectAs('authenticated', boss);

const studio = (user, key = next('key'), c = svc) => rpc(c, 'vyora_payment_create_studio_order', {
  p_user_id: user, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML',
  p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: key,
  p_quoted_fee: '100.00', p_quoted_total: '5100.00', p_quoted_fee_mode: 'ADD_ON', p_msisdn_masked: '+223••••••12' });
const business = (user, key = next('key'), c = svc) => rpc(c, 'vyora_payment_create_bg_order', {
  p_user_id: user, p_plan_key: 'croissance', p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: key,
  p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: '+223••••••12' });
const body = (order, phone = '+22370000012') => ({
  amount: order.amount, currency: 'XOF', country: 'ML', network: 'orange_ml',
  customer: { email: 'x@test.local', first_name: 'A', last_name: 'B', phone },
  description: `Pack — ${order.internal_reference}`, metadata: { order_reference: order.internal_reference },
});
const begin = (product, order, request = body(order), c = svc) => rpc(c, 'vyora_payment_begin_initiation', { p_product: product, p_order_id: order.id, p_request: request });
const unknown = (product, order, error = 'provider_unreachable') => rpc(svc, 'vyora_payment_initiation_unknown', { p_product: product, p_order_id: order.id, p_error: error });
const settle = (product, order, payment, amount, status = 'SUCCESS', failure = null) => rpc(svc, product === 'studio' ? 'vyora_payment_studio_settle' : 'vyora_payment_bg_settle', {
  p_order_id: order.id, p_payment_id: payment, p_provider_status: status, p_requested_amount: amount, p_currency: amount ? 'XOF' : null,
  p_fee: amount ? '0.00' : null, p_charged: amount, p_net: amount, p_fee_mode: amount ? 'ADD_ON' : null, p_reference: null, p_source: 'verify', p_failure_code: failure });
const init = (order) => one(`select * from saas_ugc.vyora_payment_initiations where order_id = $1`, [order.id]);
const row = (product, order) => one(`select * from ${product === 'studio' ? 'saas_ugc.ugc_recharge_orders' : 'saas_business.payment_orders'} where id = $1`, [order.id]);
const ageInit = (order, sets) => admin.query(`update saas_ugc.vyora_payment_initiations set ${sets} where order_id = $1`, [order.id]);
const anomaly = (order) => one(`select * from saas_ugc.vyora_payment_anomalies where kind = 'initiation_unconfirmed' and order_id = $1`, [order.id]);
const balance = async (user) => Number((await one(`select available_balance b from saas_ugc.ugc_wallets where user_id = $1`, [user])).b);
const house = () => rpc(svc, 'vyora_payment_housekeeping', {});
/** Les dates de création sont immuables : on lève la garde le temps de vieillir une commande de test. */
async function ageOrder(product, order, sets) {
  const [table, trigger] = product === 'studio'
    ? ['saas_ugc.ugc_recharge_orders', 'vyora_recharge_order_guard'] : ['saas_business.payment_orders', 'vyora_payment_order_guard'];
  await admin.query(`alter table ${table} disable trigger ${trigger}`);
  await admin.query(`update ${table} set ${sets} where id = $1`, [order.id]);
  await admin.query(`alter table ${table} enable trigger ${trigger}`);
}
// Repart de zéro : aucune tentative héritée d'un autre scénario ne doit fausser les listes.
await admin.query(`update saas_ugc.vyora_payment_initiations set resolved_at = now(), request = null, outcome = 'closed' where resolved_at is null`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('Tentative enregistrée avant l’appel');

const awa = await customer('awa');
const a1 = await studio(awa);
const t1 = await begin('studio', a1);
assert.equal(t1.allowed, true, JSON.stringify(t1)); assert.equal(t1.attempt, 1);
assert.deepEqual(t1.request, body(a1));
assert.ok(Date.parse(t1.replay_until) > Date.now() + 9 * 60_000 && Date.parse(t1.replay_until) < Date.now() + 11 * 60_000);
assert.equal((await row('studio', a1)).failure_code, 'initiation_unconfirmed');
assert.equal((await row('studio', a1)).status, 'pending');
let i1 = await init(a1);
assert.deepEqual([i1.outcome, i1.attempts, i1.amount, i1.payer_msisdn_masked, i1.internal_reference],
  ['started', 1, '5000.00', '+223••••••12', a1.internal_reference]);
ok('la tentative est consignée avant l’appel SasPay, avec le corps exact ; la commande devient « à confirmer »');

assert.deepEqual(await begin('studio', a1), { allowed: false, reason: 'attempt_in_progress' });
assert.equal((await init(a1)).attempts, 1);
ok('un second appel pendant que le premier est en vol est refusé (aucun double envoi)');

await unknown('studio', a1);
const t2 = await begin('studio', a1, body(a1, '+22399999999'));
assert.equal(t2.allowed, true); assert.equal(t2.attempt, 2);
assert.equal(t2.request.customer.phone, '+22370000012');
assert.deepEqual(t2.request, t1.request);
assert.equal(t2.replay_until, t1.replay_until);
ok('relance : le corps de la PREMIÈRE tentative est renvoyé à l’identique, même si le client a changé de numéro');

await fails(begin('studio', { id: a1.id }, null, await connectAs('authenticated', awa)), /permission denied|service_role/i, 'client');
await fails((await connectAs('anon')).query(`select public.vyora_payment_begin_initiation('studio', $1, '{}'::jsonb)`, [a1.id]), /permission denied/i, 'anon');
const asAwa = await connectAs('authenticated', awa);
await fails(asAwa.query(`select * from saas_ugc.vyora_payment_initiations`), /permission denied/i, 'table');
for (const [fn, args] of [
  ['vyora_payment_initiation_unknown', { p_product: 'studio', p_order_id: a1.id, p_error: 'x' }],
  ['vyora_payment_unconfirmed', { p_limit: 5, p_due_only: false }],
  ['vyora_payment_note_candidates', { p_product: 'studio', p_order_id: a1.id, p_candidates: [] }],
  ['vyora_payment_review_attached', { p_admin: boss, p_product: 'studio', p_order_id: a1.id, p_payment_id: 'x', p_note: 'note de test valable' }],
]) await fails(rpc(asAwa, fn, args), /permission denied/i, fn);
await fails(rpc(asAwa, 'vyora_admin_close_unconfirmed', { p_product: 'studio', p_order_id: a1.id, p_note: 'note de test valable' }), /admin|forbidden|not_allowed|permission/i, 'close');
ok('tentatives, numéro du payeur et décisions : inaccessibles au client et au public');

const checkout = await rpc(svc, 'vyora_payment_create_studio_order', {
  p_user_id: await customer('cho'), p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML',
  p_flow: 'checkout', p_network: null, p_idempotency_key: next('key'),
  p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null });
await fails(begin('studio', checkout), /initiation_requires_softpay/, 'checkout');
const bare = await studio(await customer('bar'));
await fails(begin('studio', bare, { amount: '5000.00' }), /initiation_request_required/, 'corps');
await fails(begin('studio', { id: '00000000-0000-4000-8000-000000000000' }), /payment_order_not_found/, 'inconnue');
ok('garde-fous : parcours softpay seulement, corps complet exigé, commande existante');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Aucun second paiement tant que l’issue est inconnue');

await unknown('studio', a1);
await fails(studio(awa), /payment_under_review/, 'studio');
await fails(business(awa), /payment_under_review/, 'business');
assert.equal(await count(`select count(*) n from saas_ugc.ugc_recharge_orders where user_id = $1`, [awa]), 1);
assert.equal(await count(`select count(*) n from saas_business.payment_orders where user_id = $1`, [awa]), 0);
ok('issue inconnue : toute nouvelle commande est refusée, Studio comme Business Grow');

const a1key = (await row('studio', a1)).idempotency_key;
const again = await studio(awa, a1key);
assert.equal(again.id, a1.id); assert.equal(again.reused, true);
ok('la même intention (même clé) retrouve la même commande : la reprise reste possible');

// Appel en vol (fonction interrompue en plein appel) : même blocage, sans attendre 60 s.
const dia = await customer('dia');
const d1 = await studio(dia);
await begin('studio', d1);
await fails(studio(dia), /payment_attempt_in_progress/, 'en vol');
await fails(business(dia), /payment_attempt_in_progress/, 'en vol bg');
await ageInit(d1, `last_attempt_at = now() - interval '61 seconds'`);
await fails(studio(dia), /payment_under_review/, 'jamais conclu');
ok('appel en vol, puis jamais conclu : aucune fenêtre pour un second paiement');

// Deux commandes créées AVANT toute tentative : une seule peut partir.
const eli = await customer('eli');
const [e1, e2] = [await studio(eli), await business(eli)];
const race = await Promise.all([begin('studio', e1, body(e1), svc), begin('business', e2, body(e2), svc2)]);
assert.equal(race.filter((r) => r.allowed).length, 1, JSON.stringify(race));
assert.equal(race.find((r) => !r.allowed).reason, 'other_payment_in_progress');
const eWin = race[0].allowed ? ['studio', e1, 'business', e2] : ['business', e2, 'studio', e1];
await unknown(eWin[0], eWin[1]);
assert.deepEqual(await begin(eWin[2], eWin[3]), { allowed: false, reason: 'other_payment_unconfirmed' });
assert.equal(await count(`select count(*) n from saas_ugc.vyora_payment_initiations where user_id = $1`, [eli]), 1);
ok('deux commandes ouvertes au même instant (Studio + Business Grow) : une seule demande part chez SasPay');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Jamais « non payée » sans preuve');

await ageOrder('studio', a1, `created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'`);
const idle = await studio(await customer('idl'));
await ageOrder('studio', idle, `created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'`);
let h = await house();
assert.equal((await row('studio', a1)).status, 'pending');
assert.equal((await row('studio', idle)).status, 'cancelled');
assert.equal((await row('studio', idle)).failure_code, 'expired_unpaid');
assert.equal((await init(a1)).review_at, null);
ok('entretien : une commande jamais présentée expire ; une commande à l’issue inconnue n’expire PAS');

// Fenêtre de rejeu dépassée → rapprochement manuel.
await ageInit(a1, `first_attempt_at = now() - interval '11 minutes', last_attempt_at = now() - interval '9 minutes'`);
h = await house();
assert.ok(h.opened_reviews >= 1);
i1 = await init(a1);
assert.ok(i1.review_at); assert.equal(i1.outcome, 'unknown'); assert.ok(i1.request, 'le corps reste disponible pour la recherche');
assert.equal((await row('studio', a1)).failure_code, 'manual_review');
assert.equal((await row('studio', a1)).status, 'pending');
let an = await anomaly(a1);
assert.equal(an.resolved_at, null);
assert.equal(an.details.reason, 'replay_window_elapsed');
assert.equal(an.details.payer_msisdn_masked, '+223••••••12');
assert.equal(JSON.stringify(an).includes('70000012'), false, 'le numéro complet ne figure pas dans l’alerte');
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = 'Paiement en cours de vérification'`, [awa]), 1);
ok('fenêtre de rejeu dépassée : rapprochement manuel, alerte administrateur, client prévenu (« ne payez pas une seconde fois »)');

assert.equal((await house()).opened_reviews, 0);
assert.equal(await count(`select count(*) n from saas_ugc.vyora_payment_anomalies where kind = 'initiation_unconfirmed' and order_id = $1`, [a1.id]), 1);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = 'Paiement en cours de vérification'`, [awa]), 1);
ok('entretien rejoué : une seule alerte, une seule notification');

assert.deepEqual(await begin('studio', a1), { allowed: false, reason: 'under_review' });
assert.equal((await init(a1)).attempts, 2);
await fails(studio(awa), /payment_under_review/, 'en revue');
ok('en rapprochement : plus aucun rejeu vers SasPay, et toujours aucun nouveau paiement');

// Relances épuisées (4 par défaut) → revue dès la tentative suivante, sans attendre l'entretien.
const fay = await customer('fay');
const f1 = await studio(fay);
for (let n = 1; n <= 4; n += 1) {
  const t = await begin('studio', f1);
  assert.deepEqual([t.allowed, t.attempt], [true, n]);
  await unknown('studio', f1, 'provider_unavailable');
}
assert.deepEqual(await begin('studio', f1), { allowed: false, reason: 'under_review' });
assert.equal((await anomaly(f1)).details.reason, 'attempts_exhausted');
assert.equal((await init(f1)).last_error, 'provider_unavailable');
ok('4 tentatives sans issue : la 5e est refusée et la commande part en rapprochement');

// Relance tardive : la fenêtre est fermée même si l'entretien n'est pas encore passé.
const gil = await customer('gil');
const g1 = await studio(gil);
await begin('studio', g1); await unknown('studio', g1);
await ageInit(g1, `first_attempt_at = now() - interval '10 minutes 5 seconds', last_attempt_at = now() - interval '10 minutes'`);
assert.deepEqual(await begin('studio', g1), { allowed: false, reason: 'under_review' });
assert.ok((await init(g1)).review_at);
ok('relance après la fenêtre : refusée sur-le-champ (un rejeu tardif pourrait pousser une seconde demande)');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Recherche et rapprochement');

let list = await rpc(svc, 'vyora_payment_unconfirmed', { p_limit: 25, p_due_only: true });
const mine = list.find((x) => x.order_id === a1.id);
assert.deepEqual([mine.product, mine.internal_reference, mine.phone, mine.amount, mine.currency, mine.in_review],
  ['studio', a1.internal_reference, '+22370000012', '5000.00', 'XOF', true]);
assert.ok(!list.some((x) => x.order_id === idle.id));
const candidates = [{ id: 'tx-cand-1', reference: 'TXN-1', status: 'SUCCESS', amount: '5000.00', currency: 'XOF', created_at: new Date().toISOString(), described: false }];
await rpc(svc, 'vyora_payment_note_candidates', { p_product: 'studio', p_order_id: a1.id, p_candidates: candidates });
list = await rpc(svc, 'vyora_payment_unconfirmed', { p_limit: 25, p_due_only: true });
assert.ok(!list.some((x) => x.order_id === a1.id), 'recherchée à l’instant : pas due');
assert.ok((await rpc(svc, 'vyora_payment_unconfirmed', { p_limit: 25, p_due_only: false })).some((x) => x.order_id === a1.id));
await ageInit(a1, `last_search_at = now() - interval '31 minutes'`);
assert.ok((await rpc(svc, 'vyora_payment_unconfirmed', { p_limit: 25, p_due_only: true })).some((x) => x.order_id === a1.id));
an = await anomaly(a1);
assert.deepEqual(an.details.candidates, candidates);
assert.equal((await init(a1)).search_count, 1);
ok('liste de recherche cadencée ; les transactions candidates sont consignées dans l’alerte — rien n’est livré');

const batch = await rpc(svc, 'vyora_payment_reconcile_batch', { p_limit: 20 });
assert.ok(batch.unconfirmed.some((x) => x.order_id === a1.id));
assert.ok(!batch.due.some((x) => x.order_id === a1.id));
const dispatched = await one(`select public.vyora_payments_reconcile_dispatch() r`);
assert.equal(dispatched.r.dispatched, true); assert.ok(dispatched.r.unconfirmed >= 1);
ok('la réconciliation planifiée part aussi pour une commande sans identifiant');

let health = await rpc(asBoss, 'vyora_admin_payment_health', {});
const seen = health.unconfirmed.find((x) => x.order_id === a1.id);
assert.deepEqual([seen.in_review, seen.attempts, seen.payer_msisdn_masked, seen.amount, seen.user_email],
  [true, 2, '+223••••••12', '5000.00', `awa-${tag}@test.local`]);
assert.deepEqual(seen.candidates, candidates);
assert.equal(JSON.stringify(health).includes('70000012'), false, 'numéro complet jamais exposé à l’interface');
assert.ok(health.anomalies.some((x) => x.kind === 'initiation_unconfirmed' && x.order_id === a1.id));
ok('vue d’exploitation : commande à rapprocher, numéro masqué, candidates');

await fails(rpc(asBoss, 'vyora_admin_resolve_anomaly', { p_anomaly_id: an.id, p_note: 'classée sans décision' }), /anomaly_requires_decision/, 'classer');
assert.equal((await anomaly(a1)).resolved_at, null);
ok('l’alerte ne peut pas être simplement classée : il faut trancher');

// Piste venue d'un webhook : ajoutée une seule fois, conservée quand une recherche ne la voit pas.
const hinted = { id: 'tx-hook-1', reference: 'TXN-2', status: 'SUCCESS', amount: '5000.00', currency: 'XOF', created_at: new Date().toISOString(), described: false, source: 'webhook', msisdn_match: true };
const addCandidate = (c, candidate) => rpc(c, 'vyora_payment_add_candidate', { p_product: 'studio', p_order_id: a1.id, p_candidate: candidate });
await addCandidate(svc, hinted); await addCandidate(svc, hinted);
assert.deepEqual((await init(a1)).candidates.map((c) => c.id), ['tx-cand-1', 'tx-hook-1']);
await rpc(svc, 'vyora_payment_note_candidates', { p_product: 'studio', p_order_id: a1.id, p_candidates: [] });
assert.deepEqual((await init(a1)).candidates.map((c) => c.id), ['tx-hook-1']);
await rpc(svc, 'vyora_payment_note_candidates', { p_product: 'studio', p_order_id: a1.id, p_candidates: [{ ...hinted, source: 'search' }, candidates[0]] });
assert.deepEqual((await init(a1)).candidates.map((c) => [c.id, c.source ?? null]), [['tx-hook-1', 'search'], ['tx-cand-1', null]]);
assert.deepEqual((await anomaly(a1)).details.candidates.map((c) => c.id), ['tx-hook-1', 'tx-cand-1']);
await fails(addCandidate(svc, { reference: 'sans identifiant' }), /candidate_required/, 'candidate');
await fails(addCandidate(asAwa, hinted), /permission denied/i, 'candidate client');
ok('transaction annoncée par un webhook : proposée une seule fois, conservée par les recherches suivantes');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Issue 1 — le paiement est retrouvé');

const before = await balance(awa);
const paid = await settle('studio', a1, next('pay'), '5000.00');
assert.deepEqual([paid.outcome, paid.credited, paid.status], ['paid', true, 'paid']);
assert.equal(await balance(awa), before + 27);
const r1 = await row('studio', a1);
assert.equal(r1.failure_code, null); assert.ok(r1.provider_payment_id);
i1 = await init(a1);
assert.deepEqual([i1.outcome, i1.request, i1.resolved_at !== null], ['attached', null, true]);
an = await anomaly(a1);
assert.ok(an.resolved_at); assert.match(an.resolution_note, /paiement SasPay identifié/);
const twice = await settle('studio', a1, r1.provider_payment_id, '5000.00');
assert.deepEqual([twice.outcome, twice.credited], ['already_paid', false]);
assert.equal(await balance(awa), before + 27);
ok('encaissement vérifié : crédité une seule fois, tentative soldée, numéro effacé, alerte levée');

await rpc(svc, 'vyora_payment_review_attached', { p_admin: boss, p_product: 'studio', p_order_id: a1.id, p_payment_id: r1.provider_payment_id, p_note: 'Retrouvé au tableau de bord SasPay' });
assert.equal((await init(a1)).resolved_by, boss);
assert.match((await anomaly(a1)).resolution_note, /rattaché par un administrateur/);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_review_payment_attached' and target_id = $1`, [a1.id]), 1);
await fails(rpc(svc, 'vyora_payment_review_attached', { p_admin: awa, p_product: 'studio', p_order_id: a1.id, p_payment_id: 'x', p_note: 'note de test valable' }), /admin_required/, 'non admin');
ok('rattachement décidé par un administrateur : tracé (qui, quel paiement, pourquoi)');

const a2 = await studio(awa);
assert.equal(a2.reused, false);
ok('une fois l’issue connue, le client peut de nouveau payer');

// Rattachement ordinaire (la relance a rendu l'identifiant) : tout redevient normal.
const t3 = await begin('studio', a2); assert.equal(t3.allowed, true);
await unknown('studio', a2);
await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: a2.id, p_payment_id: next('pay'), p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
const r2 = await row('studio', a2);
assert.deepEqual([r2.status, r2.failure_code], ['processing', null]);
assert.deepEqual([(await init(a2)).outcome, (await init(a2)).request], ['attached', null]);
assert.deepEqual(await begin('studio', a2), { allowed: false, reason: 'not_pending' });
ok('identifiant obtenu par la relance : commande « en cours » ordinaire, suivie par la vérification habituelle');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Issue 2 — refus certain');

const hui = await customer('hui');
const h1 = await studio(hui);
await begin('studio', h1);
const refusedOrder = await settle('studio', h1, null, null, 'FAILED', 'invalid_method');
assert.deepEqual([refusedOrder.status, refusedOrder.failure_code], ['failed', 'invalid_method']);
assert.deepEqual([(await init(h1)).outcome, (await init(h1)).request], ['refused', null]);
assert.equal((await studio(hui)).reused, false);
ok('refus certain de SasPay : commande close « échouée », tentative soldée, nouveau paiement permis');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Issue 3 — un administrateur atteste qu’il n’y a pas eu d’encaissement');

const close = (c, product, order, note) => rpc(c, 'vyora_admin_close_unconfirmed', { p_product: product, p_order_id: order.id, p_note: note });
// Pendant la fenêtre de rejeu : pas encore (le client peut encore obtenir l'identifiant).
const ivo = await customer('ivo');
const v1 = await studio(ivo);
await begin('studio', v1); await unknown('studio', v1);
await fails(close(asBoss, 'studio', v1, 'Rien au tableau de bord SasPay'), /payment_not_under_review/, 'fenêtre');
await fails(close(asBoss, 'studio', f1, 'court'), /review_note_required/, 'note');
await fails(close(svc, 'studio', f1, 'Rien au tableau de bord SasPay'), /admin|forbidden|permission/i, 'service');
const closed = await close(asBoss, 'studio', f1, 'Aucune transaction au tableau de bord SasPay le 13/11');
assert.equal(closed.outcome, 'closed_unpaid');
const rf = await row('studio', f1);
assert.deepEqual([rf.status, rf.failure_code], ['cancelled', 'unconfirmed_closed']);
const fi = await init(f1);
assert.deepEqual([fi.outcome, fi.request, fi.resolved_by, fi.resolution_note], ['closed', null, boss, 'Aucune transaction au tableau de bord SasPay le 13/11']);
const fa = await anomaly(f1);
assert.ok(fa.resolved_at); assert.equal(fa.resolved_by, boss); assert.match(fa.resolution_note, /^Aucun encaissement constaté chez SasPay\. Aucune transaction/);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_review_closed_unpaid' and target_id = $1 and actor_user_id = $2`, [f1.id, boss]), 1);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = 'Paiement non abouti'`, [fay]), 1);
assert.equal(await balance(fay), 0);
await fails(close(asBoss, 'studio', f1, 'Aucune transaction au tableau de bord SasPay'), /payment_not_under_review/, 'deux fois');
assert.equal((await studio(fay)).reused, false);
ok('clôture attestée : réservée à l’administrateur, motivée, tracée ; rien n’est livré, le client peut repayer');

// L'attestation était fausse : l'encaissement apparaît après coup → la commande est rouverte et livrée.
const late = await settle('studio', f1, next('pay'), '5000.00');
assert.deepEqual([late.outcome, late.credited], ['paid', true]);
assert.equal(await balance(fay), 27);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_order_reopened' and target_id = $1`, [f1.id]), 1);
ok('encaissement découvert après une clôture : la commande est rouverte et créditée (tracé)');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Business Grow');

const kim = await person('kim');
const k1 = await business(kim);
assert.equal((await begin('business', k1)).allowed, true);
await unknown('business', k1);
await fails(business(kim), /payment_under_review/, 'bg');
await ageOrder('business', k1, `created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'`);
await ageInit(k1, `first_attempt_at = now() - interval '11 minutes', last_attempt_at = now() - interval '9 minutes'`);
await house();
const rk = await row('business', k1);
assert.deepEqual([rk.status, rk.failure_code], ['pending', 'manual_review']);
assert.equal((await anomaly(k1)).product, 'business');
assert.equal(await count(`select count(*) n from saas_business.subscriptions where user_id = $1`, [kim]), 0);
const bgPaid = await settle('business', k1, next('pay'), '25000.00');
assert.deepEqual([bgPaid.outcome, bgPaid.credited], ['paid', true]);
assert.equal(await count(`select count(*) n from saas_business.subscriptions where user_id = $1 and status = 'active' and plan_key = 'croissance'`, [kim]), 1);
assert.ok((await anomaly(k1)).resolved_at);
assert.deepEqual([(await init(k1)).outcome, (await init(k1)).request], ['attached', null]);
ok('abonnement Business Grow : même règle — rien d’activé sans preuve, activé une fois le paiement vérifié');

const lea = await person('lea');
const l1 = await business(lea);
await begin('business', l1); await unknown('business', l1);
await ageInit(l1, `first_attempt_at = now() - interval '11 minutes', last_attempt_at = now() - interval '9 minutes'`);
await house();
await close(asBoss, 'business', l1, 'Aucune transaction au tableau de bord SasPay');
assert.deepEqual([(await row('business', l1)).status, (await row('business', l1)).failure_code], ['cancelled', 'unconfirmed_closed']);
assert.equal(await count(`select count(*) n from saas_business.subscriptions where user_id = $1`, [lea]), 0);
assert.equal((await business(lea)).reused, false);
ok('Business Grow : clôture attestée, aucun abonnement créé, nouveau paiement permis');

health = await rpc(asBoss, 'vyora_admin_payment_health', {});
assert.ok(!health.unconfirmed.some((x) => [a1.id, f1.id, k1.id, l1.id, h1.id].includes(x.order_id)));
assert.ok(health.unconfirmed.some((x) => x.order_id === v1.id && x.in_review === false));
ok('vue d’exploitation : seules les commandes encore incertaines restent listées');

summary();
await Promise.all([svc, svc2, asBoss, asAwa].map((c) => c.end()));
await admin.end();
process.exit(0);
