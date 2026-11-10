// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import ProjectDetail from '../src/pages/ProjectDetail';
import type { GenerationJob, Project } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listJobs: vi.fn(),
  listScenes: vi.fn(),
  listScripts: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  refreshQuota: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  deleteProject: mocks.deleteProject,
  getProject: mocks.getProject,
  listJobs: mocks.listJobs,
  listScenes: mocks.listScenes,
  listScripts: mocks.listScripts,
  updateProject: mocks.updateProject,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ refreshQuota: mocks.refreshQuota }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, warning: mocks.warning, info: vi.fn() }),
}));

const project = (id: string, title: string): Project => ({
  id,
  workspace_id: 'workspace-1',
  brand_id: null,
  product_id: null,
  created_by: 'user-1',
  title,
  brief: null,
  campaign_objective: null,
  target_audience: null,
  target_market: null,
  platform: 'TikTok',
  language: 'fr',
  aspect_ratio: '9:16',
  status: 'draft',
  settings: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const job = (id: string): GenerationJob => ({
  id,
  workspace_id: 'workspace-1',
  project_id: 'project-1',
  created_by: 'user-1',
  service_key: 'ugc_video',
  status: 'succeeded',
  request_payload: {},
  result_payload: {},
  provider: 'muapi',
  provider_job_id: null,
  credits_reserved: 2,
  credits_charged: 2,
  error_code: null,
  error_message: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:01:00.000Z',
  completed_at: '2026-01-01T00:01:00.000Z',
});

function NavigationHarness() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/app/projets/project-2')}>Ouvrir autre projet</button>;
}

function renderProjectDetail() {
  return render(
    <MemoryRouter initialEntries={['/app/projets/project-1']}>
      <NavigationHarness />
      <Routes>
        <Route path="/app/projets/:id" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProject.mockImplementation(async (id: string) => project(id, `Projet ${id}`));
  mocks.listJobs.mockResolvedValue([]);
  mocks.listScripts.mockResolvedValue([]);
  mocks.listScenes.mockResolvedValue([]);
});

afterEach(cleanup);

describe('Chargement du détail projet', () => {
  it('ne conserve pas les données d’un projet après navigation vers un autre', async () => {
    let resolveOldProject!: (value: Project) => void;
    mocks.getProject.mockImplementation((id: string) => (
      id === 'project-1'
        ? new Promise<Project>((resolve) => { resolveOldProject = resolve; })
        : Promise.resolve(project(id, 'Projet du nouvel espace'))
    ));

    renderProjectDetail();
    await waitFor(() => expect(mocks.getProject).toHaveBeenCalledWith('project-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir autre projet' }));

    expect(await screen.findByRole('heading', { name: 'Projet du nouvel espace' })).toBeTruthy();
    resolveOldProject(project('project-1', 'Projet précédent'));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Projet précédent' })).toBeNull());
    expect(screen.getByRole('heading', { name: 'Projet du nouvel espace' })).toBeTruthy();
  });

  it('demande uniquement les générations rattachées au projet courant', async () => {
    renderProjectDetail();

    await waitFor(() => expect(mocks.listJobs).toHaveBeenCalledWith(51, 0, undefined, 'project-1'));
  });

  it('charge les générations du projet progressivement sans dupliquer la ligne sentinelle', async () => {
    const jobs = Array.from({ length: 51 }, (_, index) => job(`job-${index}`));
    mocks.listJobs.mockImplementation(async (_limit: number, offset: number) => (
      offset === 0 ? jobs : jobs.slice(50)
    ));

    renderProjectDetail();
    await screen.findByRole('heading', { name: 'Projet project-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Générations (50+)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de générations' }));

    await waitFor(() => {
      const table = screen.getByRole('table');
      expect(within(table).getAllByRole('row')).toHaveLength(52);
    });
    expect(mocks.listJobs).toHaveBeenNthCalledWith(1, 51, 0, undefined, 'project-1');
    expect(mocks.listJobs).toHaveBeenNthCalledWith(2, 51, 50, undefined, 'project-1');
  });

  it('refuse un titre vide avant la mise à jour persistante du projet', async () => {
    renderProjectDetail();
    await screen.findByRole('heading', { name: 'Projet project-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith('Le titre du projet est obligatoire.');
  });

  it('retire les espaces du titre avant de le persister', async () => {
    renderProjectDetail();
    await screen.findByRole('heading', { name: 'Projet project-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: '  Campagne été  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledWith('project-1', expect.objectContaining({
      title: 'Campagne été',
    })));
    expect(mocks.success).toHaveBeenCalledWith('Projet mis à jour.');
  });
});
