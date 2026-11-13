// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return { ...actual, listPlans: async () => plans };
});

import App from '../src/App';

beforeEach(() => { window.history.pushState({}, '', '/'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('vitrine VYORA', () => {
  it('présente les deux univers avec leurs vraies routes', async () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('fait grandir vos ambitions');
    expect(screen.getByRole('heading', { name: /Transformez vos idées et vos produits/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Ne laissez plus votre entreprise/ })).toBeTruthy();

    expect(screen.getByRole('link', { name: /Découvrir VYORA Studio/ }).getAttribute('href')).toBe('/app/studio');
    const businessLinks = screen.getAllByRole('link', { name: /Découvrir Business Growth/ });
    expect(businessLinks.length).toBeGreaterThan(0);
    expect(businessLinks[0].getAttribute('href')).toBe('/app/business');

    const accountLinks = screen.getAllByRole('link', { name: /Créer mon compte/ });
    expect(accountLinks.length).toBeGreaterThan(0);
    for (const link of accountLinks) expect(link.getAttribute('href')).toBe('/inscription');

    await waitFor(() => expect(screen.getByText('Découverte')).toBeTruthy());
  });

  it('expose toutes les sections ancrées de la page', () => {
    render(<App />);
    for (const id of ['univers', 'studio', 'business', 'problemes', 'ecosysteme', 'tarifs', 'faq']) {
      expect(document.getElementById(id), `section #${id} manquante`).toBeTruthy();
    }
  });

  it('affiche la passerelle Business Growth → Studio sans promesse de débit', () => {
    render(<App />);
    expect(screen.getByText('Périmètre et droits inchangés')).toBeTruthy();
    expect(screen.getByText(/Business Growth ne lit ni ne débite le portefeuille Studio/)).toBeTruthy();
    expect(screen.getByText(/Le transfert ne consomme aucun crédit/)).toBeTruthy();
  });

  it('ouvre et referme le menu mobile au clavier', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le menu' }));
    const mobileNav = screen.getByRole('navigation', { name: 'Navigation mobile' });
    expect(within(mobileNav).getByRole('link', { name: /Tarifs/ })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('navigation', { name: 'Navigation mobile' })).toBeNull();
  });

  it('rend la FAQ utilisable au clavier et à la souris', () => {
    render(<App />);
    const question = screen.getByRole('button', { name: /Quelle est la différence entre VYORA Studio/ });
    expect(question.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(question);
    expect(question.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(question);
    expect(question.getAttribute('aria-expanded')).toBe('true');
  });

  it('conserve le chargement réel des formules depuis la base', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('120 crédits / mois')).toBeTruthy());
    expect(screen.getByText('9 crédits offerts')).toBeTruthy();
  });
});
