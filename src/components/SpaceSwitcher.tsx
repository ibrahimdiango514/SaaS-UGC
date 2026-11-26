import { Link } from 'react-router-dom';
import { Brain, Clapperboard, LayoutGrid, Sparkles } from 'lucide-react';
import { cn } from './ui';

/**
 * Sélecteur d'espace : rend visible en permanence l'espace courant et permet
 * de passer de Studio à SORAHNEX Grow en un geste, sans passer par un menu.
 *
 * Le composant ne lit aucune permission : il reçoit la route courante et
 * pointe vers les deux accueils, qui appliquent leurs propres protections.
 */
export type SpaceScope = 'studio' | 'business' | 'agent' | 'admin' | 'hub';

const SPACES = [
  {
    id: 'studio' as const,
    to: '/app/studio/accueil',
    label: 'Studio',
    detail: 'Créer',
    icon: Clapperboard,
  },
  {
    id: 'business' as const,
    to: '/app/business',
    label: 'SORAHNEX Grow',
    detail: 'Piloter',
    icon: Brain,
  },
  /*
   * Espace Agent IA : troisième espace, pas une rubrique de Grow. Il a sa
   * propre route et sa propre navigation, et reste relié à Grow pour lire les
   * données et agir dessus.
   */
  {
    id: 'agent' as const,
    to: '/app/agent',
    label: 'Agent IA',
    detail: 'Converser et agir',
    icon: Sparkles,
  },
];

export function SpaceSwitcher({ scope, compact = false }: { scope: SpaceScope; compact?: boolean }) {
  const current = scope === 'business' || scope === 'agent' ? scope : 'studio';

  return (
    <div
      role="group"
      aria-label="Changer d’espace"
      className="flex items-center gap-1 rounded-xl border border-white/[0.09] bg-white/[0.03] p-1"
    >
      {SPACES.map((space) => {
        const active = space.id === current;
        const Icon = space.icon;
        return (
          <Link
            key={space.id}
            to={space.to}
            aria-current={active ? 'true' : undefined}
            title={`${space.label} — ${space.detail}`}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold transition',
              active
                ? space.id === 'business'
                  ? 'bg-violet-400/[0.16] text-violet-100 shadow-[inset_0_0_0_1px_rgba(196,181,253,0.28)]'
                  : 'bg-cyan-400/[0.14] text-cyan-100 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.25)]'
                : 'text-slate-400 hover:bg-white/[0.05] hover:text-white',
            )}
          >
            <Icon size={13} />
            {!compact && <span>{space.label}</span>}
          </Link>
        );
      })}
      <Link
        to="/app"
        title="Tous les espaces"
        aria-label="Tous les espaces"
        className="grid h-9 w-9 place-items-center rounded-lg text-slate-500 transition hover:bg-white/[0.05] hover:text-white"
      >
        <LayoutGrid size={13} />
      </Link>
    </div>
  );
}
