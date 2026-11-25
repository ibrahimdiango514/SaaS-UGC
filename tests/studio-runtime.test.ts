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

/**
 * Messages d'erreur — un refus d'accès n'est pas une panne.
 *
 * Constat de production (2026-11-25) : `action:'quotas'` renvoyait 409
 * SUBSCRIPTION_REQUIRED avec le message générique « Consultez le statut avant de
 * réessayer une génération ». Deux défauts : on parle de génération à quelqu'un
 * qui consulte ses quotas, et on l'invite à réessayer un refus définitif.
 */
describe('messages d’erreur compréhensibles',()=>{
 function handlerQuiRefuse(status:number,corps:Record<string,unknown>){
  const fetcher=vi.fn(async(url:string)=>{
   if(String(url).includes('/auth/v1/user'))return new Response(JSON.stringify({id:'11111111-1111-4111-8111-111111111111'}),{status:200});
   if(String(url).includes('/rest/v1/rpc/'))return new Response(JSON.stringify(corps),{status});
   return new Response('{}',{status:200});
  });
  return createHandler({env:k=>k==='SUPABASE_URL'?'https://project.supabase.co':'configured',fetcher:fetcher as any,download:vi.fn()});
 }
 const request=(body:unknown)=>new Request('https://example.com',{method:'POST',headers:{authorization:'Bearer jeton'},body:JSON.stringify(body)});

 it('explique un refus d’abonnement au lieu de parler de génération',async()=>{
  const reponse=await handlerQuiRefuse(409,{message:'subscription_required'})(
   request({action:'quotas'}));
  const corps=await reponse.json() as any;
  expect(reponse.status).toBe(409);
  expect(corps.error.code).toBe('SUBSCRIPTION_REQUIRED');
  expect(corps.error.message).toMatch(/abonnés actifs/);
  expect(corps.error.message).not.toMatch(/génération/i);
 });

 it('ne dit pas « réessayez une génération » sur une simple lecture de quotas',async()=>{
  // Panne technique réelle : le message doit rester prudent, sans promesse fausse.
  const reponse=await handlerQuiRefuse(500,{message:'connexion impossible'})(
   request({action:'quotas'}));
  const corps=await reponse.json() as any;
  expect(corps.error.code).toBe('ACCESS_OR_STATE_REJECTED');
  expect(corps.error.message).not.toMatch(/génération/i);
 });

 it('garde un message générique prudent pour une panne du handler',async()=>{
  const fetcher=vi.fn(async()=>{throw new Error('réseau coupé');});
  const handler=createHandler({env:()=> 'configured',fetcher:fetcher as any,download:vi.fn()});
  const reponse=await handler(request({action:'quotas'}));
  expect(reponse.status).toBe(503);
  const corps=await reponse.json() as any;
  expect(corps.error.code).toBe('RUNTIME_UNAVAILABLE');
  expect(corps.error.message).toMatch(/indisponible/i);
 });

 it('donne toujours un code et un message, jamais un message vide',async()=>{
  const handler=handlerQuiRefuse(409,{message:'quota_exceeded:audio:5:5'});
  const corps=await (await handler(request({action:'models'}))).json() as any;
  expect(corps.error.code).toBe('QUOTA_EXCEEDED');
  expect(corps.error.message.length).toBeGreaterThan(10);
 });
});

// ===========================================================================
describe('Studio Runtime — aucun 500 possible depuis notre code', () => {
  /**
   * Incident du 25/11/2026 : deux réponses HTTP 500 observées en production.
   *
   * Ce test établit un FAIT qui oriente le diagnostic : le gestionnaire ne peut
   * pas produire 500. Toute erreur est convertie en `RuntimeError` (400/401/403/
   * 409/413/429/503) ou, pour un imprévu, en 503 `RUNTIME_UNAVAILABLE` :
   *
   *     return reply({error:{code,message}}, e instanceof RuntimeError ? e.status : 503);
   *
   * Un 500 ne peut donc venir que de la PLATEFORME, avant l'exécution de ce
   * code — typiquement un échec de chargement de module (import manquant ou
   * chemin relatif cassé : cette fonction importe `../universal-catalog/*`,
   * `../_shared/*` et `../../../src/business/importer/url-guard.ts`).
   *
   * Ce test protège la conclusion : si quelqu'un introduit un `catch` qui
   * laisse remonter une erreur brute, la garantie disparaît et ce test le dit.
   */
  const deps = {
    env: () => '',
    fetcher: vi.fn(async () => new Response('{}')),
    download: vi.fn(async () => new Uint8Array()),
  };

  it('un corps non-JSON donne 400 INVALID_BODY, pas 500', async () => {
    // Il faut une configuration présente : elle est contrôlée AVANT le corps
    // (sans quoi la réponse serait 503 SERVER_NOT_CONFIGURED, ce qui est
    // également correct mais ne teste pas ce point).
    const configure = {
      ...deps,
      env: (k: string) => ({
        SUPABASE_URL: 'https://exemple.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        SUPABASE_ANON_KEY: 'anon',
      } as Record<string, string>)[k] ?? '',
    };
    const handler = createHandler(configure as never);
    const res = await handler(new Request('https://x.test', {
      method: 'POST', body: 'ceci-n-est-pas-du-json',
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_BODY');
  });

  it('une méthode non POST donne 405, pas 500', async () => {
    const handler = createHandler(deps as never);
    const res = await handler(new Request('https://x.test', { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('une configuration serveur absente donne 503, pas 500', async () => {
    // `env` ne renvoie rien : toutes les variables sont vides.
    const handler = createHandler(deps as never);
    const res = await handler(new Request('https://x.test', {
      method: 'POST', body: JSON.stringify({ action: 'models' }),
    }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('SERVER_NOT_CONFIGURED');
  });

  it('aucun appel au fournisseur n’a lieu quand la configuration manque', async () => {
    const fetcher = vi.fn(async () => new Response('{}'));
    const handler = createHandler({ ...deps, fetcher } as never);
    await handler(new Request('https://x.test', {
      method: 'POST', body: JSON.stringify({ action: 'quote', model_id: 'x' }),
    }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('le code de repli est bien 503, jamais 500', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../supabase/functions/studio-runtime/handler.ts', import.meta.url), 'utf8');
    // La ligne exacte qui garantit l'absence de 500.
    expect(source).toMatch(/new RuntimeError\(code,status\)/);
    expect(source).toMatch(/e instanceof RuntimeError\?e\.status:503/);
    // Aucun `status: 500` codé en dur dans ce gestionnaire.
    expect(source).not.toMatch(/status:\s*500/);
    expect(source).not.toMatch(/,\s*500\s*\)/);
  });
});
