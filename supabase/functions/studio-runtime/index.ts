import { createHandler } from './handler.ts';
import { downloadMedia } from './media.ts';
const runtime=globalThis as unknown as {Deno?:{env:{get:(key:string)=>string|undefined};serve:(handler:(req:Request)=>Promise<Response>)=>void}};
export const handler=createHandler({env:key=>runtime.Deno?.env.get(key)??'',fetcher:fetch,download:downloadMedia});
runtime.Deno?.serve(handler);
