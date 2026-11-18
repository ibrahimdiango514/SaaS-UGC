/**
 * WooCommerce — client REST, sonde, lecture et projection.
 *
 * Les points vérifiés sont ceux qui cassent silencieusement : clés en clair sur
 * HTTP, unité de prix confondue avec la Store API, pagination qui s'arrête trop
 * tôt, produit variable importé sans ses variations.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  WOO_PAGE_SIZE,
  basicAuthHeader,
  classifyWooStatus,
  fetchWooResource,
  normalizeWooSite,
  probeWooCommerce,
  readWooCatalog,
  readWooPagination,
  validateWooCredentials,
  wooApiUrl,
  type WooFetchDeps,
} from '../src/business/importer/woocommerce-api';
import { toWooRawProduct, toWooRawProducts } from '../src/business/importer/woocommerce-catalog';

const SITE = 'https://boutique.example';
const CLE = 'ck_0123456789abcdef0123456789abcdef01234567';
const SECRET = 'cs_0123456789abcdef0123456789abcdef01234567';

function reponseJson(
  corps: unknown,
  options: { status?: number; total?: number; totalPages?: number } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.total !== undefined) headers.set('x-wp-total', String(options.total));
  if (options.totalPages !== undefined) headers.set('x-wp-totalpages', String(options.totalPages));
  return new Response(JSON.stringify(corps), { status: options.status ?? 200, headers });
}

function deps(reponses: Array<() => Response>): { deps: WooFetchDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    const fabrique = reponses[Math.min(index, reponses.length - 1)];
    index += 1;
    return fabrique();
  });
  return { deps: { fetchImpl, pause: async () => {}, retries: 0 }, fetchImpl };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

describe('adresse du site', () => {
  it('accepte HTTPS et conserve un sous-dossier', () => {
    const r = normalizeWooSite('https://exemple.com/boutique/');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.siteUrl).toBe('https://exemple.com/boutique');
  });

  it('refuse HTTP, en expliquant le risque', () => {
    const r = normalizeWooSite('http://boutique.example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toMatch(/https/i);
      expect(r.error.message).toMatch(/clair/i);
    }
  });

  it('refuse des identifiants dans l’adresse', () => {
    expect(normalizeWooSite('https://user:pass@boutique.example').ok).toBe(false);
  });

  it('ajoute https quand le schéma manque', () => {
    const r = normalizeWooSite('boutique.example');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.siteUrl).toBe('https://boutique.example');
  });
});

describe('clés', () => {
  it('accepte une paire ck_/cs_', () => {
    const r = validateWooCredentials(CLE, SECRET);
    expect(r.ok).toBe(true);
  });

  it('exige LES DEUX clés', () => {
    expect(validateWooCredentials(CLE, '').ok).toBe(false);
    expect(validateWooCredentials('', SECRET).ok).toBe(false);
  });

  it('refuse un secret collé dans le champ de la clé', () => {
    const r = validateWooCredentials(SECRET, SECRET);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('ck_');
  });

  it('refuse un espace ou un saut de ligne dans une clé', () => {
    expect(validateWooCredentials(`${CLE}\r\nX-Evil: 1`, SECRET).ok).toBe(false);
  });

  it('refuse une clé trop courte', () => {
    expect(validateWooCredentials('ck_abc', SECRET).ok).toBe(false);
  });
});

describe('transport', () => {
  it('encode les clés en Basic, sans les mettre dans l’URL', () => {
    const entete = basicAuthHeader(CLE, SECRET);
    expect(entete.startsWith('Basic ')).toBe(true);
    const decode = atob(entete.slice(6));
    expect(decode).toBe(`${CLE}:${SECRET}`);

    const url = wooApiUrl(SITE, 'products', { per_page: '100' });
    expect(url).not.toContain(CLE);
    expect(url).not.toContain(SECRET);
    expect(url).toContain('/wp-json/wc/v3/products');
  });

  it('lit le total et le nombre de pages', () => {
    const entetes = new Headers({ 'x-wp-total': '312', 'x-wp-totalpages': '4' });
    expect(readWooPagination(entetes)).toEqual({ total: 312, totalPages: 4 });
  });

  it('rend null quand les en-têtes manquent, sans inventer de total', () => {
    expect(readWooPagination(new Headers())).toEqual({ total: null, totalPages: null });
  });
});

/* -------------------------------------------------------------------------- */
/* Sonde                                                                       */
/* -------------------------------------------------------------------------- */

describe('sonde', () => {
  it('lit réellement une page de produits et rapporte le volume', async () => {
    const { deps: d, fetchImpl } = deps([
      () => reponseJson([{ id: 1, name: 'Sac' }], { total: 42, totalPages: 3 }),
      () => reponseJson([], { total: 3, totalPages: 1 }),
    ]);
    const r = await probeWooCommerce({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totalProducts).toBe(42);
      expect(r.value.totalPages).toBe(3);
      expect(r.value.resourcesRead).toContain('products');
    }
    // Le jeton passe en en-tête, jamais en URL.
    const appel = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(String(appel[0])).not.toContain(CLE);
    expect(JSON.stringify(appel[1])).toContain('Basic ');
  });

  it('signale des clés refusées sans les reprendre dans le message', async () => {
    const { deps: d } = deps([() => reponseJson({ code: 'woocommerce_rest_cannot_view' }, { status: 401 })]);
    const r = await probeWooCommerce({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('auth_invalid');
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  it('explique un 404 par les permaliens ou le plugin, pas par les clés', async () => {
    const { deps: d } = deps([() => reponseJson({}, { status: 404 })]);
    const r = await probeWooCommerce({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('rest_disabled');
      expect(r.error.message).toMatch(/Permaliens/);
    }
  });

  it('détecte la présence de produits variables', async () => {
    const { deps: d } = deps([
      () => reponseJson([{ id: 1 }], { total: 1, totalPages: 1 }),
      () => reponseJson([{ id: 2, type: 'variable' }], { total: 1, totalPages: 1 }),
    ]);
    const r = await probeWooCommerce({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hasVariableProducts).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Lecture                                                                     */
/* -------------------------------------------------------------------------- */

function produit(id: number, options: Record<string, unknown> = {}) {
  return {
    id,
    name: `Produit ${id}`,
    type: 'simple',
    status: 'publish',
    description: '<p>Long</p>',
    short_description: '<p>Court</p>',
    price: '12.50',
    regular_price: '15.00',
    sku: `SKU-${id}`,
    permalink: `https://boutique.example/produit/${id}`,
    stock_quantity: 7,
    stock_status: 'instock',
    images: [{ src: `https://boutique.example/${id}.jpg` }],
    categories: [{ id: 5, name: 'Sacs', slug: 'sacs' }],
    ...options,
  };
}

describe('lecture du catalogue', () => {
  it('parcourt les pages jusqu’au total annoncé', async () => {
    const page1 = Array.from({ length: WOO_PAGE_SIZE }, (_, i) => produit(i + 1));
    const page2 = [produit(101), produit(102)];
    const { deps: d, fetchImpl } = deps([
      () => reponseJson([{ id: 5, name: 'Sacs' }]),
      () => reponseJson(page1, { total: 102, totalPages: 2 }),
      () => reponseJson(page2, { total: 102, totalPages: 2 }),
    ]);

    const r = await readWooCatalog({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.products).toHaveLength(102);
    // catégories + page 1 + page 2
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('s’arrête dès que le total est couvert, sans page inutile', async () => {
    const { deps: d, fetchImpl } = deps([
      () => reponseJson([]),
      () => reponseJson([produit(1)], { total: 1, totalPages: 1 }),
    ]);
    const r = await readWooCatalog({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('lit les variations des produits variables', async () => {
    const variable = produit(9, { type: 'variable', price: '10.00' });
    const { deps: d } = deps([
      () => reponseJson([]),
      () => reponseJson([variable], { total: 1, totalPages: 1 }),
      () => reponseJson([
        { id: 91, price: '10.00', sku: 'S', stock_quantity: 2, stock_status: 'instock', attributes: [{ name: 'Taille', option: 'S' }] },
        { id: 92, price: '12.00', sku: 'M', stock_quantity: 0, stock_status: 'outofstock', attributes: [{ name: 'Taille', option: 'M' }] },
      ]),
    ]);
    const r = await readWooCatalog({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.variationsRead).toBe(2);
  });

  it('échoue explicitement si une page échoue', async () => {
    const page1 = Array.from({ length: WOO_PAGE_SIZE }, (_, i) => produit(i + 1));
    const { deps: d } = deps([
      () => reponseJson([]),
      () => reponseJson(page1, { total: 200, totalPages: 2 }),
      () => reponseJson({}, { status: 500 }),
    ]);
    const r = await readWooCatalog({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    expect(r.ok).toBe(false);
  });

  it('ne fait aucune requête d’écriture', async () => {
    const { deps: d, fetchImpl } = deps([
      () => reponseJson([]),
      () => reponseJson([produit(1)], { total: 1, totalPages: 1 }),
    ]);
    await readWooCatalog({ siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET }, d);
    for (const appel of fetchImpl.mock.calls) {
      const init = appel[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').toBe('GET');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

describe('projection vers la forme commune', () => {
  const table = new Map<number, string>([[5, 'Sacs']]);

  it('reprend nom, prix, description, image, catégories et URL', () => {
    const brut = toWooRawProduct(produit(3), table);
    expect(brut).toMatchObject({
      name: 'Produit 3',
      price: '12.50',
      description: '<p>Long</p>',
      imageUrl: 'https://boutique.example/3.jpg',
      productUrl: 'https://boutique.example/produit/3',
      categories: ['Sacs'],
      platformId: '3',
      sku: 'SKU-3',
    });
  });

  it('préfère la description longue, sans concaténer la courte', () => {
    const brut = toWooRawProduct(produit(4, { description: '' }), table);
    expect(brut?.description).toBe('<p>Court</p>');
  });

  it('garde le stock `null` quand il n’est pas suivi', () => {
    const brut = toWooRawProduct(produit(5, { stock_quantity: null }), table);
    expect(brut?.stock).toBeNull();
  });

  it('rend le stock zéro quand il vaut réellement zéro', () => {
    const brut = toWooRawProduct(produit(6, { stock_quantity: 0 }), table);
    expect(brut?.stock).toBe(0);
  });

  it('mappe les variations avec prix, SKU, stock et valeur d’attribut', () => {
    const variable = produit(7, {
      type: 'variable',
      __variations: [
        { id: 71, price: '9.90', sku: 'S', stock_quantity: 3, stock_status: 'instock', attributes: [{ name: 'Taille', option: 'S' }] },
        { id: 72, price: '11.90', sku: 'M', stock_quantity: 0, stock_status: 'outofstock', attributes: [{ name: 'Taille', option: 'M' }] },
      ],
    });
    const brut = toWooRawProduct(variable, table);
    expect(brut?.variants).toHaveLength(2);
    expect(brut?.variants[0]).toMatchObject({
      name: 'S', price: '9.90', sku: 'S', stock: 3, available: true, attributeName: 'Taille',
    });
    expect(brut?.variants[1]).toMatchObject({ stock: 0, available: false });
    // Le stock du produit est la somme des variations.
    expect(brut?.stock).toBe(3);
  });

  it('n’attribue pas de SKU produit à un produit variable', () => {
    const variable = produit(8, {
      type: 'variable',
      __variations: [{ id: 81, price: '5.00', sku: 'X', stock_quantity: 1, attributes: [] }],
    });
    expect(toWooRawProduct(variable, table)?.sku).toBeNull();
  });

  it('signale un produit variable dont aucune variation n’a été lue', () => {
    const variable = produit(9, { type: 'variable' });
    const resultat = toWooRawProducts({
      platform: 'woocommerce',
      endpoint: '',
      storeName: null,
      siteUrl: SITE,
      currency: null,
      categories: table,
      products: [variable],
      variationsRead: 0,
      truncated: false,
      resourcesRead: [],
    });
    expect(resultat.produits).toHaveLength(1);
    expect(resultat.variablesSansVariations).toEqual(['Produit 9']);
  });

  it('rejette un produit non publié en le nommant', () => {
    const resultat = toWooRawProducts({
      platform: 'woocommerce',
      endpoint: '',
      storeName: null,
      siteUrl: SITE,
      currency: null,
      categories: table,
      products: [produit(10, { status: 'draft' })],
      variationsRead: 0,
      truncated: false,
      resourcesRead: [],
    });
    expect(resultat.produits).toHaveLength(0);
    expect(resultat.rejets[0].reason).toContain('draft');
  });
});

describe('classification des statuts', () => {
  it('distingue clés invalides, API absente et limitation', () => {
    expect(classifyWooStatus(401, null).code).toBe('auth_invalid');
    expect(classifyWooStatus(404, null).code).toBe('rest_disabled');
    expect(classifyWooStatus(429, null).code).toBe('rate_limited');
  });

  it('distingue un produit supprimé d’une API absente sur un 404', () => {
    expect(classifyWooStatus(404, { code: 'woocommerce_rest_product_invalid_id' }).code).toBe('not_found');
  });

  it('ne recopie pas le corps dans le message', () => {
    expect(classifyWooStatus(422, { message: 'secret interne' }).message).not.toContain('secret');
  });
});

describe('robustesse réseau', () => {
  it('réessaie une erreur 500 puis réussit', async () => {
    let essais = 0;
    const fetchImpl = vi.fn(async () => {
      essais += 1;
      if (essais === 1) return reponseJson({}, { status: 500 });
      return reponseJson([produit(1)], { total: 1, totalPages: 1 });
    });
    const r = await fetchWooResource(
      { siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET },
      'products',
      { per_page: '1' },
      { fetchImpl, retries: 1, pause: async () => {} },
    );
    expect(r.ok).toBe(true);
    expect(essais).toBe(2);
  });

  it('traduit une adresse bloquée par la garde SSRF', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('bloqué'), { code: 'blocked_url' });
    });
    const r = await fetchWooResource(
      { siteUrl: SITE, consumerKey: CLE, consumerSecret: SECRET },
      'products',
      {},
      { fetchImpl, retries: 0, pause: async () => {} },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('blocked_url');
  });
});
