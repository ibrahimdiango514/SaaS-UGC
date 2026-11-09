import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertCircle, ChevronDown, ChevronUp, Coins, Database, ImagePlus, Info, Languages,
  Lock, Mic2, Play, Settings2, Sparkles, Subtitles, Users, X,
} from 'lucide-react';
import { Button, Select, Toggle, cn } from '../../components/ui';
import type { Avatar, MuApiModel, ServiceCatalogItem, VideoCostEstimate } from '../../lib/types';
import { modelFamily, normalizeParamValue, paramLabel, providerQuoteCostLabel, providerQuoteOriginLabel } from '../model';
import { USD_CREDIT_NOTE, creditSummary } from '../catalog';
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
  extras: Record<string, string | number | boolean>;
  subtitles: boolean;
  script: string;
  avatarId: string;
  referenceFile: File | null;
  lastReferenceFile: File | null;
  language: string;
}

export function initialFormState(): GenerationFormState {
  return {
    prompt: '', quality: 'standard', mode: 'script', ratio: '9:16', duration: 15,
    resolution: null, extras: {}, subtitles: true, script: '', avatarId: '',
    referenceFile: null, lastReferenceFile: null, language: 'fr',
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
  catalogOpen: boolean;
  onOpenCatalog: () => void;
  catalogSummary: string;
}

const RESERVED_KEYS = ['aspect_ratio', 'resolution', 'duration'];
const SHORT_MODES: Record<CreationModeId, string> = {
  idea: 'Une idée', script: 'Depuis un script', product: 'Image de produit', avatar: 'Avatar',
};

export function PromptBar({
  state, onPatch, model, services, estimate, balance, blockedReason, busy,
  generateLabel, onGenerate, health, avatars, onAiPlan, aiBusy, aiMessage,
  catalogOpen, onOpenCatalog, catalogSummary,
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const { pathname } = useLocation();
  const compactShell = pathname === '/app/studio';
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<HTMLInputElement>(null);

  const ratios = selectOptions(model, 'aspect_ratio');
  const resolutions = selectOptions(model, 'resolution');
  const durationRange = numericRange(model, 'duration');
  const durationOptions = selectOptions(model, 'duration');
  const extras = compatibleParams(model).filter(([key]) => !RESERVED_KEYS.includes(key));
  const modelAcceptsImage = Boolean(model?.input_fields.includes('image_url'));
  const modelAcceptsLastImage = Boolean(model?.input_fields.includes('last_image'));
  const summary = creditSummary(estimate, balance, Boolean(model?.dynamic_pricing));
  const cost = summary.creditsCost;
  const tier = QUALITY_TIERS.find((q) => q.id === state.quality);
  const service = services.find((s) => s.service_key === tier?.serviceKey);
  const canGenerate = !blockedReason && !busy && summary.canReserve;

  const focusPrompt = () => { promptRef.current?.focus(); promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); };

  return (
    <div id="studio-prompt-bar" data-testid="studio-prompt-bar" className={cn('studio-v2 sticky z-40 -mx-3 mt-4 border-t border-cyan-400/15 bg-[#04070b]/97 px-3 pb-2 pt-2 backdrop-blur-xl sm:-mx-5 sm:mt-6 sm:px-5 sm:pb-3 sm:pt-3', compactShell ? 'bottom-0' : 'bottom-[54px] lg:bottom-0')}>
      <div className="mx-auto max-w-[1400px]">
        <div className="rounded-[20px] border border-white/[0.10] bg-[#0b111a] p-2.5 focus-within:border-cyan-400/40 sm:rounded-[22px] sm:p-4">
          <textarea id="studio-prompt" ref={promptRef} value={state.prompt}
            onChange={(e) => onPatch({ prompt: e.target.value.slice(0, 4000) })}
            rows={1} placeholder="Une jeune femme présente son sérum visage face caméra, ton naturel, appel à l'achat à la fin."
            className="min-h-[46px] w-full resize-none bg-transparent px-1 text-[14px] leading-relaxed text-white outline-none placeholder:text-slate-500 sm:min-h-[58px] sm:text-[15px]" />
          <div className="mt-0.5 hidden justify-end text-[10px] text-slate-600 sm:flex">{state.prompt.length}/4000</div>

          <div className="no-scrollbar mt-1 flex items-center gap-1.5 overflow-x-auto pb-0.5 sm:mt-2 sm:pb-1">
            <select aria-label="Mode de création" value={state.mode}
              onChange={(e) => onPatch({ mode: e.target.value as CreationModeId })}
              className="studio-chip shrink-0 cursor-pointer appearance-none pr-2">
              {CREATION_MODES.map((m) => <option key={m.id} value={m.id}>{SHORT_MODES[m.id]}</option>)}
            </select>
            <button type="button" onClick={() => onPatch({ mode: 'avatar' })}
              className={cn('studio-chip shrink-0', state.mode === 'avatar' && 'border-cyan-400/40 text-cyan-200')}
              aria-pressed={state.mode === 'avatar'}>
              <Users size={11} /> Avatar
            </button>
            <span className="studio-chip shrink-0 cursor-not-allowed opacity-50" title="Aucun moteur de synthèse vocale / TTS connecté">
              <Lock size={10} /> Voix FR · à venir
            </span>
            <select aria-label="Qualité" value={state.quality}
              onChange={(e) => onPatch({ quality: e.target.value as QualityTier })}
              className="studio-chip shrink-0 cursor-pointer appearance-none pr-2">
              {QUALITY_TIERS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
            </select>
            <select aria-label="Ratio" value={state.ratio} disabled={ratios.length === 0}
              onChange={(e) => onPatch({ ratio: e.target.value })}
              className="studio-chip shrink-0 cursor-pointer appearance-none pr-2 disabled:opacity-40">
              {ratios.length ? ratios.map((r) => <option key={r} value={r}>{r}</option>) : <option>9:16</option>}
            </select>
            {durationOptions.length > 0 ? (
              <select aria-label="Durée" value={String(state.duration ?? durationOptions[0])}
                onChange={(e) => onPatch({ duration: Number(e.target.value) })} className="studio-chip shrink-0 cursor-pointer appearance-none pr-2">
                {durationOptions.map((d) => <option key={d} value={d}>{d} s</option>)}
              </select>
            ) : durationRange ? (
              <label className="studio-range shrink-0 !rounded-full !px-2.5 !py-1.5 text-[11px]">
                <span>Durée</span>
                <input type="range" min={durationRange.min} max={durationRange.max} step={1}
                  value={Number(state.duration ?? durationRange.min)}
                  onChange={(e) => onPatch({ duration: Number(e.target.value) })} />
                <b>{clampToModelDuration(model, state.duration ?? 5) ?? '—'} s</b>
              </label>
            ) : (
              <span className="studio-chip shrink-0" title="Durée fixée par le modèle">Durée modèle</span>
            )}
            {resolutions.length > 0 && (
              <select aria-label="Résolution" value={state.resolution ?? resolutions[0]}
                onChange={(e) => onPatch({ resolution: e.target.value })} className="studio-chip shrink-0 cursor-pointer appearance-none pr-2">
                {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
            <button type="button" onClick={() => onPatch({ subtitles: !state.subtitles })}
              className={cn('studio-chip shrink-0', state.subtitles && 'border-cyan-400/40 text-cyan-200')}
              title="Sous-titres modifiables dans l’AI Video Editor réel, pas brûlés par le modèle"
              aria-pressed={state.subtitles}>
              <Subtitles size={11} /> Sous-titres
            </button>
            <button type="button" onClick={onOpenCatalog}
              className={cn('studio-chip shrink-0', catalogOpen && 'border-cyan-400/45 bg-cyan-400/10 text-cyan-100')}>
              <Database size={11} /> Catalogue MuAPI
            </button>
            <button type="button" onClick={() => setAdvanced((v) => !v)}
              className={cn('studio-chip shrink-0', advanced && 'border-cyan-400/40 text-cyan-200')}>
              <Settings2 size={11} /> Réglages {advanced ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
            </button>
          </div>
        </div>

        {advanced && (
          <div className="animate-fadeUp mt-2 grid gap-3 rounded-2xl border border-white/[0.07] bg-[#080d14] p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Qualité & modèle</p>
              <p className="mt-1 text-sm font-semibold text-white">{tier?.label}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{tier?.description}</p>
              <p className="mt-2 text-[11px] text-cyan-200">Modèle : {model ? modelFamily(model) : 'catalogue en cours…'}</p>
              <p className="mt-1 text-[10px] text-slate-500">{service ? `Service : ${service.display_name}` : 'Service indisponible'}</p>
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
                    if (def.type === 'string') return (
                      <label key={key} className="block text-[11px] text-slate-300">{def.label ?? paramLabel(key)}
                        <input value={String(value ?? '')} onChange={(e) => onPatch({ extras: { ...state.extras, [key]: e.target.value } })}
                          className="studio-input mt-1" />
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
              <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Sources & assistance</p>
              {state.mode === 'script' && (
                <textarea value={state.script} onChange={(e) => onPatch({ script: e.target.value.slice(0, 4000) })}
                  rows={3} placeholder="Collez votre script (contexte voix off, non écrit à l’écran)…" className="studio-input mb-2" />
              )}
              {state.mode === 'product' && !modelAcceptsImage && (
                <div className="mb-2">
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                    onChange={(e) => onPatch({ referenceFile: e.target.files?.[0] ?? null })} />
                  <button type="button" onClick={() => fileRef.current?.click()} className="studio-chip w-full justify-center">
                    <ImagePlus size={11} /> {state.referenceFile ? state.referenceFile.name.slice(0, 28) : 'Importer une image produit'}
                  </button>
                  {state.referenceFile && <button type="button" onClick={() => onPatch({ referenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300"><X size={10} /> Retirer</button>}
                </div>
              )}
              {(modelAcceptsImage || modelAcceptsLastImage) && (
                <div className="mb-2 space-y-2 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.03] p-2.5">
                  <p className="text-[10px] font-medium text-cyan-200">Références déclarées par le modèle</p>
                  {modelAcceptsImage && (
                    <div>
                      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                        onChange={(e) => onPatch({ referenceFile: e.target.files?.[0] ?? null })} />
                      <button type="button" onClick={() => fileRef.current?.click()} className="studio-chip w-full justify-center">
                        <ImagePlus size={11} /> {state.referenceFile ? state.referenceFile.name.slice(0, 26) : `Image initiale${model?.required_fields.includes('image_url') ? ' *' : ''}`}
                      </button>
                      {state.referenceFile && <button type="button" onClick={() => onPatch({ referenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300"><X size={10} /> Retirer</button>}
                    </div>
                  )}
                  {modelAcceptsLastImage && (
                    <div>
                      <input ref={lastFileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                        onChange={(e) => onPatch({ lastReferenceFile: e.target.files?.[0] ?? null })} />
                      <button type="button" onClick={() => lastFileRef.current?.click()} className="studio-chip w-full justify-center">
                        <ImagePlus size={11} /> {state.lastReferenceFile ? state.lastReferenceFile.name.slice(0, 26) : 'Image finale (optionnelle)'}
                      </button>
                      {state.lastReferenceFile && <button type="button" onClick={() => onPatch({ lastReferenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300"><X size={10} /> Retirer</button>}
                    </div>
                  )}
                  <p className="text-[9px] leading-snug text-slate-600">Fichiers réels dans le bucket privé <code>ugc-assets</code>, URL signées côté serveur au devis et à la génération.</p>
                </div>
              )}
              {state.mode === 'avatar' && (
                <Select label="Avatar existant" value={state.avatarId} onChange={(e) => onPatch({ avatarId: e.target.value })}>
                  <option value="">Choisir un avatar…</option>
                  {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
              <div className="mt-2 space-y-1.5">
                <span className="studio-chip w-full opacity-50" title="Aucun moteur de synthèse vocale connecté"><Lock size={10} /> Voix · à venir</span>
                <span className="studio-chip w-full opacity-50" title="Aucune génération audio / TTS connectée"><Languages size={10} /> Langue audio · à venir</span>
                <span className="studio-chip w-full opacity-50" title="Aucun moteur de synchronisation labiale connecté"><Mic2 size={10} /> Lip Sync · à venir</span>
              </div>
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3 sm:col-span-2 lg:col-span-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100"><Sparkles size={12} /> Plan de production & assistance IA</p>
                <Button size="sm" variant="outline" loading={aiBusy} disabled={health?.groq !== true}
                  onClick={() => void onAiPlan()} icon={<Sparkles size={11} />}>Proposer un plan avec Groq</Button>
              </div>
              {health?.groq === false && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
                  <Info size={10} className="mr-1 inline" /> Assistance IA indisponible : <code>GROQ_API_KEY</code> absent côté serveur.
                  Aucune réponse IA n’est simulée. Le plan local déterministe reste disponible et construit vos scènes à partir de votre seule instruction.
                </p>
              )}
              {aiMessage && <p className="mt-2 text-[11px] text-slate-300">{aiMessage}</p>}
            </div>
          </div>
        )}

        <div className="mt-1.5 flex flex-col gap-1 sm:mt-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
          <div className="flex max-h-[38px] flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden text-[10px] sm:max-h-none sm:flex-nowrap sm:overflow-visible sm:text-[11px]" data-testid="studio-credit-summary">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1.5 font-semibold text-cyan-200">
              <Coins size={12} /> {cost !== null ? `${cost} crédits UGC` : 'Devis en cours…'}
            </span>
            {estimate && (
              <span data-testid="studio-provider-quote" className={summary.quoteToConfirm ? 'font-semibold text-amber-200' : 'text-slate-500'} title={`${providerQuoteOriginLabel(estimate)} · ${USD_CREDIT_NOTE}`}>
                Fournisseur {providerQuoteCostLabel(estimate)}<span className="hidden sm:inline"> · Solde {balance} crédits</span>
              </span>
            )}
            {summary.quoteToConfirm && <span className="hidden text-amber-200 lg:inline">Génération bloquée : devis à confirmer</span>}
            {catalogSummary && <span className="hidden max-w-full truncate text-slate-600 sm:inline" title={catalogSummary}>{catalogSummary}</span>}
            {blockedReason && <span className="hidden max-w-full items-center gap-1 text-amber-300 sm:inline-flex" title={blockedReason}><AlertCircle size={11} /> {blockedReason}</span>}
          </div>
          <button type="button" onClick={onGenerate} disabled={!canGenerate} title={blockedReason ?? undefined}
            data-testid="generate-button"
            className={cn(
              'inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl px-6 text-sm font-bold transition sm:w-auto',
              canGenerate ? 'bg-cyan-400 text-[#04121a] hover:bg-cyan-300 active:scale-[0.98]'
                : 'cursor-not-allowed bg-cyan-400/25 text-cyan-100/50',
            )}>
            <Play size={15} /> {busy ? 'Génération…' : generateLabel ?? (cost !== null ? `Générer · ${cost} crédits` : 'Générer · devis…')}
          </button>
        </div>
        {summary.quoteToConfirm && (
          <p data-testid="studio-quote-warning" className="mt-1.5 text-[10px] leading-relaxed text-amber-200 lg:hidden">
            Devis fournisseur à confirmer · aucun montant de remplacement · génération bloquée.
          </p>
        )}
        <p className="mt-1 hidden text-[9px] leading-relaxed text-slate-600 sm:block">{USD_CREDIT_NOTE}</p>
        <button type="button" onClick={focusPrompt} className="sr-only">Aller au prompt</button>
      </div>
    </div>
  );
}
