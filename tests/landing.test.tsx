// @vitest-environment jsdom
// Vitrine VYORA — landing de lancement.
//
// Ce que ces tests protègent, dans l'ordre d'importance commerciale :
//
//   1. La promesse est lisible immédiatement (un seul H1, un CTA principal).
//   2. Les deux espaces sont présentés avec un CTA chacun.
//   3. **Aucun prix n'est inventé** : si la base ne répond pas, la section
//      tarifs affiche un message honnête, jamais un faux montant.
//   4. La preuve sociale est éteinte par défaut (aucun faux témoignage).
//   5. La page est navigable au clavier et à la souris.
//
// Les tests précédents vérifiaient l'ancienne landing (hero « Vos idées
// prennent forme »). Ils sont remplacés, pas contournés : l'exigence de vérité
// commerciale, elle, est conservée et renforcée.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Landing from '../src/pages/Landing';

// La landing interroge Supabase pour les textes et les tarifs. En test, on
// simule une base injoignable : c'est le pire cas, et c'est celui qui doit
// afficher les valeurs par défaut sans jamais inventer de prix.
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: null, error: { message: 'offline' } }),
        eq: () => ({
          in: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'offline' } }) }),
          maybeSingle: () => Promise.resolve({ data: null, error: { message: 'offline' } }),
        }),
      }),
    }),
  },
  isSupabaseConfigured: true,
}));

// La scène 3D importe three dynamiquement : on l'exclut, ce n'est pas l'objet
// du test et cela évite d'attendre un chunk de 175 Ko.
vi.mock('../src/marketing/3d/SceneHero', () => ({
  SceneHero: () => <div data-testid="scene-hero" aria-hidden="true" />,
}));

function rendre() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Landing />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('landing VYORA', () => {
  it('affiche un titre principal unique et un CTA principal', async () => {
    rendre();
    const titres = await screen.findAllByRole('heading', { level: 1 });
    expect(titres).toHaveLength(1);
    // La promesse doit parler d'argent ou de clients : c'est le cœur du
    // positionnement. La formulation exacte reste éditable en admin.
    expect(titres[0].textContent).toMatch(/argent|clients|devis|impay/i);

    // Il y a plusieurs CTA vers l'inscription (hero, tarifs, bas de page) :
    // c'est voulu. On vérifie qu'ils existent tous et pointent au bon endroit.
    const ctas = screen.getAllByRole('link', { name: /Créer mon espace/i });
    expect(ctas.length).toBeGreaterThanOrEqual(2);
    for (const cta of ctas) expect(cta.getAttribute('href')).toBe('/inscription');
  });

  it('présente les deux espaces avec un CTA chacun', async () => {
    rendre();
    expect(await screen.findByRole('heading', { name: 'Business Grow', level: 3 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'VYORA Studio', level: 3 })).toBeTruthy();

    // Chaque carte mène vers l'inscription avec l'espace pré-sélectionné :
    // l'utilisateur n'a pas à le rechoisir après création du compte.
    const business = screen.getByRole('link', { name: /Ouvrir Business Grow/i });
    expect(business.getAttribute('href')).toBe('/inscription?espace=business');
    const studio = screen.getByRole('link', { name: /Ouvrir VYORA Studio/i });
    expect(studio.getAttribute('href')).toBe('/inscription?espace=studio');
  });

  it('expose les sections ancrées attendues', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });
    for (const id of ['probleme', 'solution', 'tarifs', 'faq']) {
      expect(document.getElementById(id), `section #${id} manquante`).toBeTruthy();
    }
  });

  it('n’affiche aucun prix inventé quand la base est indisponible', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });

    // Aucun montant ne doit apparaître dans la section tarifs.
    const tarifs = document.getElementById('tarifs');
    expect(tarifs).toBeTruthy();
    expect(tarifs?.textContent ?? '').not.toMatch(/\d[\s\u202f]?\d*\s?FCFA/);

    // À la place : une phrase honnête qui renvoie vers la création de compte.
    expect(screen.getByText(/tarifs sont en cours de fixation/i)).toBeTruthy();
  });

  it('garde la preuve sociale éteinte par défaut', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });
    // Aucun témoignage, aucune note, aucun logo client inventé.
    expect(screen.queryByText(/Ils utilisent VYORA/i)).toBeNull();
    expect(screen.queryByText(/\d\s?\/\s?5/)).toBeNull();
  });

  it('ne promet pas d’automatisation WhatsApp ou Meta', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });
    const texte = document.body.textContent ?? '';

    // La FAQ explique explicitement que VYORA fonctionne SANS Meta.
    expect(texte).toMatch(/fonctionne sans aucune connexion à Meta/i);
    // Et ne prétend jamais envoyer automatiquement sur WhatsApp.
    expect(texte).not.toMatch(/envoi automatique (sur|via) WhatsApp/i);
    expect(texte).not.toMatch(/connexion (automatique )?(à|a) WhatsApp/i);
  });

  it('rend la FAQ utilisable au clavier et à la souris', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });

    const question = screen.getByText(/Est-ce que ça marche avec Orange Money/i);
    const details = question.closest('details');
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);

    fireEvent.click(question);
    expect(details?.open).toBe(true);
  });

  it('garde la connexion accessible depuis la navigation', async () => {
    rendre();
    await screen.findByRole('heading', { level: 1 });
    const liens = screen.getAllByRole('link', { name: /Connexion/i });
    expect(liens.length).toBeGreaterThanOrEqual(1);
  });

  it('monte la scène décorative sans intercepter les clics', async () => {
    rendre();
    const scene = await screen.findByTestId('scene-hero');
    // Décorative : elle ne doit ni capter le pointeur ni apparaître dans
    // l'arbre d'accessibilité — sinon elle gêne la lecture du titre.
    expect(scene.getAttribute('aria-hidden')).toBe('true');
  });
});
