// SORAHNEX AI CORE — validation des images transmises à un modèle vision.
//
// Le navigateur redimensionne déjà l'image ; le serveur ne fait pas confiance
// pour autant : type MIME allowlisté, base64 strict, taille bornée et nombre
// borné. Une image invalide est refusée explicitement, jamais silencieusement
// remplacée par du texte.

import type { AiImageInput } from './types.ts';

export const MAX_VISION_IMAGES = 5;
/** ~1,5 Mo de binaire : marge sous les limites de corps des Edge Functions. */
export const MAX_IMAGE_BASE64_CHARS = 1_000_000;
/** Plafond cumulé : le corps de la requête doit rester sous la limite Edge. */
export const MAX_TOTAL_IMAGE_BASE64_CHARS = 2_400_000;

const MIME_ALLOWLIST = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ImageParseResult =
  | { ok: true; images: AiImageInput[] }
  | { ok: false; error: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Retire un éventuel préfixe `data:image/...;base64,` et valide l'alphabet. */
function base64Payload(value: string): string | null {
  const withoutPrefix = value.replace(/^data:[^;,]+;base64,/i, '');
  if (!withoutPrefix || withoutPrefix.length > MAX_IMAGE_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(withoutPrefix)) return null;
  return withoutPrefix;
}

/**
 * Valide une liste d'images.
 *
 * Accepte les formes `{ mimeType, dataBase64 }` et `{ mime_type, data_base64 }`
 * (le snake_case est utile aux appelants SQL/HTTP historiques).
 */
export function parseImageInputs(value: unknown): ImageParseResult {
  if (value == null) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'Le format des images est invalide.' };
  if (value.length > MAX_VISION_IMAGES) {
    return { ok: false, error: `Maximum ${MAX_VISION_IMAGES} images par message.` };
  }

  const images: AiImageInput[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Une image jointe est illisible.' };
    }
    const row = entry as Record<string, unknown>;
    const mimeType = text(row.mimeType ?? row.mime_type).toLowerCase();
    if (!MIME_ALLOWLIST.has(mimeType)) {
      return { ok: false, error: 'Format d’image non pris en charge (JPEG, PNG ou WebP uniquement).' };
    }
    const payload = base64Payload(text(row.dataBase64 ?? row.data_base64 ?? row.data));
    if (!payload) {
      return {
        ok: false,
        error: `Image trop volumineuse ou encodage invalide (limite ${Math.round(MAX_IMAGE_BASE64_CHARS / 1_000_000)} Mo encodés).`,
      };
    }
    images.push({ mimeType, dataBase64: payload });
  }
  if (images.reduce((total, image) => total + image.dataBase64.length, 0) > MAX_TOTAL_IMAGE_BASE64_CHARS) {
    return { ok: false, error: 'Les images jointes dépassent la taille cumulée autorisée.' };
  }
  return { ok: true, images };
}
