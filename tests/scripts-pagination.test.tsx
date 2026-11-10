// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Scripts from '../src/pages/Scripts';
import type { Script } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listScripts: vi.fn(),
  listPrompts: vi.fn(),
  deleteScript: vi.fn(),
  generateHooks: vi.fn(),
  generateScript: vi.fn(),
  saveScenes: vi.fn(),
  saveScript: vi.fn(),
  updateScript: vi.fn(),
  refreshQuota: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/lib/api', () => ({
  listProjects: mocks.listProjects,
  listScripts: mocks.listScripts,
  listPrompts: mocks.listPrompts,
  deleteScript: mocks.deleteScript,
  generateHooks: mocks.generateHooks,
  generateScript: mocks.generateScript,
  saveScenes: mocks.saveScenes,
  saveScript: mocks.saveScript,
  updateScript: mocks.updateScript,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ refreshQuota: mocks.refreshQuota }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => mocks.toast,
}));

function script(index: number): Script {
  return {
    id: `script-${index}`,
    project_id: 'project-1',
    version: 1,
    language: 'fr',
    marketing_angle: null,
    hook: null,
    script_text: `Texte de script ${index}`,
    call_to_action: null,
    claims_to_avoid: [],
    status: 'draft',
    created_by: 'user-1',
    created_at: new Date(Date.UTC(2026, 0, index)).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listProjects.mockResolvedValue([]);
  mocks.listPrompts.mockResolvedValue([]);
  mocks.listScripts.mockImplementation(async (_projectId: string | undefined, _limit: number, offset = 0) => {
    if (offset === 0) return Array.from({ length: 25 }, (_, index) => script(index + 1));
    if (offset === 24) return [script(25), script(26)];
    return [];
  });
});

afterEach(cleanup);

describe('Pagination de la bibliothèque de scripts', () => {
  it('distingue une panne de chargement initial d’une bibliothèque réellement vide et permet de réessayer', async () => {
    mocks.listProjects
      .mockRejectedValueOnce(new Error('Projets indisponibles'))
      .mockResolvedValueOnce([]);

    render(<MemoryRouter><Scripts /></MemoryRouter>);
    expect(await screen.findByText('Projets indisponibles')).toBeTruthy();
    expect(screen.queryByText('Aucun script enregistré')).toBeNull();

    mocks.listScripts.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mes scripts' }));
    expect(await screen.findByText('Aucun script enregistré')).toBeTruthy();
  });

  it('charge les scripts suivants sans plafond fixe ni duplication de frontière', async () => {
    render(<MemoryRouter><Scripts /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Mes scripts' }));

    expect(await screen.findAllByText(/Texte de script/)).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de scripts' }));

    await waitFor(() => expect(mocks.listScripts).toHaveBeenLastCalledWith(undefined, 25, 24));
    expect(await screen.findAllByText(/Texte de script/)).toHaveLength(26);
    expect(screen.getByText('Texte de script 26')).toBeTruthy();
  });

  it('conserve les scripts déjà chargés et permet de réessayer après une erreur de page', async () => {
    mocks.listScripts
      .mockImplementationOnce(async () => Array.from({ length: 25 }, (_, index) => script(index + 1)))
      .mockRejectedValueOnce(new Error('Historique scripts indisponible'))
      .mockResolvedValueOnce([script(25)]);

    render(<MemoryRouter><Scripts /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Mes scripts' }));
    expect(await screen.findAllByText(/Texte de script/)).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de scripts' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Historique scripts indisponible');
    expect(screen.getAllByText(/Texte de script/)).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    await waitFor(() => expect(mocks.listScripts).toHaveBeenLastCalledWith(undefined, 25, 24));
    expect(await screen.findAllByText(/Texte de script/)).toHaveLength(25);
  });
});
