// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';

const movementMock = vi.fn();
const historyMock = vi.fn();

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    adminCreditMovement: (...args: unknown[]) => movementMock(...args),
    adminCreditHistory: (...args: unknown[]) => historyMock(...args),
  };
});

import CreditManager, { newIdempotencyKey } from '../src/pages/admin/CreditManager';

const user = { id: '11111111-2222-4333-8444-555555555555', email: 'client@vyora.test' };

const renderManager = () => render(
  <CreditManager user={user} onClose={() => undefined} />,
  { wrapper: ToastProvider },
);

beforeEach(() => {
  historyMock.mockResolvedValue({
    user_id: user.id,
    balance: 100,
    reserved: 0,
    entries: [
      { id: 'ledger-1', delta: 100, reserved_delta: 0, operation: 'signup_bonus', description: 'Bonus de bienvenue', metadata: {}, created_at: '2026-11-11T10:00:00Z' },
    ],
  });
  movementMock.mockImplementation(async (_userId: string, delta: number, reason: string) => ({
    user_id: user.id, delta, requested_delta: delta, reason,
    balance_before: 100, balance_after: 100 + delta, ledger_id: 'ledger-2',
    replayed: false, actor_user_id: 'admin-1', applied_at: new Date().toISOString(),
  }));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('admin — gestion réelle des crédits', () => {
  it('affiche le solde réel et l’historique du client', async () => {
    renderManager();
    // Synchronisation sur le chargement de l'historique réel : le tableau
    // n'existe qu'une fois l'appel terminé. « 100 » ne peut PAS servir de
    // signal — il est déjà affiché au premier rendu (solde après opération
    // projeté = 0 + montant par défaut), avant même le chargement.
    await waitFor(() => expect(screen.getByTestId('credit-history')).toBeTruthy());
    expect(screen.getByText('100')).toBeTruthy(); // solde réel chargé
    expect(screen.getByText('Bonus de bienvenue')).toBeTruthy();
    expect(historyMock).toHaveBeenCalledWith(user.id, 25);
  });

  it('ajoute des crédits avec motif et affiche le solde avant/après', async () => {
    renderManager();
    await waitFor(() => expect(screen.getByTestId('credit-history')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Montant (crédits)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Motif (obligatoire, tracé dans l’audit)'), { target: { value: 'Geste commercial' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter les crédits/ }));

    await waitFor(() => expect(movementMock).toHaveBeenCalledTimes(1));
    const [userId, delta, reason, key] = movementMock.mock.calls[0];
    expect(userId).toBe(user.id);
    expect(delta).toBe(500);
    expect(reason).toBe('Geste commercial');
    expect(String(key).length).toBeGreaterThan(8);

    await waitFor(() => expect(screen.getByTestId('credit-result')).toBeTruthy());
    const result = within(screen.getByTestId('credit-result'));
    expect(result.getByText(/Opération appliquée et journalisée/)).toBeTruthy();
    expect(result.getByText(/Solde 100 →/)).toBeTruthy();
    expect(result.getByText('600')).toBeTruthy();
    expect(result.getByText(/\+500/)).toBeTruthy();
  });

  it('exige une confirmation avant un retrait et bloque un solde négatif', async () => {
    renderManager();
    await waitFor(() => expect(screen.getByTestId('credit-history')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Retirer' }));
    fireEvent.change(screen.getByLabelText('Montant (crédits)'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Motif (obligatoire, tracé dans l’audit)'), { target: { value: 'Correction' } });

    const submit = screen.getByRole('button', { name: /Retirer les crédits/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // confirmation obligatoire

    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: /Retirer les crédits/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Retirer les crédits/ }));
    await waitFor(() => expect(movementMock).toHaveBeenCalledTimes(1));
    expect(movementMock.mock.calls[0][1]).toBe(-40);

    cleanup();
    renderManager();
    await waitFor(() => expect(screen.getByTestId('credit-history')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Retirer' }));
    fireEvent.change(screen.getByLabelText('Montant (crédits)'), { target: { value: '10000' } });
    fireEvent.change(screen.getByLabelText('Motif (obligatoire, tracé dans l’audit)'), { target: { value: 'Trop' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByText(/Retrait impossible/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Retirer les crédits/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('génère une clé d’idempotence différente à chaque tentative', () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();
    expect(first).not.toBe(second);
    expect(first.startsWith('adm-')).toBe(true);
    expect(first.length).toBeGreaterThan(12);
  });
});
