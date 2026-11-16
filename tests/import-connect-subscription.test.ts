/**
 * Import & Connect — accès réservé aux abonnés Business Ground.
 *
 * Ces tests couvrent les dix situations exigées, et surtout celles qui ne se
 * voient pas dans l'interface : un appel direct à l'Edge Function, sans passer
 * par l'écran, avec un corps parfaitement formé.
 *
 * ## Ce qui est prouvé ici
 * La garde s'exécute APRÈS l'identité et AVANT toute action : ni l'entreprise,
 * ni le réseau, ni l'écriture ne sont sollicités pour un non-abonné. Une panne
 * de la vérification ferme l'accès (fail-closed) au lieu de l'ouvrir.
 *
 * ## Ce qui n'est pas prouvé ici
 * La règle SQL elle-même (statuts, périodes, formule retirée) est prouvée en
 * base, cf. migration `20261117090000_import_connect_access.sql`. Ces tests
 * vérifient que le handler ne peut pas contourner son résultat.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createStoreImportHandler,
  type ImportAccess,
  type StoreImportDependencies,
} from '../supabase/functions/store-import/handler.ts';
import type { PinnedSocket } from '../supabase/functions/store-import/pinned-fetch.ts';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'abababab-abab-4bab-8bab-abababababab';
const workspaceA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceB = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const ORIGIN = 'https://vyora-ugc.netlify.app';
const STORE = 'https://boutique.example';

const home = `<html><head>
<script src="https://cdn.shopify.com/s/files/1/theme.js"></script>
<meta name="shopify-checkout-api-token" content="abc">
</head><body>Boutique</body></html>`;

const catalogue = {
  products: [{
    id: 1,
    title: 'Sérum Éclat',
    body_html: '<p>Un sérum.</p>',
    handle: 'serum-eclat',
    vendor: 'VYORA',
    product_type: 'Soin',
    tags: 'visage',
    variants: [{ id: 11, title: 'Default', price: '12000.00', sku: 'SE-1', available: true }],
  }],
};

/** Réponse HTTP brute, telle que la lit `pinned-fetch`. */
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

/**
 * Socket épinglé simulé : lit la ligne de requête, puis sert le chemin
 * demandé. C'est la même mécanique que le test d'origine, reprise à
 * l'identique pour ne pas tester deux choses différentes.
 */
function socketRepondant(servir: (path: string) => string): PinnedSocket {
  let octets = new Uint8Array(0);
  let position = 0;
  let pret = false;
  return {
    async write(p: Uint8Array) {
      const texte = new TextDecoder().decode(p);
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
  } as PinnedSocket;
}

interface Contexte {
  handler: (request: Request) => Promise<Response>;
  inserted: unknown[];
  granted: unknown[];
  connexions: string[];
  accessCalls: string[];
  /** Tout ce qui aurait dû être évité pour un non-abonné. */
  sideEffects: () => { insertions: number; grants: number; connexions: number };
}

function fixture(access: ImportAccess | 'panne', overrides: Partial<StoreImportDependencies> = {}): Contexte {
  const inserted: unknown[] = [];
  const granted: unknown[] = [];
  const connexions: string[] = [];
  const accessCalls: string[] = [];

  const dependencies: StoreImportDependencies = {
    getUserId: async (authorization) => (
      authorization === `Bearer ${userA}` ? userA
        : authorization === `Bearer ${userB}` ? userB : null
    ),
    checkImportAccess: vi.fn(async (userId: string) => {
      accessCalls.push(userId);
      if (access === 'panne') throw new Error('base indisponible');
      return access;
    }),
    grantWorkspace: vi.fn(async (userId: string, workspaceId: string) => {
      granted.push({ userId, workspaceId });
      return userId === userA
        ? { canRead: workspaceId === workspaceA, canWrite: workspaceId === workspaceA }
        : { canRead: workspaceId === workspaceB, canWrite: workspaceId === workspaceB };
    }),
    listExistingProducts: vi.fn(async () => []),
    insertProducts: vi.fn(async (_workspaceId: string, products: unknown[]) => {
      inserted.push(products);
      return { created: products.length, failed: [] };
    }),
    resolveHost: async () => ['203.0.113.10'],
    connect: async (ip) => {
      connexions.push(ip);
      return socketRepondant((chemin) => (
        chemin.includes('products') ? httpResponse(JSON.stringify(catalogue), 'application/json')
          : httpResponse(home, 'text/html')
      ));
    },
    allowedOrigins: [ORIGIN],
    ...overrides,
  };

  return {
    handler: createStoreImportHandler(dependencies),
    inserted,
    granted,
    connexions,
    accessCalls,
    sideEffects: () => ({
      insertions: inserted.length,
      grants: granted.length,
      connexions: connexions.length,
    }),
  };
}

function requete(body: Record<string, unknown>, options: {
  authorization?: string; workspaceId?: string;
} = {}): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: options.authorization ?? `Bearer ${userA}`,
    origin: ORIGIN,
  });
  return new Request('https://project.supabase.co/functions/v1/store-import', {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspaceId: options.workspaceId ?? workspaceA, url: STORE, ...body }),
  });
}

const ACCES_OK: ImportAccess = {
  allowed: true,
  reason: 'OK',
  message: 'Abonnement Business Ground actif.',
  status: 'active',
  planKey: 'essentiel',
  currentPeriodEnd: '2026-12-31T00:00:00.000Z',
};

const refus = (reason: string, message: string, status: string | null): ImportAccess => ({
  allowed: false, reason, message, status, planKey: null, currentPeriodEnd: null,
});

/* -------------------------------------------------------------------------- */
/* 1 à 4 — les états d'abonnement                                             */
/* -------------------------------------------------------------------------- */

describe('Abonnement Business Ground — états', () => {
  it('1. sans abonnement : accès refusé, aucune opération', async () => {
    const ctx = fixture(refus('NO_SUBSCRIPTION', 'Un abonnement Business Ground est requis.', null));
    const res = await ctx.handler(requete({ action: 'preview' }));

    expect(res.status).toBe(403);
    const payload = await res.json() as { error: { code: string; reason: string } };
    expect(payload.error.code).toBe('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
    expect(payload.error.reason).toBe('NO_SUBSCRIPTION');
    // Rien n'a été tenté : ni entreprise, ni réseau, ni écriture.
    expect(ctx.sideEffects()).toEqual({ insertions: 0, grants: 0, connexions: 0 });
  });

  it('2. abonnement expiré : accès refusé', async () => {
    const ctx = fixture(refus('SUBSCRIPTION_EXPIRED', 'L’abonnement a expiré.', 'expired'));
    const res = await ctx.handler(requete({ action: 'import', confirmed: true }));
    expect(res.status).toBe(403);
    expect(ctx.sideEffects()).toEqual({ insertions: 0, grants: 0, connexions: 0 });
  });

  it('3. abonnement suspendu (paiement échoué) : accès refusé', async () => {
    const ctx = fixture(refus('PAYMENT_FAILED', 'Le paiement a échoué.', 'past_due'));
    const res = await ctx.handler(requete({ action: 'preview' }));
    expect(res.status).toBe(403);
    expect(ctx.sideEffects()).toEqual({ insertions: 0, grants: 0, connexions: 0 });
  });

  it('4. abonnement payé et actif : accès autorisé, import réel effectué', async () => {
    const ctx = fixture(ACCES_OK);
    const apercu = await ctx.handler(requete({ action: 'preview' }));
    expect(apercu.status).toBe(200);
    const data = await apercu.json() as { data: { previewId: string; products?: unknown[] } };
    expect(data.data.previewId).toBeTruthy();

    const importation = await ctx.handler(requete({
      action: 'import', confirmed: true, previewId: data.data.previewId,
    }));
    expect(importation.status).toBe(200);
    expect(ctx.inserted.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5 à 8 — contournement et isolation                                         */
/* -------------------------------------------------------------------------- */

describe('Abonnement Business Ground — contournement et isolation', () => {
  it('5. appel direct à l’API sans abonnement : refusé malgré un corps valide', async () => {
    // Cas le plus important : l'utilisateur connaît la route, le format, et
    // n'a pas d'abonnement. Rien ne doit se produire.
    const ctx = fixture(refus('NO_SUBSCRIPTION', 'Souscription requise.', null));
    for (const body of [
      { action: 'preview' },
      { action: 'import', confirmed: true, previewId: 'x' },
    ]) {
      const res = await ctx.handler(requete(body));
      expect(res.status).toBe(403);
    }
    expect(ctx.sideEffects()).toEqual({ insertions: 0, grants: 0, connexions: 0 });
  });

  it('5b. un abonnement prétendu par le client est ignoré', async () => {
    // Le corps contient des champs qui imitent une réponse serveur.
    const ctx = fixture(refus('NO_SUBSCRIPTION', 'Souscription requise.', null));
    const res = await ctx.handler(requete({
      action: 'preview',
      subscription: { status: 'active', is_current: true },
      access: { allowed: true },
      is_subscribed: true,
      plan_key: 'scale',
    }));
    expect(res.status).toBe(403);
    expect(ctx.sideEffects().grants).toBe(0);
  });

  it('6. abonnement qui expire pendant la session : l’opération suivante est refusée', async () => {
    // La première vérification accorde, la seconde refuse : c'est exactement
    // ce que fait une expiration entre deux requêtes. Le handler ne met rien
    // en cache, donc le second appel revérifie.
    let appels = 0;
    const ctx = fixture(ACCES_OK, {
      checkImportAccess: async () => {
        appels += 1;
        return appels === 1 ? ACCES_OK
          : refus('SUBSCRIPTION_EXPIRED', 'L’abonnement a expiré.', 'expired');
      },
    });

    const premier = await ctx.handler(requete({ action: 'preview' }));
    expect(premier.status).toBe(200);

    const second = await ctx.handler(requete({ action: 'preview' }));
    expect(second.status).toBe(403);
    expect(ctx.inserted).toHaveLength(0);
  });

  it('7. utilisateur A sur l’entreprise de B : refusé même avec un abonnement valide', async () => {
    // Un abonnement ne donne jamais accès aux données d'une autre entreprise.
    const ctx = fixture(ACCES_OK);
    const res = await ctx.handler(requete({ action: 'preview' }, { workspaceId: workspaceB }));
    expect(res.status).toBe(403);
    const payload = await res.json() as { error: { code: string } };
    expect(payload.error.code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(ctx.inserted).toHaveLength(0);
  });

  it('7b. utilisateur B n’accède qu’à sa propre entreprise', async () => {
    const ctx = fixture(ACCES_OK);
    const chezLui = await ctx.handler(requete(
      { action: 'preview' }, { authorization: `Bearer ${userB}`, workspaceId: workspaceB },
    ));
    expect(chezLui.status).toBe(200);

    const chezA = await ctx.handler(requete(
      { action: 'preview' }, { authorization: `Bearer ${userB}`, workspaceId: workspaceA },
    ));
    expect(chezA.status).toBe(403);
  });

  it('8. les droits d’un autre utilisateur ne sont jamais interrogés', async () => {
    // La vérification porte sur l'identité établie par GoTrue, jamais sur un
    // identifiant fourni dans le corps.
    const ctx = fixture(ACCES_OK);
    await ctx.handler(requete({
      action: 'preview',
      userId: userB,
      user_id: userB,
      owner_id: userB,
    }));
    expect(ctx.accessCalls).toEqual([userA]);
  });

  it('8b. sans session, la vérification d’abonnement n’est même pas atteinte', async () => {
    const ctx = fixture(ACCES_OK);
    const res = await ctx.handler(requete({ action: 'preview' }, { authorization: 'Bearer invalide' }));
    expect(res.status).toBe(401);
    expect(ctx.accessCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-closed                                                                */
/* -------------------------------------------------------------------------- */

describe('Abonnement Business Ground — panne et fermeture par défaut', () => {
  it('une panne de vérification ferme l’accès (503), elle ne l’ouvre pas', async () => {
    const ctx = fixture('panne');
    const res = await ctx.handler(requete({ action: 'preview' }));
    expect(res.status).toBe(503);
    const payload = await res.json() as { error: { code: string } };
    expect(payload.error.code).toBe('IMPORT_ACCESS_UNAVAILABLE');
    expect(ctx.sideEffects()).toEqual({ insertions: 0, grants: 0, connexions: 0 });
  });

  it('une dépendance absente est traitée comme une panne', async () => {
    // Un déploiement incomplet ne doit pas rouvrir le module.
    const ctx = fixture(ACCES_OK, {
      checkImportAccess: undefined as unknown as StoreImportDependencies['checkImportAccess'],
    });
    const res = await ctx.handler(requete({ action: 'preview' }));
    expect(res.status).toBe(503);
    expect(ctx.inserted).toHaveLength(0);
  });

  it('un résultat ambigu (allowed non booléen) est refusé', async () => {
    const ctx = fixture({ allowed: 'oui' } as unknown as ImportAccess);
    const res = await ctx.handler(requete({ action: 'preview' }));
    expect(res.status).toBe(403);
    expect(ctx.connexions).toHaveLength(0);
  });

  it('le refus ne révèle pas l’existence de l’entreprise', async () => {
    // Même réponse que l'entreprise existe ou non : la vérification
    // d'abonnement passe avant, donc aucun oracle d'existence.
    const ctx = fixture(refus('SUBSCRIPTION_EXPIRED', 'L’abonnement a expiré.', 'expired'));
    const inexistante = await ctx.handler(requete(
      { action: 'preview' },
      { workspaceId: '00000000-0000-4000-8000-000000000000' },
    ));
    const reelle = await ctx.handler(requete({ action: 'preview' }));
    expect(inexistante.status).toBe(reelle.status);
    const a = await inexistante.json() as { error: { code: string } };
    const b = await reelle.json() as { error: { code: string } };
    expect(a.error.code).toBe(b.error.code);
  });

  it('le refus est explicite et transmet l’état réel pour l’interface', async () => {
    const ctx = fixture(refus('PAYMENT_FAILED', 'Le paiement a échoué.', 'past_due'));
    const res = await ctx.handler(requete({ action: 'preview' }));
    const payload = await res.json() as {
      error: { code: string; reason: string; subscription_status: string; message: string };
    };
    expect(payload.error.reason).toBe('PAYMENT_FAILED');
    expect(payload.error.subscription_status).toBe('past_due');
    expect(payload.error.message).toMatch(/paiement/i);
    // La réponse n'est pas mise en cache : elle dépend de l'utilisateur.
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
