import { applyMigration } from './t.mjs';
for (const file of ['20261113100000_vyora_saspay_payments.sql', '20261113110000_vyora_saspay_refunds_reconcile.sql']) {
  await applyMigration(file); console.log(`migration ok (1re passe) — ${file}`);
}
// Seconde passe complète : les deux migrations sont idempotentes, dans l'ordre.
for (const file of ['20261113100000_vyora_saspay_payments.sql', '20261113110000_vyora_saspay_refunds_reconcile.sql']) {
  await applyMigration(file); console.log(`migration ok (2e passe, idempotente) — ${file}`);
}
