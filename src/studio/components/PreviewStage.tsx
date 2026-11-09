import type { ReactNode } from 'react';
import { Clapperboard, ImagePlus, LoaderCircle, Play, Sparkles } from 'lucide-react';
import { cn } from '../../components/ui';
import { TRACK_STEPS, stepStatus, type TrackingState } from '../tracking';

export function PreviewStage({ state, referenceUrl, videoUrl, children, onClearReference }: {
  state: 'empty' | 'reference' | 'generating' | 'result';
  referenceUrl?: string | null;
  videoUrl?: string | null;
  children?: ReactNode;
  onClearReference?: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#070911] shadow-[0_24px_80px_-40px_rgba(114,85,245,0.45)]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(ellipse_at_50%_-10%,rgba(114,85,245,0.22),transparent_60%),radial-gradient(ellipse_at_90%_100%,rgba(34,211,238,0.09),transparent_55%)]" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:linear-gradient(rgba(255,255,255,0.5)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.5)_1px,transparent_1px)] [background-size:48px_48px]" />

      <div className="relative flex min-h-[290px] items-center justify-center p-4 sm:min-h-[400px] sm:p-6 lg:min-h-[470px]">
        {state === 'empty' && (
          <div className="animate-fadeUp text-center">
            <div className="relative mx-auto mb-6 grid h-20 w-20 place-items-center rounded-2xl border border-brand-400/20 bg-brand-500/10 text-brand-200">
              <div className="absolute inset-0 animate-pulse rounded-2xl bg-brand-500/10 blur-xl" />
              <Clapperboard size={32} strokeWidth={1.4} className="relative" />
            </div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-brand-200/80">Reelora Video Studio</p>
            <h2 className="mt-3 max-w-md text-balance text-xl font-semibold leading-snug text-white sm:text-2xl">
              Votre prochaine scène commence ici
            </h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
              Décrivez un plan, choisissez un modèle MuAPI vérifié, puis lancez une génération réelle. L’aperçu s’affichera dans cet espace.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-[11px] text-slate-500">
              <span className="rounded-full border border-white/[0.08] px-2.5 py-1">Texte → Vidéo</span>
              <span className="rounded-full border border-white/[0.08] px-2.5 py-1">Image → Vidéo</span>
              <span className="rounded-full border border-white/[0.08] px-2.5 py-1">Stockage privé</span>
            </div>
          </div>
        )}

        {state === 'reference' && referenceUrl && (
          <div className="animate-fadeUp w-full max-w-md">
            <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/40">
              <img src={referenceUrl} alt="Image de référence importée" className="max-h-[340px] w-full object-contain" />
              <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[10px] font-medium text-white backdrop-blur-sm"><ImagePlus size={11} /> Référence importée</span>
            </div>
            {onClearReference && (
              <button onClick={onClearReference} className="mt-3 w-full rounded-lg border border-white/10 py-2 text-xs text-slate-400 transition-colors hover:border-white/20 hover:text-white">Retirer l’image</button>
            )}
          </div>
        )}

        {state === 'generating' && (
          <div className="animate-fadeUp w-full max-w-lg text-center">
            <div className="mx-auto mb-6 grid h-20 w-20 place-items-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
              <LoaderCircle size={34} className="animate-spin" strokeWidth={1.5} />
            </div>
            <h2 className="text-xl font-semibold text-white">Génération en cours</h2>
            <p className="mt-2 text-sm text-slate-400">Le suivi se poursuit côté serveur, même si vous fermez cette page.</p>
            {children}
          </div>
        )}

        {state === 'result' && videoUrl && (
          <div className="animate-fadeUp w-full">
            <video key={videoUrl} src={videoUrl} controls playsInline preload="metadata" className="max-h-[520px] w-full rounded-xl border border-white/10 bg-black" />
            <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-slate-500"><Play size={11} /> Lecture dans Reelora · fichier conservé dans Supabase Storage privé</p>
          </div>
        )}
      </div>

      <div className="relative flex items-center justify-between gap-3 border-t border-white/[0.06] bg-black/20 px-4 py-2.5 text-[10px] uppercase tracking-[0.14em] text-slate-600">
        <span className="flex items-center gap-1.5"><Sparkles size={11} /> Aperçu Reelora</span>
        <span>{state === 'result' ? 'Résultat final' : state === 'reference' ? 'Image de référence' : state === 'generating' ? 'Suivi live' : 'En attente de création'}</span>
      </div>
    </div>
  );
}

export function TrackingPanel({ tracking, providerState, requestId }: {
  tracking: TrackingState; providerState?: string | null; requestId?: string | null;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-panel/60 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {tracking.tone === 'active' && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" /><span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" /></span>}
            <h3 className="text-sm font-semibold text-white">{tracking.label}</h3>
          </div>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-slate-400">{tracking.description}</p>
        </div>
        {tracking.serverSide && (
          <span className="rounded-full border border-emerald-400/20 bg-emerald-400/[0.07] px-2.5 py-1 text-[10px] font-medium text-emerald-200">Suivi serveur actif</span>
        )}
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div className={cn('h-full rounded-full transition-all duration-700', tracking.tone === 'error' ? 'bg-rose-400' : tracking.tone === 'success' ? 'bg-emerald-400' : 'bg-gradient-to-r from-brand-500 to-cyan-400')} style={{ width: `${tracking.progress}%` }} />
      </div>

      <ol className="mt-5 grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-3">
        {TRACK_STEPS.slice(0, 5).map((step, i) => {
          const status = stepStatus(i, tracking);
          return (
            <li key={step.id} className="flex items-start gap-2">
              <span className={cn('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border text-[8px]',
                status === 'done' ? 'border-emerald-400/50 bg-emerald-400/20 text-emerald-200' :
                  status === 'active' ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-200' :
                    status === 'failed' ? 'border-rose-400/50 bg-rose-400/20 text-rose-200' : 'border-white/10 text-slate-600')}>
                {status === 'done' ? '✓' : status === 'failed' ? '!' : i + 1}
              </span>
              <div className="min-w-0">
                <p className={cn('text-[11px] font-medium leading-tight', status === 'pending' ? 'text-slate-500' : 'text-slate-200')}>{step.label}</p>
                {status === 'active' && <p className="mt-0.5 text-[10px] leading-snug text-slate-500">{step.hint}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {(providerState || requestId) && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/[0.06] pt-3 text-[10px] text-slate-500">
          {providerState && <span className="rounded bg-white/[0.04] px-2 py-1">MuAPI : {providerState}</span>}
          {requestId && <span className="rounded bg-white/[0.04] px-2 py-1 font-mono">ID : {requestId}</span>}
        </div>
      )}
    </div>
  );
}
