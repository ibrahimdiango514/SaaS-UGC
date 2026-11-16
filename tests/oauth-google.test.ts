// VYORA — chiffrement des jetons OAuth et fournisseur Google.
//
// Ces tests portent sur la logique réellement exécutée par l'Edge Function.
// `fetch` est injecté : aucun test ne dépend du réseau ni d'un secret.
import { describe, expect, it } from 'vitest';
import {
  createPkcePair,
  createState,
  decryptSecret,
  encryptSecret,
  generateKeyBase64,
  keyFingerprint,
  parseKey,
} from '../supabase/functions/_shared/oauth/crypto.ts';
import {
  AUTH_ENDPOINT,
  CapabilityDeniedError,
  assertCapability,
  buildAuthorizationUrl,
  capabilitiesFromScopes,
  decodeIdTokenClaims,
  exchangeCode,
  isCapabilitySupported,
  refreshAccessToken,
  revokeToken,
  scopesFor,
} from '../supabase/functions/_shared/oauth/google.ts';

const KEY = generateKeyBase64();

describe('oauth / chiffrement AES-256-GCM', () => {
  it('chiffre puis déchiffre sans perte', async () => {
    const secret = 'ya29.a0AfH6SMBexemple_de_jeton_google_tres_long';
    const sealed = await encryptSecret(secret, KEY);
    expect(sealed.cipher).not.toContain(secret);
    expect(sealed.iv).toBeTruthy();
    expect(sealed.tag).toBeTruthy();
    expect(await decryptSecret(sealed, KEY)).toBe(secret);
  });

  it('produit un IV différent à chaque chiffrement du même secret', async () => {
    const a = await encryptSecret('meme-jeton', KEY);
    const b = await encryptSecret('meme-jeton', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
  });

  it('refuse un cryptogramme altéré (étiquette GCM)', async () => {
    const sealed = await encryptSecret('secret-a-proteger', KEY);
    // Altération d'un caractère du texte chiffré.
    const tampered = { ...sealed, cipher: `${sealed.cipher.slice(0, -2)}AA` };
    await expect(decryptSecret(tampered, KEY)).rejects.toThrow('decrypt_failed');
  });

  it('refuse une clé différente', async () => {
    const sealed = await encryptSecret('secret', KEY);
    const autreCle = generateKeyBase64();
    await expect(decryptSecret(sealed, autreCle)).rejects.toThrow('decrypt_failed');
  });

  it('refuse une clé de mauvaise longueur ou absente', () => {
    expect(() => parseKey('')).toThrow('encryption_key_missing');
    expect(() => parseKey('dGVzdA==')).toThrow(/encryption_key_bad_length/);
    expect(() => parseKey('pas du base64 !!!')).toThrow();
  });

  it('accepte une clé de 32 octets', () => {
    expect(parseKey(KEY)).toHaveLength(32);
  });

  it('refuse un cryptogramme incomplet', async () => {
    await expect(decryptSecret({ cipher: '', iv: '', tag: '' }, KEY)).rejects.toThrow('cipher_incomplete');
  });

  it('empreinte de clé : stable, courte, non réversible', async () => {
    const a = await keyFingerprint(KEY);
    const b = await keyFingerprint(KEY);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(KEY).not.toContain(a);
  });
});

describe('oauth / PKCE et état', () => {
  it('génère un vérificateur conforme RFC 7636 et son défi S256', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('le défi est bien le SHA-256 base64url du vérificateur', async () => {
    const { verifier, challenge } = await createPkcePair();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = Buffer.from(new Uint8Array(digest)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('génère des états uniques et suffisamment longs', () => {
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(states.size).toBe(50);
    for (const state of states) expect(state.length).toBeGreaterThanOrEqual(32);
  });
});

describe('oauth / scopes et permissions séparées', () => {
  it('demande le scope lecture seule pour la capacité read', () => {
    const scopes = scopesFor('gmail', ['read']);
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.compose');
  });

  it('n’ajoute jamais le scope d’envoi quand on demande la rédaction', () => {
    const scopes = scopesFor('gmail', ['read', 'draft']);
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.compose');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
  });

  it('chaque capacité a un scope distinct pour Gmail', () => {
    const all = scopesFor('gmail', ['read', 'draft', 'send', 'modify']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('refuse une capacité non applicable au fournisseur', () => {
    expect(() => scopesFor('google_drive', ['send'])).toThrow('capacité non supportée: google_drive/send');
    expect(() => scopesFor('google_calendar', ['draft'])).toThrow(/non supportée/);
  });

  it('signale les capacités supportées par fournisseur', () => {
    expect(isCapabilitySupported('gmail', 'send')).toBe(true);
    expect(isCapabilitySupported('google_drive', 'send')).toBe(false);
    expect(isCapabilitySupported('google_calendar', 'modify')).toBe(true);
  });

  it('refuse un appel dont la capacité n’est pas accordée', () => {
    expect(() => assertCapability(['read'], 'send', 'gmail')).toThrow(CapabilityDeniedError);
    expect(() => assertCapability(['read', 'draft'], 'send', 'gmail')).toThrow(/non accordée/);
    expect(() => assertCapability(['read', 'send'], 'send', 'gmail')).not.toThrow();
  });

  it('déduit les capacités des scopes réellement renvoyés par Google', () => {
    const granted = capabilitiesFromScopes('gmail', [
      'openid',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ]);
    expect(granted).toEqual(['read', 'draft']);
    // Un scope `send` non accordé ne donne jamais la capacité d'envoi.
    expect(granted).not.toContain('send');
  });
});

describe('oauth / URL d’autorisation', () => {
  it('contient PKCE, offline et consent — sans quoi pas de refresh token', () => {
    const url = new URL(buildAuthorizationUrl({
      provider: 'gmail',
      clientId: 'client-123',
      redirectUri: 'https://vyora.app/callback',
      capabilities: ['read'],
      state: 'state-xyz',
      codeChallenge: 'challenge-abc',
    }));
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_ENDPOINT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-xyz');
  });

  it('n’utilise jamais include_granted_scopes (élargirait les permissions)', () => {
    const url = buildAuthorizationUrl({
      provider: 'gmail',
      clientId: 'c',
      redirectUri: 'r',
      capabilities: ['read'],
      state: 's',
      codeChallenge: 'cc',
    });
    expect(url).not.toContain('include_granted_scopes');
  });

  it('ne demande que le scope lecture pour une capacité lecture', () => {
    const url = new URL(buildAuthorizationUrl({
      provider: 'gmail',
      clientId: 'c',
      redirectUri: 'r',
      capabilities: ['read'],
      state: 's',
      codeChallenge: 'cc',
    }));
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('gmail.readonly');
    expect(scope).not.toContain('gmail.send');
  });
});

function fakeFetch(spec: { status?: number; json?: unknown }) {
  const calls: Array<{ url: string; body: string | null }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      json: async () => spec.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('oauth / échange de code', () => {
  it('transmet le vérificateur PKCE et le secret côté serveur', async () => {
    const { impl, calls } = fakeFetch({
      json: {
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/gmail.readonly openid',
      },
    });
    const tokens = await exchangeCode({
      clientId: 'client-123',
      clientSecret: 'secret-serveur',
      redirectUri: 'https://vyora.app/callback',
      code: 'code-abc',
      codeVerifier: 'verifier-xyz',
      fetchImpl: impl,
    });
    expect(tokens.accessToken).toBe('ya29.access');
    expect(tokens.refreshToken).toBe('1//refresh');
    expect(tokens.expiresInSeconds).toBe(3599);
    expect(tokens.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');

    const body = new URLSearchParams(calls[0].body ?? '');
    expect(body.get('code_verifier')).toBe('verifier-xyz');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_secret')).toBe('secret-serveur');
  });

  it('refuse une réponse sans access_token', async () => {
    const { impl } = fakeFetch({ json: { refresh_token: 'x' } });
    await expect(exchangeCode({
      clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v', fetchImpl: impl,
    })).rejects.toThrow('token_exchange_failed:no_access_token');
  });

  it('refuse une réponse d’erreur Google', async () => {
    const { impl } = fakeFetch({ status: 400, json: { error: 'invalid_grant' } });
    await expect(exchangeCode({
      clientId: 'c', clientSecret: 's', redirectUri: 'r', code: 'x', codeVerifier: 'v', fetchImpl: impl,
    })).rejects.toThrow('token_exchange_failed:invalid_grant');
  });
});

describe('oauth / rafraîchissement', () => {
  it('conserve le refresh token quand Google n’en renvoie pas', async () => {
    const { impl } = fakeFetch({ json: { access_token: 'nouveau', expires_in: 3600 } });
    const tokens = await refreshAccessToken({
      clientId: 'c', clientSecret: 's', refreshToken: 'refresh-original', fetchImpl: impl,
    });
    expect(tokens.accessToken).toBe('nouveau');
    expect(tokens.refreshToken).toBe('refresh-original');
  });

  it('remplace le refresh token s’il en renvoie un nouveau', async () => {
    const { impl } = fakeFetch({ json: { access_token: 'a', refresh_token: 'rotation', expires_in: 3600 } });
    const tokens = await refreshAccessToken({
      clientId: 'c', clientSecret: 's', refreshToken: 'ancien', fetchImpl: impl,
    });
    expect(tokens.refreshToken).toBe('rotation');
  });
});

describe('oauth / révocation', () => {
  it('signale le succès', async () => {
    const { impl, calls } = fakeFetch({ json: {} });
    expect(await revokeToken({ token: 'jeton-a-revoquer', fetchImpl: impl })).toBe(true);
    expect(calls[0].url).toContain('token=jeton-a-revoquer');
  });

  it('signale l’échec sans lever', async () => {
    const { impl } = fakeFetch({ status: 400, json: {} });
    expect(await revokeToken({ token: 'x', fetchImpl: impl })).toBe(false);
  });

  it('ne lève pas si le réseau tombe', async () => {
    const broken = (async () => { throw new Error('réseau'); }) as unknown as typeof fetch;
    expect(await revokeToken({ token: 'x', fetchImpl: broken })).toBe(false);
  });
});

describe('oauth / décodage du compte', () => {
  function makeIdToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`;
  }

  it('extrait sub, email et nom', () => {
    const token = makeIdToken({ sub: '1234567890', email: 'a@exemple.com', name: 'Camille' });
    expect(decodeIdTokenClaims(token)).toEqual({ sub: '1234567890', email: 'a@exemple.com', name: 'Camille' });
  });

  it('renvoie null sur un jeton malformé, sans lever', () => {
    expect(decodeIdTokenClaims('pas.un.jwt.valide')).toBeNull();
    expect(decodeIdTokenClaims('')).toBeNull();
    expect(decodeIdTokenClaims('a.b')).toBeNull();
  });

  it('refuse un jeton sans sub', () => {
    expect(decodeIdTokenClaims(makeIdToken({ email: 'a@b.c' }))).toBeNull();
  });
});

describe('oauth / aucun secret ne fuit', () => {
  it('le scellé ne contient jamais le jeton en clair', async () => {
    const secret = 'ya29.CONFIDENTIEL_ne_doit_jamais_apparaitre';
    const sealed = await encryptSecret(secret, KEY);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain('CONFIDENTIEL');
    expect(serialized).not.toContain('ya29');
  });

  it('l’URL d’autorisation ne contient aucun secret client', () => {
    const url = buildAuthorizationUrl({
      provider: 'gmail',
      clientId: 'client-public-ok',
      redirectUri: 'https://vyora.app/cb',
      capabilities: ['read'],
      state: 's',
      codeChallenge: 'cc',
    });
    expect(url).not.toContain('client_secret');
    expect(url).not.toContain('secret');
  });
});
