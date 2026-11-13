// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';
import type { AiCoreAdminSettings, AiCoreCallEntry, AiCoreRegistrySnapshot } from '../src/lib/types';

const registrySnapshot: AiCoreRegistrySnapshot = {
  version: 2,
  generated_at: '2026-11-15T12:00:00Z',
  providers: [
    { key: 'groq', name: 'Groq', status: 'active', aggregator: false },
    { key: 'gemini', name: 'Gemini', status: 'active', aggregator: false },
    { key: 'openrouter', name: 'OpenRouter', status: 'active', aggregator: true },
  ],
  models: [
    { provider: 'groq', key: 'gpt-oss-120b', provider_model: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B', verified: true, tier: 'primary' },
    { provider: 'groq', key: 'llama-3.3-70b', provider_model: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', verified: true, tier: 'fallback' },
    { provider: 'gemini', key: 'gemini-2.5-flash', provider_model: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', verified: false, tier: 'fallback' },
  ],
  roles: [{ key: 'business_advisor', capabilities: { writing: true }, enabled: true }],
  rules: [{ role: 'business_advisor', provider: 'groq', model: 'gpt-oss-120b', priority: 1 }],
  budget: { monthly: 100, alert: 80, daily: 10 },
  monthly_spend_usd: 84.2,
};

const callEntries: AiCoreCallEntry[] = [
  {
    id: 'call-1', space: 'business', task_key: 'chat', provider: 'groq', model: 'gpt-oss-120b',
    provider_model: 'openai/gpt-oss-120b', attempt: 1, status: 'success', error_code: null,
    input_tokens: 420, output_tokens: 180, latency_ms: 950, cost_usd: 0.0042,
    fallback_from: null, created_at: '2026-11-15T11:58:00Z',
  },
  {
    id: 'call-2', space: 'business', task_key: 'chat', provider: 'gemini', model: 'gemini-2.5-flash',
    provider_model: 'gemini-2.5-flash', attempt: 2, status: 'error', error_code: 'PROVIDER_TIMEOUT',
    input_tokens: null, output_tokens: null, latency_ms: 25000, cost_usd: 0,
    fallback_from: 'groq', created_at: '2026-11-15T11:57:00Z',
  },
];

const adminSettings: AiCoreAdminSettings = {
  monthly_budget_usd: 100,
  alert_threshold_pct: 80,
  max_daily_cost_usd: 10,
  updated_at: '2026-11-15T10:00:00Z',
};

const apiMocks = vi.hoisted(() => ({
  registry: vi.fn(),
  calls: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));

beforeEach(() => {
  (apiMocks.registry as Mock).mockImplementation(async () => registrySnapshot);
  (apiMocks.calls as Mock).mockImplementation(async () => callEntries);
  (apiMocks.settingsGet as Mock).mockImplementation(async () => adminSettings);
  (apiMocks.settingsSet as Mock).mockImplementation(async (args: {
    monthly_budget_usd: number | null;
    alert_threshold_pct: number;
    max_daily_cost_usd: number | null;
  }) => ({
    monthly_budget_usd: args.monthly_budget_usd,
    alert_threshold_pct: args.alert_threshold_pct,
    max_daily_cost_usd: args.max_daily_cost_usd,
    updated_at: '2026-11-15T12:05:00Z',
  }));
});

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    adminAiCoreRegistry: apiMocks.registry,
    adminAiCoreCalls: apiMocks.calls,
    adminAiCoreSettingsGet: apiMocks.settingsGet,
    adminAiCoreSettingsSet: apiMocks.settingsSet,
  };
});

import AiCoreControl from '../src/pages/admin/AiCoreControl';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('admin — Contrôle IA (AI CORE)', () => {
  it('affiche le registre réel : fournisseurs, modèles vérifiés et dépense du mois', async () => {
    render(<ToastProvider><AiCoreControl /></ToastProvider>);

    expect(await screen.findByText('Registre multi-fournisseurs')).toBeTruthy();
    expect(screen.getByText('Groq')).toBeTruthy();
    expect(screen.getByText('OpenRouter')).toBeTruthy();
    expect(screen.getByText('Agrégateur')).toBeTruthy();
    // 3 fournisseurs, 3 modèles, 2 vérifiés.
    const cards = screen.getAllByText('fournisseur(s) actif(s)');
    expect(cards.length).toBe(1);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('modèle(s) vérifié(s)')).toBeTruthy();
    // Dépense du mois avec budget 100 USD → 84 %.
    expect(screen.getByText('84 % du budget mensuel')).toBeTruthy();
  });

  it('affiche le journal des appels IA (statuts, jetons, coût, secours)', async () => {
    render(<ToastProvider><AiCoreControl /></ToastProvider>);

    expect(await screen.findByText('Journal des appels IA')).toBeTruthy();
    const table = screen.getByText('Réussi').closest('table') as HTMLTableElement;
    expect(table).toBeTruthy();
    expect(within(table).getByText('Erreur')).toBeTruthy();
    expect(within(table).getByText('420 → 180')).toBeTruthy();
    expect(within(table).getByText('950 ms')).toBeTruthy();
    expect(within(table).getAllByText('Business Grow').length).toBe(2);
    expect(within(table).getByText('openai/gpt-oss-120b')).toBeTruthy();
  });

  it('charge les réglages IA du serveur et les enregistre (round-trip)', async () => {
    render(<ToastProvider><AiCoreControl /></ToastProvider>);

    const budgetInput = (await screen.findByDisplayValue('100')) as HTMLInputElement;
    const thresholdInput = screen.getByDisplayValue('80') as HTMLInputElement;
    expect(thresholdInput).toBeTruthy();

    fireEvent.change(budgetInput, { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(apiMocks.settingsSet).toHaveBeenCalledWith({
      monthly_budget_usd: 150,
      alert_threshold_pct: 80,
      max_daily_cost_usd: 10,
    }));
    await waitFor(() => expect(screen.getByDisplayValue('150')).toBeTruthy());
    expect(screen.getByText(/Dernier changement :/)).toBeTruthy();
  });

  it('refuse un budget invalide sans appel serveur', async () => {
    render(<ToastProvider><AiCoreControl /></ToastProvider>);

    const budgetInput = (await screen.findByDisplayValue('100')) as HTMLInputElement;
    fireEvent.change(budgetInput, { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(screen.getByText('Budget invalide : montant positif ou vide.')).toBeTruthy());
    expect(apiMocks.settingsSet).not.toHaveBeenCalled();
  });

  it('affiche l’état d’erreur avec relance quand le registre est refusé', async () => {
    apiMocks.registry.mockRejectedValueOnce(Object.assign(new Error('admin required'), { code: 'admin_required' }));
    render(<ToastProvider><AiCoreControl /></ToastProvider>);

    expect(await screen.findByText('Registre multi-fournisseurs')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Réessayer' })).toBeTruthy();
  });
});
