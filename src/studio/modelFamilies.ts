/**
 * Studio — classement des modèles MuAPI par FONCTION de création, et
 * explication de chaque blocage par une action concrète.
 *
 * ## Le défaut corrigé
 * L'écran listait les modèles par catégorie technique (`image-to-video`,
 * `text-to-image`…) et affichait « Non disponible · Crédits à configurer ».
 * Deux manques, tous deux visibles par l'utilisateur :
 *
 *   1. **Aucune organisation par fonction** : personne ne cherche « vidéo à
 *      partir d'une image » en pensant « image-to-video ».
 *   2. **Le motif ne disait pas quoi faire** : « Validation réelle en attente
 *      d'autorisation financière » explique la cause mais laisse l'utilisateur
 *      sans action. Un modèle bloqué FAUTE DE PLACEMENT est réparable ; un
 *      modèle bloqué sans piste ne l'est pas.
 *
 * ## Ce que ce module ne fait pas
 * Il ne calcule aucun prix, ne devine aucun modèle et ne débloque rien. Le
 * statut vient du serveur (`blockers`, calculés par `studio-runtime`) ; ce
 * module ne fait que le TRADUIRE pour l'affichage.
 */

/** Fonctions de création, dans l'ordre où un utilisateur les cherche. */
export type FamilleCreation =
  | 'texte_video'
  | 'image_video'
  | 'avatar'
  | 'texte_image'
  | 'image_image'
  | 'audio'
  | 'video_edition'
  | 'autre';

export const FAMILLES: readonly {
  cle: FamilleCreation;
  label: string;
  description: string;
}[] = [
  { cle: 'texte_video', label: 'Texte → vidéo', description: 'Décrire une scène et obtenir une vidéo' },
  { cle: 'image_video', label: 'Image → vidéo', description: 'Animer une image existante' },
  { cle: 'avatar', label: 'Avatar / présentateur', description: 'Faire parler un visage ou un personnage' },
  { cle: 'texte_image', label: 'Texte → image', description: 'Créer une image à partir d’une description' },
  { cle: 'image_image', label: 'Image → image', description: 'Retoucher ou transformer une image' },
  { cle: 'audio', label: 'Audio et voix', description: 'Voix, musique et effets sonores' },
  { cle: 'video_edition', label: 'Montage et vidéo existante', description: 'Découper, allonger, améliorer une vidéo' },
  { cle: 'autre', label: 'Autres outils', description: '3D, upscaling et fonctions spécialisées' },
];

/**
 * Range un modèle dans UNE famille, d'après l'identifiant de catégorie que le
 * catalogue publie déjà.
 *
 * Règle stricte : on ne range nulle part au hasard. Une catégorie inconnue
 * finit dans « Autres outils » plutôt que d'être devinée à partir du nom du
 * modèle — un nom peut contenir « video » sans que le modèle produise une vidéo.
 */
export function familleDe(categorie: string | null | undefined): FamilleCreation {
  const c = (categorie ?? '').toLowerCase().trim();
  if (!c) return 'autre';

  // Avatar / présentateur : doit être testé AVANT les règles vidéo, car ces
  // modèles sont aussi « image → vidéo » techniquement.
  if (/(avatar|talking|lip[-_]?sync|face[-_]?swap|portrait.*anim)/.test(c)) return 'avatar';
  if (/(audio|voice|speech|music|sound|tts)/.test(c)) return 'audio';
  if (/(edit|upscal|extend|interpolat|stitch|merge|montage)/.test(c)) return 'video_edition';
  if (/(image[-_]?to[-_]?video|img2vid|i2v|animate)/.test(c)) return 'image_video';
  if (/(text[-_]?to[-_]?video|txt2vid|t2v)/.test(c)) return 'texte_video';
  if (/(image[-_]?to[-_]?image|img2img|i2i|inpaint|outpaint|style)/.test(c)) return 'image_image';
  if (/(text[-_]?to[-_]?image|txt2img|t2i|text2image|image.gen)/.test(c)) return 'texte_image';
  // Vidéo non qualifiée : on ne sait pas d'où vient l'entrée.
  if (/(video)/.test(c)) return 'texte_video';
  if (/(image)/.test(c)) return 'texte_image';
  return 'autre';
}

/** Regroupe les modèles par famille, dans l'ordre de `FAMILLES`. */
export function grouperParFamille<T extends { category: string }>(
  modeles: readonly T[],
): Array<{ famille: (typeof FAMILLES)[number]; modeles: T[] }> {
  const seaux = new Map<FamilleCreation, T[]>();
  for (const modele of modeles) {
    const famille = familleDe(modele.category);
    const seau = seaux.get(famille);
    if (seau) seau.push(modele);
    else seaux.set(famille, [modele]);
  }
  return FAMILLES
    .filter((famille) => (seaux.get(famille.cle)?.length ?? 0) > 0)
    .map((famille) => ({ famille, modeles: seaux.get(famille.cle) ?? [] }));
}

/**
 * Ce que l'utilisateur peut FAIRE face à un blocage.
 *
 * `qui` distingue une action d'utilisateur d'une action d'administrateur :
 * demander à un client de « configurer les crédits » d'un modèle serait absurde,
 * et lui cacher que ce n'est pas de son ressort l'est tout autant.
 */
export interface ExplicationBlocage {
  /** Formulation technique, pour l'administrateur. */
  libelle: string;
  /** Ce qu'il faut faire, concrètement. */
  action: string;
  /** Qui peut agir. */
  qui: 'vous' | 'administration';
}

export const EXPLICATIONS: Record<string, ExplicationBlocage> = {
  PROVIDER_UNAVAILABLE: {
    libelle: 'Retiré ou non publié par MuAPI',
    action: 'Ce modèle n’est plus proposé par le fournisseur. Choisissez un autre modèle de la même fonction.',
    qui: 'vous',
  },
  ACCESS_UNCONFIRMED: {
    libelle: 'Accès fournisseur non confirmé',
    action: 'La clé MuAPI n’a pas encore prouvé l’accès à ce modèle. Une sonde d’accès doit être relancée par l’administration.',
    qui: 'administration',
  },
  ENDPOINT_UNVERIFIED: {
    libelle: 'Adresse d’appel à vérifier',
    action: 'L’adresse d’exécution de ce modèle n’est pas encore déclarée. Aucune génération ne peut partir sans elle.',
    qui: 'administration',
  },
  SCHEMA_UNSUPPORTED: {
    libelle: 'Formulaire non pris en charge',
    action: 'Les paramètres d’entrée de ce modèle n’ont pas de formulaire. Il reste visible mais ne peut pas être rempli.',
    qui: 'administration',
  },
  UNSAFE_PARAMETER: {
    libelle: 'Paramètre technique refusé',
    action: 'Ce modèle expose un paramètre interdit (URL de rappel, clé, autorisation). Il ne sera pas ouvert.',
    qui: 'administration',
  },
  PRICING_REQUIRED: {
    libelle: 'Prix non établi',
    action: 'MuAPI ne publie pas de prix exploitable pour ce modèle : aucun crédit n’est calculable, donc aucune génération n’est proposée.',
    qui: 'administration',
  },
  ADAPTER_UNVERIFIED: {
    libelle: 'Protocole d’appel non validé',
    action: 'Le format de réponse de ce modèle n’est pas encore pris en charge par l’exécution.',
    qui: 'administration',
  },
  PAID_VALIDATION_PENDING: {
    libelle: 'Validation payante en attente',
    action: 'Une génération réelle (payante) doit confirmer le comportement du modèle avant son ouverture.',
    qui: 'administration',
  },
  ADMIN_DISABLED: {
    libelle: 'Désactivé par l’administration',
    action: 'Ce modèle a été volontairement coupé. Il réapparaîtra si l’administration le réactive.',
    qui: 'administration',
  },
  RUNTIME_DISABLED: {
    libelle: 'Exécution non ouverte',
    action: 'Le modèle est catalogué mais son exécution n’est pas ouverte aux utilisateurs.',
    qui: 'administration',
  },
  QUOTA_POLICY_PENDING: {
    libelle: 'Quota à définir',
    action: 'La famille de quota de ce modèle reste à trancher : sans limite approuvée, il ne peut pas être facturé.',
    qui: 'administration',
  },
  QUOTA_POLICY_MISSING: {
    libelle: 'Aucune limite approuvée',
    action: 'Ce modèle appartient à une famille sans limite approuvée pour le moment.',
    qui: 'administration',
  },
  ESTIMATE_ENDPOINT_UNVERIFIED: {
    libelle: 'Estimation fournisseur à vérifier',
    action: 'Le devis en crédits ne peut pas être obtenu auprès du fournisseur pour ce modèle.',
    qui: 'administration',
  },
  PLAN_UNAVAILABLE: {
    libelle: 'Non inclus dans votre offre',
    action: 'Ce modèle fonctionne mais n’est pas dans votre formule. Vous pouvez changer d’offre pour l’utiliser.',
    qui: 'vous',
  },
};

/** Explication d'un code inconnu : on ne prétend pas savoir. */
export const EXPLICATION_INCONNUE: ExplicationBlocage = {
  libelle: 'Validation nécessaire',
  action: 'Ce modèle n’est pas encore ouvert à la génération. Le motif exact n’est pas reconnu par cette version de l’interface.',
  qui: 'administration',
};

export function expliquerBlocage(code: string | null | undefined): ExplicationBlocage {
  if (!code) return EXPLICATION_INCONNUE;
  return EXPLICATIONS[code] ?? EXPLICATION_INCONNUE;
}

/**
 * Motif PRINCIPAL à afficher sur la carte d'un modèle.
 *
 * Pourquoi un seul : afficher quatorze codes sur une carte rend l'écran
 * illisible. On choisit le plus bloquant pour l'utilisateur, et le détail reste
 * dans la fiche du modèle.
 */
export function motifPrincipal(blockers: readonly string[]): ExplicationBlocage {
  if (blockers.length === 0) {
    return { libelle: 'Opérationnel', action: 'Ce modèle peut être utilisé.', qui: 'vous' };
  }
  /*
   * L'ordre suit ce que l'utilisateur peut réellement changer :
   *   1. PLAN_UNAVAILABLE — il peut changer de formule ;
   *   2. PROVIDER_UNAVAILABLE — il peut choisir un autre modèle ;
   *   3. PRICING_REQUIRED — le modèle est offert par le fournisseur mais pas
   *      encore tarifé chez nous : la cause lui parle, même s'il ne peut pas agir ;
   *   4. ADMIN_DISABLED — coupure volontaire, aucune action de sa part.
   */
  const ordre = ['PLAN_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'PRICING_REQUIRED', 'ADMIN_DISABLED'];
  for (const code of ordre) {
    if (blockers.includes(code)) return expliquerBlocage(code);
  }
  return expliquerBlocage(blockers[0]);
}

/**
 * Un modèle doit-il être MASQUÉ ?
 *
 * Jamais. C'est la règle du produit : un modèle non exécutable reste visible
 * avec sa raison, pour qu'aucun utilisateur ne croie à une fonction absente.
 * Cette fonction existe pour que la règle soit testable et non contournée par
 * inadvertance dans un filtre d'affichage.
 */
export function doitEtreMasque(): boolean {
  return false;
}
