import {it,expect,vi} from 'vitest';
import {createHandler} from '../supabase/functions/studio-runtime/handler';
it('reconciles a declared text job through the real runtime path without downloads or provider submission',async()=>{
 const calls:{url:string;method:string;body:any}[]=[];
 const download=vi.fn();
 const fetcher=vi.fn(async(url:any,init?:RequestInit)=>{
  const u=String(url);calls.push({url:u,method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});
  if(u.endsWith('/rpc/reelora_worker_token'))return Response.json('worker');
  if(u.endsWith('/rpc/studio_runtime_due'))return Response.json([{id:'job',provider_id:'prediction',protocol_key:'muapi_output_text_v1',output_kind:'text'}]);
  if(u.endsWith('/api/v1/predictions/prediction/result'))return Response.json({id:'prediction',status:'completed',output:{text:'<script>untrusted text</script>'}});
  if(u.endsWith('/rpc/studio_runtime_finish'))return Response.json(true);
  throw new Error('Unexpected request '+u);
 });
 const handler=createHandler({env:k=>k==='SUPABASE_URL'?'https://project.supabase.co':'configured',fetcher,download});
 const r=await handler(new Request('https://example.com',{method:'POST',headers:{'x-reelora-worker-token':'worker'},body:'{"action":"worker","task":"poll"}'}));
 expect(r.status).toBe(200);expect(await r.json()).toMatchObject({checked:1,reconciled:1});
 expect(calls.find(c=>c.url.endsWith('/rpc/studio_runtime_finish'))?.body).toMatchObject({p_status:'succeeded',p_outputs:[{kind:'text',text:'<script>untrusted text</script>'}],p_actual_usd:null});
 expect(download).not.toHaveBeenCalled();expect(calls.filter(c=>c.url.includes('api.muapi.ai')).every(c=>c.method==='GET')).toBe(true);
});
