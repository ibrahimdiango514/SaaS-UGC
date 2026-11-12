import { describe, expect, it } from 'vitest';
import {
  createPaymentsHandler, createWebhookHandler, isAllowedOrigin, readPaymentsEnv, type PaymentsEnv,
} from '../supabase/functions/_shared/saspay/http';
import { createPaymentService } from '../supabase/functions/_shared/saspay/payments';
import { createSasPayClient } from '../supabase/functions/_shared/saspay/client';
import {
  NOW, TEST_KEY, WEBHOOK_SECRET, createFakeSasPay, createFakeStore, jsonResponse, signedWebhook,
} from './helpers/saspay-fakes';

const ORIGIN = 'https://vyora-ugc.netlify.app';
const USER = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'alice@example.ml', user_metadata: { display_name: 'Alice Koné' } };
const ADMIN = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'boss@example.ml', user_metadata: {} };
const env: PaymentsEnv = {
  supabaseUrl: 'https://project.supabase.co', anonKey: 'anon-key', serviceRoleKey: 'service-role-key',
  sasPaySecretKey: TEST_KEY, webhookSecret: WEBHOOK_SECRET, extraOrigins: '',
};

function setup() {
  const fake = createFakeStore({ admins: [ADMIN.id] });
  const saspay = createFakeSasPay();
  const service = createPaymentService({
    store: fake.store, client: createSasPayClient({ secretKey: TEST_KEY, fetcher: saspay.fetcher }),
    webhookSecret: WEBHOOK_SECRET, now: () => NOW,
  });
  const authCalls: string[] = [];
  // Seul l'appel d'authentification Supabase passe par ce fetcher.
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    authCalls.push(url);
    const token = new Headers(init?.headers).get('authorization');
    if (url.endsWith('/auth/v1/user')) {
      if (token === 'Bearer jwt-alice') return jsonResponse(USER);
      if (token === 'Bearer jwt-admin') return jsonResponse(ADMIN);
      return jsonResponse({ msg: 'invalid JWT' }, 401);
    }
    throw new Error(`appel inattendu : ${url}`);
  }) as typeof fetch;
  return {
    ...fake, saspay, authCalls,
    payments: createPaymentsHandler({ env, fetcher, service }),
    webhook: createWebhookHandler({ env, fetcher, service }),
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://edge.test/vyora-payments', {
    method: 'POST',
    headers: { origin: ORIGIN, authorization: 'Bearer jwt-alice', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const createBody = {
  action: 'create', product: 'studio', item: { kind: 'pack', pack_key: 'creator' }, country: 'ML',
  flow: 'softpay', network: 'orange_ml', phone: '70123456', idempotency_key: 'idem-http-0001',
};

describe('Edge Function vyora-payments', () => {
  it('lit ses secrets côté serveur ; le secret de webhook VYORA est distinct de tout autre', () => {
    const values: Record<string, string> = {
      SUPABASE_URL: 'u', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 's',
      SASPAY_SECRET_KEY: ' sk_test_shared ', SASPAY_WEBHOOK_SECRET: 'secret-autre-produit',
    };
    const read = readPaymentsEnv((key) => values[key] ?? '');
    expect(read.sasPaySecretKey).toBe('sk_test_shared');
    // Le secret du webhook d'un autre produit n'est jamais réutilisé pour VYORA.
    expect(read.webhookSecret).toBe('');
    values.VYORA_SASPAY_SECRET_KEY = 'sk_test_vyora';
    values.VYORA_SASPAY_WEBHOOK_SECRET = 'whsec_vyora';
    const dedicated = readPaymentsEnv((key) => values[key] ?? '');
    expect(dedicated.sasPaySecretKey).toBe('sk_test_vyora');
    expect(dedicated.webhookSecret).toBe('whsec_vyora');
  });

  it('n’autorise que les origines connues', () => {
    for (const origin of [ORIGIN, 'http://localhost:5173', 'https://deploy-preview-12--vyora-ugc.netlify.app']) {
      expect(isAllowedOrigin(origin)).toBe(true);
    }
    for (const origin of [
      '', 'https://evil.example', 'https://vyora-ugc.netlify.app.evil.example', 'http://vyora-ugc.netlify.app',
      // Aucun bac à sable ni sous-domaine d'hébergeur partagé n'est admis d'office.
      'https://4180-abc123.e2b.app', 'https://autre-site.netlify.app', 'https://deploy-preview-12--autre.netlify.app',
    ]) {
      expect(isAllowedOrigin(origin)).toBe(false);
    }
    // Origine supplémentaire : exacte, déclarée par variable d'environnement.
    expect(isAllowedOrigin('https://app.vyora.ml', 'https://app.vyora.ml, https://autre.ml')).toBe(true);
    expect(isAllowedOrigin('https://4180-abc123.e2b.app', 'https://4180-abc123.e2b.app')).toBe(true);
    expect(isAllowedOrigin('https://app.vyora.ml.evil.io', 'https://app.vyora.ml')).toBe(false);
  });

  it('répond au pré-vol CORS pour une origine autorisée et le refuse sinon', async () => {
    const { payments } = setup();
    const ok = await payments(new Request('https://edge.test/x', { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const ko = await payments(new Request('https://edge.test/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(ko.status).toBe(403);
    expect(ko.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuse une origine inconnue avant toute authentification', async () => {
    const { payments, authCalls } = setup();
    const response = await payments(post(createBody, { origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(authCalls).toHaveLength(0);
  });

  it('exige une session valide', async () => {
    const { payments, orders } = setup();
    const none = await payments(post(createBody, { authorization: '' }));
    expect(none.status).toBe(401);
    expect((await none.json()).error.code).toBe('PAYMENT_UNAUTHENTICATED');
    const bad = await payments(post(createBody, { authorization: 'Bearer forged' }));
    expect(bad.status).toBe(401);
    expect(orders.size).toBe(0);
  });

  it('refuse les méthodes autres que POST, le JSON invalide et les actions inconnues', async () => {
    const { payments } = setup();
    expect((await payments(new Request('https://edge.test/x', { method: 'GET', headers: { origin: ORIGIN } }))).status).toBe(405);
    expect((await payments(post('{pas json'))).status).toBe(400);
    expect((await payments(post([1, 2]))).status).toBe(400);
    const unknown = await payments(post({ action: 'refund' }));
    expect(unknown.status).toBe(400);
    for (const action of ['payout', 'transfer', 'topup', 'confirm', 'settle', 'mark_paid']) {
      expect((await payments(post({ action, order_id: 'x' }))).status).toBe(400);
    }
  });

  it('create : l’utilisateur vient du jeton, jamais du corps de la requête', async () => {
    const { payments, orders } = setup();
    const response = await payments(post({ ...createBody, user_id: ADMIN.id, userId: ADMIN.id }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.next).toBe('await_confirmation');
    expect(payload.order).toMatchObject({ amount: '5000.00', state: 'pending' });
    expect(payload.order.user_id).toBeUndefined();
    expect([...orders.values()][0].user_id).toBe(USER.id);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('create (checkout) : l’adresse de retour est construite à partir de l’origine autorisée', async () => {
    const { payments, saspay } = setup();
    const response = await payments(post({ ...createBody, flow: 'checkout', idempotency_key: 'idem-http-0002', return_url: 'https://evil.example/steal' }));
    expect(response.status).toBe(200);
    const call = saspay.calls.find((c) => c.path === '/checkout-sessions/');
    expect(String(call?.body?.return_url)).toMatch(new RegExp(`^${ORIGIN}/app/paiement/retour\\?produit=studio&commande=`));
  });

  it('options, status et erreurs suivent le format { error: { code, message } }', async () => {
    const { payments } = setup();
    const options = await payments(post({ action: 'options', product: 'studio', item: { kind: 'pack', pack_key: 'creator' } }));
    expect((await options.json()).price.amount).toBe('5000.00');
    const created = await (await payments(post(createBody))).json();
    const status = await payments(post({ action: 'status', product: 'studio', order_id: created.order.id }));
    expect((await status.json()).order.state).toBe('pending');
    const missing = await payments(post({ action: 'status', product: 'studio', order_id: '99999999-9999-4999-8999-999999999999' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'PAYMENT_NOT_FOUND', message: 'Commande introuvable.' } });
    const invalid = await payments(post({ ...createBody, phone: '123', idempotency_key: 'idem-http-0003' }));
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe('PAYMENT_INVALID_PHONE');
  });

  it('balances : interdit à un client, lisible par un administrateur', async () => {
    const { payments } = setup();
    expect((await payments(post({ action: 'balances' }))).status).toBe(403);
    const response = await payments(post({ action: 'balances' }, { authorization: 'Bearer jwt-admin' }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.balances).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain('sk_');
  });

  it('aucune réponse ne contient de secret', async () => {
    const { payments } = setup();
    const bodies = await Promise.all([
      payments(post(createBody)), payments(post({ action: 'options', product: 'studio' })),
      payments(post({ action: 'nope' })), payments(post(createBody, { authorization: 'Bearer x' })),
    ].map(async (r) => (await r).text()));
    for (const text of bodies) {
      expect(text).not.toContain(TEST_KEY);
      expect(text).not.toContain(WEBHOOK_SECRET);
      expect(text).not.toContain('service-role-key');
    }
  });
});

describe('Edge Function vyora-saspay-webhook', () => {
  async function request(body: unknown, options: { tamper?: boolean; headers?: Record<string, string> } = {}) {
    const signed = await signedWebhook(body);
    return new Request('https://edge.test/vyora-saspay-webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-webhook-signature': signed.signature,
        'x-webhook-timestamp': signed.timestamp, 'x-webhook-event': 'transaction.success', ...options.headers,
      },
      body: options.tamper ? signed.raw.replace('"SUCCESS"', '"SUCCESS" ') : signed.raw,
    });
  }

  it('vérifie la signature sur le corps brut, sans session', async () => {
    const ctx = setup();
    const created = await (await ctx.payments(post(createBody))).json();
    const txId = [...ctx.orders.values()][0].provider_payment_id as string;
    ctx.saspay.setTransaction(txId, { status: 'SUCCESS' });

    const response = await ctx.webhook(await request({ event: 'transaction.success', data: { id: txId, status: 'SUCCESS' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, outcome: 'paid', credited: true });
    expect(ctx.credits.studio.get(USER.id)).toBe(27);
    expect(ctx.authCalls.filter((u) => u.endsWith('/auth/v1/user'))).toHaveLength(1); // uniquement l'appel « create »
    expect(created.order.id).toBeTruthy();
  });

  it('un seul octet modifié dans le corps invalide la signature', async () => {
    const ctx = setup();
    const response = await ctx.webhook(await request({ event: 'transaction.success', data: { id: 'tx-00000001', status: 'SUCCESS' } }, { tamper: true }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
  });

  it('refuse l’absence d’en-têtes, les autres méthodes et les corps trop volumineux', async () => {
    const ctx = setup();
    const unsigned = await ctx.webhook(new Request('https://edge.test/w', { method: 'POST', body: '{"event":"transaction.success"}' }));
    expect(unsigned.status).toBe(401);
    expect((await ctx.webhook(new Request('https://edge.test/w', { method: 'GET' }))).status).toBe(405);
    const huge = await ctx.webhook(new Request('https://edge.test/w', { method: 'POST', body: 'x'.repeat(70_000) }));
    expect(huge.status).toBe(413);
    expect(ctx.credits.studio.size).toBe(0);
  });

  it('n’émet aucun en-tête CORS (appel serveur à serveur)', async () => {
    const ctx = setup();
    const response = await ctx.webhook(await request({ event: 'webhook.test', data: {} }, { headers: { origin: ORIGIN } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
