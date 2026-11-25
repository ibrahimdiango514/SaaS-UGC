import { describe, expect, it, vi } from 'vitest';
import { isHttpsInput, validateMuapiInput, declaredExternalLink } from '../supabase/functions/universal-catalog/schema';
import { createHandler } from '../supabase/functions/studio-runtime/handler';

/**
 * Un champ déclaré « public URL » est un LIEN, pas un fichier : il n'est ni
 * signé, ni téléversé, ni TÉLÉCHARGÉ. Il doit malgré tout rester impossible
 * d'atteindre une IP privée, un service interne ou une adresse déguisée (SSRF).
 */

const PUBLIC = [
  'https://cdn.example.com/train.zip',
  'https://api.muapi.ai/files/out.png',
  'https://bucket.s3.eu-west-1.amazonaws.com/a/b?sig=1',
  'https://sub.domain.co.uk/path%20with%20space',
];
const PRIVATE = [
  'http://cdn.example.com/a.zip',
  'https://127.0.0.1/a.zip',
  'https://127.1/a.zip',
  'https://0x7f000001/a.zip',
  'https://2130706433/a.zip',
  'https://10.0.0.5/a.zip',
  'https://172.16.4.2/a.zip',
  'https://192.168.1.10/a.zip',
  'https://169.254.169.254/latest/meta-data',
  'https://100.64.0.1/a.zip',
  'https://[::1]/a.zip',
  'https://[fd00::1]/a.zip',
  'https://localhost/a.zip',
  'https://metadata.google.internal/a.zip',
  'https://service.local/a.zip',
  'https://printer.lan/a.zip',
  'https://thing.home.arpa/a.zip',
  'https://foo.test/a.zip',
  'https://user:pass@cdn.example.com/a.zip',
  'https://cdn.example.com:8443/a.zip',
  'https://intranet/a.zip',
  'ftp://cdn.example.com/a.zip',
  'https://cdn.example.com./a.zip'.replace('cdn.example.com.', 'localhost.'),
];

describe('lien public HTTPS', () => {
  it('accepte les liens publics', () => {
    for (const url of PUBLIC) expect(isHttpsInput(url), url).toBe(true);
  });

  it('refuse IP privées, adresses déguisées, domaines internes, identifiants et ports', () => {
    for (const url of PRIVATE) expect(isHttpsInput(url), url).toBe(false);
  });

  it('reste appliqué par la validation serveur du schéma', () => {
    const schema = { schemas: { input_data: { type: 'object', required: ['dataset'], properties: {
      dataset: { type: 'string', field: 'zip', description: 'Public URL to a .zip archive.' },
    } } } };
    expect(validateMuapiInput(schema, { dataset: 'https://cdn.example.com/train.zip' }).ok).toBe(true);
    for (const url of ['https://169.254.169.254/x.zip', 'https://cdn.example.com:22/x.zip', 'http://cdn.example.com/x.zip']) {
      expect(validateMuapiInput(schema, { dataset: url }).ok, url).toBe(false);
    }
  });

  it('ne transforme jamais un exemple HTTPS en lien public', () => {
    expect(declaredExternalLink({ type: 'string', field: 'image', examples: ['https://cdn.example.com/a.png'] })).toBe(false);
    expect(declaredExternalLink({ type: 'string', field: 'zip', description: 'Public URL to a .zip archive.' })).toBe(true);
  });
});

describe('un lien public n’est jamais ouvert par le serveur', () => {
  const QUOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const MODEL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const model = {
    provider_model_id: 'trainer',
    category: 'Training',
    display_name: 'Trainer',
    account_access: 'available',
    public_catalog_present: true,
    provider_enabled: true,
    coming_soon: false,
    runtime_enabled: true,
    spec_hash: 'hash',
    endpoint_evidence: { resolution: { status: 'resolved', path: 'trainer' } },
    input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'trainer', required: ['dataset'], properties: {
      dataset: { type: 'string', field: 'zip', description: 'Public URL to a .zip archive.' },
    } } } },
    output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' },
      output: { type: 'object', properties: { lora_url: { type: 'string', format: 'uri' } } } } } },
    runtime_config: {
      adapter: 'muapi_prediction_v1', estimate_path: '/api/v1/models/trainer/estimate-cost',
      credits: 5, quota_kind: 'lora', max_cost_usd: 0.1, verified_hash: 'hash', verified_at: '2026-11-20',
      enabled: true, allowed_plans: ['pro'],
    },
    quota_resolved: true,
    quota_policy_ready: true,
  };

  const handlerFor = (params: Record<string, unknown>) => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      calls.push(`${init?.method ?? 'GET'} ${target}`);
      if (target.endsWith('/auth/v1/user')) return Response.json({ id: UID });
      if (target.endsWith('/rpc/studio_runtime_access')) return Response.json({ plan: 'pro', credits: 100, workspace_id: WS });
      if (target.endsWith('/rpc/studio_runtime_rate')) return Response.json(true);
      if (target.endsWith('/rpc/studio_runtime_model')) return Response.json(model);
      if (target.endsWith('/estimate-cost')) return Response.json({ cost: 0.02, currency: 'USD' });
      if (target.endsWith('/rpc/studio_runtime_issue_quote')) return Response.json({ quote_id: QUOTE, credits: 5, expires_at: '2099-01-01T00:00:00Z' });
      throw new Error(`unexpected ${target}`);
    });
    const handler = createHandler({
      env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'configured',
      fetcher, download: vi.fn(),
    });
    const request = new Request('https://example.com', {
      method: 'POST', headers: { Authorization: `Bearer ${UID}` },
      body: JSON.stringify({ action: 'quote', model_id: MODEL, params }),
    });
    return { handler, request, calls };
  };

  it('transmet le lien au devis sans jamais le requêter', async () => {
    const { handler, request, calls } = handlerFor({ dataset: 'https://cdn.example.com/train.zip' });
    const response = await handler(request);
    expect(response.status).toBe(200);
    expect(calls.some((call) => call.includes('cdn.example.com'))).toBe(false);
    expect(calls.some((call) => call.includes('api.muapi.ai'))).toBe(true);
    expect(calls.every((call) => !call.startsWith('GET https://cdn'))).toBe(true);
  });

  it('refuse un lien interne avant tout appel fournisseur', async () => {
    const { handler, request, calls } = handlerFor({ dataset: 'https://169.254.169.254/train.zip' });
    const response = await handler(request);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('PARAMETER_INVALID');
    expect(calls.some((call) => call.includes('169.254.169.254'))).toBe(false);
    expect(calls.some((call) => call.includes('estimate-cost'))).toBe(false);
  });

  it('exige toujours un import privé quand le champ n’est pas déclaré public', async () => {
    const privateModel = {
      ...model,
      input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'trainer', required: ['dataset'], properties: {
        dataset: { type: 'string', field: 'zip', description: 'ZIP archive of training images.' },
      } } } },
    };
    const fetcher = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target.endsWith('/auth/v1/user')) return Response.json({ id: UID });
      if (target.endsWith('/rpc/studio_runtime_access')) return Response.json({ plan: 'pro', credits: 100, workspace_id: WS });
      if (target.endsWith('/rpc/studio_runtime_rate')) return Response.json(true);
      if (target.endsWith('/rpc/studio_runtime_model')) return Response.json(privateModel);
      throw new Error(`unexpected ${target}`);
    });
    const handler = createHandler({
      env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'configured',
      fetcher, download: vi.fn(),
    });
    const response = await handler(new Request('https://example.com', {
      method: 'POST', headers: { Authorization: `Bearer ${UID}` },
      body: JSON.stringify({ action: 'quote', model_id: MODEL, params: { dataset: 'https://cdn.example.com/train.zip' } }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('PRIVATE_UPLOAD_REQUIRED');
  });
});
