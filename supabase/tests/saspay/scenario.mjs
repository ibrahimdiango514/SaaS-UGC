// Scénarios d'intégrité de la migration SasPay, exécutés sur PostgreSQL 17 réel.
import { client } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const svc = await connectAs('service_role');

async function newCustomer(email) {
  const { id } = await one(`insert into auth.users(email) values ($1) returning id`, [email]);
  await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [id]);
  await admin.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1)`, [id]);
  return id;
}
const alice = await newCustomer('alice@test.local');
const bob = await newCustomer('bob@test.local');
const { id: boss } = await one(`insert into auth.users(email) values ('boss@test.local') returning id`);
await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin')`, [boss]);
await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [boss]);

const studioOrder = (user, key, extra = {}) => rpc(svc, 'vyora_payment_create_studio_order', {
  p_user_id: user, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML',
  p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: key,
  p_quoted_fee: '100.00', p_quoted_total: '5100.00', p_quoted_fee_mode: 'ADD_ON', p_msisdn_masked: '+223••••••12', ...extra,
});
const settle = (c, product, order, o) => rpc(c, product === 'studio' ? 'vyora_payment_studio_settle' : 'vyora_payment_bg_settle', {
  p_order_id: order, p_payment_id: o.id ?? null, p_provider_status: o.status, p_requested_amount: o.amount ?? null,
  p_currency: o.currency ?? null, p_fee: o.fee ?? null, p_charged: o.charged ?? null, p_net: o.net ?? null,
  p_fee_mode: o.mode ?? null, p_reference: o.ref ?? null, p_source: o.source ?? 'verify', p_failure_code: o.failure ?? null,
});
const wallet = async (u) => Number((await one(`select available_balance b from saas_ugc.ugc_wallets where user_id = $1`, [u])).b);
const ledgerCount = async (u) => Number((await one(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1`, [u])).n);

console.log('Studio — configuration et création');
await fails(studioOrder(alice, 'key-disabled-0001'), /payments_disabled/, 'désactivé par défaut');
ok('paiement désactivé par défaut : aucune commande créée');
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);

const o1 = await studioOrder(alice, 'key-alice-0001');
assert.equal(o1.status, 'pending'); assert.equal(o1.amount, '5000.00'); assert.equal(o1.credits, 27);
assert.equal(o1.currency, 'XOF'); assert.equal(o1.country, 'ML'); assert.match(o1.internal_reference, /^VYS-[0-9A-F]{32}$/);
assert.equal(o1.reused, false); assert.equal(o1.quoted_total_amount, '5100.00');
ok('commande créée : montant et crédits issus de la grille serveur (5 000 XOF → 27 crédits)');

const o1b = await studioOrder(alice, 'key-alice-0001');
assert.equal(o1b.id, o1.id); assert.equal(o1b.reused, true);
ok('même clé d’idempotence → même commande (double clic)');
await fails(studioOrder(alice, 'key-alice-0001', { p_pack_key: 'pro_creator' }), /idempotency_key_reused/, 'clé réutilisée');
ok('clé réutilisée avec un autre produit → refus');

await fails(studioOrder(alice, 'key-alice-x001', { p_pack_key: 'inconnu' }), /unknown_pack/, 'pack inconnu');
await fails(studioOrder(alice, 'key-alice-x002', { p_country: 'FR' }), /payment_country_not_supported/, 'pays');
await fails(studioOrder(alice, 'key-alice-x003', { p_network: 'wave_sn' }), /payment_network_not_supported/, 'réseau');
await fails(studioOrder(alice, 'key-alice-x004', { p_flow: 'virement' }), /payment_flow_not_allowed/, 'parcours');
await fails(studioOrder(alice, 'short'), /invalid_idempotency_key/, 'clé invalide');
await fails(studioOrder(boss, 'key-boss-00001'), /not_vyora_customer/, 'admin');
ok('pack / pays / réseau / parcours / clé invalides et compte admin → refus');

const custom = (amount, key) => studioOrder(bob, key, { p_kind: 'custom', p_pack_key: null, p_amount_xof: amount, p_flow: 'checkout', p_network: null });
await fails(custom(4000, 'key-bob-c0001'), /custom_amount_out_of_bounds/, 'min');
await fails(custom(5500, 'key-bob-c0002'), /custom_amount_out_of_bounds/, 'pas');
await fails(custom(351000, 'key-bob-c0003'), /custom_amount_out_of_bounds/, 'max');
const c1 = await custom(7000, 'key-bob-c0004');
assert.equal(c1.amount, '7000.00'); assert.equal(c1.credits, 37); assert.equal(c1.network_code, null); assert.equal(c1.payment_flow, 'checkout');
ok('recharge libre : bornes et pas contrôlés, 7 000 XOF → 37 crédits (palier Creator)');

console.log('Studio — règlement');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set status = 'paid' where id = $1`, [o1.id]), /saspay_order_requires_verified_payment/, 'paid sans preuve');
ok('passage manuel à « payée » sans paiement vérifié → refusé par la base');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set amount_minor = 100 where id = $1`, [o1.id]), /recharge_order_identity_is_immutable/, 'montant');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set credits_to_grant = 9999 where id = $1`, [o1.id]), /recharge_order_identity_is_immutable/, 'crédits');
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set user_id = $2 where id = $1`, [o1.id, bob]), /recharge_order_identity_is_immutable/, 'utilisateur');
ok('montant, crédits et titulaire immuables');

const a1 = await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: o1.id, p_payment_id: 'pay_0001', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
assert.equal(a1.status, 'processing'); assert.equal(a1.provider_payment_id, 'pay_0001');
await fails(rpc(svc, 'vyora_payment_studio_attach', { p_order_id: o1.id, p_payment_id: 'pay_AUTRE', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' }), /provider_reference_conflict/, 'rattachement');
ok('identifiant SasPay rattaché une seule fois');

let r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'PENDING' });
assert.equal(r.outcome, 'pending'); assert.equal(r.credited, false); assert.equal(await wallet(alice), 0);
ok('statut PENDING → aucun crédit');
r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'SUCCESS', amount: '500.00', currency: 'XOF' });
assert.equal(r.outcome, 'amount_mismatch'); assert.equal(r.status, 'processing'); assert.equal(await wallet(alice), 0);
r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'SUCCESS', amount: '5000.00', currency: 'USD' });
assert.equal(r.outcome, 'amount_mismatch'); assert.equal(await wallet(alice), 0);
ok('SUCCESS avec montant ou devise différents → aucun crédit');
await fails(settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'PAID' }), /unknown_provider_status/, 'statut inconnu');
await fails(settle(svc, 'studio', o1.id, { id: 'pay_AUTRE', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' }), /provider_reference_conflict/, 'autre paiement');
ok('statut inconnu ou autre identifiant de paiement → refus');

r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'SUCCESS', amount: '5000.00', currency: 'XOF', fee: '100.00', charged: '5100.00', net: '5000.00', mode: 'ADD_ON', ref: 'SP-REF-1' });
assert.equal(r.outcome, 'paid'); assert.equal(r.credited, true); assert.equal(r.status, 'paid');
assert.equal(r.fee_amount, '100.00'); assert.equal(r.charged_amount, '5100.00'); assert.equal(r.net_amount, '5000.00');
assert.equal(await wallet(alice), 27); assert.equal(await ledgerCount(alice), 1);
ok('SUCCESS vérifié → commande payée, 27 crédits, une écriture au grand livre');
for (let i = 0; i < 3; i += 1) {
  r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'SUCCESS', amount: '5000.00', currency: 'XOF', source: 'webhook' });
  assert.equal(r.outcome, 'already_paid'); assert.equal(r.credited, false);
}
assert.equal(await wallet(alice), 27); assert.equal(await ledgerCount(alice), 1);
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_credit_purchases where recharge_order_id = $1`, [o1.id])).n), 1);
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_payment_events where recharge_order_id = $1`, [o1.id])).n), 1);
ok('rejeu (vérification + webhook ×3) → toujours 27 crédits, un seul événement, un seul achat');
r = await settle(svc, 'studio', o1.id, { id: 'pay_0001', status: 'FAILED' });
assert.equal(r.status, 'paid'); assert.equal(await wallet(alice), 27);
await fails(admin.query(`update saas_ugc.ugc_recharge_orders set status = 'pending' where id = $1`, [o1.id]), /paid_order_is_terminal/, 'terminal');
ok('commande payée : état terminal (un FAILED tardif ne la modifie pas)');

console.log('Studio — échec, annulation, réouverture, unicité');
const o2 = await studioOrder(alice, 'key-alice-0002');
await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: o2.id, p_payment_id: 'pay_0002', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
r = await settle(svc, 'studio', o2.id, { id: 'pay_0002', status: 'FAILED' });
assert.equal(r.status, 'failed'); assert.equal(r.outcome, 'failed'); assert.equal(await wallet(alice), 27);
ok('FAILED → commande échouée, aucun crédit');
r = await settle(svc, 'studio', o2.id, { id: 'pay_0002', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' });
assert.equal(r.outcome, 'paid'); assert.equal(await wallet(alice), 54);
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'saspay_order_reopened' and target_id = $1`, [o2.id])).n), 1);
ok('SUCCESS vérifié après un échec → commande rouverte, créditée une fois, tracée');

const o3 = await studioOrder(alice, 'key-alice-0003');
await fails(rpc(svc, 'vyora_payment_studio_attach', { p_order_id: o3.id, p_payment_id: 'pay_0001', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' }), /duplicate key|provider_reference_conflict/, 'paiement déjà utilisé');
ok('un paiement SasPay ne peut régler qu’une seule commande');
r = await settle(svc, 'studio', o3.id, { status: 'CANCELLED', failure: 'checkout_expired' });
assert.equal(r.status, 'cancelled'); assert.equal(r.failure_code, 'checkout_expired');
await fails(settle(svc, 'studio', o3.id, { status: 'SUCCESS', amount: '5000.00', currency: 'XOF' }), /payment_id_required/, 'success sans id');
ok('annulation enregistrée ; SUCCESS sans identifiant de paiement → refus');

console.log('Studio — concurrence');
const o4 = await studioOrder(bob, 'key-bob-00004');
await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: o4.id, p_payment_id: 'pay_0004', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
const conns = await Promise.all(Array.from({ length: 6 }, () => connectAs('service_role')));
const results = await Promise.all(conns.map((c) => settle(c, 'studio', o4.id, { id: 'pay_0004', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' })));
assert.equal(results.filter((x) => x.credited).length, 1);
assert.equal(results.filter((x) => x.outcome === 'already_paid').length, 5);
assert.equal(await wallet(bob), 27);
ok('6 règlements simultanés (webhook + vérifications) → un seul crédit');
const keyRace = await Promise.all(conns.map((c) => rpc(c, 'vyora_payment_create_studio_order', {
  p_user_id: bob, p_kind: 'pack', p_pack_key: 'pro_creator', p_amount_xof: null, p_country: 'ML', p_flow: 'softpay',
  p_network: 'moov_ml', p_idempotency_key: 'key-bob-race01', p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null })));
assert.equal(new Set(keyRace.map((x) => x.id)).size, 1); assert.equal(keyRace.filter((x) => !x.reused).length, 1);
ok('6 créations simultanées avec la même clé → une seule commande');
await Promise.all(conns.map((c) => c.end()));

console.log('Studio — plafond de commandes ouvertes, ancienne RPC');
await studioOrder(bob, 'key-bob-open02', { p_pack_key: 'pro_creator' });
await fails(studioOrder(bob, 'key-bob-open03'), /too_many_open_payments/, 'plafond');
ok('plafond de commandes en attente respecté (3)');
await fails(admin.query(`insert into saas_ugc.ugc_recharge_orders(user_id, amount_minor, currency, country_code, credits_to_grant, provider, idempotency_key) values ($1, 100, 'XOF', 'ML', 100000, 'saspay', 'forged-key-0001')`, [alice]), /saspay_order_requires_payment_service/, 'forge');
await admin.query(`insert into saas_ugc.ugc_recharge_orders(user_id, amount_minor, currency, country_code, credits_to_grant, provider, idempotency_key) values ($1, 500000, 'XOF', 'ML', 27, 'admin', 'manual-key-0001')`, [alice]);
ok('commande SasPay forgée hors service de paiement → refus ; commande manuelle « admin » toujours possible');

console.log('Droits');
const asAlice = await connectAs('authenticated', alice);
const asBob = await connectAs('authenticated', bob);
const asBoss = await connectAs('authenticated', boss);
const asAnon = await connectAs('anon');
for (const [fn, args] of [
  ['vyora_payment_create_studio_order', { p_user_id: alice, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: 'key-hack-0001' }],
  ['vyora_payment_studio_attach', { p_order_id: o3.id, p_payment_id: 'x', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' }],
  ['vyora_payment_get_order', { p_product: 'studio', p_order_id: o1.id }],
  ['vyora_payment_quote', { p_user_id: alice, p_product: 'studio', p_item: {} }],
  ['vyora_payment_record_webhook', { p_product: 'studio', p_event_key: 'transaction.success:x', p_event_type: 'transaction.success', p_payload: {} }],
  ['vyora_payment_is_admin', { p_user_id: alice }],
]) {
  await fails(rpc(asAlice, fn, args), /permission denied/, `authenticated ${fn}`);
  await fails(rpc(asAnon, fn, args), /permission denied/, `anon ${fn}`);
}
await fails(settle(asAlice, 'studio', o3.id, { id: 'pay_x', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' }), /permission denied/, 'settle authenticated');
await fails(settle(asAlice, 'business', o3.id, { id: 'pay_x', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' }), /permission denied/, 'bg settle authenticated');
ok('aucune fonction d’écriture ni aiguilleur exécutable par anon / authenticated');
await fails(asAlice.query(`select * from saas_business.payment_orders`), /permission denied/, 'table bg');
await fails(asAlice.query(`update saas_ugc.ugc_recharge_orders set status = 'paid'`), /permission denied/, 'table studio');
ok('tables de commandes inaccessibles en direct');

let mine = await rpc(asAlice, 'vyora_my_payments', { p_product: 'studio', p_limit: 30 });
assert.equal(mine.length, 3); assert.ok(mine.every((x) => x.user_id === undefined));
for (const field of ['provider_payment_id', 'provider_session_id', 'pricing_snapshot']) assert.ok(mine.every((x) => !(field in x)), field);
assert.ok(mine.every((x) => typeof x.has_payment === 'boolean')); assert.ok(mine.some((x) => x.has_payment === true));
const bobs = await rpc(asBob, 'vyora_my_payments', { p_product: 'studio', p_limit: 30 });
assert.ok(bobs.length >= 3); assert.ok(!bobs.some((x) => mine.some((m) => m.id === x.id)));
await fails(rpc(asAnon, 'vyora_my_payments', { p_product: 'studio', p_limit: 30 }), /permission denied/, 'anon my');
ok('historique : chacun ne voit que ses commandes');
await fails(rpc(asAlice, 'vyora_admin_payments', { p_product: 'studio', p_limit: 10 }), /forbidden/, 'admin payments');
const all = await rpc(asBoss, 'vyora_admin_payments', { p_product: 'studio', p_limit: 100 });
assert.ok(all.length >= 6); assert.ok(all.some((x) => x.user_email === 'alice@test.local'));
ok('vue administrateur réservée aux administrateurs');

console.log('Webhooks');
let w = await rpc(svc, 'vyora_payment_record_webhook', { p_product: 'studio', p_event_key: 'transaction.success:pay_0001', p_event_type: 'transaction.success', p_payload: { id: 'pay_0001' } });
assert.deepEqual(w, { first: true, processed: false });
w = await rpc(svc, 'vyora_payment_record_webhook', { p_product: 'studio', p_event_key: 'transaction.success:pay_0001', p_event_type: 'transaction.success', p_payload: {} });
assert.deepEqual(w, { first: false, processed: false });
await rpc(svc, 'vyora_payment_finish_webhook', { p_product: 'studio', p_event_key: 'transaction.success:pay_0001', p_ok: true, p_error: null });
w = await rpc(svc, 'vyora_payment_record_webhook', { p_product: 'studio', p_event_key: 'transaction.success:pay_0001', p_event_type: 'transaction.success', p_payload: {} });
assert.deepEqual(w, { first: false, processed: true });
ok('webhook dupliqué détecté ; un événement traité n’est pas rejoué');
assert.deepEqual(await rpc(svc, 'vyora_payment_find_order', { p_payment_id: 'pay_0001', p_session_id: null }), { product: 'studio', order_id: o1.id });
assert.equal(await rpc(svc, 'vyora_payment_find_order', { p_payment_id: 'pay_inconnu', p_session_id: null }), null);
ok('rapprochement paiement → commande');

console.log('Business Grow');
const { id: carol } = await one(`insert into auth.users(email) values ('carol@test.local') returning id`);
const bgOrder = (user, key, plan = 'croissance', extra = {}) => rpc(svc, 'vyora_payment_create_bg_order', {
  p_user_id: user, p_plan_key: plan, p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml', p_idempotency_key: key,
  p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: null, ...extra });
let q = await rpc(svc, 'vyora_payment_quote', { p_user_id: carol, p_product: 'business', p_item: { plan_key: 'croissance' } });
assert.equal(q.eligible, false); assert.equal(q.reason, 'business_billing_disabled'); assert.equal(q.price, null);
await fails(bgOrder(carol, 'key-carol-0001'), /business_billing_disabled/, 'bg désactivé');
ok('facturation Business Grow désactivée (état de production) → aucun achat possible');
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await fails(bgOrder(carol, 'key-carol-0001'), /business_plan_not_purchasable/, 'formule sans prix');
ok('formule sans prix ni activation → non achetable');
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 60000, monthly_credit_units = 1200 where plan_key = 'scale'`);
q = await rpc(svc, 'vyora_payment_quote', { p_user_id: carol, p_product: 'business', p_item: { plan_key: 'croissance' } });
assert.equal(q.eligible, true); assert.equal(q.price.amount, '25000.00'); assert.equal(q.price.period_days, 30);

const b1 = await bgOrder(carol, 'key-carol-0001');
assert.equal(b1.amount, '25000.00'); assert.equal(b1.status, 'pending'); assert.match(b1.internal_reference, /^VYB-/); assert.equal(b1.product, 'business');
await rpc(svc, 'vyora_payment_bg_attach', { p_order_id: b1.id, p_payment_id: 'pay_b001', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
await fails(admin.query(`update saas_business.payment_orders set status = 'paid', paid_at = now() where id = $1`, [b1.id]), /saspay_order_requires_verified_payment/, 'bg paid sans preuve');
await fails(admin.query(`update saas_business.payment_orders set amount_minor = 1 where id = $1`, [b1.id]), /payment_order_identity_is_immutable/, 'bg montant');
ok('commande Business Grow : montant immuable, « payée » impossible sans preuve');
r = await settle(svc, 'business', b1.id, { id: 'pay_b001', status: 'SUCCESS', amount: '2500.00', currency: 'XOF' });
assert.equal(r.outcome, 'amount_mismatch');
assert.equal(Number((await one(`select count(*) n from saas_business.subscriptions where user_id = $1`, [carol])).n), 0);
ok('montant différent → aucun abonnement activé');
const studioBefore = await one(`select (select count(*) from saas_ugc.ugc_credit_ledger) l, (select coalesce(sum(available_balance),0) from saas_ugc.ugc_wallets) w`);
r = await settle(svc, 'business', b1.id, { id: 'pay_b001', status: 'SUCCESS', amount: '25000.00', currency: 'XOF', fee: '0.00', charged: '25000.00', net: '24500.00', mode: 'DEDUCTED' });
assert.equal(r.outcome, 'paid'); assert.equal(r.status, 'paid'); assert.equal(r.net_amount, '24500.00');
let sub = await one(`select *, extract(epoch from current_period_end - now())/86400 as days from saas_business.subscriptions where user_id = $1`, [carol]);
assert.equal(sub.status, 'active'); assert.equal(sub.plan_key, 'croissance'); assert.equal(sub.billing_provider, 'saspay');
assert.ok(Math.abs(Number(sub.days) - 30) < 0.01);
let bw = await one(`select available_units, monthly_allowance from saas_business.wallets where user_id = $1`, [carol]);
assert.equal(bw.available_units, 400); assert.equal(bw.monthly_allowance, 400);
ok('SUCCESS vérifié → abonnement actif 30 jours, quota mensuel de la formule appliqué');
const studioAfter = await one(`select (select count(*) from saas_ugc.ugc_credit_ledger) l, (select coalesce(sum(available_balance),0) from saas_ugc.ugc_wallets) w`);
assert.deepEqual(studioAfter, studioBefore);
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_wallets where user_id = $1`, [carol])).n), 0);
ok('un paiement Business Grow ne touche ni le grand livre ni les portefeuilles Studio');
assert.equal(Number((await one(`select count(*) n from saas_business.wallets where user_id in ($1, $2)`, [alice, bob])).n), 0);
ok('les paiements Studio n’ont créé aucun portefeuille Business Grow');
r = await settle(svc, 'business', b1.id, { id: 'pay_b001', status: 'SUCCESS', amount: '25000.00', currency: 'XOF', source: 'webhook' });
assert.equal(r.outcome, 'already_paid');
sub = await one(`select extract(epoch from current_period_end - now())/86400 as days from saas_business.subscriptions where user_id = $1`, [carol]);
assert.ok(Math.abs(Number(sub.days) - 30) < 0.01);
assert.equal(Number((await one(`select count(*) n from saas_business.billing_events`)).n), 1);
ok('rejeu → période inchangée, un seul événement de facturation');

await fails(bgOrder(carol, 'key-carol-0002', 'scale'), /business_plan_change_not_supported/, 'changement de formule');
q = await rpc(svc, 'vyora_payment_quote', { p_user_id: carol, p_product: 'business', p_item: { plan_key: 'scale' } });
assert.equal(q.eligible, false); assert.equal(q.reason, 'business_plan_change_not_supported');
ok('autre formule pendant une période en cours → refus explicite (pas de perte silencieuse)');
const b2 = await bgOrder(carol, 'key-carol-0003', 'croissance', { p_flow: 'checkout', p_network: null });
await rpc(svc, 'vyora_payment_bg_attach', { p_order_id: b2.id, p_payment_id: null, p_session_id: 'cs_b002', p_checkout_url: 'https://pay.saspay.me/c/x', p_provider_status: 'PENDING' });
assert.deepEqual(await rpc(svc, 'vyora_payment_open_checkout_orders', { p_limit: 10 }), [{ product: 'business', order_id: b2.id, session_id: 'cs_b002' }]);
r = await settle(svc, 'business', b2.id, { id: 'pay_b002', status: 'SUCCESS', amount: '25000.00', currency: 'XOF' });
assert.equal(r.outcome, 'paid');
const subs = (await admin.query(`select id, extract(epoch from current_period_end - now())/86400 as days from saas_business.subscriptions where user_id = $1`, [carol])).rows;
assert.equal(subs.length, 1); assert.ok(Math.abs(Number(subs[0].days) - 60) < 0.01);
assert.equal(r.subscription_id, subs[0].id);
ok('renouvellement de la même formule → même abonnement prolongé à 60 jours');
const conns2 = await Promise.all(Array.from({ length: 5 }, () => connectAs('service_role')));
const b3 = await bgOrder(carol, 'key-carol-0004');
await rpc(svc, 'vyora_payment_bg_attach', { p_order_id: b3.id, p_payment_id: 'pay_b003', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
const res2 = await Promise.all(conns2.map((c) => settle(c, 'business', b3.id, { id: 'pay_b003', status: 'SUCCESS', amount: '25000.00', currency: 'XOF' })));
assert.equal(res2.filter((x) => x.credited).length, 1);
sub = await one(`select extract(epoch from current_period_end - now())/86400 as days from saas_business.subscriptions where user_id = $1`, [carol]);
assert.ok(Math.abs(Number(sub.days) - 90) < 0.01);
await Promise.all(conns2.map((c) => c.end()));
ok('5 règlements simultanés d’un renouvellement → une seule prolongation');

const asCarol = await connectAs('authenticated', carol);
const cs = await rpc(asCarol, 'vyora_business_subscription', {});
assert.equal(cs.plan_key, 'croissance'); assert.equal(cs.is_current, true);
assert.equal(await rpc(asAlice, 'vyora_business_subscription', {}), null);
assert.equal((await rpc(asCarol, 'vyora_my_payments', { p_product: 'business', p_limit: 30 })).length, 3);
assert.equal((await rpc(asAlice, 'vyora_my_payments', { p_product: 'business', p_limit: 30 })).length, 0);
assert.equal((await rpc(asCarol, 'vyora_my_payments', { p_product: 'studio', p_limit: 30 })).length, 0);
ok('lectures Business Grow cloisonnées par utilisateur et par produit');
assert.equal(await rpc(svc, 'vyora_payment_get_order', { p_product: 'studio', p_order_id: b1.id }), null);
assert.equal(await rpc(svc, 'vyora_payment_get_order', { p_product: 'business', p_order_id: o1.id }), null);
await fails(settle(svc, 'studio', b1.id, { id: 'pay_b001', status: 'SUCCESS', amount: '25000.00', currency: 'XOF' }), /payment_order_not_found/, 'croisé');
await fails(settle(svc, 'business', o3.id, { id: 'pay_z', status: 'SUCCESS', amount: '5000.00', currency: 'XOF' }), /payment_order_not_found/, 'croisé 2');
ok('une commande d’un produit est introuvable depuis l’autre');

summary();
for (const c of [svc, asAlice, asBob, asBoss, asAnon, asCarol, admin]) await c.end();
