/**
 * Phase D — mapping déclaratif d'une API tierce vers le modèle VYORA.
 *
 * Le risque principal de ce module est silencieux : un prix faux d'un facteur
 * 100 ne lève aucune erreur, il se vend. Ces tests portent donc massivement sur
 * la conversion de prix, et sur le fait qu'un champ absent reste absent.
 */
import { describe, expect, it } from 'vitest';
import {
  mapProduct,
  readPath,
  suggestMapping,
  toMinorUnits,
  validateMapping,
  type CustomApiMapping,
} from '../src/business/importer/custom-api-mapping';
import { productFingerprint } from '../src/business/importer/normalize';

/** Mapping minimal réaliste, du type de ceux qu'un marchand configurera. */
const mapping: CustomApiMapping = {
  name: { path: 'title' },
  description: { path: 'body' },
  price: { path: 'price' },
  sku: { path: 'sku' },
  platformId: { path: 'id' },
  image: { path: 'image.src' },
  productUrl: { path: 'url' },
  categories: { path: 'categories' },
  stock: { path: 'stock' },
};

const options = {
  currency: 'XOF',
  priceUnit: 'major' as const,
  shopUrl: 'https://boutique.example/',
  sourceReference: 'api-personnalisee',
};

const brut = {
  id: 42,
  title: 'Sac en cuir',
  body: '<p>Cuir tanné</p>',
  price: 25000,
  sku: 'SAC-01',
  image: { src: '/img/sac.jpg' },
  url: '/produits/sac',
  categories: ['Maroquinerie', 'Sacs'],
  stock: 7,
};

describe('readPath — lecture sans exécution', () => {
  it('lit un chemin simple et imbriqué', () => {
    expect(readPath(brut, 'title')).toBe('Sac en cuir');
    expect(readPath(brut, 'image.src')).toBe('/img/sac.jpg');
  });

  it('indexe les tableaux', () => {
    expect(readPath(brut, 'categories.0')).toBe('Maroquinerie');
  });

  it('rend undefined pour tout ce qui n’existe pas', () => {
    expect(readPath(brut, 'absent')).toBeUndefined();
    expect(readPath(brut, 'categories.9')).toBeUndefined();
    expect(readPath(brut, 'title.plus.loin')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath(brut, '')).toBeUndefined();
  });

  it('refuse les clés de prototype', () => {
    for (const chemin of ['__proto__', 'constructor', 'prototype', 'image.__proto__']) {
      expect(readPath(brut, chemin), chemin).toBeUndefined();
    }
  });

  it('n’exécute jamais une expression', () => {
    // Une expression collée dans un champ de configuration ne doit produire
    // qu'une absence de valeur, jamais une exécution.
    expect(readPath(brut, 'title + process.exit(1)')).toBeUndefined();
    expect(readPath(brut, '(()=>{globalThis.__x=1})()')).toBeUndefined();
    expect((globalThis as Record<string, unknown>).__x).toBeUndefined();
  });
});

describe('conversion de prix — le point le plus dangereux', () => {
  it('unité principale vers unité mineure', () => {
    expect(toMinorUnits(12.5, 'EUR', 'major').minor).toBe(1250);
    expect(toMinorUnits('12,50', 'EUR', 'major').minor).toBe(1250);
    expect(toMinorUnits('1 250,50', 'EUR', 'major').minor).toBe(125050);
  });

  it('devise sans subdivision : aucun facteur 100', () => {
    // 25000 F CFA valent 25000, pas 2 500 000 : la multiplication par 100
    // serait une erreur d'un facteur 100 sur toute la boutique.
    expect(toMinorUnits(25000, 'XOF', 'major').minor).toBe(25000);
    expect(toMinorUnits('15 000', 'XAF', 'major').minor).toBe(15000);
    expect(toMinorUnits(1500, 'JPY', 'major').minor).toBe(1500);
  });

  it('unité mineure déclarée : aucune reconversion', () => {
    expect(toMinorUnits(1250, 'EUR', 'minor').minor).toBe(1250);
    expect(toMinorUnits(25000, 'XOF', 'minor').minor).toBe(25000);
  });

  it('refuse un prix absent au lieu d’inventer zéro', () => {
    const resultat = toMinorUnits(null, 'EUR', 'major');
    expect(resultat.minor).toBeNull();
    expect(resultat.warning).toBeTruthy();

    // Zéro explicite reste zéro : c'est un prix offert, pas une absence.
    expect(toMinorUnits(0, 'EUR', 'major').minor).toBe(0);
  });

  it('refuse un prix négatif ou démesuré', () => {
    expect(toMinorUnits(-5, 'EUR', 'major').minor).toBeNull();
    expect(toMinorUnits(10 ** 15, 'EUR', 'major').minor).toBeNull();
  });

  it('refuse un texte qui n’est pas un prix', () => {
    for (const valeur of ['', 'gratuit', 'à venir', {}, [], true]) {
      expect(toMinorUnits(valeur, 'EUR', 'major').minor, JSON.stringify(valeur)).toBeNull();
    }
  });

  it('nettoie un prix formaté avec symbole et espaces insécables', () => {
    expect(toMinorUnits('12,50 €', 'EUR', 'major').minor).toBe(1250);
    expect(toMinorUnits('1\u00a0234,56', 'EUR', 'major').minor).toBe(123456);
    expect(toMinorUnits('1,234.56', 'USD', 'major').minor).toBe(123456);
  });
});

describe('mapping d’un produit complet', () => {
  it('produit tous les champs attendus', () => {
    const resultat = mapProduct(brut, mapping, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    const { product } = resultat;
    expect(product.name).toBe('Sac en cuir');
    expect(product.priceMinor).toBe(25000);
    expect(product.currency).toBe('XOF');
    expect(product.sku).toBe('SAC-01');
    expect(product.platformId).toBe('42');
    // URL relative résolue contre la boutique.
    expect(product.imageUrl).toBe('https://boutique.example/img/sac.jpg');
    expect(product.productUrl).toBe('https://boutique.example/produits/sac');
    // `buildProduct` normalise les catégories en minuscules : c'est le
    // comportement commun à tout l'import, et il est réutilisé tel quel plutôt
    // que réimplémenté. L'empreinte de dédoublonnage en dépend.
    expect(product.categories).toEqual(['maroquinerie', 'sacs']);
    expect(product.stock).toBe(7);
    expect(product.source.reference).toBe('api-personnalisee');
  });

  it('porte la même empreinte qu’un produit importé du même contenu', () => {
    // Sans cette égalité, un produit mappé ne serait pas reconnu comme le
    // doublon d'un produit importé par fichier.
    const resultat = mapProduct(brut, mapping, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.fingerprint)
      .toBe(productFingerprint('Sac en cuir', ['maroquinerie', 'sacs']));
  });

  it('rejette un élément sans nom, avec le chemin fautif', () => {
    const resultat = mapProduct({ ...brut, title: '' }, mapping, options);
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.reason).toContain('title');
  });

  it('rejette un élément qui n’est pas un objet', () => {
    for (const entree of [null, undefined, 'texte', 42, [1, 2]]) {
      expect(mapProduct(entree, mapping, options).ok, String(entree)).toBe(false);
    }
  });

  it('un prix illisible donne un avertissement, pas un produit faux', () => {
    const resultat = mapProduct({ ...brut, price: 'sur devis' }, mapping, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.priceMinor).toBeNull();
    expect(resultat.product.warnings.join(' ')).toMatch(/prix/i);
  });

  it('sans champ de prix configuré, le produit reste importable', () => {
    const sansPrix: CustomApiMapping = { name: { path: 'title' } };
    const resultat = mapProduct(brut, sansPrix, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.priceMinor).toBeNull();
    expect(resultat.product.warnings.join(' ')).toMatch(/prix/i);
  });

  it('additionne un prix et une taxe séparés sans arrondir deux fois', () => {
    const avecTaxe: CustomApiMapping = {
      name: { path: 'title' },
      price: { path: 'ht', addPath: 'tva' },
    };
    const resultat = mapProduct({ title: 'X', ht: 100, tva: 18 }, avecTaxe, { ...options, currency: 'EUR' });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.priceMinor).toBe(11800);
  });

  it('applique un multiplicateur déclaré', () => {
    const avecFacteur: CustomApiMapping = {
      name: { path: 'title' },
      price: { path: 'price', multiplier: 100 },
    };
    const resultat = mapProduct({ title: 'X', price: 12.5 }, avecFacteur, { ...options, priceUnit: 'minor' as const });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.priceMinor).toBe(1250);
  });

  it('écarte une URL au schéma actif', () => {
    const resultat = mapProduct(
      { ...brut, image: { src: 'javascript:alert(1)' }, url: 'data:text/html,<script>' },
      mapping,
      options,
    );
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // Une image n'est jamais un script : elle est écartée, pas nettoyée.
    expect(resultat.product.imageUrl).toBeNull();
    expect(resultat.product.productUrl).toBeNull();
    expect(resultat.product.warnings.join(' ')).toMatch(/schéma/i);
  });

  it('utilise la devise publiée par la source quand elle existe', () => {
    const avecDevise: CustomApiMapping = { name: { path: 'title' }, price: { path: 'price' }, currency: { path: 'cur' } };
    const resultat = mapProduct({ title: 'X', price: 12.5, cur: 'EUR' }, avecDevise, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.currency).toBe('EUR');
    expect(resultat.product.priceMinor).toBe(1250);
  });

  it('lit des catégories sous forme d’objets', () => {
    const resultat = mapProduct(
      { ...brut, categories: [{ name: 'Sacs' }, { title: 'Cuir' }] },
      mapping,
      options,
    );
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.categories).toEqual(['sacs', 'cuir']);
  });

  it('écarte un stock négatif au lieu de l’afficher', () => {
    const resultat = mapProduct({ ...brut, stock: -3 }, mapping, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.stock).toBeNull();
    expect(resultat.product.warnings.join(' ')).toMatch(/stock/i);
  });
});

describe('variantes', () => {
  const avecVariantes: CustomApiMapping = {
    name: { path: 'title' },
    price: { path: 'price' },
    variants: {
      path: 'variants',
      name: { path: 'title' },
      price: { path: 'price' },
      sku: { path: 'sku' },
      stock: { path: 'inventory' },
      attributeName: 'Taille',
    },
  };

  it('lit les variantes et leurs prix', () => {
    const resultat = mapProduct({
      title: 'T-shirt',
      price: 5000,
      variants: [
        { title: 'S', price: 5000, sku: 'TS-S', inventory: 3 },
        { title: 'M', price: 5500, sku: 'TS-M', inventory: 0 },
      ],
    }, avecVariantes, options);

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    const { variants } = resultat.product;
    expect(variants).toHaveLength(2);
    expect(variants[0].name).toBe('S');
    expect(variants[0].priceMinor).toBe(5000);
    expect(variants[0].sku).toBe('TS-S');
    expect(variants[1].stock).toBe(0);
    expect(variants[1].available).toBe(false);
    expect(variants[0].attributeName).toBe('Taille');
  });

  it('numérote une variante sans nom plutôt que de laisser un vide', () => {
    const resultat = mapProduct({
      title: 'X', price: 100,
      variants: [{ price: 100 }, { price: 200 }],
    }, avecVariantes, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.variants.map((v) => v.name)).toEqual(['Variante 1', 'Variante 2']);
  });

  it('signale un chemin de variantes qui n’est pas un tableau', () => {
    const resultat = mapProduct({ title: 'X', price: 1, variants: { a: 1 } }, avecVariantes, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.variants).toEqual([]);
    expect(resultat.product.warnings.join(' ')).toMatch(/variantes/i);
  });

  it('borne le nombre de variantes', () => {
    const beaucoup = Array.from({ length: 250 }, (_, i) => ({ title: `V${i}`, price: 100 }));
    const resultat = mapProduct({ title: 'X', price: 100, variants: beaucoup }, avecVariantes, options);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.product.variants).toHaveLength(100);
  });
});

describe('validation du mapping', () => {
  it('exige un nom', () => {
    expect(validateMapping({ name: { path: '' } }, 'major').ok).toBe(false);
    expect(validateMapping({} as CustomApiMapping, 'major').errors.join(' ')).toMatch(/nom/i);
  });

  it('accepte un mapping minimal valide', () => {
    expect(validateMapping({ name: { path: 'title' } }, 'major')).toEqual({ ok: true, errors: [] });
  });

  it('refuse un chemin syntaxiquement invalide', () => {
    for (const chemin of ['.a', 'a.', 'a..b']) {
      const resultat = validateMapping({ name: { path: chemin } }, 'major');
      expect(resultat.ok, chemin).toBe(false);
    }
  });

  it('refuse un chemin qui désigne le prototype', () => {
    expect(validateMapping({ name: { path: '__proto__.x' } }, 'major').ok).toBe(false);
  });

  it('nomme le champ fautif dans l’erreur', () => {
    const resultat = validateMapping({ name: { path: 'title' }, stock: { path: 'a..b' } }, 'major');
    expect(resultat.errors.join(' ')).toMatch(/Stock/);
  });
});

describe('proposition de mapping', () => {
  it('propose les alias courants', () => {
    const proposition = suggestMapping(['id', 'title', 'body_html', 'price', 'sku', 'images', 'quantity']);
    expect(proposition.name?.path).toBe('title');
    expect(proposition.description?.path).toBe('body_html');
    expect(proposition.price?.path).toBe('price');
    expect(proposition.sku?.path).toBe('sku');
    expect(proposition.platformId?.path).toBe('id');
    expect(proposition.stock?.path).toBe('quantity');
  });

  it('ne propose pas de champ absent', () => {
    const proposition = suggestMapping(['name', 'price']);
    // Un chemin inventé échouerait à l'import : mieux vaut ne rien proposer.
    expect(proposition.image).toBeUndefined();
    expect(proposition.stock).toBeUndefined();
    expect(proposition.sku).toBeUndefined();
  });

  it('propose toujours un nom, même sans alias reconnu', () => {
    const proposition = suggestMapping(['chose_bizarre']);
    expect(proposition.name?.path).toBe('name');
  });

  it('gère une réponse sans champ', () => {
    expect(suggestMapping([]).name?.path).toBe('name');
  });
});
