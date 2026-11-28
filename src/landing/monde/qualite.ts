/**
 * Paliers de qualité de la scène 3D.
 *
 * ## Ce que ce module décide, et pourquoi il est séparé
 * La scène coûte proportionnellement au nombre de pixels éclairés : sur un GPU
 * intégré en machine virtuelle, 1,29 Mpx coûtaient ~175 ms/image. Les leviers
 * sont donc hiérarchisés du plus rentable au moins rentable :
 *
 * 1. les pixels (dpr) — un facteur 2 sur le dpr, c'est un facteur 4 sur le coût ;
 * 2. les halos additifs (7 plans qui couvrent l'écran) : ~30 % du coût mesuré ;
 * 3. le fond nébuleuse (plan plein écran) : ~25 % ;
 * 4. le nombre de lumières dynamiques (6 au départ) : ~11 % ;
 * 5. le brouillard et le tone mapping : ~5 % ;
 * 6. le reste (géométrie, ombres, étincelles) : quelques millisecondes.
 *
 * Les fonctions ci-dessous sont **pures** : la décision de dégrader se teste
 * sans navigateur, ce qui évite d'affirmer un comportement qu'on n'a pas pu
 * vérifier dans le DOM.
 */

import { createContext } from 'react';

export type Palier = 'complet' | 'eleve' | 'moyen' | 'bas';

export type Reglages = {
  nom: Palier;
  /** Plafond de devicePixelRatio pour le canvas. */
  dpr: number;
  /** Halos additifs dessinés dans la scène. */
  halos: boolean;
  /** Équivalent CSS des halos (lueurs floues), quand la 3D les abandonne. */
  lueursCss: boolean;
  /** Fond nébuleuse : dans la scène, ou en CSS derrière un canvas transparent. */
  fond: '3d' | 'css';
  /**
   * Nombre de lumières ponctuelles conservées **par groupe** (téléphone et
   * Studio). Les lumières retirées sont compensées par l'ambiante, sinon les
   * cadres passent au noir.
   */
  lumieres: number;
  brouillard: boolean;
  tonemapping: boolean;
  etincelles: boolean;
  ombres: boolean;
  /** Nombre d'affiches du couloir. */
  affiches: number;
  /** Arrondi des congés (segments). */
  segments: number;
  /** Fréquence de redessin de l'écran du téléphone, en Hz. */
  ecranHz: number;
  /** Qualité des textures redessinées (largeur du canvas). */
  resolutionEcran: number;
};

/**
 * Les quatre paliers, du plus beau au plus léger.
 *
 * `complet` est le rendu de la livraison 1 : rien n'est retiré. Les paliers
 * suivants ne touchent qu'à des éléments dont l'absence ne change pas la
 * composition (les lueurs deviennent du CSS, le fond reste la même image).
 */
export const PALIERS: Record<Palier, Reglages> = {
  complet: {
    nom: 'complet',
    dpr: 1.5,
    halos: true,
    lueursCss: false,
    fond: '3d',
    lumieres: 3,
    brouillard: true,
    tonemapping: true,
    etincelles: true,
    ombres: true,
    affiches: 8,
    segments: 4,
    ecranHz: 12,
    resolutionEcran: 512,
  },
  eleve: {
    nom: 'eleve',
    dpr: 1.25,
    halos: true,
    lueursCss: true,
    fond: 'css',
    lumieres: 3,
    brouillard: true,
    tonemapping: true,
    etincelles: true,
    ombres: true,
    affiches: 8,
    segments: 3,
    ecranHz: 10,
    resolutionEcran: 512,
  },
  moyen: {
    nom: 'moyen',
    dpr: 1,
    halos: false,
    lueursCss: true,
    fond: 'css',
    lumieres: 2,
    brouillard: false,
    tonemapping: true,
    etincelles: false,
    ombres: false,
    affiches: 6,
    segments: 3,
    ecranHz: 8,
    resolutionEcran: 384,
  },
  bas: {
    nom: 'bas',
    dpr: 0.75,
    halos: false,
    lueursCss: true,
    fond: 'css',
    lumieres: 1,
    brouillard: false,
    tonemapping: false,
    etincelles: false,
    ombres: false,
    affiches: 4,
    segments: 2,
    ecranHz: 6,
    resolutionEcran: 320,
  },
};

export const ORDRE: Palier[] = ['complet', 'eleve', 'moyen', 'bas'];

/** Seuils de décision, en images par seconde. */
export const SEUIL_CONFORT = 50;
export const SEUIL_DEGRADE = 45;
export const SEUIL_REPLI = 24;

export type Decision = 'garder' | 'descendre' | 'repli';

/**
 * Décision pour une fenêtre de mesure.
 *
 * On ne remonte jamais automatiquement : une remontée provoque l'oscillation
 * classique (dégrader → ça va mieux → remonter → ça retombe). Le palier choisi
 * par l'URL, lui, reste respecté.
 */
export function decision(palier: Palier, fps: number): Decision {
  if (!Number.isFinite(fps) || fps <= 0) return 'garder';
  if (fps < SEUIL_REPLI) return palier === 'bas' ? 'repli' : 'descendre';
  if (fps < SEUIL_DEGRADE) return palier === 'bas' ? 'garder' : 'descendre';
  return 'garder';
}

/** Palier immédiatement plus léger, ou `null` au plancher. */
export function palierSuivant(palier: Palier): Palier | null {
  const i = ORDRE.indexOf(palier);
  if (i < 0 || i === ORDRE.length - 1) return null;
  return ORDRE[i + 1];
}

/**
 * Palier demandé dans l'URL (`?palier=moyen`), ou `null`.
 * Sert aux preuves : chaque palier se capture et se mesure par URL.
 */
export function palierDepuisUrl(search: string): Palier | null {
  const valeur = new URLSearchParams(search).get('palier');
  if (!valeur) return null;
  return (ORDRE as string[]).includes(valeur) ? (valeur as Palier) : null;
}

/**
 * Palier de départ avant toute mesure. On part du plus beau : une machine
 * capable garde le rendu complet, les autres descendent en une fenêtre.
 */
export function palierInitial(portrait: boolean): Palier {
  return portrait ? 'moyen' : 'complet';
}

/**
 * Médiane d'une série — plus robuste qu'une moyenne quand une image isolée
 * dure 400 ms (ramasse-miettes, changement d'onglet).
 */
export function mediane(valeurs: number[]): number {
  if (valeurs.length === 0) return 0;
  const tri = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tri.length / 2);
  return tri.length % 2 === 0 ? (tri[milieu - 1] + tri[milieu]) / 2 : tri[milieu];
}

/** Images par seconde à partir d'une série d'intervalles en millisecondes. */
export function fpsDepuisIntervalles(intervalles: number[]): number {
  const med = mediane(intervalles);
  return med > 0 ? Math.round(1000 / med) : 0;
}

/**
 * Contexte React : les sous-scènes (téléphone, Studio) lisent le palier sans
 * qu'on ait à le faire descendre de prop en prop dans chaque composant.
 */
export const QualiteContexte = createContext<Reglages>(PALIERS.complet);
