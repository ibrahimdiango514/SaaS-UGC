import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handler as videoHandler } from '../supabase/functions/reelora-video/index.ts';
import { handler as workerHandler } from '../supabase/functions/reelora-video-worker/index.ts';

/* -------------------------------------------------------------------------- */
/* Mocks: no real MuAPI / Supabase call. Every network hop is recorded.        */
/* -------------------------------------------------------------------------- */

const SUPABASE_URL = 'https://project.supabase.co';
const EDGE_URL = `${SUPABASE_URL}/functions/v1/reelora-video`;
const WORKER_URL = `${SUPABASE_URL}/functions/v1/reelora-video-worker`;
const MUAPI_KEY = 'muapi-secret-key-98765';
const WORKER_TOKEN = 'worker-token-secret-abc123';
const VIDEO_URL = 'https://cdn.muapi.ai/output/final.mp4';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'req-muapi-123';
const PUBLIC_MODEL_ID = '11111111-1111-4111-8111-111111111112';
const PUBLIC_VEO_ID = '11111111-1111-4111-8111-111111111113';
const PUBLIC_I2V_ID = '11111111-1111-4111-8111-111111111114';
const QUOTE_ID = '99999999-9999-4999-8999-999999999999';

const SEEDANCE_T2V = {
  public_id: PUBLIC_MODEL_ID,
  model_id: 'seedance-lite-t2v', display_name: 'Seedance Lite — Texte → Vidéo',
  description: 'Prompt → vidéo', category: 'Text to Video',
  endpoint: '/api/v1/seedance-lite-t2v',
  input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed'],
  required_fields: ['prompt'],
  param_schema: {
    aspect_ratio: { type: 'select', label: 'Format', options: ['16:9', '9:16', '1:1', '4:3', '3:4', '9:21'], default: '9:16' },
    resolution: { type: 'select', label: 'Résolution', options: ['480p', '720p', '1080p'], default: '480p' },
    duration: { type: 'number', label: 'Durée', min: 5, max: 30, default: 5 },
    camera_fixed: { type: 'boolean', label: 'Caméra fixe', default: false },
  },
  cost_usd: 0.1, cost_currency: 'USD', is_enabled: true, is_coming_soon: false, active: true,
};
const VEO3_FAST = {
  ...SEEDANCE_T2V, public_id: PUBLIC_VEO_ID, model_id: 'veo3-fast-text-to-video', display_name: 'Veo 3 Fast',
  endpoint: '/api/v1/veo3-fast-text-to-video', input_fields: ['prompt', 'aspect_ratio'],
  param_schema: { aspect_ratio: { type: 'select', options: ['16:9', '9:16'], default: '9:16' } },
  cost_usd: 0.6,
};
const SEEDANCE_I2V = {
  ...SEEDANCE_T2V, public_id: PUBLIC_I2V_ID, model_id: 'seedance-lite-i2v', display_name: 'Seedance Lite — Image → Vidéo',
  endpoint: '/api/v1/seedance-lite-i2v', category: 'Image to Video',
  input_fields: ['prompt', 'image_url', 'last_image', 'resolution', 'duration', 'camera_fixed'],
  required_fields: ['prompt', 'image_url'],
};
const DETAIL_RESPONSE = {
  name: 'seedance-lite-t2v', description: 'Seedance Lite T2V', category: 'Text to Video',
  family: 'bytedance', group_of: 'video', cost: 0.1, cost_currency: 'USD',
  dynamic_pricing: true, endpoint: '/api/v1/seedance-lite-t2v',
  endpoint_url: 'seedance-lite-t2v', is_enabled: 1, is_coming_soon: false,
  input_fields: ['prompt', 'aspect_ratio', 'resolution', 'duration', 'camera_fixed'],
  required_fields: ['prompt'],
  estimate_endpoint: '/api/v1/models/seedance-lite-t2v/estimate-cost',
  input_schema: { schemas: { input_data: { type: 'object', required: ['prompt'], properties: {
    prompt: { type: 'string', title: 'Prompt', description: 'Instruction' },
    aspect_ratio: { type: 'string', title: 'Aspect Ratio', enum: ['16:9', '9:16'], default: '16:9' },
    resolution: { type: 'string', title: 'Resolution', enum: ['480p', '720p'], default: '480p' },
    duration: { type: 'int', title: 'Duration', minValue: 3, maxValue: 12, default: 5 },
    camera_fixed: { type: 'boolean', title: 'Camera Fixed', default: false },
    reference_images: { type: 'array', title: 'Reference images' },
  } } } },
};
const DYNAMIC_MODEL = {
  ...SEEDANCE_T2V,
  param_schema: {
    ...(SEEDANCE_T2V.param_schema as Record<string, unknown>),
    __catalog: {
      family: 'bytedance', group_of: 'video', source: 'muapi_public',
      dynamic_pricing: true, endpoint_url: 'seedance-lite-t2v',
      estimate_endpoint: '/api/v1/models/seedance-lite-t2v/estimate-cost',
    },
  },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];

const state = {
  authOk: true,
  claim: true,
  job: {} as Record<string, unknown>,
  model: SEEDANCE_T2V as Record<string, unknown>,
  service: { service_key: 'ugc_clip_8s', credits_cost: 9, active: true },
  videoPricing: {
    enabled: true, usd_to_xof: 600, credit_value_xof: 10,
    markup_percent: 110, additional_cost_usd: 0, updated_at: '2026-11-10T00:00:00.000Z',
  },
  providerSpendCap: { enabled: true, max_usd: 5 },
  providerSpendRows: [] as Record<string, unknown>[],
  jobsById: {} as Record<string, Record<string, unknown>>,
  quoteCosts: {} as Record<string, number>,
  assets: [] as Record<string, unknown>[],
  modelsCatalog: [] as Record<string, unknown>[],
  publicModels: [] as Record<string, unknown>[],
  accountModels: [] as Record<string, unknown>[],
  accountModelsStatus: 200,
  balanceStatus: 200,
  keysStatus: 200,
  keysResponse: [{ is_test: false }] as Record<string, unknown>[],
  detailStatus: 200,
  detailResponse: {} as Record<string, unknown>,
  estimateStatus: 200,
  estimateResponse: { cost: 0.12, currency: 'USD' } as Record<string, unknown>,
  submitStatus: 200,
  submitResponse: { request_id: REQUEST_ID, status: 'processing', cost: { amount_credits: 0.1 } } as Record<string, unknown>,
  resultResponse: { id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL], cost: { amount_credits: 0.1 } } as Record<string, unknown>,
  tickDue: [] as Record<string, unknown>[],
  jobsByProvider: [] as Record<string, unknown>[],
  isAdmin: true,
};

function expectedPricingParams(job = state.job): Record<string, unknown> {
  const payload = (job.request_payload ?? {}) as Record<string, unknown>;
  const params = (payload.params ?? {}) as Record<string, unknown>;
  const schema = (state.model.param_schema ?? {}) as Record<string, Record<string, unknown>>;
  const fields = state.model.input_fields as string[];
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema)) {
    if (!fields.includes(key) || key.startsWith('__')
      || ['prompt', 'image_url', 'last_image', 'first_frame', 'last_image_url'].includes(key)) continue;
    const raw = params[key] ?? payload[key] ?? def.default;
    if (raw !== undefined && raw !== null) out[key] = raw;
  }
  return out;
}

function asHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries(h.entries());
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...(h as Record<string, string>) };
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = asHeaders(init?.headers);
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === 'string') {
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = null; }
  }
  calls.push({ url, method, headers, body });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (url.includes('/auth/v1/user')) {
    return state.authOk ? json({ id: USER_ID }) : json({ message: 'invalid jwt' }, 401);
  }
  if (url === `${SUPABASE_URL}/rest/v1/rpc/reelora_worker_token`) return json(WORKER_TOKEN);
  if (url.includes('/rest/v1/rpc/')) {
    const name = url.split('/rest/v1/rpc/')[1]?.split('?')[0] ?? '';
    if (name === 'reelora_claim_generation_submission') return json(state.claim);
    if (name === 'reelora_video_tick') return json({ expired: 0, due: state.tickDue, checked_at: new Date().toISOString() });
    if (name === 'reelora_sync_video_models') return json(state.modelsCatalog.length);
    if (name === 'reelora_admin_overview') return state.isAdmin ? json({ users: 0 }) : json({ message: 'forbidden' }, 403);
    if (name === 'reelora_record_video_quote') {
      state.quoteCosts[QUOTE_ID] = Number(body?.p_provider_cost_usd ?? 0);
      return json(QUOTE_ID);
    }
    if (name === 'reelora_get_video_quote') {
      const quoteId = body?.p_quote_id;
      const quoteJob = Object.values(state.jobsById).find((candidate) => candidate.pricing_quote_id === quoteId) ?? state.job;
      return json({
        id: quoteId ?? QUOTE_ID, user_id: quoteJob.created_by ?? USER_ID,
        service_key: quoteJob.service_key ?? 'ugc_clip_8s',
        model_id: state.model.model_id,
        public_model_id: state.model.public_id ?? PUBLIC_MODEL_ID,
        provider_cost_usd: state.quoteCosts[String(quoteId)] ?? state.model.cost_usd ?? 0.1,
        credits_cost: quoteJob.credits_reserved ?? 13,
        pricing_params: expectedPricingParams(quoteJob),
        consumed_at: '2026-11-10T00:00:00.000Z',
      });
    }
    if (name === 'reelora_reserve_provider_spend') {
      const jobId = String(body?.p_job_id ?? '');
      const existing = state.providerSpendRows.find((row) => row.generation_job_id === jobId);
      if (existing) return json({ allowed: false, reason: 'provider_spend_already_reserved' });
      const estimate = Number(state.model.cost_usd ?? 0.1);
      const committed = state.providerSpendRows.reduce((total, row) => {
        if (row.released_at || row.status === 'blocked') return total;
        if (['reserved', 'submitted', 'unknown'].includes(String(row.status))) return total + Number(row.reserved_cost_usd ?? 0);
        return total + Number(row.actual_cost_usd ?? row.estimated_cost_usd ?? 0);
      }, 0);
      const remaining = Math.max(state.providerSpendCap.max_usd - committed, 0);
      if (!state.providerSpendCap.enabled || state.providerSpendCap.max_usd <= 0 || estimate > remaining) {
        const reason = !state.providerSpendCap.enabled || state.providerSpendCap.max_usd <= 0
          ? 'provider_spend_disabled' : 'provider_spend_cap_exceeded';
        state.providerSpendRows.push({
          generation_job_id: jobId, model_id: state.model.model_id, estimated_cost_usd: estimate,
          reserved_cost_usd: 0, status: 'blocked', reason_code: reason,
        });
        return json({ allowed: false, reason, max_usd: state.providerSpendCap.max_usd, committed_usd: committed, remaining_usd: remaining });
      }
      state.providerSpendRows.push({
        generation_job_id: jobId, model_id: state.model.model_id, estimated_cost_usd: estimate,
        reserved_cost_usd: estimate, status: 'reserved',
      });
      return json({ allowed: true, estimated_cost_usd: estimate, remaining_usd: remaining });
    }
    if (name === 'reelora_update_provider_spend') {
      const row = state.providerSpendRows.find((entry) => entry.generation_job_id === body?.p_job_id);
      if (row) {
        row.status = body?.p_status;
        row.provider_request_id = body?.p_provider_request_id;
        row.actual_cost_usd = body?.p_actual_cost_usd;
        row.released_at = body?.p_release ? new Date().toISOString() : row.released_at;
        row.reason_code = body?.p_reason_code;
      }
      return json(true);
    }
    if (name === 'reelora_admin_provider_spend_summary') return state.isAdmin
      ? json({ enabled: state.providerSpendCap.enabled, max_usd: state.providerSpendCap.max_usd })
      : json({ message: 'forbidden' }, 403);
    if (name === 'reelora_admin_set_provider_spend_cap') {
      if (!state.isAdmin) return json({ message: 'forbidden' }, 403);
      state.providerSpendCap = { enabled: body?.p_enabled === true && Number(body?.p_max_usd) > 0, max_usd: Number(body?.p_max_usd) };
      return json(true);
    }
    return json(true);
  }
  if (url.includes('/rest/v1/reelora_video_models')) return json([state.model]);
  if (url.includes('/rest/v1/ugc_app_settings')) return json([{
    setting_value: {
      enabled: state.videoPricing.enabled, usd_to_xof: state.videoPricing.usd_to_xof,
      credit_value_xof: state.videoPricing.credit_value_xof, markup_percent: state.videoPricing.markup_percent,
      additional_cost_usd: state.videoPricing.additional_cost_usd,
    },
    updated_at: state.videoPricing.updated_at,
  }]);
  if (url.includes('/rest/v1/ugc_generated_assets')) return json(state.assets);
  if (url.includes('/rest/v1/ugc_service_catalog')) return json([state.service]);
  if (url.includes('/rest/v1/ugc_generation_jobs')) {
    if (url.includes('provider_job_id=eq.')) return json(state.jobsByProvider);
    const id = new URL(url).searchParams.get('id')?.replace(/^eq\./, '');
    return json([state.jobsById[id ?? ''] ?? state.job]);
  }
  if (url.includes('/rest/v1/ugc_project_scripts')) return json([{ script_text: 'Script de secours valide pour le test.' }]);
  if (url.includes('/rest/v1/reelora_avatars')) return json([]);
  if (url.includes('/storage/v1/object/sign/')) return json({ signedURL: '/object/sign/ugc-assets/signed-token' });
  if (url.includes('/storage/v1/object/ugc-assets/')) return json({ Key: 'ugc-assets/ok' });

  if (url === 'https://api.muapi.ai/api/v1/models') {
    const authenticated = headers['x-api-key'] === MUAPI_KEY;
    const models = authenticated
      ? (state.accountModels.length ? state.accountModels : state.modelsCatalog)
      : state.publicModels;
    return json({ models, total: models.length }, authenticated ? state.accountModelsStatus : 200);
  }
  if (url === 'https://api.muapi.ai/api/v1/account/balance') return json({ balance: 42.5 }, state.balanceStatus);
  if (url === 'https://api.muapi.ai/api/v1/keys') return json(state.keysResponse, state.keysStatus);
  if (url.includes('/estimate-cost')) return json(state.estimateResponse, state.estimateStatus);
  if (method === 'GET' && url.startsWith('https://api.muapi.ai/api/v1/models/')) return json(state.detailResponse, state.detailStatus);
  if (url.includes('/api/v1/predictions/')) return json(state.resultResponse);
  if (url.startsWith('https://api.muapi.ai/api/v1/')) return json(state.submitResponse, state.submitStatus);
  if (url === VIDEO_URL) return new Response(new Uint8Array([0, 1, 2, 3, 4]), { status: 200 });
  return json({}, 404);
}

function baseJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: JOB_ID, workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, created_by: USER_ID,
    service_key: 'ugc_clip_8s', status: 'reserved', provider: null, provider_job_id: null,
    pricing_quote_id: QUOTE_ID, credits_reserved: 13, credits_charged: 0, error_message: null, result_payload: {},
    request_payload: {
      quote_id: QUOTE_ID, model_id: PUBLIC_MODEL_ID,
      script_text: 'Accroche : découvrez notre sérum éclat, une peau lumineuse en sept jours.',
      visual_prompt: 'UGC authentique, lumière naturelle, cadrage vertical smartphone.',
      scenes: [{ scene_type: 'ugc', duration_seconds: 3, visual_prompt: 'Gros plan du flacon dans la main, lumière du matin.' }],
      params: { aspect_ratio: '9:16', resolution: '480p', duration: 5, camera_fixed: false },
    },
    ...overrides,
  };
}
function post(url: string, body: Record<string, unknown>, jwt = 'Bearer valid-user-jwt'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jwt ? { Authorization: jwt } : {}) },
    body: JSON.stringify(body),
  });
}
function rpcCalls(name: string): Call[] {
  return calls.filter((c) => c.url.includes(`/rest/v1/rpc/${name}`));
}
function muapiSubmits(): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.muapi.ai/api/v1/')
    && !c.url.includes('/predictions/') && !c.url.includes('/estimate-cost'));
}
function muapiEstimateCalls(): Call[] {
  return calls.filter((c) => c.method === 'POST' && c.url.includes('/estimate-cost'));
}
function bodyOf(r: Response): Promise<Record<string, unknown>> {
  return r.json() as Promise<Record<string, unknown>>;
}

const originalEnv = { ...process.env };
beforeEach(() => {
  calls.length = 0;
  state.authOk = true;
  state.claim = true;
  state.job = baseJob();
  state.model = SEEDANCE_T2V as unknown as Record<string, unknown>;
  state.assets = [];
  state.modelsCatalog = [];
  state.publicModels = [];
  state.accountModels = [];
  state.accountModelsStatus = 200;
  state.balanceStatus = 200;
  state.keysStatus = 200;
  state.keysResponse = [{ is_test: false }];
  state.detailStatus = 200;
  state.detailResponse = DETAIL_RESPONSE as unknown as Record<string, unknown>;
  state.estimateStatus = 200;
  state.estimateResponse = { cost: 0.12, currency: 'USD' };
  state.submitStatus = 200;
  state.submitResponse = { request_id: REQUEST_ID, status: 'processing', cost: { amount_credits: 0.1 } };
  state.resultResponse = { id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL], cost: { amount_credits: 0.1 } };
  state.tickDue = [];
  state.jobsByProvider = [];
  state.jobsById = {};
  state.providerSpendRows = [];
  state.providerSpendCap = { enabled: true, max_usd: 5 };
  state.quoteCosts = {};
  state.videoPricing = {
    enabled: true, usd_to_xof: 600, credit_value_xof: 10,
    markup_percent: 110, additional_cost_usd: 0, updated_at: '2026-11-10T00:00:00.000Z',
  };
  state.isAdmin = true;
  process.env = { ...originalEnv, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key',
    SUPABASE_ANON_KEY: 'anon-test-key', MUAPI_API_KEY: MUAPI_KEY };
  vi.stubGlobal('fetch', fakeFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

/* -------------------------------------------------------------------------- */

describe('Authentification obligatoire', () => {
  it('renvoie une erreur structurée 405 sur une méthode non POST', async () => {
    const r = await videoHandler(new Request(EDGE_URL, { method: 'GET', headers: { Authorization: 'Bearer valid-user-jwt' } }));
    expect(r.status).toBe(405);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' });
    expect(calls).toHaveLength(0);
  });

  it('refuse une requête sans en-tête Authorization', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'status', job_id: JOB_ID }, ''));
    expect(r.status).toBe(401);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls.some((c) => c.url.includes('api.muapi.ai'))).toBe(false);
  });

  it('refuse un jeton utilisateur invalide (validation GoTrue)', async () => {
    state.authOk = false;
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(401);
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('le worker refuse un callback sans jeton ou avec un jeton erroné', async () => {
    const bad = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=wrong-token`, { id: REQUEST_ID }));
    expect(bad.status).toBe(401);
    const none = await workerHandler(post(`${WORKER_URL}?mode=tick`, { mode: 'tick' }));
    expect(none.status).toBe(401);
    expect(calls.some((c) => c.url.includes('/predictions/'))).toBe(false);
  });
});

describe('Configuration MuAPI et protection des crédits', () => {
  it('refuse la génération si MUAPI_API_KEY est absente, sans appeler MuAPI, et restitue les crédits', async () => {
    delete process.env.MUAPI_API_KEY;
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'MUAPI_NOT_CONFIGURED' });
    expect(muapiSubmits()).toHaveLength(0);
    const finalize = rpcCalls('reelora_finalize_generation');
    expect(finalize).toHaveLength(1);
    expect(finalize[0].body?.p_status).toBe('failed');
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
  });

  it('refuse un solde insuffisant : la règle SQL lève insufficient_credits avant toute réservation', () => {
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261108223923_reelora_muapi_v1.sql'), 'utf8');
    expect(migration).toContain("raise exception 'insufficient_credits'");
    expect(migration).toContain("perform public.reelora_consume_quota('video', v_job");
    // Le contrôle du solde précède la réservation et l'appel fournisseur.
    expect(migration.indexOf('raise exception')).toBeLessThan(migration.indexOf('apply_wallet_delta(v_uid'));
  });

  it('réserve exactement une fois via un identifiant d’idempotence par opération', () => {
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20261108223923_reelora_muapi_v1.sql'), 'utf8');
    expect(migration).toContain('on conflict (created_by, request_key) do nothing');
    expect(migration).toContain("'reserve-job:' || v_job::text");
    expect(migration).toContain("'release-job:'");
    expect(migration).toContain('release-job:');
    expect(migration).not.toMatch(/monthly.*free.*credit|monthly_credits\s*\+/i);
  });

  it('un double clic ne soumet qu’une seule tâche MuAPI (claim atomique)', async () => {
    state.claim = false;
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(muapiSubmits()).toHaveLength(0);
    expect(await bodyOf(r)).toMatchObject({ status: 'reserved' });
  });

  it('un job déjà soumis n’est jamais soumis une seconde fois', async () => {
    state.job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(muapiSubmits()).toHaveLength(0);
    const data = await bodyOf(r);
    expect(data).toMatchObject({ status: 'processing' });
    expect(JSON.stringify(data)).not.toContain(REQUEST_ID);
  });

  it('isolation entre utilisateurs : un job tiers est refusé en start et en status', async () => {
    state.job = baseJob({ created_by: OTHER_USER });
    const start = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    const status = await videoHandler(post(EDGE_URL, { action: 'status', job_id: JOB_ID }));
    expect(start.status).toBe(403);
    expect(status.status).toBe(403);
    expect(muapiSubmits()).toHaveLength(0);
  });
});

describe('Plafond atomique de dépenses fournisseur', () => {
  it('bloque tout appel payant lorsque le plafond vaut zéro ou est désactivé', async () => {
    state.providerSpendCap = { enabled: false, max_usd: 0 };
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'PROVIDER_SPEND_DISABLED' });
    expect(muapiSubmits()).toHaveLength(0);
    expect(state.providerSpendRows).toMatchObject([{ status: 'blocked', reason_code: 'provider_spend_disabled' }]);
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
  });

  it('permet une génération dont le devis est inférieur au plafond et réserve avant POST', async () => {
    state.providerSpendCap = { enabled: true, max_usd: 0.11 };
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(200);
    const reserve = rpcCalls('reelora_reserve_provider_spend');
    expect(reserve).toHaveLength(1);
    expect(state.providerSpendRows).toMatchObject([{
      estimated_cost_usd: 0.1, reserved_cost_usd: 0.1, status: 'submitted', provider_request_id: REQUEST_ID,
    }]);
    expect(muapiSubmits()).toHaveLength(1);
    const reserveIndex = calls.findIndex((call) => call.url.includes('/rpc/reelora_reserve_provider_spend'));
    const submitIndex = calls.findIndex((call) => call.url.startsWith('https://api.muapi.ai/api/v1/')
      && !call.url.includes('/estimate-cost'));
    expect(reserveIndex).toBeLessThan(submitIndex);
  });

  it('bloque une génération dont le coût estimé dépasse le budget restant', async () => {
    state.providerSpendCap = { enabled: true, max_usd: 0.05 };
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'PROVIDER_SPEND_CAP_EXCEEDED' });
    expect(state.providerSpendRows).toMatchObject([{ status: 'blocked', reason_code: 'provider_spend_cap_exceeded' }]);
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('sérialise deux demandes concurrentes et ne réserve pas au-delà du budget partagé', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    state.providerSpendCap = { enabled: true, max_usd: 0.15 };
    const secondJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondQuoteId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    state.jobsById[JOB_ID] = baseJob();
    state.jobsById[secondJobId] = baseJob({
      id: secondJobId,
      pricing_quote_id: secondQuoteId,
      request_payload: {
        ...(baseJob().request_payload as Record<string, unknown>),
        quote_id: secondQuoteId,
      },
    });
    const results = await Promise.all([
      videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID })),
      videoHandler(post(EDGE_URL, { action: 'start', job_id: secondJobId })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 503]);
    expect(muapiSubmits()).toHaveLength(1);
    const reserved = state.providerSpendRows.filter((row) => row.status !== 'blocked')
      .reduce((sum, row) => sum + Number(row.reserved_cost_usd), 0);
    expect(reserved).toBeLessThanOrEqual(state.providerSpendCap.max_usd);
  });

  it('libère la réservation pour un refus fournisseur explicite, mais conserve les inconnues réseau', async () => {
    state.submitStatus = 401;
    const rejected = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(rejected.status).toBe(503);
    expect(state.providerSpendRows[0]).toMatchObject({ status: 'failed', released_at: expect.any(String) });
    expect(muapiSubmits()).toHaveLength(1);

    calls.length = 0;
    state.job = baseJob({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    state.jobsById = {};
    state.submitStatus = 200;
    state.submitResponse = { status: 'processing' };
    const unknown = await videoHandler(post(EDGE_URL, { action: 'start', job_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }));
    expect(unknown.status).toBe(503);
    expect(state.providerSpendRows[state.providerSpendRows.length - 1]).toMatchObject({
      status: 'unknown', reason_code: 'provider_request_id_missing', reserved_cost_usd: 0.1,
    });
  });
});

describe('Soumission MuAPI réelle (mockée) et paramètres vérifiés', () => {
  it('envoie x-api-key, le prompt issu du script/scènes, uniquement les paramètres supportés, et le webhook signé par jeton', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    expect(data).toMatchObject({ status: 'processing', webhook_enabled: true, model_id: PUBLIC_MODEL_ID });
    expect(JSON.stringify(data)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(data)).not.toContain('muapi');
    const submit = muapiSubmits();
    expect(submit).toHaveLength(1);
    expect(submit[0].url).toContain('/api/v1/seedance-lite-t2v');
    expect(submit[0].headers['x-api-key']).toBe(MUAPI_KEY);
    const webhook = new URL(submit[0].url).searchParams.get('webhook') ?? '';
    expect(webhook).toContain('mode=webhook');
    expect(webhook).toContain(`token=${WORKER_TOKEN}`);
    const body = submit[0].body ?? {};
    expect(String(body.prompt)).toContain('Accroche');
    expect(String(body.prompt)).toContain('Gros plan du flacon');
    expect(body.aspect_ratio).toBe('9:16');
    expect(body.duration).toBe(5);
    expect(body).not.toHaveProperty('audio_url');
    expect(body).not.toHaveProperty('negative_prompt');
    const processing = rpcCalls('reelora_set_job_processing');
    expect(processing).toHaveLength(1);
    expect(processing[0].body).toMatchObject({ p_provider: 'muapi', p_provider_job_id: REQUEST_ID });
    expect(JSON.stringify(processing[0].body)).not.toContain(MUAPI_KEY);
  });

  it('ne transmet pas un paramètre non pris en charge par le modèle (Veo 3 Fast)', async () => {
    state.model = VEO3_FAST as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_VEO_ID, params: { duration: 10, resolution: '1080p', aspect_ratio: '16:9' } } });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(200);
    const body = muapiSubmits()[0].body ?? {};
    expect(body.aspect_ratio).toBe('16:9');
    expect(body).not.toHaveProperty('duration');
    expect(body).not.toHaveProperty('resolution');
    expect(body).not.toHaveProperty('camera_fixed');
  });

  it('un modèle image → vidéo exige image_url et rembourse si elle manque', async () => {
    state.model = SEEDANCE_I2V as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_I2V_ID, image_url: null, avatar_id: null } });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'IMAGE_MISSING' });
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
  });

  it('un modèle image → vidéo reçoit bien image_url quand elle est fournie', async () => {
    state.model = SEEDANCE_I2V as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_I2V_ID, image_url: 'https://cdn.example.com/product.png' } });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(200);
    expect(muapiSubmits()[0].body?.image_url).toBe('https://cdn.example.com/product.png');
  });

  it('signe côté serveur une image de référence importée dans Storage privé', async () => {
    state.model = SEEDANCE_I2V as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_I2V_ID, image_url: null, avatar_id: null,
      image_storage_path: `${WORKSPACE_ID}/references/first.png` } });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(200);
    const signs = calls.filter((c) => c.url.includes(`/storage/v1/object/sign/ugc-assets/${WORKSPACE_ID}/references/first.png`));
    expect(signs).toHaveLength(1);
    const body = muapiSubmits()[0].body ?? {};
    expect(String(body.image_url)).toContain('/storage/v1/');
    expect(body).not.toHaveProperty('last_image');
  });

  it('refuse un chemin d’image hors du workspace sans le signer ni soumettre', async () => {
    state.model = SEEDANCE_I2V as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_I2V_ID, image_url: null, avatar_id: null,
      image_storage_path: 'autre-workspace/secret.png' } });
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatchObject({ code: 'IMAGE_MISSING' });
    expect(calls.some((c) => c.url.includes('/storage/v1/object/sign/'))).toBe(false);
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('envoie last_image uniquement lorsque le modèle vérifié le déclare', async () => {
    state.model = SEEDANCE_I2V as unknown as Record<string, unknown>;
    state.job = baseJob({ request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_I2V_ID, image_url: 'https://cdn.example.com/first.png',
      last_image_storage_path: `${WORKSPACE_ID}/references/last.png` } });
    const withField = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    expect(withField.status).toBe(200);
    expect(String(muapiSubmits()[0].body?.last_image)).toContain('/storage/v1/');

    calls.length = 0;
    state.model = SEEDANCE_T2V as unknown as Record<string, unknown>;
    const secondJobId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    state.job = baseJob({ id: secondJobId, request_payload: { ...(state.job.request_payload as Record<string, unknown>),
      model_id: PUBLIC_MODEL_ID, last_image_storage_path: `${WORKSPACE_ID}/references/last.png` } });
    const withoutField = await videoHandler(post(EDGE_URL, { action: 'start', job_id: secondJobId }));
    expect(withoutField.status).toBe(200);
    expect(muapiSubmits()[0].body).not.toHaveProperty('last_image');
    expect(calls.some((c) => c.url.includes('/storage/v1/object/sign/'))).toBe(false);
  });

  it('une erreur MuAPI est restituée sans exposer la clé et rembourse les crédits', async () => {
    state.submitStatus = 401;
    state.submitResponse = { message: `invalid x-api-key ${MUAPI_KEY}` };
    const r = await videoHandler(post(EDGE_URL, { action: 'start', job_id: JOB_ID }));
    const text = await r.text();
    expect(r.status).toBe(503);
    expect(text).not.toContain(MUAPI_KEY);
    expect(text).not.toContain('invalid x-api-key');
    expect(rpcCalls('reelora_finalize_generation')).toHaveLength(1);
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
  });

  it('aucune clé MuAPI n’apparaît dans le frontend, les configs ou les logs', () => {
    const frontend = readFileSync(join(process.cwd(), 'src/pages/Studio.tsx'), 'utf8');
    const env = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const video = readFileSync(join(process.cwd(), 'supabase/functions/reelora-video/index.ts'), 'utf8');
    expect(frontend).not.toContain('Deno.env.get');
    expect(frontend).not.toContain('x-api-key');
    expect(env).not.toMatch(/^\s*MUAPI_API_KEY\s*=/m);
    expect(env).not.toContain('VITE_MUAPI');
    expect(video).toContain('function redact');
    expect(video).toContain('[REDACTED]');
  });
});

describe('Catalogue, estimation et suivi', () => {
  it('expose des modèles VYORA opaques et synchronise les métadonnées côté serveur', async () => {
    state.modelsCatalog = [{ name: 'seedance-lite-t2v', cost: 0.12, cost_currency: 'USD',
      description: 'Seedance Lite', is_enabled: 1, is_coming_soon: false }];
    const r = await videoHandler(post(EDGE_URL, { action: 'models' }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    const models = data.models as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: PUBLIC_MODEL_ID, display_name: expect.stringContaining('VYORA') });
    expect(models[0]).not.toHaveProperty('endpoint');
    expect(models[0]).not.toHaveProperty('cost_usd');
    expect(JSON.stringify(models)).not.toContain('seedance-lite-t2v');
    expect(JSON.stringify(models)).not.toContain('audio_url');
    expect(rpcCalls('reelora_sync_video_models')).toHaveLength(1);
  });

  it('retourne un devis opaque en crédits avant confirmation', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'estimate', service_key: 'ugc_clip_8s', model_id: 'seedance-lite-t2v' }));
    const data = await bodyOf(r);
    expect(data).toMatchObject({ service_key: 'ugc_clip_8s', credits_cost: 13,
      model_available: true, pricing_available: true, quote_id: QUOTE_ID, model_id: PUBLIC_MODEL_ID });
    expect(data).not.toHaveProperty('provider_cost_usd');
    expect(data).not.toHaveProperty('provider_quote_error');
    expect(JSON.stringify(data)).not.toContain('USD');
  });

  it('le suivi lit la base sans exposer de détails fournisseur', async () => {
    state.job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID,
      result_payload: { provider_status: 'processing' } });
    const r = await videoHandler(post(EDGE_URL, { action: 'status', job_id: JOB_ID }));
    const data = await bodyOf(r);
    expect(data).toMatchObject({ status: 'processing', progress: 55, provider_state: 'processing' });
    expect(JSON.stringify(data)).not.toContain('provider_job_id');
    expect(calls.some((c) => c.url.includes('/predictions/'))).toBe(false);
  });

  it('le suivi expose une URL signée de prévisualisation pour une vidéo terminée', async () => {
    state.job = baseJob({ status: 'succeeded', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.assets = [{ storage_path: `${WORKSPACE_ID}/${JOB_ID}.mp4`, mime_type: 'video/mp4', file_size_bytes: 1234 }];
    const r = await videoHandler(post(EDGE_URL, { action: 'status', job_id: JOB_ID }));
    const data = await bodyOf(r);
    expect(data).toMatchObject({ status: 'succeeded', progress: 100, storage_path: `${WORKSPACE_ID}/${JOB_ID}.mp4` });
    expect(String(data.preview_url)).toContain('/storage/v1/');
  });
});

describe('Worker serveur : webhook, cron, résultat, remboursement', () => {
  it('un webhook valide re-vérifie MuAPI puis enregistre la vidéo dans Supabase Storage', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`,
      { id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL] }));
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toMatchObject({ outcome: 'succeeded' });
    expect(calls.some((c) => c.url.includes(`/predictions/${REQUEST_ID}/result`))).toBe(true);
    const upload = calls.find((c) => c.method === 'POST' && c.url.includes(`/storage/v1/object/ugc-assets/${WORKSPACE_ID}/${JOB_ID}.mp4`));
    expect(upload).toBeDefined();
    const finalize = rpcCalls('reelora_finalize_generation');
    expect(finalize).toHaveLength(1);
    expect(finalize[0].body).toMatchObject({ p_status: 'succeeded', p_storage_path: `${WORKSPACE_ID}/${JOB_ID}.mp4`, p_mime_type: 'video/mp4' });
    const resultPayload = finalize[0].body?.p_result_payload as Record<string, unknown>;
    expect(resultPayload).toMatchObject({ credits_reserved: 13 });
    expect(resultPayload).not.toHaveProperty('model_id');
    expect(resultPayload).not.toHaveProperty('muapi_cost');
    expect(resultPayload.params).toMatchObject({ aspect_ratio: '9:16' });
    // Aucun remboursement abusif sur un succès.
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(0);
  });

  it('gère la variante de réponse MuAPI imbriquée dans `data`', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = { data: { id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL] } };
    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));
    expect(await bodyOf(r)).toMatchObject({ outcome: 'succeeded' });
  });

  it('rapproche le coût réel uniquement quand MuAPI indique explicitement des USD', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = {
      id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL],
      cost: { amount: 0.087, currency: 'USD' },
    };
    state.providerSpendRows.push({
      generation_job_id: JOB_ID, estimated_cost_usd: 0.12, reserved_cost_usd: 0.12,
      status: 'submitted', provider_request_id: REQUEST_ID,
    });

    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));

    expect(await bodyOf(r)).toMatchObject({ outcome: 'succeeded' });
    expect(rpcCalls('reelora_update_provider_spend')).toMatchObject([{
      body: {
        p_job_id: JOB_ID, p_status: 'succeeded', p_provider_request_id: REQUEST_ID,
        p_actual_cost_usd: 0.087, p_release: false,
      },
    }]);
    expect(state.providerSpendRows[0]).toMatchObject({
      status: 'succeeded', actual_cost_usd: 0.087, reserved_cost_usd: 0.12,
    });
  });

  it('conserve le budget estimé si le résultat MuAPI ne précise pas une devise USD', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = {
      id: REQUEST_ID, status: 'completed', outputs: [VIDEO_URL],
      cost: { amount_credits: 0.087 },
    };
    state.providerSpendRows.push({
      generation_job_id: JOB_ID, estimated_cost_usd: 0.12, reserved_cost_usd: 0.12,
      status: 'submitted', provider_request_id: REQUEST_ID,
    });

    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));

    expect(await bodyOf(r)).toMatchObject({ outcome: 'succeeded' });
    expect(rpcCalls('reelora_update_provider_spend')).toMatchObject([{
      body: {
        p_job_id: JOB_ID, p_status: 'succeeded', p_actual_cost_usd: null,
        p_release: false,
      },
    }]);
    expect(state.providerSpendRows[0]).toMatchObject({
      status: 'succeeded', reserved_cost_usd: 0.12,
    });
    expect(state.providerSpendRows[0].actual_cost_usd).toBeNull();
  });

  it('un webhook ne fait jamais confiance au corps : un faux "completed" reste en processing', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = { id: REQUEST_ID, status: 'processing', outputs: [] };
    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`,
      { id: REQUEST_ID, status: 'completed', outputs: ['https://evil.example/fake.mp4'] }));
    expect(await bodyOf(r)).toMatchObject({ outcome: 'processing' });
    expect(calls.some((c) => c.url.includes('/storage/v1/object/ugc-assets/') && c.method === 'POST')).toBe(false);
    expect(rpcCalls('reelora_record_video_poll')).toHaveLength(1);
  });

  it('un échec MuAPI finalise en failed et restitue automatiquement les crédits', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = {
      id: REQUEST_ID, status: 'failed', error: 'NSFW content', outputs: [],
      cost: { amount: 0.025, currency: 'USD' },
    };
    state.providerSpendRows.push({
      generation_job_id: JOB_ID, estimated_cost_usd: 0.12, reserved_cost_usd: 0.12,
      status: 'submitted', provider_request_id: REQUEST_ID,
    });
    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));
    expect(await bodyOf(r)).toMatchObject({ outcome: 'failed' });
    const finalize = rpcCalls('reelora_finalize_generation');
    expect(finalize).toHaveLength(1);
    expect(finalize[0].body?.p_status).toBe('failed');
    expect(String(finalize[0].body?.p_error_message)).toContain('crédits réservés ont été restitués');
    expect(rpcCalls('reelora_update_provider_spend')).toMatchObject([{
      body: { p_status: 'failed', p_actual_cost_usd: 0.025, p_release: false },
    }]);
    expect(state.providerSpendRows[0]).toMatchObject({ status: 'failed', actual_cost_usd: 0.025 });
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/storage/v1/object/ugc-assets/') && c.method === 'POST')).toBe(false);
  });

  it('conserve le coût fournisseur explicite même lorsque la génération est annulée', async () => {
    const job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    state.resultResponse = {
      id: REQUEST_ID, status: 'cancelled', outputs: [],
      cost: { amount: 0.01, currency: 'USD' },
    };
    state.providerSpendRows.push({
      generation_job_id: JOB_ID, estimated_cost_usd: 0.12, reserved_cost_usd: 0.12,
      status: 'submitted', provider_request_id: REQUEST_ID,
    });

    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));

    expect(await bodyOf(r)).toMatchObject({ outcome: 'failed' });
    expect(rpcCalls('reelora_update_provider_spend')).toMatchObject([{
      body: { p_status: 'cancelled', p_actual_cost_usd: 0.01, p_release: false },
    }]);
    expect(state.providerSpendRows[0]).toMatchObject({ status: 'cancelled', actual_cost_usd: 0.01 });
    expect(rpcCalls('reelora_release_video_quota')).toHaveLength(1);
  });

  it('un callback déjà traité est idempotent (pas de second débit ni second remboursement)', async () => {
    const job = baseJob({ status: 'succeeded', provider: 'muapi', provider_job_id: REQUEST_ID });
    state.job = job; state.jobsByProvider = [job];
    const r = await workerHandler(post(`${WORKER_URL}?mode=webhook&token=${WORKER_TOKEN}`, { id: REQUEST_ID }));
    expect(await bodyOf(r)).toMatchObject({ outcome: 'already_terminal' });
    expect(rpcCalls('reelora_finalize_generation')).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('/predictions/'))).toBe(false);
  });

  it('le cron réconcilie les jobs dus même sans page ouverte (token en en-tête)', async () => {
    state.tickDue = [{ id: JOB_ID, job_id: JOB_ID, created_by: USER_ID, workspace_id: WORKSPACE_ID,
      project_id: PROJECT_ID, provider_job_id: REQUEST_ID, provider: 'muapi', request_payload: { model_id: 'seedance-lite-t2v' } }];
    state.job = baseJob({ status: 'processing', provider: 'muapi', provider_job_id: REQUEST_ID });
    const req = new Request(`${WORKER_URL}?mode=tick`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-reelora-worker-token': WORKER_TOKEN },
      body: JSON.stringify({ mode: 'tick' }) });
    const r = await workerHandler(req);
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toMatchObject({ mode: 'tick', checked: 1 });
    expect(rpcCalls('reelora_video_tick')).toHaveLength(1);
    expect(calls.some((c) => c.url.includes(`/predictions/${REQUEST_ID}/result`))).toBe(true);
  });
});

describe('Catalogue VYORA, schéma client et devis opaque', () => {
  it('retourne uniquement les modèles VYORA connus avec des identifiants opaques', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'catalog' }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    const models = data.models as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model_id: PUBLIC_MODEL_ID, display_name: expect.stringContaining('VYORA') });
    expect(data.catalog).toMatchObject({ verified: false });
    expect(data.catalog).not.toHaveProperty('source');
    expect(data.catalog).not.toHaveProperty('account');
    expect(JSON.stringify(data)).not.toContain('seedance-lite-t2v');
    expect(JSON.stringify(data)).not.toContain('USD');
    expect(JSON.stringify(data)).not.toContain(MUAPI_KEY);
    expect(muapiSubmits()).toHaveLength(0);
    expect(muapiEstimateCalls()).toHaveLength(0);
  });

  it('ne révèle aucun détail fournisseur quand le catalogue administrateur est demandé par un client', async () => {
    state.isAdmin = false;
    const r = await videoHandler(post(EDGE_URL, { action: 'admin-catalog' }));
    expect(r.status).toBe(403);
    expect(JSON.stringify(await bodyOf(r))).not.toContain('seedance-lite-t2v');
  });

  it('récupère le schéma validé sans exposer identifiant technique ni détails fournisseur', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'model-detail', model_id: PUBLIC_MODEL_ID }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    const model = data.model as Record<string, unknown>;
    const schema = model.param_schema as Record<string, Record<string, unknown>>;
    expect(model.model_id).toBe(PUBLIC_MODEL_ID);
    expect(schema.aspect_ratio).toMatchObject({ type: 'select', options: ['16:9', '9:16'], default: '16:9' });
    expect(schema.duration).toMatchObject({ type: 'number', min: 3, max: 12, default: 5 });
    expect(schema.camera_fixed).toMatchObject({ type: 'boolean', default: false });
    expect(model).not.toHaveProperty('endpoint');
    expect(model).not.toHaveProperty('cost_usd');
    expect(JSON.stringify(data)).not.toContain(MUAPI_KEY);
    expect(JSON.stringify(data)).not.toContain('seedance-lite-t2v');
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('calcule les crédits côté serveur sans retourner coût ni paramètres de fournisseur', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    const params = { aspect_ratio: '9:16', resolution: '480p', duration: 5, camera_fixed: false };
    const prompt = 'Une publicité UGC verticale pour un sérum cosmétique avec accroche et appel à l’achat.';
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params, prompt, param_schema: SEEDANCE_T2V.param_schema,
    }));
    expect(r.status).toBe(200);
    const estimate = await bodyOf(r);
    expect(estimate).toMatchObject({
      service_key: 'ugc_clip_8s', credits_cost: 16, model_available: true,
      pricing_available: true, quote_id: QUOTE_ID, model_id: PUBLIC_MODEL_ID,
    });
    expect(estimate).not.toHaveProperty('provider_cost_usd');
    expect(estimate).not.toHaveProperty('quote_params');
    expect(JSON.stringify(estimate)).not.toContain('USD');
    expect(muapiEstimateCalls()).toHaveLength(1);
    expect(muapiEstimateCalls()[0].headers['x-api-key']).toBe(MUAPI_KEY);
    expect(muapiEstimateCalls()[0].url).toContain('/api/v1/models/seedance-lite-t2v/estimate-cost');
    expect(muapiEstimateCalls()[0].body).toMatchObject({ prompt, ...params });
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
    expect(JSON.stringify(estimate)).not.toContain(MUAPI_KEY);
  });

  it('ne crée pas de devis exploitable si le coût fournisseur ne peut pas être vérifié', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    state.estimateStatus = 400;
    state.estimateResponse = { message: 'invalid aspect_ratio' };
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: { aspect_ratio: '9:16', duration: 6 }, prompt: 'Autre instruction UGC suffisamment longue pour le devis.',
      param_schema: SEEDANCE_T2V.param_schema,
    }));
    expect(r.status).toBe(200);
    const estimate = await bodyOf(r);
    expect(estimate.pricing_available).toBe(false);
    expect(estimate.credits_cost).toBe(null);
    expect(estimate).not.toHaveProperty('provider_quote_error');
    expect(JSON.stringify(estimate)).not.toContain('invalid aspect_ratio');
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Phase de validation authentifiée : 9 cas demandés, couverts par fixtures.    */
/* Le live (catalog / model-detail / estimate) est consigné dans le rapport ;   */
/* aucun test ci-dessous ne prétend être une mesure réseau réelle.              */
/* -------------------------------------------------------------------------- */

describe('Validation du catalogue et des devis VYORA', () => {
  const PROMPT = 'Publicite UGC verticale de 15 secondes pour un serum cosmetique avec accroche, demonstration et appel a l achat.';

  it('1 · catalogue client : modèles avec identifiants opaques, sans détails fournisseur', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'catalog' }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    expect(calls.some((c) => c.url.includes('/auth/v1/user')
      && c.headers.Authorization === 'Bearer valid-user-jwt')).toBe(true);
    expect(calls.some((c) => c.url === 'https://api.muapi.ai/api/v1/models'
      && c.headers['x-api-key'] === MUAPI_KEY)).toBe(true);
    expect((data.models as Record<string, unknown>[])[0]).toMatchObject({ model_id: PUBLIC_MODEL_ID });
    expect(data.catalog).toMatchObject({ verified: false });
    expect(data.catalog).not.toHaveProperty('source');
    expect(data.catalog).not.toHaveProperty('account');
    expect(JSON.stringify(data)).not.toContain('seedance-lite-t2v');
    expect(JSON.stringify(data)).not.toContain('USD');
    expect(JSON.stringify(data)).not.toContain(MUAPI_KEY);
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('2 · fiche modèle : schéma réel récupéré côté serveur, sans secret ni génération', async () => {
    const r = await videoHandler(post(EDGE_URL, { action: 'model-detail', model_id: PUBLIC_MODEL_ID }));
    expect(r.status).toBe(200);
    const data = await bodyOf(r);
    const model = data.model as Record<string, unknown>;
    const schema = model.param_schema as Record<string, Record<string, unknown>>;
    expect(schema.duration).toMatchObject({ type: 'number', min: 3, max: 12, default: 5 });
    expect(schema.resolution).toMatchObject({ type: 'select', options: ['480p', '720p'] });
    expect(model).not.toHaveProperty('account_access');
    expect(model.model_id).toBe(PUBLIC_MODEL_ID);
    expect(JSON.stringify(data)).not.toContain(MUAPI_KEY);
    expect(JSON.stringify(data)).not.toContain('seedance-lite-t2v');
    expect(muapiSubmits()).toHaveLength(0);
    expect(muapiEstimateCalls()).toHaveLength(0);
  });

  it('3 · devis basé sur le coût fournisseur catalogué, sans détails tarifaires côté client', async () => {
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: { aspect_ratio: '9:16' }, prompt: `${PROMPT} Cas trois.`,
    }));
    const e = await bodyOf(r);
    expect(e).toMatchObject({
      credits_cost: 13, service_active: true, model_available: true,
      pricing_available: true, quote_id: QUOTE_ID, model_id: PUBLIC_MODEL_ID,
    });
    expect(e).not.toHaveProperty('provider_cost_usd');
    expect(JSON.stringify(e)).not.toContain('USD');
    expect(muapiEstimateCalls()).toHaveLength(0);
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
  });

  it('4 · devis dynamique : estimate-cost reçoit les paramètres exacts et calcule les crédits', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    const params = { aspect_ratio: '9:16', resolution: '480p', duration: 5, camera_fixed: false };
    const prompt = `${PROMPT} Cas quatre.`;
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params, prompt, param_schema: SEEDANCE_T2V.param_schema,
    }));
    const e = await bodyOf(r);
    expect(e).toMatchObject({
      credits_cost: 16, model_available: true, pricing_available: true,
      quote_id: QUOTE_ID, model_id: PUBLIC_MODEL_ID,
    });
    expect(e).not.toHaveProperty('provider_cost_usd');
    expect(e).not.toHaveProperty('quote_params');
    expect(muapiEstimateCalls()).toHaveLength(1);
    expect(muapiEstimateCalls()[0].url).toContain('/api/v1/models/seedance-lite-t2v/estimate-cost');
    expect(muapiEstimateCalls()[0].body).toMatchObject({ prompt, ...params });
    expect(JSON.stringify(e)).not.toContain('USD');
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
  });

  it('5 · modèle inaccessible : jamais présenté comme actif ni sélectionnable', async () => {
    state.model = { ...SEEDANCE_T2V, is_coming_soon: true } as unknown as Record<string, unknown>;
    const soon = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
    }));
    const e = await bodyOf(soon);
    expect(e.model_available).toBe(false);
    expect(e.model_status).toBe('coming_soon');
    expect(muapiEstimateCalls()).toHaveLength(0);
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
  });

  it('6 · erreur fournisseur : aucun prix inventé, « devis fournisseur à confirmer »', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    state.estimateStatus = 503;
    state.estimateResponse = { message: 'provider temporarily unavailable' };
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: { aspect_ratio: '9:16' }, prompt: `${PROMPT} Cas six.`,
      param_schema: SEEDANCE_T2V.param_schema,
    }));
    const e = await bodyOf(r);
    expect(e.pricing_available).toBe(false);
    expect(e.credits_cost).toBe(null);
    expect(e.model_available).toBe(true);
    expect(e).not.toHaveProperty('provider_quote_error');
    expect(JSON.stringify(e)).not.toContain('provider temporarily unavailable');
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_start_generation')).toHaveLength(0);
  });

  it('7 · paramètres invalides : options inconnues et champs source écartés, nombre borné', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: {
        aspect_ratio: '42:17', resolution: '480p', duration: 999, camera_fixed: false,
        audio_url: 'https://evil.example/audio.mp3', reference_images: ['https://evil.example/x.png'],
      },
      prompt: `${PROMPT} Cas sept.`, param_schema: SEEDANCE_T2V.param_schema,
    }));
    const response = await bodyOf(r);
    const q = muapiEstimateCalls()[0].body ?? {};
    expect(q.prompt).toContain('Cas sept');
    expect(q.aspect_ratio).toBeUndefined();
    expect(q.resolution).toBe('480p');
    expect(q.duration).toBe(30);
    expect(q.camera_fixed).toBe(false);
    expect(q).not.toHaveProperty('audio_url');
    expect(q).not.toHaveProperty('reference_images');
    expect(response).not.toHaveProperty('quote_params');
    expect(muapiSubmits()).toHaveLength(0);
  });

  it('8 · devis : aucune génération, soumission, claim ni écriture Storage', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    await videoHandler(post(EDGE_URL, { action: 'catalog' }));
    await videoHandler(post(EDGE_URL, { action: 'model-detail', model_id: PUBLIC_MODEL_ID }));
    await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: { aspect_ratio: '9:16' }, prompt: `${PROMPT} Cas huit.`,
    }));
    expect(muapiSubmits()).toHaveLength(0);
    expect(rpcCalls('reelora_claim_generation_submission')).toHaveLength(0);
    expect(rpcCalls('reelora_set_job_processing')).toHaveLength(0);
    expect(rpcCalls('reelora_finalize_generation')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/storage/v1/object/'))).toHaveLength(0);
  });

  it('9 · devis : aucun débit ni réservation, tarif du service inchangé', async () => {
    state.model = DYNAMIC_MODEL as unknown as Record<string, unknown>;
    const r = await videoHandler(post(EDGE_URL, {
      action: 'estimate', service_key: 'ugc_clip_8s', model_id: PUBLIC_MODEL_ID,
      params: { aspect_ratio: '9:16' }, prompt: `${PROMPT} Cas neuf.`,
    }));
    const e = await bodyOf(r);
    expect(e.credits_cost).toBe(16);
    expect(e.service_active).toBe(true);
    const billing = calls.filter((c) => /\/rest\/v1\/rpc\/reelora_(start_generation|consume_quota|reserve_video_quota|apply_wallet_delta|claim_generation_submission|finalize_generation|release_video_quota)/.test(c.url));
    expect(billing).toHaveLength(0);
    expect(calls.some((c) => c.url.includes('ugc_credit_ledger'))).toBe(false);
    expect(calls.some((c) => c.url.includes('ugc_wallets'))).toBe(false);
    expect(muapiSubmits()).toHaveLength(0);
  });
});

describe('UI du Studio avec devis de crédits opaque', () => {
  it('les écrans du Studio utilisent les crédits et ne révèlent pas les tarifs internes', () => {
    const studio = readFileSync(join(process.cwd(), 'src/studio/GenerationStudio.tsx'), 'utf8');
    const promptBar = readFileSync(join(process.cwd(), 'src/studio/components/PromptBar.tsx'), 'utf8');
    const confirm = readFileSync(join(process.cwd(), 'src/studio/components/CostConfirm.tsx'), 'utf8');
    const browser = readFileSync(join(process.cwd(), 'src/studio/components/CatalogBrowser.tsx'), 'utf8');
    expect(studio).toContain('creditSummary');
    expect(studio).not.toContain('providerQuoteOriginLabel');
    expect(promptBar).toContain('creditSummary');
    expect(promptBar).not.toContain('providerQuoteCostLabel');
    expect(confirm).toContain('creditSummary');
    expect(confirm).not.toContain('providerQuoteOriginLabel');
    expect(browser).not.toContain('providerQuoteCostLabel');
    for (const source of [studio, promptBar, confirm, browser]) {
      expect(source).not.toContain('?? 0).toFixed(3)');
      expect(source).not.toMatch(/provider_cost_usd\s*\|\|\s*0/);
      expect(source).not.toMatch(/providerQuote(Cost|Origin)Label/);
    }
  });
});
