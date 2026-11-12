import { describe, expect, it } from 'vitest';
import { createSasPayClient } from '../supabase/functions/_shared/saspay/client';
import {
  PaymentError, constantTimeEqual, createPaymentService, maskMsisdn, normalizeMsisdn, orderReferenceIn, paymentState,
  publicOrder,
  type OrderRecord,
} from '../supabase/functions/_shared/saspay/payments';
import {
  CRON_TOKEN, LIVE_KEY, ML_COUNTRY, NOW, TEST_KEY, WEBHOOK_SECRET, createFakeSasPay, createFakeStore, jsonResponse,
  signedWebhook, type FakeStoreOptions,
} from './helpers/saspay-fakes';

const alice = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@example.ml', name: 'Alice Koné' };
const bob = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@example.ml', name: 'Bob' };
const boss = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'boss@example.ml', name: 'Boss' };

function setup(options: FakeStoreOptions & { key?: string | null; webhookSecret?: string | null } = {}) {
  const fake = createFakeStore({ admins: [boss.id], ...options });
  const saspay = createFakeSasPay();
  const clock = { now: NOW };
  const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
  const key = options.key === undefined ? TEST_KEY : options.key;
  const service = createPaymentService({
    store: fake.store,
    client: key ? createSasPayClient({ secretKey: key, fetcher: saspay.fetcher }) : null,
    webhookSecret: options.webhookSecret === undefined ? WEBHOOK_SECRET : options.webhookSecret,
    now: () => clock.now,
    log: (event, details) => logs.push({ event, details }),
  });
  return { ...fake, saspay, service, clock, logs };
}

const softpay = (key: string, extra: Record<string, unknown> = {}) => ({
  product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay',
  network: 'orange_ml', phone: '70 12 34 56', idempotency_key: key, ...extra,
});
const checkout = (key: string, extra: Record<string, unknown> = {}) => ({
  product: 'studio', item: { kind: 'pack', pack_key: 'pro_creator' }, country: 'ML', flow: 'checkout',
  idempotency_key: key, ...extra,
});

async function expectError(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PaymentError);
  expect((error as PaymentError).code).toBe(code);
  if (status) expect((error as PaymentError).status).toBe(status);
  return error as PaymentError;
}

describe('paiement SasPay — devis et options', () => {
  it('renvoie le prix serveur et les frais estimés par réseau, selon le mode de frais du compte', async () => {
    const { service } = setup();
    const result = await service.options(alice, { product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(result.available).toBe(true);
    expect(result.price).toMatchObject({ amount: '5000.00', currency: 'XOF', credits: 27 });
    const networks = result.countries[0].networks;
    expect(networks.map((n) => n.code)).toEqual(['orange_ml', 'moov_ml', 'mobi_cash_ml']);
    // Orange : frais en sus (ADD_ON) → le client paie 5 100, le marchand reçoit 5 000.
    expect(networks[0]).toMatchObject({ available: true, fee: { fee: '100.00', mode: 'ADD_ON', total: '5100.00', net: '5000.00' } });
    // Moov : frais déduits (DEDUCTED) → le client paie 5 000, le marchand reçoit 4 800.
    expect(networks[1]).toMatchObject({ available: true, fee: { fee: '200.00', mode: 'DEDUCTED', total: '5000.00', net: '4800.00' } });
    // Mobi Cash : réseau non disponible pour ce compte marchand.
    expect(networks[2]).toMatchObject({ available: false, fee: null });
  });

  it('signale un paiement désactivé sans appeler SasPay', async () => {
    const { service, saspay } = setup({ enabled: false });
    const result = await service.options(alice, { product: 'studio' });
    expect(result).toMatchObject({ available: false, reason: 'PAYMENTS_DISABLED' });
    expect(saspay.calls).toHaveLength(0);
  });

  it('signale l’absence de clé serveur', async () => {
    const { service } = setup({ key: null });
    expect(await service.options(alice, { product: 'studio' })).toMatchObject({ available: false, reason: 'PAYMENTS_NOT_CONFIGURED' });
  });

  it('refuse une clé de production tant que le mode configuré est « test » (et inversement)', async () => {
    const live = setup({ key: LIVE_KEY, mode: 'test' });
    expect(await live.service.options(alice, { product: 'studio' })).toMatchObject({ available: false, reason: 'PAYMENT_MODE_MISMATCH' });
    await expectError(live.service.create(alice, softpay('idem-key-0001')), 'PAYMENT_MODE_MISMATCH', 503);
    expect(live.saspay.count('POST', '/payments')).toBe(0);
    expect(live.orders.size).toBe(0);

    const test = setup({ key: TEST_KEY, mode: 'live' });
    await expectError(test.service.create(alice, softpay('idem-key-0001')), 'PAYMENT_MODE_MISMATCH', 503);
    expect(test.saspay.count('POST', '/payments')).toBe(0);
  });

  it('reste utilisable si la grille tarifaire SasPay est illisible (frais non estimés)', async () => {
    const { service, saspay } = setup();
    saspay.respondWith((call) => (call.path === '/pricing/my-rates/' ? jsonResponse({ error: { code: 'x', message: 'down' } }, 503) : undefined));
    const result = await service.options(alice, { product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(result.available).toBe(true);
    expect(result.countries[0].networks.every((n) => n.available && n.fee === null)).toBe(true);
  });

  it('indique qu’un administrateur ne peut pas acheter de crédits Studio', async () => {
    const { service } = setup();
    expect(await service.options(boss, { product: 'studio' })).toMatchObject({ available: false, reason: 'PAYMENT_NOT_ELIGIBLE' });
  });
});

describe('paiement SasPay — création (softpay)', () => {
  it('fige le prix côté serveur et initie le paiement avec la référence interne comme clé d’idempotence', async () => {
    const { service, saspay, orders } = setup();
    const result = await service.create(alice, softpay('idem-key-0001'));
    expect(result.next).toBe('await_confirmation');
    expect(result.order).toMatchObject({
      product: 'studio', status: 'processing', state: 'pending', amount: '5000.00', currency: 'XOF',
      network_code: 'orange_ml', payer_msisdn_masked: '+223••••••56',
      quoted_fee_amount: '100.00', quoted_total_amount: '5100.00', quoted_fee_mode: 'ADD_ON',
    });
    const call = saspay.calls.find((c) => c.path === '/payments/softpay/');
    const order = [...orders.values()][0];
    expect(call?.headers['idempotency-key']).toBe(order.internal_reference);
    expect(call?.body).toEqual({
      // Le prix du produit, SANS les frais : SasPay les applique une seule fois.
      amount: '5000.00', currency: 'XOF', country: 'ML', network: 'orange_ml',
      customer: { email: 'alice@example.ml', first_name: 'Alice', last_name: 'Koné', phone: '+22370123456' },
      // La référence interne figure dans le libellé : la réconciliation s'en sert
      // pour retrouver un paiement dont la réponse ou le webhook s'est perdu.
      description: `Pack Creator — ${order.internal_reference}`,
      metadata: { order_reference: order.internal_reference, product: 'studio' },
    });
  });

  it('ignore tout montant ou nombre de crédits envoyé par le navigateur', async () => {
    const { service, saspay } = setup();
    const forged = softpay('idem-key-0002', {
      amount: '1.00', price: 1, credits: 999999, amount_minor: 100,
      item: { kind: 'pack', pack_key: 'creator', price_xof: 1, credits: 999999, amount: '1.00' },
    });
    const result = await service.create(alice, forged);
    expect(result.order).toMatchObject({ amount: '5000.00', credits: 27 });
    expect(saspay.calls.find((c) => c.path === '/payments/softpay/')?.body?.amount).toBe('5000.00');
  });

  it('double clic : la même intention ne crée qu’une commande et qu’un paiement', async () => {
    const { service, saspay, orders } = setup();
    const [first, second] = await Promise.all([
      service.create(alice, softpay('idem-key-0003')),
      service.create(alice, softpay('idem-key-0003')),
    ]);
    const third = await service.create(alice, softpay('idem-key-0003'));
    expect(orders.size).toBe(1);
    expect(new Set([first.order.id, second.order.id, third.order.id]).size).toBe(1);
    expect(third.reused).toBe(true);
    // Les deux appels concurrents portent la même clé d'idempotence : SasPay renvoie le paiement d'origine.
    const keys = saspay.calls.filter((c) => c.path === '/payments/softpay/').map((c) => c.headers['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
    expect(saspay.transactions.size).toBe(1);
  });

  it.each([
    ['70123456', '+22370123456'],
    ['70 12 34 56', '+22370123456'],
    ['+223 70 12 34 56', '+22370123456'],
    ['0022370123456', '+22370123456'],
    ['22370123456', '+22370123456'],
  ])('normalise le numéro %s', (input, expected) => {
    expect(normalizeMsisdn(input, ML_COUNTRY)).toBe(expected);
  });

  it.each(['', '7012345', '701234567', '+33612345678', '70-12-34-5x', 'abcdefgh', '+223', null, 70123456])(
    'refuse le numéro invalide %s', (input) => {
      expect(normalizeMsisdn(input, ML_COUNTRY)).toBeNull();
    });

  it('masque le numéro : seuls l’indicatif et les deux derniers chiffres sont conservés', () => {
    expect(maskMsisdn('+22370123456')).toBe('+223••••••56');
    expect(maskMsisdn('+22370123456')).not.toContain('701234');
  });

  it('refuse un numéro invalide avant toute création de commande', async () => {
    const { service, saspay, orders } = setup();
    await expectError(service.create(alice, softpay('idem-key-0004', { phone: '12345' })), 'PAYMENT_INVALID_PHONE', 422);
    expect(orders.size).toBe(0);
    expect(saspay.count('POST', '/payments')).toBe(0);
  });

  it('refuse réseau inconnu, réseau indisponible, pays non pris en charge et parcours inconnu', async () => {
    const { service, orders } = setup();
    await expectError(service.create(alice, softpay('idem-key-0005', { network: 'wave_sn' })), 'PAYMENT_NETWORK_NOT_SUPPORTED', 422);
    await expectError(service.create(alice, softpay('idem-key-0006', { network: 'mobi_cash_ml' })), 'PAYMENT_NETWORK_UNAVAILABLE', 422);
    await expectError(service.create(alice, softpay('idem-key-0007', { country: 'FR' })), 'PAYMENT_COUNTRY_NOT_SUPPORTED', 422);
    await expectError(service.create(alice, softpay('idem-key-0008', { flow: 'virement' })), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(service.create(alice, softpay('court')), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(service.create(alice, softpay('idem-key-0009', { product: 'autre' })), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(service.create(alice, softpay('idem-key-0010', { item: { kind: 'custom', amount_xof: 5000.5 } })), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(service.create(alice, softpay('idem-key-0011', { item: { kind: 'custom', amount_xof: '5000' } })), 'PAYMENT_INVALID_REQUEST', 400);
    expect(orders.size).toBe(0);
  });

  it('dirige vers la page sécurisée un réseau qui exige un code préalable', async () => {
    const { service, saspay } = setup();
    saspay.setRates([{ country_code: 'ML', network_code: 'orange_ml', payin: { available: true, otp_required: true, tiers: [] } }]);
    await expectError(service.create(alice, softpay('idem-key-0012')), 'PAYMENT_NETWORK_REQUIRES_OTP', 422);
  });

  it('refuse un flux désactivé dans la configuration', async () => {
    const { service } = setup({ flows: ['checkout'] });
    await expectError(service.create(alice, softpay('idem-key-0013')), 'PAYMENT_FLOW_NOT_ALLOWED', 422);
  });

  it('recharge libre : montant validé et converti côté serveur', async () => {
    const { service } = setup();
    const result = await service.create(alice, softpay('idem-key-0014', { item: { kind: 'custom', amount_xof: 7000 } }));
    expect(result.order).toMatchObject({ amount: '7000.00', credits: 37 });
    await expectError(service.create(alice, softpay('idem-key-0015', { item: { kind: 'custom', amount_xof: 4000 } })), 'PAYMENT_AMOUNT_OUT_OF_BOUNDS', 422);
  });
});

describe('paiement SasPay — erreurs du prestataire à la création', () => {
  const cases = [
    [400, 'invalid_customer', 'PAYMENT_REJECTED', 422, 'failed'],
    [401, 'authentication_failed', 'PAYMENT_PROVIDER_UNAUTHORIZED', 503, 'failed'],
    [403, 'api_key_scope_forbidden', 'PAYMENT_PROVIDER_FORBIDDEN', 503, 'failed'],
    [404, 'not_found', 'PAYMENT_PROVIDER_NOT_FOUND', 404, 'failed'],
    [409, 'idempotency_conflict', 'PAYMENT_ALREADY_IN_PROGRESS', 409, 'pending'],
    [422, 'no_route_available', 'PAYMENT_REJECTED', 422, 'failed'],
    [429, 'throttled', 'PAYMENT_RATE_LIMITED', 429, 'pending'],
    [500, 'server_error', 'PAYMENT_PROVIDER_UNAVAILABLE', 503, 'pending'],
    [503, 'unavailable', 'PAYMENT_PROVIDER_UNAVAILABLE', 503, 'pending'],
  ] as const;

  it.each(cases)('HTTP %i (%s) → %s, commande « %s »', async (status, providerCode, code, httpStatus, orderStatus) => {
    const { service, saspay, orders, credits } = setup();
    saspay.respondWith((call) => (call.path === '/payments/softpay/'
      ? jsonResponse({ success: false, error: { code: providerCode, message: `raw provider text ${TEST_KEY}` }, code: status }, status) : undefined));
    const error = await expectError(service.create(alice, softpay('idem-key-0100')), code, httpStatus);
    // Message destiné à l'utilisateur : en français, sans texte brut du prestataire ni secret.
    expect(error.message).not.toContain('raw provider text');
    expect(error.message).not.toContain('sk_');
    expect(JSON.stringify(error.details)).not.toContain('sk_');
    expect([...orders.values()][0].status).toBe(orderStatus);
    expect(credits.studio.size).toBe(0);
  });

  it('délai dépassé : la commande reste rejouable et le rejeu réutilise la même clé d’idempotence', async () => {
    const { service, saspay, orders } = setup();
    let fail = true;
    saspay.respondWith((call) => {
      if (call.path === '/payments/softpay/' && fail) throw new DOMException('timeout', 'TimeoutError');
      return undefined;
    });
    const error = await expectError(service.create(alice, softpay('idem-key-0101')), 'PAYMENT_PROVIDER_UNAVAILABLE', 503);
    expect(error.message).toContain('Aucun crédit');
    expect(error.details.retryable).toBe(true);
    expect([...orders.values()][0].status).toBe('pending');

    fail = false;
    const retry = await service.create(alice, softpay('idem-key-0101'));
    expect(retry.order.state).toBe('pending');
    expect(orders.size).toBe(1);
    const keys = saspay.calls.filter((c) => c.path === '/payments/softpay/').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('réponse 201 illisible : aucun identifiant inventé, commande non rattachée', async () => {
    const { service, saspay, orders } = setup();
    saspay.respondWith((call) => (call.path === '/payments/softpay/' ? new Response('<html>ok</html>', { status: 201 }) : undefined));
    await expectError(service.create(alice, softpay('idem-key-0102')), 'PAYMENT_PROVIDER_UNAVAILABLE', 503);
    expect([...orders.values()][0]).toMatchObject({ status: 'pending', provider_payment_id: null });
  });
});

describe('paiement SasPay — vérification du statut', () => {
  async function pending(ctx: ReturnType<typeof setup>, key = 'idem-key-0200') {
    const created = await ctx.service.create(alice, softpay(key));
    const order = ctx.orders.get(String(created.order.id)) as OrderRecord;
    return { orderId: order.id, txId: order.provider_payment_id as string };
  }

  it('PENDING → aucun crédit', async () => {
    const ctx = setup();
    const { orderId } = await pending(ctx);
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({ verified: true, credited: false, order: { state: 'pending' } });
    expect(ctx.credits.studio.get(alice.id)).toBeUndefined();
  });

  it('SUCCESS vérifié → crédit unique, frais réels enregistrés', async () => {
    const ctx = setup();
    const { orderId, txId } = await pending(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({
      verified: true, credited: true,
      order: { state: 'confirmed', status: 'paid', fee_amount: '100.00', charged_amount: '5100.00', net_amount: '5000.00' },
    });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);

    // Rejeux : aucun nouveau crédit, et plus aucun appel à SasPay une fois payée.
    const before = ctx.saspay.calls.length;
    for (let i = 0; i < 3; i += 1) {
      const again = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
      expect(again).toMatchObject({ credited: false, order: { state: 'confirmed' } });
    }
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.saspay.calls.length).toBe(before);
  });

  it('FAILED et CANCELLED → états distincts, aucun crédit', async () => {
    const ctx = setup();
    const a = await pending(ctx, 'idem-key-0201');
    const b = await pending(ctx, 'idem-key-0202');
    ctx.saspay.setTransaction(a.txId, { status: 'FAILED' });
    ctx.saspay.setTransaction(b.txId, { status: 'CANCELLED' });
    expect((await ctx.service.refresh(alice, { product: 'studio', order_id: a.orderId })).order.state).toBe('failed');
    expect((await ctx.service.refresh(alice, { product: 'studio', order_id: b.orderId })).order.state).toBe('cancelled');
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('montant ou devise vérifiés différents de la commande → aucun crédit, alerte', async () => {
    const ctx = setup();
    const a = await pending(ctx, 'idem-key-0203');
    ctx.saspay.setTransaction(a.txId, { status: 'SUCCESS', requested_amount: '50.00' });
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: a.orderId });
    expect(result.credited).toBe(false);
    expect(result.message).toContain('ne correspond pas');
    const b = await pending(ctx, 'idem-key-0204');
    ctx.saspay.setTransaction(b.txId, { status: 'SUCCESS', currency: 'USD' });
    expect((await ctx.service.refresh(alice, { product: 'studio', order_id: b.orderId })).credited).toBe(false);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('SasPay renvoie un autre paiement que celui demandé → rien n’est livré', async () => {
    const ctx = setup();
    const { orderId, txId } = await pending(ctx);
    ctx.saspay.respondWith((call) => (call.path === `/payments/${txId}/verify/`
      ? jsonResponse({ id: 'tx-AUTRE', status: 'SUCCESS', requested_amount: '5000.00', currency: 'XOF' }) : undefined));
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({ verified: false, credited: false, order: { state: 'pending' } });
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('statut inconnu ou panne du prestataire → état conservé, message clair, aucun crédit', async () => {
    const ctx = setup();
    const { orderId, txId } = await pending(ctx);
    ctx.saspay.setTransaction(txId, { status: 'COMPLETED' });
    let result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({ verified: false, credited: false, order: { state: 'pending' } });
    ctx.clock.now += 10_000;
    ctx.saspay.respondWith((call) => (call.path.includes('/verify/') ? jsonResponse({ error: { code: 'x', message: 'down' } }, 503) : undefined));
    result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result.verified).toBe(false);
    expect(result.message).toContain('ne répond pas');
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('une commande d’un autre utilisateur est introuvable (pas de fuite d’existence)', async () => {
    const ctx = setup();
    const { orderId, txId } = await pending(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const before = ctx.saspay.calls.length;
    const missing = '99999999-9999-4999-8999-999999999999';
    const foreign = await expectError(ctx.service.refresh(bob, { product: 'studio', order_id: orderId }), 'PAYMENT_NOT_FOUND', 404);
    const unknown = await expectError(ctx.service.refresh(bob, { product: 'studio', order_id: missing }), 'PAYMENT_NOT_FOUND', 404);
    expect(foreign.message).toBe(unknown.message);
    expect(ctx.saspay.calls.length).toBe(before);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('une commande Studio est introuvable sous le produit Business Grow', async () => {
    const ctx = setup();
    const { orderId } = await pending(ctx);
    await expectError(ctx.service.refresh(alice, { product: 'business', order_id: orderId }), 'PAYMENT_NOT_FOUND', 404);
    await expectError(ctx.service.refresh(alice, { product: 'studio', order_id: 'not-a-uuid' }), 'PAYMENT_INVALID_REQUEST', 400);
  });

  it('limite la fréquence des vérifications auprès de SasPay', async () => {
    const ctx = setup();
    const { orderId } = await pending(ctx);
    await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    const before = ctx.saspay.count('GET', '/payments/');
    await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(ctx.saspay.count('GET', '/payments/')).toBe(before);
    ctx.clock.now += 3_001;
    await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(ctx.saspay.count('GET', '/payments/')).toBe(before + 1);
  });
});

describe('paiement SasPay — page de paiement hébergée (checkout)', () => {
  it('crée une session, renvoie le lien https et l’adresse de retour', async () => {
    const ctx = setup();
    const result = await ctx.service.create(alice, checkout('idem-key-0300'), {
      returnUrl: (order) => `https://vyora-ugc.netlify.app/app/paiement/retour?produit=${order.product}&commande=${order.id}`,
    });
    expect(result.next).toBe('redirect');
    expect(String(result.order.checkout_url)).toMatch(/^https:\/\/pay\.saspay\.me\/c\/cs-/);
    const call = ctx.saspay.calls.find((c) => c.path === '/checkout-sessions/');
    expect(call?.body).toMatchObject({ amount: '15000.00', currency: 'XOF', country: 'ML', customer_email: 'alice@example.ml', customer_name: 'Alice Koné' });
    expect(String(call?.body?.return_url)).toContain(`commande=${result.order.id}`);
    expect(call?.headers['idempotency-key']).toBeUndefined();
  });

  it('double clic : une seule session est créée malgré l’absence d’idempotence côté SasPay', async () => {
    const ctx = setup();
    const first = await ctx.service.create(alice, checkout('idem-key-0301'));
    const second = await ctx.service.create(alice, checkout('idem-key-0301'));
    expect(second.order.checkout_url).toBe(first.order.checkout_url);
    expect(second.reused).toBe(true);
    expect(ctx.saspay.count('POST', '/checkout-sessions/')).toBe(1);
  });

  it('deux créations simultanées : une seule session est remise au client', async () => {
    const ctx = setup();
    const [first, second] = await Promise.all([
      ctx.service.create(alice, checkout('idem-key-0310')),
      ctx.service.create(alice, checkout('idem-key-0310')),
    ]);
    expect(ctx.orders.size).toBe(1);
    expect(first.order.checkout_url).toBe(second.order.checkout_url);
    expect([...ctx.orders.values()][0].checkout_url).toBe(first.order.checkout_url);
  });

  it('le retour du client ne crédite rien tant que la transaction n’est pas vérifiée SUCCESS', async () => {
    const ctx = setup();
    const created = await ctx.service.create(alice, checkout('idem-key-0302'));
    const orderId = String(created.order.id);
    const sessionId = (ctx.orders.get(orderId) as OrderRecord).provider_session_id as string;

    // 1. Le client revient sans avoir payé.
    let result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({ credited: false, order: { state: 'pending' } });

    // 2. Session marquée PAID mais sans transaction : ce seul statut ne suffit pas.
    Object.assign(ctx.saspay.sessions.get(sessionId) as object, { status: 'PAID' });
    ctx.clock.now += 5_000;
    result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result.credited).toBe(false);

    // 3. Transaction liée mais encore PENDING.
    const txId = ctx.saspay.paySession(sessionId, 'PENDING');
    ctx.clock.now += 5_000;
    result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result.credited).toBe(false);
    expect(ctx.credits.studio.size).toBe(0);

    // 4. La vérification renvoie SUCCESS : crédit.
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.clock.now += 5_000;
    result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result).toMatchObject({ credited: true, order: { state: 'confirmed', net_amount: '14550.00' } });
    expect(ctx.credits.studio.get(alice.id)).toBe(95);
  });

  it('session expirée ou annulée → commande annulée', async () => {
    const ctx = setup();
    const created = await ctx.service.create(alice, checkout('idem-key-0303'));
    const orderId = String(created.order.id);
    const sessionId = (ctx.orders.get(orderId) as OrderRecord).provider_session_id as string;
    Object.assign(ctx.saspay.sessions.get(sessionId) as object, { status: 'EXPIRED' });
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: orderId });
    expect(result.order).toMatchObject({ state: 'cancelled', failure_code: 'checkout_expired' });
  });

  it('session refusée par SasPay → commande échouée, aucun lien', async () => {
    const ctx = setup();
    ctx.saspay.respondWith((call) => (call.path === '/checkout-sessions/'
      ? jsonResponse({ success: false, error: { amount: ['too low'] }, code: 400 }, 400) : undefined));
    await expectError(ctx.service.create(alice, checkout('idem-key-0304')), 'PAYMENT_REJECTED', 422);
    expect([...ctx.orders.values()][0]).toMatchObject({ status: 'failed', checkout_url: null });
  });
});

describe('paiement SasPay — webhook', () => {
  async function paidOrder(ctx: ReturnType<typeof setup>, txStatus = 'SUCCESS', key = 'idem-key-0400') {
    const created = await ctx.service.create(alice, softpay(key));
    const order = ctx.orders.get(String(created.order.id)) as OrderRecord;
    ctx.saspay.setTransaction(order.provider_payment_id as string, { status: txStatus });
    return { orderId: order.id, txId: order.provider_payment_id as string };
  }
  const event = (txId: string, name = 'transaction.success', extra: Record<string, unknown> = {}) => ({
    event: name, data: { id: txId, reference: 'SP-REF', type: 'payin', status: 'SUCCESS', amount: '5000.00', currency: 'XOF', msisdn: '+22370123456', ...extra },
  });

  it('webhook valide → vérification serveur puis crédit', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    const signed = await signedWebhook(event(txId));
    const result = await ctx.service.webhook(signed.raw, signed);
    expect(result).toMatchObject({ received: true, outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.saspay.count('GET', `/payments/${txId}/verify/`)).toBe(1);
  });

  it('webhook rejoué ×5 (retentatives SasPay) → un seul crédit', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    for (let i = 0; i < 5; i += 1) {
      // SasPay régénère l'horodatage et la signature à chaque tentative.
      const signed = await signedWebhook(event(txId), { timestamp: Math.floor(NOW / 1000) + i });
      await ctx.service.webhook(signed.raw, signed);
    }
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.calls.filter((c) => c === 'settle:SUCCESS')).toHaveLength(1);
  });

  it('webhook et vérification simultanés → un seul crédit', async () => {
    const ctx = setup();
    const { orderId, txId } = await paidOrder(ctx);
    const signed = await signedWebhook(event(txId));
    await Promise.all([
      ctx.service.webhook(signed.raw, signed),
      ctx.service.refresh(alice, { product: 'studio', order_id: orderId }),
      ctx.service.webhook(signed.raw, signed),
    ]);
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('signature invalide, absente ou expirée → 401, aucun traitement', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    const good = await signedWebhook(event(txId));
    const calls = ctx.saspay.calls.length;
    await expectError(ctx.service.webhook(good.raw, { signature: 'a'.repeat(64), timestamp: good.timestamp }), 'WEBHOOK_SIGNATURE_INVALID', 401);
    await expectError(ctx.service.webhook(good.raw, { signature: null, timestamp: good.timestamp }), 'WEBHOOK_SIGNATURE_INVALID', 401);
    await expectError(ctx.service.webhook(good.raw, { signature: good.signature, timestamp: null }), 'WEBHOOK_SIGNATURE_INVALID', 401);
    const wrongSecret = await signedWebhook(event(txId), { secret: 'autre-secret' });
    await expectError(ctx.service.webhook(wrongSecret.raw, wrongSecret), 'WEBHOOK_SIGNATURE_INVALID', 401);
    const old = await signedWebhook(event(txId), { timestamp: Math.floor(NOW / 1000) - 301 });
    await expectError(ctx.service.webhook(old.raw, old), 'WEBHOOK_SIGNATURE_INVALID', 401);
    // Corps altéré après signature (montant gonflé).
    await expectError(ctx.service.webhook(good.raw.replace('5000.00', '900000.00'), good), 'WEBHOOK_SIGNATURE_INVALID', 401);
    expect(ctx.saspay.calls.length).toBe(calls);
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.webhooks.size).toBe(0);
  });

  it('webhook « success » arrivé avant que SasPay ne confirme : il reste rejouable, sa relance livre (une seule fois)', async () => {
    const ctx = setup();
    const order = await paidOrder(ctx, 'PENDING', 'idem-key-0410');
    // 1re livraison : SasPay vérifie encore « en attente » → rien n'est crédité.
    let signed = await signedWebhook(event(order.txId));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ received: true, outcome: 'pending', credited: false });
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.webhooks.get(`transaction.success:${order.txId}`)).toBe('failed');
    // SasPay confirme ensuite ; le MÊME événement est relivré : il est revérifié, pas écarté comme doublon.
    ctx.saspay.setTransaction(order.txId, { status: 'SUCCESS' });
    signed = await signedWebhook(event(order.txId));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ received: true, outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    // Livraisons suivantes : doublon acquitté, aucun second crédit.
    for (let i = 0; i < 3; i += 1) {
      signed = await signedWebhook(event(order.txId));
      expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ received: true, duplicate: true });
    }
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('sans secret de webhook configuré, tout est refusé', async () => {
    const ctx = setup({ webhookSecret: null });
    const signed = await signedWebhook(event('tx-1'));
    await expectError(ctx.service.webhook(signed.raw, signed), 'WEBHOOK_NOT_CONFIGURED', 503);
  });

  it('un webhook « success » signé ne crédite rien si la vérification dit PENDING ou FAILED', async () => {
    const ctx = setup();
    const a = await paidOrder(ctx, 'PENDING', 'idem-key-0401');
    let signed = await signedWebhook(event(a.txId));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ outcome: 'pending', credited: false });
    const b = await paidOrder(ctx, 'FAILED', 'idem-key-0402');
    signed = await signedWebhook(event(b.txId));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ outcome: 'failed', credited: false });
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('le montant annoncé par le webhook est ignoré : seule la vérification compte', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS', requested_amount: '100.00' });
    const signed = await signedWebhook(event(txId, 'transaction.success', { amount: '5000.00' }));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ outcome: 'amount_mismatch', credited: false });
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('transaction inconnue (autre produit du même compte marchand) → acquittée et ignorée', async () => {
    const ctx = setup();
    const signed = await signedWebhook(event('tx-immobilier-42'));
    expect(await ctx.service.webhook(signed.raw, signed)).toEqual({ received: true, ignored: true, reason: 'unknown_transaction' });
    expect(ctx.saspay.count('GET', '/payments/')).toBe(0);
  });

  it('événements non gérés (test, règlement, transfert) → acquittés sans effet', async () => {
    const ctx = setup();
    for (const name of ['webhook.test', 'transaction.created', 'settlement.completed', 'wallet_transfer.success']) {
      const signed = await signedWebhook({ event: name, data: { id: 'tx-00000001' } });
      expect(await ctx.service.webhook(signed.raw, signed)).toEqual({ received: true, ignored: true, reason: 'event_not_handled' });
    }
    expect(ctx.saspay.calls).toHaveLength(0);
  });

  it('corps signé mais invalide → 400', async () => {
    const ctx = setup();
    for (const raw of ['pas du json', '[]', '"texte"']) {
      const signed = await signedWebhook(null, { raw });
      await expectError(ctx.service.webhook(signed.raw, signed), 'WEBHOOK_INVALID_BODY', 400);
    }
    const signed = await signedWebhook({ event: 'transaction.success', data: { id: '../../etc' } });
    await expectError(ctx.service.webhook(signed.raw, signed), 'WEBHOOK_INVALID_BODY', 400);
  });

  it('panne pendant la vérification → 503 (SasPay retentera), puis crédit unique au rejeu', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    ctx.saspay.respondWith((call) => (call.path.includes('/verify/') ? jsonResponse({ error: { code: 'x', message: 'down' } }, 500) : undefined));
    let signed = await signedWebhook(event(txId));
    await expectError(ctx.service.webhook(signed.raw, signed), 'WEBHOOK_PROCESSING_FAILED', 503);
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.webhooks.get(`transaction.success:${txId}`)).toBe('failed');

    ctx.saspay.respondWith(null);
    signed = await signedWebhook(event(txId), { timestamp: Math.floor(NOW / 1000) + 60 });
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('parcours hébergé : rapproche la transaction par la session ouverte', async () => {
    const ctx = setup();
    const created = await ctx.service.create(alice, checkout('idem-key-0403'));
    const sessionId = (ctx.orders.get(String(created.order.id)) as OrderRecord).provider_session_id as string;
    const txId = ctx.saspay.paySession(sessionId);
    const signed = await signedWebhook(event(txId, 'transaction.success', { amount: '15000.00' }));
    expect(await ctx.service.webhook(signed.raw, signed)).toMatchObject({ outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(95);
  });

  it('ne journalise ni le numéro du payeur ni le secret', async () => {
    const ctx = setup();
    const { txId } = await paidOrder(ctx);
    const signed = await signedWebhook(event(txId));
    await ctx.service.webhook(signed.raw, signed);
    const dump = JSON.stringify(ctx.logs);
    expect(dump).not.toContain('70123456');
    expect(dump).not.toContain(WEBHOOK_SECRET);
    expect(dump).not.toContain('sk_test_');
  });
});

describe('paiement SasPay — séparation Studio / Business Grow', () => {
  const business = (key: string) => ({
    product: 'business', item: { plan_key: 'croissance' }, country: 'ML', flow: 'softpay',
    network: 'orange_ml', phone: '70123456', idempotency_key: key,
  });

  it('un paiement Business Grow n’alimente jamais le solde Studio, et inversement', async () => {
    const ctx = setup();
    const bg = await ctx.service.create(alice, business('idem-key-0500'));
    const studio = await ctx.service.create(alice, softpay('idem-key-0501'));
    for (const order of ctx.orders.values()) ctx.saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });

    await ctx.service.refresh(alice, { product: 'business', order_id: String(bg.order.id) });
    expect(ctx.credits.business.get(alice.id)).toBe(1);
    expect(ctx.credits.studio.get(alice.id)).toBeUndefined();

    await ctx.service.refresh(alice, { product: 'studio', order_id: String(studio.order.id) });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.credits.business.get(alice.id)).toBe(1);
  });

  it('la même clé d’idempotence sur deux produits donne deux commandes distinctes', async () => {
    const ctx = setup();
    const a = await ctx.service.create(alice, softpay('idem-key-0502'));
    const b = await ctx.service.create(alice, business('idem-key-0502'));
    expect(a.order.id).not.toBe(b.order.id);
    expect(a.order.product).toBe('studio');
    expect(b.order.product).toBe('business');
    expect(b.order.amount).toBe('25000.00');
  });

  it('Business Grow reste fermé tant que la facturation n’est pas activée', async () => {
    const ctx = setup({ businessEnabled: false });
    expect(await ctx.service.options(alice, { product: 'business' })).toMatchObject({ available: false, reason: 'BUSINESS_BILLING_DISABLED' });
    await expectError(ctx.service.create(alice, business('idem-key-0503')), 'BUSINESS_BILLING_DISABLED', 503);
    expect(ctx.saspay.count('POST', '/payments')).toBe(0);
  });

  it('refuse une formule inconnue ou un article du mauvais produit', async () => {
    const ctx = setup();
    await expectError(ctx.service.create(alice, { ...business('idem-key-0504'), item: { plan_key: 'inexistante' } }), 'BUSINESS_PLAN_NOT_PURCHASABLE', 422);
    await expectError(ctx.service.create(alice, { ...business('idem-key-0505'), item: { kind: 'pack', pack_key: 'creator' } }), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(ctx.service.create(alice, softpay('idem-key-0506', { item: { plan_key: 'croissance' } })), 'PAYMENT_INVALID_REQUEST', 400);
  });
});

describe('paiement SasPay — Business Grow : encaissement incompatible avec l’abonnement', () => {
  const business = (key: string) => ({
    product: 'business', item: { plan_key: 'croissance' }, country: 'ML', flow: 'softpay',
    network: 'orange_ml', phone: '70123456', idempotency_key: key,
  });
  async function paidButBlocked(code?: string) {
    const ctx = setup();
    const created = await ctx.service.create(alice, business('idem-conflict-01'));
    const order = [...ctx.orders.values()][0];
    ctx.blockActivation(order.id, code);
    ctx.saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });
    return { ...ctx, order, orderId: String(created.order.id) };
  }
  const hookFor = async (paymentId: string) => {
    const signed = await signedWebhook({ event: 'transaction.success', data: { id: paymentId, status: 'SUCCESS' } });
    return { raw: signed.raw, headers: { signature: signed.signature, timestamp: signed.timestamp } };
  };

  it('webhook : rien n’est livré, le webhook est acquitté, l’anomalie est signalée tout de suite', async () => {
    const ctx = await paidButBlocked();
    const hook = await hookFor(ctx.order.provider_payment_id as string);
    const result = await ctx.service.webhook(hook.raw, hook.headers);
    expect(result).toMatchObject({ received: true, outcome: 'subscription_conflict', credited: false });
    expect(ctx.credits.business.get(alice.id)).toBeUndefined();
    expect(ctx.order).toMatchObject({ status: 'processing', failure_code: 'business_plan_change_not_supported' });
    expect(ctx.anomalies).toEqual([expect.objectContaining({
      kind: 'subscription_conflict', product: 'business', orderId: ctx.order.id, paymentId: ctx.order.provider_payment_id,
      details: expect.objectContaining({ reason: 'business_plan_change_not_supported', amount: '25000.00' }),
    })]);
    // Rejeu du même webhook (retentative SasPay) : déjà traité, aucun nouvel effet.
    const again = await ctx.service.webhook(hook.raw, hook.headers);
    expect(again).toMatchObject({ received: true, duplicate: true });
    expect(ctx.credits.business.get(alice.id)).toBeUndefined();
  });

  it('retour du client : message clair (paiement reçu, non appliqué, remboursement par le support)', async () => {
    const ctx = await paidButBlocked();
    const status = await ctx.service.refresh(alice, { product: 'business', order_id: ctx.orderId });
    expect(status).toMatchObject({ verified: true, credited: false });
    expect(status.message).toMatch(/bien été reçu/);
    expect(status.message).toMatch(/remboursera/);
    expect(status.order.failure_code).toBe('business_plan_change_not_supported');
    // État à part : ni « en attente » (plus rien à attendre) ni « échoué » (le client a été débité).
    expect(status.order.state).toBe('unapplied');
    expect(ctx.credits.business.get(alice.id)).toBeUndefined();
    expect(ctx.anomalies.map((a) => a.kind)).toEqual(['subscription_conflict']);
    // Consultations suivantes : même réponse, sans réinterroger SasPay ni re-signaler.
    const verifications = ctx.saspay.count('GET', `/payments/${ctx.order.provider_payment_id}/verify/`);
    for (let i = 0; i < 3; i += 1) {
      const again = await ctx.service.refresh(alice, { product: 'business', order_id: ctx.orderId });
      expect(again).toMatchObject({ verified: true, credited: false, order: { state: 'unapplied' } });
      expect(again.message).toMatch(/remboursera intégralement/);
    }
    expect(ctx.saspay.count('GET', `/payments/${ctx.order.provider_payment_id}/verify/`)).toBe(verifications);
    expect(ctx.anomalies).toHaveLength(1);
    // Relancer la même intention ne recrée ni commande ni paiement : la commande est rendue telle quelle.
    const payments = ctx.saspay.transactions.size;
    const retry = await ctx.service.create(alice, business('idem-conflict-01'));
    expect(retry).toMatchObject({ reused: true, next: 'done', order: { state: 'unapplied' } });
    expect(ctx.saspay.transactions.size).toBe(payments);
  });

  it('états publics : un refus d’activation prime sur « en attente » et « échoué », pas sur « payé » ni « remboursé »', () => {
    for (const code of ['business_plan_change_not_supported', 'business_subscription_managed_elsewhere']) {
      expect(paymentState({ status: 'processing', provider_payment_id: 'tx', provider_session_id: null, failure_code: code })).toBe('unapplied');
      expect(paymentState({ status: 'failed', provider_payment_id: 'tx', provider_session_id: null, failure_code: code })).toBe('unapplied');
      expect(paymentState({ status: 'refunded', provider_payment_id: 'tx', provider_session_id: null, failure_code: code })).toBe('confirmed');
      expect(paymentState({ status: 'paid', provider_payment_id: 'tx', provider_session_id: null, failure_code: code })).toBe('confirmed');
    }
    expect(paymentState({ status: 'processing', provider_payment_id: 'tx', provider_session_id: null, failure_code: 'amount_mismatch' })).toBe('pending');
  });

  it('tâche planifiée : signalé à chaque passage, jamais livré, jamais clos en silence', async () => {
    const ctx = await paidButBlocked('business_subscription_managed_elsewhere');
    for (let i = 0; i < 3; i += 1) {
      const result = await ctx.service.reconcile();
      expect(result).toMatchObject({ ran: true, settled: 0, anomalies: 1 });
    }
    expect(ctx.credits.business.get(alice.id)).toBeUndefined();
    expect(ctx.order.status).toBe('processing');
    expect(new Set(ctx.anomalies.map((a) => `${a.kind}:${a.orderId}:${a.paymentId}`)).size).toBe(1);
  });
});

describe('paiement SasPay — soldes marchands (administration)', () => {
  it('réservés aux administrateurs', async () => {
    const ctx = setup();
    await expectError(ctx.service.balances(alice), 'PAYMENT_FORBIDDEN', 403);
    expect(ctx.saspay.calls).toHaveLength(0);
  });

  it('un solde par pays, jamais fusionné, en lecture seule', async () => {
    const ctx = setup();
    const result = await ctx.service.balances(boss);
    expect(result).toMatchObject({ configured: true, mode: 'test' });
    expect(result.balances.map((b) => [b.country, b.available_amount, b.pending_amount, b.is_frozen])).toEqual([
      ['ML', '125000.00', '5000.00', false],
      ['SN', '900.00', '0.00', true],
    ]);
    expect(ctx.saspay.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk_');
  });

  it('clé absente → état « non configuré » ; clé refusée → erreur explicite', async () => {
    const none = setup({ key: null });
    expect(await none.service.balances(boss)).toMatchObject({ configured: false, balances: [] });
    const ctx = setup();
    ctx.saspay.respondWith(() => jsonResponse({ error: { code: 'authentication_failed', message: 'bad' } }, 401));
    await expectError(ctx.service.balances(boss), 'PAYMENT_PROVIDER_UNAUTHORIZED', 503);
  });
});

describe('paiement SasPay — vue publique d’une commande', () => {
  const base: OrderRecord = {
    product: 'studio', id: 'o1', user_id: 'u1', status: 'pending', amount: '5000.00', currency: 'XOF', country: 'ML',
    internal_reference: 'VYS-1', label: 'Pack', payment_flow: 'softpay', network_code: 'orange_ml',
    provider_payment_id: null, provider_session_id: null, provider_status: null, checkout_url: null, last_verified_at: null,
  };

  it('expose cinq états : à effectuer, en attente, confirmé, échoué, annulé', () => {
    expect(paymentState(base)).toBe('todo');
    expect(paymentState({ ...base, provider_payment_id: 'tx' })).toBe('pending');
    expect(paymentState({ ...base, status: 'processing' })).toBe('pending');
    expect(paymentState({ ...base, status: 'paid' })).toBe('confirmed');
    expect(paymentState({ ...base, status: 'failed' })).toBe('failed');
    expect(paymentState({ ...base, status: 'cancelled' })).toBe('cancelled');
  });

  it('ne renvoie ni identifiant d’utilisateur ni identifiants SasPay au navigateur', () => {
    const view = publicOrder({ ...base, provider_payment_id: 'tx-secret', provider_session_id: 'cs-secret', pricing_snapshot: { x: 1 } });
    expect(view.user_id).toBeUndefined();
    expect(view.provider_payment_id).toBeUndefined();
    expect(view.provider_session_id).toBeUndefined();
    expect(view.pricing_snapshot).toBeUndefined();
    expect(view).toMatchObject({ id: 'o1', amount: '5000.00', state: 'pending', internal_reference: 'VYS-1' });
  });
});

describe('réconciliation SasPay — tâche planifiée', () => {
  const HOUR = 3_600_000;
  const first = <T,>(map: Map<string, T>) => [...map.values()][0];

  it('repère la référence interne dans un libellé, et rien d’autre', () => {
    const ref = `VYS-${'0A'.repeat(16)}`;
    expect(orderReferenceIn(`Pack Creator — ${ref}`)).toBe(ref);
    expect(orderReferenceIn(`VYB-${'F'.repeat(32)}`)).toBe(`VYB-${'F'.repeat(32)}`);
    for (const bad of [null, '', 'Pack Creator', `VYX-${'0'.repeat(32)}`, `VYS-${'0'.repeat(31)}`, `VYS-${'0'.repeat(33)}`,
      `VYS-${'g'.repeat(32)}`, `XVYS-${'0'.repeat(32)}`]) {
      expect(orderReferenceIn(bad)).toBeNull();
    }
  });

  it('compare le jeton à temps constant et refuse tout jeton malformé ou absent', async () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    const { service, calls } = setup();
    expect(await service.isCronToken(CRON_TOKEN)).toBe(true);
    expect(await service.isCronToken(CRON_TOKEN.replace(/.$/, '0'))).toBe(false);
    calls.length = 0;
    // Un jeton malformé est refusé sans même lire le coffre.
    for (const bad of ['', 'x', CRON_TOKEN.toUpperCase(), `${CRON_TOKEN}00`, TEST_KEY]) {
      expect(await service.isCronToken(bad)).toBe(false);
    }
    expect(calls).not.toContain('reconcileToken');
    const missing = setup({ cronToken: null });
    expect(await missing.service.isCronToken(CRON_TOKEN)).toBe(false);
  });

  it('webhook perdu : le paiement réussi est retrouvé, vérifié puis livré une seule fois', async () => {
    const { service, saspay, credits, runs, orders } = setup();
    await service.create(alice, softpay('idem-recon-0001'));
    const order = first(orders);
    saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });
    // Aucun webhook, aucune consultation du client : seule la tâche planifiée passe.
    const result = await service.reconcile();
    expect(result).toMatchObject({ ran: true, status: 'ok', checked: 1, settled: 1, errors: 0, anomalies: 0 });
    expect(order.status).toBe('paid');
    expect(credits.studio.get(alice.id)).toBe(27);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: 'cron', status: 'ok', counts: { settled: 1, sweep_done: true } });
    // Deuxième passage : plus rien à faire, aucun second crédit.
    const again = await service.reconcile();
    expect(again).toMatchObject({ ran: true, settled: 0 });
    expect(credits.studio.get(alice.id)).toBe(27);
  });

  it('ne livre rien tant que SasPay répond « en attente » ; clôt la commande sur échec vérifié', async () => {
    const { service, saspay, credits, orders } = setup();
    await service.create(alice, softpay('idem-recon-0002'));
    const order = first(orders);
    expect(await service.reconcile()).toMatchObject({ checked: 1, settled: 0, closed: 0 });
    expect(order.status).toBe('processing');
    saspay.setTransaction(order.provider_payment_id as string, { status: 'FAILED' });
    expect(await service.reconcile()).toMatchObject({ checked: 1, settled: 0, closed: 1 });
    expect(order.status).toBe('failed');
    expect(credits.studio.get(alice.id)).toBeUndefined();
  });

  it('succès tardif après un échec : la commande close est revérifiée et honorée', async () => {
    const { service, saspay, credits, orders } = setup();
    await service.create(alice, softpay('idem-recon-0003'));
    const order = first(orders);
    saspay.setTransaction(order.provider_payment_id as string, { status: 'FAILED' });
    await service.reconcile();
    expect(order.status).toBe('failed');
    saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });
    expect(await service.reconcile()).toMatchObject({ settled: 1 });
    expect(order.status).toBe('paid');
    expect(credits.studio.get(alice.id)).toBe(27);
  });

  it('montant vérifié différent du montant commandé : rien n’est livré, une anomalie est signalée', async () => {
    const { service, saspay, credits, anomalies, orders } = setup();
    await service.create(alice, softpay('idem-recon-0004'));
    const order = first(orders);
    saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS', requested_amount: '500.00' });
    expect(await service.reconcile()).toMatchObject({ settled: 0, anomalies: 1 });
    expect(credits.studio.get(alice.id)).toBeUndefined();
    expect(anomalies).toEqual([expect.objectContaining({
      kind: 'amount_mismatch', product: 'studio', orderId: order.id, reference: order.internal_reference,
    })]);
  });

  it('réponse de création perdue : le paiement est retrouvé par la référence du libellé, vérifié et livré', async () => {
    const { service, saspay, credits, orders, anomalies } = setup();
    saspay.respondWith((call) => (call.path === '/payments/softpay/' ? jsonResponse({ detail: 'timeout' }, 504) : undefined));
    await service.create(alice, softpay('idem-recon-0005')).catch(() => undefined);
    saspay.respondWith(null);
    const order = first(orders);
    expect(order.provider_payment_id).toBeNull();
    // SasPay a pourtant encaissé : la transaction porte la référence interne.
    const txId = saspay.addTransaction({
      requested_amount: '5000.00', debited_amount: '5100.00', net_amount: '5000.00',
      description: `Pack Creator — ${order.internal_reference}`,
    });
    const result = await service.reconcile();
    expect(result).toMatchObject({ swept: 1, settled: 1, sweep_done: true });
    expect(order).toMatchObject({ status: 'paid', provider_payment_id: txId });
    expect(credits.studio.get(alice.id)).toBe(27);
    expect(anomalies).toHaveLength(0);
    // La transaction listée n'est jamais crue : elle a été revérifiée unitairement.
    expect(saspay.count('GET', `/payments/${txId}/verify/`)).toBe(1);
  });

  it('paiement listé d’un montant différent : la référence ne suffit pas, rien n’est livré', async () => {
    const { service, saspay, credits, orders, anomalies } = setup();
    saspay.respondWith((call) => (call.path === '/payments/softpay/' ? jsonResponse({ detail: 'timeout' }, 504) : undefined));
    await service.create(alice, softpay('idem-recon-0006')).catch(() => undefined);
    saspay.respondWith(null);
    const order = first(orders);
    saspay.addTransaction({
      requested_amount: '100.00', debited_amount: '100.00', net_amount: '100.00',
      description: `Pack Creator — ${order.internal_reference}`,
    });
    await service.reconcile();
    expect(order.status).not.toBe('paid');
    expect(credits.studio.get(alice.id)).toBeUndefined();
    expect(anomalies.map((a) => a.kind)).toEqual(['amount_mismatch']);
  });

  it('second encaissement pour une commande déjà payée : aucun second crédit, anomalie « doublon »', async () => {
    const { service, saspay, credits, orders, anomalies } = setup();
    await service.create(alice, softpay('idem-recon-0007'));
    const order = first(orders);
    saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });
    await service.reconcile();
    expect(credits.studio.get(alice.id)).toBe(27);
    const duplicate = saspay.addTransaction({
      requested_amount: '5000.00', debited_amount: '5100.00', net_amount: '5000.00',
      description: `Pack Creator — ${order.internal_reference}`,
    });
    await service.reconcile();
    expect(credits.studio.get(alice.id)).toBe(27);
    expect(order.provider_payment_id).not.toBe(duplicate);
    expect(anomalies).toEqual([expect.objectContaining({
      kind: 'duplicate_payment', orderId: order.id, paymentId: duplicate,
      details: { tracked_payment_id: order.provider_payment_id },
    })]);
  });

  it('ignore les encaissements des autres produits du compte marchand et les références inconnues', async () => {
    const { service, saspay, anomalies, credits } = setup();
    saspay.addTransaction({ requested_amount: '5000.00', description: 'Loyer novembre — appartement 12' });
    saspay.addTransaction({ requested_amount: '5000.00', description: `Pack — VYS-${'F'.repeat(32)}` });
    const result = await service.reconcile();
    expect(result).toMatchObject({ ran: true, status: 'ok', swept: 1, settled: 0, anomalies: 0 });
    expect(anomalies).toHaveLength(0);
    expect(credits.studio.size).toBe(0);
    expect(saspay.calls.some((c) => c.path.includes('/verify/'))).toBe(false);
  });

  it('paiement inconnu de SasPay : signalé ; clos seulement après 24 h', async () => {
    const { service, saspay, orders, anomalies, clock, reconcile } = setup();
    reconcile.sweep = false;
    await service.create(alice, softpay('idem-recon-0008'));
    const order = first(orders);
    saspay.transactions.delete(order.provider_payment_id as string);
    expect(await service.reconcile()).toMatchObject({ status: 'partial', errors: 1, anomalies: 1, closed: 0 });
    expect(order.status).toBe('processing');
    expect(anomalies[0]).toMatchObject({ kind: 'payment_not_found', orderId: order.id });
    clock.now = NOW + 25 * HOUR;
    expect(await service.reconcile()).toMatchObject({ closed: 1 });
    expect(order).toMatchObject({ status: 'cancelled', failure_code: 'provider_payment_not_found' });
  });

  it('panne SasPay : aucune commande n’est modifiée, l’exécution est journalisée en erreur partielle', async () => {
    const { service, saspay, orders, runs, credits, reconcile } = setup();
    reconcile.sweep = false;
    await service.create(alice, softpay('idem-recon-0009'));
    await service.create(bob, softpay('idem-recon-0010'));
    saspay.respondWith((call) => (call.path.includes('/verify/') ? jsonResponse({ detail: 'down' }, 503) : undefined));
    const result = await service.reconcile();
    expect(result).toMatchObject({ ran: true, status: 'partial', checked: 0, errors: 2, settled: 0 });
    expect([...orders.values()].map((o) => o.status)).toEqual(['processing', 'processing']);
    expect(credits.studio.size).toBe(0);
    expect(runs[0].status).toBe('partial');
  });

  it('une seule exécution à la fois ; rien ne tourne sans clé SasPay', async () => {
    const { service, store, runs } = setup();
    await store.reconcileStart('cron');
    expect(await service.reconcile()).toEqual({ ran: false, reason: 'already_running' });
    expect(runs).toHaveLength(1);
    const unconfigured = setup({ key: null });
    expect(await unconfigured.service.reconcile()).toEqual({ ran: false, reason: 'not_configured' });
    expect(unconfigured.runs).toHaveLength(0);
  });

  it('s’arrête à l’épuisement du budget de temps et le journalise', async () => {
    const { service, saspay, runs, clock, reconcile } = setup();
    reconcile.sweep = false;
    await service.create(alice, softpay('idem-recon-0011'));
    await service.create(bob, softpay('idem-recon-0012'));
    saspay.respondWith((call) => { if (call.path.includes('/verify/')) clock.now += 60_000; return undefined; });
    const result = await service.reconcile({ budgetMs: 40_000 });
    expect(result).toMatchObject({ status: 'partial', checked: 1 });
    expect(runs[0].counts?.detail).toMatchObject({ stopped: 'time_budget' });
  });

  it('n’appelle SasPay qu’en lecture : aucun paiement, aucun décaissement n’est initié', async () => {
    const { service, saspay, orders } = setup();
    await service.create(alice, softpay('idem-recon-0013'));
    saspay.setTransaction(first(orders).provider_payment_id as string, { status: 'SUCCESS' });
    saspay.calls.length = 0;
    await service.reconcile();
    expect(saspay.calls.length).toBeGreaterThan(0);
    expect(saspay.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(saspay.calls.every((c) => /^\/(payments\/[^/]+\/verify\/|transactions\/|checkout-sessions\/[^/]+\/status\/)/.test(c.path))).toBe(true);
  });

  it('liste SasPay sans libellé (champ non garanti par la spécification) : filet aveugle signalé, rien n’est livré à l’aveugle', async () => {
    const { service, saspay, credits, orders, anomalies, runs } = setup();
    saspay.respondWith((call) => (call.path === '/payments/softpay/' ? jsonResponse({ detail: 'timeout' }, 504) : undefined));
    await service.create(alice, softpay('idem-recon-0101')).catch(() => undefined);
    saspay.respondWith(null);
    const order = first(orders);
    saspay.addTransaction({
      requested_amount: '5000.00', debited_amount: '5100.00', net_amount: '5000.00',
      description: `Pack Creator — ${order.internal_reference}`,
    });
    saspay.omitListDescriptions();
    const result = await service.reconcile();
    // Le passage n'est PAS déclaré sain : il est partiel, et un humain est prévenu.
    expect(result).toMatchObject({ ran: true, status: 'partial', swept: 0, settled: 0, anomalies: 1 });
    expect(runs[0].counts?.detail).toMatchObject({ sweep_blind: true, sweep_listed: 1 });
    expect(anomalies).toEqual([expect.objectContaining({
      kind: 'sweep_unreliable', orderId: null, details: expect.objectContaining({ reason: 'description_missing', listed: 1, described: 0 }),
    })]);
    expect(order.status).toBe('pending');
    expect(credits.studio.get(alice.id)).toBeUndefined();
  });

  it('réponse de création perdue ET liste sans libellé : le rejeu de la même intention retrouve le paiement (clé d’idempotence SasPay)', async () => {
    const { saspay } = setup();
    // SasPay crée bien le paiement, mais sa réponse n'arrive jamais.
    let lose = true;
    const real = saspay.fetcher;
    const lossy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await real(input, init);
      if (lose && String(input).endsWith('/payments/softpay/')) throw new DOMException('timeout', 'TimeoutError');
      return response;
    }) as typeof fetch;
    const fake = createFakeStore({ admins: [boss.id] });
    const lossyService = createPaymentService({
      store: fake.store, client: createSasPayClient({ secretKey: TEST_KEY, fetcher: lossy }),
      webhookSecret: WEBHOOK_SECRET, now: () => NOW, log: () => undefined,
    });
    await expectError(lossyService.create(alice, softpay('idem-recon-0102')), 'PAYMENT_PROVIDER_UNAVAILABLE', 503);
    const order = first(fake.orders);
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null });
    expect(saspay.transactions.size).toBe(1);
    const txId = [...saspay.transactions.keys()][0];
    saspay.setTransaction(txId, { status: 'SUCCESS' });

    // Le balayage ne voit aucun libellé : il ne peut rien rapprocher, et le dit.
    saspay.omitListDescriptions();
    expect(await lossyService.reconcile()).toMatchObject({ status: 'partial', settled: 0 });
    expect(fake.credits.studio.get(alice.id)).toBeUndefined();

    // Le client relance le même achat : même clé d'idempotence → SasPay renvoie le paiement d'origine.
    lose = false;
    const retry = await lossyService.create(alice, softpay('idem-recon-0102'));
    expect(saspay.transactions.size).toBe(1);
    expect(order.provider_payment_id).toBe(txId);
    expect(retry.order.id).toBe(order.id);
    // Et la vérification (ou la tâche planifiée) livre, une seule fois.
    expect(await lossyService.reconcile()).toMatchObject({ settled: 1 });
    expect(await lossyService.reconcile()).toMatchObject({ settled: 0 });
    expect(fake.credits.studio.get(alice.id)).toBe(27);
  });

  it('liste SasPay avec libellés vides (autres produits du compte) : aucun signalement abusif', async () => {
    const { service, saspay, anomalies } = setup();
    saspay.addTransaction({ requested_amount: '9000.00', description: null });
    saspay.addTransaction({ requested_amount: '9000.00', description: '' });
    const result = await service.reconcile();
    expect(result).toMatchObject({ ran: true, status: 'ok', swept: 0, anomalies: 0, sweep_done: true });
    expect(anomalies).toHaveLength(0);
  });

  it('plus d’encaissements que ce qu’un passage peut lire (1 000) : passage partiel, signalé une fois par exécution', async () => {
    const { service, saspay, anomalies, runs } = setup();
    for (let i = 0; i < 1001; i += 1) saspay.addTransaction({ requested_amount: '100.00', description: 'Autre produit' });
    const result = await service.reconcile();
    expect(result).toMatchObject({ ran: true, status: 'partial', anomalies: 1 });
    expect(runs[0].counts?.detail).toMatchObject({ sweep_truncated: true, sweep_listed: 1000 });
    expect(saspay.count('GET', '/transactions/')).toBe(5);
    expect(anomalies).toEqual([expect.objectContaining({ kind: 'sweep_unreliable', details: expect.objectContaining({ reason: 'truncated' }) })]);
  });

  it('session hébergée payée sans webhook : la transaction est retrouvée par la session puis livrée', async () => {
    const { service, saspay, credits, orders } = setup();
    await service.create(alice, checkout('idem-recon-0014'));
    const order = first(orders);
    const txId = saspay.paySession(order.provider_session_id as string);
    expect(await service.reconcile()).toMatchObject({ settled: 1 });
    expect(order).toMatchObject({ status: 'paid', provider_payment_id: txId });
    expect(credits.studio.get(alice.id)).toBe(95);
  });
});
