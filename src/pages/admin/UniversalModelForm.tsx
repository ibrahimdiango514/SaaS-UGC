import { useState } from 'react';
import { Button } from '../../components/ui';
import { validateUniversalModelInput } from '../../lib/api';
import { muapiFormFields, validateMuapiInput } from '../../../supabase/functions/universal-catalog/schema';
import { resolveMuapiEndpoint } from '../../../supabase/functions/universal-catalog/endpoint';

/** Executable parameter validation, never a generation or provider-price probe. */
export function UniversalModelForm({ modelId, schema, evidence, onSubmit, upload, onValuesChange }: { modelId: string; schema: unknown; evidence?: unknown; onSubmit?: (params: Record<string,unknown>) => Promise<string>; upload?: (file: File) => Promise<string>; onValuesChange?: () => void }) {
  const fields = muapiFormFields(schema);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = resolveMuapiEndpoint(modelId, schema, evidence);
  if (!fields) return <p role="status">Formulaire bloqué : le schéma contient des contraintes non prises en charge. Aucune règle n’est ignorée.</p>;
  const set = (key: string, value: string) => { onValuesChange?.(); setMessage(''); setValues(v => ({ ...v, [key]: value })); };
  return <form className="space-y-3" aria-label="Validation des paramètres du modèle" onSubmit={async e => {
    e.preventDefault(); setMessage('');
    const params: Record<string, unknown> = {};
    try {
      for (const { key, definition: d } of fields) {
        const text = values[key] ?? (d.default === undefined ? '' : typeof d.default === 'string' ? d.default : JSON.stringify(d.default));
        if (text === '') continue;
        params[key] = ['string','text'].includes(String(d.type)) ? text : JSON.parse(text);
      }
      if (onSubmit) { setBusy(true); setMessage(await onSubmit(params)); return; }
      const local = validateMuapiInput(schema, params);
      if (!local.ok) { setMessage(`${local.code} : ${local.field ?? 'schéma'}`); return; }
      setBusy(true);
      const result = await validateUniversalModelInput(modelId, params);
      setMessage(result.validation.ok ? 'Paramètres validés par le serveur. Aucune génération lancée, aucun crédit débité.' : `${result.validation.code} : ${result.validation.field ?? 'schéma'}`);
    } catch { setMessage('Validation impossible. Vérifiez les valeurs et votre session administrateur.'); }
    finally { setBusy(false); }
  }}>
    {!onSubmit && <><p>Endpoint : {endpoint.url ?? 'absent ou invalide — génération bloquée'}. Déclaration fournisseur uniquement, accès non prouvé.</p>
    <p>Validation sans génération. Les médias sont renseignés par URL HTTPS ; aucun fichier n’est téléversé ni téléchargé par ce formulaire. Les limites décrites uniquement en prose restent à intégrer avant activation.</p></>}
    {onSubmit && <p>Ajoutez vos médias dans le stockage privé. Le serveur contrôle les fichiers et les paramètres avant le devis. Aucune génération avant confirmation des crédits.</p>}
    {fields.map(({ key, definition: d, required }) => {
      const id = `universal-field-${key}`;
      const value = values[key] ?? (d.default === undefined ? '' : typeof d.default === 'string' ? d.default : JSON.stringify(d.default));
      const label = `${typeof d.title === 'string' ? d.title : key}${required ? ' *' : ''}`;
      return <div key={key}><label htmlFor={id} className="block text-slate-200">{label}</label>
        {Array.isArray(d.enum) ? <select id={id} className="studio-input w-full" value={value} onChange={e => set(key,e.target.value)}><option value="">Non renseigné</option>{d.enum.map((v,i) => <option key={i} value={typeof v === 'string' ? v : JSON.stringify(v)}>{String(v)}</option>)}</select>
          : d.type === 'boolean' ? <select id={id} className="studio-input w-full" value={value} onChange={e => set(key,e.target.value)}><option value="">Non renseigné</option><option value="true">Oui</option><option value="false">Non</option></select>
          : <textarea id={id} className="studio-input w-full" rows={d.type === 'array' ? 3 : 2} value={value} maxLength={32768} onChange={e => set(key,e.target.value)} placeholder={d.type === 'array' ? 'Tableau JSON, par exemple ["https://…"]' : typeof d.placeholder === 'string' ? d.placeholder : ''} />}
        {upload && d.field !== undefined && <label className="mt-1 block">Importer un fichier privé
          <input type="file" disabled={busy} className="block w-full" onChange={async e => {
            const file=e.target.files?.[0];if(!file)return;setBusy(true);setMessage('');onValuesChange?.();
            try {const marker=await upload(file); if(d.type==='array'){const previous=value?JSON.parse(value):[];if(!Array.isArray(previous))throw new Error('array');set(key,JSON.stringify([...previous,marker]));}else set(key,marker);}
            catch {setMessage('Import impossible : format, taille ou permissions invalides.');}finally{setBusy(false);e.target.value='';}
          }} />
        </label>}
        <p className="text-slate-400">{String(d.type)}{d.field ? ` · média : ${String(d.field)}` : ''}{typeof d.description === 'string' ? ` — ${d.description}` : ''}</p>
      </div>;
    })}
    <Button type="submit" size="sm" variant="outline" disabled={busy}>{busy ? 'Traitement…' : onSubmit ? 'Obtenir le prix en crédits' : 'Valider les paramètres côté serveur'}</Button>
    {message && <p role="status" aria-live="polite">{message}</p>}
  </form>;
}
