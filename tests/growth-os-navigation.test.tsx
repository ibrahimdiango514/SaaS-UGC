// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BusinessModuleRecord } from '../src/business/api';
import {
  GROWTH_OS_NAV, growthOsModuleFromPath, legacyGrowthOsPath,
} from '../src/business/os/modules';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
}));

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

import { GrowthOsLayout } from '../src/business/os/GrowthOsLayout';
import { GrowthOsOverview } from '../src/business/os/GrowthOsOverview';

function record(id: string, category: string, data: Record<string, unknown>): BusinessModuleRecord {
  return { id, category, data, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z' };
}

const store: Record<string, BusinessModuleRecord[]> = {
  bg_module_crm_contacts: [
    record('c1', 'bg_module_crm_contacts', {
      firstName: 'Awa', lastName: 'Traoré', company: 'Boutique Awa', email: 'awa@example.com',
      type: 'prospect', source: 'instagram', lastContactAt: '2026-11-20',
      nextAction: 'Envoyer la proposition', nextActionAt: '2026-11-21',
    }),
    record('c2', 'bg_module_crm_contacts', {
      firstName: 'Moussa', lastName: 'Diallo', company: 'Diallo SARL', email: 'moussa@example.com',
      type: 'client', source: 'recommandation', lastContactAt: '2026-09-01',
    }),
  ],
  bg_module_crm_opportunities: [
    record('o1', 'bg_module_crm_opportunities', {
      title: 'Pack boutique', contactId: 'c1', stage: 'proposition', amount: 500_000,
      currency: 'XOF', probability: 65, expectedCloseAt: '2026-11-25',
    }),
  ],
  bg_module_crm_tasks: [
    record('t1', 'bg_module_crm_tasks', {
      title: 'Rappeler Awa', type: 'appel', contactId: 'c1', priority: 'elevee',
      dueDate: '2026-11-20', status: 'a_faire',
    }),
  ],
  bg_module_receivables: [
    record('r1', 'bg_module_receivables', {
      reference: 'FAC-001', contactId: 'c1', description: 'Prestation', initialAmount: 500_000,
      issuedAt: '2026-10-01', dueDate: '2026-11-01', status: 'en_attente',
    }),
  ],
  bg_module_receivable_payments: [
    record('p1', 'bg_module_receivable_payments', { receivableId: 'r1', amount: 100_000, paidAt: '2026-11-10', method: 'mobile_money', status: 'valide' }),
  ],
  bg_module_receivable_reminders: [],
  bg_module_payment_promises: [
    record('pr1', 'bg_module_payment_promises', { receivableId: 'r1', contactId: 'c1', amount: 200_000, promisedAt: '2026-11-15', status: 'a_venir' }),
  ],
};

beforeEach(() => {
  api.listModuleRecords.mockImplementation(async (category: string) => ({ records: store[category] ?? [] }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Growth OS — routing réel', () => {
  it('résout chaque module depuis son URL', () => {
    expect(growthOsModuleFromPath('/app/business')).toBe('overview');
    expect(growthOsModuleFromPath('/app/business/')).toBe('overview');
    expect(growthOsModuleFromPath('/app/business/crm')).toBe('crm');
    expect(growthOsModuleFromPath('/app/business/pipeline')).toBe('pipeline');
    expect(growthOsModuleFromPath('/app/business/finance')).toBe('finance');
    expect(growthOsModuleFromPath('/app/business/recouvrement')).toBe('recouvrement');
    expect(growthOsModuleFromPath('/app/business/assistant')).toBe('assistant');
    expect(growthOsModuleFromPath('/app/business/sales')).toBe('sales');
    expect(growthOsModuleFromPath('/app/business/catalog')).toBe('catalog');
    expect(growthOsModuleFromPath('/app/business/cash')).toBe('cash');
    expect(growthOsModuleFromPath('/app/business/automation')).toBe('automation');
    expect(growthOsModuleFromPath('/app/business/marketing')).toBe('marketing');
    expect(growthOsModuleFromPath('/app/business/suppliers')).toBe('suppliers');
    expect(growthOsModuleFromPath('/app/business/storefront')).toBe('storefront');
    expect(growthOsModuleFromPath('/app/business/inconnu')).toBe('overview');
  });

  it('redirige les anciennes URL vers les nouveaux modules', () => {
    expect(legacyGrowthOsPath('chat', null)).toBe('/app/business/assistant');
    expect(legacyGrowthOsPath('growth', 'relations')).toBe('/app/business/crm');
    expect(legacyGrowthOsPath('growth', 'finance')).toBe('/app/business/finance');
    expect(legacyGrowthOsPath('growth', 'overview')).toBe('/app/business/reports');
    expect(legacyGrowthOsPath('integrations', null)).toBe('/app/business/integrations');
    expect(legacyGrowthOsPath(null, null)).toBeNull();
  });

  it('rend la sidebar Growth OS avec des liens réels et l’état actif', () => {
    render(
      <MemoryRouter initialEntries={['/app/business/crm']}>
        <GrowthOsLayout active="crm" workspaceName="Maison Karité">
          <p>Contenu CRM</p>
        </GrowthOsLayout>
      </MemoryRouter>,
    );

    const nav = screen.getByRole('navigation', { name: 'Navigation SORAHNEX Grow' });
    expect(nav).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vue générale' }).getAttribute('href')).toBe('/app/business');
    expect(screen.getByRole('link', { name: 'CRM' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Pipeline commercial' }).getAttribute('href')).toBe('/app/business/pipeline');
    expect(screen.getByRole('link', { name: 'Finance' }).getAttribute('href')).toBe('/app/business/finance');
    expect(screen.getByRole('link', { name: 'Assistant IA' }).getAttribute('href')).toBe('/app/business/assistant');
    expect(screen.getByRole('link', { name: 'Ventes et facturation' }).getAttribute('href')).toBe('/app/business/sales');
    expect(screen.getByRole('link', { name: 'Produits et stock' }).getAttribute('href')).toBe('/app/business/catalog');
    expect(screen.getByRole('link', { name: 'Trésorerie et dépenses' }).getAttribute('href')).toBe('/app/business/cash');
    expect(screen.getByRole('link', { name: 'Automatisations' }).getAttribute('href')).toBe('/app/business/automation');
    expect(screen.getByRole('link', { name: 'Marketing et fidélisation' }).getAttribute('href')).toBe('/app/business/marketing');
    expect(screen.getByRole('link', { name: 'Achats et fournisseurs' }).getAttribute('href')).toBe('/app/business/suppliers');
    expect(screen.getByRole('link', { name: 'Vitrine commerciale' }).getAttribute('href')).toBe('/app/business/storefront');
    expect(screen.queryByRole('link', { name: 'Croissance' })).toBeNull();
    expect(GROWTH_OS_NAV.flatMap((group) => group.items)).toHaveLength(21);
  });

  it('ouvre le menu mobile sans perdre la navigation', () => {
    render(
      <MemoryRouter initialEntries={['/app/business']}>
        <GrowthOsLayout active="overview" workspaceName="Maison Karité">
          <p>Contenu</p>
        </GrowthOsLayout>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir le menu SORAHNEX Grow' }));
    expect(screen.getByRole('dialog', { name: 'Menu SORAHNEX Grow' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog', { name: 'Menu SORAHNEX Grow' })).toBeNull();
  });
});

describe('Growth OS — vue générale alimentée par les données réelles', () => {
  it('calcule les indicateurs et les priorités depuis les enregistrements', async () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <GrowthOsOverview workspaceId="workspace-1" onNavigate={onNavigate} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('À traiter maintenant')).toBeTruthy());
    expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_crm_contacts', 'workspace-1');
    expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_receivables', 'workspace-1');

    // Le pipeline pondéré vient de l'opportunité réelle (500 000 × 65 %).
    await waitFor(() => expect(screen.getAllByText(/325\s000/).length).toBeGreaterThan(0));
    // La créance réelle apparaît avec son client.
    expect(screen.getAllByText('Awa Traoré').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FAC-001/).length).toBeGreaterThan(0);
    // Une promesse dépassée remonte en action, sans créer de paiement.
    expect(screen.getAllByText(/Promesse de paiement non tenue/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Ouvrir le pipeline/ }));
    expect(onNavigate).toHaveBeenCalledWith('pipeline');
  });

  it('n’affiche pas de faux chiffres sans entreprise active', () => {
    render(
      <MemoryRouter>
        <GrowthOsOverview workspaceId={null} onNavigate={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getAllByText(/Aucune entreprise active/).length).toBeGreaterThan(0);
    expect(api.listModuleRecords).not.toHaveBeenCalled();
  });
});
