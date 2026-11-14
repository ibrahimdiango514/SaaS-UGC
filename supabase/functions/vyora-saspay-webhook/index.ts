// VYORA — Edge Function `vyora-saspay-webhook` (`verify_jwt = false`).
//
// Appelée par SasPay. Authentifiée par signature HMAC-SHA256 sur le corps brut
// (`X-Webhook-Signature`, `X-Webhook-Timestamp`, tolérance 300 s) avec le secret
// VYORA_SASPAY_WEBHOOK_SECRET. Le statut annoncé n'est jamais cru : chaque
// événement déclenche `GET /payments/{id}/verify/` avant toute livraison.
import { createWebhookHandler, readPaymentsEnv } from '../_shared/saspay/http.ts';

type DenoLike = { env: { get(key: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
const runtime = (globalThis as unknown as { Deno: DenoLike }).Deno;

runtime.serve(createWebhookHandler({ env: readPaymentsEnv((key) => runtime.env.get(key) ?? '') }));
