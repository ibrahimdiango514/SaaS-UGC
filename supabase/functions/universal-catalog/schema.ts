/** Conservative validation of a supported subset of MuAPI schemas.
 * This helper is not wired to generation. Unsupported validation keywords fail closed. */
import type { JsonObject } from './catalog.ts';
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const annotations = ['title', 'description', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly'];
const only = (s: JsonObject, keys: string[]) => Object.keys(s).every(k => keys.includes(k) || annotations.includes(k));
const types = ['string', 'number', 'integer', 'int', 'boolean'];
const natural = (v: unknown) => number(v) && Number.isInteger(v) && v >= 0;

export type SchemaValidation = { ok: true; value: JsonObject } | { ok: false; code: 'SCHEMA_UNSUPPORTED' | 'PARAMETER_INVALID' | 'PARAMETER_REQUIRED'; field: string | null };
const fail = (code: 'SCHEMA_UNSUPPORTED' | 'PARAMETER_INVALID' | 'PARAMETER_REQUIRED', field: string | null): SchemaValidation => ({ ok: false, code, field });

/** Check definitions independently of input, including omitted fields and empty arrays. */
function supported(s: JsonObject): boolean {
  if (s.type === 'array') {
    return only(s, ['type', 'items', 'minItems', 'maxItems']) && object(s.items) &&
      types.includes(String(s.items.type)) && supported(s.items) &&
      (s.minItems === undefined || natural(s.minItems)) && (s.maxItems === undefined || natural(s.maxItems)) &&
      !(number(s.minItems) && number(s.maxItems) && s.minItems > s.maxItems);
  }
  if (!types.includes(String(s.type))) return false;
  const constraints = s.type === 'string' ? ['minLength','maxLength'] :
    ['number','integer','int'].includes(String(s.type)) ? ['minimum','maximum','minValue','maxValue'] : [];
  if (!only(s, ['type', 'enum', ...constraints])) return false;
  if ('enum' in s && (!Array.isArray(s.enum) || s.enum.length === 0 || s.enum.some(x =>
    s.type === 'string' ? typeof x !== 'string' : s.type === 'boolean' ? typeof x !== 'boolean' :
      !number(x) || (['integer','int'].includes(String(s.type)) && !Number.isInteger(x))))) return false;
  if (s.type === 'string') {
    if ((s.minLength !== undefined && !natural(s.minLength)) || (s.maxLength !== undefined && !natural(s.maxLength))) return false;
    if (number(s.minLength) && number(s.maxLength) && s.minLength > s.maxLength) return false;
  }
  if (['number','integer','int'].includes(String(s.type))) {
    for (const k of constraints) if (s[k] !== undefined && !number(s[k])) return false;
    if ('minimum' in s && 'minValue' in s && s.minimum !== s.minValue) return false;
    if ('maximum' in s && 'maxValue' in s && s.maximum !== s.maxValue) return false;
    const min = s.minimum ?? s.minValue, max = s.maximum ?? s.maxValue;
    if (number(min) && number(max) && min > max) return false;
  }
  return true;
}
function valid(s: JsonObject, v: unknown): boolean {
  if (s.type === 'array') {
    if (!Array.isArray(v)) return false;
    if ((number(s.minItems) && v.length < s.minItems) || (number(s.maxItems) && v.length > s.maxItems)) return false;
    return v.every(item => valid(s.items as JsonObject, item));
  }
  if (s.type === 'string' && typeof v !== 'string') return false;
  if (s.type === 'boolean' && typeof v !== 'boolean') return false;
  if (['number','integer','int'].includes(String(s.type)) && (!number(v) || (['integer','int'].includes(String(s.type)) && !Number.isInteger(v)))) return false;
  if (Array.isArray(s.enum) && !s.enum.some(x => x === v)) return false;
  if (number(v)) {
    const min = s.minimum ?? s.minValue, max = s.maximum ?? s.maxValue;
    if ((number(min) && v < min) || (number(max) && v > max)) return false;
  }
  if (typeof v === 'string') {
    const length = Array.from(v).length;
    if ((number(s.minLength) && length < s.minLength) || (number(s.maxLength) && length > s.maxLength)) return false;
  }
  return true;
}
export function validateMuapiInput(inputSchema: unknown, params: unknown): SchemaValidation {
  if (!object(inputSchema) || !object(inputSchema.schemas) || !object(inputSchema.schemas.input_data)) return fail('SCHEMA_UNSUPPORTED',null);
  const root = inputSchema.schemas.input_data;
  if (root.type !== 'object' || !object(root.properties) || !only(root, ['type','properties','required','additionalProperties']) ||
      (root.additionalProperties !== undefined && typeof root.additionalProperties !== 'boolean')) return fail('SCHEMA_UNSUPPORTED',null);
  const required = root.required ?? [];
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
