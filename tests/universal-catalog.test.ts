import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMuapiCatalog } from '../supabase/functions/universal-catalog/catalog';
import { handler } from '../supabase/functions/universal-catalog/index';
const item = (name: string, category = 'Text to Image') => ({ name, category, input_fields: ['prompt'], required_fields: ['prompt'], is_enabled: 1, cost: 12, api_key: 'secret' });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('catalogue universel MuAPI', () => {
  it('traite 861 entrées de toutes catégories et ne copie ni coût ni secret', async () => {
    const models = Array.from({ length: 861 }, (_, i) => item(`model-${i}`, i < 415 ? 'Text to Video' : 'Text to Image'));
    const fetcher = vi.fn(async () => response({ total: 861, models }));
    const result = await fetchMuapiCatalog(fetcher);
    expect(result.models).toHaveLength(861);
    expect(result.models[860].category).toBe('Text to Image');
    expect(JSON.stringify(result)).not.toMatch(/cost|secret|api_key/);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it('suit les pages explicites et déduplique les doublons identiques', async () => {
    const fetcher = vi.fn(async (url: string) => response(url.includes('page=2')
      ? { total: 3, models: [item('b'), item('a')], next: null }
      : { total: 3, models: [item('a')], next: '?page=2' }));
    const result = await fetchMuapiCatalog(fetcher);
    expect(result.models.map(m => m.provider_model_id)).toEqual(['a', 'b']);
    expect(result.pages).toBe(2);
  });
  it('refuse snapshot incomplet, doublon contradictoire, boucle et lien étranger', async () => {
    await expect(fetchMuapiCatalog(async () => response({ total: 2, models: [item('a')] }))).rejects.toThrow('CATALOG_INCOMPLETE');
    await expect(fetchMuapiCatalog(async () => response({ total: 2, models: [item('a'), item('a', 'other')] }))).rejects.toThrow('CATALOG_CONFLICTING_MODEL');
    await expect(fetchMuapiCatalog(async () => response({ models: [item('a')], next: 'https://evil.example/api/v1/models' }))).rejects.toThrow('CATALOG_UNSAFE_NEXT');
    await expect(fetchMuapiCatalog(async () => response({ models: [item('a')], next: '/api/v1/models' }))).rejects.toThrow('CATALOG_PAGINATION_LOOP');
    await expect(fetchMuapiCatalog(async () => response({ models: [item('a')] }))).rejects.toThrow('CATALOG_INCOMPLETE');
  });
});

describe('synchronisation administrateur', () => {
  beforeEach(() => { process.env.SUPABASE_URL = 'https://project.example'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'; process.env.SUPABASE_ANON_KEY = 'anon'; });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_ANON_KEY; });
  const request = () => new Request('https://local', { method: 'POST', headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync_muapi' }) });
  it('refuse les non-administrateurs avant tout appel fournisseur', async () => {
    const fetcher = vi.fn(async () => response({}, 403)); vi.stubGlobal('fetch', fetcher);
    expect((await handler(request())).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('enregistre seulement après récupération complète, sans génération', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('reelora_admin_overview')) return response({});
      if (url.startsWith('https://api.muapi.ai/')) { expect(init?.method).toBe('GET'); return response({ total: 1, models: [item('a')] }); }
      if (url.endsWith('studio_sync_muapi_catalog')) return response({ total: 1, added: 1 });
      throw Error('unexpected request');
    });
    vi.stubGlobal('fetch', fetcher);
    const res = await handler(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fetched: 1, scope: 'public' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('ne persiste pas un catalogue incomplet', async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith('reelora_admin_overview') ? response({}) : response({ total: 3, models: [item('a')] }));
    vi.stubGlobal('fetch', fetcher);
    expect((await handler(request())).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
