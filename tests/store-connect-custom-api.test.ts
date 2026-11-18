/**
 * Actions `probe-custom` et `save-custom` de `store-connect`.
 *
 * Ce qui est vérifié ici n'est pas le confort du formulaire : c'est qu'aucun
 * chemin ne permette d'enregistrer une configuration non testée, que la clé ne
 * ressorte jamais, et que l'adresse contactée soit bien celle validée contre
 * les réseaux internes.
 */
import { describe, expect, it, vi } from 'vitest';
import { handleStoreConnect, type ConnectDependencies } from '../supabase/functions/store-connect/handler.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';

function deps(surcharge: Partial<ConnectDependencies> = {}): ConnectDependencies {
  return {
    getUserId: async () => USER,
    checkImportAccess: async () => ({ allowed: true }),
    grantWorkspace: async () => ({ canRead: true, canWrite: true }),
    storeCredential: vi.fn(async () => 'vault:vyora_custom-api_user'),
    readCredential: async () => null,
    readCredentialRef: async () => null,
    deleteCredential: async () => {},
    recordConnection: vi.fn(async () => ({ connectionId: 'conn-1', status: 'connected' })),
    recordFailure: vi.fn(async () => ({ connectionId: 'conn-1', status: 'error' })),
    readConnection: async () => null,
    resolveHost: async () => ['93.184.216.34'],
    fetchImpl: vi.fn(),
    saveCustomApiConfig: vi.fn(async () => ({ ok: true, connectionId: 'conn-1' })),
    log: () => {},
    ...surcharge,
  } as ConnectDependencies;
}

function requete(corps: Record<string, unknown>): Request {
  return new Request('https://vyora.example/store-connect', {
    method: 'POST',
    headers: { authorization: 'Bearer session', 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId: WORKSPACE, ...corps }),
  });
}

async function appeler(corps: Record<string, unknown>, d: ConnectDependencies) {
  const reponse = await handleStoreConnect(requete(corps), d, { allowedOrigins: ['https://vyora.app'] });
  return { statut: reponse.status, corps: await reponse.json() as Record<string, any> };
}

const CIBLE = {
  baseUrl: 'https://api.boutique.example',
  authScheme: 'bearer',
  productsPath: '/api/products',
  paginationKind: 'page',
  pageSize: 20,
};

const PAGE_VALIDE = new Response(JSON.stringify({
  data: [{ id: 7, name: 'Sac', price: 12000 }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('probe-custom', () => {
  it('lit réellement l’API et rapporte les champs observés', async () => {
    const fetchImpl = vi.fn(async () => PAGE_VALIDE.clone());
    const d = deps({ fetchImpl });
    const { statut, corps } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'cle-secrete-123' }, d);

    expect(statut).toBe(200);
    expect(corps.data.probe.ok).toBe(true);
    expect(corps.data.probe.count).toBe(1);
    expect(corps.data.probe.arrayPath).toBe('data');
    expect(corps.data.probe.sampleFields).toEqual(['id', 'name', 'price']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('range la clé dans Vault et crée la connexion quand la sonde réussit', async () => {
    const storeCredential = vi.fn(async () => 'vault:vyora_custom-api_user');
    const recordConnection = vi.fn(async () => ({ connectionId: 'conn-1', status: 'connected' }));
    const d = deps({ fetchImpl: async () => PAGE_VALIDE.clone(), storeCredential, recordConnection });

    await appeler({ action: 'probe-custom', ...CIBLE, secret: 'cle-secrete-123' }, d);

    expect(storeCredential).toHaveBeenCalledWith({
      userId: USER, connectorKey: 'custom-api', secret: 'cle-secrete-123',
    });
    expect(recordConnection).toHaveBeenCalledTimes(1);
  });

  it('ne renvoie jamais la clé, ni dans la réponse ni dans les journaux', async () => {
    const journaux: string[] = [];
    const d = deps({
      fetchImpl: async () => PAGE_VALIDE.clone(),
      log: (message, detail) => journaux.push(`${message} ${JSON.stringify(detail ?? {})}`),
    });
    const { corps } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'cle-secrete-123' }, d);

    expect(JSON.stringify(corps)).not.toContain('cle-secrete-123');
    expect(journaux.join(' ')).not.toContain('cle-secrete-123');
  });

  it('ne contacte pas une adresse résolue vers un réseau privé', async () => {
    const fetchImpl = vi.fn();
    const d = deps({ fetchImpl, resolveHost: async () => ['10.0.0.7'] });
    const { statut, corps } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'k' }, d);

    expect(statut).toBe(400);
    expect(corps.error.code).toBe('SSRF_BLOCKED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuse une adresse non HTTPS', async () => {
    const d = deps();
    const { statut, corps } = await appeler(
      { action: 'probe-custom', ...CIBLE, baseUrl: 'http://api.boutique.example', secret: 'k' },
      d,
    );
    expect(statut).toBe(400);
    expect(corps.error.code).toBe('INVALID_BASE_URL');
  });

  it('exige une clé quand le schéma en réclame une', async () => {
    const { statut, corps } = await appeler(
      { action: 'probe-custom', ...CIBLE, secret: '', readCredential: async () => null },
      deps(),
    );
    expect(statut).toBe(400);
    expect(corps.error.code).toBe('SECRET_REQUIRED');
  });

  it('complète le chemin sans exiger de syntaxe interne', async () => {
    // L'utilisateur saisit « /api/products » : les marqueurs sont ajoutés.
    let appelee: string | null = null;
    const d = deps({ fetchImpl: async (url: string) => { appelee = url; return PAGE_VALIDE.clone(); } });
    const { statut } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'k' }, d);

    expect(statut).toBe(200);
    // Première page : page=1, pas de curseur.
    expect(appelee).toContain('page=1');
    expect(appelee).not.toContain('{');
  });

  it('refuse un chemin dont les marqueurs contredisent la pagination', async () => {
    const { statut, corps } = await appeler(
      {
        action: 'probe-custom',
        ...CIBLE,
        productsPath: '/api/products?cursor={cursor}',
        paginationKind: 'page',
        secret: 'k',
      },
      deps(),
    );
    expect(statut).toBe(400);
    expect(corps.error.code).toBe('PAGINATION_INCOHERENTE');
  });

  it('ne crée pas de connexion quand la sonde échoue', async () => {
    const recordConnection = vi.fn();
    const d = deps({
      fetchImpl: async () => new Response('{"message":"non"}', { status: 401 }),
      recordConnection,
    });
    const { corps } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'k' }, d);

    expect(corps.data.probe.ok).toBe(false);
    expect(corps.data.probe.code).toBe('unauthorized');
    expect(recordConnection).not.toHaveBeenCalled();
  });

  it('nomme un manque de droits plutôt qu’une panne réseau', async () => {
    const d = deps({ fetchImpl: async () => new Response('{}', { status: 403 }) });
    const { corps } = await appeler({ action: 'probe-custom', ...CIBLE, secret: 'k' }, d);
    expect(corps.data.probe.code).toBe('forbidden');
  });
});

describe('save-custom', () => {
  const pret = { ...CIBLE, secret: 'k', probeStatus: 200, productsFound: 12 };

  it('exige une sonde réussie : sans elle, rien n’est écrit', async () => {
    const saveCustomApiConfig = vi.fn();
    const d = deps({ saveCustomApiConfig });
    const { statut, corps } = await appeler({ action: 'save-custom', ...pret, probeStatus: 0 }, d);

    expect(statut).toBe(400);
    expect(corps.error.code).toBe('PROBE_REQUIRED');
    expect(saveCustomApiConfig).not.toHaveBeenCalled();
  });

  it('refuse un statut de sonde non 2xx', async () => {
    const { statut } = await appeler({ action: 'save-custom', ...pret, probeStatus: 500 }, deps());
    expect(statut).toBe(400);
  });

  it('enregistre et rend l’identifiant de connexion', async () => {
    const d = deps({
      saveCustomApiConfig: vi.fn(async () => ({ ok: true, connectionId: 'conn-42' })),
    });
    const { statut, corps } = await appeler({ action: 'save-custom', ...pret }, d);

    expect(statut).toBe(200);
    expect(corps.data.saved).toBe(true);
    expect(corps.data.connectionId).toBe('conn-42');
  });

  it('transmet la configuration complète, sans jamais la clé', async () => {
    let recu: Record<string, unknown> | null = null;
    const d = deps({
      saveCustomApiConfig: vi.fn(async (input) => { recu = input as unknown as Record<string, unknown>; return { ok: true }; }),
    });
    await appeler({
      action: 'save-custom',
      ...pret,
      mapping: { name: { path: 'title' }, price: { path: 'amount' } },
      priceUnit: 'minor',
      currency: 'xof',
    }, d);

    expect(recu).not.toBeNull();
    expect(JSON.stringify(recu)).not.toContain('"k"');
    expect(recu).toMatchObject({
      baseUrl: 'https://api.boutique.example',
      paginationKind: 'page',
      priceUnit: 'minor',
      currency: 'XOF',
      productsFound: 12,
    });
  });

  it('remonte le code de refus de la base avec un message lisible', async () => {
    const d = deps({
      saveCustomApiConfig: vi.fn(async () => ({
        ok: false,
        code: 'MAPPING_NAME_REQUIRED',
        message: 'Le champ « nom du produit » doit être associé.',
      })),
    });
    const { statut, corps } = await appeler({ action: 'save-custom', ...pret }, d);

    expect(statut).toBe(400);
    expect(corps.error.code).toBe('MAPPING_NAME_REQUIRED');
    expect(corps.error.message).toMatch(/nom du produit/i);
  });

  it('reuse la clé du coffre quand elle n’est pas resaisie', async () => {
    const storeCredential = vi.fn();
    const d = deps({
      storeCredential,
      readCredentialRef: async () => 'vault:vyora_custom-api_user',
    });
    const { statut } = await appeler({ action: 'save-custom', ...pret, secret: '' }, d);

    expect(statut).toBe(200);
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it('exige une clé quand aucune n’existe', async () => {
    const d = deps({ readCredentialRef: async () => null, storeCredential: vi.fn(async () => { throw new Error('x'); }) });
    const { statut, corps } = await appeler(
      { action: 'save-custom', ...pret, secret: '', authScheme: 'none' },
      d,
    );
    // `authScheme: none` : aucune clé n'est requise par le schéma, mais la
    // configuration reste inutilisable sans référence de secret.
    expect(statut).toBe(400);
    expect(corps.error.code).toBe('SECRET_REQUIRED');
  });

  it('exige le droit d’écriture sur l’entreprise', async () => {
    const d = deps({ grantWorkspace: async () => ({ canRead: true, canWrite: false }) });
    const { statut, corps } = await appeler({ action: 'save-custom', ...pret }, d);
    expect(statut).toBe(403);
    expect(corps.error.code).toBe('WORKSPACE_ACCESS_DENIED');
  });

  it('refuse un abonnement inactif avant toute écriture', async () => {
    const saveCustomApiConfig = vi.fn();
    const d = deps({
      checkImportAccess: async () => ({ allowed: false, reason: 'SUBSCRIPTION_EXPIRED', message: 'Abonnement expiré.' }),
      saveCustomApiConfig,
    });
    const { statut } = await appeler({ action: 'save-custom', ...pret }, d);
    expect(statut).toBe(403);
    expect(saveCustomApiConfig).not.toHaveBeenCalled();
  });
});
