/**
 * Shopify — client Admin API, sonde et lecture.
 *
 * Ces tests portent sur ce qui coûte cher quand c'est faux : un jeton envoyé au
 * mauvais domaine, une clé sans scope déclarée « connectée », une pagination qui
 * boucle ou qui s'arrête trop tôt, un brouillon importé.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SHOPIFY_PAGE_SIZE,
  classifyShopifyStatus,
  extrairePageInfo,
  missingRequiredScopes,
  normalizeShopDomain,
  probeShopify,
  readGrantedScopes,
  readShopifyCatalog,
  shopifyAdminUrl,
  validateShopifyToken,
  type ShopifyFetchDeps,
} from '../src/business/importer/shopify-api';
import { toShopifyRawProduct, toShopifyRawProducts } from '../src/business/importer/shopify-catalog';

const DOMAINE = 'ma-boutique.myshopify.com';
/*
 * Faux jeton, volontairement NON conforme à la forme d'un vrai `shpat_…` :
 * GitHub Push Protection bloque tout push contenant une chaîne qui ressemble
 * à un jeton Shopify (`shpat_` + 32 hexadécimaux). La fixture n'a pas besoin
 * d'être réaliste — seulement de commencer par le préfixe attendu et d'être
 * assez longue, ce que `validateShopifyToken` vérifie.
 */
const JETON = 'shpat_jeton_de_test_non_reel_0000';

describe('domaine', () => {
  it('accepte un domaine myshopify nu', () => {
    const r = normalizeShopDomain(DOMAINE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.domain).toBe(DOMAINE);
  });

  it('accepte une URL d’administration complète et la réduit au domaine', () => {
    const r = normalizeShopDomain('https://Ma-Boutique.myshopify.com/admin/products');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.domain).toBe(DOMAINE);
  });

  it('refuse une adresse de vitrine sans deviner le domaine', () => {
    const r = normalizeShopDomain('https://ma-boutique.com');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shop_mismatch');
      // Le message doit dire OÙ trouver le bon domaine.
      expect(r.error.message).toContain('myshopify.com');
      expect(r.error.message).toMatch(/Paramètres/);
    }
  });

  it('refuse un sous-domaine imbriqué', () => {
    const r = normalizeShopDomain('a.b.myshopify.com');
    expect(r.ok).toBe(false);
  });

  it('refuse un domaine vide', () => {
    expect(normalizeShopDomain('').ok).toBe(false);
    expect(normalizeShopDomain(null).ok).toBe(false);
  });
});

describe('jeton', () => {
  it('accepte un jeton shpat_', () => {
    const r = validateShopifyToken(JETON);
    expect(r.ok).toBe(true);
  });

  it('refuse un jeton sans préfixe en expliquant quoi faire', () => {
    const r = validateShopifyToken('abc123def456ghi789jkl');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toContain('shpat_');
      expect(r.error.message).toMatch(/application personnalisée/i);
    }
  });

  it('refuse un jeton contenant un espace ou un retour à la ligne', () => {
    // Un saut de ligne dans un en-tête permet l'injection d'en-têtes HTTP.
    expect(validateShopifyToken(`${JETON}\r\nX-Evil: 1`).ok).toBe(false);
    expect(validateShopifyToken(`${JETON} `).ok).toBe(true); // trim toléré
    expect(validateShopifyToken(`${JETON.slice(0, 10)} ${JETON.slice(10)}`).ok).toBe(false);
  });

  it('refuse un jeton trop court', () => {
    expect(validateShopifyToken('shpat_abc').ok).toBe(false);
  });
});

describe('URL d’API', () => {
  it('n’inclut jamais le jeton', () => {
    const url = shopifyAdminUrl(DOMAINE, 'products.json', { limit: '250' });
    expect(url).not.toContain(JETON);
    expect(url).toContain(DOMAINE);
    expect(url).toMatch(/\/admin\/api\/2024-10\/products\.json/);
  });
});

describe('scopes', () => {
  it('lit les scopes accordés depuis l’en-tête', () => {
    expect(readGrantedScopes('read_products,write_products, read_inventory '))
      .toEqual(['read_products', 'write_products', 'read_inventory']);
  });

  it('rend une liste vide quand l’en-tête est absent', () => {
    expect(readGrantedScopes(null)).toEqual([]);
  });

  it('détecte le scope catalogue manquant', () => {
    expect(missingRequiredScopes(['read_orders'])).toEqual(['read_products']);
    expect(missingRequiredScopes(['read_products'])).toEqual([]);
  });
});

describe('pagination', () => {
  it('extrait page_info de l’en-tête Link', () => {
    const lien = `<https://${DOMAINE}/admin/api/2024-10/products.json?limit=250&page_info=eyJsYXN0X2lkIjo5fQ>; rel="next"`;
    expect(extrairePageInfo(lien)).toBe('eyJsYXN0X2lkIjo5fQ');
  });

  it('ignore un lien sans rel=next', () => {
    const lien = `<https://${DOMAINE}/admin/api/2024-10/products.json?page_info=abc>; rel="previous"`;
    expect(extrairePageInfo(lien)).toBeNull();
  });

  it('rend null sur un en-tête vide ou mal formé', () => {
    expect(extrairePageInfo('')).toBeNull();
    expect(extrairePageInfo('pas un lien')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Sonde                                                                       */
/* -------------------------------------------------------------------------- */

function reponseJson(corps: unknown, options: { status?: number; scopes?: string; link?: string } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.scopes !== undefined) headers.set('x-shopify-access-scopes', options.scopes);
  if (options.link) headers.set('link', options.link);
  return new Response(JSON.stringify(corps), { status: options.status ?? 200, headers });
}

function deps(reponses: Array<() => Response>): { deps: ShopifyFetchDeps; fetchImpl: ReturnType<typeof vi.fn> } {
  let index = 0;
  const fetchImpl = vi.fn(async () => {
    const fabrique = reponses[Math.min(index, reponses.length - 1)];
    index += 1;
    return fabrique();
  });
  return { deps: { fetchImpl, pause: async () => {}, retries: 0 }, fetchImpl };
}

const SHOP = { shop: { name: 'Atelier Lin', currency: 'EUR', country_code: 'FR', domain: DOMAINE } };

describe('sonde', () => {
  it('lit la boutique ET la première page de produits', async () => {
    const { deps: d, fetchImpl } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({ products: [{ id: 1 }] }, { scopes: 'read_products' }),
    ]);
    const r = await probeShopify({ shopDomain: DOMAINE, accessToken: JETON }, d);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.shopName).toBe('Atelier Lin');
      expect(r.value.currency).toBe('EUR');
      expect(r.value.resourcesRead).toContain('shop');
      expect(r.value.resourcesRead).toContain('products');
      // Pas de total inventé : Shopify ne le publie pas.
      expect(r.value.totalProducts).toBeNull();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuse une clé sans read_products SANS appeler le catalogue', async () => {
    const { deps: d, fetchImpl } = deps([
      () => reponseJson(SHOP, { scopes: 'read_orders' }),
    ]);
    const r = await probeShopify({ shopDomain: DOMAINE, accessToken: JETON }, d);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('insufficient_scope');
      expect(r.error.missingScopes).toEqual(['read_products']);
      expect(r.error.message).toContain('read_products');
    }
    // Le second appel n'a pas eu lieu : inutile de demander un catalogue
    // auquel on n'a pas droit.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ne valide pas une connexion sur un 401', async () => {
    const { deps: d } = deps([() => reponseJson({ errors: '[API] Invalid API key' }, { status: 401 })]);
    const r = await probeShopify({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('auth_invalid');
  });

  it('refuse une adresse de vitrine avant toute requête', async () => {
    const { deps: d, fetchImpl } = deps([() => reponseJson(SHOP)]);
    const r = await probeShopify({ shopDomain: 'https://ma-boutique.com', accessToken: JETON }, d);
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ne met jamais le jeton dans la réponse d’erreur', async () => {
    const { deps: d } = deps([() => reponseJson({}, { status: 401 })]);
    const r = await probeShopify({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(JSON.stringify(r)).not.toContain(JETON);
  });
});

/* -------------------------------------------------------------------------- */
/* Lecture                                                                     */
/* -------------------------------------------------------------------------- */

function produit(id: number, options: { status?: string; variants?: number } = {}) {
  const variantes = Array.from({ length: options.variants ?? 1 }, (_, i) => ({
    id: id * 10 + i,
    title: options.variants && options.variants > 1 ? `Taille ${i}` : 'Default Title',
    price: '12.50',
    sku: `SKU-${id}-${i}`,
    inventory_quantity: 5,
    inventory_policy: 'deny',
  }));
  return {
    id,
    title: `Produit ${id}`,
    body_html: '<p>Description</p>',
    handle: `produit-${id}`,
    status: options.status ?? 'active',
    product_type: 'Sacs',
    tags: ['cuir', 'fait main'],
    images: [{ src: `https://cdn.shopify.com/${id}.jpg` }],
    variants: variantes,
  };
}

describe('lecture du catalogue', () => {
  it('suit la pagination par curseur jusqu’au bout', async () => {
    const lienPage2 = `<https://${DOMAINE}/admin/api/2024-10/products.json?page_info=CURSEUR2>; rel="next"`;
    const { deps: d, fetchImpl } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({ products: [produit(1)] }, { scopes: 'read_products', link: lienPage2 }),
      () => reponseJson({ products: [produit(2)] }, { scopes: 'read_products' }),
    ]);

    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.products).toHaveLength(2);
    // boutique + page 1 + page 2
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // La page 2 est demandée avec le curseur reçu, jamais avec `?page=2`.
    const urlPage2 = String(fetchImpl.mock.calls[2][0]);
    expect(urlPage2).toContain('page_info=CURSEUR2');
  });

  it('s’arrête si le curseur ne progresse plus', async () => {
    const lien = `<https://${DOMAINE}/admin/api/2024-10/products.json?page_info=MEME>; rel="next"`;
    const { deps: d, fetchImpl } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({ products: [produit(1)] }, { scopes: 'read_products', link: lien }),
      () => reponseJson({ products: [produit(2)] }, { scopes: 'read_products', link: lien }),
      () => reponseJson({ products: [produit(3)] }, { scopes: 'read_products', link: lien }),
    ]);

    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(true);
    // Une boucle infinie aurait épuisé les 20 pages autorisées.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('écarte les brouillons et les archive, en les comptant', async () => {
    const { deps: d } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({
        products: [produit(1), produit(2, { status: 'draft' }), produit(3, { status: 'archived' })],
      }, { scopes: 'read_products' }),
    ]);

    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.products).toHaveLength(1);
      expect(r.value.unpublishedSkipped).toBe(2);
    }
  });

  it('compte les variantes réellement vues', async () => {
    const { deps: d } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({ products: [produit(1, { variants: 3 }), produit(2)] }, { scopes: 'read_products' }),
    ]);
    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.variantsSeen).toBe(4);
  });

  it('échoue explicitement si une page échoue, au lieu de rendre un catalogue partiel', async () => {
    const lien = `<https://${DOMAINE}/admin/api/2024-10/products.json?page_info=X>; rel="next"`;
    const { deps: d } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => reponseJson({ products: [produit(1)] }, { scopes: 'read_products', link: lien }),
      () => reponseJson({}, { status: 500 }),
    ]);
    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(false);
  });

  it('respecte le plafond et le signale', async () => {
    // 250 produits par page, plafond 5000 : la page 20 dépasse.
    const lien = `<https://${DOMAINE}/admin/api/2024-10/products.json?page_info=P${Math.random()}>; rel="next"`;
    let compteur = 0;
    const { deps: d } = deps([
      () => reponseJson(SHOP, { scopes: 'read_products' }),
      () => {
        compteur += 1;
        const page = Array.from({ length: SHOPIFY_PAGE_SIZE }, (_, i) => produit(compteur * 1000 + i));
        return reponseJson({ products: page }, { scopes: 'read_products', link: lien.replace('P', `P${compteur}`) });
      },
    ]);
    const r = await readShopifyCatalog({ shopDomain: DOMAINE, accessToken: JETON }, d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.products.length).toBeLessThanOrEqual(5_000);
      expect(r.value.truncated).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

describe('projection vers la forme commune', () => {
  it('reprend prix, description, image, catégories et identifiant', () => {
    const brut = toShopifyRawProduct(produit(7, { variants: 2 }));
    expect(brut).not.toBeNull();
    expect(brut).toMatchObject({
      name: 'Produit 7',
      price: '12.50',
      imageUrl: 'https://cdn.shopify.com/7.jpg',
      platformId: '7',
      categories: ['Sacs', 'cuir', 'fait main'],
    });
    expect(brut?.variants).toHaveLength(2);
  });

  it('résume une variante « Default Title » en fiche simple, sans fausse déclinaison', () => {
    const brut = toShopifyRawProduct(produit(8));
    expect(brut?.variants).toHaveLength(0);
    // Le SKU de la variante unique devient bien la référence du produit.
    expect(brut?.sku).toBe('SKU-8-0');
  });

  it('n’attribue pas le SKU de la première variante à un produit à variantes', () => {
    const brut = toShopifyRawProduct(produit(9, { variants: 2 }));
    expect(brut?.sku).toBeNull();
  });

  it('somme le stock des variantes quand il est connu', () => {
    const brut = toShopifyRawProduct(produit(10, { variants: 2 }));
    expect(brut?.stock).toBe(10);
  });

  it('laisse le stock inconnu à null, jamais à zéro', () => {
    // Deux variantes : elles restent exposées, et aucune ne publie de quantité
    // (inventaire non suivi par le marchand). Le stock est alors INCONNU.
    const sansStock = produit(11, { variants: 2 });
    for (const variante of sansStock.variants) {
      (variante as Record<string, unknown>).inventory_quantity = null;
    }
    const brut = toShopifyRawProduct(sansStock);
    expect(brut?.stock).toBeNull();
    expect(brut?.variants[0].stock).toBeNull();
    expect(brut?.variants[1].stock).toBeNull();
  });

  it('rejette un produit sans titre sans fabriquer de fiche', () => {
    const sansTitre = { ...produit(12), title: '   ' };
    expect(toShopifyRawProduct(sansTitre)).toBeNull();
  });

  it('ne construit pas d’URL produit sans domaine de vitrine', () => {
    const brut = toShopifyRawProduct(produit(13));
    expect(brut?.productUrl).toBeNull();
  });

  it('compte les rejets de projection', () => {
    const resultat = toShopifyRawProducts({
      platform: 'shopify',
      endpoint: '',
      shopName: null,
      domain: DOMAINE,
      currency: null,
      products: [produit(1), { ...produit(2), title: '' }],
      variantsSeen: 1,
      unpublishedSkipped: 0,
      truncated: false,
      resourcesRead: [],
    });
    expect(resultat.produits).toHaveLength(1);
    expect(resultat.rejets).toHaveLength(1);
  });
});

describe('classification des statuts', () => {
  it('distingue jeton invalide, scope manquant, boutique absente et boutique verrouillée', () => {
    expect(classifyShopifyStatus(401, null).code).toBe('auth_invalid');
    expect(classifyShopifyStatus(403, null).code).toBe('insufficient_scope');
    expect(classifyShopifyStatus(404, null).code).toBe('not_found');
    expect(classifyShopifyStatus(423, null).message).toMatch(/verrouillée/i);
    expect(classifyShopifyStatus(429, null).code).toBe('rate_limited');
  });

  it('ne recopie jamais le corps de la réponse dans le message', () => {
    const erreur = classifyShopifyStatus(422, { errors: 'données client confidentielles' });
    expect(erreur.message).not.toContain('confidentielles');
  });
});
