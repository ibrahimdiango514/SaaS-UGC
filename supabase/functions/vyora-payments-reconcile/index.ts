// VYORA — Edge Function `vyora-payments-reconcile` (`verify_jwt = false`).
//
// Appelée uniquement par la tâche pg_cron `vyora-payments-reconcile` via pg_net.
// Deux protections, dans cet ordre : l'en-tête `x-vyora-cron: payments-reconcile`
// puis un jeton aléatoire stocké dans Supabase Vault, comparé à temps constant.
// Elle revérifie auprès de SasPay les commandes en attente et rattrape les
// webhooks perdus. Lecture seule côté SasPay : aucun paiement n'est initié.
// Secrets lus côté serveur uniquement : VYORA_SASPAY_SECRET_KEY,
// SUPABASE_SERVICE_ROLE_KEY.
import { createReconcileHandler, readPaymentsEnv } from '../_shared/saspay/http.ts';

type DenoLike = { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
const runtime = (globalThis as unknown as { Deno: DenoLike }).Deno;

runtime.serve(createReconcileHandler({ env: readPaymentsEnv((key) => runtime.env.get(key) ?? '') }));
