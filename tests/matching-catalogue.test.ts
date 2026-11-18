/**
 * Rapprochement catalogue — la règle « jamais de fusion sur une simple
 * ressemblance de nom » est ce que ces tests protègent.
 *
 * Les cas couverts sont ceux de la demande : correspondances exactes,
 * références différentes, noms proches, doublons internes, cas ambigus.
 */
import { describe, expect, it } from 'vitest';
import {
  indexCatalog, isNearName, matchBatch, matchProduct, nameSimilarity, skuKey,
  type CatalogCandidate,
} from '../src/business/importer/matching';

const existant = (surcharge: Partial<CatalogCandidate> = {}): CatalogCandidate => ({
  id: 'p-existant',
  name: 'Sérum éclat',
  sku: null,
  platformId: null,
  variantSkus: [],
  ...surcharge,
});

describe('skuKey', () => {
  it('ignore casse, espaces et séparateurs', () => {
    expect(skuKey('ref-12 A')).toBe(skuKey('REF 12A'));
    expect(skuKey(' ab_1.2 ')).toBe('AB12');
  });

  it('rend une chaîne vide pour une référence absente', () => {
    expect(skuKey(null)).toBe('');
    expect(skuKey(undefined)).toBe('');
  });
});

describe('noms proches', () => {
  it('reconnaît une faute de frappe', () => {
    expect(isNearName('Sérum éclat', 'Serum eclatt')).toBe(true);
  });

  it('reconnaît un mot ajouté', () => {
    expect(isNearName('Chemise indigo', 'Chemise indigo premium')).toBe(true);
  });

  it('ne rapproche pas deux produits différents', () => {
    // Le cœur de la règle : « savon » et « baume » ne sont pas proches parce
    // qu'ils partagent un mot vague.
    expect(isNearName('Savon noir', 'Baume noir')).toBe(false);
    expect(isNearName('Sérum éclat', 'Masque éclat')).toBe(false);
  });

  it('ne considère pas deux noms identiques comme « proches »', () => {
    // Identique = correspondance exacte, traitée par un niveau plus fiable.
    expect(isNearName('Sérum éclat', 'SERUM ECLAT')).toBe(false);
  });

  it('donne une similarité de 1 à des noms identiques normalisés', () => {
    expect(nameSimilarity('Sérum Éclat 30ml', 'SERUM   ECLAT 30ML')).toBe(1);
  });

  it('ne confond pas deux contenances écrites différemment', () => {
    // « 30ml » et « 30 ml » restent deux clés différentes : la normalisation ne
    // scinde pas les chiffres des lettres. Le test le fige pour qu'un
    // changement de normalisation ne passe pas inaperçu.
    expect(nameSimilarity('Sérum Éclat 30ml', 'serum eclat 30 ml')).toBeLessThan(1);
    expect(nameSimilarity('Sérum Éclat 30ml', 'serum eclat 30 ml')).toBeGreaterThan(0.85);
  });
});

describe('matchProduct — identifiants stables', () => {
  const index = indexCatalog([
    existant({ id: 'p1', name: 'Sérum éclat', sku: 'SER-01', platformId: 'shopify-88' }),
    existant({ id: 'p2', name: 'Baume nuit', sku: 'BAU-02' }),
  ]);

  it('rapproche par identifiant de source, même si le nom a changé', () => {
    const resultat = matchProduct(
      { name: 'Sérum éclat nouvelle formule', platformId: 'shopify-88' }, index,
    );
    expect(resultat.decision).toBe('update');
    expect(resultat.targetId).toBe('p1');
    expect(resultat.evidence[0].level).toBe('platform-id');
  });

  it('rapproche par référence produit', () => {
    const resultat = matchProduct({ name: 'Nom totalement différent', sku: 'SER-01' }, index);
    expect(resultat.decision).toBe('update');
    expect(resultat.targetId).toBe('p1');
  });

  it('rapproche par référence de VARIANTE', () => {
    // Une variante partagée est le même identifiant commercial : c'est ce qui
    // permet de retrouver un produit quand seul son SKU de taille est fourni.
    const avecVariantes = indexCatalog([
      existant({ id: 'p3', name: 'T-shirt coton', variantSkus: ['TSH-S', 'TSH-M'] }),
    ]);
    const resultat = matchProduct({ name: 'T-shirt', sku: 'TSH-M' }, avecVariantes);
    expect(resultat.decision).toBe('update');
    expect(resultat.targetId).toBe('p3');
  });

  it('rapproche par nom exact après normalisation', () => {
    const resultat = matchProduct({ name: 'SERUM  ECLAT' }, index);
    expect(resultat.decision).toBe('update');
    expect(resultat.targetId).toBe('p1');
  });

  it('crée quand ni la référence ni le nom ne correspondent', () => {
    const resultat = matchProduct({ name: 'Masque hydratant', sku: 'MAS-99' }, index);
    expect(resultat.decision).toBe('create');
    expect(resultat.targetId).toBeNull();
  });

  it('ne rapproche pas deux références différentes au nom proche', () => {
    // Deux SKU distincts = deux produits distincts, quoi que dise le nom.
    const resultat = matchProduct({ name: 'Sérum éclat', sku: 'AUTRE-REF' }, index);
    // Le nom exact l'emporte ici (comportement historique conservé), mais la
    // référence, elle, ne désigne PAS p1.
    expect(resultat.decision).toBe('update');
    expect(resultat.evidence.some((e) => e.level === 'sku')).toBe(false);
    expect(resultat.evidence.some((e) => e.level === 'name-exact')).toBe(true);
  });
});

describe('matchProduct — cas ambigus', () => {
  it('signale deux produits partageant le même identifiant de source', () => {
    const index = indexCatalog([
      existant({ id: 'a', name: 'Produit A', platformId: 'dup' }),
      existant({ id: 'b', name: 'Produit B', platformId: 'dup' }),
    ]);
    const resultat = matchProduct({ name: 'Produit A', platformId: 'dup' }, index);
    expect(resultat.decision).toBe('ambiguous');
    expect(resultat.candidates.sort()).toEqual(['a', 'b']);
    expect(resultat.targetId).toBeNull();
    expect(resultat.reason).toMatch(/identifiant de source/);
  });

  it('signale deux produits partageant la même référence', () => {
    const index = indexCatalog([
      existant({ id: 'a', name: 'Produit A', sku: 'SAME' }),
      existant({ id: 'b', name: 'Produit B', sku: 'SAME' }),
    ]);
    const resultat = matchProduct({ name: 'Produit C', sku: 'SAME' }, index);
    expect(resultat.decision).toBe('ambiguous');
    expect(resultat.candidates.sort()).toEqual(['a', 'b']);
  });

  it('signale un désaccord entre référence et identifiant de source', () => {
    // La référence pointe vers A, l'identifiant de source vers B : fusionner
    // l'un ou l'autre serait un choix arbitraire.
    const index = indexCatalog([
      existant({ id: 'a', name: 'Produit A', sku: 'REF-A', platformId: 'src-a' }),
      existant({ id: 'b', name: 'Produit B', sku: 'REF-B', platformId: 'src-b' }),
    ]);
    const resultat = matchProduct({ name: 'Produit X', sku: 'REF-A', platformId: 'src-b' }, index);
    expect(resultat.decision).toBe('ambiguous');
    expect(resultat.candidates.sort()).toEqual(['a', 'b']);
    expect(resultat.reason).toMatch(/désignent deux produits différents/);
  });

  it('présente un nom proche comme ambigu, jamais comme une fusion', () => {
    const index = indexCatalog([existant({ id: 'a', name: 'Chemise indigo premium' })]);
    const resultat = matchProduct({ name: 'Chemise indigo' }, index);
    expect(resultat.decision).toBe('ambiguous');
    expect(resultat.candidates).toEqual(['a']);
    expect(resultat.targetId).toBeNull();
    expect(resultat.reason).toMatch(/sans votre accord/);
  });

  it('liste tous les candidats quand plusieurs noms sont proches', () => {
    const index = indexCatalog([
      existant({ id: 'a', name: 'Chemise indigo premium' }),
      existant({ id: 'b', name: 'Chemise indigo deluxe' }),
    ]);
    const resultat = matchProduct({ name: 'Chemise indigo' }, index);
    expect(resultat.decision).toBe('ambiguous');
    expect(resultat.candidates.sort()).toEqual(['a', 'b']);
    expect(resultat.reason).toMatch(/2 produits/);
  });
});

describe('matchBatch — doublons internes', () => {
  it('marque le second produit de référence identique comme doublon du lot', () => {
    const resultats = matchBatch(
      [
        { name: 'T-shirt', sku: 'TS-1' },
        { name: 'T-shirt (bis)', sku: 'TS-1' },
      ],
      [],
    );
    expect(resultats[0].decision).toBe('create');
    expect(resultats[1].decision).toBe('duplicate-in-batch');
    expect(resultats[1].against).toBe(0);
    expect(resultats[1].reason).toMatch(/TS-1/);
  });

  it('détecte un doublon interne au nom quand aucune référence n’est fournie', () => {
    const resultats = matchBatch([{ name: 'Sable fin' }, { name: 'SABLE  FIN' }], []);
    expect(resultats[1].decision).toBe('duplicate-in-batch');
    expect(resultats[1].against).toBe(0);
  });

  it('n’écrase pas un doublon du lot par une correspondance catalogue', () => {
    // Le doublon interne est prioritaire : la deuxième ligne ne doit pas être
    // transformée en « mise à jour » du produit existant.
    const resultats = matchBatch(
      [{ name: 'Sable fin' }, { name: 'Sable fin' }],
      [existant({ id: 'existe', name: 'Sable fin' })],
    );
    expect(resultats[0].decision).toBe('update');
    expect(resultats[1].decision).toBe('duplicate-in-batch');
  });

  it('traite des produits distincts sans les confondre', () => {
    const resultats = matchBatch(
      [
        { name: 'Chemise indigo', sku: 'CH-1' },
        { name: 'Pantalon sable', sku: 'PA-1' },
        { name: 'Bougie ambre', sku: 'BO-1' },
      ],
      [],
    );
    expect(resultats.map((r) => r.decision)).toEqual(['create', 'create', 'create']);
  });

  it('rapproche chaque produit du lot séparément', () => {
    const resultats = matchBatch(
      [
        { name: 'Renommé', platformId: 'a' },
        { name: 'Autre renommé', platformId: 'b' },
        { name: 'Vraiment nouveau' },
      ],
      [
        existant({ id: 'pa', name: 'Ancien A', platformId: 'a' }),
        existant({ id: 'pb', name: 'Ancien B', platformId: 'b' }),
      ],
    );
    expect(resultats.map((r) => r.decision)).toEqual(['update', 'update', 'create']);
    expect(resultats.map((r) => r.targetId)).toEqual(['pa', 'pb', null]);
  });
});

describe('indexCatalog', () => {
  it('ne duplique pas un produit référencé par son SKU et celui d’une variante', () => {
    const index = indexCatalog([existant({ id: 'a', sku: 'X', variantSkus: ['X'] })]);
    expect(index.parSku.get('X')).toHaveLength(1);
  });

  it('conserve deux produits qui partagent une référence', () => {
    const index = indexCatalog([
      existant({ id: 'a', sku: 'SAME' }),
      existant({ id: 'b', sku: 'SAME' }),
    ]);
    expect(index.parSku.get('SAME')?.map((p) => p.id)).toEqual(['a', 'b']);
  });
});
