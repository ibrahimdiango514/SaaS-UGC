// @vitest-environment jsdom
// VYORA Connect — couche d'accès aux données.
//
// Deux propriétés sont critiques et vérifiées ici :
//   1. l'appel porte le JWT de l'utilisateur, jamais un identifiant fourni par
//      le navigateur : l'isolation est décidée en base par `auth.uid()` ;
//   2. aucun cryptogramme ne remonte vers l'interface, même si la réponse
//      serveur en contenait un jour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const getSession = vi.fn();

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { getSession: (...args: unknown[]) => getSession(...args) },
  },
}));

import {
  ConnectError,
  clearPendingAuthorization,
  fetchAuditEvents,
  fetchConnectedAccounts,
  fetchProviderAvailability,
  humanizeConnectError,
  readPendingAuthorization,
  rememberPendingAuthorization,
  refreshAccount,
  revokeAccount,
  startAuthorization,
} from '../src/integrations/connect-api';

const SESSION = { data: { session: { access_token: 'jwt-utilisateur' } } };

function mockFetch(response: { ok?: boolean; status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: async () => (typeof response.body === 'string' ? response.body : JSON.stringify(response.body)),
    } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(SESSION);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearPendingAuthorization();
});

describe('messages d’erreur', () => {
  it('traduit les codes connus en phrases utiles', () => {
    expect(humanizeConnectError('google_not_configured')).toContain('identifiants Google');
    expect(humanizeConnectError('state_invalid')).toContain('n’est plus valide');
    expect(humanizeConnectError('no_capability_granted')).toContain('Aucune permission');
    expect(humanizeConnectError('forbidden')).toContain('pas accès');
  });

  it('ne divulgue jamais de détail technique pour un code inconnu', () => {
    const message = humanizeConnectError('rpc_failed:oauth_account_secret:500');
    expect(message).toBe('Une erreur est survenue. Réessayez dans un instant.');
    expect(message).not.toContain('oauth_account_secret');
  });

  it('accepte un repli explicite quand il est fourni', () => {
    expect(humanizeConnectError(undefined, 'Message serveur.')).toBe('Message serveur.');
  });
});

describe('disponibilité des fournisseurs', () => {
  it('interroge l’Edge Function, seule source d’autorité', async () => {
    const { calls } = mockFetch({ body: { google: true, encryption_configured: true } });
    const result = await fetchProviderAvailability();
    expect(result).toEqual({ google: true, oauth_function: true, encryption: true });
    expect(calls[0].url).toContain('/functions/v1/vyora-oauth');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: 'status' });
  });

  it('reste pessimiste si le serveur dit non', async () => {
    mockFetch({ body: { google: false, encryption_configured: false } });
    expect(await fetchProviderAvailability()).toEqual({ google: false, oauth_function: true, encryption: false });
  });

  it('reste pessimiste si l’appel échoue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    // Le repli est sûr : un bouton désactivé, jamais un faux bouton actif.
    expect(await fetchProviderAvailability()).toEqual({ google: false, oauth_function: false, encryption: false });
  });

  it('traite google absent comme non configuré', async () => {
    mockFetch({ body: {} });
    expect((await fetchProviderAvailability()).google).toBe(false);
  });

  it('n’envoie jamais de secret au serveur', async () => {
    const { calls } = mockFetch({ body: { google: false } });
    await fetchProviderAvailability();
    const serialized = JSON.stringify(calls[0].init);
    expect(serialized).not.toContain('client_secret');
    expect(serialized).not.toContain('GOOGLE_CLIENT');
  });
});

describe('comptes connectés', () => {
  it('passe par la RPC bornée par auth.uid(), sans identifiant utilisateur', async () => {
    rpc.mockResolvedValue({ data: { items: [] }, error: null });
    await fetchConnectedAccounts();
    expect(rpc).toHaveBeenCalledWith('oauth_list_accounts');
    // Aucun identifiant transmis : la base le déduit du JWT.
    const args = rpc.mock.calls[0][1];
    expect(args).toBeUndefined();
  });

  it('retire tout champ ressemblant à un cryptogramme', async () => {
    rpc.mockResolvedValue({
      data: {
        items: [{
          id: 'acct-1', provider: 'gmail', email: 'a@b.c', capabilities: ['read'], status: 'connected',
          access_token_cipher: 'SECRET-1', refresh_token_cipher: 'SECRET-2',
          access_token_iv: 'IV-1', token_tag: 'TAG-1', client_secret: 'SECRET-3',
        }],
      },
      error: null,
    });
    const accounts = await fetchConnectedAccounts();
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain('SECRET-1');
    expect(serialized).not.toContain('SECRET-2');
    expect(serialized).not.toContain('SECRET-3');
    expect(serialized).not.toContain('IV-1');
    expect(accounts[0].email).toBe('a@b.c');
  });

  it('traduit une erreur base en message utilisateur', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'forbidden', message: 'permission denied for table' } });
    await expect(fetchConnectedAccounts()).rejects.toThrow(ConnectError);
    await expect(fetchConnectedAccounts()).rejects.toThrow(/pas accès/);
  });

  it('renvoie un tableau même si la réponse est malformée', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await fetchConnectedAccounts()).toEqual([]);
  });
});

describe('journal', () => {
  it('borne le nombre d’entrées demandées', async () => {
    rpc.mockResolvedValue({ data: { items: [] }, error: null });
    await fetchAuditEvents(25);
    expect(rpc).toHaveBeenCalledWith('oauth_audit_list', { p_limit: 25 });
  });
});

describe('démarrage d’une autorisation', () => {
  it('transmet le JWT et les capacités demandées', async () => {
    const { calls } = mockFetch({
      body: { authorization_url: 'https://accounts.google.com/x', state: 's', capabilities: ['read'], expires_in: 600 },
    });
    const result = await startAuthorization('gmail', ['read', 'draft']);
    expect(result.authorization_url).toContain('accounts.google.com');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-utilisateur');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      action: 'start', provider: 'gmail', capabilities: ['read', 'draft'],
    });
  });

  it('retombe sur la lecture seule si aucune capacité n’est choisie', async () => {
    const { calls } = mockFetch({ body: { authorization_url: 'https://x', state: 's', capabilities: ['read'], expires_in: 600 } });
    await startAuthorization('gmail', []);
    expect(JSON.parse(String(calls[0].init.body)).capabilities).toEqual(['read']);
  });

  it('lève si la session est absente, sans appeler le réseau', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const impl = vi.fn();
    vi.stubGlobal('fetch', impl);
    await expect(startAuthorization('gmail', ['read'])).rejects.toThrow(/session/);
    expect(impl).not.toHaveBeenCalled();
  });

  it('remonte le code d’erreur du serveur', async () => {
    mockFetch({ ok: false, status: 503, body: { error: 'google_not_configured' } });
    await expect(startAuthorization('gmail', ['read'])).rejects.toMatchObject({
      code: 'google_not_configured',
    });
  });

  it('ne renvoie jamais de jeton dans le résultat', async () => {
    mockFetch({
      body: {
        authorization_url: 'https://accounts.google.com/x', state: 's',
        capabilities: ['read'], expires_in: 600,
        // Le serveur n'en envoie pas, mais on vérifie qu'on ne propagerait pas.
        access_token: 'ya29.SECRET',
      },
    });
    const result = await startAuthorization('gmail', ['read']);
    expect(JSON.stringify(result)).not.toContain('ya29');
  });
});

describe('révocation et rafraîchissement', () => {
  it('révoque en transmettant l’identifiant du compte', async () => {
    const { calls } = mockFetch({ body: { revoked: true, remoteRevoked: true } });
    const result = await revokeAccount('acct-1');
    expect(result).toEqual({ revoked: true, remoteRevoked: true });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: 'revoke', account_id: 'acct-1' });
  });

  it('signale une révocation distante non confirmée', async () => {
    mockFetch({ body: { revoked: true, remoteRevoked: false } });
    expect((await revokeAccount('acct-1')).remoteRevoked).toBe(false);
  });

  it('rafraîchit un compte et ne remonte pas le jeton', async () => {
    const { calls } = mockFetch({ body: { refreshed: true, access_token_length: 120 } });
    const result = await refreshAccount('acct-1');
    expect(result).toEqual({ refreshed: true, access_token_length: 120 });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ action: 'refresh', account_id: 'acct-1' });
    // Le serveur ne renvoie qu'une longueur, jamais le jeton.
    expect(JSON.stringify(result)).not.toContain('ya29');
  });

  it('traduit un refus de révocation en message clair', async () => {
    mockFetch({ ok: false, status: 403, body: { error: 'forbidden' } });
    await expect(revokeAccount('acct-autre')).rejects.toThrow(/pas accès/);
  });
});

describe('aide-mémoire de connexion', () => {
  it('mémorise puis relit l’intention', () => {
    rememberPendingAuthorization({ provider: 'gmail', capabilities: ['read'], startedAt: 123 });
    const intent = readPendingAuthorization();
    expect(intent).toEqual({ provider: 'gmail', capabilities: ['read'], startedAt: 123 });
  });

  it('ignore une valeur corrompue plutôt que de lever', () => {
    sessionStorage.setItem('vyora.connect.pending.v1', '{pas du json');
    expect(readPendingAuthorization()).toBeNull();
  });

  it('ignore une valeur incomplète', () => {
    sessionStorage.setItem('vyora.connect.pending.v1', JSON.stringify({ provider: 'gmail' }));
    expect(readPendingAuthorization()).toBeNull();
  });

  it('se nettoie après lecture', () => {
    rememberPendingAuthorization({ provider: 'gmail', capabilities: [], startedAt: 1 });
    clearPendingAuthorization();
    expect(readPendingAuthorization()).toBeNull();
  });

  it('ne stocke aucun jeton', () => {
    rememberPendingAuthorization({ provider: 'gmail', capabilities: ['read'], startedAt: 1 });
    const raw = sessionStorage.getItem('vyora.connect.pending.v1') ?? '';
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('ya29');
  });
});
