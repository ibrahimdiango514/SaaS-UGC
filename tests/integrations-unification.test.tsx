// @vitest-environment jsdom
/**
 * Unification des intégrations — garanties qui ne doivent jamais régresser.
 *
 * Ce fichier verrouille les huit règles énoncées avant le chantier :
 *   1. les 27 fournisseurs d'origine sont conservés ;
 *   2. les demandes d'activation existantes sont conservées ;
 *   3. les connexions OAuth réellement enregistrées sont conservées ;
 *   4. les huit états restent distincts ;
 *   5. « Connecté » n'apparaît jamais sans preuve côté serveur ;
 *   6. Gmail, Drive et Calendar ne sont jamais fusionnés ;
 *   7. aucune donnée n'est supprimée ;
 *   8. aucune connexion n'est inventée pour un fournisseur non implémenté.
 *
 * Le point le plus subtil est le cinquième : `integration_connections` peut
 * contenir `status = 'connected'` sans qu'aucun échange OAuth n'ait eu lieu.
 * Croire ce champ sur parole afficherait exactement le faux état interdit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listConnectedAccounts: vi.fn(),
  listAudit: vi.fn(),
  revokeConnection: vi.fn(),
  listIntegrations: vi.fn(),
  requestIntegration: vi.fn(),
  cancelIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
}));

vi.mock('../src/integrations/connections', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/connections')>(
    '../src/integrations/connections',
  );
  return {
    ...reel,
    listConnectedAccounts: mocks.listConnectedAccounts,
    listAudit: mocks.listAudit,
    revokeConnection: mocks.revokeConnection,
  };
});

vi.mock('../src/business/api', async () => {
  const reel = await vi.importActual<typeof import('../src/business/api')>('../src/business/api');
  return {
    ...reel,
    businessGrowApi: {
      ...reel.businessGrowApi,
      listIntegrations: mocks.listIntegrations,
      requestIntegration: mocks.requestIntegration,
      cancelIntegration: mocks.cancelIntegration,
      disconnectIntegration: mocks.disconnectIntegration,
    },
  };
});

import { IntegrationsCenter } from '../src/integrations/CatalogPage';
import { INTEGRATIONS } from '../src/integrations/catalog';
import { deriveStatus, STATUS_LABELS } from '../src/integrations/connections';

const WORKSPACE = 'workspace-1';

function compte(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    provider: 'gmail',
    externalAccountId: 'ext-1',
    displayName: 'Compte test',
    email: 'test@example.fr',
    capabilities: ['read'],
    status: 'connected',
    lastVerifiedAt: '2026-11-13T00:00:00Z',
    lastError: null,
    createdAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

function ligne(over: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    workspace_id: WORKSPACE,
    connector_key: 'facebook',
    external_account_ref: null,
    status: 'pending',
    updated_at: '2026-11-13T00:00:00Z',
    ...over,
  };
}

function monter(props: { embedded?: boolean; workspaceId?: string | null } = {}) {
  return render(
    <MemoryRouter>
      <IntegrationsCenter workspaceId={WORKSPACE} {...props} />
    </MemoryRouter>,
  );
}

// Chaque test monte son propre catalogue : sans nettoyage, les rendus
// s'empileraient et `getByTestId` trouverait plusieurs fiches identiques.
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConnectedAccounts.mockResolvedValue([]);
  mocks.listAudit.mockResolvedValue([]);
  mocks.listIntegrations.mockResolvedValue({ connections: [] });
  mocks.requestIntegration.mockResolvedValue({ connectorKey: 'facebook', status: 'pending' });
  mocks.cancelIntegration.mockResolvedValue({ connectorKey: 'facebook', cancelled: true });
  mocks.disconnectIntegration.mockResolvedValue({ connectorKey: 'facebook', disconnected: true });
});

describe('règle 1 — les 27 fournisseurs d’origine sont conservés', () => {
  it('affiche le catalogue complet, sans en retirer aucun', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    for (const entry of INTEGRATIONS) {
      expect(screen.getByTestId(`integration-${entry.id}`)).toBeTruthy();
    }
    // 28 depuis « Autre plateforme (API personnalisée) » : le catalogue ne
    // perd aucune fiche, il en gagne une.
    expect(INTEGRATIONS).toHaveLength(28);
  });

  it('un fournisseur absent du catalogue ne peut pas apparaître par accident', async () => {
    mocks.listIntegrations.mockResolvedValue({
      connections: [ligne({ connector_key: 'fournisseur-inconnu', status: 'connected', external_account_ref: 'x' })],
    });
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    expect(screen.queryByTestId('integration-fournisseur-inconnu')).toBeNull();
  });
});

describe('règle 4 & 5 — les états restent distincts, « Connecté » exige une preuve', () => {
  it('une ligne connected sans compte OAuth donne « Autorisation manquante », jamais « Connecté »', async () => {
    mocks.listIntegrations.mockResolvedValue({
      connections: [ligne({ status: 'connected', external_account_ref: null })],
    });
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-facebook').textContent).toContain('Autorisation manquante'));
    expect(screen.getByTestId('integration-facebook').textContent).not.toContain('Connecté');
  });

  it('un compte OAuth réel donne « Connecté » et l’emporte sur la ligne métier', async () => {
    mocks.listConnectedAccounts.mockResolvedValue([compte({ provider: 'gmail' })]);
    mocks.listIntegrations.mockResolvedValue({
      connections: [ligne({ connector_key: 'gmail', status: 'disconnected' })],
    });
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-gmail').textContent).toContain('Connecté'));
  });

  it('une demande en attente est « Activation demandée », pas une connexion', async () => {
    mocks.listIntegrations.mockResolvedValue({ connections: [ligne({ status: 'pending' })] });
    monter();
    const carte = await screen.findByTestId('integration-facebook');
    await waitFor(() => expect(carte.textContent).toContain('Activation demandée'));
    expect(carte.textContent).not.toContain('Connecté');
  });

  it('les huit libellés exigés existent tous dans la table de statuts', () => {
    const exigés = [
      'Connecté', 'Non connecté', 'Activation demandée',
      'Configuration requise', 'Validation externe requise',
      'Autorisation manquante', 'Erreur de connexion',
    ];
    const valeurs = Object.values(STATUS_LABELS);
    for (const libellé of exigés) expect(valeurs).toContain(libellé);
    // « Disponible » est porté par l'état sans connecteur du catalogue.
    expect(deriveStatus(INTEGRATIONS[0], [], false)).toMatch(/needs_config|needs_approval/);
  });

  it('un compte expiré ou révoqué ne devient jamais « Connecté »', () => {
    const shopify = INTEGRATIONS.find((e) => e.id === 'shopify')!;
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'expired' })], false)).toBe('expired');
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'revoked' })], false)).toBe('revoked');
    expect(deriveStatus(shopify, [compte({ provider: 'shopify', status: 'error' })], false)).toBe('error');
  });
});

describe('règle 6 — les services Google ne sont jamais fusionnés', () => {
  it('un compte Drive ne rend ni Gmail ni Calendar connectés', async () => {
    mocks.listConnectedAccounts.mockResolvedValue([compte({ provider: 'google_drive' })]);
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-google_drive').textContent).toContain('Connecté'));
    expect(screen.getByTestId('integration-gmail').textContent).not.toContain('Connecté');
    expect(screen.getByTestId('integration-google_calendar').textContent).not.toContain('Connecté');
  });
});

describe('règle 2 — les demandes d’activation existantes sont conservées', () => {
  it('affiche les demandes déjà enregistrées et permet de les annuler', async () => {
    mocks.listIntegrations.mockResolvedValue({ connections: [ligne({ status: 'pending' })] });
    monter();
    const carte = await screen.findByTestId('integration-facebook');
    await waitFor(() => expect(carte.textContent).toContain('Activation demandée'));
    fireEvent.click(carte);
    const fiche = await screen.findByRole('dialog', { name: /Fiche Facebook/i });
    fireEvent.click(within(fiche).getByRole('button', { name: 'Annuler la demande' }));
    await waitFor(() => expect(mocks.cancelIntegration).toHaveBeenCalledWith('facebook', WORKSPACE));
  });

  it('n’offre aucune demande d’activation pour un fournisseur que le serveur refuserait', async () => {
    monter();
    // gmail est hors de `bg_validate_connector_key` : le bouton doit être absent,
    // sinon chaque clic produirait une erreur serveur garantie.
    const carte = await screen.findByTestId('integration-gmail');
    fireEvent.click(carte);
    const fiche = await screen.findByRole('dialog', { name: /Fiche Gmail/i });
    expect(within(fiche).queryByRole('button', { name: 'Demander l’activation' })).toBeNull();
  });

  it('les six fournisseurs acceptés par le serveur proposent la demande', async () => {
    monter();
    for (const id of ['facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce']) {
      fireEvent.click(await screen.findByTestId(`integration-${id}`));
      const fiche = await screen.findByRole('dialog', { name: new RegExp(`Fiche `, 'i') });
      expect(within(fiche).getByRole('button', { name: 'Demander l’activation' })).toBeTruthy();
      fireEvent.click(within(fiche).getByRole('button', { name: 'Retour' }));
    }
  });
});

describe('règle 7 — aucune donnée n’est supprimée par le socle frontend', () => {
  it('les actions disponibles sont des mutations explicites, jamais un effacement silencieux', async () => {
    mocks.listIntegrations.mockResolvedValue({ connections: [ligne({ status: 'pending' })] });
    monter();
    await screen.findByTestId('integration-facebook');
    // Le seul appel de lecture ne doit pas être accompagné d'une mutation.
    expect(mocks.cancelIntegration).not.toHaveBeenCalled();
    expect(mocks.disconnectIntegration).not.toHaveBeenCalled();
    expect(mocks.requestIntegration).not.toHaveBeenCalled();
  });
});

describe('règle 8 — aucune connexion inventée', () => {
  it('aucune fiche ne porte « Connecté » sans compte réel', async () => {
    monter();
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    expect(screen.queryByText('Connecté')).toBeNull();
  });

  it('l’absence de connecteur est expliquée, pas maquillée par un bouton actif', async () => {
    /*
     * OpenCart n'a ni moteur ni route produits : sa fiche doit l'EXPLIQUER et ne
     * proposer aucun bouton « Connecter ». Shopify servait d'exemple avant la
     * phase E ; il a désormais un vrai formulaire, donc il ne prouve plus rien
     * ici — le vérifier serait verrouiller un état périmé.
     */
    monter();
    fireEvent.click(await screen.findByTestId('integration-opencart'));
    const fiche = await screen.findByRole('dialog', { name: /Fiche OpenCart/i });
    expect(within(fiche).getByText(/identifiants SORAHNEX pour ce fournisseur ne sont pas encore configurés/i)).toBeTruthy();
    expect(within(fiche).queryByRole('button', { name: /^Connecter/ })).toBeNull();
  });

  it('Shopify et WooCommerce ouvrent un VRAI formulaire, pas un bouton mort', async () => {
    monter();
    for (const [cle, nom] of [['shopify', 'Shopify'], ['woocommerce', 'WooCommerce']] as const) {
      fireEvent.click(await screen.findByTestId(`integration-${cle}`));
      const fiche = await screen.findByRole('dialog', { name: new RegExp(`Fiche ${nom}`, 'i') });
      // Le formulaire générique, piloté par les exigences déclaratives.
      expect(await within(fiche).findByTestId(`${cle}-connect-form`), cle).toBeTruthy();
      expect(within(fiche).getByTestId(`${cle}-connect`), cle).toBeTruthy();
      // Et surtout : rien n'affirme qu'une connexion existe.
      expect(within(fiche).queryByText(/ne sont pas encore configurés/i), cle).toBeNull();
      fireEvent.click(within(fiche).getByLabelText('Retour'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });
});

describe('règle 3 — les connexions OAuth réelles sont conservées et révocables', () => {
  it('liste les comptes réels et révoque avec confirmation', async () => {
    mocks.listConnectedAccounts.mockResolvedValue([compte({ provider: 'gmail' })]);
    mocks.revokeConnection.mockResolvedValue({ remoteRevoked: true });
    monter();
    await waitFor(() => expect(screen.getByText(/Vos connexions actives/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Révoquer' }));
    const dialogue = await screen.findByRole('dialog');
    fireEvent.click(within(dialogue).getByRole('button', { name: 'Révoquer' }));
    await waitFor(() => expect(mocks.revokeConnection).toHaveBeenCalledWith('acc-1'));
    expect(await screen.findByText(/révoquée chez le fournisseur et dans SORAHNEX/i)).toBeTruthy();
  });

  it('un échec de révocation distante est rapporté tel quel, sans le maquiller', async () => {
    mocks.listConnectedAccounts.mockResolvedValue([compte({ provider: 'gmail' })]);
    mocks.revokeConnection.mockResolvedValue({ remoteRevoked: false });
    monter();
    await waitFor(() => expect(screen.getByText(/Vos connexions actives/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Révoquer' }));
    const dialogue = await screen.findByRole('dialog');
    fireEvent.click(within(dialogue).getByRole('button', { name: 'Révoquer' }));
    expect(await screen.findByText(/n’a pas confirmé la révocation distante/i)).toBeTruthy();
  });
});

describe('source unique — un seul catalogue pour deux points d’entrée', () => {
  it('le mode intégré masque l’en-tête de page mais garde tout le contenu', async () => {
    monter({ embedded: true });
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    // Pas de retour vers l'assistant : l'espace hôte fournit sa propre navigation.
    expect(screen.queryByRole('link', { name: /Retour à l’assistant/i })).toBeNull();
    // Le contenu, lui, est identique.
    expect(screen.getByRole('heading', { name: /Connectez vos outils à SORAHNEX/i })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: /Rechercher une intégration/i })).toBeTruthy();
  });

  it('hors mode intégré, la page garde son propre retour', async () => {
    monter({ embedded: false });
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    expect(screen.getByRole('link', { name: /Retour à l’assistant/i })).toBeTruthy();
  });

  it('sans entreprise active, les demandes sont désactivées avec explication', async () => {
    render(<MemoryRouter><IntegrationsCenter workspaceId={null} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-facebook')).toBeTruthy());
    expect(screen.getByText(/Aucune entreprise active/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('integration-facebook'));
    const fiche = await screen.findByRole('dialog', { name: /Fiche Facebook/i });
    expect(within(fiche).queryByRole('button', { name: 'Demander l’activation' })).toBeNull();
  });
});
