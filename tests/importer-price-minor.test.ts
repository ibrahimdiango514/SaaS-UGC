import { describe, expect, it } from 'vitest';
import { currencyExponent, minorToDecimal, parsePriceMinor } from '../src/business/importer/normalize.ts';
import { formatPreviewPrice, normalizeCatalogProduct } from '../src/business/importer/pipeline.ts';

/**
 * Régression trouvée pendant la livraison de l'Edge Function `store-import`.
 *
 * `parsePriceMinor` traitait « 12000.00 » (prix Shopify en XOF) comme un
 * séparateur de milliers quand la devise n'a pas de décimales : 12 000 devenait
 * 1 200 000, facteur 100. Un prix faux se propage dans les devis, donc il est
 * testé explicitement ici, devises à 0 et à 2 décimales.
 */

describe('parsePriceMinor — devises sans décimales (XOF, JPY)', () => {
  it.each([
    ['12000.00', 12000],
    ['12000.50', 12001], // arrondi à l'unité, jamais tronqué vers le bas
    ['12000.49', 12000],
    ['12 000', 12000],
    ['12,000', 12000],
    ['12000', 12000],
    ['1 200 000', 1200000],
    ['12,000.00', 12000], // séparateurs de milliers + décimale
    ['12000.5', 12001], // une seule décimale
  ])('lit %s comme %i (devise sans décimales)', (entree, attendu) => {
    expect(currencyExponent('XOF')).toBe(0);
    expect(parsePriceMinor(entree, 'XOF').minor).toBe(attendu);
  });

  it('lit un nombre comme une valeur en unité principale', () => {
    expect(parsePriceMinor(12000, 'XOF').minor).toBe(12000);
    expect(parsePriceMinor(19.99, 'EUR').minor).toBe(1999);
  });

  it('conserve le comportement des devises à deux décimales', () => {
    expect(parsePriceMinor('19.99', 'EUR').minor).toBe(1999);
    expect(parsePriceMinor('19,99', 'EUR').minor).toBe(1999);
    expect(parsePriceMinor('1,500.50', 'EUR').minor).toBe(150050);
    expect(parsePriceMinor('€19.99', 'EUR').minor).toBe(1999);
    expect(parsePriceMinor('19.99 EUR', 'EUR').minor).toBe(1999);
    expect(parsePriceMinor('1 500,50', 'EUR').minor).toBe(150050);
  });

  it('refuse ce qui n’est pas un prix plutôt que d’inventer', () => {
    expect(parsePriceMinor('', 'XOF').minor).toBeNull();
    expect(parsePriceMinor('sur devis', 'XOF').minor).toBeNull();
    expect(parsePriceMinor(-5, 'XOF').minor).toBeNull();
    expect(parsePriceMinor(null, 'XOF').minor).toBeNull();
  });

  it('fait l’aller-retour unité mineure → décimale', () => {
    expect(minorToDecimal(12000, 'XOF')).toBe(12000);
    expect(minorToDecimal(1999, 'EUR')).toBe(19.99);
  });
});

describe('convergence des prix Shopify / Woo, y compris en XOF', () => {
  const shopify = (price: string) => ({
    id: 1,
    title: 'Produit',
    body_html: '<p>Description</p>',
    handle: 'produit',
    vendor: 'V',
    product_type: 'T',
    tags: 'a',
    variants: [{ id: 1, title: 'Default', price, sku: 'S', available: true }],
  });

  it('Shopify en XOF : 12000.00 donne 12 000, pas 1 200 000', () => {
    const produit = normalizeCatalogProduct(
      { name: 'Produit', description: 'Description', price: '12000.00', currency: 'XOF', productUrl: null, imageUrl: null, sku: 'S', variants: [], raw: shopify('12000.00') } as never,
      'shopify',
      { reference: 'https://b.example/products.json', endpoint: 'https://b.example/products.json' },
      'XOF',
    );
    expect('error' in produit).toBe(false);
    if ('error' in produit) return;
    expect(produit.priceMinor).toBe(12000);
    expect(formatPreviewPrice(produit)).not.toContain('1\u202f200\u202f000');
  });
});
