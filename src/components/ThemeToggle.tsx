/**
 * VYORA — bascule de thème.
 *
 * Trois états (système → sombre → clair → système) dans un seul bouton de 44 px.
 * L'icône montre l'état **courant**, pas l'état suivant : c'est ce que les gens
 * attendent d'un interrupteur, et ça évite d'afficher un soleil en pleine nuit.
 */

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { applyTheme, getTheme, setTheme, type Theme } from '../styles/preferences';
import { cn } from './ui';

const ORDRE: Theme[] = ['system', 'dark', 'light'];

const LIBELLE: Record<Theme, string> = {
  system: 'Thème du système',
  dark: 'Thème sombre',
  light: 'Thème clair',
};

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setLocal] = useState<Theme>('system');

  useEffect(() => {
    setLocal(getTheme());
  }, []);

  const tourner = () => {
    const suivant = ORDRE[(ORDRE.indexOf(theme) + 1) % ORDRE.length];
    setTheme(suivant);
    applyTheme(suivant);
    setLocal(suivant);
  };

  const Icone = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  return (
    <button
      type="button"
      onClick={tourner}
      className={cn('btn btn-ghost btn-icon', className)}
      aria-label={`${LIBELLE[theme]} — cliquer pour changer`}
      title={LIBELLE[theme]}
    >
      <Icone size={18} aria-hidden="true" />
    </button>
  );
}

/**
 * Bascule de thème dans une liste de préférences : trois boutons, plus explicite
 * qu'une rotation quand on est déjà dans les réglages.
 */
export function ThemeChoice() {
  const [theme, setLocal] = useState<Theme>('system');

  useEffect(() => {
    setLocal(getTheme());
  }, []);

  return (
    <div role="radiogroup" aria-label="Thème de l’interface" className="flex gap-2">
      {ORDRE.map((t) => {
        const Icone = t === 'dark' ? Moon : t === 'light' ? Sun : Monitor;
        const actif = theme === t;
        return (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={actif}
            onClick={() => {
              setTheme(t);
              applyTheme(t);
              setLocal(t);
            }}
            className={cn(
              'btn btn-sm flex-1 gap-2',
              actif ? 'btn-primary' : 'btn-outline',
            )}
          >
            <Icone size={16} aria-hidden="true" />
            {t === 'system' ? 'Système' : t === 'dark' ? 'Sombre' : 'Clair'}
          </button>
        );
      })}
    </div>
  );
}
