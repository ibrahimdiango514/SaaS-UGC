/**
 * Palette SORAHNEX — dérivée du logo, pas inventée.
 *
 * ## Ce qui est repris du logo, et ce qui change
 * Le logo est un « S » tracé d'un seul geste, surmonté d'un point lumineux.
 * La nouvelle direction artistique remplace ses deux arrêts cyan/violet par
 * magenta → rose → orange, en conservant :
 *   - le MOUVEMENT du tracé (même courbe, mêmes extrémités) ;
 *   - le POINT lumineux, désormais orange (l'accent demandé) ;
 *   - la profondeur : chaque teinte a un rôle fixe, jamais décoratif.
 *
 * Le fond est décrit par la charte : noir profond, nébuleuse qui respire,
 * halo, planète en bas. Ces valeurs sont les seules autorisées à porter la
 * marque ; tout composant qui a besoin d'une couleur de marque lit ici.
 *
 * ## Pourquoi des constantes et pas seulement des classes Tailwind
 * La scène 3D, les dégradés SVG et les canvas n'ont pas accès à Tailwind. Une
 * seule source évite qu'un composant 3D et un bouton affichent deux roses
 * différents.
 */

/** Les cinq rôles de la palette. Aucune sixième teinte de marque n'est admise. */
export const PALETTE = {
  /** Fond principal : noir profond légèrement bleuté, pas un noir pur. */
  ink: '#05030A',
  /** Fond des sections alternées. */
  inkSoft: '#0A0512',
  /** Primaire : magenta. Porte les actions principales. */
  magenta: '#F0389E',
  /** Secondaire : rose. Porte les halos et les états actifs. */
  rose: '#FB7185',
  /** Tertiaire : violet profond. Porte la nébuleuse et les liens discrets. */
  violet: '#7C3AED',
  /** Accent rare : orange. Un seul par écran, jamais deux. */
  orange: '#FF8A3D',
  /** Texte principal et secondaire. */
  texte: '#F7F2FA',
  texteDoux: '#B9AFC7',
} as const;

/**
 * Dégradé de marque du logo : magenta → rose → orange.
 * Utilisé par le SVG du logo, les titres et le CTA.
 */
export const DEGRADE_MARQUE = [PALETTE.magenta, PALETTE.rose, PALETTE.orange] as const;

/** Points d'arrêt du dégradé, alignés sur `DEGRADE_MARQUE`. */
export const ARRETS_DEGRADE = [0, 0.56, 1] as const;

/**
 * Les trois espaces du produit, avec leur teinte propre.
 * Une teinte par espace : l'utilisateur reconnaît où il est sans lire le titre.
 */
export const ESPACES = [
  { cle: 'studio', nom: 'Studio UGC', teinte: PALETTE.magenta, description: 'Brief, script, storyboard, génération suivie.' },
  { cle: 'grow', nom: 'Grow', teinte: PALETTE.violet, description: 'CRM, ventes, trésorerie, pilotage.' },
  { cle: 'agent', nom: 'Agent IA', teinte: PALETTE.rose, description: 'Actions proposées, puis validées.' },
] as const;

/** Slogan unique, appliqué partout : nav, hero, pied de page, métadonnées. */
export const SLOGAN = 'Create. Evolve. Grow.';

/** CTA unique, répété à chaque section. */
export const CTA_PRINCIPAL = 'Créer ma première vidéo';

/** Réassurance affichée sous chaque CTA. Jamais modifiée localement. */
export const REASSURANCE = 'Devis affiché avant chaque génération, aucun coût surprise';

/**
 * Fonctionnalités non branchées : elles restent visibles mais marquées
 * « Bientôt ». Les lister ici évite qu'un écran les présente comme acquises.
 */
export const BIENTOT = [
  'Connexion Meta (Facebook, Instagram)',
  'Connexion WhatsApp Business',
  'Connexion Google (Ads, Analytics)',
] as const;
