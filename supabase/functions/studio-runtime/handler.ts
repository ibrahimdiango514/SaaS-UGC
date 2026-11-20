import { integrationProgress,protocolBinding,submissionId,familyResult,type Protocol } from './families.ts';
import { assessment,customerModel,fileType,parsePrediction,predictionId,record,UUID,type Json } from './core.ts';
import { validateMuapiInput,muapiDefaults } from '../universal-catalog/schema.ts';
import { extractProviderCostUsd,extractProviderCurrency } from '../_shared/video-quote.ts';
import { fetchMuapiCatalog } from '../universal-catalog/catalog.ts';
import { fetchMuapiDetail } from '../universal-catalog/details.ts';
import { MAX_BYTES } from './media.ts';
export interface Dependencies {env:(name:string)=>string; fetcher:typeof fetch; download:(url:string)=>Promise<Uint8Array>}
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info, x-reelora-worker-token','Access-Control-Allow-Methods':'POST, OPTIONS'};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:cors});
class RuntimeError extends Error {constructor(readonly code:string,readonly status=400){super(code);}}
const error=(code:string,status=400):never=>{throw new RuntimeError(code,status);};
export function createHandler(deps:Dependencies) {
 const {env,fetcher}=deps;
 const base=()=>env('SUPABASE_URL'),service=()=>env('SUPABASE_SERVICE_ROLE_KEY'),anon=()=>env('SUPABASE_ANON_KEY')||env('SUPABASE_PUBLISHABLE_KEY');
 const headers=(jwt?:string)=>({apikey:jwt?anon():service(),Authorization:jwt||`Bearer ${service()}`,'Content-Type':'application/json'});
 async function rpc(name:string,args:Json={},jwt?:string):Promise<any> {
  const res=await fetcher(`${base()}/rest/v1/rpc/${name}`,{method:'POST',headers:headers(jwt),body:JSON.stringify(args),signal:AbortSignal.timeout(20000)});
  if (!res.ok) {
   const raw=record(await res.json().catch(()=>({})));
   const allowed=['subscription_required','not_authenticated','admin_not_customer','not_vyora_customer','account_not_active','verification_required','quote_expired','model_unavailable','daily_budget_exceeded','concurrency_limit','runtime_disabled','quote_unavailable','invalid_plan'];
   error(allowed.includes(raw.message)?raw.message.toUpperCase():'ACCESS_OR_STATE_REJECTED',res.status===401?401:409);
  }
  return res.json();
 }
 async function provider(path:string,body?:Json) {
  const key=env('MUAPI_API_KEY'); if(!key) error('PROVIDER_NOT_CONFIGURED',503);
  const res=await fetcher(`https://api.muapi.ai${path}`,{method:body?'POST':'GET',headers:{'x-api-key':key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!res.ok) error('PROVIDER_REQUEST_FAILED',503);
  const text=await res.text(); if(text.length>1048576) error('PROVIDER_RESPONSE_INVALID',503);
  return record(JSON.parse(text));
 }
 async function sign(path:string) {
  const encoded=path.split('/').map(encodeURIComponent).join('/');
  const res=await fetcher(`${base()}/storage/v1/object/sign/ugc-assets/${encoded}`,{method:'POST',headers:headers(),body:JSON.stringify({expiresIn:7200}),signal:AbortSignal.timeout(15000)});
  if(!res.ok) error('FILE_UNAVAILABLE',409);
  const data=record(await res.json());
  const signed=new URL(data.signedURL,base()+'/storage/v1/');
  // Storage returns /object/sign/... relative to /storage/v1, not the origin.
  const url=String(data.signedURL).startsWith('/object/')?base()+'/storage/v1'+data.signedURL:signed.toString();
  if(new URL(url).origin!==new URL(base()).origin) error('FILE_UNAVAILABLE',409);
  return url;
 }
 async function inputParams(model:Json,params:unknown,jwt:string,ctx:Json) {
  params=muapiDefaults(model.input_schema,params);
  const a=assessment(model),raw=record(params),out:Json={...raw};
  if(!a.fields) error('SCHEMA_UNSUPPORTED',409);
  if(!params||typeof params!=='object'||Array.isArray(params))error('PARAMETER_INVALID');
  // Validate the entire shape before Storage lookups/signing. Markers are only
  // substituted in this non-network preflight; real media still require ownership.
  const preflight=(v:unknown):unknown=>typeof v==='string'&&v.startsWith('storage://')?'https://storage.example.com/private-input':Array.isArray(v)?v.map(preflight):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,preflight(x)])):v;
  const check=validateMuapiInput(model.input_schema,preflight(params));if(!check.ok)error(check.code);

  async function resolve(d:Json,value:unknown):Promise<unknown> {
   if(value===undefined)return undefined;
   if(d.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value)) {
    const resolved:Json={};for(const [k,v] of Object.entries(value)) {
     if(!Object.hasOwn(record(d.properties),k))error('PARAMETER_INVALID');
     Object.defineProperty(resolved,k,{value:await resolve(d.properties[k],v),enumerable:true});
    }return resolved;
   }
   if(d.type==='array'&&!d.field) {
    if(!Array.isArray(value)||value.length>256)error('PARAMETER_INVALID');
    return Promise.all((value as unknown[]).map(v=>resolve(record(d.items),v)));
   }
   if(!d.field&&d.format!=='uri'&&d.format!=='url')return value;
   const values=d.type==='array'?value:[value];
   if(!Array.isArray(values)||values.length>256)error('PARAMETER_INVALID');
   const signed:string[]=[];
   for(const value of values as unknown[]) {
    if(value===undefined) continue;
    if(typeof value!=='string'||!value.startsWith('storage://')) error('PRIVATE_UPLOAD_REQUIRED');
    const path=(value as string).slice(10);
    if(!path.startsWith(ctx.workspace_id+'/studio-inputs/')) error('FILE_FORBIDDEN',403);
    const info=await rpc('studio_runtime_input',{p_path:path},jwt);
    const size=Number(info?.metadata?.size);
    if(!info||!Number.isFinite(size)||size<=0||size>MAX_BYTES) error('FILE_SIZE_INVALID');
    const url=await sign(path);
    // Only the fixed, authenticated Storage origin is fetched, never a client URL.
    const response=await fetcher(url,{headers:{Range:'bytes=0-511'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.body) error('FILE_UNAVAILABLE');
    const reader=response.body!.getReader(); const chunks:Uint8Array[]=[];let total=0;
    try {while(total<512){const next=await reader.read();if(next.done)break;chunks.push(next.value.slice(0,512-total));total+=chunks[chunks.length-1].length;}} finally{await reader.cancel();}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const type=fileType(bytes),kind=String(d.field??'').replace(/s_list$/,'');
    if(!type || kind && kind!==type.kind) error('FILE_TYPE_INVALID');
    signed.push(url);
   }
   return d.type==='array'?signed:signed[0];
  }
  for(const field of a.fields!)if(Object.hasOwn(raw,field.key))out[field.key]=await resolve(field.definition,raw[field.key]);
  const validated=validateMuapiInput(model.input_schema,out);
  if(!validated.ok) error(validated.code);
  return validated.ok?validated.value:{};
 }
 async function uploadResult(job:Json,index:number,url:string) {
  const bytes=await deps.download(url);if(!bytes.length||bytes.length>MAX_BYTES) error('RESULT_FILE_INVALID');
  const type=fileType(bytes);if(!type) error('RESULT_FILE_UNSUPPORTED');
  const path=`${job.workspace_id}/studio-results/${job.id}/${index}.${type!.ext}`;
  const res=await fetcher(`${base()}/storage/v1/object/ugc-assets/${path}`,{method:'POST',headers:{...headers(),'Content-Type':type!.mime,'x-upsert':'true'},body:bytes as unknown as BodyInit,signal:AbortSignal.timeout(60000)});
  if(!res.ok) error('RESULT_STORAGE_FAILED',503);
  return {kind:'file',path,mime:type!.mime,size:bytes.length};
 }
 async function reconcile(job:Json) {
  if(!job.provider_id) return;
  const raw=await provider(`/api/v1/predictions/${encodeURIComponent(job.provider_id)}/result`);
  const data=record(raw.data??raw);
  if(data.id && data.id!==job.provider_id || data.request_id && data.request_id!==job.provider_id) error('RESULT_ID_MISMATCH',503);
  const parsed=job.protocol_key?familyResult(job.protocol_key as Protocol,data,job.provider_id,job.result_field):parsePrediction(data,job.output_kind);
  if(parsed.state==='pending') return;
  const outputs:Json[]=[];
  if(parsed.text) outputs.push({kind:'text',text:parsed.text});
  for(let i=0;i<parsed.media.length;i++) outputs.push(await uploadResult(job,i,parsed.media[i]));
  const actual=extractProviderCurrency(data,'')==='USD'?extractProviderCostUsd(data):null;
  await rpc('studio_runtime_finish',{p_job_id:job.id,p_status:parsed.state,p_outputs:outputs,p_actual_usd:actual});
 }
 async function history(jwt:string,before?:string) {
  const rows=await rpc('studio_runtime_history',{...(before?{p_before:before}:{}),p_limit:30},jwt);
  for(const row of rows) for(const output of row.outputs) if(output.kind==='file') {
   if(typeof output.path!=='string'||!UUID.test(output.path.split('/')[0])||!output.path.includes(`/studio-results/${row.id}/`)) error('RESULT_FILE_INVALID',503);
   output.url=await sign(output.path);
  }
  return rows;
 }
 async function worker(body:Json,token:string) {
  const expected=await rpc('reelora_worker_token');
  if(typeof expected!=='string'||!expected||!token||expected.length!==token.length) error('FORBIDDEN',403);
  let diff=0;for(let i=0;i<token.length;i++)diff|=token.charCodeAt(i)^expected.charCodeAt(i);if(diff)error('FORBIDDEN',403);
  if(body.task==='integrations') {
   const documentation=await fetcher('https://api.muapi.ai/openapi.json',{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!documentation.ok)error('OFFICIAL_CONTRACT_UNAVAILABLE',503);
   const documentationText=await documentation.text();
   if(documentationText.length>20000000)error('OFFICIAL_CONTRACT_TOO_LARGE',503);
   const openapi=record(JSON.parse(documentationText));
   openapi.__document_sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(documentationText)))).map(b=>b.toString(16).padStart(2,'0')).join('');
   if(!record(openapi.paths)['/api/v1/predictions/{id}/result']?.get)error('OFFICIAL_CONTRACT_UNAVAILABLE',503);
   let after='',assessed=0,prepared=0;
   let accountIds:Set<string>|null=null;
   if(env('MUAPI_API_KEY')) {try{const account=await fetchMuapiCatalog(fetcher,env('MUAPI_API_KEY'));accountIds=new Set(account.models.map(m=>m.provider_model_id));}catch{/* A public listing or failed account probe never proves model access. */}}
   for(let page=0;page<1000;page++) {
    const batch=await rpc('studio_runtime_models',{p_after:after,p_limit:100});
    for(const model of batch.items) {const progress=integrationProgress(model,openapi);const report={...progress,stages:{...progress.stages,authenticated_catalog_visible:accountIds?.has(model.provider_model_id)??false}};if(await rpc('studio_save_integration',{p_model_id:model.id,p_hash:model.spec_hash,p_report:report})){assessed++;if(report.status==='integration_prepared')prepared++;}}
    if(batch.items.length<100)return {assessed,prepared,authenticated_catalog_visible:accountIds?.size??0,paid_requests:0};
    after=batch.items[batch.items.length-1].provider_model_id;
   }
   error('CATALOG_TOO_LARGE',503);
  }
  if(body.task==='catalog') {
   const snapshot=await fetchMuapiCatalog(fetcher);
   return await rpc('studio_sync_muapi_catalog',{p_models:snapshot.models,p_scope:'public'});
  }
  if(body.task==='details') {
   const candidates=await rpc('studio_muapi_detail_candidates',{p_limit:10});let ok=0;
   for(const candidate of candidates) {
    const detail=await fetchMuapiDetail(fetcher,candidate.provider_model_id);
    if(await rpc('studio_save_muapi_detail',{p_model_id:detail.model_id,p_status:detail.status,p_http_status:detail.http_status,
      p_input_schema:detail.input_schema?{...detail.input_schema,vyora_endpoint_evidence:detail.endpoint_evidence}:null,p_output_schema:detail.output_schema}))ok++;
   }
   return {attempted:candidates.length,saved:ok};
  }
  if(body.task!=='poll')error('INVALID_ACTION');
  const jobs=await rpc('studio_runtime_due');let reconciled=0;
  for(const job of jobs) {try{await reconcile(job);reconciled++;}catch{/* Retry GET/storage only on a later tick. Never resubmit. */}}
  return {checked:jobs.length,reconciled};
 }
 return async function handler(req:Request):Promise<Response> {
  if(req.method==='OPTIONS') return new Response(null,{headers:cors});
  if(req.method!=='POST')return reply({error:{code:'METHOD_NOT_ALLOWED'}},405);
  try {
   if(!base()||!service()||!anon())error('SERVER_NOT_CONFIGURED',503);
   const text=await req.text();if(text.length>131072)error('BODY_TOO_LARGE',413);
   let body:Json;try{body=record(JSON.parse(text));}catch{error('INVALID_BODY');}
   const action=body!.action;
   if(action==='worker')return reply(await worker(body!,req.headers.get('x-reelora-worker-token')??''));
   const jwt=req.headers.get('Authorization')??'';if(!jwt.startsWith('Bearer '))error('UNAUTHENTICATED',401);
   const auth=await fetcher(`${base()}/auth/v1/user`,{headers:headers(jwt),signal:AbortSignal.timeout(15000)});
   if(!auth.ok)error('UNAUTHENTICATED',401);
   const user=record(await auth.json());if(!UUID.test(user.id))error('UNAUTHENTICATED',401);
   if(action==='admin_progress')return reply(await rpc('studio_integration_progress',{p_after:body!.after??'',p_family:body!.family??'',p_status:body!.status??'',p_query:body!.query??''},jwt));
   if(action==='admin_report')return reply(await rpc('studio_runtime_sync_report',{},jwt));
   if(action==='admin_reconcile')return reply({saved:await rpc('studio_runtime_admin_reconcile',{p_job_id:body!.job_id,p_provider_id:body!.provider_id,p_reference:body!.reference},jwt)});
   if(action==='admin_limits')return reply({saved:await rpc('studio_runtime_admin_limits',{p_enabled:body!.enabled,p_daily_usd:body!.daily_usd},jwt)});
   if(action==='admin_config') {
    const config=await rpc('studio_runtime_admin_config',{p_model_id:body!.model_id,p_config:body!.config??null},jwt);
    const model=await rpc('studio_runtime_model',{p_model_id:body!.model_id});
    return reply({...config,assessment:model?{...assessment(model),fields:undefined}:null});
   }
   const ctx=await rpc('studio_runtime_access',{},jwt);
   if(action==='models') {
    const page=await rpc('studio_runtime_models',{p_after:typeof body!.after==='string'?body!.after:'',p_query:typeof body!.query==='string'?body!.query:'',p_category:typeof body!.category==='string'?body!.category:'',p_limit:50});
    return reply({total:page.total,categories:page.categories,items:page.items.map((m:Json)=>customerModel(m,ctx.plan)),next_cursor:page.items.length===50?page.items[49].provider_model_id:null,credits:ctx.credits,workspace_id:ctx.workspace_id});
   }
   if(action==='history')return reply({jobs:await history(jwt,body!.before)});
   if(action==='quote') {
    if(!await rpc('studio_runtime_rate',{p_user_id:user.id,p_action:'quote'}))error('RATE_LIMITED',429);
    const model=await rpc('studio_runtime_model',{p_model_id:body!.model_id});
    if(!model||!assessment(model,ctx.plan).operational)error('MODEL_NOT_OPERATIONAL',409);
    const params=await inputParams(model,body!.params,jwt,ctx);
    const estimated=await provider(model.runtime_config.estimate_path,params);
    const cost=extractProviderCostUsd(estimated);
    if(extractProviderCurrency(estimated,'')!=='USD'||cost===null||cost<=0||cost>Number(model.runtime_config.max_cost_usd))error('QUOTE_UNAVAILABLE',409);
    const quote=await rpc('studio_runtime_issue_quote',{p_user_id:user.id,p_model_id:model.id,p_params:params,p_cost:cost,p_hash:model.spec_hash,p_revision:model.runtime_config.revision});
    return reply({...quote,balance:ctx.credits});
   }
   if(action==='start') {
    if(!UUID.test(body!.quote_id)||!UUID.test(body!.request_key))error('INVALID_REQUEST');
    if(!env('MUAPI_API_KEY'))error('PROVIDER_NOT_CONFIGURED',503);
    const started=await rpc('studio_runtime_start',{p_quote_id:body!.quote_id,p_request_key:body!.request_key},jwt);
    if(started.new) {
     try {
      const job=await rpc('studio_runtime_job',{p_job_id:started.id,p_user_id:user.id});
      const model=await rpc('studio_runtime_model',{p_model_id:job.provider_model_id});
      const a=assessment(model,ctx.plan);if(!a.operational||!a.endpoint.path)error('MODEL_NOT_OPERATIONAL',409);
      const submitted=await provider(`/api/v1/${a.endpoint.path}`,job.params);
      const id=protocolBinding(model)?submissionId(submitted):predictionId(submitted);if(!id)error('SUBMISSION_UNCERTAIN',409);
      if(!await rpc('studio_runtime_submitted',{p_job_id:job.id,p_provider_id:id}))error('SUBMISSION_UNCERTAIN',409);
     } catch { await rpc('studio_runtime_uncertain',{p_job_id:started.id}); }
    }
    return reply({job_id:started.id,status:'accepted'});
   }
   if(action==='status') {
    if(!UUID.test(body!.job_id))error('INVALID_REQUEST');
    const job=await rpc('studio_runtime_job',{p_job_id:body!.job_id,p_user_id:user.id});if(!job)error('JOB_NOT_FOUND',404);
    const due=await rpc('studio_runtime_due',{p_job_id:job.id});for(const j of due)try{await reconcile(j);}catch{/* Poll remains retryable, submission does not. */}
    const updated=await rpc('studio_runtime_job',{p_job_id:job.id,p_user_id:user.id});
    return reply({job_id:updated.id,status:updated.status,credits:updated.credits,error_code:updated.error_code});
   }
   return error('INVALID_ACTION');
  } catch(e) {return reply({error:{code:e instanceof RuntimeError?e.code:'RUNTIME_UNAVAILABLE',message:'La demande n’a pas pu être traitée. Consultez le statut avant de réessayer une génération.'}},e instanceof RuntimeError?e.status:503);}
 };
}
