/**
 * VYORA — sélecteur d'espace (exigence 4.4 : toujours visible).
 *
 * Deux produits, un compte. Sans ce contrôle, un utilisateur qui ouvre une
 * facture puis veut créer une vidéo doit retrouver le bon menu — et se demande
 * s'il est au bon endroit. Ici, changer d'espace est un geste, depuis n'importe
 * quel écran de l'application.
 *
 * Comportements importants :
 *   - l'espace **actif** est mémorisé : la prochaine connexion rouvre celui-ci ;
 *   - changer d'espace change aussi l'**univers visuel** (ambre ↔ cyan) ;
 *   - cibles tactiles de 44 px, libellés courts sur mobile ;
 *   - accessible au clavier comme un groupe de boutons radio.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, Clapperboard } from 'lucide-react';
import { applyUnivers, getUnivers, setUnivers, type Univers } from '../styles/preferences';
import { cn } from './ui';

const ESPACES: Array<{ id: Univers; label: string; court: string; to: string; icon: typeof Briefcase }> = [
  { id: 'business', label: 'Business Grow', court: 'Business', to: '/app/business', icon: Briefcase },
  { id: 'studio', label: 'VYORA Studio', court: 'Studio', to: '/app/studio', icon: Clapperboard },
];

export function SpaceSwitcher({ className, compact }: { className?: string; compact?: boolean }) {
  const navigate = useNavigate();
  const [actif, setActif] = useState<Univers>(() => getUnivers() ?? 'studio');

  useEffect(() => {
    // Si l'univers a été changé ailleurs (autre onglet, autre composant), on suit.
    const maj = () => setActif(getUnivers() ?? 'studio');
    window.addEventListener('vyora:univers', maj);
    return () => window.removeEventListener('vyora:univers', maj);
  }, []);

  const changer = (univers: Univers, to: string) => {
    setUnivers(univers);
    applyUnivers(univers);
    setActif(univers);
    window.dispatchEvent(new Event('vyora:univers'));
    navigate(to);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Choisir l’espace"
      className={cn('flex gap-1 rounded-xl border border-line bg-panel2/80 p-1', className)}
    >
      {ESPACES.map(({ id, label, court, to, icon: Icon }) => {
        const estActif = actif === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={estActif}
            onClick={() => changer(id, to)}
            className={cn(
              'tap inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-2.5 text-xs font-semibold transition-colors',
              estActif
                ? 'bg-brand-500 shadow-glow'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-100',
            )}
            style={estActif ? { color: 'var(--vy-accent-ink)' } : undefined}
            title={label}
          >
            <Icon size={15} aria-hidden="true" />
            <span className="vy-min0 truncate">{compact ? court : label}</span>
          </button>
        );
      })}
    </div>
  );
}
