/**
 * Phase D — sonde de configuration et pagination.
 *
 * Enjeu : l'utilisateur doit pouvoir tester son API **avant** d'enregistrer un
 * secret, et l'interface doit lui dire précisément ce qui ne va pas. Ces tests
 * vérifient aussi l'absence d'exécution de code fourni par l'utilisateur.
 */
import { describe, expect, it } from 'vitest';
import {
  COMMON_ARRAY_PATHS,
  MAX_PROBE_BODY_BYTES,
  lireChemin,
  paginationCoherente,
  probeResponse,
  substituerPagination,
} from '../src/business/importer/custom-api-probe';

const json = (status: number, corps: unknown, contentType = 'application/json') => ({
  status,
  contentType,
  body: JSON.stringify(corps),
});

describe('sonde — erreurs d’authentification', () => {
  it('distingue 401 de 403', () => {
    const non = probeResponse({ status: 401, body: '{}' });
    expect(non.ok).toBe(false);
    expect(non.code).toBe('unauthorized');
    expect(non.message).toMatch(/clé|authentification/i);

    const interdit = probeResponse({ status: 403, body: '{}' });
    expect(interdit.code).toBe('forbidden');
    // Le message doit suggérer que la clé peut être valide : c'est un autre
    // problème, et la correction est différente.
    expect(interdit.message).toMatch(/droits/i);
  });

  it('explique un 404 comme une erreur de chemin', () => {
    const resultat = probeResponse({ status: 404, body: '' });
    expect(resultat.code).toBe('not_found');
    expect(resultat.message).toMatch(/chemin/i);
  });

  it('n’affiche jamais le corps de la réponse dans le message', () => {
    const secret = 'sk_live_ne_doit_pas_apparaitre';
    const resultat = probeResponse({ status: 401, body: `{"detail":"clé ${secret} refusée"}` });
    expect(resultat.message).not.toContain(secret);
    expect(JSON.stringify(resultat)).not.toContain(secret);
  });

  it('gère l’absence de réponse et les erreurs serveur', () => {
    expect(probeResponse({ status: 0, body: '' }).code).toBe('unexpected_status');
    expect(probeResponse({ status: 500, body: '' }).code).toBe('server_error');
    expect(probeResponse({ status: 502, body: '' }).message).toMatch(/502/);
  });
});

describe('sonde — lecture du catalogue', () => {
  it('accepte un tableau direct', () => {
    const resultat = probeResponse(json(200, [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]));
    expect(resultat.ok).toBe(true);
    expect(resultat.arrayPath).toBe('');
    expect(resultat.count).toBe(2);
    expect(resultat.sampleFields).toEqual(['id', 'name']);
  });

  it('trouve un tableau imbriqué et rapporte le chemin', () => {
    const resultat = probeResponse(json(200, { data: { items: [{ id: 1, title: 'A' }] } }));
    expect(resultat.ok).toBe(true);
    expect(resultat.arrayPath).toBe('data.items');
    expect(resultat.count).toBe(1);
    expect(resultat.message).toContain('data.items');
  });

  it('respecte le chemin déclaré quand il fonctionne', () => {
    const resultat = probeResponse(json(200, { a: [{ id: 1 }], b: [{ id: 2 }] }), 'b');
    expect(resultat.ok).toBe(true);
    expect(resultat.arrayPath).toBe('b');
  });

  it('signale un chemin déclaré qui ne donne pas de tableau', () => {
    const resultat = probeResponse(json(200, { data: [{ id: 1 }] }), 'data.products');
    expect(resultat.ok).toBe(false);
    expect(resultat.code).toBe('no_array');
    // Le message nomme le chemin fautif, sinon l'utilisateur ne sait pas quoi corriger.
    expect(resultat.message).toContain('data.products');
  });

  it('refuse un JSON sans tableau', () => {
    const resultat = probeResponse(json(200, { data: { total: 0 } }));
    expect(resultat.ok).toBe(false);
    expect(resultat.code).toBe('no_array');
  });

  it('refuse une réponse qui n’est pas du JSON', () => {
    const resultat = probeResponse({ status: 200, contentType: 'text/html', body: '<!doctype html><html>…' });
    expect(resultat.ok).toBe(false);
    expect(resultat.code).toBe('not_json');
    // Message utile : l'adresse pointe probablement vers la vitrine.
    expect(resultat.message).toMatch(/page d’accueil|JSON/i);
  });

  it('refuse un JSON tronqué', () => {
    const resultat = probeResponse({ status: 200, contentType: 'application/json', body: '[{"id":1},' });
    expect(resultat.ok).toBe(false);
    expect(resultat.code).toBe('not_json');
  });

  it('refuse un corps vide', () => {
    expect(probeResponse({ status: 200, body: '   ' }).code).toBe('empty_body');
  });

  it('refuse un corps démesuré', () => {
    const enorme = `[{"x":"${'a'.repeat(MAX_PROBE_BODY_BYTES)}"}]`;
    const resultat = probeResponse({ status: 200, contentType: 'application/json', body: enorme });
    expect(resultat.ok).toBe(false);
    expect(resultat.code).toBe('too_large');
  });

  it('accepte un JSON annoncé par le corps sans content-type', () => {
    const resultat = probeResponse({ status: 200, body: '[{"id":1}]' });
    expect(resultat.ok).toBe(true);
  });

  it('ne rend pas plus de 40 champs d’exemple', () => {
    const produit = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, i]));
    const resultat = probeResponse(json(200, [produit]));
    expect(resultat.sampleFields).toHaveLength(40);
  });

  it('ne devine pas un tableau dans un champ non listé', () => {
    // Un chemin exotique n'est pas cherché automatiquement : mieux vaut
    // demander à l'utilisateur que de choisir à sa place.
    const resultat = probeResponse(json(200, { weird: { nested: [{ id: 1 }] } }));
    expect(resultat.ok).toBe(false);
    expect(COMMON_ARRAY_PATHS).not.toContain('weird.nested');
  });
});

describe('lecture de chemin — aucune exécution de code', () => {
  it('lit une propriété simple', () => {
    expect(lireChemin({ a: 1 }, 'a')).toBe(1);
    expect(lireChemin({ a: { b: [1, 2] } }, 'a.b')).toEqual([1, 2]);
  });

  it('rend undefined pour un chemin absent, sans lever', () => {
    expect(lireChemin({}, 'a.b.c')).toBeUndefined();
    expect(lireChemin(null, 'a')).toBeUndefined();
    expect(lireChemin('texte', 'length')).toBeUndefined();
  });

  it('ignore les clés de prototype', () => {
    // Sans ce refus, `constructor` remonterait une fonction et un chemin
    // fabriqué pourrait faire croire à un tableau inexistant.
    for (const chemin of ['__proto__', 'constructor', 'prototype', 'a.constructor', 'a.__proto__.b']) {
      expect(lireChemin({ a: {} }, chemin), chemin).toBeUndefined();
    }
  });

  it('ne lit pas les propriétés héritées', () => {
    const objet = Object.create({ herite: [1, 2, 3] });
    expect(lireChemin(objet, 'herite')).toBeUndefined();
  });

  it('n’évalue aucune expression', () => {
    // Clé littérale contenant des caractères de code (sans point, qui
    // découperait le chemin) : elle est lue telle quelle, jamais évaluée.
    const cle = 'a) || (function(){ globalThis["__pwned"] = 1 })() || (a';
    const piege: Record<string, unknown> = { [cle]: [1] };
    expect(lireChemin(piege, cle)).toEqual([1]);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    // Un chemin qui ressemble à du code ne trouve simplement rien.
    expect(lireChemin({}, 'process.exit(1)')).toBeUndefined();
  });
});

describe('pagination', () => {
  it('substitue les trois marqueurs', () => {
    expect(substituerPagination('/api/products?page={page}&limit={limit}', { page: 3, limit: 50 }))
      .toBe('/api/products?page=3&limit=50');
    expect(substituerPagination('/api/products?cursor={cursor}', { cursor: 'abc123' }))
      .toBe('/api/products?cursor=abc123');
  });

  it('percent-encode le curseur pour interdire l’ajout de paramètres', () => {
    const url = substituerPagination('/api/products?cursor={cursor}', { cursor: 'a&admin=1&x=' });
    expect(url).toBe('/api/products?cursor=a%26admin%3D1%26x%3D');
    // Le paramètre ne peut pas exister : `&` est encodé.
    expect(url.split('&')).toHaveLength(1);
  });

  it('refuse une page non entière ou négative', () => {
    expect(() => substituerPagination('?page={page}', { page: 0 })).toThrow();
    expect(() => substituerPagination('?page={page}', { page: 1.5 })).toThrow();
    expect(() => substituerPagination('?page={page}', {})).toThrow();
  });

  it('refuse un curseur absent', () => {
    expect(() => substituerPagination('?cursor={cursor}', {})).toThrow();
    expect(() => substituerPagination('?cursor={cursor}', { cursor: '' })).toThrow();
  });

  it('refuse un marqueur inconnu au lieu de le laisser passer', () => {
    // Un `{token}` non remplacé partirait tel quel dans l'URL, et l'API
    // répondrait une erreur incompréhensible.
    expect(() => substituerPagination('/api/{token}/products', {})).toThrow(/Marqueur inconnu/);
  });

  it('ne touche pas une URL sans marqueur', () => {
    expect(substituerPagination('/api/products', {})).toBe('/api/products');
  });

  it('vérifie la cohérence du mode déclaré', () => {
    expect(paginationCoherente('page', '/p?page={page}').ok).toBe(true);
    expect(paginationCoherente('page', '/p').ok).toBe(false);
    expect(paginationCoherente('cursor', '/p?cursor={cursor}').ok).toBe(true);
    expect(paginationCoherente('cursor', '/p?page={page}').ok).toBe(false);
    expect(paginationCoherente('none', '/p').ok).toBe(true);
    // Message actionnable, pas un simple booléen.
    expect(paginationCoherente('page', '/p').message).toMatch(/\{page\}/);
  });
});
