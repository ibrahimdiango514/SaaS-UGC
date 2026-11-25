import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { ArrowUpRight, Lock, Sparkles } from 'lucide-react';
import { cn } from '../../components/ui';
import { NAV_SECTIONS, ROADMAP_SECTIONS } from '../sections';

function StudioTab({ to, label, icon: Icon, status, end }: {
  to: string; label: string; icon: typeof Sparkles; status: 'live' | 'prepared'; end?: boolean;
}) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cn(
      'group flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-[12.5px] font-medium transition-all duration-200',
      isActive
        ? 'border-cyan-300/40 bg-cyan-400/[0.14] text-white shadow-[0_0_0_1px_rgba(34,211,238,0.12)]'
        : 'border-white/[0.06] bg-white/[0.02] text-slate-400 hover:border-white/15 hover:bg-white/[0.05] hover:text-white',
    )}>
      <Icon size={15} className={cn('transition-colors', status === 'live' ? 'text-cyan-300' : 'text-slate-500')} />
      <span>{label}</span>
      {status === 'prepared' && <Lock size={11} className="ml-0.5 opacity-60" aria-label="Espace préparé, non opérationnel" />}
    </NavLink>
  );
}

export function StudioShell({ children, title, eyebrow, actions }: {
  children: ReactNode; title: string; eyebrow?: string; actions?: ReactNode;
}) {
  const { pathname } = useLocation();
  const active = NAV_SECTIONS.find((s) => s.route === pathname);

  return (
    <div className="animate-fadeUp">
      {/* Identité SORAHNEX Studio — composition cyan, profondeur et grille discrète. */}
      <div className="relative mb-5 overflow-hidden rounded-[1.6rem] border border-cyan-200/[0.14] bg-[#080d15] px-5 py-6 sm:px-7 sm:py-7">
        <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-28 h-64 w-64 rounded-full bg-cyan-400/[0.18] blur-[90px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 right-0 h-64 w-64 rounded-full bg-sky-400/[0.12] blur-[100px]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-[0.035] [background-image:radial-gradient(circle_at_1px_1px,white_1px,transparent_0)] [background-size:18px_18px]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-300/25"><Sparkles size={14} /></span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-200/90">SORAHNEX · Studio UGC</span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.14em] text-slate-400">Espace création</span>
            </div>
            <h1 className="vy-title text-[1.65rem] leading-tight sm:text-[2rem]">{title}</h1>
            <p className="mt-2 max-w-2xl text-[12.5px] leading-relaxed text-slate-400">
              {active?.description ?? eyebrow ?? 'Un espace de création sobre, rapide et pensé pour le mobile.'}
            </p>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
        </div>
      </div>

      {/* Primary modular navigation — horizontally scrollable on mobile */}
      <div className="no-scrollbar mb-4 flex gap-2 overflow-x-auto pb-1" role="navigation" aria-label="Espaces du studio">
        {NAV_SECTIONS.map((s) => (
          <StudioTab key={s.id} to={s.route} label={s.label} icon={s.icon} status={s.status} end={s.route === '/app/studio'} />
        ))}
      </div>

      {children}

      {/* Roadmap: architectural placeholders, explicitly labelled non-operational */}
      <details className="group mt-8 rounded-2xl border border-white/[0.07] bg-panel/40">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-slate-300 transition-colors hover:text-white">
          <span className="flex items-center gap-2"><Sparkles size={14} className="text-cyan-300" /> Espaces préparés · feuille de route</span>
          <span className="text-[11px] font-normal text-slate-500">{ROADMAP_SECTIONS.length} modules · non opérationnels</span>
        </summary>
        <div className="border-t border-white/[0.06] px-4 py-4">
          <p className="mb-3 text-xs leading-relaxed text-slate-500">
            L’architecture de navigation est modulaire. Ces espaces sont réservés et affichés comme préparés : aucun fournisseur, aucun bouton de génération et aucun résultat simulé ne leur est associé.
          </p>
          <div className="flex flex-wrap gap-2">
            {ROADMAP_SECTIONS.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-slate-400">
                <s.icon size={12} className="text-slate-500" /> {s.label}
                <span className="rounded bg-slate-700/50 px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-300">Préparé</span>
                <ArrowUpRight size={10} className="opacity-40" />
              </span>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}
