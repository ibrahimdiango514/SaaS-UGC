import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../supabase/functions/universal-catalog/index';
const schema = { schemas:{input_data:{type:'object',endpoint_url:'real-route',properties:{prompt:{type:'string',name:'prompt',minLength:2}},required:['prompt']}}};
const model = {provider_model_id:'model',provider_key:'muapi',public_catalog_present:true,detail_status:'ok',input_schema:schema};
let admin = true;
let authoritative: unknown = model;
const calls: string[] = [];
beforeEach(() => {
  admin=true; authoritative=model; calls.length=0;
  vi.stubEnv('SUPABASE_URL','https://db.example'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','server'); vi.stubEnv('SUPABASE_ANON_KEY','anon');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect((init?.headers as Record<string,string>).Authorization).toBe('Bearer user');
    if (url.endsWith('/reelora_admin_overview')) return new Response('{}',{status:admin?200:403});
    if (url.endsWith('/studio_catalog_admin_model_detail')) return Response.json(authoritative);
    throw new Error('Unexpected network request; provider calls are forbidden');
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const request = (params: unknown, extra = {}) => new Request('https://edge.example',{method:'POST',headers:{Authorization:'Bearer user'},body:JSON.stringify({action:'validate_muapi_input',model_id:'model',params,...extra})});
describe('server-side authoritative validation without spending', () => {
  it('uses the stored schema, never a supplied schema or price, and does not echo prompts', async () => {
    const response = await handler(request({prompt:'private prompt'}, {input_schema:{},price:0}));
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toMatchObject({validation:{ok:true,fields:['prompt']},endpoint:{path:'real-route'},executable:false,mode:'validation_only'});
    expect(JSON.stringify(data)).not.toContain('private prompt');
    expect(calls).toHaveLength(2);
  });
  it('refuses non-admins before reading a model', async () => {
    admin=false;
    expect((await handler(request({prompt:'ok'}))).status).toBe(403);
    expect(calls).toHaveLength(1);
  });
  it('returns validation errors without coercing values', async () => {
    expect(await (await handler(request({prompt:2}))).json()).toMatchObject({validation:{ok:false,code:'PARAMETER_INVALID',field:'prompt'}});
    expect(await (await handler(request({}))).json()).toMatchObject({validation:{code:'PARAMETER_REQUIRED'}});
  });
  it('rejects stale, absent or mismatched model details', async () => {
    authoritative={...model,detail_status:'http_error'}; expect((await handler(request({prompt:'ok'}))).status).toBe(409);
    authoritative=null; expect((await handler(request({prompt:'ok'}))).status).toBe(404);
  });
  it('rejects oversized input before making a database or provider call', async () => {
    expect((await handler(request({prompt:'x'.repeat(131073)}))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});
