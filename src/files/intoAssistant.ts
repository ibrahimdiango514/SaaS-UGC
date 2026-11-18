/**
 * VYORA FILES → assistant : ce que le modèle peut RÉELLEMENT lire.
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
 *   * **texte** (TXT, CSv, MD…) : lu localement, transmis tel quel ;
 *   * **image** : seul le NOM et le format partent dans le message. Le binaire
 *     reste privé et n'est pas analysé par un modèle de texte. C'est annoncé ;
 *   * **PDF, DOCX, XLSX** : non extraits (aucune bibliothèque d'analyse n'est
 *     embarquée). Annoncé comme tel, avec la raison ;
 *   * **vidéo** : jamais lue par un modèle de texte. Annoncé explicitement.
 *
 * Ce choix évite deux mensonges symétriques : faire croire qu'une vidéo a été
 * « comprise », ou ignorer silencieusement une pièce jointe.
 */
import type { AiAttachment } from '../ai/api';
import { MAX_EXCERPT_CHARS } from '../ai/attachments';
import { upload, validate, type VyoraFile } from './api';
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
export function readCapability(kind: VyoraFile['kind'], previewKind: VyoraFile['preview_kind']): ReadCapability {
  if (previewKind === 'text') {
    return { transmitted: true, note: 'Contenu texte transmis à l’assistant.' };
  }
  switch (kind) {
    case 'image':
      return {
        transmitted: false,
        note: 'Image enregistrée. Le texte du message ne transmet que son nom : l’assistant ne voit pas le contenu visuel de l’image.',
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
  stored: VyoraFile;
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

  const capability = readCapability(stored.kind, stored.preview_kind);
  const excerpt = capability.transmitted ? await extractText(file) : undefined;

  // Si l'extrait échoue alors que le format est lisible, on ne prétend pas
  // l'avoir transmis : la note le dit.
  const effective: ReadCapability = capability.transmitted && !excerpt
    ? { transmitted: false, note: 'Fichier texte enregistré, mais son contenu n’a pas pu être lu localement.' }
    : capability;

  const attachment: AiAttachment = {
    name: stored.original_name,
    storagePath: stored.storage_path,
    sizeBytes: Number(stored.size_bytes),
    mimeType: stored.mime_type,
    ...(excerpt ? { excerpt } : {}),
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
