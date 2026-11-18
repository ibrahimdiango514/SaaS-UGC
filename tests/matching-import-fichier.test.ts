/**
 * Rapprochement alimenté par un VRAI fichier.
 *
 * Les tests de `matching.ts` vérifient la décision ; ceux-ci vérifient que la
 * décision dispose réellement des données : une colonne `reference` ou `id`
 * dans un CSV doit devenir une référence de rapprochement, sinon toute la
 * stratégie d'identifiants stables resterait théorique.
 */
import { describe, expect, it } from 'vitest';
import { importDelimited } from '../src/business/importer/files';
import { matchBatch } from '../src/business/importer/matching';

function produits(csv: string) {
  const resultat = importDelimited(csv, { reference: 'essai.csv' });
  if (!resultat.ok) throw new Error(`parsing refusé : ${resultat.errors.join(' | ')}`);
  return resultat.products;
}

describe('identifiants stables lus depuis un fichier', () => {
  it('lit une colonne `reference` comme référence produit', () => {
    const [produit] = produits('name,price,currency,reference\nSérum éclat,12000,XOF,SER-01');
    expect(produit.sku).toBe('SER-01');
  });

  it('lit une colonne `id` comme identifiant de source', () => {
    const [produit] = produits('name,price,currency,id\nSérum éclat,12000,XOF,8842');
    expect(produit.platformId).toBe('8842');
  });

  it('n’attribue pas le SKU d’une VARIANTE au produit parent', () => {
    // Sinon « TSH-S » deviendrait la référence du produit, et le rapprochement
    // du prochain import chercherait une fiche qui porte une référence de
    // taille.
    const liste = produits([
      'name,price,currency,sku,variant_option',
      'T-shirt coton,12000,XOF,TSH-S,S',
      'T-shirt coton,12000,XOF,TSH-M,M',
    ].join('\n'));
    expect(liste).toHaveLength(1);
    expect(liste[0].sku ?? null).toBeNull();
    expect(liste[0].variants.map((v) => v.sku)).toEqual(['TSH-S', 'TSH-M']);
  });

  it('garde la référence d’une ligne produit sans variante', () => {
    const liste = produits('name,price,currency,sku\nSable fin,2500,XOF,SAB-1');
    expect(liste[0].sku).toBe('SAB-1');
  });
});

describe('rapprochement de bout en bout', () => {
  it('rapproche un produit renommé par sa référence de fichier', () => {
    // Le produit a changé de nom chez le marchand : seul le SKU permet de le
    // reconnaître. C'est le cas qui crée un doublon dans l'ancien système.
    const entrants = produits('name,price,currency,reference\nSérum éclat v2,13000,XOF,SER-01');
    const resultats = matchBatch(
      entrants.map((p) => ({ name: p.name, sku: p.sku, platformId: p.platformId })),
      [{ id: 'existant', name: 'Sérum éclat', sku: 'SER-01' }],
    );
    expect(resultats[0].decision).toBe('update');
    expect(resultats[0].targetId).toBe('existant');
  });

  it('rapproche par identifiant de source fourni par un export PrestaShop', () => {
    const entrants = produits('name,price,currency,id\nNom changé,9000,XOF,4242');
    const resultats = matchBatch(
      entrants.map((p) => ({ name: p.name, platformId: p.platformId })),
      [{ id: 'existant', name: 'Nom d’origine', platformId: '4242' }],
    );
    expect(resultats[0].decision).toBe('update');
  });

  it('signale deux lignes de même référence comme doublon interne', () => {
    const entrants = produits([
      'name,price,currency,reference',
      'Sable fin,2500,XOF,SAB-1',
      'Sable fin premium,3000,XOF,SAB-1',
    ].join('\n'));
    const resultats = matchBatch(
      entrants.map((p) => ({ name: p.name, sku: p.sku })),
      [],
    );
    expect(resultats[0].decision).toBe('create');
    expect(resultats[1].decision).toBe('duplicate-in-batch');
    expect(resultats[1].against).toBe(0);
  });

  it('présente un nom proche sans référence comme ambigu, pas comme une mise à jour', () => {
    const entrants = produits('name,price,currency\nChemise indigo,5000,XOF');
    const resultats = matchBatch(
      entrants.map((p) => ({ name: p.name, sku: p.sku })),
      [{ id: 'existant', name: 'Chemise indigo premium' }],
    );
    expect(resultats[0].decision).toBe('ambiguous');
    expect(resultats[0].targetId).toBeNull();
  });
});
