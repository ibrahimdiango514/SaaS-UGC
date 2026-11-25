/** Evidence-bound batch adapters. Functional family is NOT a protocol guess.
 * Bindings require the declared response contract; names never determine URLs.
 */
import {muapiFormFields,validateMuapiInput,isHttpsInput,declaredExternalLink} from '../universal-catalog/schema.ts';
import {resolveMuapiEndpoint,endpointResolutionEvidence} from '../universal-catalog/endpoint.ts';
import {boundJsonResult,boundTextResult} from './json-result.ts';
import {declaresExternalAction,externalActionBlockers} from './external-actions.ts';
type Obj=Record<string,any>;
const obj=(x:unknown):Obj=>x&&typeof x==='object'&&!Array.isArray(x)?x as Obj:{};
export const PROTOCOL_VERSION='muapi-families-7';
export type Protocol='muapi_output_envelope_v1'|'muapi_output_urls_v1'|'muapi_output_media_v1'|'muapi_output_media_list_v1'|'muapi_output_text_v1'|'muapi_output_json_v1';
export function classifyFamily(model:Obj):string {
 const categories:Record<string,string>={'Text to Image':'text-to-image','Image to Image':'image-to-image','Text to Video':'text-to-video','Image to Video':'image-to-video','Video to Video':'video-to-video','Text to Audio':'audio-generation','Audio to Video':'audio-to-video','Text to Text':'text','Image to 3D':'image-to-3d','Text to 3D':'text-to-3d','Training':'training',
  // "Lora Support" is LoRA INFERENCE (a style/LoRA adapter applied to a normal
  // generation). It is not a training job. Real trainings stay 'training' and
  // remain blocked until their ZIP upload and runtime are actually supported.
  'Lora Support':'lora-inference'};
 // Distinct editing/upscale/TTS/lip-sync labels require provider capability
 // evidence. Do not relabel a model based on marketing words in its ID.
 return categories[model.category]??'other';
}
/** Le fournisseur déclare-t-il explicitement que ce champ EST une URL ?
 * `format: uri` est la preuve la plus forte ; à défaut, un titre/une description
 * qui se termine par « URL »/« URLs », ou des exemples tous HTTPS, restent des
 * déclarations officielles de la fiche — jamais une déduction depuis le NOM du
 * champ. Le parseur vérifie ensuite que chaque valeur est bien une URL HTTPS. */
function declaresUrl(d:Obj):boolean {
 if(d.format==='uri'||d.format==='url')return true;
 const text=(typeof d.title==='string'?d.title:'')+' '+(typeof d.description==='string'?d.description:'');
 if(/URLs?\s*$/.test(text.trim()))return true;
 return Array.isArray(d.examples)&&d.examples.length>0
   &&d.examples.every((e:unknown)=>typeof e==='string'&&e.startsWith('https://'));
}
/** Certaines fiches omettent `type` mais déclarent des exemples HTTPS : la
 * déclaration reste officielle, elle n'est jamais déduite du nom du champ. */
function declaresUrlWithoutType(d:Obj):boolean {
 return d.type===undefined&&Array.isArray(d.examples)&&d.examples.length>0
   &&d.examples.every((e:unknown)=>typeof e==='string'&&e.startsWith('https://'));
}
/** Un résultat de données déclaré (`result`) : objet, tableau ou chaîne, dans
 * une enveloppe qui déclare aussi `status`. Un outil dont l'état s'appelle
 * `state` (bac à sable) n'a pas ce contrat : il reste refusé. */
function declaresJsonResult(model:Obj):boolean {
 const props=obj(obj(obj(model.output_schema).schemas).properties);
 const result=obj(props.result);
 return obj(props.status).type==='string'&&['object','array','string'].includes(String(result.type));
}
/** Un résultat TEXTE déclaré : soit `output.text`, soit `text` à la racine de
 * la réponse (avec `id` et `status`). Une chaîne sans `format` est du texte ;
 * aucune URL déclarée ne doit coexister dans le même conteneur (sinon la
 * nature du résultat serait ambiguë et resterait refusée). */
function declaredTextResult(model:Obj):boolean {
 const schemas=obj(obj(model.output_schema).schemas),props=obj(schemas.properties),outer=obj(props.output),inner=obj(outer.properties);
 const text=inner.text!==undefined?obj(inner.text):obj(props.text);
 if(text.type!=='string'||text.format!==undefined||text.field!==undefined)return false;
 if(responseCandidates(inner).length||responseCandidates(props).length)return false;
 return true;
}
function responseCandidates(properties:Obj):string[] {
 return Object.entries(properties).filter(([,raw])=>{
   const d=obj(raw);
   if(d.type==='string')return declaresUrl(d);
   if(d.type===undefined)return declaresUrlWithoutType(d);
   if(d.type==='array')return obj(d.items).type==='string'&&(declaresUrl(obj(d.items))||declaresUrl(d));
   return false;
 }).map(([key])=>key);
}
const SAFE_FIELD=/^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** Conteneurs déclarés, dans l'ordre de lecture officiel de la fiche. */
function outputContainers(model:Obj):Obj[] {
 const schemas=obj(obj(model.output_schema).schemas);
 // La fiche d'entrée porte aussi SA déclaration de sortie (`output_data`) :
 // c'est une déclaration officielle du fournisseur, pas une déduction.
 // Elle n'est lue qu'après l'enveloppe de prédiction, donc elle ne peut pas
 // contredire un contrat déjà déclaré.
 const sheet=obj(obj(obj(model.input_schema).schemas).output_data);
 return [obj(obj(schemas.properties).output),obj(obj(schemas).output),obj(obj(schemas).output_data),schemas,sheet]
   .filter(container=>container.type==='object');
}
/** Un et un seul champ de sortie déclaré comme URL ; l'ambiguïté est refusée. */
export function declaredOutputField(model:Obj):{key:string;definition:Obj}|null {
 for(const container of outputContainers(model)){
  const candidates=Object.entries(obj(container.properties))
    .filter(([key,raw])=>SAFE_FIELD.test(key)&&responseCandidates({[key]:raw}).length===1);
  if(candidates.length===1)return {key:candidates[0][0],definition:obj(candidates[0][1])};
  if(candidates.length>1)return null;
 }
 return null;
}
export function responseField(model:Obj):string|null {
 return declaredOutputField(model)?.key??null;
}
export function protocolBinding(model:Obj):Protocol|null {
 const schema=obj(model.output_schema).schemas,props=obj(obj(schema).properties),output=obj(props.output),family=classifyFamily(model);
 // Une action externe (publication sur un compte tiers) n'a pas de sortie de
 // contenu : elle est traitée par le pipeline d'actions, jamais comme une
 // génération.
 if(declaresExternalAction(model))return null;
 // Text models sometimes carry a copied URL schema. Ambiguity must not be
 // silently interpreted as generated text or a file. Un texte déclaré à la
 // racine (`id`, `status`, `text`) reste un résultat texte officiel.
 if(family==='text')return obj(props.id).type==='string'&&obj(props.status).type==='string'&&declaredTextResult(model)?'muapi_output_text_v1':declaresJsonResult(model)?'muapi_output_json_v1':null;
 // Un utilitaire fournisseur (publication, bac à sable, modération,
 // téléchargement) n'est pas un générateur : sa famille de quota ne serait pas
 // résolue par les règles en base, et sa sortie n'est pas un contenu produit
 // ici. Il reste refusé pour la génération ; les actions externes ont leur
 // propre pipeline (voir `external-actions.ts`).
 if(family==='other')return null;
 // Une donnée déclarée (`result`) n'est ni un fichier ni un texte libre : elle
 // est restituée en JSON, bornée, et jamais interprétée comme un média.
 if(declaresJsonResult(model))return 'muapi_output_json_v1';
 // Media protocols are bound by the DECLARED output field itself. The generic
 // prediction envelope (root id/status) is not repeated by every model sheet;
 // the parser still refuses any result whose id or status does not match, so a
 // missing envelope can never produce a false success.
 if(output.type==='array'&&obj(output.items).type==='string'&&obj(output.items).format==='uri')return 'muapi_output_urls_v1';
 const inner=obj(output.properties),urls=obj(inner.outputs);
 if(output.type==='object'&&obj(inner.id).type==='string'&&obj(inner.status).type==='string'&&urls.type==='array'&&obj(urls.items).type==='string'&&obj(urls.items).format==='uri')return 'muapi_output_envelope_v1';
 // Le champ de sortie est cherché dans `output`, puis dans les conteneurs
 // déclarés (`output`, `output_data`, racine). Un champ ambigu reste refusé.
 const declared=declaredOutputField(model);
 if(declared)return declared.definition.type==='array'?'muapi_output_media_list_v1':'muapi_output_media_v1';
 return null;
}
export function submissionId(raw:unknown):string {
 const root=obj(raw),id=root.request_id;
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw new Error('SUBMISSION_UNRECOGNIZED');
 return id;
}
export function familyResult(protocol:Protocol,raw:unknown,expectedId:string,resultField?:string|null):{state:'pending'|'failed'|'succeeded';media:string[];text:string|null} {
 const root=obj(raw);
 if(root.id!==expectedId)throw new Error('RESULT_ID_MISMATCH');
 const body=protocol==='muapi_output_envelope_v1'?obj(root.output):root;
 if(body.id!==undefined&&body.id!==expectedId)throw new Error('RESULT_ID_MISMATCH');
 const status=body.status??root.status;
 if(typeof root.status==='string'&&body.status!==undefined&&root.status!==body.status)throw new Error('RESULT_STATE_CONFLICT');
 if(['queued','pending','starting','processing'].includes(status))return {state:'pending',media:[],text:null};
 if(['failed','cancelled','canceled'].includes(status))return {state:'failed',media:[],text:null};
 if(!['completed','succeeded'].includes(status))throw new Error('RESULT_STATUS_UNRECOGNIZED');
 if(protocol==='muapi_output_text_v1'){
  // Texte déclaré : `output.text` ou, si la fiche le déclare ainsi, `text` à la
  // racine. Borné en octets, refusé s'il est vide ou contient un NUL.
  const candidate=obj(root.output).text!==undefined?obj(root.output).text:root.text;
  const bounded=boundTextResult(candidate);
  if(!bounded.ok)throw new Error(bounded.code==='RESULT_DATA_TOO_LARGE'?'RESULT_TEXT_UNRECOGNIZED':bounded.code);
  return {state:'succeeded',media:[],text:bounded.text};
 }
 // Donnée déclarée : restituée en JSON compact, bornée et contrôlée (taille,
 // profondeur, largeur, clés interdites), jamais interprétée ni devinée.
 if(protocol==='muapi_output_json_v1'){
  const result=body.result!==undefined?body.result:root.result;
  // `null` n'est pas une donnée déclarée : la fiche promet objet/tableau/chaîne.
  if(result===undefined||result===null)throw new Error('RESULT_DATA_UNRECOGNIZED');
  const bounded=boundJsonResult(result);
  if(!bounded.ok)throw new Error(bounded.code);
  return {state:'succeeded',media:[],text:bounded.text};
 }
 const urls=protocol==='muapi_output_envelope_v1'?body.outputs:protocol==='muapi_output_media_v1'&&resultField?[obj(root.output)[resultField]]:protocol==='muapi_output_media_list_v1'&&resultField?obj(root.output)[resultField]:protocol==='muapi_output_urls_v1'?root.output:null;
 if(!Array.isArray(urls)||urls.length===0||urls.length>16||urls.some(u=>typeof u!=='string'||u.length>8192||!isHttpsInput(u)))throw new Error('RESULT_OUTPUT_UNRECOGNIZED');
 return {state:'succeeded',media:urls,text:null};
}
export function adapterSelfTest(protocol:Protocol):boolean {
 const field=['muapi_output_media_v1','muapi_output_media_list_v1'].includes(protocol)?'declared_media':null;
 const payload=protocol==='muapi_output_json_v1'?{id:'fixture',status:'completed',result:{declared:true}}:protocol==='muapi_output_text_v1'?{id:'fixture',status:'completed',output:{text:'Declared text result'}}:protocol==='muapi_output_media_list_v1'?{id:'fixture',status:'completed',output:{declared_media:['https://example.com/result.png']}}:protocol==='muapi_output_media_v1'?{id:'fixture',status:'completed',output:{declared_media:'https://example.com/result.png'}}:protocol==='muapi_output_envelope_v1'?{id:'fixture',status:'completed',output:{id:'fixture',status:'completed',outputs:['https://example.com/result.png']}}:{id:'fixture',status:'completed',output:['https://example.com/result.png']};
 try {
  if(submissionId({request_id:'fixture'})!=='fixture'||(protocol==='muapi_output_text_v1'||protocol==='muapi_output_json_v1'?!familyResult(protocol,payload,'fixture',field).text:familyResult(protocol,payload,'fixture',field).media.length!==1))return false;
  try{familyResult(protocol,payload,'wrong',field);return false;}catch{/* Expected fail closed. */}
  // Un texte racine (`id`,`status`,`text`) reste un contrat valide ; une donnée
  // hostile (clé interdite, profondeur, taille) doit échouer.
  const rejects=(payload:unknown):boolean=>{try{familyResult(protocol,payload,'fixture',field);return false;}catch{return true;}};
  if(protocol==='muapi_output_text_v1'){
   if(familyResult(protocol,{id:'fixture',status:'completed',text:'Declared root text'},'fixture',field).text!=='Declared root text')return false;
   if(!rejects({id:'fixture',status:'completed',text:'bad\u0000text'}))return false;
  }
  if(protocol==='muapi_output_json_v1'){
   const nested=(depth:number):unknown=>depth?{$child:nested(depth-1)}:{leaf:true};
   if(!rejects({id:'fixture',status:'completed',result:nested(40)}))return false;
   if(!rejects({id:'fixture',status:'completed',result:JSON.parse('{"__proto__":{"polluted":true}}')}))return false;
  }
  return true;
 }catch{return false;}
}
export type TrainingContract = {
  is_training:boolean;
  protocol:Protocol|null;
  endpoint:{path:string|null;status:string};
  dataset_fields:Array<{key:string;required:boolean;declared_public_link:boolean;field:string|null}>;
  parameters:Array<{key:string;type:string;required:boolean;minimum:number|null;maximum:number|null;enum:string[]|null}>;
  output_field:string|null;
  quota_family_note:string;
  /** Ce que SORAHNEX ne peut PAS garantir sans télécharger l'archive ou tester. */
  limitations:string[];
  blockers:string[];
};
/**
 * Contrat d'un entraînement LoRA, borné aux déclarations de la fiche.
 *
 * Ce que le contrat prouve : le chemin, les champs du jeu de données (lien
 * public déclaré ou import privé), les paramètres typés, la sortie déclarée et
 * les codes de blocage. Ce qu'il ne prouve pas — et n'invente pas : le contenu
 * de l'archive (jamais téléchargée pour un lien public), les limites décrites
 * uniquement en prose, et le comportement réel du fournisseur.
 */
export function trainingContract(model:Obj,openapi:Obj={}):TrainingContract|null {
 const isTraining=classifyFamily(model)==='training'||model.category==='Training';
 if(!isTraining)return null;
 const fields=muapiFormFields(model.input_schema);
 const endpoint=resolveMuapiEndpoint(model.provider_model_id,model.input_schema,model.endpoint_evidence,openapi);
 const leaves=(definition:Obj,out:Obj[]=[]):Obj[]=>{
  for(const [key,raw] of Object.entries(obj(definition.properties))){const d=obj(raw);if(d.field!==undefined)out.push({...d,__key:key});leaves(d,out);}
  return out;
 };
 const root=obj(obj(obj(model.input_schema).schemas).input_data);
 const required=new Set(Array.isArray(root.required)?root.required:[]);
 const dataset=leaves(root).filter(d=>String(d.field)==='zip').map(d=>({key:String(d.__key),required:required.has(String(d.__key)),declared_public_link:declaredExternalLink(d),field:'zip'}));
 const parameters=(fields??[]).filter(f=>String(f.definition.field)!=='zip').map(f=>({key:f.key,type:String(f.definition.type),required:f.required,
  minimum:typeof f.definition.minimum==='number'?f.definition.minimum:typeof f.definition.minValue==='number'?f.definition.minValue:null,
  maximum:typeof f.definition.maximum==='number'?f.definition.maximum:typeof f.definition.maxValue==='number'?f.definition.maxValue:null,
  enum:Array.isArray(f.definition.enum)?f.definition.enum.map((x:unknown)=>typeof x==='string'?x:String(obj(x).value)):null}));
 const protocol=protocolBinding(model);
 const declared=declaredOutputField(model);
 return {is_training:true,protocol,endpoint:{path:endpoint.path??null,status:endpoint.status},dataset_fields:dataset,parameters,
  output_field:declared?.key??null,
  quota_family_note:'famille résolue par saas_ugc.studio_family_rules (training → lora, priorité 82), jamais par le nom du modèle',
  limitations:['archive de lien public jamais téléchargée ni inspectée par SORAHNEX','limites décrites uniquement en prose non applicables automatiquement','résultat réel, durée et qualité non prouvés sans test fournisseur'],
  blockers:integrationProgress(model,openapi).blockers};
}
export function integrationProgress(model:Obj,openapi:Obj={}) {
 const fields=muapiFormFields(model.input_schema),protocol=protocolBinding(model),endpoint=resolveMuapiEndpoint(model.provider_model_id,model.input_schema,model.endpoint_evidence,openapi);
 const operation=endpoint.path?obj(obj(openapi.paths)['/api/v1/'+endpoint.path]).post:null;
 // Persisted proof: exact declarations, official operation and contract fingerprint.
 // No run timestamp: an unchanged document must not invalidate an attestation.
 const endpoint_resolution=endpointResolutionEvidence(endpoint);
 const tags=Array.isArray(operation?.tags)?operation.tags:[];
 const tagFamilies:Record<string,string>={'Image: Text-to-Image':'text-to-image','Image: Edit & Reference':'image-editing','Image: Enhance':'image-enhancement','Video: Text-to-Video':'text-to-video','Video: Image-to-Video':'image-to-video','Video: Edit & Effects':'video-editing','Video: Lipsync':'lip-sync','Video: Avatars':'avatar-animation','Video: Storyboard':'storyboard','LLM / Multimodal':'multimodal','Audio':'audio-generation'};
 const family=tags.map((tag:string)=>tagFamilies[tag]).find(Boolean)??classifyFamily(model);
 const leaves=(d:Obj):Obj[]=>[...(d.field!==undefined||['uri','url'].includes(d.format)?[d]:[]),...Object.values(obj(d.properties)).flatMap(v=>leaves(obj(v))),...(d.items?leaves(obj(d.items)):[])];
 const fileFields=(fields??[]).flatMap(f=>leaves(f.definition));
 const supportedMedia=['image','video','audio','images_list','videos_list','audios_list'];
 // Only DECLARED upload slots need an upload adapter. A `format: uri|url` field
 // without `field` is a plain HTTPS link typed by the customer (LoRA weights,
 // reference URL): nothing is uploaded, and `isHttpsInput` already validates it.
 // Counting those as uploads blocked 24 models for a capability they never use.
 // Un champ déclaré « public URL » est un lien fourni par le client, pas un
 // emplacement de téléversement : aucun adaptateur d'import n'est requis.
 const uploadFields=fileFields.filter(f=>f.field!==undefined&&!declaredExternalLink(f));
 const uploadsReady=uploadFields.every(f=>supportedMedia.includes(String(f.field)));
 const outputReady=protocol==='muapi_output_text_v1'||protocol==='muapi_output_json_v1'||['text-to-image','image-to-image','image-editing','image-enhancement','text-to-video','image-to-video','video-to-video','video-editing','lip-sync','avatar-animation','storyboard','audio-to-video','audio-generation','lora-inference','image-to-3d','text-to-3d','training'].includes(family)
   ;
 const schemaReady=fields!==null;
 // Required input tests are per-model, never just a count of adapter files.
 const invalid=validateMuapiInput(model.input_schema,{__unexpected_field:true});
 const tested=schemaReady&&!!protocol&&adapterSelfTest(protocol)&&!invalid.ok;
 const stages={catalogued:true,endpoint_confirmed:endpoint.status==='declared'&&!!operation,schema_confirmed:schemaReady,adapter_available:protocol!==null,
  form_ready:schemaReady,server_validation_ready:schemaReady,upload_functional:uploadsReady,task_protocol_ready:protocol!==null,output_media_supported:outputReady,
  technical_test_succeeded:tested,real_test_pending:true};
 const prepared=stages.endpoint_confirmed&&schemaReady&&protocol!==null&&uploadsReady&&outputReady&&tested;
 const external=externalActionBlockers(model);
 return {family,protocol,result_field:protocol&&['muapi_output_media_v1','muapi_output_media_list_v1'].includes(protocol)?responseField(model):null,version:PROTOCOL_VERSION,stages,status:prepared?'integration_prepared':'blocked',
  // Une action externe n'est pas un contrat de sortie manquant : elle est
  // hors du pipeline de génération et exige compte lié + confirmation.
  external_action:external.length>0,
  blockers:[...(!stages.endpoint_confirmed?[endpoint.status==='declared'?'OPENAPI_OPERATION_UNCONFIRMED':'ENDPOINT_'+endpoint.status.toUpperCase()]:[]),...(!schemaReady?['SCHEMA_UNSUPPORTED']:[]),...(external.length?external:(!protocol?['RESPONSE_CONTRACT_UNSUPPORTED']:[])),...(!uploadsReady?['UPLOAD_FORMAT_UNSUPPORTED']:[]),...(!outputReady?['OUTPUT_FORMAT_UNSUPPORTED']:[]),...(external.length?[]:['CONSTRAINT_REVIEW_REQUIRED','REAL_TEST_PENDING'])],
  openapi_evidence:{source:'https://api.muapi.ai/openapi.json',document_sha256:openapi.__document_sha256??null,operation_id:operation?.operationId??null,tags,request_schema:operation?.requestBody?.content?.['application/json']?.schema??null,
   endpoint_resolution,endpoint_declared_paths:endpoint.declared_paths,endpoint_documented_paths:endpoint.documented_paths},
  input_signature:JSON.stringify(fields?.map(f=>({key:f.key,definition:f.definition,required:f.required}))??null)};
}
