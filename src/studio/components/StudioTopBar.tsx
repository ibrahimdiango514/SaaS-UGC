import { Link, useLocation } from 'react-router-dom';
import {
  AudioLines, Clapperboard, Coins, CreditCard, Film, History, Image as ImageIcon,
  Lock, Mic2, Scissors, UserRound,
} from 'lucide-react';
import { cn } from '../../components/ui';
import { BrandLockup } from '../../components/Brand';
import { useAuth } from '../../context/AuthContext';

interface Category {
  id: string;
  label: string;
  icon: typeof Clapperboard;
  to?: string;
  available: boolean;
  note?: string;
  mobile?: boolean;
}

/** Only routes backed by real features are clickable. Everything else is "À venir". */
export const STUDIO_CATEGORIES: Category[] = [
  { id: 'image', label: 'Image', icon: ImageIcon, available: false, mobile: true, note: 'Génération d’images : aucun modèle intégré.' },
  { id: 'video', label: 'Vidéo', icon: Clapperboard, to: '/app/studio', available: true, mobile: true },
  { id: 'audio', label: 'Audio', icon: AudioLines, available: false, mobile: true, note: 'Aucun moteur audio / TTS connecté.' },
  { id: 'lip-sync', label: 'Lip Sync', icon: Mic2, available: false, mobile: true, note: 'Nécessite une source audio non produite par VYORA.' },
  { id: 'editor', label: 'Montage', icon: Scissors, to: '/app/studio/montage', available: true },
  { id: 'creations', label: 'Mes créations', icon: Film, to: '/app/bibliotheque', available: true },
];

export function StudioTopBar() {
  const { quota, profile, user } = useAuth();
  const { pathname } = useLocation();
  const balance = quota?.credits ?? 0;
  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'Mon compte';

  return (
    <header className="studio-v2 mb-4 rounded-2xl border border-white/[0.07] bg-[#05080d]/95 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 sm:px-4 sm:py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <BrandLockup symbolSize={32} />
          <div className="hidden min-w-0 leading-tight sm:block">
            <p className="truncate text-[12px] font-semibold text-white">Studio <span className="font-normal text-cyan-300">UGC</span></p>
            <p className="text-[9px] uppercase tracking-[0.18em] text-slate-600">Creative workspace</p>
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <span data-testid="credit-balance" className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-cyan-400/25 bg-cyan-400/[0.10] px-3 py-1.5 text-xs font-bold text-cyan-200">
            <Coins size={13} /> {balance} crédits
          </span>
          <Link to="/app/historique" className="studio-icon-link hidden lg:inline-flex" title="Historique"><History size={14} /></Link>
          <Link to="/app/abonnement" className="studio-icon-link hidden lg:inline-flex" title="Tarifs"><CreditCard size={14} /></Link>
          <Link to="/app/parametres" className="studio-icon-link hidden max-w-[130px] lg:inline-flex" title="Compte"><UserRound size={14} /><span className="truncate">{displayName}</span></Link>
        </div>
      </div>

      <nav aria-label="Espaces de l’UGC Studio" className="no-scrollbar flex gap-1.5 overflow-x-auto border-t border-white/[0.05] px-3 py-1.5 sm:px-4 sm:py-2">
        {STUDIO_CATEGORIES.map((c) => {
          const active = c.to && (pathname === c.to || (c.to !== '/app/studio' && pathname.startsWith(`${c.to}/`)));
          const content = (
            <>
              <c.icon size={13} className={c.available ? 'text-cyan-300' : 'text-slate-500'} />
              <span>{c.label}</span>
              {!c.available && <Lock size={9} className="opacity-70" />}
            </>
          );
          const cls = cn(
            'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors sm:text-[13px]',
            c.mobile ? '' : 'hidden sm:flex',
            active ? 'border-cyan-400/45 bg-cyan-400/15 text-white'
              : c.available ? 'border-white/[0.07] bg-white/[0.02] text-slate-300 hover:border-cyan-400/30 hover:text-white'
                : 'border-white/[0.05] bg-transparent text-slate-500',
          );
          return c.available && c.to
            ? <Link key={c.id} to={c.to} className={cls} aria-current={active ? 'page' : undefined}>{content}</Link>
            : <span key={c.id} className={cls} title={c.note ?? 'À venir'} aria-disabled="true">{content}</span>;
        })}
        <span className="ml-auto hidden shrink-0 items-center rounded-full border border-amber-300/20 bg-amber-300/[0.05] px-2 py-1 text-[9px] uppercase tracking-wide text-amber-200/80 lg:inline-flex">
          À venir · moteurs non connectés
        </span>
      </nav>
    </header>
  );
}
