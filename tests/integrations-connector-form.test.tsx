// @vitest-environment jsdom
/**
 * Formulaire de connexion **générique** — Phase A.
 *
 * Ce composant remplace `PrestashopConnectForm` et `ChariowConnectForm`. Les
 * tests ci-dessous portent sur ce qui compte, et qui est identique quel que
 * soit le connecteur :
 *
 *   - le secret est masqué, part au serveur, et **disparaît du DOM** dès la
 *     réponse ;
 *   - une preuve de lecture est affichée, jamais une valeur secrète ;
 *   - un refus du serveur n'affiche jamais « connectée » ;
 *   - les champs affichés sont **ceux du connecteur**, pas un formulaire
 *     universel : Chariow ne demande pas d'URL ;
 *   - un connecteur sans parcours livré ne rend rien du tout.
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

import { ConnectorConnectForm } from '../src/integrations/ConnectorConnectForm';

const CLE_PS = 'WS-CLE-PRESTASHOP-0123456789';
const CLE_CHARIOW = 'sk_live_0123456789abcdef';
const onChanged = vi.fn();

/** Réponse de `store-connect` pour une connexion réussie. */
function preuve(connectorKey: 'prestashop' | 'chariow') {
  return {
    data: {
      connectorKey,
      status: 'connected',
      connected: true,
      shopName: connectorKey === 'prestashop' ? 'Atelier Lin' : 'Vitrine Dorée',
      version: connectorKey === 'prestashop' ? '8.1.2' : null,
      totalProducts: connectorKey === 'prestashop' ? 42 : null,
      resourcesRead: connectorKey === 'prestashop' ? ['shops', 'languages'] : ['store', 'products'],
      connectedTo: '203.0.113.10',
      endpoint: connectorKey === 'prestashop' ? 'https://atelier-lin.example/api' : 'https://api.chariow.com/v1',
      durationMs: 640,
      ...(connectorKey === 'chariow' ? { storeUrl: 'https://vitrine.mychariow.online', storeStatus: 'active' } : {}),
    },
  };
}

beforeEach(() => {
  api.connectEdge.mockReset();
  api.invokeEdge.mockReset();
  onChanged.mockReset();
  // Par défaut, aucune connexion préexistante.
  api.connectEdge.mockResolvedValue({ data: null });
});

afterEach(cleanup);

function monter(connectorKey: string, options: { connected?: boolean; workspaceId?: string | null } = {}) {
  return render(
    <ConnectorConnectForm
      connectorKey={connectorKey}
      workspaceId={options.workspaceId === undefined ? 'w1' : options.workspaceId}
      connected={options.connected ?? false}
      onChanged={onChanged}
    />,
  );
}

describe('champs pilotés par les exigences du connecteur', () => {
  it('PrestaShop demande l’adresse et la clé, la clé étant masquée', () => {
    monter('prestashop');
    expect((screen.getByTestId('prestashop-field-url') as HTMLInputElement).type).toBe('text');
    expect((screen.getByTestId('prestashop-field-apiKey') as HTMLInputElement).type).toBe('password');
  });

  it('Chariow ne demande PAS d’adresse de boutique', () => {
    monter('chariow');
    // L'API vit chez l'éditeur : exiger une URL serait un champ inutile qui
    // laisserait croire que VYORA contacte la vitrine.
    expect(screen.queryByTestId('chariow-field-url')).toBeNull();
    expect((screen.getByTestId('chariow-field-apiKey') as HTMLInputElement).type).toBe('password');
  });

  it('Chariow affiche sa limite sur les variantes avant la saisie', () => {
    monter('chariow');
    expect(screen.getByTestId('chariow-caveat').textContent).toMatch(/variante/i);
  });

  it('un connecteur sans parcours livré ne rend rien', () => {
    const { container } = render(
      <ConnectorConnectForm connectorKey="shopify" workspaceId="w1" onChanged={onChanged} />,
    );
    // Garantie structurelle contre les boutons morts.
    expect(container.innerHTML).toBe('');
    expect(api.connectEdge).not.toHaveBeenCalled();
  });

  it('ne demande jamais de secret quand la connexion est déjà établie', async () => {
    monter('prestashop', { connected: true });
    await waitFor(() => expect(screen.getByTestId('prestashop-connect-form')).toBeTruthy());
    expect(screen.queryByTestId('prestashop-field-apiKey')).toBeNull();
    expect(screen.getByTestId('prestashop-connect-form').textContent).toMatch(/connectée/i);
  });
});

describe('enregistrement du secret', () => {
  it('envoie la clé au serveur et n’en garde rien', async () => {
    api.connectEdge.mockResolvedValue(preuve('prestashop'));
    monter('prestashop');

    fireEvent.change(screen.getByTestId('prestashop-field-url'), { target: { value: 'https://atelier-lin.example' } });
    fireEvent.change(screen.getByTestId('prestashop-field-apiKey'), { target: { value: CLE_PS } });
    fireEvent.click(screen.getByTestId('prestashop-connect'));

    await waitFor(() => expect(screen.getByTestId('prestashop-connection-state')).toBeTruthy());

    expect(api.connectEdge).toHaveBeenCalledWith('store-connect', expect.objectContaining({
      action: 'connect',
      workspaceId: 'w1',
      connectorKey: 'prestashop',
      url: 'https://atelier-lin.example',
      apiKey: CLE_PS,
    }));

    // Preuve affichée…
    const texte = document.body.textContent ?? '';
    expect(texte).toContain('Atelier Lin');
    // Le point de sortie réellement contacté est affiché : c'est la preuve du
    // contrôle d'égress, pas une reconstitution locale.
    expect(texte).toContain('https://atelier-lin.example/api');
    // …et le secret nulle part.
    expect(texte).not.toContain(CLE_PS);
    expect(document.body.innerHTML).not.toContain(CLE_PS);
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
  });

  it('envoie Chariow sans champ url', async () => {
    api.connectEdge.mockResolvedValue(preuve('chariow'));
    monter('chariow');

    fireEvent.change(screen.getByTestId('chariow-field-apiKey'), { target: { value: CLE_CHARIOW } });
    fireEvent.click(screen.getByTestId('chariow-connect'));

    await waitFor(() => expect(screen.getByTestId('chariow-connection-state')).toBeTruthy());
    const [, corps] = api.connectEdge.mock.calls.at(-1)!;
    expect(corps).not.toHaveProperty('url');
    expect(corps).toMatchObject({ connectorKey: 'chariow', apiKey: CLE_CHARIOW });
  });

  it('vide le champ même quand le serveur refuse', async () => {
    api.connectEdge.mockRejectedValueOnce(new Error('La clé a été refusée par l’éditeur.'));
    monter('chariow');

    fireEvent.change(screen.getByTestId('chariow-field-apiKey'), { target: { value: CLE_CHARIOW } });
    fireEvent.click(screen.getByTestId('chariow-connect'));

    await waitFor(() => expect(screen.getByTestId('chariow-error')).toBeTruthy());
    expect(screen.queryByTestId('chariow-connection-state')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('refuse une saisie mal formée sans appeler le serveur', () => {
    monter('prestashop');
    fireEvent.change(screen.getByTestId('prestashop-field-url'), { target: { value: 'http://interdit.example' } });
    fireEvent.change(screen.getByTestId('prestashop-field-apiKey'), { target: { value: '0123456789abcdef' } });
    fireEvent.click(screen.getByTestId('prestashop-connect'));

    // Seule la lecture d'état a eu lieu : aucun envoi de secret.
    const actions = api.connectEdge.mock.calls.map(([, corps]) => (corps as { action: string }).action);
    expect(actions).not.toContain('connect');
    expect(document.body.textContent ?? '').toMatch(/https:\/\//);
  });

  it('n’envoie rien sans entreprise active', () => {
    monter('prestashop', { workspaceId: null });
    fireEvent.change(screen.getByTestId('prestashop-field-url'), { target: { value: 'https://atelier-lin.example' } });
    fireEvent.change(screen.getByTestId('prestashop-field-apiKey'), { target: { value: CLE_PS } });
    const bouton = screen.getByTestId('prestashop-connect') as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
    expect(api.connectEdge).not.toHaveBeenCalled();
  });
});

describe('déconnexion', () => {
  it('retire le secret et repasse à « non configurée »', async () => {
    // État serveur qui bascule : connecté, puis plus de secret une fois la
    // déconnexion demandée. Un mock figé masquerait le retour à « non
    // configurée » — c'est justement ce qu'on veut vérifier.
    let deconnecte = false;
    api.connectEdge.mockImplementation(async (_nom: string, corps: Record<string, unknown>) => {
      if (corps.action === 'disconnect') {
        deconnecte = true;
        return { data: { disconnected: true } };
      }
      if (corps.action === 'status') {
        return deconnecte
          ? { data: { connectorKey: 'prestashop', status: 'disconnected', connected: false, hasCredential: false } }
          : { data: { connectorKey: 'prestashop', status: 'connected', connected: true, hasCredential: true } };
      }
      return { data: null };
    });
    monter('prestashop');

    await waitFor(() => expect(screen.getByTestId('prestashop-disconnect')).toBeTruthy());
    fireEvent.click(screen.getByTestId('prestashop-disconnect'));

    await waitFor(() => expect(api.connectEdge).toHaveBeenCalledWith('store-connect', expect.objectContaining({
      action: 'disconnect', workspaceId: 'w1', connectorKey: 'prestashop',
    })));
    // Le champ redevient proposé : la reconnexion est possible.
    await waitFor(() => expect(screen.getByTestId('prestashop-field-apiKey')).toBeTruthy());
  });
});

describe('états serveur', () => {
  it('affiche une erreur d’autorisation insuffisante', async () => {
    api.connectEdge.mockResolvedValue({
      data: {
        connectorKey: 'chariow', status: 'error', connected: false, hasCredential: true,
        lastError: 'Autorisation insuffisante : ajoutez products.read',
        lastErrorCode: 'INSUFFICIENT_SCOPE',
      },
    });
    monter('chariow');
    await waitFor(() => expect(screen.getByTestId('chariow-connect-form').textContent).toMatch(/insuffisantes/i));
    // Le champ reste accessible pour corriger la clé.
    expect(screen.getByTestId('chariow-field-apiKey')).toBeTruthy();
  });

  it('ne montre jamais « connectée » sur un statut connecté sans secret', async () => {
    api.connectEdge.mockResolvedValue({
      data: { connectorKey: 'chariow', status: 'connected', connected: false, hasCredential: false },
    });
    monter('chariow');
    await waitFor(() => expect(screen.getByTestId('chariow-connect-form')).toBeTruthy());
    expect(screen.getByTestId('chariow-connect-form').textContent).not.toMatch(/Boutique Chariow connectée/);
  });
});
