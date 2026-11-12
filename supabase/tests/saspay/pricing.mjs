// Tarification, provision et rapprochement financier (migration
// `20261113120000_vyora_pricing_margin.sql`) sur PostgreSQL 17 réel.
// Indépendant des autres scénarios ; remet la configuration dans l'état trouvé.
import { readFileSync } from 'node:fs';
import { client } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const svc = await connectAs('service_role');
const tag = `p${Date.now().toString(36)}`;
// Début du scénario : les rapports filtrés sur cette borne ignorent les paiements des scénarios précédents du banc.
const T0 = (await one(`select clock_timestamp() as t`)).t.toISOString();
const { vectors } = JSON.parse(readFileSync(new URL('./pricing-vectors.json', import.meta.url), 'utf8'));

const saved = {
  payment: (await one(`select setting_value v from saas_ugc.ugc_app_settings where setting_key = 'saspay_payment_config'`)).v,
  policy: (await one(`select setting_value v from saas_ugc.ugc_app_settings where setting_key = 'vyora_pricing_policy'`)).v,
};
const COUNTRIES = {
  ML: { name: 'Mali', currency: 'XOF', dial_code: '223', national_number_length: 8,
    networks: [{ code: 'orange_ml', label: 'Orange Money' }, { code: 'moov_ml', label: 'Moov Money' }, { code: 'mobi_cash_ml', label: 'Mobi Cash' }] },
  CI: { name: 'Côte d’Ivoire', currency: 'XOF', dial_code: '225', national_number_length: 10,
    networks: [{ code: 'orange_ci', label: 'Orange Money' }, { code: 'mtn_ci', label: 'MTN MoMo' }] },
  SN: { name: 'Sénégal', currency: 'XOF', dial_code: '221', national_number_length: 9,
    networks: [{ code: 'orange_sn', label: 'Orange Money' }, { code: 'wave_sn', label: 'Wave' }] },
};
const setPayment = (patch) => admin.query(
  `update saas_ugc.ugc_app_settings set setting_value = setting_value || $1::jsonb where setting_key = 'saspay_payment_config'`, [JSON.stringify(patch)]);
const setPolicy = (p) => admin.query(
  `update saas_ugc.ugc_app_settings set setting_value = $1::jsonb where setting_key = 'vyora_pricing_policy'`,
  [JSON.stringify({ enabled: p.enabled, strategy: p.strategy, fee_charge_mode: 'DEDUCTED',
    currencies: { XOF: { provision_cents: p.provision, rounding_step_cents: p.step } } })]);
const DEFAULT = { enabled: true, strategy: 'cover_fees', provision: 100000, step: 100 };
// Le barème n'accepte ni modification ni suppression : seul le propriétaire de la base peut le vider (banc).
const clearLines = () => admin.query(`truncate saas_ugc.vyora_fee_schedule`);
async function addLine(l) {
  const d = { type: 'payin', country: 'ML', network: null, min: 0, max: null, percent_milli: 0, fixed: 0, floor: null, cap: null,
    fee_base: 'total', from_days: -2, until_days: null, source: 'owner_provided', mode: null, ...l };
  return (await one(
    `insert into saas_ugc.vyora_fee_schedule(transaction_type, country_code, currency, network_code, min_amount_cents, max_amount_cents,
       percent_milli, fixed_cents, floor_fee_cents, cap_fee_cents, fee_base, valid_from, valid_until, source, source_note, account_fee_mode)
     values ($1, $2, 'XOF', $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11),
             case when $12::int is null then null else now() + make_interval(days => $12::int) end, $13, 'Tarif de test du banc', $14) returning id`,
    [d.type, d.country, d.network, d.min, d.max, d.percent_milli, d.fixed, d.floor, d.cap, d.fee_base, d.from_days, d.until_days, d.source, d.mode])).id;
}
const quote = async (base, country = 'ML', network = null) =>
  (await one(`select ugc_private.vyora_price_quote('studio', $1, 'XOF', $2, $3) q`, [base, country, network])).q;

await setPayment({ enabled: true, flows: ['softpay'], countries: COUNTRIES, max_open_orders: 50 });
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);
await clearLines();

let seq = 0;
const next = (p) => `${p}-${tag}-${String(++seq).padStart(4, '0')}`;
const person = async (name) => (await one(`insert into auth.users(email) values ($1) returning id`, [`${name}-${tag}@test.local`])).id;
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
const asAnon = await connectAs('anon');

const studio = (user, o = {}) => rpc(svc, 'vyora_payment_create_studio_order', {
  p_user_id: user, p_kind: o.kind ?? 'pack', p_pack_key: o.kind === 'custom' ? null : (o.pack ?? 'creator'), p_amount_xof: o.amount ?? null,
  p_country: o.country ?? 'ML', p_flow: o.flow ?? 'softpay', p_network: o.flow === 'checkout' ? null : (o.network ?? 'orange_ml'),
  p_idempotency_key: o.key ?? next('key'),
  // Ancienne estimation du navigateur (frais en sus) : ignorée sous la politique de prix.
  p_quoted_fee: '100.00', p_quoted_total: '5100.00', p_quoted_fee_mode: 'ADD_ON', p_msisdn_masked: '+223••••••12' });
const business = (user, o = {}) => rpc(svc, 'vyora_payment_create_bg_order', {
  p_user_id: user, p_plan_key: 'croissance', p_country: o.country ?? 'ML', p_flow: 'softpay', p_network: o.network ?? 'orange_ml',
  p_idempotency_key: o.key ?? next('key'), p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: '+223••••••12' });
const settle = (product, order, payment, o = {}) => rpc(svc, product === 'studio' ? 'vyora_payment_studio_settle' : 'vyora_payment_bg_settle', {
  p_order_id: order.id, p_payment_id: payment, p_provider_status: o.status ?? 'SUCCESS',
  p_requested_amount: o.requested === undefined ? order.amount : o.requested, p_currency: o.currency === undefined ? 'XOF' : o.currency,
  p_fee: o.fee ?? null, p_charged: o.charged === undefined ? order.amount : o.charged, p_net: o.net === undefined ? null : o.net,
  p_fee_mode: o.mode === undefined ? 'DEDUCTED' : o.mode, p_reference: null, p_source: o.source ?? 'verify', p_failure_code: o.failure ?? null });
const table = (product) => (product === 'studio' ? 'saas_ugc.ugc_recharge_orders' : 'saas_business.payment_orders');
const row = (product, order) => one(`select * from ${table(product)} where id = $1`, [order.id]);
const ledger = async (order) => (await admin.query(`select * from saas_ugc.vyora_payment_reconciliations where order_id = $1 order by revision`, [order.id])).rows;
const anomalies = async (order) => (await admin.query(`select kind from saas_ugc.vyora_payment_anomalies where order_id = $1 order by kind`, [order.id])).rows.map((r) => r.kind);
const balance = async (user) => Number((await one(`select available_balance b from saas_ugc.ugc_wallets where user_id = $1`, [user])).b);
const n = (v) => (v === null ? null : Number(v));

// ─────────────────────────────────────────────────────────────────────────────
console.log('Calcul du prix — vecteurs communs avec le moteur TypeScript');
for (const v of vectors) {
  await setPolicy(v.policy);
  await setPayment({ flows: v.flows, countries: { ...COUNTRIES, ML: { ...COUNTRIES.ML, networks: v.configured.map((code) => ({ code, label: code })) } } });
  await clearLines();
  for (const l of v.lines) await addLine(l);
  const q = await quote(v.base, v.country, v.network);
  const got = { final: q.final_cents, fee: q.estimated_fee_cents, net: q.expected_net_cents, margin: q.expected_margin_cents, pricing_fee: q.pricing_fee_cents, status: q.tariff_status };
  assert.deepEqual(got, v.expect, `${v.name} : ${JSON.stringify(q)}`);
  assert.equal(q.base_cents, v.base); assert.equal(q.surcharge_cents, q.final_cents - v.base);
  assert.equal(q.fee_charge_mode, v.policy.enabled ? 'DEDUCTED' : null);
  ok(v.name);
}
await setPolicy(DEFAULT);
await setPayment({ flows: ['softpay'], countries: COUNTRIES });
await clearLines();

// ─────────────────────────────────────────────────────────────────────────────
console.log('Devis client : prix final clair, aucun détail interne');

const awa = await customer('awa');
let q = await rpc(svc, 'vyora_payment_quote', { p_user_id: awa, p_product: 'studio', p_item: { kind: 'pack', pack_key: 'creator' } });
assert.equal(q.price.amount, '6000.00'); assert.equal(q.price.credits, 27); assert.equal(q.all_inclusive, true);
assert.deepEqual(Object.keys(q.countries).sort(), ['CI', 'ML', 'SN']);
for (const c of ['CI', 'ML', 'SN']) assert.deepEqual(q.countries[c].price, { amount: '6000.00', currency: 'XOF' });
assert.doesNotMatch(JSON.stringify(q), /provision|base_cents|estimated_fee|expected_net|tariff/);
ok('pack à 5 000 FCFA affiché 6 000 FCFA dans chaque pays ; ni provision ni frais transmis au navigateur');

// Tarifs différents selon le pays : chaque pays a son prix final.
await addLine({ country: 'CI', network: 'orange_ci', percent_milli: 2500 });
await addLine({ country: 'CI', network: 'mtn_ci', percent_milli: 1500 });
await addLine({ country: 'SN', network: 'wave_sn', percent_milli: 1000 });
await addLine({ country: 'SN', network: 'orange_sn', fixed: 150000 });
q = await rpc(svc, 'vyora_payment_quote', { p_user_id: awa, p_product: 'studio', p_item: { kind: 'pack', pack_key: 'studio_business' } });
// 35 000 de base. ML : aucun tarif → 36 000. CI : 2,5 % de 36 000 = 900 < 1 000 → 36 000. SN : fixe 1 500 → 36 500.
assert.equal(q.countries.ML.price.amount, '36000.00');
assert.equal(q.countries.CI.price.amount, '36000.00');
assert.equal(q.countries.SN.price.amount, '36500.00');
ok('prix final par pays : 36 000 (Mali, sans tarif), 36 000 (Côte d’Ivoire, 2,5 %), 36 500 (Sénégal, fixe 1 500)');

q = await rpc(svc, 'vyora_payment_quote', { p_user_id: awa, p_product: 'studio', p_item: {} });
assert.equal(q.price, null);
assert.deepEqual(q.catalog.creator, { amount: '6000.00', max_amount: '6500.00', currency: 'XOF' });
assert.deepEqual(q.catalog.studio_business, { amount: '36000.00', max_amount: '36500.00', currency: 'XOF' });
q = await rpc(svc, 'vyora_payment_quote', { p_user_id: awa, p_product: 'business', p_item: {} });
assert.deepEqual(q.catalog.croissance, { amount: '26000.00', max_amount: '26500.00', currency: 'XOF' });
ok('catalogue des prix finals (fourchette entre pays) pour les pages de tarifs, Studio et Business Grow');

q = await rpc(svc, 'vyora_payment_quote', { p_user_id: awa, p_product: 'studio', p_item: { kind: 'custom', amount_xof: 10000 } });
assert.equal(q.price.amount, '11000.00'); assert.equal(q.price.credits, 54);
ok('recharge libre de 10 000 FCFA de crédits : 54 crédits (inchangé), 11 000 FCFA à payer');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Commandes : prix final figé');

const a1 = await studio(awa);
let r = await row('studio', a1);
assert.equal(a1.amount, '6000.00'); assert.equal(Number(r.amount_minor), 600000); assert.equal(Number(r.credits_to_grant), 27);
assert.equal(a1.requested_fee_mode, 'DEDUCTED'); assert.equal(a1.quoted_fee_mode, 'DEDUCTED');
assert.equal(a1.quoted_total_amount, '6000.00'); assert.equal(a1.quoted_fee_amount, null);
assert.equal(r.pricing_quote.base_cents, 500000); assert.equal(r.pricing_quote.provision_cents, 100000);
assert.equal(r.pricing_quote.final_cents, 600000); assert.equal(r.pricing_quote.tariff_status, 'missing');
ok('Studio : commande de 6 000 FCFA (base 5 000 + provision 1 000), devis figé, mode « Déduits » demandé, estimation du navigateur ignorée');

const bob = await person('bob');
const b1 = await business(bob);
r = await row('business', b1);
assert.equal(b1.amount, '26000.00'); assert.equal(Number(r.amount_minor), 26000);
assert.equal(r.pricing_quote.base_cents, 2500000); assert.equal(r.pricing_quote.final_cents, 2600000);
assert.equal(b1.requested_fee_mode, 'DEDUCTED');
ok('Business Grow : formule à 25 000 FCFA facturée 26 000 FCFA, devis figé');

const cleo = await customer('cleo');
const c1 = await studio(cleo, { country: 'SN', network: 'wave_sn', pack: 'pro_creator' });
const c2 = await studio(cleo, { country: 'SN', network: 'orange_sn', pack: 'pro_creator' });
// 15 000 de base, Sénégal : Orange fixe 1 500 → prix 16 500 pour tous ; estimation propre à l'opérateur.
assert.equal(c1.amount, '16500.00'); assert.equal(c2.amount, '16500.00');
assert.equal((await row('studio', c1)).pricing_quote.estimated_fee_cents, 16500);      // Wave 1 % de 16 500
assert.equal((await row('studio', c2)).pricing_quote.estimated_fee_cents, 150000);     // Orange 1 500
assert.equal((await row('studio', c2)).pricing_quote.expected_net_cents, 1500000);     // net = base
assert.equal(c1.quoted_fee_amount, '165.00');
ok('même prix quel que soit l’opérateur (16 500 FCFA) ; frais estimés propres à chacun ; net attendu ≥ base');

await setPayment({ flows: ['softpay', 'checkout'] });
const c3 = await studio(cleo, { country: 'SN', flow: 'checkout', pack: 'pro_creator' });
assert.equal(c3.amount, '16500.00');
assert.equal((await row('studio', c3)).pricing_quote.estimated_fee_cents, 150000);
await setPayment({ flows: ['softpay'] });
ok('page hébergée (opérateur inconnu) : même prix, estimation au pire cas');

const dan = await customer('dan');
const d1 = await studio(dan, { kind: 'custom', amount: 10000 });
assert.equal(d1.amount, '11000.00'); assert.equal(d1.credits, 54);
ok('recharge libre : crédits calculés sur le prix de base, commande au prix final');

// Rejeu de la même intention après un changement de politique : même commande, même prix.
const key = next('key');
const e0 = await studio(dan, { key });
await setPolicy({ ...DEFAULT, provision: 250000 });
const e1 = await studio(dan, { key });
assert.equal(e1.id, e0.id); assert.equal(e1.reused, true); assert.equal(e1.amount, '6000.00'); assert.equal(e1.requested_fee_mode, 'DEDUCTED');
const e2 = await studio(dan);
assert.equal(e2.amount, '7500.00');
await setPolicy(DEFAULT);
await fails(studio(dan, { key, pack: 'pro_creator' }), /idempotency_key_reused/, 'clé réutilisée pour un autre article');
ok('rejeu après changement de provision : commande et prix d’origine ; nouvelle commande au nouveau prix ; clé non réutilisable pour un autre article');

await fails(admin.query(`update saas_ugc.ugc_recharge_orders set pricing_quote = pricing_quote || '{"base_cents": 1}' where id = $1`, [a1.id]),
  /pricing_quote_is_immutable/, 'devis Studio modifié');
await fails(admin.query(`update saas_business.payment_orders set pricing_quote = null where id = $1`, [b1.id]),
  /pricing_quote_is_immutable/, 'devis Business Grow effacé');
ok('devis immuable après création, y compris pour le propriétaire de la base');

await fails(setPolicy({ ...DEFAULT, enabled: true }).then(() => admin.query(
  `update saas_ugc.ugc_app_settings set setting_value = setting_value #- '{currencies,XOF}' where setting_key = 'vyora_pricing_policy'`))
  .then(() => studio(dan)), /pricing_currency_not_configured/, 'devise sans provision');
await setPolicy(DEFAULT);
ok('devise sans provision paramétrée : vente refusée plutôt que provision inventée');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Rapprochement après confirmation');

const payA = next('pay');
await settle('studio', a1, payA, { status: 'PENDING' });
assert.equal((await ledger(a1)).length, 0); assert.equal(await balance(awa), 0);
ok('paiement en attente : ni crédit ni ligne de rapprochement');

const f1 = await studio(awa);
let s = await settle('studio', f1, next('pay'), { status: 'FAILED', failure: 'provider_failed' });
assert.equal(s.credited, false); assert.equal((await ledger(f1)).length, 0);
const f2 = await studio(awa);
await rpc(svc, 'vyora_payment_housekeeping', {});
assert.equal((await ledger(f2)).length, 0); assert.equal(await balance(awa), 0);
ok('paiement échoué ou abandonné : ni crédit ni ligne de rapprochement');

// Encaissement de l'ANCIEN prix (5 000) pour une commande à 6 000 : refusé.
const g1 = await studio(awa);
s = await settle('studio', g1, next('pay'), { requested: '5000.00', charged: '5000.00', net: '4900.00' });
assert.equal(s.outcome, 'amount_mismatch'); assert.equal(s.credited, false);
assert.equal(await balance(awa), 0); assert.equal((await ledger(g1)).length, 0);
s = await settle('studio', await studio(awa), next('pay'), { currency: 'XAF', net: '5900.00' });
assert.equal(s.outcome, 'amount_mismatch'); assert.equal(await balance(awa), 0);
ok('SUCCESS au prix de base (5 000 au lieu de 6 000) ou dans une autre devise : rien livré, rien rapproché');

// Frais réels inférieurs à la provision.
s = await settle('studio', a1, payA, { net: '5850.00' });
assert.equal(s.credited, true); assert.equal(await balance(awa), 27);
let l = await ledger(a1);
assert.equal(l.length, 1);
assert.deepEqual(
  { base: n(l[0].base_cents), prov: n(l[0].provision_cents), final: n(l[0].final_cents), charged: n(l[0].charged_cents),
    fee: n(l[0].actual_fee_cents), net: n(l[0].actual_net_cents), margin: n(l[0].margin_cents), covers: l[0].provision_covers_fee,
    est: n(l[0].estimated_fee_cents), variance: n(l[0].fee_variance_cents), flags: l[0].flags, product: l[0].product,
    item: l[0].item_key, country: l[0].country_code, network: l[0].network_code, rev: l[0].revision },
  { base: 500000, prov: 100000, final: 600000, charged: 600000, fee: 15000, net: 585000, margin: 85000, covers: true,
    est: null, variance: null, flags: ['tariff_missing'], product: 'studio', item: 'creator', country: 'ML', network: 'orange_ml', rev: 1 });
assert.deepEqual(await anomalies(a1), []);
// Le client voit ce qu'il a payé ; ni les frais ni le net reçu par VYORA.
const asAwa = await connectAs('authenticated', awa);
const mineA = (await rpc(asAwa, 'vyora_my_payments', { p_product: 'studio', p_limit: 50 })).find((x) => x.id === a1.id);
assert.equal(mineA.amount, '6000.00'); assert.equal(mineA.status, 'paid'); assert.equal(mineA.charged_amount, '6000.00');
for (const hidden of ['net_amount', 'fee_amount', 'quoted_fee_amount', 'pricing_quote', 'user_id']) assert.equal(hidden in mineA, false, hidden);
await asAwa.end();
ok('frais réels de 150 FCFA (< provision) : encaissé 6 000, net 5 850, marge 850, provision suffisante, aucune alerte ; le client ne voit que le prix payé');

// Événement rejoué : même paiement confirmé une seconde fois (webhook renvoyé, réconciliation).
s = await settle('studio', a1, payA, { net: '5850.00', source: 'webhook' });
assert.equal(s.credited, false); assert.equal(await balance(awa), 27);
await settle('studio', a1, payA, { net: '5850.00', source: 'reconcile' });
assert.equal((await ledger(a1)).length, 1); assert.equal(await balance(awa), 27);
ok('confirmation rejouée deux fois : aucun second crédit, une seule ligne de rapprochement');

// Frais réels égaux à la provision.
const h1 = await studio(awa);
await settle('studio', h1, next('pay'), { net: '5000.00' });
l = await ledger(h1);
assert.deepEqual([n(l[0].actual_fee_cents), n(l[0].margin_cents), l[0].provision_covers_fee], [100000, 0, true]);
assert.deepEqual(await anomalies(h1), []);
ok('frais réels de 1 000 FCFA (= provision) : marge nulle, net = prix de base, aucune alerte');

// Frais réels supérieurs à la provision : alerte administrateur.
const notifBefore = await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1`, [boss]);
const i1 = await studio(awa);
const payI = next('pay');
s = await settle('studio', i1, payI, { net: '4800.00' });
assert.equal(s.credited, true);
l = await ledger(i1);
assert.deepEqual([n(l[0].actual_fee_cents), n(l[0].margin_cents), l[0].provision_covers_fee], [120000, -20000, false]);
assert.deepEqual(l[0].flags, ['tariff_missing', 'fee_exceeds_provision', 'net_below_base']);
assert.deepEqual(await anomalies(i1), ['fee_exceeds_provision', 'net_below_base']);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1`, [boss]), notifBefore + 2);
await settle('studio', i1, payI, { net: '4800.00', source: 'webhook' });
assert.equal(await count(`select count(*) n from saas_ugc.ugc_notifications where user_id = $1`, [boss]), notifBefore + 2);
assert.equal((await ledger(i1)).length, 1);
ok('frais réels de 1 200 FCFA (> provision) : client livré, marge −200, administrateur alerté une seule fois même si l’événement est rejoué');

// Tarif connu et prix relevé au devis : les frais dépassent 1 000 FCFA mais le prix les couvre → aucune alerte.
await addLine({ country: 'ML', network: 'moov_ml', percent_milli: 2500 });
const j0 = await quote(10000000, 'ML', 'moov_ml');
assert.equal(j0.final_cents, 10256500);
await admin.query(`update saas_business.plans set monthly_price_minor = 100000 where plan_key = 'croissance'`);
const eve = await person('eve');
const j1 = await business(eve, { network: 'moov_ml' });
assert.equal(j1.amount, '102565.00'); assert.equal(j1.quoted_fee_amount, '2564.13');
s = await settle('business', j1, next('pay'), { net: '100000.87' });
assert.equal(s.credited, true);
l = await ledger(j1);
assert.deepEqual(
  { product: l[0].product, item: l[0].item_key, base: n(l[0].base_cents), final: n(l[0].final_cents), est: n(l[0].estimated_fee_cents),
    fee: n(l[0].actual_fee_cents), variance: n(l[0].fee_variance_cents), net: n(l[0].actual_net_cents), margin: n(l[0].margin_cents), flags: l[0].flags },
  { product: 'business', item: 'croissance', base: 10000000, final: 10256500, est: 256413, fee: 256413, variance: 0, net: 10000087, margin: 87,
    flags: [] });
assert.equal(l[0].provision_covers_fee, true);
assert.equal((await one(`select status from saas_business.subscriptions where user_id = $1`, [eve])).status, 'active');
assert.deepEqual(await anomalies(j1), []);
ok('Business Grow à 100 000 FCFA, tarif de 2,5 % : prix 102 565, frais réels 2 564,13 = estimés, net 100 000,87 ≥ base, abonnement actif, aucune alerte (frais couverts par le prix)');
await admin.query(`update saas_business.plans set monthly_price_minor = 25000 where plan_key = 'croissance'`);

// Frais réels différents de l'estimation.
const k1 = await studio(awa, { network: 'moov_ml', pack: 'pro_creator' });   // 16 000, estimés 2,5 % = 400
assert.equal(k1.amount, '16000.00'); assert.equal(k1.quoted_fee_amount, '400.00');
await settle('studio', k1, next('pay'), { net: '15520.00' });                 // réels 480
l = await ledger(k1);
assert.deepEqual([n(l[0].estimated_fee_cents), n(l[0].actual_fee_cents), n(l[0].fee_variance_cents), n(l[0].margin_cents), l[0].flags],
  [40000, 48000, 8000, 52000, []]);
ok('frais réels (480) ≠ estimés (400) : écart de +80 enregistré, marge réelle 520');

// Frais ajoutés au client alors que le prix était annoncé tout compris.
const m1 = await studio(awa);
await settle('studio', m1, next('pay'), { charged: '6150.00', net: '6000.00', mode: 'ADD_ON' });
l = await ledger(m1);
assert.deepEqual([n(l[0].charged_cents), n(l[0].actual_fee_cents), l[0].flags], [615000, 15000, ['tariff_missing', 'fee_mode_unexpected']]);
assert.deepEqual(await anomalies(m1), ['fee_mode_unexpected']);
ok('compte SasPay resté en frais ajoutés : client débité de 6 150 pour 6 000 annoncés → alerte « fee_mode_unexpected »');

// Frais non restitués par SasPay : inconnus, jamais supposés ; précisés plus tard → révision.
const o1 = await studio(awa);
await settle('studio', o1, next('pay'), { charged: null, net: null, mode: null });
l = await ledger(o1);
assert.deepEqual([n(l[0].charged_cents), l[0].actual_fee_cents, l[0].margin_cents, l[0].flags], [600000, null, null, ['tariff_missing', 'charged_assumed', 'fee_unknown']]);
const later = { ...(await one(`select to_jsonb(o) j from saas_ugc.ugc_recharge_orders o where id = $1`, [o1.id])).j, charged_amount: 6000, net_amount: 5910, fee_charge_mode: 'DEDUCTED' };
await admin.query(`select ugc_private.vyora_payment_ledger_record('studio', $1::jsonb)`, [JSON.stringify(later)]);
await admin.query(`select ugc_private.vyora_payment_ledger_record('studio', $1::jsonb)`, [JSON.stringify(later)]);
l = await ledger(o1);
assert.equal(l.length, 2);
assert.deepEqual([l[1].revision, n(l[1].actual_fee_cents), n(l[1].margin_cents)], [2, 9000, 91000]);
assert.deepEqual([l[0].revision, l[0].actual_fee_cents], [1, null]);
ok('frais inconnus à la confirmation : non supposés ; précisés ensuite → révision 2 ajoutée, révision 1 intacte, pas de doublon');

await fails(admin.query(`update saas_ugc.vyora_payment_reconciliations set margin_cents = 0 where order_id = $1`, [a1.id]), /payment_reconciliation_is_immutable/, 'modification');
await fails(admin.query(`delete from saas_ugc.vyora_payment_reconciliations where order_id = $1`, [a1.id]), /payment_reconciliation_is_immutable/, 'suppression');
await fails(admin.query(`truncate saas_ugc.vyora_payment_reconciliations`), /payment_reconciliation_is_immutable/, 'vidage');
ok('registre de rapprochement immuable : ni modification, ni suppression, ni vidage');

// Paiement resté sans réponse (« en vérification ») : rien tant que SUCCESS n'est pas vérifié.
const zoe = await customer('zoe');
const z1 = await studio(zoe);
const body = { amount: z1.amount, currency: 'XOF', country: 'ML', network: 'orange_ml', fee_charge_mode: 'DEDUCTED',
  customer: { email: 'z@test.local', first_name: 'Z', last_name: 'O', phone: '+22370000012' },
  description: `Pack — ${z1.internal_reference}`, metadata: { order_reference: z1.internal_reference } };
const t = await rpc(svc, 'vyora_payment_begin_initiation', { p_product: 'studio', p_order_id: z1.id, p_request: body });
assert.equal(t.allowed, true); assert.equal(t.request.amount, '6000.00'); assert.equal(t.request.fee_charge_mode, 'DEDUCTED');
await rpc(svc, 'vyora_payment_initiation_unknown', { p_product: 'studio', p_order_id: z1.id, p_error: 'provider_unreachable' });
assert.equal((await ledger(z1)).length, 0); assert.equal(await balance(zoe), 0);
await fails(studio(zoe), /other_payment_unconfirmed|payment_under_review|other_payment_in_progress/, 'second paiement pendant la vérification');
s = await settle('studio', z1, next('pay'), { net: '5900.00' });
assert.equal(s.credited, true); assert.equal(await balance(zoe), 27); assert.equal((await ledger(z1)).length, 1);
ok('paiement en vérification : ni crédit ni rapprochement, second paiement bloqué ; SUCCESS vérifié → crédit unique et une ligne');

// Commande antérieure à la politique (sans devis) : rapprochée sans alerte de provision.
await setPolicy({ ...DEFAULT, enabled: false });
const old = await studio(awa);
assert.equal(old.amount, '5000.00'); assert.equal(old.requested_fee_mode, null); assert.equal(old.quoted_fee_mode, 'ADD_ON');
await setPolicy(DEFAULT);
await settle('studio', old, next('pay'), { charged: '5100.00', net: '5000.00', mode: 'ADD_ON' });
l = await ledger(old);
assert.deepEqual([n(l[0].base_cents), n(l[0].provision_cents), n(l[0].margin_cents), l[0].provision_covers_fee], [500000, 0, 0, null]);
assert.deepEqual(await anomalies(old), []);
ok('politique désactivée : prix et comportement d’origine (5 000 FCFA, frais selon le compte), rapprochement sans alerte');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Administration : politique, barème, simulation');

for (const [who, c] of [['anonyme', asAnon], ['client', await connectAs('authenticated', awa)], ['service', svc]]) {
  await fails(rpc(c, 'vyora_admin_finance_report', {}), /permission denied|not_authenticated|forbidden/, `rapport — ${who}`);
  await fails(rpc(c, 'vyora_admin_set_pricing_policy', { p_policy: { enabled: false, strategy: 'cover_fees', currencies: {} } }), /permission denied|not_authenticated|forbidden/, `politique — ${who}`);
  await fails(rpc(c, 'vyora_admin_add_tariff', { p_tariff: {} }), /permission denied|not_authenticated|forbidden/, `barème — ${who}`);
  for (const t of ['vyora_fee_schedule', 'vyora_payment_reconciliations']) {
    await fails(c.query(`select * from saas_ugc.${t} limit 1`), /permission denied/, `${t} — ${who}`);
  }
}
ok('politique, barème, registre et rapport : réservés à l’administrateur ; tables inaccessibles aux rôles d’API');

const policy = (over) => ({ enabled: true, strategy: 'cover_fees', currencies: { XOF: { provision_cents: 100000, rounding_step_cents: 100 } }, ...over });
for (const bad of [
  policy({ strategy: 'gratuit' }), policy({ enabled: 'oui' }), policy({ currencies: {} }),
  policy({ currencies: { XOF: { provision_cents: 100050, rounding_step_cents: 100 } } }),
  policy({ currencies: { XOF: { provision_cents: 100000, rounding_step_cents: 50 } } }),
  policy({ currencies: { XOF: { provision_cents: 1000.5, rounding_step_cents: 100 } } }),
  policy({ currencies: { xof: { provision_cents: 100000, rounding_step_cents: 100 } } }),
  policy({ currencies: { XOF: { provision_cents: -100, rounding_step_cents: 100 } } }),
]) await fails(rpc(asBoss, 'vyora_admin_set_pricing_policy', { p_policy: bad }), /pricing_policy_invalid/, JSON.stringify(bad));
let p = await rpc(asBoss, 'vyora_admin_set_pricing_policy', { p_policy: policy({ currencies: { XOF: { provision_cents: 150000, rounding_step_cents: 500 } } }) });
assert.equal(p.currencies.XOF.provision_cents, 150000);
assert.equal((await quote(500000, 'ML', 'orange_ml')).final_cents, 650000);
assert.equal(await count(`select count(*) n from saas_ugc.ugc_audit_logs where action = 'vyora_pricing_policy_updated' and actor_user_id = $1`, [boss]), 1);
await rpc(asBoss, 'vyora_admin_set_pricing_policy', { p_policy: policy({}) });
ok('provision configurable par l’administrateur (1 500 FCFA → 6 500), valeurs invalides ou décimales refusées, changement journalisé');

await clearLines();
const tariff = (over) => ({ transaction_type: 'payin', country_code: 'ML', currency: 'XOF', network_code: 'orange_ml', percent_milli: 2000,
  source: 'owner_provided', source_note: 'Grille communiquée par SasPay le 12/11', ...over });
for (const [bad, pattern] of [
  [tariff({ source: undefined }), /tariff_source_required/], [tariff({ source: 'saspay_account_rates' }), /tariff_source_required/],
  [tariff({ source_note: 'ok' }), /tariff_source_required/], [tariff({ percent_milli: 2.5 }), /tariff_invalid/],
  [tariff({ percent_milli: 60000 }), /tariff_invalid/], [tariff({ percent_milli: 0 }), /tariff_invalid/],
  [tariff({ currency: 'FCFA' }), /tariff_invalid/], [tariff({ country_code: 'MALI' }), /tariff_invalid/],
  [tariff({ fee_base: 'autre' }), /tariff_invalid/], [tariff({ transaction_type: 'refund' }), /tariff_invalid/],
  [tariff({ floor_fee_cents: 5000, cap_fee_cents: 1000 }), /tariff_invalid/], [tariff({ fixed_cents: -5 }), /tariff_invalid/],
]) await fails(rpc(asBoss, 'vyora_admin_add_tariff', { p_tariff: bad }), pattern, JSON.stringify(bad));
const t1 = await rpc(asBoss, 'vyora_admin_add_tariff', { p_tariff: tariff({}) });
assert.equal(t1.active, true); assert.equal(t1.percent_milli, 2000);
const free = await rpc(asBoss, 'vyora_admin_add_tariff', { p_tariff: tariff({ network_code: 'mobi_cash_ml', percent_milli: 0, confirmed_free: true }) });
assert.equal(free.percent_milli, 0);
ok('barème : origine du tarif obligatoire, entiers stricts, bornes contrôlées ; un tarif nul doit être affirmé explicitement');

let sim = await rpc(asBoss, 'vyora_admin_price_simulation', { p_base_cents: 10000000, p_currency: 'XOF', p_country: 'ML', p_network: 'orange_ml' });
// 100 000 / 0,98 = 102 040,82 → 102 041 FCFA ; frais 2 040,82 ; net 100 000,18.
assert.deepEqual([sim.final_cents, sim.estimated_fee_cents, sim.expected_net_cents, sim.tariff_id], [10204100, 204082, 10000018, t1.id]);
ok('simulation administrateur : 100 000 FCFA à 2 % → 102 041 FCFA, frais 2 040,82, net 100 000,18');

await fails(admin.query(`update saas_ugc.vyora_fee_schedule set percent_milli = 1 where id = $1`, [t1.id]), /fee_schedule_is_append_only/, 'ligne modifiée');
await fails(admin.query(`delete from saas_ugc.vyora_fee_schedule where id = $1`, [t1.id]), /fee_schedule_is_append_only/, 'ligne supprimée');
await fails(rpc(asBoss, 'vyora_admin_close_tariff', { p_tariff_id: t1.id, p_note: '' }), /tariff_note_required/, 'clôture sans motif');
const closed = await rpc(asBoss, 'vyora_admin_close_tariff', { p_tariff_id: t1.id, p_note: 'Tarif remplacé au 13/11' });
assert.equal(closed.active, false);
await fails(rpc(asBoss, 'vyora_admin_close_tariff', { p_tariff_id: t1.id, p_note: 'Encore une fois' }), /tariff_already_closed/, 'double clôture');
sim = await rpc(asBoss, 'vyora_admin_price_simulation', { p_base_cents: 10000000, p_currency: 'XOF', p_country: 'ML', p_network: 'orange_ml' });
assert.deepEqual([sim.final_cents, sim.tariff_status], [10100000, 'missing']);
ok('ligne de barème : ni modifiée ni supprimée, seulement close (avec motif) ; une fois close, elle ne sert plus aux devis');

// Décaissements : barème séparé, jamais de provision.
await rpc(asBoss, 'vyora_admin_add_tariff', { p_tariff: tariff({ transaction_type: 'payout', network_code: null, percent_milli: 1800, cap_fee_cents: 500000 }) });
let out = await rpc(asBoss, 'vyora_admin_payout_simulation', { p_amount_cents: 10000000, p_currency: 'XOF', p_country: 'ML', p_network: 'orange_ml' });
assert.deepEqual([out.provision_cents, out.estimated_fee_cents, out.tariff_status], [0, 180000, 'confirmed']);
out = await rpc(asBoss, 'vyora_admin_payout_simulation', { p_amount_cents: 10000000, p_currency: 'XOF', p_country: 'SN', p_network: null });
assert.deepEqual([out.provision_cents, out.estimated_fee_cents, out.tariff_status], [0, null, 'missing']);
assert.equal((await quote(10000000, 'ML', 'orange_ml')).estimated_fee_cents, null);
ok('décaissement de 100 000 FCFA : frais estimés 1 800, provision 0 ; la ligne « payout » n’entre pas dans le prix d’un encaissement');

// Import des tarifs du compte (forme documentée de GET /pricing/my-rates/).
const rates = [
  { country_code: 'CI', country_name: "Côte d'Ivoire", currency: 'XOF', network_code: 'orange_ci', network_name: 'Orange Money',
    payin: { available: true, tiers: [{ min_amount: '0.00', max_amount: '500000.00', currency: 'XOF', percent: '2.500', fixed: '0.00', floor_amount: '50.00', cap_amount: null, fee_charge_mode: 'ADD_ON' }] },
    payout: { available: true, tiers: [{ min_amount: '0.00', max_amount: '500000.00', currency: 'XOF', percent: '1.800', fixed: '0.00', floor_amount: null, cap_amount: '5000.00', fee_charge_mode: 'DEDUCTED' }] } },
  { country_code: 'ML', currency: 'XOF', network_code: 'orange_ml',
    payin: { available: true, tiers: [{ min_amount: '0.00', max_amount: null, currency: 'XOF', percent: '1.75', fixed: '25.00', floor_amount: null, cap_amount: null, fee_charge_mode: 'DEDUCTED' }] } },
  { country_code: 'ML', currency: 'XOF', network_code: 'moov_ml',
    payin: { available: true, tiers: [{ min_amount: '0.00', max_amount: null, currency: 'XOF', percent: 'deux', fixed: '0.00' }] } },
];
await fails(rpc(svc, 'vyora_payment_import_rates', { p_actor: awa, p_rates: rates }), /forbidden/, 'import par un non-administrateur');
await fails(rpc(asBoss, 'vyora_payment_import_rates', { p_actor: boss, p_rates: rates }), /permission denied|service_role_required/, 'import hors service');
await fails(rpc(svc, 'vyora_payment_import_rates', { p_actor: boss, p_rates: [] }), /rates_empty/, 'import vide');
let imp = await rpc(svc, 'vyora_payment_import_rates', { p_actor: boss, p_rates: rates });
assert.deepEqual(imp, { inserted: 3, unchanged: 0, closed: 0, skipped: 1 });
const ci = await one(`select * from saas_ugc.vyora_fee_schedule where source = 'saspay_account_rates' and country_code = 'CI' and transaction_type = 'payin'`);
assert.deepEqual([ci.percent_milli, n(ci.floor_fee_cents), n(ci.max_amount_cents), ci.account_fee_mode, ci.fee_base], [2500, 5000, 50000000, 'ADD_ON', 'total']);
const ml = await one(`select * from saas_ugc.vyora_fee_schedule where source = 'saspay_account_rates' and country_code = 'ML'`);
assert.deepEqual([ml.percent_milli, n(ml.fixed_cents)], [1750, 2500]);
imp = await rpc(svc, 'vyora_payment_import_rates', { p_actor: boss, p_rates: rates });
assert.deepEqual(imp, { inserted: 0, unchanged: 3, closed: 0, skipped: 1 });
rates[1].payin.tiers[0].percent = '2.000';
imp = await rpc(svc, 'vyora_payment_import_rates', { p_actor: boss, p_rates: rates.slice(1) });
assert.deepEqual(imp, { inserted: 1, unchanged: 0, closed: 3, skipped: 1 });
// 5 000 + 1 000 = 6 000 ; 2 % + 25 = 145 FCFA.
assert.deepEqual([(await quote(500000, 'ML', 'orange_ml')).estimated_fee_cents, await count(`select count(*) n from saas_ugc.vyora_fee_schedule where source = 'owner_provided'`)], [14500, 3]);
ok('import des tarifs du compte : paliers repris à l’identique (2,500 % → 2500), valeur illisible écartée, rejouable, lignes disparues closes, lignes manuelles intactes');

let view = await rpc(asBoss, 'vyora_admin_pricing_overview', {});
assert.equal(view.policy.currencies.XOF.provision_cents, 100000);
const missing = view.missing_tariffs.map((m) => `${m.country_code}:${m.network_code}`);
assert.deepEqual(missing, ['CI:mtn_ci', 'CI:orange_ci', 'ML:moov_ml', 'SN:orange_sn', 'SN:wave_sn']);
assert.equal(view.account_add_on_lines, 0);
assert.ok(view.tariffs.length >= 6);
ok('vue d’ensemble : tarifs manquants listés par pays et opérateur (5 sur 7), lignes actives et closes consultables');

// ─────────────────────────────────────────────────────────────────────────────
console.log('Tableau de bord financier');

let rep = await rpc(asBoss, 'vyora_admin_finance_report', {});
const mine = async (where = '') => one(
  `with latest as (select distinct on (product, order_id) * from saas_ugc.vyora_payment_reconciliations order by product, order_id, revision desc)
   select count(*)::int n, coalesce(sum(charged_cents), 0)::bigint gross, coalesce(sum(actual_fee_cents), 0)::bigint fee,
          coalesce(sum(actual_net_cents), 0)::bigint net, coalesce(sum(margin_cents), 0)::bigint margin from latest ${where}`);
let ref = await mine();
assert.deepEqual([rep.totals.transactions, rep.totals.gross_cents, rep.totals.actual_fee_cents, rep.totals.actual_net_cents, rep.totals.margin_cents],
  [ref.n, n(ref.gross), n(ref.fee), n(ref.net), n(ref.margin)]);
assert.equal(rep.totals.gross_cents - rep.totals.actual_fee_cents - (rep.totals.fee_unknown ? 0 : 0) >= rep.totals.actual_net_cents, true);
ok(`totaux : ${rep.totals.transactions} transactions, brut ${rep.totals.gross_cents / 100} FCFA, frais ${rep.totals.actual_fee_cents / 100}, net ${rep.totals.actual_net_cents / 100}, marge ${rep.totals.margin_cents / 100}`);

rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_product: 'business', p_from: T0 });
assert.deepEqual([rep.totals.transactions, rep.totals.gross_cents, rep.totals.actual_fee_cents, rep.totals.margin_cents], [1, 10256500, 256413, 87]);
assert.deepEqual(rep.by_product.map((x) => `${x.product}:${x.item_key}`), ['business:croissance']);
rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_network: 'moov_ml', p_from: T0 });
assert.deepEqual([rep.totals.transactions, rep.totals.gross_cents, rep.totals.estimated_fee_cents, rep.totals.actual_fee_cents, rep.totals.fee_variance_cents, rep.totals.compared],
  [2, 10256500 + 1600000, 256413 + 40000, 256413 + 48000, 8000, 2]);
rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_country: 'sn' });
assert.equal(rep.totals.transactions, 0); assert.deepEqual(rep.by_country, []);
rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_country: 'ML', p_product: 'studio' });
ref = await mine(`where product = 'studio' and country_code = 'ML'`);
assert.deepEqual([rep.totals.transactions, rep.totals.margin_cents], [ref.n, n(ref.margin)]);
assert.deepEqual(rep.by_country.map((x) => x.country_code), ['ML']);
ok('filtres produit, opérateur et pays ; estimé contre réel par opérateur (Moov : estimés 2 964,13, réels 3 044,13, écart +80)');

rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_from: new Date(Date.now() + 3600_000).toISOString() });
assert.equal(rep.totals.transactions, 0); assert.equal(rep.totals.gross_cents, 0);
rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_from: new Date(Date.now() - 3600_000).toISOString(), p_to: new Date(Date.now() + 3600_000).toISOString() });
assert.ok(rep.totals.transactions >= 9);
const weak = rep.unprofitable.map((x) => x.internal_reference);
// i1 : frais non couverts par le prix. j1 : prix relevé au devis, frais couverts → n'y figure pas. a1 : rentable.
assert.ok(weak.includes(i1.internal_reference) && !weak.includes(j1.internal_reference) && !weak.includes(a1.internal_reference));
assert.equal(rep.totals.unprofitable >= 1, true); assert.equal(rep.totals.over_provision >= 1, true);
assert.ok(rep.recent.some((x) => x.internal_reference === o1.internal_reference && x.revision === 2));
ok('filtre de période ; transactions insuffisamment rentables listées (net sous la base, ou frais non couverts par le prix)');

// Remboursement : repris dans le rapport sans réécrire le registre.
const before = (await rpc(asBoss, 'vyora_admin_finance_report', { p_product: 'studio' })).totals.refunded_cents;
await rpc(asBoss, 'vyora_admin_refund_studio', { p_order_id: h1.id, p_reason: 'Geste commercial du banc', p_refund_amount_xof: 6000, p_allow_partial: true });
rep = await rpc(asBoss, 'vyora_admin_finance_report', { p_product: 'studio' });
assert.equal(rep.totals.refunded_cents - before, 600000); assert.equal((await ledger(h1)).length, 1);
ok('remboursement du prix payé (6 000 FCFA, provision comprise) : visible dans le rapport, registre inchangé');

// Rattrapage d'une commande réglée sans ligne (antérieure à la migration).
await admin.query(`alter table saas_ugc.vyora_payment_reconciliations disable trigger vyora_payment_reconciliation_immutable`);
await admin.query(`delete from saas_ugc.vyora_payment_reconciliations where order_id = $1`, [k1.id]);
await admin.query(`alter table saas_ugc.vyora_payment_reconciliations enable trigger vyora_payment_reconciliation_immutable`);
assert.equal((await rpc(asBoss, 'vyora_admin_pricing_overview', {})).missing_reconciliations, 1);
assert.deepEqual(await rpc(asBoss, 'vyora_admin_finance_backfill', {}), { recorded: 1 });
assert.deepEqual(await rpc(asBoss, 'vyora_admin_finance_backfill', {}), { recorded: 0 });
l = await ledger(k1);
assert.deepEqual([l.length, n(l[0].actual_fee_cents), n(l[0].fee_variance_cents)], [1, 48000, 8000]);
ok('commande réglée sans ligne de rapprochement : signalée puis rattrapée, une seule fois');

// Le rapprochement ne peut pas empêcher de livrer un client qui a payé.
await admin.query(`alter table saas_ugc.vyora_payment_reconciliations add constraint banc_panne check (product <> 'studio') not valid`);
const y1 = await studio(awa);
const yBefore = await balance(awa);
s = await settle('studio', y1, next('pay'), { net: '5900.00' });
await admin.query(`alter table saas_ugc.vyora_payment_reconciliations drop constraint banc_panne`);
assert.equal(s.credited, true); assert.equal(await balance(awa), yBefore + 27);
assert.equal((await ledger(y1)).length, 0);
assert.deepEqual(await anomalies(y1), ['reconciliation_failed']);
assert.deepEqual(await rpc(asBoss, 'vyora_admin_finance_backfill', {}), { recorded: 1 });
ok('écriture du rapprochement en panne : client tout de même crédité, anomalie « reconciliation_failed », ligne rattrapée ensuite');

// ─────────────────────────────────────────────────────────────────────────────
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = $1::jsonb where setting_key = 'saspay_payment_config'`, [JSON.stringify(saved.payment)]);
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = $1::jsonb where setting_key = 'vyora_pricing_policy'`, [JSON.stringify(saved.policy)]);
await clearLines();
summary();
for (const c of [admin, svc, asBoss, asAnon]) await c.end();
process.exit(0);
