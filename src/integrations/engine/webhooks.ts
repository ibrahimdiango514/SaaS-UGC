/**
 * SORAHNEX — réception de webhooks entrants.
 *
 * ## Le principe
 *
 * Un webhook est une **requête non authentifiée** : n'importe qui peut appeler
 * l'URL publique. La seule chose qui distingue un vrai événement d'un faux est
 * la signature HMAC. Ce module ne fait donc qu'une chose : décider si une
 * requête est authentique. Il ne traite aucun événement, ne touche à aucune
 * base et ne lit aucun jeton.
 *
 * ## Ce qu'il refuse
 *
 * - une requête sans signature, sans horodatage, ou avec un horodatage hors
 *   fenêtre (rejeu) ;
 * - une signature de mauvaise longueur (comparaison à temps constant
 *   uniquement sur des chaînes de même longueur) ;
 * - un corps re-sérialisé : la signature porte sur les octets **bruts**. Un
 *   `JSON.stringify(JSON.parse(raw))` change l'ordre des clés et invalide tout.
 *
 * ## Réutilisation
 *
 * La vérification SasPay (`supabase/functions/_shared/saspay/webhook.ts`) suit
 * exactement ce modèle. Plutôt que d'en écrire une variante, `verifyWebhook`
 * paramètre l'algorithme : un seul comportement, plusieurs fournisseurs.
 */
import { timingSafeEqualHex } from '../../../supabase/functions/_shared/saspay/webhook';

/** Fenêtre de tolérance d'horloge, en secondes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookRejection =
  | 'missing'      // signature ou horodatage absent
  | 'malformed'    // forme invalide (non hex, longueur incorrecte)
  | 'expired'      // hors fenêtre : rejeu probable
  | 'mismatch';    // signature calculée différente

export type WebhookVerdict =
  | { ok: true; algorithm: string }
  | { ok: false; reason: WebhookRejection };

export interface WebhookInput {
  /** Corps brut, tel que reçu. Ne doit jamais être re-sérialisé. */
  rawBody: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  /** Secret partagé, détenu côté serveur uniquement. */
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
  algorithm?: 'sha256';
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Signature HMAC hexadécimale de `${timestamp}.${rawBody}`.
 *
 * L'horodatage entre dans le message signé : sans lui, une signature valide
 * resterait valide indéfiniment et le rejeu serait trivial.
 */
export async function signPayload(secret: string, timestamp: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)));
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Décide si une requête entrante est authentique.
 *
 * L'ordre des contrôles est significatif : on valide la **forme** avant le
 * calcul, pour ne pas dépenser de HMAC sur une requête manifestement forgée,
 * et on vérifie l'horodatage avant de comparer, pour ne pas laisser une
 * signature ancienne valide.
 */
export async function verifyWebhook(input: WebhookInput): Promise<WebhookVerdict> {
  const signature = (input.signature ?? '').trim().toLowerCase();
  const timestamp = (input.timestamp ?? '').trim();

  if (!input.secret || !signature || !timestamp) return { ok: false, reason: 'missing' };
  if (!HEX_64.test(signature) || !/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'malformed' };

  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const écart = Math.abs(input.nowSeconds - Number(timestamp));
  if (écart > tolerance) return { ok: false, reason: 'expired' };

  const expected = await signPayload(input.secret, timestamp, input.rawBody);
  return timingSafeEqualHex(expected, signature)
    ? { ok: true, algorithm: input.algorithm ?? 'sha256' }
    : { ok: false, reason: 'mismatch' };
}

/**
 * Identifiant d'événement pour la déduplication.
 *
 * Les fournisseurs réémettent un webhook quand ils n'ont pas reçu de 200 :
 * sans déduplication, une même commande serait importée plusieurs fois.
 * L'identifiant vient de l'en-tête du fournisseur quand il existe ; sinon on
 * dérive une empreinte stable du corps signé.
 */
export async function eventFingerprint(rawBody: string, providedId: string | null | undefined): Promise<string> {
  const id = (providedId ?? '').trim();
  if (id) return id;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  return toHex(digest);
}
