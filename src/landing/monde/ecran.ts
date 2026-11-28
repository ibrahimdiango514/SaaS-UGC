/**
 * Contenus dessinés dans des canvas 2D puis projetés en textures 3D.
 *
 * ## Pourquoi dessiner au lieu de charger une vidéo
 * L'écran du téléphone raconte en boucle : un brief se tape, un script se
 * construit, une barre progresse, la vidéo s'allume. Une vidéo de ce récit
 * pèserait plusieurs mégaoctets pour quelques centaines de pixels ; dessinée,
 * elle pèse zéro octet de réseau, reste nette à toute résolution et ne dépend
 * d'aucun fichier à valider.
 *
 * ## Une seule source pour deux rendus
 * Ces fonctions ne connaissent ni three.js ni React : elles prennent un
 * contexte 2D et des dimensions. On peut donc les régénérer à la taille de la
 * texture sans changer le contenu.
 */

const POLICE = "'Space Grotesk', 'DM Sans', system-ui, -apple-system, sans-serif";

const MAGENTA = '#F0389E';
const ROSE = '#FB7185';
const ORANGE = '#FF8A3D';
const VIOLET = '#7C3AED';
const TEXTE = '#F7F2FA';
const TEXTE_DOUX = '#B9AFC7';
const INK = '#05030A';

function police(taille: number, poids: number | string = 500): string {
  return `${poids} ${Math.round(taille)}px ${POLICE}`;
}

function arrondi(ctx: CanvasRenderingContext2D, x: number, y: number, l: number, h: number, r: number) {
  const rayon = Math.min(r, l / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rayon, y);
  ctx.arcTo(x + l, y, x + l, y + h, rayon);
  ctx.arcTo(x + l, y + h, x, y + h, rayon);
  ctx.arcTo(x, y + h, x, y, rayon);
  ctx.arcTo(x, y, x + l, y, rayon);
  ctx.closePath();
}

/** Texte dont les lettres sont espacées (canvas ne sait pas le faire seul). */
function espace(ctx: CanvasRenderingContext2D, texte: string, x: number, y: number, espacement: number) {
  let curseur = x;
  for (const caractere of texte) {
    ctx.fillText(caractere, curseur, y);
    curseur += ctx.measureText(caractere).width + espacement;
  }
  return curseur;
}

/** Coupe un texte en lignes qui tiennent dans `largeur`. */
function lignes(ctx: CanvasRenderingContext2D, texte: string, largeur: number): string[] {
  const mots = texte.split(' ');
  const resultat: string[] = [];
  let ligne = '';
  for (const mot of mots) {
    const essai = ligne ? `${ligne} ${mot}` : mot;
    if (ctx.measureText(essai).width > largeur && ligne) {
      resultat.push(ligne);
      ligne = mot;
    } else {
      ligne = essai;
    }
  }
  if (ligne) resultat.push(ligne);
  return resultat;
}

/* ------------------------------------------------------------------ */
/* Écran du téléphone : brief → script → storyboard → vidéo            */
/* ------------------------------------------------------------------ */

export type OptionsEcran = {
  /** Secondes écoulées, la boucle dure 13,5 s. */
  secondes: number;
  /** Visuel de la vidéo finale (webp local), déjà décodé. */
  poster?: CanvasImageSource | null;
};

const DUREE_BOUCLE = 13.5;

export function dessinerEcranTelephone(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  { secondes, poster }: OptionsEcran,
) {
  const k = largeur / 540;
  const t = ((secondes % DUREE_BOUCLE) + DUREE_BOUCLE) % DUREE_BOUCLE;
  const phase = t < 3.4 ? 0 : t < 6.7 ? 1 : t < 9.4 ? 2 : 3;
  const local = phase === 0 ? t / 3.4 : phase === 1 ? (t - 3.4) / 3.3 : phase === 2 ? (t - 6.7) / 2.7 : (t - 9.4) / 4.1;

  /*
   * Remise à zéro de l'état du contexte à chaque image. Sans cela, une image
   * interrompue entre save() et restore() laissait un globalAlpha < 1 : le
   * fond de l'écran devenait translucide et la nébuleuse apparaissait à
   * travers la dalle (constaté à l'image : UI nette, fond laiteux).
   */
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, largeur, hauteur);

  // Marge extérieure transparente : les angles arrondis sont dans la texture.
  ctx.save();
  arrondi(ctx, 0, 0, largeur, hauteur, 58 * k);
  ctx.clip();

  // Fond : noir profond, lueur magenta en haut, lueur rose en bas.
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, largeur, hauteur);
  const haut = ctx.createRadialGradient(largeur * 0.18, hauteur * 0.02, 0, largeur * 0.18, hauteur * 0.02, hauteur * 0.62);
  haut.addColorStop(0, 'rgba(240,56,158,0.30)');
  haut.addColorStop(1, 'rgba(240,56,158,0)');
  ctx.fillStyle = haut;
  ctx.fillRect(0, 0, largeur, hauteur);
  const bas = ctx.createRadialGradient(largeur * 0.85, hauteur * 0.95, 0, largeur * 0.85, hauteur * 0.95, hauteur * 0.55);
  bas.addColorStop(0, 'rgba(251,113,133,0.22)');
  bas.addColorStop(1, 'rgba(251,113,133,0)');
  ctx.fillStyle = bas;
  ctx.fillRect(0, 0, largeur, hauteur);

  const marge = 30 * k;

  // Barre d'état.
  ctx.fillStyle = 'rgba(247,242,250,0.85)';
  ctx.font = police(17 * k, 600);
  ctx.textBaseline = 'middle';
  ctx.fillText('9:41', marge, 30 * k);
  ctx.fillStyle = 'rgba(247,242,250,0.45)';
  for (let i = 0; i < 4; i += 1) {
    arrondi(ctx, largeur - marge - 22 * k + i * 5 * k, 33 * k - i * 2.2 * k, 3.4 * k, 4 * k + i * 2.2 * k, 1.4 * k);
    ctx.fill();
  }
  arrondi(ctx, largeur - marge - 46 * k, 27 * k, 16 * k, 9 * k, 2.4 * k);
  ctx.strokeStyle = 'rgba(247,242,250,0.5)';
  ctx.lineWidth = 1.1 * k;
  ctx.stroke();

  // En-tête applicatif : marque + espace courant.
  const yEntete = 78 * k;
  const degradeMarque = ctx.createLinearGradient(marge, yEntete, marge + 40 * k, yEntete + 40 * k);
  degradeMarque.addColorStop(0, MAGENTA);
  degradeMarque.addColorStop(0.56, ROSE);
  degradeMarque.addColorStop(1, ORANGE);
  arrondi(ctx, marge, yEntete, 38 * k, 38 * k, 12 * k);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fill();
  ctx.strokeStyle = degradeMarque;
  ctx.lineWidth = 2.2 * k;
  ctx.beginPath();
  ctx.moveTo(marge + 27 * k, yEntete + 12 * k);
  ctx.bezierCurveTo(marge + 18 * k, yEntete + 9 * k, marge + 12 * k, yEntete + 14 * k, marge + 13 * k, yEntete + 21 * k);
  ctx.bezierCurveTo(marge + 14 * k, yEntete + 28 * k, marge + 24 * k, yEntete + 27 * k, marge + 26 * k, yEntete + 36 * k);
  ctx.stroke();

  ctx.fillStyle = TEXTE;
  ctx.font = police(21 * k, 700);
  espace(ctx, 'SORAHNEX', marge + 50 * k, yEntete + 17 * k, 2.4 * k);
  ctx.fillStyle = 'rgba(185,175,199,0.75)';
  ctx.font = police(15 * k, 500);
  espace(ctx, 'STUDIO UGC', marge + 50 * k, yEntete + 34 * k, 1.6 * k);

  // Pastille d'état.
  const etat = ['Brief', 'Script', 'Storyboard', 'Vidéo prête'][phase];
  ctx.font = police(14 * k, 600);
  const largeurEtat = ctx.measureText(etat).width + 24 * k;
  arrondi(ctx, largeur - marge - largeurEtat, yEntete + 6 * k, largeurEtat, 26 * k, 13 * k);
  ctx.fillStyle = phase === 3 ? 'rgba(251,113,133,0.16)' : 'rgba(240,56,158,0.14)';
  ctx.fill();
  ctx.strokeStyle = phase === 3 ? 'rgba(251,113,133,0.45)' : 'rgba(240,56,158,0.4)';
  ctx.lineWidth = 1 * k;
  ctx.stroke();
  ctx.fillStyle = phase === 3 ? ROSE : '#F7A8CF';
  ctx.textAlign = 'center';
  ctx.fillText(etat, largeur - marge - largeurEtat / 2, yEntete + 19.5 * k);
  ctx.textAlign = 'left';

  // Rail des quatre étapes.
  const yRail = 148 * k;
  const etapes = ['Brief', 'Script', 'Plans', 'Vidéo'];
  const largeurRail = largeur - marge * 2;
  const pas = largeurRail / 3;
  for (let i = 0; i < 4; i += 1) {
    const x = marge + i * pas;
    const actif = i <= phase;
    ctx.beginPath();
    ctx.arc(x, yRail, 5 * k, 0, Math.PI * 2);
    ctx.fillStyle = actif ? (i === phase ? ROSE : MAGENTA) : 'rgba(255,255,255,0.16)';
    ctx.fill();
    if (i < 3) {
      ctx.beginPath();
      ctx.moveTo(x + 8 * k, yRail);
      ctx.lineTo(x + pas - 8 * k, yRail);
      ctx.strokeStyle = i < phase ? 'rgba(240,56,158,0.55)' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1.4 * k;
      ctx.stroke();
    }
    ctx.fillStyle = actif ? TEXTE_DOUX : 'rgba(185,175,199,0.45)';
    ctx.font = police(12 * k, 500);
    ctx.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
    ctx.fillText(etapes[i], x, yRail + 20 * k);
    ctx.textAlign = 'left';
  }

  /* ----------------------------------------------------------------- */
  /* Carte principale                                                    */
  /* ----------------------------------------------------------------- */
  const yCarte = 196 * k;
  const hCarte = 690 * k;
  arrondi(ctx, marge, yCarte, largeur - marge * 2, hCarte, 26 * k);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1.2 * k;
  ctx.stroke();

  const xTexte = marge + 24 * k;
  const largeurTexte = largeur - marge * 2 - 48 * k;

  if (phase === 0) {
    ctx.fillStyle = MAGENTA;
    ctx.font = police(13 * k, 700);
    espace(ctx, 'BRIEF', xTexte, yCarte + 40 * k, 2.6 * k);

    ctx.fillStyle = TEXTE;
    ctx.font = police(27 * k, 600);
    const phrase = 'Crème hydratante bio, cible 25-35 ans, ton naturel, format 9:16.';
    const caracteres = Math.min(phrase.length, Math.ceil(phrase.length * Math.min(1, local * 1.55)));
    const visibles = lignes(ctx, phrase.slice(0, caracteres), largeurTexte);
    visibles.forEach((ligne, index) => {
      ctx.fillText(ligne, xTexte, yCarte + 92 * k + index * 38 * k);
    });

    // Curseur : la saisie est en cours.
    if (Math.floor(t * 3) % 2 === 0) {
      const derniere = visibles[visibles.length - 1] ?? '';
      ctx.fillStyle = ROSE;
      ctx.fillRect(xTexte + ctx.measureText(derniere).width + 3 * k, yCarte + 92 * k + (visibles.length - 1) * 38 * k - 18 * k, 2.4 * k, 25 * k);
    }

    // Chips de paramètres.
    const chips = ['9:16', '15 s', 'Naturel', '1 modèle'];
    let xChip = xTexte;
    ctx.font = police(15 * k, 600);
    chips.forEach((chip) => {
      const largeurChip = ctx.measureText(chip).width + 26 * k;
      arrondi(ctx, xChip, yCarte + 250 * k, largeurChip, 32 * k, 16 * k);
      ctx.fillStyle = 'rgba(240,56,158,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,56,158,0.32)';
      ctx.lineWidth = 1 * k;
      ctx.stroke();
      ctx.fillStyle = '#F7A8CF';
      ctx.fillText(chip, xChip + 13 * k, yCarte + 271 * k);
      xChip += largeurChip + 9 * k;
    });

    // Aperçu de brief : lignes de contexte.
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    arrondi(ctx, xTexte, yCarte + 320 * k, largeurTexte, 1.4 * k, 1 * k);
    ctx.fill();
    ctx.fillStyle = 'rgba(185,175,199,0.55)';
    ctx.font = police(15 * k, 400);
    ['• Produit fourni avec 3 visuels', '• Ton direct, sans voix off robotique', '• Sous-titres incrustés'].forEach((ligne, i) => {
      ctx.fillText(ligne, xTexte, yCarte + 372 * k + i * 34 * k);
    });
  } else if (phase === 1) {
    ctx.fillStyle = MAGENTA;
    ctx.font = police(13 * k, 700);
    espace(ctx, 'SCRIPT', xTexte, yCarte + 40 * k, 2.6 * k);

    const script = [
      { n: '01', t: 'Accroche — « Ta peau respire enfin. »' },
      { n: '02', t: 'Scène 2 — texture en gros plan' },
      { n: '03', t: 'Scène 3 — avant / après' },
      { n: '04', t: 'CTA — « Découvre la routine »' },
    ];
    script.forEach((ligne, index) => {
      const seuil = (index + 0.15) / (script.length + 0.6);
      const avance = Math.min(1, Math.max(0, (local - seuil) / 0.16));
      if (avance <= 0) return;
      ctx.globalAlpha = avance;
      ctx.fillStyle = index === 3 ? ORANGE : 'rgba(240,56,158,0.85)';
      ctx.font = police(13 * k, 700);
      ctx.fillText(ligne.n, xTexte, yCarte + 96 * k + index * 62 * k);
      ctx.fillStyle = TEXTE;
      ctx.font = police(17 * k, 500);
      lignes(ctx, ligne.t, largeurTexte - 34 * k).forEach((texte, j) => {
        ctx.fillText(texte, xTexte + 32 * k, yCarte + 96 * k + index * 62 * k + j * 22 * k);
      });
      ctx.globalAlpha = 1;
    });

    // Forme d'onde : signe de la voix à venir.
    const yOnde = yCarte + 420 * k;
    const barres = 28;
    for (let i = 0; i < barres; i += 1) {
      const phaseOnde = Math.sin((i / barres) * Math.PI * 3 + t * 4) * 0.5 + 0.5;
      const h = (6 + phaseOnde * 32) * k;
      arrondi(ctx, xTexte + i * (largeurTexte / barres), yOnde - h / 2, 3.4 * k, h, 2 * k);
      ctx.fillStyle = i / barres < local ? 'rgba(251,113,133,0.85)' : 'rgba(255,255,255,0.12)';
      ctx.fill();
    }
  } else if (phase === 2) {
    ctx.fillStyle = MAGENTA;
    ctx.font = police(13 * k, 700);
    espace(ctx, 'STORYBOARD', xTexte, yCarte + 40 * k, 2.6 * k);

    const largeurPlan = (largeurTexte - 30 * k) / 4;
    const teintes = [MAGENTA, ROSE, VIOLET, ORANGE];
    for (let i = 0; i < 4; i += 1) {
      const x = xTexte + i * (largeurPlan + 10 * k);
      const apparait = Math.min(1, Math.max(0, (local - i * 0.1) / 0.18));
      ctx.globalAlpha = apparait;
      arrondi(ctx, x, yCarte + 70 * k, largeurPlan, 300 * k, 14 * k);
      ctx.save();
      ctx.clip();
      const g = ctx.createLinearGradient(x, yCarte + 70 * k, x + largeurPlan, yCarte + 370 * k);
      g.addColorStop(0, `${teintes[i]}66`);
      g.addColorStop(0.6, 'rgba(20,8,28,0.9)');
      g.addColorStop(1, '#0B0512');
      ctx.fillStyle = g;
      ctx.fillRect(x, yCarte + 70 * k, largeurPlan, 300 * k);
      // Silhouette de produit, jamais une personne.
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      arrondi(ctx, x + largeurPlan * 0.26, yCarte + 150 * k, largeurPlan * 0.48, 120 * k, 16 * k);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1 * k;
      arrondi(ctx, x, yCarte + 70 * k, largeurPlan, 300 * k, 14 * k);
      ctx.stroke();
      ctx.fillStyle = 'rgba(247,242,250,0.7)';
      ctx.font = police(12 * k, 600);
      ctx.fillText(`Plan ${i + 1}`, x + 8 * k, yCarte + 390 * k);
      ctx.globalAlpha = 1;
    }

    // Barre de génération.
    const yBarre = yCarte + 470 * k;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    arrondi(ctx, xTexte, yBarre, largeurTexte, 8 * k, 4 * k);
    ctx.fill();
    const rempli = Math.min(1, local * 1.15);
    const gBarre = ctx.createLinearGradient(xTexte, yBarre, xTexte + largeurTexte, yBarre);
    gBarre.addColorStop(0, MAGENTA);
    gBarre.addColorStop(0.7, ROSE);
    gBarre.addColorStop(1, ORANGE);
    ctx.save();
    arrondi(ctx, xTexte, yBarre, largeurTexte, 8 * k, 4 * k);
    ctx.clip();
    ctx.fillStyle = gBarre;
    ctx.fillRect(xTexte, yBarre, largeurTexte * rempli, 8 * k);
    ctx.restore();

    ctx.fillStyle = TEXTE;
    ctx.font = police(17 * k, 600);
    ctx.fillText('Génération en cours', xTexte, yBarre + 40 * k);
    ctx.fillStyle = TEXTE_DOUX;
    ctx.font = police(13 * k, 400);
    ctx.fillText('Devis vérifié avant lancement', xTexte, yBarre + 62 * k);
    ctx.textAlign = 'right';
    ctx.fillStyle = ROSE;
    ctx.font = police(20 * k, 700);
    ctx.fillText(`${Math.round(rempli * 100)} %`, xTexte + largeurTexte, yBarre + 42 * k);
    ctx.textAlign = 'left';
  } else {
    // Vidéo : le visuel occupe la carte, avec une lumière chaude.
    const x = marge + 10 * k;
    const y = yCarte + 10 * k;
    const l = largeur - marge * 2 - 20 * k;
    const h = hCarte - 20 * k;
    ctx.save();
    arrondi(ctx, x, y, l, h, 20 * k);
    ctx.clip();
    if (poster) {
      const ratio = Math.max(l / 752, h / 1392);
      const lw = 752 * ratio;
      const lh = 1392 * ratio;
      ctx.drawImage(poster, x + (l - lw) / 2, y + (h - lh) / 2, lw, lh);
    } else {
      const g = ctx.createLinearGradient(x, y, x + l, y + h);
      g.addColorStop(0, '#2A0A2E');
      g.addColorStop(1, '#0B0512');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, l, h);
    }
    // Voile sombre en bas pour le texte.
    const voile = ctx.createLinearGradient(0, y + h * 0.5, 0, y + h);
    voile.addColorStop(0, 'rgba(5,3,10,0)');
    voile.addColorStop(1, 'rgba(5,3,10,0.86)');
    ctx.fillStyle = voile;
    ctx.fillRect(x, y + h * 0.5, l, h * 0.5);

    // Bouton lecture.
    const cx = x + l / 2;
    const cy = y + h * 0.44;
    ctx.beginPath();
    ctx.arc(cx, cy, 42 * k, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,3,10,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6 * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 9 * k, cy - 15 * k);
    ctx.lineTo(cx + 17 * k, cy);
    ctx.lineTo(cx - 9 * k, cy + 15 * k);
    ctx.closePath();
    ctx.fillStyle = TEXTE;
    ctx.fill();

    // Pastille « Vidéo prête ».
    ctx.font = police(14 * k, 700);
    const largeurPastille = ctx.measureText('Vidéo prête').width + 42 * k;
    arrondi(ctx, x + 18 * k, y + 18 * k, largeurPastille, 30 * k, 15 * k);
    ctx.fillStyle = 'rgba(251,113,133,0.2)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(251,113,133,0.6)';
    ctx.lineWidth = 1 * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 33 * k, y + 33 * k, 4 * k, 0, Math.PI * 2);
    ctx.fillStyle = ROSE;
    ctx.fill();
    ctx.fillStyle = '#FFD9DF';
    ctx.fillText('Vidéo prête', x + 43 * k, y + 34 * k);

    // Légende + barre de lecture.
    ctx.fillStyle = TEXTE;
    ctx.font = police(22 * k, 600);
    ctx.fillText('Publicité UGC · 9:16', x + 20 * k, y + h - 62 * k);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    arrondi(ctx, x + 20 * k, y + h - 38 * k, l - 40 * k, 4 * k, 2 * k);
    ctx.fill();
    ctx.fillStyle = ORANGE;
    arrondi(ctx, x + 20 * k, y + h - 38 * k, (l - 40 * k) * Math.min(1, local * 1.2), 4 * k, 2 * k);
    ctx.fill();
    ctx.restore();
  }

  /* ----------------------------------------------------------------- */
  /* Pied de carte : progression du devis à la vidéo                     */
  /* ----------------------------------------------------------------- */
  const yPied = hauteur - 96 * k;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  arrondi(ctx, marge, yPied, largeur - marge * 2, 6 * k, 3 * k);
  ctx.fill();
  const gPied = ctx.createLinearGradient(marge, yPied, largeur - marge, yPied);
  gPied.addColorStop(0, MAGENTA);
  gPied.addColorStop(0.62, ROSE);
  gPied.addColorStop(1, ORANGE);
  ctx.save();
  arrondi(ctx, marge, yPied, largeur - marge * 2, 6 * k, 3 * k);
  ctx.clip();
  ctx.fillStyle = gPied;
  ctx.fillRect(marge, yPied, (largeur - marge * 2) * (0.18 + (phase + local) / 4 * 0.82), 6 * k);
  ctx.restore();
  ctx.fillStyle = 'rgba(185,175,199,0.7)';
  ctx.font = police(12 * k, 500);
  ctx.fillText('Devis affiché avant chaque génération', marge, yPied + 28 * k);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(185,175,199,0.5)';
  ctx.fillText(`Étape ${phase + 1}/4`, largeur - marge, yPied + 28 * k);
  ctx.textAlign = 'left';

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Écran géant du Studio                                               */
/* ------------------------------------------------------------------ */

export function dessinerEcranGeant(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  etape: number,
  poster?: CanvasImageSource | null,
) {
  const k = largeur / 1024;
  ctx.clearRect(0, 0, largeur, hauteur);

  arrondi(ctx, 0, 0, largeur, hauteur, 26 * k);
  ctx.save();
  ctx.clip();

  ctx.fillStyle = '#08040E';
  ctx.fillRect(0, 0, largeur, hauteur);
  const halo = ctx.createRadialGradient(largeur * 0.5, 0, 0, largeur * 0.5, 0, hauteur * 1.1);
  halo.addColorStop(0, 'rgba(240,56,158,0.16)');
  halo.addColorStop(1, 'rgba(240,56,158,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, largeur, hauteur);

  // Barre de fenêtre.
  const yBarre = 34 * k;
  for (let i = 0; i < 3; i += 1) {
    ctx.beginPath();
    ctx.arc(28 * k + i * 16 * k, yBarre, 4.4 * k, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? MAGENTA : 'rgba(255,255,255,0.16)';
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(247,242,250,0.55)';
  ctx.font = police(15 * k, 600);
  espace(ctx, 'SORAHNEX · STUDIO UGC', 88 * k, yBarre + 5 * k, 1.8 * k);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(185,175,199,0.6)';
  ctx.font = police(14 * k, 500);
  ctx.fillText('Devis vérifié avant chaque génération', largeur - 34 * k, yBarre + 5 * k);
  ctx.textAlign = 'left';

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1 * k;
  ctx.beginPath();
  ctx.moveTo(0, 66 * k);
  ctx.lineTo(largeur, 66 * k);
  ctx.stroke();

  // Colonne des étapes.
  const etapes = ['Brief', 'Script', 'Storyboard', 'Vidéo'];
  const yEtapes = 108 * k;
  etapes.forEach((titre, i) => {
    const actif = i === etape;
    if (actif) {
      arrondi(ctx, 24 * k, yEtapes + i * 62 * k - 20 * k, 206 * k, 44 * k, 10 * k);
      ctx.fillStyle = 'rgba(240,56,158,0.13)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,56,158,0.4)';
      ctx.lineWidth = 1 * k;
      ctx.stroke();
    }
    ctx.fillStyle = actif ? '#F7A8CF' : 'rgba(185,175,199,0.5)';
    ctx.font = police(11 * k, 700);
    ctx.fillText(`0${i + 1}`, 40 * k, yEtapes + i * 62 * k + 4 * k);
    ctx.fillStyle = actif ? TEXTE : 'rgba(185,175,199,0.55)';
    ctx.font = police(17 * k, actif ? 600 : 400);
    ctx.fillText(titre, 74 * k, yEtapes + i * 62 * k + 4 * k);
  });

  // Zone centrale.
  const xZone = 268 * k;
  const lZone = largeur - xZone - 34 * k;
  const yZone = 108 * k;
  const hZone = hauteur - yZone - 90 * k;
  arrondi(ctx, xZone, yZone, lZone, hZone, 18 * k);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1 * k;
  ctx.stroke();

  ctx.save();
  arrondi(ctx, xZone, yZone, lZone, hZone, 18 * k);
  ctx.clip();

  if (etape === 3) {
    if (poster) {
      const ratio = Math.max(lZone / 752, hZone / 1392);
      ctx.drawImage(poster, xZone + (lZone - 752 * ratio) / 2, yZone + (hZone - 1392 * ratio) / 2, 752 * ratio, 1392 * ratio);
    } else {
      const g = ctx.createLinearGradient(xZone, yZone, xZone + lZone, yZone + hZone);
      g.addColorStop(0, '#2A0A2E');
      g.addColorStop(1, '#0B0512');
      ctx.fillStyle = g;
      ctx.fillRect(xZone, yZone, lZone, hZone);
    }
    const voile = ctx.createLinearGradient(0, yZone + hZone * 0.45, 0, yZone + hZone);
    voile.addColorStop(0, 'rgba(5,3,10,0)');
    voile.addColorStop(1, 'rgba(5,3,10,0.9)');
    ctx.fillStyle = voile;
    ctx.fillRect(xZone, yZone + hZone * 0.45, lZone, hZone * 0.55);

    ctx.fillStyle = TEXTE;
    ctx.font = police(30 * k, 600);
    ctx.fillText('Votre publicité est prête.', xZone + 34 * k, yZone + hZone - 86 * k);
    ctx.fillStyle = TEXTE_DOUX;
    ctx.font = police(15 * k, 400);
    ctx.fillText('Bibliothèque privée · 9:16 · sous-titres incrustés', xZone + 34 * k, yZone + hZone - 56 * k);

    const cxp = xZone + lZone / 2;
    const cyp = yZone + hZone * 0.45;
    ctx.beginPath();
    ctx.arc(cxp, cyp, 46 * k, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(5,3,10,0.45)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.6 * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cxp - 10 * k, cyp - 17 * k);
    ctx.lineTo(cxp + 19 * k, cyp);
    ctx.lineTo(cxp - 10 * k, cyp + 17 * k);
    ctx.closePath();
    ctx.fillStyle = TEXTE;
    ctx.fill();
  } else if (etape === 2) {
    const largeurPlan = (lZone - 90 * k) / 3;
    const teintes = [MAGENTA, ROSE, ORANGE];
    for (let i = 0; i < 3; i += 1) {
      const x = xZone + 30 * k + i * (largeurPlan + 15 * k);
      const y = yZone + 44 * k;
      arrondi(ctx, x, y, largeurPlan, hZone - 88 * k, 12 * k);
      ctx.save();
      ctx.clip();
      const g = ctx.createLinearGradient(x, y, x + largeurPlan, y + hZone);
      g.addColorStop(0, `${teintes[i]}55`);
      g.addColorStop(0.7, 'rgba(20,8,28,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, largeurPlan, hZone - 88 * k);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      arrondi(ctx, x + largeurPlan * 0.24, y + (hZone - 88 * k) * 0.36, largeurPlan * 0.52, (hZone - 88 * k) * 0.3, 12 * k);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.strokeRect(x, y, largeurPlan, hZone - 88 * k);
      ctx.fillStyle = 'rgba(247,242,250,0.75)';
      ctx.font = police(14 * k, 600);
      ctx.fillText(`Plan ${i + 1}`, x + 12 * k, y + hZone - 72 * k);
    }
  } else {
    // Brief (0) et script (1).
    ctx.fillStyle = MAGENTA;
    ctx.font = police(13 * k, 700);
    espace(ctx, etape === 0 ? 'BRIEF' : 'SCRIPT', xZone + 30 * k, yZone + 44 * k, 2.4 * k);

    if (etape === 0) {
      ctx.fillStyle = TEXTE;
      ctx.font = police(28 * k, 500);
      lignes(ctx, 'Crème hydratante bio, cible 25-35 ans, ton naturel, format 9:16.', lZone - 60 * k).forEach((ligne, i) => {
        ctx.fillText(ligne, xZone + 30 * k, yZone + 92 * k + i * 38 * k);
      });
      ctx.fillStyle = TEXTE_DOUX;
      ctx.font = police(16 * k, 400);
      ctx.fillText('Catalogue vérifié · 1 modèle disponible', xZone + 30 * k, yZone + 220 * k);

      // Petit aperçu du produit.
      arrondi(ctx, xZone + 30 * k, yZone + 250 * k, 150 * k, hZone - 300 * k, 14 * k);
      const g = ctx.createLinearGradient(xZone + 30 * k, yZone + 250 * k, xZone + 180 * k, yZone + hZone);
      g.addColorStop(0, 'rgba(240,56,158,0.4)');
      g.addColorStop(1, 'rgba(10,5,18,0.9)');
      ctx.fillStyle = g;
      ctx.fill();
    } else {
      ctx.font = police(20 * k, 500);
      const script = [
        '01  Accroche — « Ta peau respire enfin. »',
        '02  Scène 2 — texture en gros plan',
        '03  Scène 3 — avant / après',
        '04  CTA — « Découvre la routine »',
      ];
      script.forEach((ligne, i) => {
        ctx.fillStyle = i === 3 ? '#FFC7A6' : TEXTE;
        ctx.fillText(ligne, xZone + 30 * k, yZone + 104 * k + i * 54 * k);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(xZone + 30 * k, yZone + 124 * k + i * 54 * k, lZone - 60 * k, 1 * k);
      });
    }
  }
  ctx.restore();

  // Barre de génération sous l'écran.
  const yBarreGen = hauteur - 62 * k;
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.font = police(12 * k, 600);
  espace(ctx, 'GÉNÉRATION', 268 * k, yBarreGen - 10 * k, 1.8 * k);
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  arrondi(ctx, 268 * k, yBarreGen, largeur - 302 * k, 8 * k, 4 * k);
  ctx.fill();
  const part = [0.22, 0.48, 0.74, 1][Math.min(3, Math.max(0, etape))];
  const gGen = ctx.createLinearGradient(268 * k, 0, largeur - 34 * k, 0);
  gGen.addColorStop(0, MAGENTA);
  gGen.addColorStop(0.7, ROSE);
  gGen.addColorStop(1, ORANGE);
  ctx.save();
  arrondi(ctx, 268 * k, yBarreGen, largeur - 302 * k, 8 * k, 4 * k);
  ctx.clip();
  ctx.fillStyle = gGen;
  ctx.fillRect(268 * k, yBarreGen, (largeur - 302 * k) * part, 8 * k);
  ctx.restore();

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Panneau de script flottant                                          */
/* ------------------------------------------------------------------ */

export function dessinerPanneauScript(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  progres: number,
  poster?: CanvasImageSource | null,
) {
  const k = largeur / 640;
  ctx.clearRect(0, 0, largeur, hauteur);
  arrondi(ctx, 0, 0, largeur, hauteur, 28 * k);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = 'rgba(10,5,18,0.92)';
  ctx.fillRect(0, 0, largeur, hauteur);
  const g = ctx.createLinearGradient(0, 0, largeur, hauteur);
  g.addColorStop(0, 'rgba(240,56,158,0.18)');
  g.addColorStop(1, 'rgba(124,58,237,0.08)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, largeur, hauteur);

  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(0, 0, largeur, 1.4 * k);
  ctx.fillStyle = MAGENTA;
  ctx.font = police(14 * k, 700);
  espace(ctx, 'SCRIPT EN COURS', 30 * k, 44 * k, 2.4 * k);

  const lignesScript = [
    'Accroche : « Ta peau respire enfin. »',
    'Scène 2 : texture, lumière du matin.',
    'Scène 3 : avant / après, 3 secondes.',
    'CTA : « Découvre la routine ».',
  ];
  const seuils = [0.05, 0.3, 0.55, 0.78];
  lignesScript.forEach((ligne, i) => {
    const avance = Math.min(1, Math.max(0, (progres - seuils[i]) / 0.16));
    if (avance <= 0) return;
    ctx.globalAlpha = avance;
    ctx.fillStyle = i === 3 ? '#FFC7A6' : TEXTE;
    ctx.font = police(18 * k, 500);
    ctx.fillText(ligne, 30 * k, 104 * k + i * 58 * k);
    ctx.globalAlpha = 1;
  });

  if (progres > 0.9) {
    ctx.fillStyle = ROSE;
    ctx.font = police(15 * k, 600);
    ctx.fillText('Script validé', 30 * k, hauteur - 34 * k);
  }

  // Vignette du visuel final, discrète.
  if (poster) {
    arrondi(ctx, largeur - 130 * k, hauteur - 170 * k, 100 * k, 140 * k, 12 * k);
    ctx.save();
    ctx.clip();
    const ratio = Math.max(100 * k / 752, 140 * k / 1392);
    ctx.drawImage(poster, largeur - 130 * k, hauteur - 170 * k, 752 * ratio, 1392 * ratio);
    ctx.restore();
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Étiquette en orbite                                                 */
/* ------------------------------------------------------------------ */

export function dessinerEtiquette(
  ctx: CanvasRenderingContext2D,
  largeur: number,
  hauteur: number,
  texte: string,
  teinte: string,
  detail: string,
) {
  const k = largeur / 512;
  ctx.clearRect(0, 0, largeur, hauteur);
  arrondi(ctx, 4 * k, 4 * k, largeur - 8 * k, hauteur - 8 * k, (hauteur - 8 * k) / 2);
  ctx.fillStyle = 'rgba(8,4,14,0.86)';
  ctx.fill();
  const g = ctx.createLinearGradient(0, 0, largeur, hauteur);
  g.addColorStop(0, teinte);
  g.addColorStop(1, 'rgba(255,255,255,0.18)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 3 * k;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(74 * k, hauteur / 2, 9 * k, 0, Math.PI * 2);
  ctx.fillStyle = teinte;
  ctx.fill();

  ctx.textBaseline = 'middle';
  ctx.fillStyle = TEXTE;
  ctx.font = police(44 * k, 700);
  ctx.fillText(texte, 102 * k, hauteur / 2 - 12 * k);
  ctx.fillStyle = 'rgba(185,175,199,0.8)';
  ctx.font = police(24 * k, 500);
  ctx.fillText(detail, 102 * k, hauteur / 2 + 26 * k);
}

/* ------------------------------------------------------------------ */
/* Texture de halo (additive)                                          */
/* ------------------------------------------------------------------ */

export function dessinerHalo(ctx: CanvasRenderingContext2D, taille: number, teinte: string) {
  ctx.clearRect(0, 0, taille, taille);
  const g = ctx.createRadialGradient(taille / 2, taille / 2, 0, taille / 2, taille / 2, taille / 2);
  g.addColorStop(0, teinte);
  g.addColorStop(0.35, `${teinte}80`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, taille, taille);
}
