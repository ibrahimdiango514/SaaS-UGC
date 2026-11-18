/**
 * Connecteur Chariow — lecture du catalogue sur des réponses API réalistes.
 *
 * Les charges utiles reproduisent la forme réellement documentée par Chariow
 * (`chariow.dev`) : `{ data: [...], pagination: { next_cursor, has_more_pages,
 * … } }`, montants `{ value, formatted, short, currency }` en **unité
 * principale**, images sous `pictures.{thumbnail,cover}`, stock sous
 * `quantity.remaining.value`.
 *
 * Ce que ces tests interdisent :
 *   - importer un produit en brouillon ou suspendu ;
 *   - confondre unité principale et unité mineure (facteur 100) ;
 *   - perdre l'arrondi XOF (24,9 → 25 F, pas 2 490) ;
 *   - fabriquer des variantes à partir de `has_variant_pricing` ;
 *   - inventer un SKU, un stock à zéro ou un prix libre ;
 *   - boucler sur un curseur qui ne progresse pas ;
 *   - transformer un 401 en « injoignable » ou un 403 en panne réseau.
 */
import { describe, expect, it } from 'vitest';
import {
  CHARIOW_API_BASE,
  classifyChariowStatus,
  fetchChariowResource,
  readChariowPagination,
  readMissingScopes,
  validateChariowKey,
} from '../src/business/importer/chariow-api';
import { probeChariow, readChariowCatalog, explainChariowError } from '../src/business/importer/chariow-catalog';
import {
  amountToMinor,
  mapChariowProduct,
  pickChariowPrice,
  readChariowStock,
  safeImageUrl,
  sameShopOrigin,
} from '../src/business/importer/chariow-pricing';
import { normalizeCatalog } from '../src/business/importer/pipeline';

/* -------------------------------------------------------------------------- */
/* Doublures                                                                  */
/* -------------------------------------------------------------------------- */

/** Clé de test : jamais une vraie clé, et reconnaissable comme telle. */
const CLE_TEST = 'sk_live_test_000000000000000000000000';

interface Reponse { status?: number; body: unknown; headers?: Record<string, string> }

type Repondeur = (url: URL) => Reponse;

function clientApi(repondeur: Repondeur) {
  const appels: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const entetes = new Headers(init?.headers ?? {});
    appels.push({ url: input, authorization: entetes.get('authorization') });
    const reponse = repondeur(new URL(input));
    return new Response(
      typeof reponse.body === 'string' ? reponse.body : JSON.stringify(reponse.body),
      { status: reponse.status ?? 200, headers: { 'content-type': 'application/json', ...(reponse.headers ?? {}) } },
    );
  };
  return { fetchImpl, appels };
}

const sansAttente = { pause: async () => {}, retries: 0 };

/** Produit publié complet, calqué sur la réponse documentée. */
function produitChariow(surcharge: Record<string, unknown> = {}) {
  return {
    id: 'prd_abc123',
    name: 'Premium Web Development Course',
    slug: 'premium-web-dev-course',
    description: '<p>Une formation complète.</p><script>alert(1)</script>',
    type: 'course',
    category: { value: 'education_and_learning', label: 'Education and Learning' },
    status: 'published',
    is_free: false,
    pictures: {
      thumbnail: 'https://cdn.chariow.com/products/abc123/thumb.jpg',
      cover: 'https://cdn.chariow.com/products/abc123/cover.jpg',
    },
    pricing: {
      type: 'one_time',
      current_price: { value: 99, formatted: '$99.00', short: '99', currency: 'USD' },
      price: { value: 149, formatted: '$149.00', short: '149', currency: 'USD' },
      effective: { value: 99, formatted: '$99.00', short: '99', currency: 'USD' },
      sale_price: { value: 99, formatted: '$99.00', short: '99', currency: 'USD' },
      minimum_price: { value: 0, formatted: '$0.00', short: '0', currency: 'USD' },
      suggested_price: { value: 0, formatted: '$0.00', short: '0', currency: 'USD' },
      price_off: '34%',
      tracking: { currency: 'USD', value: 99 },
    },
    has_variant_pricing: false,
    quantity: null,
    settings: { is_shipping_address_required: false },
    rating: { total_ratings: { value: 245 }, thumbs_up_count: 236, thumbs_up_percentage: '96%' },
    on_sale_until: null,
    sales_count: { value: 1250 },
    seo: null,
    custom_cta_text: { value: null, label: null },
    fields: null,
    store: null,
    bundle: null,
    coaching: null,
    ...surcharge,
  };
}

const boutique = {
  data: {
    id: 'store_abc123xyz',
    name: 'SBC AI AGENCY',
    description: 'Dev founder SaaS',
    logo_url: 'https://cdn.chariow.com/store/logo.png',
    url: 'https://ewbnibvk.mychariow.online',
    social_links: { instagram: null, facebook: null },
    status: 'active',
    stats: { total_customers: 42, ratings: { total_ratings: 10 } },
  },
};

/* -------------------------------------------------------------------------- */
/* Validation de la clé                                                        */
/* -------------------------------------------------------------------------- */

describe('Chariow — validation de la clé', () => {
  it('accepte une clé sk_ de longueur plausible', () => {
    const resultat = validateChariowKey(CLE_TEST);
    expect(resultat.ok).toBe(true);
  });

  it('refuse une clé vide, trop courte, ou sans préfixe sk_', () => {
    expect(validateChariowKey('').ok).toBe(false);
    expect(validateChariowKey('   ').ok).toBe(false);
    expect(validateChariowKey('sk_court').ok).toBe(false);
    expect(validateChariowKey('pk_live_0000000000000000000000').ok).toBe(false);
    expect(validateChariowKey(null).ok).toBe(false);
  });

  it('refuse une clé contenant un espace ou un saut de ligne (injection d’en-tête)', () => {
    expect(validateChariowKey('sk_live_aaa bbb cccccccccccccccc').ok).toBe(false);
    expect(validateChariowKey('sk_live_aaa\r\nX-Injected: 1').ok).toBe(false);
  });

  it('donne un message actionnable quand le préfixe manque', () => {
    const resultat = validateChariowKey('abcdefghijklmnopqrstuvwx');
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.message).toContain('sk_');
  });
});

/* -------------------------------------------------------------------------- */
/* Classification des erreurs                                                  */
/* -------------------------------------------------------------------------- */

describe('Chariow — classification des erreurs HTTP', () => {
  it('mappe 401 sur auth_invalid, jamais sur une panne réseau', () => {
    const erreur = classifyChariowStatus(401, { message: 'Invalid API key.' });
    expect(erreur.code).toBe('auth_invalid');
    expect(erreur.message).toContain('Settings');
  });

  it('mappe 403 sur insufficient_scope et nomme les scopes manquants', () => {
    const erreur = classifyChariowStatus(403, null, ['products.read']);
    expect(erreur.code).toBe('insufficient_scope');
    expect(erreur.missingScopes).toEqual(['products.read']);
    expect(erreur.message).toContain('products.read');
  });

  it('mappe 429 sur rate_limited et 5xx sur unreachable', () => {
    expect(classifyChariowStatus(429).code).toBe('rate_limited');
    expect(classifyChariowStatus(503).code).toBe('unreachable');
  });

  it('lit les scopes manquants dans errors.scopes', () => {
    const scopes = readMissingScopes({ errors: { scopes: ['products.read', 'store.read'] } });
    expect(scopes).toEqual(['products.read', 'store.read']);
  });

  it('lit les scopes manquants dans l’en-tête WWW-Authenticate si le corps est muet', () => {
    const scopes = readMissingScopes(null, 'Bearer error="insufficient_scope", scope="products.read"');
    expect(scopes).toEqual(['products.read']);
  });

  it('produit un message d’aide concret pour un scope manquant', () => {
    const message = explainChariowError(
      classifyChariowStatus(403, null, ['products.read']),
    );
    expect(message).toContain('products.read');
    expect(message).toContain('Settings');
  });
});

/* -------------------------------------------------------------------------- */
/* Montants et devises                                                         */
/* -------------------------------------------------------------------------- */

describe('Chariow — prix et devises', () => {
  it('préfère effective, puis current_price, puis price', () => {
    const pricing = {
      effective: { value: 99, currency: 'USD' },
      current_price: { value: 120, currency: 'USD' },
      price: { value: 149, currency: 'USD' },
    };
    expect(pickChariowPrice(pricing)?.value).toBe(99);
    expect(pickChariowPrice({ current_price: { value: 120, currency: 'USD' }, price: { value: 149 } })?.value).toBe(120);
    expect(pickChariowPrice({ price: { value: 149, currency: 'USD' } })?.value).toBe(149);
  });

  it('n’utilise JAMAIS minimum_price ni suggested_price (produit à prix libre)', () => {
    const pricing = {
      type: 'what_you_want',
      minimum_price: { value: 0, currency: 'USD' },
      suggested_price: { value: 50, currency: 'USD' },
    };
    expect(pickChariowPrice(pricing)).toBeNull();
  });

  it('convertit 99 USD en 9900 centimes', () => {
    expect(amountToMinor({ value: 99, currency: 'USD', formatted: null }, 'USD')).toBe(9900);
  });

  it('arrondit 24,9 € en 2490 centimes sans centime fantôme', () => {
    expect(amountToMinor({ value: 24.9, currency: 'EUR', formatted: null }, 'EUR')).toBe(2490);
    expect(amountToMinor({ value: 24.99, currency: 'EUR', formatted: null }, 'EUR')).toBe(2499);
  });

  it('applique l’exposant 0 du XOF : 24,9 → 25 F, jamais 2 490', () => {
    expect(amountToMinor({ value: 24.9, currency: 'XOF', formatted: null }, 'XOF')).toBe(25);
    expect(amountToMinor({ value: 1500, currency: 'XOF', formatted: null }, 'XOF')).toBe(1500);
  });

  it('rend null pour un montant absent ou négatif', () => {
    expect(amountToMinor(null, 'USD')).toBeNull();
    expect(amountToMinor({ value: null, currency: 'USD', formatted: null }, 'USD')).toBeNull();
    expect(amountToMinor({ value: -5, currency: 'USD', formatted: null }, 'USD')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping produit                                                             */
/* -------------------------------------------------------------------------- */

describe('Chariow — mapping produit', () => {
  it('conserve l’identifiant stable prd_ et ne fabrique aucun SKU', () => {
    const produit = mapChariowProduct(produitChariow());
    expect(produit?.id).toBe('prd_abc123');
    // `sku` n'existe pas dans le type : la seule identité est `id`.
    expect(produit).not.toHaveProperty('sku');
  });

  it('préfère pictures.cover à pictures.thumbnail', () => {
    const produit = mapChariowProduct(produitChariow());
    expect(produit?.imageUrl).toContain('cover.jpg');
  });

  it('retombe sur thumbnail quand cover est absent', () => {
    const produit = mapChariowProduct(produitChariow({
      pictures: { thumbnail: 'https://cdn.chariow.com/t.jpg', cover: null },
    }));
    expect(produit?.imageUrl).toContain('t.jpg');
  });

  it('refuse une image non https', () => {
    expect(safeImageUrl('http://cdn.chariow.com/x.jpg')).toBeNull();
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(safeImageUrl('https://cdn.chariow.com/x.jpg')).toContain('x.jpg');
  });

  it('lit le stock dans quantity.remaining.value et rend null si absent', () => {
    expect(readChariowStock({ value: 10, remaining: { value: 7 }, sold: { value: 3 } })).toBe(7);
    expect(readChariowStock({ value: 10 })).toBe(10);
    expect(readChariowStock(null)).toBeNull();
  });

  it('ne confond JAMAIS stock inconnu et stock zéro', () => {
    expect(readChariowStock(null)).toBeNull();
    expect(readChariowStock({ remaining: { value: 0 } })).toBe(0);
  });

  it('conserve has_variant_pricing comme indicateur, sans créer de variantes', () => {
    const produit = mapChariowProduct(produitChariow({ has_variant_pricing: true }));
    expect(produit?.hasVariantPricing).toBe(true);
    expect(produit).not.toHaveProperty('variants');
  });

  it('rend null pour un produit sans identifiant ou sans nom', () => {
    expect(mapChariowProduct({ id: '', name: 'X' })).toBeNull();
    expect(mapChariowProduct({ id: 'prd_1', name: '' })).toBeNull();
    expect(mapChariowProduct(null)).toBeNull();
  });

  it('force le prix à zéro quand is_free est vrai', () => {
    const produit = mapChariowProduct(produitChariow({ is_free: true }));
    expect(produit?.amount.value).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Comparaison de boutiques                                                    */
/* -------------------------------------------------------------------------- */

describe('Chariow — vérification que la clé correspond à la boutique', () => {
  it('accepte les variantes d’écriture d’une même boutique', () => {
    expect(sameShopOrigin('https://ewbnibvk.mychariow.online', 'ewbnibvk.mychariow.online/')).toBe(true);
    expect(sameShopOrigin('https://www.exemple.com', 'https://exemple.com')).toBe(true);
    expect(sameShopOrigin('https://Exemple.COM', 'https://exemple.com')).toBe(true);
  });

  it('refuse deux boutiques différentes — le cas qui écraserait le mauvais catalogue', () => {
    expect(sameShopOrigin('https://ewbnibvk.mychariow.online', 'https://autre.mychariow.online')).toBe(false);
    expect(sameShopOrigin(null, 'https://exemple.com')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

describe('Chariow — pagination par curseur', () => {
  it('lit next_cursor et has_more_pages', () => {
    const p = readChariowPagination({
      pagination: { count: 2, next_cursor: 'cur-2', has_more_pages: true },
    });
    expect(p.nextCursor).toBe('cur-2');
    expect(p.hasMorePages).toBe(true);
    expect(p.count).toBe(2);
  });

  it('s’arrête quand next_cursor est null', () => {
    const p = readChariowPagination({ pagination: { count: 1, next_cursor: null, has_more_pages: false } });
    expect(p.nextCursor).toBeNull();
    expect(p.hasMorePages).toBe(false);
  });

  it('tolère une pagination absente sans planter', () => {
    expect(readChariowPagination({}).nextCursor).toBeNull();
    expect(readChariowPagination(null).hasMorePages).toBe(false);
  });

  it('parcourt toutes les pages et transmet le curseur reçu', async () => {
    const { fetchImpl, appels } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      const curseur = url.searchParams.get('cursor');
      if (!curseur) {
        return {
          body: {
            data: [produitChariow({ id: 'prd_1', name: 'A' })],
            pagination: { count: 1, next_cursor: 'cur-2', has_more_pages: true },
          },
        };
      }
      if (curseur === 'cur-2') {
        return {
          body: {
            data: [produitChariow({ id: 'prd_2', name: 'B' })],
            pagination: { count: 1, next_cursor: 'cur-3', has_more_pages: true },
          },
        };
      }
      return {
        body: {
          data: [produitChariow({ id: 'prd_3', name: 'C' })],
          pagination: { count: 1, next_cursor: null, has_more_pages: false },
        },
      };
    });

    const resultat = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products.map((p) => p.id)).toEqual(['prd_1', 'prd_2', 'prd_3']);
    expect(resultat.value.truncated).toBe(false);
    // Trois pages produits + une lecture de boutique.
    const pagesProduits = appels.filter((a) => a.url.includes('/products'));
    expect(pagesProduits).toHaveLength(3);
    expect(pagesProduits[1].url).toContain('cursor=cur-2');
  });

  it('s’arrête net si le curseur ne progresse pas (API défaillante)', async () => {
    let tours = 0;
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      tours += 1;
      return {
        body: {
          data: [produitChariow({ id: `prd_${tours}`, name: `P${tours}` })],
          // Toujours le même curseur : une implémentation naïve boucherait ici.
          pagination: { count: 1, next_cursor: 'boucle', has_more_pages: true },
        },
      };
    });

    const resultat = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(true);
    // 2 pages au maximum : le curseur identique arrête la boucle.
    expect(tours).toBeLessThanOrEqual(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Filtre publié / brouillon                                                   */
/* -------------------------------------------------------------------------- */

describe('Chariow — produits publiés et brouillons', () => {
  it('n’importe que les produits publiés et compte les brouillons écartés', async () => {
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return {
        body: {
          data: [
            produitChariow({ id: 'prd_pub', name: 'Publié', status: 'published' }),
            produitChariow({ id: 'prd_draft', name: 'Brouillon', status: 'draft' }),
            produitChariow({ id: 'prd_susp', name: 'Suspendu', status: 'suspended' }),
            produitChariow({ id: 'prd_pub2', name: 'Publié 2', status: 'published' }),
          ],
          pagination: { count: 4, next_cursor: null, has_more_pages: false },
        },
      };
    });

    const resultat = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products.map((p) => p.id)).toEqual(['prd_pub', 'prd_pub2']);
    expect(resultat.value.draftsSkipped).toBe(2);
  });

  it('compte les produits inexploitables en rejets, sans casser la lecture', async () => {
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return {
        body: {
          data: [produitChariow({ id: 'prd_ok' }), { id: 'prd_sans_nom', name: '' }],
          pagination: { count: 2, next_cursor: null, has_more_pages: false },
        },
      };
    });
    const resultat = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products).toHaveLength(1);
    expect(resultat.value.rejected).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Erreurs réelles                                                             */
/* -------------------------------------------------------------------------- */

describe('Chariow — erreurs d’authentification et de permission', () => {
  it('remonte 401 comme auth_invalid, pas comme panne réseau', async () => {
    const { fetchImpl } = clientApi(() => ({
      status: 401,
      body: { message: 'Invalid API key. Please check again. Help: https://docs.chariow.com', errors: [] },
    }));
    const resultat = await probeChariow({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('auth_invalid');
  });

  it('remonte 403 avec les scopes manquants, sans réessayer', async () => {
    let appels = 0;
    const { fetchImpl } = clientApi(() => {
      appels += 1;
      return {
        status: 403,
        body: {
          message: 'This credential is missing the required scope: products.read.',
          data: [],
          errors: { scopes: ['products.read'] },
        },
        headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="products.read"' },
      };
    });
    const resultat = await probeChariow({ apiKey: CLE_TEST }, { fetchImpl, pause: async () => {}, retries: 2 });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('insufficient_scope');
    expect(resultat.error.missingScopes).toEqual(['products.read']);
    // Un 403 ne se réessaie pas : c'est une action côté Chariow.
    expect(appels).toBe(1);
  });

  it('réessaie un 429 puis réussit', async () => {
    let tours = 0;
    const { fetchImpl } = clientApi((url) => {
      tours += 1;
      if (tours === 1) return { status: 429, body: { message: 'Too many requests' } };
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return { body: { data: [], pagination: { count: 0, next_cursor: null, has_more_pages: false } } };
    });
    const resultat = await probeChariow(
      { apiKey: CLE_TEST },
      { fetchImpl, pause: async () => {}, retries: 2, retryDelayMs: 1 },
    );
    expect(resultat.ok).toBe(true);
    expect(tours).toBeGreaterThan(1);
  });

  it('refuse une réponse HTML (portail captif) au lieu de dire « JSON invalide »', async () => {
    const { fetchImpl } = clientApi(() => ({ body: '<!doctype html><html>proxy</html>' }));
    const resultat = await fetchChariowResource({ apiKey: CLE_TEST }, 'store', {}, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.message).toContain('HTML');
  });

  it('transmet la clé en en-tête Bearer, jamais dans l’URL', async () => {
    const { fetchImpl, appels } = clientApi(() => ({ body: boutique }));
    await fetchChariowResource({ apiKey: CLE_TEST }, 'store', {}, { fetchImpl, ...sansAttente });
    expect(appels[0].authorization).toBe(`Bearer ${CLE_TEST}`);
    expect(appels[0].url).not.toContain('sk_live');
    expect(appels[0].url.startsWith(CHARIOW_API_BASE)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Sonde de connexion                                                          */
/* -------------------------------------------------------------------------- */

describe('Chariow — sonde de connexion', () => {
  it('lit la boutique ET une page de produits (preuve des deux scopes)', async () => {
    const { fetchImpl, appels } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return { body: { data: [produitChariow()], pagination: { count: 1, next_cursor: null, has_more_pages: false } } };
    });
    const resultat = await probeChariow({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.store.name).toBe('SBC AI AGENCY');
    expect(resultat.value.store.url).toBe('https://ewbnibvk.mychariow.online');
    expect(resultat.value.resourcesRead).toEqual(['store', 'products']);
    expect(appels).toHaveLength(2);
  });

  it('échoue si la clé n’a pas products.read, même si store.read fonctionne', async () => {
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return { status: 403, body: { message: 'scope', errors: { scopes: ['products.read'] } } };
    });
    const resultat = await probeChariow({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('insufficient_scope');
  });

  it('refuse une clé mal formée sans aucun appel réseau', async () => {
    let appels = 0;
    const { fetchImpl } = clientApi(() => {
      appels += 1;
      return { body: boutique };
    });
    const resultat = await probeChariow({ apiKey: 'pas-une-cle' }, { fetchImpl, ...sansAttente });
    expect(resultat.ok).toBe(false);
    expect(appels).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Chaîne complète : Chariow → normaliseur commun                              */
/* -------------------------------------------------------------------------- */

describe('Chariow — intégration au normaliseur commun', () => {
  it('normalise un catalogue Chariow sans double conversion de prix', async () => {
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return {
        body: {
          data: [
            produitChariow({
              id: 'prd_xof',
              name: 'Formation XOF',
              pricing: {
                effective: { value: 24900, formatted: '24 900 F CFA', short: '24900', currency: 'XOF' },
                tracking: { currency: 'XOF', value: 24900 },
              },
            }),
          ],
          pagination: { count: 1, next_cursor: null, has_more_pages: false },
        },
      };
    });

    const lecture = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(lecture.ok).toBe(true);
    if (!lecture.ok) return;
    expect(lecture.value.currency).toBe('XOF');

    // On reconstruit les produits bruts comme le fera `store-import`, puis on
    // passe par le normaliseur COMMUN — le même que Shopify et PrestaShop.
    const bruts = lecture.value.products.map((produit) => {
      const devise = produit.amount.currency ?? lecture.value.currency ?? 'XOF';
      return {
        name: produit.name,
        description: produit.description,
        // `priceMinor` est la référence : plus aucune conversion en aval.
        priceMinor: amountToMinor(produit.amount, devise),
        price: produit.amount.value,
        currency: devise,
        productUrl: produit.slug ? `https://ewbnibvk.mychariow.online/${produit.slug}` : null,
        imageUrl: produit.imageUrl,
        categories: produit.category?.label ? [produit.category.label] : [],
        variants: [],
        sku: null,
        platformId: produit.id,
      };
    });

    const { produits, rejets } = normalizeCatalog(
      { platform: 'chariow', endpoint: 'https://api.chariow.com/v1/products', products: bruts, currency: 'XOF' },
      'chariow',
      'XOF',
    );
    expect(rejets).toHaveLength(0);
    expect(produits).toHaveLength(1);
    // 24 900 F CFA reste 24 900 F CFA : pas de facteur 100.
    expect(produits[0].priceMinor).toBe(24900);
    expect(produits[0].currency).toBe('XOF');
    expect(produits[0].platformId).toBe('prd_xof');
    expect(produits[0].sku).toBeNull();
    expect(produits[0].variants).toEqual([]);
  });

  it('nettoie le HTML de description fourni par Chariow', async () => {
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/store')) return { body: boutique };
      return {
        body: {
          data: [produitChariow({ id: 'prd_html' })],
          pagination: { count: 1, next_cursor: null, has_more_pages: false },
        },
      };
    });
    const lecture = await readChariowCatalog({ apiKey: CLE_TEST }, { fetchImpl, ...sansAttente });
    expect(lecture.ok).toBe(true);
    if (!lecture.ok) return;
    const { produits } = normalizeCatalog(
      {
        platform: 'chariow',
        endpoint: 'https://api.chariow.com/v1/products',
        products: lecture.value.products.map((p) => ({
          name: p.name,
          description: p.description,
          priceMinor: amountToMinor(p.amount, p.amount.currency ?? 'USD'),
          price: p.amount.value,
          currency: p.amount.currency ?? 'USD',
          productUrl: null,
          imageUrl: p.imageUrl,
          categories: [],
          variants: [],
          sku: null,
          platformId: p.id,
        })),
      },
      'chariow',
      'USD',
    );
    expect(produits[0].description).not.toContain('<script');
    expect(produits[0].description).not.toContain('<p>');
    expect(produits[0].description).toContain('formation');
  });
});
