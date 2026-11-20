import { describe, expect, it } from 'vitest';
import { validateMuapiInput } from '../supabase/functions/universal-catalog/schema';
const schema = { schemas: { input_data: { type:'object', required:['prompt'], properties:{
  prompt:{type:'string',minLength:3}, duration:{type:'int',minValue:1,maxValue:10},
  ratio:{type:'string',enum:['9:16','16:9']}, audio:{type:'boolean'},
  images:{type:'array',items:{type:'string'},minItems:1,maxItems:3},
} } } };
describe('validation dynamique du sous-ensemble supporté', () => {
  it('accepte les champs déclarés avec leur type et leurs limites', () => {
    const params={prompt:'bonjour',duration:5,ratio:'9:16',audio:true,images:['x']};
    expect(validateMuapiInput(schema,params)).toEqual({ok:true,value:params});
  });
  it('refuse champs manquants, inconnus, limites et types invalides', () => {
    expect(validateMuapiInput(schema,{})).toMatchObject({code:'PARAMETER_REQUIRED',field:'prompt'});
    expect(validateMuapiInput(schema,{prompt:'bonjour',price:1})).toMatchObject({code:'PARAMETER_INVALID',field:'price'});
    for (const params of [{prompt:'x'}, {prompt:'bonjour',duration:12}, {prompt:'bonjour',duration:'5'}, {prompt:'bonjour',ratio:'3:4'}, {prompt:'bonjour',images:[]}]) expect(validateMuapiInput(schema,params)).toMatchObject({code:'PARAMETER_INVALID'});
  });
  it('refuse les règles complexes et les références non supportées', () => {
    const complex={schemas:{input_data:{type:'object',required:['prompt'],properties:{prompt:{type:'string',pattern:'[a-z]+'}}}}};
    expect(validateMuapiInput(complex,{prompt:'abc'})).toEqual({ok:false,code:'SCHEMA_UNSUPPORTED',field:'prompt'});
    expect(validateMuapiInput({schemas:{input_data:{$ref:'#/input'}}},{})).toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  });
});

describe('fermeture sur les contraintes inconnues', () => {
  const wrap = (property: unknown) => ({ schemas: { input_data: { type: 'object', properties: { optional: property } } } });
  it('refuse une contrainte inconnue même si le champ est omis', () => {
    expect(validateMuapiInput(wrap({ type: 'string', contentEncoding: 'base64' }), {})).toMatchObject({ code: 'SCHEMA_UNSUPPORTED', field: 'optional' });
  });
  it('inspecte les items même si le tableau est vide', () => {
    expect(validateMuapiInput(wrap({ type: 'array', items: { type: 'string', pattern: '^x' } }), { optional: [] })).toMatchObject({ code: 'SCHEMA_UNSUPPORTED', field: 'optional' });
    expect(validateMuapiInput(wrap({ type: 'array', items: { type: 'string', enum: 'wrong' } }), { optional: [] })).toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
  });
  it('refuse les contraintes contradictoires ou mal formées et mesure les caractères Unicode', () => {
    expect(validateMuapiInput(wrap({ type: 'number', minimum: 3, maximum: 1 }), {})).toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    expect(validateMuapiInput(wrap({ type: 'string', minLength: -1 }), {})).toMatchObject({ code: 'SCHEMA_UNSUPPORTED' });
    expect(validateMuapiInput(wrap({ type: 'string', maxLength: 1 }), { optional: '😀' }).ok).toBe(true);
  });
});
