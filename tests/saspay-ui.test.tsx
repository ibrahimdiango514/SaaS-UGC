// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const invokeEdge = vi.fn();
const rpc = vi.fn();
const refreshQuota = vi.fn(async () => undefined);

vi.mock('../src/lib/api', () => ({
  invokeEdge: (...args: unknown[]) => invokeEdge(...args),
  rpc: (...args: unknown[]) => rpc(...args),
}));
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ quota: { credits: 0 }, refreshQuota }),
}));

import PaymentDialog, { POLL_INTERVAL_MS, POLL_MAX_MS } from '../src/components/PaymentDialog';
import PaymentReturn, { RETURN_POLL_INTERVAL_MS } from '../src/pages/PaymentReturn';
import SasPayPanel from '../src/pages/admin/SasPayPanel';
import {
  createIntentKeeper, describeFee, formatAmount, isOrderId, isPaymentProduct, isPlausiblePhone, isSafeCheckoutUrl,
  paymentStateOf,
} from '../src/lib/payments';
import { AppError } from '../src/lib/errors';

const ORDER_ID = '9004f26f-f8c8-433e-85fa-f94d6fd2be5a';
const options = (extra: Record<string, unknown> = {}) => ({
  product: 'studio', available: true, reason: null, message: null, mode: 'test', flows: ['softpay', 'checkout'],
  price: { amount: '5000.00', currency: 'XOF', label: 'Pack Creator', credits: 27 },
  countries: [{
    code: 'ML', name: 'Mali', currency: 'XOF', dial_code: '223', national_number_length: 8,
    networks: [
      { code: 'orange_ml', label: 'Orange Money', available: true, otp_required: false, fee: { fee: '100.00', mode: 'ADD_ON', total: '5100.00', net: '5000.00' } },
      { code: 'moov_ml', label: 'Moov Money', available: true, otp_required: false, fee: { fee: '200.00', mode: 'DEDUCTED', total: '5000.00', net: '4800.00' } },
      { code: 'mobi_cash_ml', label: 'Mobi Cash', available: false, otp_required: false, fee: null },
    ],
  }],
  ...extra,
});
const order = (extra: Record<string, unknown> = {}) => ({
  product: 'studio', id: ORDER_ID, status: 'processing', state: 'pending', amount: '5000.00', currency: 'XOF',
  internal_reference: 'VYS-ABC', label: 'Pack Creator', credits: 27, payment_flow: 'softpay', network_code: 'orange_ml',
  payer_msisdn_masked: '+223••••••56', quoted_total_amount: '5100.00', ...extra,
});

/** Aiguille les appels à l'Edge Function selon l'action. */
function edge(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  invokeEdge.mockImplementation(async (_name: string, body: Record<string, unknown>) => {
    const handler = handlers[String(body.action)];
    if (!handler) throw new Error(`action inattendue : ${String(body.action)}`);
    return handler(body);
  });
}
const calls = (action: string) => invokeEdge.mock.calls.filter(([, body]) => (body as { action: string }).action === action);

beforeEach(() => { invokeEdge.mockReset(); rpc.mockReset(); refreshQuota.mockClear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('aides de paiement (navigateur)', () => {
  it('formate les montants décimaux sans calcul flottant', () => {
    expect(formatAmount('5000.00')).toBe('5\u202f000\u00a0FCFA');
    expect(formatAmount('125000.5')).toBe('125\u202f000,50\u00a0FCFA');
    expect(formatAmount('999999999999999.99')).toBe('999\u202f999\u202f999\u202f999\u202f999,99\u00a0FCFA');
    expect(formatAmount('0.00')).toBe('0\u00a0FCFA');
    expect(formatAmount('12.00', 'USD')).toBe('12\u00a0USD');
    for (const bad of [null, undefined, '', 'abc', '-5', '1e3']) expect(formatAmount(bad as string)).toBe('—');
  });

  it('décrit les frais selon le mode, sans rien inventer', () => {
    expect(describeFee({ fee: '100.00', mode: 'ADD_ON', total: '5100.00', net: '5000.00' })).toContain('en sus — total débité 5\u202f100');
    expect(describeFee({ fee: '200.00', mode: 'DEDUCTED', total: '5000.00', net: '4800.00' })).toContain('sans supplément');
    expect(describeFee(null)).toContain('indiqués avant validation');
    expect(describeFee({ fee: '0.00', mode: 'ADD_ON', total: '5000.00', net: '5000.00' })).toBe('Aucuns frais de paiement.');
  });

  it('garde la même clé pour la même intention, en change si un choix change', () => {
    let n = 0;
    const keeper = createIntentKeeper(() => `id-${++n}`);
    const a = keeper.keyFor({ network: 'orange_ml', phone: '70123456' });
    expect(keeper.keyFor({ phone: '70123456', network: 'orange_ml' })).toBe(a); // ordre des champs indifférent
    const b = keeper.keyFor({ network: 'moov_ml', phone: '70123456' });
    expect(b).not.toBe(a);
    keeper.reset();
    expect(keeper.keyFor({ network: 'moov_ml', phone: '70123456' })).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
  });

  it('valide numéros, identifiants et liens', () => {
    const ml = { dial_code: '223', national_number_length: 8 };
    for (const ok of ['70123456', '70 12 34 56', '+223 70 12 34 56', '0022370123456']) expect(isPlausiblePhone(ok, ml)).toBe(true);
    for (const ko of ['', '7012345', '+33612345678', '70-12-34-5x']) expect(isPlausiblePhone(ko, ml)).toBe(false);
    expect(isOrderId(ORDER_ID)).toBe(true);
    expect(isOrderId('1 or 1=1')).toBe(false);
    expect(isPaymentProduct('studio')).toBe(true);
    expect(isPaymentProduct('admin')).toBe(false);
    expect(isSafeCheckoutUrl('https://pay.example/c/1')).toBe(true);
    for (const ko of ['http://pay.example/c/1', 'javascript:alert(1)', 'data:text/html,x', '', null]) expect(isSafeCheckoutUrl(ko)).toBe(false);
  });

  it('ramène tout statut à l’un des cinq états', () => {
    expect(paymentStateOf({ status: 'pending' })).toBe('todo');
    expect(paymentStateOf({ status: 'pending', has_payment: true })).toBe('pending');
    expect(paymentStateOf({ status: 'pending', provider_session_id: 'cs-1' })).toBe('pending');
    expect(paymentStateOf({ status: 'processing' })).toBe('pending');
    expect(paymentStateOf({ status: 'paid' })).toBe('confirmed');
    expect(paymentStateOf({ status: 'failed' })).toBe('failed');
    expect(paymentStateOf({ status: 'cancelled' })).toBe('cancelled');
    expect(paymentStateOf({ status: 'paid', state: 'bidon' })).toBe('confirmed');
  });
});

describe('fenêtre de paiement', () => {
  const renderDialog = (props: Partial<Parameters<typeof PaymentDialog>[0]> = {}) => {
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    render(<PaymentDialog open product="studio" item={{ kind: 'pack', pack_key: 'creator' }} title="Acheter" onClose={onClose} onConfirmed={onConfirmed} {...props} />);
    return { onConfirmed, onClose };
  };
  const fillPhone = (value: string) => fireEvent.change(screen.getByPlaceholderText('8 chiffres'), { target: { value } });
  const submitButton = () => screen.getByRole('button', { name: /^Payer|Continuer vers le paiement/ });

  it('affiche le prix du serveur et les frais du réseau choisi', async () => {
    edge({ options: () => options() });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('payment-price').textContent).toBe('5\u202f000\u00a0FCFA'));
    expect(invokeEdge).toHaveBeenCalledWith('vyora-payments', { action: 'options', product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(screen.getByTestId('payment-fee').textContent).toContain('total débité 5\u202f100');
    expect(submitButton().textContent).toContain('5\u202f100');
    fireEvent.click(screen.getByLabelText(/Moov Money/));
    expect(screen.getByTestId('payment-fee').textContent).toContain('sans supplément');
    expect(submitButton().textContent).toContain('5\u202f000');
    expect((screen.getByLabelText(/Mobi Cash/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Mode test')).toBeTruthy();
  });

  it('paiement indisponible : aucun formulaire, aucune commande', async () => {
    edge({ options: () => options({ available: false, reason: 'PAYMENTS_DISABLED', message: 'Le paiement en ligne n’est pas encore activé.', price: null }) });
    renderDialog();
    await waitFor(() => expect(screen.getByText('Paiement en ligne indisponible')).toBeTruthy());
    expect(screen.getByText(/pas encore activé/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Payer/ })).toBeNull();
    expect(calls('create')).toHaveLength(0);
  });

  it('service de paiement injoignable : message clair, rien n’est créé', async () => {
    invokeEdge.mockRejectedValue(new AppError('Connexion impossible.', 'EDGE_ERROR'));
    renderDialog();
    await waitFor(() => expect(screen.getByText('Paiement en ligne indisponible')).toBeTruthy());
    expect(screen.getByText(/Aucune commande n’a été créée/)).toBeTruthy();
  });

  it('refuse d’envoyer un numéro invalide', async () => {
    edge({ options: () => options() });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    fillPhone('12345');
    expect(screen.getByText('Numéro invalide pour Mali.')).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(submitButton().closest('form') as HTMLFormElement);
    expect(calls('create')).toHaveLength(0);
  });

  it('n’envoie ni prix ni crédits : seulement l’intention', async () => {
    edge({ options: () => options(), create: () => ({ order: order(), next: 'await_confirmation', reused: false }) });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70 12 34 56');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText('Paiement en attente de confirmation')).toBeTruthy());
    const body = calls('create')[0][1] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['action', 'country', 'flow', 'idempotency_key', 'item', 'network', 'phone', 'product']);
    expect(body).toMatchObject({ action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay', network: 'orange_ml', phone: '70 12 34 56' });
    expect(String(body.idempotency_key)).toMatch(/^vyora-[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/amount|price|credits|5000|5100/);
    expect(screen.getByText(/Rien n’est crédité tant que SasPay n’a pas confirmé/)).toBeTruthy();
  });

  it('double clic : un seul appel de création', async () => {
    let release: (value: unknown) => void = () => undefined;
    edge({ options: () => options(), create: () => new Promise((resolve) => { release = resolve; }) });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70123456');
    const form = submitButton().closest('form') as HTMLFormElement;
    fireEvent.submit(form); fireEvent.submit(form); fireEvent.submit(form);
    expect(calls('create')).toHaveLength(1);
    await act(async () => { release({ order: order(), next: 'await_confirmation', reused: false }); });
  });

  it('nouvel essai après une erreur : même clé si rien ne change, nouvelle clé si le réseau change', async () => {
    let attempt = 0;
    edge({
      options: () => options(),
      create: () => { attempt += 1; throw new AppError('SasPay ne répond pas pour le moment. Aucun crédit n’a été accordé.', 'PAYMENT_PROVIDER_UNAVAILABLE'); },
    });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70123456');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/SasPay ne répond pas/)).toBeTruthy());
    fireEvent.click(submitButton());
    await waitFor(() => expect(attempt).toBe(2));
    fireEvent.click(screen.getByLabelText(/Moov Money/));
    await waitFor(() => expect((submitButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(attempt).toBe(3));
    const keys = calls('create').map(([, body]) => (body as { idempotency_key: string }).idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('n’annonce la confirmation qu’après la réponse « confirmé » du serveur', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses = [order(), order(), order({ status: 'paid', state: 'confirmed' })];
    edge({
      options: () => options(),
      create: () => ({ order: order(), next: 'await_confirmation', reused: false }),
      status: () => ({ order: statuses.shift() ?? order({ status: 'paid', state: 'confirmed' }), verified: true, credited: true, message: null }),
    });
    const { onConfirmed } = renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70123456');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText('Paiement en attente de confirmation')).toBeTruthy());
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByText('Paiement confirmé')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    expect(onConfirmed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
    await waitFor(() => expect(screen.getByText('Paiement confirmé')).toBeTruthy());
    expect(screen.getByText(/27 crédits ont été ajoutés/)).toBeTruthy();
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    // Une fois l'état final atteint, le suivi s'arrête.
    const polled = calls('status').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5); });
    expect(calls('status')).toHaveLength(polled);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('échec : rien n’est crédité, « Réessayer » repart avec une nouvelle clé', async () => {
    edge({
      options: () => options(),
      create: () => ({ order: order({ status: 'failed', state: 'failed', failure_code: 'insufficient_funds' }), next: 'failed', reused: false }),
    });
    const { onConfirmed } = renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70123456');
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByTestId('payment-result').getAttribute('data-state')).toBe('failed'));
    expect(screen.getByText(/Rien n’a été crédité/)).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    fillPhone('70123456');
    fireEvent.click(submitButton());
    await waitFor(() => expect(calls('create')).toHaveLength(2));
    const keys = calls('create').map(([, body]) => (body as { idempotency_key: string }).idempotency_key);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('attente prolongée : arrête d’interroger et l’explique, sans annoncer de succès', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    edge({
      options: () => options(),
      create: () => ({ order: order(), next: 'await_confirmation', reused: false }),
      status: () => ({ order: order(), verified: true, credited: false, message: null }),
    });
    const { onConfirmed } = renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fillPhone('70123456');
    fireEvent.click(submitButton());
    await waitFor(() => screen.getByText('Paiement en attente de confirmation'));
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MAX_MS + POLL_INTERVAL_MS * 2); });
    await waitFor(() => expect(screen.getByText('Toujours en attente')).toBeTruthy());
    const polled = calls('status').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10); });
    expect(calls('status')).toHaveLength(polled);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByText('Paiement confirmé')).toBeNull();
  });

  it('page sécurisée : redirige uniquement vers un lien https', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    edge({
      options: () => options({ flows: ['checkout'] }),
      create: () => ({ order: order({ status: 'pending', payment_flow: 'checkout', checkout_url: 'https://pay.example/c/cs-1' }), next: 'redirect', reused: false }),
    });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fireEvent.click(submitButton());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://pay.example/c/cs-1'));
    const body = calls('create')[0][1] as Record<string, unknown>;
    expect(body.flow).toBe('checkout');
    expect('phone' in body).toBe(false);
    expect('network' in body).toBe(false);
  });

  it('page sécurisée : un lien non https est refusé', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    edge({
      options: () => options({ flows: ['checkout'] }),
      create: () => ({ order: order({ status: 'pending', payment_flow: 'checkout', checkout_url: 'javascript:alert(1)' }), next: 'redirect', reused: false }),
    });
    renderDialog();
    await waitFor(() => screen.getByTestId('payment-price'));
    fireEvent.click(submitButton());
    await waitFor(() => expect(screen.getByText(/lien de paiement reçu est invalide/)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('page de retour de paiement', () => {
  const renderReturn = (search: string) => render(
    <MemoryRouter initialEntries={[`/app/paiement/retour${search}`]}>
      <Routes><Route path="/app/paiement/retour" element={<PaymentReturn />} /></Routes>
    </MemoryRouter>,
  );

  it('ne crédite rien sur la foi de l’adresse : paramètres « succès » ignorés', async () => {
    edge({ status: () => ({ order: order(), verified: true, credited: false, message: null }) });
    renderReturn(`?produit=studio&commande=${ORDER_ID}&status=SUCCESS&paid=true&credits=9999`);
    await waitFor(() => expect(screen.getByText('Paiement en attente de confirmation')).toBeTruthy());
    expect(screen.queryByText('Paiement confirmé')).toBeNull();
    expect(refreshQuota).not.toHaveBeenCalled();
    // Seuls le produit et l'identifiant de commande partent au serveur.
    expect(invokeEdge).toHaveBeenCalledWith('vyora-payments', { action: 'status', product: 'studio', order_id: ORDER_ID });
  });

  it('affiche la confirmation quand le serveur l’annonce, et rafraîchit le solde une fois', async () => {
    edge({ status: () => ({ order: order({ status: 'paid', state: 'confirmed' }), verified: true, credited: true, message: null }) });
    renderReturn(`?produit=studio&commande=${ORDER_ID}`);
    await waitFor(() => expect(screen.getByText('Paiement confirmé')).toBeTruthy());
    expect(screen.getByText(/27 crédits ont été ajoutés/)).toBeTruthy();
    expect(refreshQuota).toHaveBeenCalledTimes(1);
    expect(calls('status')).toHaveLength(1);
  });

  it('suit un paiement en attente jusqu’à sa confirmation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses = [order(), order({ status: 'paid', state: 'confirmed' })];
    edge({ status: () => ({ order: statuses.shift() ?? order({ status: 'paid', state: 'confirmed' }), verified: true, credited: true, message: null }) });
    renderReturn(`?produit=studio&commande=${ORDER_ID}`);
    await waitFor(() => expect(screen.getByText('Paiement en attente de confirmation')).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(RETURN_POLL_INTERVAL_MS); });
    await waitFor(() => expect(screen.getByText('Paiement confirmé')).toBeTruthy());
  });

  it('paiement annulé ou échoué : le dit, sans crédit', async () => {
    edge({ status: () => ({ order: order({ status: 'cancelled', state: 'cancelled' }), verified: true, credited: false, message: null }) });
    renderReturn(`?produit=studio&commande=${ORDER_ID}`);
    await waitFor(() => expect(screen.getByText('Paiement annulé')).toBeTruthy());
    expect(screen.getByText(/Rien n’a été crédité/)).toBeTruthy();
    expect(refreshQuota).not.toHaveBeenCalled();
  });

  it('lien invalide : aucun appel au serveur', async () => {
    for (const search of ['', '?produit=studio', '?produit=admin&commande=' + ORDER_ID, '?produit=studio&commande=../../x']) {
      renderReturn(search);
      expect(screen.getByText('Lien de retour invalide')).toBeTruthy();
      cleanup();
    }
    expect(invokeEdge).not.toHaveBeenCalled();
  });

  it('commande d’un autre compte : « introuvable », sans insister', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invokeEdge.mockRejectedValue(new AppError('Commande introuvable.', 'PAYMENT_NOT_FOUND'));
    renderReturn(`?produit=studio&commande=${ORDER_ID}`);
    await waitFor(() => expect(screen.getByText('Commande introuvable')).toBeTruthy());
    await act(async () => { await vi.advanceTimersByTimeAsync(RETURN_POLL_INTERVAL_MS * 5); });
    expect(invokeEdge).toHaveBeenCalledTimes(1);
  });

  it('Business Grow : renvoie vers la page d’abonnement Business Grow', async () => {
    edge({ status: () => ({ order: order({ product: 'business', status: 'paid', state: 'confirmed', credits: undefined }), verified: true, credited: true, message: null }) });
    renderReturn(`?produit=business&commande=${ORDER_ID}`);
    await waitFor(() => expect(screen.getByText('Votre abonnement Business Grow est actif.')).toBeTruthy());
    expect(screen.getByText('Retour à l’abonnement Business Grow').getAttribute('href')).toBe('/app/business/abonnement');
    // Un paiement Business Grow ne touche pas le solde Studio.
    expect(refreshQuota).not.toHaveBeenCalled();
  });
});

describe('administration — panneau SasPay (lecture seule)', () => {
  const adminOrder = (extra: Record<string, unknown> = {}) => order({ user_email: 'client@vyora.test', provider_payment_id: 'tx-1', ...extra, state: undefined });

  it('affiche un solde par pays, sans total, et le gel éventuel', async () => {
    edge({ balances: () => ({ configured: true, mode: 'test', message: null, balances: [
      { id: 'b1', country: 'ML', currency: 'XOF', available_amount: '125000.00', pending_amount: '5000.00', is_frozen: false },
      { id: 'b2', country: 'SN', currency: 'XOF', available_amount: '900.00', pending_amount: '0.00', is_frozen: true },
    ] }) });
    rpc.mockResolvedValue([]);
    render(<SasPayPanel />);
    await waitFor(() => expect(screen.getAllByTestId('saspay-balance')).toHaveLength(2));
    const [mali, senegal] = screen.getAllByTestId('saspay-balance').map((node) => node.textContent ?? '');
    expect(mali).toContain('ML · XOF');
    expect(mali).toContain('125\u202f000\u00a0FCFA');
    expect(mali).toContain('5\u202f000\u00a0FCFA'); // en attente de règlement
    expect(senegal).toContain('900\u00a0FCFA');
    // Jamais additionnés : aucun total (125 900 ou 130 900) n'apparaît nulle part.
    const panel = screen.getByTestId('saspay-panel').textContent ?? '';
    expect(panel).not.toContain('125\u202f900');
    expect(panel).not.toContain('130\u202f900');
    expect(panel).not.toMatch(/Total/i);
    expect(screen.getByText('Gelé')).toBeTruthy();
    expect(screen.getByText('Mode test')).toBeTruthy();
    expect(screen.getByText(/aucun retrait, transfert ni recharge/)).toBeTruthy();
  });

  it('solde illisible : « non vérifié », jamais zéro', async () => {
    invokeEdge.mockRejectedValue(new AppError('La clé SasPay est refusée.', 'PAYMENT_PROVIDER_UNAUTHORIZED'));
    rpc.mockResolvedValue([]);
    render(<SasPayPanel />);
    await waitFor(() => expect(screen.getByText('Soldes non vérifiés')).toBeTruthy());
    expect(screen.queryAllByTestId('saspay-balance')).toHaveLength(0);
    expect(screen.getByTestId('saspay-panel').textContent ?? '').not.toContain('FCFA');
  });

  it('liste les paiements sans aucune action de modification', async () => {
    edge({ balances: () => ({ configured: false, mode: null, balances: [], message: null }) });
    rpc.mockResolvedValue([
      adminOrder({ id: 'o-paid', status: 'paid', fee_amount: '100.00', charged_amount: '5100.00', net_amount: '5000.00' }),
      adminOrder({ id: 'o-pending', status: 'processing' }),
      adminOrder({ id: 'o-failed', status: 'failed', failure_code: 'insufficient_funds' }),
    ]);
    render(<SasPayPanel />);
    await waitFor(() => expect(screen.getAllByTestId('saspay-order')).toHaveLength(3));
    expect(rpc).toHaveBeenCalledWith('vyora_admin_payments', { p_product: 'studio', p_limit: 100 });
    const paid = screen.getAllByTestId('saspay-order')[0].textContent ?? '';
    expect(paid).toContain('Débité : 5\u202f100\u00a0FCFA');
    expect(paid).toContain('Frais : 100\u00a0FCFA');
    expect(paid).toContain('Net reçu : 5\u202f000\u00a0FCFA');
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const label of labels) expect(label).not.toMatch(/Confirmer|Valider|Créditer|Modifier|Supprimer|Rembourser|Retirer|Transférer/i);
    // Seule action : redemander l'état à SasPay, et seulement pour un paiement non terminé.
    expect(screen.getAllByRole('button', { name: 'Revérifier' })).toHaveLength(1);
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });

  it('« Revérifier » interroge le serveur sans rien écrire', async () => {
    edge({
      balances: () => ({ configured: false, mode: null, balances: [], message: null }),
      status: () => ({ order: order(), verified: true, credited: false, message: null }),
    });
    rpc.mockResolvedValue([adminOrder({ status: 'processing' })]);
    render(<SasPayPanel />);
    await waitFor(() => screen.getByRole('button', { name: 'Revérifier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revérifier' }));
    await waitFor(() => expect(calls('status')).toHaveLength(1));
    expect(calls('status')[0][1]).toEqual({ action: 'status', product: 'studio', order_id: ORDER_ID });
    await waitFor(() => expect(screen.getByText(/état vérifié auprès de SasPay/)).toBeTruthy());
    expect(rpc.mock.calls.every(([name]) => name === 'vyora_admin_payments')).toBe(true);
  });

  it('Studio et Business Grow sont listés séparément', async () => {
    edge({ balances: () => ({ configured: false, mode: null, balances: [], message: null }) });
    rpc.mockResolvedValue([]);
    render(<SasPayPanel />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('vyora_admin_payments', { p_product: 'studio', p_limit: 100 }));
    fireEvent.click(screen.getByText('Business Grow (abonnements)'));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('vyora_admin_payments', { p_product: 'business', p_limit: 100 }));
  });
});
