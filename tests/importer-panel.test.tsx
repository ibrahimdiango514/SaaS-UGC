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
 *   - l'étape URL explique son indisponibilité au lieu d'offrir un bouton mort.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createProduct: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, createProduct: api.createProduct };
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
});
afterEach(cleanup);

describe('étape 1 — choix de la source', () => {
  it('affiche le dépôt de fichier et les formats acceptés', () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId('store-importer')).toBeTruthy();
    expect(screen.getByText(/Déposez un fichier CSV, XLSX ou XML/i)).toBeTruthy();
  });

  it('explique que l’import par URL n’est pas disponible, sans bouton mort', () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/Importer depuis une URL de boutique/i)).toBeTruthy();
    expect(screen.getByText(/exige une vérification DNS et une protection/i)).toBeTruthy();
    // Aucun bouton d'import par URL : on ne propose pas ce qui échouerait.
    expect(screen.queryByRole('button', { name: /importer depuis une url/i })).toBeNull();
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

    // Le point essentiel : aucune écriture avant confirmation.
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(screen.getByTestId('import-confirm').textContent).toContain('2');
  });

  it('signale un prix manquant comme « à compléter », sans le remplacer par zéro', async () => {
    déposer(fichier('name,price\nSérum,sur-devis', 'c.csv'));
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    expect(screen.getByText('prix à compléter')).toBeTruthy();
    expect(screen.getByText(/1 sans prix/i)).toBeTruthy();
  });

  it('détecte un doublon interne au fichier et l’annonce', async () => {
    déposer(fichier('name,price\nSérum,1000\nSERUM,1000', 'c.csv'));
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    expect(screen.getByText(/1 doublon\(s\) dans le fichier/i)).toBeTruthy();
    expect(screen.getByText(/ne sera pas créé deux fois/i)).toBeTruthy();
  });

  it('détecte un doublon face au catalogue existant', async () => {
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
    déposer(fichier('nimporte quoi sans entete', 'c.csv'));
    await waitFor(() => expect(screen.getByText(/Import impossible/i)).toBeTruthy());
    expect(screen.queryByTestId('import-preview')).toBeNull();
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('un fichier XML avec DOCTYPE est refusé avec un message de sécurité', async () => {
    déposer(fichier('<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><catalog></catalog>', 'flux.xml'));
    await waitFor(() => expect(screen.getByText(/Import impossible/i)).toBeTruthy());
    expect(screen.getByText(/DOCTYPE/i)).toBeTruthy();
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

    expect(api.createProduct).toHaveBeenCalledTimes(2);
    // Le prix part en unité principale, la devise est conservée.
    const premier = api.createProduct.mock.calls[0][0];
    expect(premier.name).toBe('Sérum');
    expect(premier.price_amount).toBe(12000);
    expect(premier.price_currency).toBe('XOF');
    expect(premier.workspace_id).toBe('w');
    expect(onImported).toHaveBeenCalled();
  });

  it('n’écrit pas deux fois un doublon interne au fichier', async () => {
    render(<StoreImportPanel workspaceId="w" existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000\nSERUM,1000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());
    fireEvent.click(screen.getByTestId('import-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(api.createProduct).toHaveBeenCalledTimes(1);
  });

  it('rapporte fidèlement un échec partiel, sans le masquer', async () => {
    api.createProduct
      .mockResolvedValueOnce({ id: 'p-1' })
      .mockRejectedValueOnce(new Error('Quota dépassé'));
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

  it('sans entreprise active, le bouton d’import est inactif', async () => {
    render(<StoreImportPanel workspaceId={null} existing={[]} onImported={vi.fn()} onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fichier('name,price\nSérum,1000', 'c.csv')] } });
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());
    expect((screen.getByTestId('import-confirm') as HTMLButtonElement).disabled).toBe(true);
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
