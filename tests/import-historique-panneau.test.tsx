// @vitest-environment jsdom
/**
 * Panneau « Historique des imports » — comportement visible.
 *
 * Ce qui est protégé ici :
 *   - un import échoué s'affiche comme échoué, jamais comme terminé ;
 *   - le rapport détaillé n'est demandé QUE s'il y a des erreurs (pas d'appel
 *     inutile) ;
 *   - un refus serveur (42501, autre entreprise) s'affiche au lieu d'un
 *     historique vide qui laisserait croire qu'il n'y a jamais eu d'import ;
 *   - la pagination ne sort pas des bornes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  loadImportHistory: vi.fn(),
  loadImportReport: vi.fn(),
}));

vi.mock('../src/business/importer/history', () => api);

import { ImportHistoryPanel } from '../src/business/importer/ImportHistoryPanel';

const job = (surcharge: Record<string, unknown> = {}) => ({
  id: 'j1',
  createdAt: '2026-11-18T09:30:00.000Z',
  source: 'file',
  reference: 'produits.csv',
  status: 'completed',
  productsCreated: 2,
  productsFailed: 0,
  variantsCreated: 6,
  errorsCount: 0,
  format: 'csv',
  ...surcharge,
});

const page = (surcharge: Record<string, unknown> = {}) => ({
  total: 1, limit: 20, offset: 0, jobs: [job()], ...surcharge,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.loadImportHistory.mockResolvedValue(page());
  api.loadImportReport.mockResolvedValue({ ...job(), failures: [] });
});

afterEach(() => {
  cleanup();
});

describe('liste', () => {
  it('affiche la date, l’origine, le statut et les compteurs', async () => {
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText('produits.csv')).toBeTruthy());
    expect(screen.getByText(/2026/)).toBeTruthy();
    expect(screen.getByText('Terminé')).toBeTruthy();
    expect(screen.getByText(/2 produit/)).toBeTruthy();
  });

  it('affiche « Partiel » quand des lignes ont échoué', async () => {
    api.loadImportHistory.mockResolvedValue(page({
      jobs: [job({ status: 'partial', productsFailed: 1, errorsCount: 2 })],
    }));
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText('Partiel')).toBeTruthy());
    expect(screen.queryByText('Terminé')).toBeNull();
  });

  it('dit quand il n’y a aucun import, sans prétendre à une erreur', async () => {
    api.loadImportHistory.mockResolvedValue(page({ total: 0, jobs: [] }));
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText(/Aucun import/)).toBeTruthy());
  });
});

describe('rapport', () => {
  it('n’interroge pas la base pour un import sans erreur', async () => {
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText('produits.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('produits.csv'));
    await waitFor(() => expect(screen.getByText(/Aucune erreur/)).toBeTruthy());
    expect(api.loadImportReport).not.toHaveBeenCalled();
  });

  it('charge et affiche le détail quand il y a des erreurs', async () => {
    api.loadImportHistory.mockResolvedValue(page({
      jobs: [job({ status: 'partial', errorsCount: 1, productsFailed: 1 })],
    }));
    api.loadImportReport.mockResolvedValue({
      ...job({ status: 'partial', errorsCount: 1 }),
      failures: [{ name: 'Baume', reason: 'prix invalide' }],
    });
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText('produits.csv')).toBeTruthy());
    fireEvent.click(screen.getByText('produits.csv'));

    await waitFor(() => expect(api.loadImportReport).toHaveBeenCalledWith('j1'));
    await waitFor(() => expect(screen.getByText(/Baume : prix invalide/)).toBeTruthy());
  });
});

describe('refus et bornes', () => {
  it('affiche un refus serveur au lieu d’un historique vide', async () => {
    api.loadImportHistory.mockRejectedValue(new Error('Accès refusé à cet espace de travail.'));
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText(/Accès refusé/)).toBeTruthy());
    expect(screen.queryByText(/Aucun import/)).toBeNull();
  });

  it('ne demande pas de page au-delà du total', async () => {
    api.loadImportHistory.mockResolvedValue(page({ total: 1, offset: 0 }));
    render(<ImportHistoryPanel workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText('produits.csv')).toBeTruthy());
    // Une seule ligne sur un total d'une : aucun bouton « Suivant ».
    expect(screen.queryByText('Suivant')).toBeNull();
  });

  it('ne charge rien sans entreprise sélectionnée', async () => {
    render(<ImportHistoryPanel workspaceId={null} />);
    await waitFor(() => expect(screen.getByText(/Aucune entreprise/)).toBeTruthy());
    expect(api.loadImportHistory).not.toHaveBeenCalled();
  });
});
