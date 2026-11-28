// @vitest-environment jsdom
// Vitrine SORAHNEX (B3) — homepage premium avec hero 3D, sélecteur 2 cartes
// (SORAHNEX Grow / Studio UGC) et AUCUNE offre fictive : le système commercial
// (formules, crédits, SASPAY) vit dans les espaces authentifiés
// (/app/abonnement, /app/credits, /app/business/abonnement), jamais sur la
// page publique.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import App from '../src/App';

beforeEach(() => { window.history.pushState({}, '', '/'); });
afterEach(() => { cleanup(); });

describe('vitrine SORAHNEX (B3)', () => {
  it('présente le hero et un lien d’évitement accessible au clavier', async () => {
    render(<App />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    /*
     * Refonte immersive : le titre du hero change, l'exigence ne change pas.
     * Le `h1` reste un vrai titre présent dans le HTML au premier rendu — c'est
     * ce que protège ce test, et c'est ce dont dépend le LCP.
     */
    expect(h1.textContent).toContain('Vos vidéos');
    expect(h1.textContent).toContain('Votre croissance');
    const skip = screen.getByRole('link', { name: /Aller au contenu/i });
    expect(skip.getAttribute('href')).toBe('#contenu');
  });

  it('présente les deux univers avec leurs routes', async () => {
    render(<App />);
    // Chaque espace est nommé plusieurs fois dans la vitrine (aperçu produit,
    // carte de dimension, pastille) : on exige la présence, pas l'unicité.
    expect((await screen.findAllByText('SORAHNEX Studio')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('SORAHNEX Grow').length).toBeGreaterThan(0);
    // Les cartes mènent vers l’onboarding : les espaces de travail sont
    // derrière l’authentification (parcours post-login, sélecteur 2 cartes).
    const cardLinks = screen.getAllByRole('link').filter((link) => link.getAttribute('href') === '/inscription');
    expect(cardLinks.length).toBeGreaterThanOrEqual(2);
  });

  it('expose toutes les sections ancrées de la page', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    /*
     * La refonte remplace les ancres de l'ancienne vitrine par celles du
     * nouveau parcours : l'accueil du scroll immersif, les espaces, les
     * fonctionnalités, le déroulé et la FAQ. Chacune doit exister réellement
     * dans le document, sinon un lien de navigation ne mène nulle part.
     */
    for (const id of ['hero', 'immersion', 'deux-espaces', 'fonctionnalites', 'workflow', 'faq']) {
      expect(document.getElementById(id), `section #${id} manquante`).toBeTruthy();
    }
    // Les trois espaces sont nommés : c'est la promesse centrale du produit.
    expect(screen.getAllByText(/Studio/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Grow/).length).toBeGreaterThan(0);
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
    /*
     * L'action principale de la barre n'est plus « Commencer » mais le CTA
     * unique de la mission. Ce qui compte, et qui est vérifié ici : une action
     * mène à la création de compte, et elle est accessible par son nom.
     */
    const creer = within(document.body).getAllByRole('link', { name: /Créer ma première vidéo/i });
    expect(creer.length).toBeGreaterThanOrEqual(1);
    expect(creer.some((lien) => lien.getAttribute('href') === '/inscription')).toBe(true);
  });
});
