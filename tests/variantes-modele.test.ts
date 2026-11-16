/**
 * Modèle de variantes — lecture, validation, affichage.
 *
 * Ces tests portent sur des fonctions pures : aucune base, aucun réseau. Ils
 * verrouillent les décisions qui, si elles glissaient, produiraient des erreurs
 * silencieuses à l'écran :
 * - un prix absent n'est PAS zéro ;
 * - un stock inconnu n'est PAS une rupture ;
 * - l'ordre de la source est conservé (sinon « S, M, L » devient « L, M, S ») ;
 * - une variante sans option est refusée.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_VARIANT, formFromVariant, normalizeVariant, normalizeVariants, validateVariantForm,
  variantPriceLabel, variantStockLabel,
} from '../src/business/importer/variants-model';

const ligne = (surcharge: Record<string, unknown> = {}) => ({
  id: 'v1',
  product_id: 'p1',
  attribute_name: 'Taille',
  attribute_value: 'M',
  sku: 'TSH-M',
  price_amount: 12000,
  price_currency: 'XOF',
  stock: 15,
  available: true,
  active: true,
  position: 1,
  ...surcharge,
});

describe('normalizeVariant', () => {
  it('lit une ligne complète sans perdre aucun champ', () => {
    expect(normalizeVariant(ligne())).toEqual({
      id: 'v1', product_id: 'p1', attribute_name: 'Taille', attribute_value: 'M',
      sku: 'TSH-M', price_amount: 12000, price_currency: 'XOF', stock: 15,
      available: true, active: true, position: 1,
    });
  });

  it('rejette une ligne sans identifiant ou sans option', () => {
    expect(normalizeVariant({ ...ligne(), id: '' })).toBeNull();
    expect(normalizeVariant({ ...ligne(), attribute_value: '   ' })).toBeNull();
    expect(normalizeVariant(null)).toBeNull();
  });

  it('rattache la variante au produit fourni quand la ligne l’omet', () => {
    const variante = normalizeVariant({ ...ligne(), product_id: undefined }, 'parent-9');
    expect(variante?.product_id).toBe('parent-9');
  });

  it('considère une variante sans drapeau `active` comme active', () => {
    // Les lignes importées avant l'ajout de la colonne ne doivent pas
    // disparaître du tableau.
    expect(normalizeVariant({ ...ligne(), active: undefined })?.active).toBe(true);
    expect(normalizeVariant({ ...ligne(), active: false })?.active).toBe(false);
  });

  it('garde `null` pour un prix et un stock inconnus', () => {
    const variante = normalizeVariant(ligne({ price_amount: null, stock: null, sku: null }));
    expect(variante?.price_amount).toBeNull();
    expect(variante?.stock).toBeNull();
    expect(variante?.sku).toBeNull();
  });
});

describe('normalizeVariants', () => {
  it('conserve l’ordre de la source', () => {
    const liste = normalizeVariants([
      ligne({ id: 'a', attribute_value: 'S', position: 0 }),
      ligne({ id: 'b', attribute_value: 'M', position: 1 }),
      ligne({ id: 'c', attribute_value: 'L', position: 2 }),
    ]);
    expect(liste.map((v) => v.attribute_value)).toEqual(['S', 'M', 'L']);
  });

  it('ignore les entrées illisibles et les non-tableaux', () => {
    expect(normalizeVariants([null, { id: 'x' }, ligne()])).toHaveLength(1);
    expect(normalizeVariants('CSV')).toEqual([]);
  });
});

describe('validateVariantForm', () => {
  it('exige le nom de l’option', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT });
    expect(resultat.ok).toBe(false);
  });

  it('accepte un prix et un stock vides (héritage du parent, stock inconnu)', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT, attributeValue: '43' });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(resultat.payload.price_amount).toBeNull();
      expect(resultat.payload.stock).toBeNull();
      expect(resultat.payload.price_currency).toBeNull();
      expect(resultat.payload.attribute_name).toBeNull();
    }
  });

  it('normalise la devise en majuscules', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'Rouge', currency: 'xof' });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.payload.price_currency).toBe('XOF');
  });

  it('refuse un prix négatif', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'M', price: '-5' });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error).toMatch(/négatif/);
  });

  it('refuse un stock négatif ou décimal', () => {
    expect(validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'M', stock: '-1' }).ok).toBe(false);
    expect(validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'M', stock: '2,5' }).ok).toBe(false);
  });

  it('refuse une devise qui n’a pas trois lettres', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'M', currency: 'FRANC' });
    expect(resultat.ok).toBe(false);
  });

  it('accepte une virgule décimale dans le prix', () => {
    const resultat = validateVariantForm({ ...EMPTY_VARIANT, attributeValue: 'M', price: '12,5' });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.payload.price_amount).toBe(12.5);
  });
});

describe('formFromVariant', () => {
  it('laisse vides les champs inconnus plutôt que « null »', () => {
    const formulaire = formFromVariant({
      id: 'v1', product_id: 'p1', attribute_name: null, attribute_value: 'M',
      sku: null, price_amount: null, price_currency: null, stock: null,
      available: null, active: true, position: 0,
    });
    expect(formulaire).toEqual({
      attributeName: '', attributeValue: 'M', sku: '', price: '', currency: '', stock: '',
    });
  });

  it('fait l’aller-retour avec validateVariantForm', () => {
    const variante = normalizeVariant(ligne())!;
    const resultat = validateVariantForm(formFromVariant(variante));
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(resultat.payload).toEqual({
        attribute_name: 'Taille', attribute_value: 'M', sku: 'TSH-M',
        price_amount: 12000, price_currency: 'XOF', stock: 15,
      });
    }
  });
});

describe('affichage', () => {
  const format = (montant: number, devise: string) => `${montant} ${devise}`;

  it('affiche le prix de la variante quand il existe', () => {
    const variante = normalizeVariant(ligne())!;
    expect(variantPriceLabel(variante, 10000, 'XOF', format)).toBe('12000 XOF');
  });

  it('dit « prix du produit » plutôt que « 0 » quand le prix est hérité', () => {
    const variante = normalizeVariant(ligne({ price_amount: null }))!;
    expect(variantPriceLabel(variante, 10000, 'XOF', format)).toBe('Prix du produit : 10000 XOF');
  });

  it('signale un prix à compléter quand le parent n’a pas de prix', () => {
    const variante = normalizeVariant(ligne({ price_amount: null }))!;
    expect(variantPriceLabel(variante, null, null, format)).toBe('Prix à compléter');
  });

  it('distingue stock inconnu et rupture', () => {
    expect(variantStockLabel(normalizeVariant(ligne({ stock: null }))!)).toBe('—');
    expect(variantStockLabel(normalizeVariant(ligne({ stock: 0 }))!)).toBe('Rupture');
    expect(variantStockLabel(normalizeVariant(ligne({ stock: 7 }))!)).toBe('7');
  });
});
