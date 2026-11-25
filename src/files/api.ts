/**
 * SORAHNEX FILES — téléversement, lecture, suppression.
 *
 * ## Le chemin d'un fichier, dans l'ordre
 *   1. `validate()` lit les premiers octets et décide du type RÉEL ;
 *   2. `upload()` envoie le binaire au bucket privé, sous `${workspace_id}/`,
 *      avec une progression réelle ;
 *   3. `vyora_file_register` enregistre les métadonnées — et cette fonction
 *      REFUSE un fichier qui n'existe pas réellement dans le stockage ou dont
 *      la taille ne correspond pas.
 *
 * Conséquence : une ligne de métadonnées ne peut pas exister sans binaire, et
 * un binaire ne peut pas être rattaché à une autre entreprise. C'est ce qui
 * interdit les « fausses pièces jointes ».
 *
 * ## Isolation
 * Elle est portée par deux barrières indépendantes, pas par le code appelant :
 *   * les politiques Storage `ugc_storage_*` n'acceptent que le préfixe
 *     `${workspace_id}/` d'une entreprise dont on est membre ;
 *   * la table `vyora_files` reprend la même règle et la revalide.
 */

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL, supabase, STORAGE_BUCKET } from '../lib/supabase';
import { AppError } from '../lib/errors';
import {
  HEADER_BYTES, MAX_FILE_BYTES, checkSize, detectType, extensionOf,
  storagePathFor, type DetectedType, type FileKind, type PreviewKind, type ReferenceRole,
} from './types';

/** Ligne de la table `vyora_files`. */
export interface SorahnnexFile {
  id: string;
  workspace_id: string;
  owner_id: string;
  project_id: string | null;
  conversation_id: string | null;
  original_name: string;
  storage_path: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  kind: FileKind;
  reference_role: ReferenceRole | null;
  preview_kind: PreviewKind | null;
  checksum_sha256: string | null;
  created_at: string;
  updated_at: string;
}

/** Refus de fichier, avec un motif affichable. */
export class FileRejectedError extends AppError {
  constructor(message: string) {
    super(message, 'FILE_REJECTED');
    this.name = 'FileRejectedError';
  }
}

/** Résultat de la validation d'un fichier avant envoi. */
export interface ValidatedFile {
  file: File;
  detected: DetectedType;
  sizeBytes: number;
}

/** Lit les premiers octets d'un fichier sans le charger entièrement. */
async function readHeader(file: Blob): Promise<Uint8Array> {
  const slice = file.slice(0, HEADER_BYTES);
  return new Uint8Array(await slice.arrayBuffer());
}

/**
 * Valide un fichier : taille, puis type RÉEL.
 *
 * @throws FileRejectedError avec un motif explicite. L'appelant affiche le
 *   message tel quel : il ne doit jamais y avoir un refus silencieux.
 */
export async function validate(file: File): Promise<ValidatedFile> {
  const taille = checkSize(file.size);
  if (taille) throw new FileRejectedError(`« ${file.name} » — ${taille}`);

  const detected = detectType(file.name, await readHeader(file));
  if (!detected.accepted) {
    throw new FileRejectedError(
      `« ${file.name} » refusé. ${detected.reason ?? 'Format non autorisé.'}`,
    );
  }
  return { file, detected, sizeBytes: file.size };
}

/** Calcule le SHA-256 d'un fichier (intégrité, déduplication). */
async function sha256(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // contexte non sécurisé (http)
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export interface UploadOptions {
  /** Progression de 0 à 100, réellement rapportée par le transport. */
  onProgress?: (percent: number) => void;
  referenceRole?: ReferenceRole | null;
  projectId?: string | null;
  conversationId?: string | null;
  /** Annulation (bouton « interrompre » de l'interface). */
  signal?: AbortSignal;
}

/**
 * Envoie un fichier déjà validé, puis enregistre ses métadonnées.
 *
 * ## Progression réelle
 * On n'utilise pas `supabase.storage.upload` : il ne rapporte aucune
 * progression. On appelle l'API Storage avec `XMLHttpRequest`, qui expose
 * `upload.onprogress`. Si le navigateur ne fournit pas cet événement
 * (`lengthComputable` faux), on le dit : on ne simule pas une barre.
 *
 * @returns la ligne créée, telle que la base l'a enregistrée.
 */
export async function upload(
  workspaceId: string,
  validated: ValidatedFile,
  options: UploadOptions = {},
): Promise<SorahnnexFile> {
  const { file, detected, sizeBytes } = validated;
  const path = storagePathFor(workspaceId, detected.kind, detected.extension);
  const checksum = await sha256(file);

  await sendToStorage(path, file, detected.mimeType, options);

  const { data, error } = await supabase.rpc('vyora_file_register', {
    p_workspace_id: workspaceId,
    p_storage_path: path,
    p_original_name: file.name.slice(0, 255),
    p_mime_type: detected.mimeType,
    p_extension: detected.extension,
    p_size_bytes: sizeBytes,
    p_kind: detected.kind,
    p_reference_role: options.referenceRole ?? null,
    p_preview_kind: detected.previewKind,
    p_checksum_sha256: checksum,
    p_project_id: options.projectId ?? null,
    p_conversation_id: options.conversationId ?? null,
  });

  if (error) {
    // Le binaire est parti mais la métadonnée a été refusée : on nettoie pour
    // ne pas laisser d'objet orphelin (invisible et non supprimable via l'UI).
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    throw new AppError(
      messageForRpcError(error.message),
      'FILE_REGISTER_FAILED',
    );
  }
  options.onProgress?.(100);
  return data as SorahnnexFile;
}

function messageForRpcError(message: string): string {
  if (/objet absent du stockage/i.test(message)) {
    return 'L’envoi du fichier n’a pas abouti côté stockage. Le fichier n’a pas été enregistré.';
  }
  if (/taille declaree|taille déclarée/i.test(message)) {
    return 'La taille reçue ne correspond pas au fichier annoncé. Envoi interrompu.';
  }
  if (/droits insuffisants/i.test(message)) {
    return 'Vous n’avez pas les droits nécessaires sur cette entreprise.';
  }
  if (/chemin hors de l.entreprise/i.test(message)) {
    return 'Ce fichier ne peut pas être rattaché à cette entreprise.';
  }
  return `Enregistrement du fichier impossible : ${message}`;
}

/** Réponse de l'API Storage pour un envoi. */
function sendToStorage(
  path: string,
  file: File,
  contentType: string,
  options: UploadOptions,
): Promise<void> {
  // On réutilise la configuration déjà résolue par `lib/supabase` (variables
  // d'environnement ou valeurs publiques par défaut) au lieu de relire
  // `import.meta.env` ici : une seule source de vérité pour l'URL et la clé.
  const base = SUPABASE_URL.replace(/\/+$/, '');
  const key = SUPABASE_PUBLISHABLE_KEY;

  // En test (jsdom) ou si la configuration manque, on échoue explicitement
  // plutôt que de faire semblant d'envoyer.
  if (!globalThis.XMLHttpRequest || !base) {
    return Promise.reject(new AppError('Envoi de fichiers indisponible dans ce contexte.', 'STORAGE_UNAVAILABLE'));
  }

  return (async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new AppError('Session expirée : reconnectez-vous avant d’envoyer un fichier.', 'UNAUTHENTICATED');

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${base}/storage/v1/object/${STORAGE_BUCKET}/${encodeURI(path)}`);
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      if (key) xhr.setRequestHeader('apikey', key);
      xhr.setRequestHeader('content-type', contentType);
      // Pas d'écrasement : un chemin unique par fichier. Si le nom existait
      // déjà, l'API renvoie une erreur au lieu de remplacer silencieusement.
      xhr.setRequestHeader('x-upsert', 'false');

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        options.onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      };
      xhr.onerror = () => reject(new AppError('Envoi interrompu (réseau).', 'STORAGE_NETWORK'));
      xhr.onabort = () => reject(new AppError('Envoi annulé.', 'STORAGE_ABORTED'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        reject(new AppError(storageErrorMessage(xhr.status, xhr.responseText), 'STORAGE_ERROR'));
      };

      options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  })();
}

/** Traduit un refus Storage en message actionnable. */
export function storageErrorMessage(status: number, body: string): string {
  if (status === 413) return 'Le fichier dépasse la taille autorisée par le stockage (50 Mo).';
  if (status === 415) return 'Ce type de fichier n’est pas autorisé par le stockage.';
  if (status === 403 || status === 401) return 'Droits insuffisants : ce fichier ne peut pas être déposé dans cette entreprise.';
  if (status === 409) return 'Un fichier identique existe déjà à cet emplacement.';
  const detail = body?.trim().slice(0, 160);
  return `Le stockage a refusé le fichier (${status})${detail ? ` : ${detail}` : ''}.`;
}

/** Liste les fichiers d'une entreprise, éventuellement filtrés. */
export async function list(
  workspaceId: string,
  filters: { projectId?: string | null; conversationId?: string | null; kind?: FileKind } = {},
): Promise<SorahnnexFile[]> {
  let query = supabase
    .from('vyora_files')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (filters.projectId) query = query.eq('project_id', filters.projectId);
  if (filters.conversationId) query = query.eq('conversation_id', filters.conversationId);
  if (filters.kind) query = query.eq('kind', filters.kind);

  const { data, error } = await query;
  if (error) throw new AppError(`Lecture des fichiers impossible : ${error.message}`, 'FILES_READ_FAILED');
  return (data ?? []) as SorahnnexFile[];
}

/**
 * URL signée, temporaire, pour consulter ou prévisualiser un fichier.
 *
 * Le bucket est privé : aucun lien public n'existe. C'est la seule façon
 * d'accéder au binaire, et elle expire.
 */
export async function signedUrl(file: SorahnnexFile, expiresInSeconds = 300): Promise<string> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(file.storage_path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw new AppError(
      `Prévisualisation impossible : ${error?.message ?? 'lien non délivré'}.`,
      'SIGNED_URL_FAILED',
    );
  }
  return data.signedUrl;
}

/**
 * Supprime un fichier : d'abord la métadonnée, puis l'objet.
 *
 * ## Pourquoi dans cet ordre
 * Si la suppression de l'objet échoue après celle de la ligne, il reste un
 * objet orphelin — invisible pour l'utilisateur, mais qui consomme du stockage.
 * L'inverse laisserait une ligne pointant vers un objet absent, c'est-à-dire une
 * pièce jointe cassée affichée comme valide. On préfère l'orphelin, et on le
 * signale.
 *
 * Les droits sont vérifiés par la RLS `vyora_files_delete_owner` : si la
 * suppression de la ligne ne rend aucune ligne, rien n'est supprimé du stockage.
 */
export async function remove(file: SorahnnexFile): Promise<void> {
  const { data, error } = await supabase
    .from('vyora_files')
    .delete()
    .eq('id', file.id)
    .select('id');

  if (error) throw new AppError(`Suppression impossible : ${error.message}`, 'FILES_DELETE_FAILED');
  if (!data || data.length === 0) {
    throw new AppError(
      'Suppression refusée : vous n’avez pas les droits sur ce fichier.',
      'FILES_DELETE_FORBIDDEN',
    );
  }

  const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([file.storage_path]);
  if (storageError) {
    throw new AppError(
      'Le fichier a été retiré de la liste, mais son contenu n’a pas pu être effacé du stockage. Signalez-le à l’administrateur.',
      'FILES_DELETE_PARTIAL',
    );
  }
}

/** Rattache un fichier à un projet Studio, avec un rôle de référence. */
export async function attachToProject(
  fileId: string,
  projectId: string,
  role?: ReferenceRole | null,
): Promise<SorahnnexFile> {
  const { data, error } = await supabase.rpc('vyora_file_attach_to_project', {
    p_file_id: fileId,
    p_project_id: projectId,
    p_reference_role: role ?? null,
  });
  if (error) {
    if (/projet inconnu/i.test(error.message)) {
      throw new AppError('Ce projet n’appartient pas à cette entreprise.', 'PROJECT_NOT_FOUND');
    }
    throw new AppError(`Rattachement impossible : ${error.message}`, 'ATTACH_FAILED');
  }
  return data as SorahnnexFile;
}

/** Rattache un fichier à une conversation de l'assistant. */
export async function attachToConversation(fileId: string, conversationId: string): Promise<SorahnnexFile> {
  const { data, error } = await supabase.rpc('vyora_file_attach_to_conversation', {
    p_file_id: fileId,
    p_conversation_id: conversationId,
  });
  if (error) {
    if (/conversation inconnue/i.test(error.message)) {
      throw new AppError('Cette conversation n’existe pas ou ne vous appartient pas.', 'CONVERSATION_NOT_FOUND');
    }
    if (/autre entreprise/i.test(error.message)) {
      throw new AppError('Cette conversation appartient à une autre entreprise.', 'CROSS_WORKSPACE');
    }
    throw new AppError(`Rattachement impossible : ${error.message}`, 'ATTACH_FAILED');
  }
  return data as SorahnnexFile;
}

/** Détecte le type sans téléverser : sert à prévenir avant l'envoi. */
export async function inspect(file: File): Promise<DetectedType> {
  return detectType(file.name, await readHeader(file));
}

/** Extension normalisée, réexportée pour l'interface. */
export { extensionOf, MAX_FILE_BYTES };
