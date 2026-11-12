// Remboursements, entretien et réconciliation (migration
// `20261113110000_vyora_saspay_refunds_reconcile.sql`) sur PostgreSQL 17 réel.
// Indépendant des autres scénarios : crée ses propres comptes.
import { client } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const svc = await connectAs('service_role');
const tag = Date.now().toString(36);

await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);

async function customer(name) {
  const { id } = await one(`insert into auth.users(email) values ($1) returning id`, [`${name}-${tag}@test.local`]);
  await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [id]);
  await admin.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1)`, [id]);
  return id;
}
const { id: boss } = await one(`insert into auth.users(email) values ($1) returning id`, [`chef-${tag}@test.local`]);
// Un seul administrateur est autorisé par la base : on repart d'un rôle vierge (comme e2e.mjs).
await admin.query(`delete from saas_ugc.ugc_user_roles`);
await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin')`, [boss]);
const asBoss = await connectAs('authenticated', boss);
const asAnon = await connectAs('anon');

let seq = 0;
const settleArgs = (order, payment, amount) => ({
  p_order_id: order, p_payment_id: payment, p_provider_status: 'SUCCESS', p_requested_amount: amount, p_currency: 'XOF',
  p_fee: '0.00', p_charged: amount, p_net: amount, p_fee_mode: 'ADD_ON', p_reference: null, p_source: 'verify', p_failure_code: null,
});
/** Commande Studio « Creator » (5 000 FCFA → 27 crédits), réglée ou non. */
async function studioOrder(user, { pay = true, attach = true } = {}) {
  seq += 1;
  const payment = `pay-${tag}-s${String(seq).padStart(4, '0')}`;
  const order = await rpc(svc, 'vyora_payment_create_studio_order', {
    p_user_id: user, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML', p_flow: 'softpay',
    p_network: 'orange_ml', p_idempotency_key: `key-${tag}-s${String(seq).padStart(4, '0')}`,
    p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null });
  if (attach || pay) await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: order.id, p_payment_id: payment, p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
  if (pay) await rpc(svc, 'vyora_payment_studio_settle', settleArgs(order.id, payment, '5000.00'));
  return { ...order, payment };
}
async function bgOrder(user, { pay = true } = {}) {
  seq += 1;
  const payment = `pay-${tag}-b${String(seq).padStart(4, '0')}`;
  const order = await rpc(svc, 'vyora_payment_create_bg_order', {
    p_user_id: user, p_plan_key: 'croissance', p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml',
    p_idempotency_key: `key-${tag}-b${String(seq).padStart(4, '0')}`,
    p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null });
  await rpc(svc, 'vyora_payment_bg_attach', { p_order_id: order.id, p_payment_id: payment, p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
  if (pay) await rpc(svc, 'vyora_payment_bg_settle', settleArgs(order.id, payment, '25000.00'));
  return { ...order, payment };
}
const wallet = async (u) => one(`select available_balance::int a, reserved_balance::int r from saas_ugc.ugc_wallets where user_id = $1`, [u]);
const ledger = async (u) => count(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1`, [u]);
const spend = (u, n, key) => admin.query(`select ugc_private.apply_wallet_delta($1, 'capture', $2, 0, $3)`, [u, -n, key]);
const refundStudio = (c, order, amount, partial = false, reason = 'Demande du client, double achat') =>
  rpc(c, 'vyora_admin_refund_studio', { p_order_id: order, p_reason: reason, p_refund_amount_xof: amount, p_allow_partial: partial });
const refundBg = (c, order, amount, partial = false, reason = 'Demande du client, erreur de formule') =>
  rpc(c, 'vyora_admin_refund_business', { p_order_id: order, p_reason: reason, p_refund_amount_xof: amount, p_allow_partial: partial });
const preview = (product, order) => rpc(asBoss, 'vyora_admin_refund_preview', { p_product: product, p_order_id: order });
/** Les dates de création sont immuables : on lève la garde le temps de vieillir une commande de test. */
async function age(product, id, sets) {
  const [table, trigger] = product === 'studio'
    ? ['saas_ugc.ugc_recharge_orders', 'vyora_recharge_order_guard'] : ['saas_business.payment_orders', 'vyora_payment_order_guard'];
  await admin.query(`alter table ${table} disable trigger ${trigger}`);
  await admin.query(`update ${table} set ${sets} where id = $1`, [id]);
  await admin.query(`alter table ${table} enable trigger ${trigger}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('Remboursement Studio — crédits intacts');
const dave = await customer('dave');
const asDave = await connectAs('authenticated', dave);
const d1 = await studioOrder(dave);
assert.deepEqual(await wallet(dave), { a: 27, r: 0 });
let p = await preview('studio', d1.id);
assert.equal(p.refundable, true); assert.equal(p.credits_recoverable, 27); assert.equal(p.credits_unrecoverable, 0);
assert.equal(p.max_refund_xof, 5000); assert.equal(p.needs_partial, false); assert.equal(p.blocked, null);
ok('aperçu : 27 crédits récupérables, 5 000 FCFA remboursables au plus');

await fails(refundStudio(asDave, d1.id, 5000), /forbidden/, 'client');
await fails(refundStudio(asAnon, d1.id, 5000), /permission denied/, 'anon');
await fails(refundStudio(svc, d1.id, 5000), /permission denied|not_authenticated/, 'service');
await fails(rpc(asDave, 'vyora_admin_refund_preview', { p_product: 'studio', p_order_id: d1.id }), /forbidden/, 'aperçu client');
await fails(rpc(asDave, 'vyora_admin_refund_settle', { p_product: 'studio', p_order_id: d1.id, p_external_reference: 'REF-123' }), /forbidden/, 'attestation client');
ok('remboursement, aperçu et attestation réservés aux administrateurs');

await fails(refundStudio(asBoss, d1.id, 5000, false, 'non'), /refund_reason_required/, 'motif');
await fails(refundStudio(asBoss, d1.id, 0), /refund_amount_out_of_bounds/, 'zéro');
await fails(refundStudio(asBoss, d1.id, 5001), /refund_amount_out_of_bounds/, 'trop');
await fails(refundStudio(asBoss, d1.id, null), /refund_amount_out_of_bounds/, 'absent');
assert.deepEqual(await wallet(dave), { a: 27, r: 0 });
ok('motif obligatoire ; montant borné par le prix payé ; aucun effet en cas de refus');

let r = await refundStudio(asBoss, d1.id, 5000);
assert.equal(r.outcome, 'refunded'); assert.equal(r.status, 'refunded'); assert.equal(r.refund_state, 'credits_recovered');
assert.equal(r.refund_amount, '5000.00'); assert.equal(r.refund_credits_recovered, 27); assert.equal(r.refund_credits_unrecovered, 0);
assert.deepEqual(await wallet(dave), { a: 0, r: 0 });
const entry = await one(`select operation_type, available_delta::int d, recharge_order_id from saas_ugc.ugc_credit_ledger where user_id = $1 and idempotency_key = $2`, [dave, `refund:${d1.id}`]);
assert.deepEqual(entry, { operation_type: 'refund', d: -27, recharge_order_id: d1.id });
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_refund_recorded' and target_id = $1 and actor_user_id = $2`, [d1.id, boss]), 1);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = 'Remboursement en cours'`, [dave]), 1);
ok('remboursement enregistré : 27 crédits repris par le grand livre, commande « remboursée », tracé (auteur, motif)');

const before = await ledger(dave);
r = await refundStudio(asBoss, d1.id, 5000);
assert.equal(r.outcome, 'already_refunded'); assert.equal(await ledger(dave), before); assert.deepEqual(await wallet(dave), { a: 0, r: 0 });
r = await refundStudio(asBoss, d1.id, 1200, true, 'Autre montant, autre motif');
assert.equal(r.outcome, 'already_refunded'); assert.equal(r.refund_amount, '5000.00');
ok('rejeu → aucun second retrait, le premier remboursement fait foi');

r = await rpc(svc, 'vyora_payment_studio_settle', { ...settleArgs(d1.id, d1.payment, '5000.00'), p_source: 'webhook' });
assert.equal(r.outcome, 'already_paid'); assert.equal(r.credited, false); assert.equal(r.status, 'refunded');
assert.deepEqual(await wallet(dave), { a: 0, r: 0 });
ok('webhook ou vérification rejoués après remboursement → aucun nouveau crédit');

await fails(admin.query(`update saas_ugc.ugc_recharge_orders set status = 'paid' where id = $1`, [d1.id]), /paid_order_is_terminal/, 'retour payé');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set refund_amount_minor = 100 where id = $1`, [d1.id]), /refund_is_immutable/, 'montant');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set refund_credits_recovered = 1, refund_credits_unrecovered = 26 where id = $1`, [d1.id]), /refund_is_immutable/, 'crédits');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set refund_state = 'settled' where id = $1`, [d1.id]), /refund_settlement_requires_reference/, 'attestation sans référence');
ok('« remboursée » est terminal ; montant et crédits repris immuables');

const settleRefund = (product, order, ref) => rpc(asBoss, 'vyora_admin_refund_settle', { p_product: product, p_order_id: order, p_external_reference: ref });
await fails(settleRefund('studio', d1.id, 'x'), /refund_settlement_requires_reference/, 'référence courte');
r = await settleRefund('studio', d1.id, 'OM-TX-99812');
assert.equal(r.refund_state, 'settled'); assert.equal(r.refund_external_reference, 'OM-TX-99812'); assert.ok(r.refund_settled_at);
r = await settleRefund('studio', d1.id, 'OM-TX-99812');
assert.equal(r.refund_state, 'settled');
await fails(settleRefund('studio', d1.id, 'AUTRE-REF'), /refund_already_settled/, 'autre référence');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set refund_external_reference = 'FORGE' where id = $1`, [d1.id]), /refund_is_immutable/, 'référence');
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_refund_settled' and target_id = $1`, [d1.id]), 1);
ok('attestation du versement : référence obligatoire, enregistrée une seule fois, immuable');

const mine = await rpc(asDave, 'vyora_my_payments', { p_product: 'studio', p_limit: 10 });
assert.equal(mine[0].status, 'refunded'); assert.equal(mine[0].refund_amount, '5000.00'); assert.ok(mine[0].refunded_at);
assert.ok(!('refund_reason' in mine[0])); assert.ok(!('refund_external_reference' in mine[0]));
const seen = (await rpc(asBoss, 'vyora_admin_payments', { p_product: 'studio', p_limit: 300 })).find((x) => x.id === d1.id);
assert.equal(seen.refund_reason, 'Demande du client, double achat'); assert.equal(seen.refund_external_reference, 'OM-TX-99812');
ok('le client voit le remboursement sans les notes internes ; l’administrateur voit tout');

console.log('Remboursement Studio — crédits déjà consommés');
const erin = await customer('erin');
const e1 = await studioOrder(erin);
await spend(erin, 10, `spend-${tag}-1`);
p = await preview('studio', e1.id);
assert.equal(p.credits_recoverable, 17); assert.equal(p.credits_unrecoverable, 10);
assert.equal(p.max_refund_xof, 3148); assert.equal(p.needs_partial, true); assert.equal(p.refundable, true);
await fails(refundStudio(asBoss, e1.id, 3148), /refund_credits_already_consumed/, 'partiel non confirmé');
await fails(refundStudio(asBoss, e1.id, 5000, true), /refund_amount_out_of_bounds/, 'plein tarif');
await fails(refundStudio(asBoss, e1.id, 3149, true), /refund_amount_out_of_bounds/, 'un franc de trop');
assert.deepEqual(await wallet(erin), { a: 17, r: 0 });
r = await refundStudio(asBoss, e1.id, 3148, true);
assert.equal(r.outcome, 'refunded'); assert.equal(r.refund_credits_recovered, 17); assert.equal(r.refund_credits_unrecovered, 10);
assert.equal(r.refund_amount, '3148.00'); assert.deepEqual(await wallet(erin), { a: 0, r: 0 });
ok('10 crédits consommés sur 27 : confirmation explicite exigée, 17 crédits repris, 3 148 FCFA au plus (prorata)');

const frank = await customer('frank');
const f1 = await studioOrder(frank);
await spend(frank, 27, `spend-${tag}-2`);
p = await preview('studio', f1.id);
assert.equal(p.refundable, false); assert.equal(p.blocked, 'refund_nothing_recoverable'); assert.equal(p.max_refund_xof, 0);
await fails(refundStudio(asBoss, f1.id, 1, true), /refund_nothing_recoverable/, 'tout consommé');
assert.equal((await one(`select status from saas_ugc.ugc_recharge_orders where id = $1`, [f1.id])).status, 'paid');
ok('tous les crédits consommés → aucun remboursement possible par ce parcours, commande inchangée');

const gina = await customer('gina');
const g1 = await studioOrder(gina);
await admin.query(`select ugc_private.apply_wallet_delta($1, 'reserve', -20, 20, $2)`, [gina, `reserve-${tag}-1`]);
assert.deepEqual(await wallet(gina), { a: 7, r: 20 });
p = await preview('studio', g1.id);
assert.equal(p.blocked, 'refund_wallet_has_reserved_credits');
await fails(refundStudio(asBoss, g1.id, 1000, true), /refund_wallet_has_reserved_credits/, 'réservés');
await admin.query(`select ugc_private.apply_wallet_delta($1, 'release', 20, -20, $2)`, [gina, `release-${tag}-1`]);
r = await refundStudio(asBoss, g1.id, 5000);
assert.equal(r.outcome, 'refunded'); assert.deepEqual(await wallet(gina), { a: 0, r: 0 });
ok('crédits réservés par une génération en cours → remboursement suspendu ; possible une fois la génération terminée');

const hugo = await customer('hugo');
await admin.query(`select ugc_private.apply_wallet_delta($1, 'signup_bonus', 50, 0, $2)`, [hugo, `bonus-${tag}-1`]);
const h1 = await studioOrder(hugo);
const h2 = await studioOrder(hugo);
assert.deepEqual(await wallet(hugo), { a: 104, r: 0 });
r = await refundStudio(asBoss, h1.id, 5000);
assert.deepEqual(await wallet(hugo), { a: 77, r: 0 });
assert.equal((await one(`select status from saas_ugc.ugc_recharge_orders where id = $1`, [h2.id])).status, 'paid');
ok('seuls les crédits de la commande remboursée sont repris ; bonus et autres achats intacts');

const i1 = await studioOrder(hugo, { pay: false });
await fails(refundStudio(asBoss, i1.id, 5000), /refund_requires_paid_order/, 'non payée');
await fails(refundStudio(asBoss, '00000000-0000-4000-8000-000000000000', 5000), /payment_order_not_found/, 'inconnue');
ok('une commande non payée ou inconnue ne se rembourse pas');

await fails(admin.query(`update saas_ugc.ugc_recharge_orders set status = 'refunded' where id = $1`, [h2.id]), /refund_requires_refund_service/, 'forge simple');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered',
  refund_reason = 'forge', refund_amount_minor = 500000, refund_credits_recovered = 27, refund_credits_unrecovered = 0, refund_recorded_by = $2 where id = $1`, [h2.id, boss]),
  /refund_requires_credit_recovery/, 'forge complète');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set refund_amount_minor = 1 where id = $1`, [h2.id]), /refund_requires_refund_service/, 'champ isolé');
assert.deepEqual(await wallet(hugo), { a: 77, r: 0 });
ok('écriture directe en table : « remboursée » impossible sans reprise des crédits au grand livre');

const jade = await customer('jade');
const j1 = await studioOrder(jade);
const bosses = await Promise.all(Array.from({ length: 5 }, () => connectAs('authenticated', boss)));
const race = await Promise.all(bosses.map((c) => refundStudio(c, j1.id, 5000)));
assert.equal(race.filter((x) => x.outcome === 'refunded').length, 1);
assert.equal(race.filter((x) => x.outcome === 'already_refunded').length, 4);
assert.deepEqual(await wallet(jade), { a: 0, r: 0 });
assert.equal(await count(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1 and operation_type = 'refund'`, [jade]), 1);
ok('5 remboursements simultanés de la même commande → un seul retrait de crédits');

const kofi = await customer('kofi');
const k1 = await studioOrder(kofi);
const [raceRefund, raceSpend] = await Promise.allSettled([
  refundStudio(bosses[0], k1.id, 5000),
  admin.query(`select ugc_private.apply_wallet_delta($1, 'capture', -27, 0, $2)`, [kofi, `spend-${tag}-race`]),
]);
const kw = await wallet(kofi);
assert.equal(kw.a, 0); assert.ok(kw.a >= 0);
// L'un des deux a gagné : jamais les deux (les crédits ne sont ni dépensés ET repris, ni le solde négatif).
assert.ok((raceRefund.status === 'fulfilled') !== (raceSpend.status === 'fulfilled'),
  `refund=${raceRefund.status} ${raceRefund.reason?.message ?? ''} / spend=${raceSpend.status} ${raceSpend.reason?.message ?? ''}`);
ok('remboursement et dépense simultanés des mêmes crédits → un seul des deux aboutit, solde jamais négatif');
await Promise.all(bosses.map((c) => c.end()));

// ─────────────────────────────────────────────────────────────────────────────
console.log('Remboursement Business Grow');
const { id: lena } = await one(`insert into auth.users(email) values ($1) returning id`, [`lena-${tag}@test.local`]);
const studioState = async () => one(`select (select count(*) from saas_ugc.ugc_credit_ledger) l, (select coalesce(sum(available_balance), 0) from saas_ugc.ugc_wallets) w`);
const studioBefore = await studioState();
const l1 = await bgOrder(lena);
let sub = await one(`select id, status from saas_business.subscriptions where user_id = $1`, [lena]);
assert.equal(sub.status, 'active');
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [lena]), { a: 400, m: 400 });
p = await preview('business', l1.id);
assert.equal(p.refundable, true); assert.equal(p.will_cancel, true); assert.equal(p.days_recoverable, 30);
assert.equal(p.max_refund_xof, 25000); assert.equal(p.needs_partial, false);
await fails(refundBg(asAnon, l1.id, 25000), /permission denied/, 'anon');
await fails(refundBg(svc, l1.id, 25000), /permission denied|not_authenticated/, 'service');
await fails(refundBg(asDave, l1.id, 25000), /forbidden/, 'client');
await fails(refundBg(asBoss, l1.id, 25001), /refund_amount_out_of_bounds/, 'trop');
r = await refundBg(asBoss, l1.id, 25000);
assert.equal(r.outcome, 'refunded'); assert.equal(r.status, 'refunded'); assert.equal(r.refund_amount, '25000.00');
assert.equal(r.refund_subscription_status, 'canceled'); assert.equal(r.refund_units_recovered, 350); assert.equal(r.refund_days_recovered, 30);
sub = await one(`select status from saas_business.subscriptions where user_id = $1`, [lena]);
assert.equal(sub.status, 'canceled');
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [lena]), { a: 50, m: 50 });
assert.equal(await count(`select count(*) n from saas_business.billing_events where external_event_id = $1 and processing_status = 'processed'`, [`saspay:refund:${l1.id}`]), 1);
assert.equal(await count(`select count(*) n from saas_business.credit_ledger where user_id = $1 and kind = 'adjustment' and delta = -350`, [lena]), 1);
ok('remboursement intégral le jour même : abonnement résilié, quota ramené à la valeur par défaut, commande « remboursée »');
assert.deepEqual(await studioState(), studioBefore);
ok('un remboursement Business Grow ne touche ni le grand livre ni les portefeuilles Studio');

r = await refundBg(asBoss, l1.id, 25000);
assert.equal(r.outcome, 'already_refunded');
r = await rpc(svc, 'vyora_payment_bg_settle', { ...settleArgs(l1.id, l1.payment, '25000.00'), p_source: 'webhook' });
assert.equal(r.outcome, 'already_paid'); assert.equal(r.credited, false);
assert.equal((await one(`select status from saas_business.subscriptions where user_id = $1`, [lena])).status, 'canceled');
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [lena]), { a: 50, m: 50 });
ok('rejeu du remboursement ou du webhook de paiement → abonnement toujours résilié, aucun quota rendu');
await fails(admin.query(`update saas_business.payment_orders set status = 'paid' where id = $1`, [l1.id]), /paid_order_is_terminal/, 'retour payé');
await fails(admin.query(`update saas_business.payment_orders set refund_amount_minor = 1 where id = $1`, [l1.id]), /refund_is_immutable/, 'montant');
r = await settleRefund('business', l1.id, 'VIR-2026-0042');
assert.equal(r.refund_state, 'settled');
await fails(settleRefund('business', l1.id, 'AUTRE'), /refund_already_settled/, 'autre référence');
ok('« remboursée » terminal et immuable ; attestation du versement unique');

const l2 = await bgOrder(lena);
const subs = (await admin.query(`select id, status from saas_business.subscriptions where user_id = $1 order by created_at`, [lena])).rows;
assert.equal(subs.length, 2); assert.equal(subs[1].status, 'active'); assert.equal(subs[1].id, l2.id);
ok('nouvel achat après remboursement → nouvel abonnement actif');

const { id: malik } = await one(`insert into auth.users(email) values ($1) returning id`, [`malik-${tag}@test.local`]);
const m1 = await bgOrder(malik);
const m2 = await bgOrder(malik);
const days = async (u) => Number((await one(`select extract(epoch from current_period_end - now()) / 86400 as d from saas_business.subscriptions where user_id = $1 and status = 'active'`, [u])).d);
assert.ok(Math.abs(await days(malik) - 60) < 0.01);
p = await preview('business', m2.id);
assert.equal(p.will_cancel, false); assert.equal(p.max_refund_xof, 25000);
r = await refundBg(asBoss, m2.id, 25000);
assert.equal(r.refund_subscription_status, 'active'); assert.equal(r.refund_units_recovered, 0);
assert.ok(Math.abs(await days(malik) - 30) < 0.01);
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [malik]), { a: 400, m: 400 });
assert.equal((await one(`select status from saas_business.payment_orders where id = $1`, [m1.id])).status, 'paid');
ok('remboursement d’un renouvellement : 30 jours retirés, abonnement et quota conservés pour la période restante');

// Période entamée : il reste 10 jours sur 30.
await admin.query(`update saas_business.subscriptions set current_period_start = now() - interval '20 days', current_period_end = now() + interval '10 days' - interval '1 minute' where user_id = $1 and status = 'active'`, [malik]);
p = await preview('business', m1.id);
assert.equal(p.days_recoverable, 10); assert.equal(p.max_refund_xof, 8333); assert.equal(p.needs_partial, true); assert.equal(p.will_cancel, true);
await fails(refundBg(asBoss, m1.id, 8333), /refund_period_already_consumed/, 'partiel non confirmé');
await fails(refundBg(asBoss, m1.id, 25000, true), /refund_amount_out_of_bounds/, 'plein tarif');
r = await refundBg(asBoss, m1.id, 8333, true);
assert.equal(r.outcome, 'refunded'); assert.equal(r.refund_days_recovered, 10); assert.equal(r.refund_subscription_status, 'canceled');
ok('période entamée (20 jours sur 30) : confirmation exigée, 8 333 FCFA au plus (prorata), abonnement résilié');

const { id: nina } = await one(`insert into auth.users(email) values ($1) returning id`, [`nina-${tag}@test.local`]);
const n1 = await bgOrder(nina);
await admin.query(`update saas_business.subscriptions set current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute' where user_id = $1`, [nina]);
p = await preview('business', n1.id);
assert.equal(p.refundable, false); assert.equal(p.blocked, 'refund_nothing_recoverable');
await fails(refundBg(asBoss, n1.id, 1, true), /refund_nothing_recoverable/, 'période écoulée');
const n2 = await bgOrder(nina, { pay: false });
await fails(refundBg(asBoss, n2.id, 25000), /refund_requires_paid_order/, 'non payée');
ok('période entièrement écoulée ou commande non payée → aucun remboursement');
await fails(admin.query(`update saas_business.payment_orders set status = 'refunded' where id = $1`, [n1.id]), /refund_requires_refund_service/, 'forge bg');
await fails(admin.query(`update saas_business.payment_orders set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered',
  refund_reason = 'forge', refund_amount_minor = 25000, refund_days_recovered = 30, refund_recorded_by = $2, refund_billing_event_id = billing_event_id where id = $1`, [n1.id, boss]),
  /refund_requires_refund_service/, 'forge bg complète');
ok('écriture directe en table : « remboursée » impossible sans l’événement de facturation du remboursement');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Entretien (aucun appel réseau)');
await fails(rpc(asDave, 'vyora_payment_housekeeping', {}), /permission denied/, 'client');
await fails(rpc(asAnon, 'vyora_payment_housekeeping', {}), /permission denied/, 'anon');
const oscar = await customer('oscar');
const o1 = await studioOrder(oscar, { pay: false, attach: false });   // jamais parvenue à SasPay
const o2 = await studioOrder(oscar, { pay: false });                  // connue de SasPay
const o3 = await studioOrder(oscar, { pay: false, attach: false });   // récente
await admin.query(`update saas_ugc.ugc_recharge_orders set expires_at = now() - interval '20 minutes' where id = any($1)`, [[o1.id, o2.id]]);
let house = await rpc(svc, 'vyora_payment_housekeeping', {});
assert.equal(house.expired_studio_orders, 1);
const statusOf = async (id) => (await one(`select status, failure_code from saas_ugc.ugc_recharge_orders where id = $1`, [id]));
assert.deepEqual(await statusOf(o1.id), { status: 'cancelled', failure_code: 'expired_unpaid' });
assert.equal((await statusOf(o2.id)).status, 'processing');
assert.equal((await statusOf(o3.id)).status, 'pending');
ok('commande expirée jamais parvenue à SasPay → annulée ; commande connue de SasPay ou récente → intacte');
r = await rpc(svc, 'vyora_payment_studio_settle', settleArgs(o1.id, `pay-${tag}-late01`, '5000.00'));
assert.equal(r.outcome, 'paid'); assert.equal((await wallet(oscar)).a, 27);
ok('paiement réussi retrouvé après expiration → commande rouverte et créditée une fois');

assert.equal((await one(`select status from saas_business.subscriptions where user_id = $1`, [nina])).status, 'active');
await admin.query(`update saas_business.subscriptions set current_period_end = now() - interval '2 hours' where user_id = $1`, [nina]);
house = await admin.query(`select public.vyora_payment_housekeeping() as r`).then((x) => x.rows[0].r);   // comme pg_cron
assert.equal(house.expired_subscriptions, 1);
assert.equal((await one(`select status from saas_business.subscriptions where user_id = $1`, [nina])).status, 'expired');
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [nina]), { a: 50, m: 50 });
house = await rpc(svc, 'vyora_payment_housekeeping', {});
assert.equal(house.expired_subscriptions, 0);
const asNina = await connectAs('authenticated', nina);
assert.equal(await rpc(asNina, 'vyora_business_subscription', {}), null);
const n3 = await bgOrder(nina);
assert.equal((await one(`select status from saas_business.subscriptions where id = $1`, [n3.id])).status, 'active');
assert.deepEqual(await one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [nina]), { a: 400, m: 400 });
ok('abonnement arrivé à échéance → « expired », quota par défaut ; un nouvel achat réactive tout');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Réconciliation — sélection, anomalies, exécutions');
const due = async () => (await rpc(svc, 'vyora_payment_reconcile_batch', { p_limit: 50 }));
const isDue = async (id) => (await due()).due.some((x) => x.order_id === id);
const paul = await customer('paul');
const q1 = await studioOrder(paul, { pay: false });
assert.equal(await isDue(q1.id), false);
await age('studio', q1.id, `created_at = now() - interval '3 minutes'`);
assert.equal(await isDue(q1.id), true);
await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() - interval '1 minute' where id = $1`, [q1.id]);
assert.equal(await isDue(q1.id), false);
await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() - interval '5 minutes' where id = $1`, [q1.id]);
assert.equal(await isDue(q1.id), true);
await age('studio', q1.id, `created_at = now() - interval '3 hours'`);
assert.equal(await isDue(q1.id), false);
await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() - interval '31 minutes' where id = $1`, [q1.id]);
assert.equal(await isDue(q1.id), true);
ok('commande en attente : revérifiée après 2 min, puis toutes les 4 min (1re heure), 30 min (1er jour)');
const q2 = await studioOrder(paul, { pay: false, attach: false });
await age('studio', q2.id, `created_at = now() - interval '10 minutes'`);
assert.equal(await isDue(q2.id), false);
ok('commande sans identifiant SasPay : jamais envoyée en vérification (rien à vérifier)');
const q3 = await studioOrder(paul, { pay: false });
await rpc(svc, 'vyora_payment_studio_settle', { ...settleArgs(q3.id, q3.payment, null), p_provider_status: 'FAILED', p_requested_amount: null, p_currency: null });
assert.equal(await isDue(q3.id), false);
await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() - interval '7 hours' where id = $1`, [q3.id]);
assert.equal(await isDue(q3.id), true);
await age('studio', q3.id, `created_at = now() - interval '73 hours'`);
assert.equal(await isDue(q3.id), false);
ok('commande en échec : revérifiée toutes les 6 h pendant 72 h (succès tardif), puis plus jamais');
const q4 = await bgOrder(paul, { pay: false });
await age('business', q4.id, `created_at = now() - interval '5 minutes'`);
assert.ok((await due()).due.some((x) => x.order_id === q4.id && x.product === 'business'));
ok('les commandes Business Grow en attente sont revérifiées de la même façon');
const paid = await studioOrder(paul);
await age('studio', paid.id, `created_at = now() - interval '5 hours', last_verified_at = null`);
assert.equal(await isDue(paid.id), false);
ok('une commande payée ou remboursée n’est jamais revérifiée');

await age('studio', q1.id, `created_at = now() - interval '25 hours', last_verified_at = now() - interval '7 hours'`);
const notes = () => count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title like 'Paiement SasPay bloqué%'`, [boss]);
const notesBefore = await notes();
await due();
let anomaly = await one(`select kind, product, seen_count, internal_reference from saas_ugc.vyora_payment_anomalies where order_id = $1`, [q1.id]);
assert.deepEqual(anomaly, { kind: 'order_stuck', product: 'studio', seen_count: 1, internal_reference: q1.internal_reference });
assert.equal(await notes(), notesBefore + 1);
await due();
anomaly = await one(`select seen_count from saas_ugc.vyora_payment_anomalies where order_id = $1`, [q1.id]);
assert.equal(anomaly.seen_count, 2); assert.equal(await notes(), notesBefore + 1);
ok('commande bloquée depuis plus de 24 h → une anomalie, une seule alerte aux administrateurs');

assert.deepEqual(await rpc(svc, 'vyora_payment_find_by_reference', { p_reference: q1.internal_reference }), { product: 'studio', order_id: q1.id });
assert.deepEqual(await rpc(svc, 'vyora_payment_find_by_reference', { p_reference: q4.internal_reference }), { product: 'business', order_id: q4.id });
assert.equal(await rpc(svc, 'vyora_payment_find_by_reference', { p_reference: `VYS-${'0'.repeat(32)}` }), null);
assert.equal(await rpc(svc, 'vyora_payment_find_by_reference', { p_reference: `x' or 1=1 --` }), null);
ok('rapprochement par référence interne (VYS-… / VYB-…)');

assert.equal((await due()).sweep, true);
const run1 = await rpc(svc, 'vyora_payment_reconcile_start', { p_source: 'cron' });
assert.match(run1, /^[0-9a-f-]{36}$/);
assert.equal(await rpc(svc, 'vyora_payment_reconcile_start', { p_source: 'cron' }), null);
await rpc(svc, 'vyora_payment_reconcile_finish', { p_run_id: run1, p_status: 'ok', p_counts: { checked: 3, settled: 1, closed: 1, errors: 0, swept: 12, anomalies: 0, sweep_done: true } });
assert.equal((await due()).sweep, false);
const run2 = await rpc(svc, 'vyora_payment_reconcile_start', { p_source: 'manual' });
await admin.query(`update saas_ugc.vyora_payment_reconcile_runs set started_at = now() - interval '11 minutes' where id = $1`, [run2]);
const run3 = await rpc(svc, 'vyora_payment_reconcile_start', { p_source: 'cron' });
assert.ok(run3);
assert.equal((await one(`select status from saas_ugc.vyora_payment_reconcile_runs where id = $1`, [run2])).status, 'error');
await rpc(svc, 'vyora_payment_reconcile_finish', { p_run_id: run3, p_status: 'partial', p_counts: { checked: 1, errors: 1 } });
ok('exécutions : une seule à la fois, journalisées ; une exécution interrompue est close ; balayage au plus tous les quarts d’heure');

const reportArgs = { p_kind: 'duplicate_payment', p_product: 'studio', p_order_id: paid.id, p_payment_id: `pay-${tag}-dup001`, p_reference: paid.internal_reference, p_details: { amount: '5000.00' } };
assert.equal(await rpc(svc, 'vyora_payment_report_anomaly', reportArgs), true);
assert.equal(await rpc(svc, 'vyora_payment_report_anomaly', reportArgs), false);
await fails(rpc(svc, 'vyora_payment_report_anomaly', { ...reportArgs, p_kind: 'inconnu' }), /check constraint|violates/, 'type inconnu');
for (const [fn, args] of [
  ['vyora_payment_report_anomaly', reportArgs],
  ['vyora_payment_reconcile_batch', { p_limit: 5 }],
  ['vyora_payment_find_by_reference', { p_reference: q1.internal_reference }],
  ['vyora_payment_reconcile_start', { p_source: 'x' }],
  ['vyora_payment_reconcile_finish', { p_run_id: run1, p_status: 'ok', p_counts: {} }],
  ['vyora_payments_reconcile_token', {}],
  ['vyora_payments_reconcile_dispatch', {}],
]) {
  await fails(rpc(asDave, fn, args), /permission denied/, `authenticated ${fn}`);
  await fails(rpc(asBoss, fn, args), /permission denied/, `admin ${fn}`);
  await fails(rpc(asAnon, fn, args), /permission denied/, `anon ${fn}`);
}
await fails(rpc(svc, 'vyora_payments_reconcile_dispatch', {}), /permission denied/, 'dispatch service_role');
await fails(asDave.query(`select * from saas_ugc.vyora_payment_anomalies`), /permission denied/, 'table anomalies');
await fails(asBoss.query(`select * from saas_ugc.vyora_payment_reconcile_runs`), /permission denied/, 'table runs');
ok('fonctions de réconciliation et jeton inaccessibles au navigateur (client comme administrateur) ; tables fermées');

await fails(rpc(asDave, 'vyora_admin_payment_health', {}), /forbidden/, 'santé client');
let health = await rpc(asBoss, 'vyora_admin_payment_health', {});
assert.equal(health.enabled, true); assert.equal(health.mode, 'test');
assert.deepEqual(health.cron, { available: true, scheduled: true, schedule: '*/5 * * * *', active: true });
assert.ok(health.open_orders.studio >= 2); assert.ok(health.open_orders.business >= 1);
assert.equal(health.runs[0].status, 'partial'); assert.ok(health.runs.some((x) => x.sweep_done && x.swept === 12));
assert.ok(health.anomalies.some((a) => a.kind === 'duplicate_payment' && a.order_id === paid.id));
assert.ok(health.anomalies.every((a) => !('dedup_key' in a)));
assert.equal(health.refunds_awaiting_settlement, await count(`select (select count(*) from saas_ugc.ugc_recharge_orders where status = 'refunded' and refund_state = 'credits_recovered')
  + (select count(*) from saas_business.payment_orders where status = 'refunded' and refund_state = 'credits_recovered') as n`));
assert.ok(health.refunds_awaiting_settlement >= 4);
const dup = health.anomalies.find((a) => a.kind === 'duplicate_payment');
await fails(rpc(asDave, 'vyora_admin_resolve_anomaly', { p_anomaly_id: dup.id, p_note: 'Remboursé manuellement' }), /forbidden/, 'résolution client');
await fails(rpc(asBoss, 'vyora_admin_resolve_anomaly', { p_anomaly_id: dup.id, p_note: 'ok' }), /anomaly_note_required/, 'note');
await rpc(asBoss, 'vyora_admin_resolve_anomaly', { p_anomaly_id: dup.id, p_note: 'Second paiement remboursé au client (OM-TX-7781)' });
await fails(rpc(asBoss, 'vyora_admin_resolve_anomaly', { p_anomaly_id: dup.id, p_note: 'Deuxième clôture' }), /anomaly_not_found/, 'déjà résolue');
health = await rpc(asBoss, 'vyora_admin_payment_health', {});
assert.ok(!health.anomalies.some((a) => a.id === dup.id));
ok('vue d’exploitation réservée aux administrateurs : tâche planifiée, exécutions, anomalies, remboursements à verser');

console.log('Réconciliation — planification');
assert.deepEqual(await one(`select schedule, command, active from cron.job where jobname = 'vyora-payments-reconcile'`),
  { schedule: '*/5 * * * *', command: 'select public.vyora_payments_reconcile_dispatch()', active: true });
assert.equal(await count(`select count(*) n from cron.job where jobname = 'vyora-payments-reconcile'`), 1);
const token = (await one(`select decrypted_secret s from vault.decrypted_secrets where name = 'vyora_payments_reconcile_token'`)).s;
assert.match(token, /^[0-9a-f]{64}$/);
assert.equal(await count(`select count(*) n from vault.secrets where name = 'vyora_payments_reconcile_token'`), 1);
assert.equal(await rpc(svc, 'vyora_payments_reconcile_token', {}), token);
ok('tâche planifiée unique (*/5 min) et jeton serveur unique dans Vault (migration rejouée deux fois)');

// pg_net réel absent du banc : on enregistre ce qui partirait.
const root = client(); await root.connect();
await root.query(`create table if not exists net.sent (id bigserial primary key, url text, headers jsonb, body jsonb, timeout_milliseconds int);
  create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
  returns bigint language sql as $f$ insert into net.sent(url, headers, body, timeout_milliseconds) values (url, headers, body, timeout_milliseconds) returning id $f$;
  truncate net.sent;
  grant usage on schema net to postgres; grant all on net.sent to postgres; grant usage on sequence net.sent_id_seq to postgres;
  grant execute on all functions in schema net to postgres;`);
await root.end();
const dispatch = async () => (await admin.query(`select public.vyora_payments_reconcile_dispatch() as r`)).rows[0].r;
let d = await dispatch();
assert.equal(d.dispatched, true); assert.ok(d.due >= 1);
let sent = (await admin.query(`select * from net.sent`)).rows;
assert.equal(sent.length, 1);
assert.equal(sent[0].url, 'https://xbuuhfwobrafcbgtdgjx.supabase.co/functions/v1/vyora-payments-reconcile');
assert.equal(sent[0].headers.Authorization, `Bearer ${token}`); assert.equal(sent[0].headers['x-vyora-cron'], 'payments-reconcile');
assert.deepEqual(sent[0].body, { source: 'cron' });
ok('des commandes sont à revérifier → un appel authentifié (jeton Vault + en-tête dédié) vers la fonction de réconciliation');

// Plus rien à faire : toutes les commandes ouvertes viennent d'être vérifiées, balayage récent.
await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() where provider = 'saspay' and status not in ('paid', 'refunded')`);
await admin.query(`update saas_business.payment_orders set last_verified_at = now() where status not in ('paid', 'refunded')`);
const run4 = await rpc(svc, 'vyora_payment_reconcile_start', { p_source: 'cron' });
await rpc(svc, 'vyora_payment_reconcile_finish', { p_run_id: run4, p_status: 'ok', p_counts: { sweep_done: true } });
await admin.query(`truncate net.sent`);
d = await dispatch();
assert.equal(d.dispatched, false); assert.equal(d.reason, 'nothing_to_reconcile');
assert.equal(await count(`select count(*) n from net.sent`), 0);
ok('rien à revérifier → aucun appel réseau (l’entretien SQL a tout de même tourné)');

await admin.query(`update saas_ugc.ugc_recharge_orders set last_verified_at = now() - interval '2 days' where id = $1`, [q1.id]);
await admin.query(`update vault.secrets set secret = '' where name = 'vyora_payments_reconcile_token'`);
d = await dispatch();
assert.equal(d.dispatched, false); assert.equal(d.reason, 'token_missing');
assert.equal(await count(`select count(*) n from net.sent`), 0);
await admin.query(`update vault.secrets set secret = $1 where name = 'vyora_payments_reconcile_token'`, [token]);
ok('jeton absent → aucun appel réseau');

summary();
for (const c of [svc, asBoss, asAnon, asDave, asNina, admin]) await c.end();
