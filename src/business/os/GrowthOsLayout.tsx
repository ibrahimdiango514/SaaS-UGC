import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, Sparkles, X } from 'lucide-react';
import { cn } from '../../components/ui';
import { SpaceSwitcher } from '../../components/SpaceSwitcher';
import {
  GROWTH_OS_MODULES, GROWTH_OS_NAV, GROWTH_OS_QUICK_ACTIONS, growthOsModule,
  type GrowthOsModule,
} from './modules';

/**
 * Coquille du Growth OS : navigation réelle, en-tête de module et zone de contenu.
 *
 * Tous les liens sont des URL : le rechargement, le bouton retour et le partage
 * d'un écran fonctionnent. La disposition suit trois contextes :
 *
 *   - téléphone : barre compacte + menu plein écran, barre de navigation basse
 *     fournie par le Layout global ;
 *   - tablette : navigation latérale visible dès 768 px, la zone de contenu
 *     reste lisible sans colonne inutile ;
 *   - ordinateur : navigation latérale et contenu large.
 *
 * La barre mobile est collée sous l'en-tête global (`top-16`) : elle ne disparaît
 * plus derrière lui au défilement, et un seul conteneur défile (la fenêtre).
 */
export function GrowthOsLayout({
  active, workspaceName, children,
}: {
  active: GrowthOsModule;
  workspaceName: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const current = growthOsModule(active);

  // Le menu mobile est un panneau : la page derrière ne doit ni défiler ni
  // rester ouverte après un changement d'écran, et Échap doit le fermer.
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  const nav = (onNavigate?: () => void) => (
    <nav aria-label="Navigation SORAHNEX Grow" className="space-y-4">
      {GROWTH_OS_NAV.map((group) => (
        <div key={group.id}>
          <p className="px-2.5 text-[9px] font-semibold uppercase tracking-[0.18em] text-slate-500">{group.label}</p>
          <div className="mt-1.5 space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = item.key === active;
              return (
                <Link
                  key={item.key}
                  to={item.path}
                  onClick={onNavigate}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'group flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] transition',
                    isActive
                      ? 'bg-gradient-to-r from-violet-400/20 to-cyan-400/[0.05] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(196,181,253,0.18)]'
                      : 'text-slate-400 hover:bg-white/[0.04] hover:text-white',
                  )}
                >
                  <Icon size={15} className={isActive ? 'text-violet-200' : 'text-slate-500 group-hover:text-slate-300'} />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      ))}
      <div className="space-y-0.5 border-t border-white/[0.07] pt-3">
        <Link to="/app/business/modules" onClick={onNavigate} className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white">
          <Sparkles size={15} className="text-slate-500" /> Modules métier
        </Link>
        <Link to="/app/business/abonnement" onClick={onNavigate} className="flex min-h-11 items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white">
          <Sparkles size={15} className="text-slate-500" /> Formule SORAHNEX Grow
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="animate-fadeUp min-w-0" data-testid="growth-os">
      {/* Barre mobile : collée sous l'en-tête global, jamais derrière lui. */}
      <div className="sticky top-16 z-20 -mx-1 mb-3 flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-[#070c13]/95 px-3 py-2.5 backdrop-blur-xl md:hidden">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-400/15 text-violet-200 ring-1 ring-violet-300/25">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-violet-200/80">SORAHNEX Grow</p>
          <p className="truncate text-[13px] font-semibold text-white">{current.label}</p>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Ouvrir le menu SORAHNEX Grow"
          aria-expanded={menuOpen}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-slate-200"
        >
          <Menu size={14} /> Menu
        </button>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-50 flex justify-start overflow-x-hidden md:hidden" role="dialog" aria-modal="true" aria-label="Menu SORAHNEX Grow">
          <button type="button" aria-label="Fermer le menu" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <div
            className="relative flex h-full w-[min(86vw,320px)] max-w-full flex-col overflow-y-auto overscroll-contain bg-[#070c13] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)] shadow-2xl"
            style={{ paddingLeft: 'max(1rem, env(safe-area-inset-left))' }}
          >
            <div className="mb-4 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-200/80">SORAHNEX</p>
                <p className="text-sm font-semibold text-white">Grow</p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName}</p>
              </div>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Fermer" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/10 p-2 text-slate-300">
                <X size={16} />
              </button>
            </div>
            <div className="mb-4"><SpaceSwitcher scope="business" /></div>
            {nav(() => setMenuOpen(false))}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[212px_minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden min-w-0 md:block">
          <div className="sticky top-[4.5rem] max-h-[calc(100vh-5.5rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.07] bg-[#070c13]/85 p-3 backdrop-blur-xl no-scrollbar">
            <div className="mb-4 px-1">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-200/80">SORAHNEX</p>
              <p className="mt-0.5 font-display text-[15px] font-semibold text-white">Grow</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName}</p>
            </div>
            <div className="mb-4"><SpaceSwitcher scope="business" compact /></div>
            {nav()}
          </div>
        </aside>

        <main className="min-w-0 overflow-x-hidden">
          <header className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#080a12] px-4 py-4 sm:px-5">
            <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-violet-500/15 blur-[70px]" />
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
            <div className="relative flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[9.5px] font-semibold uppercase tracking-[0.2em] text-violet-200/85">SORAHNEX Grow · {current.label}</p>
                <h1 className="mt-1 font-display text-[1.35rem] font-semibold leading-tight text-white sm:text-[1.6rem]">{current.label}</h1>
                <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-slate-400">{current.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-flex max-w-[190px] items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-slate-300">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" />
                  <span className="truncate">{workspaceName}</span>
                </span>
              </div>
            </div>
          </header>

          {/* Actions du quotidien : visibles, sans encombrer la navigation. */}
          <div className="-mx-1 mt-3 flex snap-x gap-2 overflow-x-auto px-1 pb-1 no-scrollbar" aria-label="Actions rapides">
            {GROWTH_OS_QUICK_ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.to}
                  to={action.to}
                  title={action.hint}
                  className="inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 text-[11.5px] font-medium text-slate-300 transition hover:border-violet-300/30 hover:bg-violet-400/[0.07] hover:text-white"
                >
                  <Icon size={14} className="text-violet-200" />
                  {action.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-3 min-w-0 space-y-4">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function GrowthOsMobilePicker({ active }: { active: GrowthOsModule }) {
  return (
    <details className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 md:hidden">
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between text-[11px] text-slate-300">
        Changer de module <ChevronDown size={13} />
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        {GROWTH_OS_MODULES.map((item) => (
          <Link
            key={item.key}
            to={item.path}
            aria-current={item.key === active ? 'page' : undefined}
            className={cn(
              'rounded-lg border px-2 py-1.5 text-[11px]',
              item.key === active ? 'border-violet-300/30 bg-violet-400/10 text-white' : 'border-white/[0.06] text-slate-400',
            )}
          >
            {item.shortLabel}
          </Link>
        ))}
      </div>
    </details>
  );
}
