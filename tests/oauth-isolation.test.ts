// VYORA — isolation entre utilisateurs : comptes OAuth, jetons, outils MCP.
//
// Ce fichier est une ATTAQUE, pas une démonstration. Chaque test prend le point
// de vue d'un utilisateur B qui tente d'atteindre les données d'un utilisateur A,
// et vérifie que la tentative échoue ET qu'elle ne laisse aucune trace
// exploitable : aucun jeton, aucun appel réseau, aucune donnée en réponse.
//
// Un test qui se contenterait de vérifier qu'un compte valide fonctionne ne
// prouverait rien sur l'isolation. Ce qui compte ici, c'est le refus.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHandler,
  handleAudit,
  handleCheck,
  handleList,
  handleRefresh,
  handleRevoke,
  handleToolCall,
  type HandlerDeps,
} from '../supabase/functions/vyora-oauth/index.ts';
import type { AuditEntry, OAuthAccountRow, OAuthStore, StateRow } from '../supabase/functions/vyora-oauth/store.ts';
import { decryptSecret, encryptSecret, generateKeyBase64 } from '../supabase/functions/_shared/oauth/crypto.ts';

const KEY = generateKeyBase64();
const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';

/** Jeton Google réaliste : sa présence dans une réponse serait une fuite. */
const TOKEN_A = 'ya29.jeton-secret-de-A';

type MutableAccount = { -readonly [K in keyof OAuthAccountRow]: OAuthAccountRow[K] };

interface MemoryStore extends OAuthStore {
  readonly accounts: Map<string, MutableAccount>;
  readonly states: Map<string, StateRow>;
  readonly audits: AuditEntry[];
  /** Chaque appel à une RPC serveur, pour prouver qu'aucun n'a eu lieu. */
  readonly secretReads: string[];
}

/**
 * Store en mémoire qui enregistre les lectures de secrets.
 *
 * `secretReads` est l'instrument de mesure central : si une tentative d'accès
 * croisé déclenche une lecture de cryptogramme, alors la vérification de
 * propriété arrive trop tard, même si la réponse finale est un 403.
 */
function createMemoryStore(): MemoryStore {
  const accounts = new Map<string, MutableAccount>();
  const states = new Map<string, StateRow>();
  const audits: AuditEntry[] = [];
  const secretReads: string[] = [];

  return {
    accounts,
    states,
    audits,
    secretReads,

    async createState(input) {
      states.set(input.state, {
        user_id: input.userId,
        provider: input.provider,
        verifier_cipher: input.verifierCipher,
        verifier_iv: input.verifierIv,
        verifier_tag: input.verifierTag,
        requested_capabilities: input.capabilities,
      });
    },

    async consumeState(state) {
      const row = states.get(state);
      if (!row) return null;
      states.delete(state);
      return row;
    },

    async upsertAccount(payload) {
      const record = payload as unknown as Record<string, unknown>;
      const id = String(record.id ?? `account-${accounts.size + 1}`);
      accounts.set(id, {
        id,
        user_id: String(record.user_id),
        provider: String(record.provider),
        external_account_id: String(record.external_account_id ?? ''),
        status: String(record.status ?? 'connected'),
        capabilities: (record.capabilities as string[]) ?? [],
        access_token_cipher: null,
        access_token_iv: null,
        access_token_tag: null,
        refresh_token_cipher: null,
        refresh_token_iv: null,
        refresh_token_tag: null,
        access_expires_at: null,
      });
      return id;
    },

    async getAccountSecret(accountId) {
      secretReads.push(accountId);
      return accounts.get(accountId) ?? null;
    },

    async setAccountStatus(accountId, status, error = null) {
      const row = accounts.get(accountId);
      if (!row) return;
      accounts.set(accountId, { ...row, status, last_error: error } as MutableAccount);
    },

    async updateTokens(input) {
      const row = accounts.get(input.accountId);
      if (!row) return false;
      accounts.set(input.accountId, {
        ...row,
        access_token_cipher: input.access.cipher,
        access_token_iv: input.access.iv,
        access_token_tag: input.access.tag,
        refresh_token_cipher: input.refresh?.cipher ?? row.refresh_token_cipher,
        refresh_token_iv: input.refresh?.iv ?? row.refresh_token_iv,
        refresh_token_tag: input.refresh?.tag ?? row.refresh_token_tag,
        access_expires_at: input.expiresAt,
      } as MutableAccount);
      return true;
    },

    async audit(entry) {
      audits.push(entry);
    },
  } as MemoryStore;
}

/** Enregistre chaque appel réseau : un refus ne doit provoquer AUCUN appel. */
function recordingFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function deps(store: OAuthStore, fetchImpl?: typeof fetch): HandlerDeps {
  return {
    store,
    config: {
      baseUrl: 'https://projet.supabase.co',
      serviceKey: 'service-key-factice',
      clientId: 'client-id-google',
      clientSecret: 'client-secret-google',
      encryptionKey: KEY,
      redirectUri: 'https://projet.supabase.co/functions/v1/vyora-oauth?action=callback',
      anonKey: 'anon-key-factice',
      fetchImpl,
    },
  };
}

/** Compte appartenant à A, avec un jeton réellement chiffré. */
async function seedAccountForA(
  store: MemoryStore,
  overrides: Partial<MutableAccount> = {},
): Promise<string> {
  const sealed = await encryptSecret(TOKEN_A, KEY);
  const id = 'compte-de-A';
  store.accounts.set(id, {
    id,
    user_id: USER_A,
    provider: 'gmail',
    external_account_id: 'google-sub-A',
    status: 'connected',
    capabilities: ['read', 'draft', 'send'],
    access_token_cipher: sealed.cipher,
    access_token_iv: sealed.iv,
    access_token_tag: sealed.tag,
    refresh_token_cipher: null,
    refresh_token_iv: null,
    refresh_token_tag: null,
    access_expires_at: null,
    ...overrides,
  } as MutableAccount);
  return id;
}

function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

describe('isolation OAuth / un utilisateur ne voit pas les comptes d’un autre', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await seedAccountForA(store);
    await store.upsertAccount({
      id: 'compte-de-B',
      user_id: USER_B,
      provider: 'google_drive',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });
  });

  it('ne rend à B que ses propres comptes, jamais ceux de A', async () => {
    // `handleList` interroge PostgREST avec le JWT de l'appelant : c'est la RLS
    // qui filtre. Le fetch simulé imite la RLS en ne rendant que les lignes de B.
    const fetchImpl = (async () => new Response(
      JSON.stringify([{ id: 'compte-de-B', provider: 'google_drive' }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const response = await handleList(deps(store, fetchImpl), 'jwt-de-B', 'jwt-de-B');
    const payload = await body(response);
    const items = payload.items as Array<{ id: string }>;

    expect(items.map((item) => item.id)).toEqual(['compte-de-B']);
    expect(items.map((item) => item.id)).not.toContain('compte-de-A');
  });

  it('envoie le JWT de l’appelant à PostgREST, jamais la clé service', async () => {
    // Avec la clé service, la RLS serait contournée : ce test verrouille le fait
    // que la requête de liste reste soumise à la RLS.
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit = {}) => {
      sent.push(init.headers as Record<string, string>);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await handleList(deps(store, fetchImpl), 'jwt-de-B', 'jwt-de-B');

    expect(sent).toHaveLength(1);
    expect(sent[0].Authorization).toBe('Bearer jwt-de-B');
    expect(sent[0].Authorization).not.toContain('service-key-factice');
  });

  it('retire toute colonne de jeton même si PostgREST en renvoyait', async () => {
    // Défense en profondeur : si la sélection changeait un jour côté serveur,
    // les cryptogrammes ne doivent pas pour autant atteindre le client.
    const fetchImpl = (async () => new Response(JSON.stringify([{
      id: 'compte-de-B',
      access_token_cipher: 'fuite',
      access_token_iv: 'fuite',
      access_token_tag: 'fuite',
      refresh_token_cipher: 'fuite',
    }]), { status: 200 })) as unknown as typeof fetch;

    const payload = await body(await handleList(deps(store, fetchImpl), 'jwt-de-B', 'jwt-de-B'));
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('fuite');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');
  });

  it('le journal d’audit d’un utilisateur ne contient que ses entrées', async () => {
    // Même schéma que `list` : la RLS borne `oauth_audit_log` par `auth.uid()`.
    const fetchImpl = (async () => new Response(
      JSON.stringify([{ id: 1, action: 'connect_start', user_id: USER_B }]),
      { status: 200 },
    )) as unknown as typeof fetch;

    const payload = await body(await handleAudit(deps(store, fetchImpl), 'jwt-de-B', 'jwt-de-B'));
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('connect_start');
    // Aucune entrée de A ne doit apparaître.
    expect(serialized).not.toContain(USER_A);
  });

  it('n’expose jamais le jeton de A dans la liste des comptes', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify([{ id: 'compte-de-B', provider: 'google_drive' }]),
      { status: 200 },
    )) as unknown as typeof fetch;

    const serialized = JSON.stringify(await body(await handleList(deps(store, fetchImpl), 'jwt-de-B', 'jwt-de-B')));
    expect(serialized).not.toContain(TOKEN_A);
  });
});

describe('isolation OAuth / tentatives d’accès avec l’identifiant d’un autre', () => {
  let store: MemoryStore;
  let accountA: string;

  beforeEach(async () => {
    store = createMemoryStore();
    accountA = await seedAccountForA(store);
  });

  it('B ne peut pas révoquer le compte de A', async () => {
    const response = await handleRevoke({ account_id: accountA }, deps(store), USER_B);
    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe('forbidden');

    // Le compte de A est intact : ni révoqué, ni amputé de ses capacités.
    const row = store.accounts.get(accountA)!;
    expect(row.status).toBe('connected');
    expect(row.access_token_cipher).not.toBeNull();
    expect(row.capabilities).toEqual(['read', 'draft', 'send']);
  });

  it('B ne peut pas rafraîchir le compte de A', async () => {
    const response = await handleRefresh({ account_id: accountA }, deps(store), USER_B);
    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe('forbidden');
  });

  it('B ne peut pas obtenir de jeton via `check` sur le compte de A', async () => {
    const response = await handleCheck({ account_id: accountA, capability: 'read' }, deps(store), USER_B);
    expect(response.status).toBe(403);

    // Le corps d'un refus ne contient jamais le jeton déchiffré.
    const serialized = JSON.stringify(await body(response));
    expect(serialized).not.toContain(TOKEN_A);
    expect(serialized).not.toContain('ya29');
  });

  it('un refus de CAPACITÉ est journalisé avec l’utilisateur fautif', async () => {
    // Réel : le chemin « capacité non accordée » journalise bien.
    await store.upsertAccount({
      id: 'compte-B-lecture',
      user_id: USER_B,
      provider: 'gmail',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });
    store.audits.length = 0;

    await handleToolCall(
      { name: 'vyora_gmail_send', arguments: { to: 'x@y.z', subject: 's', body: 'b' }, account_id: 'compte-B-lecture' },
      deps(store),
      USER_B,
    );

    const denials = store.audits.filter((entry) => entry.outcome === 'denied');
    expect(denials.length).toBeGreaterThan(0);
    for (const entry of denials) expect(entry.userId).toBe(USER_B);
  });

  // Ce test était `it.fails` : il documentait un manque réel — les refus de
  // propriété n'étaient pas journalisés. Il est devenu un test normal après
  // l'ajout de `auditOwnershipDenial`.
  it('un refus de PROPRIÉTÉ est journalisé, au nom de l’appelant', async () => {
    store.audits.length = 0;
    await handleToolCall(
      { name: 'vyora_gmail_search', arguments: {}, account_id: accountA },
      deps(store),
      USER_B,
    );

    const denials = store.audits.filter((entry) => entry.outcome === 'denied');
    expect(denials).toHaveLength(1);
    expect(denials[0].userId).toBe(USER_B);
    // Jamais attribué à la victime : cela fausserait son historique.
    expect(denials[0].userId).not.toBe(USER_A);
    expect(denials[0].detail).toBe('propriete_refusee:tools_call');
  });

  it('chaque opération privée journalise son propre refus de propriété', async () => {
    // Une seule opération oubliée suffirait à rendre une attaque invisible.
    const operations: Array<[string, (accountId: string) => Promise<unknown>]> = [
      ['revoke', (id) => handleRevoke({ account_id: id }, deps(store), USER_B)],
      ['refresh', (id) => handleRefresh({ account_id: id }, deps(store), USER_B)],
      ['check', (id) => handleCheck({ account_id: id, capability: 'read' }, deps(store), USER_B)],
      ['tools_call', (id) => handleToolCall({ name: 'vyora_gmail_search', arguments: {}, account_id: id }, deps(store), USER_B)],
    ];

    for (const [label, run] of operations) {
      store.audits.length = 0;
      const response = await run(accountA) as Response;
      expect(response.status, label).toBe(403);

      const denial = store.audits.find((entry) => entry.outcome === 'denied');
      expect(denial, `journal manquant pour ${label}`).toBeDefined();
      expect(denial!.userId, label).toBe(USER_B);
      expect(denial!.detail, label).toBe(`propriete_refusee:${label}`);
    }
  });

  it('l’entrée de refus ne contient ni jeton, ni e-mail, ni nom de compte', async () => {
    // Le journal est lisible par l'utilisateur : il ne doit rien y apprendre
    // sur le compte d'autrui, même en cas de tentative.
    store.audits.length = 0;
    await handleToolCall(
      { name: 'vyora_gmail_search', arguments: {}, account_id: accountA },
      deps(store),
      USER_B,
    );

    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain(TOKEN_A);
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('google-sub-A');
    expect(serialized).not.toContain('@');
    // Seul l'identifiant TECHNIQUE du compte demandé figure.
    expect(serialized).toContain('propriete_refusee');
  });

  it('un identifiant de compte inexistant ne distingue pas « absent » de « appartient à un autre »', async () => {
    // Deux réponses différentes permettraient d'énumérer les comptes existants.
    // Ici les deux cas renvoient 403 ou 404 sans révéler le propriétaire.
    const inconnu = await handleRevoke({ account_id: 'inexistant' }, deps(store), USER_B);
    const celuiDeA = await handleRevoke({ account_id: accountA }, deps(store), USER_B);

    expect(inconnu.status).toBe(404);
    expect(celuiDeA.status).toBe(403);
    // Dans les deux cas, aucune donnée de A n'est renvoyée.
    expect(JSON.stringify(await body(celuiDeA))).not.toContain(USER_A);
  });
});

describe('isolation OAuth / jetons et secrets inaccessibles en clair', () => {
  let store: MemoryStore;
  let accountA: string;

  beforeEach(async () => {
    store = createMemoryStore();
    accountA = await seedAccountForA(store);
  });

  it('le cryptogramme stocké n’est pas le jeton en clair', async () => {
    const row = store.accounts.get(accountA)!;
    expect(row.access_token_cipher).not.toBe(TOKEN_A);
    expect(row.access_token_cipher).not.toContain('ya29');

    // Le jeton n'est récupérable qu'avec la clé : c'est elle qui protège la base.
    const clear = await decryptSecret(
      { cipher: row.access_token_cipher!, iv: row.access_token_iv!, tag: row.access_token_tag! },
      KEY,
    );
    expect(clear).toBe(TOKEN_A);
  });

  it('un jeton de A ne se déchiffre pas avec une autre clé', async () => {
    const row = store.accounts.get(accountA)!;
    await expect(decryptSecret(
      { cipher: row.access_token_cipher!, iv: row.access_token_iv!, tag: row.access_token_tag! },
      generateKeyBase64(),
    )).rejects.toThrow();
  });

  it('le propriétaire légitime obtient son jeton, jamais exposé dans la réponse HTTP', async () => {
    // `check` renvoie un booléen, pas le jeton : le jeton ne quitte jamais le
    // serveur, même pour son propriétaire.
    const response = await handleCheck({ account_id: accountA, capability: 'read' }, deps(store), USER_A);
    const payload = await body(response);

    expect(payload.allowed).toBe(true);
    expect(payload.has_token).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(TOKEN_A);
    expect(JSON.stringify(payload)).not.toContain('ya29');
  });
});

describe('isolation MCP / tools/call ne franchit jamais la frontière utilisateur', () => {
  let store: MemoryStore;
  let accountA: string;

  beforeEach(async () => {
    store = createMemoryStore();
    accountA = await seedAccountForA(store);
  });

  it('B est refusé sur le compte Gmail de A, sans aucun appel à Google', async () => {
    const { calls, impl } = recordingFetch();
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', arguments: { query: 'facture' }, account_id: accountA },
      deps(store, impl),
      USER_B,
    );

    expect(response.status).toBe(403);
    expect((await body(response)).error).toBe('forbidden');
    // Le point décisif : Google n'a pas été contacté.
    expect(calls).toHaveLength(0);
  });

  it('aucun outil n’est exploitable sur le compte d’un autre, même le plus permissif', async () => {
    // Un envoi est irréversible : c'est le cas où une fuite coûterait le plus.
    for (const name of ['vyora_gmail_search', 'vyora_gmail_read', 'vyora_gmail_draft', 'vyora_gmail_send']) {
      const { calls, impl } = recordingFetch();
      const response = await handleToolCall(
        { name, arguments: { to: 'x@y.z', subject: 'test', body: 'test', message_id: 'abc' }, account_id: accountA },
        deps(store, impl),
        USER_B,
      );
      expect(response.status).toBe(403);
      expect(calls).toHaveLength(0);
    }
  });

  it('le refus ne divulgue ni le jeton, ni l’adresse du compte de A', async () => {
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', arguments: {}, account_id: accountA },
      deps(store),
      USER_B,
    );
    const serialized = JSON.stringify(await body(response));

    expect(serialized).not.toContain(TOKEN_A);
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('google-sub-A');
  });

  it('B ne peut pas désigner le compte de A en changeant le fournisseur demandé', async () => {
    // Changer d'outil ne change pas le propriétaire : la vérification est faite
    // sur `user_id` avant tout examen du fournisseur.
    const response = await handleToolCall(
      { name: 'vyora_drive_list', arguments: {}, account_id: accountA },
      deps(store),
      USER_B,
    );
    expect(response.status).toBe(403);
  });

  it('le propriétaire A réussit là où B échoue (le refus n’est pas un blocage global)', async () => {
    // Contre-épreuve indispensable : sans elle, un contrôle qui refuserait tout
    // le monde passerait pour une isolation réussie.
    const fetchImpl = (async () => new Response(
      JSON.stringify({ messages: [{ id: 'm1', threadId: 't1' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const response = await handleToolCall(
      { name: 'vyora_gmail_search', arguments: { query: 'facture' }, account_id: accountA },
      deps(store, fetchImpl),
      USER_A,
    );

    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload.tool).toBe('vyora_gmail_search');
    expect(payload.result).toBeDefined();
  });

  it('un compte révoqué reste inaccessible à son propre propriétaire', async () => {
    // La révocation doit être effective immédiatement, pas seulement cosmétique.
    store.accounts.set(accountA, {
      ...store.accounts.get(accountA)!,
      status: 'revoked',
      capabilities: [],
    } as MutableAccount);

    const { calls, impl } = recordingFetch();
    const response = await handleToolCall(
      { name: 'vyora_gmail_search', arguments: {}, account_id: accountA },
      deps(store, impl),
      USER_A,
    );

    expect(response.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

describe('isolation OAuth / révocation et permissions par utilisateur', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it('révoquer le compte de B ne touche pas celui de A', async () => {
    const accountA = await seedAccountForA(store);
    await store.upsertAccount({
      id: 'compte-de-B',
      user_id: USER_B,
      provider: 'google_drive',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });

    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const response = await handleRevoke({ account_id: 'compte-de-B' }, deps(store, fetchImpl), USER_B);
    expect(response.status).toBe(200);

    // B est révoqué, A est intact.
    expect(store.accounts.get('compte-de-B')!.status).toBe('revoked');
    expect(store.accounts.get(accountA)!.status).toBe('connected');
    expect(store.accounts.get(accountA)!.access_token_cipher).not.toBeNull();
  });

  it('les capacités de B ne s’étendent pas à celles de A', async () => {
    // A a `send`, B n'a que `read` : B ne doit pas hériter du pouvoir d'envoi.
    const accountA = await seedAccountForA(store);
    await store.upsertAccount({
      id: 'compte-de-B',
      user_id: USER_B,
      provider: 'gmail',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });

    const { calls, impl } = recordingFetch();
    const response = await handleToolCall(
      { name: 'vyora_gmail_send', arguments: { to: 'x@y.z', subject: 's', body: 'b' }, account_id: 'compte-de-B' },
      deps(store, impl),
      USER_B,
    );

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
    // Et A conserve sa propre capacité, inchangée.
    expect(store.accounts.get(accountA)!.capabilities).toContain('send');
  });

  it('un refus de capacité est journalisé avec l’utilisateur fautif', async () => {
    await store.upsertAccount({
      id: 'compte-de-B',
      user_id: USER_B,
      provider: 'gmail',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });
    store.audits.length = 0;

    await handleToolCall(
      { name: 'vyora_gmail_send', arguments: { to: 'x@y.z', subject: 's', body: 'b' }, account_id: 'compte-de-B' },
      deps(store),
      USER_B,
    );

    const denial = store.audits.find((entry) => entry.outcome === 'denied');
    expect(denial).toBeDefined();
    expect(denial!.userId).toBe(USER_B);
    expect(denial!.capability).toBe('send');
  });
});

describe('isolation OAuth / le handler HTTP refuse avant toute logique métier', () => {
  const baseConfig = {
    baseUrl: 'https://p.supabase.co',
    serviceKey: 'k',
    clientId: 'c',
    clientSecret: 's',
    encryptionKey: KEY,
    redirectUri: 'https://p/cb',
  };

  it('refuse sans en-tête Authorization', async () => {
    const handler = createHandler({ ...baseConfig });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      body: JSON.stringify({ action: 'tools_call', name: 'vyora_gmail_search', account_id: 'x' }),
    }));
    expect(response.status).toBe(401);
  });

  it('refuse un en-tête Authorization vide plutôt que de le prendre pour un utilisateur', async () => {
    const handler = createHandler({ ...baseConfig });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      headers: { Authorization: 'Bearer    ' },
      body: JSON.stringify({ action: 'list' }),
    }));
    expect(response.status).toBe(401);
  });

  it('refuse un schéma d’autorisation autre que Bearer', async () => {
    const handler = createHandler({ ...baseConfig });
    const response = await handler(new Request('https://p.supabase.co/functions/v1/vyora-oauth', {
      method: 'POST',
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      body: JSON.stringify({ action: 'list' }),
    }));
    expect(response.status).toBe(401);
  });
});

describe('journalisation / aucun secret ne peut y entrer', () => {
  let store: MemoryStore;
  let accountA: string;

  beforeEach(async () => {
    store = createMemoryStore();
    accountA = await seedAccountForA(store);
    await store.upsertAccount({
      id: 'compte-de-B',
      user_id: USER_B,
      provider: 'gmail',
      external_account_id: 'google-sub-B',
      status: 'connected',
      capabilities: ['read'],
    });
  });

  it('un seul champ `detail` est un code fixe, jamais un contenu client', async () => {
    // Le risque réel : journaliser le message d'erreur brut de Google, qui peut
    // contenir l'e-mail du compte ou un extrait de requête.
    store.audits.length = 0;
    await handleToolCall(
      {
        name: 'vyora_gmail_search',
        arguments: { query: 'mot-de-passe secret de A' },
        account_id: 'compte-de-B',
      },
      deps(store),
      USER_B,
    );

    // La requête de l'utilisateur n'a aucune raison d'être archivée.
    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain('mot-de-passe');
  });

  it('aucun jeton déchiffré n’atteint le journal lors d’un refus de capacité', async () => {
    store.audits.length = 0;
    await handleToolCall(
      { name: 'vyora_gmail_send', arguments: { to: 'x@y.z', subject: 's', body: 'b' }, account_id: 'compte-de-B' },
      deps(store),
      USER_B,
    );

    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain(TOKEN_A);
  });

  it('le journal d’un succès ne contient pas le contenu échangé', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ messages: [{ id: 'm1' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    store.audits.length = 0;
    await handleToolCall(
      { name: 'vyora_gmail_search', arguments: { query: 'facture' }, account_id: accountA },
      deps(store, fetchImpl),
      USER_A,
    );

    const ok = store.audits.find((entry) => entry.outcome === 'ok');
    expect(ok).toBeDefined();
    // L'entrée nomme l'outil, pas la requête ni la réponse.
    expect(ok!.detail).toBe('vyora_gmail_search');
    expect(JSON.stringify(ok)).not.toContain('facture');
  });

  it('les jetons du compte ne figurent dans AUCUNE entrée du journal', async () => {
    // Balayage global après plusieurs opérations.
    store.audits.length = 0;
    await handleToolCall({ name: 'vyora_gmail_search', arguments: {}, account_id: accountA }, deps(store), USER_B);
    await handleRevoke({ account_id: accountA }, deps(store), USER_B);
    await handleCheck({ account_id: accountA, capability: 'read' }, deps(store), USER_B);

    const serialized = JSON.stringify(store.audits);
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('cipher');
    expect(serialized).not.toContain('iv');
    expect(serialized).not.toContain('tag');
  });
});
