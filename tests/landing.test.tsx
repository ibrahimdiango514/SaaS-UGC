// @vitest-environment jsdom
// Vitrine VYORA (B3) — homepage premium avec hero 3D, sélecteur 2 cartes
// (Business Grow / Studio UGC) et AUCUNE offre fictive : le système commercial
// (formules, crédits, SASPAY) vit dans les espaces authentifiés
// (/app/abonnement, /app/credits, /app/business/abonnement), jamais sur la
// page publique.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import App from '../src/App';

beforeEach(() => { window.history.pushState({}, '', '/'); });
afterEach(() => { cleanup(); });

describe('vitrine VYORA (B3)', () => {
  it('présente le hero et un lien d’évitement accessible au clavier', async () => {
    render(<App />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1.textContent).toContain('Vos idées prennent forme');
    const skip = screen.getByRole('link', { name: /Aller au contenu/i });
    expect(skip.getAttribute('href')).toBe('#contenu');
  });

  it('présente les deux univers avec leurs routes', async () => {
    render(<App />);
    expect(await screen.findByText('VYORA Studio')).toBeTruthy();
    expect(screen.getByText('VYORA Business')).toBeTruthy();
    // Les cartes mènent vers l’onboarding : les espaces de travail sont
    // derrière l’authentification (parcours post-login, sélecteur 2 cartes).
    const cardLinks = screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/inscription');
    expect(cardLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('expose toutes les sections ancrées de la page', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    for (const id of ['dimensions', 'fonctionnalites', 'workflow', 'defis', 'faq']) {
      expect(document.getElementById(id), `section #${id} manquante`).toBeTruthy();
    }
    // La section « défis » (les vrais problèmes des utilisateurs) remplace
    // l’ancienne section Tarifs de la vitrine publique.
    expect(screen.getByText('Les défis que vous connaissez')).toBeTruthy();
  });

  it('n’affiche aucune offre fictive (pas de Tarifs, formule, prix ni mois)', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('Tarifs')).toBeNull();
    expect(screen.queryByText('Découverte')).toBeNull();
    expect(screen.queryByText('9 crédits offerts')).toBeNull();
    expect(screen.queryByText(/mois/)).toBeNull();
  });

  it('rend la FAQ utilisable au clavier et à la souris', async () => {
    render(<App />);
    const question = await screen.findByRole('button', { name: /Comment le devis fonctionne-t-il/ });
    expect(question.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(question);
    expect(question.getAttribute('aria-expanded')).toBe('true');
    // La réponse : devis vérifié côté serveur, aucun prix inventé.
    expect(screen.getByText(/aucun prix n’est inventé/)).toBeTruthy();
    fireEvent.click(question);
    expect(question.getAttribute('aria-expanded')).toBe('false');
  });

  it('garde les actions de connexion visibles sur la barre de navigation', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    const connexions = screen.getAllByRole('link', { name: /Connexion/i });
    expect(connexions.length).toBeGreaterThanOrEqual(1);
    expect(within(document.body).getAllByRole('link', { name: /Commencer/i }).length).toBeGreaterThanOrEqual(1);
  });
});
