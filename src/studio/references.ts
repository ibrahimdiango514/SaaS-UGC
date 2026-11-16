/**
 * Studio — références multiples et capacité réelle des modèles.
 *
 * ## La règle qui gouverne ce module
 * Un média n'est envoyé à un modèle **que si le modèle déclare réellement le
 * champ correspondant** dans son catalogue (`input_fields`). On ne « tente
 * pas » un envoi : on refuse, en disant pourquoi.
 *
 * Cela vaut pour chaque forme de référence :
 *   * image unique   → `image_url` / `images_list` / `image_urls` / `reference_images`
 *   * vidéo          → `video_url` / `input_video` / `reference_video_url` / `reference_videos`
 *   * image de fin   → `last_image` / `end_image_url`
 *
 * ## Ce qui était faux avant
 * Le studio n'offrait qu'une image de référence et une image de fin. Les champs
 * `images_list` (131 modèles vérifiés), `image_urls` (6), `reference_images` (4),
 * `reference_videos` (4) existaient en base mais n'étaient jamais renseignés :
 * des capacités déclarées et inutilisées.
 *
 * ## Ordre de priorité
 * Quand plusieurs champs sont disponibles, on choisit le plus spécifique :
 * `images_list` porte plusieurs images, `image_url` une seule. Un modèle qui
 * déclare `images_list` reçoit une LISTE, jamais une concaténation.
 */

/** Champ de référence, tel que déclaré par le catalogue des modèles. */
export type ReferenceField =
  | 'images_list'
  | 'image_urls'
  | 'image_url'
  | 'reference_images'
  | 'last_image'
  | 'video_url'
  | 'reference_video_url'
  | 'reference_videos'
  | 'input_video';

/** Une référence prête à partir : chemin Storage et URL signée. */
export interface ResolvedReference {
  fileId: string;
  name: string;
  kind: 'image' | 'video';
  role: string | null;
  storagePath: string;
  url: string;
}

/** Ce qu'un modèle accepte, déduit de ses champs déclarés. */
export interface ModelReferenceSupport {
  /** Champ utilisé pour les images, `null` si le modèle n'en accepte aucune. */
  imageField: Extract<ReferenceField, 'images_list' | 'image_urls' | 'image_url' | 'reference_images'> | null;
  /** Le champ image accepte-t-il PLUSIEURS images ? */
  imageMultiple: boolean;
  /** Nombre maximal d'images utiles. Un seul emplacement = 1. */
  imageLimit: number;
  /** Champ vidéo disponible, `null` si aucune vidéo n'est acceptée. */
  videoField: Extract<ReferenceField, 'video_url' | 'reference_video_url' | 'reference_videos' | 'input_video'> | null;
  /** Champ d'image de fin (première → dernière image). */
  lastImageField: 'last_image' | 'end_image_url' | null;
}

const IMAGE_FIELDS_IN_PRIORITY = ['images_list', 'image_urls', 'reference_images', 'image_url'] as const;
const VIDEO_FIELDS_IN_PRIORITY = ['reference_videos', 'video_url', 'reference_video_url', 'input_video'] as const;

/** Champs image qui acceptent plusieurs valeurs. */
const MULTI_IMAGE_FIELDS = new Set<string>(['images_list', 'image_urls', 'reference_images']);

/**
 * Déduit la capacité d'un modèle à partir de ses champs DÉCLARÉS.
 *
 * Fonction pure : testable sans base ni réseau.
 */
export function referenceSupport(inputFields: readonly string[]): ModelReferenceSupport {
  const fields = new Set(inputFields.map((field) => field.toLowerCase()));

  const imageField = IMAGE_FIELDS_IN_PRIORITY.find((field) => fields.has(field)) ?? null;
  const videoField = VIDEO_FIELDS_IN_PRIORITY.find((field) => fields.has(field)) ?? null;
  const lastImageField = fields.has('last_image')
    ? 'last_image' as const
    : fields.has('end_image_url') ? 'end_image_url' as const : null;

  const imageMultiple = imageField ? MULTI_IMAGE_FIELDS.has(imageField) : false;

  return {
    imageField,
    imageMultiple,
    // Un champ mono-image ne peut porter qu'une référence : annoncer
    // « plusieurs images acceptées » serait faux.
    imageLimit: imageField ? (imageMultiple ? 8 : 1) : 0,
    videoField,
    lastImageField,
  };
}

export interface ReferencePlan {
  /** Ce qui partira réellement au modèle. */
  images: ResolvedReference[];
  videos: ResolvedReference[];
  lastImage: ResolvedReference | null;
  /** Références écartées, avec le motif exact. */
  rejected: Array<{ reference: ResolvedReference; reason: string }>;
  /** Message d'ensemble, si le modèle n'accepte rien de ce qui a été fourni. */
  warning: string | null;
}

/**
 * Répartit les références d'un projet sur les champs réellement supportés.
 *
 * @param references Références du projet, dans l'ordre d'ajout.
 * @param support Capacité du modèle sélectionné.
 */
export function planReferences(
  references: ResolvedReference[],
  support: ModelReferenceSupport,
): ReferencePlan {
  const images = references.filter((reference) => reference.kind === 'image');
  const videos = references.filter((reference) => reference.kind === 'video');
  const rejected: ReferencePlan['rejected'] = [];

  const acceptedImages: ResolvedReference[] = [];
  if (!support.imageField) {
    for (const image of images) {
      rejected.push({
        reference: image,
        reason: 'Ce modèle n’accepte aucune image de référence : elle n’est pas transmise.',
      });
    }
  } else {
    for (const image of images) {
      if (acceptedImages.length < support.imageLimit) acceptedImages.push(image);
      else {
        rejected.push({
          reference: image,
          reason: `Ce modèle accepte au plus ${support.imageLimit} image(s) de référence : celle-ci n’est pas transmise.`,
        });
      }
    }
  }

  const acceptedVideos: ResolvedReference[] = [];
  if (!support.videoField) {
    for (const video of videos) {
      rejected.push({
        reference: video,
        reason: 'Ce modèle n’accepte aucune vidéo de référence : elle n’est pas transmise.',
      });
    }
  } else {
    // Un champ vidéo ne porte qu'une source dans le catalogue actuel : on
    // n'invente pas une liste là où le modèle n'en déclare pas.
    for (const video of videos) {
      if (acceptedVideos.length === 0) acceptedVideos.push(video);
      else {
        rejected.push({
          reference: video,
          reason: 'Ce modèle n’accepte qu’une seule vidéo de référence : celle-ci n’est pas transmise.',
        });
      }
    }
  }

  return {
    images: acceptedImages,
    videos: acceptedVideos,
    lastImage: acceptedImages.length > 1 ? acceptedImages[acceptedImages.length - 1] : null,
    rejected,
    warning: acceptedImages.length === 0 && acceptedVideos.length === 0 && references.length > 0
      ? 'Aucune des références fournies n’est acceptée par ce modèle. La génération se fera sans elles.'
      : null,
  };
}

/**
 * Construit les champs de médias du payload envoyé à l'Edge Function.
 *
 * Les noms de clés correspondent à ce que le serveur sait lire
 * (`image_storage_paths`, `video_storage_paths`, …). Les URL signées ne sont
 * PAS envoyées : le serveur les régénère, car une URL signée côté navigateur
 * expire et ne doit pas être tenue pour fiable.
 */
export function mediaPayload(plan: ReferencePlan, support: ModelReferenceSupport): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const imagePaths = plan.images.map((reference) => reference.storagePath);

  if (support.imageField && imagePaths.length > 0) {
    payload.image_storage_paths = imagePaths;
    // Le premier reste exposé sous la forme historique, pour ne rien casser si
    // le serveur n'a pas encore été mis à jour.
    payload.image_storage_path = imagePaths[0];
  }
  if (support.lastImageField && plan.lastImage) {
    payload.last_image_storage_path = plan.lastImage.storagePath;
  }
  if (support.videoField && plan.videos.length > 0) {
    payload.video_storage_path = plan.videos[0].storagePath;
    payload.video_storage_paths = plan.videos.map((reference) => reference.storagePath);
  }
  return payload;
}
