import { ArrowUpRight, Sparkles } from 'lucide-react';
import { SECTORS, type SectorId } from '../plan';

interface HomeCard {
  sector: SectorId;
  label: string;
  image: string;
}

const HOME_CARDS: HomeCard[] = [
  { sector: 'cosmetique', label: 'Beauté', image: '/studio-examples/cosmetique.jpg' },
  { sector: 'food', label: 'Food', image: '/studio-examples/food.jpg' },
  { sector: 'ecommerce', label: 'E-commerce', image: '/studio-examples/ecommerce.jpg' },
  { sector: 'mode', label: 'Mode', image: '/studio-examples/mode.jpg' },
];

const CHIPS: { sector: SectorId; label: string }[] = [
  { sector: 'cosmetique', label: 'Cosmétique' },
  { sector: 'food', label: 'Food' },
  { sector: 'ecommerce', label: 'E-commerce' },
  { sector: 'fitness', label: 'Fitness' },
];

export function GenerationEmptyState({ onExample, onStart, onSector, selectedSector }: {
  onExample: (sector: SectorId, example: string) => void;
  onStart: () => void;
  onSector?: (sector: SectorId) => void;
  selectedSector?: SectorId;
}) {
  const pick = (sector: SectorId) => {
    const example = SECTORS.find((s) => s.id === sector)?.example ?? '';
    onSector?.(sector);
    onExample(sector, example);
  };

  return (
    <section data-testid="studio-hero" className="studio-v2 relative overflow-hidden rounded-[28px] border border-white/[0.06] bg-[#04070b] px-4 pb-32 pt-3 sm:px-8 sm:pb-10 sm:pt-12">
      <div aria-hidden="true" className="pointer-events-none absolute -left-32 -top-40 h-80 w-80 rounded-full bg-cyan-400/[0.08] blur-[110px]" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-32 top-10 h-72 w-72 rounded-full bg-fuchsia-500/[0.06] blur-[110px]" />

      <div className="relative mx-auto max-w-3xl text-center">
        <div className="mx-auto mb-3 flex w-full max-w-[440px] items-end justify-center gap-1.5 sm:mb-9 sm:gap-2" aria-label="Inspirations par secteur">
          {HOME_CARDS.map((card) => (
            <button key={card.sector} type="button" onClick={() => pick(card.sector)}
              className="group relative h-20 w-1/4 max-w-[110px] overflow-hidden rounded-2xl border border-white/10 bg-[#111821] shadow-[0_18px_45px_rgba(0,0,0,0.45)] transition duration-300 hover:z-10 hover:scale-105 sm:h-36"
              aria-label={`Exemple ${card.label}`}>
              <img src={card.image} alt="" className="absolute inset-0 h-full w-full object-cover opacity-75 transition duration-500 group-hover:scale-110 group-hover:opacity-100" />
              <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/10" />
              <span className="absolute left-2 top-2 rounded-md bg-black/40 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-white/90 backdrop-blur">Démo</span>
              <span className="absolute inset-x-1 bottom-2 truncate text-[10px] font-bold text-white drop-shadow sm:text-xs">{card.label}</span>
              <ArrowUpRight size={11} className="absolute right-2 top-2 text-white/80 opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
        </div>

        <p className="inline-flex items-center gap-1.5 rounded-full border border-cyan-400/20 bg-cyan-400/[0.06] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.22em] text-cyan-200">
          <Sparkles size={10} />           VYORA · Studio UGC
        </p>
        <h1 className="mt-3 text-[24px] font-black uppercase leading-[1.05] tracking-tight text-white sm:mt-5 sm:text-5xl">
          Votre prochain<br /><span className="text-cyan-300">film commence ici</span>
        </h1>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-400 sm:mt-3 sm:text-base">Décrivez votre pub, on crée la vidéo.</p>

        <div className="mt-3 flex flex-wrap justify-center gap-2 sm:mt-6" aria-label="Secteurs">
          {CHIPS.map((chip) => (
            <button key={chip.sector} type="button" onClick={() => pick(chip.sector)}
              className={`rounded-full border px-4 py-2 text-xs font-medium transition sm:text-[13px] ${
                selectedSector === chip.sector
                  ? 'border-cyan-400/50 bg-cyan-400/15 text-white'
                  : 'border-white/[0.09] bg-white/[0.02] text-slate-300 hover:border-cyan-400/35 hover:text-white'
              }`}
              aria-pressed={selectedSector === chip.sector}>
              {chip.label}
            </button>
          ))}
        </div>

        <button type="button" onClick={onStart}
          className="mt-4 inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/[0.08] px-4 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-400/[0.14] sm:mt-7">
          Écrire mon instruction <ArrowUpRight size={13} />
        </button>
      </div>
    </section>
  );
}
