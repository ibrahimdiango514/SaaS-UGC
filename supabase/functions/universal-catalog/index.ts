/** Admin-only catalog ingestion. No generation, credit or billing operations. */
import { fetchMuapiCatalog } from './catalog.ts';
import { fetchMuapiDetail } from './details.ts';
import { validateMuapiInput } from './schema.ts';
import { resolveMuapiEndpoint } from './endpoint.ts';

type Json = Record<string, unknown>;
const env = (key: string): string => (globalThis as unknown as { Deno?: { env?: { get?: (k: string) => string | undefined } }; process?: { env?: Record<string, string | undefined> } }).Deno?.env?.get?.(key) ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key] ?? '';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const jwt = req.headers.get('Authorization') ?? '';
  if (!jwt.startsWith('Bearer ')) return json({ error: 'UNAUTHENTICATED' }, 401);
  const base = env('SUPABASE_URL'); const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY'); const anon = env('SUPABASE_ANON_KEY');
  if (!base || !serviceKey || !anon) return json({ error: 'SERVER_NOT_CONFIGURED' }, 503);
  let body: Json;
  try { const text = await req.text(); if (text.length > 131072) return json({ error: 'BODY_TOO_LARGE' }, 413); body = JSON.parse(text) as Json; } catch { return json({ error: 'INVALID_BODY' }, 400); }
  if (!body || !['sync_muapi', 'sync_muapi_details', 'validate_muapi_input'].includes(String(body.action)) || (body.scope !== undefined && body.scope !== 'public')) return json({ error: 'INVALID_ACTION' }, 400);
  const limit = body.limit === undefined ? 5 : body.limit;
  if (body.action === 'sync_muapi_details' && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10)) return json({ error: 'INVALID_LIMIT' }, 400);
  try {
    // Existing admin gate validates the user's JWT and role in the database.
    const admin = await fetch(`${base}/rest/v1/rpc/reelora_admin_overview`, {
      method: 'POST', headers: { apikey: anon, Authorization: jwt, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000),
    });
    if (!admin.ok) return json({ error: 'FORBIDDEN' }, 403);
    if (body.action === 'validate_muapi_input') {
      if (typeof body.model_id !== 'string' || !/^[A-Za-z0-9._~-]{1,160}$/.test(body.model_id)) return json({ error: 'INVALID_MODEL' }, 400);
      // Read authoritative schema using the caller's JWT, not a submitted schema.
      const response = await fetch(`${base}/rest/v1/rpc/studio_catalog_admin_model_detail`, {
        method: 'POST', headers: { apikey: anon, Authorization: jwt, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_model_id: body.model_id }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) return json({ error: 'MODEL_READ_FAILED' }, 503);
      const model = await response.json();
      if (!model || model.provider_model_id !== body.model_id || model.provider_key !== 'muapi') return json({ error: 'MODEL_NOT_FOUND' }, 404);
      if (!model.public_catalog_present || model.detail_status !== 'ok') return json({ error: 'MODEL_DETAIL_UNVERIFIED' }, 409);
      const validation = validateMuapiInput(model.input_schema, body.params);
      const endpoint = resolveMuapiEndpoint(body.model_id, model.input_schema, model.endpoint_evidence);
      // Dry run only: no provider request, quote, reservation or storage write.
      return json({ validation: validation.ok ? { ok: true, fields: Object.keys(validation.value) } : validation,
        endpoint, executable: false, mode: 'validation_only' });
    }
    if (body.action === 'sync_muapi_details') {
      const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
      const candidatesResponse = await fetch(`${base}/rest/v1/rpc/studio_muapi_detail_candidates`, {
        method: 'POST', headers: serviceHeaders, body: JSON.stringify({ p_limit: limit }), signal: AbortSignal.timeout(15000),
      });
      if (!candidatesResponse.ok) return json({ error: 'DETAIL_CANDIDATES_FAILED' }, 503);
      const candidates: unknown = await candidatesResponse.json();
      if (!Array.isArray(candidates) || candidates.length > 10 || candidates.some((c) => !c || typeof c.provider_model_id !== 'string' || !/^[A-Za-z0-9._~-]{1,160}$/.test(c.provider_model_id))) return json({ error: 'DETAIL_CANDIDATES_INVALID' }, 503);
      const counts = { ok: 0, http_error: 0, invalid: 0, network_error: 0, persist_error: 0 };
      // Small batches avoid an unbounded fan-out and avoid following provider redirects.
      for (let i = 0; i < candidates.length; i += 3) {
        await Promise.all(candidates.slice(i, i + 3).map(async (candidate: { provider_model_id: string }) => {
          const detail = await fetchMuapiDetail(fetch, candidate.provider_model_id);
          try {
            const saved = await fetch(`${base}/rest/v1/rpc/studio_save_muapi_detail`, {
              method: 'POST', headers: serviceHeaders, signal: AbortSignal.timeout(15000),
              body: JSON.stringify({ p_model_id: detail.model_id, p_status: detail.status, p_http_status: detail.http_status,
                p_input_schema: detail.input_schema ? { ...detail.input_schema, vyora_endpoint_evidence: detail.endpoint_evidence } : null, p_output_schema: detail.output_schema }),
            });
            if (!saved.ok || await saved.json() !== true) { counts.persist_error++; return; }
            counts[detail.status]++;
          } catch { counts.persist_error++; }
        }));
      }
      return json({ attempted: candidates.length, ...counts }, counts.persist_error ? 503 : 200);
    }
    // Public scope does not assert access to the account and does not use a secret.
    const snapshot = await fetchMuapiCatalog(fetch);
    const saved = await fetch(`${base}/rest/v1/rpc/studio_sync_muapi_catalog`, {
      method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_models: snapshot.models, p_scope: snapshot.scope }), signal: AbortSignal.timeout(60000),
    });
    if (!saved.ok) return json({ error: 'CATALOG_PERSIST_FAILED' }, 503);
    const result = await saved.json();
    return json({ scope: snapshot.scope, fetched: snapshot.total, pages: snapshot.pages, result });
  } catch (error) {
    const code = error instanceof Error && /^CATALOG_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CATALOG_SYNC_FAILED';
    return json({ error: code }, 503);
  }
}
const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
