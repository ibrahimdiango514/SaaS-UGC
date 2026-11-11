// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { providersNeedingVerification } from '../src/business/BusinessGrowWorkspace';
import type { BusinessProviderStatus } from '../src/business/api';
import BusinessGrow from '../src/business/BusinessGrow';

vi.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    user: { id: 'staleness-user', email: 'staleness@example.test' },
    session: { access_token: 'test-token' },
    profile: null, workspace: null, workspaceId: null, quota: null,
    isAdmin: false, loading: false, bootstrapError: null,
    refreshQuota: vi.fn(), refreshAll: vi.fn(), logout: vi.fn(),
  }),
}));

vi.mock('../src/lib/api', () => ({
  listBrands: vi.fn(async () => []),
  listProducts: vi.fn(async () => []),
  listNotifications: vi.fn(async () => []),
}));

const NOW = Date.parse('2026-11-11T22:00:00.000Z');

/**
 * Forme réellement renvoyée par `{action:'status'}` quand le dernier contrôle a
 * plus de 24 h : l'Edge Function expose alors `unverified` + `enabled: false`
 * alors que la base garde `enabled = true`.
 */
function staleStatus(overrides: Partial<BusinessProviderStatus> = {}): BusinessProviderStatus {
  return status({
    enabled: false,
    status: 'unverified',
    checked_at: '2026-11-10T18:55:21.962Z',
    verified_model_keys: [],
    ...overrides,
  });
}

function status(overrides: Partial<BusinessProviderStatus>): BusinessProviderStatus {
  return {
    provider_key: 'groq',
    display_name: 'Groq',
    enabled: true,
    status: 'available',
    config_status: 'configured',
    checked_at: '2026-11-11T21:00:00.000Z',
    verified_model_keys: ['openai/gpt-oss-120b'],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('Validité réelle des contrôles fournisseur (24 h côté SQL)', () => {
  it('signale un fournisseur configuré dont le contrôle a expiré', () => {
    const stale = providersNeedingVerification([staleStatus()], NOW);
    expect(stale.map((provider) => provider.provider_key)).toEqual(['groq']);
  });

  it('ne signale rien quand le contrôle est récent', () => {
    expect(providersNeedingVerification([status({ checked_at: '2026-11-11T21:00:00.000Z' })], NOW)).toHaveLength(0);
  });

  it('signale un fournisseur configuré jamais contrôlé', () => {
    expect(providersNeedingVerification([status({ checked_at: null })], NOW)).toHaveLength(1);
  });

  it('ignore les fournisseurs non configurés et MuAPI (hors périmètre)', () => {
    const stale = providersNeedingVerification([
      status({ provider_key: 'gemini', config_status: 'missing', checked_at: null }),
      status({ provider_key: 'muapi', checked_at: null }),
    ], NOW);
    expect(stale).toHaveLength(0);
  });

  it('gère un statut absent sans erreur', () => {
    expect(providersNeedingVerification(null, NOW)).toEqual([]);
  });
});

describe('Écran Business Grow — expiration des contrôles', () => {
  const businessMocks = vi.hoisted(() => ({ getStatus: vi.fn(), getQuota: vi.fn() }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  vi.mock('../src/business/api', () => ({
    BusinessGrowApiError: class extends Error {
      code: string | null;
      constructor(message: string, code?: string | null) { super(message); this.code = code ?? null; }
    },
    businessGrowApi: {
      getStatus: businessMocks.getStatus,
      getQuota: businessMocks.getQuota,
      listConversations: async () => ({ conversations: [] }),
      listMessages: async () => ({ messages: [] }),
      getMemory: async () => ({ consent: false, policyVersion: null, profile: null, items: [] }),
      listModels: async () => ({ models: [], remoteModels: {} }),
      listRequests: async () => ({ requests: [] }),
      listTools: async () => ({ tools: [] }),
      listIntegrations: async () => ({ connections: [] }),
      listRouting: async () => ({ preferences: [] }),
    },
  }));

  it('explique l’expiration au lieu de laisser croire à une panne', async () => {
    businessMocks.getStatus.mockResolvedValue({ providers: [staleStatus()] });
    businessMocks.getQuota.mockResolvedValue({
      domain: 'business_grow', period_key: '2026-11', period_used: 0, reserved_units: 0,
      available_units: 50, lifetime_consumed: 0, monthly_allowance: 50, studio_ugc_untouched: true,
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');

    await waitFor(() => expect(screen.getByTestId('business-stale-providers')).toBeTruthy());
    expect(screen.getByTestId('business-stale-providers').textContent).toContain('24 h');
    expect(screen.getByRole('button', { name: /Ouvrir les services IA/ })).toBeTruthy();
    expect(screen.getByTestId('business-overall-status').textContent).toContain('IA non disponible');
  });

  it('signale la dégradation du secours quand un seul service reste vérifié', async () => {
    businessMocks.getStatus.mockResolvedValue({
      providers: [status({
        checked_at: new Date().toISOString(),
        status: 'available',
        enabled: true,
      }), staleStatus({ provider_key: 'gemini', display_name: 'Gemini' })],
    });
    businessMocks.getQuota.mockResolvedValue({
      domain: 'business_grow', period_key: '2026-11', period_used: 0, reserved_units: 0,
      available_units: 50, lifetime_consumed: 0, monthly_allowance: 50, studio_ugc_untouched: true,
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');

    await waitFor(() => expect(screen.getByTestId('business-overall-status').textContent).toContain('1 service(s) IA vérifié(s)'));
    const notice = await screen.findByTestId('business-stale-providers');
    expect(notice.textContent).toContain('secours automatique est dégradé');
    expect(notice.textContent).not.toContain('Aucune réponse ne sera simulée');
  });

  it('n’affiche aucune alerte quand un service est réellement vérifié', async () => {
    businessMocks.getStatus.mockResolvedValue({ providers: [status({})] });
    businessMocks.getQuota.mockResolvedValue({
      domain: 'business_grow', period_key: '2026-11', period_used: 1, reserved_units: 0,
      available_units: 49, lifetime_consumed: 1, monthly_allowance: 50, studio_ugc_untouched: true,
    });

    render(<MemoryRouter><BusinessGrow /></MemoryRouter>);
    await screen.findByTestId('business-grow');

    await waitFor(() => expect(screen.getByTestId('business-overall-status').textContent).toContain('1 service(s) IA vérifié(s)'));
    expect(screen.queryByTestId('business-stale-providers')).toBeNull();
  });
});
