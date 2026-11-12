// Création softpay dont la réponse s'est perdue : le paiement a pu être
// encaissé sans que VYORA n'en connaisse l'identifiant.
//
// Règle vérifiée ici : une telle commande n'est jamais déclarée « non payée »
// par un automate, jamais « payée » sans vérification SasPay, et le client ne
// peut pas payer une seconde fois tant que l'issue est inconnue.
import { describe, expect, it } from 'vitest';
import { createSasPayClient } from '../supabase/functions/_shared/saspay/client';
import {
  PaymentError, REVIEW_MESSAGE, UNCONFIRMED_MESSAGE, createPaymentService, paymentState, publicOrder,
  type OrderRecord,
} from '../supabase/functions/_shared/saspay/payments';
import {
  NOW, TEST_KEY, WEBHOOK_SECRET, createFakeSasPay, createFakeStore, jsonResponse, signedWebhook,
  type FakeStoreOptions,
} from './helpers/saspay-fakes';

const alice = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@example.ml', name: 'Alice Koné' };
const bob = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'bob@example.ml', name: 'Bob' };
const boss = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'boss@example.ml', name: 'Boss' };
const NOTE = 'Transaction retrouvée au tableau de bord SasPay';

function setup(options: FakeStoreOptions = {}) {
  const fake = createFakeStore({ admins: [boss.id], ...options });
  const saspay = createFakeSasPay();
  const logs: Array<{ event: string; details: Record<string, unknown> }> = [];
  const service = createPaymentService({
    store: fake.store,
    client: createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher }),
    webhookSecret: WEBHOOK_SECRET,
    now: () => fake.clock.now,
    log: (event, details) => logs.push({ event, details }),
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
  });
  const sent = () => saspay.calls.filter((c) => c.method === 'POST' && c.path === '/payments/softpay/');
  const only = () => [...fake.orders.values()][0] as OrderRecord;
  /** Webhook signé à l'heure courante du test. */
  async function hook(id: string, event = 'transaction.success', extra: Record<string, unknown> = {}) {
    const signed = await signedWebhook({ event, data: { id, status: 'SUCCESS', ...extra } },
      { timestamp: Math.floor(fake.clock.now / 1000) });
    return service.webhook(signed.raw, signed);
  }
  /** Passage de la tâche planifiée (toujours « exécuté » dans ces tests). */
  async function run() {
    const result = await service.reconcile();
    if (!result.ran) throw new Error(`réconciliation non exécutée : ${result.reason}`);
    return result;
  }
  return { ...fake, saspay, service, logs, sent, only, hook, run };
}
type Ctx = ReturnType<typeof setup>;

const softpay = (key: string, extra: Record<string, unknown> = {}) => ({
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
  return error as PaymentError;
}

/**
 * Le cas de la mission : SasPay crée le paiement (la demande part sur le
 * téléphone), mais ni la réponse ni celle du rejeu immédiat ne reviennent.
 */
async function lostResponse(ctx: Ctx, key = 'idem-lost-0001', user = alice) {
  ctx.saspay.loseSoftpayResponses(2);
  const result = await ctx.service.create(user, softpay(key));
  const order = [...ctx.orders.values()].find((o) => o.id === result.order.id) as OrderRecord;
  const txId = [...ctx.saspay.transactions.keys()].at(-1) as string;
  return { result, order, txId };
}

/** Passe la fenêtre de rejeu puis l'entretien planifié : la commande entre en rapprochement manuel. */
function intoReview(ctx: Ctx) {
  ctx.clock.now += 12 * 60_000;
  return ctx.housekeeping();
}

describe('réponse de création perdue — ce que voit le client', () => {
  it('paiement créé chez SasPay, réponse jamais reçue : ni « payé », ni « échoué », ni « à refaire »', async () => {
    const ctx = setup();
    const { result, order } = await lostResponse(ctx);
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(result.next).toBe('review');
    expect(result.message).toBe(UNCONFIRMED_MESSAGE);
    expect(result.order).toMatchObject({ state: 'review', status: 'pending', retry_allowed: true });
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null, failure_code: 'initiation_unconfirmed' });
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.initiations.get(order.id)).toMatchObject({ outcome: 'unknown', attempts: 1, resolvedAt: null });
  });

  it('le statut est dit tel quel, sans interroger SasPay (aucun identifiant à vérifier)', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    const before = ctx.saspay.calls.length;
    const status = await ctx.service.refresh(alice, { product: 'studio', order_id: order.id });
    expect(status).toMatchObject({ verified: false, credited: false, message: UNCONFIRMED_MESSAGE, order: { state: 'review' } });
    expect(ctx.saspay.calls).toHaveLength(before);
    // Un tiers ne voit rien.
    await expectError(ctx.service.refresh(bob, { product: 'studio', order_id: order.id }), 'PAYMENT_NOT_FOUND', 404);
  });

  it('aucun message, journal ou vue ne contient le numéro du payeur ni la clé', async () => {
    const ctx = setup();
    const { result } = await lostResponse(ctx);
    const exposed = JSON.stringify([result, ctx.logs, ctx.anomalies]);
    expect(exposed).not.toContain('70123456');
    expect(exposed).not.toContain('sk_');
  });

  it('vue publique : `retry_allowed` seulement pendant la fenêtre de rejeu', () => {
    const base = { status: 'pending', provider_payment_id: null, provider_session_id: null } as unknown as OrderRecord;
    expect(paymentState({ ...base, failure_code: 'initiation_unconfirmed' })).toBe('review');
    expect(paymentState({ ...base, failure_code: 'manual_review' })).toBe('review');
    expect(paymentState({ ...base, failure_code: null })).toBe('todo');
    // Dès qu'un identifiant est connu, la commande est simplement « en attente ».
    expect(paymentState({ ...base, provider_payment_id: 'tx-1', failure_code: 'initiation_unconfirmed' })).toBe('pending');
    expect(publicOrder({ ...base, failure_code: 'initiation_unconfirmed' }).retry_allowed).toBe(true);
    expect(publicOrder({ ...base, failure_code: 'manual_review' }).retry_allowed).toBe(false);
    expect('retry_allowed' in publicOrder({ ...base, failure_code: null })).toBe(false);
  });
});

describe('réponse de création perdue — aucun second paiement', () => {
  it('un nouvel achat Studio est refusé tant que l’issue est inconnue', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    const calls = ctx.sent().length;
    const error = await expectError(ctx.service.create(alice, softpay('idem-other-0001')), 'PAYMENT_UNDER_REVIEW', 409);
    expect(error.message).toContain('en cours de vérification');
    // Autre pack, autre numéro, autre réseau : même refus.
    await expectError(ctx.service.create(alice, softpay('idem-other-0002', {
      item: { kind: 'pack', pack_key: 'pro_creator' }, phone: '66 55 44 33', network: 'moov_ml',
    })), 'PAYMENT_UNDER_REVIEW', 409);
    // La page hébergée n'est pas une échappatoire.
    await expectError(ctx.service.create(alice, {
      product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML', flow: 'checkout', idempotency_key: 'idem-other-0003',
    }), 'PAYMENT_UNDER_REVIEW', 409);
    expect(ctx.orders.size).toBe(1);
    expect(ctx.sent()).toHaveLength(calls);
    expect(ctx.saspay.count('POST', '/checkout-sessions/')).toBe(0);
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('un abonnement Business Grow est refusé aussi (et réciproquement)', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    await expectError(ctx.service.create(alice, plan('idem-bg-0001')), 'PAYMENT_UNDER_REVIEW', 409);

    const other = setup();
    other.saspay.loseSoftpayResponses(2);
    const bg = await other.service.create(alice, plan('idem-bg-0002'));
    expect(bg.next).toBe('review');
    await expectError(other.service.create(alice, softpay('idem-st-0002')), 'PAYMENT_UNDER_REVIEW', 409);
    expect(other.saspay.transactions.size).toBe(1);
    expect(other.credits.business.size).toBe(0);
  });

  it('les autres clients ne sont pas concernés', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    const result = await ctx.service.create(bob, softpay('idem-bob-0001'));
    expect(result.next).toBe('await_confirmation');
  });

  it('toujours refusé une fois en rapprochement manuel, jusqu’à la décision', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    intoReview(ctx);
    await expectError(ctx.service.create(alice, softpay('idem-other-0004')), 'PAYMENT_UNDER_REVIEW', 409);
    ctx.closeUnpaid(order.id, boss.id, NOTE);
    expect((await ctx.service.create(alice, softpay('idem-other-0005'))).next).toBe('await_confirmation');
  });
});

describe('réponse de création perdue — relances du client', () => {
  it('la relance rejoue la MÊME demande : même clé, même corps → SasPay rend le paiement d’origine', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    const retry = await ctx.service.create(alice, softpay('idem-lost-0001'));
    expect(retry).toMatchObject({ next: 'await_confirmation', message: null, order: { id: order.id, state: 'pending' } });
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(order.provider_payment_id).toBe(txId);
    expect(order.failure_code ?? null).toBeNull();
    expect(ctx.initiations.get(order.id)).toMatchObject({ outcome: 'attached', request: null, attempts: 2 });
    const calls = ctx.sent();
    expect(new Set(calls.map((c) => c.headers['idempotency-key']))).toEqual(new Set([order.internal_reference]));
    expect(new Set(calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
    // Puis le paiement suit la voie ordinaire : vérifié SUCCESS → crédité une seule fois.
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.clock.now += 5_000;
    expect(await ctx.service.refresh(alice, { product: 'studio', order_id: order.id })).toMatchObject({ credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('le client change de numéro en relançant : c’est le corps d’origine qui repart (sinon SasPay répondrait 409)', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    const retry = await ctx.service.create(alice, softpay('idem-lost-0001', { phone: '66 55 44 33', network: 'moov_ml' }));
    expect(retry.order.state).toBe('pending');
    const bodies = ctx.sent().map((c) => c.body as { customer: { phone: string }; network: string });
    expect(new Set(bodies.map((b) => b.customer.phone))).toEqual(new Set(['+22370123456']));
    expect(new Set(bodies.map((b) => b.network))).toEqual(new Set(['orange_ml']));
    expect(order.payer_msisdn_masked).toBe('+223••••••56');
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('relances répétées pendant une panne : 4 tentatives au plus, puis rapprochement — jamais un second paiement', async () => {
    const ctx = setup();
    ctx.saspay.loseSoftpayResponses(100);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await ctx.service.create(alice, softpay('idem-lost-0002'));
      expect(result).toMatchObject({ next: 'review', message: UNCONFIRMED_MESSAGE, order: { retry_allowed: true } });
      expect(ctx.initiations.get(ctx.only().id)?.attempts).toBe(attempt);
      ctx.clock.now += 30_000;
    }
    expect(ctx.sent()).toHaveLength(8);
    const fifth = await ctx.service.create(alice, softpay('idem-lost-0002'));
    expect(fifth).toMatchObject({ next: 'review', message: REVIEW_MESSAGE, order: { state: 'review', retry_allowed: false } });
    expect(ctx.sent()).toHaveLength(8);
    expect(ctx.only()).toMatchObject({ status: 'pending', failure_code: 'manual_review' });
    expect(ctx.anomalies.filter((a) => a.kind === 'initiation_unconfirmed')).toHaveLength(1);
    expect(ctx.anomalies[0].details).toMatchObject({ reason: 'attempts_exhausted' });
    expect(ctx.orders.size).toBe(1);
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(new Set(ctx.sent().map((c) => c.headers['idempotency-key'])).size).toBe(1);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('fenêtre de rejeu dépassée (10 min) : plus aucun appel SasPay, la commande part en rapprochement', async () => {
    const ctx = setup();
    await lostResponse(ctx);
    const calls = ctx.sent().length;
    ctx.clock.now += 10 * 60_000 + 1_000;
    const late = await ctx.service.create(alice, softpay('idem-lost-0001'));
    expect(late).toMatchObject({ next: 'review', message: REVIEW_MESSAGE, order: { retry_allowed: false } });
    expect(ctx.sent()).toHaveLength(calls);
    expect(ctx.only().failure_code).toBe('manual_review');
    expect(ctx.anomalies[0]).toMatchObject({ kind: 'initiation_unconfirmed', details: { reason: 'replay_window_elapsed' } });
    const status = await ctx.service.refresh(alice, { product: 'studio', order_id: ctx.only().id });
    expect(status).toMatchObject({ verified: false, credited: false, message: REVIEW_MESSAGE });
  });

  it('fenêtre et nombre de relances réglables (bornés en base)', async () => {
    const ctx = setup({ replayWindowMs: 60_000, maxAttempts: 2 });
    ctx.saspay.loseSoftpayResponses(100);
    await ctx.service.create(alice, softpay('idem-lost-0003'));
    await ctx.service.create(alice, softpay('idem-lost-0003'));
    expect((await ctx.service.create(alice, softpay('idem-lost-0003'))).message).toBe(REVIEW_MESSAGE);
    expect(ctx.sent()).toHaveLength(4);
  });

  it('la requête n’a jamais atteint SasPay : la relance est le premier vrai envoi, un seul paiement', async () => {
    const ctx = setup();
    ctx.saspay.dropSoftpayRequests(2);
    const first = await ctx.service.create(alice, softpay('idem-drop-0001'));
    expect(first.next).toBe('review');
    expect(ctx.saspay.transactions.size).toBe(0);
    const retry = await ctx.service.create(alice, softpay('idem-drop-0001'));
    expect(retry.next).toBe('await_confirmation');
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(ctx.only().provider_payment_id).toBe([...ctx.saspay.transactions.keys()][0]);
  });

  it('double clic pendant l’envoi : la seconde requête attend l’issue de la première, sans second appel', async () => {
    const ctx = setup();
    const [first, second] = await Promise.all([
      ctx.service.create(alice, softpay('idem-dbl-0001')),
      ctx.service.create(alice, softpay('idem-dbl-0001')),
    ]);
    expect(first.order.id).toBe(second.order.id);
    expect([first.next, second.next]).toEqual(['await_confirmation', 'await_confirmation']);
    expect(ctx.sent()).toHaveLength(1);
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('deux commandes ouvertes avant tout envoi : une seule demande part', async () => {
    const ctx = setup();
    const hold: Array<() => void> = [];
    ctx.saspay.respondWith((call) => (call.path === '/payments/softpay/'
      ? new Promise<undefined>((resolve) => { hold.push(() => resolve(undefined)); }) as unknown as undefined : undefined));
    const studio = ctx.service.create(alice, softpay('idem-two-0001'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expectError(ctx.service.create(alice, plan('idem-two-0002')), 'PAYMENT_ALREADY_IN_PROGRESS', 409);
    hold.forEach((release) => release());
    expect((await studio).next).toBe('await_confirmation');
    expect(ctx.sent()).toHaveLength(1);
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('identifiant reçu mais impossible à enregistrer : même traitement qu’une réponse perdue', async () => {
    const ctx = setup();
    ctx.failAttach(1);
    await expectError(ctx.service.create(alice, softpay('idem-att-0001')), 'PAYMENT_STORAGE_UNAVAILABLE', 503);
    expect(ctx.saspay.transactions.size).toBe(1);
    expect(ctx.only()).toMatchObject({ status: 'pending', provider_payment_id: null, failure_code: 'initiation_unconfirmed' });
    expect(ctx.initiations.get(ctx.only().id)).toMatchObject({ outcome: 'unknown', lastError: 'attach_failed' });
    await expectError(ctx.service.create(alice, softpay('idem-att-0002')), 'PAYMENT_UNDER_REVIEW', 409);
    const retry = await ctx.service.create(alice, softpay('idem-att-0001'));
    expect(retry.next).toBe('await_confirmation');
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('après une tentative sans réponse, un refus d’accès (401/403) ne prouve rien : la commande reste en vérification', async () => {
    for (const status of [401, 403]) {
      const ctx = setup();
      await lostResponse(ctx);
      ctx.saspay.respondWith((call) => (call.path === '/payments/softpay/'
        ? jsonResponse({ success: false, error: { code: 'authentication_failed', message: 'x' }, code: status }, status) : undefined));
      const retry = await ctx.service.create(alice, softpay('idem-lost-0001'));
      expect(retry.next).toBe('review');
      expect(ctx.only()).toMatchObject({ status: 'pending', failure_code: 'initiation_unconfirmed' });
    }
  });

  it('après une tentative sans réponse, un refus métier (422) au rejeu clôt la commande : le premier envoi a été refusé de même', async () => {
    const ctx = setup();
    ctx.saspay.dropSoftpayRequests(2);
    await ctx.service.create(alice, softpay('idem-drop-0002'));
    ctx.saspay.respondWith((call) => (call.path === '/payments/softpay/'
      ? jsonResponse({ success: false, error: { code: 'no_route_available', message: 'x' }, code: 422 }, 422) : undefined));
    await expectError(ctx.service.create(alice, softpay('idem-drop-0002')), 'PAYMENT_REJECTED', 422);
    expect(ctx.only().status).toBe('failed');
    expect(ctx.initiations.get(ctx.only().id)).toMatchObject({ outcome: 'refused', request: null });
    ctx.saspay.respondWith(null);
    expect((await ctx.service.create(alice, softpay('idem-drop-0003'))).next).toBe('await_confirmation');
  });
});

describe('réponse de création perdue — le client ne revient jamais', () => {
  it('webhook d’une transaction inconnue + SasPay restitue le libellé : rattachée, vérifiée, créditée une fois', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const result = await ctx.hook(txId);
    expect(result).toMatchObject({ received: true, outcome: 'paid', credited: true });
    expect(order).toMatchObject({ status: 'paid', provider_payment_id: txId });
    expect(order.failure_code ?? null).toBeNull();
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.initiations.get(order.id)).toMatchObject({ outcome: 'attached', request: null });
    // Renvois du même webhook, tâche planifiée : aucun second crédit.
    expect(await ctx.hook(txId)).toMatchObject({ duplicate: true });
    await ctx.service.reconcile();
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    // Le client peut de nouveau acheter.
    expect((await ctx.service.create(alice, softpay('idem-next-0001'))).next).toBe('await_confirmation');
  });

  it('SasPay ne restitue que les métadonnées : la référence y est reconnue aussi', async () => {
    const ctx = setup();
    const { txId } = await lostResponse(ctx);
    ctx.saspay.omitVerifyDescriptions();
    ctx.saspay.exposeMetadata();
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    expect(await ctx.hook(txId)).toMatchObject({ outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('webhook « success » alors que SasPay vérifie PENDING : rattachée, rien livré, puis livrée à la confirmation', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    expect(await ctx.hook(txId)).toMatchObject({ outcome: 'pending', credited: false });
    expect(order).toMatchObject({ status: 'processing', provider_payment_id: txId });
    expect(ctx.credits.studio.size).toBe(0);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.clock.now += 5_000;
    expect(await ctx.hook(txId)).toMatchObject({ outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('webhook « failed » prouvé : la commande est close « échouée », le client peut repayer', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.setTransaction(txId, { status: 'FAILED' });
    expect(await ctx.hook(txId, 'transaction.failed')).toMatchObject({ outcome: 'failed', credited: false });
    expect(order.status).toBe('failed');
    expect((await ctx.service.create(alice, softpay('idem-next-0002'))).next).toBe('await_confirmation');
  });

  it('SasPay ne restitue NI libellé NI métadonnées : rien n’est rattaché sur une ressemblance — la transaction est proposée à l’administrateur', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.omitVerifyDescriptions();
    ctx.saspay.omitListDescriptions();
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const result = await ctx.hook(txId, 'transaction.success', { msisdn: '+22370123456' });
    expect(result).toEqual({ received: true, ignored: true, reason: 'unknown_transaction' });
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null });
    expect(ctx.credits.studio.size).toBe(0);
    expect(ctx.initiations.get(order.id)?.candidates).toEqual([
      expect.objectContaining({ id: txId, status: 'SUCCESS', amount: '5000.00', source: 'webhook', msisdn_match: true, described: false }),
    ]);
    // Même webhook rejoué : pas de doublon de piste.
    await ctx.hook(txId, 'transaction.success', { msisdn: '+22370123456' });
    expect(ctx.initiations.get(order.id)?.candidates).toHaveLength(1);
    // Un autre montant, ou un autre numéro annoncé : écarté / signalé.
    const cheap = ctx.saspay.addTransaction({ requested_amount: '100.00' });
    await ctx.hook(cheap);
    const stranger = ctx.saspay.addTransaction({ requested_amount: '5000.00' });
    await ctx.hook(stranger, 'transaction.success', { msisdn: '+22366554433' });
    expect(ctx.initiations.get(order.id)?.candidates.map((c) => [c.id, c.msisdn_match])).toEqual([[txId, true], [stranger, false]]);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('webhook d’une transaction inconnue sans aucune commande incertaine : ignoré sans appel SasPay', async () => {
    const ctx = setup();
    const foreign = ctx.saspay.addTransaction({ requested_amount: '5000.00' });
    expect(await ctx.hook(foreign)).toEqual({ received: true, ignored: true, reason: 'unknown_transaction' });
    expect(ctx.saspay.calls).toHaveLength(0);
  });

  it('SasPay injoignable pendant ce webhook : 503, pour qu’il soit représenté', async () => {
    const ctx = setup();
    const { txId } = await lostResponse(ctx);
    ctx.saspay.respondWith((call) => (call.path.includes('/verify/') ? jsonResponse({ error: { code: 'x', message: 'down' } }, 500) : undefined));
    const signed = await signedWebhook({ event: 'transaction.success', data: { id: txId } });
    await expectError(ctx.service.webhook(signed.raw, signed), 'WEBHOOK_PROCESSING_FAILED', 503);
    ctx.saspay.respondWith(null);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    expect(await ctx.hook(txId)).toMatchObject({ credited: true });
  });

  it('une transaction portant la référence d’une AUTRE commande n’est jamais rattachée ni proposée', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    const other = ctx.saspay.addTransaction({ requested_amount: '5000.00', description: 'Pack — VYS-0000000000000000000000000000FFFF' });
    expect(await ctx.hook(other)).toMatchObject({ ignored: true });
    expect(ctx.initiations.get(order.id)?.candidates).toEqual([]);
    expect(order.provider_payment_id).toBeNull();
  });

  it('l’entretien planifié ne la déclare jamais « non payée » : elle part en rapprochement manuel', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    // Une commande jamais présentée à SasPay, elle, expire normalement.
    ctx.clock.now += 50 * 60_000;
    expect(ctx.housekeeping()).toEqual({ opened: 1, expired: 0 });
    expect(order).toMatchObject({ status: 'pending', failure_code: 'manual_review' });
    ctx.clock.now += 30 * 24 * 3_600_000;
    expect(ctx.housekeeping()).toEqual({ opened: 0, expired: 0 });
    expect(order.status).toBe('pending');
    expect(ctx.anomalies.filter((a) => a.kind === 'initiation_unconfirmed')).toHaveLength(1);
  });
});

describe('réponse de création perdue — tâche planifiée', () => {
  it('recherche par numéro du payeur : SasPay restitue le libellé → retrouvée, vérifiée, créditée une fois', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.reconcile.sweep = false; // on isole la recherche par numéro du balayage général
    const run = await ctx.run();
    expect(run).toMatchObject({ ran: true, settled: 1 });
    expect(order).toMatchObject({ status: 'paid', provider_payment_id: txId });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    await ctx.service.reconcile();
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    // Lecture seule, bornée dans le temps, par numéro : jamais par e-mail ni par nom.
    const searches = ctx.saspay.calls.filter((c) => c.path.startsWith('/transactions/') && c.path.includes('search='));
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((c) => c.method === 'GET')).toBe(true);
    const query = new URL(`https://x${searches[0].path}`).searchParams;
    expect(query.get('search')).toBe('22370123456');
    expect(query.get('flow_direction')).toBe('INBOUND');
    expect(Date.parse(String(query.get('created_at__gte')))).toBe(NOW - 5 * 60_000);
    expect(JSON.stringify(ctx.logs)).not.toContain('70123456');
  });

  it('encaissement encore PENDING chez SasPay : rattaché, rien livré ; livré à la confirmation', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.reconcile.sweep = false;
    await ctx.service.reconcile();
    expect(order).toMatchObject({ status: 'processing', provider_payment_id: txId });
    expect(ctx.credits.studio.size).toBe(0);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.clock.now += 5 * 60_000;
    await ctx.service.reconcile();
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('liste SANS libellé : aucune livraison ; les transactions ressemblantes sont consignées pour l’administrateur', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.omitListDescriptions();
    ctx.saspay.omitVerifyDescriptions();
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    // Même numéro mais autre montant ; même montant mais hors fenêtre ; même montant mais déjà rattachée ailleurs.
    ctx.saspay.addTransaction({ requested_amount: '15000.00', _phone: '+22370123456' });
    ctx.saspay.addTransaction({ requested_amount: '5000.00', _phone: '+22370123456', created_at: new Date(NOW + 3 * 3_600_000).toISOString() });
    await ctx.service.create(bob, softpay('idem-bob-0002', { phone: '70 12 34 56' }));
    const run = await ctx.run();
    expect(run.settled).toBe(0);
    expect(ctx.credits.studio.size).toBe(0);
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null });
    const candidates = ctx.initiations.get(order.id)?.candidates ?? [];
    expect(candidates).toEqual([expect.objectContaining({ id: txId, status: 'SUCCESS', amount: '5000.00', currency: 'XOF', source: 'search', described: false })]);
    expect(ctx.runs.at(-1)?.counts?.detail).toMatchObject({ unconfirmed_searched: 1, unconfirmed_recovered: 0, unconfirmed_with_candidates: 1 });
  });

  it('une piste venue d’un webhook survit à une recherche qui ne la voit pas', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    ctx.saspay.omitListDescriptions();
    ctx.saspay.omitVerifyDescriptions();
    await ctx.hook(txId);
    // La recherche par numéro ne renvoie rien (SasPay ne retrouve pas ce numéro).
    ctx.saspay.setTransaction(txId, { _phone: '' });
    await ctx.service.reconcile();
    expect(ctx.initiations.get(order.id)?.candidates.map((c) => [c.id, c.source])).toEqual([[txId, 'webhook']]);
  });

  it('recherche SasPay en panne : le passage le signale, rien n’est conclu', async () => {
    const ctx = setup();
    const { order } = await lostResponse(ctx);
    ctx.reconcile.sweep = false;
    ctx.saspay.respondWith((call) => (call.path.startsWith('/transactions/') ? jsonResponse({ error: { code: 'x', message: 'down' } }, 503) : undefined));
    const run = await ctx.run();
    expect(run.errors).toBeGreaterThan(0);
    expect(run.status).not.toBe('ok');
    expect(order).toMatchObject({ status: 'pending', failure_code: 'initiation_unconfirmed' });
  });
});

describe('réponse de création perdue — décision de l’administrateur', () => {
  async function inReview(ctx: Ctx) {
    const lost = await lostResponse(ctx);
    ctx.saspay.omitVerifyDescriptions();
    ctx.saspay.omitListDescriptions();
    intoReview(ctx);
    return lost;
  }
  const attach = (ctx: Ctx, orderId: string, paymentId: string, user = boss, note = NOTE) => ctx.service.resolveReview(user,
    { product: 'studio', order_id: orderId, payment_id: paymentId, note });

  it('rattacher le paiement : relu chez SasPay, livré seulement si SUCCESS, une seule fois, tracé', async () => {
    const ctx = setup();
    const { order, txId } = await inReview(ctx);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const result = await attach(ctx, order.id, txId);
    expect(result).toMatchObject({ outcome: 'paid', credited: true, order: { state: 'confirmed' } });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect(ctx.initiations.get(order.id)).toMatchObject({ outcome: 'attached', request: null, resolvedBy: boss.id, note: NOTE });
    // Rejeu de la décision, webhook tardif, tâche planifiée : aucun second crédit.
    await expectError(attach(ctx, order.id, txId), 'PAYMENT_NOT_UNDER_REVIEW', 409);
    await ctx.hook(txId);
    await ctx.service.reconcile();
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
    expect((await ctx.service.create(alice, softpay('idem-next-0003'))).next).toBe('await_confirmation');
  });

  it('paiement encore PENDING : rattaché sans rien livrer, puis suivi par la voie ordinaire', async () => {
    const ctx = setup();
    const { order, txId } = await inReview(ctx);
    const result = await attach(ctx, order.id, txId);
    expect(result).toMatchObject({ outcome: 'pending', credited: false, order: { state: 'pending' } });
    expect(ctx.credits.studio.size).toBe(0);
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    ctx.clock.now += 5_000;
    expect(await ctx.service.refresh(alice, { product: 'studio', order_id: order.id })).toMatchObject({ credited: true });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });

  it('paiement FAILED chez SasPay : la commande est close « échouée », rien n’est livré', async () => {
    const ctx = setup();
    const { order, txId } = await inReview(ctx);
    ctx.saspay.setTransaction(txId, { status: 'FAILED' });
    expect(await attach(ctx, order.id, txId)).toMatchObject({ outcome: 'failed', credited: false });
    expect(order.status).toBe('failed');
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('refus : non-administrateur, motif absent, identifiant invalide, commande hors vérification', async () => {
    const ctx = setup();
    const { order, txId } = await inReview(ctx);
    await expectError(attach(ctx, order.id, txId, alice), 'PAYMENT_FORBIDDEN', 403);
    await expectError(attach(ctx, order.id, txId, boss, 'court'), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(attach(ctx, order.id, '../x'), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(attach(ctx, 'pas-un-uuid', txId), 'PAYMENT_INVALID_REQUEST', 400);
    await expectError(attach(ctx, '00000000-0000-4000-8000-00000000ffff', txId), 'PAYMENT_NOT_FOUND', 404);
    const normal = await ctx.service.create(bob, softpay('idem-bob-0003'));
    await expectError(attach(ctx, String(normal.order.id), txId), 'PAYMENT_NOT_UNDER_REVIEW', 409);
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null });
    expect(ctx.calls).not.toContain('reviewAttached');
  });

  it('refus : la transaction ne correspond pas (montant, devise, sens, autre commande, antérieure, inconnue)', async () => {
    const ctx = setup();
    const { order } = await inReview(ctx);
    const cheap = ctx.saspay.addTransaction({ requested_amount: '500.00' });
    const euro = ctx.saspay.addTransaction({ requested_amount: '5000.00', currency: 'EUR' });
    const payout = ctx.saspay.addTransaction({ requested_amount: '5000.00', flow_direction: 'OUTBOUND' });
    const old = ctx.saspay.addTransaction({ requested_amount: '5000.00', created_at: new Date(NOW - 3_600_000).toISOString() });
    ctx.saspay.omitVerifyDescriptions(false);
    const foreign = ctx.saspay.addTransaction({ requested_amount: '5000.00', description: 'Pack — VYS-0000000000000000000000000000FFFF' });
    for (const id of [cheap, euro, payout, old, foreign]) {
      const error = await expectError(attach(ctx, order.id, id), 'PAYMENT_REVIEW_MISMATCH', 422);
      expect(error.message).toContain('Rien n’a été rattaché');
    }
    await expectError(attach(ctx, order.id, 'tx-inconnue-0001'), 'PAYMENT_PROVIDER_NOT_FOUND', 404);
    // Paiement déjà rattaché à la commande d'un autre client.
    const normal = await ctx.service.create(bob, softpay('idem-bob-0004'));
    const taken = (ctx.orders.get(String(normal.order.id)) as OrderRecord).provider_payment_id as string;
    await expectError(attach(ctx, order.id, taken), 'PAYMENT_REFERENCE_CONFLICT', 409);
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null, failure_code: 'manual_review' });
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('SasPay injoignable au moment de la décision : rien n’est rattaché', async () => {
    const ctx = setup();
    const { order, txId } = await inReview(ctx);
    ctx.saspay.respondWith((call) => (call.path.includes('/verify/') ? jsonResponse({ error: { code: 'x', message: 'down' } }, 503) : undefined));
    await expectError(attach(ctx, order.id, txId), 'PAYMENT_PROVIDER_UNAVAILABLE', 503);
    expect(order).toMatchObject({ status: 'pending', provider_payment_id: null });
  });

  it('aucun encaissement : clôture attestée → rien livré, le client peut repayer', async () => {
    const ctx = setup();
    ctx.saspay.dropSoftpayRequests(2);
    await ctx.service.create(alice, softpay('idem-drop-0004'));
    const order = ctx.only();
    intoReview(ctx);
    ctx.closeUnpaid(order.id, boss.id, 'Aucune transaction au tableau de bord SasPay');
    expect(order).toMatchObject({ status: 'cancelled', failure_code: 'unconfirmed_closed' });
    expect(paymentState(order)).toBe('cancelled');
    expect(ctx.credits.studio.size).toBe(0);
    const again = await ctx.service.create(alice, softpay('idem-drop-0005'));
    expect(again.next).toBe('await_confirmation');
    expect(ctx.saspay.transactions.size).toBe(1);
  });

  it('clôture attestée à tort, l’encaissement apparaît ensuite (libellé restitué) : commande rouverte et livrée', async () => {
    const ctx = setup();
    const { order, txId } = await lostResponse(ctx);
    intoReview(ctx);
    ctx.closeUnpaid(order.id, boss.id, 'Aucune transaction au tableau de bord SasPay');
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });
    const run = await ctx.run();
    expect(run.settled).toBe(1);
    expect(order).toMatchObject({ status: 'paid', provider_payment_id: txId });
    expect(ctx.credits.studio.get(alice.id)).toBe(27);
  });
});
