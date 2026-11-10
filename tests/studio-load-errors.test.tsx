// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Studio from '../src/pages/Studio';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listScripts: vi.fn(),
  listServices: vi.fn(),
  listVideoModels: vi.fn(),
  listAssets: vi.fn(),
  listJobs: vi.fn(),
  listAvatars: vi.fn(),
  healthCheck: vi.fn(),
  cancelGeneration: vi.fn(),
  createProject: vi.fn(),
  estimateVideo: vi.fn(),
  generateScenes: vi.fn(),
  generateScript: vi.fn(),
  newGenerationIdempotencyKey: vi.fn(() => 'test-idempotency-key'),
  saveScript: vi.fn(),
  saveScenes: vi.fn(),
  startGeneration: vi.fn(),
  videoStart: vi.fn(),
  videoStatus: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/lib/api', () => ({
  cancelGeneration: mocks.cancelGeneration,
  createProject: mocks.createProject,
  estimateVideo: mocks.estimateVideo,
  generateScenes: mocks.generateScenes,
  generateScript: mocks.generateScript,
  listProjects: mocks.listProjects,
  listScripts: mocks.listScripts,
  listServices: mocks.listServices,
  listVideoModels: mocks.listVideoModels,
  listAssets: mocks.listAssets,
  listJobs: mocks.listJobs,
  listAvatars: mocks.listAvatars,
  healthCheck: mocks.healthCheck,
  newGenerationIdempotencyKey: mocks.newGenerationIdempotencyKey,
  saveScript: mocks.saveScript,
  saveScenes: mocks.saveScenes,
  startGeneration: mocks.startGeneration,
  videoStart: mocks.videoStart,
  videoStatus: mocks.videoStatus,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ workspaceId: 'workspace-1', quota: { credits: 10 }, refreshQuota: vi.fn() }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => mocks.toast,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProjects.mockResolvedValue([]);
  mocks.listScripts.mockResolvedValue([]);
  mocks.listServices.mockResolvedValue([]);
  mocks.listVideoModels.mockResolvedValue([]);
  mocks.listAssets.mockResolvedValue([]);
  mocks.listJobs.mockResolvedValue([]);
  mocks.listAvatars.mockResolvedValue([]);
  mocks.healthCheck.mockResolvedValue({ configured: {} });
});

afterEach(cleanup);

describe('Chargement du Video Studio', () => {
  it('affiche une erreur récupérable si le catalogue de modèles ne peut pas être chargé', async () => {
    mocks.listVideoModels.mockRejectedValueOnce(new Error('Catalogue inaccessible'));

    render(<MemoryRouter><Studio /></MemoryRouter>);

    expect(await screen.findByText('Catalogue inaccessible')).toBeTruthy();
  });

  it('ne transforme pas une erreur de chargement des avatars en catalogue vide', async () => {
    mocks.listAvatars.mockRejectedValueOnce(new Error('Avatars inaccessibles'));

    render(<MemoryRouter><Studio /></MemoryRouter>);

    expect(await screen.findByText('Avatars inaccessibles')).toBeTruthy();
  });
});
