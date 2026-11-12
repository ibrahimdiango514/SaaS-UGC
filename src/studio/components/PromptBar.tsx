import { useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertCircle, AudioLines, ChevronDown, Coins, Database, Film, ImagePlus, Info, Play,
  RefreshCw, Settings2, Sparkles, Subtitles, X,
} from 'lucide-react';
import { Button, Select, Toggle, cn } from '../../components/ui';
import type { Avatar, MuApiModel, ServiceCatalogItem, VideoCostEstimate } from '../../lib/types';
import { MODE_LABELS, modelModes, normalizeParamValue, paramLabel } from '../model';
import { creditSummary } from '../catalog';
import {
  QUALITY_TIERS, compatibleParams, selectOptions, numericRange, clampToModelDuration,
  type QualityTier,
} from '../quality';
import { CREATION_MODES } from '../plan';

export type CreationModeId = 'idea' | 'script' | 'product' | 'avatar' | 'video-source' | 'audio-source';

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
  /** Source vidéo importée (modèles Video→Video / Lip Sync). */
  sourceVideoFile: File | null;
  /** Source audio importée (modèles Audio→Video / avatars parlants). */
  sourceAudioFile: File | null;
  language: string;
}

export function initialFormState(): GenerationFormState {
  return {
    prompt: '', quality: 'standard', mode: 'script', ratio: '9:16', duration: 15,
    resolution: null, extras: {}, subtitles: true, script: '', avatarId: '',
    referenceFile: null, lastReferenceFile: null,
    sourceVideoFile: null, sourceAudioFile: null, language: 'fr',
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
  healthBusy: boolean;
  healthError: string;
  onRetryHealth: () => void;
  catalogOpen: boolean;
  onOpenCatalog: () => void;
}

const RESERVED_KEYS = ['aspect_ratio', 'resolution', 'duration'];
const SHORT_MODES: Record<CreationModeId, string> = {
  idea: 'Une idée', script: 'Depuis un script', product: 'Image de produit', avatar: 'Avatar',
  'video-source': 'Vidéo existante', 'audio-source': 'Audio + image',
};

/**
 * Composer docké du Studio.
 *
 * Reproduit la zone de saisie de la référence : un seul bloc sombre qui contient
 * le champ de description et, sur la même ligne, des sélecteurs compacts puis le
 * bouton de génération. Tout le reste (sources, réglages avancés, assistance IA)
 * est replié derrière « Réglages » : rien n'encombre l'espace de création.
 */
export function PromptBar({
  state, onPatch, model, services, estimate, balance, blockedReason, busy,
  generateLabel, onGenerate, health, avatars, onAiPlan, aiBusy, aiMessage,
  healthBusy, healthError, onRetryHealth,
  catalogOpen, onOpenCatalog,
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const { pathname } = useLocation();
  const compactShell = pathname === '/app/studio';
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastFileRef = useRef<HTMLInputElement>(null);
  const videoFileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  const ratios = selectOptions(model, 'aspect_ratio');
  const resolutions = selectOptions(model, 'resolution');
  const durationRange = numericRange(model, 'duration');
  const durationOptions = selectOptions(model, 'duration');
  const extras = compatibleParams(model).filter(([key]) => !RESERVED_KEYS.includes(key));
  const modelAcceptsImage = Boolean(model?.input_fields.includes('image_url'));
  const modelAcceptsLastImage = Boolean(model?.input_fields.includes('last_image'));
  const modelAcceptsVideo = Boolean(model?.input_fields.some((f) => f === 'video_url' || f === 'input_video'));
  const modelAcceptsAudio = Boolean(model?.input_fields.includes('audio_url'));
  const requiresVideo = Boolean(model?.required_fields.some((f) => f === 'video_url' || f === 'input_video'));
  const requiresAudio = Boolean(model?.required_fields.includes('audio_url'));
  const summary = creditSummary(estimate, balance, Boolean(model?.dynamic_pricing));
  // Le devis ne peut pas être calculé sans instruction : ce n'est pas un calcul
  // bloqué, et l'afficher comme tel laissait croire à une panne du backend.
  const needsInstruction = !state.prompt.trim()
    && Boolean(model?.required_fields?.some((field) => field.toLowerCase() === 'prompt'));
  const cost = summary.creditsCost;
  const tier = QUALITY_TIERS.find((q) => q.id === state.quality);
  const service = services.find((s) => s.service_key === tier?.serviceKey);
  const canGenerate = !blockedReason && !busy && summary.canReserve;

  const focusPrompt = () => {
    promptRef.current?.focus();
    promptRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    <div
      id="studio-prompt-bar"
      data-testid="studio-prompt-bar"
      className={cn(
        'studio-v2 sticky z-40 -mx-3 border-t border-white/[0.06] bg-[#050505]/96 px-3 pb-2 pt-2 backdrop-blur-xl sm:-mx-6 sm:px-6 sm:pb-3 sm:pt-3',
        // `mt-auto` est porté par `.studio-composer-dock` : la marge utilitaire
        // `mt-3` la masquerait (les utilitaires sont émis après les composants).
        compactShell ? 'studio-composer-dock bottom-0' : 'mt-3 bottom-[54px] sm:mt-5 lg:bottom-0',
      )}
    >
      <div className="mx-auto max-w-[1400px]">
        <div className="studio-composer p-2.5 sm:p-3.5">
          <textarea
            id="studio-prompt"
            ref={promptRef}
            value={state.prompt}
            onChange={(e) => onPatch({ prompt: e.target.value.slice(0, 4000) })}
            rows={2}
            placeholder="Décrivez la vidéo que vous voulez créer"
            className="studio-composer-input min-h-[46px] px-1.5 sm:min-h-[54px]"
          />

          <div className="mt-1 flex flex-wrap items-center gap-1.5 border-t border-white/[0.06] pt-2">
            {/* Sources et paramètres : compacts, jamais au centre du canvas.
                Sur mobile ils occupent toute une ligne (défilement horizontal),
                le devis et le bouton restent accessibles juste en dessous. */}
            <div className="no-scrollbar flex min-w-0 basis-full items-center gap-1.5 overflow-x-auto pb-0.5 sm:basis-auto sm:flex-1 sm:pb-0">
              <select
                aria-label="Mode de création"
                value={state.mode}
                onChange={(e) => onPatch({ mode: e.target.value as CreationModeId })}
                className="studio-pill cursor-pointer appearance-none !pr-2"
              >
                {CREATION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>{SHORT_MODES[m.id]}</option>
                ))}
              </select>
              <select
                aria-label="Qualité"
                value={state.quality}
                onChange={(e) => onPatch({ quality: e.target.value as QualityTier })}
                className="studio-pill cursor-pointer appearance-none !pr-2"
              >
                {QUALITY_TIERS.map((q) => (
                  <option key={q.id} value={q.id}>{q.label}</option>
                ))}
              </select>
              <select
                aria-label="Ratio"
                value={state.ratio}
                disabled={ratios.length === 0}
                onChange={(e) => onPatch({ ratio: e.target.value })}
                className="studio-pill cursor-pointer appearance-none !pr-2 disabled:opacity-40"
              >
                {ratios.length
                  ? ratios.map((r) => <option key={r} value={r}>{r}</option>)
                  : <option>9:16</option>}
              </select>
              {durationOptions.length > 0 ? (
                <select
                  aria-label="Durée"
                  value={String(state.duration ?? durationOptions[0])}
                  onChange={(e) => onPatch({ duration: Number(e.target.value) })}
                  className="studio-pill cursor-pointer appearance-none !pr-2"
                >
                  {durationOptions.map((d) => <option key={d} value={d}>{d} s</option>)}
                </select>
              ) : durationRange ? (
                <label className="studio-pill !gap-1.5 !px-2.5">
                  <span className="text-slate-500">Durée</span>
                  <input
                    type="range"
                    min={durationRange.min}
                    max={durationRange.max}
                    step={1}
                    value={Number(state.duration ?? durationRange.min)}
                    onChange={(e) => onPatch({ duration: Number(e.target.value) })}
                    className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/15 accent-cyan-400"
                    aria-label="Durée en secondes"
                  />
                  <b className="min-w-[2rem] text-cyan-200">{clampToModelDuration(model, state.duration ?? 5) ?? '—'} s</b>
                </label>
              ) : (
                <span className="studio-pill" title="Durée fixée par le modèle">Durée modèle</span>
              )}
              {resolutions.length > 0 && (
                <select
                  aria-label="Résolution"
                  value={state.resolution ?? resolutions[0]}
                  onChange={(e) => onPatch({ resolution: e.target.value })}
                  className="studio-pill cursor-pointer appearance-none !pr-2"
                >
                  {resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              )}
              <button
                type="button"
                onClick={() => onPatch({ subtitles: !state.subtitles })}
                className={cn('studio-pill', state.subtitles && 'studio-pill-active')}
                title="Sous-titres modifiables dans l’éditeur vidéo réel, non incrustés par le modèle"
                aria-pressed={state.subtitles}
              >
                <Subtitles size={11} /> Sous-titres
              </button>
              <button
                type="button"
                onClick={onOpenCatalog}
                className={cn('studio-pill', catalogOpen && 'studio-pill-active')}
                title="Choisir un modèle dans le catalogue vérifié"
              >
                <Database size={11} /> Modèle
              </button>
              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className={cn('studio-pill', advanced && 'studio-pill-active')}
                aria-expanded={advanced}
              >
                <Settings2 size={11} /> Réglages <ChevronDown size={10} className={cn('transition', advanced && 'rotate-180')} />
              </button>
            </div>

            <div className="flex w-full shrink-0 items-center justify-between gap-2 sm:w-auto sm:justify-end">
              <span
                data-testid="studio-credit-summary"
                className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1.5 text-[11.5px] font-semibold text-cyan-200"
              >
                <Coins size={12} />
                <span>
                  {cost !== null
                    ? `${cost} crédits VYORA`
                    : needsInstruction
                      ? 'En attente d’instruction'
                      : 'Coût en cours…'}
                </span>
                {/* Le montant n'est jamais « confirmé » sans devis serveur : le dire ici,
                    au plus près du bouton, évite toute génération sur un prix supposé. */}
                {summary.quoteToConfirm && (
                  <span className="text-[10px] font-medium text-amber-300">· coût en crédits à confirmer</span>
                )}
              </span>
              <button
                type="button"
                onClick={onGenerate}
                disabled={!canGenerate}
                title={blockedReason ?? undefined}
                data-testid="generate-button"
                className={cn('studio-generate', canGenerate ? 'studio-generate-ready' : 'studio-generate-blocked')}
              >
                <Play size={14} />
                {busy ? 'Génération…' : generateLabel ?? 'Générer'}
              </button>
            </div>
          </div>
        </div>

        {/* Statut compact sous le composer — jamais au-dessus du canvas. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[10.5px] text-slate-500">
          {estimate && <span>Solde {balance} crédits</span>}
          {summary.quoteToConfirm && (
            <span data-testid="studio-quote-warning" className="font-medium text-amber-300">
              Coût en crédits à confirmer · génération bloquée
            </span>
          )}
          {blockedReason && (
            <span className="inline-flex items-center gap-1 text-amber-300" title={blockedReason}>
              <AlertCircle size={11} /> {blockedReason}
            </span>
          )}
        </div>

        {advanced && (
          <div className="animate-fadeUp mt-2 grid gap-3 rounded-2xl border border-white/[0.07] bg-[#0a0a0b] p-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-slate-500">Qualité & modèle</p>
              <p className="mt-1 text-sm font-semibold text-white">{tier?.label}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{tier?.description}</p>
              <p className="mt-2 text-[11px] text-cyan-200">
                Mode : {model ? MODE_LABELS[modelModes(model)[0]] ?? 'Vidéo' : 'Chargement du catalogue…'}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">{service ? 'Service actif' : 'Service indisponible'}</p>
            </div>

            {extras.length > 0 && (
              <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Réglages compatibles</p>
                <div className="space-y-2">
                  {extras.map(([key, def]) => {
                    const value = state.extras[key];
                    if (def.type === 'boolean') {
                      return (
                        <Toggle
                          key={key}
                          checked={value === true || value === 'true'}
                          onChange={(v) => onPatch({ extras: { ...state.extras, [key]: v } })}
                          label={def.label ?? paramLabel(key)}
                        />
                      );
                    }
                    if (def.type === 'number') {
                      return (
                        <label key={key} className="block text-[11px] text-slate-300">
                          {def.label ?? paramLabel(key)}
                          <input
                            type="number"
                            min={def.min ?? 1}
                            max={def.max ?? 300}
                            value={String(value ?? def.default ?? def.min ?? 1)}
                            onChange={(e) => onPatch({ extras: { ...state.extras, [key]: Number(e.target.value) } })}
                            className="studio-number mt-1"
                          />
                        </label>
                      );
                    }
                    if (def.type === 'string') {
                      return (
                        <label key={key} className="block text-[11px] text-slate-300">
                          {def.label ?? paramLabel(key)}
                          <input
                            value={String(value ?? '')}
                            onChange={(e) => onPatch({ extras: { ...state.extras, [key]: e.target.value } })}
                            className="studio-input mt-1"
                          />
                        </label>
                      );
                    }
                    return (
                      <Select
                        key={key}
                        label={def.label ?? paramLabel(key)}
                        value={value === undefined ? '' : String(value)}
                        onChange={(e) => onPatch({ extras: { ...state.extras, [key]: normalizeParamValue(model!, key, e.target.value) } })}
                      >
                        <option value="">Par défaut</option>
                        {(def.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
                      </Select>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="rounded-xl border border-white/[0.06] bg-black/30 p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">Sources & assistance</p>
              {state.mode === 'script' && (
                <textarea
                  value={state.script}
                  onChange={(e) => onPatch({ script: e.target.value.slice(0, 4000) })}
                  rows={3}
                  placeholder="Collez votre script (contexte voix off, non écrit à l’écran)…"
                  className="studio-input mb-2"
                />
              )}
              {state.mode === 'product' && !modelAcceptsImage && (
                <div className="mb-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => onPatch({ referenceFile: e.target.files?.[0] ?? null })}
                  />
                  <button type="button" onClick={() => fileRef.current?.click()} className="studio-pill w-full justify-center">
                    <ImagePlus size={11} /> {state.referenceFile ? state.referenceFile.name.slice(0, 28) : 'Importer une image produit'}
                  </button>
                  {state.referenceFile && (
                    <button type="button" onClick={() => onPatch({ referenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300">
                      <X size={10} /> Retirer
                    </button>
                  )}
                </div>
              )}
              {(modelAcceptsImage || modelAcceptsLastImage) && (
                <div className="mb-2 space-y-2 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.03] p-2.5">
                  <p className="text-[10px] font-medium text-cyan-200">Références déclarées par le modèle</p>
                  {modelAcceptsImage && (
                    <div>
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => onPatch({ referenceFile: e.target.files?.[0] ?? null })}
                      />
                      <button type="button" onClick={() => fileRef.current?.click()} className="studio-pill w-full justify-center">
                        <ImagePlus size={11} />
                        {state.referenceFile ? state.referenceFile.name.slice(0, 26) : `Image initiale${model?.required_fields.includes('image_url') ? ' *' : ''}`}
                      </button>
                      {state.referenceFile && (
                        <button type="button" onClick={() => onPatch({ referenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300">
                          <X size={10} /> Retirer
                        </button>
                      )}
                    </div>
                  )}
                  {modelAcceptsLastImage && (
                    <div>
                      <input
                        ref={lastFileRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        onChange={(e) => onPatch({ lastReferenceFile: e.target.files?.[0] ?? null })}
                      />
                      <button type="button" onClick={() => lastFileRef.current?.click()} className="studio-pill w-full justify-center">
                        <ImagePlus size={11} />
                        {state.lastReferenceFile ? state.lastReferenceFile.name.slice(0, 26) : 'Image finale (optionnelle)'}
                      </button>
                      {state.lastReferenceFile && (
                        <button type="button" onClick={() => onPatch({ lastReferenceFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300">
                          <X size={10} /> Retirer
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-[9px] leading-snug text-slate-600">
                    Fichiers réels dans le bucket privé <code>ugc-assets</code>, URL signées côté serveur au devis et à la génération.
                  </p>
                </div>
              )}
              {state.mode === 'avatar' && (
                <Select label="Avatar existant" value={state.avatarId} onChange={(e) => onPatch({ avatarId: e.target.value })}>
                  <option value="">Choisir un avatar…</option>
                  {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              )}
              {(modelAcceptsVideo || modelAcceptsAudio) && (
                <div className="mt-3 space-y-2">
                  {modelAcceptsVideo && (
                    <div>
                      <input
                        ref={videoFileRef}
                        type="file"
                        accept="video/mp4,video/quicktime,video/webm"
                        className="hidden"
                        onChange={(e) => onPatch({ sourceVideoFile: e.target.files?.[0] ?? null })}
                      />
                      <button type="button" onClick={() => videoFileRef.current?.click()} className="studio-pill w-full justify-center">
                        <Film size={11} />
                        {state.sourceVideoFile
                          ? state.sourceVideoFile.name.slice(0, 26)
                          : `Vidéo source${requiresVideo ? ' *' : ''}`}
                      </button>
                      {state.sourceVideoFile && (
                        <button type="button" onClick={() => onPatch({ sourceVideoFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300">
                          <X size={10} /> Retirer
                        </button>
                      )}
                    </div>
                  )}
                  {modelAcceptsAudio && (
                    <div>
                      <input
                        ref={audioFileRef}
                        type="file"
                        accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg"
                        className="hidden"
                        onChange={(e) => onPatch({ sourceAudioFile: e.target.files?.[0] ?? null })}
                      />
                      <button type="button" onClick={() => audioFileRef.current?.click()} className="studio-pill w-full justify-center">
                        <AudioLines size={11} />
                        {state.sourceAudioFile
                          ? state.sourceAudioFile.name.slice(0, 26)
                          : `Audio source${requiresAudio ? ' *' : ''}`}
                      </button>
                      {state.sourceAudioFile && (
                        <button type="button" onClick={() => onPatch({ sourceAudioFile: null })} className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-rose-300">
                          <X size={10} /> Retirer
                        </button>
                      )}
                    </div>
                  )}
                  <p className="text-[9px] leading-snug text-slate-600">
                    Vidéo et audio importés dans votre bucket privé, signés côté serveur. Aucun média de démonstration n’est utilisé.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-3 sm:col-span-2 lg:col-span-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-cyan-100">
                  <Sparkles size={12} /> Plan de production & assistance IA
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  loading={aiBusy}
                  disabled={health?.groq !== true}
                  onClick={() => void onAiPlan()}
                  icon={<Sparkles size={11} />}
                >
                  Proposer un plan avec l’IA
                </Button>
              </div>
              {health?.groq === false && (
                <p className="mt-2 text-[11px] leading-relaxed text-amber-200">
                  <Info size={10} className="mr-1 inline" /> Assistance IA indisponible pour le moment.
                  Aucune réponse IA n’est simulée. Le plan local déterministe reste disponible et construit vos scènes à partir de votre seule instruction.
                </p>
              )}
              {health?.groq !== true && health?.groq !== false && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-200" role={healthError ? 'alert' : 'status'}>
                  <span>{healthBusy ? 'Vérification de la disponibilité de l’aide IA…' : 'Aide IA indisponible. Réessayez plus tard.'}</span>
                  {!healthBusy && (
                    <Button size="sm" variant="ghost" icon={<RefreshCw size={11} />} onClick={onRetryHealth}>
                      Réessayer
                    </Button>
                  )}
                </div>
              )}
              {aiMessage && <p className="mt-2 text-[11px] text-slate-300">{aiMessage}</p>}
            </div>
          </div>
        )}

        <button type="button" onClick={focusPrompt} className="sr-only">Aller au prompt</button>
      </div>
    </div>
  );
}
