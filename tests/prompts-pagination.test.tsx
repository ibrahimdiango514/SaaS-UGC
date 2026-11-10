// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Prompts from '../src/pages/Prompts';
import type { PromptTemplate } from '../src/lib/types';

const mocks = vi.hoisted(() => ({
  listPrompts: vi.fn(),
  createPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  improvePrompt: vi.fn(),
  updatePrompt: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('../src/lib/api', () => ({
  listPrompts: mocks.listPrompts,
  createPrompt: mocks.createPrompt,
  deletePrompt: mocks.deletePrompt,
  improvePrompt: mocks.improvePrompt,
  updatePrompt: mocks.updatePrompt,
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, workspaceId: 'workspace-1', refreshQuota: vi.fn() }),
}));

vi.mock('../src/context/ToastContext', () => ({
  useToast: () => mocks.toast,
}));

function prompt(index: number, category: PromptTemplate['category'] = 'script'): PromptTemplate {
  return {
    id: `prompt-${index}`,
    workspace_id: 'workspace-1',
    created_by: 'user-1',
    title: `Modèle ${category} ${index}`,
    category,
    content: `Contenu ${index}`,
    variables: [],
    is_system: false,
    is_favorite: false,
    usage_count: 0,
    created_at: new Date(Date.UTC(2026, 0, index)).toISOString(),
    updated_at: new Date(Date.UTC(2026, 0, index)).toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPrompts.mockImplementation(async (category?: PromptTemplate['category'], _limit?: number, offset = 0) => {
    if (category === 'hook') return offset === 0
      ? Array.from({ length: 25 }, (_, index) => prompt(index + 1, 'hook'))
      : [prompt(25, 'hook'), prompt(26, 'hook')];
    if (category) return [];
    return Array.from({ length: 25 }, (_, index) => prompt(index + 1));
  });
});

afterEach(cleanup);

describe('Pagination et filtre Supabase des prompts', () => {
  it('applique le filtre de catégorie côté Supabase et pagine sans plafond fixe', async () => {
    render(<Prompts />);
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(24);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filtrer par catégorie' }), {
      target: { value: 'hook' },
    });
    await waitFor(() => expect(mocks.listPrompts).toHaveBeenLastCalledWith('hook', 25));
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(24);

    fireEvent.click(screen.getByRole('button', { name: 'Charger plus de prompts' }));
    await waitFor(() => expect(mocks.listPrompts).toHaveBeenLastCalledWith('hook', 25, 24));
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(26);
    expect(screen.getByText('Modèle hook 26')).toBeTruthy();
  });

  it('ne présente pas une erreur de chargement comme une bibliothèque de prompts vide', async () => {
    mocks.listPrompts.mockRejectedValueOnce(new Error('Prompts indisponibles'));
    render(<Prompts />);

    expect(await screen.findByText('Prompts indisponibles')).toBeTruthy();
    expect(screen.queryByText('Aucun prompt')).toBeNull();
  });
});
