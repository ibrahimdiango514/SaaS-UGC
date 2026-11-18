/**
 * VYORA FILES — règles communes de type, de taille et de prévisualisation.
 *
 * ## Pourquoi ce module est pur
 * Ces règles sont utilisées par l'interface, par les tests et par la
 * documentation des limites. Elles ne touchent ni au DOM ni au réseau, pour
 * rester vérifiables sans navigateur.
 *
 * ## Ce qui est réellement contrôlé
 * Le `File.type` du navigateur et l'extension du nom sont **déclarés** par le
 * client : ils ne prouvent rien. La fonction `detectType` lit les premiers
 * octets du fichier (signature / « magic bytes ») et c'est CE résultat qui fait
 * foi. Un fichier renommé `photo.png` qui contient autre chose est refusé.
 *
 * Les formats bureautiques (DOCX, XLSX) sont des archives ZIP : ils partagent
 * la même signature. On les distingue par l'extension **après** avoir constaté
 * qu'il s'agit bien d'un ZIP, ce qui suffit à exclure un exécutable ou un
 * fichier texte déguisé.
 */

/** Plafond de taille d'un fichier, aligné sur la limite du bucket. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Nombre d'octets nécessaires pour identifier tous les formats gérés. */
export const HEADER_BYTES = 16;

export type FileKind = 'image' | 'video' | 'document' | 'spreadsheet' | 'audio' | 'other';

/** Usage Studio d'une référence. */
export type ReferenceRole =
  | 'character'
  | 'product'
  | 'decor'
  | 'environment'
  | 'object'
  | 'video_reference'
  | 'photo';

export type PreviewKind = 'image' | 'video' | 'pdf' | 'text';

export interface DetectedType {
  /** Type MIME canonique, déduit du contenu et non du nom. */
  mimeType: string;
  /** Extension canonique (minuscules, sans point). */
  extension: string;
  kind: FileKind;
  /** Prévisualisation possible, ou `null` si le format ne s'y prête pas. */
  previewKind: PreviewKind | null;
  /** Vrai si le format figure dans la liste blanche. */
  accepted: boolean;
  /** Motif de refus, lorsque `accepted` est faux. */
  reason?: string;
}

interface Signature {
  mimeType: string;
  extension: string;
  kind: FileKind;
  previewKind: PreviewKind | null;
  /**
   * Octets attendus au début du fichier. `null` à une position = octet libre.
   * Les comparaisons portent sur les premières positions uniquement.
   */
  bytes: Array<number | null>;
  /** Décalage d'application de la signature (MP4 : boîte `ftyp` à l'offset 4). */
  offset?: number;
  /**
   * Extensions attendues dans le nom du fichier. Elles servent à départager des
   * formats qui partagent une signature (ZIP pour DOCX/XLSX, ISO-BMFF pour
   * MP4/MOV) — jamais à décider seul qu'un fichier est acceptable.
   */
  extensions?: string[];
}

const ascii = (text: string): number[] => text.split('').map((char) => char.charCodeAt(0));

/**
 * Signatures connues, dans l'ordre de priorité.
 *
 * `ISO-BMFF` (MP4/MOV/M4V) partage les octets `ftyp` : on lit la marque
 * secondaire (`isom`, `mp42`, `qt  `, `M4V `) pour trancher le type MIME réel.
 */
const SIGNATURES: Signature[] = [
  // --- Images ---
  { mimeType: 'image/png', extension: 'png', kind: 'image', previewKind: 'image', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', extension: 'jpg', kind: 'image', previewKind: 'image', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', extension: 'gif', kind: 'image', previewKind: 'image', bytes: ascii('GIF87a') },
  { mimeType: 'image/gif', extension: 'gif', kind: 'image', previewKind: 'image', bytes: ascii('GIF89a') },
  {
    mimeType: 'image/webp', extension: 'webp', kind: 'image', previewKind: 'image',
    bytes: [...ascii('RIFF'), null, null, null, null, ...ascii('WEBP')],
  },
  {
    mimeType: 'image/avif', extension: 'avif', kind: 'image', previewKind: 'image',
    bytes: [null, null, null, null, ...ascii('ftypavif')], offset: 0,
  },
  // --- Documents ---
  { mimeType: 'application/pdf', extension: 'pdf', kind: 'document', previewKind: 'pdf', bytes: ascii('%PDF-') },
  // --- Archives : DOCX/XLSX (ZIP), départagées par l'extension ---
  {
    mimeType: 'application/zip', extension: 'zip', kind: 'document', previewKind: null,
    bytes: [0x50, 0x4b, 0x03, 0x04],
    extensions: ['docx', 'xlsx', 'zip'],
  },
];

/** Extensions des formats ISO-BMFF (vidéo). */
const ISO_BMFF_EXTENSIONS = ['mp4', 'mov', 'm4v'];

/**
 * Marques ISO-BMFF et type MIME associé.
 *
 * `qt  ` porte des espaces de remplissage dans la spécification QuickTime :
 * la clé est écrite exactement, sans retrait, sinon MOV ne serait jamais
 * reconnu et serait classé MP4 (défaut relevé par le test dédié).
 */
const ISO_BMFF_BRANDS: Record<string, { mimeType: string; extension: string }> = {
  isom: { mimeType: 'video/mp4', extension: 'mp4' },
  iso2: { mimeType: 'video/mp4', extension: 'mp4' },
  isom4: { mimeType: 'video/mp4', extension: 'mp4' },
  mp41: { mimeType: 'video/mp4', extension: 'mp4' },
  mp42: { mimeType: 'video/mp4', extension: 'mp4' },
  avc1: { mimeType: 'video/mp4', extension: 'mp4' },
  'qt  ': { mimeType: 'video/quicktime', extension: 'mov' },
  'M4V ': { mimeType: 'video/x-m4v', extension: 'm4v' },
};

/** Signatures audio reconnues (webm partage un conteneur Matroska). */
const AUDIO_SIGNATURES: Signature[] = [
  { mimeType: 'audio/mpeg', extension: 'mp3', kind: 'audio', previewKind: null, bytes: ascii('ID3') },
  { mimeType: 'audio/mpeg', extension: 'mp3', kind: 'audio', previewKind: null, bytes: [0xff, 0xfb] },
  { mimeType: 'audio/wav', extension: 'wav', kind: 'audio', previewKind: null, bytes: [...ascii('RIFF'), null, null, null, null, ...ascii('WAVE')] },
  { mimeType: 'audio/ogg', extension: 'ogg', kind: 'audio', previewKind: null, bytes: ascii('OggS') },
];

/** Extension normalisée d'un nom de fichier (minuscules, sans point). */
export function extensionOf(name: string): string {
  const clean = name.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot <= 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1).replace(/[^a-z0-9]/g, '');
}

function matches(bytes: Uint8Array, signature: Signature): boolean {
  const offset = signature.offset ?? 0;
  if (bytes.length < offset + signature.bytes.length) return false;
  return signature.bytes.every((expected, index) => expected === null || bytes[offset + index] === expected);
}

function typeFromExtension(name: string): DetectedType | null {
  const extension = extensionOf(name);
  const map: Record<string, DetectedType> = {
    docx: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: 'docx', kind: 'document', previewKind: null, accepted: true },
    xlsx: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx', kind: 'spreadsheet', previewKind: null, accepted: true },
    zip: { mimeType: 'application/zip', extension: 'zip', kind: 'document', previewKind: null, accepted: true },
    csv: { mimeType: 'text/csv', extension: 'csv', kind: 'spreadsheet', previewKind: 'text', accepted: true },
    txt: { mimeType: 'text/plain', extension: 'txt', kind: 'document', previewKind: 'text', accepted: true },
    md: { mimeType: 'text/plain', extension: 'md', kind: 'document', previewKind: 'text', accepted: true },
  };
  return map[extension] ?? null;
}

/**
 * Vrai si les octets forment du texte UTF-8 sans caractère de contrôle.
 *
 * ## Pourquoi un décodage strict, et pas un simple comptage d'octets
 * Une première version comptait les octets « imprimables » en ASCII. Or les
 * octets ≥ 0x80 y passaient pour imprimables : un fichier binaire inconnu
 * (0x89 0x50…) était alors classé « texte » et donc ACCEPTÉ. Le test
 * « fichier tronqué » l'a révélé. On utilise donc `TextDecoder` en mode fatal :
 * une séquence UTF-8 invalide est du binaire, sans ambiguïté.
 *
 * Une en-tête peut couper un caractère multioctet en deux : on retire jusqu'à
 * trois octets de fin avant de conclure au binaire, sinon un fichier texte
 * parfaitement valide serait refusé une fois sur cinq.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return false; // NUL : binaire, jamais du texte

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string | null = null;
  for (let trim = 0; trim <= 3 && text === null; trim += 1) {
    const slice = bytes.subarray(0, bytes.length - trim);
    if (slice.length === 0) break;
    try {
      text = decoder.decode(slice);
    } catch {
      // séquence coupée en fin d'en-tête : on réessaie en retirant un octet
    }
  }
  if (text === null) return false;

  // Caractères de contrôle (hors tabulation et sauts de ligne) : binaire.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

/**
 * Détermine le type réel d'un fichier à partir de ses premiers octets.
 *
 * @param name Nom d'origine : sert uniquement à départager des formats de même
 *   signature, jamais à décider qu'un contenu est acceptable.
 * @param header Premiers octets du fichier (`HEADER_BYTES` suffisent).
 */
export function detectType(name: string, header: Uint8Array): DetectedType {
  const extension = extensionOf(name);

  // 1) Conteneurs ISO-BMFF (MP4 / MOV / M4V) : signature à l'offset 4.
  if (header.length >= 12 && String.fromCharCode(...header.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...header.slice(8, 12));
    // QuickTime écrit « qt  » : on essaie la marque brute, puis sans
    // remplissage, sans jamais retirer les espaces d'une clé de la table.
    const known = ISO_BMFF_BRANDS[brand]
      ?? ISO_BMFF_BRANDS[brand.replace(/[\s\0]+$/, '')];
    if (known) {
      return { ...known, kind: 'video', previewKind: 'video', accepted: true };
    }
    // Signature de conteneur reconnue mais marque inconnue : on n'invente pas
    // un type MIME. L'extension tranche, sinon refus.
    if (ISO_BMFF_EXTENSIONS.includes(extension)) {
      return {
        mimeType: 'video/mp4', extension, kind: 'video', previewKind: 'video', accepted: true,
      };
    }
    return {
      mimeType: 'application/octet-stream', extension: extension || 'inconnu',
      kind: 'other', previewKind: null, accepted: false,
      reason: 'Conteneur vidéo non reconnu : le format n’est pas dans la liste autorisée.',
    };
  }

  // 2) Signatures binaires connues.
  for (const signature of SIGNATURES) {
    if (!matches(header, signature)) continue;

    // ZIP : DOCX et XLSX partagent cette signature, comme toute archive ZIP.
    // On n'accepte DONC pas le ZIP en général : seules les extensions
    // bureautiques documentées passent. Accepter « .zip » reviendrait à ouvrir
    // la porte à n'importe quel contenu, sans prévisualisation ni analyse.
    if (signature.extensions) {
      const byExtension = typeFromExtension(name);
      if (byExtension && (byExtension.extension === 'docx' || byExtension.extension === 'xlsx')) {
        return byExtension;
      }
      return {
        mimeType: 'application/zip', extension: 'zip', kind: 'other',
        previewKind: null, accepted: false,
        reason: 'Archive ZIP non identifiée comme document bureautique : seuls DOCX et XLSX sont acceptés.',
      };
    }

    return {
      mimeType: signature.mimeType, extension: signature.extension, kind: signature.kind,
      previewKind: signature.previewKind, accepted: true,
    };
  }

  // 3) Audio.
  for (const signature of AUDIO_SIGNATURES) {
    if (!matches(header, signature)) continue;
    return {
      mimeType: signature.mimeType, extension: signature.extension, kind: 'audio',
      previewKind: null, accepted: true,
    };
  }

  // 4) Matroska / WebM.
  if (matches(header, { mimeType: '', extension: '', kind: 'video', previewKind: null, bytes: [0x1a, 0x45, 0xdf, 0xa3] })) {
    return {
      mimeType: extension === 'webm' ? 'video/webm' : 'video/webm',
      extension: 'webm', kind: 'video', previewKind: 'video', accepted: true,
    };
  }

  // 5) Texte : CSV, TXT, MD. Lecture des octets, pas du type déclaré.
  if (looksLikeText(header)) {
    const byExtension = typeFromExtension(name);
    if (byExtension && byExtension.previewKind === 'text') return byExtension;
    return {
      mimeType: 'text/plain', extension: extension || 'txt', kind: 'document',
      previewKind: 'text', accepted: true,
    };
  }

  // 6) Tout le reste est refusé, y compris les exécutables.
  return {
    mimeType: 'application/octet-stream', extension: extension || 'inconnu',
    kind: 'other', previewKind: null, accepted: false,
    reason: extension
      ? `Format « ${extension} » non autorisé (images, vidéos, PDF, DOCX, XLSX, CSV, TXT).`
      : 'Format non reconnu : l’extension est absente et le contenu n’est pas identifiable.',
  };
}

/** Vérifie la taille avant lecture. Rend `null` si acceptable. */
export function checkSize(sizeBytes: number): string | null {
  if (sizeBytes <= 0) return 'Le fichier est vide.';
  if (sizeBytes > MAX_FILE_BYTES) {
    return `Le fichier dépasse ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} Mo.`;
  }
  return null;
}

/**
 * Chemin de stockage d'un fichier.
 *
 * Le premier segment est **toujours** l'identifiant de l'entreprise : c'est la
 * clé d'isolation des politiques Storage et de la contrainte de la table.
 */
export function storagePathFor(workspaceId: string, kind: FileKind, extension: string): string {
  const folder = kind === 'image' ? 'images'
    : kind === 'video' ? 'videos'
    : kind === 'audio' ? 'audio'
    : 'documents';
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error('Identifiant aléatoire indisponible : envoi impossible.');
  return `${workspaceId}/files/${folder}/${id}.${extension || 'bin'}`;
}

/** Libellés d'usage des références Studio, pour l'interface. */
export const REFERENCE_ROLE_LABELS: Record<ReferenceRole, string> = {
  character: 'Personnage',
  product: 'Produit',
  decor: 'Décor',
  environment: 'Environnement',
  object: 'Objet',
  video_reference: 'Vidéo de référence',
  photo: 'Photo',
};

/** Rôles autorisés pour une image, dans l'ordre d'affichage. */
export const IMAGE_REFERENCE_ROLES: ReferenceRole[] = [
  'character', 'product', 'decor', 'environment', 'object', 'photo',
];

/** Vrai si le rôle convient à une vidéo. */
export function roleAcceptsKind(role: ReferenceRole, kind: FileKind): boolean {
  if (role === 'video_reference') return kind === 'video';
  return kind === 'image';
}
