import { Link } from 'react-router-dom';
import {
  Clapperboard, Download, Film, History, PencilLine, RefreshCw, Scissors, Sparkles,
} from 'lucide-react';
import type { GenerationJob, VideoActionResult } from '../../lib/types';

/** Post-generation actions. No fake video: the player only appears with a real signed URL. */
export function AfterGeneration({ result, job, onRegenerate, onEditScript, onVariant, onEditor }: {
  result: VideoActionResult | null;
  job: GenerationJob | null;
  onRegenerate: () => void;
  onEditScript: () => void;
  onVariant: () => void;
  onEditor: () => void;
}) {
  const url = result?.preview_url ?? null;
  const credits = job?.credits_charged || job?.credits_reserved || 0;
  return (
    <div className="studio-v2 animate-fadeUp rounded-2xl border border-cyan-400/20 bg-[#080e14] p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-300">Résultat de génération</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Votre vidéo UGC</h2>
        </div>
        <span className="rounded-lg border border-white/[0.08] px-2.5 py-1 text-[11px] text-slate-400">
          Studio UGC · {credits} crédits {job?.status === 'succeeded' ? 'utilisés' : 'réservés'}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-white/[0.08] bg-black">
          {url ? (
            <video src={url} controls playsInline preload="metadata" className="h-full w-full" />
          ) : (
            <div className="grid h-full place-items-center px-6 text-center">
              <div>
                <Film size={28} className="mx-auto text-slate-600" />
                <p className="mt-2 text-sm text-slate-300">Aucun fichier vidéo disponible</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  Le lecteur apparaît dès que votre vidéo est prête et enregistrée dans votre espace privé.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-slate-400">Actions</p>
          <a href={url ?? undefined} download={url ? 'vyora-video.mp4' : undefined}
            className={`studio-action ${url ? '' : 'pointer-events-none opacity-40'}`} aria-disabled={!url}>
            <Download size={14} /> Télécharger
          </a>
          <button type="button" onClick={onEditor} className="studio-action"><Scissors size={14} /> Modifier le montage</button>
          <button type="button" onClick={onRegenerate} className="studio-action"><RefreshCw size={14} /> Régénérer</button>
          <button type="button" onClick={onEditScript} className="studio-action"><PencilLine size={14} /> Modifier le script</button>
          <button type="button" onClick={onVariant} className="studio-action"><Sparkles size={14} /> Créer une variante</button>
          <Link to="/app/historique" className="studio-action"><History size={14} /> Voir l’historique</Link>
          <Link to="/app/studio/montage" className="studio-action"><Clapperboard size={14} /> Reprendre dans l’éditeur</Link>
        </div>
      </div>
    </div>
  );
}
