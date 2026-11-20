import {describe,it,expect,vi} from 'vitest';
import {assessment,customerModel,fileType,parsePrediction,predictionId} from '../supabase/functions/studio-runtime/core';
import {createHandler} from '../supabase/functions/studio-runtime/handler';
const model={provider_model_id:'model',display_name:'Model',category:'image',account_access:'available',public_catalog_present:true,provider_enabled:true,coming_soon:false,runtime_enabled:true,spec_hash:'abc',endpoint_evidence:{endpoint:'/api/v1/model'},input_schema:{schemas:{input_data:{type:'object',endpoint_url:'model',properties:{prompt:{type:'string',description:'supplier cost secret'}},required:['prompt']}}},runtime_config:{adapter:'muapi_prediction_v1',estimate_path:'/api/v1/models/model/estimate-cost',credits:4,quota_kind:'image',max_cost_usd:.1,verified_hash:'abc',verified_at:'2026-11-20',enabled:true,allowed_plans:['pro']}};
describe('universal runtime safety without provider spending',()=>{
 it('requires every activation gate and matching schema verification',()=>{
  expect(assessment(model,'pro').operational).toBe(true);
  expect(assessment({...model,spec_hash:'changed'},'pro').blockers).toContain('PAID_VALIDATION_PENDING');
  expect(assessment({...model,runtime_enabled:false},'pro').operational).toBe(false);
  expect(assessment(model,'free').blockers).toContain('PLAN_UNAVAILABLE');
  expect(assessment({...model,runtime_config:{}},'pro').operational).toBe(false);
 });
 it('projects only customer fields and never price/margin/endpoint metadata',()=>{
  const projected=JSON.stringify(customerModel({...model,internal_margin:99},'pro'));
  for(const secret of ['max_cost_usd','verified_hash','supplier cost secret','internal_margin','endpoint_url'])expect(projected).not.toContain(secret);
  expect(JSON.parse(projected).credits).toBe(4);
 });
 it('does not guess completion from arbitrary URLs or states',()=>{
  expect(predictionId({request_id:'../../metadata'})).toBeNull();
  expect(()=>parsePrediction({status:'unknown',outputs:['https://example.com/a']},'media')).toThrow();
  expect(()=>parsePrediction({status:'completed',outputs:[]},'media')).toThrow();
  expect(parsePrediction({status:'processing'},'media').state).toBe('pending');
  expect(parsePrediction({status:'failed'},'media').state).toBe('failed');
  expect(parsePrediction({status:'completed',text:'answer'},'text').text).toBe('answer');
 });
 it('rejects executable, SVG and unrecognized file bytes',()=>{
  expect(fileType(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
  expect(fileType(new Uint8Array([0x89,80,78,71,13,10,26,10]))?.mime).toBe('image/png');
 });
 it('requires authentication before model/provider access',async()=>{
  const fetcher=vi.fn();const handler=createHandler({env:k=>k==='SUPABASE_URL'?'https://project.supabase.co':'configured',fetcher,download:vi.fn()});
  const response=await handler(new Request('https://example.com',{method:'POST',body:JSON.stringify({action:'quote',model_id:'model'})}));
  expect(response.status).toBe(401);expect(fetcher).not.toHaveBeenCalled();
 });
 it('rejects methods and malformed bodies without spending',async()=>{
  const fetcher=vi.fn();const handler=createHandler({env:()=> 'configured',fetcher,download:vi.fn()});
  expect((await handler(new Request('https://example.com'))).status).toBe(405);
  expect((await handler(new Request('https://example.com',{method:'POST',body:'{'}))).status).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
 });
});
it('checks unsafe parameters recursively and preserves only validated defaults and nested customer rules',()=>{
 const structured={...model,input_schema:{schemas:{input_data:{type:'object',endpoint_url:'model',properties:{turns:{type:'array',items:{type:'object',required:['prompt'],properties:{prompt:{type:'string',description:'supplier cost secret'},api_key:{type:'string'}}}},seed:{type:'int',default:4,minValue:1,maxValue:8},invalid:{type:'int',default:99,maxValue:8}}}}}};
 expect(assessment(structured,'pro').blockers).toContain('UNSAFE_PARAMETER');
 const projected=customerModel(structured,'pro').schema as any;
 expect(projected.schemas.input_data.properties.turns.items.required).toEqual(['prompt']);
 expect(projected.schemas.input_data.properties.seed.default).toBe(4);
 expect(projected.schemas.input_data.properties.invalid.default).toBeUndefined();
 expect(JSON.stringify(projected)).not.toContain('supplier cost secret');
});
