import { ArrowUpRight, Clapperboard, Play, Sparkles } from 'lucide-react';
import { SECTORS, type SectorId } from '../plan';

/** Real project-integrated stills, explicitly labelled as inspiration. */
export function GenerationEmptyState({ onExample, onStart }: {
  onExample: (sector: SectorId, example: string) => void;
  onStart: () => void;
}) {
  return (
    <div className="studio-v2 animate-fadeUp">
      <div className="relative overflow-hidden rounded-3xl border border-cyan-400/15 bg-[#070b11] px-5 py-7 sm:px-8 sm:py-9">
        <div aria-hidden="true" className="pointer-events-none absolute -left-28 -top-40 h-80 w-80 rounded-full bg-cyan-400/10 blur-[110px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 right-0 h-80 w-80 rounded-full bg-brand-500/10 blur-[110px]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.03] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:20px_20px]" />
        <div className="relative">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-400/[0.07] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200">
            <Sparkles size={11} /> Reelora · Video Generation Studio
          </span>
          <h1 className="mt-4 max-w-2xl text-2xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            Une idée. Une vidéo UGC. <span className="text-cyan-300">Un montage à vous.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
            Décrivez votre publicité en une seule phrase. Reelora prépare le plan de production, choisit un modèle MuAPI compatible,
            affiche le devis en crédits UGC, puis ouvre le résultat dans un véritable éditeur avec timeline.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={onStart} className="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-[#04121a] transition hover:bg-cyan-300">
              <Play size={15} /> Commencer une génération
            </button>
            <span className="inline-flex items-center gap-2 rounded-xl border border-white/[0.08] px-3 py-2.5 text-xs text-slate-400">
              <Clapperboard size={14} className="text-cyan-300" /> Format 9:16 par défaut · Reels / TikTok / Shorts
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Exemples par secteur</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">Visuels d’inspiration intégrés au projet — images de démonstration, pas des générations vidéo.</p>
        </div>
        <span className="hidden shrink-0 rounded-lg border border-white/[0.07] px-2 py-1 text-[10px] text-slate-500 sm:block">5 secteurs</span>
      </div>

      <div className="no-scrollbar mt-3 flex snap-x gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-3 sm:overflow-visible lg:grid-cols-5">
        {SECTORS.map((s) => (
          <button key={s.id} type="button" onClick={() => onExample(s.id, s.example)}
            className="group relative aspect-[3/4] w-[150px] shrink-0 snap-start overflow-hidden rounded-2xl border border-white/[0.08] bg-panel text-left transition hover:border-cyan-400/40 sm:w-auto">
            <img src={s.image} alt={`Visuel d’inspiration · ${s.label}`} loading="lazy" className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-300 group-hover:scale-105 group-hover:opacity-95" />
            <span className="absolute inset-0 bg-gradient-to-t from-[#05080e] via-[#05080e]/25 to-transparent" />
            <span className="absolute inset-x-0 bottom-0 p-3">
              <span className="mb-1 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200 backdrop-blur">Démo</span>
              <span className="block text-sm font-semibold text-white">{s.label}</span>
              <span className="mt-0.5 block text-[10px] leading-snug text-slate-300">{s.hint}</span>
              <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium text-cyan-300">Utiliser l’exemple <ArrowUpRight size={10} /></span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
