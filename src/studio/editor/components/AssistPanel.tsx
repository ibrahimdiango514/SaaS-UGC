import { useMemo, useState } from 'react';
import { Check, Lightbulb, Pencil, Sparkles, X } from 'lucide-react';
import { Button, cn } from '../../../components/ui';
import { analyzeProject, subtitleSpans, type Suggestion } from '../assist';
import { clampDuration, totalDuration, type EditorProject, type TransitionKind } from '../types';

const COVERAGE = 'média, accroche, CTA, rythme, incohérences, coupes, sync voix/images, transitions, sous-titres, cohérence visuelle';

function editableValue(s: Suggestion): { label: string; value: string; hint: string } | null {
  switch (s.id) {
    case 'pacing': return { label: 'Durée cible (secondes)', value: '20', hint: 'Les plans sont ajustés proportionnellement.' };
    case 'cuts': return { label: 'Longueur maximale des sous-titres', value: '90', hint: 'Nombre de caractères conservés sur mobile.' };
    case 'visual-consistency': return { label: 'Durée minimale d’un plan (s)', value: '1.5', hint: 'Les plans plus courts sont allongés.' };
    case 'subtitles': return { label: 'Texte du premier sous-titre', value: '', hint: 'Laissez vide pour utiliser la voix off du plan.' };
    case 'transitions': return { label: 'Transition', value: 'fade', hint: 'Valeurs : cut, fade, dissolve, slide.' };
    default: return null;
  }
}

/** A real state transformation; overrides are validated, never sent to a provider. */
function applyWithOverride(project: EditorProject, s: Suggestion, raw: string): EditorProject {
  const base = s.apply ? s.apply(project) : project;
  const value = raw.trim();
  if (s.id === 'pacing') {
    const target = Number(value);
    if (!Number.isFinite(target) || target < 1 || target > 120) return base;
    const factor = target / Math.max(0.1, totalDuration(project));
    return { ...base, scenes: base.scenes.map((scene) => ({ ...scene, duration: clampDuration(scene.duration * factor) })), updatedAt: new Date().toISOString() };
  }
  if (s.id === 'cuts') {
    const max = Number(value);
    if (!Number.isFinite(max) || max < 20 || max > 500) return base;
    return { ...base, scenes: base.scenes.map((scene) => scene.subtitle.length > max
      ? { ...scene, subtitle: `${scene.subtitle.slice(0, max - 1).trimEnd()}…` } : scene), updatedAt: new Date().toISOString() };
  }
  if (s.id === 'visual-consistency') {
    const min = Number(value);
    if (!Number.isFinite(min) || min < 0.5 || min > 60) return base;
    return { ...base, scenes: base.scenes.map((scene) => scene.duration < min ? { ...scene, duration: clampDuration(min) } : scene), updatedAt: new Date().toISOString() };
  }
  if (s.id === 'subtitles') {
    const span = subtitleSpans({ ...project, subtitlesEnabled: true })[0];
    const firstSpoken = project.scenes.findIndex((scene) => scene.spokenText.trim().length > 5);
    if (!span && firstSpoken < 0) return base;
    return { ...base, subtitlesEnabled: true, scenes: base.scenes.map((scene, i) => i === firstSpoken
      ? { ...scene, subtitle: (value || scene.spokenText).trim().slice(0, 110) } : scene), updatedAt: new Date().toISOString() };
  }
  if (s.id === 'transitions') {
    if (!['cut', 'fade', 'dissolve', 'slide'].includes(value)) return base;
    return { ...base, scenes: base.scenes.map((scene, i, all) => i === Math.max(0, all.length - 2)
      ? { ...scene, transition: value as TransitionKind } : scene), updatedAt: new Date().toISOString() };
  }
  return base;
}

export function AssistPanel({ project, onChange, disabled }: {
  project: EditorProject;
  onChange: (p: EditorProject) => void;
  disabled?: boolean;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const suggestions = useMemo(() => analyzeProject(project, 20), [project]);
  const visible = suggestions.filter((s) => !dismissed.includes(s.id));

  const accept = (s: Suggestion, override?: string) => {
    if (!s.apply) return;
    onChange(override === undefined ? s.apply(project) : applyWithOverride(project, s, override));
    setDismissed((d) => [...d, s.id]); setEditing(null); setValue('');
  };

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-white"><Sparkles size={13} className="text-cyan-300" /> Assistant de montage</p>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-500">Analyse déterministe locale · aucune réponse IA simulée · ne lance aucune génération ni aucun débit.</p>
        </div>
        <span className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400">{visible.length} avis</span>
      </div>
      {disabled && <p className="mt-2 text-[10px] text-amber-300">Suggestions en lecture seule pendant le rendu.</p>}
      <div className="mt-3 max-h-[330px] space-y-2 overflow-y-auto pr-1">
        {visible.length === 0 && <p className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-3 text-[11px] text-emerald-200">Aucune alerte restante. Vérifiez tout de même la prévisualisation avant d’exporter.</p>}
        {visible.map((s) => {
          const editable = editableValue(s);
          return (
            <div key={s.id} className={cn('rounded-xl border p-3',
              s.severity === 'error' ? 'border-rose-400/25 bg-rose-400/[0.04]' :
                s.severity === 'warning' ? 'border-amber-400/20 bg-amber-400/[0.04]' :
                  'border-white/[0.07] bg-white/[0.02]')}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-white">{s.title}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{s.detail}</p>
                </div>
                <span className="shrink-0 rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase text-slate-500">{s.kind}</span>
              </div>
              {editing === s.id && editable && (
                <div className="mt-2 space-y-1.5">
                  <label className="block text-[10px] text-slate-400">{editable.label}
                    <input value={value} onChange={(e) => setValue(e.target.value)} className="studio-input mt-1" aria-label={editable.label} />
                  </label>
                  <p className="text-[9px] text-slate-600">{editable.hint}</p>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => accept(s, value)}>Appliquer ma version</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setValue(''); }}>Annuler</Button>
                  </div>
                </div>
              )}
              {editing !== s.id && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.apply && <button type="button" disabled={disabled} onClick={() => accept(s)} className="studio-chip text-emerald-200"><Check size={11} /> Accepter</button>}
                  {s.apply && editable && <button type="button" disabled={disabled} onClick={() => { setEditing(s.id); setValue(editable.value); }} className="studio-chip"><Pencil size={11} /> Modifier</button>}
                  <button type="button" onClick={() => setDismissed((d) => [...d, s.id])} className="studio-chip text-slate-400"><X size={11} /> Refuser</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-600"><Lightbulb size={11} className="mt-0.5 shrink-0" /> Couverture : {COVERAGE}. Les modifications ne sont appliquées qu’au montage visible, jamais transmises aveuglément à MuAPI.</p>
    </section>
  );
}
