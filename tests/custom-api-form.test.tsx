// @vitest-environment jsdom
/**
 * Écran de configuration de l'API personnalisée.
 *
 * Les tests portent sur les décisions qui ont un coût réel : peut-on
 * enregistrer sans preuve ? la clé survit-elle à l'affichage ? l'unité de prix
 * est-elle un choix explicite ?
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ invokeEdge: vi.fn() }));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, invokeEdge: api.invokeEdge };
});

import { CustomApiConnectForm } from '../src/integrations/CustomApiConnectForm';

/*
 * `AppError` n'est pas une `Error` (voir `src/lib/errors.ts`) : `mockRejectedValue`
 * construisait l'objet au moment de la configuration du mock et ne rejetait
 * rien, d'où une promesse qui se résolvait avec `undefined`. On rejette donc
 * explicitement, dans l'implémentation.
 */

beforeEach(() => api.invokeEdge.mockReset());
afterEach(cleanup);

const SONDE_OK = {
  data: {
    probe: {
      ok: true,
      code: 'ok',
      message: '38 produits lus.',
      arrayPath: 'data',
      count: 38,
      sampleFields: ['id', 'title', 'amount', 'stock'],
    },
    status: 200,
    productsFound: 38,
  },
};

function remplir() {
  fireEvent.change(screen.getByTestId('custom-api-base-url'), {
    target: { value: 'https://api.boutique.example' },
  });
  fireEvent.change(screen.getByTestId('custom-api-secret'), { target: { value: 'cle-123' } });
  fireEvent.change(screen.getByTestId('custom-api-products-path'), {
    target: { value: '/api/products' },
  });
}

describe('enregistrement', () => {
  it('refuse d’enregistrer avant un test réussi', () => {
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    const bouton = screen.getByTestId('custom-api-save') as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    expect(screen.getByText(/test réussi est requis/i)).toBeTruthy();
  });

  it('ne peut pas enregistrer après un test échoué', async () => {
    api.invokeEdge.mockResolvedValue({
      data: { probe: { ok: false, code: 'unauthorized', message: 'Clé refusée.' }, status: 401 },
    });
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));

    await waitFor(() => expect(screen.getByTestId('custom-api-probe-result')).toBeTruthy());
    expect(screen.getByTestId('custom-api-probe-result').getAttribute('data-ok')).toBe('false');
    expect((screen.getByTestId('custom-api-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enregistre après un test réussi et transmet la preuve', async () => {
    api.invokeEdge.mockImplementation(async (_nom: string, corps?: Record<string, unknown>) => {
      if (corps?.action === 'probe-custom') return SONDE_OK;
      return { data: { saved: true, connectionId: 'conn-9' } };
    });
    const onChanged = vi.fn();
    const onSaved = vi.fn();
    render(<CustomApiConnectForm workspaceId="w1" onChanged={onChanged} onSaved={onSaved} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));

    await waitFor(() => expect((screen.getByTestId('custom-api-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('custom-api-save'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const envoi = api.invokeEdge.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(envoi.action).toBe('save-custom');
    expect(envoi.probeStatus).toBe(200);
    expect(envoi.productsFound).toBe(38);
    expect(onSaved).toHaveBeenCalled();
  });
});

describe('secret', () => {
  it('vide le champ dès un test réussi', async () => {
    api.invokeEdge.mockResolvedValue(SONDE_OK);
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    const champ = screen.getByTestId('custom-api-secret') as HTMLInputElement;
    expect(champ.value).toBe('cle-123');

    fireEvent.click(screen.getByTestId('custom-api-test'));
    await waitFor(() => expect(champ.value).toBe(''));
  });

  it('conserve la saisie quand la sonde échoue', async () => {
    /*
     * Une clé refusée ne doit pas être effacée : l'utilisateur corrigerait à
     * l'aveugle, en devant retrouver sa clé. Le champ n'est vidé QUE sur une
     * sonde réussie, où il n'a plus d'utilité.
     *
     * On passe par un échec rapporté par le serveur (le cas réel) plutôt que
     * par une exception du mock : une exception synchrone dans le harnais
     * remonte aussi comme rejet non capté et masque l'assertion.
     */
    api.invokeEdge.mockResolvedValue({
      data: { probe: { ok: false, code: 'unauthorized', message: 'La clé a été refusée.' }, status: 401 },
    });
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));

    await waitFor(() => expect(screen.getByTestId('custom-api-probe-result')).toBeTruthy());
    expect(screen.getByTestId('custom-api-probe-result').textContent).toContain('La clé a été refusée');
    expect((screen.getByTestId('custom-api-secret') as HTMLInputElement).value).toBe('cle-123');
    expect((screen.getByTestId('custom-api-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ne l’écrit jamais dans le stockage local', async () => {
    api.invokeEdge.mockResolvedValue(SONDE_OK);
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));
    await waitFor(() => expect(screen.getByTestId('custom-api-probe-result')).toBeTruthy());

    const stockage = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(stockage).not.toContain('cle-123');
  });
});

describe('correspondance', () => {
  it('propose le mapping à partir des champs observés', async () => {
    api.invokeEdge.mockResolvedValue(SONDE_OK);
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));

    await waitFor(() => expect(screen.getByTestId('custom-api-mapping-toggle')).toBeTruthy());
    // Les champs de la sonde servent de base : `title` pour le nom, `amount`
    // pour le prix.
    expect((screen.getByTestId('custom-api-map-name') as HTMLInputElement).value).toBe('title');
    expect((screen.getByTestId('custom-api-map-price') as HTMLInputElement).value).toBe('amount');
  });

  it('n’impose pas de mapping deviné : le champ reste modifiable', async () => {
    api.invokeEdge.mockResolvedValue(SONDE_OK);
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    remplir();
    fireEvent.click(screen.getByTestId('custom-api-test'));
    await waitFor(() => expect(screen.getByTestId('custom-api-map-name')).toBeTruthy());

    fireEvent.change(screen.getByTestId('custom-api-map-name'), { target: { value: 'product.title' } });
    expect((screen.getByTestId('custom-api-map-name') as HTMLInputElement).value).toBe('product.title');
  });

  it('rend l’unité de prix explicite', () => {
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    const unite = screen.getByTestId('custom-api-price-unit') as HTMLSelectElement;
    // « major » par défaut : le prix affiché est celui que la boutique montre.
    expect(unite.value).toBe('major');
    expect(screen.getByText(/fausse tous les prix d’un facteur 100/i)).toBeTruthy();
  });
});

describe('périmètre', () => {
  it('ne fait rien sans entreprise', () => {
    render(<CustomApiConnectForm workspaceId={null} onChanged={() => {}} />);
    expect((screen.getByTestId('custom-api-test') as HTMLButtonElement).disabled).toBe(true);
    expect(api.invokeEdge).not.toHaveBeenCalled();
  });

  it('annonce la lecture seule', () => {
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    expect(screen.getByTestId('custom-api-form').textContent).toMatch(/Lecture seule/i);
  });

  it('n’offre que des en-têtes d’authentification connus', () => {
    render(<CustomApiConnectForm workspaceId="w1" onChanged={() => {}} />);
    fireEvent.change(screen.getByTestId('custom-api-scheme'), { target: { value: 'header' } });
    const select = screen.getByTestId('custom-api-header-name');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(options).not.toContain('authorization');
    // Aucun en-tête de contrôle du message HTTP.
    expect(options).not.toContain('host');
    expect(options).not.toContain('content-length');
  });
});
