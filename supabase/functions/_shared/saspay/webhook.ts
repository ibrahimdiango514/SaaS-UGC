// VYORA — vérification de la signature des webhooks SasPay.
//
// Contrat documenté (https://docs.saspay.me/api-reference/webhooks) :
//   X-Webhook-Signature = HMAC-SHA256(secret, `${timestamp}.${corpsBrut}`), hex minuscule
//   X-Webhook-Timestamp = secondes Unix, régénéré à chaque tentative
//   rejet si l'écart avec l'horloge dépasse 300 secondes
// La signature porte sur le CORPS BRUT : il ne doit jamais être re-sérialisé.

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookRejection = 'missing' | 'malformed' | 'expired' | 'mismatch';
export type WebhookVerification = { ok: true } | { ok: false; reason: WebhookRejection };

const HEX_64 = /^[0-9a-f]{64}$/;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Comparaison à temps constant de deux chaînes hexadécimales de même longueur. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signWebhook(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
}

export async function verifyWebhookSignature(input: {
  secret: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<WebhookVerification> {
  const signature = (input.signature ?? '').trim().toLowerCase();
  const timestamp = (input.timestamp ?? '').trim();
  if (!input.secret || !signature || !timestamp) return { ok: false, reason: 'missing' };
  if (!HEX_64.test(signature) || !/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'malformed' };
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - Number(timestamp)) > tolerance) return { ok: false, reason: 'expired' };
  const expected = await signWebhook(input.secret, timestamp, input.rawBody);
  return timingSafeEqualHex(expected, signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
