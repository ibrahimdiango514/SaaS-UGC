// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetaTestFlowPanel } from '../src/integrations/MetaTestFlowPanel';

/**
 * Panneau du parcours de test — ce qu'il montre et ce qu'il cache.
 *
 * Deux erreurs seraient graves ici :
 *  1. afficher quelque chose à un client non administrateur. Le serveur répond
 *     404 exprès pour ne pas révéler l'existence du parcours ; un panneau qui
 *     afficherait « réservé à l'administrateur » annulerait cet effort ;
 *  2. afficher « Connecté » alors que le serveur ne l'a pas dit.
 */

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../src/integrations/meta/api', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/meta/api')>('../src/integrations/meta/api');
  return {
    ...reel,
    readMetaTestFlow: mocks.read,
    connectMetaTestFlow: mocks.connect,
    disconnectMetaTestFlow: mocks.disconnect,
  };
});

const WS = '1e1fd8bb-6ad4-4ae2-8e99-bf48373fce1b';

const DISPONIBLE = {
  testFlow: {
    available: true,
    reason: null,
    wabaId: '102290129340398',
    phoneNumberId: '106540352242922',
    displayPhoneNumber: '+1 555 000 0000',
  },
  connection: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('MetaTestFlowPanel — visibilité', () => {
  it('n’affiche RIEN quand le serveur refuse (404 pour un client)', async () => {
    // Un client non administrateur : réponse 404, donc aucune trace à l'écran.
    mocks.read.mockRejectedValue(Object.assign(new Error('introuvable'), { code: 'TEST_FLOW_UNAVAILABLE' }));
    const { container } = render(<MetaTestFlowPanel workspaceId={WS} />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    // Aucun mot qui trahirait l'existence du parcours.
    expect(container.textContent).not.toMatch(/admin|test/i);
  });

  it('n’affiche rien non plus sans entreprise sélectionnée', async () => {
    const { container } = render(<MetaTestFlowPanel workspaceId={null} />);
    expect(container.textContent).toBe('');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('affiche l’état et les identifiants imposés quand le parcours est ouvert', async () => {
    mocks.read.mockResolvedValue(DISPONIBLE);
    render(<MetaTestFlowPanel workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText(/Parcours de test/)).toBeTruthy());
    expect(screen.getByText('102290129340398')).toBeTruthy();
    expect(screen.getByText(/106540352242922/)).toBeTruthy();
    // Aucun « Connecté » : le serveur n'a rien dit de tel.
    expect(document.body.textContent).not.toContain('Connecté');
  });

  it('explique pourquoi le parcours est fermé, sans citer de secret', async () => {
    mocks.read.mockResolvedValue({
      testFlow: { ...DISPONIBLE.testFlow, available: false, reason: 'Parcours de test indisponible : META_TEST_FLOW_ENABLED manquant(s).' },
      connection: null,
    });
    render(<MetaTestFlowPanel workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText(/META_TEST_FLOW_ENABLED manquant/)).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/EAA[A-Za-z0-9]{8,}/);
  });

  it('signale un compte non abonné aux webhooks — la cause d’un parcours muet', async () => {
    mocks.read.mockResolvedValue({
      ...DISPONIBLE,
      connection: {
        status: 'connected', flow: 'test-number', wabaId: '102290129340398',
        phoneNumberId: '106540352242922', displayPhoneNumber: '+1 555 000 0000',
        webhookSubscribed: false, lastError: null,
      },
    });
    render(<MetaTestFlowPanel workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText(/non abonné/)).toBeTruthy());
  });
});

describe('MetaTestFlowPanel — actions', () => {
  it('connecte puis affiche l’avertissement renvoyé par le serveur', async () => {
    mocks.read.mockResolvedValue(DISPONIBLE);
    mocks.connect.mockResolvedValue({
      connected: true,
      wabaId: '102290129340398',
      phoneNumberId: '106540352242922',
      displayPhoneNumber: '+1 555 000 0000',
      webhookSubscribed: false,
      warning: 'Le compte WhatsApp n’est pas abonné aux webhooks : aucun message ne sera reçu.',
      connections: [],
    });
    const onChanged = vi.fn();
    render(<MetaTestFlowPanel workspaceId={WS} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /Connecter le numéro de test/ }));
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledWith(WS));
    await waitFor(() => expect(screen.getByText(/n’est pas abonné aux webhooks/)).toBeTruthy());
    expect(onChanged).toHaveBeenCalledWith({ tone: 'success', text: 'Parcours de test connecté.' });
  });

  it('affiche l’erreur serveur telle quelle, sans la masquer', async () => {
    mocks.read.mockResolvedValue(DISPONIBLE);
    mocks.connect.mockRejectedValue(
      new Error('Le numéro 106540352242922 n’appartient pas au compte WhatsApp 102290129340398 : rien n’a été enregistré.'),
    );
    render(<MetaTestFlowPanel workspaceId={WS} />);
    fireEvent.click(await screen.findByRole('button', { name: /Connecter le numéro de test/ }));
    await waitFor(() => expect(screen.getByText(/n’appartient pas au compte WhatsApp/)).toBeTruthy());
  });

  it('propose de retirer la connexion seulement si elle vient du test', async () => {
    mocks.read.mockResolvedValue({
      ...DISPONIBLE,
      connection: {
        status: 'connected', flow: 'embedded-signup', wabaId: '102290129340398',
        phoneNumberId: '106540352242922', displayPhoneNumber: '+1 555 000 0000',
        webhookSubscribed: true, lastError: null,
      },
    });
    render(<MetaTestFlowPanel workspaceId={WS} />);
    await waitFor(() => expect(screen.getByText(/Parcours de test/)).toBeTruthy());
    // L'état dit explicitement d'où vient la connexion.
    expect(document.body.textContent).toMatch(/parcours client/);
    // Une vraie connexion client ne se supprime pas depuis ce panneau.
    expect(screen.queryByRole('button', { name: /Retirer la connexion de test/ })).toBeNull();
  });
});
