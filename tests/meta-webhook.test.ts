import { describe, expect, it, vi } from 'vitest';
import {
  hmacSha256Hex,
  parseWebhook,
  timingSafeEqual,
  verificationChallenge,
  verifySignature,
  type NormalizedEvent,
} from '../src/business/meta/webhook';
import { handleMetaWebhook, type WebhookDeps } from '../supabase/functions/meta-webhook/handler';

/**
 * Webhooks Meta — la porte d'entrée non authentifiée de VYORA.
 *
 * Ce que ces tests protègent :
 * - sans signature `X-Hub-Signature-256` valide, RIEN n'est lu ni écrit ;
 * - la vérification d'abonnement ne répond le challenge que si le jeton
 *   correspond, comparaison à temps constant ;
 * - une relivraison Meta (fréquente, jusqu'à 7 jours) n'écrit pas de doublon ;
 * - un identifiant Meta inconnu de VYORA ne crée aucune donnée.
 */

const SECRET = 'app-secret-de-test';
const TOKEN = 'verify-token-de-test';

function depsAvec(overrides: Partial<WebhookDeps> = {}): WebhookDeps & { enregistres: string[] } {
  const enregistres: string[] = [];
  const connus = new Set(['wa_appels', 'page_connectee', 'ig_connexion']);
  const deps: WebhookDeps = {
    verifyToken: TOKEN,
    appSecret: SECRET,
    recordEvent: async (_o, _k, cle) => {
      const nouveau = !enregistres.includes(cle);
      if (nouveau) enregistres.push(cle);
      return nouveau;
    },
    finishEvent: async () => {},
    resolvePhone: async (id) => (connus.has(id) ? { connectionId: 'c1', userId: 'u1', workspaceId: 'w1' } : null),
    resolvePage: async (id) => (connus.has(id) ? { connectionId: 'c1', userId: 'u1', workspaceId: 'w1' } : null),
    resolveInstagram: async (id) => (connus.has(id) ? { connectionId: 'c1', userId: 'u1', workspaceId: 'w1', pageId: 'p1' } : null),
    messageRecord: vi.fn(async () => {}),
    messageSetStatus: vi.fn(async () => {}),
    pageEventRecord: vi.fn(async () => {}),
    log: () => {},
    ...overrides,
  };
  return Object.assign(deps, { enregistres });
}

const signer = async (corps: string) => `sha256=${await hmacSha256Hex(SECRET, corps)}`;

function requete(corps: unknown, signature?: string, url = 'https://exemple.supabase.co/functions/v1/meta-webhook'): Request {
  const brut = typeof corps === 'string' ? corps : JSON.stringify(corps);
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    body: brut,
  });
}

/* ------------------------------ Signature ------------------------------- */

describe('signature — HMAC-SHA256 du corps brut', () => {
  it('accepte la signature exacte calculée sur le corps tel qu’il arrive', async () => {
    const corps = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    expect(await verifySignature(SECRET, corps, await signer(corps))).toBe(true);
  });

  it('refuse une signature absente, mal formée, ou calculée sur un autre corps', async () => {
    const corps = '{"object":"page","entry":[]}';
    expect(await verifySignature(SECRET, corps, null)).toBe(false);
    expect(await verifySignature(SECRET, corps, 'sha1=abc')).toBe(false);
    expect(await verifySignature(SECRET, corps, 'sha256=pas-hexadecimal')).toBe(false);
    expect(await verifySignature(SECRET, corps, await signer('{"object":"autre"}'))).toBe(false);
  });

  it('refuse une signature calculée avec un autre secret', async () => {
    const corps = '{"object":"page","entry":[]}';
    const mauvaise = `sha256=${await hmacSha256Hex('mauvais-secret', corps)}`;
    expect(await verifySignature(SECRET, corps, mauvaise)).toBe(false);
  });

  it('sans secret configuré, refuse tout (fail-closed)', async () => {
    // Un secret vide ne peut produire aucune signature valide : on refuse sans
    // même tenter le HMAC (une clé de longueur nulle n'est pas calculable).
    expect(await verifySignature('', '{}', `sha256=${'0'.repeat(64)}`)).toBe(false);
  });

  it('la comparaison est à temps constant et compare aussi la longueur', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

/* -------------------------- Vérification GET ---------------------------- */

describe('vérification d’abonnement (GET)', () => {
  it('rend le challenge quand le jeton correspond', () => {
    const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '12345' });
    expect(verificationChallenge(query, TOKEN)).toEqual({ ok: true, challenge: '12345' });
  });

  it('refuse un jeton différent, un mode différent, ou un challenge vide', () => {
    expect(verificationChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'faux', 'hub.challenge': '1' }), TOKEN).ok).toBe(false);
    expect(verificationChallenge(new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }), TOKEN).ok).toBe(false);
    expect(verificationChallenge(new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }), TOKEN).ok).toBe(false);
  });

  it('GET sur la fonction : 403 sans jeton, challenge en clair avec', async () => {
    const deps = depsAvec();
    const refus = await handleMetaWebhook(new Request('https://x/functions/v1/meta-webhook?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=1'), deps);
    expect(refus.status).toBe(403);
    const ok = await handleMetaWebhook(
      new Request(`https://x/functions/v1/meta-webhook?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=abc123`),
      deps,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('abc123');
  });

  it('sans jeton de vérification configuré : 503, jamais 200', async () => {
    const deps = depsAvec({ verifyToken: '' });
    const reponse = await handleMetaWebhook(
      new Request('https://x/functions/v1/meta-webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=1'),
      deps,
    );
    expect(reponse.status).toBe(503);
  });
});

/* --------------------------- Notifications POST -------------------------- */

describe('POST — sans signature valide, rien n’est écrit', () => {
  it('refuse une requête non signée en 401 et n’enregistre aucun événement', async () => {
    const deps = depsAvec();
    const corps = { object: 'whatsapp_business_account', entry: [] };
    const reponse = await handleMetaWebhook(requete(corps), deps);
    expect(reponse.status).toBe(401);
    expect(deps.enregistres).toHaveLength(0);
    expect(deps.recordEvent).toBeDefined();
  });

  it('refuse aussi une signature falsifiée', async () => {
    const deps = depsAvec();
    const corps = { object: 'page', entry: [] };
    const reponse = await handleMetaWebhook(requete(corps, `sha256=${'0'.repeat(64)}`), deps);
    expect(reponse.status).toBe(401);
    expect(deps.enregistres).toHaveLength(0);
  });

  it('sans App Secret configuré : 503, jamais un traitement à l’aveugle', async () => {
    const deps = depsAvec({ appSecret: '' });
    const reponse = await handleMetaWebhook(requete({ object: 'page', entry: [] }, `sha256=${'0'.repeat(64)}`), deps);
    expect(reponse.status).toBe(503);
  });

  it('rejette un JSON illisible signé correctement (mais ne plante pas)', async () => {
    const deps = depsAvec();
    const brut = '{"object": ';
    const reponse = await handleMetaWebhook(requete(brut, await signer(brut)), deps);
    expect(reponse.status).toBe(400);
  });

  it('refuse un corps trop volumineux', async () => {
    const deps = depsAvec();
    const gros = JSON.stringify({ object: 'page', entry: [], bourrage: 'x'.repeat(2000) });
    const reponse = await handleMetaWebhook(requete(gros, await signer(gros)), deps, { maxBytes: 500 });
    expect(reponse.status).toBe(413);
  });
});

describe('POST — traitement et idempotence', () => {
  const messageWhatsApp = {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_1',
      changes: [{
        field: 'messages',
        value: {
          metadata: { phone_number_id: 'wa_appels' },
          messages: [{ id: 'wamid.A', from: '22370000000', timestamp: '1763000000', type: 'text', text: { body: 'Bonjour' } }],
        },
      }],
    }],
  };

  it('enregistre un message WhatsApp pour un numéro connu de VYORA', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify(messageWhatsApp);
    const reponse = await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    expect(reponse.status).toBe(200);
    expect(deps.messageRecord).toHaveBeenCalledTimes(1);
    const enregistre = (deps.messageRecord as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(enregistre.channel).toBe('whatsapp');
    expect(enregistre.user_id).toBe('u1');
    expect(enregistre.workspace_id).toBe('w1');
    expect(enregistre.body).toBe('Bonjour');
    expect(enregistre.direction).toBe('in');
  });

  it('une relivraison Meta est ignorée : une seule ligne, un seul traitement', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify(messageWhatsApp);
    const signature = await signer(corps);
    const premier = await handleMetaWebhook(requete(corps, signature), deps);
    const second = await handleMetaWebhook(requete(corps, signature), deps);
    expect(premier.status).toBe(200);
    expect(second.status).toBe(200);
    expect(deps.messageRecord).toHaveBeenCalledTimes(1);
    expect(deps.enregistres).toHaveLength(1);
    expect(await second.json()).toMatchObject({ received: 1, processed: 0, duplicates: 1 });
  });

  it('un numéro WhatsApp inconnu de VYORA n’écrit aucune donnée', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_X', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'inconnu' }, messages: [{ id: 'wamid.Z', from: '1', type: 'text', text: { body: 'x' } }] } }] }],
    });
    const reponse = await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    expect(reponse.status).toBe(200);
    expect(deps.messageRecord).not.toHaveBeenCalled();
    // L'événement est tracé (utile au diagnostic) mais rattaché à rien.
    expect(deps.enregistres).toHaveLength(1);
  });

  it('les statuts de livraison mettent à jour le message existant', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA_1',
        changes: [{
          field: 'messages',
          value: {
            metadata: { phone_number_id: 'wa_appels' },
            statuses: [{ id: 'wamid.A', status: 'delivered', timestamp: '1763000100', recipient_id: '22370000000' }],
          },
        }],
      }],
    });
    await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    expect(deps.messageSetStatus).toHaveBeenCalledWith('wamid.A', 'delivered', null, null);
  });

  it('un message Messenger est enregistré, un écho ne l’est pas', async () => {
    const deps = depsAvec();
    const entrant = JSON.stringify({
      object: 'page',
      entry: [{ id: 'page_connectee', messaging: [{ sender: { id: 'PSID_1' }, recipient: { id: 'page_connectee' }, timestamp: 1763000000000, message: { mid: 'm_1', text: 'Salut' } }] }],
    });
    await handleMetaWebhook(requete(entrant, await signer(entrant)), deps);
    expect(deps.messageRecord).toHaveBeenCalledTimes(1);

    const echo = JSON.stringify({
      object: 'page',
      entry: [{ id: 'page_connectee', messaging: [{ sender: { id: 'page_connectee' }, recipient: { id: 'PSID_1' }, timestamp: 1763000001000, message: { mid: 'm_2', text: 'Réponse', is_echo: true } }] }],
    });
    await handleMetaWebhook(requete(echo, await signer(echo)), deps);
    expect(deps.messageRecord).toHaveBeenCalledTimes(1);
  });

  it('un commentaire Instagram connu est rattaché à l’entreprise', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify({
      object: 'instagram',
      entry: [{ id: 'ig_connexion', changes: [{ field: 'comments', value: { id: 'cmt_1', text: 'Super', media: { id: 'media_1' }, from: { id: 'u_9' } } }] }],
    });
    await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    expect(deps.pageEventRecord).toHaveBeenCalledTimes(1);
    const evenement = (deps.pageEventRecord as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as Record<string, unknown>;
    expect(evenement.channel).toBe('instagram');
    expect(evenement.page_id).toBe('p1');
  });

  it('une erreur de traitement est journalisée sans faire échouer Meta (200)', async () => {
    const deps = depsAvec({
      messageRecord: vi.fn(async () => { throw new Error('base indisponible'); }),
    });
    const corps = JSON.stringify(messageWhatsApp);
    const reponse = await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    // 200 : un 5xx ferait réessayer Meta pendant 7 jours pour rien.
    expect(reponse.status).toBe(200);
    expect(await reponse.json()).toMatchObject({ received: 1, processed: 0 });
  });

  it('la réponse ne contient aucun jeton ni secret', async () => {
    const deps = depsAvec();
    const corps = JSON.stringify(messageWhatsApp);
    const reponse = await handleMetaWebhook(requete(corps, await signer(corps)), deps);
    const texte = JSON.stringify(await reponse.json());
    expect(texte).not.toContain(SECRET);
    expect(texte).not.toContain(TOKEN);
  });
});

/* ---------------------------- Analyse du corps --------------------------- */

describe('parseWebhook — normalisation', () => {
  const trouver = (events: NormalizedEvent[], kind: NormalizedEvent['kind']) => events.find((e) => e.kind === kind);

  it('extrait le WABA, le numéro et le texte d’un message WhatsApp', () => {
    const events = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'PN' }, messages: [{ id: 'm1', from: '223', timestamp: '1763000000', type: 'text', text: { body: 'Bonjour' } }] } }] }],
    });
    const message = trouver(events, 'whatsapp.message');
    expect(message).toMatchObject({ wabaId: 'WABA', phoneNumberId: 'PN', messageId: 'm1', from: '223', text: 'Bonjour', type: 'text' });
    expect(message && 'dedupeKey' in message ? message.dedupeKey : '').toBe('wa:msg:m1');
  });

  it('extrait une erreur de statut (code + titre)', () => {
    const events = parseWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: { statuses: [{ id: 'm1', status: 'failed', timestamp: '1', errors: [{ code: 131047, title: 'Re-engagement' }] }] } }] }],
    });
    const statut = trouver(events, 'whatsapp.status');
    expect(statut).toMatchObject({ status: 'failed', errorCode: 131047, errorTitle: 'Re-engagement' });
  });

  it('donne des clés de déduplication stables et distinctes par statut', () => {
    const corps = (statut: string) => ({
      object: 'whatsapp_business_account',
      entry: [{ id: 'W', changes: [{ field: 'messages', value: { statuses: [{ id: 'm1', status: statut, timestamp: '1' }] } }] }],
    });
    const cle = (statut: string) => {
      const evenement = trouver(parseWebhook(corps(statut)), 'whatsapp.status');
      return evenement && 'dedupeKey' in evenement ? evenement.dedupeKey : '';
    };
    // Le même statut relivré garde la même clé ; deux statuts différents non.
    expect(cle('delivered')).toBe(cle('delivered'));
    expect(cle('delivered')).not.toBe(cle('read'));
  });

  it('extrait un commentaire de page, un feed et un message Messenger', () => {
    const feed = parseWebhook({
      object: 'page',
      entry: [{ id: 'P', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'c1', post_id: 'p1_2', message: 'Bravo', from: { id: 'u1' }, created_time: 1763000000 } }] }],
    });
    expect(trouver(feed, 'page.feed')).toMatchObject({ pageId: 'P', item: 'comment', commentId: 'c1', postId: 'p1_2' });

    const messenger = parseWebhook({
      object: 'page',
      entry: [{ id: 'P', messaging: [{ sender: { id: 'u1' }, recipient: { id: 'P' }, timestamp: 1763000000000, message: { mid: 'm1', text: 'Bonjour' } }] }],
    });
    expect(trouver(messenger, 'messenger.message')).toMatchObject({ pageId: 'P', senderId: 'u1', messageId: 'm1', isEcho: false });
  });

  it('un corps inattendu ne produit aucun événement explosif', () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook('texte')).toEqual([]);
    expect(parseWebhook({ object: 'inconnu', entry: [] })).toEqual([]);
    const inconnu = parseWebhook({ object: 'page', entry: [{ id: 'P', changes: [{ field: 'inconnu', value: {} }] }] });
    expect(inconnu[0].kind).toBe('unknown');
  });
});
