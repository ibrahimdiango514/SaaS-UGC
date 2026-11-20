/** Conservative validation of a supported subset of MuAPI schemas.
 * Shared by forms and the generation runtime. Unknown constraints fail closed. */
import type { JsonObject } from './catalog.ts';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const annotations = ['title', 'description', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', 'name', 'placeholder', 'isEdit'];
const only = (s: JsonObject, keys: string[]) => Object.keys(s).every(k => keys.includes(k) || annotations.includes(k));
const types = ['string', 'text', 'number', 'float', 'integer', 'int', 'boolean'];
const numeric = (t: unknown) => ['number','float','integer','int'].includes(String(t));
const textual = (t: unknown) => ['string','text'].includes(String(t));
const mediaFields = ['image','video','audio','zip','images_list','videos_list','audios_list'];
export function isHttpsInput(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(u.hostname) && !/^[0-9.]+$/.test(u.hostname) &&
    !/(^|\.)(localhost|local|internal|test|invalid)$/.test(u.hostname); } catch { return false; }
}
const natural = (v: unknown) => number(v) && Number.isInteger(v) && v >= 0;

export type SchemaValidation = { ok: true; value: JsonObject } | { ok: false; code: 'SCHEMA_UNSUPPORTED' | 'PARAMETER_INVALID' | 'PARAMETER_REQUIRED'; field: string | null };
const fail = (code: 'SCHEMA_UNSUPPORTED' | 'PARAMETER_INVALID' | 'PARAMETER_REQUIRED', field: string | null): SchemaValidation => ({ ok: false, code, field });

/** Check definitions independently of input, including omitted fields and empty arrays. */
const safeKey=(k:string)=>/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(k)&&!['__proto__','constructor','prototype'].includes(k);
/** Labelled MuAPI choices carry their wire value separately from the UI label. */
export function enumChoices(s: JsonObject): {value:unknown;label:string}[] | null {
 if(!Array.isArray(s.enum))return null;
 return s.enum.map(x=>object(x)?{value:x.value,label:String(x.label)}:{value:x,label:String(x)});
}
function supported(s: JsonObject, depth=0): boolean {
  if(depth>5)return false;
  if(s.type==='object') {
    if(!only(s,['type','properties','required','additionalProperties','x-order-properties'])||!object(s.properties)||Object.keys(s.properties).length>100)return false;
    if(s.additionalProperties!==undefined&&typeof s.additionalProperties!=='boolean')return false;
    const req=s.required??[];
    return Array.isArray(req)&&new Set(req).size===req.length&&req.every(k=>typeof k==='string'&&Object.hasOwn(s.properties as object,k))&&
      Object.entries(s.properties).every(([k,v])=>safeKey(k)&&object(v)&&supported(v,depth+1));
  }
  if ('field' in s && !mediaFields.includes(String(s.field))) return false;
  if ('format' in s && !['uri','url','text'].includes(String(s.format))) return false;
  if ('field' in s && !(s.type === 'string' || s.type === 'array')) return false;
  if ('format' in s && !textual(s.type)) return false;
  if (s.type === 'array') {
    return only(s, ['type', 'items', 'minItems', 'maxItems', 'field']) && object(s.items) &&
      supported(s.items,depth+1) && (!s.field || s.items.type === 'string') &&
      (s.minItems === undefined || natural(s.minItems)) && (s.maxItems === undefined || natural(s.maxItems)) &&
      !(number(s.minItems) && number(s.maxItems) && s.minItems > s.maxItems);
  }
  if (!types.includes(String(s.type))) return false;
  const constraints = textual(s.type) ? ['minLength','maxLength','format','field'] :
    numeric(s.type) ? ['minimum','maximum','minValue','maxValue','step'] : [];
  if (!only(s, ['type', 'enum', 'typing', ...constraints])) return false;
  if('typing' in s && (typeof s.typing!=='boolean'||!textual(s.type)||!Array.isArray(s.enum)))return false;
  if(Array.isArray(s.enum)&&s.enum.some(x=>object(x)&&(!only(x,['label','value'])||Object.keys(x).some(k=>!['label','value'].includes(k))||typeof x.label!=='string'||!Object.hasOwn(x,'value'))))return false;
  if ('enum' in s && (!Array.isArray(s.enum) || s.enum.length === 0 || enumChoices(s)!.some(({value:x}) =>
    textual(s.type) ? typeof x !== 'string' : s.type === 'boolean' ? typeof x !== 'boolean' :
      !number(x) || (['integer','int'].includes(String(s.type)) && !Number.isInteger(x))))) return false;
  if (textual(s.type)) {
    if ((s.minLength !== undefined && !natural(s.minLength)) || (s.maxLength !== undefined && !natural(s.maxLength))) return false;
    if (number(s.minLength) && number(s.maxLength) && s.minLength > s.maxLength) return false;
  }
  if (numeric(s.type)) {
    for (const k of constraints) if (s[k] !== undefined && !number(s[k])) return false;
    if (s.step !== undefined && (!number(s.step) || s.step <= 0)) return false;
    if ('minimum' in s && 'minValue' in s && s.minimum !== s.minValue) return false;
    if ('maximum' in s && 'maxValue' in s && s.maximum !== s.maxValue) return false;
    const min = s.minimum ?? s.minValue, max = s.maximum ?? s.maxValue;
    if (number(min) && number(max) && min > max) return false;
  }
  return true;
}
function valid(s: JsonObject, v: unknown): boolean {
  if(s.type==='object') {
    if(!object(v)||Object.keys(v).length>100)return false;
    const props=s.properties as JsonObject;
    return (s.required as string[]??[]).every(k=>Object.hasOwn(v,k))&&Object.entries(v).every(([k,x])=>Object.hasOwn(props,k)&&valid(props[k] as JsonObject,x));
  }
  if (s.type === 'array') {
    if (!Array.isArray(v)||v.length>256) return false;
    if ((number(s.minItems) && v.length < s.minItems) || (number(s.maxItems) && v.length > s.maxItems)) return false;
    return v.every(item => valid(s.items as JsonObject, item) && (!s.field || (typeof item === 'string' && isHttpsInput(item))));
  }
  if (textual(s.type) && typeof v !== 'string') return false;
  if (s.type === 'boolean' && typeof v !== 'boolean') return false;
  if (numeric(s.type) && (!number(v) || (['integer','int'].includes(String(s.type)) && !Number.isInteger(v)))) return false;
  if (Array.isArray(s.enum) && s.typing!==true && !enumChoices(s)!.some(x => x.value === v)) return false;
  if (number(v)) {
    const min = s.minimum ?? s.minValue, max = s.maximum ?? s.maxValue;
    if ((number(min) && v < min) || (number(max) && v > max)) return false;
    if (number(s.step)) { const steps = (v - (number(min) ? min : 0)) / s.step; if (Math.abs(steps - Math.round(steps)) > 1e-8) return false; }
  }
  if (typeof v === 'string') {
    if ((s.format === 'uri' || s.format === 'url' || s.field) && !isHttpsInput(v)) return false;
    const length = Array.from(v).length;
    if ((number(s.minLength) && length < s.minLength) || (number(s.maxLength) && length > s.maxLength)) return false;
  }
  return true;
}
export function validateMuapiInput(inputSchema: unknown, params: unknown): SchemaValidation {
  if (!object(inputSchema) || !object(inputSchema.schemas) || !object(inputSchema.schemas.input_data)) return fail('SCHEMA_UNSUPPORTED',null);
  const root = inputSchema.schemas.input_data;
  if (root.type !== 'object' || !object(root.properties) || !only(root, ['type','properties','required','additionalProperties','endpoint_url','x-order-properties']) ||
      (root.additionalProperties !== undefined && typeof root.additionalProperties !== 'boolean')) return fail('SCHEMA_UNSUPPORTED',null);
  const required = root.required ?? [];
  if (Object.keys(root.properties).length > 100 || Object.keys(root.properties).some(k => !safeKey(k))) return fail('SCHEMA_UNSUPPORTED',null);
  if (!Array.isArray(required) || required.some(x => typeof x !== 'string' || !Object.prototype.hasOwnProperty.call(root.properties, x)) || new Set(required).size !== required.length) return fail('SCHEMA_UNSUPPORTED',null);
  for (const [field, def] of Object.entries(root.properties)) if (!object(def) || !supported(def)) return fail('SCHEMA_UNSUPPORTED',field);
  if (!object(params) || Object.keys(params).length > 100) return fail('PARAMETER_INVALID',null);
  for (const key of Object.keys(params)) if (!Object.prototype.hasOwnProperty.call(root.properties,key)) return fail('PARAMETER_INVALID',key);
  for (const field of required as string[]) if (!Object.prototype.hasOwnProperty.call(params,field)) return fail('PARAMETER_REQUIRED',field);
  const value: JsonObject = {};
  for (const [key,v] of Object.entries(params)) {
    if (!valid(root.properties[key] as JsonObject,v)) return fail('PARAMETER_INVALID',key);
    Object.defineProperty(value, key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return { ok:true, value };
}

export interface MuapiField { key: string; definition: JsonObject; required: boolean }
export function muapiFormFields(inputSchema: unknown): MuapiField[] | null {
  // Missing required parameters are allowed here; unsupported schema is not.
  const check = validateMuapiInput(inputSchema, {});
  if (!check.ok && check.code === 'SCHEMA_UNSUPPORTED') return null;
  const root = (inputSchema as { schemas: { input_data: JsonObject } }).schemas.input_data;
  const required = new Set((root.required ?? []) as string[]);
  const properties = root.properties as JsonObject;
  const declared = root['x-order-properties'];
  const keys = Object.keys(properties);
  const ordered = Array.isArray(declared) ? [...new Set([...declared.filter((k): k is string => typeof k === 'string' && keys.includes(k)), ...keys])] : keys;
  return ordered.map(key => ({ key, definition: properties[key] as JsonObject, required: required.has(key) }));
}

/** Apply only schema-valid declared defaults, never invented values or null placeholders.
 * Used before estimation so the persisted quote and eventual submission are identical. */
export function muapiDefaults(schema:unknown,params:unknown):unknown {
 if(!muapiFormFields(schema))return params;
 const root=(schema as {schemas:{input_data:JsonObject}}).schemas.input_data;
 const apply=(d:JsonObject,v:unknown):unknown=>{
  if(v===undefined&&d.default!==undefined&&d.default!==null&&valid(d,d.default))v=structuredClone(d.default);
  if(d.type==='array'&&Array.isArray(v))return v.map(x=>apply(d.items as JsonObject,x));
  if(d.type==='object'&&object(v)) {
   const pairs=Object.entries(v).map(([k,x])=>[k,Object.hasOwn(d.properties as object,k)?apply((d.properties as JsonObject)[k] as JsonObject,x):x]);
   for(const [k,def] of Object.entries(d.properties as JsonObject))if(!Object.hasOwn(v,k)) {const value=apply(def as JsonObject,undefined);if(value!==undefined)pairs.push([k,value]);}
   return Object.fromEntries(pairs);
  }return v;
 };
 return apply(root,params);
}
