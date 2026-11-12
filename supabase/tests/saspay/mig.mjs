import { applyMigration } from './t.mjs';
await applyMigration('20261113100000_vyora_saspay_payments.sql'); console.log('migration ok (1re passe)');
await applyMigration('20261113100000_vyora_saspay_payments.sql'); console.log('migration ok (2e passe, idempotente)');
