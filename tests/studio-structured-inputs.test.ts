import {it,expect,vi} from 'vitest';
import {createHandler} from '../supabase/functions/studio-runtime/handler';
const workspace='11111111-1111-4111-8111-111111111111';
const user='22222222-2222-4222-8222-222222222222';
const model={id:user,provider_model_id:'structured',category:'Text to Image',account_access:'available',public_catalog_present:true,provider_enabled:true,coming_soon:false,runtime_enabled:true,spec_hash:'hash',
 input_schema:{schemas:{input_data:{type:'object',endpoint_url:'structured',required:['frames'],properties:{frames:{type:'array',maxItems:2,items:{type:'object',required:['image','strength'],properties:{image:{type:'string',field:'image'},strength:{type:'number',minimum:0,maximum:1}}}}}}}},
 runtime_config:{adapter:'muapi_prediction_v1',estimate_path:'/api/v1/models/structured/estimate-cost',credits:4,quota_kind:'image',max_cost_usd:1,verified_hash:'hash',verified_at:'2026-11-20',enabled:true,allowed_plans:['pro'],revision:1}};
function harness(){
 const calls:{url:string;body:any}[]=[];
 const fetcher=vi.fn(async(url: any,init?:RequestInit)=>{
  const u=String(url),body=typeof init?.body==='string'?JSON.parse(init.body):null;calls.push({url:u,body});
  if(u.endsWith('/auth/v1/user'))return Response.json({id:user});
  if(u.endsWith('/rpc/studio_runtime_access'))return Response.json({workspace_id:workspace,plan:'pro',credits:100});
  if(u.endsWith('/rpc/studio_runtime_rate'))return Response.json(true);
  if(u.endsWith('/rpc/studio_runtime_model'))return Response.json(model);
  if(u.endsWith('/rpc/studio_runtime_input'))return Response.json({metadata:{size:512}});
  if(u.includes('/storage/v1/object/sign/')&&init?.method==='POST')return Response.json({signedURL:`/object/sign/ugc-assets/${workspace}/studio-inputs/picture.png?token=private`});
  if(u.includes('/storage/v1/object/sign/')||u.includes('?token=private'))return new Response(new Uint8Array([137,80,78,71,13,10,26,10]));
  if(u.endsWith('/estimate-cost'))return Response.json({cost:0.2,currency:'USD'});
  if(u.endsWith('/rpc/studio_runtime_issue_quote'))return Response.json({quote_id:user,credits:4});
  throw new Error('Unexpected request '+u);
 });
 const handler=createHandler({env:k=>k==='SUPABASE_URL'?'https://project.supabase.co':'configured',fetcher,download:vi.fn()});
 const quote=(params:unknown)=>handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer session'},body:JSON.stringify({action:'quote',model_id:'structured',params})}));
 return {calls,quote};
}
it('rejects nested invalid parameters before signing, estimating or reserving credits',async()=>{
 const {calls,quote}=harness();const r=await quote({frames:[{image:`storage://${workspace}/studio-inputs/picture.png`,strength:2}]});
 expect(r.status).toBe(400);expect(calls.some(c=>/storage|estimate-cost|issue_quote|runtime_start/.test(c.url))).toBe(false);
});
it('rejects another workspace private input before signing or estimating',async()=>{
 const {calls,quote}=harness();const r=await quote({frames:[{image:`storage://${user}/studio-inputs/picture.png`,strength:0.5}]});
 expect(r.status).toBe(403);expect(calls.some(c=>/storage|estimate-cost|issue_quote/.test(c.url))).toBe(false);
});
it('never forwards arbitrary nested public URLs to MuAPI',async()=>{
 const {calls,quote}=harness();const r=await quote({frames:[{image:'https://example.com/image.png',strength:0.5}]});
 expect(r.status).toBe(400);expect(calls.some(c=>/storage|estimate-cost|issue_quote/.test(c.url))).toBe(false);
});

it('signs owned nested media and binds the same typed payload to a free estimate and quote, never generation',async()=>{
 const {calls,quote}=harness();const r=await quote({frames:[{image:`storage://${workspace}/studio-inputs/picture.png`,strength:0.5}]});
 expect(r.status).toBe(200);
 const estimate=calls.find(c=>c.url.endsWith('/estimate-cost'))!;
 expect(estimate.body.frames[0].image).toContain('https://project.supabase.co/storage/v1/object/sign/');
 expect(estimate.body.frames[0].strength).toBe(0.5);
 expect(calls.find(c=>c.url.endsWith('/rpc/studio_runtime_issue_quote'))?.body.p_params).toEqual(estimate.body);
 expect(calls.some(c=>/studio_runtime_start|wallet|finish|api\/v1\/structured$/.test(c.url))).toBe(false);
});
