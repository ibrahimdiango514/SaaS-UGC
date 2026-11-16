// VYORA — authentification des actions OAuth privées.
//
// ## Historique de ce fichier
//
// Il a d'abord servi à DÉMONTRER une faille : `callerId()` ne vérifiait ni
// signature ni expiration, et l'Edge Function est déployée avec
// `verify_jwt: false`. Un `Authorization: Bearer <uuid>` arbitraire devenait
// l'identité de l'appelant, rendant les contrôles `user_id` décoratifs.
//
// La faille est corrigée : `resolveCaller()` (dans
// `supabase/functions/vyora-oauth/auth.ts`) vérifie le jeton auprès de
// Supabase Auth avant toute logique métier. Les anciens tests `it.fails` sont
// devenus des tests normaux — c'est la preuve que la protection existe.
//
// ## Ce que ce fichier couvre maintenant
//
// Le comportement de `resolveCaller` face à toutes les catégories de jetons
// (absent, malformé, forgé, expiré, révoqué, valide), et le fait qu'aucun de ces
// cas ne peut atteindre une opération privée.
import { describe, expect, it } from 'vitest';
import { looksLikeJwt, resolveCaller, type AuthConfig } from '../supabase/functions/vyora-oauth/auth.ts';
import { createHandler } from '../supabase/functions/vyora-oauth/index.ts';
import { generateKeyBase64 } from '../supabase/functions/_shared/oauth/crypto.ts';

const USER_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** JWT bien formé (3 segments base64url) mais dont la signature est inventée. */
const JWT_FORGE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.signature-inventee';
const JWT_EXPIRE = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.signature-expiree';

function authConfig(fetchImpl: typeof fetch): AuthConfig {
  return { baseUrl: 'https://projet.supabase.co', anonKey: 'anon-key-factice', fetchImpl };
}

/** Simule `/auth/v1/user` : rend l'utilisateur si le jeton est reconnu. */
function authService(accepted: string | null, status = 200) {
  const calls: Array<{ url: string; authorization: string; apikey: string }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url: String(url), authorization: headers.Authorization ?? '', apikey: headers.apikey ?? '' });
    if (status !== 200) return new Response('{}', { status });
    const token = (headers.Authorization ?? '').replace(/^Bearer\s+/, '');
    if (accepted === null || token !== accepted) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ id: USER_ID, email: 'a@exemple.fr' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('resolveCaller / jetons refusés sans appel réseau', () => {
  it('refuse l’absence d’en-tête', async () => {
    const { calls, impl } = authService(JWT_FORGE);
    const result = await resolveCaller(null, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
    // Un en-tête absent ne justifie pas un aller-retour réseau.
    expect(calls).toHaveLength(0);
  });

  it('refuse un en-tête vide ou réduit à des espaces', async () => {
    const { calls, impl } = authService(JWT_FORGE);
    for (const header of ['', '   ', 'Bearer', 'Bearer ', 'Bearer    ']) {
      const result = await resolveCaller(header, authConfig(impl));
      expect(result.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it('refuse un schéma autre que Bearer', async () => {
    const { calls, impl } = authService(JWT_FORGE);
    const result = await resolveCaller('Basic dXNlcjpwYXNz', authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(calls).toHaveLength(0);
  });

  it('refuse un UUID nu — le cas exact de l’attaque d’origine', async () => {
    // Avant correction, cette valeur devenait l'identité de l'appelant.
    const { calls, impl } = authService(JWT_FORGE);
    const result = await resolveCaller(`Bearer ${USER_ID}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
    // Rejeté sur la forme, donc sans même interroger Auth.
    expect(calls).toHaveLength(0);
  });

  it('refuse un JWT tronqué ou à deux segments', async () => {
    const { impl } = authService(JWT_FORGE);
    for (const token of ['abc', 'a.b', 'a.b.c.d', 'a..c']) {
      const result = await resolveCaller(`Bearer ${token}`, authConfig(impl));
      expect(result.ok).toBe(false);
    }
  });
});

describe('resolveCaller / jetons soumis à Supabase Auth', () => {
  it('accepte un jeton authentique et rend l’identité d’Auth', async () => {
    const { calls, impl } = authService(JWT_FORGE);
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));

    expect(result).toEqual({ ok: true, userId: USER_ID });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://projet.supabase.co/auth/v1/user');
    expect(calls[0].authorization).toBe(`Bearer ${JWT_FORGE}`);
    // La clé publique accompagne le jeton, elle ne le remplace pas.
    expect(calls[0].apikey).toBe('anon-key-factice');
  });

  it('refuse un JWT forgé (signature invalide → 401 d’Auth)', async () => {
    const { impl } = authService(null);
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuse un JWT expiré (401 d’Auth)', async () => {
    const { impl } = authService(null);
    const result = await resolveCaller(`Bearer ${JWT_EXPIRE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('refuse un jeton révoqué (403 d’Auth)', async () => {
    const { impl } = authService(null, 403);
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('distingue une panne d’Auth (503) d’un refus d’identité (401)', async () => {
    // Confondre les deux ferait afficher « session expirée » lors d'une panne,
    // et pousserait l'utilisateur à se reconnecter pour rien.
    const { impl } = authService(JWT_FORGE, 500);
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'auth_unavailable' });
  });

  it('traite un réseau injoignable comme une indisponibilité, pas un refus', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'auth_unavailable' });
  });

  it('traite une réponse 200 non-JSON comme une indisponibilité', async () => {
    const impl = (async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch;
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'auth_unavailable' });
  });

  it('refuse une réponse sans identifiant exploitable', async () => {
    const impl = (async () => new Response(JSON.stringify({ email: 'x@y.z' }), { status: 200 })) as unknown as typeof fetch;
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, authConfig(impl));
    expect(result).toEqual({ ok: false, reason: 'auth_unavailable' });
  });

  it('refuse faute de clé publique plutôt que de faire confiance au porteur', async () => {
    // Sans clé, impossible d'interroger Auth. Accepter serait le pire choix.
    const { calls, impl } = authService(JWT_FORGE);
    const result = await resolveCaller(`Bearer ${JWT_FORGE}`, {
      baseUrl: 'https://projet.supabase.co', anonKey: '', fetchImpl: impl,
    });
    expect(result).toEqual({ ok: false, reason: 'auth_unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('looksLikeJwt / reconnaissance de forme', () => {
  it('accepte un JWT à trois segments base64url', () => {
    expect(looksLikeJwt(JWT_FORGE)).toBe(true);
  });

  it('rejette un UUID, une chaîne vide et les formes incomplètes', () => {
    for (const value of [USER_ID, '', 'abc', 'a.b', 'a.b.c.d', 'a.b.c!']) {
      expect(looksLikeJwt(value)).toBe(false);
    }
  });
});

describe('handler HTTP / aucune action privée sans identité vérifiée', () => {
  const config = {
    baseUrl: 'https://p.supabase.co',
    serviceKey: 'k',
    clientId: 'c',
    clientSecret: 's',
    encryptionKey: generateKeyBase64(),
    redirectUri: 'https://p/cb',
    anonKey: 'anon-key-factice',
  };

  /** Auth injoignable : toute action privée doit échouer. */
  const authDown = (async () => { throw new Error('down'); }) as unknown as typeof fetch;

  const privateActions = [
    'list', 'audit', 'revoke', 'refresh', 'check', 'start', 'tools_list', 'tools_call',
  ];

  it('refuse toutes les actions privées sans en-tête Authorization', async () => {
    const handler = createHandler({ ...config, fetchImpl: authDown });
    for (const action of privateActions) {
      const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
        method: 'POST',
        body: JSON.stringify({ action }),
      }));
      expect(response.status, `action ${action}`).toBe(401);
    }
  });

  it('refuse toutes les actions privées avec un UUID nu en porteur', async () => {
    // Régression directe de la faille : ce porteur ne doit plus rien ouvrir.
    const handler = createHandler({ ...config, fetchImpl: authDown });
    for (const action of privateActions) {
      const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
        method: 'POST',
        headers: { Authorization: `Bearer ${USER_ID}` },
        body: JSON.stringify({ action }),
      }));
      expect(response.status, `action ${action}`).toBe(401);
    }
  });

  it('refuse toutes les actions privées avec un JWT forgé', async () => {
    const handler = createHandler({ ...config, fetchImpl: authDown });
    for (const action of privateActions) {
      const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
        method: 'POST',
        headers: { Authorization: `Bearer ${JWT_FORGE}` },
        body: JSON.stringify({ action }),
      }));
      // 401 (jeton refusé) ou 503 (Auth injoignable) — jamais un succès.
      expect([401, 503], `action ${action}`).toContain(response.status);
    }
  });

  it('rend 503 quand Auth est injoignable, pas 401', async () => {
    const handler = createHandler({ ...config, fetchImpl: authDown });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT_FORGE}` },
      body: JSON.stringify({ action: 'list' }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('auth_unavailable');
  });

  it('laisse passer une action privée avec un JWT authentique', async () => {
    // Contre-épreuve : sans elle, un handler qui refuserait tout passerait
    // pour sécurisé.
    const { impl } = authService(JWT_FORGE);
    const handler = createHandler({ ...config, fetchImpl: impl });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT_FORGE}` },
      body: JSON.stringify({ action: 'status' }),
    }));
    expect(response.status).toBe(200);
  });
});

describe('callback reste public — la correction ne casse pas le flux OAuth', () => {
  const config = {
    baseUrl: 'https://p.supabase.co',
    serviceKey: 'k',
    clientId: 'c',
    clientSecret: 's',
    encryptionKey: generateKeyBase64(),
    redirectUri: 'https://p/cb',
    anonKey: 'anon-key-factice',
  };

  it('accepte un GET callback sans en-tête Authorization', async () => {
    // Google redirige le navigateur : aucun jeton ne peut être présent.
    // Passer `verify_jwt: true` casserait ce chemin — d'où la vérification
    // applicative plutôt que la vérification de plateforme.
    //
    // Le fetch simulé rend un tableau vide pour `oauth_state_consume` : l'état
    // est inconnu, ce qui est exactement le scénario CSRF testé ici.
    const storeFetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const handler = createHandler({ ...config, fetchImpl: storeFetch });
    const response = await handler(new Request(
      'https://p.supabase.co/functions/v1/vyora-oauth?action=callback&code=abc&state=inconnu',
    ));
    // 400 : l'état est inconnu (comportement CSRF attendu), mais la requête a
    // bien ATTEINT le handler sans authentification. C'est ce qui compte ici.
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('state_invalid');
  });

  it('refuse un callback sans paramètres, toujours sans exiger de jeton', async () => {
    const storeFetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const handler = createHandler({ ...config, fetchImpl: storeFetch });
    const response = await handler(new Request(
      'https://p.supabase.co/functions/v1/vyora-oauth?action=callback',
    ));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('code_or_state_missing');
  });
});
