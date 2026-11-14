// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from '../src/pages/Home';

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'awa.traore@example.com' },
    profile: { display_name: 'Awa Traoré' },
    workspace: { id: 'ws-1', name: 'Maison VYORA' },
  }),
}));

afterEach(() => cleanup());

describe('Accueil personnalisé après connexion', () => {
  it('salue le prénom du profil authentifié', () => {
    render(<MemoryRouter><Home /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Awa');
    expect(screen.getByText(/Bonjour|Bon après-midi|Bonsoir/)).toBeTruthy();
  });

  it('présente deux cartes indépendantes vers les vrais tableaux de bord', () => {
    render(<MemoryRouter><Home /></MemoryRouter>);
    const studio = screen.getByRole('link', { name: /Entrer dans Studio/ });
    const business = screen.getByRole('link', { name: /Entrer dans Business Growth/ });
    expect(studio.getAttribute('href')).toBe('/app/studio');
    expect(business.getAttribute('href')).toBe('/app/business');
    expect(screen.getByRole('heading', { name: 'VYORA Studio' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'VYORA Business Growth' })).toBeTruthy();
  });

  it('rappelle la séparation des crédits et des données', () => {
    render(<MemoryRouter><Home /></MemoryRouter>);
    expect(screen.getByText('Crédits Studio séparés')).toBeTruthy();
    expect(screen.getByText('Données métier isolées')).toBeTruthy();
    expect(screen.getByText('Crédits et quotas séparés')).toBeTruthy();
  });
});
