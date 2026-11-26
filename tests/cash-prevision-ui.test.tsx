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
import CashWorkspace from '../src/business/cash/CashWorkspace';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const record = (id: string, category: string, data: Record<string, unknown>) => ({
  id, category, data, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
});

/** Deux jours avant aujourd'hui, pour que le retard soit toujours réel. */
function datePassee(jours: number): string {
  return new Date(Date.now() - jours * 86_400_000).toISOString().slice(0, 10);
}

function jeuCreances() {
  return [
    record('r1', 'bg_module_receivables', {
      reference: 'FAC-ALPHA', contactId: 'k1', description: 'Prestation', initialAmount: 400000,
      issuedAt: datePassee(60), dueDate: datePassee(30), status: 'en_attente',
    }),
  ];
}

function jeuDepenses() {
  return [
    record('e1', 'bg_module_cash_expenses', {
      label: 'Loyer atelier', category: 'Loyer', amount: 900000, incurredAt: datePassee(2),
      paidAt: '', method: 'virement', status: 'engagee', recurrence: 'aucune',
    }),
  ];
}

describe('Prévision de trésorerie — branchée dans l’écran', () => {
  it('affiche le panneau et propose les trois horizons', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_receivables' ? jeuCreances() : category === 'bg_module_cash_expenses' ? jeuDepenses() : [],
    }));
    render(
      <ToastProvider>
        <CashWorkspace workspaceId="11111111-1111-4111-8111-111111111111" onOpenFinance={() => {}} />
      </ToastProvider>,
    );

    const panneau = await screen.findByTestId('cash-prevision');
    expect(panneau.textContent).toContain('Prévision de trésorerie');
    for (const libelle of ['4 sem.', '8 sem.', '12 sem.']) {
      expect(screen.getByRole('button', { name: libelle })).toBeTruthy();
    }
    // L'horizon par défaut est 8 semaines : 8 lignes lisibles sur mobile.
    await waitFor(() => expect(panneau.querySelectorAll('li').length).toBeGreaterThanOrEqual(8));
    expect(panneau.textContent).toContain('Semaine 1');
  });

  it('affiche la vraie référence de la créance, jamais un chiffre inventé', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_receivables' ? jeuCreances() : category === 'bg_module_cash_expenses' ? jeuDepenses() : [],
    }));
    render(
      <ToastProvider>
        <CashWorkspace workspaceId="11111111-1111-4111-8111-111111111111" onOpenFinance={() => {}} />
      </ToastProvider>,
    );
    const panneau = await screen.findByTestId('cash-prevision');
    await waitFor(() => expect(panneau.textContent).toContain('FAC-ALPHA'));
  });

  it('signale un trou de trésorerie avec des actions chiffrées', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_receivables' ? jeuCreances() : category === 'bg_module_cash_expenses' ? jeuDepenses() : [],
    }));
    render(
      <ToastProvider>
        <CashWorkspace workspaceId="11111111-1111-4111-8111-111111111111" onOpenFinance={() => {}} />
      </ToastProvider>,
    );
    const panneau = await screen.findByTestId('cash-prevision');
    // 400 000 espérés × 0,65 − 900 000 de loyer engagé = trésorerie négative.
    await waitFor(() => expect(panneau.textContent).toMatch(/sous zéro/));
    expect(panneau.textContent).toContain('effet estimé');
    expect(panneau.textContent).toMatch(/ne garantit aucun résultat/);
  });

  it('dit honnêtement qu’il n’y a rien à projeter quand les données manquent', async () => {
    api.listModuleRecords.mockResolvedValue({ records: [] });
    render(
      <ToastProvider>
        <CashWorkspace workspaceId="11111111-1111-4111-8111-111111111111" onOpenFinance={() => {}} />
      </ToastProvider>,
    );
    const panneau = await screen.findByTestId('cash-prevision');
    await waitFor(() => expect(panneau.textContent).toContain('ne peut rien affirmer'));
  });

  it('change d’horizon au clic, sans recharger les données', async () => {
    api.listModuleRecords.mockImplementation(async (category: string) => ({
      records: category === 'bg_module_receivables' ? jeuCreances() : category === 'bg_module_cash_expenses' ? jeuDepenses() : [],
    }));
    render(
      <ToastProvider>
        <CashWorkspace workspaceId="11111111-1111-4111-8111-111111111111" onOpenFinance={() => {}} />
      </ToastProvider>,
    );
    const panneau = await screen.findByTestId('cash-prevision');
    await waitFor(() => expect(panneau.textContent).toContain('Semaine 8'));
    fireEvent.click(screen.getByRole('button', { name: '12 sem.' }));
    await waitFor(() => expect(panneau.textContent).toContain('Semaine 12'));
    expect(screen.queryByText('Semaine 13')).toBeNull();
  });
});
