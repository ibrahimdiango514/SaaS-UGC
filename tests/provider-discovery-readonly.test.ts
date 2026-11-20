import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../supabase/functions/vyora-provider-discovery/index';
const token = 'test-token-012345678901234567890123456789';
const request = (auth: string) => new Request('https://local', { method:'POST', headers:{ Authorization:`Bearer ${auth}` }, body:'{}' });
afterEach(() => { vi.unstubAllGlobals(); for (const key of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','BUSINESS_GROW_GROQ_API_KEY','BUSINESS_GROW_GEMINI_API_KEY','MUAPI_API_KEY']) delete process.env[key]; });
describe('découverte fournisseurs en lecture seule', () => {
  it('refuse un token invalide avant tout appel fournisseur', async () => {
    process.env.SUPABASE_URL='https://project.test'; process.env.SUPABASE_SERVICE_ROLE_KEY='service';
    const fetcher=vi.fn(async () => new Response(JSON.stringify(token))); vi.stubGlobal('fetch',fetcher);
    expect((await handler(request('wrong-token-0123456789012345678901234567'))).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('teste aussi le catalogue du compte MuAPI sans exposer la clé', async () => {
    process.env.SUPABASE_URL='https://project.test'; process.env.SUPABASE_SERVICE_ROLE_KEY='service'; process.env.MUAPI_API_KEY='muapi-test-secret';
    const fetcher=vi.fn(async (input:string | URL | Request, init?:RequestInit) => {
      if (String(input).endsWith('/vyora_provider_health_cron_token')) return new Response(JSON.stringify(token));
      expect(init?.method).toBe('GET');
      if (String(input).includes('api.muapi.ai') && (init?.headers as Record<string,string>)['x-api-key']) expect((init?.headers as Record<string,string>)['x-api-key']).toBe('muapi-test-secret');
      return new Response(JSON.stringify({models:[{name:'example',price:42}]}));
    }); vi.stubGlobal('fetch',fetcher);
    const data=await (await handler(request(token))).json();
    expect(data.results.find((r: {provider:string}) => r.provider === 'muapi_account')).toMatchObject({status:'catalog_accessible',models_on_first_page:1,completeness:'unverified'});
    expect(JSON.stringify(data)).not.toMatch(/muapi-test-secret|price/);
  });
  it('ne fait que des GET fournisseurs et ne renvoie ni clés ni prix', async () => {
    process.env.SUPABASE_URL='https://project.test'; process.env.SUPABASE_SERVICE_ROLE_KEY='service';
    process.env.BUSINESS_GROW_GROQ_API_KEY='test-groq-key'; process.env.BUSINESS_GROW_GEMINI_API_KEY='test-gemini-key';
    const fetcher=vi.fn(async (input:string | URL | Request, init?:RequestInit) => {
      const url=String(input);
      if (url.endsWith('/vyora_provider_health_cron_token')) { expect(init?.method).toBe('POST'); return new Response(JSON.stringify(token)); }
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error');
      if (url.includes('generativelanguage')) return new Response(JSON.stringify({ models:[{name:'a',price:10}] }));
      return new Response(JSON.stringify({ data:[{id:'a',price:10}], models:[{name:'a',price:10}] }));
    }); vi.stubGlobal('fetch',fetcher);
    const response=await handler(request(token)); const data=await response.json();
    expect(response.status).toBe(200); expect(data).toMatchObject({mode:'read_only',generated:false,persisted:false});
    expect(data.results.find((r: { provider:string })=>r.provider==='groq')).toMatchObject({status:'catalog_accessible',models_on_first_page:1,completeness:'unverified'});
    expect(data.results.find((r: { provider:string })=>r.provider==='cloudflare').status).toBe('not_configured');
    expect(JSON.stringify(data)).not.toMatch(/test-groq-key|test-gemini-key|price|test-token/);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
