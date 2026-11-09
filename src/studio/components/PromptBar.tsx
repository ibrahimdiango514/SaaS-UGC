import { useRef, useState } from 'react';
import {
  ChevronDown, ChevronUp, Coins, ImagePlus, Info, Languages, Lock, Mic2,
  Play, Settings2, Sparkles, Subtitles, X,
} from 'lucide-react';
import { Button, Select, Toggle, cn } from '../../components/ui';
import type { Avatar, MuApiModel, ServiceCatalogItem, VideoCostEstimate } from '../../lib/types';
import type { ParamValue } from '../model';
import { modelFamily, normalizeParamValue, paramLabel } from '../model';
import {
  QUALITY_TIERS, compatibleParams, selectOptions, numericRange, clampToModelDuration,
  type QualityTier,
} from '../quality';
import { CREATION_MODES } from '../plan';

export type CreationModeId = 'idea' | 'script' | 'product' | 'avatar';

export interface GenerationFormState {
  prompt: string;
  quality: QualityTier;
  mode: CreationModeId;
  ratio: string;
  duration: number | null;
  resolution: string | null;
  extras: Record<string, ParamValue>;
  subtitles: boolean;
  script: string;
  avatarId: string;
  referenceFile: File | null;
  language: string;
}

export function initialFormState(): GenerationFormState {
  return {
    prompt: '', quality: 'standard', mode: 'idea', ratio: '9:16', duration: 5,
    resolution: null, extras: {}, subtitles: true, script: '', avatarId: '',
    referenceFile: null, language: 'fr',
  };
}

interface Props {
  state: GenerationFormState;
  onPatch: (patch: Partial<GenerationFormState>) => void;
  model: MuApiModel | null;
  services: ServiceCatalogItem[];
  estimate: VideoCostEstimate | null;
  balance: number;
  blockedReason: string;
  busy: boolean;
  generateLabel?: string;
  onGenerate: () => void;
  health: Record<string, boolean> | null;
  avatars: Avatar[];
  onAiPlan: () => void;
  aiBusy: boolean;
  aiMessage: string;
}

const RESERVED_KEYS = ['aspect_ratio', 'resolution', 'duration'];

export function PromptBar({
  state, onPatch, model, services, estimate, balance, blockedReason, busy,
  generateLabel, onGenerate, health, avatars, onAiPlan, aiBusy, aiMessage,
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const ratios = selectOptions(model, 'aspect_ratio');
  const resolutions = selectOptions(model, 'resolution');
  const durationRange = numericRange(model, 'duration');
  const durationOptions = selectOptions(model, 'duration');
  const extras = compatibleParams(model).filter(([key]) => !RESERVED_KEYS.includes(key));
  const cost = estimate?.credits_cost ?? null;
  const tier = QUALITY_TIERS.find((q) => q.id === state.quality);
  const service = services.find((s) => s.service_key === tier?.serviceKey);
  const canGenerate = !blockedReason && !busy && cost !== null && cost > 0 && balance >= cost;

  const focusPrompt = () => { promptRef.current?.focus(); promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  return (
    <div className="studio-v2 sticky bottom-0 z-30 -mx-3 mt-6 border-t border-cyan-400/15 bg-[#060a10]/97 px-3 pb-3 pt-3 backdrop-blur-xl sm:-mx-5 sm:px-5 lg:bottom-0">
      <div className="mx-auto max-w-[1400px]">
        <div className="flex items-start gap-2 rounded-2xl border border-white/[0.09] bg-[#0b111a] p-2.5 focus-within:border-cyan-400/40">
          <textarea id="studio-prompt" ref={promptRef} value={state.prompt}
            onChange={(e) => onPatch({ prompt: e.target.value.slice(0, 4000) })}
            rows={2} placeholder="Décrivez votre vidéo UGC en une phrase : produit, accroche, démonstration, appel à l’achat…"
            className="min-h-[54px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm leading-relaxed text-white outline-none placeholder:text-slate-600" />
          <span className="hidden shrink-0 pt-2 text-[10px] text-slate-600 sm:block">{state.prompt.length}/4000</span>
        </div>

        {/* Quick controls: horizontally scrollable on mobile */}
        <div className="no-scrollbar mt-2.5 flex items-center gap-2 overflow-x-auto pb-1">
          <select aria-label="Mode de création" value={state.mode}
            onChange={(e) => onPatch({ mode: e.target.value as CreationModeId })}
            className="studio-select shrink-0">
            {CREATION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <select aria-label="Qualité" value={state.quality}
            onChange={(e) => onPatch({ quality: e.target.value as QualityTier })}
            className="studio-select shrink-0">
            {QUALITY_TIERS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
          </select>
          <select aria-label="Ratio" value={state.ratio} disabled={ratios.length === 0}
            onChange={(e) => onPatch({ ratio: e.target.value })}
            className="studio-select shrink-0 disabled:opacity-40">
            {ratios.length ? ratios.map((r) => <option key={r} value={r}>{r}</option>) : <option>Ratio fixe</option>}
          </select>
          {durationOptions.length > 0 ? (
            <select aria-label="Durée" value={String(state.duration ?? durationOptions[0])}
              onChange={(e) => onPatch({ duration: Number(e.target.value) })} className="studio-select shrink-0">
              {durationOptions.map((d) => <option key={d} value={d}>{d} s</option>)}
            </select>
          ) : durationRange ? (
            <label className="studio-range shrink-0">
              <span>Durée</span>
              <input type="range" min={durationRange.min} max={durationRange.max} step={1}
                value={Number(state.duration ?? durationRange.min)}
                onChange={(e) => onPatch({ duration: Number(e.target.value) })} />
              <b>{clampToModelDuration(model, state.duration ?? 5) ?? '—'} s</b>
            </label>
          ) : (
            <span className="studio-chip shrink-0" title="Ce modèle ne permet pas de régler la durée">Durée : modèle</span>
          )}
          {resolutions.length > 0 && (
            <select aria-label="Résolution" value={state.resolution ?? resolutions[0]}
              onChange={(e) => onPatch({ resolution: e.target.value })} className="studio-select shrink-0">
              {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          <button type="button" onClick={() => setAdvanced((v) => !v)}
            className={cn('studio-chip shrink-0', advanced && 'border-cyan-400/40 text-cyan-200')}>
            <Settings2 size={12} /> Réglages {advanced ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
          <button type="button" onClick={() => onPatch({ subtitles: !state.subtitles })}
            className={cn('studio-chip shrink-0', state.subtitles && 'border-cyan-400/40 text-cyan-200')}
            aria-pressed={state.subtitles}>
            <Subtitles size={12} /> Sous-titres {state.subtitles ? 'on' : 'off'}
          </button>
        </div>

        {advanced && (
          <div className="animate-fadeUp mt-2 grid gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Qualité sélectionnée</p>
              <p className="mt-1 text-sm font-semibold text-white">{tier?.label}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{tier?.description}</p>
              <p className="mt-2 text-[11px] text-cyan-200">Modèle : {model ? modelFamily(model) : 'catalogue en cours…'}</p>
              <p className="mt-1 text-[10px] text-slate-500">{service ? `Service : ${service.display_name}` : 'Service indisponible'}</p>
              <p className="mt-1 text-[10px] text-slate-500">Le choix technique est dérivé du catalogue MuAPI vérifié, sans identifiant exposé.</p>
            </div>

            {extras.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Réglages compatibles</p>
                <div className="space-y-2">
                  {extras.map(([key, def]) => {
                    const value = state.extras[key];
                    if (def.type === 'boolean') return (
                      <Toggle key={key} checked={value === true || value === 'true'}
                        onChange={(v) => onPatch({ extras: { ...state.extras, [key]: v } })}
                        label={def.label ?? paramLabel(key)} />
                    );
                    if (def.type === 'number') return (
                      <label key={key} className="block text-[11px] text-slate-300">{def.label ?? paramLabel(key)}
                        <input type="number" min={def.min ?? 1} max={def.max ?? 300} value={String(value ?? def.default ?? def.min ?? 1)}
                          onChange={(e) => onPatch({ extras: { ...state.extras, [key]: Number(e.target.value) } })}
                          className="studio-number mt-1" />
                      </label>
                    );
                    return (
                      <Select key={key} label={def.label ?? paramLabel(key)} value={value === undefined ? '' : String(value)}
                        onChange={(e) => onPatch({ extras: { ...state.extras, [key]: normalizeParamValue(model!, key, e.target.value) } })}>
                        <option value="">Par défaut</option>
                        {(def.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                      </Select>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Sources &amp; assistance</p>
              {state.mode === 'script' && (
                <textarea value={state.script} onChange={(e) => onPatch({ script: e.target.value.slice(0, 4000) })}
                  rows={3} placeholder="Collez votre script (contexte voix off, non écrit à l’écran)…" className="studio-input mb-2" />
              )}
              {state.mode === 'product' && (
                <div className="mb-2">
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => onPatch({ referenceFile: e.target.files?.[0] ?? null })} />
                  <button type="button" onClick={() => fileRef.current?.click()} className="studio-chip w-full justify-center">
                    <ImagePlus size={12} /> {state.referenceFile ? state.referenceFile.name.slice(0, 28) : 'Importer une image produit'}
                  </button>
                  {state.referenceFile && <button type="button" onClick={() => onPatch({ referenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300"><X size={10} /> Retirer</button>}
                </div>
              )}
              {state.mode === 'avatar' && (
                <Select label="Avatar existant" value={state.avatarId} onChange={(e) => onPatch({ avatarId: e.target.value })}>
                  <option value="">Choisir un avatar…</option>
                  {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
              <div className="mt-2 space-y-1.5">
                <span className="studio-chip w-full opacity-50" title="Aucun moteur de synthèse vocale connecté"><Lock size={11} /> Voix · à venir</span>
                <span className="studio-chip w-full opacity-50" title="Aucune génération audio / TTS connectée"><Languages size={11} /> Langue audio · à venir</span>
                <span className="studio-chip w-full opacity-50" title="Aucun moteur de synchronisation labiale connecté"><Mic2 size={11} /> Lip Sync · à venir</span>
              </div>
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3 sm:col-span-2 lg:col-span-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100"><Sparkles size={13} /> Plan de production &amp; assistance IA</p>
                <Button size="sm" variant="outline" loading={aiBusy} disabled={health?.groq !== true}
                  onClick={() => void onAiPlan()} icon={<Sparkles size={12} />}>Proposer un plan avec Groq</Button>
              </div>
              {health?.groq === false && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
                  <Info size={11} className="mr-1 inline" /> Assistance IA indisponible : <code>GROQ_API_KEY</code> absent côté serveur.
                  Aucune réponse IA n’est simulée. Le plan local déterministe reste disponible et construit vos scènes à partir de votre seule instruction.
                </p>
              )}
              {aiMessage && <p className="mt-2 text-[11px] text-slate-300">{aiMessage}</p>}
            </div>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1.5 font-semibold text-cyan-200">
              <Coins size={12} /> {cost !== null ? `${cost} crédits UGC` : 'Devis en cours…'}
            </span>
            {estimate && (
              <span className="text-slate-500">
                Fournisseur {Number(estimate.provider_cost_usd ?? 0).toFixed(3)} {estimate.provider_cost_currency} · Solde {balance} crédits
              </span>
            )}
            {blockedReason && <span className="max-w-full truncate text-amber-300" title={blockedReason}>{blockedReason}</span>}
          </div>
          <button type="button" onClick={onGenerate} disabled={!canGenerate}
            className={cn(
              'inline-flex min-h-[44px] items-center gap-2 rounded-xl px-5 text-sm font-bold transition',
              canGenerate ? 'bg-cyan-400 text-[#04121a] hover:bg-cyan-300 active:scale-[0.98]'
                : 'cursor-not-allowed bg-cyan-400/25 text-cyan-100/50',
            )}>
            <Play size={15} /> {busy ? 'Génération…' : generateLabel ?? (cost !== null ? `Générer · ${cost} crédits` : 'Générer · devis…')}
          </button>
        </div>
        <button type="button" onClick={focusPrompt} className="sr-only">Aller au prompt</button>
      </div>
    </div>
  );
}
