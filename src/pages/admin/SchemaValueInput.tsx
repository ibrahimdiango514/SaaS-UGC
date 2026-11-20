import {useState} from 'react';
import {enumChoices} from '../../../supabase/functions/universal-catalog/schema';
type Def=Record<string,any>;
/** Bounded, schema-driven controls for structured dialogue, keyframes and adapters. */
export function SchemaValueInput({definition:d,value,onChange,id,upload}:{definition:Def;value:unknown;onChange:(v:unknown)=>void;id:string;upload?:(file:File)=>Promise<string>}) {
 const [uploading,setUploading]=useState(false),[error,setError]=useState('');
 const choices=enumChoices(d);
 if(d.type==='object') {
  const current=(value&&typeof value==='object'&&!Array.isArray(value)?value:{}) as Def;
  return <fieldset className="space-y-2 border border-white/10 p-3">{Object.entries(d.properties??{}).map(([k,raw])=>{const def=raw as Def;return <div key={k}><label htmlFor={`${id}-${k}`}>{def.title??k}{d.required?.includes(k)?' *':''}</label><SchemaValueInput id={`${id}-${k}`} definition={def} upload={upload} value={current[k]===undefined?def.default??undefined:current[k]} onChange={v=>{const next={...current};if(v===undefined)delete next[k];else next[k]=v;onChange(next);}}/></div>;})}</fieldset>;
 }
 if(d.type==='array') {
  const items=Array.isArray(value)?value:[];
  return <div className="space-y-2">{items.map((v,i)=><div key={i}><SchemaValueInput id={`${id}-${i}`} definition={{...d.items,...(d.field?{field:String(d.field).replace(/s_list$/,'')}:{})}} upload={upload} value={v} onChange={x=>onChange(items.map((old,j)=>j===i?x:old))}/><button type="button" onClick={()=>onChange(items.filter((_,j)=>j!==i))}>Supprimer l’élément {i+1}</button></div>)}<button type="button" disabled={items.length>=Math.min(d.maxItems??256,256)} onClick={()=>onChange([...items,d.items.type==='object'?{}:d.items.type==='boolean'?false:['number','int','integer','float'].includes(d.items.type)?0:''])}>Ajouter un élément</button></div>;
 }
 const wire=(x:unknown)=>x===undefined?'':typeof x==='string'?x:JSON.stringify(x);
 if(choices&&d.typing!==true||d.type==='boolean')return <select id={id} className="studio-input w-full" value={wire(value)} onChange={e=>onChange(e.target.value===''?undefined:d.type==='string'||d.type==='text'?e.target.value:JSON.parse(e.target.value))}><option value="">Non renseigné</option>{(choices??[{value:true,label:'Oui'},{value:false,label:'Non'}]).map((c,i)=><option key={i} value={wire(c.value)}>{c.label}</option>)}</select>;
 const numeric=['number','float','int','integer'].includes(d.type);
 return <><input id={id} className="studio-input w-full" type={numeric?'number':'text'} value={wire(value)} min={d.minimum??d.minValue} max={d.maximum??d.maxValue} step={d.step??(numeric?'any':undefined)} maxLength={d.maxLength??32768} onChange={e=>onChange(e.target.value===''?undefined:numeric?Number(e.target.value):e.target.value)} list={choices?`${id}-choices`:undefined}/>{upload&&d.field&&<label>Importer un fichier privé<input type="file" disabled={uploading} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;setUploading(true);setError('');try{onChange(await upload(file));}catch{setError('Import privé impossible.');}finally{setUploading(false);e.target.value='';}}}/></label>}{error&&<p role="alert">{error}</p>}{choices&&<datalist id={`${id}-choices`}>{choices.map((c,i)=><option key={i} value={String(c.value)}>{c.label}</option>)}</datalist>}</>;
}
