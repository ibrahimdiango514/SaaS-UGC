import { ImagePlus, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Button, Select, Toggle } from '../../components/ui';
import type { MuApiModel } from '../../lib/types';
import { normalizeParamValue, optionsOf, paramLabel, supportedParams, type ParamValue } from '../model';

function Field({ name, model, value, onChange }: {
  name: string; model: MuApiModel; value: ParamValue | undefined;
  onChange: (key: string, value: ParamValue) => void;
}) {
  const def = model.param_schema[name];
  const stringValue = value === undefined || value === null ? '' : String(value);
  const required = model.required_fields.includes(name) || def.required === true;
  const options = optionsOf(model, name);
  const min = def.min ?? 1;
  const max = def.max ?? 300;
  const hasRange = def.min != null && def.max != null
    && Number.isFinite(min) && Number.isFinite(max) && max >= min;

  // MuAPI may declare options on a `string`/`number` field, not only on a
  // `select`. Every declared option is a real constraint; honour it first.
  if (options.length > 0) {
    return (
      <Select id={`param-${name}`} label={`${def.label ?? paramLabel(name)}${required ? ' *' : ''}`} value={stringValue}
        onChange={(e) => onChange(name, normalizeParamValue(model, name, e.target.value))}>
        {options.map((option) => <option key={option} value={option}>{option}{name === 'duration' ? ' s' : ''}</option>)}
      </Select>
    );
  }

  if (def.type === 'boolean') {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
        <Toggle checked={value === true || value === 'true'} onChange={(v) => onChange(name, v)} label={def.label ?? paramLabel(name)} />
      </div>
    );
  }

  if (hasRange) {
    const current = Number(value ?? def.default ?? min);
    return (
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <label htmlFor={`param-${name}`} className="text-xs font-medium text-slate-200">{def.label ?? paramLabel(name)}</label>
          <span className="rounded-md bg-cyan-400/15 px-2 py-0.5 text-xs font-semibold text-cyan-200">{current}{name === 'duration' ? ' s' : ''}</span>
        </div>
        <input id={`param-${name}`} type="range" min={min} max={max} step={def.step ?? 1} value={Number.isFinite(current) ? current : min}
          onChange={(e) => onChange(name, Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-cyan-400" />
        <div className="mt-1 flex justify-between text-[10px] text-slate-600"><span>{min}{name === 'duration' ? ' s' : ''}</span><span>{max}{name === 'duration' ? ' s' : ''}</span></div>
      </div>
    );
  }

  if (def.type === 'number') {
    return (
      <label htmlFor={`param-${name}`} className="block text-[11px] font-medium text-slate-300">
        {def.label ?? paramLabel(name)}{required ? ' *' : ''}
        <input id={`param-${name}`} type="number" step={def.step ?? 1} value={stringValue}
          placeholder={def.default !== undefined ? String(def.default) : 'Valeur numérique déclarée'}
          onChange={(e) => onChange(name, Number(e.target.value))}
          className="studio-input mt-1.5" />
      </label>
    );
  }

  if (def.type === 'string') {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3" data-testid="dynamic-params-declared-field">
        <label htmlFor={`param-${name}`} className="block text-[11px] font-medium text-slate-300">
          {def.label ?? paramLabel(name)}{required ? ' *' : ''}
          <input id={`param-${name}`} value={stringValue} placeholder={def.description ?? 'Valeur acceptée par le modèle'}
            onChange={(e) => onChange(name, e.target.value)}
            className="studio-input mt-1.5" />
        </label>
        <p className="mt-1.5 text-[9px] leading-relaxed text-slate-600">Champ déclaré sans liste d’options dans le schéma synchronisé : la fiche détaillée du fournisseur fait foi, aucune valeur n’est supposée.</p>
      </div>
    );
  }

  // Arrays/objects are declared by some MuAPI schemas but Reelora has no
  // connected editor for them yet. Never invent a control or a value.
  return null;
}

export function DynamicParams({ model, values, onChange }: {
  model: MuApiModel; values: Record<string, ParamValue>; onChange: (values: Record<string, ParamValue>) => void;
}) {
  const declared = supportedParams(model);
  const params = declared.filter(([, def]) => ['select', 'number', 'boolean', 'string'].includes(def.type) || Number.isFinite(def.min) || Number.isFinite(def.max) || (def.options?.length ?? 0) > 0);
  const structured = declared.filter(([key]) => !params.some(([k]) => k === key)).map(([key]) => key);
  const hasFirstImage = model.input_fields.includes('image_url');
  const hasLastImage = model.input_fields.includes('last_image');

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-400/10 text-cyan-200"><SlidersHorizontal size={15} /></span>
        <div>
          <h3 className="text-sm font-semibold text-white">Paramètres dynamiques</h3>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
            Générés depuis <code className="text-slate-400">GET /api/v1/models/{'{name}'}</code> : seules les entrées réellement déclarées sont affichées.
          </p>
        </div>
      </div>

      {params.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {params.map(([key]) => (
            <Field key={key} name={key} model={model} value={values[key]} onChange={(k, v) => onChange({ ...values, [k]: v })} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-xs text-slate-500">Ce modèle n’expose aucun réglage supplémentaire exploitable : seul le prompt sera envoyé.</p>
      )}

      {structured.length > 0 && (
        <p data-testid="dynamic-params-incompatible" className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2 text-[10px] leading-relaxed text-amber-200/90">
          Champs structurés déclarés mais non connectés : {structured.join(', ')}. Aucun contrôle ni valeur de substitution n’est fabriqué ; ces champs ne sont pas envoyés.
        </p>
      )}

      {(hasFirstImage || hasLastImage) && (
        <p className="mt-4 flex items-center gap-1.5 text-[11px] text-slate-500"><ImagePlus size={12} /> Images de référence déclarées : {[hasFirstImage && 'image initiale', hasLastImage && 'image finale'].filter(Boolean).join(' · ')}</p>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">Les champs média (image, audio, vidéo) ne sont pas transformés en réglages : ils sont fournis séparément uniquement si le moteur correspondant est connecté.</p>
    </div>
  );
}

export function ReferenceUploader({ model, firstPreview, lastPreview, onFirst, onLast, busy }: {
  model: MuApiModel;
  firstPreview: string | null;
  lastPreview: string | null;
  onFirst: (file: File | null) => void;
  onLast: (file: File | null) => void;
  busy?: boolean;
}) {
  const first = model.input_fields.includes('image_url');
  const last = model.input_fields.includes('last_image');
  if (!first && !last) return null;

  const panel = (label: string, preview: string | null, onChange: (file: File | null) => void, required: boolean) => (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-200">{label}{required ? ' *' : ''}</p>
        {preview && <button type="button" onClick={() => onChange(null)} className="text-slate-500 hover:text-rose-300" aria-label={`Retirer ${label}`}><X size={13} /></button>}
      </div>
      {preview ? <img src={preview} alt={label} className="h-28 w-full rounded-lg border border-white/10 object-cover" /> : (
        <label className="flex h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 text-slate-500 transition-colors hover:border-cyan-400/40 hover:text-cyan-200">
          <Upload size={18} />
          <span className="text-[11px]">Importer une image</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy}
            onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
        </label>
      )}
      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">Fichier conservé dans le bucket privé <code>ugc-assets</code> ; URL signée temporaire générée au moment de la soumission.</p>
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4 sm:p-5">
      <h3 className="mb-3 text-sm font-semibold text-white">Images de référence</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {first && panel('Image initiale', firstPreview, onFirst, model.required_fields.includes('image_url'))}
        {last && panel('Image finale (optionnelle)', lastPreview, onLast, model.required_fields.includes('last_image'))}
      </div>
      {!first && <Button variant="ghost" size="sm" icon={<ImagePlus size={13} />} disabled>Aucune image acceptée par ce modèle</Button>}
    </div>
  );
}
