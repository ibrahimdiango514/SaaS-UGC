import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const core = vi.hoisted(() => ({ runAiCall: vi.fn() }));
vi.mock('../supabase/functions/_shared/ai-core/index.ts', async (importOriginal) => ({ ...await importOriginal<object>(), runAiCall: core.runAiCall }));
import { handler } from '../supabase/functions/vyora-ai/index';
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
const ok = { ok:true, code:null, content:'ok', providerKey:'groq', providerModelKey:'test', estimatedCostUsd:0.123, inputTokens:2, outputTokens:4, attempts:[] };

describe('confidentialité et budget du moteur IA', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL='https://project.example'; process.env.SUPABASE_SERVICE_ROLE_KEY='service'; process.env.SUPABASE_ANON_KEY='anon';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/auth/v1/user')) return json({id:'user'});
      if (url.includes('reelora_consume_quota')) return json({used:1});
      if (url.includes('reelora_refund_quota')) return json(true);
      throw Error(`unexpected request: ${url}`);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); core.runAiCall.mockReset(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_ANON_KEY; });
  const request = (token: string) => new Request('https://local', { method:'POST', headers:{Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, body:JSON.stringify({action:'complete',prompt:'bonjour',role_key:'assistant'}) });
  it('masque le coût aux clients tout en le conservant pour le service interne', async () => {
    core.runAiCall.mockResolvedValue(ok);
    const client = await (await handler(request('jwt'))).json();
    expect(client.content).toBe('ok'); expect(client).not.toHaveProperty('cost_usd');
    const service = await (await handler(request('service'))).json();
    expect(service).toHaveProperty('cost_usd', 0.123);
  });
  it('budget épuisé : pas de fallback vers un autre fournisseur, quota remboursé', async () => {
    core.runAiCall.mockResolvedValue({ ...ok, ok:false, code:'BUDGET_EXHAUSTED', content:null, attempts:[] });
    const res = await handler(request('jwt')); const body = await res.json();
    expect(res.status).toBe(502); expect(body.error.code).toBe('AI_BUDGET_EXHAUSTED');
    expect(core.runAiCall).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('reelora_refund_quota'))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('https://project.example/'))).toBe(true);
  });
  it('ne renvoie pas des erreurs fournisseur brutes susceptibles de contenir des coûts', async () => {
    core.runAiCall.mockRejectedValue(Error('vendor raw cost $123'));
    const res = await handler(request('jwt')); const text = await res.text();
    expect(text).not.toContain('123'); expect(text).not.toContain('vendor raw');
  });
});
