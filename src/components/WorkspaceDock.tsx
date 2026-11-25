import { Link } from 'react-router-dom';
import { ArrowLeftRight, Brain, Clapperboard, LayoutDashboard } from 'lucide-react';
import { cn } from './ui';

/**
 * Barre d'espace : rappelle en permanence dans quel univers on se trouve
 * (identité couleur + nom) et propose les sorties légitimes.
 *
 * Aucune permission n'est modifiée : le dock ne fait que LIRE le périmètre
 * déjà déterminé par la route, et pointe vers des pages existantes.
 */
export type DockScope = 'studio' | 'business' | 'hub' | 'admin';

const IDENTITY: Record<Exclude<DockScope, 'hub'>, {
  label: string;
  detail: string;
  icon: typeof Clapperboard;
  home: string;
  overview: string;
  overviewLabel: string;
}> = {
  studio: {
    label: 'SORAHNEX Studio',
    detail: 'Création & production UGC',
    icon: Clapperboard,
    home: '/app/studio',
    overview: '/app/studio/accueil',
    overviewLabel: 'Tableau de bord',
  },
  business: {
    label: 'SORAHNEX Grow',
    detail: 'Pilotage, revenus & opérations',
    icon: Brain,
    home: '/app/business',
    overview: '/app/business',
    overviewLabel: 'Vue d’ensemble',
  },
  admin: {
    label: 'Administration SORAHNEX',
    detail: 'Console propriétaire',
    icon: LayoutDashboard,
    home: '/admin',
    overview: '/admin',
    overviewLabel: 'Console',
  },
};

export function WorkspaceDock({ scope, currentPath }: { scope: Exclude<DockScope, 'hub'>; currentPath: string }) {
  const identity = IDENTITY[scope];
  const Icon = identity.icon;

  return (
    <div className="vy-dock mb-4" data-testid="workspace-dock" data-scope={scope}>
      <span className="vy-dock-mark" aria-hidden="true"><Icon size={15} /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[12px] font-semibold tracking-[-0.01em] text-white">{identity.label}</p>
        <p className="truncate text-[10px] text-slate-400">{identity.detail}</p>
      </div>
      <nav aria-label="Sorties de l’espace" className="flex shrink-0 items-center gap-1">
        {currentPath !== identity.overview && scope !== 'admin' && (
          <Link
            to={identity.overview}
            className="hidden min-h-9 items-center rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-[10.5px] font-medium text-slate-300 transition hover:border-white/20 hover:text-white sm:inline-flex"
          >
            {identity.overviewLabel}
          </Link>
        )}
        <Link
          to="/app"
          title="Tous les espaces"
          aria-label="Tous les espaces"
          className={cn(
            'grid h-9 w-9 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-slate-300 transition hover:border-white/20 hover:text-white',
          )}
        >
          <ArrowLeftRight size={14} />
        </Link>
      </nav>
    </div>
  );
}
