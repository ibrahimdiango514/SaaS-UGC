import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../supabase/functions/vyora-ai-providers/index';
const response = (value: unknown) => new Response(JSON.stringify(value), { status:200 });
afterEach(() => { vi.unstubAllGlobals(); for (const key of ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','BUSINESS_GROW_GONKA_API_KEY']) delete process.env[key]; });
describe('catalog_only ne modifie pas le registre actif', () => {
  it('lit le catalogue sans synchroniser, désactiver ou lancer une complétion', async () => {
    process.env.SUPABASE_URL='https://project.test'; process.env.SUPABASE_SERVICE_ROLE_KEY='service'; process.env.BUSINESS_GROW_GONKA_API_KEY='test';
    const fetcher=vi.fn(async (input:string | URL | Request, init?:RequestInit) => {
      const url=String(input);
      if (url.endsWith('/vyora_ai_provider_descriptors')) return response([{ key:'gonka', adapter_kind:'openai', base_url:'https://provider.test/v1', models_url:'https://provider.test/v1/models', api_key_env:'BUSINESS_GROW_GONKA_API_KEY', headers:{} }]);
      if (url==='https://provider.test/v1/models') { expect(init?.method).toBe('GET'); return response({data:[{id:'model-a'}]}); }
      throw Error(`Unexpected mutation or completion: ${url}`);
    }); vi.stubGlobal('fetch',fetcher);
    const result=await handler(new Request('https://local', { method:'POST', headers:{Authorization:'Bearer service','Content-Type':'application/json'}, body:JSON.stringify({action:'probe',catalog_only:true}) }));
    expect(result.status).toBe(200);
    const data=await result.json();
    expect(data.results[0]).toMatchObject({provider:'gonka',status:'catalog_accessible',catalog_models_synced:0,completion_ok:null});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('ne désactive pas non plus un fournisseur sans clé', async () => {
    process.env.SUPABASE_URL='https://project.test'; process.env.SUPABASE_SERVICE_ROLE_KEY='service';
    const fetcher=vi.fn(async () => response([{key:'gonka',api_key_env:'BUSINESS_GROW_GONKA_API_KEY'}])); vi.stubGlobal('fetch',fetcher);
    const result=await handler(new Request('https://local', { method:'POST', headers:{Authorization:'Bearer service','Content-Type':'application/json'}, body:JSON.stringify({action:'probe',catalog_only:true}) }));
    expect(result.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await result.json()).results[0].status).toBe('not_configured');
  });
});
