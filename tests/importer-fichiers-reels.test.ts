// @vitest-environment node
/**
 * Import CSV/XLSX — fichiers réalistes de bout en bout.
 *
 * ## Pourquoi ces tests existent
 * Les tests existants vérifient le parseur sur des chaînes construites à la
 * main. C'est nécessaire et insuffisant : un classeur produit par un vrai
 * tableur se comporte autrement (colonnes vides sautées, chaînes partagées,
 * flottants IEEE 754). Le 2026-11-16, trois défauts réels ont été trouvés en
 * passant les fichiers `supabase/tests/import-fichiers/` dans l'analyseur :
 *
 *   1. **Colonnes décalées** : les cellules vides d'une ligne XLSX n'émettent
 *      pas de `<c>`, donc toute colonne facultative manquante décalait les
 *      suivantes (`description: "15000"`, prix nul, image dans les catégories).
 *   2. **Prix faux** : `parseFloat` perd la précision (24,90 € → 2489 centimes
 *      au lieu de 2490) et accepte `12abc` en silence.
 *   3. **`stock` non reconnu** : la colonne était ignorée sans un mot.
 *
 * Ces tests portent sur les fichiers générés par
 * `supabase/tests/import-fichiers/generer.py`, pas sur des chaînes inventées.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFile } from '../src/business/importer/files';
import { runFileImport } from '../src/business/importer/pipeline';

const dossier = join(process.cwd(), 'supabase/tests/import-fichiers');
const lire = (nom: string) => new Uint8Array(readFileSync(join(dossier, nom)));

describe('CSV réel — lecture complète', () => {
  it('lit les 13 lignes de données sans en perdre', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 14 lignes de données, dont une sans nom (rejetée) → 13 produits.
    expect(r.products).toHaveLength(13);
    expect(r.format).toBe('csv');
  });

  it('conserve les noms accentués et les guillemets internes', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) throw new Error('lecture impossible');
    const bol = r.products.find((p) => p.name.startsWith('Bol'));
    expect(bol?.name).toBe('Bol "spécial" Dakar');
    const theiere = r.products.find((p) => p.name === 'Théière Bamako');
    expect(theiere?.name).toBe('Théière Bamako');
  });

  it('rejette la ligne sans nom au lieu d’inventer un produit', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) throw new Error('lecture impossible');
    expect(r.products.some((p) => p.name === '')).toBe(false);
  });

  it('signale les prix illisibles sans fabriquer de montant', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) throw new Error('lecture impossible');
    const demande = r.products.find((p) => p.name === 'Marmite en fonte');
    expect(demande?.priceMinor).toBeNull();
    expect(demande?.warnings.join(' ')).toMatch(/prix/i);
  });
});

describe('CSV réel — normalisation des prix', () => {
  const prix = async (nom: string): Promise<{ minor: number | null; currency: string } | null> => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) return null;
    const p = r.products.find((x) => x.name === nom);
    return p ? { minor: p.priceMinor, currency: p.currency } : null;
  };

  it('lit un entier en XOF sans lui appliquer de centimes', async () => {
    // XOF n'a pas de subdivision : 18500 reste 18500.
    expect(await prix('Sac en toile Koulikoro')).toEqual({ minor: 18500, currency: 'XOF' });
  });

  it('convertit un prix décimal européen en centimes, sans perte', async () => {
    // « 24,90 » → 2490 centimes. `parseFloat('24,90') * 100` donne 2489.99…,
    // tronqué à 2489 : un centime perdu à chaque produit.
    expect(await prix('Théière Bamako')).toEqual({ minor: 2490, currency: 'EUR' });
  });

  it('lit un montant avec séparateur de milliers et devise en clair', async () => {
    expect(await prix('Tableau d\'art Dogon')).toEqual({ minor: 45000, currency: 'XOF' });
  });

  it('laisse le prix nul quand il est absent, sans mettre zéro', async () => {
    // 0 serait un prix affiché « gratuit » : ce n'est pas la même chose.
    expect((await prix('Panier tressé Ségou'))?.minor).toBeNull();
  });

  it('ramène une devise inconnue à la devise par défaut au lieu d’inventer', async () => {
    const statue = await prix('Statuette Dogon');
    expect(statue?.currency).toBe('XOF');
  });
});

describe('CSV réel — doublons et quantités', () => {
  it('détecte le doublon interne au lot (casse différente)', async () => {
    const r = await runFileImport(lire('produits.csv'), 'produits.csv', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.batch.duplicates).toHaveLength(1);
    expect(r.batch.duplicates[0].kind).toBe('in-batch');
    // Un seul des deux est importable : le second écraserait le premier.
    expect(r.batch.summary.importable).toBe(12);
    expect(r.batch.summary.total).toBe(13);
  });

  it('lit la colonne stock quand elle est présente', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) throw new Error('lecture impossible');
    const sac = r.products.find((p) => p.name === 'Sac en toile Koulikoro');
    expect(sac?.stock).toBe(12);
  });

  it('signale un stock négatif plutôt que de l’accepter', async () => {
    const r = await importFile(lire('produits.csv'), 'produits.csv');
    if (!r.ok) throw new Error('lecture impossible');
    const coussin = r.products.find((p) => p.name === 'Coussin brodé');
    expect(coussin?.stock ?? null).toBeNull();
    expect(coussin?.warnings.join(' ')).toMatch(/stock/i);
  });
});

describe('XLSX réel — alignement des colonnes', () => {
  it('lit 12 produits : la ligne portant une FORMULE est refusée', async () => {
    // Le CSV contient `=HYPERLINK(…)` comme TEXTE (13 produits). Dans le
    // classeur, c'est une VRAIE formule : sa valeur mise en cache est vide, et
    // une formule n'est jamais évaluée. La ligne est donc écartée — ce qui est
    // le comportement sûr. Le test fige ce choix plutôt que de le subir.
    const r = await importFile(lire('produits.xlsx'), 'produits.xlsx');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.products).toHaveLength(12);
    expect(r.products.some((p) => p.name.includes('HYPERLINK'))).toBe(false);
    expect(r.format).toBe('xlsx');
  });

  it('n’évalue jamais une formule contenue dans un classeur', async () => {
    // Une formule XLSX est du contenu non fiable : la lire reviendrait à
    // exécuter ce que le fichier demande. On lit la valeur mise en cache, qui
    // est vide ici, donc la ligne ne produit pas de produit.
    const r = await importFile(lire('produits.xlsx'), 'produits.xlsx');
    if (!r.ok) throw new Error('lecture impossible');
    expect(r.products.every((p) => !p.name.startsWith('=') && !p.name.includes('phish'))).toBe(true);
  });

  it('ne décale pas les colonnes quand un champ facultatif est vide', async () => {
    // C'est LE défaut : sans référence de cellule, la ligne sans description
    // faisait glisser prix → description, image → catégories.
    const r = await importFile(lire('produits.xlsx'), 'produits.xlsx');
    if (!r.ok) throw new Error('lecture impossible');
    const bouilloire = r.products.find((p) => p.name === 'Bouilloire Sahel');
    expect(bouilloire).toBeDefined();
    expect(bouilloire?.description).toBe('');
    expect(bouilloire?.priceMinor).toBe(15000);
    expect(bouilloire?.categories).toEqual(['cuisine']);
    expect(bouilloire?.imageUrl).toContain('bouilloire');
  });

  it('produit exactement les mêmes valeurs que le CSV, hors ligne à formule', async () => {
    // Le classeur et le CSV portent les mêmes données. La seule différence
    // légitime est la ligne à formule (refusée en XLSX, texte en CSV) : toute
    // AUTRE divergence serait un défaut de lecture.
    const csv = await importFile(lire('produits.csv'), 'produits.csv');
    const xlsx = await importFile(lire('produits.xlsx'), 'produits.xlsx');
    if (!csv.ok || !xlsx.ok) throw new Error('lecture impossible');
    const signature = (r: typeof csv) => r.products
      .filter((p) => !p.name.includes('HYPERLINK'))
      .map((p) => [p.name, p.description, p.priceMinor, p.currency, p.stock, p.categories.join('|')].join('§'));
    expect(signature(xlsx)).toEqual(signature(csv));
  });

  it('lit un prix décimal XLSX (flottant) sans perte de centime', async () => {
    const r = await importFile(lire('produits.xlsx'), 'produits.xlsx');
    if (!r.ok) throw new Error('lecture impossible');
    const theiere = r.products.find((p) => p.name === 'Théière Bamako');
    // Le tableur stocke 24.9 en flottant : 24.9 * 100 = 2490.0000000000005.
    expect(theiere?.priceMinor).toBe(2490);
  });
});

describe('XLSX réel — variantes', () => {
  it('ramène les 6 lignes de variantes à 2 fiches produit', async () => {
    // Trois tailles de T-shirt et trois pointures de sandales sont DEUX
    // produits, pas six. Le regroupement se fait sur le SKU parent.
    const r = await importFile(lire('variantes.xlsx'), 'variantes.xlsx');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.products).toHaveLength(2);
    expect(r.products.map((p) => p.name).sort()).toEqual(['Sandales cuir Gao', 'T-shirt Bogolan']);
  });

  it('regroupe les variantes sous un seul produit au lieu de créer 3 doublons', async () => {
    // Trois lignes « T-shirt Bogolan » (tailles S/M/L) sont UN produit à trois
    // variantes. Sans regroupement, l'utilisateur se retrouve avec trois
    // produits homonymes, et deux sont marqués « doublon » puis écartés.
    const r = await runFileImport(lire('variantes.xlsx'), 'variantes.xlsx', {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tshirts = r.batch.products.filter((p) => p.name === 'T-shirt Bogolan');
    expect(tshirts).toHaveLength(1);
    expect(tshirts[0].variants).toHaveLength(3);
    expect(tshirts[0].variants.map((v) => v.name).sort()).toEqual(['L', 'M', 'S']);
    // Le regroupement supprime les faux doublons : trois tailles ne sont pas
    // trois produits concurrents.
    expect(r.batch.summary.duplicateInBatch).toBe(0);
  });

  it('conserve le prix propre à chaque variante', async () => {
    const r = await runFileImport(lire('variantes.xlsx'), 'variantes.xlsx', {});
    if (!r.ok) throw new Error('lecture impossible');
    const tshirt = r.batch.products.find((p) => p.name === 'T-shirt Bogolan');
    const parTaille = Object.fromEntries((tshirt?.variants ?? []).map((v) => [v.name, v.priceMinor]));
    // La taille L coûte 500 de plus : le prix ne doit pas être moyenné ni
    // uniformisé sur la fiche.
    expect(parTaille).toEqual({ S: 12000, M: 12000, L: 12500 });
  });

  it('additionne le stock des variantes sur la fiche', async () => {
    // 10 + 15 + 7 = 32 : le stock de la fiche est ce qui est réellement
    // disponible, pas celui de la première ligne.
    const r = await runFileImport(lire('variantes.xlsx'), 'variantes.xlsx', {});
    if (!r.ok) throw new Error('lecture impossible');
    const tshirt = r.batch.products.find((p) => p.name === 'T-shirt Bogolan');
    expect(tshirt?.stock).toBe(32);
  });

  it('signale la variante sans prix sans lui inventer un montant', async () => {
    const r = await runFileImport(lire('variantes.xlsx'), 'variantes.xlsx', {});
    if (!r.ok) throw new Error('lecture impossible');
    const sandale = r.batch.products.find((p) => p.name === 'Sandales cuir Gao');
    const p45 = sandale?.variants.find((v) => v.name === '45');
    expect(p45?.priceMinor ?? null).toBeNull();
  });
});
