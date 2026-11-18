// @vitest-environment jsdom
/**
 * Connexion d'une boutique PrestaShop — ce que l'écran promet.
 *
 * Ce qui est protégé ici :
 *   - la clé part au serveur, en `type="password"`, et n'est jamais réaffichée ;
 *   - après connexion, la clé est vidée du champ et ce qui reste affiché est la
 *     preuve (boutique, version, produits, adresse contrôlée) — jamais le secret ;
 *   - un échec est affiché tel quel, et rien ne prétend être connecté ;
 *   - la déconnexion demande le retrait côté serveur avant de changer l'écran ;
 *   - aucun de ces appels ne va vers une boutique : tout passe par Edge Function.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  createProduct: vi.fn(),
  invokeEdge: vi.fn(),
  connectEdge: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...reel,
    createProduct: api.createProduct,
    invokeEdge: (nom: string, corps: Record<string, unknown>) => (
      nom === 'store-connect' ? api.connectEdge(nom, corps) : api.invokeEdge(nom, corps)
    ),
  };
});

import { StoreImportPanel } from '../src/business/importer/StoreImportPanel';

const CLE = 'WS-CLE-TRES-SECRETE-0123456789';

const connecte = {
  data: {
    connectorKey: 'prestashop',
    status: 'connected',
    connected: true,
    shopName: 'Atelier Lin',
    version: '8.1.2',
    totalProducts: 42,
    resourcesRead: ['shops', 'languages', 'products'],
    connectedTo: '203.0.113.10',
    endpoint: 'https://atelier-lin.example/api',
    durationMs: 812,
  },
};

beforeEach(() => {
  api.createProduct.mockReset();
  api.invokeEdge.mockReset();
  api.connectEdge.mockReset();
  api.connectEdge.mockResolvedValue({ data: null });
});

afterEach(cleanup);

function panneau(workspaceId: string | null = 'w1') {
  return render(
    <StoreImportPanel workspaceId={workspaceId} existing={[]} onImported={vi.fn()} onClose={vi.fn()} />,
  );
}

function saisir(adresse: string, cle: string) {
  fireEvent.change(screen.getByTestId('store-connect-url'), { target: { value: adresse } });
  fireEvent.change(screen.getByTestId('store-connect-key'), { target: { value: cle } });
}

describe('connexion PrestaShop', () => {
  it('la clé est saisie masquée et part au serveur, jamais l’inverse', async () => {
    panneau();
    const champCle = screen.getByTestId('store-connect-key') as HTMLInputElement;
    // Masquée à l'écran : une clé Webservice ne doit pas rester lisible.
    expect(champCle.type).toBe('password');

    api.connectEdge.mockResolvedValueOnce(connecte);
    saisir('https://atelier-lin.example', CLE);
    fireEvent.click(screen.getByTestId('store-connect-submit'));

    await waitFor(() => expect(screen.getByTestId('store-connect-connected')).toBeTruthy());

    // On cherche l'appel de CONNEXION : la lecture d'état (`status`) faite au
    // montage est un autre appel, légitime et sans secret.
    const [, corps] = api.connectEdge.mock.calls.find(([, b]) => b?.action === 'connect')!;
    expect(corps).toMatchObject({
      action: 'connect',
      workspaceId: 'w1',
      connectorKey: 'prestashop',
      url: 'https://atelier-lin.example',
      apiKey: CLE,
    });
    // Aucun appel d'import n'a été déclenché par une simple connexion.
    expect(api.invokeEdge).not.toHaveBeenCalled();
  });

  it('vide le champ de la clé et n’affiche que la preuve de lecture', async () => {
    panneau();
    api.connectEdge.mockResolvedValueOnce(connecte);
    saisir('https://atelier-lin.example', CLE);
    fireEvent.click(screen.getByTestId('store-connect-submit'));

    await waitFor(() => expect(screen.getByTestId('store-connect-connected')).toBeTruthy());

    // Le champ de saisie disparaît avec la connexion : il ne peut plus rien
    // contenir. La clé n'apparaît nulle part dans le document.
    expect(screen.queryByTestId('store-connect-key')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain(CLE);
    expect(document.body.textContent ?? '').not.toContain('WS-CLE');

    // La preuve est affichée, y compris l'adresse réellement contactée.
    expect(screen.getByText(/Atelier Lin/)).toBeTruthy();
    expect(screen.getByText(/42 produit/)).toBeTruthy();
    expect(screen.getByText(/203\.0\.113\.10/)).toBeTruthy();
  });

  it('affiche le refus du serveur sans prétendre être connecté', async () => {
    panneau();
    api.connectEdge.mockRejectedValueOnce(new Error('La clé Webservice a été refusée. Vérifiez la clé.'));
    saisir('https://atelier-lin.example', 'CLE-INCORRECTE-1234');
    fireEvent.click(screen.getByTestId('store-connect-submit'));

    await waitFor(() => expect(screen.getByTestId('store-connect-error')).toBeTruthy());
    expect(screen.getByTestId('store-connect-error').textContent).toMatch(/refusée/i);
    expect(screen.queryByTestId('store-connect-connected')).toBeNull();
  });

  it('reflète une connexion déjà établie au retour sur l’écran', async () => {
    api.connectEdge.mockResolvedValueOnce({
      data: {
        connectorKey: 'prestashop',
        status: 'connected',
        connected: true,
        connectedTo: '203.0.113.10',
        endpoint: 'https://atelier-lin.example/api',
        shopName: 'Atelier Lin',
        version: '8.1.2',
        totalProducts: 42,
        resourcesRead: ['shops'],
        checkedAt: '2026-11-17T00:00:00.000Z',
        lastError: null,
      },
    });
    panneau();

    await waitFor(() => expect(screen.getByTestId('store-connect-connected')).toBeTruthy());
    expect(api.connectEdge).toHaveBeenCalledWith('store-connect', expect.objectContaining({ action: 'status' }));
    expect(api.invokeEdge).not.toHaveBeenCalled();
  });

  it('déconnecte côté serveur avant de changer l’écran', async () => {
    api.connectEdge.mockResolvedValueOnce({
      data: {
        connectorKey: 'prestashop', status: 'connected', connected: true,
        connectedTo: '203.0.113.10', endpoint: 'https://atelier-lin.example/api',
        shopName: 'Atelier Lin', version: '8.1.2', totalProducts: 42,
        resourcesRead: ['shops'], checkedAt: null, lastError: null,
      },
    });
    panneau();
    await waitFor(() => expect(screen.getByTestId('store-connect-connected')).toBeTruthy());

    api.connectEdge.mockResolvedValueOnce({ data: { disconnected: true } });
    fireEvent.click(screen.getByTestId('store-connect-disconnect'));

    await waitFor(() => expect(screen.queryByTestId('store-connect-connected')).toBeNull());
    const appels = api.connectEdge.mock.calls.filter(([, corps]) => corps?.action === 'disconnect');
    expect(appels).toHaveLength(1);
    expect(appels[0][1]).toMatchObject({ connectorKey: 'prestashop', workspaceId: 'w1' });
    // La saisie redevient disponible : l'utilisateur peut reconnecter.
    expect(screen.getByTestId('store-connect-key')).toBeTruthy();
  });

  it('ne propose pas de connecter sans entreprise sélectionnée', () => {
    panneau(null);
    saisir('https://atelier-lin.example', CLE);
    const bouton = screen.getByTestId('store-connect-submit') as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });
});
