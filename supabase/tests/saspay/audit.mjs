// Audit avant mise en production : concurrence, remboursements, dates.
// PostgreSQL 17 réel, plusieurs connexions réellement simultanées.
// Indépendant des autres scénarios : crée ses propres comptes.
import { client } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const svc = await connectAs('service_role');
const pool = await Promise.all(Array.from({ length: 6 }, () => connectAs('service_role')));
const tag = `a${Date.now().toString(36)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 10000, monthly_credit_units = 150 where plan_key = 'essentiel'`);
const PRICE = { croissance: '25000.00', essentiel: '10000.00' };

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
// Un seul administrateur est autorisé par la base : on repart d'un rôle vierge.
await admin.query(`delete from saas_ugc.ugc_user_roles`);
await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin')`, [boss]);
const asBoss = await connectAs('authenticated', boss);
const asBoss2 = await connectAs('authenticated', boss);

const settleArgs = (order, payment, amount, status = 'SUCCESS') => ({
  p_order_id: order, p_payment_id: payment, p_provider_status: status, p_requested_amount: amount, p_currency: 'XOF',
  p_fee: '0.00', p_charged: amount, p_net: amount, p_fee_mode: 'ADD_ON', p_reference: null, p_source: 'webhook', p_failure_code: null,
});
const createBg = (c, user, plan, key = next('key')) => rpc(c, 'vyora_payment_create_bg_order', {
  p_user_id: user, p_plan_key: plan, p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: key,
  p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null });
/** Commande Business Grow présentée à SasPay (identifiant de paiement rattaché). */
async function bgOpen(user, plan, c = svc) {
  const order = await createBg(c, user, plan);
  const payment = next('pay');
  await rpc(svc, 'vyora_payment_bg_attach', { p_order_id: order.id, p_payment_id: payment, p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
  return { ...order, payment, plan };
}
const settleBg = (c, o, status = 'SUCCESS') => rpc(c, 'vyora_payment_bg_settle', settleArgs(o.id, o.payment, PRICE[o.plan], status));
const bgRow = (id) => one(`select * from saas_business.payment_orders where id = $1`, [id]);
const subsOf = async (u) => (await admin.query(
  `select id, plan_key, status, billing_provider, extract(epoch from current_period_end - now()) / 86400 as days
     from saas_business.subscriptions where user_id = $1 order by created_at`, [u])).rows;
const bgWallet = (u) => one(`select available_units a, monthly_allowance m from saas_business.wallets where user_id = $1`, [u]);
/** Les dates de création sont immuables : on lève la garde le temps de vieillir une commande de test. */
async function age(product, id, sets) {
  const [table, trigger] = product === 'studio'
    ? ['saas_ugc.ugc_recharge_orders', 'vyora_recharge_order_guard'] : ['saas_business.payment_orders', 'vyora_payment_order_guard'];
  await admin.query(`alter table ${table} disable trigger ${trigger}`);
  await admin.query(`update ${table} set ${sets} where id = $1`, [id]);
  await admin.query(`alter table ${table} enable trigger ${trigger}`);
}
const settled = async (promises) => (await Promise.allSettled(promises)).map((x) => (x.status === 'fulfilled' ? x.value : { error: x.reason.message }));

// ─────────────────────────────────────────────────────────────────────────────
console.log('Business Grow — deux formules différentes en même temps');

// 1. Entrelacement imposé : la première création tient son verrou, la seconde attend.
const ada = await person('ada');
await pool[0].query('begin');
const first = await createBg(pool[0], ada, 'croissance');
let waiting = 'pending';
const second = createBg(pool[1], ada, 'essentiel').then((v) => { waiting = 'created'; return v; }, (e) => { waiting = 'refused'; return { error: e.message }; });
await sleep(250);
assert.equal(waiting, 'pending', 'la seconde création doit attendre la fin de la première');
await pool[0].query('commit');
const refused = await second;
assert.match(refused.error ?? '', /business_other_plan_payment_in_progress/);
assert.equal(await count(`select count(*) n from saas_business.payment_orders where user_id = $1`, [ada]), 1);
assert.equal(first.plan_key, 'croissance');
ok('la seconde création attend la première, puis est refusée : une autre formule est déjà en cours de paiement');

// 2. Course réelle, répétée : jamais deux commandes ouvertes de formules différentes.
const racers = []; for (let i = 0; i < 12; i += 1) racers.push(await person(`race${i}`));
for (const [i, user] of racers.entries()) {
  const res = await settled([createBg(pool[i % 3], user, 'croissance'), createBg(pool[3 + (i % 3)], user, 'essentiel')]);
  const created = res.filter((x) => !x.error);
  assert.equal(created.length, 1, `utilisateur ${i} : ${JSON.stringify(res)}`);
  assert.match(res.find((x) => x.error).error, /business_other_plan_payment_in_progress/);
}
assert.equal(await count(
  `select count(*) n from (select user_id from saas_business.payment_orders where user_id = any($1) group by user_id having count(distinct plan_key) > 1) x`, [racers]), 0);
ok('12 courses « deux formules au même instant » → toujours une seule commande créée');

// La même formule peut, elle, être rejouée (autre clé) : ce n'est pas un conflit.
const again = await createBg(svc, ada, 'croissance');
assert.notEqual(again.id, first.id);
const sameKey = await createBg(svc, ada, 'croissance', first.idempotency_key ?? undefined).catch((e) => ({ error: e.message }));
assert.ok(!sameKey.error || /idempotency/.test(sameKey.error));
ok('une seconde commande de la MÊME formule reste possible (renouvellement, nouvel essai)');

// 3. Commande expirée d'une autre formule, payée tardivement : c'est le règlement qui tranche.
console.log('Business Grow — deux encaissements pour deux formules différentes');
const bea = await person('bea');
const beaPro = await bgOpen(bea, 'croissance');
// Trente minutes plus tard, la première commande n'est plus « ouverte » : le client change d'avis.
await age('business', beaPro.id, `created_at = now() - interval '45 minutes', expires_at = now() - interval '15 minutes'`);
const beaEss = await bgOpen(bea, 'essentiel');
let res = await settled([settleBg(pool[0], beaPro), settleBg(pool[1], beaEss)]);
assert.ok(res.every((x) => !x.error), JSON.stringify(res));
assert.deepEqual(res.map((x) => x.outcome).sort(), ['paid', 'subscription_conflict']);
const winner = res[0].outcome === 'paid' ? beaPro : beaEss;
const loser = winner === beaPro ? beaEss : beaPro;
let subs = await subsOf(bea);
assert.equal(subs.length, 1); assert.equal(subs[0].plan_key, winner.plan); assert.equal(subs[0].status, 'active');
assert.ok(Math.abs(Number(subs[0].days) - 30) < 0.01);
assert.deepEqual(await bgWallet(bea), winner.plan === 'croissance' ? { a: 400, m: 400 } : { a: 150, m: 150 });
let lost = await bgRow(loser.id);
assert.equal(lost.status, 'processing'); assert.equal(lost.failure_code, 'business_plan_change_not_supported');
assert.equal(lost.paid_at, null); assert.equal(lost.subscription_id, null); assert.equal(lost.provider_payment_id, loser.payment);
assert.equal(await count(`select count(*) n from saas_business.billing_events where external_event_id = $1`, [`saspay:success:${loser.payment}`]), 0);
ok('deux règlements simultanés, deux formules → une seule activée ; l’autre : rien livré, motif enregistré');

// 4. Même chose sans simultanéité : c'est bien le règlement qui refuse, pas la chance.
const cleo = await person('cleo');
const cleoPro = await bgOpen(cleo, 'croissance');
await age('business', cleoPro.id, `created_at = now() - interval '45 minutes', expires_at = now() - interval '15 minutes'`);
const cleoEss = await bgOpen(cleo, 'essentiel');
assert.equal((await settleBg(svc, cleoEss)).outcome, 'paid');
let late = await settleBg(svc, cleoPro);
assert.equal(late.outcome, 'subscription_conflict'); assert.equal(late.credited, false);
subs = await subsOf(cleo);
assert.equal(subs.length, 1); assert.equal(subs[0].plan_key, 'essentiel'); assert.ok(Math.abs(Number(subs[0].days) - 30) < 0.01);
assert.deepEqual(await bgWallet(cleo), { a: 150, m: 150 });
ok('paiement tardif d’une autre formule → la formule en cours n’est ni remplacée ni raccourcie');

// 5. Le refus est définitif : rejeu, fin de période, échec tardif — rien n'est livré plus tard.
late = await settleBg(svc, cleoPro);
assert.equal(late.outcome, 'subscription_conflict');
await admin.query(`update saas_business.subscriptions set current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute' where user_id = $1`, [cleo]);
res = await settled(pool.slice(0, 4).map((c) => settleBg(c, cleoPro)));
assert.ok(res.every((x) => x.outcome === 'subscription_conflict'), JSON.stringify(res));
assert.equal((await subsOf(cleo))[0].plan_key, 'essentiel');
await rpc(svc, 'vyora_payment_bg_settle', { ...settleArgs(cleoPro.id, cleoPro.payment, null, 'CANCELLED'), p_failure_code: 'provider_payment_not_found' });
assert.equal((await bgRow(cleoPro.id)).failure_code, 'business_plan_change_not_supported');
assert.equal((await settleBg(svc, cleoPro)).outcome, 'subscription_conflict');
assert.equal((await subsOf(cleo))[0].plan_key, 'essentiel');
ok('refus définitif : rejeux, fin de la période en cours, clôture tardive → jamais d’activation différée');

// 6. Même formule payée deux fois en même temps : deux périodes, une seule ligne d'abonnement.
const dora = await person('dora');
const dora1 = await bgOpen(dora, 'croissance');
const dora2 = await bgOpen(dora, 'croissance');
res = await settled([settleBg(pool[0], dora1), settleBg(pool[1], dora2), settleBg(pool[2], dora1), settleBg(pool[3], dora2)]);
assert.ok(res.every((x) => !x.error), JSON.stringify(res));
assert.equal(res.filter((x) => x.outcome === 'paid').length, 2);
assert.equal(res.filter((x) => x.outcome === 'already_paid').length, 2);
subs = await subsOf(dora);
assert.equal(subs.length, 1); assert.ok(Math.abs(Number(subs[0].days) - 60) < 0.01, `jours : ${subs[0].days}`);
assert.equal(await count(`select count(*) n from saas_business.billing_events e where e.user_id = $1`, [dora]), 2);
ok('premier abonnement payé deux fois au même instant (même formule) → 60 jours, un seul abonnement, aucune erreur');

// 7. Période terminée : une autre formule redevient possible, à la création comme au règlement.
const elsa = await person('elsa');
const elsa1 = await bgOpen(elsa, 'croissance');
assert.equal((await settleBg(svc, elsa1)).outcome, 'paid');
await fails(createBg(svc, elsa, 'essentiel'), /business_plan_change_not_supported/, 'formule en cours');
await admin.query(`update saas_business.subscriptions set current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute' where user_id = $1`, [elsa]);
const elsa2 = await bgOpen(elsa, 'essentiel');
assert.equal((await settleBg(svc, elsa2)).outcome, 'paid');
subs = await subsOf(elsa);
assert.equal(subs.filter((s) => s.status === 'active').length, 1);
assert.equal(subs.find((s) => s.status === 'active').plan_key, 'essentiel');
assert.ok(Math.abs(Number(subs.find((s) => s.status === 'active').days) - 30) < 0.01);
ok('une fois la période terminée, une autre formule s’achète et s’active normalement (30 jours à compter du paiement)');

// 8. Abonnement repris par un autre prestataire entre la commande et le paiement.
const fany = await person('fany');
const fany1 = await bgOpen(fany, 'croissance');
await admin.query(
  `insert into saas_business.subscriptions(id, user_id, plan_key, status, billing_provider, external_customer_id, external_subscription_id, current_period_start, current_period_end)
   values (gen_random_uuid(), $1, 'essentiel', 'active', 'stripe', $2, $3, now(), now() + interval '30 days')`, [fany, `cus_${tag}`, `sub_${tag}`]);
res = await settleBg(svc, fany1);
assert.equal(res.outcome, 'subscription_conflict');
assert.equal((await bgRow(fany1.id)).failure_code, 'business_subscription_managed_elsewhere');
subs = await subsOf(fany);
assert.equal(subs.length, 1); assert.equal(subs[0].billing_provider, 'stripe'); assert.equal(subs[0].plan_key, 'essentiel');
ok('abonnement géré par un autre prestataire → encaissement non livré et signalé, abonnement intact');

// 9. Un encaissement non livré n'a qu'une issue : son remboursement INTÉGRAL, sans toucher l'abonnement.
const refundUndelivered = (c, order, amount) => rpc(c, 'vyora_admin_refund_business', {
  p_order_id: order, p_reason: 'Encaissement non activable, rendu au client', p_refund_amount_xof: amount, p_allow_partial: true });
let stuck = await bgRow(fany1.id);
assert.equal(stuck.status, 'processing'); assert.equal(stuck.provider_status, 'SUCCESS'); assert.equal(stuck.subscription_id, null);
// Aucun autre changement d'état n'est possible, même par une écriture directe en base.
for (const [sql, pattern] of [
  [`update saas_business.payment_orders set status = 'paid' where id = $1`, /subscription_conflict_is_final/],
  [`update saas_business.payment_orders set status = 'failed' where id = $1`, /subscription_conflict_is_final/],
  [`update saas_business.payment_orders set status = 'cancelled' where id = $1`, /subscription_conflict_is_final/],
  [`update saas_business.payment_orders set failure_code = null where id = $1`, /subscription_conflict_is_final/],
  [`update saas_business.payment_orders set provider_status = 'PENDING' where id = $1`, /subscription_conflict_is_final/],
  [`update saas_business.payment_orders set status = 'refunded' where id = $1`, /refund_requires_refund_service/],
  [`update saas_business.payment_orders set status = 'refunded', refunded_at = now(), refund_state = 'credits_recovered', refund_reason = 'x', refund_recorded_by = user_id,
      refund_amount_minor = amount_minor - 1, refund_days_recovered = 0, refund_units_recovered = 0 where id = $1`, /refund_requires_refund_service/],
]) await fails(admin.query(sql, [fany1.id]), pattern, sql.slice(0, 70));
for (const status of ['FAILED', 'CANCELLED', 'PENDING']) {
  res = await rpc(svc, 'vyora_payment_bg_settle', settleArgs(fany1.id, fany1.payment, null, status));
  assert.equal(res.outcome, 'subscription_conflict'); assert.equal(res.credited, false);
}
stuck = await bgRow(fany1.id); assert.equal(stuck.status, 'processing'); assert.equal(stuck.provider_status, 'SUCCESS');
let undeliveredPlan = await rpc(asBoss, 'vyora_admin_refund_preview', { p_product: 'business', p_order_id: fany1.id });
assert.equal(undeliveredPlan.undelivered, true); assert.equal(undeliveredPlan.refundable, true);
assert.equal(Number(undeliveredPlan.max_refund_xof), 25000); assert.equal(undeliveredPlan.needs_partial, false);
assert.equal(undeliveredPlan.will_cancel, false); assert.equal(undeliveredPlan.days_recoverable, 0);
await fails(refundUndelivered(asBoss, fany1.id, 10000), /refund_amount_out_of_bounds/, 'remboursement partiel d’un encaissement non livré');
await fails(refundUndelivered(asBoss, fany1.id, 25001), /refund_amount_out_of_bounds/, 'remboursement supérieur à l’encaissement');
await fails(refundUndelivered(svc, fany1.id, 25000), /./, 'remboursement par la clé de service');
const fanyEvents = await count(`select count(*) n from saas_business.billing_events e where e.user_id = $1`, [fany]);
res = await settled([refundUndelivered(asBoss, fany1.id, 25000), refundUndelivered(asBoss2, fany1.id, 25000)]);
assert.deepEqual(res.map((x) => x.outcome).sort(), ['already_refunded', 'refunded'], JSON.stringify(res));
stuck = await bgRow(fany1.id);
assert.equal(stuck.status, 'refunded'); assert.equal(stuck.refund_state, 'credits_recovered');
assert.equal(Number(stuck.refund_amount_minor), 25000); assert.equal(stuck.refund_days_recovered, 0); assert.equal(stuck.refund_billing_event_id, null);
subs = await subsOf(fany);
assert.equal(subs.length, 1); assert.equal(subs[0].billing_provider, 'stripe'); assert.equal(subs[0].status, 'active');
assert.ok(Math.abs(Number(subs[0].days) - 30) < 0.01);
assert.equal(await count(`select count(*) n from saas_business.billing_events e where e.user_id = $1`, [fany]), fanyEvents);
// Après remboursement : un webhook tardif ne livre toujours rien.
res = await settleBg(svc, fany1); assert.equal(res.credited, false); assert.equal((await bgRow(fany1.id)).status, 'refunded');
// Une commande simplement impayée (aucun encaissement constaté) n'est jamais remboursable.
const unpaid = await person('impayee'); const ginaOpen = await bgOpen(unpaid, 'croissance');
undeliveredPlan = await rpc(asBoss, 'vyora_admin_refund_preview', { p_product: 'business', p_order_id: ginaOpen.id });
assert.equal(undeliveredPlan.undelivered, false); assert.equal(undeliveredPlan.blocked, 'refund_requires_paid_order');
await fails(refundUndelivered(asBoss, ginaOpen.id, 25000), /refund_requires_paid_order/, 'commande impayée');
ok('encaissement non livré : figé (ni activé, ni échoué), remboursable intégralement une seule fois, abonnement et quota intacts ; commande impayée non remboursable');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Business Grow — remboursement : jours restants, fuseaux, périodes');
const refundBg = (c, order, amount, partial = false, reason = 'Demande du client, erreur de formule') =>
  rpc(c, 'vyora_admin_refund_business', { p_order_id: order, p_reason: reason, p_refund_amount_xof: amount, p_allow_partial: partial });
const preview = (product, order, c = asBoss) => rpc(c, 'vyora_admin_refund_preview', { p_product: product, p_order_id: order });
const paidBg = async (user, plan = 'croissance') => { const o = await bgOpen(user, plan); assert.equal((await settleBg(svc, o)).outcome, 'paid'); return o; };
const setPeriod = (user, startSql, endSql) => admin.query(
  `update saas_business.subscriptions set current_period_start = ${startSql}, current_period_end = ${endSql} where user_id = $1 and status = 'active'`, [user]);

// 9. Fuseau horaire : 30 « jours » = 30 × 24 h, quel que soit le fuseau de la session.
const gina = await person('gina');
const gina1 = await paidBg(gina);
// Fin de période le 15 novembre 2030 à 12:00 UTC : 30 jours plus tôt, New York a changé d'heure (3 nov.).
await setPeriod(gina, `'2030-10-01 12:00:00+00'`, `'2030-11-15 12:00:00+00'`);
const views = [];
for (const zone of ['UTC', 'America/New_York', 'Pacific/Auckland', 'Africa/Bamako']) {
  await asBoss.query(`set timezone = '${zone}'`);
  const v = await preview('business', gina1.id);
  views.push({ days: v.days_recoverable, max: v.max_refund_xof, end: new Date(v.new_period_end).toISOString(), cancel: v.will_cancel });
}
for (const v of views) assert.deepEqual(v, { days: 30, max: 25000, end: '2030-10-16T12:00:00.000Z', cancel: false });
await asBoss.query(`set timezone = 'America/New_York'`);
let r = await refundBg(asBoss, gina1.id, 25000);
await asBoss.query(`set timezone = 'UTC'`);
assert.equal(r.outcome, 'refunded'); assert.equal(r.refund_days_recovered, 30);
assert.equal((await one(`select current_period_end = '2030-10-16 12:00:00+00'::timestamptz as same from saas_business.subscriptions where user_id = $1`, [gina])).same, true);
ok('fuseau de la session (UTC, New York, Auckland, Bamako) sans effet : 30 jours = 720 h exactes, même à travers un changement d’heure');

// La période achetée elle-même fait 720 h exactes, quel que soit le fuseau.
const gwen = await person('gwen');
const gwen1 = await bgOpen(gwen, 'croissance');
await pool[0].query(`set timezone = 'America/New_York'`);
assert.equal((await settleBg(pool[0], gwen1)).outcome, 'paid');
await pool[0].query(`set timezone = 'UTC'`);
assert.equal(Number((await one(`select extract(epoch from current_period_end - current_period_start) as s from saas_business.subscriptions where user_id = $1`, [gwen])).s), 30 * 86400);
ok('période activée : 30 × 86 400 secondes exactement, quel que soit le fuseau de la session');

// 10. Jours entamés : une journée commencée reste due au client ; plafond = prix payé.
const hana = await person('hana');
const hana1 = await paidBg(hana);
const cases = [
  [`now() + interval '9 days 1 hour'`, 10, 8333, true],
  [`now() + interval '8 days 23 hours'`, 9, 7500, true],
  [`now() + interval '30 seconds'`, 1, 833, true],
  [`now() + interval '29 days 23 hours 59 minutes'`, 30, 25000, true],
  [`now() + interval '45 days'`, 30, 25000, false],
];
for (const [endSql, days, max, cancel] of cases) {
  await setPeriod(hana, `now() - interval '1 day'`, endSql);
  const v = await preview('business', hana1.id);
  assert.deepEqual([v.days_recoverable, v.max_refund_xof, v.will_cancel, v.refundable], [days, max, cancel, true], endSql);
  assert.equal(v.needs_partial, max < 25000);
}
await setPeriod(hana, `now() - interval '31 days'`, `now() - interval '1 second'`);
let v = await preview('business', hana1.id);
assert.deepEqual([v.days_recoverable, v.max_refund_xof, v.refundable, v.blocked], [0, 0, false, 'refund_nothing_recoverable']);
await fails(refundBg(asBoss, hana1.id, 1, true), /refund_nothing_recoverable/, 'période échue');
assert.equal((await bgRow(hana1.id)).status, 'paid');
ok('jours entamés arrondis au profit du client, jamais plus que le prix payé ; période échue → rien à rembourser');

// 11. Changement de formule après échéance : l'ancienne commande n'est plus remboursable.
const iris = await person('iris');
const iris1 = await paidBg(iris, 'croissance');
await setPeriod(iris, `now() - interval '31 days'`, `now() - interval '1 minute'`);
const iris2 = await paidBg(iris, 'essentiel');
v = await preview('business', iris1.id);
assert.equal(v.refundable, false); assert.equal(v.blocked, 'refund_subscription_plan_changed'); assert.equal(v.max_refund_xof, 0);
await fails(refundBg(asBoss, iris1.id, 1, true), /refund_subscription_plan_changed/, 'autre formule');
subs = await subsOf(iris);
assert.ok(Math.abs(Number(subs.find((s) => s.status === 'active').days) - 30) < 0.01);
v = await preview('business', iris2.id);
assert.deepEqual([v.refundable, v.max_refund_xof, v.days_recoverable], [true, 10000, 30]);
ok('ancienne commande d’une formule terminée → non remboursable ; la période de la nouvelle formule n’est pas amputée');

// 12. Deux remboursements simultanés sur le même abonnement (deux périodes payées).
const jade = await person('jade');
const jade1 = await paidBg(jade); const jade2 = await paidBg(jade);
assert.ok(Math.abs(Number((await subsOf(jade))[0].days) - 60) < 0.01);
res = await settled([refundBg(asBoss, jade1.id, 25000), refundBg(asBoss2, jade2.id, 25000)]);
assert.ok(res.every((x) => x.outcome === 'refunded'), JSON.stringify(res));
assert.deepEqual(res.map((x) => x.refund_days_recovered), [30, 30]);
assert.deepEqual(res.map((x) => x.refund_subscription_status).sort(), ['active', 'canceled']);
subs = await subsOf(jade);
assert.equal(subs.length, 1); assert.equal(subs[0].status, 'canceled');
assert.deepEqual(await bgWallet(jade), { a: 50, m: 50 });
res = await settled([refundBg(asBoss, jade1.id, 1, true), refundBg(asBoss2, jade2.id, 1, true)]);
assert.ok(res.every((x) => x.outcome === 'already_refunded' && x.refund_amount === '25000.00'), JSON.stringify(res));
ok('deux périodes remboursées au même instant → 60 jours repris en tout, abonnement résilié une fois, rejeux sans effet');

// 13. Remboursement d'une période pendant qu'un renouvellement est réglé.
const kira = await person('kira');
const kira1 = await paidBg(kira);
const kira2 = await bgOpen(kira, 'croissance');
res = await settled([refundBg(asBoss, kira1.id, 25000), settleBg(pool[0], kira2)]);
assert.ok(res.every((x) => !x.error), JSON.stringify(res));
assert.equal(res[0].outcome, 'refunded'); assert.equal(res[1].outcome, 'paid');
subs = (await subsOf(kira)).filter((s) => s.status === 'active');
assert.equal(subs.length, 1); assert.ok(Math.abs(Number(subs[0].days) - 30) < 0.01, `jours : ${subs[0].days}`);
assert.deepEqual(await bgWallet(kira), { a: 400, m: 400 });
ok('remboursement et renouvellement simultanés → une période remboursée, une période active (30 jours), quota de la formule');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Studio — crédits attribués, consommés, disponibles');
const wallet = (u) => one(`select available_balance::int a, reserved_balance::int r from saas_ugc.ugc_wallets where user_id = $1`, [u]);
const ledgerSum = async (u) => Number((await one(`select coalesce(sum(available_delta), 0)::int s from saas_ugc.ugc_credit_ledger where user_id = $1`, [u])).s);
const spend = (u, n, c = admin) => c.query(`select ugc_private.apply_wallet_delta($1, 'capture', $2, 0, $3)`, [u, -n, next('spend')]);
async function studioOpen(user) {
  const order = await rpc(svc, 'vyora_payment_create_studio_order', {
    p_user_id: user, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML', p_flow: 'softpay',
    p_network: 'orange_ml', p_idempotency_key: next('key'), p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null });
  const payment = next('pay');
  await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: order.id, p_payment_id: payment, p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
  return { ...order, payment };
}
const settleStudio = (c, o) => rpc(c, 'vyora_payment_studio_settle', settleArgs(o.id, o.payment, '5000.00'));
const paidStudio = async (user) => { const o = await studioOpen(user); assert.equal((await settleStudio(svc, o)).outcome, 'paid'); return o; };
const refundStudio = (c, order, amount, partial = false, reason = 'Demande du client, double achat') =>
  rpc(c, 'vyora_admin_refund_studio', { p_order_id: order, p_reason: reason, p_refund_amount_xof: amount, p_allow_partial: partial });
const studioRow = (id) => one(`select * from saas_ugc.ugc_recharge_orders where id = $1`, [id]);

// 14. Consommation partielle : l'aperçu dit exactement ce qui a été attribué, consommé, repris.
const lena = await customer('lena');
const lena1 = await paidStudio(lena);
await spend(lena, 10);
v = await preview('studio', lena1.id);
assert.deepEqual([v.credits_granted, v.wallet_available, v.wallet_reserved, v.credits_recoverable, v.credits_unrecoverable, v.max_refund_xof, v.needs_partial],
  [27, 17, 0, 17, 10, 3148, true]);
await fails(refundStudio(asBoss, lena1.id, 5000, true), /refund_amount_out_of_bounds/, 'plein tarif après consommation');
await fails(refundStudio(asBoss, lena1.id, 3149, true), /refund_amount_out_of_bounds/, 'un franc de trop');
await fails(refundStudio(asBoss, lena1.id, 3148), /refund_credits_already_consumed/, 'partiel non confirmé');
assert.deepEqual(await wallet(lena), { a: 17, r: 0 });
r = await refundStudio(asBoss, lena1.id, 3148, true);
assert.deepEqual([r.refund_credits_recovered, r.refund_credits_unrecovered, r.refund_amount, r.refund_state], [17, 10, '3148.00', 'credits_recovered']);
assert.deepEqual(await wallet(lena), { a: 0, r: 0 }); assert.equal(await ledgerSum(lena), 0);
ok('10 crédits consommés sur 27 : 17 repris, 3 148 FCFA au plus, solde à 0 (jamais négatif), grand livre équilibré');

// 15. Consommation totale : rien à reprendre, rien à rendre par ce parcours.
const mona = await customer('mona');
const mona1 = await paidStudio(mona);
await spend(mona, 27);
v = await preview('studio', mona1.id);
assert.deepEqual([v.credits_recoverable, v.credits_unrecoverable, v.max_refund_xof, v.refundable, v.blocked], [0, 27, 0, false, 'refund_nothing_recoverable']);
await fails(refundStudio(asBoss, mona1.id, 1, true), /refund_nothing_recoverable/, 'tout consommé');
assert.equal((await studioRow(mona1.id)).status, 'paid'); assert.deepEqual(await wallet(mona), { a: 0, r: 0 });
ok('27 crédits consommés sur 27 → aucun remboursement, commande et solde inchangés');

// 16. Un seul crédit restant : le prorata arrondi à l'entier inférieur reste ≥ 1 FCFA.
const nora = await customer('nora');
const nora1 = await paidStudio(nora);
await spend(nora, 26);
v = await preview('studio', nora1.id);
assert.deepEqual([v.credits_recoverable, v.max_refund_xof, v.refundable], [1, 185, true]);
r = await refundStudio(asBoss, nora1.id, 185, true);
assert.equal(r.refund_credits_recovered, 1); assert.deepEqual(await wallet(nora), { a: 0, r: 0 });
ok('1 crédit restant sur 27 → 185 FCFA au plus (5 000 × 1 / 27, arrondi inférieur)');

// 17. Deux achats, des crédits consommés, deux remboursements au même instant.
const olga = await customer('olga');
const olga1 = await paidStudio(olga); const olga2 = await paidStudio(olga);
await spend(olga, 30);
assert.deepEqual(await wallet(olga), { a: 24, r: 0 });
res = await settled([refundStudio(asBoss, olga1.id, 4444, true), refundStudio(asBoss2, olga2.id, 4444, true)]);
assert.equal(res.filter((x) => x.outcome === 'refunded').length, 1, JSON.stringify(res));
assert.match(res.find((x) => x.error).error, /refund_nothing_recoverable/);
assert.equal(res.find((x) => x.outcome === 'refunded').refund_credits_recovered, 24);
assert.deepEqual(await wallet(olga), { a: 0, r: 0 }); assert.equal(await ledgerSum(olga), 0);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_recharge_orders where user_id = $1 and status = 'refunded'`, [olga]), 1);
ok('deux commandes, 24 crédits restants, deux remboursements simultanés → les mêmes crédits ne sont repris qu’une fois');

// 18. Remboursement d'un achat pendant qu'un autre achat est crédité.
const pia = await customer('pia');
const pia1 = await paidStudio(pia);
const pia2 = await studioOpen(pia);
res = await settled([refundStudio(asBoss, pia1.id, 5000), settleStudio(pool[0], pia2), settleStudio(pool[1], pia2)]);
assert.ok(res.every((x) => !x.error), JSON.stringify(res));
assert.equal(res[0].outcome, 'refunded'); assert.equal(res[0].refund_credits_recovered, 27);
assert.equal(res.slice(1).filter((x) => x.credited).length, 1);
assert.deepEqual(await wallet(pia), { a: 27, r: 0 }); assert.equal(await ledgerSum(pia), 27);
ok('remboursement d’un achat et crédit d’un autre au même instant → 27 crédits, grand livre équilibré');

// 19. Rafale : 4 remboursements + 6 dépenses simultanés sur les mêmes crédits.
const rita = await customer('rita');
const rita1 = await paidStudio(rita);
res = await settled([
  refundStudio(asBoss, rita1.id, 1, true), refundStudio(asBoss2, rita1.id, 1, true),
  ...pool.map((c) => spend(rita, 5, c).then(() => ({ spent: 5 }))),
]);
const spent = res.filter((x) => x.spent).length * 5;
const rw = await wallet(rita); const rRow = await studioRow(rita1.id);
assert.ok(rw.a >= 0 && rw.r >= 0, JSON.stringify(rw));
assert.equal(await ledgerSum(rita), rw.a);
if (rRow.status === 'refunded') {
  assert.equal(Number(rRow.refund_credits_recovered) + Number(rRow.refund_credits_unrecovered), 27);
  assert.equal(27 - spent - Number(rRow.refund_credits_recovered), rw.a);
} else {
  assert.equal(27 - spent, rw.a);
}
assert.equal(await count(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1 and operation_type = 'refund'`, [rita]), rRow.status === 'refunded' ? 1 : 0);
ok(`rafale remboursement × 2 + dépense × 6 → solde final ${rw.a} ≥ 0, attribués = consommés + repris + restants`);

// 20. Remboursement ENREGISTRÉ ≠ versement ATTESTÉ.
const sara = await customer('sara');
const asSara = await connectAs('authenticated', sara);
const sara1 = await paidStudio(sara);
r = await refundStudio(asBoss, sara1.id, 5000);
assert.deepEqual([r.status, r.refund_state, r.refund_settled_at ?? null, r.refund_external_reference ?? null], ['refunded', 'credits_recovered', null, null]);
let mine = (await rpc(asSara, 'vyora_my_payments', { p_product: 'studio', p_limit: 5 }))[0];
assert.deepEqual([mine.status, mine.refund_state, mine.refund_settled_at ?? null], ['refunded', 'credits_recovered', null]);
const notes = async (title) => count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = $2`, [sara, title]);
assert.deepEqual([await notes('Remboursement en cours'), await notes('Remboursement effectué')], [1, 0]);
let health = await rpc(asBoss, 'vyora_admin_payment_health', {});
const awaiting = health.refunds_awaiting_settlement;
assert.ok(awaiting >= 1);
const attest = (c, ref) => rpc(c, 'vyora_admin_refund_settle', { p_product: 'studio', p_order_id: sara1.id, p_external_reference: ref });
res = await settled([attest(asBoss, 'OM-REF-AAA-001'), attest(asBoss2, 'WAVE-REF-BBB-002')]);
assert.equal(res.filter((x) => x.refund_state === 'settled').length, 1, JSON.stringify(res));
assert.match(res.find((x) => x.error).error, /refund_already_settled/);
const kept = res.find((x) => !x.error).refund_external_reference;
assert.equal((await studioRow(sara1.id)).refund_external_reference, kept);
assert.deepEqual([await notes('Remboursement en cours'), await notes('Remboursement effectué')], [1, 1]);
health = await rpc(asBoss, 'vyora_admin_payment_health', {});
assert.equal(health.refunds_awaiting_settlement, awaiting - 1);
mine = (await rpc(asSara, 'vyora_my_payments', { p_product: 'studio', p_limit: 5 }))[0];
assert.equal(mine.refund_state, 'settled'); assert.ok(mine.refund_settled_at); assert.ok(!('refund_external_reference' in mine));
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_refund_settled' and target_id = $1`, [sara1.id]), 1);
ok('enregistré (crédits repris) puis attesté (référence du versement) : deux états distincts ; deux attestations simultanées → une seule référence');

// 21. Invariant global : aucun solde négatif, nulle part.
assert.equal(await count(`select count(*) n from saas_ugc.ugc_wallets where available_balance < 0 or reserved_balance < 0`), 0);
assert.equal(await count(`select count(*) n from saas_business.wallets where available_units < 0`), 0);
assert.equal(await count(
  `select count(*) n from saas_ugc.ugc_recharge_orders o where o.status = 'refunded'
    and (o.refund_amount_minor > o.amount_minor or o.refund_credits_recovered + o.refund_credits_unrecovered <> o.credits_to_grant
         or o.refund_amount_minor > floor(o.amount_minor::numeric * o.refund_credits_recovered / o.credits_to_grant))`), 0);
assert.equal(await count(`select count(*) n from saas_business.payment_orders o where o.status = 'refunded' and o.refund_amount_minor > o.amount_minor`), 0);
ok('invariants : aucun solde négatif ; aucun remboursement supérieur au prix payé ni au prorata des crédits repris');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Réconciliation — exécutions, anomalies, prérequis');
await admin.query(`update saas_ugc.vyora_payment_reconcile_runs set status = 'ok', finished_at = now() where status = 'running'`);
res = await settled(pool.map((c) => rpc(c, 'vyora_payment_reconcile_start', { p_source: 'audit' })));
assert.ok(res.every((x) => !x?.error), JSON.stringify(res));
assert.equal(res.filter((x) => x !== null).length, 1, JSON.stringify(res));
assert.equal(await count(`select count(*) n from saas_ugc.vyora_payment_reconcile_runs where status = 'running'`), 1);
await fails(admin.query(`insert into saas_ugc.vyora_payment_reconcile_runs(trigger_source) values ('forge')`), /vyora_payment_reconcile_runs_single_running_idx/, 'seconde exécution');
const runId = res.find((x) => x !== null);
await rpc(svc, 'vyora_payment_reconcile_finish', { p_run_id: runId, p_status: 'partial',
  p_counts: { checked: 0, settled: 0, closed: 0, errors: 0, swept: 0, anomalies: 1, sweep_done: true, detail: { sweep_blind: true, sweep_truncated: true, secret: 'x' } } });
ok('6 démarrages simultanés → une seule exécution ; une seconde exécution « en cours » est impossible en base');

const report = (kind, order = null, payment = null) => rpc(svc, 'vyora_payment_report_anomaly', {
  p_kind: kind, p_product: order ? 'business' : null, p_order_id: order, p_payment_id: payment, p_reference: null, p_details: { reason: 'audit' } });
const alerts = async (title) => count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1 and title = $2`, [boss, title]);
await admin.query(`delete from saas_ugc.vyora_payment_anomalies where kind = 'sweep_unreliable'`);
assert.equal(await report('subscription_conflict', cleoPro.id, cleoPro.payment), true);
assert.equal(await report('subscription_conflict', cleoPro.id, cleoPro.payment), false);
assert.equal(await report('sweep_unreliable'), true);
assert.equal(await report('sweep_unreliable'), false);
await fails(report('n_importe_quoi'), /vyora_payment_anomalies_kind_check/, 'genre inconnu');
assert.equal(await alerts('Paiement Business Grow encaissé mais non activable'), 1);
assert.equal(await alerts('Filet de sécurité SasPay incomplet'), 1);
ok('anomalies « encaissement non activable » et « filet incomplet » : une ligne, une alerte, même signalées plusieurs fois');

health = await rpc(asBoss, 'vyora_admin_payment_health', {});
assert.deepEqual(health.dispatch, { token_present: true, http_available: true });
const lastRun = health.runs.find((x) => x.id === runId);
assert.deepEqual([lastRun.status, lastRun.sweep_blind, lastRun.sweep_truncated], ['partial', true, true]);
assert.ok(!('detail' in lastRun)); assert.equal(JSON.stringify(health).includes('secret'), false);
assert.ok(health.anomalies.some((a) => a.kind === 'subscription_conflict' && a.order_id === cleoPro.id));
ok('vue d’exploitation : jeton présent (sans sa valeur), appel HTTP disponible, indicateurs du balayage');

summary();
await Promise.all([...pool, svc, asBoss, asBoss2, asSara].map((c) => c.end()));
await admin.end();
