import { Link, useLocation } from 'react-router-dom';
import {
  AudioLines, Clapperboard, Coins, CreditCard, Film, History, Image as ImageIcon,
  Lock, Mic2, Scissors, UserRound, Users,
} from 'lucide-react';
import { cn } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';

interface Category {
  id: string;
  label: string;
  icon: typeof Clapperboard;
  to?: string;
  available: boolean;
  note?: string;
}

/** Only routes backed by real features are clickable. Everything else is "à venir". */
export const STUDIO_CATEGORIES: Category[] = [
  { id: 'image', label: 'Image', icon: ImageIcon, available: false, note: 'Génération d’images : aucun modèle intégré.' },
  { id: 'video', label: 'Vidéo', icon: Clapperboard, to: '/app/studio', available: true },
  { id: 'audio', label: 'Audio', icon: AudioLines, available: false, note: 'Aucun moteur audio / TTS connecté.' },
  { id: 'lip-sync', label: 'Lip Sync', icon: Mic2, available: false, note: 'Nécessite une source audio non produite par Reelora.' },
  { id: 'avatar', label: 'Avatar', icon: Users, to: '/app/avatars', available: true },
  { id: 'editor', label: 'Montage', icon: Scissors, to: '/app/studio/montage', available: true },
  { id: 'creations', label: 'Mes créations', icon: Film, to: '/app/bibliotheque', available: true },
];

export function StudioTopBar() {
  const { quota, profile, user } = useAuth();
  const { pathname } = useLocation();
  const balance = quota?.credits ?? 0;
  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'Mon compte';

  return (
    <div className="studio-v2 mb-5 overflow-hidden rounded-2xl border border-cyan-400/15 bg-[#070b11]/95">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-cyan-400/15 text-cyan-300 ring-1 ring-cyan-400/25"><Clapperboard size={15} /></span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold text-white">UGC Studio <span className="font-normal text-cyan-300/80">· Video Generation</span></p>
            <p className="text-[10px] text-slate-500">Système 1 · crédits UGC</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.08] px-2.5 py-1.5 text-xs font-semibold text-cyan-200" title="Crédits UGC, distincts des abonnements du Business Growth Workspace">
            <Coins size={13} /> {balance} crédits UGC
          </span>
          <Link to="/app/historique" className="studio-icon-link" title="Historique des générations"><History size={14} /><span className="hidden sm:inline">Historique</span></Link>
          <Link to="/app/abonnement" className="studio-icon-link" title="Tarifs et achat de crédits UGC"><CreditCard size={14} /><span className="hidden sm:inline">Tarifs</span></Link>
          <Link to="/app/parametres" className="studio-icon-link" title="Informations de compte"><UserRound size={14} /><span className="hidden max-w-[110px] truncate sm:inline">{displayName}</span></Link>
        </div>
      </div>

      <nav aria-label="Espaces de l’UGC Studio" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-2 sm:px-4">
        {STUDIO_CATEGORIES.map((c) => {
          const active = c.to && (pathname === c.to || (c.to !== '/app/studio' && pathname.startsWith(`${c.to}/`)));
          const content = (
            <>
              <c.icon size={14} className={c.available ? 'text-cyan-300' : 'text-slate-500'} />
              <span>{c.label}</span>
              {!c.available && <><Lock size={10} className="opacity-60" /><span className="rounded bg-white/[0.06] px-1 py-0.5 text-[9px] uppercase tracking-wide text-slate-400">À venir</span></>}
            </>
          );
          const cls = cn(
            'flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition-colors sm:text-[13px]',
            active ? 'border-cyan-400/45 bg-cyan-400/15 text-white'
              : c.available ? 'border-white/[0.07] bg-white/[0.02] text-slate-300 hover:border-cyan-400/30 hover:text-white'
                : 'border-white/[0.05] bg-transparent text-slate-500',
          );
          return c.available && c.to
            ? <Link key={c.id} to={c.to} className={cls} aria-current={active ? 'page' : undefined}>{content}</Link>
            : <span key={c.id} className={cls} title={c.note} aria-disabled="true">{content}</span>;
        })}
      </nav>
    </div>
  );
}
