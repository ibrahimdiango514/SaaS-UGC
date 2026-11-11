import { describe, expect, it } from 'vitest';
import {
  billingUnits,
  buildPricingBasis,
  buildProviderQuote,
  classifyProviderFailure,
  extractProviderCostUsd,
  extractProviderCurrency,
  isCatalogStale,
  normalizeEstimateEndpoint,
  providerErrorMessage,
  quotePricingParams,
  unavailableQuote,
  type QuoteModelMeta,
} from '../supabase/functions/_shared/video-quote.ts';

const NOW = new Date('2026-11-11T12:00:00.000Z');

function dynamicModel(overrides: Partial<QuoteModelMeta> = {}): QuoteModelMeta {
  return {
    modelId: 'wan2.2-5b-fast-t2v',
    publicId: '11111111-1111-4111-8111-111111111112',
    dynamicPricing: true,
    estimateEndpoint: '/api/v1/models/wan2.2-5b-fast-t2v/estimate-cost',
    active: true,
    enabled: true,
    comingSoon: false,
    syncedAt: '2026-11-11T10:00:00.000Z',
    catalogCostUsd: 0.016,
    catalogCurrency: 'USD',
    requiredFields: ['prompt'],
    supportedFields: ['prompt', 'duration', 'resolution', 'aspect_ratio', 'generate_audio'],
    ...overrides,
  };
}

describe('Extraction du tarif fournisseur', () => {
  it('lit les formes documentées et imbriquées de MuAPI', () => {
    expect(extractProviderCostUsd({ cost: 0.02 })).toBe(0.02);
    expect(extractProviderCostUsd({ cost_usd: '1.87' })).toBe(1.87);
    expect(extractProviderCostUsd({ data: { estimated_cost: 9.35 } })).toBe(9.35);
    expect(extractProviderCostUsd({ cost: { amount: 0.5, currency: 'USD' } })).toBe(0.5);
    expect(extractProviderCostUsd({ data: { estimate: { amount_usd: 2.4 } } })).toBe(2.4);
  });

  it('ne déduit jamais un prix d’un champ non tarifaire', () => {
    expect(extractProviderCostUsd({ message: 'ok' })).toBeNull();
    expect(extractProviderCostUsd(null)).toBeNull();
    expect(extractProviderCostUsd({ duration: 5, resolution: '1080p' })).toBeNull();
    expect(extractProviderCostUsd({ cost: 'n/a' })).toBeNull();
  });

  it('normalise la devise et retombe sur USD uniquement par défaut explicite', () => {
    expect(extractProviderCurrency({ currency: 'usd' })).toBe('USD');
    expect(extractProviderCurrency({ cost: { currency: 'eur' } })).toBe('EUR');
    expect(extractProviderCurrency({}, 'USD')).toBe('USD');
  });
});

describe('Endpoint de devis', () => {
  it('accepte uniquement un chemin MuAPI de modèle', () => {
    expect(normalizeEstimateEndpoint(undefined, 'seedance-lite-t2v'))
      .toBe('/api/v1/models/seedance-lite-t2v/estimate-cost');
    expect(normalizeEstimateEndpoint('/api/v1/models/a.b-c_1/estimate-cost', 'x'))
      .toBe('/api/v1/models/a.b-c_1/estimate-cost');
  });

  it('rejette les URL externes et les chemins détournés', () => {
    expect(normalizeEstimateEndpoint('https://evil.example/api/v1/models/x/estimate-cost', 'x')).toBeNull();
    expect(normalizeEstimateEndpoint('/api/v1/predictions/x/estimate-cost', 'x')).toBeNull();
    expect(normalizeEstimateEndpoint('/api/v1/models/../../admin/estimate-cost', 'x')).toBeNull();
  });
});

describe('Base tarifaire et unités facturées', () => {
  it('exclut le prompt, les médias et les champs internes', () => {
    const basis = buildPricingBasis({
      prompt: 'secret créatif',
      image_url: 'https://private/x.png',
      duration: 5,
      resolution: '720p',
      generate_audio: true,
      aspect_ratio: '9:16',
      __catalog: { hidden: true },
    });
    expect(basis).toEqual({
      aspect_ratio: '9:16', duration: 5, generate_audio: true, resolution: '720p',
    });
    expect(quotePricingParams({ prompt: 'x', duration: 5 }).duration).toBe(5);
  });

  it('déduit les unités facturées réellement présentes, dans un ordre stable', () => {
    expect(billingUnits({ resolution: '720p', duration: 5, quantity: 2 }))
      .toEqual(['duration', 'resolution', 'quantity']);
    expect(billingUnits({ prompt_only: 'x' })).toEqual([]);
  });
});

describe('Fraîcheur du catalogue', () => {
  it('considère absente ou ancienne une synchronisation non vérifiable', () => {
    expect(isCatalogStale(null, NOW)).toBe(true);
    expect(isCatalogStale('not-a-date', NOW)).toBe(true);
    expect(isCatalogStale('2026-11-09T10:00:00.000Z', NOW)).toBe(true);
    expect(isCatalogStale('2026-11-11T10:00:00.000Z', NOW)).toBe(false);
  });
});

describe('Construction du devis', () => {
  it('utilise le tarif dynamique exact renvoyé par le fournisseur', () => {
    const quote = buildProviderQuote({
      model: dynamicModel(),
      providerReply: { ok: true, status: 200, data: { cost: 1.87, currency: 'USD' } },
      pricingParams: { prompt: 'x', duration: 5, resolution: '720p' },
      prompt: 'x',
      now: NOW,
    });
    expect(quote).toMatchObject({
      available: true, cost_usd: 1.87, currency: 'USD', source: 'provider_estimate',
      stale_catalog: false, error_code: null, estimate_endpoint_available: true,
    });
    expect(quote.billing_units).toEqual(['duration', 'resolution']);
    expect(JSON.stringify(quote)).not.toContain('x');
  });

  it('ne remplace jamais un tarif dynamique manquant par le tarif catalogue', () => {
    const quote = buildProviderQuote({
      model: dynamicModel({ catalogCostUsd: 0.6 }),
      providerReply: { ok: true, status: 200, data: { message: 'ok' } },
      pricingParams: { duration: 5 },
      prompt: 'x',
      now: NOW,
    });
    expect(quote.available).toBe(false);
    expect(quote.cost_usd).toBeNull();
    expect(quote.error_code).toBe('PROVIDER_PRICE_MISSING');
  });

  it('refuse une devise non USD même si le montant est présent', () => {
    const quote = buildProviderQuote({
      model: dynamicModel(),
      providerReply: { ok: true, status: 200, data: { cost: 5, currency: 'EUR' } },
      prompt: 'x',
      now: NOW,
    });
    expect(quote).toMatchObject({ available: false, cost_usd: null, error_code: 'CURRENCY_UNSUPPORTED' });
  });

  it('classe les pannes fournisseur sans exposer leur message brut', () => {
    expect(classifyProviderFailure({ ok: false, status: 401 })).toBe('PROVIDER_AUTH_FAILED');
    expect(classifyProviderFailure({ ok: false, status: 429 })).toBe('PROVIDER_RATE_LIMITED');
    expect(classifyProviderFailure({ ok: false, status: 503 })).toBe('PROVIDER_UNAVAILABLE');
    expect(classifyProviderFailure({ ok: false, status: 0, timedOut: true })).toBe('PROVIDER_TIMEOUT');
    expect(classifyProviderFailure({ ok: false, status: 0 })).toBe('PROVIDER_UNAVAILABLE');
    for (const code of ['PROVIDER_AUTH_FAILED', 'PROVIDER_PRICE_MISSING'] as const) {
      expect(providerErrorMessage(code)).not.toMatch(/<[^>]+>/);
    }
  });

  it('exige un prompt quand le modèle le requiert', () => {
    const quote = buildProviderQuote({
      model: dynamicModel(),
      providerReply: null,
      prompt: '',
      requirePrompt: true,
      now: NOW,
    });
    expect(quote).toMatchObject({ available: false, error_code: 'PROMPT_REQUIRED' });
  });

  it('accepte le tarif catalogue uniquement pour un modèle à prix fixe', () => {
    const fixed = buildProviderQuote({
      model: dynamicModel({ dynamicPricing: false, catalogCostUsd: 0.1 }),
      providerReply: null,
      now: NOW,
    });
    expect(fixed).toMatchObject({
      available: true, cost_usd: 0.1, source: 'catalog_tariff', currency: 'USD',
    });
    const missing = buildProviderQuote({
      model: dynamicModel({ dynamicPricing: false, catalogCostUsd: null }),
      providerReply: null,
      now: NOW,
    });
    expect(missing).toMatchObject({ available: false, error_code: 'CATALOG_TARIFF_MISSING' });
  });

  it('signale un modèle indisponible avant toute lecture tarifaire', () => {
    const quote = buildProviderQuote({
      model: dynamicModel({ comingSoon: true }),
      providerReply: { ok: true, status: 200, data: { cost: 1 } },
      now: NOW,
    });
    expect(quote).toMatchObject({ available: false, error_code: 'MODEL_UNAVAILABLE' });
  });

  it('un devis indisponible ne contient jamais de montant', () => {
    const quote = unavailableQuote({ code: 'PROVIDER_UNAVAILABLE', now: NOW });
    expect(quote.cost_usd).toBeNull();
    expect(quote.currency).toBeNull();
    expect(quote.available).toBe(false);
  });
});
