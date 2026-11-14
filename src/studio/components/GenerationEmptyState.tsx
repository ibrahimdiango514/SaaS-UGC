import { Sparkles } from 'lucide-react';
import { SECTORS, type SectorId } from '../plan';

interface HomeCard {
  sector: SectorId;
  label: string;
  image: string;
}

/**
 * Quatre visuels de démonstration, étiquetés « Démo ».
 * Ils illustrent des secteurs ; ce ne sont PAS des médias générés par VYORA.
 */
const HOME_CARDS: HomeCard[] = [
  { sector: 'cosmetique', label: 'Beauté', image: '/studio-examples/cosmetique.jpg' },
  { sector: 'food', label: 'Food', image: '/studio-examples/food.jpg' },
  { sector: 'ecommerce', label: 'E-commerce', image: '/studio-examples/ecommerce.jpg' },
  { sector: 'mode', label: 'Mode', image: '/studio-examples/mode.jpg' },
];

const CHIPS: { sector: SectorId; label: string }[] = [
  { sector: 'cosmetique', label: 'Beauté' },
  { sector: 'food', label: 'Food' },
  { sector: 'ecommerce', label: 'E-commerce' },
  { sector: 'fitness', label: 'Fitness' },
];

/**
 * Écran d'accueil du Studio.
 *
 * Reproduit la composition de la référence : une rangée de visuels en éventail,
 * un titre sur deux lignes avec la seconde accentuée, une seule ligne de
 * consigne, puis des puces de secteur. Aucun paragraphe explicatif, aucun
 * bandeau commercial, aucun modèle affiché en permanence : tout cela vit dans
 * les panneaux (catalogue, réglages) et dans le composer docké.
 */
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
    <section data-testid="studio-hero" className="relative px-3 pb-2 pt-6 sm:px-6 sm:pt-12">
      <div className="relative mx-auto max-w-3xl text-center">
        {/* Éventail de visuels, comme la référence : léger décalage vertical et inclinaison. */}
        <div
          className="mx-auto mb-6 flex w-full max-w-[520px] items-end justify-center gap-1 sm:mb-9 sm:gap-2"
          aria-label="Inspirations par secteur"
        >
          {HOME_CARDS.map((card, index) => (
            <button
              key={card.sector}
              type="button"
              onClick={() => pick(card.sector)}
              className="group relative h-[74px] w-1/4 max-w-[120px] overflow-hidden rounded-[14px] border border-white/12 bg-[#111] shadow-[0_16px_40px_rgba(0,0,0,0.6)] transition duration-300 hover:z-10 hover:-translate-y-1 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 sm:h-[118px] sm:rounded-2xl"
              style={{ transform: `rotate(${(index - 1.5) * 3}deg)` }}
              aria-label={`Exemple ${card.label} (image de démonstration)`}
            >
              <img
                src={card.image}
                alt=""
                className="absolute inset-0 h-full w-full object-cover opacity-80 transition duration-500 group-hover:scale-105 group-hover:opacity-100"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
              <span className="absolute left-1.5 top-1.5 rounded bg-black/55 px-1 py-0.5 text-[7px] uppercase tracking-wide text-white/90 backdrop-blur-sm sm:text-[8px]">
                Démo
              </span>
              <span className="absolute inset-x-1 bottom-1.5 truncate text-[9px] font-semibold text-white drop-shadow sm:text-[11px]">
                {card.label}
              </span>
            </button>
          ))}
        </div>

        <h1 className="text-[26px] font-black uppercase leading-[1.02] tracking-[-0.02em] text-white sm:text-[46px]">
          Créez votre vidéo
          <br />
          <span className="text-cyan-300">avec VYORA</span>
        </h1>

        <p className="mx-auto mt-2.5 max-w-md text-[12.5px] leading-relaxed text-slate-400 sm:mt-4 sm:text-[14.5px]">
          Décrivez une scène, un produit, un ton — et générez votre publicité.
        </p>

        <div className="mt-4 flex flex-wrap justify-center gap-1.5 sm:mt-6 sm:gap-2" aria-label="Secteurs">
          {CHIPS.map((chip) => (
            <button
              key={chip.sector}
              type="button"
              onClick={() => pick(chip.sector)}
              className={`rounded-full border px-3.5 py-1.5 text-[11.5px] font-medium transition sm:text-[12.5px] ${
                selectedSector === chip.sector
                  ? 'border-cyan-400/55 bg-cyan-400/15 text-white'
                  : 'border-white/[0.10] bg-white/[0.03] text-slate-300 hover:border-white/25 hover:text-white'
              }`}
              aria-pressed={selectedSector === chip.sector}
            >
              {chip.label}
            </button>
          ))}
          <button
            type="button"
            onClick={onStart}
            className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-3 py-1.5 text-[11.5px] font-medium text-cyan-300 transition hover:text-cyan-200 sm:text-[12.5px]"
          >
            <Sparkles size={12} /> Écrire
          </button>
        </div>
      </div>
    </section>
  );
}
