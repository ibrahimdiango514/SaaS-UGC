import { describe, expect, it, vi } from 'vitest';
import { createHandler } from '../supabase/functions/studio-runtime/handler';

/**
 * Robustesse du runtime : réponses fournisseur incorrectes, double soumission,
 * résultat hostile, accès non autorisé. Aucun test ne soumet de génération
 * réelle : le fournisseur est toujours simulé, mais les chemins testés sont
 * ceux du code de production.
 */

const UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const JOB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const QUOTE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const model = {
  provider_model_id: 'model', display_name: 'Model', category: 'Text to Image',
  account_access: 'available', public_catalog_present: true, provider_enabled: true, coming_soon: false,
  runtime_enabled: true, spec_hash: 'hash', quota_resolved: true, quota_policy_ready: true,
  endpoint_evidence: { resolution: { status: 'resolved', path: 'model' } },
  input_schema: { schemas: { input_data: { type: 'object', endpoint_url: 'model', required: ['prompt'], properties: { prompt: { type: 'string' } } } } },
  output_schema: { schemas: { properties: { id: { type: 'string' }, status: { type: 'string' }, output: { type: 'object', properties: {
    id: { type: 'string' }, status: { type: 'string' }, outputs: { type: 'array', items: { type: 'string', format: 'uri' } },
  } } } } },
  runtime_config: {
    adapter: 'muapi_prediction_v1', estimate_path: '/api/v1/models/model/estimate-cost',
    credits: 4, quota_kind: 'image', max_cost_usd: 0.1, verified_hash: 'hash', verified_at: '2026-11-20',
    enabled: true, allowed_plans: ['pro'],
  },
};

const recordCalls = () => {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  return { calls, push: (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
  } };
};

describe('réponses fournisseur incorrectes pendant le suivi', () => {
  const poll = async (result: () => Response | Promise<Response>) => {
    const { calls, push } = recordCalls();
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url); push(target, init);
      if (target.endsWith('/rpc/reelora_worker_token')) return Response.json('worker');
      if (target.endsWith('/rpc/studio_runtime_due')) return Response.json([{ id: 'job', provider_id: 'pred', protocol_key: 'muapi_output_json_v1', output_kind: 'text' }]);
      if (target.includes('/api/v1/predictions/pred/result')) return result();
      if (target.endsWith('/rpc/studio_runtime_finish')) return Response.json(true);
      throw new Error(`unexpected ${target}`);
    });
    const handler = createHandler({ env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'configured', fetcher, download: vi.fn() });
    const response = await handler(new Request('https://example.com', { method: 'POST', headers: { 'x-reelora-worker-token': 'worker' }, body: '{"action":"worker","task":"poll"}' }));
    return { response, body: await response.json(), calls };
  };

  const finished = (calls: Array<{ url: string }>) => calls.some((call) => call.url.endsWith('/rpc/studio_runtime_finish'));

  it('un délai fournisseur laisse le job réessayable, sans fin ni nouvelle soumission', async () => {
    const { response, body, calls } = await poll(() => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ checked: 1, reconciled: 0 });
    expect(finished(calls)).toBe(false);
    expect(calls.every((call) => !call.url.includes('api.muapi.ai') || call.method === 'GET')).toBe(true);
  });

  it('une erreur HTTP laisse le job réessayable', async () => {
    const { body, calls } = await poll(() => new Response('{}', { status: 503 }));
    expect(body.reconciled).toBe(0);
    expect(finished(calls)).toBe(false);
  });

  it('un corps non JSON, vide ou d’un autre type n’est jamais un succès', async () => {
    for (const response of [() => new Response('boom', { status: 200 }), () => new Response('', { status: 200 }), () => Response.json([1, 2])]) {
      const { body, calls } = await poll(response);
      expect(body.reconciled).toBe(0);
      expect(finished(calls)).toBe(false);
    }
  });

  it('une donnée hostile ou d’un autre identifiant n’est jamais enregistrée', async () => {
    const hostile = await poll(() => Response.json({ id: 'pred', status: 'completed', result: { blob: 'é'.repeat(65536) } }));
    expect(hostile.body.reconciled).toBe(0);
    expect(finished(hostile.calls)).toBe(false);
    const mismatch = await poll(() => Response.json({ id: 'other', status: 'completed', result: { ok: true } }));
    expect(mismatch.body.reconciled).toBe(0);
    expect(finished(mismatch.calls)).toBe(false);
    const deep = await poll(() => {
      let nested: unknown = 1;
      for (let index = 0; index < 30; index += 1) nested = { child: nested };
      return Response.json({ id: 'pred', status: 'completed', result: nested });
    });
    expect(deep.body.reconciled).toBe(0);
  });

  it('une donnée déclarée valide est enregistrée en texte borné', async () => {
    const { body, calls } = await poll(() => Response.json({ id: 'pred', status: 'completed', result: { score: 0.9 } }));
    expect(body).toMatchObject({ checked: 1, reconciled: 1 });
    const finish = calls.find((call) => call.url.endsWith('/rpc/studio_runtime_finish'));
    expect(finish?.body).toMatchObject({ p_status: 'succeeded', p_outputs: [{ kind: 'text', text: '{"score":0.9}' }] });
  });
});

describe('double soumission et accès non autorisé', () => {
  const startHandler = (started: boolean) => {
    const { calls, push } = recordCalls();
    let submits = 0;
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url); push(target, init);
      if (target.endsWith('/auth/v1/user')) return Response.json({ id: UID });
      if (target.endsWith('/rpc/studio_runtime_access')) return Response.json({ plan: 'pro', credits: 100, workspace_id: UID });
      if (target.endsWith('/rpc/studio_runtime_rate')) return Response.json(true);
      if (target.endsWith('/rpc/studio_runtime_start')) return Response.json({ id: JOB, new: started });
      if (target.endsWith('/rpc/studio_runtime_job')) return Response.json({ id: JOB, provider_model_id: 'model', params: { prompt: 'x' }, workspace_id: UID });
      if (target.endsWith('/rpc/studio_runtime_model')) return Response.json(model);
      if (target.endsWith('/rpc/studio_runtime_submitted')) return Response.json(true);
      if (target === 'https://api.muapi.ai/api/v1/model') { submits += 1; return Response.json({ request_id: 'pred' }); }
      throw new Error(`unexpected ${target}`);
    });
    const handler = createHandler({ env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'key', fetcher, download: vi.fn() });
    const send = () => handler(new Request('https://example.com', {
      method: 'POST', headers: { Authorization: `Bearer ${UID}` },
      body: JSON.stringify({ action: 'start', quote_id: QUOTE, request_key: REQUEST }),
    }));
    return { send, calls, submits: () => submits };
  };

  it('une même demande rejouée ne soumet le fournisseur qu’une fois', async () => {
    const first = startHandler(true);
    expect((await first.send()).status).toBe(200);
    expect(first.submits()).toBe(1);
    const replay = startHandler(false);
    expect((await replay.send()).status).toBe(200);
    expect((await replay.send()).status).toBe(200);
    expect(replay.submits()).toBe(0);
    expect(replay.calls.some((call) => call.method === 'POST' && call.url.includes('api.muapi.ai'))).toBe(false);
  });

  it('refuse une action externe sans session, sans appeler aucune RPC', async () => {
    const fetcher = vi.fn();
    const handler = createHandler({ env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'configured', fetcher, download: vi.fn() });
    const response = await handler(new Request('https://example.com', {
      method: 'POST', body: JSON.stringify({ action: 'external_confirm', action_id: JOB, confirm: true, note: 'ok' }),
    }));
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('valide les identifiants des actions externes avant toute RPC', async () => {
    const fetcher = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: UID });
      throw new Error('unexpected');
    });
    const handler = createHandler({ env: (key) => key === 'SUPABASE_URL' ? 'https://project.supabase.co' : 'configured', fetcher, download: vi.fn() });
    const response = await handler(new Request('https://example.com', {
      method: 'POST', headers: { Authorization: `Bearer ${UID}` },
      body: JSON.stringify({ action: 'external_confirm', action_id: '../../metadata', confirm: true }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_REQUEST');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
