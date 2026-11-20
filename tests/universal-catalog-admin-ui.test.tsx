// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UniversalCatalogSync } from '../src/pages/admin/UniversalCatalogSync';
import { getUniversalCatalogSummary, syncUniversalCatalog, syncUniversalCatalogDetails } from '../src/lib/api';
vi.mock('../src/lib/api', () => ({ getUniversalCatalogSummary: vi.fn(), syncUniversalCatalog: vi.fn(), syncUniversalCatalogDetails: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('synchronisation administrateur', () => {
  it('déclenche la vraie action et présente uniquement le résultat confirmé', async () => {
    vi.mocked(getUniversalCatalogSummary).mockResolvedValue({ models: 861, details_ok: 861, detail_errors: 0, enabled: 0, last_sync: null, categories: {} });
    vi.mocked(syncUniversalCatalog).mockResolvedValue({ scope: 'public', fetched: 861, pages: 1, result: { sync_id: 'sync', total: 861, added: 861, changed: 0, missing: 0 } });
    render(<UniversalCatalogSync />);
    fireEvent.click(screen.getByRole('button', { name: 'Synchroniser le catalogue public' }));
    await waitFor(() => expect(screen.getByText(/861 références reçues/)).toBeTruthy());
    expect(syncUniversalCatalog).toHaveBeenCalledOnce();
    expect(syncUniversalCatalogDetails).not.toHaveBeenCalled();
  });
  it('rend visibles les erreurs sans annoncer de succès', async () => {
    vi.mocked(syncUniversalCatalogDetails).mockRejectedValue(new Error('refusé'));
    render(<UniversalCatalogSync />);
    fireEvent.click(screen.getByRole('button', { name: 'Actualiser 10 fiches' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refusé'));
    expect(screen.queryByText(/enregistrée/)).toBeNull();
  });
});
