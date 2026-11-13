import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell, BookOpen, Brain, ChevronDown, Clapperboard, Coins, CreditCard, FolderKanban,
  History, LayoutDashboard, LogOut, Menu, Search, Settings, Shield, Sparkles,
  Users, Wand2, X, CheckCheck, SlidersHorizontal, type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { asAppError } from '../lib/errors';
import { initials, relativeDate, truncate } from '../lib/format';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../lib/api';
import type { AppNotification } from '../lib/types';
import { BrandLockup, BrandSymbol } from './Brand';
import { Badge, Button, cn, LoadingState } from './ui';

interface NavItem { to: string; label: string; icon: LucideIcon; end?: boolean }
const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Espace', items: [
    { to: '/app', label: 'Tableau de bord', icon: LayoutDashboard, end: true },
    { to: '/app/projets', label: 'Projets', icon: FolderKanban },
  ] },
  { label: 'Modules', items: [
    { to: '/app/studio', label: 'Studio UGC', icon: Clapperboard },
    { to: '/app/business', label: 'Business Grow', icon: Brain },
    { to: '/app/business/abonnement', label: 'Formules Business Grow', icon: CreditCard },
  ] },
  { label: 'Ressources', items: [
    { to: '/app/avatars', label: 'Avatars', icon: Users },
    { to: '/app/scripts', label: 'Scripts IA', icon: Wand2 },
    { to: '/app/prompts', label: 'Prompts', icon: BookOpen },
    { to: '/app/presets', label: 'Réglages vidéo', icon: SlidersHorizontal },
    { to: '/app/bibliotheque', label: 'Bibliothèque', icon: Sparkles },
    { to: '/app/historique', label: 'Historique', icon: History },
  ] },
  { label: 'Compte', items: [
    { to: '/app/abonnement', label: 'Abonnement', icon: CreditCard },
    { to: '/app/parametres', label: 'Paramètres', icon: Settings },
  ] },
];

const NAV: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
const MOBILE_NAV = NAV.filter((item) =>
  ['/app', '/app/projets', '/app/studio', '/app/business', '/app/historique'].includes(item.to),
);

function Logo({ compact = false, to = '/app' }: { compact?: boolean; to?: string }) {
  return (
    <NavLink to={to} aria-label="VYORA, tableau de bord" className="flex items-center gap-2.5">
      {compact ? <BrandSymbol size={36} /> : <BrandLockup tagline />}
    </NavLink>
  );
}

export default function Layout() {
  const { user, profile, quota, isAdmin, loading, logout, refreshQuota } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // Le Studio est un canvas immersif : sur cette route, la navigation globale
  // (barre latérale + en-tête) est remplacée par la barre de catégories du
  // Studio, à toutes les tailles d'écran. Les autres pages gardent la coque.
  const studioCanvas = location.pathname === '/app/studio';
  const navGroups = isAdmin
    ? [{ label: 'Administration', items: [{ to: '/admin', label: 'Administration', icon: Shield, end: true }] }]
    : NAV_GROUPS;
  const mobileNav = isAdmin
    ? [{ to: '/admin', label: 'Administration', icon: Shield, end: true }]
    : MOBILE_NAV;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [markingNotificationId, setMarkingNotificationId] = useState<string | null>(null);
  const [markingAllNotifications, setMarkingAllNotifications] = useState(false);
  const [quotaRefreshing, setQuotaRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const notifRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const notificationItems = Array.isArray(notifications) ? notifications : [];
  const unread = notificationItems.filter((n) => !n.read_at).length;

  const loadNotifications = useCallback(async (showLoading = false) => {
    if (showLoading) setNotificationsLoading(true);
    try {
      const result = await listNotifications();
      if (!Array.isArray(result)) throw new Error('Réponse de notifications invalide.');
      setNotifications(result);
      setNotificationsError(null);
    } catch (error) {
      setNotificationsError(asAppError(error, 'Impossible de charger les notifications.').message);
    } finally {
      if (showLoading) setNotificationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadNotifications(true);
    const id = window.setInterval(() => void loadNotifications(), 60000);
    return () => window.clearInterval(id);
  }, [user, loadNotifications]);

  useEffect(() => { setDrawerOpen(false); setNotifOpen(false); setUserOpen(false); }, [location.pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const onMarkRead = async (n: AppNotification) => {
    if (markingNotificationId || markingAllNotifications) return;
    setMarkingNotificationId(n.id);
    try {
      const marked = await markNotificationRead(n.id);
      if (!marked) throw new Error('Impossible de marquer cette notification comme lue.');
      setNotifications((list) => list.map((x) => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
    } catch (error) { toast.error(asAppError(error).message); }
    finally { setMarkingNotificationId(null); }
  };

  const onMarkAll = async () => {
    if (markingAllNotifications || markingNotificationId || unread === 0) return;
    setMarkingAllNotifications(true);
    try {
      await markAllNotificationsRead();
      setNotifications((list) => list.map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() })));
    } catch (error) { toast.error(asAppError(error).message); }
    finally { setMarkingAllNotifications(false); }
  };

  const onRefreshQuota = async () => {
    if (quotaRefreshing) return;
    setQuotaRefreshing(true);
    try {
      if (await refreshQuota()) toast.success('Solde actualisé.');
      else toast.error('Impossible d’actualiser le solde. Réessayez.');
    } finally {
      setQuotaRefreshing(false);
    }
  };

  const onLogout = async () => {
    try { await logout(); navigate('/'); toast.success('Vous êtes déconnecté.'); }
    catch (error) { toast.error(asAppError(error).message); }
  };

  if (loading) return <div className="grid min-h-screen place-items-center"><LoadingState label="Préparation de votre espace…" /></div>;

  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'Mon compte';

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar — masquée sur le canvas immersif du Studio. */}
      <aside className={cn('relative sticky top-0 hidden h-screen w-[252px] shrink-0 flex-col overflow-hidden border-r border-white/[0.06] bg-[#070c13]/95 px-3 py-5 backdrop-blur-2xl lg:flex', studioCanvas && 'lg:hidden')}>
        <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full bg-cyan-400/[0.10] blur-[80px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-16 h-64 w-64 rounded-full bg-violet-500/[0.10] blur-[80px]" />
        <div className="relative px-2 pb-6">
          <Logo to={isAdmin ? '/admin' : '/app'} />
          <p className="mt-1.5 pl-[46px] text-[10px] font-medium uppercase tracking-[0.2em] text-slate-600">Create · Evolve · Grow</p>
        </div>
        <nav className="relative flex-1 space-y-5 overflow-y-auto no-scrollbar">
          {navGroups.map((group) => (
            <section key={group.label}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end}
                    className={({ isActive }) => cn('nav-link py-2', isActive && 'nav-link-active')}>
                    <item.icon size={17} /> {item.label}
                  </NavLink>
                ))}
              </div>
            </section>
          ))}
        </nav>
        {!isAdmin && <div className="relative mt-4 overflow-hidden rounded-2xl border border-cyan-300/15 bg-gradient-to-br from-cyan-400/[0.10] via-panel/70 to-violet-500/[0.05] p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-100"><Coins size={14} /> Crédits Studio UGC</div>
          <p className="mt-1 text-2xl font-bold tracking-tight text-white">{quota?.credits ?? 0}</p>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-violet-400 transition-all duration-700"
              style={{ width: `${Math.min(100, Math.max(2, ((quota?.usage?.video ?? 0) / Math.max(1, quota?.plan?.max_videos_per_month ?? 1)) * 100))}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">{quota?.plan?.display_name ?? 'Formule'} · {quota?.usage?.video ?? 0}/{quota?.plan?.max_videos_per_month ?? 0} vidéos ce mois</p>
          <Button variant="outline" size="sm" className="mt-3 w-full" onClick={() => navigate('/app/abonnement')}>Gérer le Studio</Button>
        </div>}
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className={cn('sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-white/[0.06] bg-[#05080e]/80 px-4 backdrop-blur-2xl sm:px-6', studioCanvas && 'hidden')}>
          <button className="btn btn-ghost btn-icon lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Ouvrir le menu"><Menu size={20} /></button>
          <div className="lg:hidden"><Logo compact to={isAdmin ? '/admin' : '/app'} /></div>

          {!isAdmin && <form className="hidden max-w-md flex-1 items-center gap-2 rounded-xl border border-line bg-white/[0.025] px-3 py-2 md:flex"
            onSubmit={(e) => { e.preventDefault(); navigate(`/app/projets?q=${encodeURIComponent(search)}`); }}>
            <Search size={16} className="text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un projet…"
              className="w-full bg-transparent text-sm text-white outline-none placeholder:text-slate-500" />
          </form>}

          <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
            {!isAdmin && <button onClick={() => void onRefreshQuota()} disabled={quotaRefreshing}
              className="hidden items-center gap-1.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 sm:flex" title="Actualiser le solde">
              <Coins size={15} className="text-amber-300" /> {quota?.credits ?? 0}
            </button>}

            <div className="relative" ref={notifRef}>
              <button onClick={() => { setNotifOpen((v) => !v); setUserOpen(false); }} className="btn btn-ghost btn-icon relative" aria-label="Notifications">
                <Bell size={19} />
                {unread > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brand-500 px-1 text-[10px] font-bold text-white">{unread > 9 ? '9+' : unread}</span>}
              </button>
              {notifOpen && (
                <div className="absolute right-0 top-12 z-40 w-[min(92vw,360px)] overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl">
                  <div className="flex items-center justify-between border-b border-line px-4 py-3">
                    <p className="text-sm font-semibold text-white">Notifications</p>
                    <button onClick={() => void onMarkAll()} disabled={markingAllNotifications || markingNotificationId !== null || unread === 0} className="flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200 disabled:cursor-not-allowed disabled:opacity-50"><CheckCheck size={14} /> Tout lire</button>
                  </div>
                  <div className="max-h-[360px] overflow-y-auto">
                    {notificationsLoading && <p className="px-4 py-8 text-center text-sm text-slate-400" role="status">Chargement des notifications…</p>}
                    {!notificationsLoading && notificationsError && (
                      <div className="space-y-3 px-4 py-6 text-center" role="alert">
                        <p className="text-sm text-rose-200">{notificationsError}</p>
                        <button type="button" onClick={() => void loadNotifications(true)} className="text-xs text-brand-300 underline">Réessayer</button>
                      </div>
                    )}
                    {!notificationsLoading && !notificationsError && notificationItems.length === 0 && <p className="px-4 py-8 text-center text-sm text-slate-500">Aucune notification.</p>}
                    {!notificationsLoading && !notificationsError && notificationItems.map((n) => (
                      <button key={n.id} onClick={() => { void onMarkRead(n); if (n.href) navigate(n.href); }} disabled={markingAllNotifications || markingNotificationId !== null}
                        className={cn('block w-full border-b border-white/[0.06] px-4 py-3 text-left hover:bg-white/5', !n.read_at && 'bg-brand-500/5')}>
                        <div className="flex items-start gap-2">
                          {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-400" />}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-white">{n.title}</p>
                            <p className="mt-0.5 text-xs text-slate-400">{truncate(n.body, 110)}</p>
                            <p className="mt-1 text-[11px] text-slate-600">{relativeDate(n.created_at)}</p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative" ref={userRef}>
              <button onClick={() => { setUserOpen((v) => !v); setNotifOpen(false); }} className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.04] px-2 py-1.5">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-700 text-xs font-bold text-white">{initials(displayName, user?.email)}</span>
                <span className="hidden max-w-[130px] truncate text-sm font-medium text-white sm:block">{displayName}</span>
                <ChevronDown size={14} className="hidden text-slate-400 sm:block" />
              </button>
              {userOpen && (
                <div className="absolute right-0 top-12 z-40 w-56 rounded-2xl border border-line bg-panel p-2 shadow-2xl">
                  <div className="border-b border-line px-3 py-2">
                    <p className="truncate text-sm font-semibold text-white">{displayName}</p>
                    <p className="truncate text-xs text-slate-500">{user?.email}</p>
                    {isAdmin && <Badge tone="info" >Administrateur</Badge>}
                  </div>
                  {isAdmin
                    ? <button onClick={() => navigate('/admin')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5"><Shield size={15} /> Console d’administration</button>
                    : <>
                      <button onClick={() => navigate('/app/parametres')} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5"><Settings size={15} /> Paramètres</button>
                      <button onClick={() => navigate('/app/abonnement')} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-white/5"><CreditCard size={15} /> Abonnement</button>
                    </>}
                  <button onClick={() => void onLogout()} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10"><LogOut size={15} /> Déconnexion</button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className={cn('relative flex-1 px-4 sm:px-6 lg:pb-10 lg:pt-8', studioCanvas ? 'pb-0 pt-0' : 'pb-28 pt-6')}>
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(ellipse_at_50%_-20%,rgba(34,211,238,0.07),transparent_70%)]" />
          <div className="relative mx-auto w-full max-w-[1400px]"><Outlet /></div>
        </main>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm lg:hidden" onMouseDown={() => setDrawerOpen(false)}>
          <div className="flex h-full w-[min(88vw,300px)] flex-col border-r border-line bg-panel px-3 py-5" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-6 flex items-center justify-between px-2"><Logo to={isAdmin ? '/admin' : '/app'} /><button onClick={() => setDrawerOpen(false)} className="btn btn-ghost btn-icon"><X size={18} /></button></div>
            <nav className="flex-1 space-y-5 overflow-y-auto">
              {navGroups.map((group) => (
                <section key={group.label}>
                  <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">{group.label}</p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end}
                        className={({ isActive }) => cn('nav-link py-2', isActive && 'nav-link-active')}>
                        <item.icon size={17} /> {item.label}
                      </NavLink>
                    ))}
                  </div>
                </section>
              ))}
            </nav>
            {!isAdmin && <div className="mt-6 rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.06] p-3 text-sm">
              <p className="text-xs text-slate-400">Crédits Studio UGC</p>
              <p className="text-xl font-bold text-white">{quota?.credits ?? 0}</p>
            </div>}
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav className={cn('safe-bottom fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around border-t border-white/[0.07] bg-[#070c13]/95 px-1 pt-2 backdrop-blur-2xl', studioCanvas ? 'hidden' : 'lg:hidden')}>
        {mobileNav.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}
            className={({ isActive }) => cn('flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-1 py-1 text-[10px] font-medium transition', isActive ? 'bg-cyan-400/[0.08] text-cyan-200' : 'text-slate-500')}>
            <item.icon size={19} /> <span className="truncate">{item.label.split(' ')[0]}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
