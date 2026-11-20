import {it,expect,vi} from 'vitest';
import {createHandler} from '../supabase/functions/studio-runtime/handler';
it('persists family binding from model contracts without calling generation or financial RPCs',async()=>{
 const calls:{url:string;body:any;method:string}[]=[];
 const props={id:{type:'string'},status:{type:'string'},output:{type:'array',items:{type:'string',format:'uri'}}};
 const model={id:'11111111-1111-4111-8111-111111111111',provider_model_id:'declared-model',category:'Text to Image',spec_hash:'hash',input_schema:{schemas:{input_data:{type:'object',endpoint_url:'actual-declared-path',properties:{prompt:{type:'string'}},required:['prompt']}}},output_schema:{schemas:{type:'object',properties:props}}};
 const fetcher=vi.fn(async(url:any,init?:RequestInit)=>{
  const body=init?.body?JSON.parse(String(init.body)):null;calls.push({url:String(url),body,method:init?.method??'GET'});
  if(String(url)==='https://api.muapi.ai/openapi.json')return Response.json({paths:{'/api/v1/actual-declared-path':{post:{operationId:'declared'}},'/api/v1/predictions/{id}/result':{get:{}}}});
  if(String(url).includes('reelora_worker_token'))return Response.json('worker-token');
  if(String(url).includes('studio_runtime_models'))return Response.json({items:[model]});
  if(String(url).includes('studio_save_integration'))return Response.json(true);
  throw new Error('Unexpected network request: '+url);
 });
 const handler=createHandler({env:k=>k==='MUAPI_API_KEY'?'':k==='SUPABASE_URL'?'https://project.supabase.co':'configured',fetcher,download:vi.fn()});
 const response=await handler(new Request('https://example.com',{method:'POST',headers:{'x-reelora-worker-token':'worker-token'},body:JSON.stringify({action:'worker',task:'integrations'})}));
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({assessed:1,prepared:1,paid_requests:0});
 const saved=calls.find(c=>c.url.includes('studio_save_integration'))!;
 expect(saved.body.p_report.protocol).toBe('muapi_output_urls_v1');expect(saved.body.p_hash).toBe('hash');
 expect(calls.some(c=>/studio_runtime_start|issue_quote|wallet|finish/.test(c.url))).toBe(false);
});
