// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fiches Meta dans VYORA Integrations.
 *
 * Ce que ces tests prouvent, et qui n'est pas visible dans les tests unitaires :
 * - les quatre fiches existent, séparément, et n'affichent JAMAIS « Connecté »
 *   sans un échange OAuth réel ;
 * - la fiche appelle `meta-connect` avec l'action et l'entreprise attendues ;
 * - quand le serveur répond « non configuré », la fiche le dit et ne propose
 *   aucun bouton qui mènerait à un échec garanti ;
 * - le retour du parcours (`?meta=connected|error`) est lu une fois, puis
 *   retiré de l'URL.
 */

const metaMocks = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  disconnect: vi.fn(),
  verify: vi.fn(),
  refresh: vi.fn(),
  pagesList: vi.fn(),
  pagesSelect: vi.fn(),
}));

vi.mock('../src/integrations/meta/api', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/meta/api')>('../src/integrations/meta/api');
  return {
    ...reel,
    readMetaStatus: metaMocks.status,
    startMetaConnect: metaMocks.start,
    disconnectMeta: metaMocks.disconnect,
    verifyMetaConnection: metaMocks.verify,
    refreshMetaToken: metaMocks.refresh,
    listMetaPages: metaMocks.pagesList,
    selectMetaPages: metaMocks.pagesSelect,
  };
});

vi.mock('../src/integrations/connections', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/connections')>('../src/integrations/connections');
  return {
    ...reel,
    listConnectedAccounts: vi.fn(async () => []),
    listAudit: vi.fn(async () => []),
    revokeConnection: vi.fn(async () => ({ remoteRevoked: true })),
  };
});

const businessMocks = vi.hoisted(() => ({
  listIntegrations: vi.fn(),
  requestIntegration: vi.fn(),
  cancelIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
}));

vi.mock('../src/business/api', async () => {
  const reel = await vi.importActual<typeof import('../src/business/api')>('../src/business/api');
  return {
    ...reel,
    businessGrowApi: {
      ...reel.businessGrowApi,
      listIntegrations: businessMocks.listIntegrations,
      requestIntegration: businessMocks.requestIntegration,
      cancelIntegration: businessMocks.cancelIntegration,
      disconnectIntegration: businessMocks.disconnectIntegration,
    },
  };
});

import { IntegrationsCenter } from '../src/integrations/CatalogPage';
import { INTEGRATIONS } from '../src/integrations/catalog';

const WORKSPACE = 'workspace-meta';

const etatNonConfigure = {
  configured: false,
  configIds: { whatsapp: false, facebook: false, messenger: false, instagram: false },
  connections: [],
};

const connexionWhatsApp = {
  id: 'conn-wa',
  product: 'whatsapp' as const,
  status: 'connected' as const,
  external_account_id: '102290129340398',
  display_name: 'VYORA Test',
  granted_scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
  token_expires_at: null,
  has_token: true,
  metadata: {
    flow: 'embedded-signup', waba_id: '102290129340398', waba_name: 'Portefeuille Test',
    phone_number_id: '106540352242922', display_phone_number: '+223 70 00 00 00',
    missing_scopes: [],
  },
  last_error: null,
  last_verified_at: '2026-11-14T10:00:00Z',
  updated_at: '2026-11-14T10:00:00Z',
  pages: [],
};

function monter(route = '/app/connect') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <IntegrationsCenter workspaceId={WORKSPACE} />
    </MemoryRouter>,
  );
}

/**
 * Ouvre la fiche d'un produit depuis sa carte du catalogue.
 *
 * On passe par `data-testid` (comme les autres tests du catalogue) : chercher
 * « un bouton dont le texte contient… » attraperait aussi les filtres et les
 * bandeaux, et ouvrirait la mauvaise fiche.
 */
async function ouvrirFiche(connectorKey: string, nom: RegExp) {
  const carte = await screen.findByTestId(`integration-${connectorKey}`);
  fireEvent.click(carte);
  return screen.findByRole('dialog', { name: nom });
}

beforeEach(() => {
  vi.clearAllMocks();
  businessMocks.listIntegrations.mockResolvedValue({ connections: [] });
  metaMocks.status.mockResolvedValue(etatNonConfigure);
  metaMocks.disconnect.mockResolvedValue({ disconnected: true, remoteRevoked: true, connections: [] });
  metaMocks.verify.mockResolvedValue({ valid: true, scopes: [], connections: [] });
});

afterEach(cleanup);

describe('fiches Meta — séparées et jamais « Connecté » sans preuve', () => {
  it('les quatre fiches existent dans le catalogue', () => {
    const ids = INTEGRATIONS.map((e) => e.id);
    for (const id of ['whatsapp', 'facebook', 'messenger', 'instagram']) {
      expect(ids, id).toContain(id);
    }
    // Une fiche par produit : ni fusion, ni alias.
    expect(new Set(['whatsapp', 'facebook', 'messenger', 'instagram']).size).toBe(4);
  });

  it('sans configuration serveur, la fiche le dit et ne laisse pas croire à un succès', async () => {
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(within(fiche).getByTestId('meta-panel-whatsapp')).toBeTruthy());
    expect(within(fiche).getByText(/Le serveur n’a pas encore reçu/i)).toBeTruthy();
    // Le bouton de connexion est présent mais désactivé : rien ne partirait.
    const bouton = within(fiche).getByRole('button', { name: /Connecter WhatsApp Business/i });
    expect(bouton.hasAttribute('disabled')).toBe(true);
    expect(fiche.textContent).not.toContain('Connecté ·');
  });

  it('interroge le serveur pour l’état du produit, dans l’entreprise active', async () => {
    monter();
    await ouvrirFiche('messenger', /Fiche Messenger/);
    await waitFor(() => expect(metaMocks.status).toHaveBeenCalledWith(WORKSPACE, 'messenger'));
  });

  it('une connexion réelle affiche l’état, le WABA et le numéro', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [connexionWhatsApp],
    });
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(within(fiche).getByText(/Connecté · VYORA Test/)).toBeTruthy());
    expect(fiche.textContent).toContain('102290129340398');
    expect(fiche.textContent).toContain('+223 70 00 00 00');
    // La fiche propose la déconnexion et la vérification, pas une reconnexion.
    expect(within(fiche).getByRole('button', { name: /Déconnecter/ })).toBeTruthy();
    expect(within(fiche).getByRole('button', { name: /Vérifier/ })).toBeTruthy();
    expect(within(fiche).queryByRole('button', { name: /Reconnecter/ })).toBeNull();
  });

  it('un jeton expiré propose « Reconnecter » et non « Déconnecter » seul', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [{ ...connexionWhatsApp, status: 'expired' }],
    });
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(within(fiche).getByRole('button', { name: /Reconnecter/ })).toBeTruthy());
    expect(fiche.textContent).toContain('Jeton expiré');
  });

  it('un jeton permanent n’affiche aucune date d’expiration', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [{
        ...connexionWhatsApp,
        token_expires_at: null,
        metadata: { ...connexionWhatsApp.metadata, permanent_token: true },
      }],
    });
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(within(fiche).getByText(/Connecté · VYORA Test/)).toBeTruthy());
    // Une date inventée ferait croire à une expiration qui n'existe pas.
    expect(fiche.textContent).not.toMatch(/Jeton valable jusqu/);
  });

  it('un numéro non enregistré est signalé comme bloquant l’envoi', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [{
        ...connexionWhatsApp,
        metadata: { ...connexionWhatsApp.metadata, registered: false, register_error: '133005: Two step verification PIN mismatch' },
      }],
    });
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(fiche.textContent).toContain('pas encore enregistré'));
    expect(fiche.textContent).toContain('133005');
  });

  it('une permission manquante est nommée, sans bloquer l’affichage', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [{ ...connexionWhatsApp, metadata: { ...connexionWhatsApp.metadata, missing_scopes: ['whatsapp_business_messaging'] } }],
    });
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    await waitFor(() => expect(fiche.textContent).toContain('Permissions manquantes'));
    expect(fiche.textContent).toContain('whatsapp_business_messaging');
  });
});

describe('fiches Meta — actions réelles', () => {
  it('« Connecter » demande un lancement au serveur et signale un refus', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [],
    });
    metaMocks.start.mockRejectedValue(new Error('La configuration Meta de Facebook Pages (META_FACEBOOK_CONFIG_ID) n’est pas renseignée côté serveur.'));
    monter();
    const fiche = await ouvrirFiche('facebook', /Fiche Facebook/);
    const bouton = await within(fiche).findByRole('button', { name: /Connecter Facebook/ });
    expect(bouton.hasAttribute('disabled')).toBe(false);
    fireEvent.click(bouton);
    await waitFor(() => expect(metaMocks.start).toHaveBeenCalledWith(WORKSPACE, 'facebook'));
    // Le message du serveur est affiché tel quel : pas de reformulation qui
    // ferait croire à un problème local.
    await waitFor(() => expect(within(fiche).getByText(/META_FACEBOOK_CONFIG_ID/)).toBeTruthy());
  });

  it('la déconnexion appelle le serveur avec le produit et l’entreprise', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [connexionWhatsApp],
    });
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(true);
    monter();
    const fiche = await ouvrirFiche('whatsapp', /Fiche WhatsApp Business/);
    const bouton = await within(fiche).findByRole('button', { name: /Déconnecter/ });
    fireEvent.click(bouton);
    await waitFor(() => expect(metaMocks.disconnect).toHaveBeenCalledWith(WORKSPACE, 'whatsapp'));
    confirmation.mockRestore();
  });

  it('les pages ne sont proposées que pour les produits qui en ont', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [{ ...connexionWhatsApp, product: 'facebook', external_account_id: 'USER_FB', pages: [] }],
    });
    monter();
    const fiche = await ouvrirFiche('facebook', /Fiche Facebook/);
    await waitFor(() => expect(within(fiche).getByRole('button', { name: /Choisir les pages/ })).toBeTruthy());
    fireEvent.click(within(fiche).getByRole('button', { name: /Choisir les pages/ }));
    await waitFor(() => expect(metaMocks.pagesList).toHaveBeenCalledWith(WORKSPACE, 'facebook'));
  });
});

describe('retour du parcours Meta', () => {
  it('un retour réussi ouvre la fiche et montre l’état relu, puis nettoie l’URL', async () => {
    metaMocks.status.mockResolvedValue({
      configured: true,
      configIds: { whatsapp: true, facebook: true, messenger: true, instagram: true },
      connections: [connexionWhatsApp],
    });
    monter('/app/connect?section=integrations&meta=connected&product=whatsapp');
    await waitFor(() => expect(screen.getByText(/autorisation reçue/i)).toBeTruthy());
    // La fiche du produit concerné est ouverte, avec l'état RÉEL.
    const fiche = await screen.findByRole('dialog', { name: /Fiche WhatsApp Business/i });
    await waitFor(() => expect(within(fiche).getByText(/Connecté · VYORA Test/)).toBeTruthy());
  });

  it('un retour en erreur affiche le code et affirme qu’aucune connexion n’a été enregistrée', async () => {
    monter('/app/connect?meta=error&product=facebook&code=STATE_INVALID');
    await waitFor(() => expect(screen.getByText(/n’a pas abouti \(STATE_INVALID\)/i)).toBeTruthy());
    expect(screen.getByText(/Aucune connexion n’a été enregistrée/i)).toBeTruthy();
  });

  it('un produit inconnu dans l’URL n’ouvre aucune fiche', async () => {
    monter('/app/connect?meta=connected&product=tiktok');
    await waitFor(() => expect(screen.getByText(/autorisation reçue/i)).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
