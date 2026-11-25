import {useEffect,useState} from 'react';
import {Button,Card,CardHeader} from '../../components/ui';
import {universalRuntime} from '../../lib/api';
import {asAppError} from '../../lib/errors';

interface PlanFamily {
  family:string;display_name:string;allowed:boolean;entitlement_approved:boolean;
  monthly_limit:number|null;quota_enabled:boolean;quota_approved:boolean;source_note:string|null;
}
interface Plan {plan_key:string;display_name:string;families:PlanFamily[]}
interface Summary {
  models:number;prepared:number;configurable:number;runtime_configured:number;technical_test_passed:number;
  operational:number;enabled:number;studio_available:number;quota_policy_pending:number;plan_policy_pending:number;
  configurable_quota_pending:number;configurable_plan_pending:number;
  pricing_missing:number;real_tests_missing:number;estimate_missing:number;free_billing:number;
  status?:{catalogued:number;prepared:number;configurable:number;runtime_configured:number;
    technical_test_passed:number;operational:number;enabled:number;studio_available:number};
}
interface ProposalPlan {
  plan_key:string;anchor_limit:number|null;anchor_approved:boolean;
  proposed_limit:number|null;quota_approved:boolean;quota_enabled:boolean;
  entitlement_allowed:boolean;entitlement_approved:boolean;
}
interface Proposal {
  family:string;display_name:string;anchor_family:string;multiplier:number;minimum:number;rationale:string;
  quota_approved_plans:number;entitlement_approved_plans:number;models_prepared:number;plans:ProposalPlan[];
}
type Draft = {allowed:boolean;entitlementApproved:boolean;limit:string;quotaEnabled:boolean;quotaApproved:boolean};
const key=(plan:string,family:string)=>`${plan}:${family}`;

/**
 * Administration des quotas et des droits d'abonnement.
 *
 * Deux niveaux sont volontairement séparés :
 *   - les propositions DÉRIVÉES d'une famille (audio, 3D, LoRA…) : calculées à
 *     partir d'un quota déjà approuvé, visibles, modifiables, mais jamais
 *     appliquées tant qu'un administrateur ne les approuve pas explicitement ;
 *   - la matrice plan × famille : limite, quota actif, droit d'offre, chacun
 *     avec son propre drapeau d'approbation.
 * Aucun modèle n'est activé depuis cet écran et aucune limite n'est inventée.
 */
export function StudioPlanMatrix(){
 const [plans,setPlans]=useState<Plan[]>([]),[summary,setSummary]=useState<Summary|null>(null),[drafts,setDrafts]=useState<Record<string,Draft>>({});
 const [proposals,setProposals]=useState<Proposal[]>([]),[notes,setNotes]=useState<Record<string,string>>({}),[withPlans,setWithPlans]=useState<Record<string,boolean>>({});
 const [error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const load=async()=>{
  setError('');
  try{
   const [matrix,counters,derived]=await Promise.all([
    universalRuntime<{plans:Plan[]}>('admin_plan_matrix'),
    universalRuntime<Summary>('admin_summary'),
    universalRuntime<{families:Proposal[]}>('admin_plan_proposals'),
   ]);
   const list=Array.isArray(matrix.plans)?matrix.plans:[];
   setPlans(list);setSummary(counters);
   setProposals(Array.isArray(derived.families)?derived.families:[]);
   const next:Record<string,Draft>={};
   for(const plan of list)for(const f of (plan.families??[]))next[key(plan.plan_key,f.family)]={
     allowed:f.allowed,entitlementApproved:f.entitlement_approved,
     limit:f.monthly_limit===null?'':String(f.monthly_limit),
     quotaEnabled:f.quota_enabled,quotaApproved:f.quota_approved,
   };
   setDrafts(next);
  }catch(e){setError(asAppError(e).message);}
 };
 useEffect(()=>{void load();},[]);
 const update=(k:string,patch:Partial<Draft>)=>setDrafts(current=>({...current,[k]:{...current[k],...patch}}));
 const save=async(plan:string,family:string)=>{
  const d=drafts[key(plan,family)];if(!d)return;
  setBusy(true);setMessage('');setError('');
  try{
   await universalRuntime('admin_plan_family',{plan_key:plan,family,allowed:d.allowed,approved:d.entitlementApproved});
   const limit=d.limit.trim()===''?null:Number(d.limit);
   await universalRuntime('admin_plan_quota',{plan_key:plan,family,limit,enabled:d.quotaEnabled,approved:d.quotaApproved});
   setMessage(`${plan} · ${family} : politique enregistrée.`);
   await load();
  }catch(e){setError(asAppError(e).message);}finally{setBusy(false);}
 };
 const recompute=async(family?:string)=>{
  setBusy(true);setMessage('');setError('');
  try{
   await universalRuntime('admin_plan_propose',family?{family}:{});
   setMessage(family?`Proposition recalculée pour ${family}.`:'Toutes les propositions ont été recalculées.');
   await load();
  }catch(e){setError(asAppError(e).message);}finally{setBusy(false);}
 };
 const approve=async(family:string)=>{
  const note=notes[family]??'';
  setBusy(true);setMessage('');setError('');
  try{
   const result=await universalRuntime<{saved:{quota_plans_approved:number;entitlement_plans_approved:number}}>('admin_plan_approve',{
     family,approve_entitlements:withPlans[family]===true,note,
   });
   setMessage(`${family} : ${result.saved?.quota_plans_approved??0} quota(s) de plan approuvé(s)${withPlans[family]?`, ${result.saved?.entitlement_plans_approved??0} droit(s) d’offre approuvé(s)`:''}.`);
   await load();
  }catch(e){setError(asAppError(e).message);}finally{setBusy(false);}
 };
 const ladder=summary?.status??null;
 return <Card><CardHeader title="Quotas, offres et disponibilité Studio" description="Une famille sans quota approuvé reste bloquée ; aucune limite n'est inventée à la place du produit." />
  <div className="space-y-4 p-5 pt-0 text-xs text-slate-300">
   {ladder&&<div className="space-y-1">
    <p className="text-slate-400">Échelle des statuts (même mesure que le runtime) :</p>
    <div className="flex flex-wrap gap-2">
     {[['Catalogues',ladder.catalogued],['Préparés',ladder.prepared],['Configurables',ladder.configurable],
       ['Runtime configuré',ladder.runtime_configured],['Test technique',ladder.technical_test_passed],
       ['Opérationnels',ladder.operational],['Activés',ladder.enabled],['Disponibles Studio',ladder.studio_available]]
      .map(([label,value])=><div key={String(label)} className="rounded-lg border border-white/10 px-3 py-2"><p className="text-slate-500">{label}</p><p className="text-lg font-semibold text-white">{String(value)}</p></div>)}
    </div>
   </div>}
   {summary&&<div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
    {[
      ['Quota à arbitrer',summary.quota_policy_pending],['Configurables, quota en attente',summary.configurable_quota_pending],
      ['Configurables, offre en attente',summary.configurable_plan_pending],['Plans à arbitrer',summary.plan_policy_pending],
      ['Prix manquants',summary.pricing_missing],['Tests réels manquants',summary.real_tests_missing],
      ['Gratuits déclarés',summary.free_billing],
    ].map(([label,value])=><div key={String(label)} className="rounded-lg border border-white/10 px-3 py-2"><p className="text-slate-500">{label}</p><p className="text-lg font-semibold text-white">{String(value??'—')}</p></div>)}
   </div>}
   <p className="text-amber-200">Un modèle « configurable » n'est ni validé ni activé : il lui manque au minimum une attestation de test réel et une activation explicite. Les compteurs séparent les blocages techniques des arbitrages produit.</p>
   {error&&<p role="alert">Erreur : {error}</p>}{message&&<p role="status">{message}</p>}

   <section className="space-y-2 rounded-xl border border-amber-300/30 bg-amber-400/5 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
     <h4 className="text-sm font-semibold text-amber-100">Propositions dérivées — non approuvées</h4>
     <Button size="sm" variant="outline" disabled={busy} onClick={()=>void recompute()}>Recalculer toutes les propositions</Button>
    </div>
    <p className="text-amber-200">Chaque proposition est un multiple d'un quota <em>déjà approuvé</em> ({proposals[0]?.anchor_family??'video'}), jamais un quota vidéo ou image détourné. Tant qu'une famille n'est pas approuvée, la génération est refusée avec <code>quota_policy_missing:&lt;famille&gt;</code>.</p>
    {!proposals.length&&<p role="status">Aucune règle de dérivation enregistrée.</p>}
    {proposals.map(p=><div key={p.family} className="space-y-2 rounded-lg border border-white/10 p-3">
     <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-sm text-white">{p.display_name} <code className="text-slate-400">{p.family}</code></p>
      <span className="text-slate-400">{p.multiplier} × {p.anchor_family} · minimum {p.minimum} · {p.models_prepared} modèle(s) préparé(s)</span>
     </div>
     <p className="text-slate-400">{p.rationale}</p>
     <div className="flex flex-wrap gap-1.5">{(p.plans??[]).map(plan=><span key={plan.plan_key} className={`rounded border px-2 py-1 ${plan.quota_approved?'border-emerald-400/40 text-emerald-200':'border-white/10 text-slate-300'}`}>
      {plan.plan_key} : {plan.proposed_limit??0}{plan.quota_approved?' (approuvé)':''}{plan.entitlement_allowed?' · offre':''}
     </span>)}</div>
     <div className="flex flex-wrap items-center gap-2">
      <label className="flex-1">Motif d'approbation<input className="studio-input ml-2 min-w-48" maxLength={200} aria-label={`${p.family} motif d'approbation`} value={notes[p.family]??''} onChange={e=>setNotes(v=>({...v,[p.family]:e.target.value}))} placeholder="Arbitrage produit daté"/></label>
      <label className="inline-flex items-center gap-1"><input type="checkbox" aria-label={`${p.family} approuver aussi les droits d'offre`} checked={withPlans[p.family]===true} onChange={e=>setWithPlans(v=>({...v,[p.family]:e.target.checked}))}/>approuver aussi les droits d'offre proposés</label>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void recompute(p.family)}>Recalculer</Button>
      <Button size="sm" disabled={busy||(notes[p.family]??'').trim().length<3} onClick={()=>void approve(p.family)}>Approuver {p.family}</Button>
     </div>
    </div>)}
   </section>

   {!plans.length&&!error&&<p role="status">Chargement de la matrice…</p>}
   {plans.map((plan,index)=><section key={plan.plan_key??`plan-${index}`} className="space-y-2 rounded-xl border border-white/10 p-3">
    <h4 className="text-sm font-semibold text-white">{plan.display_name} <code className="text-xs text-slate-400">{plan.plan_key}</code></h4>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-slate-400"><th className="p-2">Famille</th><th className="p-2">Incluse</th><th className="p-2">Droit approuvé</th><th className="p-2">Limite / mois</th><th className="p-2">Quota actif</th><th className="p-2">Quota approuvé</th><th className="p-2">Source</th><th className="p-2" /></tr></thead><tbody>
     {(plan.families??[]).map(f=>{const d=drafts[key(plan.plan_key,f.family)];if(!d)return null;return <tr key={f.family} className="border-t border-white/10">
      <td className="p-2">{f.display_name} <code>{f.family}</code></td>
      <td className="p-2"><input type="checkbox" aria-label={`${plan.plan_key} ${f.family} incluse`} checked={d.allowed} onChange={e=>update(key(plan.plan_key,f.family),{allowed:e.target.checked})}/></td>
      <td className="p-2"><input type="checkbox" aria-label={`${plan.plan_key} ${f.family} droit approuvé`} checked={d.entitlementApproved} onChange={e=>update(key(plan.plan_key,f.family),{entitlementApproved:e.target.checked})}/></td>
      <td className="p-2"><input className="studio-input w-24" type="number" min="0" max="1000000" aria-label={`${plan.plan_key} ${f.family} limite`} value={d.limit} onChange={e=>update(key(plan.plan_key,f.family),{limit:e.target.value})}/></td>
      <td className="p-2"><input type="checkbox" aria-label={`${plan.plan_key} ${f.family} quota actif`} checked={d.quotaEnabled} onChange={e=>update(key(plan.plan_key,f.family),{quotaEnabled:e.target.checked})}/></td>
      <td className="p-2"><input type="checkbox" aria-label={`${plan.plan_key} ${f.family} quota approuvé`} checked={d.quotaApproved} onChange={e=>update(key(plan.plan_key,f.family),{quotaApproved:e.target.checked})}/></td>
      <td className="p-2 text-slate-500">{f.source_note??'—'}</td>
      <td className="p-2"><Button size="sm" variant="outline" disabled={busy} onClick={()=>void save(plan.plan_key,f.family)}>Enregistrer</Button></td>
     </tr>;})}
    </tbody></table></div>
   </section>)}
  </div>
 </Card>;
}
