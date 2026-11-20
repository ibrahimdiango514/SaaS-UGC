/** Evidence-bound batch adapters. Functional family is NOT a protocol guess.
 * Bindings require the declared response contract; names never determine URLs.
 */
import {muapiFormFields,validateMuapiInput,isHttpsInput} from '../universal-catalog/schema.ts';
import {resolveMuapiEndpoint} from '../universal-catalog/endpoint.ts';
type Obj=Record<string,any>;
const obj=(x:unknown):Obj=>x&&typeof x==='object'&&!Array.isArray(x)?x as Obj:{};
export const PROTOCOL_VERSION='muapi-families-3';
export type Protocol='muapi_output_envelope_v1'|'muapi_output_urls_v1'|'muapi_output_media_v1'|'muapi_output_media_list_v1';
export function classifyFamily(model:Obj):string {
 const categories:Record<string,string>={'Text to Image':'text-to-image','Image to Image':'image-to-image','Text to Video':'text-to-video','Image to Video':'image-to-video','Video to Video':'video-to-video','Text to Audio':'audio-generation','Audio to Video':'audio-to-video','Text to Text':'text','Image to 3D':'image-to-3d','Text to 3D':'text-to-3d','Training':'training','Lora Support':'lora'};
 // Distinct editing/upscale/TTS/lip-sync labels require provider capability
 // evidence. Do not relabel a model based on marketing words in its ID.
 return categories[model.category]??'other';
}
export function responseField(model:Obj):string|null {
 const fields=obj(obj(obj(obj(model.output_schema).schemas).properties).output).properties;
 const entries=Object.entries(obj(fields)).filter(([,raw])=>{const d=obj(raw);return d.type==='string'&&(d.format==='uri'||typeof d.title==='string'&&/ URL$/.test(d.title))||d.type==='array'&&obj(d.items).type==='string'&&obj(d.items).format==='uri';});
 if(entries.length!==1)return null;
 const [key]=entries[0];
 // URI format or an explicit provider URL title is evidence; never pick a
 // field merely because its name resembles image_url/video/audio.
 return /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key)?key:null;
}
export function protocolBinding(model:Obj):Protocol|null {
 const schema=obj(model.output_schema).schemas,props=obj(obj(schema).properties),output=obj(props.output);
 if(obj(props.id).type!=='string'||obj(props.status).type!=='string')return null;
 // Text models sometimes carry a copied URL schema. Ambiguity must not be
 // silently interpreted as generated text or a file.
 if(['text','training','other','lora'].includes(classifyFamily(model)))return null;
 if(output.type==='array'&&obj(output.items).type==='string'&&obj(output.items).format==='uri')return 'muapi_output_urls_v1';
 const inner=obj(output.properties),urls=obj(inner.outputs);
 if(output.type==='object'&&obj(inner.id).type==='string'&&obj(inner.status).type==='string'&&urls.type==='array'&&obj(urls.items).type==='string'&&obj(urls.items).format==='uri')return 'muapi_output_envelope_v1';
 if(output.type==='object'&&responseField(model))return obj(inner[responseField(model)!]).type==='array'?'muapi_output_media_list_v1':'muapi_output_media_v1';
 return null;
}
export function submissionId(raw:unknown):string {
 const root=obj(raw),id=root.request_id;
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new Error('SUBMISSION_UNRECOGNIZED');
 return id;
}
export function familyResult(protocol:Protocol,raw:unknown,expectedId:string,resultField?:string|null):{state:'pending'|'failed'|'succeeded';media:string[];text:null} {
 const root=obj(raw);
 if(root.id!==expectedId)throw new Error('RESULT_ID_MISMATCH');
 const body=protocol==='muapi_output_envelope_v1'?obj(root.output):root;
 if(body.id!==undefined&&body.id!==expectedId)throw new Error('RESULT_ID_MISMATCH');
 const status=body.status??root.status;
 if(typeof root.status==='string'&&body.status!==undefined&&root.status!==body.status)throw new Error('RESULT_STATE_CONFLICT');
 if(['queued','pending','starting','processing'].includes(status))return {state:'pending',media:[],text:null};
 if(['failed','cancelled','canceled'].includes(status))return {state:'failed',media:[],text:null};
 if(!['completed','succeeded'].includes(status))throw new Error('RESULT_STATUS_UNRECOGNIZED');
 const urls=protocol==='muapi_output_envelope_v1'?body.outputs:protocol==='muapi_output_media_v1'&&resultField?[obj(root.output)[resultField]]:protocol==='muapi_output_media_list_v1'&&resultField?obj(root.output)[resultField]:protocol==='muapi_output_urls_v1'?root.output:null;
 if(!Array.isArray(urls)||urls.length===0||urls.length>16||urls.some(u=>typeof u!=='string'||u.length>8192||!isHttpsInput(u)))throw new Error('RESULT_OUTPUT_UNRECOGNIZED');
 return {state:'succeeded',media:urls,text:null};
}
export function adapterSelfTest(protocol:Protocol):boolean {
 const field=['muapi_output_media_v1','muapi_output_media_list_v1'].includes(protocol)?'declared_media':null;
 const payload=protocol==='muapi_output_media_list_v1'?{id:'fixture',status:'completed',output:{declared_media:['https://example.com/result.png']}}:protocol==='muapi_output_media_v1'?{id:'fixture',status:'completed',output:{declared_media:'https://example.com/result.png'}}:protocol==='muapi_output_envelope_v1'?{id:'fixture',status:'completed',output:{id:'fixture',status:'completed',outputs:['https://example.com/result.png']}}:{id:'fixture',status:'completed',output:['https://example.com/result.png']};
 try {
  if(submissionId({request_id:'fixture'})!=='fixture'||familyResult(protocol,payload,'fixture',field).media.length!==1)return false;
  try{familyResult(protocol,payload,'wrong',field);return false;}catch{/* Expected fail closed. */}
  return true;
 }catch{return false;}
}
export function integrationProgress(model:Obj,openapi:Obj={}) {
 const fields=muapiFormFields(model.input_schema),protocol=protocolBinding(model),endpoint=resolveMuapiEndpoint(model.provider_model_id,model.input_schema,model.endpoint_evidence);
 const operation=endpoint.path?obj(obj(openapi.paths)['/api/v1/'+endpoint.path]).post:null;
 const tags=Array.isArray(operation?.tags)?operation.tags:[];
 const tagFamilies:Record<string,string>={'Image: Text-to-Image':'text-to-image','Image: Edit & Reference':'image-editing','Image: Enhance':'image-enhancement','Video: Text-to-Video':'text-to-video','Video: Image-to-Video':'image-to-video','Video: Edit & Effects':'video-editing','Video: Lipsync':'lip-sync','Video: Avatars':'avatar-animation','Video: Storyboard':'storyboard','LLM / Multimodal':'multimodal','Audio':'audio-generation'};
 const family=tags.map((tag:string)=>tagFamilies[tag]).find(Boolean)??classifyFamily(model);
 const leaves=(d:Obj):Obj[]=>[...(d.field!==undefined||['uri','url'].includes(d.format)?[d]:[]),...Object.values(obj(d.properties)).flatMap(v=>leaves(obj(v))),...(d.items?leaves(obj(d.items)):[])];
 const fileFields=(fields??[]).flatMap(f=>leaves(f.definition));
 const supportedMedia=['image','video','audio','images_list','videos_list','audios_list'];
 const uploadsReady=fileFields.every(f=>supportedMedia.includes(String(f.field)));
 const outputReady=['text-to-image','image-to-image','image-editing','image-enhancement','text-to-video','image-to-video','video-to-video','video-editing','lip-sync','avatar-animation','storyboard','audio-to-video','audio-generation'].includes(family);
 const schemaReady=fields!==null;
 // Required input tests are per-model, never just a count of adapter files.
 const invalid=validateMuapiInput(model.input_schema,{__unexpected_field:true});
 const tested=schemaReady&&!!protocol&&adapterSelfTest(protocol)&&!invalid.ok;
 const stages={catalogued:true,endpoint_confirmed:endpoint.status==='declared'&&!!operation,schema_confirmed:schemaReady,adapter_available:protocol!==null,
  form_ready:schemaReady,server_validation_ready:schemaReady,upload_functional:uploadsReady,task_protocol_ready:protocol!==null,output_media_supported:outputReady,
  technical_test_succeeded:tested,real_test_pending:true};
 const prepared=stages.endpoint_confirmed&&schemaReady&&protocol!==null&&uploadsReady&&outputReady&&tested;
 return {family,protocol,result_field:protocol&&['muapi_output_media_v1','muapi_output_media_list_v1'].includes(protocol)?responseField(model):null,version:PROTOCOL_VERSION,stages,status:prepared?'integration_prepared':'blocked',
  blockers:[...(!stages.endpoint_confirmed?[endpoint.status==='declared'?'OPENAPI_OPERATION_UNCONFIRMED':'ENDPOINT_'+endpoint.status.toUpperCase()]:[]),...(!schemaReady?['SCHEMA_UNSUPPORTED']:[]),...(!protocol?['RESPONSE_CONTRACT_UNSUPPORTED']:[]),...(!uploadsReady?['UPLOAD_FORMAT_UNSUPPORTED']:[]),...(!outputReady?['OUTPUT_FORMAT_UNSUPPORTED']:[]),'CONSTRAINT_REVIEW_REQUIRED','REAL_TEST_PENDING'],
  openapi_evidence:{source:'https://api.muapi.ai/openapi.json',document_sha256:openapi.__document_sha256??null,operation_id:operation?.operationId??null,tags,request_schema:operation?.requestBody?.content?.['application/json']?.schema??null},
  input_signature:JSON.stringify(fields?.map(f=>({key:f.key,definition:f.definition,required:f.required}))??null)};
}
