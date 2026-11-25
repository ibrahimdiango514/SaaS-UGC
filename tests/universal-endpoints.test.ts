import { describe, expect, it } from 'vitest';
import { resolveMuapiEndpoint } from '../supabase/functions/universal-catalog/endpoint';
const schema = (path: unknown) => ({ schemas: { input_data: { endpoint_url: path } } });
describe('official MuAPI endpoint binding', () => {
  it('preserves a declared alias and multi-segment paths instead of guessing the ID', () => {
    expect(resolveMuapiEndpoint('flux-dev',schema('flux-dev-image'))).toMatchObject({ status:'declared', path:'flux-dev-image',url:'https://api.muapi.ai/api/v1/flux-dev-image',differs:true });
    expect(resolveMuapiEndpoint('wan-2.1',schema('wan-2.1')).status).toBe('declared');
    expect(resolveMuapiEndpoint('mmaudio-v2-text-to-audio',schema('mmaudio-v2/text-to-audio')).path).toBe('mmaudio-v2/text-to-audio');
  });
  it.each(['minimax-h3-open-reference-to-video','qwen-image-text-to-image-2512-lora','qwen-image-text-to-image-lora','qwen3-image-to-image','qwen3-pro-image-to-image','qwen3-pro-text-to-image','qwen3-text-to-image'])('resolves %s only with its observed top-level declaration', id => {
    expect(resolveMuapiEndpoint(id,{}).status).toBe('missing');
    expect(resolveMuapiEndpoint(id,{}, { endpoint_url:id,endpoint:`/api/v1/${id}` })).toMatchObject({status:'declared',path:id});
  });
  it('blocks contradictory declarations', () => {
    expect(resolveMuapiEndpoint('x',schema('a'),{endpoint_url:'b'}).status).toBe('conflict');
  });
  it.each(['https://evil.example/path','//evil.example','/x','../x','a/../x','a%2fb','x?key=v','x#hash','x\\a',4])('rejects unsafe path %s', path => {
    expect(resolveMuapiEndpoint('x',schema(path)).status).toBe('invalid');
  });
});
