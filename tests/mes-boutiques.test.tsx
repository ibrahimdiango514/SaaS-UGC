// @vitest-environment jsdom
/**
 * Phase E — centre « Mes boutiques connectées ».
 *
 * Ce panneau agrège des états serveur. Le risque n'est pas qu'il plante : c'est
 * qu'il affiche « connectée » à tort, ou qu'une panne de lecture passe pour une
 * absence de connexion. Les deux cas sont testés.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ connectEdge: vi.fn(), invokeEdge: vi.fn() }));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...reel,
    invokeEdge: (nom: string, corps: Record<string, unknown>) => (
      nom === 'store-connect' ? api.connectEdge(nom, corps) : api.invokeEdge(nom, corps)
    ),
  };
});

import { MesBoutiquesConnectees } from '../src/integrations/MesBoutiquesConnectees';

beforeEach(() => {
  api.connectEdge.mockReset();
  api.invokeEdge.mockReset();
});

afterEach(cleanup);

/** Réponse de `store-connect` par connecteur. */
function repondre(parCle: Record<string, unknown | Error>) {
  api.connectEdge.mockImplementation(async (_nom: string, corps: Record<string, unknown>) => {
    const valeur = parCle[String(corps.connectorKey)];
    if (valeur instanceof Error) throw valeur;
    return { data: valeur ?? null };
  });
}

describe('lecture des états', () => {
  it('affiche une boutique connectée avec sa preuve', async () => {
    repondre({
      prestashop: {
        connectorKey: 'prestashop',
        status: 'connected',
        connected: true,
        shopName: 'Atelier Lin',
        endpoint: 'https://atelier-lin.example/api',
        totalProducts: 42,
        checkedAt: '2026-11-14T10:00:00.000Z',
      },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const carte = screen.getByTestId('boutique-prestashop');
    expect(carte.getAttribute('data-state')).toBe('connected');
    expect(carte.textContent).toContain('Atelier Lin');
    expect(carte.textContent).toContain('42');
  });

  it('distingue une erreur d’authentification d’un droit manquant', async () => {
    repondre({
      prestashop: { connectorKey: 'prestashop', status: 'error', connected: false, lastError: 'La clé a été refusée.', lastErrorCode: 'AUTH_INVALID' },
      chariow: { connectorKey: 'chariow', status: 'error', connected: false, lastError: 'Autorisation insuffisante : ajoutez products.read', lastErrorCode: 'INSUFFICIENT_SCOPE' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('auth-error');
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('insufficient-scope');
  });

  it('affiche « non configurée » quand le serveur ne renvoie rien', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('not-configured');
  });

  it('ne conclut RIEN quand la lecture échoue', async () => {
    repondre({ prestashop: new Error('Réseau indisponible') });
    render(<MesBoutiquesConnectees workspaceId="w1" />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const carte = screen.getByTestId('boutique-prestashop');
    // Surtout pas « non configurée » : l'utilisateur ressaisirait sa clé alors
    // qu'une connexion valide existe peut-être.
    expect(carte.getAttribute('data-state')).toBe('pending');
    expect(carte.textContent).toMatch(/illisible/i);
    expect(carte.textContent).toMatch(/aucune conclusion/i);
  });

  it('une panne d’un connecteur ne masque pas l’autre', async () => {
    repondre({
      prestashop: new Error('panne'),
      chariow: { connectorKey: 'chariow', status: 'connected', connected: true, shopName: 'Vitrine' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);

    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('pending');
  });

  it('signale une connexion déclarée sans secret', async () => {
    repondre({
      chariow: {
        connectorKey: 'chariow',
        status: 'connected',
        // Le serveur dit « connecté » mais aucun secret n'existe : trace d'une
        // ancienne demande d'activation.
        connected: false,
      },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);

    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('boutique-chariow').textContent).toMatch(/Aucun secret/i);
  });

  it('résume les états en tête', async () => {
    repondre({
      prestashop: { connectorKey: 'prestashop', status: 'connected', connected: true },
      chariow: { connectorKey: 'chariow', status: 'error', connected: false, lastErrorCode: 'AUTH_INVALID' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/1 connectée/i));
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/1 à corriger/i);
  });
});

describe('interactions', () => {
  it('ouvre la fiche du connecteur demandé', async () => {
    repondre({});
    const onOpen = vi.fn();
    render(<MesBoutiquesConnectees workspaceId="w1" onOpenConnector={onOpen} />);

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const bouton = screen.getByTestId('boutique-prestashop').querySelector('button');
    expect(bouton).toBeTruthy();
    fireEvent.click(bouton!);
    expect(onOpen).toHaveBeenCalledWith('prestashop');
  });

  it('relit les états au clic sur Actualiser', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    const avant = api.connectEdge.mock.calls.length;

    fireEvent.click(screen.getByTestId('mes-boutiques-refresh'));
    await waitFor(() => expect(api.connectEdge.mock.calls.length).toBeGreaterThan(avant));
  });

  it('ne lit rien sans entreprise active', () => {
    render(<MesBoutiquesConnectees workspaceId={null} />);
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/Sélectionnez une entreprise/i);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });
});

describe('périmètre affiché', () => {
  it('ne liste que les connecteurs réellement branchés', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());

    // Aucun connecteur non fonctionnel ne doit apparaître ici.
    for (const absent of ['shopify', 'woocommerce', 'opencart', 'magento']) {
      expect(screen.queryByTestId(`boutique-${absent}`), absent).toBeNull();
    }
  });

  it('dit combien de connecteurs sont configurables', async () => {
    repondre({});
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/2 connecteurs sont configurables/i));
  });

  it('n’expose aucun secret dans le DOM', async () => {
    repondre({
      chariow: { connectorKey: 'chariow', status: 'connected', connected: true, shopName: 'Vitrine' },
    });
    render(<MesBoutiquesConnectees workspaceId="w1" />);
    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    // `credential_ref` ne doit jamais être rendu, même sous forme de nom.
    expect(document.body.innerHTML).not.toMatch(/credential|vault|sk_live/i);
  });
});
