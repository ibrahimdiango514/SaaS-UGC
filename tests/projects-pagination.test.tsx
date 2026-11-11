// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Projects from '../src/pages/Projects';
import type { Project } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  refreshQuota: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  createProject: mocks.createProject,
  deleteProject: mocks.deleteProject,
  listProjects: mocks.listProjects,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ refreshQuota: mocks.refreshQuota }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, info: vi.fn(), warning: vi.fn() }),
}));

function project(index: number): Project {
  const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
  return {
    id: `project-${index}`,
    workspace_id: 'workspace-1',
    brand_id: null,
    product_id: null,
    created_by: 'user-1',
    title: `Campagne ${index}`,
    brief: null,
    campaign_objective: null,
    target_audience: null,
    target_market: null,
    platform: 'TikTok',
    language: 'fr',
    aspect_ratio: '9:16',
    status: 'draft',
    settings: {},
    created_at: date,
    updated_at: date,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProjects.mockImplementation(async (_filters: unknown, _limit: number, offset = 0) => {
    if (offset === 0) return Array.from({ length: 25 }, (_, index) => project(index + 1));
    if (offset === 24) return [project(25), project(26)];
    return [];
  });
});

afterEach(cleanup);

describe('Pagination de la liste des projets', () => {
  it('charge les projets suivants sans perdre ni dupliquer la frontière', async () => {
    render(<MemoryRouter><Projects /></MemoryRouter>);

    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de projets' }));

    await waitFor(() => expect(mocks.listProjects).toHaveBeenLastCalledWith({ status: 'all', search: '' }, 25, 24));
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(26);
    expect(screen.getByText('Campagne 25')).toBeTruthy();
    expect(screen.getByText('Campagne 26')).toBeTruthy();
  });

  it('conserve les projets chargés et réessaie une page suivante en erreur', async () => {
    mocks.listProjects
      .mockImplementationOnce(async () => Array.from({ length: 25 }, (_, index) => project(index + 1)))
      .mockRejectedValueOnce(new Error('Connexion impossible'))
      .mockResolvedValueOnce([project(25)]);

    render(<MemoryRouter><Projects /></MemoryRouter>);
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de projets' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    await waitFor(() => expect(mocks.listProjects).toHaveBeenLastCalledWith({ status: 'all', search: '' }, 25, 24));
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(25);
  });

  it('applique recherche et statut côté Supabase dès la première page', async () => {
    mocks.listProjects.mockResolvedValue([]);
    render(<MemoryRouter><Projects /></MemoryRouter>);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Rechercher un projet' }), {
      target: { value: 'lancement' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrer par statut' }), {
      target: { value: 'completed' },
    });

    await waitFor(() => expect(mocks.listProjects).toHaveBeenLastCalledWith({
      status: 'completed',
      search: 'lancement',
    }, 25));
  });

  it('réinitialise les filtres après la création pour rendre le nouveau projet visible dans la liste', async () => {
    mocks.listProjects.mockResolvedValue([]);
    mocks.createProject.mockResolvedValue('project-created');
    render(<MemoryRouter initialEntries={['/app/projets?q=ancien'] }><Projects /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Nouveau projet' }));
    fireEvent.change(screen.getByLabelText('Titre du projet'), { target: { value: 'Nouvelle campagne' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer le projet' }));

    await waitFor(() => expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Nouvelle campagne',
    })));
    await waitFor(() => expect(mocks.listProjects).toHaveBeenLastCalledWith({
      status: 'all',
      search: '',
    }, 25));
  });
});
