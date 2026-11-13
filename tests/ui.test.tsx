// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Plan } from '../src/lib/types';

const plans: Plan[] = [
  {
    plan_key: 'free', display_name: 'Découverte', tagline: 'Pour découvrir Reelora',
    monthly_price_minor: 0, currency: 'XOF', monthly_credits: 9, max_projects: 2,
    max_scripts_per_month: 5, max_prompts_per_month: 5, max_videos_per_month: 1,
    max_avatars: 1, features: ['9 crédits offerts', '1 vidéo / mois'], active: true, sort_order: 0,
  },
  {
    plan_key: 'studio', display_name: 'Studio', tagline: 'Pour les créateurs réguliers',
    monthly_price_minor: 150000000, currency: 'XOF', monthly_credits: 120, max_projects: 15,
    max_scripts_per_month: 80, max_prompts_per_month: 60, max_videos_per_month: 20,
    max_avatars: 5, features: ['120 crédits / mois', '20 vidéos / mois'], active: true, sort_order: 1,
  },
];

// Only the plan catalog is replaced: every other API export stays real, so the
// production wiring (AuthProvider, Router, ErrorBoundary) is exercised as-is.
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, listPlans: async () => plans };
});

import App from '../src/App';

beforeEach(() => { window.history.pushState({}, '', '/'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('parcours public', () => {
  it('affiche la page d’accueil en français avec les formules issues de la base', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('fait grandir vos ambitions');
    expect(screen.getByRole('heading', { name: /Transformez vos idées et vos produits/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Ne laissez plus votre entreprise/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Votre entreprise mérite mieux/ })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Découverte')).toBeTruthy());
    expect(screen.getByText('Pour découvrir VYORA')).toBeTruthy();
    expect(screen.getByText('Studio', { selector: 'h3' })).toBeTruthy();
    expect(screen.getByText('9 crédits offerts')).toBeTruthy();
  });

  it('navigue vers l’inscription et affiche le formulaire complet', async () => {
    render(<App />);
    fireEvent.click(screen.getAllByRole('link', { name: /Créer mon compte/ })[0]);
    await waitFor(() => expect(window.location.pathname).toBe('/inscription'));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Créer un compte'), { timeout: 5000 });
    expect(screen.getByLabelText('Nom complet')).toBeTruthy();
    expect(screen.getByLabelText('Adresse e-mail')).toBeTruthy();
    expect(screen.getByLabelText(/Mot de passe/)).toBeTruthy();
    expect(screen.getByText('Confirmer le mot de passe')).toBeTruthy();
  });

  it('valide les champs obligatoires de la connexion', async () => {
    window.history.pushState({}, '', '/connexion');
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Connexion'));
    fireEvent.click(screen.getByRole('button', { name: /Se connecter/i }));
    await waitFor(() => expect(screen.getByText(/Renseignez votre e-mail/)).toBeTruthy());
  });

  it('protège l’espace /app et redirige vers la connexion', async () => {
    window.history.pushState({}, '', '/app');
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/connexion'));
  });

  it('affiche une page 404 pour une route inconnue', async () => {
    window.history.pushState({}, '', '/route-inexistante');
    render(<App />);
    expect(screen.getByText('Page introuvable')).toBeTruthy();
  });

  it('affiche la politique de confidentialité', async () => {
    window.history.pushState({}, '', '/confidentialite');
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Politique de confidentialité');
    expect(screen.getByText('Données collectées')).toBeTruthy();
  });
});
