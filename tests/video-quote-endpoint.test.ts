import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuote, billingUnits, pricingBasis, providerParams } from '../supabase/functions/video-quote/index';

function row(overrides: Record<string, unknown> = {}) {
  return {
    model_id: 'kling-4.0-text-to-video',
    public_id: 'f24bd427-9445-42dc-af9a-3723bf79fffd',
    category: 'Text to Video',
    cost_usd: 0.785,
    cost_currency: 'USD',
    active: true,
    is_enabled: true,
    is_coming_soon: false,
    synced_at: new Date().toISOString(),
    input_fields: ['prompt', 'duration', 'resolution'],
    required_fields: ['prompt'],
    param_schema: {
      duration: { type: 'number', min: 1, max: 10, default: 5 },
      resolution: { type: 'select', options: ['480p', '720p'], default: '720p' },
      prompt: { type: 'string' },
      __catalog: { dynamic_pricing: false, estimate_endpoint: '/api/v1/models/kling-4.0-text-to-video/estimate-cost' },
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.MUAPI_API_KEY = 'test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MUAPI_API_KEY;
});

describe('Service de devis VYORA (production endpoint)', () => {
  it('retourne le tarif catalogue réel en USD pour un modèle à prix fixe', async () => {
    const result = await buildQuote(row(), 'kling-4.0-text-to-video', { params: { duration: 5, resolution: '720p' }, prompt: 'Un test' });
    expect(result.model_available).toBe(true);
    expect(result.model_status).toBe('active');
    expect(result.quote.available).toBe(true);
    expect(result.quote.source).toBe('catalog_tariff');
    expect(result.quote.cost_usd).toBe(0.785);
    expect(result.quote.currency).toBe('USD');
    expect(result.quote.billing_units).toEqual(['duration', 'resolution']);
    expect(result.quote.pricing_basis).toEqual({ duration: 5, resolution: '720p' });
  });

  it('refuse un tarif catalogue non USD ou absent', async () => {
    const eur = await buildQuote(row({ cost_currency: 'EUR' }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(eur.quote.available).toBe(false);
    expect(eur.quote.error_code).toBe('CURRENCY_UNSUPPORTED');
    const missing = await buildQuote(row({ cost_usd: null, cost_currency: 'USD' }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(missing.quote.error_code).toBe('CATALOG_TARIFF_MISSING');
    const zero = await buildQuote(row({ cost_usd: 0 }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(zero.quote.error_code).toBe('PRICE_NOT_POSITIVE');
  });

  it('marque le catalogue comme périmé après 36 h sans synchronisation', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const result = await buildQuote(row({ synced_at: old }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(result.quote.stale_catalog).toBe(true);
  });

  it('refuse un modèle désactivé ou nécessitant une entrée non prise en charge', async () => {
    const disabled = await buildQuote(row({ active: false }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(disabled.quote.error_code).toBe('MODEL_UNAVAILABLE');
    expect(disabled.quote.available).toBe(false);
    const unsupported = await buildQuote(row({ required_fields: ['prompt', 'audio_url'] }), 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(unsupported.quote.available).toBe(false);
    expect(unsupported.model_reason).toMatch(/audio_url/);
  });

  it('interroge le tarif réel du fournisseur pour un modèle dynamique sans lancer de génération', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cost: { amount: 1.2345678, currency: 'USD' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const dynamicRow = row({ param_schema: { ...row().param_schema, __catalog: { dynamic_pricing: true } } });
    const result = await buildQuote(dynamicRow, 'kling-4.0-text-to-video', { prompt: 'Une scène', params: { duration: 5 } });
    expect(result.quote.available).toBe(true);
    expect(result.quote.source).toBe('provider_estimate');
    expect(result.quote.cost_usd).toBe(1.234568);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.muapi.ai/api/v1/models/kling-4.0-text-to-video/estimate-cost');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: 'Une scène', duration: 5 });
  });

  it('traduit les erreurs fournisseur en devis indisponible honnête', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const dynamicRow = row({ param_schema: { ...row().param_schema, __catalog: { dynamic_pricing: true } } });
    const limited = await buildQuote(dynamicRow, 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(limited.quote.available).toBe(false);
    expect(limited.quote.error_code).toBe('PROVIDER_RATE_LIMITED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ cost: 2, currency: 'EUR' }), { status: 200 })));
    const eur = await buildQuote(dynamicRow, 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(eur.quote.error_code).toBe('CURRENCY_UNSUPPORTED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'no price' }), { status: 200 })));
    const missing = await buildQuote(dynamicRow, 'kling-4.0-text-to-video', { prompt: 'x' });
    expect(missing.quote.error_code).toBe('PROVIDER_PRICE_MISSING');
  });

  it('exige un prompt quand le modèle le requiert', async () => {
    const dynamicRow = row({ param_schema: { ...row().param_schema, __catalog: { dynamic_pricing: true } } });
    const result = await buildQuote(dynamicRow, 'kling-4.0-text-to-video', { params: { duration: 5 } });
    expect(result.quote.error_code).toBe('PROMPT_REQUIRED');
  });

  it('renvoie MODEL_NOT_FOUND sans inventer de modèle', async () => {
    const result = await buildQuote(null, 'inconnu', {});
    expect(result.quote.available).toBe(false);
    expect(result.quote.error_code).toBe('MODEL_NOT_FOUND');
    expect(result.quote.cost_usd).toBeNull();
  });

  it('applique les defaults et bornes du schéma sans accepter de valeurs arbitraires', () => {
    const params = providerParams(row(), { params: { duration: '99', resolution: '4k' }, prompt: 'test' });
    expect(params.duration).toBe(10);
    expect(params.resolution).toBeUndefined();
    expect(params.prompt).toBe('test');
  });

  it('ne divulgue jamais le prompt ni les médias dans la base de tarification', () => {
    const basis = pricingBasis({
      prompt: 'secret métier', image_url: 'https://x/y.png', duration: 5, resolution: '720p', generate_audio: true,
    });
    expect(basis).toEqual({ duration: 5, resolution: '720p', generate_audio: true });
    expect(billingUnits(basis)).toEqual(['duration', 'resolution', 'audio']);
  });
});
