// @vitest-environment jsdom
/**
 * Page « Connexions MCP » — les deux sections, et le départ OAuth.
 *
 * Ce que ces tests prouvent :
 *
 *   - les deux sens du protocole sont sur l'écran, sous deux titres distincts ;
 *   - le bouton « Autoriser » n'apparaît QUE pour une connexion OAuth ;
 *   - un démarrage OAuth réussi envoie le navigateur vers l'URL du serveur, et
 *     ne stocke aucun jeton côté navigateur ;
 *   - un refus du serveur (PKCE non supporté, découverte impossible) est
 *     affiché tel quel, sans message générique.
 *
 * Ce qu'ils ne prouvent pas : le réseau. `demarrerOAuth` est simulé ; le flux
 * réel est couvert par `mcp-oauth.test.ts` contre un serveur HTTP local.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listerServeurs: vi.fn(),
  creerServeur: vi.fn(),
  testerConnexion: vi.fn(),
  definirPermission: vi.fn(),
  revoquerServeur: vi.fn(),
  executerOutil: vi.fn(),
  demarrerOAuth: vi.fn(),
  revoquerOAuth: vi.fn(),
  getWorkspaces: vi.fn(),
  // Le MCP entrant a ses propres appels : tous simulés ici.
  listerJetons: vi.fn(),
  listerEvenements: vi.fn(),
  creerJeton: vi.fn(),
  revoquerJeton: vi.fn(),
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
    executerOutil: mocks.executerOutil,
    demarrerOAuth: mocks.demarrerOAuth,
    revoquerOAuth: mocks.revoquerOAuth,
  };
});

vi.mock('../src/lib/api', async () => {
  const reel = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...reel, getWorkspaces: mocks.getWorkspaces };
});

vi.mock('../src/mcp/api', async () => {
  const reel = await vi.importActual<typeof import('../src/mcp/api')>('../src/mcp/api');
  return {
    ...reel,
    listerJetons: mocks.listerJetons,
    listerEvenements: mocks.listerEvenements,
    creerJeton: mocks.creerJeton,
    revoquerJeton: mocks.revoquerJeton,
  };
});

import { ConnexionsMcpPage } from '../src/integrations/ConnexionsMcpPage';
import { ErreurGestion } from '../src/mcp/serveurs';

const WS_ID = '44444444-4444-4444-4444-444444444444';

function serveur(partiel: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    workspaceId: WS_ID,
    nom: 'CRM de test',
    url: 'https://crm.example/mcp',
    authKind: 'bearer',
    aSecret: true,
    status: 'connected',
    protocolVersion: '2025-06-18',
    serverName: 'crm',
    serverVersion: '1',
    outils: [{ name: 'list_contacts', description: 'Liste les contacts.', lecture: true }],
    toolPermissions: { list_contacts: 'allowed' },
    dernierTestAt: null,
    derniereErreur: null,
    createdAt: '2026-11-14T00:00:00Z',
    revokedAt: null,
    oauthClientId: null,
    authorizationServer: null,
    oauthExpireLe: null,
    oauthScope: null,
    ...partiel,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorkspaces.mockResolvedValue([{ id: WS_ID, nom: 'Espace de test' }]);
  mocks.listerServeurs.mockResolvedValue([serveur()]);
  mocks.listerJetons.mockResolvedValue([]);
  mocks.listerEvenements.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('Page « Connexions MCP » — deux sections', () => {
  it('présente les deux sens du protocole sous deux titres distincts', async () => {
    render(<ConnexionsMcpPage />);
    expect(screen.getByRole('heading', { name: 'Connexions MCP', level: 1 })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Connecter SORAHNEX à mes IA' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Connecter mes applications à SORAHNEX' })).toBeTruthy();
  });

  it('n’affiche qu’une seule fois l’en-tête de page (pas de titre imbriqué)', async () => {
    render(<ConnexionsMcpPage />);
    await screen.findByRole('heading', { name: 'Connecter mes applications à SORAHNEX' });
    // Les deux composants embarqués reçoivent `sansEnTete` : aucun second h1.
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('Section B — autorisation OAuth', () => {
  it('propose « Autoriser » sur une connexion OAuth', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: false })]);
    render(<ConnexionsMcpPage />);
    expect(await screen.findByRole('button', { name: 'Autoriser via OAuth' })).toBeTruthy();
  });

  it('ne propose PAS d’autorisation OAuth sur une connexion Bearer', async () => {
    render(<ConnexionsMcpPage />);
    await screen.findByText('CRM de test');
    expect(screen.queryByRole('button', { name: /via OAuth$/ })).toBeNull();
  });

  it('envoie le navigateur vers l’URL d’autorisation et ne garde aucun jeton', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: false })]);
    mocks.demarrerOAuth.mockResolvedValue({
      autorisationUrl: 'https://as.example/authorize?client_id=c&code_challenge=x',
      state: 'etat-1',
      serveurAutorisation: 'https://as.example',
      portees: ['mcp:read'],
      clientEnregistre: true,
      pkceAnnonce: true,
    });

    const assigner = vi.fn();
    const original = window.location;
    // `window.location.assign` n'est pas remplaçable directement : on substitue
    // l'objet location pour observer la navigation sans quitter le test.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign: assigner },
    });

    try {
      render(<ConnexionsMcpPage />);
      fireEvent.click(await screen.findByRole('button', { name: 'Autoriser via OAuth' }));
      await waitFor(() => expect(assigner).toHaveBeenCalledTimes(1));
      expect(assigner).toHaveBeenCalledWith('https://as.example/authorize?client_id=c&code_challenge=x');
      // Aucun stockage navigateur n'est utilisé par ce parcours. jsdom peut
      // exposer un stockage opaque selon l'origine ; son absence signifie aussi
      // qu'aucun jeton n'a pu y être écrit.
      expect(window.localStorage?.getItem('oauth') ?? null).toBeNull();
      expect(window.sessionStorage?.getItem('oauth') ?? null).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('affiche le motif réel du refus, pas un message générique', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: false })]);
    mocks.demarrerOAuth.mockRejectedValue(new ErreurGestion(
      'Ce serveur d’autorisation n’accepte pas PKCE S256.',
      'pkce_non_supporte',
      422,
    ));
    render(<ConnexionsMcpPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Autoriser via OAuth' }));
    expect(await screen.findByText(/n’accepte pas PKCE S256/)).toBeTruthy();
  });
});

describe('Section B — retrait de l’accès OAuth (P6d)', () => {
  it('propose « Retirer l’accès » seulement quand un jeton OAuth existe', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: false, status: 'auth_required' })]);
    render(<ConnexionsMcpPage />);
    await screen.findByRole('button', { name: 'Autoriser via OAuth' });
    expect(screen.queryByRole('button', { name: 'Retirer l’accès OAuth' })).toBeNull();
  });

  it('appelle la route de révocation et affiche le résultat DISTANT tel quel', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: true, oauthExpireLe: '2026-12-01T00:00:00Z' })]);
    mocks.revoquerOAuth.mockResolvedValue({ ok: true, distant: 'indisponible', jetonsDetruits: 1, status: 'auth_required' });
    render(<ConnexionsMcpPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retirer l’accès OAuth' }));
    await waitFor(() => expect(mocks.revoquerOAuth).toHaveBeenCalledWith('33333333-3333-3333-3333-333333333333'));
    // « indisponible » n'est pas présenté comme un succès complet.
    expect(await screen.findByText(/n’expose pas de révocation/)).toBeTruthy();
    // La liste est relue : la connexion n'a pas disparu.
    await waitFor(() => expect(mocks.listerServeurs).toHaveBeenCalledTimes(2));
  });

  it('un refus du fournisseur est affiché, pas masqué', async () => {
    mocks.listerServeurs.mockResolvedValue([serveur({ authKind: 'oauth', aSecret: true })]);
    mocks.revoquerOAuth.mockResolvedValue({ ok: true, distant: 'refuse', detailDistant: 'Révocation refusée (statut 400).', jetonsDetruits: 2, status: 'auth_required' });
    render(<ConnexionsMcpPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retirer l’accès OAuth' }));
    expect(await screen.findByText(/le fournisseur a refusé la révocation/)).toBeTruthy();
    expect(screen.getByText(/Révocation refusée \(statut 400\)/)).toBeTruthy();
  });
});

describe('Section B — création OAuth sans jeton (P6d)', () => {
  it('en mode OAuth, le formulaire n’exige plus de secret et explique « Autoriser »', async () => {
    mocks.creerServeur.mockResolvedValue({ serverId: 'n', serveur: null });
    render(<ConnexionsMcpPage />);
    await screen.findByText('CRM de test');
    fireEvent.click(screen.getByRole('button', { name: /Ajouter un serveur/ }));
    fireEvent.change(screen.getByLabelText(/Nom/), { target: { value: 'Linear' } });
    fireEvent.change(screen.getByLabelText(/URL du serveur/), { target: { value: 'https://mcp.linear.app/mcp' } });
    fireEvent.change(screen.getByLabelText(/Authentification/), { target: { value: 'oauth' } });
    expect(screen.getByText(/Aucun jeton à coller/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    await waitFor(() => expect(mocks.creerServeur).toHaveBeenCalledTimes(1));
    const envoi = mocks.creerServeur.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(envoi.authKind).toBe('oauth');
    expect('secret' in envoi).toBe(false);
  });
});
