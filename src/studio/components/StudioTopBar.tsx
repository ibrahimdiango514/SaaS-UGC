import { Link, useLocation } from 'react-router-dom';
import {
  Clapperboard, Coins, CreditCard, Film, History,
  LayoutGrid, Mic2, Scissors, Sparkles, UserRound,
} from 'lucide-react';
import { cn } from '../../components/ui';
import { BrandSymbol } from '../../components/Brand';
import { useAuth } from '../../context/AuthContext';

interface Category {
  id: string;
  label: string;
  icon: typeof Clapperboard;
  to?: string;
  available: boolean;
  note?: string;
}

/**
 * Navigation du Studio, alignée sur la référence : une barre horizontale unique,
 * sans carte, sans ombre, posée directement sur le canvas noir.
 *
 * Toutes les entrées listées ouvrent une capacité réellement disponible : le
 * Studio n'affiche plus de cadenas ni d'étiquette de disponibilité. Une capacité
 * absente du produit n'apparaît pas du tout, au lieu d'être présentée comme
 * verrouillée.
 */
export const STUDIO_CATEGORIES: Category[] = [
  { id: 'video', label: 'Vidéo', icon: Clapperboard, to: '/app/studio', available: true,
    note: 'Texte → Vidéo et Image → Vidéo.' },
  { id: 'video-to-video', label: 'Vidéo → Vidéo', icon: Film, to: '/app/studio?mode=video-source', available: true,
    note: 'Montage, clips, effets, mise à l’échelle sur une vidéo importée.' },
  { id: 'lip-sync', label: 'Lip Sync', icon: Mic2, to: '/app/studio?mode=audio-source', available: true,
    note: 'Synchronisation labiale et avatars parlants à partir d’un audio importé.' },
  { id: 'editor', label: 'Montage', icon: Scissors, to: '/app/studio/montage', available: true,
    note: 'Timeline, pistes, scènes, sous-titres et export.' },
  { id: 'creations', label: 'Mes créations', icon: Film, to: '/app/bibliotheque', available: true,
    note: 'Fichiers réellement produits, conservés dans le stockage privé.' },
  { id: 'credits', label: 'Crédits', icon: Coins, to: '/app/credits', available: true,
    note: 'Packs, solde et historique du portefeuille Studio.' },
];

const SECONDARY = [
  { to: '/app/historique', label: 'Historique', icon: History },
  { to: '/app/credits', label: 'Crédits', icon: CreditCard },
];

export function StudioTopBar() {
  const { quota, profile, user } = useAuth();
  const { pathname } = useLocation();
  const balance = quota?.credits ?? 0;
  const displayName = profile?.display_name || user?.email?.split('@')[0] || 'Compte';

  return (
    <header className="studio-immersive-bar">
      <div className="flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3 sm:py-2">
        {/* Sortie vers l'espace de travail complet : le canvas masque la coque
            globale, mais la navigation doit rester accessible sur mobile. */}
        <Link
          to="/app"
          className="studio-bar-icon shrink-0"
          title="Revenir à l’espace de travail VYORA"
          aria-label="Revenir à l’espace de travail VYORA"
        >
          <LayoutGrid size={15} />
        </Link>

        <Link to="/app/studio" className="flex shrink-0 items-center gap-2" aria-label="VYORA Studio">
          <BrandSymbol size={26} />
          <span className="hidden text-[13px] font-semibold tracking-tight text-white sm:block">VYORA</span>
        </Link>

        <nav aria-label="Espaces du Studio" className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1">
          {STUDIO_CATEGORIES.map((c) => {
            const active = c.to && (pathname === c.to || (c.to !== '/app/studio' && pathname.startsWith(`${c.to}/`)));
            const content = (
              <>
                <c.icon size={14} className={active ? 'text-cyan-300' : 'text-slate-300'} />
                <span className="whitespace-nowrap">{c.label}</span>
              </>
            );
            const cls = cn('studio-bar-tab', active && 'studio-bar-tab-active');
            return (
              <Link
                key={c.id}
                to={c.to ?? '/app/studio'}
                className={cls}
                title={c.note}
                aria-current={active ? 'page' : undefined}
              >
                {content}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          {SECONDARY.map((s) => (
            <Link key={s.to} to={s.to} className="studio-bar-icon hidden sm:inline-flex" title={s.label} aria-label={s.label}>
              <s.icon size={15} />
            </Link>
          ))}
          <Link
            to="/app/credits"
            data-testid="credit-balance"
            className="studio-credit-pill"
            title="Solde de crédits Studio"
          >
            <Coins size={13} />
            <span className="tabular-nums">{balance}</span>
            <span className="hidden text-[10px] font-medium text-cyan-200/70 sm:inline">crédits</span>
          </Link>
          <Link to="/app/parametres" className="studio-account-pill" title={displayName} aria-label={`Compte ${displayName}`}>
            <UserRound size={13} />
            <span className="hidden max-w-[90px] truncate sm:inline">{displayName}</span>
          </Link>
        </div>
      </div>

      {/* Bandeau discret : le Studio est réel, aucune maquette. */}
      <p className="flex items-center gap-1.5 truncate px-3 pb-1.5 text-[9px] uppercase tracking-[0.14em] text-slate-600 sm:px-4">
        <Sparkles size={9} className="text-cyan-400/50" />
        Devis vérifié avant génération · espace isolé par compte
        <span className="hidden sm:inline">· aucun résultat simulé</span>
      </p>
    </header>
  );
}
