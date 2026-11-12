// VYORA — Edge Function `vyora-payments` (JWT requis : `verify_jwt = true`).
//
// POST { action: 'options' | 'create' | 'status' | 'balances', … }
// Secrets lus côté serveur uniquement : SASPAY_SECRET_KEY (ou
// VYORA_SASPAY_SECRET_KEY), SUPABASE_SERVICE_ROLE_KEY. Rien n'est renvoyé au
// navigateur hormis l'état des commandes de l'utilisateur.
import { createPaymentsHandler, readPaymentsEnv } from '../_shared/saspay/http.ts';

type DenoLike = { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
const runtime = (globalThis as unknown as { Deno: DenoLike }).Deno;

runtime.serve(createPaymentsHandler({ env: readPaymentsEnv((key) => runtime.env.get(key) ?? '') }));
