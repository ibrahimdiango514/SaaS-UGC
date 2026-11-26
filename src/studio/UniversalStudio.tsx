import {useCatalogRevision} from '../hooks/useCatalogRevision';
import { useEffect,useState } from 'react';
import { Link } from 'react-router-dom';
import { Button,Card } from '../components/ui';
import { asAppError } from '../lib/errors';
import { universalRuntime,uploadUniversalInput,type UniversalStudioPage,type UniversalStudioModel,type UniversalStudioJob,type UniversalStudioQuote,type UniversalQuotas } from '../lib/api';
import { UniversalModelForm } from '../pages/admin/UniversalModelForm';
import { StudioShell } from './components/StudioShell';
import { JsonResult, isJsonDocument } from './components/JsonResult';
import { grouperParFamille, motifPrincipal, expliquerBlocage } from './modelFamilies';


/** Un modèle gratuit affiche 0 crédit, jamais un prix supposé. */
const creditLabel=(credits:number|null,billing?:string)=>credits===null?'':billing==='free'||credits===0?' · gratuit (0 crédit)':` · ${credits} crédit${credits>1?'s':''}`;

/** Un résultat se lit selon son type réel, jamais comme un simple lien. */
function ResultOutput({output,index}:{output:UniversalStudioJob['outputs'][number];index:number}) {
  // Un texte déclaré peut être une donnée JSON : elle est affichée comme une
  // donnée (jamais injectée en HTML), sinon comme du texte brut échappé.
  if(output.kind==='text') return typeof output.text==='string' && isJsonDocument(output.text)
    ? <JsonResult value={output.text}/>
    : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-xs text-slate-200">{output.text}</pre>;
  if(!output.url) return <p className="text-xs text-amber-200">Fichier {index+1} indisponible.</p>;
  const mime=output.mime??'';
  if(mime.startsWith('image/')) return <figure className="space-y-1"><img src={output.url} alt={`Résultat image ${index+1}`} loading="lazy" className="max-h-80 w-full rounded-lg border border-white/10 object-contain"/><a href={output.url} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-300 underline">Ouvrir l’image {index+1}</a></figure>;
  if(mime.startsWith('video/')) return <figure className="space-y-1"><video src={output.url} controls playsInline preload="metadata" className="w-full rounded-lg border border-white/10 bg-black" aria-label={`Résultat vidéo ${index+1}`}/><a href={output.url} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-300 underline">Télécharger la vidéo {index+1}</a></figure>;
  if(mime.startsWith('audio/')) return <figure className="space-y-1"><audio src={output.url} controls preload="metadata" className="w-full" aria-label={`Résultat audio ${index+1}`}/><a href={output.url} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-300 underline">Télécharger l’audio {index+1}</a></figure>;
  if(mime==='model/gltf-binary'||/\.glb(\?|$)/i.test(output.url)) return <div className="space-y-1 rounded-lg border border-white/10 bg-white/[.03] p-3"><p className="text-xs text-slate-300">Modèle 3D (glTF binaire)</p><a href={output.url} target="_blank" rel="noopener noreferrer" download className="text-xs text-cyan-300 underline">Télécharger le modèle 3D {index+1}</a></div>;
  return <a href={output.url} target="_blank" rel="noopener noreferrer" className="block text-xs text-cyan-300 underline">Ouvrir / télécharger le résultat {index+1}</a>;
}

export default function UniversalStudio(){
 const catalogRevision=useCatalogRevision();
 const [page,setPage]=useState<UniversalStudioPage|null>(null),[query,setQuery]=useState(''),[filter,setFilter]=useState(''),[category,setCategory]=useState(''),[cursors,setCursors]=useState(['']);
 const [selected,setSelected]=useState<UniversalStudioModel|null>(null),[quote,setQuote]=useState<UniversalStudioQuote|null>(null),[job,setJob]=useState<string|null>(null),[jobs,setJobs]=useState<UniversalStudioJob[]>([]);
 const [quotas,setQuotas]=useState<UniversalQuotas|null>(null);
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[requestKey,setRequestKey]=useState('');
 const after=cursors[cursors.length-1];
 useEffect(()=>{let live=true;setBusy(true);setError('');universalRuntime<UniversalStudioPage>('models',{after,query:filter,category}).then(p=>{if(live)setPage(p);}).catch(e=>{if(live)setError(asAppError(e).message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[after,filter,category,refresh,catalogRevision]);
 useEffect(()=>{let live=true;universalRuntime<UniversalQuotas>('quotas').then(q=>{if(live)setQuotas(q);}).catch(()=>{});return()=>{live=false;};},[refresh,catalogRevision]);
 useEffect(()=>{if(!selected||!page)return;const next=page.items.find(m=>m.model_id===selected.model_id)??null;if(JSON.stringify(next)!==JSON.stringify(selected)){setSelected(next);setQuote(null);}},[page,selected]);
 useEffect(()=>{let live=true;universalRuntime<{jobs:UniversalStudioJob[]}>('history').then(r=>{if(live)setJobs(r.jobs);}).catch(()=>{});return()=>{live=false;};},[refresh]);
 useEffect(()=>{if(!job)return;let active=true;let timer:ReturnType<typeof setTimeout>;const tick=async()=>{try{const r=await universalRuntime<{status:string}>('status',{job_id:job});if(active){setRefresh(n=>n+1);if(['succeeded','failed','uncertain','expired'].includes(r.status)){setJob(null);return;}}}catch{/* Explicit history refresh is still available; never auto-submit. */}if(active)timer=setTimeout(tick,15000);};timer=setTimeout(tick,15000);return()=>{active=false;clearTimeout(timer);};},[job]);
 const reset=()=>{setCursors(['']);setSelected(null);setQuote(null);};
 const technical=(m:UniversalStudioModel)=>m.technical_blockers??m.blockers.filter(b=>b!=='PLAN_UNAVAILABLE');
 const readyUnavailable=(page?.items??[]).filter(m=>!m.operational&&technical(m).length===0);
 // Regroupement par FONCTION de création : personne ne cherche « image-to-video ».
 const groupes=grouperParFamille(page?.items??[]);
 return <StudioShell title="Studio universel MuAPI" eyebrow="Catalogue complet, paramètres, médias privés, devis en crédits et historique.">
  <div className="space-y-4">
   <Card className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-white">Toutes les catégories de création</h2><span>{page?.total??'…'} modèles catalogués · Solde : {page?.credits??'…'} crédits{page?.plan?` · Offre ${page.plan}`:''}</span></div>
    <p className="text-sm text-slate-400">Seuls les modèles vérifiés, autorisés et inclus dans votre offre proposent une génération. Les autres restent visibles avec leur motif exact.</p>
    <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();reset();setFilter(query.trim());}}><label className="sr-only" htmlFor="universal-search">Rechercher dans tout MuAPI</label><input id="universal-search" className="studio-input flex-1" value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} placeholder="Nom, identifiant, fonctionnalité"/><Button type="submit" size="sm">Rechercher</Button>
    <label className="sr-only" htmlFor="universal-category">Catégorie de création</label><select id="universal-category" className="studio-input" value={category} onChange={e=>{reset();setCategory(e.target.value);}}><option value="">Toutes les catégories</option>{Object.entries(page?.categories??{}).sort(([a],[b])=>a.localeCompare(b)).map(([c,n])=><option key={c} value={c}>{c} ({n})</option>)}</select></form>
    {busy&&<p role="status">Chargement du catalogue…</p>}{error&&<p role="alert">{error}</p>}
    {page&&!page.items.some(m=>m.operational)&&<p role="status">Aucun modèle opérationnel sur cette page. Les modèles non validés restent dans le catalogue administrateur, sans génération disponible.</p>}
    {/* Tous les modèles restent consultables : sélectionner un modèle non
        opérationnel affiche son motif exact, sans formulaire ni génération. */}
    {groupes.map(({famille,modeles})=><section key={famille.cle} className="space-y-2"><div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/[0.06] pb-1"><h3 className="text-sm font-semibold text-white">{famille.label}</h3><span className="text-xs text-slate-500">{famille.description} · {modeles.length} modèle{modeles.length>1?'s':''}</span></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{modeles.map(m=><button type="button" key={m.model_id} onClick={()=>{setSelected(m);setQuote(null);}} className={`rounded-xl border p-4 text-left ${selected?.model_id===m.model_id?(m.operational?'border-cyan-300 bg-cyan-400/10':'border-amber-300/50 bg-amber-400/5'):(m.operational?'border-white/10 bg-white/[.02]':'border-white/[.06] bg-white/[.01]')}`}><span className="block font-semibold text-white">{m.display_name}</span><span className="block break-all text-xs text-slate-400">{m.model_id} · {m.category}</span>{m.operational?<span className="mt-2 block text-xs text-emerald-300">Opérationnel{creditLabel(m.credits,m.billing)}{m.quota_family?` · ${m.quota_family}`:''}</span>:<><span className="mt-2 block text-xs text-amber-200">{motifPrincipal(m.blockers).libelle}{creditLabel(m.credits,m.billing)}</span><span className="mt-1 block text-[11px] leading-relaxed text-amber-100/70">{motifPrincipal(m.blockers).action}</span></>}</button>)}</div></section>)}
    {readyUnavailable.length>0&&<div className="space-y-2 rounded-xl border border-amber-300/30 bg-amber-400/5 p-3"><p className="text-sm font-medium text-amber-100">Prêts techniquement, mais non inclus dans votre offre</p><ul className="space-y-1 text-xs text-amber-200">{readyUnavailable.map(m=><li key={m.model_id}><span className="font-medium text-amber-100">{m.display_name}</span> · {m.category}{creditLabel(m.credits,m.billing)} — <Link to="/app/abonnement" className="underline">voir les offres</Link></li>)}</ul></div>}
    <div className="flex gap-2"><Button size="sm" variant="outline" disabled={cursors.length===1||busy} onClick={()=>{setCursors(v=>v.slice(0,-1));setSelected(null);setQuote(null);}}>Précédent</Button><Button size="sm" variant="outline" disabled={!page?.next_cursor||busy} onClick={()=>{if(page?.next_cursor)setCursors(v=>[...v,page.next_cursor!]);setSelected(null);setQuote(null);}}>Suivant</Button></div>
   </Card>
   {quotas&&<Card className="space-y-2 p-5"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-white">Quotas de votre offre · {quotas.plan}</h2><span className="text-xs text-slate-500">Période {quotas.period}</span></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{(quotas.items??[]).filter(q=>q.generator).map(q=><div key={q.family} className="rounded-lg border border-white/10 px-3 py-2 text-xs"><p className="font-medium text-slate-200">{q.display_name}</p><p className="text-slate-400">{q.policy==='active'?`${q.used} / ${q.limit} utilisés` : q.policy==='pending_approval'?(q.limit!==null?`Proposition : ${q.limit} / mois — en attente d’arbitrage produit`:'Politique en attente de validation produit') : q.policy==='disabled'?'Quota désactivé':'Aucun quota pour cette offre'}</p></div>)}</div></Card>}
   {selected&&<Card className="space-y-3 p-5"><h2 className="font-semibold text-white">{selected.display_name}</h2>{!selected.operational&&<ul className="space-y-1 text-sm text-amber-200">{selected.blockers.map(r=>{const e=expliquerBlocage(r);return <li key={r}><span className="font-medium">{e.libelle}</span>{' — '}<span className="text-amber-100/80">{e.action}</span>{e.qui==='administration'?<span className="text-[11px] text-slate-500"> (administration)</span>:null}</li>;})}</ul>}
    {selected.operational&&selected.schema?<UniversalModelForm key={selected.model_id} modelId={selected.model_id} schema={selected.schema} onValuesChange={()=>setQuote(null)} upload={file=>uploadUniversalInput(page!.workspace_id,file)} onSubmit={async params=>{
      if(!selected.operational)throw new Error('MODEL_NOT_OPERATIONAL');
      const q=await universalRuntime<UniversalStudioQuote>('quote',{model_id:selected.model_id,params});setQuote(q);setRequestKey(crypto.randomUUID());return 'Devis prêt. Vérifiez les crédits et confirmez ci-dessous.';
    }}/>:<p>Le formulaire est bloqué tant que toutes les contraintes déclarées ne sont pas prises en charge.</p>}
    {quote&&<div className="rounded-xl border border-cyan-300/30 p-4"><p>{quote.credits===0?'Génération gratuite — 0 crédit débité':`${quote.credits} crédits SORAHNEX`} · Votre solde : {quote.balance} crédits</p><p className="text-xs text-slate-400">Devis valable jusqu’au {new Date(quote.expires_at).toLocaleTimeString()}. Une réservation est effectuée uniquement après confirmation.</p><Button disabled={busy||quote.balance<quote.credits||Date.parse(quote.expires_at)<=Date.now()} onClick={async()=>{setBusy(true);setError('');try{const r=await universalRuntime<{job_id:string}>('start',{quote_id:quote.quote_id,request_key:requestKey});setJob(r.job_id);setQuote(null);setRefresh(n=>n+1);}catch(e){setError(asAppError(e).message);}finally{setBusy(false);}}}>Confirmer et générer — {quote.credits===0?'gratuit':`${quote.credits} crédits`}</Button></div>}
   </Card>}
   <Card className="space-y-3 p-5"><div className="flex justify-between"><h2 className="font-semibold text-white">Historique universel</h2><Button size="sm" variant="outline" onClick={()=>setRefresh(n=>n+1)}>Actualiser</Button></div><p className="text-xs text-slate-400">Le suivi serveur continue lorsque vous quittez cette page. Une soumission incertaine n’est jamais relancée automatiquement.</p>
    {!jobs.length&&<p>Aucune génération universelle enregistrée.</p>}{jobs.map(j=><article key={j.id} className="space-y-2 rounded-xl border border-white/10 p-3"><h3>{j.display_name} · {j.credits} crédits</h3><p className="text-sm">{j.status}{j.status==='uncertain'?' — vérification administrative requise, ne relancez pas la génération.':''}</p>{j.outputs.map((o,i)=><ResultOutput key={i} output={o} index={i}/>)}</article>)}
    {jobs.length===30&&<Button size="sm" variant="outline" onClick={async()=>{try{const r=await universalRuntime<{jobs:UniversalStudioJob[]}>('history',{before:jobs[jobs.length-1].created_at});setJobs(v=>[...v,...r.jobs]);}catch(e){setError(asAppError(e).message);}}}>Historique plus ancien</Button>}
   </Card>
  </div>
 </StudioShell>;
}
