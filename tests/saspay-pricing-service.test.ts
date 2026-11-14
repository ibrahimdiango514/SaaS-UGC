// Politique de prix dans le parcours de paiement : prix final tout compris,
// frais déduits, rapprochement, alertes, événements rejoués.
import { describe, expect, it } from 'vitest';
import { createSasPayClient } from '../supabase/functions/_shared/saspay/client';
import { PaymentError, createPaymentService, type OrderRecord } from '../supabase/functions/_shared/saspay/payments';
import type { FeeLine } from '../supabase/functions/_shared/saspay/pricing';
import {
  DEFAULT_PRICING_POLICY, NOW, TEST_KEY, WEBHOOK_SECRET, createFakeSasPay, createFakeStore, signedWebhook,
  type FakeStoreOptions,
} from './helpers/saspay-fakes';

const alice = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@example.ml', name: 'Alice Koné' };
const bob = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@example.ml', name: 'Bob' };
const boss = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'boss@example.ml', name: 'Boss' };

const line = (over: Partial<FeeLine> = {}): FeeLine => ({
  id: 'l1', transaction_type: 'payin', country_code: 'ML', currency: 'XOF', network_code: null,
  min_amount_cents: 0n, max_amount_cents: null, percent_milli: 0n, fixed_cents: 0n, floor_fee_cents: null,
  cap_fee_cents: null, fee_base: 'total', valid_from: NOW - 86_400_000, valid_until: null, created_at: NOW - 86_400_000, ...over,
});

function setup(options: FakeStoreOptions = {}, withClient = true) {
  const fake = createFakeStore({ admins: [boss.id], pricing: { policy: DEFAULT_PRICING_POLICY }, ...options });
  const saspay = createFakeSasPay();
  const service = createPaymentService({
    store: fake.store,
    client: withClient ? createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher }) : null,
    webhookSecret: WEBHOOK_SECRET,
    now: () => fake.clock.now,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const sent = (path = '/payments/softpay/') => saspay.calls.filter((c) => c.method === 'POST' && c.path === path);
  const only = () => [...fake.orders.values()][0] as OrderRecord;
  async function hook(id: string) {
    const signed = await signedWebhook({ event: 'transaction.success', data: { id, status: 'SUCCESS' } },
      { timestamp: Math.floor(fake.clock.now / 1000) });
    return service.webhook(signed.raw, signed);
  }
  return { ...fake, saspay, service, sent, only, hook };
}

const pack = (key: string, extra: Record<string, unknown> = {}) => ({
  product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'softpay',
  network: 'orange_ml', phone: '70 12 34 56', idempotency_key: key, ...extra,
});
const plan = (key: string) => ({
  product: 'business', item: { plan_key: 'croissance' }, country: 'ML', flow: 'softpay',
  network: 'orange_ml', phone: '70 12 34 56', idempotency_key: key,
});
async function expectError(promise: Promise<unknown>, code: string, status?: number) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(PaymentError);
  expect((error as PaymentError).code).toBe(code);
  if (status) expect((error as PaymentError).status).toBe(status);
}

describe('prix affiché : final, sans frais ajoutés au moment de payer', () => {
  it('annonce 6 000 FCFA pour un pack à 5 000 FCFA, sans frais en sus par opérateur', async () => {
    const ctx = setup();
    const options = await ctx.service.options(alice, { product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(options.price).toMatchObject({ amount: '6000.00', credits: 27 });
    expect(options.all_inclusive).toBe(true);
    expect(options.countries[0].price).toEqual({ amount: '6000.00', currency: 'XOF' });
    expect(options.countries[0].networks.every((network) => network.fee === null)).toBe(true);
    // Rien d'interne ne part vers le navigateur.
    expect(JSON.stringify(options)).not.toMatch(/provision|base_cents|estimated_fee|expected_net/);
  });

  it('fournit le catalogue des prix finals pour les pages de tarifs', async () => {
    const ctx = setup();
    const studio = await ctx.service.options(alice, { product: 'studio' });
    expect(studio.catalog).toMatchObject({
      creator: { amount: '6000.00' }, pro_creator: { amount: '16000.00' }, studio_business: { amount: '36000.00' },
    });
    const business = await ctx.service.options(bob, { product: 'business' });
    expect(business.catalog).toMatchObject({ croissance: { amount: '26000.00' } });
  });

  it('relève le prix quand un tarif confirmé dépasse la provision (2,5 % sur 100 000 FCFA)', async () => {
    const ctx = setup({
      businessPlans: { croissance: { price: 100_000, label: 'Business Grow — Croissance' } },
      pricing: { policy: DEFAULT_PRICING_POLICY, lines: [line({ percent_milli: 2500n })] },
    });
    const options = await ctx.service.options(bob, { product: 'business', item: { plan_key: 'croissance' } });
    expect(options.price?.amount).toBe('102565.00');
  });

  it('sans politique de prix : prix et frais d’origine (compatibilité)', async () => {
    const ctx = setup({ pricing: undefined });
    const options = await ctx.service.options(alice, { product: 'studio', item: { kind: 'pack', pack_key: 'creator' } });
    expect(options.price?.amount).toBe('5000.00');
    expect(options.all_inclusive).toBe(false);
    expect(options.countries[0].networks[0].fee).not.toBeNull();
    await ctx.service.create(alice, pack('idem-legacy-0001'));
    expect(ctx.sent()[0].body).not.toHaveProperty('fee_charge_mode');
    expect(ctx.sent()[0].body?.amount).toBe('5000.00');
  });
});

describe('encaissement en frais déduits', () => {
  it('envoie à SasPay le prix final et demande le mode « Déduits »', async () => {
    const ctx = setup();
    const result = await ctx.service.create(alice, pack('idem-price-0001'));
    expect(ctx.sent()).toHaveLength(1);
    expect(ctx.sent()[0].body).toMatchObject({ amount: '6000.00', currency: 'XOF', fee_charge_mode: 'DEDUCTED' });
    expect(result.order).toMatchObject({ amount: '6000.00', quoted_total_amount: '6000.00', quoted_fee_mode: 'DEDUCTED' });
    // Les frais estimés et le net attendu restent côté serveur.
    expect(result.order).not.toHaveProperty('quoted_fee_amount');
    expect(result.order).not.toHaveProperty('net_amount');
    expect(ctx.quotes.get(ctx.only().id)).toMatchObject({ base_cents: 500_000n, provision_cents: 100_000n, final_cents: 600_000n });
  });

  it('page hébergée : même prix final, même mode de frais', async () => {
    const ctx = setup();
    const result = await ctx.service.create(alice, pack('idem-price-0002', { flow: 'checkout', network: undefined }));
    const body = ctx.sent('/checkout-sessions/')[0].body;
    expect(body).toMatchObject({ amount: '6000.00', fee_charge_mode: 'DEDUCTED' });
    expect(result.order).toMatchObject({ amount: '6000.00' });
  });

  it('Business Grow : 25 000 FCFA facturés 26 000 FCFA', async () => {
    const ctx = setup();
    const result = await ctx.service.create(bob, plan('idem-price-0003'));
    expect(ctx.sent()[0].body).toMatchObject({ amount: '26000.00', fee_charge_mode: 'DEDUCTED' });
    expect(result.order).toMatchObject({ amount: '26000.00' });
  });

  it('réponse perdue : le rejeu envoie exactement le même corps, mode de frais compris', async () => {
    const ctx = setup();
    ctx.saspay.loseSoftpayResponses(1);
    const result = await ctx.service.create(alice, pack('idem-price-0004'));
    expect(ctx.sent()).toHaveLength(2);
    expect(ctx.sent()[1].body).toEqual(ctx.sent()[0].body);
    expect(ctx.sent()[1].headers['idempotency-key']).toBe(ctx.sent()[0].headers['idempotency-key']);
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(result.order).toMatchObject({ amount: '6000.00' });
  });

  it('double clic : une seule commande, un seul paiement, au même prix', async () => {
    const ctx = setup();
    const [a, b] = await Promise.all([
      ctx.service.create(alice, pack('idem-price-0005')),
      ctx.service.create(alice, pack('idem-price-0005')),
    ]);
    expect(ctx.orders.size).toBe(1);
    expect(ctx.saspay.transactions.size).toBe(1);
    expect([a.order.amount, b.order.amount]).toEqual(['6000.00', '6000.00']);
  });
});

describe('confirmation et rapprochement', () => {
  async function paid(ctx: ReturnType<typeof setup>, key: string) {
    await ctx.service.create(alice, pack(key));
    const order = ctx.only();
    const txId = order.provider_payment_id as string;
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    return { order, txId };
  }

  it('paiement abandonné : aucun crédit, aucune ligne de rapprochement', async () => {
    const ctx = setup();
    await ctx.service.create(alice, pack('idem-rec-0001'));
    ctx.clock.now += 5_000;
    const result = await ctx.service.refresh(alice, { product: 'studio', order_id: ctx.only().id });
    expect(result.credited).toBe(false);
    expect(ctx.ledger.size).toBe(0);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('SUCCESS vérifié : crédit unique ; encaissé 6 000, frais 100, net 5 900, marge 900', async () => {
    const ctx = setup();
    const { order, txId } = await paid(ctx, 'idem-rec-0002');
    const first = await ctx.hook(txId);
    expect(first).toMatchObject({ received: true, outcome: 'paid', credited: true });
    expect(await ctx.hook(txId)).toMatchObject({ received: true, duplicate: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.ledger.get(order.id)).toEqual({
      charged_cents: 600_000n, actual_fee_cents: 10_000n, actual_net_cents: 590_000n, fee_variance_cents: null,
      margin_cents: 90_000n, provision_covers_fee: true, flags: ['tariff_missing'],
    });
    expect(ctx.anomalies).toEqual([]);
  });

  it('webhook rejoué puis vérification manuelle : aucun second crédit', async () => {
    const ctx = setup();
    const { order, txId } = await paid(ctx, 'idem-rec-0003');
    await ctx.hook(txId);
    await ctx.hook(txId);
    ctx.clock.now += 5_000;
    await ctx.service.refresh(alice, { product: 'studio', order_id: order.id });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.ledger.size).toBe(1);
  });

  it('SasPay confirme le prix de BASE au lieu du prix final : rien n’est livré', async () => {
    const ctx = setup();
    const { order, txId } = await paid(ctx, 'idem-rec-0004');
    ctx.saspay.setTransaction(txId, { requested_amount: '5000.00', debited_amount: '5000.00', net_amount: '4900.00' });
    await ctx.hook(txId);
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.ledger.size).toBe(0);
    expect(ctx.orders.get(order.id)).toMatchObject({ failure_code: 'amount_mismatch' });
  });

  it('SUCCESS dans une autre devise : rien n’est livré', async () => {
    const ctx = setup();
    const { txId } = await paid(ctx, 'idem-rec-0005');
    ctx.saspay.setTransaction(txId, { currency: 'XAF' });
    await ctx.hook(txId);
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.ledger.size).toBe(0);
  });

  it('frais réels égaux à la provision : net égal au prix de base, aucune alerte', async () => {
    const ctx = setup();
    ctx.saspay.setFee(() => 100_000n);
    const { order, txId } = await paid(ctx, 'idem-rec-0006');
    await ctx.hook(txId);
    expect(ctx.ledger.get(order.id)).toMatchObject({ actual_fee_cents: 100_000n, actual_net_cents: 500_000n, margin_cents: 0n, provision_covers_fee: true });
    expect(ctx.anomalies).toEqual([]);
  });

  it('frais réels supérieurs à la provision : client livré, administrateur alerté', async () => {
    const ctx = setup();
    ctx.saspay.setFee(() => 120_000n);
    const { order, txId } = await paid(ctx, 'idem-rec-0007');
    await ctx.hook(txId);
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.ledger.get(order.id)).toMatchObject({ actual_fee_cents: 120_000n, margin_cents: -20_000n, provision_covers_fee: false });
    expect(ctx.anomalies.map((a) => a.kind)).toEqual(['fee_exceeds_provision', 'net_below_base']);
  });

  it('frais réels différents des frais estimés : écart enregistré', async () => {
    const ctx = setup({ pricing: { policy: DEFAULT_PRICING_POLICY, lines: [line({ network_code: 'orange_ml', percent_milli: 1000n })] } });
    ctx.saspay.setFee((amount) => (amount * 15n) / 1000n); // 1,5 % réel pour 1 % estimé
    const { order, txId } = await paid(ctx, 'idem-rec-0008');
    await ctx.hook(txId);
    expect(ctx.quotes.get(order.id)).toMatchObject({ estimated_fee_cents: 6000n, expected_net_cents: 594_000n });
    expect(ctx.ledger.get(order.id)).toMatchObject({ actual_fee_cents: 9000n, fee_variance_cents: 3000n, margin_cents: 91_000n, flags: [] });
  });

  it('tarif connu, prix relevé : le net commercial est préservé', async () => {
    const lines = [line({ percent_milli: 2500n })];
    const ctx = setup({
      businessPlans: { croissance: { price: 100_000, label: 'Business Grow — Croissance' } },
      pricing: { policy: DEFAULT_PRICING_POLICY, lines },
    });
    ctx.saspay.setFee((amount) => (amount * 2500n + 99_999n) / 100_000n);
    await ctx.service.create(bob, plan('idem-rec-0009'));
    const order = ctx.only();
    expect(order.amount).toBe('102565.00');
    ctx.saspay.setTransaction(order.provider_payment_id as string, { status: 'SUCCESS' });
    await ctx.hook(order.provider_payment_id as string);
    const row = ctx.ledger.get(order.id);
    expect(row).toMatchObject({ charged_cents: 10_256_500n, actual_fee_cents: 256_413n, actual_net_cents: 10_000_087n, fee_variance_cents: 0n, margin_cents: 87n });
    expect(row!.actual_net_cents! >= 10_000_000n).toBe(true);
    expect(ctx.credits.business.get(bob.id)).toBe(1);
  });

  it('compte SasPay qui ignore le mode demandé : frais ajoutés au client → alerte', async () => {
    const ctx = setup();
    ctx.saspay.ignoreFeeModeOverride();
    const { order, txId } = await paid(ctx, 'idem-rec-0010');
    await ctx.hook(txId);
    // Le montant demandé est conforme : la commande est honorée, mais le client a payé 6 100 pour 6 000 annoncés.
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.ledger.get(order.id)).toMatchObject({ charged_cents: 610_000n, actual_net_cents: 600_000n });
    expect(ctx.anomalies.map((a) => a.kind)).toEqual(['fee_mode_unexpected']);
  });
});

describe('import des tarifs du compte SasPay', () => {
  it('réservé aux administrateurs', async () => {
    const ctx = setup();
    await expectError(ctx.service.syncRates(alice), 'PAYMENT_FORBIDDEN', 403);
    expect(ctx.saspay.count('GET', '/pricing/my-rates/')).toBe(0);
    expect(ctx.importedRates).toHaveLength(0);
  });

  it('lit GET /pricing/my-rates/ et transmet les paliers tels quels à la base', async () => {
    const ctx = setup();
    const result = await ctx.service.syncRates(boss);
    expect(ctx.saspay.count('GET', '/pricing/my-rates/')).toBe(1);
    expect(ctx.saspay.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(ctx.importedRates).toHaveLength(1);
    expect(result).toMatchObject({ mode: 'test', inserted: ctx.importedRates[0].length });
  });

  it('réponse vide : le barème n’est pas touché', async () => {
    const ctx = setup();
    ctx.saspay.setRates([]);
    await expectError(ctx.service.syncRates(boss), 'PAYMENT_RATES_EMPTY', 502);
  });

  it('sans clé SasPay : refus explicite', async () => {
    const ctx = setup({}, false);
    await expectError(ctx.service.syncRates(boss), 'PAYMENTS_NOT_CONFIGURED', 503);
  });
});
