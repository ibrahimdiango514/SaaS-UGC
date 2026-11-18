import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_HOST,
  MetaError,
  classifyGraphError,
  debugToken,
  exchangeCode,
  exchangeLongLived,
  httpStatusFor,
  listPages,
  me,
  redactTokens,
  sendWhatsAppMessage,
  subscribePage,
} from '../src/business/meta/graph';

/**
 * Client Graph Meta.
 *
 * Ce que ces tests protègent : l'hôte est fixe (aucune URL fournie par
 * l'utilisateur ne peut détourner l'appel), le jeton part en en-tête et jamais
 * en paramètre d'URL, les erreurs Meta sont classées en codes stables, et aucun
 * jeton n'apparaît dans un message d'erreur.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Graph — la requête ne peut pas être détournée', () => {
  it('appelle toujours graph.facebook.com, quelle que soit la version demandée', async () => {
    const fetchImpl = vi.fn(async () => json({ id: '1', name: 'Compte' }));
    await me('TOKEN-TEST', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url.startsWith(`${GRAPH_HOST}/`)).toBe(true);
    expect(url).toContain('/me');
    expect(url).toContain('fields=');
  });

  it('envoie le jeton en en-tête Authorization, jamais dans l’URL', async () => {
    const fetchImpl = vi.fn(async () => json({ id: '1', name: 'Compte' }));
    await me('EAAjetonDeTestSansFormeDeCle', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('EAA');
    expect(url).not.toContain('access_token');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer EAAjetonDeTestSansFormeDeCle');
  });

  it('refuse de suivre une redirection (pas de sortie d’hôte)', async () => {
    const fetchImpl = vi.fn(async () => json({ id: '1' }));
    await me('t', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('error');
  });

  it('un échec réseau devient une MetaError classée, pas une exception brute', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(me('t', { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ name: 'MetaError', code: 'network_failed' });
  });
});

describe('Graph — classification des erreurs Meta', () => {
  it('190 = jeton invalide, 190/463 = expiré', () => {
    expect(classifyGraphError(400, { error: { code: 190, message: 'Invalid OAuth access token.' } }).code).toBe('auth_invalid');
    expect(classifyGraphError(400, { error: { code: 190, error_subcode: 463, message: 'Session expired.' } }).code).toBe('auth_expired');
    expect(classifyGraphError(400, { error: { code: 190, error_subcode: 467, message: 'Password changed.' } }).code).toBe('auth_expired');
  });

  it('10 et 200–299 = permission refusée', () => {
    expect(classifyGraphError(403, { error: { code: 10, message: '(#10) Application does not have permission' } }).code).toBe('permission_denied');
    expect(classifyGraphError(403, { error: { code: 200, message: 'Permissions error' } }).code).toBe('permission_denied');
    expect(classifyGraphError(403, { error: { code: 294, message: 'Managing' } }).code).toBe('permission_denied');
  });

  it('4/17/32/613 = limite de débit', () => {
    for (const code of [4, 17, 32, 613]) {
      expect(classifyGraphError(429, { error: { code, message: 'rate' } }).code).toBe('rate_limited');
    }
  });

  it('100 et les codes WhatsApp courants = requête invalide', () => {
    for (const code of [100, 131000, 131026, 131047, 131051, 132000, 132001, 133010]) {
      expect(classifyGraphError(400, { error: { code, message: 'invalid' } }).code).toBe('invalid_request');
    }
  });

  it('une réponse 5xx sans corps Meta = erreur serveur, pas « jeton invalide »', () => {
    expect(classifyGraphError(503, null).code).toBe('server_error');
    expect(classifyGraphError(502, { not_an_error: true }).code).toBe('server_error');
  });

  it('un corps 200 sans champ error mais avec du texte = réponse inexploitable', () => {
    expect(classifyGraphError(200, 'texte').code).toBe('bad_response');
  });

  it('conserve le code Meta et le fbtrace_id pour le diagnostic', () => {
    const erreur = classifyGraphError(400, { error: { code: 100, error_subcode: 33, message: 'bad', fbtrace_id: 'ABC123' } });
    expect(erreur.metaCode).toBe(100);
    expect(erreur.metaSubcode).toBe(33);
    expect(erreur.fbtraceId).toBe('ABC123');
  });

  it('chaque code a un statut HTTP cohérent', () => {
    expect(httpStatusFor('auth_invalid')).toBe(401);
    expect(httpStatusFor('permission_denied')).toBe(403);
    expect(httpStatusFor('rate_limited')).toBe(429);
    expect(httpStatusFor('timeout')).toBe(504);
    expect(httpStatusFor('invalid_request')).toBe(400);
  });

  it('le message d’une MetaError ne contient jamais de jeton', () => {
    const erreur = classifyGraphError(401, {
      error: { code: 190, message: 'Invalid token EAAabcdefghijklmnopqrstuvwxyz0123456789 (access_token=EAAsecret)' },
    });
    expect(erreur.message).not.toContain('EAAabcdefghij');
    expect(erreur.message).not.toContain('EAAsecret');
    expect(erreur.message).toContain('[expurgé]');
  });

  it('redactTokens efface les jetons et les paramètres sensibles', () => {
    const nettoye = redactTokens('voir EAA1234567890abcdefghijklmnop&client_secret=abc');
    expect(nettoye).not.toContain('EAA1234567890');
    expect(nettoye).not.toContain('client_secret=abc');
  });
});

describe('Graph — OAuth', () => {
  it('l’échange de code transmet bien redirect_uri quand il est fourni', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'EAAcourt', expires_in: 3600 }));
    await exchangeCode(
      { appId: '1692282959171281', appSecret: 'secret', code: 'CODE', redirectUri: 'https://exemple/callback' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('code=CODE');
    expect(url).toContain('client_id=1692282959171281');
    expect(url).toContain(encodeURIComponent('https://exemple/callback'));
  });

  it('Embedded Signup omet redirect_uri (exigence Meta pour le SDK)', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'EAAcourt' }));
    await exchangeCode({ appId: '1', appSecret: 's', code: 'C' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).not.toContain('redirect_uri');
  });

  it('un échange sans jeton est refusé, jamais accepté à moitié', async () => {
    const fetchImpl = vi.fn(async () => json({ token_type: 'bearer' }));
    await expect(exchangeCode({ appId: '1', appSecret: 's', code: 'C' }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: 'bad_response' });
  });

  it('le jeton long utilise grant_type=fb_exchange_token', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'EAAlong', expires_in: 5184000 }));
    const jeton = await exchangeLongLived({ appId: '1', appSecret: 's', token: 'court' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('grant_type=fb_exchange_token');
    expect(jeton.expires_in).toBe(5184000);
  });

  it('debug_token utilise le jeton d’application et rend les scopes granulaires', async () => {
    const fetchImpl = vi.fn(async () => json({
      data: { app_id: '1692282959171281', scopes: ['whatsapp_business_messaging'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['111'] }] },
    }));
    const info = await debugToken({ appId: '1692282959171281', appSecret: 's', token: 't' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('debug_token');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer 1692282959171281|s');
    expect(info.granular_scopes?.[0].target_ids).toEqual(['111']);
  });
});

describe('Graph — Pages et WhatsApp', () => {
  it('listPages suit la pagination par curseur et s’arrête', async () => {
    const pages = [
      json({ data: [{ id: '1', name: 'A', access_token: 'EAA-page-1' }], paging: { next: 'x', cursors: { after: 'C1' } } }),
      json({ data: [{ id: '2', name: 'B', access_token: 'EAA-page-2' }], paging: {} }),
    ];
    let appel = 0;
    const fetchImpl = vi.fn(async () => pages[appel++] ?? json({ data: [] }));
    const resultat = await listPages('user-token', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(resultat.map((p) => p.id)).toEqual(['1', '2']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('l’abonnement d’une page déclare les champs demandés', async () => {
    const fetchImpl = vi.fn(async () => json({ success: true }));
    const ok = await subscribePage('PAGE', 'page-token', ['feed', 'messages'], { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('subscribed_apps');
    expect(url).toContain('subscribed_fields=feed%2Cmessages');
    expect(init.method).toBe('POST');
    expect(ok).toBe(true);
  });

  it('WhatsApp envoie un texte avec messaging_product=whatsapp', async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [{ id: 'wamid.1' }], contacts: [{ wa_id: '22370000000' }] }));
    const envoi = await sendWhatsAppMessage('PHONE_ID', 'token', { to: '22370000000', text: 'Bonjour' }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/PHONE_ID/messages');
    const corps = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(corps.messaging_product).toBe('whatsapp');
    expect(corps.type).toBe('text');
    expect(envoi.messageId).toBe('wamid.1');
    expect(envoi.waId).toBe('22370000000');
  });

  it('WhatsApp envoie un modèle approuvé avec sa langue', async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [{ id: 'wamid.2' }] }));
    await sendWhatsAppMessage('PHONE_ID', 'token', { to: '22370000000', template: { name: 'bienvenue', language: 'fr' } }, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const corps = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, any>;
    expect(corps.type).toBe('template');
    expect(corps.template.name).toBe('bienvenue');
    expect(corps.template.language.code).toBe('fr');
  });

  it('un envoi non confirmé par Meta est une erreur, pas un succès silencieux', async () => {
    const fetchImpl = vi.fn(async () => json({ messages: [] }));
    await expect(sendWhatsAppMessage('P', 't', { to: '1', text: 'x' }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toBeInstanceOf(MetaError);
  });
});
