/** Read-only provider detail ingestion. Never calls a generation endpoint. */
import type { JsonObject } from './catalog.ts';
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type DetailStatus = 'ok' | 'http_error' | 'invalid' | 'network_error';
export interface DetailResult {
  model_id: string;
  status: DetailStatus;
  http_status: number | null;
  input_schema: JsonObject | null;
  endpoint_evidence?: JsonObject | null;
  output_schema: JsonObject | null;
  /** Prix et endpoint d'estimation DÉCLARÉS par le fournisseur (jamais déduits). */
  provider_pricing?: JsonObject | null;
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
    const source = `https://api.muapi.ai/api/v1/models/${encodeURIComponent(modelId)}`;
    result.endpoint_evidence = { endpoint: raw.endpoint ?? null, endpoint_url: raw.endpoint_url ?? null, source_url: source, observed_at: new Date().toISOString(), http_status: response.status };
    // Le runtime ne peut ni devis ni plafonner sans ces deux déclarations. On les
    // conserve telles quelles, et SEULEMENT si elles sont exploitables : un prix
    // absent ou non-USD n'est jamais converti ni complété par une estimation.
    //
    // Un coût officiellement nul N'EST PAS un prix manquant : MuAPI déclare
    // 0.00 USD pour ses traitements locaux (filigrane PIL/FFmpeg) et pour les
    // compagnons Gemini Omni. On l'enregistre comme `free` avec la stratégie de
    // coût officielle et la source, pour que le modèle soit configurable à
    // 0 crédit. Un coût nul SANS stratégie déclarée reste refusé : ce serait
    // alors une valeur par défaut inventée.
    const cost = raw.cost;
    const estimate = raw.estimate_endpoint;
    const expectedEstimate = `/api/v1/models/${modelId}/estimate-cost`;
    const costStrategy = typeof raw.cost_strategy === 'string' ? raw.cost_strategy.trim() : '';
    const free = cost === 0 && costStrategy.length > 0;
    const priceAccepted = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= 1000
      && raw.cost_currency === 'USD' && (cost > 0 || free);
    result.provider_pricing = priceAccepted
      ? {
        cost_usd: cost,
        currency: 'USD',
        billing: cost === 0 ? 'free' : 'metered',
        ...(costStrategy ? { cost_strategy: costStrategy } : {}),
        dynamic_pricing: raw.dynamic_pricing === true,
        // Un endpoint qui ne vise pas CE modèle n'est pas une preuve pour lui.
        estimate_path: estimate === expectedEstimate ? estimate : null,
        source_url: source,
        observed_at: result.endpoint_evidence.observed_at,
      }
      : null;
    result.status = 'ok';
    result.input_schema = raw.input_schema;
    result.output_schema = raw.output_schema == null ? null : raw.output_schema as JsonObject;
    return result;
  } catch {
    result.status = 'network_error';
    return result;
  }
}
