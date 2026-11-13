import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../components/ui';
import {
  BUSINESS_NAV_GROUPS, BUSINESS_SHORTCUTS, STUDIO_NAV_GROUPS,
  STUDIO_SHORTCUTS, activeGroupId, filterNavGroups, isNavItemActive,
  type WorkspaceNavGroup, type WorkspaceScope,
} from './config';

const STORAGE_PREFIX = 'vyora.nav.groups.v1';

function defaultOpenState(groups: WorkspaceNavGroup[], active: string | null): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const group of groups) state[group.id] = Boolean(group.defaultOpen) || group.id === active;
  return state;
}

function readOpenState(scope: WorkspaceScope, groups: WorkspaceNavGroup[], active: string | null): Record<string, boolean> {
  if (typeof window === 'undefined') return defaultOpenState(groups, active);
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}.${scope}`);
    if (!raw) return defaultOpenState(groups, active);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const state = defaultOpenState(groups, active);
    for (const group of groups) {
      if (typeof parsed[group.id] === 'boolean') state[group.id] = parsed[group.id] as boolean;
    }
    if (active) state[active] = true;
    return state;
  } catch {
    return defaultOpenState(groups, active);
  }
}

export function WorkspaceNav({ scope, onNavigate, onRequestClose }: {
  scope: WorkspaceScope;
  onNavigate?: () => void;
  onRequestClose?: () => void;
}) {
  const location = useLocation();
  const groups = scope === 'business' ? BUSINESS_NAV_GROUPS : STUDIO_NAV_GROUPS;
  const shortcuts = scope === 'business' ? BUSINESS_SHORTCUTS : STUDIO_SHORTCUTS;
  const active = useMemo(
    () => activeGroupId(groups, location.pathname, location.search),
    [groups, location.pathname, location.search],
  );
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>(() => readOpenState(scope, groups, active));
  const [scopeChanged, setScopeChanged] = useState(scope);
  const searchRef = useRef<HTMLInputElement>(null);

  // Un changement d'espace recharge les groupes de cet espace, sans fuite de
  // l'état replié de l'autre espace.
  if (scopeChanged !== scope) {
    setScopeChanged(scope);
    setOpen(readOpenState(scope, groups, active));
    setQuery('');
  }

  useEffect(() => {
    if (!active) return;
    setOpen((current) => current[active] ? current : { ...current, [active]: true });
  }, [active]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}.${scope}`, JSON.stringify(open));
    } catch {
      // La navigation reste fonctionnelle si le stockage local est indisponible.
    }
  }, [open, scope]);

  const filtered = useMemo(() => filterNavGroups(groups, query), [groups, query]);
  const searching = query.trim().length > 0;
  const allOpen = groups.every((group) => open[group.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-1">
        <label className="relative flex min-h-11 items-center rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 focus-within:border-cyan-300/35">
          <Search size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
          <span className="sr-only">Rechercher dans les fonctionnalités</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('');
                event.currentTarget.blur();
              }
            }}
            placeholder={scope === 'business' ? 'Rechercher un outil métier…' : 'Rechercher un outil Studio…'}
            className="w-full bg-transparent px-2 py-2 text-[12.5px] text-white outline-none placeholder:text-slate-500"
            aria-label="Recherche rapide dans les fonctionnalités"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}
              className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-white/5 hover:text-white"
              aria-label="Effacer la recherche"
            >
              <X size={13} />
            </button>
          )}
        </label>
      </div>

      {!searching && (
        <div className="mt-3 px-1">
          <p className="mb-1.5 px-2 text-[9.5px] font-semibold uppercase tracking-[0.18em] text-slate-600">Accès rapides</p>
          <div className="grid grid-cols-3 gap-1">
            {shortcuts.map((shortcut) => {
              const item = groups.flatMap((group) => group.items).find((candidate) => candidate.to === shortcut.to);
              const isActive = item ? isNavItemActive(item, location.pathname, location.search) : false;
              return (
                <Link
                  key={shortcut.to}
                  to={shortcut.to}
                  onClick={onNavigate}
                  className={cn(
                    'flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-2 text-[9.5px] font-medium transition',
                    isActive
                      ? 'border-cyan-300/25 bg-cyan-400/[0.09] text-cyan-100'
                      : 'border-white/[0.05] bg-white/[0.02] text-slate-400 hover:border-white/15 hover:text-white',
                  )}
                >
                  <shortcut.icon size={14} />
                  <span className="truncate">{shortcut.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between px-2">
        <p className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-slate-600">
          {searching ? `${filtered.reduce((total, group) => total + group.items.length, 0)} résultat(s)` : 'Fonctionnalités'}
        </p>
        {!searching && (
          <button
            type="button"
            onClick={() => {
              const next = !allOpen;
              const state: Record<string, boolean> = {};
              for (const group of groups) state[group.id] = next;
              setOpen(state);
            }}
            className="min-h-8 rounded px-1.5 text-[9.5px] font-medium text-slate-500 transition hover:text-slate-200"
          >
            {allOpen ? 'Replier' : 'Tout déplier'}
          </button>
        )}
      </div>

      <nav aria-label={scope === 'business' ? 'Navigation Business Growth' : 'Navigation Studio'} className="relative mt-1 min-h-0 flex-1 overflow-y-auto pb-3 no-scrollbar">
        {filtered.length === 0 && (
          <div className="mx-2 mt-3 rounded-xl border border-dashed border-white/10 px-3 py-5 text-center">
            <p className="text-xs font-medium text-slate-300">Aucun outil trouvé</p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">Essayez « CRM », « vidéo », « stock » ou « assistant ».</p>
          </div>
        )}

        {filtered.map((group) => {
          const expanded = searching || open[group.id];
          const hasActive = group.items.some((item) => isNavItemActive(item, location.pathname, location.search));
          return (
            <section key={group.id} className="mb-0.5">
              <button
                type="button"
                onClick={() => setOpen((current) => ({ ...current, [group.id]: !current[group.id] }))}
                aria-expanded={expanded}
                className={cn(
                  'group flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left transition',
                  hasActive ? 'text-white' : 'text-slate-400 hover:bg-white/[0.03] hover:text-slate-200',
                )}
              >
                <group.icon size={13} className={cn('shrink-0', hasActive ? 'text-cyan-300' : 'text-slate-600')} />
                <span className="min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-[0.12em]">{group.label}</span>
                {hasActive && !expanded && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-300" />}
                <ChevronDown size={13} className={cn('shrink-0 text-slate-600 transition-transform duration-200', expanded && 'rotate-180')} />
              </button>

              {expanded && (
                <div className="mb-1.5 space-y-0.5 pl-1">
                  {group.items.map((item) => {
                    const isActive = isNavItemActive(item, location.pathname, location.search);
                    return (
                      <Link
                        key={`${group.id}:${item.to}`}
                        to={item.to}
                        onClick={onNavigate}
                        aria-current={isActive ? 'page' : undefined}
                        title={item.description}
                        className={cn(
                          'group/item relative flex min-h-10 items-center gap-2 rounded-lg px-2.5 text-[12px] transition-all duration-200',
                          isActive
                            ? 'bg-gradient-to-r from-cyan-400/[0.12] to-transparent font-semibold text-white'
                            : 'text-slate-400 hover:bg-white/[0.035] hover:text-white',
                        )}
                      >
                        <span className={cn(
                          'grid h-6 w-6 shrink-0 place-items-center rounded-md border transition',
                          isActive
                            ? 'border-cyan-300/25 bg-cyan-300/10 text-cyan-200'
                            : 'border-transparent text-slate-500 group-hover/item:text-slate-300',
                        )}>
                          <item.icon size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{item.label}</span>
                          {(isActive || searching) && (
                            <span className="mt-0.5 block truncate text-[10px] font-normal text-slate-500">{item.description}</span>
                          )}
                        </span>
                        {item.badge && (
                          <span className={cn(
                            'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide',
                            isActive
                              ? 'border-cyan-300/25 bg-cyan-300/10 text-cyan-100'
                              : 'border-white/[0.07] bg-white/[0.03] text-slate-500',
                          )}>
                            {item.badge}
                          </span>
                        )}
                        {isActive && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-cyan-300" />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </nav>

      {onRequestClose && (
        <button
          type="button"
          onClick={onRequestClose}
          className="mt-2 min-h-11 rounded-xl border border-white/[0.07] px-3 text-xs font-medium text-slate-400 transition hover:bg-white/5 hover:text-white lg:hidden"
        >
          Fermer le menu
        </button>
      )}
    </div>
  );
}
