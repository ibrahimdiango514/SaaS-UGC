import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMuapiDetail } from '../supabase/functions/universal-catalog/details';
import { handler } from '../supabase/functions/universal-catalog/index';
const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const detail = { name: 'creatify-lipsync', input_schema: { schemas: { input_data: { type: 'object', properties: { video_url: { type: 'string' }, audio_url: { type: 'string' } }, required: ['video_url','audio_url'] } } }, output_schema: { schemas: {} }, cost: 10 };

describe('fiches MuAPI, récupération en lecture seule', () => {
  it('lit les schémas exacts sans conserver le prix ni appeler la génération', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { expect(init?.method).toBe('GET'); return response(detail); });
    const result = await fetchMuapiDetail(fetcher, 'creatify-lipsync');
    expect(result.status).toBe('ok'); expect(result.input_schema).toEqual(detail.input_schema);
    expect(JSON.stringify(result)).not.toContain('cost');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.muapi.ai/api/v1/models/creatify-lipsync');
  });
  it('refuse mauvais identifiant, schéma absent et échec réseau', async () => {
    const fetcher = vi.fn(async () => response(detail));
    expect((await fetchMuapiDetail(fetcher, '../bad')).status).toBe('invalid'); expect(fetcher).not.toHaveBeenCalled();
    expect((await fetchMuapiDetail(async () => response({ name: 'a' }), 'a')).status).toBe('invalid');
    expect((await fetchMuapiDetail(async () => response({}, 404), 'a')).status).toBe('http_error');
    expect((await fetchMuapiDetail(async () => { throw Error('timeout'); }, 'a')).status).toBe('network_error');
  });
});

describe('sync fiches administrateur', () => {
  beforeEach(() => { process.env.SUPABASE_URL='https://project.example'; process.env.SUPABASE_SERVICE_ROLE_KEY='service'; process.env.SUPABASE_ANON_KEY='anon'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_ANON_KEY; });
  const request = (extra = {}) => new Request('https://local', { method:'POST', headers:{ Authorization:'Bearer jwt','Content-Type':'application/json' }, body:JSON.stringify({action:'sync_muapi_details',...extra}) });
  it('refuse un non-admin avant tout accès au catalogue ou fournisseur', async () => {
    const fetcher = vi.fn(async () => response({},403)); vi.stubGlobal('fetch',fetcher);
    expect((await handler(request())).status).toBe(403); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('ne récupère que des modèles déjà présents en base, en lots limités', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('reelora_admin_overview')) return response({});
      if (url.endsWith('studio_muapi_detail_candidates')) return response([{provider_model_id:'creatify-lipsync'}]);
      if (url === 'https://api.muapi.ai/api/v1/models/creatify-lipsync') return response(detail);
      if (url.endsWith('studio_save_muapi_detail')) { expect(JSON.parse(String(init?.body))).not.toHaveProperty('cost'); return response(true); }
      throw Error('unexpected');
    }); vi.stubGlobal('fetch',fetcher);
    const result = await handler(request()); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ attempted:1, ok:1, persist_error:0 });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('refuse un lot excessif avant appel réseau', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
    expect((await handler(request({limit:11}))).status).toBe(400); expect(fetcher).not.toHaveBeenCalled();
  });
});
