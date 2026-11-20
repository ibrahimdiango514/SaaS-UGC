import {useEffect,useState} from 'react';
import {getUniversalCatalogHealth,type UniversalCatalogHealth as Health} from '../../lib/api';
import {useCatalogRevision} from '../../hooks/useCatalogRevision';
import {Button,Card} from '../../components/ui';
import {asAppError} from '../../lib/errors';
export function UniversalCatalogHealth({onInspect}:{onInspect?:()=>void}){
 const revision=useCatalogRevision(),[data,setData]=useState<Health|null>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;void(async()=>{try{const next=await getUniversalCatalogHealth();if(live){setData(next);setError('');}}catch(e){if(live){setData(null);setError(asAppError(e).message);}}})();return()=>{live=false;};},[revision]);
 const counts=[['Références MuAPI',data?.models],['Intégrations préparées',data?.prepared],['Intégrés et validés',data?.integrated],['Opérationnels',data?.operational],['Activation configurée',data?.enabled],['Disponibles dans le Studio',data?.studio_available],['Références à résoudre',data?.problems]] as const;
 return <Card className="mb-5 space-y-3 p-4" data-testid="universal-catalog-health"><h3 className="font-semibold text-white">Catalogue MuAPI — source universelle</h3><dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">{counts.map(([label,value])=><div key={label}><dt className="text-xs text-slate-400">{label}</dt><dd className="text-xl font-semibold text-white">{value??'—'}</dd></div>)}</dl>
 <p className="text-xs text-slate-400">Tous types confondus, sans additionner le sous-catalogue vidéo historique. Actualisation automatique toutes les 20 secondes et au retour sur la page.</p>
 {data&&<p className="text-xs text-slate-400">Mesuré le {new Date(data.measured_at).toLocaleString()} · {data.pricing_missing} sans tarification complète · {data.real_tests_missing} sans attestation réelle.</p>}
 {error&&<p role="alert" className="text-xs text-amber-200">{error}</p>}
 {onInspect&&<Button size="sm" variant="outline" onClick={onInspect}>Consulter les modèles et leurs problèmes</Button>}
 </Card>;
}
