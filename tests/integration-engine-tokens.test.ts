// @vitest-environment node
/**
 * Échange de jetons et webhooks — les deux frontières où une erreur coûte cher.
 *
 * Tous les appels réseau sont simulés : aucun test ne contacte un fournisseur.
 * Ce qui est vérifié ici n'est pas « le code appelle fetch » mais « le code
 * refuse une réponse douteuse ». Un jeton accepté sans contrôle est un incident
 * de sécurité ; un webhook non signé accepté est une porte ouverte.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EXPIRY_SKEW_SECONDS,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeRemoteToken,
} from '../src/integrations/engine/tokens';
import { eventFingerprint, signPayload, verifyWebhook } from '../src/integrations/engine/webhooks';

const NOW = () => new Date('2026-11-14T12:00:00Z');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseExchange = {
  tokenUrl: 'https://fournisseur.example/oauth/token',
  clientId: 'client-id',
  clientSecret: 'client-secret-serveur',
  code: 'code-autorisation',
  redirectUri: 'https://app.example/callback',
  codeVerifier: 'v'.repeat(43),
  now: NOW,
};

describe('échange de code — accepte une réponse conforme', () => {
  it('rend un jeton et une expiration calculée avec marge', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      access_token: 'jeton-abc',
      refresh_token: 'refresh-abc',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'read send',
    }));

    const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    expect(resultat.value.accessToken).toBe('jeton-abc');
    expect(resultat.value.refreshToken).toBe('refresh-abc');
    expect(resultat.value.scopes).toEqual(['read', 'send']);
    // 3600 s moins la marge de 60 s.
    expect(resultat.value.expiresAt).toBe(
      new Date(NOW().getTime() + (3600 - EXPIRY_SKEW_SECONDS) * 1000).toISOString(),
    );
  });

  it('le client_secret voyage dans le corps, jamais dans l’URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a', token_type: 'Bearer' }));
    await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('client-secret-serveur');
    expect(String(init.body)).toContain('client_secret=client-secret-serveur');
    expect(String(init.body)).toContain('code_verifier=');
  });

  it('sans expires_in, l’expiration reste inconnue plutôt qu’inventée', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a', token_type: 'Bearer' }));
    const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    expect(resultat.ok && resultat.value.expiresAt).toBeNull();
  });
});

describe('échange de code — refuse les réponses douteuses', () => {
  it('refuse un corps sans access_token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ token_type: 'Bearer' }));
    const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('invalid_response');
  });

  it('refuse un token_type inattendu', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'a', token_type: 'MAC' }));
    const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.message).toMatch(/token_type/);
  });

  it('refuse une réponse non JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>erreur</html>', { status: 200 }));
    const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('invalid_response');
  });

  it('refuse une URL de jeton non HTTPS sans appel réseau', async () => {
    const fetchImpl = vi.fn();
    const resultat = await exchangeAuthorizationCode({
      ...baseExchange,
      tokenUrl: 'http://fournisseur.example/token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resultat.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuse l’absence de vérifieur PKCE', async () => {
    const fetchImpl = vi.fn();
    const resultat = await exchangeAuthorizationCode({
      ...baseExchange,
      codeVerifier: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resultat.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('traduit chaque statut HTTP en code exploitable', async () => {
    const cas: Array<[number, string]> = [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [429, 'rate_limited'],
      [500, 'upstream_error'],
      [418, 'invalid_response'],
    ];
    for (const [status, code] of cas) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, status));
      const resultat = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl });
      expect(resultat.ok).toBe(false);
      if (!resultat.ok) expect(resultat.error.code).toBe(code);
    }
  });

  it('un incident réseau est rejouable, une autorisation refusée ne l’est pas', async () => {
    const reseau = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r1 = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl: reseau as unknown as typeof fetch });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.retryable).toBe(true);

    const refuse = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));
    const r2 = await exchangeAuthorizationCode({ ...baseExchange, fetchImpl: refuse });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.retryable).toBe(false);
  });
});

describe('renouvellement — ne jamais inventer un refresh token', () => {
  it('renvoie null quand le fournisseur n’en fournit pas de nouveau', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'nouveau', token_type: 'Bearer', expires_in: 1800 }));
    const resultat = await refreshAccessToken({
      tokenUrl: baseExchange.tokenUrl,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'ancien',
      now: NOW,
      fetchImpl,
    });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.refreshToken).toBeNull();
  });

  it('refuse un renouvellement sans refresh token', async () => {
    const fetchImpl = vi.fn();
    const resultat = await refreshAccessToken({
      tokenUrl: baseExchange.tokenUrl,
      clientId: 'c',
      clientSecret: 's',
      refreshToken: '',
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('révocation — idempotente par construction', () => {
  it('un jeton déjà absent est un succès, pas une erreur', async () => {
    const fetchImpl = vi.fn();
    const resultat = await revokeRemoteToken({
      revokeUrl: 'https://fournisseur.example/revoke',
      token: '',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(resultat.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un 400 « jeton déjà invalide » est traité comme un succès', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 400 }));
    const resultat = await revokeRemoteToken({
      revokeUrl: 'https://fournisseur.example/revoke',
      token: 'jeton',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    expect(resultat.ok).toBe(true);
  });

  it('un refus explicite du fournisseur remonte comme erreur', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const resultat = await revokeRemoteToken({
      revokeUrl: 'https://fournisseur.example/revoke',
      token: 'jeton',
      clientId: 'c',
      clientSecret: 's',
      fetchImpl,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('forbidden');
  });
});

describe('webhooks — la signature est la seule authentification', () => {
  const secret = 'secret-partage-serveur';
  const body = '{"id":"evt_1","type":"order.created"}';
  const nowSeconds = 1_800_000_000;

  it('accepte une signature correcte dans la fenêtre', async () => {
    const timestamp = String(nowSeconds - 10);
    const signature = await signPayload(secret, timestamp, body);
    const verdict = await verifyWebhook({ rawBody: body, signature, timestamp, secret, nowSeconds });
    expect(verdict).toEqual({ ok: true, algorithm: 'sha256' });
  });

  it('rejette une absence de signature', async () => {
    const verdict = await verifyWebhook({
      rawBody: body, signature: null, timestamp: String(nowSeconds), secret, nowSeconds,
    });
    expect(verdict).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejette un corps modifié après signature', async () => {
    const timestamp = String(nowSeconds);
    const signature = await signPayload(secret, timestamp, body);
    const verdict = await verifyWebhook({
      rawBody: body.replace('order.created', 'order.refunded'),
      signature, timestamp, secret, nowSeconds,
    });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejette un rejeu hors fenêtre', async () => {
    const timestamp = String(nowSeconds - 3600);
    const signature = await signPayload(secret, timestamp, body);
    const verdict = await verifyWebhook({ rawBody: body, signature, timestamp, secret, nowSeconds });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejette une signature mal formée sans calculer de HMAC inutile', async () => {
    const verdict = await verifyWebhook({
      rawBody: body, signature: 'pas-du-hex', timestamp: String(nowSeconds), secret, nowSeconds,
    });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejette un horodatage aberrant', async () => {
    const verdict = await verifyWebhook({
      rawBody: body, signature: 'a'.repeat(64), timestamp: 'hier', secret, nowSeconds,
    });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });

  it('un secret différent invalide la signature', async () => {
    const timestamp = String(nowSeconds);
    const signature = await signPayload('autre-secret', timestamp, body);
    const verdict = await verifyWebhook({ rawBody: body, signature, timestamp, secret, nowSeconds });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('webhooks — déduplication des réémissions', () => {
  it('privilégie l’identifiant fourni', async () => {
    expect(await eventFingerprint('{}', 'evt_42')).toBe('evt_42');
  });

  it('dérive une empreinte stable du corps à défaut d’identifiant', async () => {
    const body = '{"id":"evt_1"}';
    const a = await eventFingerprint(body, null);
    const b = await eventFingerprint(body, '   ');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('deux corps différents donnent deux empreintes différentes', async () => {
    expect(await eventFingerprint('{"a":1}', null)).not.toBe(await eventFingerprint('{"a":2}', null));
  });
});
