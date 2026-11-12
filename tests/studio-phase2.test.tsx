// @vitest-environment jsdom
/**
 * PHASE 2 — tests SIMULÉS, sans appel MuAPI, sans Supabase, sans génération,
 * sans réservation ni débit réel. Les fixtures reproduisent les agrégats du
 * catalogue vérifié (415 références, 236 actifs Reelora) et les 3 devis live
 * déjà consignés dans docs/validation-authentifiee-muapi.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MuApiModel, VideoCostEstimate, VideoCatalogDiagnostics } from '../src/lib/types';
import {
  modelRatios, modelResolutions, reeloraModelStatus,
} from '../src/studio/model';
import {
  DEFAULT_CATALOG_FILTERS, canConfirmGeneration,
  creditSummary, filterModels, modelCapabilities,
} from '../src/studio/catalog';
import {
  QUALITY_TIERS, buildCompatibleParams, catalogByCost, clampToModelDuration,
  defaultSettingsFor, numericRange, qualityTierSummary, selectOptions,
} from '../src/studio/quality';
import { CatalogBrowser } from '../src/studio/components/CatalogBrowser';
import { CostConfirm } from '../src/studio/components/CostConfirm';
import { DynamicParams } from '../src/studio/components/DynamicParams';
import { initialFormState, PromptBar } from '../src/studio/components/PromptBar';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function model(overrides: Partial<MuApiModel> = {}): MuApiModel {
  return {
    model_id: 'phase2-t2v', display_name: 'Modèle T2V de test', description: 'Fixture Phase 2',
    category: 'Text to Video', endpoint: '/api/v1/phase2-t2v',
    input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed'],
    required_fields: ['prompt'],
    param_schema: {
      aspect_ratio: { type: 'select', options: ['9:16', '16:9'], default: '9:16' },
      resolution: { type: 'select', options: ['480p', '720p'], default: '480p' },
      duration: { type: 'number', min: 4, max: 16, default: 5 },
      camera_fixed: { type: 'boolean', default: false },
    },
    cost_usd: 0.6, cost_currency: 'USD', is_enabled: true, is_coming_soon: false,
    dynamic_pricing: true, account_access: 'account',
    ...overrides,
  };
}

function estimate(overrides: Partial<VideoCostEstimate> = {}): VideoCostEstimate {
  return {
    service_key: 'ugc_clip_15s', credits_cost: 16, service_active: true,
    model_id: 'phase2-t2v', model_available: true, model_status: 'active',
    model_reason: null, pricing_available: true, quote_id: 'quote-123',
    quote_expires_at: new Date(Date.now() + 600_000).toISOString(),
    ...overrides,
  };
}

function promptBarHealthProps(
  health: Record<string, boolean> | null,
  healthBusy = false,
  healthError = '',
) {
  const noop = vi.fn();
  return {
    state: { ...initialFormState(), prompt: 'Une publicité UGC de quinze secondes pour un sérum naturel.' },
    onPatch: noop, model: model(), services: [], estimate: estimate({
      pricing_available: false, quote_id: null, model_available: false,
    }),
    balance: 36, blockedReason: 'Devis fournisseur à confirmer', busy: false,
    onGenerate: noop, health, avatars: [], onAiPlan: noop,
    aiBusy: false, aiMessage: '', healthBusy, healthError,
    onRetryHealth: vi.fn(), catalogOpen: false, onOpenCatalog: noop, catalogSummary: '',
  };
}

/** Aggregate fixture derived from the read-only DB audit (no invented models). */
function catalogFixture(): MuApiModel[] {
  const activeGroups = [
    { category: 'Image to Video', count: 118, fields: ['prompt', 'image_url', 'aspect_ratio', 'resolution', 'duration'] },
    { category: 'Text to Video', count: 109, fields: ['prompt', 'aspect_ratio', 'resolution', 'duration'] },
    { category: 'Video to Video', count: 4, fields: ['prompt', 'video_url', 'aspect_ratio'] },
    { category: 'Lora Support', count: 3, fields: ['prompt', 'lora_id', 'duration'] },
    { category: 'Training', count: 2, fields: ['prompt', 'training_name', 'resolution'] },
  ];
  const inactiveGroups = [
    { category: 'Image to Image', count: 90, group: null },
    { category: 'AI Effects', count: 50, group: 'ai-effects' },
    { category: 'Video Tools', count: 36, group: 'video-tools' },
  ];
  const out: MuApiModel[] = [];
  let n = 0;
  for (const group of activeGroups) {
    for (let i = 0; i < group.count; i += 1) {
      n += 1;
      const requiresImage = group.category === 'Image to Video';
      out.push(model({
        model_id: `active-${n}`, display_name: `Actif ${n}`, category: group.category,
        family: group.category === 'Text to Video' ? 'Seedance' : 'Wan',
        input_fields: group.fields,
        required_fields: requiresImage ? ['prompt', 'image_url'] : ['prompt'],
        cost_usd: Number((0.016 + (n % 100) * 0.09).toFixed(3)),
        param_schema: {
          ...(group.fields.includes('aspect_ratio') ? { aspect_ratio: { type: 'string' as const } } : {}),
          ...(group.fields.includes('resolution') ? { resolution: { type: 'string' as const } } : {}),
          ...(group.fields.includes('duration') ? { duration: { type: 'string' as const } } : {}),
        },
      }));
    }
  }
  for (const group of inactiveGroups) {
    for (let i = 0; i < group.count; i += 1) {
      n += 1;
      out.push(model({
        model_id: `unsupported-${n}`, display_name: `Non connecté ${n}`, category: group.category,
        group_of: group.group, input_fields: ['prompt', 'video_url', 'audio_url'],
        required_fields: ['prompt', 'video_url'], dynamic_pricing: true,
        cost_usd: Number((0.06 + (n % 50) * 0.04).toFixed(3)),
        param_schema: {},
      }));
    }
  }
  for (let i = 0; i < 3; i += 1) {
    out.push(model({
      model_id: `soon-${i + 1}`, display_name: `Bientôt ${i + 1}`,
      category: 'Text to Video', is_coming_soon: true, dynamic_pricing: false,
      cost_usd: 0.15, param_schema: {},
    }));
  }
  return out;
}

/** In-memory mirror of the backend wallet invariant; no RPC/DB is touched. */
class SimulatedCreditWallet {
  available: number;
  reserved = 0;
  captured = 0;
  refunded = 0;
  private jobs = new Map<string, { amount: number; state: 'reserved' | 'captured' | 'released' }>();

  constructor(initial: number) { this.available = initial; }

  reserve(key: string, amount: number): boolean {
    if (this.jobs.has(key) || amount <= 0 || this.available < amount) return false;
    this.available -= amount;
    this.reserved += amount;
    this.jobs.set(key, { amount, state: 'reserved' });
    return true;
  }

  capture(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job || job.state !== 'reserved') return false;
    this.reserved -= job.amount;
    this.captured += job.amount;
    job.state = 'captured';
    return true;
  }

  release(key: string): boolean {
    const job = this.jobs.get(key);
    if (!job || job.state !== 'reserved') return false;
    this.reserved -= job.amount;
    this.available += job.amount;
    this.refunded += job.amount;
    job.state = 'released';
    return true;
  }
}

describe('Phase 2 · devis opaques et crédits VYORA', () => {
  it('bloque un devis absent, indisponible ou expiré', () => {
    const cases: Array<Partial<VideoCostEstimate>> = [
      { pricing_available: false, quote_id: null },
      { pricing_available: true, quote_id: null },
      { pricing_available: true, quote_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    for (const e of cases) {
      const q = estimate(e);
      expect(creditSummary(q, 40).quoteToConfirm).toBe(true);
      expect(creditSummary(q, 40).canReserve).toBe(false);
      expect(canConfirmGeneration({ estimate: q, balance: 40, accepted: true })).toBe(false);
    }
    expect(creditSummary(null, 40).quoteToConfirm).toBe(true);
  });

  it('autorise uniquement un devis serveur frais, avec confirmation explicite', () => {
    const quote = estimate({ credits_cost: 18 });
    expect(creditSummary(quote, 36).canReserve).toBe(true);
    expect(canConfirmGeneration({ estimate: quote, balance: 36, accepted: false })).toBe(false);
    expect(canConfirmGeneration({ estimate: quote, balance: 36, accepted: true })).toBe(true);
    expect(creditSummary(quote, 10).canReserve).toBe(false);
    expect(creditSummary(quote, 10).remaining).toBe(0);
  });

  it('ne transmet aucun coût fournisseur dans les surfaces client', () => {
    for (const file of [
      'src/studio/GenerationStudio.tsx', 'src/studio/components/PromptBar.tsx',
      'src/studio/components/CostConfirm.tsx', 'src/studio/components/CatalogBrowser.tsx',
      'src/studio/catalog.ts', 'src/studio/model.ts',
    ]) {
      const source = read(file);
      expect(source).not.toContain('?? 0).toFixed(3)');
      expect(source).not.toContain('provider_cost_usd');
      expect(source).not.toMatch(/cost_usd\s*\|\|\s*0/);
    }
    expect(read('supabase/config.toml')).toContain('verify_jwt = true');
    // Les deux parcours historiques demandent aussi un devis exact et bloquent
    // toute génération si le serveur n'a pas confirmé le prix.
    for (const file of ['src/pages/Studio.tsx', 'src/studio/VideoStudio.tsx']) {
      const legacy = read(file);
      expect(legacy).toContain('creditSummary');
      expect(legacy).toContain('estimateVideo(serviceKey, modelId, {');
      expect(legacy).toContain('summary.canReserve');
    }
  });
});

describe('Phase 2 · erreurs fournisseur et états d’interface', () => {
  it('expose un état générique sans publier le détail de tarification', () => {
    const failed = estimate({
      pricing_available: false, quote_id: null, pricing_error: 'Le tarif exact de cette génération n’est pas disponible.',
      model_available: false, model_status: 'unverified', model_reason: 'Indisponible momentanément.',
    });
    const s = creditSummary(failed, 100, true);
    expect(s.quoteToConfirm).toBe(true);
    expect(s).not.toHaveProperty('usdLabel');
    expect(s.exactQuote).toBe(false);
    expect(s.canReserve).toBe(false);
    expect(failed.model_available).toBe(false);
  });

  it('classe les 415 références : 236 actifs, 176 non connectés, 3 à venir', () => {
    const models = catalogFixture();
    expect(models).toHaveLength(415);
    const active = filterModels(models, { ...DEFAULT_CATALOG_FILTERS, status: 'active' });
    const unavailable = filterModels(models, { ...DEFAULT_CATALOG_FILTERS, status: 'unavailable' });
    expect(active.total).toBe(236);
    expect(unavailable.total).toBe(179);
    expect(models.filter((m) => m.is_coming_soon)).toHaveLength(3);
    expect(models.filter((m) => m.dynamic_pricing)).toHaveLength(412);
    expect(models.filter((m) => reeloraModelStatus(m).status === 'unsupported')).toHaveLength(176);
    const byCategory = active.items.reduce<Record<string, number>>((acc, m) => {
      acc[m.category] = (acc[m.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCategory).toEqual({
      'Image to Video': 118, 'Text to Video': 109, 'Video to Video': 4,
      'Lora Support': 3, Training: 2,
    });
    expect(filterModels(models, { ...DEFAULT_CATALOG_FILTERS, pricing: 'dynamic' }).total).toBe(412);
    expect(filterModels(models, { ...DEFAULT_CATALOG_FILTERS, capability: 'resolution' }).total).toBeGreaterThan(200);
    expect(filterModels(models, { ...DEFAULT_CATALOG_FILTERS, capability: 'duration' }).total).toBeGreaterThan(200);
    expect(filterModels(models, { ...DEFAULT_CATALOG_FILTERS, query: 'active 109' }).total).toBe(1);
    expect(filterModels(models, { ...DEFAULT_CATALOG_FILTERS, query: 'aucun-modele-inexistant' }).total).toBe(0);
    const costsUnknownLast = filterModels([
      model({ model_id: 'unknown', cost_usd: null }),
      model({ model_id: 'cheap', cost_usd: 0.016 }),
      model({ model_id: 'premium', cost_usd: 9.35 }),
    ], { ...DEFAULT_CATALOG_FILTERS, sort: 'cost-asc' }).items.map((m) => m.model_id);
    expect(costsUnknownLast).toEqual(['cheap', 'premium', 'unknown']);
  });

  it('affiche chargement, catalogue vide, erreur fournisseur et aucun résultat', () => {
    const diagnostics: VideoCatalogDiagnostics = {
      fetched_at: '2026-11-09T00:00:00Z',
      detected_video: 415, active: 0, unavailable: 0, verified: false,
    };
    const base = {
      models: [], catalog: diagnostics, selectedId: null, onSelect: vi.fn(), onClose: vi.fn(),
      detailLoading: false, model: null, params: {}, onParamsChange: vi.fn(), onClearSelection: vi.fn(),
      estimate: null, balance: 0, referenceFile: null, lastReferenceFile: null,
      onReferenceChange: vi.fn(), onLastReferenceChange: vi.fn(),
    };
    const { unmount } = render(<CatalogBrowser {...base} loading catalogError="MuAPI HTTP 503" providerUnavailable />);
    expect(screen.getByTestId('catalog-loading')).toBeTruthy();
    expect(screen.getByTestId('catalog-provider-error').textContent).toContain('service sera disponible');
    expect(screen.getByTestId('catalog-provider-error').textContent).not.toContain('503');
    unmount(); cleanup();

    render(<CatalogBrowser {...base} catalogError="MuAPI HTTP 503" providerUnavailable />);
    expect(screen.getByTestId('catalog-empty').textContent).toContain('Aucun modèle disponible');
    unmount(); cleanup();

    const models = catalogFixture();
    render(<CatalogBrowser {...base} models={models} />);
    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'inexistant-xyz' } });
    expect(screen.getByTestId('catalog-no-results').textContent).toContain('Aucun modèle ne correspond aux filtres');
    expect(screen.getByTestId('catalog-results-count').textContent).toContain('0 résultat');
  });
});

describe('Phase 2 · paramètres incompatibles et capacités déclarées', () => {
  it('n’envoie jamais une valeur devinée pour un schéma synchronisé sans options', () => {
    const placeholder = model({
      input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed', 'elements'],
      param_schema: {
        aspect_ratio: { type: 'string' }, resolution: { type: 'string' },
        duration: { type: 'string' }, camera_fixed: { type: 'boolean', default: false },
        elements: { type: 'array' },
      },
    });
    const caps = modelCapabilities(placeholder);
    expect(caps.tags).toContain('Format déclaré');
    expect(caps.tags).toContain('Résolution déclarée');
    expect(caps.tags).toContain('Durée déclarée');
    expect(caps.tags.join(' ')).not.toContain('9:16');
    expect(caps.tags.join(' ')).not.toContain('720p');
    expect(selectOptions(placeholder, 'aspect_ratio')).toEqual([]);
    expect(numericRange(placeholder, 'duration')).toBeNull();
    expect(clampToModelDuration(placeholder, 12)).toBeNull();
    expect(modelRatios(placeholder)).toEqual([]);
    expect(modelResolutions(placeholder)).toEqual([]);
    const built = buildCompatibleParams(placeholder, {
      ratio: '9:16', resolution: '720p', duration: 12,
      extras: { camera_fixed: true, unknown: 'x', aspect_ratio: '4:3' },
    });
    expect(built).toEqual({ camera_fixed: true });
    expect(built).not.toHaveProperty('aspect_ratio');
    expect(built).not.toHaveProperty('resolution');
    expect(built).not.toHaveProperty('duration');
    expect(built).not.toHaveProperty('unknown');
  });

  it('respecte les options déclarées sur string/number et les bornes réelles', () => {
    const declared = model({
      input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'quality'],
      param_schema: {
        aspect_ratio: { type: 'string', options: ['9:16', '1:1'], default: '9:16' },
        resolution: { type: 'string', options: ['480p', '720p'] },
        duration: { type: 'number', options: [5, 10], default: 5 },
        quality: { type: 'number', min: 1, max: 4, default: 2 },
      },
    });
    expect(selectOptions(declared, 'aspect_ratio')).toEqual(['9:16', '1:1']);
    expect(clampToModelDuration(declared, 8)).toBe(10);
    expect(defaultSettingsFor(declared).ratio).toBe('9:16');
    const built = buildCompatibleParams(declared, {
      ratio: '4:3', resolution: '720p', duration: 8,
      extras: { quality: 99, ghost: 'never' },
    });
    expect(built.aspect_ratio).toBe('9:16'); // vrai default déclaré, pas une valeur inventée
    expect(built.resolution).toBe('720p');
    expect(built.duration).toBe(10);
    expect(built.quality).toBe(4); // borné au max réel
    expect(built).not.toHaveProperty('ghost');
  });

  it('affiche les champs structurés comme incompatibles, sans contrôle inventé', () => {
    const structured = model({
      param_schema: {
        aspect_ratio: { type: 'string' },
        tuning: { type: 'array' },
        style_config: { type: 'object' },
      },
      input_fields: ['prompt', 'aspect_ratio', 'tuning', 'style_config'],
    });
    render(<DynamicParams model={structured} values={{}} onChange={vi.fn()} />);
    expect(screen.getByTestId('dynamic-params-incompatible').textContent).toContain('tuning, style_config');
    expect(screen.getByTestId('dynamic-params-declared-field').textContent).toContain('aucune valeur n’est supposée');
  });

  it('ne sélectionne pas un modèle dont une entrée obligatoire n’est pas connectée', () => {
    const unsupported = model({ required_fields: ['prompt', 'audio_url'] });
    expect(reeloraModelStatus(unsupported).status).toBe('unsupported');
    expect(filterModels([unsupported], { ...DEFAULT_CATALOG_FILTERS, status: 'active' }).total).toBe(0);
    expect(catalogByCost([unsupported], 'text-to-video')).toHaveLength(0);
    expect(catalogByCost([model({ cost_usd: null })], 'text-to-video')).toHaveLength(1);
  });
});

describe('Phase 2 · calculs de crédits, réservation, capture et remboursement simulés', () => {
  it('affiche les 3 niveaux réels sans convertir les devis USD en crédits', () => {
    const services = [
      { service_key: 'ugc_clip_8s', display_name: 'Clip 8 s', credits_cost: 9, active: true },
      { service_key: 'ugc_clip_15s', display_name: 'Clip 15 s', credits_cost: 16, active: true },
      { service_key: 'ugc_ad_4clips', display_name: 'Pub 4 clips', credits_cost: 36, active: true },
    ] as Parameters<typeof qualityTierSummary>[1];
    const models = [
      model({ model_id: 'wan2.2-5b-fast-t2v', cost_usd: 0.016 }),
      model({ model_id: 'seedance-2.5-spicy-text-to-video', cost_usd: 0.6 }),
      model({ model_id: 'seedance-2.5-spicy-text-to-video-4k', cost_usd: 9.35 }),
    ];
    const tiers = qualityTierSummary(models, services, 'text-to-video');
    expect(tiers.map((t) => t.tier)).toEqual(['rapide', 'standard', 'premium']);
    expect(tiers.map((t) => t.serviceKey)).toEqual(QUALITY_TIERS.map((q) => q.serviceKey));
    expect(tiers.map((t) => t.creditsCost)).toEqual([null, null, null]);
    expect(tiers.map((t) => t.modelId)).toEqual(models.map((m) => m.model_id));
    expect(tiers.every((t) => t.available)).toBe(true);
    for (const [i] of [0.02, 1.87, 9.35].entries()) {
      const q = estimate({ service_key: tiers[i].serviceKey, credits_cost: [9, 16, 36][i], quote_id: `quote-${i}` });
      const s = creditSummary(q, 36, true);
      expect(s.creditsCost).toBe([9, 16, 36][i]);
      expect(s).not.toHaveProperty('usdLabel');
      expect(s.remaining).toBe(36 - [9, 16, 36][i]);
      expect(s.exactQuote).toBe(true);
      expect(s.enough).toBe(true);
    }
  });

  it('applique réservation unique, capture sur succès seulement et remboursement unique', () => {
    const success = new SimulatedCreditWallet(36);
    expect(success.reserve('job-A', 16)).toBe(true);
    expect(success.available).toBe(20);
    expect(success.reserved).toBe(16);
    expect(success.reserve('job-A', 16)).toBe(false); // idempotence : pas de seconde réservation
    expect(success.available).toBe(20);
    expect(success.capture('job-A')).toBe(true);
    expect(success.capture('job-A')).toBe(false); // pas de double débit
    expect(success.release('job-A')).toBe(false); // pas de remboursement après succès
    expect({ available: success.available, reserved: success.reserved, captured: success.captured, refunded: success.refunded })
      .toEqual({ available: 20, reserved: 0, captured: 16, refunded: 0 });

    for (const reason of ['failed', 'cancelled', 'expired']) {
      const wallet = new SimulatedCreditWallet(36);
      expect(wallet.reserve(`job-${reason}`, 16)).toBe(true);
      expect(wallet.release(`job-${reason}`)).toBe(true);
      expect(wallet.release(`job-${reason}`)).toBe(false); // pas de double remboursement
      expect(wallet.capture(`job-${reason}`)).toBe(false); // pas de capture après échec
      expect({ available: wallet.available, reserved: wallet.reserved, captured: wallet.captured, refunded: wallet.refunded })
        .toEqual({ available: 36, reserved: 0, captured: 0, refunded: 16 });
    }
    const overdraft = new SimulatedCreditWallet(9);
    expect(overdraft.reserve('job-overdraft', 36)).toBe(false);
    expect(overdraft.available).toBe(9);
  });

  it('garde les garde-fous SQL existants et la confirmation explicite', () => {
    const start = read('supabase/migrations/20261108223923_reelora_muapi_v1.sql');
    const finalize = read('supabase/migrations/20261108164309_reelora_v1_rpc.sql');
    const security = read('supabase/migrations/20261108170950_reelora_v1_secure_refund.sql');
    expect(start).toContain('on conflict (created_by, request_key) do nothing');
    expect(start).toContain('reserve-job:');
    expect(finalize).toContain("p_status = 'succeeded'");
    expect(finalize).toContain("'capture-job:'");
    expect(finalize).toContain("'release-job:'");
    expect(security).toContain('revoke all on function public.reelora_finalize_generation');
    expect(security).toContain('grant execute on function public.reelora_finalize_generation(uuid, text, text, text, bigint, jsonb, text) to service_role');
    const studio = read('src/studio/GenerationStudio.tsx');
    expect(studio).toContain('newGenerationIdempotencyKey()');
    expect(studio).toContain('if (blockedReason || !model || !service || !projectId || !estimate || !summary.canReserve');
    expect(read('src/studio/components/CostConfirm.tsx')).toContain('canConfirmGeneration');
  });

  it('bloque le bouton de génération tant que le devis exact est absent', () => {
    const dynamic = model();
    const noop = vi.fn();
    const props = {
      state: { ...initialFormState(), prompt: 'Une publicité UGC de quinze secondes pour un sérum naturel.' },
      onPatch: noop, model: dynamic, services: [], estimate: estimate({ pricing_available: false, quote_id: null, model_available: false }),
      balance: 36, blockedReason: 'Devis fournisseur à confirmer', busy: false,
      onGenerate: noop, health: null, avatars: [], onAiPlan: noop,
      aiBusy: false, aiMessage: '', healthBusy: false, healthError: 'Connexion impossible.',
      onRetryHealth: vi.fn(), catalogOpen: false, onOpenCatalog: noop, catalogSummary: '',
    };
    render(<MemoryRouter><PromptBar {...props} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    expect(screen.getByRole('alert').textContent).toContain('Aide IA indisponible.');
    const retryHealth = props.onRetryHealth;
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(retryHealth).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('studio-credit-summary').textContent).toContain('coût en crédits à confirmer');
    expect(screen.getByTestId('studio-quote-warning').textContent).toContain('génération bloquée');
    expect(screen.getByTestId('studio-credit-summary').textContent).not.toMatch(/USD|MuAPI|Groq/i);
    cleanup();

    render(<MemoryRouter><PromptBar {...props} estimate={estimate()} blockedReason="" /></MemoryRouter>);
    expect((screen.getByTestId('generate-button') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('studio-credit-summary').textContent).toContain('16 crédits VYORA');
    expect(screen.getByTestId('studio-credit-summary').textContent).not.toMatch(/USD|MuAPI|Groq/i);
  });

  it('présente une instruction manquante comme un état normal, pas comme un calcul bloqué', () => {
    // Champ vide + modèle exigeant un prompt : le backend répond PROMPT_REQUIRED.
    // L'interface ne doit pas laisser croire que le backend calcule sans fin.
    const props = {
      ...promptBarHealthProps({ groq: true }),
      state: { ...initialFormState(), prompt: '' },
      // Devis non calculable : aucune instruction à chiffrer.
      estimate: null,
    };
    render(<MemoryRouter><PromptBar {...props} /></MemoryRouter>);
    const summary = screen.getByTestId('studio-credit-summary').textContent ?? '';
    expect(summary).toContain('En attente d’instruction');
    expect(summary).not.toContain('Coût en cours');
    cleanup();
  });

  it('annonce la vérification Groq en cours sans afficher une relance prématurée', () => {
    render(<MemoryRouter><PromptBar {...promptBarHealthProps(null, true)} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    expect(screen.getByRole('status').textContent).toContain('Vérification de la disponibilité de l’aide IA');
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('désactive le plan si Groq est absent et l’active si Groq est configuré', () => {
    const absent = promptBarHealthProps({ groq: false });
    render(<MemoryRouter><PromptBar {...absent} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    expect(screen.getByText(/Assistance IA indisponible pour le moment/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Proposer un plan avec l’IA' }).hasAttribute('disabled')).toBe(true);

    cleanup();
    const available = promptBarHealthProps({ groq: true });
    render(<MemoryRouter><PromptBar {...available} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Réglages/ }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Proposer un plan avec l’IA' }).hasAttribute('disabled')).toBe(false);
  });

  it('n’autorise la modale qu’après checkbox et devis confirmé', () => {
    const onConfirm = vi.fn();
    const props = {
      open: true, onClose: vi.fn(), onConfirm, model: model(), estimate: estimate(),
      balance: 36, params: { aspect_ratio: '9:16' }, loading: false, blockedReason: '',
    };
    render(<CostConfirm {...props} estimate={estimate({ pricing_available: false, quote_id: null })} />);
    const blocked = screen.getByRole('button', { name: /Je confirme/ }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(blocked.disabled).toBe(true);
    expect(screen.getByTestId('quote-to-confirm').textContent).toContain('coût en crédits');
    expect(screen.getByTestId('quote-to-confirm').textContent).not.toContain('0.000 USD');
    expect(onConfirm).not.toHaveBeenCalled();
    cleanup();

    render(<CostConfirm {...props} />);
    const enabled = screen.getByRole('button', { name: /Je confirme/ }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(true); // checkbox non cochée
    fireEvent.click(screen.getByRole('checkbox'));
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    expect(onConfirm).toHaveBeenCalledTimes(1); // callback simulé uniquement, aucune génération
  });
});
