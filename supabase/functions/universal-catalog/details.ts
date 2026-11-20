/** Read-only provider detail ingestion. Never calls a generation endpoint. */
import type { JsonObject } from './catalog.ts';
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type DetailStatus = 'ok' | 'http_error' | 'invalid' | 'network_error';
export interface DetailResult {
  model_id: string;
  status: DetailStatus;
  http_status: number | null;
  input_schema: JsonObject | null;
  output_schema: JsonObject | null;
}
const object = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);
export async function fetchMuapiDetail(fetcher: Fetcher, modelId: string): Promise<DetailResult> {
  const result: DetailResult = { model_id: modelId, status: 'invalid', http_status: null, input_schema: null, output_schema: null };
  if (!/^[A-Za-z0-9._~-]{1,160}$/.test(modelId)) return result;
  try {
    const response = await fetcher(`https://api.muapi.ai/api/v1/models/${encodeURIComponent(modelId)}`, {
      method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    result.http_status = response.status;
    if (!response.ok) { result.status = 'http_error'; return result; }
    let raw: unknown;
    try { raw = await response.json(); } catch { return result; }
    if (!object(raw) || raw.name !== modelId || !object(raw.input_schema)) return result;
    // Require the MuAPI input object; an unrelated JSON object is not a schema.
    const schemas = raw.input_schema.schemas;
    if (!object(schemas) || !object(schemas.input_data) || schemas.input_data.type !== 'object' || !object(schemas.input_data.properties)) return result;
    if (raw.output_schema != null && !object(raw.output_schema)) return result;
    result.status = 'ok';
    result.input_schema = raw.input_schema;
    result.output_schema = raw.output_schema == null ? null : raw.output_schema as JsonObject;
    return result;
  } catch {
    result.status = 'network_error';
    return result;
  }
}
