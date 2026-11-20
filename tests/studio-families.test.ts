import {describe,it,expect} from 'vitest';
import {classifyFamily,protocolBinding,familyResult,submissionId,integrationProgress,adapterSelfTest,type Protocol} from '../supabase/functions/studio-runtime/families';
const uri={type:'string',format:'uri'};
const input={schemas:{input_data:{type:'object',endpoint_url:'official-path',required:['prompt'],properties:{prompt:{type:'string',minLength:2}}}}};
const envelope={schemas:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{type:'object',properties:{id:{type:'string'},status:{type:'string'},outputs:{type:'array',items:uri}}}}}};
const flat={schemas:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{type:'array',items:uri}}}};
const document={paths:{'/api/v1/official-path':{post:{operationId:'official_operation',tags:['Image: Text-to-Image']}},'/api/v1/predictions/{id}/result':{get:{}}}};
const progress=(m:any)=>integrationProgress(m,document);
const model={provider_model_id:'not-the-endpoint',category:'Text to Image',input_schema:input,output_schema:envelope};
describe('evidence-bound family integrations',()=>{
 it.each(['Text to Image','Image to Image','Text to Video','Image to Video','Video to Video','Text to Audio','Audio to Video','Image to 3D','Text to 3D'])('binds shared contracts independently for %s',category=>{
  expect(protocolBinding({...model,category})).toBe('muapi_output_envelope_v1');
  expect(protocolBinding({...model,category,output_schema:flat})).toBe('muapi_output_urls_v1');
 });
 it('never invents a protocol from category or endpoint-like names',()=>{
  expect(protocolBinding({...model,output_schema:{}})).toBeNull();
  expect(protocolBinding({...model,category:'Text to Text'})).toBeNull();
  expect(classifyFamily({...model,provider_model_id:'upscale-lip-sync-tts'})).toBe('text-to-image');
 });
 it('reports prepared not operational and retains the real-test gate',()=>{
  const p=progress(model);
  expect(p.status).toBe('integration_prepared');expect(p.protocol).toBe('muapi_output_envelope_v1');
  expect(p.stages.technical_test_succeeded).toBe(true);expect(p.stages.real_test_pending).toBe(true);
  expect(p.blockers).toContain('CONSTRAINT_REVIEW_REQUIRED');expect(p).not.toHaveProperty('operational',true);
 });
 it('blocks conflicting endpoint evidence, unknown schema and unsafe upload formats separately',()=>{
  expect(progress({...model,endpoint_evidence:{endpoint:'different'}}).status).toBe('blocked');
  const unsupported=structuredClone(model);(unsupported.input_schema.schemas.input_data as any).oneOf=[];
  expect(progress(unsupported).stages.technical_test_succeeded).toBe(false);
  expect(progress({...model,input_schema:{schemas:{input_data:{type:'object',endpoint_url:'official-path',properties:{zip:{type:'string',field:'zip'}}}}}}).blockers).toContain('UPLOAD_FORMAT_UNSUPPORTED');
 });
 it.each<Protocol>(['muapi_output_envelope_v1','muapi_output_urls_v1'])('runs simulated lifecycle for %s',protocol=>{
  expect(adapterSelfTest(protocol)).toBe(true);expect(submissionId({request_id:'request-1',status:'processing'})).toBe('request-1');
  const pending={id:'request-1',status:'processing',...(protocol==='muapi_output_envelope_v1'?{output:{id:'request-1',status:'processing'}}:{})};
  expect(familyResult(protocol,pending,'request-1').state).toBe('pending');
  expect(familyResult(protocol,{id:'request-1',status:'failed'},'request-1').state).toBe('failed');
  const done={id:'request-1',status:'completed',output:protocol==='muapi_output_envelope_v1'?{id:'request-1',status:'completed',outputs:['https://example.com/result']} : ['https://example.com/result']};
  expect(familyResult(protocol,done,'request-1').media).toHaveLength(1);
  expect(()=>familyResult(protocol,done,'different')).toThrow('RESULT_ID_MISMATCH');
  expect(()=>familyResult(protocol,{...done,output:protocol==='muapi_output_envelope_v1'?{id:'request-1',status:'completed',outputs:['http://169.254.169.254/']} : ['http://169.254.169.254/']},'request-1')).toThrow();
  expect(()=>familyResult(protocol,{id:'request-1',status:'new-unknown'},'request-1')).toThrow();
 });
 it('rejects guessed submission formats',()=>{
  expect(()=>submissionId({id:'request-1'})).toThrow();
  expect(()=>submissionId({request_id:'../x'})).toThrow();
 });
});

it('binds a direct media output only from explicit URL semantics and snapshots its declared key',()=>{
 const direct={...model,output_schema:{schemas:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{type:'object',properties:{provider_specific_field:{type:'string',format:'uri'}}}}}}};
 expect(protocolBinding(direct)).toBe('muapi_output_media_v1');
 expect(progress(direct).result_field).toBe('provider_specific_field');
 expect(adapterSelfTest('muapi_output_media_v1')).toBe(true);
 expect(familyResult('muapi_output_media_v1',{id:'request',status:'completed',output:{provider_specific_field:'https://example.com/image.png'}},'request','provider_specific_field').media).toHaveLength(1);
 expect(()=>familyResult('muapi_output_media_v1',{id:'request',status:'completed',output:{other:'https://example.com/image.png'}},'request','provider_specific_field')).toThrow();
 const guessed=structuredClone(direct);(guessed.output_schema.schemas.properties.output.properties.provider_specific_field as any)={type:'string'};
 expect(protocolBinding(guessed)).toBeNull();
});
it('binds named URI lists alongside non-media metadata, rejecting ambiguous or untyped outputs',()=>{
 const m={...model,output_schema:{schemas:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{type:'object',properties:{images:{type:'array',items:{type:'string',format:'uri'}},character_id:{type:'string'}}}}}}};
 expect(protocolBinding(m)).toBe('muapi_output_media_list_v1');expect(progress(m).result_field).toBe('images');
 expect(adapterSelfTest('muapi_output_media_list_v1')).toBe(true);
 expect(familyResult('muapi_output_media_list_v1',{id:'r',status:'completed',output:{images:['https://example.com/1.png','https://example.com/2.png'],character_id:'c'}},'r','images').media).toHaveLength(2);
 expect(()=>familyResult('muapi_output_media_list_v1',{id:'r',status:'completed',output:{images:['http://127.0.0.1/a']}},'r','images')).toThrow();
 const ambiguous=structuredClone(m);Object.assign(ambiguous.output_schema.schemas.properties.output.properties,{other:{type:'array',items:{type:'string',format:'uri'}}});expect(protocolBinding(ambiguous)).toBeNull();
 const untyped=structuredClone(m);delete (untyped.output_schema.schemas.properties.output.properties.images.items as any).format;expect(protocolBinding(untyped)).toBeNull();
});
it('uses a declared text-result protocol rather than interpreting URL schemas as text',()=>{
 const text={...model,category:'Text to Text',output_schema:{schemas:{type:'object',properties:{id:{type:'string'},status:{type:'string'},output:{type:'object',properties:{text:{type:'string',description:'Generated text response'}}}}}}};
 expect(protocolBinding(text)).toBe('muapi_output_text_v1');expect(progress(text).status).toBe('integration_prepared');
 expect(adapterSelfTest('muapi_output_text_v1')).toBe(true);
 expect(familyResult('muapi_output_text_v1',{id:'r',status:'completed',output:{text:'Bonjour'}},'r')).toEqual({state:'succeeded',media:[],text:'Bonjour'});
 for(const output of [{text:''},{text:2},{text:'x'.repeat(131073)},['https://example.com/a']])expect(()=>familyResult('muapi_output_text_v1',{id:'r',status:'completed',output},'r')).toThrow();
 expect(protocolBinding({...model,category:'Text to Text'})).toBeNull();
});
