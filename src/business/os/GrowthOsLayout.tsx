import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Menu, Sparkles, X } from 'lucide-react';
import { cn } from '../../components/ui';
import {
  GROWTH_OS_MODULES, GROWTH_OS_NAV, growthOsModule, type GrowthOsModule,
} from './modules';

/**
 * Coquille du Growth OS : sidebar réelle, en-tête de module et zone de contenu.
 *
 * Tous les liens sont des URL : le rechargement, le bouton retour et le partage
 * d'un écran fonctionnent. Sur mobile, un menu plein écran remplace la sidebar.
 */
export function GrowthOsLayout({
  active, workspaceName, children,
}: {
  active: GrowthOsModule;
  workspaceName: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const current = growthOsModule(active);

  const nav = (onNavigate?: () => void) => (
    <nav aria-label="Navigation Growth OS" className="space-y-5">
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
                    'group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] transition',
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
        <Link to="/app/business/modules" className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white">
          <Sparkles size={15} className="text-slate-500" /> Modules métier
        </Link>
        <Link to="/app/business/abonnement" className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[12.5px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white">
          <Sparkles size={15} className="text-slate-500" /> Formule Business
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="animate-fadeUp" data-testid="growth-os">
      {/* Barre mobile */}
      <div className="sticky top-0 z-30 -mx-1 mb-3 flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-[#070c13]/95 px-3 py-2.5 backdrop-blur-xl lg:hidden">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-400/15 text-violet-200 ring-1 ring-violet-300/25">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-violet-200/80">Growth OS</p>
          <p className="truncate text-[13px] font-semibold text-white">{current.label}</p>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Ouvrir le menu Growth OS"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-slate-200"
        >
          <Menu size={14} /> Menu
        </button>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="Menu Growth OS">
          <button type="button" aria-label="Fermer le menu" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setMenuOpen(false)} />
          <div className="relative ml-auto flex h-full w-[86%] max-w-[320px] flex-col overflow-y-auto bg-[#070c13] p-4">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-200/80">SORAHNEX</p>
                <p className="text-sm font-semibold text-white">Growth OS</p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName}</p>
              </div>
              <button type="button" onClick={() => setMenuOpen(false)} aria-label="Fermer" className="rounded-lg border border-white/10 p-2 text-slate-300">
                <X size={16} />
              </button>
            </div>
            {nav(() => setMenuOpen(false))}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-4 rounded-2xl border border-white/[0.07] bg-[#070c13]/85 p-3 backdrop-blur-xl">
            <div className="mb-4 px-1">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-violet-200/80">SORAHNEX · Business</p>
              <p className="mt-0.5 font-display text-[15px] font-semibold text-white">Growth OS</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName}</p>
            </div>
            {nav()}
          </div>
        </aside>

        <main className="min-w-0">
          <header className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#080a12] px-4 py-4 sm:px-5">
            <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-violet-500/15 blur-[70px]" />
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-violet-300/40 to-transparent" />
            <div className="relative flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[9.5px] font-semibold uppercase tracking-[0.2em] text-violet-200/85">Growth OS · {current.label}</p>
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

          <div className="mt-3 space-y-4">{children}</div>
        </main>
      </div>
    </div>
  );
}

export function GrowthOsMobilePicker({ active }: { active: GrowthOsModule }) {
  return (
    <details className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] text-slate-300">
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
