import { applyMigration } from './t.mjs';
import { client } from './pg.mjs';
import assert from 'node:assert/strict';

const FILES = [
  '20261113100000_vyora_saspay_payments.sql',
  '20261113110000_vyora_saspay_refunds_reconcile.sql',
  '20261113120000_vyora_pricing_margin.sql',
  '20261113130000_vyora_admin_rpc_revoke_anon.sql',
];
for (const file of FILES) {
  await applyMigration(file); console.log(`migration ok (1re passe) — ${file}`);
}
// Seconde passe complète : les migrations sont idempotentes, dans l'ordre.
for (const file of FILES) {
  await applyMigration(file); console.log(`migration ok (2e passe, idempotente) — ${file}`);
}

// La politique de prix est livrée ACTIVE (provision de 1 000 FCFA). Les scénarios
// historiques (prix de base = prix payé) vérifient que rien ne change quand elle
// est désactivée : on la coupe ici ; `pricing.mjs` la rallume pour ses propres cas.
const db = client('postgres'); await db.connect();
const { rows } = await db.query(`select setting_value v from saas_ugc.ugc_app_settings where setting_key = 'vyora_pricing_policy'`);
assert.equal(rows[0].v.enabled, true, 'politique active par défaut');
assert.equal(rows[0].v.currencies.XOF.provision_cents, 100000, 'provision de 1 000 FCFA par défaut');
assert.equal(Number((await db.query(`select count(*) n from saas_ugc.vyora_fee_schedule`)).rows[0].n), 0, 'aucun tarif livré');
await db.query(`update saas_ugc.ugc_app_settings set setting_value = setting_value || '{"enabled": false}' where setting_key = 'vyora_pricing_policy'`);
// RPC d'administration : jamais appelables sans session (constat de production).
const { rows: open } = await db.query(`
  select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'vyora\\_admin\\_%' and has_function_privilege('anon', p.oid, 'execute')`);
assert.deepEqual(open.map((row) => row.proname), [], 'aucune RPC d’administration exécutable par anon');
await db.end();
console.log('politique de prix : active par défaut (1 000 FCFA, barème vide) — désactivée pour les scénarios historiques');
