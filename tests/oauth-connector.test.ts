// VYORA — Edge Function du connecteur OAuth (Gmail/Drive/Calendar).
//
// Le store est en mémoire et `fetch` est simulé : ces tests vérifient le
// comportement réel du code déployé (routage, CSRF, PKCE, capacités, isolation,
// révocation) sans dépendre du réseau ni d'un secret Google.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthError,
  loadUsableAccount,
  normalizeCapabilities,
  refreshAccount,
  revokeAccount,
} from '../supabase/functions/vyora-oauth/accounts.ts';
import {
  createHandler,
  handleCallback,
  handleList,
  handleRevoke,
  handleStart,
  type HandlerDeps,
} from '../supabase/functions/vyora-oauth/index.ts';
import type { AuditEntry, OAuthAccountRow, OAuthStore, StateRow } from '../supabase/functions/vyora-oauth/store.ts';
import { decryptSecret, encryptSecret, generateKeyBase64 } from '../supabase/functions/_shared/oauth/crypto.ts';

const KEY = generateKeyBase64();
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * Compte stocké en mémoire. Contrairement à `OAuthAccountRow` (qui décrit une
 * lecture), les champs sont mutables : c'est ce qui permet de vérifier qu'une
 * révocation EFFACE réellement les cryptogrammes.
 */
type MutableAccount = { -readonly [K in keyof OAuthAccountRow]: OAuthAccountRow[K] };

interface MemoryStore extends OAuthStore {
  readonly states: Map<string, StateRow & { consumed: boolean }>;
  readonly accounts: Map<string, MutableAccount>;
  readonly audits: AuditEntry[];
  counter: number;
}

function createMemoryStore(): MemoryStore {
  const states = new Map<string, StateRow & { consumed: boolean }>();
  const accounts = new Map<string, MutableAccount>();
  const audits: AuditEntry[] = [];
  let counter = 0;

  return {
    states,
    accounts,
    audits,
    get counter() { return counter; },
    set counter(value: number) { counter = value; },

    async createState(input) {
      states.set(input.state, {
        user_id: input.userId,
        provider: input.provider,
        verifier_cipher: input.verifierCipher,
        verifier_iv: input.verifierIv,
        verifier_tag: input.verifierTag,
        requested_capabilities: input.capabilities,
        consumed: false,
      });
    },

    async consumeState(state) {
      const row = states.get(state);
      // Usage unique : une seconde consommation ne rend rien.
      if (!row || row.consumed) return null;
      row.consumed = true;
      return row;
    },

    async upsertAccount(payload) {
      counter += 1;
      const id = `acct-${counter}`;
      const previous = [...accounts.values()].find(
        (a) => a.user_id === payload.user_id && a.provider === payload.provider
          && a.external_account_id === payload.external_account_id,
      );
      const row: MutableAccount = {
        id: previous?.id ?? id,
        user_id: String(payload.user_id),
        provider: String(payload.provider),
        external_account_id: String(payload.external_account_id),
        status: String(payload.status ?? 'connected'),
        capabilities: (payload.capabilities as string[]) ?? ['read'],
        access_token_cipher: (payload.access_token_cipher as string) ?? previous?.access_token_cipher ?? null,
        access_token_iv: (payload.access_token_iv as string) ?? previous?.access_token_iv ?? null,
        access_token_tag: (payload.access_token_tag as string) ?? previous?.access_token_tag ?? null,
        refresh_token_cipher: (payload.refresh_token_cipher as string) ?? previous?.refresh_token_cipher ?? null,
        refresh_token_iv: (payload.refresh_token_iv as string) ?? previous?.refresh_token_iv ?? null,
        refresh_token_tag: (payload.refresh_token_tag as string) ?? previous?.refresh_token_tag ?? null,
        access_expires_at: (payload.access_expires_at as string) ?? previous?.access_expires_at ?? null,
      };
      accounts.set(row.id, row);
      return row.id;
    },

    async getAccountSecret(accountId) {
      return accounts.get(accountId) ?? null;
    },

    async setAccountStatus(accountId, status, error = null) {
      const row = accounts.get(accountId);
      if (!row) return;
      row.status = status;
      if (status === 'revoked') {
        // La révocation efface réellement les cryptogrammes.
        row.access_token_cipher = null;
        row.access_token_iv = null;
        row.access_token_tag = null;
        row.refresh_token_cipher = null;
        row.refresh_token_iv = null;
        row.refresh_token_tag = null;
        row.capabilities = [];
      }
      void error;
    },

    async updateTokens(input) {
      const row = accounts.get(input.accountId);
      if (!row) return false;
      row.access_token_cipher = input.access.cipher;
      row.access_token_iv = input.access.iv;
      row.access_token_tag = input.access.tag;
      if (input.refresh) {
        row.refresh_token_cipher = input.refresh.cipher;
        row.refresh_token_iv = input.refresh.iv;
        row.refresh_token_tag = input.refresh.tag;
      }
      row.access_expires_at = input.expiresAt;
      row.status = 'connected';
      return true;
    },

    async audit(entry) {
      audits.push(entry);
    },
  };
}

function googleFetch(spec: {
  token?: Record<string, unknown>;
  tokenStatus?: number;
  revokeOk?: boolean;
  profile?: unknown;
} = {}) {
  // Les en-têtes sont enregistrés : c'est ce qui permet de vérifier que le
  // jeton Google voyage bien en `Authorization` et jamais dans l'URL.
  const calls: Array<{ url: string; body: string | null; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      body: typeof init.body === 'string' ? init.body : null,
      init,
    });
    if (String(url).includes('/revoke')) {
      return { ok: spec.revokeOk ?? true, status: spec.revokeOk === false ? 400 : 200, json: async () => ({}) } as Response;
    }
    if (String(url).includes('/token')) {
      return {
        ok: (spec.tokenStatus ?? 200) < 400,
        status: spec.tokenStatus ?? 200,
        json: async () => spec.token ?? {},
      } as Response;
    }
    return { ok: true, status: 200, json: async () => spec.profile ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.sig`;
}

function deps(store: MemoryStore, fetchImpl?: typeof fetch): HandlerDeps {
  return {
    store,
    config: {
      baseUrl: 'https://projet.supabase.co',
      serviceKey: 'service-key-factice',
      clientId: 'client-id-google',
      clientSecret: 'client-secret-google',
      encryptionKey: KEY,
      redirectUri: 'https://projet.supabase.co/functions/v1/vyora-oauth?action=callback',
      fetchImpl,
    },
  };
}

describe('connecteur OAuth / capacités', () => {
  it('normalise une liste vide en lecture seule', () => {
    expect(normalizeCapabilities([])).toEqual(['read']);
    expect(normalizeCapabilities(undefined)).toEqual(['read']);
  });

  it('respecte un ordre stable et dédoublonne', () => {
    expect(normalizeCapabilities(['send', 'read', 'send'])).toEqual(['read', 'send']);
    expect(normalizeCapabilities(['modify', 'draft', 'read', 'send'])).toEqual(['read', 'draft', 'send', 'modify']);
  });

  it('refuse une capacité inconnue au lieu de l’ignorer', () => {
    expect(() => normalizeCapabilities(['admin'])).toThrow('capability_unknown:admin');
    expect(() => normalizeCapabilities(['read', 42])).toThrow('capabilities_invalid');
    expect(() => normalizeCapabilities('read')).toThrow('capabilities_invalid');
  });
});

describe('connecteur OAuth / start', () => {
  let store: MemoryStore;
  beforeEach(() => { store = createMemoryStore(); });

  it('rend une URL Google avec PKCE, état et scopes lecture', async () => {
    const response = await handleStart({ provider: 'gmail', capabilities: ['read'] }, deps(store), USER_A);
    expect(response.status).toBe(200);
    const body = await response.json() as { authorization_url: string; state: string; capabilities: string[] };
    const url = new URL(body.authorization_url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).not.toContain('gmail.send');
    expect(body.capabilities).toEqual(['read']);
  });

  it('stocke le vérificateur CHIFFRÉ, jamais en clair', async () => {
    const response = await handleStart({ provider: 'gmail', capabilities: ['read'] }, deps(store), USER_A);
    const body = await response.json() as { state: string; authorization_url: string };
    const row = store.states.get(body.state);
    expect(row).toBeDefined();
    // Le vérificateur n'apparaît nulle part en clair.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('code_challenge');
    expect(row!.verifier_cipher.length).toBeGreaterThan(20);
    expect(row!.verifier_iv).toBeTruthy();
    expect(row!.verifier_tag).toBeTruthy();
    // Et il est bien déchiffrable avec la clé.
    const verifier = await decryptSecret(
      { cipher: row!.verifier_cipher, iv: row!.verifier_iv, tag: row!.verifier_tag },
      KEY,
    );
    const challenge = new URL(body.authorization_url).searchParams.get('code_challenge');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const expected = Buffer.from(new Uint8Array(digest)).toString('base64url');
    expect(challenge).toBe(expected);
  });

  it('refuse un fournisseur inconnu', async () => {
    const response = await handleStart({ provider: 'outlook', capabilities: ['read'] }, deps(store), USER_A);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('provider_invalid');
  });

  it('refuse une capacité non supportée par le fournisseur', async () => {
    const response = await handleStart({ provider: 'google_drive', capabilities: ['send'] }, deps(store), USER_A);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('capability_not_supported');
  });

  it('refuse sans identifiant Google configuré', async () => {
    const d = deps(store);
    const response = await handleStart({ provider: 'gmail', capabilities: ['read'] },
      { ...d, config: { ...d.config, clientId: '' } }, USER_A);
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('google_not_configured');
  });

  it('journalise le démarrage sans révéler de secret', async () => {
    await handleStart({ provider: 'gmail', capabilities: ['read', 'draft'] }, deps(store), USER_A);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].action).toBe('connect_start');
    expect(JSON.stringify(store.audits)).not.toContain('client-secret');
  });
});

describe('connecteur OAuth / callback', () => {
  let store: MemoryStore;
  beforeEach(() => { store = createMemoryStore(); });

  async function startFor(capabilities: string[] = ['read', 'draft']) {
    const response = await handleStart({ provider: 'gmail', capabilities }, deps(store), USER_A);
    return (await response.json() as { state: string }).state;
  }

  it('connecte le compte et n’expose jamais les jetons', async () => {
    const state = await startFor();
    const { impl } = googleFetch({
      token: {
        access_token: 'ya29.access-secret',
        refresh_token: '1//refresh-secret',
        expires_in: 3599,
        scope: 'openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
        id_token: makeIdToken({ sub: 'google-sub-123', email: 'camille@exemple.com', name: 'Camille' }),
      },
    });
    const response = await handleCallback({ code: 'code-abc', state }, deps(store, impl));
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { connected: boolean; email: string; capabilities: string[]; account_id: string };

    expect(body.connected).toBe(true);
    expect(body.email).toBe('camille@exemple.com');
    expect(body.capabilities).toEqual(['read', 'draft']);
    // Aucun jeton dans la réponse HTTP.
    expect(text).not.toContain('ya29');
    expect(text).not.toContain('refresh-secret');

    // En base : jetons présents mais chiffrés.
    const row = store.accounts.get(body.account_id)!;
    expect(row.access_token_cipher).toBeTruthy();
    expect(row.access_token_cipher).not.toContain('ya29');
    const decoded = await decryptSecret(
      { cipher: row.access_token_cipher!, iv: row.access_token_iv!, tag: row.access_token_tag! }, KEY,
    );
    expect(decoded).toBe('ya29.access-secret');
  });

  it('n’enregistre que les capacités réellement accordées', async () => {
    const state = await startFor(['read', 'draft', 'send']);
    const { impl } = googleFetch({
      token: {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 3600,
        // L'utilisateur a refusé l'envoi : seul readonly a été accordé.
        scope: 'openid https://www.googleapis.com/auth/gmail.readonly',
        id_token: makeIdToken({ sub: 's1', email: 'x@y.z' }),
      },
    });
    const response = await handleCallback({ code: 'c', state }, deps(store, impl));
    const body = await response.json() as { capabilities: string[] };
    expect(body.capabilities).toEqual(['read']);
    // La capacité d'envoi n'est donc PAS utilisable.
    expect(store.accounts.get(store.accounts.keys().next().value as string)!.capabilities).not.toContain('send');
  });

  it('refuse quand aucune capacité n’est accordée', async () => {
    const state = await startFor(['send']);
    const { impl } = googleFetch({
      token: { access_token: 'a', expires_in: 3600, scope: 'openid', id_token: makeIdToken({ sub: 's' }) },
    });
    const response = await handleCallback({ code: 'c', state }, deps(store, impl));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('no_capability_granted');
    expect(store.accounts.size).toBe(0);
  });

  it('refuse un état inconnu (CSRF)', async () => {
    const { impl } = googleFetch({ token: { access_token: 'a' } });
    const response = await handleCallback({ code: 'c', state: 'etat-invente' }, deps(store, impl));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('state_invalid');
  });

  it('l’état est à usage unique : le rejeu échoue', async () => {
    const state = await startFor();
    const { impl } = googleFetch({
      token: { access_token: 'a', refresh_token: 'r', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly', id_token: makeIdToken({ sub: 's' }) },
    });
    const first = await handleCallback({ code: 'c', state }, deps(store, impl));
    expect(first.status).toBe(200);
    const second = await handleCallback({ code: 'c', state }, deps(store, impl));
    expect(second.status).toBe(400);
    expect((await second.json() as { error: string }).error).toBe('state_invalid');
  });

  it('consomme l’état même si l’échange échoue (pas de rejeu possible)', async () => {
    const state = await startFor();
    const { impl } = googleFetch({ tokenStatus: 400, token: { error: 'invalid_grant' } });
    const response = await handleCallback({ code: 'c', state }, deps(store, impl));
    expect(response.status).toBe(502);
    expect(store.states.get(state)!.consumed).toBe(true);
  });

  it('refuse un code ou un état manquant', async () => {
    expect((await handleCallback({ code: '', state: 'x' }, deps(store))).status).toBe(400);
    expect((await handleCallback({ code: 'x', state: '' }, deps(store))).status).toBe(400);
  });

  it('journalise un refus utilisateur', async () => {
    const response = await handleCallback({ code: '', state: '', error: 'access_denied' }, deps(store));
    expect(response.status).toBe(400);
    expect(store.audits.some((a) => a.action === 'connect_failure')).toBe(true);
  });
});

describe('connecteur OAuth / isolation entre utilisateurs', () => {
  it('un utilisateur ne peut pas révoquer le compte d’un autre', async () => {
    const store = createMemoryStore();
    const sealed = await encryptSecret('jeton', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read'], status: 'connected',
    });

    const response = await handleRevoke({ account_id: accountId }, deps(store), USER_B);
    expect(response.status).toBe(403);
    // Le compte de A est intact.
    expect((await store.getAccountSecret(accountId!))!.status).toBe('connected');
  });

  it('un utilisateur ne peut pas charger les jetons d’un autre', async () => {
    const store = createMemoryStore();
    const sealed = await encryptSecret('jeton', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read'], status: 'connected',
    });
    // check est borné par user_id côté handler.
    const { handleCheck } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleCheck({ account_id: accountId, capability: 'read' }, deps(store), USER_B);
    expect(response.status).toBe(403);
  });
});

describe('connecteur OAuth / garde de capacités à l’usage', () => {
  it('refuse un appel sans la capacité demandée, et le journalise', async () => {
    const store = createMemoryStore();
    const sealed = await encryptSecret('ya29.jeton', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read', 'draft'], status: 'connected',
    });

    await expect(loadUsableAccount({
      store, accountId: accountId!, capability: 'send', encryptionKey: KEY,
    })).rejects.toThrow(OAuthError);

    const denial = store.audits.find((a) => a.action === 'denied');
    expect(denial).toBeDefined();
    expect(denial!.capability).toBe('send');
    expect(denial!.outcome).toBe('denied');
  });

  it('autorise la capacité accordée et rend le jeton déchiffré', async () => {
    const store = createMemoryStore();
    const sealed = await encryptSecret('ya29.jeton-lisible', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read'], status: 'connected',
    });
    const result = await loadUsableAccount({
      store, accountId: accountId!, capability: 'read', encryptionKey: KEY,
    });
    expect(result.accessToken).toBe('ya29.jeton-lisible');
    expect(result.provider).toBe('gmail');
  });

  it('refuse un compte révoqué', async () => {
    const store = createMemoryStore();
    const sealed = await encryptSecret('x', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read'], status: 'revoked',
    });
    await expect(loadUsableAccount({
      store, accountId: accountId!, capability: 'read', encryptionKey: KEY,
    })).rejects.toThrow(/account_revoked/);
  });

  it('refuse un compte inconnu', async () => {
    const store = createMemoryStore();
    await expect(loadUsableAccount({
      store, accountId: 'inexistant', capability: 'read', encryptionKey: KEY,
    })).rejects.toThrow(/account_not_found/);
  });

  it('refuse un jeton indéchiffrable au lieu de l’utiliser', async () => {
    const store = createMemoryStore();
    const autreCle = generateKeyBase64();
    const sealed = await encryptSecret('jeton', autreCle);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: sealed.cipher, access_token_iv: sealed.iv, access_token_tag: sealed.tag,
      capabilities: ['read'], status: 'connected',
    });
    await expect(loadUsableAccount({
      store, accountId: accountId!, capability: 'read', encryptionKey: KEY,
    })).rejects.toThrow(/decrypt_failed/);
  });
});

describe('connecteur OAuth / IV indépendants (régression cryptographique)', () => {
  it('l’access token et le refresh token ont des IV et étiquettes DIFFÉRENTS', async () => {
    const store = createMemoryStore();
    const state = await (async () => {
      const response = await handleStart({ provider: 'gmail', capabilities: ['read'] }, deps(store), USER_A);
      return (await response.json() as { state: string }).state;
    })();

    const { impl } = googleFetch({
      token: {
        access_token: 'ya29.access',
        refresh_token: '1//refresh',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        id_token: makeIdToken({ sub: 's', email: 'a@b.c' }),
      },
    });
    await handleCallback({ code: 'c', state }, deps(store, impl));

    const row = [...store.accounts.values()][0];
    // Un IV réutilisé entre deux chiffrements sous la même clé détruit la
    // sécurité de GCM. Ce test verrouille la correction du schéma.
    expect(row.access_token_iv).toBeTruthy();
    expect(row.refresh_token_iv).toBeTruthy();
    expect(row.access_token_iv).not.toBe(row.refresh_token_iv);
    expect(row.access_token_tag).not.toBe(row.refresh_token_tag);

    // Et chaque jeton se déchiffre avec SON propre couple IV/tag.
    expect(await decryptSecret(
      { cipher: row.access_token_cipher!, iv: row.access_token_iv!, tag: row.access_token_tag! }, KEY,
    )).toBe('ya29.access');
    expect(await decryptSecret(
      { cipher: row.refresh_token_cipher!, iv: row.refresh_token_iv!, tag: row.refresh_token_tag! }, KEY,
    )).toBe('1//refresh');
  });

  it('un jeton ne se déchiffre pas avec l’IV de l’autre', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('ya29.a', KEY);
    const refresh = await encryptSecret('1//r', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, access_token_iv: access.iv, access_token_tag: access.tag,
      refresh_token_cipher: refresh.cipher, refresh_token_iv: refresh.iv, refresh_token_tag: refresh.tag,
      capabilities: ['read'], status: 'connected',
    });
    const row = (await store.getAccountSecret(accountId!))!;
    await expect(decryptSecret(
      { cipher: row.access_token_cipher!, iv: row.refresh_token_iv!, tag: row.access_token_tag! }, KEY,
    )).rejects.toThrow();
    await expect(decryptSecret(
      { cipher: row.refresh_token_cipher!, iv: row.access_token_iv!, tag: row.refresh_token_tag! }, KEY,
    )).rejects.toThrow();
  });
});

describe('connecteur OAuth / révocation', () => {
  it('révoque chez Google puis efface les cryptogrammes locaux', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('ya29.a', KEY);
    const refresh = await encryptSecret('1//r', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, refresh_token_cipher: refresh.cipher,
      access_token_iv: access.iv, access_token_tag: access.tag,
      refresh_token_iv: refresh.iv, refresh_token_tag: refresh.tag,
      capabilities: ['read', 'send'], status: 'connected',
    });

    const { impl, calls } = googleFetch({ revokeOk: true });
    const result = await revokeAccount({ store, encryptionKey: KEY, accountId: accountId!, fetchImpl: impl });
    expect(result).toEqual({ revoked: true, remoteRevoked: true });
    expect(calls.some((c) => c.url.includes('/revoke'))).toBe(true);
    // Les cryptogrammes sont réellement effacés.
    expect(store.accounts.get(accountId!)!.access_token_cipher).toBeNull();
    expect(store.accounts.get(accountId!)!.refresh_token_cipher).toBeNull();
    expect(store.accounts.get(accountId!)!.capabilities).toEqual([]);
  });

  it('efface quand même localement si Google refuse', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('ya29.a', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, access_token_iv: access.iv, access_token_tag: access.tag,
      capabilities: ['read'], status: 'connected',
    });
    const { impl } = googleFetch({ revokeOk: false });
    const result = await revokeAccount({ store, encryptionKey: KEY, accountId: accountId!, fetchImpl: impl });
    expect(result.remoteRevoked).toBe(false);
    expect(store.accounts.get(accountId!)!.status).toBe('revoked');
    expect(store.accounts.get(accountId!)!.access_token_cipher).toBeNull();
  });

  it('un compte révoqué ne peut plus rien faire', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('ya29.a', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, access_token_iv: access.iv, access_token_tag: access.tag,
      capabilities: ['read'], status: 'connected',
    });
    const { impl } = googleFetch({ revokeOk: true });
    await revokeAccount({ store, encryptionKey: KEY, accountId: accountId!, fetchImpl: impl });
    await expect(loadUsableAccount({
      store, accountId: accountId!, capability: 'read', encryptionKey: KEY,
    })).rejects.toThrow(/account_revoked/);
  });
});

describe('connecteur OAuth / rafraîchissement', () => {
  it('remplace l’access token chiffré et conserve le refresh token', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('vieux', KEY);
    const refresh = await encryptSecret('refresh-original', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, refresh_token_cipher: refresh.cipher,
      access_token_iv: access.iv, access_token_tag: access.tag,
      refresh_token_iv: refresh.iv, refresh_token_tag: refresh.tag,
      capabilities: ['read'], status: 'connected',
    });
    const row = (await store.getAccountSecret(accountId!))!;
    const { impl } = googleFetch({ token: { access_token: 'nouveau', expires_in: 3600 } });

    const token = await refreshAccount(row, {
      store, encryptionKey: KEY, clientId: 'c', clientSecret: 's', fetchImpl: impl,
    });
    expect(token).toBe('nouveau');

    const updated = (await store.getAccountSecret(accountId!))!;
    const decrypted = await decryptSecret(
      { cipher: updated.access_token_cipher!, iv: updated.access_token_iv!, tag: updated.access_token_tag! }, KEY,
    );
    expect(decrypted).toBe('nouveau');
    // Le refresh token d'origine est conservé (Google n'en renvoie pas).
    expect(updated.refresh_token_cipher).toBe(refresh.cipher);
  });

  it('marque le compte expiré si le rafraîchissement échoue', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('vieux', KEY);
    const refresh = await encryptSecret('refresh', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, refresh_token_cipher: refresh.cipher,
      access_token_iv: access.iv, access_token_tag: access.tag,
      refresh_token_iv: refresh.iv, refresh_token_tag: refresh.tag,
      capabilities: ['read'], status: 'connected',
    });
    const row = (await store.getAccountSecret(accountId!))!;
    const { impl } = googleFetch({ tokenStatus: 400, token: { error: 'invalid_grant' } });
    await expect(refreshAccount(row, {
      store, encryptionKey: KEY, clientId: 'c', clientSecret: 's', fetchImpl: impl,
    })).rejects.toThrow(/refresh_failed/);
    expect(store.accounts.get(accountId!)!.status).toBe('expired');
    expect(store.audits.some((a) => a.action === 'token_refresh_failure')).toBe(true);
  });

  it('signale un compte sans refresh token', async () => {
    const store = createMemoryStore();
    const access = await encryptSecret('vieux', KEY);
    const accountId = await store.upsertAccount({
      user_id: USER_A, provider: 'gmail', external_account_id: 'sub-a',
      access_token_cipher: access.cipher, access_token_iv: access.iv, access_token_tag: access.tag,
      capabilities: ['read'], status: 'connected',
    });
    const row = (await store.getAccountSecret(accountId!))!;
    await expect(refreshAccount(row, {
      store, encryptionKey: KEY, clientId: 'c', clientSecret: 's',
    })).rejects.toThrow(/refresh_token_missing/);
  });
});

describe('connecteur OAuth / routage HTTP', () => {
  it('refuse une requête sans jeton', async () => {
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: KEY, redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST', body: JSON.stringify({ action: 'list' }),
    }));
    expect(response.status).toBe(401);
  });

  it('refuse un JSON malformé', async () => {
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: KEY, redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: '{cassé',
    }));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('invalid_json');
  });

  it('refuse quand la configuration serveur est incomplète', async () => {
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: '', redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify({ action: 'list' }),
    }));
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe('oauth_not_configured');
  });

  it('accepte le callback en GET (redirection Google) sans jeton', async () => {
    // `fetch` est injecté : l'état est inconnu (tableau vide), donc le callback
    // est refusé pour état invalide — surtout PAS pour absence de jeton, ce qui
    // prouve que la route est bien ouverte à la redirection navigateur.
    const fetchImpl = (async () => ({
      ok: true, status: 200, text: async () => '[]', json: async () => [],
    })) as unknown as typeof fetch;

    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: KEY, redirectUri: 'https://p/cb',
      fetchImpl,
    });
    const response = await handler(new Request(
      'https://p.supabase.co/functions/v1/vyora-oauth?action=callback&code=x&state=inconnu',
    ));
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('state_invalid');
  });

  it('rejette une action inconnue', async () => {
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: KEY, redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST', headers: { Authorization: 'Bearer jwt' },
      body: JSON.stringify({ action: 'supprimer_tout' }),
    }));
    expect(response.status).toBe(404);
  });

  it('répond au préflight CORS', async () => {
    const handler = createHandler({
      baseUrl: 'https://p.supabase.co', serviceKey: 'k', clientId: 'c',
      clientSecret: 's', encryptionKey: KEY, redirectUri: 'https://p/cb',
    });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

describe('connecteur OAuth / list', () => {
  it('retire toute colonne de jeton de la réponse', async () => {
    const store = createMemoryStore();
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => [{
        id: 'a1', provider: 'gmail', email: 'x@y.z', capabilities: ['read'],
        access_token_cipher: 'NE-DOIT-PAS-FUIR', refresh_token_cipher: 'NON-PLUS',
        access_token_iv: 'iv1', access_token_tag: 'tag1',
        refresh_token_iv: 'iv2', refresh_token_tag: 'tag2',
      }],
    })) as unknown as typeof fetch;

    const response = await handleList(deps(store, fetchImpl), 'jwt-utilisateur');
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain('NE-DOIT-PAS-FUIR');
    expect(text).not.toContain('NON-PLUS');
    const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).not.toHaveProperty('access_token_cipher');
    expect(body.items[0].email).toBe('x@y.z');
  });

  it('utilise le JWT de l’utilisateur, jamais la clé service', async () => {
    const store = createMemoryStore();
    const calls: Array<RequestInit> = [];
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      calls.push(init);
      return { ok: true, status: 200, json: async () => [] } as Response;
    }) as unknown as typeof fetch;
    await handleList(deps(store, fetchImpl), 'jwt-utilisateur');
    const headers = calls[0].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-utilisateur');
  });
});

describe('connecteur OAuth / statut de configuration', () => {
  it('annonce Google configuré seulement si les DEUX identifiants ET la clé existent', async () => {
    const store = createMemoryStore();
    const { handleStatus } = await import('../supabase/functions/vyora-oauth/index.ts');
    const d = deps(store);

    const complet = handleStatus(d);
    expect(complet.status).toBe(200);
    expect(await complet.json()).toMatchObject({
      google: true,
      encryption_configured: true,
      providers: { gmail: true, google_drive: true, google_calendar: true },
    });
  });

  it('refuse d’annoncer Google prêt sans secret client', async () => {
    const store = createMemoryStore();
    const { handleStatus } = await import('../supabase/functions/vyora-oauth/index.ts');
    const d = deps(store);
    const response = handleStatus({ ...d, config: { ...d.config, clientSecret: '' } });
    const body = await response.json() as { google: boolean; providers: Record<string, boolean> };
    expect(body.google).toBe(false);
    expect(body.providers.gmail).toBe(false);
  });

  it('refuse d’annoncer Google prêt sans clé de chiffrement', async () => {
    const store = createMemoryStore();
    const { handleStatus } = await import('../supabase/functions/vyora-oauth/index.ts');
    const d = deps(store);
    const response = handleStatus({ ...d, config: { ...d.config, encryptionKey: '' } });
    const body = await response.json() as { google: boolean; encryption_configured: boolean };
    // Sans clé, connecter un compte stockerait des jetons illisibles.
    expect(body.google).toBe(false);
    expect(body.encryption_configured).toBe(false);
  });

  it('ne divulgue aucun secret dans la réponse', async () => {
    const store = createMemoryStore();
    const { handleStatus } = await import('../supabase/functions/vyora-oauth/index.ts');
    const text = await handleStatus(deps(store)).text();
    expect(text).not.toContain('client-secret-google');
    expect(text).not.toContain('client-id-google');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('service-key-factice');
  });
});

describe('connecteur OAuth / outils Google exposés en MCP', () => {
  /** Crée un compte réel dans le store mémoire, jetons réellement chiffrés. */
  async function makeAccount(
    store: MemoryStore,
    accessToken: string,
    opts: { userId?: string; provider?: string; capabilities?: string[]; status?: string } = {},
  ) {
    const spec = {
      userId: opts.userId ?? USER_A,
      provider: opts.provider ?? 'gmail',
      capabilities: opts.capabilities ?? ['read'],
      status: opts.status ?? 'connected',
    };
    const access = await encryptSecret(accessToken, KEY);
    const id = await store.upsertAccount({
      user_id: spec.userId,
      provider: spec.provider,
      external_account_id: `ext-${Math.random().toString(36).slice(2)}`,
      access_token_cipher: access.cipher,
      access_token_iv: access.iv,
      access_token_tag: access.tag,
      capabilities: spec.capabilities,
      status: spec.status,
    });
    return id!;
  }

  it('tools_list expose les six outils Google', async () => {
    // `tools/list` ne dépend d'aucun compte : la découverte est publique au
    // sein de la fonction, l'autorisation n'intervient qu'à l'appel.
    const { handleToolsList } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = handleToolsList();
    expect(response.status).toBe(200);
    const body = await response.json() as { count: number; tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    expect(body.count).toBe(6);
    expect(body.tools.map((t) => t.name)).toContain('vyora_gmail_search');
    expect(body.tools.map((t) => t.name)).toContain('vyora_gmail_send');
  });

  it('tools_call refuse un outil inconnu', async () => {
    const store = createMemoryStore();
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall({ name: 'vyora_supprimer_tout' }, deps(store), USER_A);
    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toBe('tool_unknown');
  });

  it('tools_call refuse le compte d’un autre utilisateur AVANT tout appel Google', async () => {
    const store = createMemoryStore();
    const fetchImpl = vi.fn();
    const accountId = await makeAccount(store, 'ya29.jeton');
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', account_id: accountId, arguments: {} },
      deps(store, fetchImpl as unknown as typeof fetch),
      USER_B,
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('forbidden');
    // Aucune requête réseau n'a été tentée.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tools_call refuse une capacité non accordée, sans appel réseau', async () => {
    const store = createMemoryStore();
    const fetchImpl = vi.fn();
    const accountId = await makeAccount(store, 'ya29.jeton', { capabilities: ['read'] });
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall(
      { name: 'vyora_gmail_send', account_id: accountId, arguments: { to: 'a@b.co', body: 'x' } },
      deps(store, fetchImpl as unknown as typeof fetch),
      USER_A,
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe('capability_not_granted');
    expect(fetchImpl).not.toHaveBeenCalled();
    // Le refus est journalisé : c'est une tentative d'action, pas un oubli.
    expect(store.audits.some((a) => a.action === 'denied' && a.capability === 'send')).toBe(true);
  });

  it('tools_call exécute une recherche et journalise le succès', async () => {
    const store = createMemoryStore();
    const accountId = await makeAccount(store, 'ya29.jeton-valide', { capabilities: ['read'] });
    const { impl, calls } = googleFetch({
      profile: { messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 },
    });
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', account_id: accountId, arguments: { query: 'from:client@x.co' } },
      deps(store, impl),
      USER_A,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { tool: string; result: { count: number } };
    expect(body.tool).toBe('vyora_gmail_search');
    expect(body.result.count).toBe(1);
    // Un seul appel réseau, et il porte le jeton DÉCHIFFRÉ : c'est le vrai
    // chemin (chiffré en base -> déchiffré en mémoire -> en-tête Google).
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ya29.jeton-valide');
    // La réponse HTTP ne contient jamais le jeton.
    expect(JSON.stringify(body)).not.toContain('ya29');
    expect(store.audits.some((a) => a.action === 'read' && a.outcome === 'ok')).toBe(true);
  });

  it('tools_call refuse un compte révoqué', async () => {
    const store = createMemoryStore();
    const accountId = await makeAccount(store, 'ya29.jeton', { status: 'revoked' });
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', account_id: accountId, arguments: {} },
      deps(store),
      USER_A,
    );
    expect(response.status).toBe(409);
    expect((await response.json() as { error: string }).error).toBe('account_revoked');
  });

  it('tools_call refuse un outil Gmail sur un compte Drive', async () => {
    const store = createMemoryStore();
    const accountId = await makeAccount(store, 'ya29.jeton', { provider: 'google_drive', capabilities: ['read'] });
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', account_id: accountId, arguments: {} },
      deps(store),
      USER_A,
    );
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('provider_mismatch');
  });

  it('tools_call exige l’identifiant de compte', async () => {
    const store = createMemoryStore();
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const response = await handleToolCall({ name: 'vyora_gmail_search' }, deps(store), USER_A);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toBe('account_id_required');
  });

  it('un refus d’envoi ne divulgue jamais le jeton', async () => {
    const store = createMemoryStore();
    const accountId = await makeAccount(store, 'ya29.TRES-SECRET', { capabilities: ['read'] });
    const { handleToolCall } = await import('../supabase/functions/vyora-oauth/index.ts');
    const text = await (await handleToolCall(
      { name: 'vyora_gmail_send', account_id: accountId, arguments: { to: 'a@b.co', body: 'x' } },
      deps(store),
      USER_A,
    )).text();
    expect(text).not.toContain('TRES-SECRET');
  });
});
