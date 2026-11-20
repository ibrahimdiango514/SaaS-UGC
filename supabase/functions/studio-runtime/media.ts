import { httpGetPinned } from './binary-pinned-fetch.ts';
import { assertPublicAddresses } from '../../../src/business/importer/url-guard.ts';
import { isHttpsInput } from '../universal-catalog/schema.ts';
export const MAX_BYTES=50*1024*1024;
export async function downloadMedia(input: string): Promise<Uint8Array> {
  let url=new URL(input);
  const deno=(globalThis as unknown as {Deno?:{resolveDns:(name:string,type:'A'|'AAAA')=>Promise<string[]>}}).Deno;
  if (!deno?.resolveDns) throw new Error('MEDIA_NETWORK_UNAVAILABLE');
  for (let hop=0;hop<4;hop++) {
    if (!isHttpsInput(url.toString())) throw new Error('MEDIA_URL_REJECTED');
    const addresses=(await Promise.all([deno.resolveDns(url.hostname,'A').catch(()=>[]),deno.resolveDns(url.hostname,'AAAA').catch(()=>[])])).flat();
    if (!addresses.length || !assertPublicAddresses(addresses).ok) throw new Error('MEDIA_URL_REJECTED');
    const response=await httpGetPinned({ip:addresses[0],hostname:url.hostname,path:url.pathname+url.search},{accept:'*/*',maxBytes:MAX_BYTES,binary:true,timeoutMs:60000});
    if ([301,302,303,307,308].includes(response.status)) {
      if (!response.headers.location) throw new Error('MEDIA_REDIRECT_INVALID');
      url=new URL(response.headers.location,url); continue;
    }
    if (response.status!==200 || !response.bodyBytes?.length) throw new Error('MEDIA_DOWNLOAD_FAILED');
    return response.bodyBytes;
  }
  throw new Error('MEDIA_REDIRECT_LIMIT');
}
