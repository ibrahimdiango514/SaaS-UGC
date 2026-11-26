import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Lock, Menu, Sparkles, X } from 'lucide-react';
import { cn } from '../components/ui';
import { PortalOverlay } from '../components/PortalOverlay';
import { SpaceSwitcher } from '../components/SpaceSwitcher';
import { MoteurIaDiagnostic } from '../business/ai/MoteurIaDiagnostic';
import { AGENT_SPACE_NAV, type AgentSpaceSection } from './agentSpace';

/**
 * Coquille de l'espace Agent IA.
 *
 * ## Identité propre
 * L'espace Agent n'est pas un onglet de SORAHNEX Grow : il a sa propre teinte
 * (cyan, comme le Studio) et sa propre navigation (Conversation, Historique,
 * Capacités). Il reste relié à Grow : il lit ses données et agit sur elles.
 *
 * ## Mobile d'abord
 * La barre de navigation basse de l'application est masquée dans cet espace
 * (voir `Layout`) : la conversation occupe la hauteur, et la navigation propre
 * de l'espace tient dans une barre haute à défilement horizontal, au-dessus de
 * la zone de saisie.
 *
 * ## Défaut Android évité
 * Le panneau mobile passe par `PortalOverlay` : la racine de l'espace porte
 * `animate-fadeUp`, dont le `fill-mode: both` laisse un `transform` actif. Sans
 * portail, le panneau se dimensionnerait sur le conteneur et non sur l'écran.
 */
export function AgentSpaceLayout({
  active, children, workspaceName, locked = false,
}: {
  active: AgentSpaceSection;
  children: ReactNode;
  workspaceName: string | null;
  /** Sans abonnement Grow : l'espace affiche son contenu verrouillé. */
  locked?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const precedent = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const surTouche = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', surTouche);
    return () => {
      document.body.style.overflow = precedent;
      document.removeEventListener('keydown', surTouche);
    };
  }, [menuOpen]);

  const navigation = (onNavigate?: () => void) => (
    <nav aria-label="Navigation de l’espace Agent" className="space-y-0.5">
      {AGENT_SPACE_NAV.map((item) => (
        <Link
          key={item.key}
          to={item.path}
          onClick={onNavigate}
          aria-current={item.key === active ? 'page' : undefined}
          className={cn(
            'flex min-h-11 flex-col justify-center rounded-xl px-2.5 py-1.5 text-[12.5px] transition',
            item.key === active
              ? 'bg-gradient-to-r from-cyan-400/20 to-transparent font-semibold text-white shadow-[inset_0_0_0_1px_rgba(34,211,238,0.2)]'
              : 'text-slate-400 hover:bg-white/[0.04] hover:text-white',
          )}
        >
          <span className="truncate">{item.label}</span>
          <span className="truncate text-[10px] font-normal text-slate-500">{item.description}</span>
        </Link>
      ))}
      <div className="mt-3 space-y-0.5 border-t border-white/[0.07] pt-3">
        <Link
          to="/app/business"
          onClick={onNavigate}
          className="flex min-h-11 items-center gap-2 rounded-xl px-2.5 text-[12px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white"
        >
          SORAHNEX Grow
        </Link>
        <Link
          to="/app/business/abonnement"
          onClick={onNavigate}
          className="flex min-h-11 items-center gap-2 rounded-xl px-2.5 text-[12px] text-slate-400 transition hover:bg-white/[0.04] hover:text-white"
        >
          Formule SORAHNEX Grow
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="animate-fadeUp min-w-0" data-testid="agent-space" data-section={active}>
      {/* Barre mobile : identité de l'espace + accès au panneau. */}
      <div className="sticky top-16 z-20 -mx-1 mb-3 flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-[#070c13]/95 px-3 py-2.5 backdrop-blur-xl md:hidden">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-cyan-400/15 text-cyan-200 ring-1 ring-cyan-300/25">
          <Sparkles size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80">SORAHNEX Agent IA</p>
          <p className="truncate text-[13px] font-semibold text-white">
            {AGENT_SPACE_NAV.find((item) => item.key === active)?.label ?? 'Conversation'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Ouvrir le menu de l’espace Agent"
          aria-expanded={menuOpen}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11px] font-medium text-slate-200"
        >
          <Menu size={14} /> Menu
        </button>
      </div>

      {menuOpen && (
        <PortalOverlay>
          <div
            className="fixed inset-0 z-50 flex justify-start overflow-x-hidden md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Menu de l’espace Agent"
          >
            <button
              type="button"
              aria-label="Fermer le menu"
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setMenuOpen(false)}
            />
            <div className="relative flex h-full w-[min(86vw,320px)] max-w-full flex-col overflow-y-auto overscroll-contain bg-[#070c13] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)] shadow-2xl">
              <div className="mb-4 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-cyan-200/80">SORAHNEX</p>
                  <p className="text-sm font-semibold text-white">Agent IA</p>
                  <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName ?? 'Aucune entreprise active'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setMenuOpen(false)}
                  aria-label="Fermer"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-white/10 p-2 text-slate-300"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="mb-4"><SpaceSwitcher scope="agent" /></div>
              {navigation(() => setMenuOpen(false))}
            </div>
          </div>
        </PortalOverlay>
      )}

      <div className="grid gap-4 md:grid-cols-[212px_minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)]">
        <aside className="hidden min-w-0 md:block">
          <div className="sticky top-[4.5rem] max-h-[calc(100vh-5.5rem)] overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.07] bg-[#070c13]/85 p-3 backdrop-blur-xl no-scrollbar">
            <div className="mb-4 px-1">
              <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-cyan-200/80">SORAHNEX</p>
              <p className="mt-0.5 font-display text-[15px] font-semibold text-white">Agent IA</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-500">{workspaceName ?? 'Aucune entreprise active'}</p>
            </div>
            <div className="mb-4"><SpaceSwitcher scope="agent" compact /></div>
            {navigation()}
          </div>
        </aside>

        <main className="min-w-0 overflow-x-hidden">
          <header className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#080a12] px-4 py-4 sm:px-5">
            <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-cyan-400/15 blur-[70px]" />
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/40 to-transparent" />
            <div className="relative flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[9.5px] font-semibold uppercase tracking-[0.2em] text-cyan-200/85">
                  SORAHNEX Agent IA · {AGENT_SPACE_NAV.find((item) => item.key === active)?.label}
                </p>
                <h1 className="mt-1 font-display text-[1.35rem] font-semibold leading-tight text-white sm:text-[1.6rem]">
                  {AGENT_SPACE_NAV.find((item) => item.key === active)?.label}
                </h1>
                <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-slate-400">
                  {AGENT_SPACE_NAV.find((item) => item.key === active)?.description}
                </p>
              </div>
              {locked ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300/25 bg-amber-300/[0.08] px-2.5 py-1 text-[10px] text-amber-200">
                  <Lock size={11} /> Abonnement requis
                </span>
              ) : null}
            </div>
          </header>

          {/* État du moteur : la cause exacte, jamais un « indisponible » muet. */}
          <div className="mt-3"><MoteurIaDiagnostic variante="agent" /></div>

          <div className="mt-3 min-w-0 space-y-4">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** Barre de navigation basse de l'espace (mobile), au-dessus du clavier. */
export function AgentSpaceTabs({ active }: { active: AgentSpaceSection }) {
  return (
    <nav
      aria-label="Sections de l’espace Agent"
      className="safe-bottom flex items-stretch gap-1 rounded-xl border border-white/[0.07] bg-white/[0.02] p-1 md:hidden"
    >
      {AGENT_SPACE_NAV.map((item) => (
        <NavLink
          key={item.key}
          to={item.path}
          aria-current={item.key === active ? 'page' : undefined}
          className={cn(
            'flex min-h-11 flex-1 items-center justify-center rounded-lg px-1 text-center text-[11px] font-medium transition',
            item.key === active ? 'bg-cyan-400/[0.14] text-cyan-100' : 'text-slate-400',
          )}
        >
          {item.shortLabel}
        </NavLink>
      ))}
    </nav>
  );
}
