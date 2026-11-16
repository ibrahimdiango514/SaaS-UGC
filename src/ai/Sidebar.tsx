import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BookOpen, ChevronLeft, ChevronRight, Compass, Image as ImageIcon, MessageSquarePlus,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plug, Search, Settings, Sparkles,
  Trash2, TrendingUp, User, X,
} from 'lucide-react';
import type { AiConversation } from './api';
import { cn } from '../components/ui';
import { useAuth } from '../context/AuthContext';

/**
 * Barre latérale de l'espace assistant.
 *
 * Repliable sur desktop (rail d'icônes), tiroir sur mobile. L'état de repli est
 * mémorisé localement : c'est une préférence d'affichage, pas une donnée
 * sensible.
 */
export function Sidebar({
  collapsed,
  onToggle,
  groups,
  activeId,
  query,
  onQuery,
  onSelect,
  onNew,
  onDelete,
  loading,
  onCloseMobile,
}: {
  collapsed: boolean;
  onToggle: () => void;
  groups: Array<{ label: string; items: AiConversation[] }>;
  activeId: string | null;
  query: string;
  onQuery: (value: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  loading: boolean;
  onCloseMobile?: () => void;
}) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [menuOuvert, setMenuOuvert] = useState<string | null>(null);

  const nom = profile?.display_name?.trim() || user?.email?.split('@')[0] || 'Mon compte';
  const initiale = nom.charAt(0).toUpperCase();

  const creer = () => {
    onNew();
    onCloseMobile?.();
    navigate('/app/ai');
  };

  return (
    <aside
      className={cn('vy-rail shrink-0', collapsed ? 'w-[68px]' : 'w-[264px]')}
      aria-label="Navigation de l’assistant"
    >
      {/* En-tête : logo + repli */}
      <div className="flex items-center gap-2 px-3 py-3">
        <Link
          to="/app/ai"
          className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1"
          aria-label="VYORA AI — accueil"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-accent shadow-glow">
            <Sparkles size={17} className="text-ink" />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block font-display text-sm font-semibold tracking-tight text-white">
                VYORA<span className="text-brand-300"> AI</span>
              </span>
              <span className="block text-[0.62rem] uppercase tracking-[0.18em] text-slate-500">
                assistant
              </span>
            </span>
          )}
        </Link>

        <span className="flex-1" />

        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="hidden rounded-lg p-1.5 text-slate-500 transition hover:bg-white/10 hover:text-white lg:block"
            aria-label="Réduire la barre latérale"
            title="Réduire"
          >
            <PanelLeftClose size={17} />
          </button>
        )}
        {onCloseMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Fermer le menu"
          >
            <X size={17} />
          </button>
        )}
      </div>

      {collapsed && (
        <button
          type="button"
          onClick={onToggle}
          className="mx-auto mb-1 hidden rounded-lg p-1.5 text-slate-500 hover:bg-white/10 hover:text-white lg:block"
          aria-label="Agrandir la barre latérale"
          title="Agrandir"
        >
          <PanelLeftOpen size={17} />
        </button>
      )}

      {/* Action principale */}
      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={creer}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl border border-brand-400/30 bg-brand-500/[0.12] px-2.5 py-2.5 text-sm font-medium text-brand-100 transition hover:border-brand-400/60 hover:bg-brand-500/20',
            collapsed && 'justify-center px-0',
          )}
          title="Nouvelle conversation"
        >
          <MessageSquarePlus size={17} className="shrink-0" />
          {!collapsed && <span>Nouveau chat</span>}
        </button>
      </div>

      {/* Navigation courte */}
      <nav className="space-y-0.5 px-2.5" aria-label="Sections">
        <RailLink to="/app/ai/images" icon={<ImageIcon size={16} />} label="Images" collapsed={collapsed} onClick={onCloseMobile} />
        <RailLink to="/app/bibliotheque" icon={<BookOpen size={16} />} label="Bibliothèque" collapsed={collapsed} onClick={onCloseMobile} />
        <RailLink to="/app/connect" icon={<Plug size={16} />} label="Intégrations" collapsed={collapsed} onClick={onCloseMobile} />
        <RailLink to="/app/ai/explorer" icon={<Compass size={16} />} label="Explorer" collapsed={collapsed} onClick={onCloseMobile} />
        <RailLink to="/app/business" icon={<TrendingUp size={16} />} label="Espace Business" collapsed={collapsed} onClick={onCloseMobile} />
      </nav>

      {!collapsed && (
        <>
          <div className="mt-3 px-2.5">
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                type="search"
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                placeholder="Rechercher…"
                aria-label="Rechercher dans les conversations"
                className="w-full rounded-lg border border-line bg-white/[0.04] py-1.5 pl-8 pr-2 text-xs text-white placeholder:text-slate-500 outline-none transition focus:border-brand-400/50 focus:bg-white/[0.06]"
              />
            </div>
          </div>

          <div className="vy-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
            {loading && (
              <div className="space-y-1.5 px-1 py-2" aria-busy="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-7 animate-pulse rounded-lg bg-white/[0.04]" />
                ))}
              </div>
            )}

            {!loading && groups.length === 0 && (
              <p className="px-2 py-3 text-xs leading-relaxed text-slate-500">
                {query
                  ? 'Aucune conversation ne correspond.'
                  : 'Aucune conversation pour l’instant. Commencez par écrire un message.'}
              </p>
            )}

            {groups.map((groupe) => (
              <div key={groupe.label} className="mb-2">
                <p className="px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                  {groupe.label}
                </p>
                <ul className="space-y-0.5">
                  {groupe.items.map((conversation) => (
                    <li key={conversation.id} className="group/item relative">
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(conversation.id);
                          onCloseMobile?.();
                        }}
                        data-active={activeId === conversation.id}
                        className="vy-conversation"
                        title={conversation.title ?? 'Sans titre'}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {conversation.title || 'Sans titre'}
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuOuvert(menuOuvert === conversation.id ? null : conversation.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.stopPropagation();
                              setMenuOuvert(menuOuvert === conversation.id ? null : conversation.id);
                            }
                          }}
                          className="rounded p-0.5 text-slate-500 opacity-0 transition hover:text-white focus:opacity-100 group-hover/item:opacity-100"
                          aria-label={`Options pour ${conversation.title ?? 'cette conversation'}`}
                        >
                          <MoreHorizontal size={14} />
                        </span>
                      </button>

                      {menuOuvert === conversation.id && (
                        <div className="absolute right-1 top-full z-10 mt-0.5 rounded-lg border border-line bg-panel2 p-1 shadow-card">
                          <button
                            type="button"
                            onClick={() => {
                              onDelete(conversation.id);
                              setMenuOuvert(null);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/15"
                          >
                            <Trash2 size={12} />
                            Supprimer
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}

      {collapsed && <div className="flex-1" />}

      {/* Pied : profil + paramètres */}
      <div className="mt-auto border-t border-line p-2.5">
        <Link
          to="/app/parametres"
          className={cn('vy-nav-item', collapsed && 'justify-center px-0')}
          title="Paramètres"
          onClick={onCloseMobile}
        >
          <Settings size={16} />
          {!collapsed && <span>Paramètres</span>}
        </Link>
        <div
          className={cn(
            'mt-1 flex items-center gap-2.5 rounded-lg px-1.5 py-1.5',
            collapsed && 'justify-center',
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent text-[0.7rem] font-bold text-ink">
            {initiale}
          </span>
          {!collapsed && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-slate-200">{nom}</span>
              <span className="block truncate text-[0.62rem] text-slate-500">
                {user?.email ?? 'connecté'}
              </span>
            </span>
          )}
          {!collapsed && <User size={13} className="text-slate-600" />}
        </div>
      </div>
    </aside>
  );
}

function RailLink({
  to, icon, label, collapsed, onClick,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      to={to}
      className={cn('vy-nav-item', collapsed && 'justify-center px-0')}
      title={label}
      onClick={onClick}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
      {!collapsed && <ChevronRight size={13} className="ml-auto text-slate-600" />}
      {collapsed && <ChevronLeft size={0} aria-hidden="true" />}
    </Link>
  );
}
