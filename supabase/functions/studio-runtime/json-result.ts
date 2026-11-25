/**
 * Validation bornée d'un résultat de DONNÉE déclaré par une fiche fournisseur
 * (`muapi_output_json_v1`).
 *
 * Le fournisseur est une source NON FIABLE : son `result` peut être énorme,
 * profondément imbriqué, contenir des clés de pollution de prototype ou des
 * valeurs non sérialisables. Rien n'est jamais interprété comme du HTML, du
 * code ou un média : la donnée est contrôlée, puis restituée en texte JSON.
 *
 * Le parcours est ITÉRATIF (pile explicite) : une imbrication de 100 000
 * niveaux ne doit pas provoquer un débordement de pile avant même le contrôle
 * de profondeur.
 *
 * Aucun journal ne contient la donnée ni l'URL : les erreurs sont des CODES
 * fixes, sans payload, sans identifiant fournisseur et sans message brut.
 */

/** 128 Kio : plafond de la donnée stockée et affichée (octets UTF-8). */
export const MAX_RESULT_BYTES = 131072;
/** Profondeur maximale d'un résultat de donnée. */
export const MAX_DEPTH = 12;
/** Nombre total de valeurs (scalaires, objets, tableaux) d'un résultat. */
export const MAX_NODES = 20000;
/** Taille maximale d'un tableau déclaré. */
export const MAX_ARRAY_ITEMS = 1000;
/** Nombre maximal de clés d'un objet. */
export const MAX_OBJECT_KEYS = 200;
/** Taille maximale d'une chaîne (unités UTF-16). */
export const MAX_STRING_UNITS = 65536;
/** Taille maximale d'une clé JSON. */
export const MAX_KEY_UNITS = 200;
/** Clés interdites : elles ne doivent jamais traverser la frontière serveur. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type JsonFailure =
  | 'RESULT_DATA_UNRECOGNIZED'
  | 'RESULT_DATA_TOO_LARGE'
  | 'RESULT_DATA_TOO_DEEP'
  | 'RESULT_DATA_TOO_WIDE'
  | 'RESULT_DATA_UNSAFE'
  | 'RESULT_DATA_UNSUPPORTED';

export type BoundedResult =
  | { ok: true; text: string; bytes: number }
  | { ok: false; code: JsonFailure };

const fail = (code: JsonFailure): BoundedResult => ({ ok: false, code });

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Contrôle puis sérialise une donnée NON FIABLE.
 *
 * Refus explicites (aucun repli silencieux) :
 *  - `undefined`, fonction, symbole, bigint, objet exotique → UNSUPPORTED ;
 *  - nombre non fini → UNRECOGNIZED ;
 *  - clé `__proto__`/`constructor`/`prototype` → UNSAFE ;
 *  - profondeur > MAX_DEPTH → TOO_DEEP ;
 *  - > MAX_NODES valeurs → TOO_WIDE ;
 *  - tableau > MAX_ARRAY_ITEMS ou objet > MAX_OBJECT_KEYS → TOO_WIDE ;
 *  - chaîne > MAX_STRING_UNITS → TOO_WIDE ;
 *  - JSON sérialisé > MAX_RESULT_BYTES octets UTF-8 → TOO_LARGE.
 */
export function boundJsonResult(value: unknown): BoundedResult {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop()!;
    const item = current.value;
    nodes += 1;
    if (nodes > MAX_NODES) return fail('RESULT_DATA_TOO_WIDE');

    if (item === null) continue;
    switch (typeof item) {
      case 'string':
        if (item.length > MAX_STRING_UNITS) return fail('RESULT_DATA_TOO_WIDE');
        continue;
      case 'boolean':
        continue;
      case 'number':
        if (!Number.isFinite(item)) return fail('RESULT_DATA_UNRECOGNIZED');
        continue;
      case 'object':
        break;
      default:
        // undefined, function, symbol, bigint : jamais sérialisables sans perte.
        return fail('RESULT_DATA_UNSUPPORTED');
    }

    if (current.depth >= MAX_DEPTH) return fail('RESULT_DATA_TOO_DEEP');

    if (Array.isArray(item)) {
      if (item.length > MAX_ARRAY_ITEMS) return fail('RESULT_DATA_TOO_WIDE');
      for (const entry of item) stack.push({ value: entry, depth: current.depth + 1 });
      continue;
    }

    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return fail('RESULT_DATA_UNSUPPORTED');
    const entries = Object.entries(item as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_KEYS) return fail('RESULT_DATA_TOO_WIDE');
    for (const [key, entry] of entries) {
      if (key.length > MAX_KEY_UNITS) return fail('RESULT_DATA_TOO_WIDE');
      if (FORBIDDEN_KEYS.has(key)) return fail('RESULT_DATA_UNSAFE');
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }

  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    // Cycle ou accesseur qui lève : la donnée n'est pas une donnée JSON.
    return fail('RESULT_DATA_UNRECOGNIZED');
  }
  if (typeof encoded !== 'string' || encoded.length < 2) return fail('RESULT_DATA_UNRECOGNIZED');
  const bytes = utf8Bytes(encoded);
  if (bytes > MAX_RESULT_BYTES) return fail('RESULT_DATA_TOO_LARGE');
  return { ok: true, text: encoded, bytes };
}

/**
 * Contrôle un résultat TEXTE déclaré (transcription, script, réponse LLM).
 * Le texte est stocké tel quel mais jamais interprété comme du HTML : c'est
 * l'affichage qui l'échappe. Un NUL est refusé (PostgreSQL ne peut pas le
 * stocker et un consommateur pourrait le tronquer silencieusement).
 */
export function boundTextResult(value: unknown): { ok: true; text: string; bytes: number } | { ok: false; code: JsonFailure } {
  if (typeof value !== 'string' || !value.trim()) return fail('RESULT_DATA_UNRECOGNIZED');
  if (value.includes('\u0000')) return fail('RESULT_DATA_UNRECOGNIZED');
  const bytes = utf8Bytes(value);
  if (bytes > MAX_RESULT_BYTES) return fail('RESULT_DATA_TOO_LARGE');
  return { ok: true, text: value, bytes };
}

/**
 * Diagnostic de journal : uniquement des codes fixes, jamais la donnée, jamais
 * l'URL fournisseur, jamais un message d'erreur brut qui pourrait la contenir.
 */
export function safeDiagnostic(code: unknown): string {
  const known = new Set<string>([
    'RESULT_DATA_UNRECOGNIZED', 'RESULT_DATA_TOO_LARGE', 'RESULT_DATA_TOO_DEEP',
    'RESULT_DATA_TOO_WIDE', 'RESULT_DATA_UNSAFE', 'RESULT_DATA_UNSUPPORTED',
    'RESULT_OUTPUT_UNRECOGNIZED', 'RESULT_ID_MISMATCH', 'RESULT_STATE_CONFLICT',
    'RESULT_STATUS_UNRECOGNIZED', 'PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED',
    'PROVIDER_RESPONSE_INVALID', 'RESULT_FILE_INVALID', 'RESULT_FILE_UNSUPPORTED',
  ]);
  return typeof code === 'string' && known.has(code) ? code : 'RUNTIME_UNAVAILABLE';
}
