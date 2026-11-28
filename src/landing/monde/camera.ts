/**
 * Chemin de caméra de l'expérience immersive (hero → Studio).
 *
 * ## Pourquoi une fonction pure
 * La caméra est le cœur de la demande : elle doit réellement avancer et
 * tourner. Une animation qu'on ne peut pas décrire sans navigateur ne se
 * vérifie pas. `etatCamera` est donc une fonction pure du progrès de
 * défilement : on peut l'appeler dans un test, comparer deux positions et
 * prouver que la caméra bouge — ce qu'aucune capture ne prouve à elle seule.
 *
 * ## Le trajet
 * - 0 → 0,19 : le hero. La caméra est face au téléphone, elle s'avance.
 * - 0,19 → 0,55 : elle passe à côté du téléphone et entre dans le couloir de
 *   plans UGC ; les cartes défilent de part et d'autre.
 * - 0,55 → 1 : elle se pose devant l'écran géant du Studio, légèrement en
 *   biais, et s'immobilise quand la vidéo s'allume.
 *
 * ## Portrait / paysage
 * En portrait, l'écran géant est nettement moins large dans le champ : la
 * caméra s'arrête plus loin pour qu'il reste lisible, et vise un peu plus bas
 * afin de laisser le bas de l'écran libre pour le texte (le texte ne passe
 * jamais sur l'objet).
 */

export type Vecteur = [number, number, number];

export type EtatCamera = {
  position: Vecteur;
  cible: Vecteur;
};

/** FOV vertical de la caméra, en degrés. Une seule valeur pour tout le site. */
export const FOV = 38;

/** Hauteur du téléphone, en unités monde. Sert au calcul de cadrage. */
export const HAUTEUR_TELEPHONE = 3.2;

/** Position du téléphone dans le monde (le hero). */
export const POSITION_TELEPHONE: Vecteur = [0, 0, 0];

/** Position de l'écran géant du Studio. */
export const POSITION_ECRAN: Vecteur = [0, 0.55, -24];

type Clef = {
  /** Progrès de défilement. */
  p: number;
  x: number;
  y: number;
  /** Position en profondeur, 0 = départ, 1 = arrivée devant l'écran. */
  zf: number;
  /** Point visé. */
  cx: number;
  /** Fraction de la position verticale du téléphone (1 = sur le téléphone). */
  cyf: number;
  cz: number;
};

const CLEFS: Clef[] = [
  { p: 0, x: 0, y: 0.32, zf: 0, cx: 0, cyf: 1, cz: 0 },
  { p: 0.09, x: 0.08, y: 0.3, zf: 0.08, cx: 0, cyf: 1, cz: 0 },
  { p: 0.19, x: 0.55, y: 0.2, zf: 0.32, cx: 0.05, cyf: 0.55, cz: -2 },
  { p: 0.3, x: 1.2, y: 0.12, zf: 0.55, cx: 0.4, cyf: 0.2, cz: -12 },
  { p: 0.46, x: 1.55, y: 0.16, zf: 0.74, cx: 0.3, cyf: 0.1, cz: -20 },
  { p: 0.62, x: 1.25, y: 0.12, zf: 0.87, cx: 0.3, cyf: 0.06, cz: -23 },
  { p: 0.8, x: 0.85, y: 0.08, zf: 0.96, cx: 0.32, cyf: 0.04, cz: -24 },
  { p: 1, x: 0.5, y: 0.05, zf: 1, cx: 0.34, cyf: 0.03, cz: -24 },
];

const lisser = (t: number) => t * t * (3 - 2 * t);

function melanger(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Profondeur de départ de la caméra (le hero). */
export function profondeurDepart(portrait: boolean): number {
  return portrait ? 7.4 : 7.0;
}

/**
 * Profondeur d'arrivée : 8,8 unités devant l'écran en paysage, 11,5 en
 * portrait, pour que l'écran reste lisible sans sortir du champ.
 */
export function profondeurArrivee(portrait: boolean): number {
  return POSITION_ECRAN[2] + (portrait ? 11.5 : 10.6);
}

/** Position verticale du téléphone : posée dans la moitié basse en portrait. */
export function hauteurTelephone(portrait: boolean): number {
  return portrait ? -0.95 : 0;
}

/**
 * Part de la hauteur visible occupée par le téléphone au premier écran.
 * Exigence : au moins 60 % sur mobile (360 px).
 */
export function partHauteurTelephone(portrait: boolean): number {
  const visible = 2 * profondeurDepart(portrait) * Math.tan((FOV * Math.PI) / 360);
  return HAUTEUR_TELEPHONE / visible;
}

/**
 * État de la caméra pour un progrès donné.
 *
 * @param progres 0 → 1 sur toute l'expérience hero + Studio.
 * @param portrait vrai sous 768 px de large.
 */
export function etatCamera(progres: number, portrait: boolean): EtatCamera {
  const p = Math.min(1, Math.max(0, progres));
  const zDebut = profondeurDepart(portrait);
  const zFin = profondeurArrivee(portrait);
  const yPhone = hauteurTelephone(portrait);

  let i = 0;
  while (i < CLEFS.length - 2 && p > CLEFS[i + 1].p) i += 1;
  const a = CLEFS[i];
  const b = CLEFS[i + 1];
  const brut = (p - a.p) / (b.p - a.p || 1);
  const t = lisser(Math.min(1, Math.max(0, brut)));

  // En paysage, la caméra vise À GAUCHE de l'écran : l'écran se décale donc à
  // droite du champ et le texte garde toute la gauche, dans le vide. (Viser à
  // droite plaçait l'écran sous le titre — constaté à la capture.)
  const cxFin = portrait ? 0 : -1.75;
  const cxA = a.cx + (cxFin - a.cx) * a.zf;
  const cxB = b.cx + (cxFin - b.cx) * b.zf;
  const cyFin = portrait ? -0.3 : 0.2;
  const cyA = a.cyf * yPhone + (cyFin - a.cyf * yPhone) * Math.max(0, (a.zf - 0.25) / 0.75);
  const cyB = b.cyf * yPhone + (cyFin - b.cyf * yPhone) * Math.max(0, (b.zf - 0.25) / 0.75);

  return {
    position: [
      melanger(a.x, b.x, t),
      melanger(a.y, b.y, t),
      melanger(zDebut, zFin, melanger(a.zf, b.zf, t)),
    ],
    cible: [
      melanger(cxA, cxB, t),
      melanger(cyA, cyB, t),
      melanger(a.cz, b.cz, t),
    ],
  };
}

/** Fenêtres du Studio, dans l'ordre du récit. */
export const ETAPES_STUDIO = [
  { cle: 'brief', titre: 'Brief', de: 0.22, a: 0.44 },
  { cle: 'script', titre: 'Script', de: 0.44, a: 0.62 },
  { cle: 'storyboard', titre: 'Storyboard', de: 0.62, a: 0.8 },
  { cle: 'video', titre: 'Vidéo', de: 0.8, a: 1.01 },
] as const;

/** Étape du Studio (0 → 3) pour un progrès global. */
export function etapeStudio(progres: number): number {
  const index = ETAPES_STUDIO.findIndex((etape) => progres >= etape.de && progres < etape.a);
  return index === -1 ? (progres >= 1 ? 3 : 0) : index;
}
