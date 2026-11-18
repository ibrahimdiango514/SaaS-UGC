// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
// Le nombre de fournisseurs est lu du catalogue : la capture ne doit pas
// annoncer un total que le composant ne rend pas.
import { INTEGRATIONS } from '../src/integrations/catalog';

/**
 * Preuve de rendu — catalogue d'intégrations unifié.
 *
 * ## Pourquoi ce fichier existe
 *
 * Un test qui vérifie « la page se monte » ne prouve pas ce que l'utilisateur
 * voit. Ici on monte le VRAI `IntegrationsCenter` avec des réponses serveur
 * simulées, puis on écrit le DOM obtenu dans
 * `artifacts/integrations-unifiees.html`. Le CSS Tailwind compilé y est inliné,
 * donc le fichier ouvert dans un navigateur rend la mise en page réelle.
 *
 * ## Ce que la capture doit montrer
 *
 * Un mélange d'états, pour prouver qu'ils restent distincts :
 *   - gmail connecté (compte OAuth réel) ;
 *   - google_drive non connecté (aucun compte, connecteur absent) ;
 *   - facebook en demande d'activation ;
 *   - shopify en « Autorisation manquante » (ligne connected sans preuve) ;
 *   - tiktok en « Validation externe requise ».
 *
 * Si un état mangeait les autres, la capture le rendrait visible.
 */

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

const WORKSPACE = 'workspace-demo';

const STYLES = `
  body { margin: 0; background: #070b12; color: #e2e8f0; font-family: ui-sans-serif, system-ui, sans-serif; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 24px 16px 48px; }
  .capture-title { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin: 0 0 4px; }
  .capture-sub { font-size: 12px; color: #475569; margin: 0 0 18px; }
  .capture-banner { display: inline-block; border: 1px solid rgba(56,189,248,.35); background: rgba(14,165,233,.10); color: #bae6fd; border-radius: 999px; padding: 4px 12px; font-size: 11px; margin-bottom: 14px; }
`;

describe('preuve de rendu du catalogue unifié', () => {
  it('produit un artefact HTML ouvrable avec les états réellement dérivés', async () => {
    cleanup();
    mocks.listConnectedAccounts.mockResolvedValue([
      {
        id: 'acc-gmail', provider: 'gmail', externalAccountId: 'ext-g',
        displayName: 'Direction VYORA', email: 'direction@vyora.app',
        capabilities: ['read', 'send'], status: 'connected',
        lastVerifiedAt: '2026-11-14T09:12:00Z', lastError: null, createdAt: '2026-11-01T00:00:00Z',
      },
    ]);
    mocks.listAudit.mockResolvedValue([
      { id: 'a1', action: 'oauth.connect', provider: 'gmail', outcome: 'ok', detail: 'compte relié', createdAt: '2026-11-14T09:12:00Z' },
    ]);
    mocks.listIntegrations.mockResolvedValue({
      connections: [
        // Demande en attente : un état réel, pas une connexion.
        { id: 'r1', workspace_id: WORKSPACE, connector_key: 'facebook', external_account_ref: null, status: 'pending', updated_at: '2026-11-14T08:00:00Z' },
        // Ligne prétendument connectée, sans compte OAuth : le cas piège.
        { id: 'r2', workspace_id: WORKSPACE, connector_key: 'shopify', external_account_ref: null, status: 'connected', updated_at: '2026-11-14T08:30:00Z' },
      ],
    });

    const { container } = render(
      <MemoryRouter>
        <IntegrationsCenter workspaceId={WORKSPACE} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('integration-facebook').textContent).toContain('Activation demandée'));

    // Les états distincts sont bien présents dans le DOM rendu.
    expect(screen.getByTestId('integration-gmail').textContent).toContain('Connecté');
    expect(screen.getByTestId('integration-shopify').textContent).toContain('Autorisation manquante');
    expect(screen.getByTestId('integration-facebook').textContent).toContain('Activation demandée');
    // Fournisseurs exigeant une approbation de leur côté, sans compte relié.
    for (const id of ['tiktok', 'instagram', 'microsoft365']) {
      expect(screen.getByTestId(`integration-${id}`).textContent).toContain('Validation externe requise');
    }
    /*
     * Depuis la phase E, WooCommerce a un moteur : sans ligne de connexion, son
     * état est « Non connecté » — et non plus « Configuration requise ». Le
     * second libellé reste vérifié sur OpenCart, qui n'a réellement aucun moteur.
     */
    expect(screen.getByTestId('integration-woocommerce').textContent).toContain('Non connecté');
    expect(screen.getByTestId('integration-opencart').textContent).toContain('Configuration requise');
    // Le compte réel est listé dans « Vos connexions actives ».
    expect(screen.getByText(/Vos connexions actives/i)).toBeTruthy();

    // Preuve complémentaire : la fiche de Shopify explique pourquoi elle ne
    // prétend pas être connectée, malgré `status = 'connected'` en base.
    fireEvent.click(screen.getByTestId('integration-shopify'));
    const fiche = await screen.findByRole('dialog', { name: /Fiche Shopify/i });
    expect(within(fiche).getByText(/aucune autorisation n’a été obtenue auprès du fournisseur/i)).toBeTruthy();

    const css = existsSync('dist/assets')
      ? readdirSync('dist/assets').filter((f) => f.endsWith('.css')).map((f) => readFileSync(`dist/assets/${f}`, 'utf8')).join('\n')
      : '';

    mkdirSync('artifacts', { recursive: true });
    const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VYORA — Intégrations unifiées (preuve de rendu)</title>
<style>${css}</style>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <p class="capture-title">VYORA · Business Grow → Intégrations</p>
  <p class="capture-sub">Catalogue unique de ${INTEGRATIONS.length} fournisseurs, statuts dérivés du serveur. Capture produite depuis le composant réel.</p>
  <span class="capture-banner">Même composant que /app/connect</span>
  ${container.innerHTML}
</div>
</body>
</html>`;

    writeFileSync('artifacts/integrations-unifiees.html', html, 'utf8');
    expect(existsSync('artifacts/integrations-unifiees.html')).toBe(true);
  });
});
