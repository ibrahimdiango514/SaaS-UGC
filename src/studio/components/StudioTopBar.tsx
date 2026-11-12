import { Link, useLocation } from 'react-router-dom';
import {
  AudioLines, Clapperboard, Coins, CreditCard, Film, History, Image as ImageIcon,
  LayoutGrid, Lock, Mic2, Scissors, Sparkles, UserRound,
} from 'lucide-react';
import { cn } from '../../components/ui';
import { BrandSymbol } from '../../components/Brand';
import { useAuth } from '../../context/AuthContext';

interface Category {
  /** `planned` = capacité annoncée non intégrée ; `soon` = aucun moteur connecté. */
  tier?: 'soon' | 'planned';
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
 * Seules les entrées reliées à une fonction réelle sont cliquables ; les autres
 * restent visibles, grisées et verrouillées — jamais présentées comme prêtes.
 * Le libellé « À venir » est conservé pour le verrou (traçabilité produit).
 */
export const STUDIO_CATEGORIES: Category[] = [
  { id: 'video', label: 'Vidéo', icon: Clapperboard, to: '/app/studio', available: true },
  { id: 'image', label: 'Image', icon: ImageIcon, available: false, tier: 'soon', note: 'Aucun modèle image intégré.' },
  { id: 'audio', label: 'Audio Studio', icon: AudioLines, available: false, tier: 'soon', note: 'Aucun moteur audio / TTS connecté.' },
  { id: 'lip-sync', label: 'Lip Sync', icon: Mic2, available: false, tier: 'planned', note: 'Nécessite une source audio non produite par VYORA.' },
  { id: 'editor', label: 'Montage', icon: Scissors, to: '/app/studio/montage', available: true },
  { id: 'creations', label: 'Mes créations', icon: Film, to: '/app/bibliotheque', available: true },
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
                <c.icon size={14} className={c.available ? (active ? 'text-cyan-300' : 'text-slate-300') : 'text-slate-600'} />
                <span className="whitespace-nowrap">{c.label}</span>
                {!c.available && (
                  <span className="hidden text-[9px] uppercase tracking-wide text-slate-600 xl:inline">
                    {c.tier === 'planned' ? 'Démo' : 'À venir'}
                  </span>
                )}
              </>
            );
            const cls = cn(
              'studio-bar-tab',
              active && 'studio-bar-tab-active',
              !c.available && 'cursor-not-allowed text-slate-600 hover:border-transparent hover:text-slate-600',
            );
            return c.available && c.to ? (
              <Link key={c.id} to={c.to} className={cls} aria-current={active ? 'page' : undefined}>
                {content}
              </Link>
            ) : (
              <span key={c.id} className={cls} title={c.note ?? 'À venir'} aria-disabled="true">
                {content}
                <Lock size={9} className="opacity-60" />
              </span>
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
