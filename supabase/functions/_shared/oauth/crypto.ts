// VYORA — chiffrement des jetons OAuth.
//
// AES-256-GCM via WebCrypto (disponible dans Deno ET dans Node 22, donc
// testable sous vitest sans adaptateur). Format stocké en base :
//   cipher : base64 du texte chiffré
//   iv     : base64 du nonce de 12 octets (unique par chiffrement)
//   tag    : base64 de l'étiquette d'authentification de 16 octets
//
// La clé n'existe QUE dans les secrets Supabase (`VYORA_OAUTH_ENCRYPTION_KEY`,
// 32 octets en base64). Elle n'est jamais journalisée, jamais renvoyée, jamais
// stockée en base. Un jeton chiffré sans la clé est inexploitable.

export interface EncryptedValue {
  cipher: string;
  iv: string;
  tag: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * WebCrypto attend un `BufferSource` dont le tampon est un `ArrayBuffer`
 * (jamais un `SharedArrayBuffer`). Ce convertisseur garantit le type, y compris
 * sous la vérification stricte de TypeScript 5.7.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Décode et valide une clé au format base64. Refuse tout ce qui n'a pas
 * exactement 32 octets : une clé trop courte ne doit jamais être utilisée.
 */
export function parseKey(encoded: string): Uint8Array {
  if (!encoded || encoded.trim() === '') throw new Error('encryption_key_missing');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(encoded.trim());
  } catch {
    throw new Error('encryption_key_invalid_base64');
  }
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`encryption_key_bad_length:${bytes.length}`);
  }
  return bytes;
}

async function importKey(encoded: string): Promise<CryptoKey> {
  const raw = parseKey(encoded);
  return crypto.subtle.importKey('raw', toBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, keyBase64: string): Promise<EncryptedValue> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: TAG_BYTES * 8 },
      key,
      toBuffer(encoded),
    ),
  );
  // WebCrypto concatène le texte chiffré et l'étiquette : on les sépare pour
  // que la base les stocke distinctement (colonnes iv / tag).
  const cipher = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return { cipher: toBase64(cipher), iv: toBase64(iv), tag: toBase64(tag) };
}

/**
 * Déchiffre une valeur. Lève `decrypt_failed` si l'étiquette ne correspond pas :
 * un cryptogramme altéré n'est jamais utilisé silencieusement.
 */
export async function decryptSecret(value: EncryptedValue, keyBase64: string): Promise<string> {
  if (!value.cipher || !value.iv || !value.tag) throw new Error('cipher_incomplete');
  const key = await importKey(keyBase64);
  const cipher = fromBase64(value.cipher);
  const tag = fromBase64(value.tag);
  if (tag.length !== TAG_BYTES) throw new Error('tag_bad_length');
  const sealed = new Uint8Array(cipher.length + tag.length);
  sealed.set(cipher, 0);
  sealed.set(tag, cipher.length);
  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(fromBase64(value.iv)), tagLength: TAG_BYTES * 8 },
      key,
      toBuffer(sealed),
    );
    return new TextDecoder().decode(opened);
  } catch {
    throw new Error('decrypt_failed');
  }
}

/** Génère une clé aléatoire de 32 octets, en base64 (pour l'exploitant). */
export function generateKeyBase64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Empreinte courte et non réversible : identifie une clé sans la révéler. */
export async function keyFingerprint(keyBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBuffer(new TextEncoder().encode(keyBase64.trim())));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/** PKCE (RFC 7636) : vérificateur aléatoire et son défi S256. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = toBase64(random).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', toBuffer(new TextEncoder().encode(verifier)));
  const challenge = toBase64(new Uint8Array(digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return { verifier, challenge };
}

/** État anti-CSRF : imprévisible, longueur fixe. */
export function createState(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(random).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
