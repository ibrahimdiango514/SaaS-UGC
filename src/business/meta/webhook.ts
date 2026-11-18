/**
 * VYORA Meta Integrations — réception des Webhooks Meta.
 *
 * - Vérification d'abonnement (GET) : `hub.mode=subscribe` et
 *   `hub.verify_token` égal au secret `META_WEBHOOK_VERIFY_TOKEN`, comparé à
 *   temps constant ; on répond `hub.challenge` en clair.
 * - Notifications (POST) : signature `X-Hub-Signature-256 = sha256=HMAC(app
 *   secret, corps brut)`. Le corps est lu **tel quel** (pas re-sérialisé) ;
 *   la comparaison est à temps constant ; sans signature valide, rien n'est
 *   lu ni stocké.
 * - Idempotence : chaque événement reçoit une clé de déduplication stable
 *   (identifiant Meta du message / du statut / du changement). Une relivraison
 *   Meta (fréquente : Meta réessaie jusqu'à 7 jours sans 200) est ignorée.
 *
 * Ce module ne touche pas à la base : il transforme un corps Meta en
 * événements normalisés que le gestionnaire persiste.
 */

export type MetaWebhookObject = 'whatsapp_business_account' | 'page' | 'instagram';

export type NormalizedEvent =
  | {
    kind: 'whatsapp.message';
    dedupeKey: string;
    phoneNumberId: string;
    wabaId: string;
    messageId: string;
    from: string;
    timestamp: Date;
    type: string;
    text: string | null;
    raw: unknown;
  }
  | {
    kind: 'whatsapp.status';
    dedupeKey: string;
    phoneNumberId: string;
    wabaId: string;
    messageId: string;
    status: string;
    recipient: string | null;
    timestamp: Date;
    errorCode: number | null;
    errorTitle: string | null;
    raw: unknown;
  }
  | {
    kind: 'whatsapp.template_status';
    dedupeKey: string;
    wabaId: string;
    templateName: string | null;
    event: string | null;
    raw: unknown;
  }
  | {
    kind: 'messenger.message';
    dedupeKey: string;
    pageId: string;
    senderId: string;
    recipientId: string;
    messageId: string;
    text: string | null;
    isEcho: boolean;
    timestamp: Date;
    raw: unknown;
  }
  | {
    kind: 'messenger.delivery' | 'messenger.read';
    dedupeKey: string;
    pageId: string;
    senderId: string;
    messageIds: string[];
    watermark: number;
    raw: unknown;
  }
  | {
    kind: 'page.feed';
    dedupeKey: string;
    pageId: string;
    item: string | null;
    verb: string | null;
    postId: string | null;
    commentId: string | null;
    message: string | null;
    fromId: string | null;
    timestamp: Date;
    raw: unknown;
  }
  | {
    kind: 'instagram.comment';
    dedupeKey: string;
    igId: string;
    commentId: string | null;
    mediaId: string | null;
    text: string | null;
    fromId: string | null;
    raw: unknown;
  }
  | {
    kind: 'unknown';
    dedupeKey: string;
    object: string;
    raw: unknown;
  };

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison à temps constant de deux chaînes (longueur comprise). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ba.length ^ bb.length;
  const n = Math.max(ba.length, bb.length);
  for (let i = 0; i < n; i += 1) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, body: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const data = typeof body === 'string' ? encoder.encode(body) : body;
  const signature = await crypto.subtle.sign('HMAC', key, data as BufferSource);
  return hex(signature);
}

/**
 * Vérifie `X-Hub-Signature-256`. Rend `false` si l'en-tête est absent, mal
 * formé, ou si le HMAC diffère — sans distinguer les cas pour l'appelant.
 */
export async function verifySignature(appSecret: string, rawBody: string | Uint8Array, header: string | null): Promise<boolean> {
  if (!appSecret || !header) return false;
  const trouve = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!trouve) return false;
  const attendu = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqual(attendu.toLowerCase(), trouve[1].toLowerCase());
}

/** Réponse à la vérification d'abonnement Meta (GET). */
export function verificationChallenge(
  query: URLSearchParams,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false } {
  const mode = query.get('hub.mode');
  const token = query.get('hub.verify_token') ?? '';
  const challenge = query.get('hub.challenge') ?? '';
  if (mode !== 'subscribe' || !verifyToken || !challenge) return { ok: false };
  if (!timingSafeEqual(token, verifyToken)) return { ok: false };
  return { ok: true, challenge };
}

function dateFromUnix(value: unknown): Date {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return new Date();
  // WhatsApp envoie des secondes, Messenger des millisecondes.
  return new Date(n > 1e12 ? n : n * 1000);
}

function texte(value: unknown, max = 4000): string | null {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

/** Transforme un corps Webhook Meta en événements normalisés. */
export function parseWebhook(payload: unknown): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  if (!payload || typeof payload !== 'object') return events;
  const corps = payload as { object?: unknown; entry?: unknown };
  const object = typeof corps.object === 'string' ? corps.object : 'unknown';
  const entries = Array.isArray(corps.entry) ? corps.entry : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const entryId = String(e.id ?? '');

    if (object === 'whatsapp_business_account') {
      for (const change of Array.isArray(e.changes) ? e.changes : []) {
        const c = change as { field?: string; value?: Record<string, unknown> };
        const value = c.value ?? {};
        if (c.field === 'messages') {
          const metadata = (value.metadata ?? {}) as Record<string, unknown>;
          const phoneNumberId = String(metadata.phone_number_id ?? '');
          for (const m of Array.isArray(value.messages) ? value.messages : []) {
            const msg = m as Record<string, unknown>;
            const id = String(msg.id ?? '');
            if (!id) continue;
            const type = String(msg.type ?? 'unknown');
            const textBody = type === 'text' ? texte((msg.text as Record<string, unknown> | undefined)?.body) : null;
            events.push({
              kind: 'whatsapp.message',
              dedupeKey: `wa:msg:${id}`,
              phoneNumberId,
              wabaId: entryId,
              messageId: id,
              from: String(msg.from ?? ''),
              timestamp: dateFromUnix(msg.timestamp),
              type,
              text: textBody,
              raw: msg,
            });
          }
          for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
            const st = s as Record<string, unknown>;
            const id = String(st.id ?? '');
            const status = String(st.status ?? '');
            if (!id || !status) continue;
            const erreurs = Array.isArray(st.errors) ? (st.errors as Array<Record<string, unknown>>) : [];
            events.push({
              kind: 'whatsapp.status',
              dedupeKey: `wa:status:${id}:${status}`,
              phoneNumberId,
              wabaId: entryId,
              messageId: id,
              status,
              recipient: texte(st.recipient_id, 64),
              timestamp: dateFromUnix(st.timestamp),
              errorCode: typeof erreurs[0]?.code === 'number' ? (erreurs[0].code as number) : null,
              errorTitle: texte(erreurs[0]?.title, 300),
              raw: st,
            });
          }
        } else if (c.field === 'message_template_status_update') {
          const name = texte(value.message_template_name, 512);
          const event = texte(value.event, 64);
          events.push({
            kind: 'whatsapp.template_status',
            dedupeKey: `wa:tpl:${entryId}:${name ?? ''}:${event ?? ''}:${String(value.message_template_id ?? '')}`,
            wabaId: entryId,
            templateName: name,
            event,
            raw: value,
          });
        } else {
          events.push({ kind: 'unknown', dedupeKey: `wa:${entryId}:${c.field ?? 'field'}:${hashLite(JSON.stringify(value))}`, object, raw: change });
        }
      }
      continue;
    }

    if (object === 'page') {
      for (const m of Array.isArray(e.messaging) ? e.messaging : []) {
        const ev = m as Record<string, unknown>;
        const sender = String((ev.sender as Record<string, unknown> | undefined)?.id ?? '');
        const recipient = String((ev.recipient as Record<string, unknown> | undefined)?.id ?? '');
        if (ev.message && typeof ev.message === 'object') {
          const msg = ev.message as Record<string, unknown>;
          const mid = String(msg.mid ?? '');
          if (!mid) continue;
          events.push({
            kind: 'messenger.message',
            dedupeKey: `fb:msg:${mid}`,
            pageId: entryId,
            senderId: sender,
            recipientId: recipient,
            messageId: mid,
            text: texte(msg.text),
            isEcho: msg.is_echo === true,
            timestamp: dateFromUnix(ev.timestamp),
            raw: ev,
          });
        } else if (ev.delivery && typeof ev.delivery === 'object') {
          const d = ev.delivery as Record<string, unknown>;
          const mids = Array.isArray(d.mids) ? d.mids.map(String) : [];
          const watermark = Number(d.watermark ?? 0);
          events.push({ kind: 'messenger.delivery', dedupeKey: `fb:delivery:${entryId}:${sender}:${watermark}`, pageId: entryId, senderId: sender, messageIds: mids, watermark, raw: ev });
        } else if (ev.read && typeof ev.read === 'object') {
          const watermark = Number((ev.read as Record<string, unknown>).watermark ?? 0);
          events.push({ kind: 'messenger.read', dedupeKey: `fb:read:${entryId}:${sender}:${watermark}`, pageId: entryId, senderId: sender, messageIds: [], watermark, raw: ev });
        }
      }
      for (const change of Array.isArray(e.changes) ? e.changes : []) {
        const c = change as { field?: string; value?: Record<string, unknown> };
        const value = c.value ?? {};
        if (c.field === 'feed') {
          const commentId = texte(value.comment_id, 128);
          const postId = texte(value.post_id, 128);
          events.push({
            kind: 'page.feed',
            dedupeKey: `fb:feed:${entryId}:${String(value.item ?? '')}:${String(value.verb ?? '')}:${commentId ?? postId ?? ''}:${String(value.created_time ?? '')}`,
            pageId: entryId,
            item: texte(value.item, 64),
            verb: texte(value.verb, 64),
            postId,
            commentId,
            message: texte(value.message),
            fromId: texte((value.from as Record<string, unknown> | undefined)?.id, 64),
            timestamp: dateFromUnix(value.created_time ?? e.time),
            raw: change,
          });
        } else {
          events.push({ kind: 'unknown', dedupeKey: `fb:${entryId}:${c.field ?? 'field'}:${hashLite(JSON.stringify(value))}`, object, raw: change });
        }
      }
      continue;
    }

    if (object === 'instagram') {
      for (const change of Array.isArray(e.changes) ? e.changes : []) {
        const c = change as { field?: string; value?: Record<string, unknown> };
        const value = c.value ?? {};
        if (c.field === 'comments') {
          const commentId = texte(value.id, 128);
          events.push({
            kind: 'instagram.comment',
            dedupeKey: `ig:comment:${commentId ?? hashLite(JSON.stringify(value))}`,
            igId: entryId,
            commentId,
            mediaId: texte((value.media as Record<string, unknown> | undefined)?.id, 128),
            text: texte(value.text),
            fromId: texte((value.from as Record<string, unknown> | undefined)?.id, 64),
            raw: change,
          });
        } else {
          events.push({ kind: 'unknown', dedupeKey: `ig:${entryId}:${c.field ?? 'field'}:${hashLite(JSON.stringify(value))}`, object, raw: change });
        }
      }
      continue;
    }

    events.push({ kind: 'unknown', dedupeKey: `${object}:${entryId}:${hashLite(JSON.stringify(entry))}`, object, raw: entry });
  }
  return events;
}

/** Empreinte courte et déterministe (FNV-1a 32 bits), suffisante pour une clé de déduplication. */
export function hashLite(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
