// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const invokeEdge = vi.fn();
const rpc = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

vi.mock('../src/lib/api', () => ({
  invokeEdge: (...args: unknown[]) => invokeEdge(...args),
  rpc: (...args: unknown[]) => rpc(...args),
}));
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ quota: { credits: 12 }, refreshQuota: vi.fn(async () => undefined) }),
}));
vi.mock('../src/context/ToastContext', () => ({ useToast: () => toast }));

import StudioPricing from '../src/pages/StudioPricing';
import BusinessGrowSubscription from '../src/pages/BusinessGrowSubscription';

const grid = {
  credit_value_xof: 100,
  packs: [
    { pack_key: 'creator', label: 'Creator', price_xof: 5000, credits: 27 },
    { pack_key: 'pro_creator', label: 'Pro Creator', price_xof: 15000, credits: 95, recommended: true },
  ],
  custom_recharge: { min_xof: 5000, max_xof: 350000, step_xof: 1000 },
  examples: [], target_margin_percent: 60, updated_at: '2026-11-12T10:00:00Z',
};
const studioOptions = (available: boolean) => ({
  product: 'studio', available, reason: available ? null : 'PAYMENTS_DISABLED',
  message: available ? null : 'Le paiement en ligne n’est pas encore activé.', mode: 'test', flows: ['softpay', 'checkout'],
  price: null,
  countries: [{ code: 'ML', name: 'Mali', currency: 'XOF', dial_code: '223', national_number_length: 8, networks: [{ code: 'orange_ml', label: 'Orange Money', available: true, otp_required: false, fee: null }] }],
});
const rpcCalls = (name: string) => rpc.mock.calls.filter(([n]) => n === name);
const edgeCalls = (action: string) => invokeEdge.mock.calls.filter(([, b]) => (b as { action: string }).action === action);

function mockRpc(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = {
    studio_credit_grid: grid,
    studio_credit_history: { purchases: [], ledger: [] },
    vyora_my_payments: [],
    studio_purchase_pack: { credits: 27, price_xof: 5000, status: 'pending' },
    vyora_business_subscription: null,
    ...overrides,
  };
  rpc.mockImplementation(async (name: string) => {
    if (!(name in table)) throw new Error(`rpc inattendue : ${name}`);
    return table[name];
  });
}

beforeEach(() => { invokeEdge.mockReset(); rpc.mockReset(); Object.values(toast).forEach((fn) => fn.mockReset()); });
afterEach(cleanup);

describe('page Crédits Studio', () => {
  const renderPage = () => render(<MemoryRouter><StudioPricing /></MemoryRouter>);

  it('paiement en ligne désactivé : le parcours existant (validation administrateur) est inchangé', async () => {
    mockRpc();
    invokeEdge.mockResolvedValue(studioOptions(false));
    renderPage();
    await waitFor(() => expect(screen.getByText('Creator')).toBeTruthy());
    expect(screen.getByText(/confirmation du paiement par un administrateur/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Choisir ce pack/ })[0]);
    await waitFor(() => expect(rpcCalls('studio_purchase_pack')).toHaveLength(1));
    expect(rpcCalls('studio_purchase_pack')[0][1]).toMatchObject({ p_pack_key: 'creator', p_provider: 'admin' });
    expect(edgeCalls('create')).toHaveLength(0);
    expect(screen.queryByTestId('payment-dialog')).toBeNull();
  });

  it('service de paiement absent (fonction non déployée) : même repli, sans erreur', async () => {
    mockRpc();
    invokeEdge.mockRejectedValue(new Error('Function not found'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Creator')).toBeTruthy());
    expect(screen.getByText(/confirmation du paiement par un administrateur/)).toBeTruthy();
    expect(screen.getByText('Crédits estimés')).toBeTruthy();
  });

  it('paiement en ligne activé : ouvre la fenêtre SasPay, sans créer de commande manuelle', async () => {
    mockRpc();
    invokeEdge.mockImplementation(async (_n: string, body: { action: string; item?: unknown }) => {
      if (body.action === 'options') {
        return { ...studioOptions(true), price: body.item ? { amount: '5000.00', currency: 'XOF', label: 'Pack Creator', credits: 27 } : null };
      }
      throw new Error(`action inattendue : ${body.action}`);
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/dès que le paiement est confirmé par SasPay/)).toBeTruthy());
    // Aucune estimation locale de crédits : seul le devis du serveur fait foi.
    expect(screen.queryByText('Crédits estimés')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /Choisir ce pack/ })[0]);
    await waitFor(() => expect(screen.getByTestId('payment-price')).toBeTruthy());
    expect(edgeCalls('options').at(-1)?.[1]).toEqual({ action: 'options', product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(rpcCalls('studio_purchase_pack')).toHaveLength(0);
    expect(rpcCalls('ugc_create_recharge_order')).toHaveLength(0);
  });

  it('liste les paiements en ligne avec l’un des cinq états et un lien de suivi', async () => {
    mockRpc({ vyora_my_payments: [
      { product: 'studio', id: 'a1', status: 'paid', amount: '5000.00', currency: 'XOF', internal_reference: 'VYS-1', label: 'Pack Creator', created_at: '2026-11-12T10:00:00Z', has_payment: true },
      { product: 'studio', id: 'a2', status: 'processing', amount: '15000.00', currency: 'XOF', internal_reference: 'VYS-2', label: 'Pack Pro Creator', created_at: '2026-11-12T11:00:00Z', has_payment: true },
      { product: 'studio', id: 'a3', status: 'failed', amount: '5000.00', currency: 'XOF', internal_reference: 'VYS-3', label: 'Pack Creator', created_at: '2026-11-12T12:00:00Z', has_payment: true },
    ] });
    invokeEdge.mockResolvedValue(studioOptions(false));
    renderPage();
    await waitFor(() => expect(screen.getByText('Paiements en ligne')).toBeTruthy());
    expect(rpc).toHaveBeenCalledWith('vyora_my_payments', { p_product: 'studio', p_limit: 20 });
    expect(screen.getByText('Confirmé')).toBeTruthy();
    expect(screen.getByText('En attente')).toBeTruthy();
    expect(screen.getByText('Échoué')).toBeTruthy();
    const follow = screen.getAllByText('Suivre');
    expect(follow).toHaveLength(1);
    expect(follow[0].getAttribute('href')).toBe('/app/paiement/retour?produit=studio&commande=a2');
  });
});

describe('page Tarifs Studio — remboursements', () => {
  it('affiche l’état du remboursement et son montant, sans notes internes', async () => {
    const base = { product: 'studio', amount: '5000.00', currency: 'XOF', label: 'Pack Creator', has_payment: true, status: 'refunded' };
    mockRpc({ vyora_my_payments: [
      { ...base, id: 'r1', internal_reference: 'VYS-1', created_at: '2026-11-12T10:00:00Z', refund_state: 'credits_recovered', refund_amount: '3148.00', refunded_at: '2026-11-13T10:00:00Z' },
      { ...base, id: 'r2', internal_reference: 'VYS-2', created_at: '2026-11-11T10:00:00Z', refund_state: 'settled', refund_amount: '5000.00', refunded_at: '2026-11-12T10:00:00Z' },
    ] });
    invokeEdge.mockResolvedValue(studioOptions(false));
    render(<MemoryRouter><StudioPricing /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Paiements en ligne')).toBeTruthy());
    const list = screen.getByLabelText('Paiements en ligne').textContent ?? '';
    expect(list).toContain('Remboursement en cours · 3\u202f148\u00a0FCFA');
    expect(list).toContain('Remboursé · 5\u202f000\u00a0FCFA');
    // Un paiement remboursé n'est plus présenté comme « Confirmé » et n'a rien à suivre.
    expect(screen.queryByText('Confirmé')).toBeNull();
    expect(screen.queryByText('Suivre')).toBeNull();
  });
});

describe('page Abonnement Business Grow', () => {
  const plan = (extra: Record<string, unknown> = {}) => ({
    plan_key: 'croissance', display_name: 'Croissance', tagline: null, monthly_price_minor: null, currency: 'XOF',
    monthly_credit_units: null, features: [], active: false, ...extra,
  });
  const priced = plan({ active: true, monthly_price_minor: 25000, monthly_credit_units: 400 });
  const businessOptions = (available: boolean, message: string | null = null) => ({
    product: 'business', available, reason: available ? null : 'BUSINESS_BILLING_DISABLED', message, mode: 'test',
    flows: ['softpay'], price: null, countries: [],
  });
  const renderPage = () => render(<MemoryRouter><BusinessGrowSubscription /></MemoryRouter>);
  const subscribeButtons = () => screen.queryAllByRole('button', { name: /Souscrire|Prolonger/ });

  it('état actuel de la production (facturation désactivée, aucun prix) : rien n’est achetable', async () => {
    mockRpc({ business_grow_catalog: { plans: [plan(), plan({ plan_key: 'scale', display_name: 'Scale' })], billing_enabled: false, config: null } });
    invokeEdge.mockResolvedValue(businessOptions(false, 'La facturation Business Grow n’est pas activée.'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Croissance')).toBeTruthy());
    expect(screen.getByText('Facturation Business Grow non activée')).toBeTruthy();
    expect(subscribeButtons()).toHaveLength(0);
    expect(screen.getAllByText('Prix à définir').length).toBe(2);
    for (const button of screen.getAllByRole('button', { name: /Souscription indisponible/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('formule tarifée mais serveur de paiement indisponible : toujours inachetable', async () => {
    mockRpc({ business_grow_catalog: { plans: [priced], billing_enabled: true, config: null } });
    invokeEdge.mockResolvedValue(businessOptions(false, 'Le paiement en ligne n’est pas encore activé'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Croissance')).toBeTruthy());
    expect(subscribeButtons()).toHaveLength(0);
    expect(screen.getByText('Souscription en ligne indisponible')).toBeTruthy();
  });

  it('catalogue annoncé « facturable » mais service de paiement injoignable : inachetable', async () => {
    mockRpc({ business_grow_catalog: { plans: [priced], billing_enabled: true, config: null } });
    invokeEdge.mockRejectedValue(new Error('Function not found'));
    renderPage();
    await waitFor(() => expect(screen.getByText('Croissance')).toBeTruthy());
    expect(subscribeButtons()).toHaveLength(0);
  });

  it('une formule sans prix n’est jamais achetable, même paiement disponible', async () => {
    // Formules actives, quota défini, mais prix absent ou nul : seul le prix manque.
    mockRpc({ business_grow_catalog: { plans: [
      plan({ plan_key: 'essentiel', display_name: 'Essentiel', active: true, monthly_credit_units: 400, monthly_price_minor: null }),
      plan({ plan_key: 'scale', display_name: 'Scale', active: true, monthly_credit_units: 400, monthly_price_minor: 0 }),
      plan({ plan_key: 'inactive', display_name: 'Inactive', active: false, monthly_credit_units: 400, monthly_price_minor: 9000 }),
      priced,
    ], billing_enabled: true, config: null } });
    invokeEdge.mockResolvedValue(businessOptions(true));
    renderPage();
    await waitFor(() => expect(subscribeButtons()).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: /Souscription indisponible/ })).toHaveLength(3);
  });

  it('souscription : n’envoie que la clé de formule', async () => {
    mockRpc({ business_grow_catalog: { plans: [priced], billing_enabled: true, config: null } });
    invokeEdge.mockImplementation(async (_n: string, body: { action: string; item?: unknown }) => ({
      ...businessOptions(true),
      price: body.item ? { amount: '25000.00', currency: 'XOF', label: 'Business Grow — Croissance', period_days: 30 } : null,
      flows: ['checkout'],
    }));
    renderPage();
    await waitFor(() => expect(subscribeButtons()).toHaveLength(1));
    fireEvent.click(subscribeButtons()[0]);
    await waitFor(() => expect(screen.getByTestId('payment-price').textContent).toBe('25\u202f000\u00a0FCFA'));
    expect(edgeCalls('options').at(-1)?.[1]).toEqual({ action: 'options', product: 'business', item: { plan_key: 'croissance' } });
    expect(screen.getByText(/30 jours, sans renouvellement automatique/)).toBeTruthy();
    // Aucun vocabulaire Studio dans le parcours Business Grow.
    expect(screen.getByTestId('payment-dialog').textContent ?? '').not.toMatch(/Crédits Studio/);
  });

  it('abonnement en cours : prolongation de la même formule seulement', async () => {
    mockRpc({
      business_grow_catalog: { plans: [priced, { ...priced, plan_key: 'scale', display_name: 'Scale' }], billing_enabled: true, config: null },
      vyora_business_subscription: { plan_key: 'croissance', plan_label: 'Croissance', status: 'active', current_period_start: '2026-11-12T10:00:00Z', current_period_end: '2026-12-12T10:00:00Z', is_current: true },
    });
    invokeEdge.mockResolvedValue(businessOptions(true));
    renderPage();
    await waitFor(() => expect(screen.getByText('Abonnement actif : Croissance')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: /Prolonger de 30 jours/ })).toHaveLength(1);
    const blocked = screen.getByRole('button', { name: /Souscription indisponible/ }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toContain('changement de formule');
  });
});
