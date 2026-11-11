import { useMemo, useState } from 'react';
import {
  Bot, Check, Lightbulb, Pencil, RotateCcw, Sparkles, Wand2, X,
} from 'lucide-react';
import { Button, cn } from '../../../components/ui';
import { replanEditorScenes, type ProductionPlan } from '../../plan';
import { analyzeProject, subtitleSpans, type Suggestion } from '../assist';
import type { ProjectMediaItem } from '../projectMedia';
import {
  UGC_RHYTHM_PRESETS, clampDuration, totalDuration, type EditorProject,
  type TransitionKind, type UgcRhythmPresetId,
} from '../types';

const COVERAGE = 'médias du projet, découpes, ordre narratif UGC, accroche, CTA, rythme, sous-titres, débit voix off, ducking audio, cadrage, transitions';

function fallbackModifySpec(s: Suggestion): Suggestion['modifySpec'] | null {
  if (s.modifySpec) return s.modifySpec;
  switch (s.id) {
    case 'pacing': return { label: 'Durée cible (secondes)', inputType: 'number', defaultValue: '20', hint: 'Les plans sont ajustés proportionnellement.', min: 5, max: 90, step: 1 };
    case 'cuts': return { label: 'Longueur maximale des sous-titres', inputType: 'number', defaultValue: '90', hint: 'Nombre de caractères conservés sur mobile.', min: 25, max: 300, step: 5 };
    case 'visual-consistency': return { label: 'Durée minimale d’un plan (s)', inputType: 'number', defaultValue: '1.5', hint: 'Les plans plus courts sont allongés.', min: 0.5, max: 10, step: 0.5 };
    case 'subtitles': return { label: 'Texte du premier sous-titre', inputType: 'text', defaultValue: '', hint: 'Laissez vide pour utiliser la voix off du plan.' };
    case 'transitions': return {
      label: 'Transition', inputType: 'select', defaultValue: 'fade', hint: 'Valeurs : cut, fade, dissolve, slide.',
      options: [
        { value: 'fade', label: 'Fondu' },
        { value: 'dissolve', label: 'Dissolve' },
        { value: 'slide', label: 'Balayage' },
        { value: 'cut', label: 'Coupe franche' },
      ],
    };
    default: return null;
  }
}

function applyWithFallback(project: EditorProject, s: Suggestion, raw: string): EditorProject {
  if (s.applyCustom) return s.applyCustom(project, raw);
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
    return {
      ...base,
      scenes: base.scenes.map((scene) => scene.subtitle.length > max
        ? { ...scene, subtitle: `${scene.subtitle.slice(0, max - 1).trimEnd()}…` } : scene),
      updatedAt: new Date().toISOString(),
    };
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
    return {
      ...base,
      subtitlesEnabled: true,
      scenes: base.scenes.map((scene, i) => i === firstSpoken
        ? { ...scene, subtitle: (value || scene.spokenText).trim().slice(0, 110) } : scene),
      updatedAt: new Date().toISOString(),
    };
  }
  if (s.id === 'transitions') {
    if (!['cut', 'fade', 'dissolve', 'slide'].includes(value)) return base;
    return {
      ...base,
      scenes: base.scenes.map((scene, i, all) => i === Math.max(0, all.length - 2)
        ? { ...scene, transition: value as TransitionKind } : scene),
      updatedAt: new Date().toISOString(),
    };
  }
  return base;
}

export function AssistPanel({
  project,
  onChange,
  disabled,
  mediaItems = [],
  groqConfigured = null,
  onProposeAiPlan,
  onSelectScene,
}: {
  project: EditorProject;
  onChange: (p: EditorProject) => void;
  disabled?: boolean;
  mediaItems?: ProjectMediaItem[];
  groqConfigured?: boolean | null;
  onProposeAiPlan?: () => Promise<ProductionPlan | null>;
  onSelectScene?: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [aiProposal, setAiProposal] = useState<ProductionPlan | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  const presetId: UgcRhythmPresetId = project.ugcPreset ?? 'ugc-balanced';
  const preset = UGC_RHYTHM_PRESETS[presetId];
  const targetDuration = project.targetDuration ?? preset.targetDuration;

  const suggestions = useMemo(
    () => analyzeProject(project, targetDuration, { preset: presetId, targetDuration, mediaItems }),
    [project, targetDuration, presetId, mediaItems],
  );

  const decisions = project.suggestionDecisions ?? {};
  const visible = suggestions.filter((s) => !decisions[s.id]);
  const decisionValues = Object.values(decisions);
  const acceptedCount = decisionValues.filter((d) => d.status === 'accepted').length;
  const modifiedCount = decisionValues.filter((d) => d.status === 'modified').length;
  const rejectedCount = decisionValues.filter((d) => d.status === 'rejected').length;

  const recordDecision = (
    baseProject: EditorProject,
    id: string,
    status: 'accepted' | 'modified' | 'rejected',
    customValue?: string,
  ): EditorProject => ({
    ...baseProject,
    suggestionDecisions: {
      ...(baseProject.suggestionDecisions ?? {}),
      [id]: {
        status,
        ...(customValue !== undefined ? { customValue } : {}),
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  });

  const accept = (s: Suggestion, override?: string) => {
    const nextProject = override === undefined
      ? (s.apply ? s.apply(project) : project)
      : applyWithFallback(project, s, override);
    const status = override === undefined ? 'accepted' : 'modified';
    onChange(recordDecision(nextProject, s.id, status, override));
    setEditing(null);
    setValue('');
  };

  const reject = (s: Suggestion) => {
    onChange(recordDecision(project, s.id, 'rejected'));
    if (editing === s.id) {
      setEditing(null);
      setValue('');
    }
  };

  const resetDecisions = () => {
    onChange({
      ...project,
      suggestionDecisions: undefined,
      updatedAt: new Date().toISOString(),
    });
  };

  const requestGroqSuggestion = async () => {
    if (!onProposeAiPlan || groqConfigured !== true) return;
    setAiBusy(true);
    setAiError('');
    try {
      const proposed = await onProposeAiPlan();
      if (proposed) setAiProposal(proposed);
    } catch (err) {
      setAiError('Impossible de générer une proposition IA. Réessayez.');
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#080d14] p-4" aria-label="Assistant intelligent de montage">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-white">
            <Sparkles size={13} className="text-cyan-300" /> Assistant intelligent de montage
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
            <span className="rounded border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200">
              Local · déterministe
            </span>{' '}
            Analyse vos clips, coupes, rythme UGC et sous-titres sans appel IA simulé.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-lg border border-white/[0.08] px-2 py-1 text-[10px] text-slate-400">
            {visible.length} active(s)
          </span>
          {decisionValues.length > 0 && (
            <button
              type="button"
              disabled={disabled}
              onClick={resetDecisions}
              className="studio-chip text-[10px]"
              title="Réafficher toutes les suggestions"
            >
              <RotateCcw size={10} /> Rétablir ({decisionValues.length})
            </button>
          )}
        </div>
      </div>

      {/* UGC Rhythm Target Preset */}
      <div className="mt-3 grid gap-2 rounded-xl border border-white/[0.07] bg-black/25 p-2.5 sm:grid-cols-[minmax(0,1fr)_110px]">
        <label className="text-[10px] text-slate-400">Rythme UGC cible
          <select
            disabled={disabled}
            value={presetId}
            onChange={(e) => {
              const id = e.target.value as UgcRhythmPresetId;
              const nextPreset = UGC_RHYTHM_PRESETS[id];
              onChange({
                ...project,
                ugcPreset: id,
                targetDuration: nextPreset.targetDuration,
                updatedAt: new Date().toISOString(),
              });
            }}
            className="studio-select mt-1 w-full"
          >
            {(Object.keys(UGC_RHYTHM_PRESETS) as UgcRhythmPresetId[]).map((k) => (
              <option key={k} value={k}>{UGC_RHYTHM_PRESETS[k].label}</option>
            ))}
          </select>
        </label>
        <label className="text-[10px] text-slate-400">Cible (s)
          <input
            type="number"
            disabled={disabled}
            min={5}
            max={90}
            step={1}
            value={targetDuration}
            onChange={(e) => {
              const n = Math.min(90, Math.max(5, Number(e.target.value) || 20));
              onChange({ ...project, targetDuration: n, updatedAt: new Date().toISOString() });
            }}
            className="studio-number mt-1"
          />
        </label>
        <p className="text-[10px] text-slate-500 sm:col-span-2">{preset.description}</p>
      </div>

      {decisionValues.length > 0 && (
        <p className="mt-2 text-[10px] text-slate-400">
          Décisions mémorisées : <span className="text-emerald-300">{acceptedCount} acceptée(s)</span> ·{' '}
          <span className="text-cyan-300">{modifiedCount} modifiée(s)</span> ·{' '}
          <span className="text-slate-400">{rejectedCount} refusée(s)</span>
        </p>
      )}

      {disabled && <p className="mt-2 text-[10px] text-amber-300">Suggestions en lecture seule pendant le rendu.</p>}

      <div className="mt-3 max-h-[340px] space-y-2 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-3 text-[11px] text-emerald-200">
            Aucune suggestion en attente. Vérifiez la prévisualisation fluide avant d’exporter.
          </p>
        )}
        {visible.map((s) => {
          const spec = fallbackModifySpec(s);
          return (
            <div
              key={s.id}
              data-testid={`suggestion-${s.id}`}
              className={cn(
                'rounded-xl border p-3',
                s.severity === 'error' ? 'border-rose-400/25 bg-rose-400/[0.04]'
                  : s.severity === 'warning' ? 'border-amber-400/20 bg-amber-400/[0.04]'
                    : 'border-white/[0.07] bg-white/[0.02]',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-white">{s.title}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{s.detail}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="rounded border border-white/[0.08] px-1.5 py-0.5 text-[9px] uppercase text-slate-500">{s.kind}</span>
                  {s.targetSceneId && onSelectScene && (
                    <button
                      type="button"
                      onClick={() => onSelectScene(s.targetSceneId!)}
                      className="text-[9px] text-cyan-300 hover:underline"
                    >
                      Voir le plan
                    </button>
                  )}
                </div>
              </div>

              {editing === s.id && spec && (
                <div className="mt-2 space-y-1.5 rounded-lg border border-white/[0.08] bg-black/30 p-2.5">
                  <label className="block text-[10px] text-slate-300">{spec.label}
                    {spec.inputType === 'select' && spec.options ? (
                      <select
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="studio-select mt-1 w-full"
                        aria-label={spec.label}
                      >
                        {spec.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={spec.inputType === 'number' ? 'number' : 'text'}
                        min={spec.min}
                        max={spec.max}
                        step={spec.step}
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        className="studio-input mt-1"
                        aria-label={spec.label}
                      />
                    )}
                  </label>
                  <p className="text-[9px] text-slate-500">{spec.hint}</p>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => accept(s, value)}>Appliquer ma version</Button>
                    <Button size="sm" variant="ghost" onClick={() => { setEditing(null); setValue(''); }}>Annuler</Button>
                  </div>
                </div>
              )}

              {editing !== s.id && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.apply && (
                    <button type="button" disabled={disabled} onClick={() => accept(s)} className="studio-chip text-emerald-200">
                      <Check size={11} /> Accepter
                    </button>
                  )}
                  {spec && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => { setEditing(s.id); setValue(spec.defaultValue); }}
                      className="studio-chip"
                    >
                      <Pencil size={11} /> Modifier
                    </button>
                  )}
                  <button type="button" disabled={disabled} onClick={() => reject(s)} className="studio-chip text-slate-400">
                    <X size={11} /> Refuser
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Optional server-assisted production plan */}
      {onProposeAiPlan && (
        <div className="mt-3 rounded-xl border border-white/[0.08] bg-black/25 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
              <Bot size={13} className="text-cyan-300" /> Suggestion IA
            </span>
            <span className={cn(
              'rounded px-1.5 py-0.5 text-[9px] font-semibold',
              groqConfigured === true ? 'bg-cyan-400/15 text-cyan-200' : 'bg-amber-400/10 text-amber-200',
            )}>
              {groqConfigured === true ? 'Disponible' : 'Indisponible'}
            </span>
          </div>
          {groqConfigured !== true ? (
            <p className="mt-1.5 text-[10px] leading-relaxed text-amber-200/90">
              Les suggestions IA sont indisponibles pour le moment.
            </p>
          ) : (
            <div className="mt-2">
              <Button size="sm" variant="outline" loading={aiBusy} disabled={disabled} icon={<Wand2 size={12} />} onClick={() => void requestGroqSuggestion()}>
                Demander un découpage IA
              </Button>
              {aiError && <p className="mt-1.5 text-[10px] text-rose-300">{aiError}</p>}
              {aiProposal && (
                <div className="mt-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.05] p-2.5 text-[10px]">
                  <p className="font-semibold text-cyan-200">Proposition IA validée ({aiProposal.scenes.length} scènes)</p>
                  <p className="mt-1 text-slate-300">
                    {aiProposal.scenes.map((sc, i) => `${i + 1}. ${sc.label} (${sc.durationSeconds}s)`).join(' · ')}
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => { onChange(replanEditorScenes(project, aiProposal)); setAiProposal(null); }}
                      className="studio-chip text-emerald-200"
                    >
                      <Check size={11} /> Appliquer au montage
                    </button>
                    <button type="button" onClick={() => setAiProposal(null)} className="studio-chip text-slate-400">
                      <X size={11} /> Rejeter
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-slate-600">
        <Lightbulb size={11} className="mt-0.5 shrink-0" />
        Couverture locale : {COVERAGE}. Aucune donnée n’est envoyée à un fournisseur sans action explicite.
      </p>
    </section>
  );
}
