import { describe, expect, it } from 'vitest';
import {
  boundJsonResult, boundTextResult, safeDiagnostic,
  MAX_RESULT_BYTES, MAX_DEPTH, MAX_ARRAY_ITEMS, MAX_NODES,
} from '../supabase/functions/studio-runtime/json-result';
import { familyResult } from '../supabase/functions/studio-runtime/families';

/**
 * Le `result` d'une fiche fournisseur est une donnée NON FIABLE.
 * Ces tests couvrent : JSON invalide, taille, imbrication, tableaux énormes,
 * valeurs nulles, caractères spéciaux, HTML/script, clés de pollution,
 * valeurs non sérialisables, réponse vide — et l'absence de fuite dans les
 * messages d'erreur.
 */

const hostiles = {
  html: { title: '<img src=x onerror="alert(1)">', body: '<script>alert(1)</script>' },
  specials: { quote: '"\'`${}', newline: 'a\nb\r\tc', unicode: 'éè漢字🎬', nul: '\u0000' },
};

describe('bornes d’une donnée déclarée', () => {
  it('accepte une donnée normale mais restitue les caractères spéciaux sans les interpréter', () => {
    const result = boundJsonResult(hostiles.html);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain('<script>alert(1)</script>');
    expect(JSON.parse(result.text)).toEqual(hostiles.html);
    expect(boundJsonResult(hostiles.specials).ok).toBe(true);
  });

  it('refuse une taille supérieure à 128 Kio en OCTETS (pas en unités UTF-16)', () => {
    // 65 536 caractères « é » = 131 072 octets : sous l'ancien contrôle de
    // longueur (unités UTF-16), cette donnée passait.
    const multibyte = boundJsonResult({ blob: 'é'.repeat(65536) });
    expect(multibyte).toEqual({ ok: false, code: 'RESULT_DATA_TOO_LARGE' });
    const ascii = boundJsonResult({ blob: 'a'.repeat(MAX_RESULT_BYTES) });
    expect(ascii.ok).toBe(false);
  });

  it('refuse une imbrication profonde sans déborder la pile', () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 50000; i += 1) deep = { child: deep };
    expect(boundJsonResult(deep)).toEqual({ ok: false, code: 'RESULT_DATA_TOO_DEEP' });
    let allowed: unknown = { leaf: true };
    for (let i = 0; i < MAX_DEPTH - 1; i += 1) allowed = { child: allowed };
    expect(boundJsonResult(allowed).ok).toBe(true);
  });

  it('refuse un tableau ou un objet démesuré', () => {
    expect(boundJsonResult({ list: new Array(MAX_ARRAY_ITEMS + 1).fill(1) }))
      .toEqual({ ok: false, code: 'RESULT_DATA_TOO_WIDE' });
    const wide: Record<string, number> = {};
    for (let i = 0; i < 201; i += 1) wide[`k${i}`] = i;
    expect(boundJsonResult(wide)).toEqual({ ok: false, code: 'RESULT_DATA_TOO_WIDE' });
    const nodes: unknown[] = [];
    for (let i = 0; i < MAX_NODES + 5; i += 1) nodes.push(i);
    expect(boundJsonResult(nodes).ok).toBe(false);
  });

  it('refuse les clés qui polluent un prototype', () => {
    const polluted = JSON.parse('{"__proto__":{"admin":true},"constructor":{"x":1},"prototype":{"y":1}}');
    expect(boundJsonResult(polluted)).toEqual({ ok: false, code: 'RESULT_DATA_UNSAFE' });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('refuse ce qui n’est pas une donnée JSON', () => {
    expect(boundJsonResult(undefined)).toEqual({ ok: false, code: 'RESULT_DATA_UNSUPPORTED' });
    expect(boundJsonResult({ fn: () => 1 })).toEqual({ ok: false, code: 'RESULT_DATA_UNSUPPORTED' });
    expect(boundJsonResult({ n: Number.NaN })).toEqual({ ok: false, code: 'RESULT_DATA_UNRECOGNIZED' });
    expect(boundJsonResult({ n: Infinity })).toEqual({ ok: false, code: 'RESULT_DATA_UNRECOGNIZED' });
    class Exotic { value = 1; }
    expect(boundJsonResult(new Exotic())).toEqual({ ok: false, code: 'RESULT_DATA_UNSUPPORTED' });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(boundJsonResult(cycle).ok).toBe(false);
  });

  it('accepte null et les valeurs nulles imbriquées', () => {
    const result = boundJsonResult({ a: null, b: [null, 0, false, ''] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.parse(result.text)).toEqual({ a: null, b: [null, 0, false, ''] });
  });
});

describe('résultat texte borné', () => {
  it('refuse un texte vide, un NUL et un texte hors borne', () => {
    expect(boundTextResult('   ')).toEqual({ ok: false, code: 'RESULT_DATA_UNRECOGNIZED' });
    expect(boundTextResult('a\u0000b')).toEqual({ ok: false, code: 'RESULT_DATA_UNRECOGNIZED' });
    expect(boundTextResult('é'.repeat(70000))).toEqual({ ok: false, code: 'RESULT_DATA_TOO_LARGE' });
    expect(boundTextResult('<script>x</script>').ok).toBe(true);
  });
});

describe('adaptateur JSON : réponses fournisseur incorrectes', () => {
  const parse = (payload: unknown) => familyResult('muapi_output_json_v1', payload, 'req-1');

  it('refuse une donnée absente, nulle ou d’un autre identifiant', () => {
    expect(() => parse({ id: 'req-1', status: 'completed' })).toThrow('RESULT_DATA_UNRECOGNIZED');
    expect(() => parse({ id: 'req-1', status: 'completed', result: null })).toThrow('RESULT_DATA_UNRECOGNIZED');
    expect(() => parse({ id: 'other', status: 'completed', result: {} })).toThrow('RESULT_ID_MISMATCH');
    expect(() => parse({ id: 'req-1', status: 'mystery', result: {} })).toThrow('RESULT_STATUS_UNRECOGNIZED');
  });

  it('refuse une donnée hostile et ne la restitue jamais partiellement', () => {
    expect(() => parse({ id: 'req-1', status: 'completed', result: { blob: 'é'.repeat(65536) } })).toThrow('RESULT_DATA_TOO_LARGE');
    let deep: unknown = 1;
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => parse({ id: 'req-1', status: 'completed', result: deep })).toThrow('RESULT_DATA_TOO_DEEP');
    expect(() => parse({ id: 'req-1', status: 'completed', result: JSON.parse('{"__proto__":{"polluted":1}}') })).toThrow('RESULT_DATA_UNSAFE');
  });

  it('accepte les formes déclarées : objet, tableau, chaîne', () => {
    expect(JSON.parse(parse({ id: 'req-1', status: 'completed', result: { score: 0.5 } }).text ?? '')).toEqual({ score: 0.5 });
    expect(JSON.parse(parse({ id: 'req-1', status: 'completed', result: [1, 2] }).text ?? '')).toEqual([1, 2]);
    expect(JSON.parse(parse({ id: 'req-1', status: 'completed', result: 'ok' }).text ?? '')).toBe('ok');
  });

  it('ne fuit jamais la donnée dans un message ou un diagnostic', () => {
    const secret = 'sk-live-SECRET-TOKEN';
    try {
      parse({ id: 'req-1', status: 'completed', result: { blob: 'é'.repeat(65536), leak: secret } });
      throw new Error('should have thrown');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toBe('RESULT_DATA_TOO_LARGE');
      expect(message).not.toContain(secret);
    }
    try {
      parse({ id: 'req-1', status: 'completed', result: JSON.parse(`{"__proto__":{"leak":"${secret}"}}`) });
      throw new Error('should have thrown');
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toBe('RESULT_DATA_UNSAFE');
      expect(message).not.toContain(secret);
    }
    expect(safeDiagnostic('RESULT_DATA_TOO_LARGE')).toBe('RESULT_DATA_TOO_LARGE');
    expect(safeDiagnostic(`boom ${secret}`)).toBe('RUNTIME_UNAVAILABLE');
    expect(safeDiagnostic(undefined)).toBe('RUNTIME_UNAVAILABLE');
  });
});
