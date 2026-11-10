// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import History from '../src/pages/History';
import type { GenerationJob } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  listJobs: vi.fn(),
  listLedger: vi.fn(),
  listJobEvents: vi.fn(),
  cancelGeneration: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  refreshQuota: vi.fn(),
}));

vi.mock('../src/lib/api', () => ({
  cancelGeneration: mocks.cancelGeneration,
  listJobEvents: mocks.listJobEvents,
  listJobs: mocks.listJobs,
  listLedger: mocks.listLedger,
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, info: vi.fn(), warning: vi.fn() }),
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ refreshQuota: mocks.refreshQuota }),
}));

const job: GenerationJob = {
  id: 'job-1',
  workspace_id: 'workspace-1',
  project_id: null,
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
  updated_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:01:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listJobs.mockResolvedValue([job]);
  mocks.listLedger.mockResolvedValue([]);
  mocks.listJobEvents.mockResolvedValue([]);
});

afterEach(cleanup);

describe('Événements de production dans l’historique Studio', () => {
  it('distingue une erreur de chargement d’une liste réellement vide et permet de réessayer', async () => {
    mocks.listJobEvents
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockResolvedValueOnce([{
        id: 'event-1',
        event_type: 'provider_completed',
        from_status: 'processing',
        to_status: 'succeeded',
        created_at: '2026-01-01T00:01:00.000Z',
      }]);

    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.click(await screen.findByTitle('Détails'));

    expect((await screen.findByRole('alert')).textContent).toContain('Vous n’avez pas les droits nécessaires pour cette action.');
    expect(screen.queryByText('Aucun événement enregistré.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('provider_completed')).toBeTruthy();
    expect(mocks.listJobEvents).toHaveBeenCalledTimes(2);
  });

  it('indique explicitement quand la base confirme qu’aucun événement n’est enregistré', async () => {
    render(<MemoryRouter><History /></MemoryRouter>);
    fireEvent.click(await screen.findByTitle('Détails'));

    expect(await screen.findByText('Aucun événement enregistré.')).toBeTruthy();
    await waitFor(() => expect(mocks.listJobEvents).toHaveBeenCalledWith('job-1'));
  });
});

describe('Pagination de l’historique Studio', () => {
  it('charge les générations suivantes sans répéter la ligne sentinelle', async () => {
    const jobs = Array.from({ length: 51 }, (_, index) => ({ ...job, id: `job-${index}` }));
    mocks.listJobs.mockImplementation(async (_limit: number, offset: number) => (
      offset === 0 ? jobs : jobs.slice(50)
    ));

    render(<MemoryRouter><History /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTitle('Détails')).toHaveLength(50));
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de générations' }));

    await waitFor(() => expect(screen.getAllByTitle('Détails')).toHaveLength(51));
    expect(mocks.listJobs).toHaveBeenNthCalledWith(1, 51, 0, undefined);
    expect(mocks.listJobs).toHaveBeenNthCalledWith(2, 51, 50, undefined);
    expect(screen.getByRole('button', { name: 'Générations (51)' })).toBeTruthy();
  });

  it('applique le filtre de statut à la requête Supabase', async () => {
    mocks.listJobs.mockImplementation(async (_limit: number, _offset: number, status?: string) => (
      status === 'failed' ? [{ ...job, id: 'failed-job', status: 'failed' }] : [job]
    ));

    render(<MemoryRouter><History /></MemoryRouter>);
    await screen.findByTitle('Détails');
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrer par statut' }), { target: { value: 'failed' } });

    await waitFor(() => expect(mocks.listJobs).toHaveBeenLastCalledWith(51, 0, 'failed'));
    await waitFor(() => expect(screen.getAllByTitle('Détails')).toHaveLength(1));
  });
});
