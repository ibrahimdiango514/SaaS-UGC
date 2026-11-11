// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../src/context/ToastContext';
import type { AdminMetrics, MuApiModel } from '../src/lib/types';

const catalogResponse = {
  models: [
    {
      model_id: 'kling-4.0-text-to-video', display_name: 'Kling 4.0', description: null, category: 'Text to Video',
      input_fields: ['prompt'], required_fields: ['prompt'], param_schema: {}, cost_usd: 0.785, cost_currency: 'USD',
      is_enabled: true, is_coming_soon: false, dynamic_pricing: true, cost_strategy: 'per_second',
      reelora_status: 'active', account_access: 'account', synced_at: '2026-11-11T16:29:41Z',
    },
    {
      model_id: 'wan2.2-5b-fast-t2v', display_name: 'Wan 2.2 Fast', description: null, category: 'Text to Video',
      input_fields: ['prompt'], required_fields: ['prompt'], param_schema: {}, cost_usd: 0.015, cost_currency: 'USD',
      is_enabled: true, is_coming_soon: false, dynamic_pricing: true, cost_strategy: 'per_second',
      reelora_status: 'active', account_access: 'account', synced_at: '2026-11-11T16:29:41Z',
    },
    {
      model_id: 'mystery-model', display_name: 'Mystery', description: null, category: 'Video to Video',
      input_fields: [], required_fields: ['first_frame'], param_schema: {}, cost_usd: null, cost_currency: 'USD',
      is_enabled: true, is_coming_soon: false, dynamic_pricing: false, cost_strategy: null,
      reelora_status: 'unsupported', account_access: 'public_only', synced_at: null,
    },
  ] as MuApiModel[],
  catalog: {
    source: 'muapi_authenticated', fetched_at: '2026-11-11T19:22:37.095Z', public_total: 415, authenticated_total: 415,
    detected_video: 3, active: 2, unavailable: 1, verified: true, reasons: { active: 2, unsupported: 1 }, error: null,
    account: { key_configured: true, key_valid: true, catalog_status: 200, balance_status: 200, keys_status: 200, key_is_test: false, error: null },
  },
};

const metrics: AdminMetrics = {
  generated_at: '2026-11-11T19:24:42.038948+00:00',
  months: 3,
  period_start: '2026-09-01',
  period_end: '2026-11-01',
  history: { first_activity_at: '2026-11-08T16:45:14.763321+00:00', exploitable_from: '2026-11-08', has_history: true, months_of_history: 1 },
  revenue: {
    currency: 'XOF', collected_total_minor: 0, collected_orders: 0, pending_orders: 0,
    by_month: [{ month: '2026-09', collected_minor: 0, orders: 0 }, { month: '2026-10', collected_minor: 0, orders: 0 }, { month: '2026-11', collected_minor: 0, orders: 0 }],
  },
  mrr: {
    currency: 'XOF', current_minor: 1500000, active_recurring_subscriptions: 1,
    by_month: [
      { month: '2026-09', mrr_minor: 0, new_mrr_minor: 0, lost_mrr_minor: 0, net_mrr_minor: 0, active_subscriptions: 0 },
      { month: '2026-10', mrr_minor: 0, new_mrr_minor: 0, lost_mrr_minor: 0, net_mrr_minor: 0, active_subscriptions: 0 },
      { month: '2026-11', mrr_minor: 1500000, new_mrr_minor: 1500000, lost_mrr_minor: 0, net_mrr_minor: 1500000, active_subscriptions: 1 },
    ],
  },
  subscriptions: {
    total: 4, active: 3, cancelled: 1,
    by_plan: [{ plan_key: 'studio', plan_name: 'Studio', status: 'active', count: 1, monthly_price_minor: 1500000 }],
    new_by_month: [{ month: '2026-11', count: 4 }], cancelled_by_month: [{ month: '2026-11', count: 1 }],
  },
  users: { customers: 2, with_subscription: 4, new_by_month: [{ month: '2026-11', count: 2 }] },
  studio: {
    jobs_total: 0, jobs_succeeded: 0, jobs_failed: 0, credits_charged_total: 0,
    usage_by_kind: { prompt: 1, script: 2 },
    by_month: [{ month: '2026-11', jobs: 0, succeeded: 0, failed: 0, credits_charged: 0 }],
  },
  business_growth: {
    requests_total: 0, requests_succeeded: 0, requests_failed: 0, conversations: 0, messages: 0,
    memory_items: 0, tool_executions: 0, tokens_total: 0, by_month: [{ month: '2026-11', requests: 0, succeeded: 0, failed: 0, input_tokens: 0, output_tokens: 0, provider_cost_micros: 0 }],
  },
  providers: { business_growth: [], studio_cost_events: [] },
  models: { total: 415, selectable: 412, coming_soon: 3, synced_at: '2026-11-11T16:29:41.391775+00:00' },
};

vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...actual,
    adminVideoCatalog: vi.fn(async () => catalogResponse),
    aiEngineHealth: vi.fn(async () => ({
      service: 'vyora-ai', status: 'ok',
      providers: { groq: { configured: true, model: 'openai/gpt-oss-120b' }, gemini: { configured: true, model: 'gemini-2.5-flash' } },
    })),
  };
});

import {
  GrowthActivitySection, KpiSection, ModelsSection, ProvidersSection, RevenueSection, StudioActivitySection, modelsToCsv,
} from '../src/pages/admin/AdminSections';

const renderWithProviders = (node: React.ReactElement) => render(node, { wrapper: ToastProvider });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('admin — revenus et MRR', () => {
  it('affiche les revenus encaissés réels et prévient quand l’historique est absent', () => {
    render(<RevenueSection metrics={metrics} loading={false} months={3} onMonths={() => undefined} />);
    expect(screen.getByTestId('admin-revenue')).toBeTruthy();
    expect(screen.getByText('Revenus encaissés')).toBeTruthy();
    // Revenu réel nul : affiché 0, jamais « Sur devis ».
    expect(screen.queryByText('Sur devis')).toBeNull();
    expect(screen.getAllByText(/0\s*F\s*CFA/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Période exploitable limitée/)).toBeTruthy();
    expect(screen.getByText(/Premier événement réel/)).toBeTruthy();
  });

  it('ne fabrique aucun revenu : toutes les barres de période sont à zéro', () => {
    render(<RevenueSection metrics={metrics} loading={false} months={3} onMonths={() => undefined} />);
    expect(screen.getByLabelText('Revenus encaissés par mois')).toBeTruthy();
    expect(screen.getByText(/Aucune donnée sur la période/)).toBeTruthy();
  });

  it('documente la méthode MRR et compte uniquement les abonnements récurrents actifs', () => {
    render(<KpiSection metrics={metrics} loading={false} />);
    expect(screen.getByTestId('admin-kpis')).toBeTruthy();
    expect(screen.getByText(/Méthode MRR documentée/)).toBeTruthy();
    expect(screen.getByText(/1 récurrent\(s\) actif\(s\)/)).toBeTruthy();
    expect(screen.getByLabelText('Tendance du MRR')).toBeTruthy();
  });

  it('affiche l’activité Studio et Business Growth à partir des compteurs réels', () => {
    render(<StudioActivitySection metrics={metrics} loading={false} />);
    expect(screen.getByTestId('admin-studio-activity')).toBeTruthy();
    expect(screen.getByText('script')).toBeTruthy();
    cleanup();
    render(<GrowthActivitySection metrics={metrics} loading={false} />);
    expect(screen.getByTestId('admin-growth-activity')).toBeTruthy();
    expect(screen.getByText('Requêtes IA')).toBeTruthy();
  });
});

describe('admin — catalogue modèles', () => {
  it('affiche le catalogue réel avec prix USD et équivalent USDT', async () => {
    renderWithProviders(<ModelsSection />);
    await waitFor(() => expect(screen.getByText('kling-4.0-text-to-video')).toBeTruthy());
    expect(screen.getByText('0,785 USD')).toBeTruthy();
    expect(screen.getByText('0,785 USDT')).toBeTruthy();
    expect(screen.getByText(/1 USD = 1 USDT/)).toBeTruthy();
    expect(screen.getByText(/tarif non communiqué/)).toBeTruthy();
  });

  it('exporte un CSV complet avec les deux devises et la tarification dynamique', () => {
    const csv = modelsToCsv(catalogResponse.models);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('tarif_usd');
    expect(lines[0]).toContain('equivalent_usdt');
    expect(lines[1]).toContain('kling-4.0-text-to-video');
    expect(lines[1]).toContain('0.7850');
    expect(lines[1]).toContain('oui');
    expect(lines[3]).toContain('unsupported');
  });

  it('sonde le moteur IA central et affiche les modèles réellement configurés', async () => {
    renderWithProviders(<ProvidersSection metrics={metrics} />);
    await waitFor(() => expect(screen.getByText('openai/gpt-oss-120b')).toBeTruthy());
    expect(screen.getByText('gemini-2.5-flash')).toBeTruthy();
    expect(screen.getByText('415 modèles')).toBeTruthy();
  });
});
