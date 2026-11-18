import { describe, expect, it, vi } from 'vitest';
import {
  createStoreImportHandler,
  type ExistingProduct,
  type StoreImportDependencies,
} from '../supabase/functions/store-import/handler.ts';
import type { PinnedSocket } from '../supabase/functions/store-import/pinned-fetch.ts';
import type { NormalizedProduct } from '../src/business/importer/normalize.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'abababab-abab-4bab-8bab-abababababab';
const workspaceA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceB = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const ORIGIN = 'https://vyora-ugc.netlify.app';
const STORE = 'https://boutique.example';

/** Page d'accueil Shopify : motif reconnu par `detectPlatform`. */
const shopifyHome = `<html><head>
<script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
<meta name="shopify-checkout-api-token" content="abc">
<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/theme.css">
</head><body>Boutique</body></html>`;

const shopifyCatalog = {
  products: [
    {
      id: 1,
      title: 'Sérum Éclat',
      body_html: '<p>Un sérum.</p>',
      handle: 'serum-eclat',
      vendor: 'VYORA',
      product_type: 'Soin',
      tags: 'visage, éclat',
      variants: [{ id: 11, title: 'Default', price: '12000.00', sku: 'SE-1', available: true }],
    },
    {
      id: 2,
      title: 'Crème Nuit',
      body_html: '<p>Une crème.</p>',
      handle: 'creme-nuit',
      vendor: 'VYORA',
      product_type: 'Soin',
      tags: 'nuit',
      variants: [{ id: 21, title: 'Default', price: '8500.00', sku: 'CN-1', available: true }],
    },
  ],
};

/**
 * Faux socket qui lit la requête écrite puis sert la réponse correspondant au
 * CHEMIN demandé — indispensable : la racine renvoie du HTML, l'endpoint du JSON.
 */
function socketRepondant(servir: (path: string) => string): PinnedSocket & { requetes: string[] } {
  const requetes: string[] = [];
  let octets = new Uint8Array(0);
  let position = 0;
  let pret = false;
  return {
    requetes,
    async write(p: Uint8Array) {
      const texte = new TextDecoder().decode(p);
      requetes.push(texte);
      const ligne = /^GET (\S+) HTTP\//.exec(texte);
      octets = new TextEncoder().encode(servir(ligne?.[1] ?? '/'));
      position = 0;
      pret = true;
      return p.byteLength;
    },
    async read(p: Uint8Array) {
      if (!pret || position >= octets.length) return null;
      const taille = Math.min(p.length, octets.length - position);
      p.set(octets.subarray(position, position + taille));
      position += taille;
      return taille;
    },
    close() {},
  };
}

/** Socket qui sert toujours la même réponse brute (sans lire la requête). */
function socketServing(raw: string): PinnedSocket {
  const octets = new TextEncoder().encode(raw);
  let position = 0;
  return {
    async write() {
      return octets.length;
    },
    async read(p: Uint8Array) {
      if (position >= octets.length) return null;
      const taille = Math.min(p.length, octets.length - position);
      p.set(octets.subarray(position, position + taille));
      position += taille;
      return taille;
    },
    close() {},
  };
}

function httpResponse(corps: string, contentType: string): string {
  return [
    'HTTP/1.1 200 OK',
    `Content-Type: ${contentType}`,
    `Content-Length: ${new TextEncoder().encode(corps).byteLength}`,
    'Connection: close',
    '',
    corps,
  ].join('\r\n');
}

interface Contexte {
  handler: (request: Request) => Promise<Response>;
  inserted: Array<{ workspaceId: string; products: NormalizedProduct[] }>;
  listed: string[];
  granted: Array<{ userId: string; workspaceId: string }>;
  connexions: string[];
}

function fixture(overrides: Partial<StoreImportDependencies> = {}, options: {
  adresses?: Record<string, string[]>;
  existing?: ExistingProduct[];
  grant?: (userId: string, workspaceId: string) => { canRead: boolean; canWrite: boolean };
  now?: () => number;
} = {}): Contexte {
  const inserted: Contexte['inserted'] = [];
  const listed: string[] = [];
  const granted: Contexte['granted'] = [];
  const connexions: string[] = [];
  const adresses = options.adresses ?? { 'boutique.example': ['203.0.113.10'] };

  const dependencies: StoreImportDependencies = {
    // Par défaut, l'utilisateur de test dispose d'un abonnement Business
    // Ground valide : les tests existants portent sur l'import, pas sur
    // l'abonnement. Les tests d'abonnement surchargent cette dépendance.
    checkImportAccess: vi.fn(async () => ({
      allowed: true,
      reason: 'OK',
      message: 'Abonnement Business Ground actif.',
      status: 'active',
      planKey: 'essentiel',
      currentPeriodEnd: null,
    })),
    getUserId: async (authorization) => (authorization === `Bearer ${userA}` ? userA : authorization === `Bearer ${userB}` ? userB : null),
    grantWorkspace: vi.fn(async (userId: string, workspaceId: string) => {
      granted.push({ userId, workspaceId });
      if (options.grant) return options.grant(userId, workspaceId);
      // Chaque utilisateur n'a accès qu'à SON entreprise.
      return userId === userA
        ? { canRead: workspaceId === workspaceA, canWrite: workspaceId === workspaceA }
        : { canRead: workspaceId === workspaceB, canWrite: workspaceId === workspaceB };
    }),
    listExistingProducts: vi.fn(async (workspaceId: string) => {
      listed.push(workspaceId);
      return options.existing ?? [];
    }),
    insertProducts: vi.fn(async (workspaceId: string, products: NormalizedProduct[]) => {
      inserted.push({ workspaceId, products });
      return { created: products.length, failed: [] };
    }),
    resolveHost: async (hostname) => adresses[hostname] ?? [],
    // Connexion simulée : la réponse dépend du chemin réellement demandé.
    connect: async (ip) => {
      connexions.push(ip);
      return socketRepondant((path) =>
        path.startsWith('/products.json') || path.includes('/products?')
          ? httpResponse(JSON.stringify(shopifyCatalog), 'application/json')
          : httpResponse(shopifyHome, 'text/html'),
      );
    },
    now: options.now ?? (() => Date.now()),
    allowedOrigins: [ORIGIN],
    ...overrides,
  };

  return {
    handler: createStoreImportHandler(dependencies),
    inserted,
    listed,
    granted,
    connexions,
  };
}

function requete(body: Record<string, unknown>, options: { authorization?: string; origin?: string | null } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('authorization', options.authorization ?? `Bearer ${userA}`);
  if (options.origin !== null) headers.set('origin', options.origin ?? ORIGIN);
  return new Request('https://project.supabase.co/functions/v1/store-import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspaceId: workspaceA, url: STORE, ...body }),
  });
}

/* -------------------------------------------------------------------------- */
/* Authentification et isolation                                             */
/* -------------------------------------------------------------------------- */

describe('store-import — authentification', () => {
  it('refuse sans JWT', async () => {
    const { handler } = fixture();
    const sansJwt = new Request('https://x.supabase.co/functions/v1/store-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ action: 'preview', workspaceId: workspaceA, url: STORE }),
    });
    const reponse = await handler(sansJwt);
    expect(reponse.status).toBe(401);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('refuse un JWT invalide', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete({ action: 'preview' }, { authorization: 'Bearer inconnu' }));
    expect(reponse.status).toBe(401);
  });

  it('refuse une méthode autre que POST', async () => {
    const { handler } = fixture();
    const reponse = await handler(new Request('https://x.supabase.co/functions/v1/store-import', { method: 'GET', headers: { origin: ORIGIN } }));
    expect(reponse.status).toBe(405);
  });

  it('refuse une origine non autorisée avant toute authentification', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete({ action: 'preview' }, { origin: 'https://attaquant.example' }));
    expect(reponse.status).toBe(403);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'ORIGIN_NOT_ALLOWED' } });
  });

  it('répond au préflight sans exposer de données', async () => {
    const { handler } = fixture();
    const reponse = await handler(
      new Request('https://x.supabase.co/functions/v1/store-import', { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    );
    expect(reponse.status).toBe(204);
    expect(reponse.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await expect(reponse.text()).resolves.toBe('');
  });
});

describe('store-import — isolation entre entreprises', () => {
  it('refuse l’entreprise d’un autre utilisateur', async () => {
    const { handler, inserted, listed } = fixture();
    // userA tente d'importer dans l'entreprise de userB.
    const reponse = await handler(requete({ action: 'preview', workspaceId: workspaceB }));
    expect(reponse.status).toBe(403);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'WORKSPACE_ACCESS_DENIED' } });
    // Aucune lecture de catalogue, aucune écriture.
    expect(listed).toHaveLength(0);
    expect(inserted).toHaveLength(0);
  });

  it('refuse d’écrire avec un rôle insuffisant (lecture seule)', async () => {
    const { handler, inserted } = fixture({}, { grant: () => ({ canRead: true, canWrite: false }) });
    const reponse = await handler(requete({ action: 'preview', workspaceId: workspaceA }));
    expect(reponse.status).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it('refuse un aperçu émis pour un autre utilisateur', async () => {
    const { handler } = fixture();
    const apercu = await handler(requete({ action: 'preview', workspaceId: workspaceA }));
    expect(apercu.status).toBe(200);
    const { data } = (await apercu.json()) as { data: { previewId: string } };
    expect(data.previewId).toBeTruthy();

    // userB tente d'utiliser l'aperçu de userA DANS SON entreprise : refusé,
    // l'aperçu est lié à l'utilisateur ET à l'entreprise qui l'ont créé.
    const vol = await handler(
      requete({ action: 'import', workspaceId: workspaceB, previewId: data.previewId, confirmed: true }, { authorization: `Bearer ${userB}` }),
    );
    expect(vol.status).toBe(409);
    await expect(vol.json()).resolves.toMatchObject({ error: { code: 'PREVIEW_EXPIRED' } });

    // Et userB ne peut pas atteindre l'entreprise de userA du tout.
    const acces = await handler(
      requete({ action: 'preview', workspaceId: workspaceA }, { authorization: `Bearer ${userB}` }),
    );
    expect(acces.status).toBe(403);
  });

  it('refuse un aperçu utilisé dans une autre entreprise du même utilisateur', async () => {
    // Un utilisateur ayant accès à deux entreprises ne peut pas transférer un
    // aperçu de l'une vers l'autre.
    const { handler } = fixture({}, { grant: () => ({ canRead: true, canWrite: true }) });
    const apercu = await handler(requete({ action: 'preview', workspaceId: workspaceA }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };
    const reponse = await handler(
      requete({ action: 'import', workspaceId: workspaceB, previewId: data.previewId, confirmed: true }),
    );
    expect(reponse.status).toBe(409);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'PREVIEW_EXPIRED' } });
  });
});

/* -------------------------------------------------------------------------- */
/* Aperçu : aucune écriture                                                  */
/* -------------------------------------------------------------------------- */

describe('store-import — l’aperçu ne crée jamais de produit', () => {
  it('renvoie un aperçu complet sans appeler l’écriture', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete({ action: 'preview' }));
    expect(reponse.status).toBe(200);

    const { data } = (await reponse.json()) as {
      data: {
        previewId: string;
        summary: { total: number; importable: number };
        products: Array<{ name: string; price: string; duplicate: string | null }>;
        warnings: string[];
        connectedTo: string;
      };
    };

    expect(data.summary.total).toBe(2);
    expect(data.products.map((p) => p.name)).toEqual(['Sérum Éclat', 'Crème Nuit']);
    // Prix formaté en unité majeure : 12 000 F CFA, pas 1 200 000.
    expect(data.products[0].price).toMatch(/^12\s?000/);
    expect(data.products[0].price).not.toContain('1\u202f200\u202f000');
    expect(data.products[0].duplicate).toBeNull();
    expect(data.warnings.join(' ')).toContain('Aucun produit n’a été créé');
    // L'IP contactée est rapportée : preuve du contrôle SSRF.
    expect(data.connectedTo).toBe('203.0.113.10');
    // L'essentiel : aucune écriture.
    expect(inserted).toHaveLength(0);
  });

  it('signale les doublons existants sans rien créer', async () => {
    const { handler, inserted } = fixture({}, { existing: [{ id: 'p1', name: 'sérum éclat' }] });
    const reponse = await handler(requete({ action: 'preview' }));
    const { data } = (await reponse.json()) as {
      data: { products: Array<{ name: string; duplicate: string | null }>; summary: { duplicateExisting: number } };
    };
    expect(data.summary.duplicateExisting).toBe(1);
    expect(data.products[0].duplicate).toBe('existing');
    expect(inserted).toHaveLength(0);
  });

  it('refuse une entreprise valide mais un résolveur DNS absent', async () => {
    const { handler } = fixture({ resolveHost: undefined });
    const reponse = await handler(requete({ action: 'preview' }));
    expect(reponse.status).toBe(503);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'RESOLVER_UNAVAILABLE' } });
  });
});

/* -------------------------------------------------------------------------- */
/* Écriture : confirmation explicite obligatoire                              */
/* -------------------------------------------------------------------------- */

describe('store-import — aucun produit créé avant confirmation', () => {
  it('refuse un import sans confirmation même avec un aperçu valide', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    const reponse = await handler(requete({ action: 'import', previewId: data.previewId }));
    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'CONFIRMATION_REQUIRED' } });
    expect(inserted).toHaveLength(0);
  });

  it('refuse `confirmed: false` et `confirmed: "true"`', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    for (const valeur of [false, 'true', 1]) {
      const reponse = await handler(requete({ action: 'import', previewId: data.previewId, confirmed: valeur }));
      expect(reponse.status).toBe(400);
    }
    expect(inserted).toHaveLength(0);
  });

  it('refuse un import sans aperçu préalable', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete({ action: 'import', confirmed: true }));
    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: { code: 'PREVIEW_REQUIRED' } });
    expect(inserted).toHaveLength(0);
  });

  it('refuse un identifiant d’aperçu inventé', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete({ action: 'import', previewId: 'inventé', confirmed: true }));
    expect(reponse.status).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it('n’écrit qu’après confirmation, dans la bonne entreprise', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    const reponse = await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true }));
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toMatchObject({ data: { created: 2 } });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].workspaceId).toBe(workspaceA);
    expect(inserted[0].products.map((p) => p.name)).toEqual(['Sérum Éclat', 'Crème Nuit']);
  });

  it('ne rejoue pas un aperçu : la confirmation le consomme', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    expect((await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true }))).status).toBe(200);
    // Second essai avec le même aperçu : refusé, pas de double import.
    const second = await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true }));
    expect(second.status).toBe(409);
    expect(inserted).toHaveLength(1);
  });

  it('refuse un aperçu expiré', async () => {
    let horloge = 1_000_000;
    const { handler, inserted } = fixture({}, { now: () => horloge });
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    horloge += 11 * 60 * 1000; // au-delà de 10 minutes
    const reponse = await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true }));
    expect(reponse.status).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it('n’importe que la sélection demandée', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true, selection: [1] }));
    expect(inserted[0].products.map((p) => p.name)).toEqual(['Crème Nuit']);
  });

  it('refuse une sélection hors limites', async () => {
    const { handler, inserted } = fixture();
    const apercu = await handler(requete({ action: 'preview' }));
    const { data } = (await apercu.json()) as { data: { previewId: string } };

    const reponse = await handler(requete({ action: 'import', previewId: data.previewId, confirmed: true, selection: [99] }));
    expect(reponse.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* SSRF via l'Edge Function                                                  */
/* -------------------------------------------------------------------------- */

describe('store-import — refus SSRF de bout en bout', () => {
  it.each([
    ['localhost', 'https://localhost/', { localhost: ['127.0.0.1'] }],
    ['métadonnées cloud', 'https://169.254.169.254/latest/meta-data/', {}],
    ['réseau privé', 'https://interne.example/', { 'interne.example': ['192.168.0.10'] }],
    ['IPv4 mappée', 'https://rebind.example/', { 'rebind.example': ['::ffff:127.0.0.1'] }],
  ])('refuse %s', async (_nom, url, adresses) => {
    const { handler, inserted } = fixture({}, { adresses });
    const reponse = await handler(requete({ action: 'preview', url }));
    expect([400, 403]).toContain(reponse.status);
    expect(inserted).toHaveLength(0);
  });

  it('refuse le schéma HTTP non chiffré', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete({ action: 'preview', url: 'http://boutique.example/' }));
    expect(reponse.status).toBe(400);
  });

  it('refuse un port non standard', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete({ action: 'preview', url: 'https://boutique.example:8443/' }));
    expect(reponse.status).toBe(400);
  });

  it('ne renvoie aucun détail réseau interne dans l’erreur', async () => {
    const { handler } = fixture({}, { adresses: { 'interne.example': ['10.0.0.5'] } });
    const reponse = await handler(requete({ action: 'preview', url: 'https://interne.example/' }));
    const corps = await reponse.text();
    // Le message explique le refus sans révéler l'adresse interne.
    expect(corps).not.toContain('10.0.0.5');
  });

  it('accepte une boutique publique et rapporte l’IP contactée', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete({ action: 'preview' }));
    expect(reponse.status).toBe(200);
    const { data } = (await reponse.json()) as { data: { connectedTo: string } };
    expect(data.connectedTo).toBe('203.0.113.10');
  });
});

/* -------------------------------------------------------------------------- */
/* Plateformes sans catalogue public : message honnête, pas d'invention       */
/* -------------------------------------------------------------------------- */

describe('store-import — plateformes sans catalogue public', () => {
  it('explique l’alternative au lieu d’inventer un catalogue', async () => {
    // Marqueurs réellement reconnus par `detectPlatform` (en-tête Wix).
    const html = '<html><head><script src="https://static.parastorage.com/x.js"></script></head><body>Wix</body></html>';
    const { handler, inserted } = fixture(
      { connect: async () => socketServing(httpResponse(html, 'text/html')) },
      { adresses: { 'wix.example': ['203.0.113.20'] } },
    );
    const reponse = await handler(requete({ action: 'preview', url: 'https://wix.example/' }));
    // Wix est détecté mais n'a pas de catalogue public normalisé.
    expect([422, 502]).toContain(reponse.status);
    const corps = await reponse.text();
    expect(corps).toMatch(/csv|api/i);
    expect(inserted).toHaveLength(0);
  });
});
