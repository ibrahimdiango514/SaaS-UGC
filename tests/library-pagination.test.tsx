// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Library from '../src/pages/Library';
import type { GeneratedAsset } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listJobs: vi.fn(),
  listProjects: vi.fn(),
  signedStorageUrl: vi.fn(),
  attachAssetToProject: vi.fn(),
  deleteAsset: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  attachAssetToProject: mocks.attachAssetToProject,
  deleteAsset: mocks.deleteAsset,
  listAssets: mocks.listAssets,
  listJobs: mocks.listJobs,
  listProjects: mocks.listProjects,
  signedStorageUrl: mocks.signedStorageUrl,
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, info: vi.fn(), warning: vi.fn() }),
}));

function asset(id: number): GeneratedAsset {
  return {
    id: `asset-${id}`,
    workspace_id: 'workspace-1',
    project_id: null,
    generation_job_id: null,
    created_by: 'user-1',
    asset_type: 'video',
    storage_path: `workspace-1/assets/${id}.mp4`,
    mime_type: 'video/mp4',
    file_size_bytes: 1024,
    metadata: {},
    created_at: new Date(2026, 0, id).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAssets.mockImplementation(async (_limit: number, offset = 0) => {
    if (offset === 0) return Array.from({ length: 25 }, (_, index) => asset(index + 1));
    if (offset === 24) return [asset(25), asset(26)];
    return [];
  });
  mocks.listJobs.mockResolvedValue([]);
  mocks.listProjects.mockResolvedValue([]);
  mocks.signedStorageUrl.mockResolvedValue('https://signed.example/video.mp4');
});

afterEach(cleanup);

describe('Pagination de la bibliothèque privée', () => {
  it('affiche l’échec de chargement des métadonnées au lieu de masquer les créations comme liste vide', async () => {
    mocks.listJobs.mockRejectedValueOnce(new Error('Historique indisponible'));

    render(<MemoryRouter><Library /></MemoryRouter>);

    expect(await screen.findByText('Historique indisponible')).toBeTruthy();
    expect(screen.queryByText('Aucune création')).toBeNull();
  });

  it('charge la suite par plage Supabase sans perdre ou dupliquer la frontière', async () => {
    render(<MemoryRouter><Library /></MemoryRouter>);

    expect(await screen.findAllByText('Vidéo réelle')).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de créations' }));

    await waitFor(() => expect(mocks.listAssets).toHaveBeenLastCalledWith(25, 24));
    expect(await screen.findAllByText('Vidéo réelle')).toHaveLength(26);
    expect(screen.getByText('workspace-1/assets/25.mp4')).toBeTruthy();
    expect(screen.getByText('workspace-1/assets/26.mp4')).toBeTruthy();
  });

  it('préserve les créations déjà chargées et permet de réessayer après une erreur de page', async () => {
    mocks.listAssets
      .mockImplementationOnce(async () => Array.from({ length: 25 }, (_, index) => asset(index + 1)))
      .mockRejectedValueOnce(new Error('Connexion impossible'))
      .mockResolvedValueOnce([asset(25)]);

    render(<MemoryRouter><Library /></MemoryRouter>);
    expect(await screen.findAllByText('Vidéo réelle')).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de créations' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByText('Vidéo réelle')).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    await waitFor(() => expect(mocks.listAssets).toHaveBeenLastCalledWith(25, 24));
    expect(await screen.findAllByText('Vidéo réelle')).toHaveLength(25);
  });
});
