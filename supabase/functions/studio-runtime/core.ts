import { muapiFormFields } from '../universal-catalog/schema.ts';
import { resolveMuapiEndpoint } from '../universal-catalog/endpoint.ts';
export type Json = Record<string, any>;
export const record = (x: unknown): Json => x && typeof x === 'object' && !Array.isArray(x) ? x as Json : {};
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assessment(model: Json, plan?: string) {
  const c = record(model.runtime_config);
  const endpoint = resolveMuapiEndpoint(model.provider_model_id, model.input_schema, model.endpoint_evidence);
  const fields = muapiFormFields(model.input_schema);
  const blockers: string[] = [];
  if (!model.public_catalog_present || model.provider_enabled !== true || model.coming_soon === true) blockers.push('PROVIDER_UNAVAILABLE');
  if (endpoint.status !== 'declared') blockers.push('ENDPOINT_UNVERIFIED');
  if (!fields) blockers.push('SCHEMA_UNSUPPORTED');
  if (fields?.some(f => ['webhook','callback_url','api_key','authorization','endpoint'].includes(f.key.toLowerCase()))) blockers.push('UNSAFE_PARAMETER');
  if (!Number.isSafeInteger(c.credits) || c.credits <= 0 || !(Number(c.max_cost_usd) > 0)) blockers.push('PRICING_REQUIRED');
  const category=String(model.category).toLowerCase();
  const expectedQuota=category.includes('video')?'video':category.includes('image')?'image':category==='text to text'?'script':null;
  if (!expectedQuota || c.quota_kind !== expectedQuota) blockers.push('QUOTA_POLICY_PENDING');
  if (typeof c.estimate_path !== 'string' || !/^\/api\/v1\/models\/[A-Za-z0-9._~-]{1,160}\/estimate-cost$/.test(c.estimate_path)) blockers.push('ESTIMATE_ENDPOINT_UNVERIFIED');
  if (c.adapter !== 'muapi_prediction_v1') blockers.push('ADAPTER_UNVERIFIED');
  if (!c.verified_at || c.verified_hash !== model.spec_hash) blockers.push('PAID_VALIDATION_PENDING');
  if (!c.enabled) blockers.push('ADMIN_DISABLED');
  if (!model.runtime_enabled) blockers.push('RUNTIME_DISABLED');
  if (plan !== undefined && (!Array.isArray(c.allowed_plans) || !c.allowed_plans.includes(plan))) blockers.push('PLAN_UNAVAILABLE');
  return { operational: blockers.length === 0, blockers, endpoint, fields };
}
/** Only supported validation rules cross the customer boundary, never provider
 * descriptions, examples, cost metadata, endpoints or arbitrary extensions. */
export function customerSchema(schema: unknown): unknown {
  const fields = muapiFormFields(schema);
  if (!fields) return null;
  const rules = new Set(['type','enum','minimum','maximum','minValue','maxValue','step','minLength','maxLength','minItems','maxItems','field','format']);
  const clean = (def: Json): Json => {
    const out: Json = {};
    for (const [k,v] of Object.entries(def)) if (rules.has(k)) out[k]=v;
    if (def.items) out.items=clean(def.items);
    // Defaults are user parameters, but deliberately not forwarded: they can
    // contain supplier prose. The UI requires explicit selections.
    return out;
  };
  return { schemas: { input_data: {type:'object',required:fields.filter(f=>f.required).map(f=>f.key),properties:Object.fromEntries(fields.map(f=>[f.key,clean(f.definition)])), 'x-order-properties':fields.map(f=>f.key)} } };
}
export function customerModel(model: Json, plan: string) {
  const a=assessment(model,plan), c=record(model.runtime_config);
  return {model_id:model.provider_model_id,display_name:model.display_name,category:model.category,provider:'MuAPI',
    schema:customerSchema(model.input_schema),credits:Number.isSafeInteger(c.credits)?c.credits:null,
    operational:a.operational,blockers:a.blockers};
}
export function predictionId(raw: unknown): string | null {
  const id=record(raw).request_id;
  return typeof id==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? id : null;
}
export function parsePrediction(raw: unknown, outputKind: string): {state:'pending'|'failed'|'succeeded';media:string[];text:string|null} {
  const root=record(raw), status=root.status;
  if (['failed','cancelled','canceled'].includes(status)) return {state:'failed',media:[],text:null};
  if (['queued','pending','processing','starting'].includes(status)) return {state:'pending',media:[],text:null};
  if (!['completed','succeeded'].includes(status)) throw new Error('RESULT_UNRECOGNIZED');
  if (outputKind==='text') {
    const text=typeof root.text==='string'?root.text:typeof record(root.output).text==='string'?root.output.text:null;
    if (!text || text.length>100000) throw new Error('RESULT_UNRECOGNIZED');
    return {state:'succeeded',media:[],text};
  }
  if (!Array.isArray(root.outputs) || root.outputs.length<1 || root.outputs.length>16) throw new Error('RESULT_UNRECOGNIZED');
  const media=root.outputs.map((x: unknown)=>typeof x==='string'?x:record(x).url);
  if (media.some((x: unknown)=>typeof x!=='string' || x.length>8192)) throw new Error('RESULT_UNRECOGNIZED');
  return {state:'succeeded',media,text:null};
}
export function fileType(bytes: Uint8Array): {mime:string;ext:string;kind:string}|null {
  const ascii=(a:number,b:number)=>String.fromCharCode(...bytes.slice(a,b));
  if (bytes[0]===0x89 && ascii(1,4)==='PNG' && bytes[4]===13 && bytes[5]===10 && bytes[6]===26 && bytes[7]===10) return {mime:'image/png',ext:'png',kind:'image'};
  if (bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return {mime:'image/jpeg',ext:'jpg',kind:'image'};
  if (['GIF87a','GIF89a'].includes(ascii(0,6))) return {mime:'image/gif',ext:'gif',kind:'image'};
  if (ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP') return {mime:'image/webp',ext:'webp',kind:'image'};
  if (ascii(4,8)==='ftyp') return {mime:'video/mp4',ext:'mp4',kind:'video'};
  if (bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3) return {mime:'video/webm',ext:'webm',kind:'video'};
  if (ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE') return {mime:'audio/wav',ext:'wav',kind:'audio'};
  if (ascii(0,3)==='ID3' || bytes[0]===255 && (bytes[1]&0xe0)===0xe0) return {mime:'audio/mpeg',ext:'mp3',kind:'audio'};
  if (ascii(0,4)==='OggS') return {mime:'audio/ogg',ext:'ogg',kind:'audio'};
  if (bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4) return {mime:'application/zip',ext:'zip',kind:'zip'};
  return null;
}
