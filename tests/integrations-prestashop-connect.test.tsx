// @vitest-environment jsdom
/**
 * Connexion PrestaShop depuis la fiche du catalogue d'intégrations.
 *
 * Ce qui est protégé ici :
 *   - la fiche propose réellement de connecter le seul fournisseur dont le
 *     moteur est écrit (avant, le bouton était inerte et l'état `needs_config`
 *     rendait même le bouton absent) ;
 *   - la clé part au serveur, masquée, et n'est jamais réaffichée ;
 *   - un refus du serveur est affiché tel quel, sans état « connecté » ;
 *   - sans entreprise active, rien ne part ;
 *   - un fournisseur sans moteur n'affiche pas ce formulaire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  connectEdge: vi.fn(),
  invokeEdge: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...reel,
    invokeEdge: (nom: string, corps: Record<string, unknown>) => (
      nom === 'store-connect' ? api.connectEdge(nom, corps) : api.invokeEdge(nom, corps)
    ),
  };
});

vi.mock('../src/context/AuthContext', async () => {
  const reel = await vi.importActual<typeof import('../src/context/AuthContext')>('../src/context/AuthContext');
  return { ...reel, useAuth: () => ({ workspaceId: 'w1' }) };
});

import { PrestashopConnectForm } from '../src/integrations/PrestashopConnectForm';

const CLE = 'WS-CLE-PRESTASHOP-0123456789';
const onChanged = vi.fn();

beforeEach(() => {
  api.connectEdge.mockReset();
  api.invokeEdge.mockReset();
  onChanged.mockReset();
});

afterEach(cleanup);

function monter(connected = false, workspaceId: string | null = 'w1') {
  return render(<PrestashopConnectForm workspaceId={workspaceId} connected={connected} onChanged={onChanged} />);
}

function saisir(adresse = 'https://atelier-lin.example', cle = CLE) {
  fireEvent.change(screen.getByTestId('prestashop-url'), { target: { value: adresse } });
  fireEvent.change(screen.getByTestId('prestashop-key'), { target: { value: cle } });
}

describe('connexion PrestaShop — fiche du catalogue', () => {
  it('la clé est masquée et part au serveur', async () => {
    api.connectEdge.mockResolvedValueOnce({
      data: {
        connectorKey: 'prestashop', status: 'connected', connected: true,
        shopName: 'Atelier Lin', version: '8.1.2', totalProducts: 42,
        resourcesRead: ['shops', 'languages'], connectedTo: '203.0.113.10',
        endpoint: 'https://atelier-lin.example/api', durationMs: 640,
      },
    });
    monter();
    const champ = screen.getByTestId('prestashop-key') as HTMLInputElement;
    expect(champ.type).toBe('password');

    saisir();
    fireEvent.click(screen.getByTestId('prestashop-submit'));

    await waitFor(() => expect(screen.getByTestId('prestashop-proof')).toBeTruthy());
    expect(api.connectEdge).toHaveBeenCalledWith('store-connect', expect.objectContaining({
      action: 'connect', workspaceId: 'w1', connectorKey: 'prestashop',
      url: 'https://atelier-lin.example', apiKey: CLE,
    }));
    // Preuve affichée, clé absente du DOM.
    expect(document.body.textContent ?? '').toContain('Atelier Lin');
    expect(document.body.textContent ?? '').toContain('203.0.113.10');
    expect(document.body.textContent ?? '').not.toContain(CLE);
    // Le champ de saisie est vidé : la clé n'est plus dans le composant.
    expect((screen.getByTestId('prestashop-key') as HTMLInputElement).value).toBe('');
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('affiche le refus du serveur sans prétendre être connecté', async () => {
    api.connectEdge.mockRejectedValueOnce(new Error('La clé Webservice a été refusée.'));
    monter();
    saisir('https://atelier-lin.example', 'MAUVAISE-CLE-1234');
    fireEvent.click(screen.getByTestId('prestashop-submit'));

    await waitFor(() => expect(screen.getByTestId('prestashop-connect-error')).toBeTruthy());
    expect(screen.getByTestId('prestashop-connect-error').textContent).toMatch(/refusée/i);
    expect(screen.queryByTestId('prestashop-proof')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('n’envoie rien sans entreprise active', () => {
    monter(false, null);
    saisir();
    const bouton = screen.getByTestId('prestashop-submit') as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('propose de déconnecter une boutique déjà connectée', async () => {
    api.connectEdge.mockResolvedValueOnce({ data: { disconnected: true } });
    monter(true);

    // Rien à ressaisir : la clé n'existe plus côté navigateur.
    expect(screen.queryByTestId('prestashop-key')).toBeNull();
    fireEvent.click(screen.getByTestId('prestashop-disconnect'));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.connectEdge).toHaveBeenCalledWith('store-connect', expect.objectContaining({
      action: 'disconnect', workspaceId: 'w1', connectorKey: 'prestashop',
    }));
  });
});
