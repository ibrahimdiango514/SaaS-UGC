// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import OwnerLogin from '../src/pages/OwnerLogin';
import { signIn, bootstrap, signOut } from '../src/lib/api';

/**
 * Accès propriétaire — contrats de sécurité.
 *
 * L'habillage a changé, pas les règles : une session sans le rôle
 * administrateur est **fermée** (pas seulement ignorée), et aucun message ne
 * laisse croire qu'une promotion est possible depuis l'interface.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../src/lib/api', () => ({
  signIn: vi.fn(async () => ({})),
  bootstrap: vi.fn(async () => ({ is_admin: true, workspace_id: null })),
  signOut: vi.fn(async () => undefined),
}));

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: null, isAdmin: false, loading: false, logout: vi.fn() }),
}));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  navigate.mockReset();
  vi.mocked(signIn).mockClear();
  vi.mocked(bootstrap).mockClear();
  vi.mocked(signOut).mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('connexion administrateur', () => {
  it('ouvre la console quand le serveur confirme le rôle', async () => {
    render(<MemoryRouter><OwnerLogin /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'owner@vyora.app' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'motdepasse123' } });
    fireEvent.click(screen.getByRole('button', { name: /Se connecter/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
    expect(signOut).not.toHaveBeenCalled();
  });

  it('déconnecte immédiatement une session sans rôle administrateur', async () => {
    vi.mocked(bootstrap).mockResolvedValueOnce({ is_admin: false, workspace_id: 'ws-1' } as never);
    render(<MemoryRouter><OwnerLogin /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Adresse e-mail'), { target: { value: 'client@vyora.app' } });
    fireEvent.change(screen.getByLabelText('Mot de passe'), { target: { value: 'motdepasse123' } });
    fireEvent.click(screen.getByRole('button', { name: /Se connecter/i }));

    expect(await screen.findByText('Ce compte ne possède pas le rôle administrateur.')).toBeTruthy();
    // Règle d'accès préservée : la session est fermée, pas simplement ignorée.
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalledWith('/admin', { replace: true });
  });

  it('rappelle que le rôle vient du serveur, jamais de l’interface', () => {
    render(<MemoryRouter><OwnerLogin /></MemoryRouter>);
    expect(screen.getByText(/Aucune élévation de privilège n’est possible/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Connexion utilisateur standard/ }).getAttribute('href')).toBe('/connexion');
  });
});
