// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

import CrmWorkspace from '../src/business/crm/CrmWorkspace';
import FinanceWorkspace from '../src/business/finance/FinanceWorkspace';

function record(id: string, category: string, data: Record<string, unknown>): BusinessModuleRecord {
  return { id, category, data, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-11-20T00:00:00.000Z' };
}

const store: Record<string, BusinessModuleRecord[]> = {
  bg_module_crm_contacts: [
    record('c1', 'bg_module_crm_contacts', {
      firstName: 'Awa', lastName: 'Traoré', company: 'Boutique Awa', phone: '+223 76 12 34 56',
      email: 'awa@example.com', city: 'Bamako', type: 'prospect', source: 'instagram',
      lastContactAt: '2026-11-20', nextAction: 'Envoyer la proposition', nextActionAt: '2026-11-21',
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
  bg_module_crm_activities: [
    record('a1', 'bg_module_crm_activities', { contactId: 'c1', type: 'note', summary: 'Premier échange téléphonique', occurredAt: '2026-11-20' }),
  ],
  bg_module_crm_segments: [],
  bg_module_receivables: [
    record('r1', 'bg_module_receivables', {
      reference: 'FAC-001', contactId: 'c1', description: 'Prestation', initialAmount: 500_000,
      issuedAt: '2026-10-01', dueDate: '2026-11-01', status: 'en_attente',
    }),
    record('r2', 'bg_module_receivables', {
      reference: 'FAC-002', contactId: 'c2', description: 'Soldée', initialAmount: 200_000,
      issuedAt: '2026-10-01', dueDate: '2026-11-01', status: 'en_attente',
    }),
  ],
  bg_module_receivable_payments: [
    record('p1', 'bg_module_receivable_payments', { receivableId: 'r1', amount: 100_000, paidAt: '2026-11-10', method: 'mobile_money', status: 'valide' }),
    record('p2', 'bg_module_receivable_payments', { receivableId: 'r2', amount: 200_000, paidAt: '2026-11-10', method: 'virement', status: 'valide' }),
  ],
  bg_module_receivable_reminders: [],
  bg_module_payment_promises: [
    record('pr1', 'bg_module_payment_promises', { receivableId: 'r1', contactId: 'c1', amount: 200_000, promisedAt: '2026-11-15', status: 'a_venir' }),
  ],
  bg_module_receivable_disputes: [],
};

beforeEach(() => {
  api.listModuleRecords.mockImplementation(async (category: string) => ({ records: store[category] ?? [] }));
  api.createModuleRecord.mockResolvedValue({ recordId: 'new-id' });
  api.updateModuleRecord.mockResolvedValue({ updated: true });
  api.deleteModuleRecord.mockResolvedValue({ deleted: true });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderCrm(onCreateReceivable = vi.fn()) {
  return render(
    <ToastProvider>
      <CrmWorkspace workspaceId="ws-1" legacyProspects={[]} onCreateReceivable={onCreateReceivable}
        onOpenFinance={() => undefined} onOpenAssistant={() => undefined} />
    </ToastProvider>,
  );
}

describe('CRM — interface connectée aux données', () => {
  it('affiche le tableau de bord calculé depuis les enregistrements réels', async () => {
    renderCrm();
    await waitFor(() => expect(screen.getByTestId('crm-dashboard')).toBeTruthy());
    expect(screen.getByText('Pipeline ouvert')).toBeTruthy();
    expect(screen.getAllByText(/500/).length).toBeGreaterThan(0);
    expect(screen.getByText('Prospects chauds')).toBeTruthy();
  });

  it('ouvre une fiche contact avec score expliqué et situation financière réelle', async () => {
    const onCreateReceivable = vi.fn();
    renderCrm(onCreateReceivable);
    await waitFor(() => expect(screen.getByTestId('crm-dashboard')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Contacts$/ }));
    await waitFor(() => expect(screen.getByTestId('crm-contacts')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Awa Traoré/ }));
    await waitFor(() => expect(screen.getByTestId('crm-contact-detail')).toBeTruthy());
    expect(screen.getByText('Pourquoi cette priorité')).toBeTruthy();
    expect(screen.getByText('Solde restant')).toBeTruthy();
    expect(screen.getByText(/Premier échange téléphonique/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Créer une créance/ }));
    expect(onCreateReceivable).toHaveBeenCalledWith('c1');
  });

  it('exige un motif avant de marquer une opportunité perdue', async () => {
    renderCrm();
    await waitFor(() => expect(screen.getByTestId('crm-dashboard')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Pipeline$/ }));
    await waitFor(() => expect(screen.getByTestId('crm-pipeline')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Étape de Pack boutique'), { target: { value: 'perdu' } });
    await waitFor(() => expect(screen.getByText('Marquer l’opportunité perdue')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Confirmer la perte/ }));
    expect(api.updateModuleRecord).not.toHaveBeenCalledWith('bg_module_crm_opportunities', expect.anything(), expect.objectContaining({ stage: 'perdu' }), expect.anything());
  });

  it('propose une créance après une opportunité gagnée sans en créer une', async () => {
    renderCrm();
    await waitFor(() => expect(screen.getByTestId('crm-dashboard')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Pipeline$/ }));
    await waitFor(() => expect(screen.getByTestId('crm-pipeline')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Étape de Pack boutique'), { target: { value: 'gagne' } });
    await waitFor(() => expect(screen.getByText('Opportunité gagnée')).toBeTruthy());
    expect(api.createModuleRecord).not.toHaveBeenCalledWith('bg_module_receivables', expect.anything(), expect.anything(), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Plus tard' }));
  });
});

describe('Finances — interface connectée aux créances et paiements', () => {
  it('affiche un tableau de bord sans compter une créance soldée comme en retard', async () => {
    render(
      <ToastProvider>
        <FinanceWorkspace workspaceId="ws-1" onOpenContact={() => undefined} />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('finance-dashboard')).toBeTruthy());
    expect(screen.getByText('Solde restant')).toBeTruthy();
    expect(screen.getByText('En retard')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Créances$/ }));
    await waitFor(() => expect(screen.getByTestId('finance-receivables')).toBeTruthy());
    const rows = screen.getAllByRole('row');
    const paidRow = rows.find((row) => row.textContent?.includes('FAC-002'));
    expect(paidRow?.textContent).toMatch(/Payée/);
    const overdueRow = rows.find((row) => row.textContent?.includes('FAC-001'));
    expect(overdueRow?.textContent).toMatch(/En retard/);
  });

  it('affiche le risque, les paiements et les promesses dans la fiche créance', async () => {
    render(
      <ToastProvider>
        <FinanceWorkspace workspaceId="ws-1" onOpenContact={() => undefined} />
      </ToastProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('finance-dashboard')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Créances$/ }));
    await waitFor(() => expect(screen.getByTestId('finance-receivables')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'FAC-001' }));
    await waitFor(() => expect(screen.getByTestId('finance-receivable-detail')).toBeTruthy());
    expect(screen.getByText('Pourquoi ce niveau de risque')).toBeTruthy();
    expect(screen.getByText(/non respectée/)).toBeTruthy();
    expect(screen.getByText(/Paiements \(1 validés\)/)).toBeTruthy();
  });
});
