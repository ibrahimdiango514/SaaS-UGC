import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importFile } from '../src/business/importer/files';
import { previewValidity, formaterDuree, PREVIEW_WARNING_MS } from '../src/business/importer/preview-validity';

/**
 * Variantes : de l'octet du fichier jusqu'à la ligne qui sera écrite en base.
 *
 * ## Pourquoi ce test existe
 * Les variantes étaient **détectées** puis perdues : l'aperçu affichait
 * « S, M, L », et la base ne recevait qu'une fiche nue. Aucun test ne le
 * voyait, parce qu'aucun ne regardait plus loin que `parseFile()`. Celui-ci
 * vérifie les trois étages qui doivent tenir ensemble :
 *
 *   1. l'analyseur conserve le stock, le prix et la référence **par variante** ;
 *   2. la ligne écrite par l'Edge Function les reprend sans les aplatir ;
 *   3. un prix de variante absent reste `null` (prix du parent), jamais 0.
 *
 * Il ne remplace pas la vérification en base — faite séparément, en production,
 * jusqu'à la lecture de `ugc_product_variants` — mais il interdit la régression
 * silencieuse.
 */

const FICHIERS = 'supabase/tests/import-fichiers';

function octets(nom: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FICHIERS}/${nom}`));
}

describe('import XLSX avec variantes', () => {
  it('détecte deux fiches et six variantes dans variantes.xlsx', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    expect(resultat.products).toHaveLength(2);
    const variantes = resultat.products.flatMap((p) => p.variants);
    expect(variantes).toHaveLength(6);
  });

  it('conserve le stock PROPRE de chaque variante, et non la somme seule', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const tshirt = resultat.products.find((p) => p.name.includes('T-shirt'));
    expect(tshirt).toBeDefined();

    // Les stocks par variante étaient absents avant le correctif : seul le
    // total (32) survivait, ce qui ne permet pas de savoir combien il reste en M.
    expect(tshirt!.variants.map((v) => v.stock)).toEqual([10, 15, 7]);
    // Le parent conserve la somme : les deux informations coexistent.
    expect(tshirt!.stock).toBe(32);
  });

  it('conserve le prix et la devise propres à une variante', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const tshirt = resultat.products.find((p) => p.name.includes('T-shirt'))!;
    const prix = tshirt.variants.map((v) => v.priceMinor);
    // La taille L coûte 12 500 alors que le parent est à 12 000 : aplatir les
    // prix sur celui du parent perdrait cette information commerciale.
    expect(prix).toEqual([12000, 12000, 12500]);
    expect(tshirt.variants.every((v) => v.currency === 'XOF')).toBe(true);
  });

  it('conserve la référence (SKU) de chaque variante', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const skus = resultat.products.flatMap((p) => p.variants.map((v) => v.sku));
    expect(skus).toEqual(['TSH-S', 'TSH-M', 'TSH-L', 'SAN-41', 'SAN-43', 'SAN-45']);
  });

  it('laisse un prix de variante absent à null, jamais à zéro', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const sandales = resultat.products.find((p) => p.name.includes('Sandales'))!;
    const sansPrix = sandales.variants.find((v) => v.name === '45');
    // La pointure 45 n'a pas de prix : `null` signifie « prix du parent ».
    // Écrire 0 ferait apparaître une variante gratuite dans le catalogue.
    expect(sansPrix?.priceMinor).toBeNull();
    expect(sansPrix?.stock).toBe(0);
  });

  it('retient l’ordre du fichier, pour que « S, M, L » s’affiche dans l’ordre', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const tshirt = resultat.products.find((p) => p.name.includes('T-shirt'))!;
    expect(tshirt.variants.map((v) => v.name)).toEqual(['S', 'M', 'L']);
  });

  it('nomme le critère quand la source le fournit', async () => {
    const resultat = await importFile(octets('variantes.xlsx'), 'variantes.xlsx');
    if (!resultat.ok) throw new Error('fichier non analysé');

    const criteres = new Set(resultat.products.flatMap((p) => p.variants.map((v) => v.attributeName)));
    expect(criteres).toEqual(new Set(['Taille', 'Pointure']));
  });
});

describe('import CSV — non-régression', () => {
  it('produit toujours 13 lignes avec les pièges attendus', async () => {
    const resultat = await importFile(octets('produits.csv'), 'produits.csv');
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(13);
  });

  it('n’invente aucune variante pour un CSV sans colonne de déclinaison', async () => {
    const resultat = await importFile(octets('produits.csv'), 'produits.csv');
    if (!resultat.ok) throw new Error('fichier non analysé');
    // Un tableau vide est la bonne réponse : mieux vaut aucune variante qu'une
    // variante fabriquée à partir du nom du produit.
    expect(resultat.products.every((p) => p.variants.length === 0)).toBe(true);
  });

  it('conserve le prix XOF sans le diviser par cent', async () => {
    const resultat = await importFile(octets('produits.csv'), 'produits.csv');
    if (!resultat.ok) throw new Error('fichier non analysé');
    const sac = resultat.products.find((p) => p.name.includes('Koulikoro'))!;
    expect(sac.priceMinor).toBe(18500);
    expect(sac.currency).toBe('XOF');
  });
});

describe('validité de l’aperçu temporaire', () => {
  const T0 = Date.parse('2026-11-16T12:00:00.000Z');
  const echeance = new Date(T0 + 10 * 60 * 1000).toISOString();

  it('annonce une durée restante quand l’échéance est lointaine', () => {
    const v = previewValidity(echeance, T0);
    expect(v.state).toBe('valid');
    expect(v.remainingMs).toBe(600_000);
    expect(v.label).toContain('confirmez avant l’expiration');
  });

  it('passe en avertissement sous le seuil, sans changer de sens', () => {
    const v = previewValidity(echeance, T0 + 600_000 - PREVIEW_WARNING_MS + 1);
    expect(v.state).toBe('expiring');
    expect(v.remainingMs).toBe(PREVIEW_WARNING_MS - 1);
  });

  it('déclare l’aperçu expiré à l’échéance exacte', () => {
    const v = previewValidity(echeance, T0 + 600_000);
    expect(v.state).toBe('expired');
    expect(v.remainingMs).toBe(0);
  });

  it('reste expiré après l’échéance et ne rend jamais de durée négative', () => {
    const v = previewValidity(echeance, T0 + 3_600_000);
    expect(v.state).toBe('expired');
    expect(v.remainingMs).toBe(0);
  });

  it('n’affirme rien quand l’échéance est absente ou illisible', () => {
    // Cas d'une réponse serveur plus ancienne : mieux vaut « inconnue » qu'un
    // décompte inventé, qui ferait confirmer au mauvais moment.
    expect(previewValidity(undefined, T0).state).toBe('unknown');
    expect(previewValidity('pas-une-date', T0).state).toBe('unknown');
  });

  it('formate les durées courtes sans arrondir au-dessus du réel', () => {
    expect(formaterDuree(59_999)).toBe('59 s');
    expect(formaterDuree(60_000)).toBe('1 min');
    expect(formaterDuree(125_000)).toBe('2 min 5 s');
    expect(formaterDuree(0)).toBe('0 s');
  });
});
