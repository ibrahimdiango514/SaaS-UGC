/**
 * VYORA Meta Integrations — réception des Webhooks (fonction Edge
 * `meta-webhook`).
 *
 * ## Ce que Meta peut appeler ici
 *
 * - `GET /meta-webhook` : vérification d'abonnement. Meta envoie
 *   `hub.mode=subscribe`, `hub.verify_token` et `hub.challenge` ; on répond le
 *   challenge en clair UNIQUEMENT si le jeton correspond à
 *   `META_WEBHOOK_VERIFY_TOKEN` (comparaison à temps constant).
 * - `POST /meta-webhook` : notification. La signature
 *   `X-Hub-Signature-256` porte sur le corps BRUT. Sans signature valide, rien
 *   n'est lu : la requête est rejetée en 401 avant tout accès base.
 *
 * ## Idempotence
 *
 * Meta réessaie jusqu'à 7 jours si on ne répond pas 200. Chaque événement
 * reçoit une clé de déduplication stable (`message id`, `statut`, `mid`…).
 * `saas_business.meta_webhook_event_record` écrit avec `on conflict do nothing`
 * et rend `false` si la clé existait : la relivraison est alors ignorée sans
 * doublon en base ni double traitement.
 *
 * ## Aucune confiance dans le corps
 *
 * Un événement n'est enregistré que s'il est rattachable à une connexion
 * RÉELLE (`meta_resolve_phone` / `meta_resolve_page` / `meta_resolve_instagram`
 * côté base). Un WABA ou une page inconnus de VYORA ne créent aucune donnée.
 */
import {
  parseWebhook,
  verificationChallenge,
  verificationDiagnostic,
  verifySignature,
  type NormalizedEvent,
} from '../../../src/business/meta/webhook.ts';
import { redactTokens } from '../../../src/business/meta/graph.ts';

export interface WebhookDeps {
  verifyToken: string;
  appSecret: string;
  /** Enregistre l'événement ; `false` = déjà connu (relivraison). */
  recordEvent(object: string, kind: string, dedupeKey: string, payload: unknown): Promise<boolean>;
  finishEvent(dedupeKey: string, error: string | null): Promise<void>;
  resolvePhone(phoneNumberId: string): Promise<{ connectionId: string; userId: string; workspaceId: string } | null>;
  resolvePage(pageId: string, product: 'facebook' | 'messenger'): Promise<{ connectionId: string; userId: string; workspaceId: string } | null>;
  resolveInstagram(igId: string): Promise<{ connectionId: string; userId: string; workspaceId: string; pageId: string } | null>;
  messageRecord(payload: Record<string, unknown>): Promise<void>;
  messageSetStatus(externalMessageId: string, status: string, errorCode: number | null, errorMessage: string | null): Promise<void>;
  pageEventRecord(payload: Record<string, unknown>): Promise<void>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface WebhookOptions {
  /** Longueur maximale acceptée pour un corps (Meta plafonne à ~1 Mio). */
  maxBytes?: number;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Un événement est-il rattaché à une connexion réelle ? Sinon on l'ignore. */
async function processEvent(event: NormalizedEvent, deps: WebhookDeps): Promise<void> {
  switch (event.kind) {
    case 'whatsapp.message': {
      const cible = await deps.resolvePhone(event.phoneNumberId);
      if (!cible) {
        deps.log?.('meta-webhook: numéro WhatsApp inconnu, événement ignoré', { wabaId: event.wabaId });
        return;
      }
      await deps.messageRecord({
        user_id: cible.userId,
        workspace_id: cible.workspaceId,
        connection_id: cible.connectionId,
        channel: 'whatsapp',
        account_ref: event.phoneNumberId,
        conversation_ref: event.from,
        external_message_id: event.messageId,
        direction: 'in',
        message_type: event.type,
        body: event.text ?? `[${event.type}]`,
        status: 'received',
        sent_at: event.timestamp.toISOString(),
      });
      return;
    }
    case 'whatsapp.status': {
      await deps.messageSetStatus(event.messageId, event.status, event.errorCode, event.errorTitle);
      return;
    }
    case 'messenger.message': {
      const cible = await deps.resolvePage(event.pageId, 'messenger');
      if (!cible) return;
      // Un écho est notre propre message rediffusé : il est déjà enregistré à
      // l'envoi, on ne le compte pas deux fois.
      if (event.isEcho) return;
      await deps.messageRecord({
        user_id: cible.userId,
        workspace_id: cible.workspaceId,
        connection_id: cible.connectionId,
        channel: 'messenger',
        account_ref: event.pageId,
        conversation_ref: event.senderId,
        external_message_id: event.messageId,
        direction: 'in',
        message_type: 'text',
        body: event.text ?? '[pièce jointe]',
        status: 'received',
        sent_at: event.timestamp.toISOString(),
      });
      return;
    }
    case 'messenger.delivery':
    case 'messenger.read': {
      const statut = event.kind === 'messenger.delivery' ? 'delivered' : 'read';
      for (const mid of event.messageIds) {
        await deps.messageSetStatus(mid, statut, null, null);
      }
      return;
    }
    case 'page.feed': {
      const cible = await deps.resolvePage(event.pageId, 'facebook');
      if (!cible) return;
      await deps.pageEventRecord({
        user_id: cible.userId,
        workspace_id: cible.workspaceId,
        page_id: event.pageId,
        channel: 'facebook',
        item: event.item,
        verb: event.verb,
        post_id: event.postId,
        comment_id: event.commentId,
        from_id: event.fromId,
        message: event.message,
        occurred_at: event.timestamp.toISOString(),
      });
      return;
    }
    case 'instagram.comment': {
      const cible = await deps.resolveInstagram(event.igId);
      if (!cible) return;
      await deps.pageEventRecord({
        user_id: cible.userId,
        workspace_id: cible.workspaceId,
        page_id: cible.pageId,
        channel: 'instagram',
        item: 'comment',
        verb: 'add',
        post_id: event.mediaId,
        comment_id: event.commentId,
        from_id: event.fromId,
        message: event.text,
        occurred_at: new Date().toISOString(),
      });
      return;
    }
    default:
      // Événement non géré (champ inconnu, objet inconnu) : tracé, pas rejoué.
      return;
  }
}

export async function handleMetaWebhook(
  request: Request,
  deps: WebhookDeps,
  options: WebhookOptions = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    /*
     * Diagnostic sans valeur secrète : Meta n'affiche qu'un message générique
     * quand la poignée de main échoue (« URL couldn't be validated »), ce qui
     * rend « jeton absent » et « jeton différent » indiscernables depuis la
     * console Meta. Le motif renvoyé est un CODE, jamais le jeton attendu.
     */
    if (!deps.verifyToken) {
      deps.log?.('meta-webhook: vérification refusée', { reason: 'TOKEN_NOT_CONFIGURED' });
      return new Response('webhook non configuré (TOKEN_NOT_CONFIGURED)', { status: 503 });
    }
    const verification = verificationChallenge(url.searchParams, deps.verifyToken);
    if (!verification.ok) {
      deps.log?.('meta-webhook: vérification refusée', { reason: verificationDiagnostic(url.searchParams, deps.verifyToken) });
      return new Response(`vérification refusée (${verificationDiagnostic(url.searchParams, deps.verifyToken)})`, { status: 403 });
    }
    return new Response(verification.challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  if (!deps.appSecret) {
    deps.log?.('meta-webhook: META_APP_SECRET absent, notification refusée');
    return new Response('webhook non configuré', { status: 503 });
  }

  const limite = options.maxBytes ?? 1_048_576;
  const annonce = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(annonce) && annonce > limite) {
    return new Response('payload too large', { status: 413 });
  }
  const brut = await request.text();
  if (brut.length > limite) return new Response('payload too large', { status: 413 });

  const signature = request.headers.get('x-hub-signature-256');
  const valide = await verifySignature(deps.appSecret, brut, signature);
  if (!valide) {
    deps.log?.('meta-webhook: signature invalide, notification rejetée');
    return new Response('invalid signature', { status: 401 });
  }

  let corps: unknown;
  try {
    corps = JSON.parse(brut);
  } catch {
    return new Response(JSON.stringify({ error: { code: 'INVALID_JSON', message: 'Corps illisible.' } }), {
      status: 400, headers: JSON_HEADERS,
    });
  }

  const evenements = parseWebhook(corps);
  const object = corps && typeof corps === 'object' && typeof (corps as { object?: unknown }).object === 'string'
    ? String((corps as { object: string }).object)
    : 'unknown';

  let traites = 0;
  let ignores = 0;
  for (const evenement of evenements) {
    try {
      const nouveau = await deps.recordEvent(object, evenement.kind, evenement.dedupeKey, evenement.raw);
      if (!nouveau) {
        ignores += 1;
        continue;
      }
      await processEvent(evenement, deps);
      await deps.finishEvent(evenement.dedupeKey, null);
      traites += 1;
    } catch (erreur) {
      const message = erreur instanceof Error ? redactTokens(erreur.message) : 'inconnue';
      deps.log?.('meta-webhook: traitement impossible', { kind: evenement.kind, message });
      await deps.finishEvent(evenement.dedupeKey, message).catch(() => {});
    }
  }

  // 200 systématique une fois la signature validée : un 4xx ferait réessayer
  // Meta pendant des jours pour un événement qu'on ne saura pas traiter mieux.
  return new Response(JSON.stringify({ received: evenements.length, processed: traites, duplicates: ignores }), {
    status: 200, headers: JSON_HEADERS,
  });
}
