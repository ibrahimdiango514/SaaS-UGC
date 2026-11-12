// Bout en bout : vraies Edge Functions (TypeScript du dépôt) + PostgreSQL réel
// (PostgREST émulé) + faux SasPay. Aucun appel réseau sortant.
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { client, REPO } from './pg.mjs';
import { connectAs, ok, summary, assert } from './t.mjs';
const { createPaymentsHandler, createWebhookHandler, createReconcileHandler } = await import(pathToFileURL(path.join(REPO, 'supabase/functions/_shared/saspay/http.ts')).href);

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const svc = await connectAs('service_role');
const KEY = 'sk_test_e2e_0123456789', WH = 'whsec_e2e';
const ORIGIN = 'https://vyora-ugc.netlify.app';
const tokens = new Map();
const tx = new Map(), sessions = new Map(), idem = new Map(); let seq = 0; let softpayFailure = null;
const J = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetcher = async (input, init = {}) => {
  const url = new URL(String(input)); const headers = new Headers(init.headers);
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.host === 'db.local') {
    if (url.pathname === '/auth/v1/user') { const u = tokens.get(headers.get('authorization')); return u ? J(u) : J({ msg: 'bad jwt' }, 401); }
    const name = url.pathname.replace('/rest/v1/rpc/', '');
    assert.equal(headers.get('authorization'), 'Bearer service-key');
    const keys = Object.keys(body);
    try {
      const res = await svc.query(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
        keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])));
      return J(res.rows[0].r ?? null);
    } catch (e) { return J({ code: e.code, message: e.message }, 400); }
  }
  assert.equal(url.host, 'api.saspay.me'); assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
  const path = url.pathname.replace('/api/v1', '');
  if (path === '/pricing/my-rates/') return J({ success: true, data: [{ country_code: 'ML', network_code: 'orange_ml', payin: { available: true, otp_required: false, tiers: [{ min_amount: '0.00', max_amount: null, percent: '2.00', fixed: '0.00', fee_charge_mode: 'ADD_ON' }] } }] });
  if (path === '/payments/softpay/') {
    if (softpayFailure) return J({ success: false, error: softpayFailure.error, code: softpayFailure.status }, softpayFailure.status);
    const k = headers.get('idempotency-key'); if (idem.has(k)) return J({ success: true, data: idem.get(k) }, 201);
    const id = `tx-${String(++seq).padStart(8, '0')}`; const amount = body.amount;
    tx.set(id, { id, description: body.description, transaction_type: 'PAIEMENT', flow_direction: 'INBOUND', created_at: new Date().toISOString(), reference: `SP-${id}`, status: 'PENDING', requested_amount: amount, currency: body.currency, fee_charge_mode: 'ADD_ON', client_fee: (Number(amount) * 0.02).toFixed(2), debited_amount: (Number(amount) * 1.02).toFixed(2), net_amount: amount });
    const data = { id, status: 'PENDING', checkout_url: '' }; idem.set(k, data); return J({ success: true, data }, 201);
  }
  if (path === '/checkout-sessions/') { const id = `cs-${String(++seq).padStart(8, '0')}`; sessions.set(id, { id, status: 'PENDING', transaction_id: null, amount: body.amount, currency: body.currency }); return J({ id, status: 'PENDING', checkout_url: `https://pay.saspay.me/c/${id}` }, 201); }
  let m = path.match(/^\/checkout-sessions\/(.+)\/status\/$/); if (m) return sessions.has(m[1]) ? J({ success: true, data: sessions.get(m[1]) }) : J({ error: { code: 'not_found', message: 'x' } }, 404);
  m = path.match(/^\/payments\/(.+)\/verify\/$/); if (m) return tx.has(m[1]) ? J({ success: true, data: tx.get(m[1]) }) : J({ error: { code: 'not_found', message: 'x' } }, 404);
  if (path === '/transactions/') {
    assert.equal(init.method ?? 'GET', 'GET');
    listings.push(Object.fromEntries(url.searchParams));
    return J({ success: true, data: { next: null, previous: null, results: [...tx.values()].filter((t) => t.status === 'SUCCESS') } });
  }
  if (path.startsWith('/merchant-balances/')) return J({ success: true, data: { count: 1, next: null, results: [{ id: 'b1', country: 'ML', currency: 'XOF', available_amount: '42000.00', pending_amount: '0.00', is_frozen: false }] } });
  return J({ error: { code: 'not_found', message: 'x' } }, 404);
};

const listings = [];
let clock = Date.now();
const env = { supabaseUrl: 'https://db.local', anonKey: 'anon', serviceRoleKey: 'service-key', sasPaySecretKey: KEY, webhookSecret: WH, extraOrigins: '' };
const payments = createPaymentsHandler({ env, fetcher, now: () => clock });
const webhook = createWebhookHandler({ env, fetcher, now: () => clock });
const reconcileFn = createReconcileHandler({ env, fetcher, now: () => clock });
const call = async (token, body) => { const r = await payments(new Request('https://edge/vyora-payments', { method: 'POST', headers: { origin: ORIGIN, authorization: token, 'content-type': 'application/json' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
const hook = async (body, { secret = WH, tamper = false } = {}) => {
  const raw = JSON.stringify(body); const ts = String(Math.floor(clock / 1000));
  const sig = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  const r = await webhook(new Request('https://edge/vyora-saspay-webhook', { method: 'POST', headers: { 'x-webhook-signature': sig, 'x-webhook-timestamp': ts }, body: tamper ? raw.replace('5000', '9000') : raw }));
  return { status: r.status, body: await r.json() };
};
async function user(email, { customer = true, role = null } = {}) {
  const { id } = await one(`insert into auth.users(email) values ($1) returning id`, [email]);
  if (customer) { await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [id]); await admin.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1)`, [id]); }
  if (role) await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, $2)`, [id, role]);
  tokens.set(`Bearer ${email}`, { id, email, user_metadata: { display_name: email.split('@')[0] } });
  return id;
}
const wallet = async (u) => Number((await one(`select available_balance b from saas_ugc.ugc_wallets where user_id = $1`, [u])).b);
const dbOrder = (id) => one(`select * from saas_ugc.ugc_recharge_orders where id = $1`, [id]);

await admin.query(`delete from saas_ugc.ugc_user_roles`);
const alice = await user('e2e-alice@test.local'), bob = await user('e2e-bob@test.local');
const boss = await user('e2e-boss@test.local', { customer: false, role: 'admin' });
const carol = await user('e2e-carol@test.local', { customer: false });
const A = 'Bearer e2e-alice@test.local', B = 'Bearer e2e-bob@test.local', BOSS = 'Bearer e2e-boss@test.local', C = 'Bearer e2e-carol@test.local';
const softpay = (key, extra = {}) => ({ action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '70 12 34 56', idempotency_key: key, ...extra });

console.log('Bout en bout — Studio (softpay)');
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": false}' where setting_key = 'saspay_payment_config'`);
let r = await call(A, softpay('e2e-key-000001'));
assert.equal(r.status, 503); assert.equal(r.body.error.code, 'PAYMENTS_DISABLED');
ok('interrupteur général coupé → 503 PAYMENTS_DISABLED, aucun appel SasPay');
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);

r = await call(A, { action: 'options', product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
assert.equal(r.body.available, true); assert.equal(r.body.price.amount, '5000.00');
assert.deepEqual(r.body.countries[0].networks[0].fee, { fee: '100.00', mode: 'ADD_ON', total: '5100.00', net: '5000.00' });
ok('devis : prix de la grille en base + frais estimés du compte');

r = await call(A, softpay('e2e-key-000002', { amount: '1.00', credits: 99999 }));
assert.equal(r.status, 200); assert.equal(r.body.next, 'await_confirmation');
const orderId = r.body.order.id; let row = await dbOrder(orderId);
assert.equal(row.status, 'processing'); assert.equal(Number(row.amount_minor), 500000); assert.equal(Number(row.credits_to_grant), 27);
assert.equal(row.payer_msisdn_masked, '+223••••••56'); assert.equal(row.user_id, alice); assert.equal(Number(row.quoted_total_amount), 5100);
const txId = row.provider_payment_id; assert.ok(tx.has(txId)); assert.equal(tx.get(txId).requested_amount, '5000.00');
assert.equal(JSON.stringify(row).includes('70123456'), false);
ok('commande en base : montant serveur, numéro masqué, paiement SasPay rattaché');
const again = await call(A, softpay('e2e-key-000002'));
assert.equal(again.body.order.id, orderId); assert.equal(tx.size, 1);
ok('rejeu de la même intention → même commande, aucun second paiement');

r = await call(A, { action: 'status', product: 'studio', order_id: orderId });
assert.equal(r.body.order.state, 'pending'); assert.equal(await wallet(alice), 0);
ok('paiement en attente → solde inchangé');
r = await call(B, { action: 'status', product: 'studio', order_id: orderId });
assert.equal(r.status, 404);
ok('un autre utilisateur ne peut pas consulter la commande (404)');

r = await hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS', amount: '5000.00' } });
assert.equal(r.body.outcome, 'pending', JSON.stringify(r)); assert.equal(await wallet(alice), 0);
ok('webhook « success » signé alors que SasPay vérifie PENDING → aucun crédit');
r = await hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS', amount: '5000.00' } }, { secret: 'mauvais' });
assert.equal(r.status, 401);
r = await hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS', amount: '5000' } }, { tamper: true });
assert.equal(r.status, 401); assert.equal(await wallet(alice), 0);
ok('webhook mal signé ou altéré → 401');

tx.get(txId).status = 'SUCCESS'; clock += 5000;
const burst = await Promise.all([
  hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS', amount: '5000.00' } }),
  call(A, { action: 'status', product: 'studio', order_id: orderId }),
  hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS', amount: '5000.00' } }),
]);
assert.ok(burst.every((x) => x.status === 200), JSON.stringify(burst));
assert.equal(await wallet(alice), 27);
row = await dbOrder(orderId);
assert.equal(row.status, 'paid'); assert.equal(Number(row.fee_amount), 100); assert.equal(Number(row.charged_amount), 5100); assert.equal(Number(row.net_amount), 5000);
ok('webhook ×2 + vérification simultanés → payée, 27 crédits exactement, frais réels enregistrés');
for (let i = 0; i < 3; i += 1) { clock += 1000; await hook({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS' } }); }
assert.equal(await wallet(alice), 27);
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1`, [alice])).n), 1);
r = await call(A, { action: 'status', product: 'studio', order_id: orderId });
assert.equal(r.body.order.state, 'confirmed');
ok('rejeux ultérieurs du webhook → toujours 27 crédits, une écriture au grand livre');

console.log('Bout en bout — montant falsifié, refus, page hébergée');
r = await call(A, softpay('e2e-key-000003'));
const t2 = (await dbOrder(r.body.order.id)).provider_payment_id;
Object.assign(tx.get(t2), { status: 'SUCCESS', requested_amount: '50.00' }); clock += 5000;
r = await call(A, { action: 'status', product: 'studio', order_id: r.body.order.id });
assert.equal(r.body.credited, false); assert.match(r.body.message, /ne correspond pas/); assert.equal(await wallet(alice), 27);
ok('SasPay confirme un autre montant que la commande → aucun crédit');

softpayFailure = { status: 422, error: { code: 'invalid_customer', message: 'Invalid msisdn' } };
r = await call(B, softpay('e2e-key-000004'));
assert.equal(r.status, 422); assert.equal(r.body.error.code, 'PAYMENT_REJECTED');
assert.equal((await dbOrder(r.body.error.order_id)).status, 'failed'); softpayFailure = null;
ok('refus SasPay (422) → commande « échouée » en base, message utilisateur');
softpayFailure = { status: 503, error: { code: 'unavailable', message: 'down' } };
r = await call(B, softpay('e2e-key-000005'));
assert.equal(r.status, 503); const retryId = r.body.error.order_id; assert.equal((await dbOrder(retryId)).status, 'pending'); softpayFailure = null;
r = await call(B, softpay('e2e-key-000005'));
assert.equal(r.status, 200); assert.equal(r.body.order.id, retryId); assert.equal((await dbOrder(retryId)).status, 'processing');
ok('panne SasPay (503) → commande conservée, rejouée avec la même intention');

r = await call(B, { action: 'create', product: 'studio', item: { kind: 'custom', amount_xof: 20000 }, country: 'ML', flow: 'checkout', idempotency_key: 'e2e-key-000006' });
assert.equal(r.body.next, 'redirect'); assert.match(r.body.order.checkout_url, /^https:\/\/pay\.saspay\.me\/c\/cs-/);
const coId = r.body.order.id; const csId = (await dbOrder(coId)).provider_session_id;
r = await call(B, { action: 'status', product: 'studio', order_id: coId });
assert.equal(r.body.order.state, 'pending'); assert.equal(await wallet(bob), 0);
const t3 = `tx-${String(++seq).padStart(8, '0')}`; tx.set(t3, { id: t3, reference: `SP-${t3}`, status: 'SUCCESS', requested_amount: '20000.00', currency: 'XOF', fee_charge_mode: 'DEDUCTED', client_fee: '0.00', debited_amount: '20000.00', net_amount: '19400.00' });
Object.assign(sessions.get(csId), { status: 'PAID', transaction_id: t3 }); clock += 5000;
r = await hook({ event: 'transaction.success', data: { id: t3, status: 'SUCCESS' } });
assert.equal(r.body.credited, true); assert.equal(await wallet(bob), 126);
row = await dbOrder(coId); assert.equal(row.provider_payment_id, t3); assert.equal(Number(row.net_amount), 19400); assert.equal(Number(row.fee_amount), 0);
ok('page hébergée : 20 000 XOF → 126 crédits (palier Pro Creator) après webhook vérifié, frais déduits enregistrés');

console.log('Bout en bout — administration et lectures');
r = await call(A, { action: 'balances' }); assert.equal(r.status, 403);
r = await call(BOSS, { action: 'balances' }); assert.equal(r.status, 200); assert.equal(r.body.balances[0].available_amount, '42000.00'); assert.equal(r.body.mode, 'test');
r = await call(BOSS, softpay('e2e-key-000007')); assert.equal(r.status, 403);
ok('soldes SasPay : administrateur uniquement ; un administrateur ne peut pas acheter');
const asBoss = await connectAs('authenticated', boss);
await assert.rejects(asBoss.query(`select public.reelora_admin_confirm_recharge($1)`, [retryId]).catch((e) => { if (/does not exist/.test(e.message)) return admin.query(`update saas_ugc.ugc_recharge_orders set status = 'paid' where id = $1`, [retryId]); throw e; }), /saspay_order_requires_verified_payment/);
ok('validation manuelle d’une commande SasPay → refusée par la base');
const asAlice = await connectAs('authenticated', alice);
const mine = (await asAlice.query(`select public.vyora_my_payments('studio', 30) r`)).rows[0].r;
assert.equal(mine.length, 2); assert.ok(mine.every((o) => !('user_id' in o)));
ok('historique utilisateur lu avec son propre jeton');

console.log('Bout en bout — Business Grow');
const bg = (key) => ({ action: 'create', product: 'business', item: { plan_key: 'croissance' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '+22366554433', idempotency_key: key });
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": false}' where config_key = 'pricing'`);
r = await call(C, bg('e2e-key-bg0001')); assert.equal(r.status, 503); assert.equal(r.body.error.code, 'BUSINESS_BILLING_DISABLED');
ok('facturation désactivée → 503 BUSINESS_BILLING_DISABLED');
await admin.query(`update saas_business.commercial_config set value = value || '{"billing_enabled": true, "payment_providers": ["saspay"]}' where config_key = 'pricing'`);
await admin.query(`update saas_business.plans set active = true, billing_enabled = true, monthly_price_minor = 25000, monthly_credit_units = 400 where plan_key = 'croissance'`);
r = await call(C, bg('e2e-key-bg0001')); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.order.amount, '25000.00');
const bgId = r.body.order.id; const bgTx = (await one(`select provider_payment_id p from saas_business.payment_orders where id = $1`, [bgId])).p;
assert.equal(tx.get(bgTx).requested_amount, '25000.00');
const studioSum = await one(`select coalesce(sum(available_balance), 0) s from saas_ugc.ugc_wallets`);
tx.get(bgTx).status = 'SUCCESS'; clock += 5000;
r = await hook({ event: 'transaction.success', data: { id: bgTx, status: 'SUCCESS' } });
assert.equal(r.body.outcome, 'paid');
const sub = await one(`select status, plan_key, billing_provider from saas_business.subscriptions where user_id = $1`, [carol]);
assert.deepEqual(sub, { status: 'active', plan_key: 'croissance', billing_provider: 'saspay' });
assert.deepEqual(await one(`select coalesce(sum(available_balance), 0) s from saas_ugc.ugc_wallets`), studioSum);
r = await call(C, { action: 'status', product: 'studio', order_id: bgId }); assert.equal(r.status, 404);
r = await call(C, { action: 'status', product: 'business', order_id: bgId }); assert.equal(r.body.order.state, 'confirmed');
ok('abonnement Business Grow activé par webhook vérifié ; soldes Studio intacts ; commande invisible côté Studio');

console.log('Bout en bout — réconciliation planifiée');
// Jeton lu comme le fait pg_cron : dans le coffre, jamais dans le code.
const cronToken = (await one(`select decrypted_secret t from vault.decrypted_secrets where name = 'vyora_payments_reconcile_token'`)).t;
assert.match(cronToken, /^[0-9a-f]{64}$/);
const cron = async (headers = {}) => {
  const res = await reconcileFn(new Request('https://edge/vyora-payments-reconcile', {
    method: 'POST', body: JSON.stringify({ source: 'cron' }),
    headers: { 'content-type': 'application/json', 'x-vyora-cron': 'payments-reconcile', authorization: `Bearer ${cronToken}`, ...headers },
  }));
  return { status: res.status, body: await res.json() };
};
// Vieillit une commande (les gardes interdisent de modifier `created_at` : désactivées le temps du test).
const ageOrder = async (id, interval) => {
  await admin.query(`alter table saas_ugc.ugc_recharge_orders disable trigger user`);
  await admin.query(`update saas_ugc.ugc_recharge_orders set created_at = now() - $2::interval, last_verified_at = null where id = $1`, [id, interval]);
  await admin.query(`alter table saas_ugc.ugc_recharge_orders enable trigger user`);
};
const runCount = async () => Number((await one(`select count(*) n from saas_ugc.vyora_payment_reconcile_runs`)).n);
await admin.query(`delete from saas_ugc.vyora_payment_reconcile_runs`);
await admin.query(`delete from saas_ugc.vyora_payment_anomalies`);

r = await cron({ authorization: 'Bearer ' + 'f'.repeat(64) }); assert.equal(r.status, 401);
r = await cron({ authorization: 'Bearer service-key' }); assert.equal(r.status, 401);
r = await cron({ 'x-vyora-cron': 'autre' }); assert.equal(r.status, 403);
assert.equal(await runCount(), 0);
ok('appel sans en-tête dédié → 403 ; jeton faux ou clé de service → 401 ; aucune exécution ouverte');

// 1. Webhook perdu : paiement réussi chez SasPay, VYORA n'en a rien su.
const beforeLost = await wallet(bob);
r = await call(B, { action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '+22366112233', idempotency_key: 'e2e-key-recon01' });
assert.equal(r.status, 200, JSON.stringify(r.body));
const lostId = r.body.order.id; const lostTx = (await dbOrder(lostId)).provider_payment_id;
tx.get(lostTx).status = 'SUCCESS';
// Balayage tenu à l'écart (il vient d'avoir lieu) : seule la revérification ciblée est observée ici.
await admin.query(`insert into saas_ugc.vyora_payment_reconcile_runs(trigger_source, status, sweep_done, finished_at) values ('test', 'ok', true, now())`);
r = await cron(); assert.equal(r.status, 200); assert.equal(r.body.settled, 0); assert.equal(r.body.sweep_done, false);
assert.equal(await wallet(bob), beforeLost);
ok('commande de moins de 2 minutes : pas encore revérifiée individuellement (le webhook a la priorité)');
await ageOrder(lostId, '3 minutes');
r = await cron(); assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.ran, true); assert.equal(r.body.settled, 1);
assert.equal((await dbOrder(lostId)).status, 'paid');
assert.equal(await wallet(bob), beforeLost + 27);
const lostLedger = await one(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1 and idempotency_key like '%' || $2 || '%'`, [bob, lostId]);
assert.equal(Number(lostLedger.n), 1);
ok('webhook perdu → la tâche planifiée vérifie auprès de SasPay et crédite 27 crédits, une seule fois');

r = await cron(); assert.equal(r.body.settled, 0); assert.equal(await wallet(bob), beforeLost + 27);
// Le webhook arrive finalement, en retard : aucun second crédit.
clock += 5000;
r = await hook({ event: 'transaction.success', data: { id: lostTx, status: 'SUCCESS' } });
assert.equal(r.body.credited, false); assert.equal(await wallet(bob), beforeLost + 27);
ok('nouveau passage puis webhook tardif → aucun second crédit');

// 2. Réponse de création perdue : aucun identifiant SasPay connu, paiement pourtant encaissé.
softpayFailure = { status: 503, error: { code: 'unavailable', message: 'down' } };
r = await call(B, { action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'pro_creator' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '+22366112233', idempotency_key: 'e2e-key-recon02' });
softpayFailure = null;
const ghostId = r.body.error.order_id; const ghost = await dbOrder(ghostId);
assert.equal(ghost.provider_payment_id, null);
tx.set('tx-ghost-0001', { id: 'tx-ghost-0001', reference: 'SP-ghost', status: 'SUCCESS', transaction_type: 'PAIEMENT', flow_direction: 'INBOUND',
  description: `Pack Pro Creator — ${ghost.internal_reference}`, requested_amount: '15000.00', currency: 'XOF', fee_charge_mode: 'ADD_ON',
  client_fee: '300.00', debited_amount: '15300.00', net_amount: '15000.00', created_at: new Date().toISOString() });
await admin.query(`delete from saas_ugc.vyora_payment_reconcile_runs`); // le balayage est limité à un par quart d'heure
listings.length = 0;
r = await cron(); assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.sweep_done, true); assert.equal(r.body.settled, 1);
assert.deepEqual(Object.keys(listings[0]).sort(), ['created_at__gte', 'page_size', 'status', 'transaction_type']);
const found = await dbOrder(ghostId);
assert.equal(found.status, 'paid'); assert.equal(found.provider_payment_id, 'tx-ghost-0001');
assert.equal(await wallet(bob), beforeLost + 27 + 95);
ok('réponse de création perdue → paiement retrouvé par la référence interne, revérifié, 95 crédits livrés');

// 3. Second encaissement portant la référence d'une commande déjà payée.
tx.set('tx-dup-0001', { ...tx.get('tx-ghost-0001'), id: 'tx-dup-0001', reference: 'SP-dup' });
await admin.query(`delete from saas_ugc.vyora_payment_reconcile_runs`);
// (La commande au montant falsifié de la section précédente est, elle aussi, re-signalée — sans doublon en base.)
r = await cron(); assert.ok(r.body.anomalies >= 1); assert.equal(r.body.settled, 0);
assert.equal(await wallet(bob), beforeLost + 27 + 95);
const dup = await one(`select kind, product, order_id, provider_payment_id, seen_count from saas_ugc.vyora_payment_anomalies where kind = 'duplicate_payment'`);
assert.deepEqual(dup, { kind: 'duplicate_payment', product: 'studio', order_id: ghostId, provider_payment_id: 'tx-dup-0001', seen_count: 1 });
await admin.query(`delete from saas_ugc.vyora_payment_reconcile_runs`);
r = await cron();
assert.equal(Number((await one(`select count(*) n from saas_ugc.vyora_payment_anomalies where kind = 'duplicate_payment'`)).n), 1);
const alerts = await one(`select count(*) n from saas_ugc.ugc_notifications where title ilike '%doublon%' or body ilike '%tx-dup-0001%'`);
ok(`double encaissement → aucun second crédit, une seule anomalie « doublon » (alertes administrateur : ${alerts.n})`);
tx.delete('tx-dup-0001');

// 4. Montant encaissé différent du montant commandé.
softpayFailure = { status: 503, error: { code: 'unavailable', message: 'down' } };
r = await call(A, { action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '+22366112233', idempotency_key: 'e2e-key-recon03' });
softpayFailure = null;
const cheapId = r.body.error.order_id; const cheap = await dbOrder(cheapId); const aliceBefore = await wallet(alice);
tx.set('tx-cheap-0001', { id: 'tx-cheap-0001', reference: 'SP-cheap', status: 'SUCCESS', transaction_type: 'PAIEMENT', flow_direction: 'INBOUND',
  description: `Pack Creator — ${cheap.internal_reference}`, requested_amount: '100.00', currency: 'XOF', fee_charge_mode: 'ADD_ON',
  client_fee: '0.00', debited_amount: '100.00', net_amount: '100.00', created_at: new Date().toISOString() });
await admin.query(`delete from saas_ugc.vyora_payment_reconcile_runs`);
r = await cron(); assert.equal(r.body.settled, 0);
assert.notEqual((await dbOrder(cheapId)).status, 'paid'); assert.equal(await wallet(alice), aliceBefore);
assert.equal(Number((await one(`select count(*) n from saas_ugc.vyora_payment_anomalies where kind = 'amount_mismatch' and order_id = $1`, [cheapId])).n), 1);
ok('100 FCFA encaissés pour une commande de 5 000 FCFA → rien n’est livré, anomalie « montant »');
tx.delete('tx-cheap-0001');

// 5. Journal et vue d'exploitation.
const lastRun = await one(`select status, trigger_source, finished_at is not null done from saas_ugc.vyora_payment_reconcile_runs order by started_at desc limit 1`);
assert.equal(lastRun.trigger_source, 'cron'); assert.equal(lastRun.done, true); assert.ok(['ok', 'partial'].includes(lastRun.status));
const health = (await asBoss.query(`select public.vyora_admin_payment_health() r`)).rows[0].r;
assert.ok(health.runs.length >= 1); assert.ok(health.anomalies.some((a) => a.kind === 'duplicate_payment'));
assert.ok(!JSON.stringify(health).includes(cronToken));
await assert.rejects(asAlice.query(`select public.vyora_admin_payment_health()`));
ok('exécutions journalisées ; vue d’exploitation lisible par l’administrateur seul, sans le jeton');

summary();
for (const c of [svc, asBoss, asAlice, admin]) await c.end();
