/**
 * VYORA — préférences visuelles globales.
 *
 * Deux réglages indépendants :
 *   - le **thème** : sombre, clair, ou celui du système ;
 *   - l'**univers** : Business Grow ou Studio, qui change l'accent.
 *
 * Les deux sont posés sur `<html>` (`data-theme`, `data-univers`), ce qui suffit
 * à basculer toutes les variables CSS — donc toute l'application, sans qu'aucun
 * composant n'ait à connaître le thème.
 *
 * Choix assumé : l'univers n'est **pas** déduit de la page courante. Un
 * utilisateur qui ouvre une facture depuis Business Grow ne doit pas voir
 * l'interface changer de couleur selon la route ; il choisit son espace, et
 * l'interface le respecte (exigence 4.4 : sélecteur d'espace toujours visible).
 */

const THEME_KEY = 'vyora.theme.v1';
const UNIVERS_KEY = 'vyora.univers.v1';

export type Theme = 'dark' | 'light' | 'system';
export type Univers = 'business' | 'studio';

export const UNIVERS_LABEL: Record<Univers, string> = {
  business: 'Business Grow',
  studio: 'VYORA Studio',
};

function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  } catch {
    /* stockage indisponible (navigation privée stricte) : on garde le défaut */
  }
  return 'system';
}

function readUnivers(): Univers | null {
  try {
    const raw = localStorage.getItem(UNIVERS_KEY);
    if (raw === 'business' || raw === 'studio') return raw;
  } catch {
    /* idem */
  }
  return null;
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: light)').matches === false;
}

/** Applique le thème effectif sur `<html>`. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const effective: 'dark' | 'light' = theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme;
  root.setAttribute('data-theme', effective);
  // `color-scheme` pilote les widgets natifs (scrollbars, sélecteurs de date).
  root.style.colorScheme = effective;
}

/** Applique l'univers sur `<html>`. */
export function applyUnivers(univers: Univers): void {
  document.documentElement.setAttribute('data-univers', univers);
}

export function getTheme(): Theme {
  return readTheme();
}

export function getUnivers(): Univers | null {
  return readUnivers();
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* on applique quand même : la préférence ne survivra pas au rechargement */
  }
  applyTheme(theme);
}

export function setUnivers(univers: Univers): void {
  try {
    localStorage.setItem(UNIVERS_KEY, univers);
  } catch {
    /* idem */
  }
  applyUnivers(univers);
}

/**
 * À appeler une fois au démarrage, avant le premier rendu React, pour éviter
 * le flash de thème clair (FOUC). Lit les préférences et les applique.
 */
export function initPreferences(): { theme: Theme; univers: Univers } {
  const theme = readTheme();
  const univers = readUnivers() ?? 'studio';
  applyTheme(theme);
  applyUnivers(univers);
  // Suit le système tant que l'utilisateur n'a pas choisi explicitement.
  if (theme === 'system' && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      if (readTheme() === 'system') applyTheme('system');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
  }
  return { theme, univers };
}
