// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Home from '../src/pages/Home';
import { WorkspaceDock } from '../src/components/WorkspaceDock';

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'awa@example.com' },
    profile: { display_name: 'Awa Traoré' },
    workspace: { id: 'ws-1', name: 'Maison SORAHNEX' },
    quota: null,
  }),
}));

afterEach(() => cleanup());

/**
 * Toutes les routes déclarées par `App.tsx` (les chemins relatifs sont sous /app).
 * Sert de garde-fou : une carte d'accueil ne doit jamais pointer vers une page
 * inexistante (« aucun bouton décoratif sans action réelle »).
 */
function declaredRoutes(): string[][] {
  const source = readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8');
  const patterns: string[][] = [['']];
  for (const match of source.matchAll(/<Route\s+path="([^"]+)"/g)) {
    const path = match[1];
    if (path === '*') continue;
    patterns.push((path.startsWith('/') ? path : `/app/${path}`).split('/').filter(Boolean));
  }
  return patterns;
}

/** Reconnaît les routes dynamiques (`:id`, `:moduleKey`). */
function matchesAnyRoute(patterns: string[][], pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean);
  return patterns.some((pattern) => pattern.length === segments.length
    && pattern.every((segment, index) => segment.startsWith(':') || segment === segments[index]));
}

describe('séparation des deux espaces', () => {
  it('affiche les deux cartes d’univers vers leurs tableaux de bord réels', () => {
    render(<MemoryRouter><Home /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /Entrer dans Studio/ }).getAttribute('href')).toBe('/app/studio');
    expect(screen.getByRole('link', { name: /Entrer dans Grow/ }).getAttribute('href')).toBe('/app/business');
    expect(screen.getByRole('heading', { name: 'SORAHNEX Studio' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'SORAHNEX Grow' })).toBeTruthy();
  });

  it('n’expose que des destinations réellement déclarées', () => {
    const routes = declaredRoutes();
    render(<MemoryRouter><Home /></MemoryRouter>);
    const hrefs = screen.getAllByRole('link')
      .map((link) => link.getAttribute('href') ?? '')
      .filter((href) => href.startsWith('/'));
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      const path = href.split('?')[0];
      expect(matchesAnyRoute(routes, path), `lien mort dans l'accueil : ${href}`).toBe(true);
    }
  });

  it('donne une identité distincte à chaque barre d’espace', () => {
    render(<MemoryRouter><WorkspaceDock scope="studio" currentPath="/app/studio" /></MemoryRouter>);
    expect(screen.getByText('SORAHNEX Studio')).toBeTruthy();
    expect(screen.getByText('Création & production UGC')).toBeTruthy();
    expect(screen.getByTestId('workspace-dock').getAttribute('data-scope')).toBe('studio');
    cleanup();

    render(<MemoryRouter><WorkspaceDock scope="business" currentPath="/app/business" /></MemoryRouter>);
    expect(screen.getByText('SORAHNEX Grow')).toBeTruthy();
    expect(screen.getByText('Pilotage, revenus & opérations')).toBeTruthy();
    expect(screen.getByTestId('workspace-dock').getAttribute('data-scope')).toBe('business');
  });

  it('offre un retour au sélecteur d’espaces depuis chaque espace', () => {
    render(<MemoryRouter><WorkspaceDock scope="business" currentPath="/app/business" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Tous les espaces' }).getAttribute('href')).toBe('/app');
  });
});
