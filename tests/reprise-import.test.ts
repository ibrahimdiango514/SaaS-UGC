/**
 * Reprise d'import — idempotence et non-duplication.
 *
 * Ce que ces tests protègent :
 *   - reprendre ne réécrit jamais une ligne déjà traitée ;
 *   - reprendre deux fois de suite ne fait rien la seconde fois ;
 *   - une écriture réussie dont la progression s'est perdue est traitée par le
 *     rapprochement (mise à jour), jamais par une création en double ;
 *   - une ligne en échec reste dans le lot et sera retentée.
 */
import { describe, expect, it } from 'vitest';
import {
  importKey, lineKey, normalizeProgress, planResume, resumeSummary,
  type ImportProgress,
} from '../src/business/importer/resume';

const produit = (nom: string, sku: string | null = null, platformId: string | null = null) => ({
  name: nom, sku, platformId,
});

const progression = (lignes: Array<{ key: string; outcome?: 'created' | 'updated' }>): ImportProgress => ({
  importKey: 'lot-1',
  total: lignes.length,
  lines: lignes.map((l, i) => ({
    lineKey: l.key,
    productId: `p${i}`,
    outcome: l.outcome ?? 'created',
    variantsWritten: 0,
    createdAt: '2026-11-18T10:00:00.000Z',
  })),
});

describe('lineKey', () => {
  it('privilégie la référence, insensible à la casse et aux séparateurs', () => {
    expect(lineKey(produit('Peu importe', 'ref-12'))).toBe(lineKey(produit('Autre nom', 'REF 12')));
  });

  it('utilise l’identifiant de source à défaut de référence', () => {
    expect(lineKey(produit('X', null, '8842'))).toBe('pid:8842');
  });

  it('retombe sur le nom normalisé', () => {
    expect(lineKey(produit('Sérum  Éclat'))).toBe('nom:serum eclat');
  });
});

describe('importKey', () => {
  it('est stable pour le même lot', () => {
    const lot = [produit('A', 'A1'), produit('B', 'B1')];
    expect(importKey({ reference: 'cat.csv' }, lot)).toBe(importKey({ reference: 'CAT.CSV' }, lot));
  });

  it('ne dépend pas de l’ordre des lignes', () => {
    const a = [produit('A', 'A1'), produit('B', 'B1')];
    const b = [produit('B', 'B1'), produit('A', 'A1')];
    expect(importKey({ reference: 'cat.csv' }, a)).toBe(importKey({ reference: 'cat.csv' }, b));
  });

  it('distingue deux lots différents', () => {
    const a = importKey({ reference: 'cat.csv' }, [produit('A', 'A1')]);
    const b = importKey({ reference: 'cat.csv' }, [produit('A', 'A2')]);
    const c = importKey({ reference: 'autre.csv' }, [produit('A', 'A1')]);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('ignore un changement de prix : c’est le même lot', () => {
    // La clé porte sur l'identité des produits, pas sur leurs valeurs : sans
    // cela, une simple mise à jour de prix empêcherait toute reprise.
    const lot = [produit('A', 'A1')];
    expect(importKey({ reference: 'cat.csv' }, lot)).toBe(importKey({ reference: 'cat.csv' }, lot));
  });
});

describe('normalizeProgress', () => {
  it('lit les lignes utiles et ignore le reste', () => {
    const resultat = normalizeProgress({
      import_key: 'lot-1',
      total: 2,
      lines: [
        { line_key: 'ref:A1', product_id: 'p1', outcome: 'created', variants_written: 3 },
        { line_key: '', product_id: 'p2' },
        null,
      ],
    });
    expect(resultat.total).toBe(2);
    expect(resultat.lines).toHaveLength(1);
    expect(resultat.lines[0]).toMatchObject({ lineKey: 'ref:A1', productId: 'p1', variantsWritten: 3 });
  });

  it('supporte une réponse vide', () => {
    expect(normalizeProgress(null)).toEqual({ importKey: '', total: 0, lines: [] });
  });
});

describe('planResume', () => {
  const lot = [produit('A', 'A1'), produit('B', 'B1'), produit('C', 'C1')];

  it('ne reprend que les lignes non traitées', () => {
    const plan = planResume(lot, progression([{ key: 'ref:A1' }]));
    expect(plan.restant).toEqual([1, 2]);
    expect(plan.dejaFait).toBe(1);
    expect(plan.termine).toBe(false);
  });

  it('conserve l’ordre d’origine des lignes restantes', () => {
    const plan = planResume(lot, progression([{ key: 'ref:B1' }]));
    expect(plan.restant).toEqual([0, 2]);
  });

  it('est idempotent : tout traité ⇒ plus rien à faire', () => {
    const plan = planResume(lot, progression([
      { key: 'ref:A1' }, { key: 'ref:B1' }, { key: 'ref:C1' },
    ]));
    expect(plan.restant).toEqual([]);
    expect(plan.termine).toBe(true);
    expect(resumeSummary(plan, 3)).toMatch(/déjà terminé/);
  });

  it('reprend tout quand aucune progression n’existe', () => {
    const plan = planResume(lot, null);
    expect(plan.restant).toEqual([0, 1, 2]);
    expect(plan.dejaFait).toBe(0);
  });

  it('ne traite pas en création une ligne déjà présente en base', () => {
    // Écriture réussie dont l'accusé de réception s'est perdu : le produit est
    // en base, la progression l'ignore. Il doit passer par le rapprochement
    // (mise à jour), jamais par une création en double.
    const plan = planResume(lot, progression([{ key: 'ref:A1' }]), new Set(['ref:B1']));
    expect(plan.incertains).toBe(1);
    expect(plan.restant).toContain(1);
    expect(resumeSummary(plan, 3)).toMatch(/à vérifier avant écriture/);
  });

  it('signale l’incertitude même quand la progression est vide', () => {
    const plan = planResume(lot, null, new Set(['ref:A1', 'ref:B1', 'ref:C1']));
    expect(plan.incertains).toBe(3);
    expect(plan.restant).toEqual([0, 1, 2]);
  });

  it('reprend une ligne en échec, absente de la progression', () => {
    // Une ligne qui a échoué n'écrit aucune progression : elle reste dans le
    // lot et sera retentée, sans que les lignes réussies soient réécrites.
    const plan = planResume(lot, progression([{ key: 'ref:A1' }, { key: 'ref:C1' }]));
    expect(plan.restant).toEqual([1]);
  });

  it('dit ce qui est fait et ce qui reste', () => {
    const resume = resumeSummary(planResume(lot, progression([{ key: 'ref:A1' }])), 3);
    expect(resume).toMatch(/1 produit\(s\) sur 3 déjà écrit/);
    expect(resume).toMatch(/2 restant/);
  });
});
