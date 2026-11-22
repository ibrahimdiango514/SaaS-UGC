// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ToastProvider } from '../src/context/ToastContext';
import type { BusinessModuleRecord } from '../src/business/api';

const api = vi.hoisted(() => ({
  listModuleRecords: vi.fn(),
  createModuleRecord: vi.fn(),
  updateModuleRecord: vi.fn(),
  deleteModuleRecord: vi.fn(),
}));

vi.mock('../src/business/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/business/api')>();
  return { ...actual, businessGrowApi: { ...actual.businessGrowApi, ...api } };
});

import SalesWorkspace from '../src/business/sales/SalesWorkspace';
import CatalogWorkspace from '../src/business/catalog/CatalogWorkspace';
import CashWorkspace from '../src/business/cash/CashWorkspace';
import AutomationWorkspace from '../src/business/automation/AutomationWorkspace';
import MarketingWorkspace from '../src/business/marketing/MarketingWorkspace';

function record(id: string, category: string, data: Record<string, unknown>): BusinessModuleRecord {
  return { id, category, data, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z' };
}

const store: Record<string, BusinessModuleRecord[]> = {
  bg_module_crm_contacts: [
    record('c1', 'bg_module_crm_contacts', { firstName: 'Awa', lastName: 'Traoré', company: 'Boutique Awa', type: 'client', whatsapp: '+223 76 12 34 56' }),
    record('c2', 'bg_module_crm_contacts', { firstName: 'Moussa', lastName: 'Diallo', company: 'Diallo SARL', type: 'prospect' }),
  ],
  bg_module_sales_quotes: [
    record('q1', 'bg_module_sales_quotes', {
      number: 'DEV-2026-0001', contactId: 'c1', status: 'envoye', issuedAt: '2026-11-01', expiresAt: '2026-11-30',
      lines: [{ id: 'l1', description: 'Savon', quantity: 2, unitPrice: 10_000, discountPct: 0, taxPct: 0 }],
    }),
  ],
  bg_module_sales_invoices: [
    record('i1', 'bg_module_sales_invoices', {
      number: 'FAC-2026-0001', contactId: 'c1', status: 'envoyee', issuedAt: '2026-11-01', dueDate: '2026-11-15',
      receivableId: 'r1', lines: [{ id: 'l1', description: 'Savon', quantity: 2, unitPrice: 10_000, discountPct: 0, taxPct: 0 }],
    }),
  ],
  bg_module_receivables: [
    record('r1', 'bg_module_receivables', { reference: 'FAC-2026-0001', contactId: 'c1', initialAmount: 20_000, issuedAt: '2026-11-01', dueDate: '2026-11-15', status: 'en_attente' }),
  ],
  bg_module_receivable_payments: [
    record('p1', 'bg_module_receivable_payments', { receivableId: 'r1', amount: 5_000, paidAt: '2026-11-05', method: 'mobile_money', status: 'valide' }),
  ],
  bg_module_payment_promises: [],
  bg_module_catalog_products: [
    record('pr1', 'bg_module_catalog_products', { name: 'Savon', kind: 'produit', trackStock: true, initialStock: 2, lowStockThreshold: 5, price: 1_500, cost: 700, unit: 'pièce' }),
    record('pr2', 'bg_module_catalog_products', { name: 'Conseil', kind: 'service', price: 25_000 }),
  ],
  bg_module_stock_movements: [
    record('m1', 'bg_module_stock_movements', { productId: 'pr1', type: 'sortie', quantity: 1, occurredAt: '2026-11-20' }),
  ],
  bg_module_cash_expenses: [
    record('e1', 'bg_module_cash_expenses', { label: 'Loyer', category: 'Loyer', amount: 150_000, incurredAt: '2026-11-01', paidAt: '2026-11-02', status: 'payee', method: 'virement' }),
  ],
  bg_module_crm_tasks: [
    record('t1', 'bg_module_crm_tasks', { title: 'Rappeler Awa', contactId: 'c1', dueDate: '2026-11-01', status: 'a_faire', priority: 'elevee' }),
  ],
  bg_module_crm_opportunities: [],
  bg_module_crm_segments: [],
  bg_module_automation_rules: [],
  bg_module_automation_runs: [],
  bg_module_marketing_campaigns: [],
};

beforeEach(() => {
  api.listModuleRecords.mockImplementation(async (category: string) => ({ records: store[category] ?? [] }));
  api.createModuleRecord.mockResolvedValue({ recordId: 'new-id' });
  api.updateModuleRecord.mockResolvedValue({ updated: true });
  api.deleteModuleRecord.mockResolvedValue({ deleted: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const wrap = (node: ReactNode) => render(<ToastProvider>{node}</ToastProvider>);

describe('Growth OS — nouveaux modules connectés', () => {
  it('crée un devis numéroté depuis un client CRM', async () => {
    wrap(<SalesWorkspace workspaceId="w1" onOpenContact={() => {}} onOpenFinance={() => {}} />);
    await screen.findByText('DEV-2026-0001');
    fireEvent.click(screen.getByRole('button', { name: 'Nouveau' }));
    fireEvent.change(screen.getByLabelText('Client (CRM)'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Désignation de la ligne'), { target: { value: 'Savon artisanal' } });
    fireEvent.change(screen.getByLabelText('Prix unitaire'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer le devis' }));

    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalled());
    const [category, data, dedupe, workspace] = api.createModuleRecord.mock.calls[0];
    expect(category).toBe('bg_module_sales_quotes');
    expect(data).toMatchObject({ contactId: 'c1', status: 'brouillon', number: expect.stringMatching(/^DEV-\d{4}-0002$/) });
    expect(dedupe).toBe(`number:${(data as Record<string, unknown>).number}`);
    expect(workspace).toBe('w1');
  });

  it('affiche le stock dérivé et signale le seuil', async () => {
    wrap(<CatalogWorkspace workspaceId="w1" />);
    expect(await screen.findByText('Savon')).toBeTruthy();
    expect(screen.getAllByText('Stock faible').length).toBeGreaterThan(0);
    expect(screen.getByText('1 pièce')).toBeTruthy();
    expect(screen.getAllByText('Non suivi').length).toBeGreaterThan(0);
  });

  it('affiche le solde de trésorerie réel et les dépenses payées', async () => {
    wrap(<CashWorkspace workspaceId="w1" onOpenFinance={() => {}} />);
    expect(await screen.findByText('Solde de trésorerie')).toBeTruthy();
    expect(screen.getAllByText(/145\s000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Loyer/).length).toBeGreaterThan(0);
  });

  it('propose une action d’automatisation à partir d’une tâche réelle', async () => {
    store.bg_module_automation_rules = [
      record('rule1', 'bg_module_automation_rules', { name: 'Tâches en retard', trigger: 'tache_retard', thresholdDays: 1, action: 'creer_tache', enabled: true }),
    ];
    wrap(<AutomationWorkspace workspaceId="w1" onOpenContact={() => {}} />);
    expect(await screen.findByText('Rappeler Awa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Créer la tâche' }));
    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalledWith(
      'bg_module_crm_tasks',
      expect.objectContaining({ title: 'Rappeler Awa', contactId: 'c1' }),
      'rule1:task:t1',
      'w1',
    ));
    store.bg_module_automation_rules = [];
  });

  it('prépare une campagne marketing à partir des contacts sans envoyer', async () => {
    wrap(<MarketingWorkspace workspaceId="w1" onOpenContact={() => {}} />);
    expect(await screen.findByText('Aucune campagne')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Créer' }));
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Réactivation clients' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Message/ }), { target: { value: 'Bonjour {{contact}}, revenez nous voir.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer la campagne' }));
    await waitFor(() => expect(api.createModuleRecord).toHaveBeenCalledWith(
      'bg_module_marketing_campaigns',
      expect.objectContaining({ name: 'Réactivation clients', channel: 'whatsapp' }),
      null,
      'w1',
    ));
  });
});
