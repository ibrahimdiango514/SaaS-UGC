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

describe('contraintes MuAPI observées en production', () => {
  const wrap = (properties: unknown) => ({schemas:{input_data:{type:'object',endpoint_url:'model', 'x-order-properties':[],properties}}});
  it('accepte les annotations fournisseur et valide les types alias et pas numériques', () => {
    const s=wrap({value:{type:'float',minValue:0.1,maxValue:1,step:0.1,name:'value',title:'Value',placeholder:'0.5'},prompt:{type:'text',format:'text'}});
    expect(validateMuapiInput(s,{value:0.3,prompt:'Bonjour'}).ok).toBe(true);
    expect(validateMuapiInput(s,{value:0.35})).toMatchObject({code:'PARAMETER_INVALID'});
  });
  it('valide les médias HTTPS et bloque schémas/URL mal formés sans téléchargement', () => {
    const s=wrap({image:{type:'string',field:'image'},videos:{type:'array',field:'videos_list',items:{type:'string'},maxItems:2}});
    expect(validateMuapiInput(s,{image:'https://cdn.example.com/image.png',videos:['https://cdn.example.com/video.mp4']}).ok).toBe(true);
    for (const image of ['http://cdn.example.com/x','data:image/png,x','https://localhost/x','https://127.0.0.1/x','https://user:pass@cdn.example.com/x']) expect(validateMuapiInput(s,{image}).ok).toBe(false);
    expect(validateMuapiInput(wrap({x:{type:'string',format:'unknown'}}),{})).toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  });
  it('refuse les contraintes conditionnelles et les choix dynamiques non résolus', () => {
    for (const extra of [{conditionalMaxItems:{}},{limitWhenFieldPresent:{}},{options_source:'remote'},{typing:'other'}]) {
      expect(validateMuapiInput(wrap({x:{type:'string',...extra}}),{})).toMatchObject({code:'SCHEMA_UNSUPPORTED'});
    }
  });
});

describe('structured MuAPI inputs (dialogue and keyframes)',()=>{
 const schema={schemas:{input_data:{type:'object',properties:{dialogue:{type:'array',maxItems:2,items:{type:'object',required:['text','voice'],properties:{text:{type:'string',minLength:1},voice:{type:'string',typing:true,enum:[{label:'Official voice',value:'voice-1'}]},weight:{type:'number',minValue:0,maxValue:1,step:0.1}}}}}}}};
 it('validates nested types, required values, bounds and labelled/custom choices',()=>{
  expect(validateMuapiInput(schema,{dialogue:[{text:'Bonjour',voice:'custom-voice',weight:0.3}]}).ok).toBe(true);
  for(const dialogue of [[{voice:'voice-1'}],[{text:'Bonjour',voice:'x',weight:1.1}],[{text:'Bonjour',voice:'x',unknown:true}]])expect(validateMuapiInput(schema,{dialogue}).ok).toBe(false);
  const strict={schemas:{input_data:{type:'object',properties:{voice:{type:'string',enum:[{label:'Voice',value:'id'}]}}}}};
  expect(validateMuapiInput(strict,{voice:'Voice'}).ok).toBe(false);expect(validateMuapiInput(strict,{voice:'id'}).ok).toBe(true);
 });
 it('does not weaken unknown nested constraints or prototype protection',()=>{
  const bad=structuredClone(schema);Object.assign(bad.schemas.input_data.properties.dialogue.items.properties.text,{pattern:'^x'});
  expect(validateMuapiInput(bad,{})).toMatchObject({code:'SCHEMA_UNSUPPORTED'});
  expect(validateMuapiInput(schema,JSON.parse('{"dialogue":[{"text":"x","voice":"v","__proto__":{}}]}')).ok).toBe(false);
  expect(validateMuapiInput(schema,{dialogue:Array(257).fill({text:'x',voice:'v'})}).ok).toBe(false);
 });
});
it('applies declared valid nested defaults identically for quote and submission, without changing explicit values',async()=>{
 const {muapiDefaults}=await import('../supabase/functions/universal-catalog/schema');
 const s={schemas:{input_data:{type:'object',properties:{turns:{type:'array',items:{type:'object',properties:{text:{type:'string'},stability:{type:'number',default:0.5,minimum:0,maximum:1}}}},language:{type:'string',default:null},bad:{type:'int',default:20,maximum:10}}}}};
 expect(muapiDefaults(s,{turns:[{text:'hello'},{text:'explicit',stability:0}]})).toEqual({turns:[{text:'hello',stability:0.5},{text:'explicit',stability:0}]});
});
it('enforces the observed Qwen mask-dependent reference-image cap without dropping the base limit',()=>{
 const s={schemas:{input_data:{type:'object',properties:{mask:{type:'string'},images:{type:'array',items:{type:'string'},minItems:1,maxItems:10,conditionalMaxItems:1,limitWhenFieldPresent:'mask'}}}}};
 expect(validateMuapiInput(s,{images:['a','b']}).ok).toBe(true);
 expect(validateMuapiInput(s,{mask:'present',images:['a']}).ok).toBe(true);
 expect(validateMuapiInput(s,{mask:'present',images:['a','b']})).toMatchObject({code:'PARAMETER_INVALID'});
 expect(validateMuapiInput(s,{images:Array(11).fill('a')})).toMatchObject({code:'PARAMETER_INVALID'});
 const unresolved=structuredClone(s);unresolved.schemas.input_data.properties.images.limitWhenFieldPresent='undeclared';
 expect(validateMuapiInput(unresolved,{})).toMatchObject({code:'SCHEMA_UNSUPPORTED'});
});
