// @vitest-environment jsdom
/**
 * Import par URL — parcours serveur, du panneau à l'Edge Function.
 *
 * Ce qui est protégé ici :
 *   - l'aperçu n'appelle JAMAIS l'écriture (ni `createProduct` ni `import`) ;
 *   - la confirmation transmet le `previewId` émis par le serveur ;
 *   - un aperçu expiré ramène à l'étape source avec un message lisible ;
 *   - un refus SSRF du serveur est affiché tel quel, sans produit créé ;
 *   - sans entreprise, rien ne part.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createProduct: vi.fn(),
  invokeEdge: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, createProduct: api.createProduct, invokeEdge: api.invokeEdge };
});

import { StoreImportPanel } from '../src/business/importer/StoreImportPanel';

const apercuServeur = {
  previewId: '11111111-1111-4111-8111-111111111111',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  origin: { kind: 'url', reference: 'https://boutique.example/', platform: 'shopify', endpoint: 'https://boutique.example/products.json' },
  summary: { total: 2, importable: 2, duplicateInBatch: 0, duplicateExisting: 1, withWarnings: 0, priced: 2, unpriced: 0 },
  products: [
    { index: 0, name: 'Sérum Éclat', price: '12 000 F CFA', currency: 'XOF', productUrl: 'https://boutique.example/p/1', warnings: [], duplicate: null, importable: true },
    { index: 1, name: 'Crème Nuit', price: '8 500 F CFA', currency: 'XOF', productUrl: 'https://boutique.example/p/2', warnings: [], duplicate: 'existing', importable: true },
  ],
  rejected: [],
  warnings: ['Aucun produit n’a été créé : cette étape est une prévisualisation.'],
  connectedTo: '203.0.113.10',
};

beforeEach(() => {
  api.createProduct.mockReset();
  api.invokeEdge.mockReset();
});

afterEach(cleanup);

function panneau(workspaceId: string | null = 'w1') {
  return render(<StoreImportPanel workspaceId={workspaceId} existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
}

function saisirUrl(valeur = 'https://boutique.example') {
  fireEvent.change(screen.getByTestId('store-url-input'), { target: { value: valeur } });
}

describe('import par URL — aperçu', () => {
  it('envoie l’URL au serveur et affiche l’aperçu sans rien écrire', async () => {
    api.invokeEdge.mockResolvedValueOnce({ data: apercuServeur });
    panneau();
    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));

    await waitFor(() => expect(screen.getByTestId('store-url-preview-panel')).toBeTruthy());

    expect(api.invokeEdge).toHaveBeenCalledTimes(1);
    const [nom, corps] = api.invokeEdge.mock.calls[0];
    expect(nom).toBe('store-import');
    expect(corps).toMatchObject({ action: 'preview', workspaceId: 'w1', url: 'https://boutique.example' });

    expect(screen.getByText('Sérum Éclat')).toBeTruthy();
    // Le résumé ET la ligne du produit signalent le doublon du catalogue.
    expect(screen.getAllByText(/déjà dans votre catalogue/i).length).toBeGreaterThanOrEqual(1);
    // Aucun produit créé pendant l'aperçu, des deux côtés.
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(api.invokeEdge.mock.calls.some(([nom, corps]) => nom === 'store-import' && corps.action === 'import')).toBe(false);
  });

  it('annonce qu’aucun produit n’a été créé et que l’aperçu expire', async () => {
    api.invokeEdge.mockResolvedValueOnce({ data: apercuServeur });
    panneau();
    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));
    await waitFor(() => expect(screen.getByTestId('store-url-preview-panel')).toBeTruthy());
    expect(screen.getByText(/Aucun produit n’a été créé à cette étape/i)).toBeTruthy();
    expect(screen.getByText(/expire au bout de dix minutes/i)).toBeTruthy();
  });

  it('affiche le refus SSRF du serveur, sans produit créé', async () => {
    const { AppError } = await import('../src/lib/errors');
    api.invokeEdge.mockRejectedValueOnce(new AppError('Cette adresse pointe vers un réseau interne : import refusé.', 'URL_REFUSED'));
    panneau();
    saisirUrl('https://interne.example');
    fireEvent.click(screen.getByTestId('store-url-preview'));

    await waitFor(() => expect(screen.getByText(/réseau interne/i)).toBeTruthy());
    expect(screen.queryByTestId('store-url-preview-panel')).toBeNull();
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('n’envoie rien sans entreprise', async () => {
    panneau(null);
    saisirUrl();
    expect((screen.getByTestId('store-url-input') as HTMLInputElement).disabled).toBe(true);
    expect(api.invokeEdge).not.toHaveBeenCalled();
  });

  it('n’envoie rien avec une URL vide : le bouton reste inactif', () => {
    panneau();
    // Une saisie vide désactive le bouton : pas de requête inutile au serveur.
    expect((screen.getByTestId('store-url-preview') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('store-url-preview'));
    expect(api.invokeEdge).not.toHaveBeenCalled();
  });
});

describe('import par URL — confirmation', () => {
  it('transmet le previewId et le drapeau de confirmation, puis rapporte le décompte', async () => {
    api.invokeEdge
      .mockResolvedValueOnce({ data: apercuServeur })
      .mockResolvedValueOnce({ data: { created: 2, failed: [] } });
    const onImported = vi.fn();
    render(<StoreImportPanel workspaceId="w1" existing={[]} onImported={onImported} onClose={vi.fn()} />);

    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));
    await waitFor(() => expect(screen.getByTestId('store-url-confirm')).toBeTruthy());

    fireEvent.click(screen.getByTestId('store-url-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());

    const [, corps] = api.invokeEdge.mock.calls[1];
    expect(corps).toMatchObject({
      action: 'import',
      workspaceId: 'w1',
      previewId: apercuServeur.previewId,
      confirmed: true,
    });
    // L'écriture est faite par le serveur : le navigateur n'insère rien.
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(screen.getByText(/2 produit\(s\) créé\(s\)/i)).toBeTruthy();
    expect(onImported).toHaveBeenCalled();
  });

  it('rapporte un échec partiel sans le masquer', async () => {
    api.invokeEdge
      .mockResolvedValueOnce({ data: apercuServeur })
      .mockResolvedValueOnce({ data: { created: 1, failed: [{ name: 'Crème Nuit', reason: 'Refusé par la base.' }] } });
    panneau();
    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));
    await waitFor(() => expect(screen.getByTestId('store-url-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('store-url-confirm'));

    await waitFor(() => expect(screen.getByText(/1 produit\(s\) non créé\(s\)/i)).toBeTruthy());
    expect(screen.getByText(/Crème Nuit : Refusé par la base/)).toBeTruthy();
  });

  it('ramène à la source quand l’aperçu a expiré, sans rien créer', async () => {
    const { AppError } = await import('../src/lib/errors');
    api.invokeEdge
      .mockResolvedValueOnce({ data: apercuServeur })
      .mockRejectedValueOnce(new AppError('Aperçu expiré : relancez la prévisualisation.', 'PREVIEW_EXPIRED'));
    panneau();
    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));
    await waitFor(() => expect(screen.getByTestId('store-url-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('store-url-confirm'));

    await waitFor(() => expect(screen.getByText(/Aperçu expiré/i)).toBeTruthy());
    // Retour à l'étape source : l'utilisateur doit relancer un aperçu.
    expect(screen.queryByTestId('store-url-preview-panel')).toBeNull();
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('désactive la confirmation quand aucun produit n’est importable', async () => {
    api.invokeEdge.mockResolvedValueOnce({
      data: {
        ...apercuServeur,
        summary: { ...apercuServeur.summary, importable: 0 },
        products: [{ ...apercuServeur.products[0], importable: false, duplicate: 'in-batch' }],
      },
    });
    panneau();
    saisirUrl();
    fireEvent.click(screen.getByTestId('store-url-preview'));
    await waitFor(() => expect(screen.getByTestId('store-url-confirm')).toBeTruthy());
    expect((screen.getByTestId('store-url-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});
