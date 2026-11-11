// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('../src/context/AuthContext', () => ({ useAuth: mocks.useAuth }));

import { AdminRoute, ProtectedRoute } from '../src/components/Routes';

function renderAdminRoute({ user, isAdmin }: { user: object | null; isAdmin: boolean }) {
  mocks.useAuth.mockReturnValue({
    user,
    isAdmin,
    loading: false,
    bootstrapError: null,
    refreshAll: vi.fn(),
  });

  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route element={<AdminRoute />}>
            <Route path="/admin" element={<p>Administration protégée</p>} />
          </Route>
          <Route path="/app" element={<p>Espace utilisateur</p>} />
        </Route>
        <Route path="/connexion" element={<p>Connexion</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('route /admin', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('affiche l’administration pour un administrateur connecté', () => {
    renderAdminRoute({ user: { id: 'admin-user' }, isAdmin: true });

    expect(screen.getByText('Administration protégée')).toBeTruthy();
  });

  it('redirige un utilisateur connecté non administrateur', () => {
    renderAdminRoute({ user: { id: 'regular-user' }, isAdmin: false });

    expect(screen.getByText('Espace utilisateur')).toBeTruthy();
  });

  it('redirige une session absente vers la connexion', () => {
    renderAdminRoute({ user: null, isAdmin: false });

    expect(screen.getByText('Connexion')).toBeTruthy();
  });
});
