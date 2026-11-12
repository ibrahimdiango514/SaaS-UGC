// Les deux RPC historiques accessibles au navigateur, chargées TELLES QUELLES
// depuis la migration du dépôt, face aux gardes SasPay :
//   - public.ugc_create_recharge_order  (client)  : ne doit pas créer de commande SasPay ;
//   - public.reelora_admin_confirm_recharge (admin) : ne doit pas valider une commande SasPay.
// Le parcours manuel existant (provider « manual ») doit continuer de fonctionner.
import { client, readMigration } from './pg.mjs';
import { connectAs, rpc, fails, ok, summary, assert } from './t.mjs';

const admin = client('postgres'); await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];

const source = readMigration('20261111165732_vyora_customer_isolation_and_admin_entitlement.sql');
function extract(name) {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `fonction ${name} introuvable dans la migration du dépôt`);
  const end = source.indexOf('\n$$;', start);
  return source.slice(start, end + 4);
}
// Bouchons (absents des migrations du dépôt, présents en production) — formes minimales.
await admin.query(`
  create or replace function saas_ugc.ugc_is_admin() returns boolean language sql stable security definer set search_path = ''
    as $f$ select ugc_private.has_role((select auth.uid()), 'admin') $f$;
  create table if not exists saas_ugc.ugc_country_pricing (country_code char(2) primary key, currency char(3) not null,
    min_amount_minor bigint not null, max_amount_minor bigint not null, credits_per_1000_minor numeric not null, active boolean not null default true);
  insert into saas_ugc.ugc_country_pricing values ('ML', 'XOF', 100000, 50000000, 1, true) on conflict do nothing;
`);
for (const name of ['ugc_private.reelora_assert_vyora_customer', 'public.ugc_create_recharge_order', 'public.reelora_admin_confirm_recharge']) {
  await admin.query(extract(name));
}
await admin.query(`grant execute on function public.ugc_create_recharge_order(bigint, character, text, text) to authenticated;
  grant execute on function public.reelora_admin_confirm_recharge(uuid, text) to authenticated;`);
await admin.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": true}' where setting_key = 'saspay_payment_config'`);

const { id: dave } = await one(`insert into auth.users(email) values ('legacy-dave@test.local') returning id`);
await admin.query(`insert into saas_ugc.ugc_customer_accounts(user_id) values ($1)`, [dave]);
await admin.query(`insert into saas_ugc.ugc_wallets(user_id) values ($1)`, [dave]);
await admin.query(`delete from saas_ugc.ugc_user_roles`);
const { id: boss } = await one(`insert into auth.users(email) values ('legacy-boss@test.local') returning id`);
await admin.query(`insert into saas_ugc.ugc_user_roles(user_id, role) values ($1, 'admin')`, [boss]);
const asDave = await connectAs('authenticated', dave), asBoss = await connectAs('authenticated', boss), svc = await connectAs('service_role');
const wallet = async () => Number((await one(`select available_balance b from saas_ugc.ugc_wallets where user_id = $1`, [dave])).b);
const ledger = async () => Number((await one(`select count(*) n from saas_ugc.ugc_credit_ledger where user_id = $1`, [dave])).n);
const legacyCreate = (provider, key) => rpc(asDave, 'ugc_create_recharge_order', { p_amount_minor: 500000, p_country_code: 'ML', p_provider: provider, p_idempotency_key: key });

console.log('Anciennes RPC face aux gardes SasPay');
await fails(legacyCreate('saspay', 'legacy-key-0001'), /saspay_order_requires_payment_service/, 'création SasPay par le navigateur');
ok('ugc_create_recharge_order(provider = saspay) appelée par un client → refusée');
for (const spelling of ['SasPay', 'SASPAY', ' saspay', 'saspay ', 'Saspay\t', 'sas-pay', 'Sas Pay']) {
  await fails(legacyCreate(spelling, `legacy-key-sp-${Buffer.from(spelling).toString('hex')}`), /saspay_provider_name_reserved/, `graphie « ${spelling} »`);
}
ok('graphies voisines (« SasPay », « SASPAY », espaces) → refusées : pas de fausse commande SasPay');
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_recharge_orders where user_id = $1`, [dave])).n), 0);

const manualId = await legacyCreate('manual', 'legacy-key-0002');
assert.equal((await one(`select provider, status from saas_ugc.ugc_recharge_orders where id = $1`, [manualId])).status, 'pending');
ok('parcours manuel existant : la commande « manual » se crée toujours');
await fails(rpc(asDave, 'reelora_admin_confirm_recharge', { p_order_id: manualId, p_provider_reference: null }), /forbidden/, 'client non admin');
assert.equal(await rpc(asBoss, 'reelora_admin_confirm_recharge', { p_order_id: manualId, p_provider_reference: 'RECU-1' }), true);
const manualCredits = await wallet(); assert.ok(manualCredits > 0); assert.equal(await ledger(), 1);
ok(`parcours manuel existant : validation par l’administrateur toujours possible (${manualCredits} crédits)`);

const sp = await rpc(svc, 'vyora_payment_create_studio_order', {
  p_user_id: dave, p_kind: 'pack', p_pack_key: 'creator', p_amount_xof: null, p_country: 'ML', p_flow: 'softpay', p_network: 'orange_ml',
  p_idempotency_key: 'legacy-key-0003', p_quoted_fee: null, p_quoted_total: null, p_quoted_fee_mode: null, p_msisdn_masked: '+223••••••12',
});
await fails(rpc(asBoss, 'reelora_admin_confirm_recharge', { p_order_id: sp.id, p_provider_reference: null }), /saspay_order_requires_verified_payment/, 'validation manuelle (pending)');
await rpc(svc, 'vyora_payment_studio_attach', { p_order_id: sp.id, p_payment_id: 'tx-legacy-0001', p_session_id: null, p_checkout_url: null, p_provider_status: 'PENDING' });
await fails(rpc(asBoss, 'reelora_admin_confirm_recharge', { p_order_id: sp.id, p_provider_reference: 'FAUX' }), /saspay_order_requires_verified_payment/, 'validation manuelle (processing)');
assert.equal(await wallet(), manualCredits); assert.equal(await ledger(), 1);
assert.equal((await one(`select status from saas_ugc.ugc_recharge_orders where id = $1`, [sp.id])).status, 'processing');
assert.equal(Number((await one(`select count(*) n from saas_ugc.ugc_payment_events where recharge_order_id = $1`, [sp.id])).n), 0);
ok('reelora_admin_confirm_recharge sur une commande SasPay → refusée ; ni crédit, ni écriture, ni événement (transaction annulée en entier)');

summary();
for (const c of [asDave, asBoss, svc, admin]) await c.end();
