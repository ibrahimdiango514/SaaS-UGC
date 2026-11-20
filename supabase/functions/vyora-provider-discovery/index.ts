/** Read-only provider catalog diagnostics. No model completion, DB writes or prices. */
type Json = Record<string, unknown>;
type Descriptor = { name: string; url: string; key: string | null; header?: string; account?: string };
const env = (name: string): string => (globalThis as unknown as { Deno?: { env?: { get?: (name: string) => string | undefined } }; process?: { env?: Record<string,string | undefined> } }).Deno?.env?.get?.(name) ?? (globalThis as unknown as { process?: { env?: Record<string,string | undefined> } }).process?.env?.[name] ?? '';
const rec = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const equal = (a: string, b: string): boolean => { if (!a || a.length !== b.length) return false; let diff = 0; for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i); return diff === 0; };
function descriptors(): Descriptor[] {
  const account = env('BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID');
  return [
    { name:'muapi', url:'https://api.muapi.ai/api/v1/models', key:null },
    { name:'muapi_account', url:'https://api.muapi.ai/api/v1/models', key:'MUAPI_API_KEY', header:'x-api-key' },
    { name:'groq', url:'https://api.groq.com/openai/v1/models', key:'BUSINESS_GROW_GROQ_API_KEY' },
    { name:'gemini', url:'https://generativelanguage.googleapis.com/v1beta/models', key:'BUSINESS_GROW_GEMINI_API_KEY', header:'x-goog-api-key' },
    { name:'gonka', url:'https://proxy.gonkabroker.com/v1/models', key:'BUSINESS_GROW_GONKA_API_KEY' },
    { name:'llm7', url:'https://api.llm7.io/v1/models', key:'BUSINESS_GROW_LLM7_API_KEY' },
    { name:'ollama', url:'https://ollama.com/v1/models', key:'BUSINESS_GROW_OLLAMA_API_KEY' },
    { name:'openrouter', url:'https://openrouter.ai/api/v1/models', key:'BUSINESS_GROW_OPENROUTER_API_KEY' },
    { name:'cloudflare', url:`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/models`, key:'BUSINESS_GROW_CLOUDFLARE_API_TOKEN', account:'BUSINESS_GROW_CLOUDFLARE_ACCOUNT_ID' },
  ];
}
async function read(d: Descriptor) {
  const key = d.key ? env(d.key) : '';
  if (d.key && !key) return { provider:d.name, status:'not_configured', missing:d.key };
  if (d.account && !env(d.account)) return { provider:d.name, status:'not_configured', missing:d.account };
  const headers: Record<string,string> = { Accept:'application/json' };
  if (d.key) headers[d.header ?? 'Authorization'] = d.header ? key : `Bearer ${key}`;
  try {
    const response = await fetch(d.url, { method:'GET', headers, redirect:'error', signal:AbortSignal.timeout(15000) });
    if (!response.ok) return { provider:d.name, status:'http_error', http_status:response.status };
    const body = rec(await response.json());
    const result = rec(body.result);
    const items = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : Array.isArray(body.result) ? body.result : Array.isArray(result.models) ? result.models : null;
    if (!items) return { provider:d.name, status:'invalid_catalog', http_status:response.status };
    return { provider:d.name, status:'catalog_accessible', http_status:response.status, models_on_first_page:items.length, completeness:'unverified' };
  } catch { return { provider:d.name, status:'network_or_parse_error' }; }
}
export async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error:'METHOD_NOT_ALLOWED' },405);
  const supplied = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i,'').trim();
  if (supplied.length < 32) return json({ error:'UNAUTHENTICATED' },401);
  const base = env('SUPABASE_URL'), service = env('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !service) return json({ error:'SERVER_NOT_CONFIGURED' },503);
  try {
    const tokenResponse = await fetch(`${base}/rest/v1/rpc/vyora_provider_health_cron_token`, { method:'POST', headers: { apikey:service, Authorization:`Bearer ${service}`, 'Content-Type':'application/json' }, body:'{}', signal:AbortSignal.timeout(10000) });
    const token: unknown = tokenResponse.ok ? await tokenResponse.json() : null;
    if (typeof token !== 'string' || token.length < 32 || !equal(supplied,token)) return json({ error:'FORBIDDEN' },403);
    const items = descriptors(); const results: unknown[] = [];
    for (let i=0;i<items.length;i+=3) results.push(...await Promise.all(items.slice(i,i+3).map(read)));
    return json({ mode:'read_only', generated:false, persisted:false, results });
  } catch { return json({ error:'DISCOVERY_UNAVAILABLE' },503); }
}
const runtime = globalThis as unknown as { Deno?: { serve?: (fn:(req:Request)=>Promise<Response>)=>void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
