// @vitest-environment node
/**
 * Pipeline d'import — le point où tous les risques se rencontrent.
 *
 * Ce qui est vérifié ici, et qui ne l'est nulle part ailleurs :
 *   - la **conversion des prix** : Shopify et WooCommerce n'expriment pas le
 *     prix dans la même unité. Se tromper d'un facteur 100 est l'erreur la plus
 *     coûteuse d'un importateur de catalogue ;
 *   - le **résumé** : ce que voit l'utilisateur avant d'écrire quoi que ce soit ;
 *   - l'**absence d'écriture** : le pipeline prépare, il n'écrit pas ;
 *   - les **échecs explicites** : plateforme inconnue, catalogue vide, fichier
 *     illisible — chacun avec un message qui dit quoi faire.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  formatPreviewPrice,
  isImportable,
  normalizeCatalogProduct,
  runFileImport,
  runUrlImport,
  summarizeBatch,
} from '../src/business/importer/pipeline';
import { buildProduct } from '../src/business/importer/normalize';

const résolveurPublic = async () => ['93.184.216.34'];

function html(contenu: string, headers: Record<string, string> = {}): Response {
  return new Response(contenu, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('conversion des prix — le piège de l’unité', () => {
  const produitShopify = {
    name: 'Sérum', description: '', price: '12000.00' as const, currency: null,
    productUrl: '/products/serum', imageUrl: null, categories: [], variants: [],
  };
  const produitWoo = {
    name: 'Sérum', description: '', price: '1200000' as const, currency: 'XOF',
    productUrl: null, imageUrl: null, categories: [], variants: [],
  };

  it('Shopify : 12000.00 GNF → 1200000 en unité mineure (2 décimales)', () => {
    // Une devise à 2 décimales : 12 000,00 → 1 200 000 centimes.
    const résultat = normalizeCatalogProduct(
      { ...produitShopify, currency: 'EUR' }, 'shopify',
      { reference: 'x', endpoint: 'https://b.com/' }, 'EUR',
    );
    expect('error' in résultat).toBe(false);
    if (!('error' in résultat)) expect(résultat.priceMinor).toBe(1_200_000);
  });

  it('Shopify : une devise sans subdivision ne multiplie pas', () => {
    // 12 000 XOF vaut 12 000, pas 1 200 000 : la devise n’a pas de centime.
    const résultat = normalizeCatalogProduct(
      { ...produitShopify, price: '12000' }, 'shopify',
      { reference: 'x', endpoint: 'https://b.com/' }, 'XOF',
    );
    expect('error' in résultat).toBe(false);
    if (!('error' in résultat)) expect(résultat.priceMinor).toBe(12_000);
  });

  it('WooCommerce : la valeur est déjà en unité mineure, aucune conversion', () => {
    const résultat = normalizeCatalogProduct(
      produitWoo, 'woocommerce', { reference: 'x', endpoint: 'https://b.com/' }, 'XOF',
    );
    expect('error' in résultat).toBe(false);
    if (!('error' in résultat)) expect(résultat.priceMinor).toBe(1_200_000);
  });

  it('les deux plateformes convergent pour un même prix affiché', () => {
    // 1 200 000 centimes d’euro = 12 000,00 € côté Shopify comme côté Woo.
    const shopify = normalizeCatalogProduct(
      { ...produitShopify, currency: 'EUR' }, 'shopify', { reference: 'x', endpoint: 'https://b.com/' }, 'EUR',
    );
    const woo = normalizeCatalogProduct(
      { ...produitWoo, price: '1200000', currency: 'EUR' }, 'woocommerce',
      { reference: 'x', endpoint: 'https://b.com/' }, 'EUR',
    );
    expect('error' in shopify).toBe(false);
    expect('error' in woo).toBe(false);
    if (!('error' in shopify) && !('error' in woo)) {
      expect(shopify.priceMinor).toBe(woo.priceMinor);
    }
  });

  it('résout une URL produit relative Shopify', () => {
    const résultat = normalizeCatalogProduct(
      produitShopify, 'shopify', { reference: 'x', endpoint: 'https://boutique.com/' }, 'XOF',
    );
    expect('error' in résultat).toBe(false);
    if (!('error' in résultat)) expect(résultat.productUrl).toBe('https://boutique.com/products/serum');
  });

  it('un prix absent reste inconnu, il n’est pas remplacé par zéro', () => {
    const résultat = normalizeCatalogProduct(
      { ...produitShopify, price: null }, 'shopify', { reference: 'x', endpoint: 'https://b.com/' }, 'XOF',
    );
    expect('error' in résultat).toBe(false);
    if (!('error' in résultat)) expect(résultat.priceMinor).toBeNull();
  });
});

describe('résumé — ce que l’utilisateur voit avant d’écrire', () => {
  const a = buildProduct({ name: 'Sérum', priceMinor: 1000, currency: 'XOF', source: { platform: 'file', reference: 'f' } });
  const b = buildProduct({ name: 'Baume', priceMinor: null, currency: 'XOF', source: { platform: 'file', reference: 'f' } });
  const doublon = buildProduct({ name: 'SERUM', priceMinor: 1000, currency: 'XOF', source: { platform: 'file', reference: 'f' } });

  it('compte importables, doublons et prix manquants', () => {
    if ('error' in a || 'error' in b || 'error' in doublon) throw new Error('produit invalide');
    const résumé = summarizeBatch([a, b, doublon], [
      { index: 2, kind: 'in-batch', against: 0 },
    ]);
    expect(résumé.total).toBe(3);
    expect(résumé.duplicateInBatch).toBe(1);
    expect(résumé.importable).toBe(2);
    expect(résumé.priced).toBe(2);
    expect(résumé.unpriced).toBe(1);
  });

  it('distingue un doublon du lot d’un doublon du catalogue existant', () => {
    if ('error' in a) throw new Error('produit invalide');
    const résumé = summarizeBatch([a], [{ index: 0, kind: 'existing', existingId: 'id-1' }]);
    expect(résumé.duplicateExisting).toBe(1);
    expect(résumé.duplicateInBatch).toBe(0);
    // Un doublon existant reste importable : l'utilisateur décide.
    expect(résumé.importable).toBe(1);
  });
});

describe('runUrlImport — réussite de bout en bout', () => {
  it('sonde, détecte Shopify, lit le catalogue et prépare un lot', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const cible = String(url);
      if (cible.includes('/products.json')) {
        return json({
          products: [
            { title: 'Sérum éclat', handle: 'serum', body_html: '<p>Vitaminé</p>', variants: [{ price: '12000', sku: 'SER' }], images: [{ src: 'https://cdn.shopify.com/a.jpg' }] },
            { title: 'Baume', handle: 'baume', variants: [{ price: '4500' }] },
          ],
        });
      }
      return html('<link href="https://cdn.shopify.com/x.css"><script>Shopify.theme={}</script>', { 'x-shopid': '1' });
    });

    const résultat = await runUrlImport('https://ma-boutique.com/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
      currency: 'XOF',
    });

    expect(résultat.ok).toBe(true);
    if (!résultat.ok) return;
    expect(résultat.batch.origin.platform).toBe('shopify');
    expect(résultat.batch.origin.reference).toBe('https://ma-boutique.com');
    expect(résultat.batch.products).toHaveLength(2);
    expect(résultat.batch.products[0].name).toBe('Sérum éclat');
    // Le HTML de description est nettoyé.
    expect(résultat.batch.products[0].description).toBe('Vitaminé');
    expect(résultat.batch.summary.importable).toBe(2);
  });

  it('détecte les doublons face au catalogue existant', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/products.json')) {
        return json({ products: [{ title: 'Sérum éclat', handle: 'serum', variants: [{ price: '1000' }] }] });
      }
      return html('<link href="https://cdn.shopify.com/x.css">', { 'x-shopid': '1' });
    });
    const résultat = await runUrlImport('https://ma-boutique.com/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
      existing: [{ id: 'p-1', name: 'SERUM ECLAT' }],
    });
    expect(résultat.ok).toBe(true);
    if (!résultat.ok) return;
    expect(résultat.batch.summary.duplicateExisting).toBe(1);
    expect(résultat.batch.duplicates[0].existingId).toBe('p-1');
  });
});

describe('runUrlImport — échecs explicites', () => {
  it('ne tente aucun endpoint quand la plateforme est inconnue', async () => {
    const fetchImpl = vi.fn(async () => html('<html>Aucun indice</html>'));
    const résultat = await runUrlImport('https://boutique.com/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
    });
    expect(résultat.ok).toBe(false);
    if (résultat.ok) return;
    expect(résultat.stage).toBe('acquire');
    expect(résultat.errors[0]).toMatch(/non identifiée/i);
    // Un seul appel : la sonde. Aucune tentative /products.json au hasard.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('explique quoi faire pour une plateforme sans catalogue public', async () => {
    const fetchImpl = vi.fn(async () => html('<script src="https://parastorage.com/x.js"></script>'));
    const résultat = await runUrlImport('https://boutique-wix.com/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
    });
    expect(résultat.ok).toBe(false);
    if (résultat.ok) return;
    expect(résultat.verdict?.platform).toBe('wix');
    expect(résultat.errors.join(' ')).toMatch(/CSV|API officielle/i);
  });

  it('signale une sonde impossible sans masquer la cause', async () => {
    const résultat = await runUrlImport('https://boutique.com/', { deps: { resolveHost: async () => ['10.0.0.1'] } });
    expect(résultat.ok).toBe(false);
    if (!résultat.ok) expect(résultat.stage).toBe('probe');
  });

  it('n’invente pas de produits quand le catalogue est vide', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/products.json')) return json({ products: [] });
      return html('<link href="https://cdn.shopify.com/x.css">', { 'x-shopid': '1' });
    });
    const résultat = await runUrlImport('https://boutique.com/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
    });
    expect(résultat.ok).toBe(false);
    if (!résultat.ok) expect(résultat.stage).toBe('acquire');
  });

  it('refuse une URL interne avant tout appel réseau', async () => {
    const fetchImpl = vi.fn();
    const résultat = await runUrlImport('http://169.254.169.254/latest/meta-data/', {
      deps: { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic },
    });
    expect(résultat.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runFileImport — le fichier suit le même chemin', () => {
  it('produit un lot avec les mêmes garanties', async () => {
    const importer = vi.fn(async () => ({
      ok: true as const,
      format: 'csv' as const,
      products: [
        buildProduct({ name: 'Sérum', priceMinor: 1000, currency: 'XOF', source: { platform: 'file' as const, reference: 'c.csv' } }) as never,
        buildProduct({ name: 'Baume', priceMinor: null, currency: 'XOF', source: { platform: 'file' as const, reference: 'c.csv' } }) as never,
      ],
      warnings: [],
      truncated: false,
    }));

    const résultat = await runFileImport(new Uint8Array([1]), 'c.csv', { importer });
    expect(résultat.ok).toBe(true);
    if (!résultat.ok) return;
    expect(résultat.batch.origin.kind).toBe('file');
    expect(résultat.batch.origin.reference).toBe('c.csv');
    expect(résultat.batch.summary.total).toBe(2);
    expect(résultat.batch.summary.unpriced).toBe(1);
  });

  it('remonte les erreurs du parseur sans les réécrire', async () => {
    const importer = vi.fn(async () => ({ ok: false as const, format: 'xml' as const, errors: ['DOCTYPE refusé'] }));
    const résultat = await runFileImport(new Uint8Array([1]), 'mauvais.xml', { importer });
    expect(résultat.ok).toBe(false);
    if (!résultat.ok) expect(résultat.errors).toEqual(['DOCTYPE refusé']);
  });

  it('refuse un fichier sans aucun produit valide', async () => {
    const importer = vi.fn(async () => ({ ok: true as const, format: 'csv' as const, products: [], warnings: [], truncated: false }));
    const résultat = await runFileImport(new Uint8Array([1]), 'vide.csv', { importer });
    expect(résultat.ok).toBe(false);
    if (!résultat.ok) expect(résultat.stage).toBe('normalize');
  });
});

describe('aucune écriture — le pipeline prépare seulement', () => {
  it('ne touche à aucune API d’écriture', async () => {
    // Le pipeline n’importe ni `createProduct` ni Supabase : on le vérifie en
    // inspectant les exports du module.
    const module = await import('../src/business/importer/pipeline');
    expect(Object.keys(module).sort()).toEqual([
      'formatPreviewPrice', 'isImportable', 'normalizeCatalog', 'normalizeCatalogProduct',
      'runFileImport', 'runImport', 'runUrlImport', 'summarizeBatch',
    ]);
  });
});

describe('affichage de prévisualisation', () => {
  it('formate un prix connu avec la bonne échelle', () => {
    const produit = buildProduct({ name: 'X', priceMinor: 1_200_000, currency: 'EUR', source: { platform: 'file', reference: 'f' } });
    if ('error' in produit) throw new Error('invalide');
    const texte = formatPreviewPrice(produit);
    expect(texte).toContain('12');
    expect(texte).toContain('000');
  });

  it('annonce un prix à compléter quand il est inconnu', () => {
    const produit = buildProduct({ name: 'X', priceMinor: null, source: { platform: 'file', reference: 'f' } });
    if ('error' in produit) throw new Error('invalide');
    expect(formatPreviewPrice(produit)).toBe('prix à compléter');
  });

  it('un produit sans nom n’est jamais importable', () => {
    const produit = buildProduct({ name: 'X', source: { platform: 'file', reference: 'f' } });
    if ('error' in produit) throw new Error('invalide');
    expect(isImportable(produit)).toBe(true);
    expect(isImportable({ ...produit, name: '   ' })).toBe(false);
  });
});
