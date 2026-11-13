// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BusinessModules from '../src/business/modules/BusinessModules';
import BusinessModuleWorkspace from '../src/business/modules/BusinessModuleWorkspace';
import {
  FOUNDATION_MODULES,
  MODULE_DEFINITIONS,
  buildAutomationTasks,
  computeRevenueLeaks,
  moduleKeyToCategory,
  type ModuleRecord,
} from '../src/business/modules/registry';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(async () => ({ records: [] as unknown[] })),
  createModuleRecord: vi.fn(async () => ({ recordId: 'new-record' })),
  updateModuleRecord: vi.fn(async () => ({ updated: true })),
  deleteModuleRecord: vi.fn(async () => ({ deleted: true })),
}));

vi.mock('../src/business/api', () => ({ businessGrowApi: api }));

afterEach(() => cleanup());

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-state">{JSON.stringify(location.state)}</output>;
}

function record(id: string, data: Record<string, unknown>): ModuleRecord {
  return {
    id,
    category: 'bg_module_test',
    data,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
  };
}

describe('Registre des modules Business Growth', () => {
  it('couvre les 16 modules de la mission : 13 outils + 3 fondations', () => {
    expect(MODULE_DEFINITIONS).toHaveLength(13);
    expect(FOUNDATION_MODULES).toHaveLength(3);
    const allKeys = [...MODULE_DEFINITIONS.map((module) => module.key), ...FOUNDATION_MODULES.map((module) => module.key)];
    expect(new Set(allKeys).size).toBe(16);
  });

  it('déclare pour chaque module un stockage, des champs et des statuts cohérents', () => {
    for (const module of MODULE_DEFINITIONS) {
      expect(module.category).toBe(moduleKeyToCategory(module.key));
      expect(module.category).toMatch(/^bg_module_[a-z0-9_]+$/);
      expect(module.fields.length).toBeGreaterThan(2);
      expect(module.statuses.length).toBeGreaterThan(1);
      expect(module.openStatuses.length).toBeGreaterThan(0);
      expect(module.fields.some((field) => field.key === module.primaryField)).toBe(true);
      expect(module.fields.some((field) => field.required)).toBe(true);
      if (module.dateField) expect(module.fields.some((field) => field.key === module.dateField)).toBe(true);
      if (module.valueField) expect(module.fields.some((field) => field.key === module.valueField)).toBe(true);
      expect(typeof module.kpis[0].compute([])).toBe('string');
      expect(module.agentPrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it('calcule les fuites de revenus à partir des enregistrements réels', () => {
    const leads = [
      record('lead-1', { name: 'A', estimatedValue: 75000, lastContactAt: '2026-10-01', status: 'nouveau' }),
      record('lead-2', { name: 'B', estimatedValue: 25000, lastContactAt: '2026-11-12', status: 'qualifie' }),
    ];
    const invoices = [record('invoice-1', { amount: 120000, status: 'en_retard' })];
    const stock = [record('stock-1', { stock: 2, threshold: 10, price: 15000 })];
    const leaks = computeRevenueLeaks({
      'lead-rescue': leads,
      'payment-recovery': invoices,
      'smart-inventory': stock,
    });
    const byId = Object.fromEntries(leaks.map((leak) => [leak.id, leak]));
    expect(byId['leak-leads'].amount).toBe(75000);
    expect(byId['leak-invoices'].amount).toBe(120000);
    expect(byId['leak-stock'].amount).toBe(8 * 15000);
    expect(leaks[0].severity).toBe('haute');
  });

  it('génère des tâches déterministes uniquement pour les règles actives', () => {
    const playbooks = [
      record('rule-1', { name: 'Relancer les paniers', trigger: 'panier_abandonne', action: 'tache_relance', delayDays: 1, status: 'actif' }),
      record('rule-2', { name: 'Règle en pause', trigger: 'facture_echue', action: 'alerte_interne', delayDays: 0, status: 'pause' }),
    ];
    const tasks = buildAutomationTasks(playbooks, {
      'order-cart-recovery': [record('cart-1', { reference: 'CMD-1', status: 'panier' })],
      'payment-recovery': [record('invoice-1', { invoiceRef: 'FAC-1', status: 'en_retard' })],
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: 'sales_automation',
      sourcePlaybookId: 'rule-1',
      sourceRecordId: 'cart-1',
      priority: 'moyenne',
    });
    expect(tasks[0].title).toContain('CMD-1');
  });
});

describe('Catalogue des modules', () => {
  it('présente les 13 outils et les 3 fondations, avec un lien réel par module', () => {
    render(<MemoryRouter><BusinessModules /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /Vos modules métier/i })).toBeTruthy();
    expect(screen.getByText('Fondations déjà opérationnelles')).toBeTruthy();
    for (const module of MODULE_DEFINITIONS) {
      expect(screen.getByRole('heading', { name: module.title })).toBeTruthy();
    }
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    for (const module of MODULE_DEFINITIONS) {
      expect(links).toContain(`/app/business/modules/${module.key}`);
    }
  });
});

describe('Espace d’un module', () => {
  beforeEach(() => {
    api.listModuleRecords.mockClear();
    api.createModuleRecord.mockClear();
  });

  it('affiche un état vide et crée un enregistrement avec les champs réels', async () => {
    render(
      <MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Lead Rescue' })).toBeTruthy();
    expect(await screen.findByText('Aucun lead à sauver pour le moment')).toBeTruthy();
    expect(api.listModuleRecords).toHaveBeenCalledWith('bg_module_lead_rescue');

    fireEvent.click(screen.getAllByRole('button', { name: /Créer un enregistrement/i })[0]);
    fireEvent.change(screen.getByLabelText(/Prospect/), { target: { value: 'Salif Traoré' } });
    fireEvent.change(screen.getByLabelText(/Valeur estimée/), { target: { value: '125000' } });
    fireEvent.click(screen.getByRole('button', { name: /Créer l’enregistrement/i }));

    await waitFor(() => {
      expect(api.createModuleRecord).toHaveBeenCalledWith('bg_module_lead_rescue', expect.objectContaining({
        name: 'Salif Traoré',
        estimatedValue: 125000,
        status: 'nouveau',
      }));
    });
  });

  it('prépare un brief agent avec le contexte réel du module', async () => {
    api.listModuleRecords.mockResolvedValueOnce({
      records: [{
        id: 'lead-agent-1',
        category: 'bg_module_lead_rescue',
        data: { name: 'Fatoumata Diallo', company: 'Éclat Bamako', estimatedValue: 185000, lastContactAt: '2026-11-11', status: 'nouveau' },
        created_at: '2026-11-11T09:00:00Z',
        updated_at: '2026-11-12T09:00:00Z',
      }],
    });
    render(
      <MemoryRouter initialEntries={['/app/business/modules/lead-rescue']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
          <Route path="/app/business" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Fatoumata Diallo');
    fireEvent.click(screen.getByRole('button', { name: /Demander à l’agent/i }));
    const probe = await screen.findByTestId('location-state');
    const state = JSON.parse(probe.textContent || '{}');
    expect(state.businessGrowIntent.section).toBe('chat');
    expect(state.businessGrowIntent.initialDraft).toContain('Analyse mes leads');
    expect(state.businessGrowIntent.initialDraft).toContain('Fatoumata Diallo');
    expect(state.businessGrowIntent.initialDraft).toContain('185');
  });

  it('refuse un module inconnu sans appeler le backend', async () => {
    render(
      <MemoryRouter initialEntries={['/app/business/modules/inconnu']}>
        <Routes>
          <Route path="/app/business/modules/:moduleKey" element={<BusinessModuleWorkspace />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Module introuvable')).toBeTruthy();
    expect(api.listModuleRecords).not.toHaveBeenCalled();
  });
});
