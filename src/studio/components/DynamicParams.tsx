import { ImagePlus, SlidersHorizontal, Upload, X } from 'lucide-react';
import { Button, Select, Toggle } from '../../components/ui';
import type { MuApiModel } from '../../lib/types';
import { normalizeParamValue, paramLabel, supportedParams, type ParamValue } from '../model';

function Field({ name, model, value, onChange }: {
  name: string; model: MuApiModel; value: ParamValue | undefined;
  onChange: (key: string, value: ParamValue) => void;
}) {
  const def = model.param_schema[name];
  const stringValue = value === undefined || value === null ? '' : String(value);
  const required = model.required_fields.includes(name) || def.required === true;

  if (def.type === 'boolean') {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
        <Toggle checked={value === true || value === 'true'} onChange={(v) => onChange(name, v)} label={def.label ?? paramLabel(name)} />
      </div>
    );
  }

  if (def.type === 'number') {
    const min = def.min ?? 1;
    const max = def.max ?? 300;
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

  if (def.type === 'select') {
    const options = (def.options ?? []).map(String);
    return (
      <Select id={`param-${name}`} label={`${def.label ?? paramLabel(name)}${required ? ' *' : ''}`} value={stringValue}
        onChange={(e) => onChange(name, normalizeParamValue(model, name, e.target.value))}>
        {options.map((option) => <option key={option} value={option}>{option}{name === 'duration' ? ' s' : ''}</option>)}
      </Select>
    );
  }

  if (def.type === 'string') {
    return (
      <label htmlFor={`param-${name}`} className="block text-[11px] font-medium text-slate-300">
        {def.label ?? paramLabel(name)}{required ? ' *' : ''}
        <input id={`param-${name}`} value={stringValue} placeholder={def.description ?? 'Valeur acceptée par le modèle'}
          onChange={(e) => onChange(name, e.target.value)}
          className="studio-input mt-1.5" />
      </label>
    );
  }

  // Arrays/objects are declared by some MuAPI schemas but Reelora has no
  // connected editor for them yet. Never invent a control or a value.
  return null;
}

export function DynamicParams({ model, values, onChange }: {
  model: MuApiModel; values: Record<string, ParamValue>; onChange: (values: Record<string, ParamValue>) => void;
}) {
  const params = supportedParams(model).filter(([, def]) => ['select', 'number', 'boolean', 'string'].includes(def.type));
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
