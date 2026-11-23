/**
 * Read-only provider catalog diagnostics.
 *
 * Toutes les cibles IA viennent du REGISTRE central
 * (`vyora_ai_provider_descriptors()`), protocole OpenAI-compatible uniquement.
 * Aucun fournisseur LLM n'est écrit en dur. MuAPI (génération vidéo) reste
 * sondé localement : ce n'est pas un fournisseur de langage et il n'est pas
 * décrit par le registre IA.
 *
 * No model completion, DB writes or prices.
 */
type Json = Record<string, unknown>;
type Descriptor = { name: string; url: string; key: string | null; header?: string };

const env = (name: string): string =>
  (globalThis as unknown as { Deno?: { env?: { get?: (name: string) => string | undefined } }; process?: { env?: Record<string, string | undefined> } })
    .Deno?.env?.get?.(name)
  ?? (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.[name]
  ?? "";

const rec = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, max = 400): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const equal = (a: string, b: string): boolean => {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Fournisseurs décrits localement : uniquement la génération vidéo MuAPI. */
function localDescriptors(): Descriptor[] {
  return [
    { name: "muapi", url: "https://api.muapi.ai/api/v1/models", key: null },
    { name: "muapi_account", url: "https://api.muapi.ai/api/v1/models", key: "MUAPI_API_KEY", header: "x-api-key" },
  ];
}

/** Cibles IA : descripteurs du registre central, jamais une liste figée. */
async function registryDescriptors(base: string, service: string): Promise<Descriptor[]> {
  const res = await fetch(`${base}/rest/v1/rpc/vyora_ai_provider_descriptors`, {
    method: "POST",
    headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as unknown;
  if (!Array.isArray(rows)) return [];
  const out: Descriptor[] = [];
  for (const raw of rows) {
    const row = rec(raw);
    const name = str(row.key, 40).toLowerCase();
    if (!name) continue;
    const baseUrl = str(row.base_url, 300).replace(/\/+$/, "");
    const modelsUrl = str(row.models_url, 300);
    const url = modelsUrl || (baseUrl ? `${baseUrl}/models` : "");
    if (!url) continue;
    out.push({ name, url, key: str(row.api_key_env, 80) || null });
  }
  return out;
}

async function read(d: Descriptor) {
  const key = d.key ? env(d.key) : "";
  if (d.key && !key) return { provider: d.name, status: "not_configured", missing: d.key };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (d.key) headers[d.header ?? "Authorization"] = d.header ? key : `Bearer ${key}`;
  try {
    const response = await fetch(d.url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { provider: d.name, status: "http_error", http_status: response.status };
    const body = rec(await response.json());
    const result = rec(body.result);
    const items = Array.isArray(body.models)
      ? body.models
      : Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.result)
          ? body.result
          : Array.isArray(result.models)
            ? result.models
            : null;
    if (!items) return { provider: d.name, status: "invalid_catalog", http_status: response.status };
    return { provider: d.name, status: "catalog_accessible", http_status: response.status, models_on_first_page: items.length, completeness: "unverified" };
  } catch {
    return { provider: d.name, status: "network_or_parse_error" };
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const supplied = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (supplied.length < 32) return json({ error: "UNAUTHENTICATED" }, 401);
  const base = env("SUPABASE_URL");
  const service = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !service) return json({ error: "SERVER_NOT_CONFIGURED" }, 503);
  try {
    const tokenResponse = await fetch(`${base}/rest/v1/rpc/vyora_provider_health_cron_token`, {
      method: "POST",
      headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    });
    const token: unknown = tokenResponse.ok ? await tokenResponse.json() : null;
    if (typeof token !== "string" || token.length < 32 || !equal(supplied, token)) return json({ error: "FORBIDDEN" }, 403);

    const items = [...localDescriptors(), ...(await registryDescriptors(base, service))];
    const results: unknown[] = [];
    for (let i = 0; i < items.length; i += 3) results.push(...await Promise.all(items.slice(i, i + 3).map(read)));
    return json({ mode: "read_only", generated: false, persisted: false, results });
  } catch {
    return json({ error: "DISCOVERY_UNAVAILABLE" }, 503);
  }
}

const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (req: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
