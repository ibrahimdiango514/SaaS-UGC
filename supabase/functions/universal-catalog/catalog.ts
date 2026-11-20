/** Catalog ingestion only: no inference, pricing changes or user credits. */
export type JsonObject = Record<string, unknown>;
export interface CatalogModel {
  provider_model_id: string;
  display_name: string;
  category: string;
  description: string | null;
  input_fields: string[];
  required_fields: string[];
  input_schema: JsonObject | null;
  output_schema: JsonObject | null;
  provider_enabled: boolean | null;
  coming_soon: boolean | null;
  metadata: JsonObject;
}
export interface CatalogSnapshot { models: CatalogModel[]; total: number; pages: number; scope: 'public' | 'account'; }

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const BASE = 'https://api.muapi.ai';
const PATH = '/api/v1/models';
const MAX_PAGES = 1000;
const MAX_MODELS = 50000;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const bool = (value: unknown): boolean | null => value === true || value === 1 ? true : value === false || value === 0 ? false : null;

/** Whitelist metadata: never persist supplier prices, secrets, headers or arbitrary endpoints. */
export function normalizeMuapiModel(raw: unknown): CatalogModel {
  const r = object(raw);
  const id = typeof r.name === 'string' ? r.name.trim() : '';
  if (!/^[A-Za-z0-9._~-]{1,160}$/.test(id)) throw new Error('CATALOG_INVALID_MODEL_ID');
  if (!Array.isArray(r.input_fields) || !Array.isArray(r.required_fields) ||
      strings(r.input_fields).length !== r.input_fields.length || strings(r.required_fields).length !== r.required_fields.length) throw new Error('CATALOG_INVALID_FIELDS');
  const metadata: JsonObject = {};
  for (const key of ['family', 'group_of', 'domain', 'dynamic_pricing']) {
    if (typeof r[key] === 'string' || typeof r[key] === 'boolean') metadata[key] = r[key];
  }
  return {
    provider_model_id: id,
    display_name: typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name.trim().slice(0, 200) : id,
    category: typeof r.category === 'string' && r.category.trim() ? r.category.trim().slice(0, 100) : 'other',
    description: typeof r.description === 'string' ? r.description.slice(0, 4000) : null,
    input_fields: strings(r.input_fields), required_fields: strings(r.required_fields),
    input_schema: r.input_schema && typeof r.input_schema === 'object' && !Array.isArray(r.input_schema) ? object(r.input_schema) : null,
    output_schema: r.output_schema && typeof r.output_schema === 'object' && !Array.isArray(r.output_schema) ? object(r.output_schema) : null,
    provider_enabled: bool(r.is_enabled), coming_soon: bool(r.is_coming_soon), metadata,
  };
}

/** Follow only explicit next links on the MuAPI models endpoint. Reject incomplete snapshots. */
export async function fetchMuapiCatalog(fetcher: Fetcher, apiKey?: string): Promise<CatalogSnapshot> {
  let url: string | null = BASE + PATH;
  const visited = new Set<string>();
  const byId = new Map<string, CatalogModel>();
  let expected: number | null = null;
  let pages = 0;
  let rawCount = 0;
  let explicitEnd = false;
  while (url) {
    if (visited.has(url) || pages >= MAX_PAGES) throw new Error('CATALOG_PAGINATION_LOOP');
    visited.add(url);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`CATALOG_HTTP_${response.status}`);
    const root = object(await response.json());
    const data = Array.isArray(root.models) ? root : object(root.data);
    if (!Array.isArray(data.models)) throw new Error('CATALOG_INVALID_RESPONSE');
    const total = data.total ?? root.total;
    if (total !== undefined && total !== null) {
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 1 || total > MAX_MODELS) throw new Error('CATALOG_INVALID_TOTAL');
      if (expected !== null && total !== expected) throw new Error('CATALOG_TOTAL_CHANGED');
      expected = total;
    }
    for (const entry of data.models) {
      const model = normalizeMuapiModel(entry);
      rawCount++;
      const previous = byId.get(model.provider_model_id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(model)) throw new Error('CATALOG_CONFLICTING_MODEL');
      byId.set(model.provider_model_id, model);
      if (byId.size > MAX_MODELS) throw new Error('CATALOG_TOO_LARGE');
    }
    pages++;
    const pagination = object(data.pagination ?? root.pagination);
    const hasNext = Object.prototype.hasOwnProperty.call(data, 'next') || Object.prototype.hasOwnProperty.call(root, 'next') || Object.prototype.hasOwnProperty.call(pagination, 'next');
    const next = data.next ?? root.next ?? pagination.next;
    if (next === null || next === undefined || next === '') {
      explicitEnd = hasNext;
      url = null;
    } else {
      if (typeof next !== 'string') throw new Error('CATALOG_INVALID_NEXT');
      const nextUrl: URL = new URL(next, url);
      if (nextUrl.origin !== BASE || nextUrl.pathname !== PATH || nextUrl.username || nextUrl.password || nextUrl.hash) throw new Error('CATALOG_UNSAFE_NEXT');
      url = nextUrl.toString();
    }
  }
  if (!byId.size || (expected !== null && rawCount !== expected) || (expected === null && !explicitEnd)) throw new Error('CATALOG_INCOMPLETE');
  return { models: [...byId.values()], total: byId.size, pages, scope: apiKey ? 'account' : 'public' };
}
