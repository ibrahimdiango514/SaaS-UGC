import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BookOpen, Check, ChevronLeft, ChevronRight, Image as ImageIcon, Link2, MessageSquarePlus,
  MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plug, Search, Settings, Sparkles,
  Server, Trash2, TrendingUp, User, X,
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
  onRename,
  loading,
  onCloseMobile,
  embedded = false,
  onNavigateSection,
  fillHeight = false,
  newLabel = 'Nouveau chat',
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
  /**
   * Renommage d'une conversation. Absent, l'action n'est pas proposée — plutôt
   * qu'un bouton qui ne ferait rien.
   */
  onRename?: (id: string, title: string) => void;
  loading: boolean;
  onCloseMobile?: () => void;
  /**
   * Intégré à SORAHNEX Grow : la barre ne propose plus de liens vers d'autres
   * espaces de l'application. Sinon, embarquée dans l'onglet Assistant, elle
   * réafficherait « Espace Business », « Explorer », « Images »… et
   * reconstituerait la navigation globale que SORAHNEX Grow possède déjà —
   * exactement le deuxième espace métier qu'on veut éviter.
   */
  embedded?: boolean;
  /** En mode intégré, navigue vers une rubrique de SORAHNEX Grow. */
  onNavigateSection?: (section: 'chat' | 'integrations') => void;
  /**
   * En mode intégré, la barre occupe la hauteur imposée par son conteneur au
   * lieu de coller au viewport : SORAHNEX Grow l'héberge dans une carte.
   */
  fillHeight?: boolean;
  /** Libellé de l'action principale, selon l'espace hôte. */
  newLabel?: string;
}) {
  const navigate = useNavigate();
  const { user, profile } = useAuth();
  const [menuOuvert, setMenuOuvert] = useState<string | null>(null);
  const [renommageId, setRenommageId] = useState<string | null>(null);
  // Supprimer une conversation n'est pas réversible : on demande confirmation,
  // comme le faisait l'interface précédente de SORAHNEX Grow.
  const [suppressionId, setSuppressionId] = useState<string | null>(null);
  const [titreDraft, setTitreDraft] = useState('');

  const nom = profile?.display_name?.trim() || user?.email?.split('@')[0] || 'Mon compte';
  const initiale = nom.charAt(0).toUpperCase();

  const creer = () => {
    onNew();
    onCloseMobile?.();
    // Embarquée dans le Growth OS, la création reste dans l'espace courant :
    // naviguer vers /app/ai ferait sortir l'utilisateur du nouveau Business
    // Growth et rouvrirait l'ancien espace assistant.
    if (!embedded) navigate('/app/ai');
  };

  return (
    <aside
      className={cn(
        'vy-rail shrink-0',
        collapsed ? 'w-[68px]' : 'w-[264px]',
        // Hébergée dans une carte de SORAHNEX Grow, la barre prend la hauteur
        // du conteneur au lieu de celle du viewport.
        fillHeight && 'h-full',
      )}
      aria-label="Navigation de l’assistant"
    >
      {/* En-tête : logo + repli */}
      <div className="flex items-center gap-2 px-3 py-3">
        <Link
          to={embedded ? '/app/business' : '/app/ai'}
          className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1"
          aria-label={embedded ? 'SORAHNEX Business — assistant' : 'SORAHNEX AI — accueil'}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-accent shadow-glow">
            <Sparkles size={17} className="text-ink" />
          </span>
          {!collapsed && (
            <span className="min-w-0">
              <span className="block font-display text-sm font-semibold tracking-tight text-white">
                SORAHNEX<span className="text-brand-300"> AI</span>
              </span>
              <span className="block text-[0.62rem] uppercase tracking-[0.18em] text-slate-500">
                {embedded ? 'business' : 'assistant'}
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
          title={newLabel}
        >
          <MessageSquarePlus size={17} className="shrink-0" />
          {!collapsed && <span>{newLabel}</span>}
        </button>
      </div>

      {/* Navigation courte.
          En mode intégré, on n'expose QUE ce qui appartient à SORAHNEX Grow.
          Les autres rubriques métier restent dans la navigation de Business
          SORAHNEX Grow, juste à côté : pas de doublon. */}
      {embedded ? (
        <nav className="space-y-0.5 px-2.5" aria-label="Rubriques de l’assistant">
          <SectionLink
            icon={<Plug size={16} />}
            label="Intégrations"
            description="Ouvrir les intégrations de SORAHNEX Grow"
            collapsed={collapsed}
            onClick={() => {
              onNavigateSection?.('integrations');
              onCloseMobile?.();
            }}
          />
        </nav>
      ) : (
        <nav className="space-y-0.5 px-2.5" aria-label="Sections">
          {/* « Images » menait à /app/ai/images, route jamais déclarée : le clic
              affichait la page 404. Les images de référence sont gérées par
              l'écran « Mes avatars » (JPG/PNG, présentateur ou produit). */}
          <RailLink to="/app/avatars" icon={<ImageIcon size={16} />} label="Images de référence" collapsed={collapsed} onClick={onCloseMobile} />
          <RailLink to="/app/bibliotheque" icon={<BookOpen size={16} />} label="Bibliothèque" collapsed={collapsed} onClick={onCloseMobile} />
          <RailLink to="/app/connect" icon={<Plug size={16} />} label="Intégrations" collapsed={collapsed} onClick={onCloseMobile} />
          <RailLink to="/app/connexions-ia" icon={<Sparkles size={16} />} label="MCP et connexions IA" collapsed={collapsed} onClick={onCloseMobile} />
          <RailLink to="/app/mes-serveurs-mcp" icon={<Server size={16} />} label="Mes serveurs MCP" collapsed={collapsed} onClick={onCloseMobile} />
          {/* Entrée unifiée : les deux sens du protocole sur un seul écran,
              chacun dans sa section. Les deux entrées ci-dessus restent pour
              ceux qui arrivent par un lien direct. */}
          <RailLink to="/app/connexions-mcp" icon={<Link2 size={16} />} label="Connexions MCP" collapsed={collapsed} onClick={onCloseMobile} />
          <RailLink to="/app/business" icon={<TrendingUp size={16} />} label="Espace Business" collapsed={collapsed} onClick={onCloseMobile} />
        </nav>
      )}

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
              // `embedded` : vocabulaire de SORAHNEX Grow. Sinon, celui de
              // l'espace assistant autonome, qui a ses propres tests.
              embedded ? (
                <div className="rounded-xl border border-dashed border-white/[0.10] px-3 py-6 text-center">
                  <MessageSquarePlus size={18} className="mx-auto text-slate-600" />
                  <p className="mt-2 text-xs font-medium text-slate-400">
                    {query ? 'Aucune conversation ne correspond' : 'Aucune conversation enregistrée'}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                    {query ? 'Essayez un autre mot-clé.' : 'Créez une conversation pour commencer.'}
                  </p>
                </div>
              ) : (
                <p className="px-2 py-3 text-xs leading-relaxed text-slate-500">
                  {query
                    ? 'Aucune conversation ne correspond.'
                    : 'Aucune conversation pour l’instant. Commencez par écrire un message.'}
                </p>
              )
            )}

            {groups.map((groupe) => (
              <div key={groupe.label} className="mb-2">
                <p className="px-2 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-slate-600">
                  {groupe.label}
                </p>
                <ul className="space-y-0.5">
                  {groupe.items.map((conversation) => (
                    <li key={conversation.id} className="group/item relative">
                      {renommageId === conversation.id && onRename ? (
                        <form
                          className="flex items-center gap-1 rounded-lg border border-line bg-white/[0.06] px-1.5 py-1"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const titre = titreDraft.trim();
                            if (titre) onRename(conversation.id, titre);
                            setRenommageId(null);
                          }}
                        >
                          <input
                            autoFocus
                            value={titreDraft}
                            onChange={(event) => setTitreDraft(event.target.value)}
                            aria-label="Nouveau titre de conversation"
                            className="min-w-0 flex-1 bg-transparent px-1 py-0.5 text-xs text-white outline-none"
                          />
                          <button
                            type="submit"
                            aria-label="Enregistrer le titre"
                            disabled={!titreDraft.trim()}
                            className="rounded p-0.5 text-emerald-300 hover:bg-white/10 disabled:opacity-40"
                          >
                            <Check size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenommageId(null)}
                            aria-label="Annuler le renommage"
                            className="rounded p-0.5 text-slate-400 hover:bg-white/10"
                          >
                            <X size={12} />
                          </button>
                        </form>
                      ) : (
                      <>
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
                        <span className="min-w-0 flex-1 truncate pr-5">
                          {conversation.title || 'Sans titre'}
                        </span>
                      </button>

                      {/* Actions séparées du bouton de sélection : les imbriquer
                          produisait un HTML invalide et deux nœuds accessibles
                          portant le même nom. */}
                      <span className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition focus-within:opacity-100 group-hover/item:opacity-100">
                        {onRename && (
                          <button
                            type="button"
                            onClick={() => {
                              setRenommageId(conversation.id);
                              setTitreDraft(conversation.title ?? '');
                            }}
                            className="rounded p-0.5 text-slate-400 hover:text-violet-300"
                            aria-label="Renommer la conversation"
                            title="Renommer"
                          >
                            <Pencil size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setSuppressionId(conversation.id)}
                          className="rounded p-0.5 text-slate-400 hover:text-rose-300"
                          aria-label="Supprimer la conversation"
                          title="Supprimer"
                        >
                          <Trash2 size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setMenuOuvert(menuOuvert === conversation.id ? null : conversation.id)}
                          className="rounded p-0.5 text-slate-400 hover:text-white"
                          aria-label="Actions de la conversation"
                          title="Actions"
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </span>
                      </>)}

                      {suppressionId === conversation.id && (
                        <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-2 py-1.5 text-[11px]">
                          <span className="text-rose-200">Supprimer cette conversation ?</span>
                          <span className="flex gap-1">
                            <button
                              type="button"
                              aria-label="Confirmer la suppression"
                              onClick={() => {
                                onDelete(conversation.id);
                                setSuppressionId(null);
                              }}
                              className="rounded px-1.5 py-0.5 text-rose-200 hover:bg-rose-500/15"
                            >
                              Oui
                            </button>
                            <button
                              type="button"
                              aria-label="Annuler la suppression"
                              onClick={() => setSuppressionId(null)}
                              className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-white/10"
                            >
                              Non
                            </button>
                          </span>
                        </div>
                      )}

                      {menuOuvert === conversation.id && (
                        <div className="absolute right-1 top-full z-10 mt-0.5 rounded-lg border border-line bg-panel2 p-1 shadow-card">
                          {onRename && (
                            <button
                              type="button"
                              onClick={() => {
                                setRenommageId(conversation.id);
                                setTitreDraft(conversation.title ?? '');
                                setMenuOuvert(null);
                              }}
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-200 hover:bg-white/10"
                            >
                              <Pencil size={12} />
                              Renommer la conversation
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setSuppressionId(conversation.id);
                              setMenuOuvert(null);
                            }}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/15"
                          >
                            <Trash2 size={12} />
                            Supprimer la conversation
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
          title={embedded ? 'Paramètres du compte' : 'Paramètres'}
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

/**
 * Lien de rubrique interne (mode intégré) : déclenche un changement de section
 * dans SORAHNEX Grow au lieu d'une navigation de route.
 */
function SectionLink({
  icon, label, collapsed, onClick, description,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onClick: () => void;
  /**
   * Texte du `title` quand le libellé seul serait ambigu. Deux boutons
   * « Intégrations » à l'écran (la rubrique métier et ce raccourci) porteraient
   * le même nom accessible ; on les distingue, on ne les duplique pas.
   */
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('vy-nav-item w-full', collapsed && 'justify-center px-0')}
      title={description ?? label}
      // Le nom accessible porte la description : la rubrique « Intégrations »
      // de SORAHNEX Grow existe déjà juste à côté, deux boutons homonymes
      // rendraient le choix ambigu.
      aria-label={description ?? label}
    >
      {icon}
      {!collapsed && <span>{label}</span>}
      {!collapsed && <ChevronRight size={13} className="ml-auto text-slate-600" />}
    </button>
  );
}
