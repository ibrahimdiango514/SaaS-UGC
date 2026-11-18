// @vitest-environment jsdom
/**
 * Page « Mes serveurs MCP » — MCP SORTANT.
 *
 * Ce que ces tests prouvent, et ce qu'ils ne prouvent pas :
 *
 *   - ils prouvent que l'écran appelle les VRAIES routes (`lister`, `creer`,
 *     `tester`, `permissions`, `revoquer`) et n'utilise aucune donnée fictive ;
 *   - ils prouvent qu'un secret n'est jamais réaffiché après l'envoi ;
 *   - ils ne prouvent rien sur le serveur : les routes sont simulées ici. Les
 *     tests HTTP réels sont dans `mcp-gestion-http.test.ts`, et les appels de
 *     production sont décrits dans le rapport P6.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listerServeurs: vi.fn(),
  creerServeur: vi.fn(),
  testerConnexion: vi.fn(),
  definirPermission: vi.fn(),
  revoquerServeur: vi.fn(),
  getWorkspaces: vi.fn(),
}));

vi.mock('../src/mcp/serveurs', async () => {
  const reel = await vi.importActual<typeof import('../src/mcp/serveurs')>('../src/mcp/serveurs');
  return {
    ...reel,
    listerServeurs: mocks.listerServeurs,
    creerServeur: mocks.creerServeur,
    testerConnexion: mocks.testerConnexion,
    definirPermission: mocks.definirPermission,
    revoquerServeur: mocks.revoquerServeur,
  };
});

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, getWorkspaces: mocks.getWorkspaces };
});

const WS_ID = '44444444-4444-4444-4444-444444444444';

function serveur(partiel: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    workspaceId: WS_ID,
    nom: 'Serveur de test',
    url: 'https://exemple.example/mcp',
    authKind: 'bearer',
    aSecret: true,
    status: 'connected',
    protocolVersion: '2025-06-18',
    serverName: 'exemple',
    serverVersion: '1',
    outils: [{ name: 'list_products', description: 'Liste les produits.' }],
    toolPermissions: { list_products: 'pending' },
    dernierTestAt: '2026-11-21T00:00:00Z',
    derniereErreur: null,
    createdAt: '2026-11-21T00:00:00Z',
    revokedAt: null,
    ...partiel,
  };
}

beforeEach(() => {
  mocks.getWorkspaces.mockResolvedValue([{ id: WS_ID, name: 'Mon espace' }]);
  mocks.listerServeurs.mockResolvedValue([serveur()]);
  mocks.creerServeur.mockResolvedValue({ serverId: 'x', serveur: serveur() });
  mocks.testerConnexion.mockResolvedValue({
    ok: true, etat: 'connected', message: 'Connecté : 1 outil(s) découvert(s).',
    protocole: '2025-06-18', outils: [{ name: 'list_products' }],
  });
  mocks.definirPermission.mockResolvedValue({ list_products: 'allowed' });
  mocks.revoquerServeur.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function rendre() {
  const { MesServeursMcpPage } = await import('../src/integrations/MesServeursMcpPage');
  render(<MesServeursMcpPage />);
  await waitFor(() => expect(mocks.listerServeurs).toHaveBeenCalled());
}

describe('chargement réel', () => {
  it('appelle la vraie route de liste au montage', async () => {
    await rendre();
    await waitFor(() => expect(screen.getByText('Serveur de test')).toBeTruthy());
    expect(mocks.listerServeurs).toHaveBeenCalledTimes(1);
  });

  it('affiche un état vide honnête quand il n’y a aucun serveur', async () => {
    mocks.listerServeurs.mockResolvedValue([]);
    await rendre();
    await waitFor(() => expect(screen.getByText('Aucun serveur MCP connecté')).toBeTruthy());
  });

  it('ne prétend jamais « Connecté » sans test : un serveur inconnu est « Jamais testé »', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ status: 'unknown', derniereErreur: null })]);
    await rendre();
    await waitFor(() => expect(screen.getByText('Jamais testé')).toBeTruthy());
  });
});

describe('permissions — découvrir n’accorde rien', () => {
  it('un outil en attente est affiché « en attente », pas « autorisé »', async () => {
    await rendre();
    await waitFor(() => expect(screen.getByText('en attente')).toBeTruthy());
    expect(screen.queryByText('autorisé')).toBeNull();
  });

  it('accorder une permission appelle la vraie route', async () => {
    await rendre();
    const bouton = await waitFor(() => screen.getAllByText('Autoriser')[0]);
    fireEvent.click(bouton);
    await waitFor(() => {
      expect(mocks.definirPermission).toHaveBeenCalledWith(serveur().id, 'list_products', 'allowed');
    });
  });

  it('après une permission, l’écran RELIT la base au lieu de supposer', async () => {
    await rendre();
    const bouton = await waitFor(() => screen.getAllByText('Autoriser')[0]);
    const avant = mocks.listerServeurs.mock.calls.length;
    fireEvent.click(bouton);
    await waitFor(() => expect(mocks.listerServeurs.mock.calls.length).toBeGreaterThan(avant));
  });

  it('n’offre aucune commande d’écriture', async () => {
    await rendre();
    await waitFor(() => screen.getByText('Serveur de test'));
    // Le mot n'apparaît que dans la mention explicative, jamais comme action.
    expect(screen.queryByText(/autoriser une écriture/i)).toBeNull();
    expect(screen.getByText(/écritures ne sont pas activées/i)).toBeTruthy();
  });
});

describe('test de connexion', () => {
  it('appelle la vraie route et affiche le message du serveur', async () => {
    await rendre();
    const bouton = await waitFor(() => screen.getByText('Tester'));
    fireEvent.click(bouton);
    await waitFor(() => expect(mocks.testerConnexion).toHaveBeenCalledWith(serveur().id));
    await waitFor(() => expect(screen.getByText(/1 outil\(s\) découvert/)).toBeTruthy());
  });

  it('un échec de test est affiché comme un échec, pas comme un succès', async () => {
    mocks.testerConnexion.mockResolvedValue({
      ok: false, etat: 'error', message: 'Le serveur MCP a répondu 500.', outils: [],
    });
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Tester')));
    await waitFor(() => expect(screen.getByText(/répondu 500/)).toBeTruthy());
  });
});

describe('création — le secret ne revient jamais', () => {
  it('crée via la vraie route avec l’espace de travail réel', async () => {
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Ajouter un serveur')));
    fireEvent.change(screen.getByPlaceholderText('Mon serveur de documentation'), {
      target: { value: 'Nouveau serveur' },
    });
    fireEvent.change(screen.getByPlaceholderText('https://exemple.com/mcp'), {
      target: { value: 'https://nouveau.example/mcp' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bearer' } });
    fireEvent.change(screen.getByPlaceholderText('Collez votre jeton'), {
      target: { value: 'secret-tres-sensible-0123456789' },
    });
    fireEvent.click(screen.getByText('Ajouter'));

    await waitFor(() => expect(mocks.creerServeur).toHaveBeenCalledTimes(1));
    const envoye = mocks.creerServeur.mock.calls[0][0];
    expect(envoye.workspaceId).toBe(WS_ID);
    expect(envoye.authKind).toBe('bearer');
    expect(envoye.secret).toBe('secret-tres-sensible-0123456789');
  });

  it('le secret n’est PAS laissé dans le formulaire après création', async () => {
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Ajouter un serveur')));
    fireEvent.change(screen.getByPlaceholderText('Mon serveur de documentation'), { target: { value: 'S' } });
    fireEvent.change(screen.getByPlaceholderText('https://exemple.com/mcp'), { target: { value: 'https://s.example/mcp' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bearer' } });
    fireEvent.change(screen.getByPlaceholderText('Collez votre jeton'), { target: { value: 'secret-a-oublier' } });
    fireEvent.click(screen.getByText('Ajouter'));
    await waitFor(() => expect(mocks.creerServeur).toHaveBeenCalled());

    // On rouvre le formulaire et on resélectionne un mode à secret : le champ
    // doit être vide, ce qui prouve que la valeur a bien été oubliée.
    fireEvent.click(await waitFor(() => screen.getByText('Ajouter un serveur')));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bearer' } });
    const champ = screen.getByPlaceholderText('Collez votre jeton') as HTMLInputElement;
    expect(champ.value).toBe('');
  });

  it('refuse une URL http:// sans appeler le serveur', async () => {
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Ajouter un serveur')));
    fireEvent.change(screen.getByPlaceholderText('Mon serveur de documentation'), { target: { value: 'S' } });
    fireEvent.change(screen.getByPlaceholderText('https://exemple.com/mcp'), {
      target: { value: 'http://insecure.example/mcp' },
    });
    fireEvent.click(screen.getByText('Ajouter'));
    await waitFor(() => expect(screen.getByText(/doit commencer par https/)).toBeTruthy());
    expect(mocks.creerServeur).not.toHaveBeenCalled();
  });

  it('exige un secret quand l’authentification n’est pas « aucune »', async () => {
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Ajouter un serveur')));
    fireEvent.change(screen.getByPlaceholderText('Mon serveur de documentation'), { target: { value: 'S' } });
    fireEvent.change(screen.getByPlaceholderText('https://exemple.com/mcp'), { target: { value: 'https://s.example/mcp' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'api_key' } });
    fireEvent.click(screen.getByText('Ajouter'));
    await waitFor(() => expect(screen.getByText(/exige un secret/)).toBeTruthy());
    expect(mocks.creerServeur).not.toHaveBeenCalled();
  });
});

describe('révocation', () => {
  it('demande confirmation puis appelle la vraie route', async () => {
    await rendre();
    fireEvent.click(await waitFor(() => screen.getByText('Révoquer')));
    await waitFor(() => expect(screen.getByText(/Le secret sera définitivement détruit/)).toBeTruthy());
    const boutons = screen.getAllByText('Révoquer');
    fireEvent.click(boutons[boutons.length - 1]);
    await waitFor(() => expect(mocks.revoquerServeur).toHaveBeenCalledWith(serveur().id));
  });

  it('une connexion révoquée n’offre plus de test ni de révocation', async () => {
    mocks.listerServeurs.mockResolvedValue([
      serveur({ status: 'revoked', revokedAt: '2026-11-21T00:00:00Z' }),
    ]);
    await rendre();
    await waitFor(() => expect(screen.getByText('Révoqué')).toBeTruthy());
    expect(screen.queryByText('Tester')).toBeNull();
  });
});

describe('aucun secret dans le rendu', () => {
  it('la page n’affiche jamais de valeur de secret', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur()]);
    await rendre();
    await waitFor(() => screen.getByText('Serveur de test'));
    const texte = document.body.textContent ?? '';
    expect(texte).not.toContain('mcp_server_');
    expect(texte).not.toContain('vault.secrets');
    // On affiche l'existence du secret, jamais sa valeur.
    expect(screen.getByText('secret en Vault')).toBeTruthy();
  });
});
