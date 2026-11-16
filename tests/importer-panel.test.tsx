// @vitest-environment jsdom
/**
 * Panneau d'import — comportement visible.
 *
 * Ce qui est protégé ici n'est pas « le composant s'affiche », mais les
 * promesses faites à l'utilisateur :
 *   - rien n'est écrit avant confirmation ;
 *   - l'aperçu montre les prix, images, catégories et doublons ;
 *   - un import partiel est rapporté fidèlement (créés / échoués) ;
 *   - les doublons internes au fichier ne créent pas de produit en double ;
 *   - **fichier comme URL passent par le serveur** : le navigateur n'écrit plus
 *     dans `ugc_products`, donc l'abonnement ne peut plus être contourné.
 *
 * Les tests ci-dessous simulent l'Edge Function (`invokeEdge`) et non plus un
 * parseur local : c'est bien le contrat serveur qui est vérifié.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createProduct: vi.fn(),
  invokeEdge: vi.fn(),
}));

/** Aperçu serveur minimal, tel que `store-import` le renvoie. */
function apercuServeur(surcharge: Record<string, unknown> = {}) {
  return {
    data: {
      previewId: 'apercu-1',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      summary: { total: 2, importable: 2, duplicateInBatch: 0, duplicateExisting: 0, unpriced: 0 },
      products: [
        { index: 0, name: 'Sérum éclat', price: '12 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: null, importable: true },
        { index: 1, name: 'Baume', price: '4 500 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: null, importable: true },
      ],
      rejected: [],
      warnings: [],
      origin: { kind: 'file', platform: 'unknown', endpoint: 'csv', reference: 'catalogue.csv' },
      connectedTo: '',
      ...surcharge,
    },
  };
}

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, createProduct: api.createProduct, invokeEdge: api.invokeEdge };
});

import { StoreImportPanel } from '../src/business/importer/StoreImportPanel';

/** Construit un File à partir d'une chaîne, comme un dépôt utilisateur. */
function fichier(contenu: string, nom: string): File {
  return new File([contenu], nom, { type: 'text/csv' });
}

function déposer(fichierCsv: File) {
  render(
    <StoreImportPanel
      workspaceId="workspace-1"
      existing={[]}
      onImported={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fichierCsv] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.createProduct.mockResolvedValue({ id: 'p-1' });
  api.invokeEdge.mockImplementation(async (_fn: string, body: { action: string }) => {
    if (body.action === 'preview') return apercuServeur();
    return { data: { created: 2, failed: [] } };
  });
});
afterEach(cleanup);

describe('étape 1 — choix de la source', () => {
  it('affiche le dépôt de fichier et les formats acceptés', () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('store-importer')).toBeTruthy();
    expect(screen.getByText(/Déposez un fichier CSV, XLSX ou XML/i)).toBeTruthy();
  });

  it('propose l’import par URL, exécuté par le serveur', () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Importer depuis une URL de boutique/i)).toBeTruthy();
    // L'explication dit QUI fait la lecture : le serveur, pas le navigateur.
    expect(screen.getByText(/Votre navigateur ne contacte jamais la boutique/i)).toBeTruthy();
    expect(screen.getByTestId('store-url-input')).toBeTruthy();
    expect(screen.getByTestId('store-url-preview')).toBeTruthy();
  });

  it('désactive l’import par URL sans entreprise sélectionnée', () => {
    render(<StoreImportPanel workspaceId={null} existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByTestId('store-url-input') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Sélectionnez une entreprise pour importer/i)).toBeTruthy();
  });
});

describe('étape 2 — aperçu avant écriture', () => {
  it('montre les produits, prix et catégories sans rien écrire', async () => {
    déposer(fichier('name,price,currency,category\nSérum éclat,12000,XOF,Soin\nBaume,4500,XOF,Soin', 'catalogue.csv'));
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());

    const aperçu = screen.getByTestId('import-preview');
    expect(within(aperçu).getByText('Sérum éclat')).toBeTruthy();
    expect(within(aperçu).getByText('Baume')).toBeTruthy();
    expect(screen.getByText(/2 produit\(s\) détecté\(s\)/i)).toBeTruthy();

    // Le point essentiel : aucune écriture avant confirmation, et c'est le
    // SERVEUR qui a produit l'aperçu (pas un parseur local).
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(api.invokeEdge).toHaveBeenCalledTimes(1);
    expect(api.invokeEdge.mock.calls[0][1].action).toBe('preview');
    expect(api.invokeEdge.mock.calls[0][1].fileBase64).toBeTruthy();
    expect(screen.getByTestId('import-confirm').textContent).toContain('2');
  });

  it('signale un prix manquant comme « à compléter », sans le remplacer par zéro', async () => {
    api.invokeEdge.mockResolvedValueOnce(apercuServeur({
      summary: { total: 1, importable: 1, duplicateInBatch: 0, duplicateExisting: 0, unpriced: 1 },
      products: [{ index: 0, name: 'Sérum', price: 'à compléter', currency: 'XOF', productUrl: null, warnings: [], duplicate: null, importable: true }],
    }));
    déposer(fichier('name,price\nSérum,sur-devis', 'c.csv'));
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    // Le serveur rend « à compléter » : l'interface ne substitue pas zéro.
    expect(screen.getByText('à compléter')).toBeTruthy();
    expect(screen.getByText(/1 sans prix/i)).toBeTruthy();
  });

  it('détecte un doublon interne au fichier et l’annonce', async () => {
    api.invokeEdge.mockResolvedValueOnce(apercuServeur({
      summary: { total: 2, importable: 1, duplicateInBatch: 1, duplicateExisting: 0, unpriced: 0 },
      products: [
        { index: 0, name: 'Sérum', price: '1 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: null, importable: true },
        { index: 1, name: 'SERUM', price: '1 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: 'in-batch', importable: false },
      ],
    }));
    déposer(fichier('name,price\nSérum,1000\nSERUM,1000', 'c.csv'));
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    expect(screen.getByText(/1 doublon\(s\) dans la source/i)).toBeTruthy();
    expect(screen.getByText(/ne sera pas créé deux fois/i)).toBeTruthy();
    // Un seul produit importable : le bouton ne promet pas deux écritures.
    expect(screen.getByTestId('import-confirm').textContent).toContain('1');
  });

  it('détecte un doublon face au catalogue existant', async () => {
    api.invokeEdge.mockResolvedValueOnce(apercuServeur({
      summary: { total: 1, importable: 1, duplicateInBatch: 0, duplicateExisting: 1, unpriced: 0 },
      products: [{ index: 0, name: 'Sérum Éclat', price: '1 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: 'existing', importable: true }],
    }));
    render(
      <StoreImportPanel
        workspaceId="w"
        existing={[{ id: 'p-1', name: 'Sérum éclat' }]}
        onImported={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum Éclat,1000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    expect(screen.getByText(/1 déjà dans votre catalogue/i)).toBeTruthy();
    expect(screen.getByText(/sera créé si vous confirmez/i)).toBeTruthy();
  });

  it('un fichier illisible affiche l’erreur sans aperçu trompeur', async () => {
    api.invokeEdge.mockRejectedValueOnce(Object.assign(new Error('Fichier illisible.'), { code: 'FILE_UNREADABLE' }));
    déposer(fichier('nimporte quoi sans entete', 'c.csv'));
    await waitFor(() => expect(screen.getByText(/Fichier illisible/i)).toBeTruthy());
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('un fichier XML avec DOCTYPE est refusé avec un message de sécurité', async () => {
    // Le refus vient du serveur : le navigateur ne fait plus l'analyse, il relaie
    // la raison exacte renvoyée par l'Edge Function.
    api.invokeEdge.mockRejectedValueOnce(
      Object.assign(new Error('DTD interdite.'), { code: 'FILE_UNREADABLE' }),
    );
    déposer(fichier('<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><catalog></catalog>', 'flux.xml'));
    await waitFor(() => expect(screen.getByText(/DTD interdite/i)).toBeTruthy());
    expect(screen.queryByTestId('import-preview')).toBeNull();
  });
});

describe('étape 3 — écriture après confirmation', () => {
  it('crée les produits une seule fois après le clic', async () => {
    const onImported = vi.fn();
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={onImported} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price,currency\nSérum,12000,XOF\nBaume,4500,XOF', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());

    fireEvent.click(screen.getByTestId('import-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());

    // Aucune écriture navigateur : tout passe par l'Edge Function.
    expect(api.createProduct).not.toHaveBeenCalled();
    const écriture = api.invokeEdge.mock.calls.find(([, body]) => body.action === 'import');
    expect(écriture).toBeTruthy();
    expect(écriture![1].workspaceId).toBe('w');
    expect(écriture![1].previewId).toBe('apercu-1');
    expect(onImported).toHaveBeenCalled();
  });

  it('n’écrit pas deux fois un doublon interne au fichier', async () => {
    api.invokeEdge.mockImplementation(async (_fn: string, body: { action: string }) => {
      if (body.action === 'preview') {
        return apercuServeur({
          summary: { total: 2, importable: 1, duplicateInBatch: 1, duplicateExisting: 0, unpriced: 0 },
          products: [
            { index: 0, name: 'Sérum', price: '1 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: null, importable: true },
            { index: 1, name: 'SERUM', price: '1 000 XOF', currency: 'XOF', productUrl: null, warnings: [], duplicate: 'in-batch', importable: false },
          ],
        });
      }
      return { data: { created: 1, failed: [] } };
    });
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000\nSERUM,1000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('import-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    // La sélection envoyée ne contient que les produits importables : le doublon
    // n'est pas transmis du tout, il ne peut donc pas être écrit deux fois.
    const écriture = api.invokeEdge.mock.calls.find(([, body]) => body.action === 'import');
    expect(écriture![1].selection).toHaveLength(1);
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('rapporte fidèlement un échec partiel, sans le masquer', async () => {
    // Le serveur rapporte lui-même l'échec partiel : 1 créé, 1 refusé.
    api.invokeEdge.mockImplementation(async (_fn: string, body: { action: string }) => {
      if (body.action === 'preview') return apercuServeur();
      return { data: { created: 1, failed: [{ name: 'Baume', reason: 'Quota dépassé' }] } };
    });
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000\nBaume,2000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('import-confirm'));

    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    const résultat = screen.getByTestId('import-result');
    expect(résultat.textContent).toContain('1 produit(s) créé(s)');
    expect(résultat.textContent).toContain('1 produit(s) non créé(s)');
    expect(résultat.textContent).toContain('Quota dépassé');
  });

  it('sans entreprise active, aucun envoi au serveur n’est tenté', async () => {
    render(<StoreImportPanel workspaceId={null} existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000', 'c.csv')] } });
    // Le fichier n'est même pas lu : la validation d'entreprise intervient avant,
    // ce qui évite un aller-retour réseau voué à l'échec.
    await waitFor(() => expect(screen.getByText(/Sélectionnez une entreprise avant d’importer/i)).toBeTruthy());
    expect(api.invokeEdge).not.toHaveBeenCalled();
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('permet de changer de source sans conserver l’aperçu', async () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Changer de source/i }));
    await waitFor(() => expect(screen.queryByTestId('import-preview')).toBeNull());
    expect(screen.getByText(/Déposez un fichier CSV/i)).toBeTruthy();
  });
});
