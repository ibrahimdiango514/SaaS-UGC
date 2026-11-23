/**
 * VYORA AI — lecture des pièces jointes côté navigateur.
 *
 * ## Principe
 *
 * On n'envoie jamais un binaire à un modèle de texte. On extrait localement ce
 * qui est lisible, et on ne transmet que ce texte. Deux conséquences utiles :
 *
 *   - rien ne quitte le poste avant l'envoi du message ;
 *   - les formats non lisibles (PDF scanné, image) sont annoncés comme tels
 *     plutôt que silencieusement ignorés.
 *
 * Le PDF et le XLSX sont traités par `files/intoAssistant` : pdf.js extrait le
 * texte des PDF, et le lecteur ZIP existant lit la première feuille XLSX. Les
 * images et vidéos restent annoncées comme non analysées : aucun modèle de
 * texte ne peut les lire, et aucun OCR n'est simulé.
 */

/** Taille maximale d'un fichier joint. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Nombre maximal de pièces jointes par message. */
export const MAX_ATTACHMENTS = 5;

/** Longueur maximale du texte extrait, par fichier. */
export const MAX_EXCERPT_CHARS = 12_000;

/** Formats dont le contenu peut être extrait sans dépendance. */
const EXTENSIONS_TEXTE = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'sql', 'log', 'ini', 'conf',
]);

export interface ReadResult {
  /** Texte extrait, ou `undefined` si le format n'est pas lisible. */
  excerpt?: string;
  /** Explication à afficher quand le contenu n'est pas extrait. */
  reason?: string;
}

/** Extension normalisée d'un nom de fichier. */
export function extensionOf(name: string): string {
  const parts = name.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** Vrai si le fichier peut être lu localement. */
export function isReadable(file: Pick<File, 'name' | 'type'>): boolean {
  if (file.type.startsWith('text/')) return true;
  if (file.type === 'application/json') return true;
  return EXTENSIONS_TEXTE.has(extensionOf(file.name));
}

/** Vrai si le fichier est une image. */
export function isImage(file: Pick<File, 'type'>): boolean {
  return file.type.startsWith('image/');
}

/** Vérifie une pièce jointe avant lecture. Rend `null` si elle est acceptable. */
export function validateAttachment(file: File, existing: number): string | null {
  if (file.size === 0) return `« ${file.name} » est vide.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `« ${file.name} » dépasse ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} Mo.`;
  }
  if (existing >= MAX_ATTACHMENTS) {
    return `Maximum ${MAX_ATTACHMENTS} fichiers par message.`;
  }
  return null;
}

/**
 * Lit un fichier et rend le texte exploitable.
 *
 * Ne lève jamais : un échec de lecture devient une raison affichée. L'appelant
 * n'a donc pas à distinguer « fichier illisible » de « erreur d'E/S ».
 */
export async function readAttachment(file: File): Promise<ReadResult> {
  if (isImage(file)) {
    return { reason: 'Image : contenu non analysé (envoi du nom et du format uniquement).' };
  }
  if (file.type === 'application/pdf' || extensionOf(file.name) === 'pdf') {
    return { reason: 'PDF : extraction de texte non disponible sans bibliothèque dédiée.' };
  }
  if (!isReadable(file)) {
    return { reason: `Format « ${extensionOf(file.name) || 'inconnu'} » non lisible localement.` };
  }

  try {
    const brut = await file.text();
    const propre = brut.replace(/\u0000/g, '').trim();
    if (!propre) return { reason: 'Fichier vide après lecture.' };
    if (propre.length > MAX_EXCERPT_CHARS) {
      return {
        excerpt: `${propre.slice(0, MAX_EXCERPT_CHARS)}\n\n[… tronqué : ${propre.length} caractères au total]`,
      };
    }
    return { excerpt: propre };
  } catch (error) {
    return { reason: `Lecture impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}.` };
  }
}

/** Taille lisible. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}
