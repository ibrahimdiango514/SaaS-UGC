import {describe,it,expect,vi} from 'vitest';
import {createHandler} from '../supabase/functions/studio-runtime/handler';
import {assessment,customerModel,fileType} from '../supabase/functions/studio-runtime/core';

/**
 * Parcours Studio complet SIMULÉ — aucun fournisseur réel, aucun crédit.
 *
 * Devis serveur → réservation → soumission → polling → résultat → historique.
 * Les réponses fournisseur sont des mocks : ce test prouve le câblage et les
 * protections (double soumission, débit unique), jamais le comportement réel
 * d'un fournisseur.
 */
const BASE='https://project.supabase.co';
const UID='11111111-1111-4111-8111-111111111111';
const WS='22222222-2222-4222-8222-222222222222';
const JOB='33333333-3333-4333-8333-333333333333';
const QUOTE='44444444-4444-4444-8444-444444444444';
const KEY='55555555-5555-4555-8555-555555555555';
const PNG=new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
const model={id:'66666666-6666-4666-8666-666666666666',provider_model_id:'model',display_name:'Model',category:'image',
  account_access:'available',public_catalog_present:true,provider_enabled:true,coming_soon:false,runtime_enabled:true,
  spec_hash:'abc',endpoint_evidence:{endpoint:'/api/v1/model'},
  input_schema:{schemas:{input_data:{type:'object',endpoint_url:'model',properties:{prompt:{type:'string'}},required:['prompt']}}},
  runtime_config:{adapter:'muapi_prediction_v1',estimate_path:'/api/v1/models/model/estimate-cost',credits:4,
    quota_kind:'image',max_cost_usd:0.1,verified_hash:'abc',verified_at:'2026-11-20',enabled:true,allowed_plans:['pro'],revision:3}};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

describe('parcours Studio simulé de bout en bout',()=>{
 it('enchaîne devis, réservation, soumission unique, polling et résultat',async()=>{
  let finished=false,started=0,submitted=0;
  const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=String(input);const body=typeof init?.body==='string'?JSON.parse(init.body):{};
   if(url===`${BASE}/auth/v1/user`)return json({id:UID});
   if(url.startsWith(`${BASE}/rest/v1/rpc/`)){
    const name=url.split('/').pop();
    if(name==='studio_runtime_access')return json({user_id:UID,workspace_id:WS,credits:10,plan:'pro'});
    if(name==='studio_runtime_rate')return json(true);
    if(name==='studio_runtime_quotas')return json({plan:'pro',period:'2026-11',items:[{family:'image',display_name:'Image',generator:true,limit:20,used:0,remaining:20,policy:'active'}]});
    if(name==='studio_runtime_model')return json(model);
    if(name==='studio_runtime_issue_quote')return json({quote_id:QUOTE,credits:4,expires_at:new Date(Date.now()+120000).toISOString()});
    if(name==='studio_runtime_start'){const isNew=started===0;started++;return json({id:JOB,new:isNew});}
    if(name==='studio_runtime_job')return json({id:JOB,workspace_id:WS,provider_model_id:'model',params:{prompt:'hello'},
      provider_id:submitted?'pred-1':null,status:finished?'succeeded':'processing',credits:4,output_kind:'media',protocol_key:null,result_field:null});
    if(name==='studio_runtime_submitted'){submitted++;return json(true);}
    if(name==='studio_runtime_due')return json(finished?[]:[{id:JOB,workspace_id:WS,provider_id:'pred-1',status:'processing',protocol_key:null,result_field:null,output_kind:'media'}]);
    if(name==='studio_runtime_finish'){finished=true;return json(true);}
    if(name==='studio_runtime_history')return json(finished?[{id:JOB,status:'succeeded',credits:4,created_at:'2026-11-20T00:00:00Z',updated_at:'2026-11-20T00:00:01Z',
      display_name:'Model',provider_model_id:'model',error_code:null,outputs:[{kind:'file',path:`${WS}/studio-results/${JOB}/0.png`,mime:'image/png'}]}]:[]);
    if(name==='studio_runtime_uncertain')return json(true);
    return json({});
   }
   if(url===`${BASE}/storage/v1/object/sign/ugc-assets/${WS}/studio-results/${JOB}/0.png`)return json({signedURL:'/object/sign/ugc-assets/x?token=t'});
   if(url===`https://api.muapi.ai/api/v1/models/model/estimate-cost`)return json({cost_usd:0.1,currency:'USD'});
   if(url===`https://api.muapi.ai/api/v1/model`)return json({request_id:'pred-1'});
   if(url===`https://api.muapi.ai/api/v1/predictions/pred-1/result`)return json({status:'completed',outputs:['https://cdn.example.com/result.png'],currency:'USD',cost:0.1});
   if(url.startsWith(`${BASE}/storage/v1/object/ugc-assets/`))return json({});
   throw new Error(`unexpected fetch ${url} ${JSON.stringify(body)}`);
  });
  const handler=createHandler({env:k=>k==='SUPABASE_URL'?BASE:k==='MUAPI_API_KEY'?'test-key':'configured',fetcher,download:vi.fn(async()=>PNG)});
  const call=async(action:string,body:Record<string,unknown>={})=>{
   const response=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer token'},
     body:JSON.stringify({action,...body})}));
   return {status:response.status,body:await response.json() as Record<string,any>};
  };
  const quote=await call('quote',{model_id:'model',params:{prompt:'hello'}});
  expect(quote.status).toBe(200);expect(quote.body).toMatchObject({quote_id:QUOTE,credits:4,balance:10});
  const first=await call('start',{quote_id:QUOTE,request_key:KEY});
  expect(first.body).toMatchObject({job_id:JOB,status:'accepted'});
  const replay=await call('start',{quote_id:QUOTE,request_key:KEY});
  expect(replay.body).toMatchObject({job_id:JOB,status:'accepted'});
  // La double soumission ne renvoie AUCUNE seconde requête fournisseur.
  expect(submitted).toBe(1);
  expect(fetcher.mock.calls.filter(([url])=>String(url)===`https://api.muapi.ai/api/v1/model`)).toHaveLength(1);
  const polled=await call('status',{job_id:JOB});
  expect(polled.body).toMatchObject({job_id:JOB,status:'succeeded'});
  const history=await call('history');
  expect(history.body.jobs[0]).toMatchObject({id:JOB,status:'succeeded',credits:4});
  expect(history.body.jobs[0].outputs[0]).toMatchObject({kind:'file',mime:'image/png'});
  expect(history.body.jobs[0].outputs[0].url).toContain('/storage/v1/');
  // Un second polling après un statut terminal ne relit pas le fournisseur.
  const resultReads=()=>fetcher.mock.calls.filter(([url])=>String(url).includes('/predictions/pred-1/result')).length;
  const readsAfterFinish=resultReads();
  await call('status',{job_id:JOB});
  expect(resultReads()).toBe(readsAfterFinish);
 });

 it('refuse une génération sans droit d’abonnement ou sans quota, sans appeler le fournisseur',async()=>{
  const calls:string[]=[];
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>{
   const url=String(input);calls.push(url);
   if(url===`${BASE}/auth/v1/user`)return json({id:UID});
   if(url.endsWith('/studio_runtime_access'))return json({user_id:UID,workspace_id:WS,credits:10,plan:'free'});
   if(url.endsWith('/studio_runtime_rate'))return json(true);
   if(url.endsWith('/studio_runtime_model'))return json(model);
   if(url.endsWith('/rpc/studio_runtime_issue_quote'))return json({message:'quota_policy_missing:image'},409);
   return json({});
  });
  const handler=createHandler({env:k=>k==='SUPABASE_URL'?BASE:k==='MUAPI_API_KEY'?'test-key':'configured',fetcher,download:vi.fn()});
  const response=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer token'},
    body:JSON.stringify({action:'quote',model_id:'model',params:{prompt:'hello'}})}));
  // Le modèle n'est pas inclus dans l'offre « free » : refus avant tout devis.
  expect(response.status).toBe(409);
  expect((await response.json() as any).error.code).toBe('MODEL_NOT_OPERATIONAL');
  expect(calls.some(url=>url.startsWith('https://api.muapi.ai'))).toBe(false);
 });

 it('projette le droit d’offre séparément de la préparation technique',()=>{
  expect(assessment(model,'free')).toMatchObject({operational:false,planAllowed:false});
  expect(assessment(model,'free').technicalBlockers).not.toContain('PLAN_UNAVAILABLE');
  expect(assessment(model,'pro')).toMatchObject({operational:true,planAllowed:true,technicalBlockers:[]});
  expect(customerModel(model,'free')).toMatchObject({plan_allowed:false,quota_family:'image'});
  expect(fileType(PNG)).toMatchObject({mime:'image/png',kind:'image'});
 });
});
