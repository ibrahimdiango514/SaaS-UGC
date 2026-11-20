#!/usr/bin/env node
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {buildBundle,renderLoader,renderSeedSql} from './build-edge-loader.mjs';
const built=buildBundle(process.cwd(),'studio-runtime');
const name=`studio-runtime-${built.sha256}`,dir='artifacts/studio-runtime';
mkdirSync(dir,{recursive:true});
const files={
 'supabase/functions/studio-runtime.edge.js':built.source,
 [`${dir}/loader.ts`]:renderLoader(name,built),
 [`${dir}/publish.sql`]:`begin;\n${renderSeedSql(name,built)}commit;\n`,
 [`${dir}/manifest.json`]:JSON.stringify({name,sha256:built.sha256,chars:built.chars,parts:built.slices.length},null,2)+'\n'
};
for(const [path,content] of Object.entries(files)) {
 if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==content)throw new Error(`Stale artifact: ${path}`);}
 else writeFileSync(path,content);
}
console.log(name);
