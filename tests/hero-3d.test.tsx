// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// drei (react-use-measure) exige un ResizeObserver : jsdom n'en a pas.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() { /* noop */ }
    unobserve() { /* noop */ }
    disconnect() { /* noop */ }
  } as unknown as typeof ResizeObserver;
}

import Landing from '../src/pages/Landing';

/** jsdom n'implémente pas WebGL : getContext renvoie null par défaut. */
function stubWebgl(available: boolean) {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((name: string) => {
    if (name === 'webgl2' || name === 'webgl') return available ? ({} as unknown as WebGLRenderingContext) : null;
    return null;
  });
}

function stubReducedMotion(reduced: boolean) {
  const listeners: Array<(event: MediaQueryListEvent) => void> = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: reduced,
      media: 'prefers-reduced-motion: reduce',
      addEventListener: vi.fn((_: string, cb: (event: MediaQueryListEvent) => void) => { listeners.push(cb); }),
      removeEventListener: vi.fn(),
    }),
  });
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Landing />
    </MemoryRouter>,
  );
}

describe('accueil — hero 3D (B3)', () => {
  beforeEach(() => {
    stubWebgl(false);
    stubReducedMotion(false);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('garde l’image statique quand WebGL est indisponible', async () => {
    renderLanding();

    expect(await screen.findByAltText('Direction artistique VYORA : lumière, matière et profondeur')).toBeTruthy();
    expect(screen.getByText('Vos idées prennent forme.')).toBeTruthy();
  });

  it('désactive la scène 3D quand le mouvement réduit est demandé', async () => {
    stubReducedMotion(true);
    // Même avec WebGL « disponible » : le repli statique est prioritaire.
    stubWebgl(true);
    renderLanding();

    expect(await screen.findByAltText('Direction artistique VYORA : lumière, matière et profondeur')).toBeTruthy();
  });

  it('monte la scène 3D quand WebGL est disponible (canvas présent, page intacte)', async () => {
    // En navigateur réel : si la création du contexte WebGL échoue au
    // montage, l'error boundary bascule sur le repli statique (testé par le
    // contrat des deux tests précédents). Ici, on vérifie que le canvas 3D
    // est bien tenté et que la page reste fonctionnelle.
    stubWebgl(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderLanding();

    await waitFor(() => expect(document.querySelector('canvas')).toBeTruthy(), { timeout: 10_000 });
    expect(screen.getByText('Vos idées prennent forme.')).toBeTruthy();
    expect(screen.getByText('Créer · Développer')).toBeTruthy();
  });
});
