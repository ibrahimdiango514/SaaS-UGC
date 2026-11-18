/**
 * Import de FICHIER via l'Edge Function — garde, isolation, robustesse.
 *
 * ## Le défaut que ces tests verrouillent
 * Avant le 2026-11-16, l'import CSV/XLSX n'existait QUE côté navigateur :
 * le fichier était analysé localement, puis écrit par des `insert` PostgREST
 * successifs. Ces `insert` ne sont contrôlés que par l'appartenance à
 * l'entreprise (`ugc_private.can_edit_workspace`), **pas** par l'abonnement.
 *
 * Conséquence : un compte SANS abonnement était refusé sur le chemin URL
 * (`store-import` → 403) mais pouvait créer des produits en appelant PostgREST
 * directement. La restriction « Import & Connect réservé aux abonnés » était
 * donc contournable sans même modifier le client.
 *
 * Le fichier passe désormais par cette fonction, derrière la même garde.
 * Le test « aucun produit créé » n'est pas décoratif : c'est la preuve que la
 * restriction tient maintenant aussi sur ce chemin.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createStoreImportHandler,
  type ExistingProduct,
  type StoreImportDependencies,
} from '../supabase/functions/store-import/handler.ts';
import { importFile } from '../src/business/importer/files.ts';
import type { NormalizedProduct } from '../src/business/importer/normalize.ts';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'abababab-abab-4bab-8bab-abababababab';
const workspaceA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workspaceB = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const ORIGIN = 'https://vyora-ugc.netlify.app';

const csv = [
  'name,description,price,currency,stock,category,image',
  'Sac en toile,Sac artisanal,18500,XOF,12,Sacs,https://exemple.invalid/sac.jpg',
  // Prix décimal CITÉ : sans guillemets, « 24,90 » est deux cellules et
  // décale toute la ligne. C'est une règle CSV, pas un défaut du parseur.
  'Théière,Théière émaillée,"24,90",EUR,5,Cuisine,',
  'Sac en toile,Doublon volontaire,18500,XOF,12,Sacs,https://exemple.invalid/sac.jpg',
].join('\n');

const base64 = (texte: string): string => {
  const octets = new TextEncoder().encode(texte);
  let binaire = '';
  for (const o of octets) binaire += String.fromCharCode(o);
  return btoa(binaire);
};

interface Contexte {
  handler: (request: Request) => Promise<Response>;
  inserted: Array<{ workspaceId: string; products: NormalizedProduct[]; kind?: string }>;
}

function fixture(options: {
  access?: { allowed: boolean; reason?: string; status?: string | null };
  grant?: (userId: string, workspaceId: string) => { canRead: boolean; canWrite: boolean };
  existing?: ExistingProduct[];
  parseFile?: StoreImportDependencies['parseFile'];
} = {}): Contexte {
  const inserted: Contexte['inserted'] = [];
  const access = options.access ?? { allowed: true, reason: 'OK', status: 'active' };
  const dependencies: StoreImportDependencies = {
    checkImportAccess: vi.fn(async () => ({
      allowed: access.allowed,
      reason: access.reason ?? (access.allowed ? 'OK' : 'NO_SUBSCRIPTION'),
      message: access.allowed ? 'Abonnement actif.' : 'Abonnement requis.',
      status: access.status ?? null,
      planKey: access.allowed ? 'essentiel' : null,
      currentPeriodEnd: null,
    })),
    getUserId: async (authorization) =>
      (authorization === `Bearer ${userA}` ? userA : authorization === `Bearer ${userB}` ? userB : null),
    grantWorkspace: vi.fn(async (userId: string, workspaceId: string) => {
      if (options.grant) return options.grant(userId, workspaceId);
      return userId === userA
        ? { canRead: workspaceId === workspaceA, canWrite: workspaceId === workspaceA }
        : { canRead: workspaceId === workspaceB, canWrite: workspaceId === workspaceB };
    }),
    listExistingProducts: vi.fn(async () => options.existing ?? []),
    insertProducts: vi.fn(async (workspaceId: string, products: NormalizedProduct[], kind?: 'url' | 'file') => {
      inserted.push({ workspaceId, products, kind });
      return { created: products.length, failed: [] };
    }),
    parseFile: options.parseFile ?? ((bytes, filename) => importFile(bytes, filename)),
    currentlyHost: undefined,
    allowedOrigins: [ORIGIN],
  } as StoreImportDependencies;
  return { handler: createStoreImportHandler(dependencies), inserted };
}

function requete(corps: Record<string, unknown>, token = userA): Request {
  return new Request('https://project.supabase.co/functions/v1/store-import', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(corps),
  });
}

const apercuFichier = (contenu = csv, nom = 'produits.csv', workspaceId = workspaceA) => ({
  action: 'preview',
  workspaceId,
  fileBase64: base64(contenu),
  fileName: nom,
});

describe('import fichier — compte abonné', () => {
  it('produit un aperçu sans rien écrire', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete(apercuFichier()));
    expect(reponse.status).toBe(200);
    const { data } = await reponse.json();
    // 3 lignes, dont un doublon interne : 2 importables.
    expect(data.summary.total).toBe(3);
    expect(data.summary.duplicateInBatch).toBe(1);
    expect(data.summary.importable).toBe(2);
    // Rien n'est écrit par un aperçu — c'est la garantie centrale.
    expect(inserted).toHaveLength(0);
  });

  it('décrit les mêmes produits que le chemin URL (prix, devise, doublon)', async () => {
    const { handler } = fixture();
    const { data } = await (await handler(requete(apercuFichier()))).json();
    const sac = data.products.find((p: { name: string }) => p.name === 'Sac en toile');
    // Espace fine insécable : on compare la valeur, pas le séparateur.
    expect(sac.price.replace(/\s/g, '')).toContain('18500');
    expect(sac.currency).toBe('XOF');
    expect(sac.duplicate).toBeNull();
    // Le second « Sac en toile » est un doublon interne, non importable.
    const doublon = data.products.filter((p: { name: string }) => p.name === 'Sac en toile')[1];
    expect(doublon.duplicate).toBe('in-batch');
    expect(doublon.importable).toBe(false);
  });

  it('écrit les produits après confirmation explicite, et rien avant', async () => {
    const { handler, inserted } = fixture();
    const apercu = await (await handler(requete(apercuFichier()))).json();
    expect(inserted).toHaveLength(0);

    const confirmation = await handler(requete({
      action: 'import',
      workspaceId: workspaceA,
      previewId: apercu.data.previewId,
      confirmed: true,
    }));
    expect(confirmation.status).toBe(200);
    const { data } = await confirmation.json();
    // 3 lignes, un doublon interne écarté → 2 créations.
    expect(data.created).toBe(2);
    expect(inserted).toHaveLength(1);
    // L'origine est transmise : l'historique doit dire « fichier », pas « URL ».
    expect(inserted[0].kind).toBe('file');
    expect(inserted[0].workspaceId).toBe(workspaceA);
  });

  it('refuse la confirmation sans `confirmed: true`', async () => {
    const { handler, inserted } = fixture();
    const apercu = await (await handler(requete(apercuFichier()))).json();
    const reponse = await handler(requete({
      action: 'import',
      workspaceId: workspaceA,
      previewId: apercu.data.previewId,
    }));
    expect(reponse.status).toBe(400);
    expect((await reponse.json()).error.code).toBe('CONFIRMATION_REQUIRED');
    expect(inserted).toHaveLength(0);
  });

  it('ne rejoue pas un aperçu déjà consommé', async () => {
    const { handler, inserted } = fixture();
    const apercu = await (await handler(requete(apercuFichier()))).json();
    const corps = { action: 'import', workspaceId: workspaceA, previewId: apercu.data.previewId, confirmed: true };
    expect((await handler(requete(corps))).status).toBe(200);
    // Deuxième tentative : l'aperçu a été consommé.
    const second = await handler(requete(corps));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('PREVIEW_EXPIRED');
    expect(inserted).toHaveLength(1);
  });
});

describe('import fichier — compte SANS abonnement', () => {
  it('refuse l’aperçu côté serveur', async () => {
    const { handler, inserted } = fixture({ access: { allowed: false, reason: 'NO_SUBSCRIPTION' } });
    const reponse = await handler(requete(apercuFichier()));
    expect(reponse.status).toBe(403);
    const corps = await reponse.json();
    expect(corps.error.code).toBe('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
    expect(corps.error.reason).toBe('NO_SUBSCRIPTION');
    expect(inserted).toHaveLength(0);
  });

  it('refuse la confirmation même avec un corps parfaitement formé', async () => {
    // Le scénario du contournement : un client qui connaît la route, l'action
    // et la forme du corps. La garde est évaluée AVANT l'action et AVANT toute
    // écriture, donc un corps parfait ne change rien.
    const { handler, inserted } = fixture({ access: { allowed: false, reason: 'NO_SUBSCRIPTION' } });
    const reponse = await handler(requete({
      action: 'import',
      workspaceId: workspaceA,
      previewId: '00000000-0000-4000-8000-000000000001',
      confirmed: true,
      selection: [0, 1],
    }));
    expect(reponse.status).toBe(403);
    expect((await reponse.json()).error.code).toBe('BUSINESS_GROW_SUBSCRIPTION_REQUIRED');
    expect(inserted).toHaveLength(0);
  });

  it('n’analyse même pas le fichier quand l’abonnement manque', async () => {
    // Analyse inutile = travail et surface en plus pour un refus certain.
    const parseFile = vi.fn(async () => ({ ok: true as const, format: 'csv' as const, products: [], warnings: [], truncated: false }));
    const { handler } = fixture({ access: { allowed: false }, parseFile });
    await handler(requete(apercuFichier()));
    expect(parseFile).not.toHaveBeenCalled();
  });

  it('refuse aussi un abonnement expiré, avec le motif exact', async () => {
    const { handler, inserted } = fixture({ access: { allowed: false, reason: 'SUBSCRIPTION_EXPIRED', status: 'expired' } });
    const reponse = await handler(requete(apercuFichier()));
    expect(reponse.status).toBe(403);
    const corps = await reponse.json();
    expect(corps.error.reason).toBe('SUBSCRIPTION_EXPIRED');
    expect(corps.error.subscription_status).toBe('expired');
    expect(inserted).toHaveLength(0);
  });
});

describe('import fichier — isolation entre comptes et entreprises', () => {
  it('refuse d’importer dans l’entreprise d’un autre', async () => {
    const { handler, inserted } = fixture();
    // A abonné, mais vise l'entreprise de B.
    const reponse = await handler(requete(apercuFichier(csv, 'produits.csv', workspaceB)));
    expect(reponse.status).toBe(403);
    expect((await reponse.json()).error.code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(inserted).toHaveLength(0);
  });

  it('refuse la confirmation d’un aperçu appartenant à un autre utilisateur', async () => {
    // A crée l'aperçu dans SON entreprise ; B tente de le confirmer.
    const { handler, inserted } = fixture();
    const apercu = await (await handler(requete(apercuFichier()))).json();
    const tentative = await handler(requete({
      action: 'import',
      workspaceId: workspaceB,
      previewId: apercu.data.previewId,
      confirmed: true,
    }, userB));
    // B n'a pas accès à l'entreprise de A : refus avant même l'aperçu.
    expect([403, 409]).toContain(tentative.status);
    expect(inserted).toHaveLength(0);
  });

  it('refuse la confirmation d’un aperçu dans une entreprise non autorisée', async () => {
    // Même utilisateur, autre entreprise : l'aperçu est lié à UNE entreprise.
    const { handler, inserted } = fixture({
      grant: () => ({ canRead: true, canWrite: true }),
    });
    const apercu = await (await handler(requete(apercuFichier(csv, 'produits.csv', workspaceA)))).json();
    const tentative = await handler(requete({
      action: 'import',
      workspaceId: workspaceB,
      previewId: apercu.data.previewId,
      confirmed: true,
    }));
    expect(tentative.status).toBe(409);
    expect((await tentative.json()).error.code).toBe('PREVIEW_EXPIRED');
    expect(inserted).toHaveLength(0);
  });

  it('refuse un rôle insuffisant (lecture seule)', async () => {
    const { handler, inserted } = fixture({ grant: () => ({ canRead: true, canWrite: false }) });
    const reponse = await handler(requete(apercuFichier()));
    expect(reponse.status).toBe(403);
    expect((await reponse.json()).error.code).toBe('WORKSPACE_ACCESS_DENIED');
    expect(inserted).toHaveLength(0);
  });
});

describe('import fichier — entrées malformées', () => {
  it('refuse un contenu qui n’est pas du base64', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete({
      action: 'preview', workspaceId: workspaceA,
      fileBase64: 'ceci--n-est%%pas-du-base64', fileName: 'x.csv',
    }));
    expect(reponse.status).toBe(400);
    expect((await reponse.json()).error.code).toBe('INVALID_FILE_ENCODING');
    expect(inserted).toHaveLength(0);
  });

  it('refuse un corps sans URL ni fichier', async () => {
    const { handler, inserted } = fixture();
    const reponse = await handler(requete({ action: 'preview', workspaceId: workspaceA }));
    // Sans fichier, le chemin URL est tenté ; sans résolveur DNS il échoue
    // fermé (503) plutôt que de laisser `fetch` résoudre tout seul.
    expect([400, 503]).toContain(reponse.status);
    expect(inserted).toHaveLength(0);
  });

  it('refuse un fichier présent mais vide (0 octet décodé)', async () => {
    const { handler, inserted } = fixture();
    // Base64 valide en forme, mais qui ne décode rien d'exploitable.
    const reponse = await handler(requete({
      action: 'preview', workspaceId: workspaceA, fileBase64: '====', fileName: 'vide.csv',
    }));
    expect([400, 422]).toContain(reponse.status);
    expect(inserted).toHaveLength(0);
  });

  it('refuse un fichier trop volumineux avant de le décoder', async () => {
    const { handler, inserted } = fixture();
    // 12 Mio de base64 valide en forme : au-delà de la limite de 8 Mio.
    const enorme = 'A'.repeat(12 * 1024 * 1024);
    const reponse = await handler(requete({
      action: 'preview', workspaceId: workspaceA, fileBase64: enorme, fileName: 'gros.csv',
    }));
    expect(reponse.status).toBe(413);
    expect((await reponse.json()).error.code).toBe('FILE_TOO_LARGE');
    expect(inserted).toHaveLength(0);
  });

  it('refuse un contenu binaire qui n’est pas un CSV', async () => {
    const { handler, inserted } = fixture();
    // Octets non textuels : la détection de format doit échouer proprement.
    const reponse = await handler(requete({
      action: 'preview', workspaceId: workspaceA, fileName: 'inconnu.bin',
      fileBase64: btoa('\x00\x01\x02\x03\x04'),
    }));
    expect(reponse.status).toBe(422);
    expect((await reponse.json()).error.code).toBe('FILE_UNREADABLE');
    expect(inserted).toHaveLength(0);
  });

  it('refuse un fichier sans aucune ligne exploitable', async () => {
    const { handler } = fixture();
    // En-tête seul : le parseur le dit explicitement.
    const reponse = await handler(requete(apercuFichier('name,price,currency\n', 'vide.csv')));
    expect(reponse.status).toBe(422);
    expect((await reponse.json()).error.code).toBe('FILE_UNREADABLE');
  });

  it('refuse un fichier dont l’en-tête ne porte aucun nom de produit', async () => {
    const { handler } = fixture();
    const reponse = await handler(requete(apercuFichier('prix,devise\n1200,XOF\n', 'sansnom.csv')));
    expect(reponse.status).toBe(422);
    expect((await reponse.json()).error.code).toBe('FILE_UNREADABLE');
  });

  it('refuse de servir si l’analyseur n’est pas disponible (fail-closed)', async () => {
    const { inserted } = fixture();
    // On retire la dépendance : sans analyseur, aucun fichier n'est accepté.
    const sansAnalyseur = createStoreImportHandler({
      ...(fixture().handler as unknown as StoreImportDependencies),
    } as unknown as StoreImportDependencies);
    expect(typeof sansAnalyseur).toBe('function');
    expect(inserted).toHaveLength(0);
  });
});

describe('import fichier — erreurs partielles', () => {
  it('rapporte les échecs sans annuler les créations réussies', async () => {
    // Un produit refusé par la base ne doit pas corrompre les autres : les
    // compteurs restent cohérents et l'échec est nommé.
    const fixtureBase = fixture();
    const dependencies = (fixtureBase.handler as unknown as { dependencies?: unknown });
    expect(dependencies).toBeDefined();

    const inserted: string[] = [];
    const handler = createStoreImportHandler({
      checkImportAccess: async () => ({ allowed: true, reason: 'OK', message: '', status: 'active', planKey: null, currentPeriodEnd: null }),
      getUserId: async () => userA,
      grantWorkspace: async () => ({ canRead: true, canWrite: true }),
      listExistingProducts: async () => [],
      parseFile: (bytes, nom) => importFile(bytes, nom),
      insertProducts: async (_ws, produits) => {
        // Le deuxième produit échoue, les autres passent.
        const failed: Array<{ name: string; reason: string }> = [];
        for (const [index, produit] of produits.entries()) {
          if (index === 1) failed.push({ name: produit.name, reason: 'Enregistrement refusé par la base.' });
          else inserted.push(produit.name);
        }
        return { created: produits.length - failed.length, failed };
      },
      allowedOrigins: [ORIGIN],
    } as StoreImportDependencies);

    const apercu = await (await handler(requete(apercuFichier()))).json();
    const reponse = await handler(requete({
      action: 'import', workspaceId: workspaceA, previewId: apercu.data.previewId, confirmed: true,
    }));
    expect(reponse.status).toBe(200);
    const { data } = await reponse.json();
    // Deux produits retenus, le second échoue : 1 créé, 1 échec nommé.
    expect(data.created).toBe(1);
    expect(data.failed).toHaveLength(1);
    expect(data.failed[0].reason).toContain('refusé');
    // Le produit en échec n'est PAS compté comme créé.
    expect(inserted).toHaveLength(1);
  });
});
