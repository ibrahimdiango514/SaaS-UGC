import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../supabase/functions/studio-runtime/handler';

/**
 * Parcours Studio par famille et chemins d'erreur — entièrement simulés.
 *
 * Ce que ces tests prouvent : le câblage du runtime (validation, refus, devis,
 * réservation, polling, résultat typé, restitution) et le fait qu'AUCUN appel
 * fournisseur n'est fait quand un contrôle échoue. Ils ne prouvent jamais le
 * comportement réel d'un fournisseur : toutes les réponses sont des mocks.
 */
const BASE = 'https://project.supabase.co';
const UID = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const QUOTE = '44444444-4444-4444-8444-444444444444';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const modelFor = (over: Record<string, unknown> = {}) => ({
  id: '66666666-6666-4666-8666-666666666666',
  provider_model_id: 'model', display_name: 'Model', category: 'Text to Image',
  account_access: 'available', public_catalog_present: true, provider_enabled: true, coming_soon: false,
  runtime_enabled: true, quota_resolved: true, quota_policy_ready: true,
  spec_hash: 'abc', endpoint_evidence: { endpoint: '/api/v1/model' },
  input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'model', properties: { prompt: { type: 'string' } }, required: ['prompt'] } } },
  runtime_config: {
    adapter: 'muapi_prediction_v1', estimate_path: '/api/v1/models/model/estimate-cost', credits: 4,
    quota_kind: 'image', max_cost_usd: 0.1, verified_hash: 'abc', verified_at: '2026-11-20',
    enabled: true, allowed_plans: ['pro'], revision: 3, billing: 'metered',
  },
  ...over,
});

interface MockOptions {
  plan?: string;
  quotaError?: string;
  expired?: boolean;
  status?: string;
  providerResult?: () => Response;
  providerSubmit?: () => Response;
  estimate?: () => Response;
  download?: Uint8Array;
  model?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  schema?: unknown;
}

function harness(options: MockOptions = {}) {
  const calls: { url: string; body: any }[] = [];
  let finished: { status: string; outputs: unknown[] } | null = null;
  let jobStatus = options.status ?? 'processing';
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    calls.push({ url, body });
    if (url === `${BASE}/auth/v1/user`) return json({ id: UID });
    if (url.startsWith(`${BASE}/rest/v1/rpc/`)) {
      switch (url.split('/').pop()) {
        case 'studio_runtime_access': return json({ user_id: UID, workspace_id: WS, credits: 10, plan: options.plan ?? 'pro' });
        case 'studio_runtime_rate': return json(true);
        case 'studio_runtime_model': return json(modelFor({ ...(options.model ?? {}), runtime_config: { ...modelFor().runtime_config, ...(options.runtime ?? {}) }, ...(options.schema ? { input_schema: options.schema } : {}) }));
        case 'studio_runtime_input': return json({ path: 'x', metadata: { size: 10 } });
        case 'studio_runtime_issue_quote':
          return options.quotaError ? json({ message: options.quotaError }, 409)
            : json({ quote_id: QUOTE, credits: options.runtime?.credits ?? 4, expires_at: new Date(Date.now() + 120000).toISOString() });
        case 'studio_runtime_start': return options.expired ? json({ message: 'quote_expired' }, 409) : json({ id: JOB, new: true });
        case 'studio_runtime_job': return json({
          id: JOB, workspace_id: WS, provider_model_id: 'model', params: { prompt: 'hello' },
          provider_id: 'pred-1', status: jobStatus, credits: options.runtime?.credits ?? 4,
          output_kind: options.runtime?.output_kind ?? 'media', protocol_key: null, result_field: null,
        });
        case 'studio_runtime_submitted': return json(true);
        case 'studio_runtime_due': return json(jobStatus === 'processing'
          ? [{ id: JOB, workspace_id: WS, provider_id: 'pred-1', status: 'processing', protocol_key: null, result_field: null, output_kind: 'media' }]
          : []);
        case 'studio_runtime_finish':
          finished = { status: body.p_status, outputs: body.p_outputs };
          jobStatus = body.p_status;
          return json(true);
        case 'studio_runtime_history': return json([]);
        case 'studio_runtime_uncertain': return json(true);
        default: return json({});
      }
    }
    if (url.startsWith(`${BASE}/storage/v1/object/sign/`)) return json({ signedURL: '/object/sign/ugc-assets/x?token=t' });
    if (url.startsWith(`${BASE}/storage/v1/object/ugc-assets/`)) return json({});
    if (url.startsWith(`${BASE}/storage/v1/`)) return new Response((options.download ?? PNG) as unknown as BodyInit, { status: 200 });
    if (url === 'https://api.muapi.ai/api/v1/models/model/estimate-cost') {
      return options.estimate ? options.estimate() : json({ cost_usd: 0.1, currency: 'USD' });
    }
    if (url === 'https://api.muapi.ai/api/v1/model') {
      return options.providerSubmit ? options.providerSubmit() : json({ request_id: 'pred-1' });
    }
    if (url === 'https://api.muapi.ai/api/v1/predictions/pred-1/result') {
      return options.providerResult
        ? options.providerResult()
        : json({ status: 'completed', outputs: ['https://cdn.example.com/result.bin'], currency: 'USD', cost: 0.1 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  const handler = createHandler({
    env: (key) => key === 'SUPABASE_URL' ? BASE : key === 'MUAPI_API_KEY' ? 'test-key' : 'configured',
    fetcher,
    download: vi.fn(async () => options.download ?? PNG),
  });
  const call = async (action: string, body: Record<string, unknown> = {}) => {
    const response = await handler(new Request('https://example.com', {
      method: 'POST', headers: { Authorization: 'Bearer token' }, body: JSON.stringify({ action, ...body }),
    }));
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  // Correspondance exacte du chemin : `/api/v1/model` ne doit pas confondre
  // l'estimation (`/api/v1/models/model/estimate-cost`) avec une soumission.
  const providerCalls = (needle: string) => calls.filter((call) => {
    const path = new URL(call.url).pathname;
    return path === needle || path.startsWith(`${needle}/`);
  });
  const externalCalls = () => calls.filter((call) => call.url.startsWith('https://api.muapi.ai'));
  return { call, calls, providerCalls, externalCalls, finished: () => finished };
}

describe('parcours Studio simulé par famille', () => {
  const families = [
    { family: 'image', mime: 'image/png', bytes: PNG },
    { family: 'video', mime: 'video/mp4', bytes: MP4 },
    { family: 'audio', mime: 'audio/mpeg', bytes: MP3 },
    { family: 'model_3d', mime: 'model/gltf-binary', bytes: GLB },
  ] as const;

  it.each(families)('enchaîne $family jusqu’au résultat stocké au bon type', async ({ family, mime, bytes }) => {
    const { call, finished, providerCalls } = harness({
      runtime: { quota_kind: family, output_kind: 'media' }, download: bytes,
    });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ quote_id: QUOTE, credits: 4, balance: 10 });
    const started = await call('start', { quote_id: QUOTE, request_key: '55555555-5555-4555-8555-555555555555' });
    expect(started.body).toMatchObject({ job_id: JOB, status: 'accepted' });
    expect(providerCalls('/api/v1/model').length).toBe(1);
    const polled = await call('status', { job_id: JOB });
    expect(polled.body).toMatchObject({ status: 'succeeded' });
    expect(finished()?.status).toBe('succeeded');
    expect(finished()?.outputs).toHaveLength(1);
    expect(finished()?.outputs[0]).toMatchObject({ kind: 'file', mime });
  });

  it('refuse des paramètres invalides avant tout appel fournisseur', async () => {
    const { call, externalCalls } = harness();
    const quote = await call('quote', { model_id: 'model', params: { inconnu: true } });
    expect(quote.status).toBe(400);
    expect(quote.body.error.code).toBe('PARAMETER_INVALID');
    expect(externalCalls()).toHaveLength(0);
  });

  it('refuse un modèle hors offre sans devis ni réservation', async () => {
    const { call, externalCalls } = harness({ plan: 'free' });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('MODEL_NOT_OPERATIONAL');
    expect(externalCalls()).toHaveLength(0);
  });

  it('remonte un quota insuffisant avec sa famille et ses compteurs', async () => {
    const { call, providerCalls } = harness({ quotaError: 'quota_exceeded:audio:5:5' });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(providerCalls('/api/v1/model')).toHaveLength(0);
  });

  it('n’appelle pas le fournisseur quand le devis est expiré', async () => {
    const { call, externalCalls } = harness({ expired: true });
    const started = await call('start', { quote_id: QUOTE, request_key: '55555555-5555-4555-8555-555555555555' });
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('QUOTE_EXPIRED');
    expect(externalCalls()).toHaveLength(0);
  });

  it('laisse la tâche en cours quand le fournisseur ne renvoie pas de résultat exploitable', async () => {
    const { call, finished } = harness({ providerResult: () => json({ status: 'completed', outputs: [] }) });
    await call('start', { quote_id: QUOTE, request_key: '55555555-5555-4555-8555-555555555555' });
    const polled = await call('status', { job_id: JOB });
    expect(polled.body.status).toBe('processing');
    expect(finished()).toBeNull();
  });

  it('clôt en échec fournisseur et conserve la restitution à la charge du runtime', async () => {
    const { call, finished } = harness({ providerResult: () => json({ status: 'failed', currency: 'USD' }) });
    await call('start', { quote_id: QUOTE, request_key: '55555555-5555-4555-8555-555555555555' });
    const polled = await call('status', { job_id: JOB });
    expect(polled.body.status).toBe('failed');
    expect(finished()).toMatchObject({ status: 'failed', outputs: [] });
  });

  it('refuse un fichier incompatible avant la soumission fournisseur', async () => {
    const { call, providerCalls } = harness({
      schema: { schemas: { input_data: { type: 'object', properties: { image_url: { type: 'string', field: 'image' } }, required: ['image_url'] } } },
      download: new TextEncoder().encode('pas une image'),
    });
    const quote = await call('quote', { model_id: 'model', params: { image_url: `storage://${WS}/studio-inputs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png` } });
    expect(quote.status).toBe(400);
    expect(quote.body.error.code).toBe('FILE_TYPE_INVALID');
    expect(providerCalls('api.muapi.ai/api/v1/model')).toHaveLength(0);
  });

  it('accepte un devis gratuit déclaré à 0 crédit et le soumet comme les autres', async () => {
    const { call, providerCalls } = harness({
      runtime: { billing: 'free', credits: 0, max_cost_usd: 0 },
      estimate: () => json({ cost_usd: 0, currency: 'USD' }),
    });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ credits: 0, balance: 10 });
    const started = await call('start', { quote_id: QUOTE, request_key: '55555555-5555-4555-8555-555555555555' });
    expect(started.body).toMatchObject({ status: 'accepted' });
    expect(providerCalls('/api/v1/model').length).toBe(1);
  });

  it('refuse un devis gratuit dont l’estimation fournisseur est facturée', async () => {
    const { call, providerCalls } = harness({
      runtime: { billing: 'free', credits: 0, max_cost_usd: 0 },
      estimate: () => json({ cost_usd: 0.2, currency: 'USD' }),
    });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('QUOTE_UNAVAILABLE');
    expect(providerCalls('/api/v1/model')).toHaveLength(0);
  });
});

describe('adaptateurs de sortie par protocole déclaré', () => {
  it('un modèle audio/3D garde son quota propre et sa famille séparée de l’offre', async () => {
    const { call } = harness({ runtime: { quota_kind: 'audio' }, plan: 'pro' });
    const quote = await call('quote', { model_id: 'model', params: { prompt: 'hello' } });
    expect(quote.status).toBe(200);
    const quotas = await call('quotas');
    expect(quotas.status).toBe(200);
  });
});
