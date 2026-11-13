// @vitest-environment jsdom
// Prix tout compris à l'écran : le client voit le prix final, jamais les frais ;
// l'administrateur voit base, provision, frais, net et marge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import PaymentDialog from '../src/components/PaymentDialog';
import StudioPricing from '../src/pages/StudioPricing';
import BusinessGrowSubscription from '../src/pages/BusinessGrowSubscription';
import SasPayPanel from '../src/pages/admin/SasPayPanel';
import SasPayFinance from '../src/pages/admin/SasPayFinance';
import {
  ANOMALY_ADVICE, ANOMALY_LABELS, catalogPrice, describeFee, finalPrice, formatCents, formatPercentMilli, parseScaled,
} from '../src/lib/payments';
import { asAppError } from '../src/lib/errors';

const FCFA = (text: string) => `${text.replace(/ /g, '\u202f')}\u00a0FCFA`;
const network = (code: string, label: string) => ({ code, label, available: true, otp_required: false, fee: null });
const country = (price: string | null) => ({
  code: 'ML', name: 'Mali', currency: 'XOF', dial_code: '223', national_number_length: 8,
  networks: [network('orange_ml', 'Orange Money'), network('moov_ml', 'Moov Money')],
  ...(price ? { price: { amount: price, currency: 'XOF' } } : {}),
});
const itemOptions = (extra: Record<string, unknown> = {}) => ({
  product: 'studio', available: true, reason: null, message: null, mode: 'live', flows: ['softpay', 'checkout'],
  price: { amount: '6000.00', currency: 'XOF', label: 'Pack Creator', credits: 27 },
  countries: [country('6000.00')], all_inclusive: true, catalog: null, ...extra,
});
const edgeCalls = (action: string) => invokeEdge.mock.calls.filter(([, b]) => (b as { action: string }).action === action);
const rpcCalls = (name: string) => rpc.mock.calls.filter(([n]) => n === name);

function mockRpc(table: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
    if (!(name in table)) throw new Error(`rpc inattendue : ${name}`);
    const value = table[name];
    return typeof value === 'function' ? (value as (a: Record<string, unknown>) => unknown)(args) : value;
  });
}

beforeEach(() => { invokeEdge.mockReset(); rpc.mockReset(); Object.values(toast).forEach((fn) => fn.mockReset()); });
afterEach(cleanup);

describe('aides de prix (navigateur)', () => {
  it('prix tout compris : une seule phrase, aucun montant de frais', () => {
    const text = describeFee({ fee: '150.00', mode: 'DEDUCTED', total: '6000.00', net: '5850.00' }, 'XOF', true);
    expect(text).toBe('Prix final, frais de paiement inclus : aucun supplément ne sera ajouté.');
    expect(text).not.toMatch(/\d/);
  });

  it('prix final : celui du pays, sinon le prix général', () => {
    expect(finalPrice({ price: { amount: '6000.00', currency: 'XOF' } }, { price: { amount: '6100.00', currency: 'XOF' } })).toBe('6100.00');
    expect(finalPrice({ price: { amount: '6000.00', currency: 'XOF' } }, { price: null })).toBe('6000.00');
    expect(finalPrice(null, null)).toBeNull();
  });

  it('prix de catalogue : final si le serveur le fournit, grille sinon', () => {
    const on = { available: true, all_inclusive: true, catalog: { creator: { amount: '6000.00', max_amount: '6000.00', currency: 'XOF' } } };
    expect(catalogPrice(on, 'creator', 5000)).toEqual({ label: FCFA('6 000'), amount: 6000, from: false });
    expect(catalogPrice(on, 'inconnu', 5000).amount).toBe(5000);
    expect(catalogPrice({ ...on, available: false }, 'creator', 5000).amount).toBe(5000);
    expect(catalogPrice({ ...on, all_inclusive: false }, 'creator', 5000).amount).toBe(5000);
    expect(catalogPrice({ ...on, catalog: { creator: { amount: 'abc', currency: 'XOF' } } }, 'creator', 5000).amount).toBe(5000);
    expect(catalogPrice({ ...on, catalog: { creator: { amount: '6000.00', max_amount: '6200.00', currency: 'XOF' } } }, 'creator', 5000).from).toBe(true);
    expect(catalogPrice(null, 'creator', 5000).label).toBe(FCFA('5 000'));
  });

  it('centièmes, taux et saisies : conversions exactes, sans flottant', () => {
    expect(formatCents(600000)).toBe(FCFA('6 000'));
    expect(formatCents(256413)).toBe(`2\u202f564,13\u00a0FCFA`);
    expect(formatCents(-20000)).toBe(`−${FCFA('200')}`);
    expect(formatCents(0)).toBe(FCFA('0'));
    expect(formatCents(null)).toBe('—');
    expect(formatPercentMilli(2500)).toBe('2,5\u00a0%');
    expect(formatPercentMilli(1000)).toBe('1\u00a0%');
    expect(formatPercentMilli(1875)).toBe('1,875\u00a0%');
    expect(formatPercentMilli(null)).toBe('—');
    expect(parseScaled('2,5', 3)).toBe(2500);
    expect(parseScaled('1.875', 3)).toBe(1875);
    expect(parseScaled('0,1', 3)).toBe(100);
    expect(parseScaled('1 000', 2)).toBe(100000);
    expect(parseScaled('19,99', 2)).toBe(1999);
    expect(parseScaled('2,5001', 3)).toBeNull();
    expect(parseScaled('-1', 2)).toBeNull();
    expect(parseScaled('', 2)).toBeNull();
    expect(parseScaled('1e3', 2)).toBeNull();
  });

  it('alertes financières : libellé et consigne pour chaque genre', () => {
    for (const kind of ['fee_exceeds_provision', 'net_below_base', 'fee_mode_unexpected', 'reconciliation_failed']) {
      expect(ANOMALY_LABELS[kind]).toBeTruthy();
      expect(ANOMALY_ADVICE[kind]).toBeTruthy();
    }
    expect(asAppError(new Error('tariff_source_required')).message).toMatch(/d’où vient ce tarif/);
    expect(asAppError(new Error('fee_schedule_is_append_only')).message).toMatch(/fermez-la/);
  });
});

describe('fenêtre de paiement — prix tout compris', () => {
  const renderDialog = () => render(
    <PaymentDialog open product="studio" item={{ kind: 'pack', pack_key: 'creator' }} title="Acheter" onClose={vi.fn()} onConfirmed={vi.fn()} />,
  );

  it('affiche le prix final, le même pour chaque opérateur, sans ligne de frais', async () => {
    invokeEdge.mockResolvedValue(itemOptions());
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('payment-price').textContent).toBe(FCFA('6 000')));
    expect(screen.getByText('Prix à payer')).toBeTruthy();
    expect(screen.getByTestId('payment-fee').textContent).toBe('Prix final, frais de paiement inclus : aucun supplément ne sera ajouté.');
    expect(screen.getByRole('button', { name: /^Payer/ }).textContent).toContain(FCFA('6 000'));
    fireEvent.click(screen.getByLabelText(/Moov Money/));
    expect(screen.getByRole('button', { name: /^Payer/ }).textContent).toContain(FCFA('6 000'));
    // Ni prix de base, ni provision, ni frais, ni net.
    const text = screen.getByTestId('payment-dialog').textContent ?? '';
    expect(text).not.toContain('5\u202f000');
    expect(text).not.toContain('1\u202f000');
    expect(text).not.toMatch(/provision|en sus|net reçu|frais estimés/i);
  });

  it('un devis de frais reçu par erreur n’est jamais affiché ni ajouté', async () => {
    const leaky = country('6000.00');
    leaky.networks[0] = { ...leaky.networks[0], fee: { fee: '150.00', mode: 'ADD_ON', total: '6150.00', net: '6000.00' } } as never;
    invokeEdge.mockResolvedValue(itemOptions({ countries: [leaky] }));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('payment-price').textContent).toBe(FCFA('6 000')));
    expect(screen.getByRole('button', { name: /^Payer/ }).textContent).toContain(FCFA('6 000'));
    expect(screen.getByTestId('payment-dialog').textContent).not.toContain('6\u202f150');
  });

  it('page de paiement hébergée : même annonce de prix final', async () => {
    invokeEdge.mockResolvedValue(itemOptions({ flows: ['checkout'] }));
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('payment-price').textContent).toBe(FCFA('6 000')));
    expect(screen.getByTestId('payment-fee').textContent).toMatch(/aucun supplément/);
  });

  it('le navigateur n’envoie ni prix ni montant : le serveur recalcule', async () => {
    invokeEdge.mockImplementation(async (_n: string, body: Record<string, unknown>) => {
      if (body.action === 'options') return itemOptions();
      return { order: { product: 'studio', id: '9004f26f-f8c8-433e-85fa-f94d6fd2be5a', status: 'processing', state: 'pending', amount: '6000.00', currency: 'XOF', internal_reference: 'VYS-1', quoted_total_amount: '6000.00', payer_msisdn_masked: '+223••••••56' }, next: 'await_confirmation', message: null };
    });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fireEvent.change(screen.getByPlaceholderText('8 chiffres'), { target: { value: '70123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^Payer/ }));
    await waitFor(() => expect(edgeCalls('create')).toHaveLength(1));
    const body = edgeCalls('create')[0][1] as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toMatch(/amount|price|fee|6000|5000/);
    await waitFor(() => expect(screen.getByText(/Validez la demande de/).textContent).toContain(FCFA('6 000')));
  });
});

describe('pages de tarifs — prix final', () => {
  const grid = {
    credit_value_xof: 100,
    packs: [
      { pack_key: 'creator', label: 'Creator', price_xof: 5000, credits: 27 },
      { pack_key: 'pro_creator', label: 'Pro Creator', price_xof: 15000, credits: 95, recommended: true },
    ],
    custom_recharge: { min_xof: 5000, max_xof: 350000, step_xof: 1000 },
    examples: [], target_margin_percent: 60, updated_at: '2026-11-12T10:00:00Z',
  };
  const studioRpc = () => mockRpc({ studio_credit_grid: grid, studio_credit_history: { purchases: [], ledger: [] }, vyora_my_payments: [] });
  const catalog = { creator: { amount: '6000.00', max_amount: '6000.00', currency: 'XOF' }, pro_creator: { amount: '16000.00', max_amount: '16000.00', currency: 'XOF' } };

  it('Studio : les packs affichent 6 000 et 16 000 FCFA, pas le prix de base', async () => {
    studioRpc();
    invokeEdge.mockResolvedValue(itemOptions({ price: null, catalog }));
    render(<MemoryRouter><StudioPricing /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('pack-price-creator').textContent).toBe(FCFA('6 000')));
    expect(screen.getByTestId('pack-price-pro_creator').textContent).toBe(FCFA('16 000'));
    expect(screen.getByText(/Prix finals, frais de paiement inclus/)).toBeTruthy();
    expect(screen.getByText('Valeur de la recharge (FCFA)')).toBeTruthy();
    expect(screen.getByText('95 crédits')).toBeTruthy();
  });

  it('Studio : paiement en ligne indisponible → prix de la grille, parcours historique', async () => {
    studioRpc();
    invokeEdge.mockResolvedValue(itemOptions({ available: false, price: null, catalog }));
    render(<MemoryRouter><StudioPricing /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('pack-price-creator').textContent).toBe(FCFA('5 000')));
    expect(screen.queryByText(/Prix finals/)).toBeNull();
    expect(screen.getByText('Montant (FCFA)')).toBeTruthy();
  });

  it('Studio : politique de prix désactivée → prix de la grille', async () => {
    studioRpc();
    invokeEdge.mockResolvedValue(itemOptions({ price: null, all_inclusive: false, catalog: null }));
    render(<MemoryRouter><StudioPricing /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('pack-price-creator').textContent).toBe(FCFA('5 000')));
  });

  it('Business Grow : la formule à 25 000 FCFA est annoncée 26 000 FCFA', async () => {
    mockRpc({
      business_grow_catalog: { billing_enabled: true, config: null, plans: [{
        plan_key: 'croissance', display_name: 'Croissance', tagline: null, monthly_price_minor: 25000, currency: 'XOF',
        monthly_credit_units: 400, features: [], active: true,
      }] },
      vyora_business_subscription: null, vyora_my_payments: [],
    });
    invokeEdge.mockResolvedValue(itemOptions({ product: 'business', price: null, flows: ['softpay'], catalog: { croissance: { amount: '26000.00', max_amount: '26000.00', currency: 'XOF' } } }));
    render(<MemoryRouter><BusinessGrowSubscription /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Croissance')).toBeTruthy());
    const page = document.body.textContent ?? '';
    expect(page).toContain(FCFA('26 000'));
    expect(page).not.toMatch(/25\s000/);
  });
});

describe('administration — prix, frais et marge', () => {
  const policy = { enabled: true, strategy: 'cover_fees', fee_charge_mode: 'DEDUCTED', currencies: { XOF: { provision_cents: 100000, rounding_step_cents: 100 } } };
  const tariff = (extra: Record<string, unknown> = {}) => ({
    id: 't1', transaction_type: 'payin', country_code: 'ML', currency: 'XOF', network_code: 'orange_ml', min_amount_cents: 0,
    max_amount_cents: null, percent_milli: 2500, fixed_cents: 0, floor_fee_cents: 5000, cap_fee_cents: null, fee_base: 'total',
    account_fee_mode: 'ADD_ON', valid_from: '2026-11-12T10:00:00Z', valid_until: null, source: 'saspay_account_rates',
    source_note: 'GET /pricing/my-rates/', created_at: '2026-11-12T10:00:00Z', closed_at: null, active: true, ...extra,
  });
  const overview = (extra: Record<string, unknown> = {}) => ({
    policy, tariffs: [], missing_reconciliations: 0, account_add_on_lines: 0,
    missing_tariffs: [{ country_code: 'ML', currency: 'XOF', network_code: 'orange_ml', network_label: 'Orange Money', flow: 'softpay' }],
    ...extra,
  });
  const stats = (extra: Record<string, unknown> = {}) => ({
    transactions: 2, currency: 'XOF', currencies: 1, gross_cents: 1200000, base_cents: 1000000, provision_cents: 200000,
    fee_known: 2, fee_unknown: 0, actual_fee_cents: 135000, actual_net_cents: 1065000, margin_cents: 65000, estimated: 0,
    estimated_fee_cents: 0, expected_net_cents: 0, compared: 0, fee_variance_cents: 0, refunded_cents: 0, refunded: 0,
    unprofitable: 1, over_provision: 1, tariff_missing: 2, ...extra,
  });
  const line = (extra: Record<string, unknown> = {}) => ({
    product: 'studio', order_id: 'o1', internal_reference: 'VYS-1', item_key: 'creator', country_code: 'ML', network: 'orange_ml',
    currency: 'XOF', base_cents: 500000, provision_cents: 100000, final_cents: 600000, charged_cents: 600000,
    estimated_fee_cents: null, actual_fee_cents: 120000, actual_net_cents: 480000, margin_cents: -20000, flags: ['tariff_missing', 'fee_exceeds_provision', 'net_below_base'],
    paid_at: '2026-11-12T11:00:00Z', ...extra,
  });
  const report = (extra: Record<string, unknown> = {}) => ({
    totals: stats(), by_country: [{ ...stats(), country_code: 'ML' }], by_network: [{ ...stats(), network: 'orange_ml' }],
    by_product: [{ ...stats(), product: 'studio', item_key: 'creator' }], unprofitable: [line()],
    recent: [line(), line({ order_id: 'o2', internal_reference: 'VYS-2', actual_fee_cents: 15000, actual_net_cents: 585000, margin_cents: 85000, flags: ['tariff_missing'] })],
    ...extra,
  });
  const table = (extra: Record<string, unknown> = {}) => ({ vyora_admin_pricing_overview: overview(), vyora_admin_finance_report: report(), ...extra });

  it('l’onglet financier ne charge rien tant qu’il n’est pas ouvert', async () => {
    invokeEdge.mockResolvedValue({ configured: false, mode: null, message: null, balances: [] });
    mockRpc({ ...table(), vyora_admin_payments: [], vyora_admin_payment_health: null });
    render(<SasPayPanel />);
    await waitFor(() => expect(rpcCalls('vyora_admin_payments')).toHaveLength(1));
    expect(rpcCalls('vyora_admin_pricing_overview')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Prix, frais et marge' }));
    await waitFor(() => expect(screen.getByTestId('finance-policy')).toBeTruthy());
    expect(rpcCalls('vyora_admin_pricing_overview')).toHaveLength(1);
  });

  it('barème vide : frais « non confirmés », jamais zéro', async () => {
    mockRpc(table());
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByTestId('tariffs-empty')).toBeTruthy());
    expect(screen.getByText('Frais non confirmés')).toBeTruthy();
    expect(screen.getByTestId('finance-tariffs').textContent).toContain('ML · orange_ml');
  });

  it('rapport : brut, frais réels, net, marge et paiements déficitaires', async () => {
    mockRpc(table());
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByTestId('finance-totals')).toBeTruthy());
    const totals = screen.getByTestId('finance-totals').textContent ?? '';
    expect(totals).toContain(FCFA('12 000'));   // brut
    expect(totals).toContain(FCFA('1 350'));    // frais réels
    expect(totals).toContain(FCFA('10 650'));   // net reçu
    expect(totals).toContain(FCFA('650'));      // marge
    expect(totals).toContain('aucun tarif confirmé à comparer');
    const bad = screen.getAllByTestId('finance-unprofitable');
    expect(bad).toHaveLength(1);
    expect(bad[0].textContent).toContain(`−${FCFA('200')}`);
    expect(bad[0].textContent).toContain('Frais supérieurs à la provision');
    expect(screen.getAllByTestId('finance-line')).toHaveLength(2);
  });

  it('frais non restitués par SasPay : « — », pas un zéro', async () => {
    mockRpc(table({ vyora_admin_finance_report: report({
      totals: stats({ fee_known: 0, fee_unknown: 2, actual_fee_cents: 0, actual_net_cents: 0, margin_cents: 0, unprofitable: 0, over_provision: 0 }),
      by_country: [], by_network: [], by_product: [], unprofitable: [], recent: [],
    }) }));
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByTestId('finance-totals')).toBeTruthy());
    const totals = screen.getByTestId('finance-totals');
    expect(within(totals).getByText('Net reçu').nextSibling?.textContent).toBe('—');
    expect(within(totals).getByText('Frais SasPay réels').nextSibling?.textContent).toBe('—');
    expect(totals.textContent).toContain('2 paiement(s) sans frais restitués');
  });

  it('rapport illisible : « non vérifié », aucun chiffre', async () => {
    mockRpc(table({ vyora_admin_finance_report: () => { throw new Error('boom'); } }));
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByText('Rapport non vérifié')).toBeTruthy());
    expect(screen.queryByTestId('finance-totals')).toBeNull();
  });

  it('politique illisible : aucune valeur par défaut inventée', async () => {
    mockRpc(table({ vyora_admin_pricing_overview: { tariffs: [] } }));
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByText('Tarification non vérifiée')).toBeTruthy());
    expect(screen.queryByTestId('finance-policy')).toBeNull();
  });

  it('enregistre la provision en centièmes entiers et conserve les autres devises', async () => {
    const withGnf = { ...policy, currencies: { ...policy.currencies, GNF: { provision_cents: 1000000, rounding_step_cents: 10000 } } };
    mockRpc(table({ vyora_admin_pricing_overview: overview({ policy: withGnf }), vyora_admin_set_pricing_policy: withGnf }));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-policy'));
    const input = screen.getByLabelText(/^Provision par transaction/) as HTMLInputElement;
    expect(input.value).toBe('1000');
    fireEvent.change(input, { target: { value: '1 500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la politique' }));
    await waitFor(() => expect(rpcCalls('vyora_admin_set_pricing_policy')).toHaveLength(1));
    expect(rpcCalls('vyora_admin_set_pricing_policy')[0][1]).toEqual({ p_policy: {
      enabled: true, strategy: 'cover_fees',
      currencies: { XOF: { provision_cents: 150000, rounding_step_cents: 100 }, GNF: { provision_cents: 1000000, rounding_step_cents: 10000 } },
    } });
  });

  it('provision non entière : enregistrement impossible', async () => {
    mockRpc(table());
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-policy'));
    fireEvent.change(screen.getByLabelText(/^Provision par transaction/), { target: { value: '999,5' } });
    expect((screen.getByRole('button', { name: 'Enregistrer la politique' }) as HTMLButtonElement).disabled).toBe(true);
    expect(rpcCalls('vyora_admin_set_pricing_policy')).toHaveLength(0);
  });

  it('import des tarifs du compte : appel serveur unique, résultat affiché', async () => {
    mockRpc(table());
    invokeEdge.mockResolvedValue({ mode: 'live', inserted: 3, unchanged: 1, closed: 0, skipped: 0 });
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-tariffs'));
    fireEvent.click(screen.getByRole('button', { name: /Importer les tarifs du compte/ }));
    await waitFor(() => expect(screen.getByText(/3 ligne\(s\) ajoutée\(s\), 1 inchangée\(s\)/)).toBeTruthy());
    expect(invokeEdge).toHaveBeenCalledTimes(1);
    expect(invokeEdge).toHaveBeenCalledWith('vyora-payments', { action: 'sync_rates' });
  });

  it('import refusé : le barème est annoncé comme non modifié', async () => {
    mockRpc(table());
    invokeEdge.mockRejectedValue(new Error('SasPay n’a renvoyé aucun tarif exploitable. Le barème n’a pas été modifié.'));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-tariffs'));
    fireEvent.click(screen.getByRole('button', { name: /Importer les tarifs du compte/ }));
    await waitFor(() => expect(screen.getByText('Import impossible')).toBeTruthy());
    expect(screen.getByText(/barème n’a pas été modifié/)).toBeTruthy();
  });

  it('ligne importée : taux, minimum, origine, et avertissement « frais ajoutés »', async () => {
    mockRpc(table({ vyora_admin_pricing_overview: overview({ tariffs: [tariff()], missing_tariffs: [], account_add_on_lines: 1 }) }));
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByTestId('tariff-line')).toBeTruthy());
    const text = screen.getByTestId('tariff-line').textContent ?? '';
    expect(text).toContain('2,5\u00a0%');
    expect(text).toContain(`minimum ${FCFA('50')}`);
    expect(text).toContain('Tarifs du compte SasPay (import)');
    expect(screen.getByText('Le compte SasPay ajoute les frais au client par défaut')).toBeTruthy();
    expect(screen.queryByText('Frais non confirmés')).toBeNull();
  });

  it('ajout manuel : taux en millièmes de pour cent, montants en centièmes, origine obligatoire', async () => {
    mockRpc(table({ vyora_admin_add_tariff: tariff() }));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-tariffs'));
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une ligne' }));
    const form = within(screen.getByTestId('tariff-form'));
    const submit = () => form.getByRole('button', { name: 'Ajouter la ligne' }) as HTMLButtonElement;
    fireEvent.change(form.getByLabelText(/^Taux/), { target: { value: '2,5' } });
    fireEvent.change(form.getByLabelText(/^Frais minimum/), { target: { value: '50' } });
    fireEvent.change(form.getByLabelText(/^Opérateur/), { target: { value: 'orange_ml' } });
    expect(submit().disabled).toBe(true); // origine non renseignée
    fireEvent.change(form.getByLabelText(/^Référence du tarif/), { target: { value: 'Grille SasPay Mali, novembre 2026' } });
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await waitFor(() => expect(rpcCalls('vyora_admin_add_tariff')).toHaveLength(1));
    expect(rpcCalls('vyora_admin_add_tariff')[0][1]).toEqual({ p_tariff: {
      transaction_type: 'payin', country_code: 'ML', currency: 'XOF', network_code: 'orange_ml', min_amount_cents: 0,
      max_amount_cents: null, percent_milli: 2500, fixed_cents: 0, floor_fee_cents: 5000, cap_fee_cents: null, fee_base: 'total',
      source: 'owner_provided', source_note: 'Grille SasPay Mali, novembre 2026',
    } });
  });

  it('tarif nul : refusé tant qu’il n’est pas confirmé explicitement', async () => {
    mockRpc(table({ vyora_admin_add_tariff: tariff() }));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-tariffs'));
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter une ligne' }));
    const form = within(screen.getByTestId('tariff-form'));
    fireEvent.change(form.getByLabelText(/^Référence du tarif/), { target: { value: 'Courriel SasPay du 12/11' } });
    const submit = form.getByRole('button', { name: 'Ajouter la ligne' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(form.getByText(/réellement de 0/));
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(rpcCalls('vyora_admin_add_tariff')).toHaveLength(1));
    expect((rpcCalls('vyora_admin_add_tariff')[0][1] as { p_tariff: Record<string, unknown> }).p_tariff).toMatchObject({ percent_milli: 0, fixed_cents: 0, confirmed_free: true });
  });

  it('simulateur : affiche le calcul du serveur ; sans tarif, frais « non confirmés »', async () => {
    const sim = (extra: Record<string, unknown> = {}) => ({
      policy_enabled: true, strategy: 'cover_fees', currency: 'XOF', country: 'ML', network: null, base_cents: 500000,
      provision_cents: 100000, final_cents: 600000, surcharge_cents: 100000, estimated_fee_cents: null, expected_net_cents: null,
      expected_margin_cents: null, tariff_status: 'missing', tariff: null, ...extra,
    });
    mockRpc(table({ vyora_admin_price_simulation: (args: Record<string, unknown>) => (args.p_base_cents === 10000000
      ? sim({ base_cents: 10000000, final_cents: 10256500, surcharge_cents: 256500, estimated_fee_cents: 256413, expected_net_cents: 10000087, expected_margin_cents: 87, tariff_status: 'confirmed' })
      : sim()) }));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-simulator'));
    const card = within(screen.getByTestId('finance-simulator'));
    fireEvent.click(card.getByRole('button', { name: 'Simuler' }));
    await waitFor(() => expect(screen.getByTestId('simulation-result')).toBeTruthy());
    expect(rpcCalls('vyora_admin_price_simulation')[0][1]).toEqual({ p_base_cents: 500000, p_currency: 'XOF', p_country: 'ML', p_network: null });
    let text = screen.getByTestId('simulation-result').textContent ?? '';
    expect(text).toContain(FCFA('6 000'));
    expect(text).toContain('Non confirmés');
    fireEvent.change(card.getByLabelText('Prix de base (FCFA)'), { target: { value: '100000' } });
    fireEvent.click(card.getByRole('button', { name: 'Simuler' }));
    await waitFor(() => expect(screen.getByTestId('simulation-result').textContent).toContain(FCFA('102 565')));
    text = screen.getByTestId('simulation-result').textContent ?? '';
    expect(text).toContain('2\u202f564,13\u00a0FCFA');
    expect(text).toContain('100\u202f000,87\u00a0FCFA');
    expect(text).toContain('prix a été relevé');
  });

  it('décaissement : estimation sans provision, aucun versement', async () => {
    mockRpc(table({ vyora_admin_payout_simulation: { amount_cents: 5000000, provision_cents: 0, estimated_fee_cents: null, tariff_status: 'missing', account_fee_mode: null } }));
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-simulator'));
    const card = within(screen.getByTestId('finance-simulator'));
    fireEvent.change(card.getByLabelText('Opération'), { target: { value: 'payout' } });
    fireEvent.change(card.getByLabelText('Montant à verser (FCFA)'), { target: { value: '50000' } });
    fireEvent.click(card.getByRole('button', { name: 'Simuler' }));
    await waitFor(() => expect(screen.getByTestId('payout-result')).toBeTruthy());
    const text = screen.getByTestId('payout-result').textContent ?? '';
    expect(text).toContain('Aucune (la provision ne s’applique qu’aux encaissements)');
    expect(text).toContain('Non confirmés');
    expect(text).toContain('VYORA n’exécute aucun décaissement');
    expect(invokeEdge).not.toHaveBeenCalled();
  });

  it('filtres du rapport : transmis au serveur', async () => {
    mockRpc(table());
    render(<SasPayFinance />);
    await waitFor(() => screen.getByTestId('finance-totals'));
    const card = within(screen.getByTestId('finance-report'));
    fireEvent.change(card.getByLabelText('Pays'), { target: { value: 'ML' } });
    fireEvent.change(card.getByLabelText('Opérateur'), { target: { value: 'orange_ml' } });
    fireEvent.change(card.getByLabelText('Produit'), { target: { value: 'business' } });
    fireEvent.click(card.getByRole('button', { name: 'Filtrer' }));
    await waitFor(() => expect(rpcCalls('vyora_admin_finance_report').length).toBeGreaterThan(1));
    expect(rpcCalls('vyora_admin_finance_report').at(-1)?.[1]).toMatchObject({ p_country: 'ML', p_network: 'orange_ml', p_product: 'business', p_from: null, p_to: null });
  });

  it('paiements anciens non rapprochés : reprise de l’historique proposée', async () => {
    mockRpc(table({ vyora_admin_pricing_overview: overview({ missing_reconciliations: 4 }), vyora_admin_finance_backfill: { recorded: 4 } }));
    render(<SasPayFinance />);
    await waitFor(() => expect(screen.getByText('Paiements non rapprochés')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reprendre l’historique' }));
    await waitFor(() => expect(rpcCalls('vyora_admin_finance_backfill')).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/4 paiement\(s\) ancien\(s\) ajouté\(s\)/)).toBeTruthy());
  });
});
