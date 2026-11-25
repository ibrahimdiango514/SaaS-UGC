/**
 * SORAHNEX FILES → assistant : ce que le modèle peut RÉELLEMENT lire.
 *
 * ## Le problème que ce module résout
 * Avant, une pièce jointe n'existait que dans l'onglet courant : le fichier
 * n'était pas téléversé (`storagePath: null`), et seul un extrait de texte
 * partait. Après rechargement, il n'y avait plus rien — c'est précisément une
 * « fausse pièce jointe ».
 *
 * Désormais : le fichier est téléversé (progression réelle), enregistré en base,
 * et rattaché à la conversation. Son contenu exploitable est préparé ici, avec
 * une règle simple : on ne prétend jamais transmettre au modèle ce qu'il ne
 * peut pas lire.
 *
 * ## Capacités réelles, par genre
 *   * **texte** (TXT, CSV, MD…) : lu localement, transmis tel quel ;
 *   * **PDF** : texte extrait localement par pdf.js, transmis au modèle ; un
 *     PDF scanné sans couche texte est annoncé, sans OCR inventé ;
 *   * **XLSX** : première feuille convertie en tableau texte, transmise ;
 *   * **image** : redimensionnée localement puis transmise à un modèle vision
 *     (Gemini). Le binaire n'est jamais mis dans le texte ni journalisé ; si
 *     aucun modèle vision n'est disponible, l'envoi échoue explicitement ;
 *   * **DOCX** : non extrait ; **vidéo** : jamais lue par un modèle de texte.
 *
 * Ce choix évite deux mensonges symétriques : faire croire qu'une vidéo a été
 * « comprise », ou ignorer silencieusement une pièce jointe.
 */
import type { AiAttachment } from '../ai/api';
import { MAX_EXCERPT_CHARS } from '../ai/attachments';
import { upload, validate, type SorahnnexFile } from './api';
import { readXlsxRows } from '../business/importer/files';
import { asAppError } from '../lib/errors';

/** Ce que le modèle peut faire d'un fichier, dit à l'utilisateur. */
export interface ReadCapability {
  /** Contenu transmis au modèle ? */
  transmitted: boolean;
  /** Explication affichable, toujours renseignée. */
  note: string;
}

/**
 * Détermine la capacité de lecture d'un fichier, à partir de son type RÉEL.
 *
 * Fonction pure : testable sans réseau ni DOM.
 */
export function readCapability(kind: SorahnnexFile['kind'], previewKind: SorahnnexFile['preview_kind']): ReadCapability {
  if (previewKind === 'text') {
    return { transmitted: true, note: 'Contenu texte transmis à l’assistant.' };
  }
  switch (kind) {
    case 'image':
      return {
        transmitted: true,
        note: 'Image transmise au modèle vision (Gemini) pour une analyse réelle.',
      };
    case 'video':
      return {
        transmitted: false,
        note: 'Vidéo enregistrée. Aucun modèle de texte ne peut la lire : elle n’est pas analysée et cela n’est pas simulé.',
      };
    case 'audio':
      return { transmitted: false, note: 'Audio enregistré. Il n’est pas transcrit automatiquement.' };
    case 'spreadsheet':
    case 'document':
      return {
        transmitted: false,
        note: 'Document enregistré. Son contenu n’est pas extrait (PDF, DOCX et XLSX demandent une analyse dédiée non embarquée).',
      };
    default:
      return { transmitted: false, note: 'Fichier enregistré. Son contenu n’est pas lisible par l’assistant.' };
  }
}

/**
 * Extrait le texte d'un PDF dans le navigateur.
 *
 * pdf.js est chargé à la demande : l'analyse PDF n'alourdit pas le premier
 * écran de l'assistant. Un PDF scanné ne contient pas de couche texte : on le
 * dit explicitement au lieu d'envoyer un extrait vide. Aucun OCR n'est simulé.
 */
export async function extractPdfText(file: File): Promise<{ text?: string; reason?: string }> {
  try {
    const [pdfjs, worker] = await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const document = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const pages: string[] = [];
    const maxPages = Math.min(document.numPages, 30);
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) pages.push(`--- Page ${pageNumber} ---\n${text}`);
      if (pages.join('\n').length >= MAX_EXCERPT_CHARS) break;
    }
    await document.destroy();
    if (!pages.length) {
      return { reason: 'PDF sans texte sélectionnable (document scanné ou image). Aucun OCR n’est exécuté.' };
    }
    const joined = pages.join('\n\n');
    return {
      text: joined.length <= MAX_EXCERPT_CHARS
        ? joined
        : `${joined.slice(0, MAX_EXCERPT_CHARS)}\n\n[… extrait PDF borné à ${MAX_EXCERPT_CHARS} caractères.]`,
    };
  } catch (error) {
    return { reason: `PDF non extrait : ${error instanceof Error ? error.message : 'lecture impossible'}.` };
  }
}

/** Convertit la première feuille XLSX en tableau texte lisible par le modèle. */
export async function extractXlsxText(file: File): Promise<{ text?: string; reason?: string }> {
  try {
    const table = await readXlsxRows(new Uint8Array(await file.arrayBuffer()));
    if (!table.ok) return { reason: `Classeur non extrait : ${table.error}` };
    if (table.rows.length === 0) return { reason: 'Classeur vide : aucun contenu à analyser.' };
    const rows = table.rows.slice(0, 500);
    const text = rows.map((row) => row.map((cell) => {
      const value = cell.replace(/\s+/g, ' ').trim();
      return /[;,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(';')).join('\n');
    const bounded = text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)}\n\n[… extrait XLSX borné.]`;
    return { text: `${bounded}${table.rows.length > rows.length ? `\n\n[${table.rows.length - rows.length} ligne(s) supplémentaire(s) non transmise(s).]` : ''}` };
  } catch (error) {
    return { reason: `Classeur non extrait : ${error instanceof Error ? error.message : 'lecture impossible'}.` };
  }
}

/** Plafond du base64 envoyé au serveur (le client reste sous la limite Edge). */
export const MAX_VISION_BASE64_CHARS = 900_000;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fileDataBase64(file: File): Promise<string> {
  return base64FromBytes(new Uint8Array(await file.arrayBuffer()));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image illisible'));
    image.src = url;
  });
}

/**
 * Prépare une image pour le modèle vision.
 *
 * Réduction à 1280 px et JPEG qualité 0,82 : une photo de téléphone de 8 Mo
 * tombe sous la limite de corps de l'Edge Function. Si le navigateur ne peut
 * pas redimensionner (canvas absent, format exotique), l'original n'est
 * envoyé que s'il tient dans la limite — sinon la raison est annoncée.
 */
export async function imageForVision(file: File): Promise<{
  image?: { mimeType: string; dataBase64: string };
  reason?: string;
}> {
  const supported = ['image/jpeg', 'image/png', 'image/webp'];
  if (!supported.includes(file.type)) {
    return { reason: 'Format d’image non pris en charge par le modèle vision (JPEG, PNG ou WebP).' };
  }

  try {
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      // 1024 px suffit pour lire un document ou identifier un produit, et
      // garde plusieurs images sous la limite de corps de l'Edge Function.
      const maxSide = 1024;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas indisponible');
      // Fond blanc : une PNG transparente ne doit pas devenir noire en JPEG.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      const dataBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/i, '');
      if (!dataBase64 || dataBase64.length > MAX_VISION_BASE64_CHARS) {
        return { reason: 'Image trop volumineuse après compression pour être transmise.' };
      }
      return { image: { mimeType: 'image/jpeg', dataBase64 } };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // Repli sans redimensionnement, uniquement si le fichier est déjà petit.
    if (file.size <= 650_000) {
      const dataBase64 = await fileDataBase64(file);
      if (dataBase64.length <= MAX_VISION_BASE64_CHARS) {
        return { image: { mimeType: file.type, dataBase64 } };
      }
    }
    return { reason: 'Image non préparée : le navigateur n’a pas pu la redimensionner et elle dépasse la limite d’envoi.' };
  }
}

/** Lit un fichier texte (TXT, CSV, MD) en s'arrêtant au plafond d'extrait. */
async function extractText(file: File): Promise<string | undefined> {
  try {
    const texte = (await file.text()).replace(/\u0000/g, '').trim();
    if (!texte) return undefined;
    if (texte.length <= MAX_EXCERPT_CHARS) return texte;
    // Le refus de troncature silencieuse ne s'applique pas ici : l'extrait est
    // borné et le dépassement est ANNONCÉ au modèle comme à l'utilisateur.
    return `${texte.slice(0, MAX_EXCERPT_CHARS)}\n\n[… extrait borné à ${MAX_EXCERPT_CHARS} caractères sur ${texte.length}.]`;
  } catch {
    return undefined;
  }
}

export interface PreparedAttachment {
  /** Pièce jointe compatible avec `composeMessageBody`. */
  attachment: AiAttachment;
  /** Ligne de fichier créée en base (preuve du téléversement). */
  stored: SorahnnexFile;
  capability: ReadCapability;
}

/**
 * Valide, téléverse, enregistre puis prépare une pièce jointe.
 *
 * @param onProgress progression réelle de 0 à 100.
 * @throws si le fichier est refusé ou si l'envoi échoue. L'appelant affiche le
 *   motif : aucune pièce jointe n'est ajoutée « au cas où ».
 */
export async function prepareAttachment(
  workspaceId: string,
  file: File,
  options: {
    conversationId?: string | null;
    onProgress?: (percent: number) => void;
  } = {},
): Promise<PreparedAttachment> {
  const valide = await validate(file);
  const stored = await upload(workspaceId, valide, {
    conversationId: options.conversationId ?? null,
    onProgress: options.onProgress,
  });

  const isPdf = stored.mime_type === 'application/pdf' || /\\.pdf$/i.test(stored.original_name);
  const isXlsx = stored.mime_type.includes('spreadsheetml') || /\\.xlsx$/i.test(stored.original_name);
  const isImage = stored.kind === 'image' || stored.mime_type.startsWith('image/');
  const pdf = isPdf ? await extractPdfText(file) : null;
  const xlsx = isXlsx ? await extractXlsxText(file) : null;
  const vision = isImage ? await imageForVision(file) : null;
  const capability: ReadCapability = isPdf
    ? (pdf?.text
      ? { transmitted: true, note: 'Texte du PDF extrait localement et transmis à l’assistant.' }
      : { transmitted: false, note: pdf?.reason ?? 'PDF enregistré, mais son texte n’a pas pu être extrait.' })
    : isXlsx
      ? (xlsx?.text
        ? { transmitted: true, note: 'Données de la première feuille XLSX extraites et transmises à l’assistant.' }
        : { transmitted: false, note: xlsx?.reason ?? 'Classeur enregistré, mais son contenu n’a pas pu être extrait.' })
      : isImage
        ? (vision?.image
          ? { transmitted: true, note: 'Image transmise au modèle vision (Gemini) pour une analyse réelle.' }
          : { transmitted: false, note: vision?.reason ?? 'Image enregistrée, mais elle n’a pas pu être préparée pour l’analyse visuelle.' })
        : readCapability(stored.kind, stored.preview_kind);
  const excerpt = isPdf ? pdf?.text : isXlsx ? xlsx?.text : capability.transmitted && !isImage ? await extractText(file) : undefined;

  // Si l'extrait échoue alors que le format est lisible, on ne prétend pas
  // l'avoir transmis : la note le dit.
  const effective: ReadCapability = capability.transmitted && !excerpt
    ? { transmitted: false, note: 'Fichier enregistré, mais son contenu n’a pas pu être lu localement.' }
    : capability;

  const attachment: AiAttachment = {
    name: stored.original_name,
    storagePath: stored.storage_path,
    sizeBytes: Number(stored.size_bytes),
    mimeType: stored.mime_type,
    ...(excerpt ? { excerpt } : {}),
    ...(vision?.image ? { visionImage: vision.image } : {}),
    // La note est jointe au message : le modèle sait ce qu'il ne voit pas, et
    // l'utilisateur reçoit la même information dans le fil.
    note: effective.note,
    fileId: stored.id,
  };

  return { attachment, stored, capability: effective };
}

/** Résume les capacités d'une liste, pour l'affichage dans le fil. */
export function summarizeCapabilities(prepared: PreparedAttachment[]): string | null {
  const muettes = prepared.filter((item) => !item.capability.transmitted);
  if (muettes.length === 0) return null;
  return muettes.map((item) => `${item.stored.original_name} — ${item.capability.note}`).join(' ');
}

export { asAppError };
