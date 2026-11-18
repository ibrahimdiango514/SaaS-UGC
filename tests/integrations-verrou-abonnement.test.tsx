// @vitest-environment jsdom
/**
 * VYORA Integrations — verrou Business Grow sur le parcours d'accès.
 *
 * ## Constat de production (2026-11-18)
 * Abonnement inactif : les 28 fiches affichaient « Abonnement requis » (exact),
 * mais le panneau « Mes boutiques connectées » lisait quand même les quatre
 * connecteurs via `store-connect` → « Vérification en cours » puis erreur
 * réseau/CORS, en contradiction avec le bandeau « l'état n'est pas lu sans
 * abonnement ». Les comptes OAuth et le journal étaient lus en parallèle, pour
 * rien.
 *
 * ## Ce que ces tests imposent
 * 1. Sans abonnement : UNE seule requête (la lecture refusée par le serveur),
 *    aucune vers `store-connect`, aucune vers les comptes OAuth ni le journal.
 * 2. Le verrou est affiché clairement, avec le lien vers la vraie page de
 *    gestion de l'abonnement (`/app/business/abonnement`).
 * 3. Abonnement détecté (lecture acceptée) : la lecture des connexions démarre
 *    réellement — quatre lectures `status`, une par connecteur — et l'état réel
 *    s'affiche.
 * 4. « Revérifier » après attribution administrative : passage du verrou à la
 *    lecture réelle sans rechargement de page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  listConnectedAccounts: vi.fn(),
  listAudit: vi.fn(),
  listIntegrations: vi.fn(),
  readConnection: vi.fn(),
}));

vi.mock('../src/integrations/connections', async () => {
  const reel = await vi.importActual<typeof import('../src/integrations/connections')>('../src/integrations/connections');
  return { ...reel, listConnectedAccounts: mocks.listConnectedAccounts, listAudit: mocks.listAudit };
});

vi.mock('../src/business/api', async () => {
  const reel = await vi.importActual<typeof import('../src/business/api')>('../src/business/api');
  return {
    ...reel,
    businessGrowApi: { ...reel.businessGrowApi, listIntegrations: mocks.listIntegrations },
  };
});

vi.mock('../src/business/importer/connect-relay', async () => {
  const reel = await vi.importActual<typeof import('../src/business/importer/connect-relay')>('../src/business/importer/connect-relay');
  return { ...reel, readConnection: mocks.readConnection };
});

import { IntegrationsCenter } from '../src/integrations/CatalogPage';
import { BusinessGrowApiError } from '../src/business/api';

const WORKSPACE = 'workspace-1';

const refusAbonnement = () => new BusinessGrowApiError(
  'Abonnement Business Grow requis pour Import & Connect.',
  'BUSINESS_GROW_SUBSCRIPTION_REQUIRED',
  403,
  { reason: 'NO_SUBSCRIPTION', subscription_status: null, plan_key: null, current_period_end: null },
);

function monter() {
  return render(
    <MemoryRouter>
      <IntegrationsCenter workspaceId={WORKSPACE} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConnectedAccounts.mockResolvedValue([]);
  mocks.listAudit.mockResolvedValue([]);
  mocks.readConnection.mockResolvedValue(null);
});

afterEach(cleanup);

describe('abonnement inactif', () => {
  it('n’émet qu’une requête (refusée) : ni store-connect, ni comptes OAuth, ni journal', async () => {
    mocks.listIntegrations.mockRejectedValue(refusAbonnement());
    monter();
    const bandeau = await screen.findByTestId('integrations-subscription-required');
    expect(bandeau.textContent).toContain('Abonnement Business Grow requis');
    expect(bandeau.textContent).toMatch(/Connexions verrouillées/);

    expect(mocks.listIntegrations).toHaveBeenCalledTimes(1);
    expect(mocks.readConnection).not.toHaveBeenCalled();
    expect(mocks.listConnectedAccounts).not.toHaveBeenCalled();
    expect(mocks.listAudit).not.toHaveBeenCalled();
  });

  it('affiche le verrou sur les boutiques, sans « Vérification en cours » ni erreur réseau', async () => {
    mocks.listIntegrations.mockRejectedValue(refusAbonnement());
    monter();
    await screen.findByTestId('integrations-subscription-required');
    const boutiques = screen.getByTestId('mes-boutiques');
    expect(boutiques.getAttribute('data-access')).toBe('locked');
    expect(boutiques.textContent).toMatch(/Connexions verrouillées/);
    expect(boutiques.textContent).not.toMatch(/Vérification en cours|illisible|réseau|CORS|Lecture en cours/i);
    expect(screen.queryByTestId('boutique-prestashop')).toBeNull();
    // Aucune panne annoncée : le refus n'est pas une erreur.
    expect(screen.queryByText(/État des intégrations indisponible/)).toBeNull();
    expect(screen.queryByText(/Impossible de lire vos connexions/)).toBeNull();
    // Les fiches disent « Abonnement requis », pas « État inconnu ».
    expect(screen.getByTestId('integration-shopify').textContent).toContain('Abonnement requis');
  });

  it('les deux liens « Voir l’abonnement Business Grow » mènent à la vraie page de gestion', async () => {
    mocks.listIntegrations.mockRejectedValue(refusAbonnement());
    monter();
    const bandeau = await screen.findByTestId('integrations-subscription-required');
    expect(within(bandeau).getByRole('link', { name: /Voir l’abonnement Business Grow/ }).getAttribute('href')).toBe('/app/business/abonnement');
    expect(screen.getByTestId('mes-boutiques-abonnement').getAttribute('href')).toBe('/app/business/abonnement');
  });
});

describe('abonnement actif', () => {
  it('lance réellement la lecture des quatre connexions et affiche leur état réel', async () => {
    mocks.listIntegrations.mockResolvedValue({ connections: [] });
    mocks.readConnection.mockImplementation(async ({ connectorKey }: { connectorKey: string }) => (
      connectorKey === 'chariow'
        ? { connectorKey, status: 'connected', connected: true, shopName: 'Vitrine Bamako', storeUrl: 'https://vitrine.chariow.com', totalProducts: 12, checkedAt: '2026-11-18T10:00:00Z', connectedTo: null, endpoint: null, version: null, resourcesRead: [], lastError: null }
        : null
    ));
    monter();
    await waitFor(() => expect(screen.getByTestId('boutique-chariow')).toBeTruthy());
    expect(screen.getByTestId('mes-boutiques').getAttribute('data-access')).toBe('active');
    expect(screen.getByTestId('boutique-chariow').getAttribute('data-state')).toBe('connected');
    expect(screen.getByTestId('boutique-chariow').textContent).toContain('Vitrine Bamako');
    expect(screen.getByTestId('boutique-prestashop').getAttribute('data-state')).toBe('not-configured');

    const cles = mocks.readConnection.mock.calls.map(([arg]) => (arg as { connectorKey: string }).connectorKey).sort();
    expect(cles).toEqual(['chariow', 'prestashop', 'shopify', 'woocommerce']);
    // Les autres sources sont lues APRÈS la vérification d'abonnement, pas en parallèle.
    expect(mocks.listConnectedAccounts).toHaveBeenCalledTimes(1);
    expect(mocks.listAudit).toHaveBeenCalledTimes(1);
    expect(mocks.listIntegrations.mock.invocationCallOrder[0]).toBeLessThan(mocks.listConnectedAccounts.mock.invocationCallOrder[0]);
  });

  it('« Revérifier » après attribution de l’abonnement : du verrou à la lecture réelle, sans rechargement', async () => {
    mocks.listIntegrations.mockRejectedValueOnce(refusAbonnement());
    monter();
    const bandeau = await screen.findByTestId('integrations-subscription-required');
    expect(mocks.readConnection).not.toHaveBeenCalled();

    // L'administrateur attribue l'abonnement ; le serveur accepte désormais la lecture.
    mocks.listIntegrations.mockResolvedValue({ connections: [] });
    fireEvent.click(within(bandeau).getByRole('button', { name: 'Revérifier' }));

    await waitFor(() => expect(screen.getByTestId('boutique-prestashop')).toBeTruthy());
    expect(screen.queryByTestId('integrations-subscription-required')).toBeNull();
    expect(screen.getByTestId('mes-boutiques').getAttribute('data-access')).toBe('active');
    expect(mocks.readConnection).toHaveBeenCalledTimes(4);
  });

  it('lecture des intégrations en panne (pas un refus) : aucune lecture de boutique, message dédié', async () => {
    mocks.listIntegrations.mockRejectedValue(new Error('Lecture indisponible'));
    monter();
    await screen.findByText(/État des intégrations indisponible/);
    expect(screen.getByTestId('mes-boutiques').getAttribute('data-access')).toBe('pending');
    expect(screen.getByTestId('mes-boutiques').textContent).toMatch(/Lecture des intégrations en échec/);
    expect(mocks.readConnection).not.toHaveBeenCalled();
    expect(mocks.listConnectedAccounts).not.toHaveBeenCalled();
  });
});
