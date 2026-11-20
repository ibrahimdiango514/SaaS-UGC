import { useEffect, useState } from 'react';
import { UniversalRuntimeConfig } from './UniversalRuntimeConfig';
import { UniversalModelForm } from './UniversalModelForm';
import { resolveMuapiEndpoint } from '../../../supabase/functions/universal-catalog/endpoint';
import { Button, Card, CardHeader } from '../../components/ui';
import { asAppError } from '../../lib/errors';
import { getUniversalAdminModelDetail, getUniversalAdminModels, getUniversalCatalogSummary, type UniversalAdminModelDetail, type UniversalAdminPage } from '../../lib/api';

type ObjectValue = Record<string, unknown>;
const object = (x: unknown): ObjectValue => x && typeof x === 'object' && !Array.isArray(x) ? x as ObjectValue : {};
function SchemaPreview({ schema }: { schema: unknown }) {
  const root = object(object(object(schema).schemas).input_data);
  const properties = object(root.properties);
  const required = new Set(Array.isArray(root.required) ? root.required.filter((x): x is string => typeof x === 'string') : []);
  if (root.type !== 'object' || !Object.keys(properties).length) return <p>Schéma non exploitable pour cet aperçu.</p>;
  return <ul className="space-y-1" aria-label="Aperçu des paramètres déclarés">
    {Object.entries(properties).map(([key, raw]) => {
      const def = object(raw);
      return <li key={key} className="rounded border border-white/10 px-2 py-1">
        <span className="font-medium text-slate-200">{typeof def.title === 'string' ? def.title : key}</span> <code>{key}</code>
        {' · '}{typeof def.type === 'string' ? def.type : 'type non reconnu'} · {required.has(key) ? 'obligatoire' : 'facultatif'}
        {Array.isArray(def.enum) && <span> · valeurs déclarées : {def.enum.map(String).join(', ')}</span>}
      </li>;
    })}
  </ul>;
}

/** Administration consultation only: no claim that the catalog is executable. */
export function UniversalCatalogBrowser() {
  const [queryInput,setQueryInput] = useState('');
  const [query,setQuery] = useState('');
  const [category,setCategory] = useState('');
  const [status,setStatus] = useState('');
  const [categories,setCategories] = useState<string[]>([]);
  const [history,setHistory] = useState<string[]>(['']);
  const [page,setPage] = useState<UniversalAdminPage | null>(null);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [modelId,setModelId] = useState<string | null>(null);
  const [detail,setDetail] = useState<UniversalAdminModelDetail | null>(null);
  const [detailError,setDetailError] = useState('');
  const after = history[history.length-1];
  const binding = detail ? resolveMuapiEndpoint(detail.provider_model_id, detail.input_schema, detail.endpoint_evidence) : null;
  useEffect(() => { let active=true; getUniversalCatalogSummary().then(x => { if (active) setCategories(Object.keys(x.categories).sort()); }).catch(() => { if (active) setCategories([]); }); return () => { active=false; }; }, []);
  useEffect(() => {
    let active=true; setLoading(true); setError(''); setPage(null);
    getUniversalAdminModels({query,category,status,after}).then(x => { if(active) setPage(x); }).catch(e => { if(active) setError(asAppError(e).message); }).finally(() => { if(active) setLoading(false); });
    return () => { active=false; };
  }, [query,category,status,after]);
  useEffect(() => {
    let active=true; setDetail(null); setDetailError('');
    if (modelId) getUniversalAdminModelDetail(modelId).then(x => { if(active) setDetail(x); }).catch(e => { if(active) setDetailError(asAppError(e).message); });
    return () => { active=false; };
  }, [modelId]);
  const resetPage = () => { setHistory(['']); setModelId(null); };
  return <Card><CardHeader title="Explorer le registre universel" description="Consultation administrateur des références MuAPI, y compris celles non intégrées. Ce registre ne permet pas encore de lancer une génération." />
    <div className="space-y-4 p-5 pt-0 text-sm text-slate-300">
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); resetPage(); setQuery(queryInput.trim()); }}>
        <label className="sr-only" htmlFor="universal-admin-query">Rechercher un modèle</label>
        <input id="universal-admin-query" className="studio-input min-w-48 flex-1" value={queryInput} maxLength={200} onChange={e => setQueryInput(e.target.value)} placeholder="Nom, identifiant ou catégorie" />
        <Button type="submit" size="sm" variant="outline">Rechercher</Button>
        <label className="sr-only" htmlFor="universal-admin-category">Catégorie</label>
        <select id="universal-admin-category" className="studio-input" value={category} onChange={e => { resetPage(); setCategory(e.target.value); }}><option value="">Toutes les catégories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <label className="sr-only" htmlFor="universal-admin-status">Statut</label>
        <select id="universal-admin-status" className="studio-input" value={status} onChange={e => { resetPage(); setStatus(e.target.value); }}>
          <option value="">Tous les statuts</option><option value="catalog_only">Catalogué uniquement</option><option value="partial">Partiel</option><option value="integrated">Intégré</option><option value="e2e_verified">E2E vérifié</option><option value="enabled">Activé Studio</option><option value="disabled">Désactivé Studio</option><option value="missing">Absent du catalogue public</option>
        </select>
      </form>
      <p className="text-xs text-slate-400">Fournisseur : MuAPI · {page ? `${page.total} résultat(s)` : 'chargement du registre'}. Les prix ne sont pas enregistrés dans ce registre.</p>
      {loading && <p role="status">Chargement…</p>}{error && <p role="alert">Erreur de lecture : {error}</p>}
      {page && <><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr className="text-slate-400"><th className="p-2">Modèle / identifiant</th><th className="p-2">Catégorie</th><th className="p-2">Fiche</th><th className="p-2">Accès</th><th className="p-2">Intégration</th><th className="p-2">Studio</th></tr></thead><tbody>
        {page.items.map(m => <tr key={m.provider_model_id} className="border-t border-white/10"><td className="p-2"><button type="button" className="text-left text-cyan-300 underline" onClick={() => setModelId(m.provider_model_id)}>{m.display_name}<br /><code>{m.provider_model_id}</code></button></td><td className="p-2">{m.category}</td><td className="p-2">{m.detail_status ?? 'non vérifiée'}</td><td className="p-2">{m.account_access}</td><td className="p-2">{m.integration_status}</td><td className="p-2">{m.studio_enabled ? 'activé' : 'désactivé'}</td></tr>)}
      </tbody></table></div>
        {page.items.length === 0 && <p>Aucun modèle pour ces filtres.</p>}
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={history.length===1} onClick={() => { setHistory(h => h.slice(0,-1)); setModelId(null); }}>Page précédente</Button><Button size="sm" variant="outline" disabled={!page.next_cursor} onClick={() => { if (page.next_cursor) { setHistory(h => [...h,page.next_cursor!]); setModelId(null); } }}>Page suivante</Button></div>
      </>}
      {detailError && <p role="alert">Erreur de fiche : {detailError}</p>}
      {modelId && !detail && !detailError && <p role="status">Chargement de la fiche…</p>}
      {detail && <section aria-label="Fiche du modèle" className="space-y-3 rounded-xl border border-cyan-400/20 p-4 text-xs">
        <h3 className="text-base font-semibold text-white">{detail.display_name} <code className="text-xs">{detail.provider_model_id}</code></h3>
        <p>{detail.provider_key} · {detail.category} · {detail.public_catalog_present ? 'présent au catalogue' : 'absent du catalogue public'}</p>
        <p>Endpoint déclaré dans la fiche : {binding?.url ?? 'absent, invalide ou contradictoire — intégration bloquée'}. Ce champ n’est pas une preuve d’accès ou de fonctionnement.</p>
        {detail.description && <p>{detail.description}</p>}
        <ul className="space-y-1"><li>1. Catalogué : oui</li><li>2. Fiche technique : {detail.detail_status ?? 'non vérifiée'}{detail.detail_http_status ? ` (HTTP ${detail.detail_http_status})` : ''}</li><li>3. Accès au compte : {detail.account_access}</li><li>4. Clé d’adaptateur : {detail.adapter_key ?? 'non renseignée — adaptation non établie'}</li><li>5. Paramètres intégrés : non établis par la fiche</li><li>6. Test technique : non établi par la fiche</li><li>7. E2E : {detail.integration_status === 'e2e_verified' ? 'statut E2E enregistré' : 'non établi'}</li></ul>
        <p>Studio : {detail.studio_enabled ? 'activé' : 'désactivé'} · statut d’intégration : {detail.integration_status}. Activation et modification indisponibles tant que les contrôles serveur ne sont pas raccordés.</p>
        <p>Coût fournisseur, coût interne et marge : non enregistrés dans ce registre ; aucun montant déduit.</p>
        <h4 className="font-semibold text-white">Aperçu des paramètres du schéma</h4><p className="text-slate-400">Lecture seule : cet aperçu n’est pas un formulaire de génération validé.</p><SchemaPreview schema={detail.input_schema} />
        <UniversalRuntimeConfig key={detail.provider_model_id} modelId={detail.provider_model_id} />
        <h4 className="font-semibold text-white">Formulaire de validation serveur (sans génération)</h4><UniversalModelForm key={detail.provider_model_id + String(detail.detail_checked_at)} modelId={detail.provider_model_id} schema={detail.input_schema} evidence={detail.endpoint_evidence} />
        <details><summary className="cursor-pointer">Schéma brut des entrées</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(detail.input_schema,null,2)}</pre></details>
        <details><summary className="cursor-pointer">Schéma brut des sorties</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(detail.output_schema,null,2)}</pre></details>
        <details><summary className="cursor-pointer">Changements récents du catalogue (20 maximum)</summary><ul>{detail.recent_changes.map(c => <li key={c.id}>{c.created_at} · {c.change_type}</li>)}</ul></details>
      </section>}
    </div>
  </Card>;
}
