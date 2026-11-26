// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});

function joursAvant(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Le formulaire s'ouvre sur une règle existante : c'est le chemin le plus court. */
const regleExistante = () => [
  record('rule-1', 'bg_module_automation_rules', {
    name: 'Relancer les impayés', trigger: 'facture_retard', thresholdDays: 5,
    action: 'preparer_relance', channel: 'email', enabled: true, lastRunAt: '',
  }),
];

async function ouvrirFormulaire() {
  const { default: AutomationWorkspaceComposant } = await import('../src/business/automation/AutomationWorkspace');
  render(
    <ToastProvider>
      <AutomationWorkspaceComposant workspaceId="11111111-1111-4111-8111-111111111111" onOpenContact={() => {}} />
    </ToastProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('automation-workspace')).toBeTruthy());
  const modifier = await screen.findAllByRole('button', { name: /modifier/i });
  fireEvent.click(modifier[0]);
  return screen.findAllByRole('dialog');
}

describe('Automatisation écrite en une phrase — branchée dans l’écran', () => {
  it('pré-remplit les champs structurés depuis la phrase', async () => {
    api.listModuleRecords.mockResolvedValue({ records: regleExistante() });
    await ouvrirFormulaire();

    const zone = screen.getByPlaceholderText(/si une facture a 7 jours de retard/i);
    fireEvent.change(zone, { target: { value: 'si une facture a 12 jours de retard, prépare la relance' } });
    fireEvent.click(screen.getByRole('button', { name: /comprendre la phrase/i }));

    // Le seuil est pré-rempli depuis la phrase (12 jours).
    const seuil = screen.getByLabelText(/Seuil \(jours\)/i) as HTMLInputElement;
    await waitFor(() => expect(seuil.value).toBe('12'));
  });

  it('affiche les questions au lieu de deviner quand la phrase est incomplète', async () => {
    api.listModuleRecords.mockResolvedValue({ records: regleExistante() });
    await ouvrirFormulaire();

    const zone = screen.getByPlaceholderText(/si une facture a 7 jours de retard/i);
    fireEvent.change(zone, { target: { value: 'prépare la relance après 3 jours' } });
    fireEvent.click(screen.getByRole('button', { name: /comprendre la phrase/i }));

    await waitFor(() => expect(screen.getByText(/Sur quoi la règle doit-elle se déclencher/i)).toBeTruthy());
  });

  it('teste la règle à blanc sur les données réelles, sans rien exécuter', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_automation_rules'
        ? regleExistante()
        : category === 'bg_module_sales_invoices'
          ? [record('inv-1', 'bg_module_sales_invoices', {
            number: 'FAC-900', contactId: 'k1', status: 'envoyee', currency: 'XOF',
            issuedAt: joursAvant(40), dueDate: joursAvant(20), lines: [],
          })]
          : [],
    }));
    await ouvrirFormulaire();

    fireEvent.click(screen.getByRole('button', { name: /tester à blanc/i }));
    const apercu = await screen.findByTestId('test-a-blanc');
    // Le message doit être l'un des trois états honnêtes, jamais une promesse.
    expect(apercu.textContent).toMatch(/Rien n’a été exécuté|aucun ne déclencherait|Aucune donnée à examiner/);
  });

  it('dit « aucune donnée à examiner » plutôt que de rassurer à tort', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_automation_rules' ? regleExistante() : [],
    }));
    await ouvrirFormulaire();

    fireEvent.click(screen.getByRole('button', { name: /tester à blanc/i }));
    const apercu = await screen.findByTestId('test-a-blanc');
    expect(apercu.textContent).toContain('Aucune donnée à examiner');
  });
});
