// Lance tout le banc : base → migrations SasPay (2 passes) → scénarios SQL → bout en bout.
//   cd supabase/tests/saspay && npm install && npm test
import { spawnSync } from 'node:child_process';
import { start, HERE } from './pg.mjs';

const steps = [
  ['base.mjs', []],
  ['mig.mjs', []],
  // Modules métier Business Growth : persistance, cloisonnement, RLS.
  ['modules.mjs', []],
  ['scenario.mjs', []],
  ['legacy.mjs', []],
  // Remboursements, entretien, sélection de réconciliation, anomalies, planification.
  ['refunds.mjs', []],
  // Audit : concurrence Business Grow, remboursements sous charge, fuseaux, exécutions.
  ['audit.mjs', []],
  // Création softpay sans réponse : tentatives, blocage d'un second paiement, rapprochement manuel.
  ['unconfirmed.mjs', []],
  // Tarification : provision, couverture des frais, devis figés, rapprochement, barème, rapport financier.
  ['pricing.mjs', []],
  // Les Edge Functions sont du TypeScript : Node ≥ 22.6 sait en retirer les types.
  ['e2e.mjs', ['--experimental-strip-types', '--no-warnings']],
];
let failed = false;
for (const [file, flags] of steps) {
  console.log(`\n── ${file}`);
  const result = spawnSync(process.execPath, [...flags, file], { cwd: HERE, stdio: 'inherit' });
  if (result.status !== 0) { failed = true; console.error(`\n✗ ${file} a échoué (code ${result.status})`); break; }
}
// Arrête le serveur local sans réinitialiser les données (utile pour inspecter un échec).
try { (await start({ fresh: false })).stop(); } catch { /* déjà arrêté */ }
process.exit(failed ? 1 : 0);
