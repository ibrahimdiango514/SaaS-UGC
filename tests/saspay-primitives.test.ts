import { describe, expect, it, vi } from 'vitest';
import {
  decimalEquals, formatDecimal, normalizeDecimal, parseDecimal, quoteFee, selectTier,
} from '../supabase/functions/_shared/saspay/money';
import {
  signWebhook, timingSafeEqualHex, verifyWebhookSignature,
} from '../supabase/functions/_shared/saspay/webhook';
import {
  SASPAY_API_BASE, SasPayError, createSasPayClient, keyMode, redactSecrets,
} from '../supabase/functions/_shared/saspay/client';
import { TEST_KEY, LIVE_KEY, createFakeSasPay, jsonResponse } from './helpers/saspay-fakes';

describe('SasPay — montants décimaux exacts', () => {
  it('convertit les chaînes décimales en centièmes sans virgule flottante', () => {
    expect(parseDecimal('2500')).toBe(250000n);
    expect(parseDecimal('2500.5')).toBe(250050n);
    expect(parseDecimal('2500.50')).toBe(250050n);
    expect(parseDecimal(' 0.07 ')).toBe(7n);
    expect(parseDecimal(5000)).toBe(500000n);
    // 0.1 + 0.2 en flottant vaut 0.30000000000000004 : ici le calcul est exact.
    expect(formatDecimal((parseDecimal('0.10') as bigint) + (parseDecimal('0.20') as bigint))).toBe('0.30');
    expect(formatDecimal((parseDecimal('999999999999.99') as bigint) + 1n)).toBe('1000000000000.00');
  });

  it('refuse tout ce qui n’est pas un montant décimal strict', () => {
    for (const bad of ['', '-1', '1e3', '1,5', '1.234', 'abc', '0x10', '१२', null, undefined, {}, 1.5, Number.NaN, -3, Infinity]) {
      expect(parseDecimal(bad)).toBeNull();
    }
    expect(normalizeDecimal('5000')).toBe('5000.00');
    expect(normalizeDecimal('5000.5')).toBe('5000.50');
    expect(normalizeDecimal('nope')).toBeNull();
    expect(() => formatDecimal(-1n)).toThrow();
  });

  it('compare les montants par valeur et non par écriture', () => {
    expect(decimalEquals('5000', '5000.00')).toBe(true);
    expect(decimalEquals('5000.0', 5000)).toBe(true);
    expect(decimalEquals('5000.01', '5000.00')).toBe(false);
    expect(decimalEquals('abc', 'abc')).toBe(false);
  });

  it('choisit le palier tarifaire applicable (bornes incluses)', () => {
    const tiers = [
      { min_amount: '0.00', max_amount: '9999.99', percent: '3.00', fixed: '0.00', fee_charge_mode: 'ADD_ON' },
      { min_amount: '10000.00', max_amount: null, percent: '2.00', fixed: '0.00', fee_charge_mode: 'ADD_ON' },
    ];
    expect(selectTier('5000.00', tiers)).toBe(tiers[0]);
    expect(selectTier('9999.99', tiers)).toBe(tiers[0]);
    expect(selectTier('10000.00', tiers)).toBe(tiers[1]);
    expect(selectTier('5000.00', [])).toBeNull();
  });

  it('ADD_ON : les frais s’ajoutent au montant payé, le marchand reçoit le prix', () => {
    const quote = quoteFee('5000.00', { percent: '2.00', fixed: '0.00', fee_charge_mode: 'ADD_ON' });
    expect(quote).toEqual({ fee: '100.00', mode: 'ADD_ON', total: '5100.00', net: '5000.00' });
  });

  it('DEDUCTED : le client paie le prix, les frais sont retenus sur le versement', () => {
    const quote = quoteFee('15000.00', { percent: '3.00', fixed: '50.00', fee_charge_mode: 'DEDUCTED' });
    expect(quote).toEqual({ fee: '500.00', mode: 'DEDUCTED', total: '15000.00', net: '14500.00' });
  });

  it('applique plancher et plafond, arrondit les frais au centième supérieur', () => {
    expect(quoteFee('1000.00', { percent: '1.00', fixed: '0.00', floor_amount: '50.00', fee_charge_mode: 'ADD_ON' })?.fee).toBe('50.00');
    expect(quoteFee('900000.00', { percent: '2.00', fixed: '0.00', cap_amount: '5000.00', fee_charge_mode: 'ADD_ON' })?.fee).toBe('5000.00');
    expect(quoteFee('333.33', { percent: '1.50', fixed: '0.00', fee_charge_mode: 'ADD_ON' })?.fee).toBe('5.00');
    expect(quoteFee('0.01', { percent: '1.50', fixed: '0.00', fee_charge_mode: 'ADD_ON' })?.fee).toBe('0.01');
  });

  it('ne produit aucune estimation si le tarif est illisible', () => {
    expect(quoteFee('5000.00', null)).toBeNull();
    expect(quoteFee('5000.00', { percent: '2.00', fixed: '0.00' })).toBeNull();
    expect(quoteFee('5000.00', { percent: 'deux', fixed: '0.00', fee_charge_mode: 'ADD_ON' })).toBeNull();
    expect(quoteFee('abc', { percent: '2.00', fixed: '0.00', fee_charge_mode: 'ADD_ON' })).toBeNull();
    expect(quoteFee('10.00', { percent: '0.00', fixed: '50.00', fee_charge_mode: 'DEDUCTED' })).toBeNull();
  });
});

describe('SasPay — signature des webhooks', () => {
  const secret = 'whsec_test';
  const rawBody = '{"event":"transaction.success","data":{"id":"tx-1","amount":"5000.00"}}';
  const now = 1_794_564_000;

  it('signe en HMAC-SHA256 hexadécimal minuscule sur « timestamp.corps »', async () => {
    // Vecteur de référence calculé indépendamment (node:crypto).
    const { createHmac } = await import('node:crypto');
    const expected = createHmac('sha256', secret).update(`${now}.${rawBody}`).digest('hex');
    expect(await signWebhook(secret, String(now), rawBody)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepte une signature valide dans la fenêtre de 300 secondes', async () => {
    const signature = await signWebhook(secret, String(now), rawBody);
    for (const drift of [0, 299, -299, 300]) {
      expect(await verifyWebhookSignature({ secret, signature, timestamp: String(now), rawBody, nowSeconds: now + drift }))
        .toEqual({ ok: true });
    }
  });

  it('rejette une signature expirée (rejeu) ou venue du futur', async () => {
    const signature = await signWebhook(secret, String(now), rawBody);
    expect(await verifyWebhookSignature({ secret, signature, timestamp: String(now), rawBody, nowSeconds: now + 301 }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(await verifyWebhookSignature({ secret, signature, timestamp: String(now), rawBody, nowSeconds: now - 301 }))
      .toEqual({ ok: false, reason: 'expired' });
  });

  it('rejette un corps modifié, un autre secret ou un autre horodatage', async () => {
    const signature = await signWebhook(secret, String(now), rawBody);
    const base = { secret, signature, timestamp: String(now), rawBody, nowSeconds: now };
    expect(await verifyWebhookSignature({ ...base, rawBody: rawBody.replace('5000.00', '9000.00') })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhookSignature({ ...base, rawBody: `${rawBody} ` })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhookSignature({ ...base, secret: 'autre' })).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifyWebhookSignature({ ...base, timestamp: String(now + 1) })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejette les en-têtes absents ou mal formés sans calculer de signature', async () => {
    const signature = await signWebhook(secret, String(now), rawBody);
    const base = { secret, signature, timestamp: String(now), rawBody, nowSeconds: now };
    expect(await verifyWebhookSignature({ ...base, signature: null })).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyWebhookSignature({ ...base, timestamp: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyWebhookSignature({ ...base, secret: '' })).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyWebhookSignature({ ...base, signature: 'zz' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyWebhookSignature({ ...base, signature: `sha256=${signature}` })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyWebhookSignature({ ...base, timestamp: '2026-11-13' })).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyWebhookSignature({ ...base, timestamp: `${now}000` })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('compare à temps constant (longueurs différentes → faux)', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
  });
});

describe('SasPay — client HTTP', () => {
  const customer = { email: 'a@b.ml', first_name: 'Awa', last_name: 'Traoré', phone: '+22370000000' };
  const softpayBody = { amount: '5000.00', currency: 'XOF', country: 'ML', network: 'orange_ml', customer };

  it('appelle l’API officielle avec la clé en Bearer et la clé d’idempotence', async () => {
    const saspay = createFakeSasPay();
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher });
    const result = await client.softpay(softpayBody, 'VYS-REF-1');
    expect(result).toEqual({ id: 'tx-00000001', status: 'PENDING', checkout_url: null });
    const call = saspay.calls[0];
    expect(SASPAY_API_BASE).toBe('https://api.saspay.me/api/v1');
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/payments/softpay/');
    expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(call.headers['idempotency-key']).toBe('VYS-REF-1');
    expect(call.body).toEqual(softpayBody);
    // Le montant voyage en chaîne décimale, jamais en nombre.
    expect(typeof call.body?.amount).toBe('string');
  });

  it('n’envoie pas d’Idempotency-Key sur les sessions de checkout (non pris en charge)', async () => {
    const saspay = createFakeSasPay();
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher });
    const session = await client.createCheckoutSession({ amount: '5000.00', currency: 'XOF', customer_email: 'a@b.ml', customer_name: 'Awa T' });
    expect(session.checkout_url).toBe('https://pay.saspay.me/c/cs-00000001');
    expect(saspay.calls[0].headers['idempotency-key']).toBeUndefined();
  });

  it('accepte les réponses avec ou sans enveloppe { success, data }', async () => {
    const tx = { id: 'tx-9', status: 'SUCCESS', requested_amount: '5000.00', currency: 'xof', reference: 'R' };
    for (const body of [{ success: true, data: tx, code: 200 }, tx]) {
      const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: (async () => jsonResponse(body)) as typeof fetch });
      const verified = await client.verifyPayment('tx-9');
      expect(verified).toMatchObject({ id: 'tx-9', status: 'SUCCESS', requested_amount: '5000.00', currency: 'XOF' });
    }
  });

  it.each([
    [400, 'bad_request', false, true],
    [401, 'unauthorized', false, true],
    [403, 'forbidden', false, true],
    [404, 'not_found', false, true],
    [409, 'conflict', true, false],
    [410, 'gone', false, true],
    [422, 'unprocessable', false, true],
    [429, 'rate_limited', true, false],
    [500, 'provider_unavailable', true, false],
    [503, 'provider_unavailable', true, false],
  ] as const)('HTTP %i → %s (rejouable : %s, définitif : %s)', async (status, kind, retryable, definitive) => {
    const fetcher = (async () => jsonResponse({ success: false, error: { code: 'x_code', message: 'boom' }, code: status }, status)) as typeof fetch;
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher });
    const error = await client.softpay(softpayBody, 'k').catch((e: unknown) => e) as SasPayError;
    expect(error).toBeInstanceOf(SasPayError);
    expect(error.status).toBe(status);
    expect(error.kind).toBe(kind);
    expect(error.code).toBe('x_code');
    expect(error.retryable).toBe(retryable);
    expect(error.definitive).toBe(definitive);
  });

  it('lit les erreurs de validation par champ sans exposer les valeurs', async () => {
    const fetcher = (async () => jsonResponse({ success: false, error: { phone: ['Invalid +22370000000'], amount: ['bad'] }, code: 400 }, 400)) as typeof fetch;
    const error = await createSasPayClient({ secretKey: TEST_KEY, fetcher }).softpay(softpayBody, 'k').catch((e: unknown) => e) as SasPayError;
    expect(error.code).toBe('validation_error');
    expect(error.message).toBe('Champs refusés : phone, amount');
  });

  it('traite un délai dépassé comme « injoignable », rejouable et non définitif', async () => {
    const fetcher = (async () => { throw new DOMException('timeout', 'TimeoutError'); }) as typeof fetch;
    const error = await createSasPayClient({ secretKey: TEST_KEY, fetcher }).softpay(softpayBody, 'k').catch((e: unknown) => e) as SasPayError;
    expect(error.kind).toBe('provider_unreachable');
    expect(error.retryable).toBe(true);
    expect(error.definitive).toBe(false);
  });

  it('refuse un statut de paiement inconnu plutôt que de l’interpréter', async () => {
    for (const status of ['PAID', 'COMPLETED', 'success_ish', '', undefined]) {
      const fetcher = (async () => jsonResponse({ id: 'tx-1', status, requested_amount: '1.00' })) as typeof fetch;
      const error = await createSasPayClient({ secretKey: TEST_KEY, fetcher }).verifyPayment('tx-1').catch((e: unknown) => e) as SasPayError;
      expect(error.kind).toBe('invalid_response');
    }
  });

  it('refuse une réponse 200 illisible ou sans identifiant', async () => {
    for (const body of ['<html>', '[]', 'null', '{"status":"PENDING"}']) {
      const fetcher = (async () => new Response(body, { status: 200 })) as typeof fetch;
      const error = await createSasPayClient({ secretKey: TEST_KEY, fetcher }).softpay(softpayBody, 'k').catch((e: unknown) => e) as SasPayError;
      expect(error.kind).toBe('invalid_response');
    }
  });

  it('n’accepte qu’un lien de paiement https', async () => {
    const fetcher = (async () => jsonResponse({ id: 'cs-1', status: 'PENDING', checkout_url: 'javascript:alert(1)' }, 201)) as typeof fetch;
    const error = await createSasPayClient({ secretKey: TEST_KEY, fetcher })
      .createCheckoutSession({ amount: '1.00', currency: 'XOF', customer_email: 'a@b.ml', customer_name: 'A' }).catch((e: unknown) => e) as SasPayError;
    expect(error.kind).toBe('invalid_response');
  });

  it('lit les soldes par pays sans les additionner, en lecture seule', async () => {
    const saspay = createFakeSasPay();
    const balances = await createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher }).merchantBalances();
    expect(balances).toEqual([
      { id: 'bal-ml', country: 'ML', currency: 'XOF', available_amount: '125000.00', pending_amount: '5000.00', is_frozen: false, updated_at: '2026-11-13T09:00:00Z' },
      { id: 'bal-sn', country: 'SN', currency: 'XOF', available_amount: '900.00', pending_amount: '0.00', is_frozen: true, updated_at: '2026-11-12T09:00:00Z' },
    ]);
    expect(saspay.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(saspay.calls[0].path).toBe('/merchant-balances/?page=1&page_size=100');
  });

  it('ne laisse jamais fuiter la clé secrète dans une erreur', async () => {
    const fetcher = (async () => jsonResponse({ error: { code: 'x', message: `bad key ${LIVE_KEY}` } }, 401)) as typeof fetch;
    const error = await createSasPayClient({ secretKey: LIVE_KEY, fetcher }).myRates().catch((e: unknown) => e) as SasPayError;
    expect(error.message).not.toContain(LIVE_KEY);
    expect(error.message).toContain('sk_***');
    expect(JSON.stringify(error)).not.toContain('sk_live_');
    expect(redactSecrets(`a ${TEST_KEY} b ${LIVE_KEY}`)).toBe('a sk_*** b sk_***');
  });

  it('déduit le mode de la clé sans l’exposer', () => {
    expect(keyMode(TEST_KEY)).toBe('test');
    expect(keyMode(LIVE_KEY)).toBe('live');
    expect(keyMode('pk_whatever')).toBe('unknown');
    expect(createSasPayClient({ secretKey: `  ${TEST_KEY}\n`, fetcher: vi.fn() as unknown as typeof fetch }).mode).toBe('test');
  });

  it('n’expose aucune opération de décaissement, de transfert ou de recharge', () => {
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: vi.fn() as unknown as typeof fetch });
    expect(Object.keys(client).sort()).toEqual(
      ['checkoutStatus', 'createCheckoutSession', 'listSuccessfulPayments', 'merchantBalances', 'mode', 'myRates', 'searchPayments', 'softpay', 'verifyPayment'],
    );
  });
});

describe('SasPay — liste des encaissements (réconciliation)', () => {
  const page = (results: unknown[], next: string | null = null) =>
    new Response(JSON.stringify({ success: true, code: 200, data: { next, previous: null, results } }), { status: 200 });
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id, status: 'SUCCESS', flow_direction: 'INBOUND', transaction_type: 'PAIEMENT',
    description: `Pack — VYS-${'A'.repeat(32)}`, reference: `SP-${id}`, created_at: '2026-11-13T09:00:00Z', ...extra,
  });

  it('demande les encaissements réussis depuis une date, en lecture seule, et suit le curseur', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(page([row('tx-00000001')], 'https://api.saspay.me/api/v1/transactions/?cursor=abc&page_size=100'))
      .mockResolvedValueOnce(page([row('tx-00000002')]));
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
    const listing = await client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z' });
    expect(listing.truncated).toBe(false);
    expect(listing.transactions.map((tx) => tx.id)).toEqual(['tx-00000001', 'tx-00000002']);
    const [first, second] = fetcher.mock.calls.map(([url, init]) => ({ url: new URL(String(url)), init: init as RequestInit }));
    expect(first.init.method).toBe('GET');
    expect(first.init.body).toBeUndefined();
    expect(first.url.pathname).toBe('/api/v1/transactions/');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      // Uniquement des paramètres décrits par la spécification ; 200 = maximum documenté.
      status: 'SUCCESS', transaction_type: 'PAIEMENT', created_at__gte: '2026-11-10T10:00:00.000Z', page_size: '200',
    });
    expect(second.url.searchParams.get('cursor')).toBe('abc');
  });

  it('ne dépasse jamais la taille de page documentée (200)', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([]));
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
    await client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z', pageSize: 5000 });
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('page_size')).toBe('200');
  });

  it('compte les transactions dont la réponse porte un champ « description » (non garanti par la spécification)', async () => {
    const bare = (id: string) => ({ id, status: 'SUCCESS', flow_direction: 'INBOUND', transaction_type: 'PAIEMENT', reference: `SP-${id}` });
    const list = async (rows: unknown[]) => {
      const fetcher = vi.fn().mockResolvedValue(page(rows));
      return createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch })
        .listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z' });
    };
    // Champ absent partout : le libellé n'est pas exposé, la liste est inexploitable pour le rapprochement.
    let listing = await list([bare('tx-00000001'), bare('tx-00000002')]);
    expect(listing).toMatchObject({ described: 0, truncated: false });
    expect(listing.transactions.map((tx) => tx.description)).toEqual([null, null]);
    // Champ présent mais vide ou nul : l'API l'expose, la transaction n'a simplement pas de libellé.
    listing = await list([{ ...bare('tx-00000001'), description: null }, { ...bare('tx-00000002'), description: '' }, row('tx-00000003')]);
    expect(listing.described).toBe(3);
    expect(listing.transactions.map((tx) => tx.description)).toEqual([null, null, `Pack — VYS-${'A'.repeat(32)}`]);
    // Liste vide : rien à dire.
    expect(await list([])).toMatchObject({ described: 0, transactions: [] });
  });

  it('n’envoie jamais la clé secrète vers une adresse de page suivante étrangère à SasPay', async () => {
    for (const hostile of [
      'https://evil.example/api/v1/transactions/?cursor=x',
      'https://api.saspay.me.evil.example/api/v1/transactions/?cursor=x',
      'http://api.saspay.me/api/v1/transactions/?cursor=x',
      'https://api.saspay.me/api/v1/payouts/initialize/',
    ]) {
      const fetcher = vi.fn().mockResolvedValue(page([row('tx-00000001')], hostile));
      const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
      const listing = await client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(listing.transactions).toHaveLength(1);
    }
  });

  it('réapplique les filtres : ni décaissement, ni paiement non abouti, ni identifiant malformé', async () => {
    const fetcher = vi.fn().mockResolvedValue(page([
      row('tx-00000001'),
      row('tx-00000002', { status: 'PENDING' }),
      row('tx-00000003', { flow_direction: 'OUTBOUND', transaction_type: 'RETRAIT' }),
      row('../../payouts', {}),
      'pas un objet',
    ]));
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
    const listing = await client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z' });
    expect(listing.transactions.map((tx) => tx.id)).toEqual(['tx-00000001']);
  });

  it('s’arrête au nombre de pages demandé et le signale', async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      page([row('tx-00000001')], 'https://api.saspay.me/api/v1/transactions/?cursor=again'));
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
    const listing = await client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z', maxPages: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(listing.truncated).toBe(true);
  });

  it('refuse une réponse qui n’est pas une liste', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { oops: true } }), { status: 200 }));
    const client = createSasPayClient({ secretKey: TEST_KEY, fetcher: fetcher as unknown as typeof fetch });
    await expect(client.listSuccessfulPayments({ createdAfter: '2026-11-10T10:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
