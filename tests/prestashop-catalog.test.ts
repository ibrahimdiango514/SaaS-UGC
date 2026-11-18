/**
 * Connecteur PrestaShop — lecture du catalogue sur des réponses API réalistes.
 *
 * Ces réponses reproduisent la forme réellement renvoyée par le Webservice
 * PrestaShop (`{ prestashop: { products: [...] } }`, valeurs multilingues,
 * `associations.product_option_values`). Elles ne sont pas inventées « pour
 * faire passer le test » : chaque particularité piégeuse correspond à un
 * comportement documenté de PrestaShop 1.7/8.x.
 *
 * Ce que ces tests interdisent :
 *   - transformer une déclinaison en produit indépendant ;
 *   - perdre le SKU, la devise ou le stock ;
 *   - inventer un prix ou un stock quand l'API n'en donne pas ;
 *   - confondre « prix d'incidence » et « prix absolu » sur une déclinaison ;
 *   - s'arrêter silencieusement sur une pagination tronquée.
 */
import { describe, expect, it } from 'vitest';
import {
  priceMinorOf,
  textOf,
  parseContentRange,
  classifyStatus,
  resourceUrl,
} from '../src/business/importer/prestashop-api';
import { readPrestashopCatalog, probePrestashop } from '../src/business/importer/prestashop-catalog';
import { normalizeCatalog } from '../src/business/importer/pipeline';

/* -------------------------------------------------------------------------- */
/* Doublure d'API : répond selon la ressource et la page demandée.            */
/* -------------------------------------------------------------------------- */

interface Reponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

type Repondeur = (url: URL) => Reponse;

function clientApi(repondeur: Repondeur) {
  const appels: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const entetes = new Headers(init?.headers ?? {});
    appels.push({ url: input, authorization: entetes.get('authorization') });
    const url = new URL(input);
    const reponse = repondeur(url);
    return new Response(typeof reponse.body === 'string' ? reponse.body : JSON.stringify(reponse.body), {
      status: reponse.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reponse.headers ?? {}) },
    });
  };
  return { fetchImpl, appels };
}

/** Enveloppe PrestaShop, comme le fait le Webservice. */
const enveloppe = (ressource: string, valeur: unknown) => ({ prestashop: { [ressource]: valeur } });

/** Valeur multilingue, telle que PrestaShop la renvoie. */
const multilangue = (valeur: string, idLangue = 1) => ({ language: [{ '@id': String(idLangue), value: valeur }] });

/* -------------------------------------------------------------------------- */
/* Utilitaires purs                                                           */
/* -------------------------------------------------------------------------- */

describe('utilitaires PrestaShop', () => {
  it('lit un texte multilingue dans la langue demandée', () => {
    const brut = { language: [{ '@id': '1', value: 'Chemise' }, { '@id': '2', value: 'Shirt' }] };
    expect(textOf(brut, 2)).toBe('Shirt');
    expect(textOf(brut, 1)).toBe('Chemise');
    // Langue absente : on retombe sur la première disponible, jamais sur vide.
    expect(textOf(brut, 9)).toBe('Chemise');
  });

  it('lit un texte simple', () => {
    expect(textOf('Sable fin')).toBe('Sable fin');
    expect(textOf(12)).toBe('12');
    expect(textOf(null)).toBe('');
  });

  it('convertit un prix décimal en unité mineure', () => {
    expect(priceMinorOf('24.900000')).toBe(2490);
    expect(priceMinorOf('2500.000000')).toBe(250000);
    expect(priceMinorOf('0.5')).toBe(50);
    expect(priceMinorOf('')).toBeNull();
    expect(priceMinorOf('abc')).toBeNull();
  });

  it('lit le total de Content-Range', () => {
    expect(parseContentRange('0-99/1234')).toBe(1234);
    expect(parseContentRange('0-99/*')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });

  it('traduit les statuts HTTP en erreurs actionnables', () => {
    expect(classifyStatus(401).code).toBe('auth_invalid');
    expect(classifyStatus(403).code).toBe('forbidden');
    expect(classifyStatus(404).code).toBe('not_found');
    expect(classifyStatus(429).code).toBe('rate_limited');
    expect(classifyStatus(405).code).toBe('api_disabled');
    // Le message doit exister : c'est lui que l'utilisateur lira.
    expect(classifyStatus(401).message.length).toBeGreaterThan(20);
  });

  it('ne place jamais la clé dans une URL', () => {
    const url = resourceUrl(
      { root: new URL('https://boutique.example/'), basePath: '/api' },
      'products',
      { limit: '0,100' },
    );
    expect(url).toContain('https://boutique.example/api/products');
    expect(url).not.toContain('ws_key');
    expect(url).not.toContain('key');
    expect(url).toContain('output_format=JSON');
  });
});

/* -------------------------------------------------------------------------- */
/* Vérification de connexion                                                  */
/* -------------------------------------------------------------------------- */

describe('probePrestashop', () => {
  const cible = { root: new URL('https://boutique.example/'), basePath: '/api' };

  it('vérifie en lisant réellement des ressources', async () => {
    const { fetchImpl, appels } = clientApi((url) => {
      if (url.pathname.endsWith('/shops')) {
        return { body: enveloppe('shops', [{ id: '1', name: 'Boutique Bamako', version: '8.1.2' }]) };
      }
      if (url.pathname.endsWith('/languages')) {
        return { body: enveloppe('languages', [{ id: '1', iso_code: 'fr' }, { id: '2', iso_code: 'en' }]) };
      }
      return { body: enveloppe('products', [{ id: '1', name: 'Produit' }]), headers: { 'content-range': '0-0/42' } };
    });

    const resultat = await probePrestashop(cible, { apiKey: 'CLEFAPI1234567890ABCDEF123456' }, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.shopName).toBe('Boutique Bamako');
    expect(resultat.value.version).toBe('8.1.2');
    expect(resultat.value.totalProducts).toBe(42);
    expect(resultat.value.languages).toEqual([{ id: 1, isoCode: 'fr' }, { id: 2, isoCode: 'en' }]);
    // La preuve : trois ressources réellement lues, et la clé en en-tête.
    expect(resultat.value.resourcesRead).toEqual(['shops', 'languages', 'products']);
    expect(appels).toHaveLength(3);
    for (const appel of appels) {
      expect(appel.authorization).toMatch(/^Basic /);
      expect(appel.url).not.toContain('CLEFAPI1234567890ABCDEF123456');
    }
  });

  it('refuse une clé vide sans tenter de connexion', async () => {
    const { fetchImpl, appels } = clientApi(() => ({ body: {} }));
    const resultat = await probePrestashop(cible, { apiKey: '' }, { fetchImpl });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('auth_required');
    expect(appels).toHaveLength(0);
  });

  it('signale une clé refusée (401) sans réessayer', async () => {
    let appels = 0;
    const { fetchImpl } = clientApi(() => {
      appels += 1;
      return { status: 401, body: '<response><error>unauthorized</error></response>' };
    });
    const resultat = await probePrestashop(cible, { apiKey: 'CLEFAPI1234567890ABCDEF123456' }, { fetchImpl });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('auth_invalid');
    expect(appels).toBe(1);
  });

  it('distingue une page HTML d’une API absente', async () => {
    const { fetchImpl } = clientApi(() => ({ body: '<!DOCTYPE html><html><body>Boutique</body></html>' }));
    const resultat = await probePrestashop(cible, { apiKey: 'CLEFAPI1234567890ABCDEF123456' }, { fetchImpl });
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('not_prestashop');
    expect(resultat.error.message).toMatch(/HTML/);
  });

  it('réessaie une limite de débit puis échoue proprement', async () => {
    let appels = 0;
    const { fetchImpl } = clientApi(() => {
      appels += 1;
      return { status: 429, body: {} };
    });
    const resultat = await probePrestashop(
      cible,
      { apiKey: 'CLEFAPI1234567890ABCDEF123456' },
      { fetchImpl, retries: 2, pause: async () => {} },
    );
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('rate_limited');
    expect(appels).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Catalogue complet                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Catalogue de référence : deux produits, dont un avec trois déclinaisons.
 *
 * Particularités reproduites volontairement :
 *   - `id_default_image` arrive en objet `{ '#text': '5' }` sur PrestaShop 1.6 ;
 *   - `price` du produit est un décimal à 6 chiffres ;
 *   - `price` d'une déclinaison est une INCIDENCE (+2.000000), pas un prix ;
 *   - le stock réel est dans `stock_availables`, le cache de la déclinaison
 *     étant obsolète.
 */
function catalogueRealiste(page = 1) {
  const produits = page === 1
    ? [
      {
        id: '10',
        name: multilangue('Chemise indigo'),
        reference: 'CHE-1',
        price: '24.900000',
        id_default_image: { '#text': '5' },
        active: '1',
      },
      {
        id: '11',
        name: multilangue('Sable fin'),
        reference: '',
        price: '2500.000000',
        id_default_image: '0',
        active: '1',
      },
    ]
    : [];

  const declinaisons = page === 1
    ? [
      {
        id: '100',
        id_product: '10',
        reference: 'CHE-1-M',
        price: '0.000000',
        quantity: '0',
        associations: { product_option_values: { product_option_value: [{ id: '1' }, { id: '3' }] } },
      },
      {
        id: '101',
        id_product: '10',
        reference: 'CHE-1-L',
        price: '2.000000',
        quantity: '0',
        associations: { product_option_values: { product_option_value: [{ id: '2' }, { id: '3' }] } },
      },
    ]
    : [];

  const valeurs = [
    { id: '1', id_attribute_group: '1', name: multilangue('M') },
    { id: '2', id_attribute_group: '1', name: multilangue('L') },
    { id: '3', id_attribute_group: '2', name: multilangue('Bleu') },
  ];
  const groupes = [
    { id: '1', name: multilangue('Taille') },
    { id: '2', name: multilangue('Couleur') },
  ];
  // Stock réel : M = 4, L = 0. Le cache des déclinaisons dit 0 pour les deux —
  // c'est exactement le piège que le connecteur doit éviter.
  const stock = [
    { id: '1', id_product: '10', id_product_attribute: '100', quantity: '4' },
    { id: '2', id_product: '10', id_product_attribute: '101', quantity: '0' },
    { id: '3', id_product: '11', id_product_attribute: '0', quantity: '9' },
  ];

  return (url: URL): Reponse => {
    const chemin = url.pathname;
    if (chemin.endsWith('/products')) {
      // La pagination est REPRODUITE : la doublure renvoie vraiment une page
      // vide au-delà de la première. Sans cela, le connecteur boucherait sur
      // une API qui renvoie éternellement les mêmes produits — et les tests
      // valideraient un comportement qui n'existe pas en production.
      const limite = url.searchParams.get('limit') ?? '0,100';
      const [debut] = limite.split(',').map(Number);
      const pageCourante = debut >= produits.length ? [] : produits;
      return {
        body: enveloppe('products', pageCourante),
        headers: { 'content-range': `0-${Math.max(0, produits.length - 1)}/2` },
      };
    }
    // Même règle de pagination pour toutes les ressources : au-delà de la
    // première page, la réponse est vide. Sans cela, une ressource renvoyée à
    // l'identique à chaque page ferait boucler la lecture jusqu'au plafond.
    const auDela = Number((url.searchParams.get('limit') ?? '0,100').split(',')[0]) > 0;
    const choisir = <T>(valeur: T[]): T[] => (auDela ? [] : valeur);
    if (chemin.endsWith('/combinations')) return { body: enveloppe('combinations', choisir(declinaisons)) };
    if (chemin.endsWith('/product_option_values')) return { body: enveloppe('product_option_values', choisir(valeurs)) };
    if (chemin.endsWith('/product_options')) return { body: enveloppe('product_options', choisir(groupes)) };
    if (chemin.endsWith('/stock_availables')) return { body: enveloppe('stock_availables', choisir(stock)) };
    return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
  };
}

describe('readPrestashopCatalog', () => {
  const cible = { root: new URL('https://boutique.example/'), basePath: '/api' };
  const identifiants = { apiKey: 'CLEFAPI1234567890ABCDEF123456' };

  it('lit produits, déclinaisons, attributs et stock', async () => {
    const { fetchImpl } = clientApi(catalogueRealiste());
    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl }, { defaultCurrency: 'EUR' });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    const catalogue = resultat.value;
    expect(catalogue.platform).toBe('prestashop');
    expect(catalogue.products).toHaveLength(2);
    expect(catalogue.currency).toBe('EUR');
    expect(catalogue.resourcesRead).toEqual([
      'products', 'product_option_values', 'product_options', 'combinations', 'stock_availables',
    ]);

    const chemise = catalogue.products[0];
    expect(chemise.name).toBe('Chemise indigo');
    expect(chemise.sku).toBe('CHE-1');
    expect(chemise.platformId).toBe('10');
    // Prix du parent : 24,90 — pas la somme des incidences.
    expect(chemise.price).toBeCloseTo(24.9, 5);
    // Deux déclinaisons, jamais deux produits.
    expect(chemise.variants).toHaveLength(2);
    expect(chemise.variants.map((v) => v.name)).toEqual(['M / Bleu', 'L / Bleu']);
    expect(chemise.variants.map((v) => v.sku)).toEqual(['CHE-1-M', 'CHE-1-L']);
    // Le prix d'une déclinaison est le prix du parent PLUS l'incidence.
    expect(chemise.variants[0].price).toBeCloseTo(24.9, 5);
    expect(chemise.variants[1].price).toBeCloseTo(26.9, 5);
    // Le stock réel vient de `stock_availables`, pas du cache de la déclinaison.
    expect(chemise.variants[0].stock).toBe(4);
    expect(chemise.variants[1].stock).toBe(0);
    expect(chemise.stock).toBe(4);
    // Le critère est nommé, pas un identifiant nu.
    expect(chemise.variants[0].attributeName).toBe('Taille');
    // Image : URL construite depuis l'identifiant, pas inventée.
    expect(chemise.imageUrl).toBe('https://boutique.example/img/p/5/5.jpg');
  });

  it('lit un produit sans déclinaison et son stock propre', async () => {
    const { fetchImpl } = clientApi(catalogueRealiste());
    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    const sable = resultat.value.products[1];
    expect(sable.name).toBe('Sable fin');
    expect(sable.variants).toHaveLength(0);
    // Une référence vide ne devient pas une chaîne vide : elle reste absente.
    expect(sable.sku).toBeNull();
    expect(sable.stock).toBe(9);
    expect(sable.imageUrl).toBeNull();
  });

  it('ne promeut pas une déclinaison en produit', async () => {
    const { fetchImpl } = clientApi(catalogueRealiste());
    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // Le catalogue source a 2 produits et 2 déclinaisons : la sortie doit
    // compter 2 produits, jamais 4.
    expect(resultat.value.products).toHaveLength(2);
    const noms = resultat.value.products.map((p) => p.name);
    expect(noms).not.toContain('CHE-1-M');
  });

  it('échoue plutôt que de livrer un catalogue sans déclinaisons', async () => {
    // Des produits amputés de leurs tailles seraient un catalogue faux : mieux
    // vaut refuser l'import que d'écrire deux fiches incomplètes.
    const { fetchImpl } = clientApi((url) => {
      if (url.pathname.endsWith('/combinations')) return { status: 500, body: {} };
      return catalogueRealiste()(url);
    });
    const resultat = await readPrestashopCatalog(
      cible, identifiants, { fetchImpl, retries: 0 },
    );
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.error.code).toBe('unreachable');
  });

  it('pagine jusqu’au dernier produit et rapporte le total', async () => {
    // 250 produits sur 3 pages : le connecteur doit toutes les lire.
    const pages = new Map<string, unknown[]>();
    pages.set('1', Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1), name: multilangue(`Produit ${i + 1}`), reference: `P${i + 1}`, price: '10.000000',
    })));
    pages.set('2', Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 101), name: multilangue(`Produit ${i + 101}`), reference: `P${i + 101}`, price: '10.000000',
    })));
    pages.set('3', Array.from({ length: 50 }, (_, i) => ({
      id: String(i + 201), name: multilangue(`Produit ${i + 201}`), reference: `P${i + 201}`, price: '10.000000',
    })));

    const demandes: string[] = [];
    const { fetchImpl } = clientApi((url) => {
      const chemin = url.pathname;
      if (!chemin.endsWith('/products')) return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
      const limit = url.searchParams.get('limit') ?? '0,100';
      demandes.push(limit);
      const [, taille] = limit.split(',');
      const page = String(Math.floor(Number(limit.split(',')[0]) / Number(taille)) + 1);
      const items = pages.get(page) ?? [];
      return {
        body: enveloppe('products', items),
        headers: { 'content-range': `0-${Math.max(0, items.length - 1)}/250` },
      };
    });

    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products).toHaveLength(250);
    expect(resultat.value.truncated).toBe(false);
    // Une page de plus ne doit pas être demandée une fois le total couvert.
    expect(demandes).toEqual(['0,100', '100,100', '200,100']);
  });

  it('signale un catalogue tronqué au lieu de le faire passer pour complet', async () => {
    const { fetchImpl } = clientApi((url) => {
      const chemin = url.pathname;
      if (!chemin.endsWith('/products')) return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
      // Toujours 100 produits, total annoncé énorme : le plafond coupera.
      const items = Array.from({ length: 100 }, (_, i) => ({
        id: String(i + 1), name: multilangue(`Produit ${i + 1}`), price: '10.000000',
      }));
      return { body: enveloppe('products', items), headers: { 'content-range': '0-99/999999' } };
    });

    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.truncated).toBe(true);
    expect(resultat.value.products.length).toBeLessThanOrEqual(5000);
  });

  it('rejette un produit sans nom sans perdre les autres', async () => {
    const { fetchImpl } = clientApi((url) => {
      const chemin = url.pathname;
      if (chemin.endsWith('/products')) {
        return {
          body: enveloppe('products', [
            { id: '1', name: multilangue('Valide'), price: '5.000000' },
            { id: '2', name: multilangue(''), price: '5.000000' },
          ]),
          headers: { 'content-range': '0-1/2' },
        };
      }
      return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
    });
    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products).toHaveLength(1);
    expect(resultat.value.rejected).toHaveLength(1);
    expect(resultat.value.rejected[0].reason).toMatch(/nom/);
  });

  it('n’invente ni prix ni stock quand l’API ne les donne pas', async () => {
    const { fetchImpl } = clientApi((url) => {
      const chemin = url.pathname;
      if (chemin.endsWith('/products')) {
        return {
          body: enveloppe('products', [{ id: '1', name: multilangue('Sans prix'), price: '' }]),
          headers: { 'content-range': '0-0/1' },
        };
      }
      return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
    });
    const resultat = await readPrestashopCatalog(cible, identifiants, { fetchImpl });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.products[0].price).toBeNull();
    // Stock inconnu, jamais zéro : zéro afficherait « rupture » à tort.
    expect(resultat.value.products[0].stock).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Intégration au moteur commun                                               */
/* -------------------------------------------------------------------------- */

describe('PrestaShop dans le moteur commun', () => {
  const cible = { root: new URL('https://boutique.example/'), basePath: '/api' };

  it('produit des produits normalisés avec prix, devise, stock et SKU', async () => {
    const { fetchImpl } = clientApi(catalogueRealiste());
    const lecture = await readPrestashopCatalog(
      cible, { apiKey: 'CLEFAPI1234567890ABCDEF123456' }, { fetchImpl }, { defaultCurrency: 'EUR' },
    );
    expect(lecture.ok).toBe(true);
    if (!lecture.ok) return;

    const { produits, rejets } = normalizeCatalog(
      {
        platform: 'prestashop',
        endpoint: lecture.value.endpoint,
        products: lecture.value.products,
        currency: 'EUR',
      },
      'prestashop',
      'XOF',
    );

    expect(rejets).toHaveLength(0);
    expect(produits).toHaveLength(2);
    const chemise = produits[0];
    // 24,90 EUR = 2490 centimes. Si la conversion était faite deux fois, on
    // lirait 24.
    expect(chemise.priceMinor).toBe(2490);
    expect(chemise.currency).toBe('EUR');
    expect(chemise.sku).toBe('CHE-1');
    expect(chemise.platformId).toBe('10');
    expect(chemise.stock).toBe(4);
    expect(chemise.variants).toHaveLength(2);
    expect(chemise.variants[0]).toMatchObject({
      name: 'M / Bleu',
      sku: 'CHE-1-M',
      stock: 4,
      attributeName: 'Taille',
      priceMinor: 2490,
      available: true,
    });
    expect(chemise.variants[1]).toMatchObject({
      name: 'L / Bleu',
      sku: 'CHE-1-L',
      stock: 0,
      priceMinor: 2690,
      available: false,
    });
  });

  it('garde la devise de la boutique quand elle diffère du défaut', async () => {
    const { fetchImpl } = clientApi((url) => {
      const chemin = url.pathname;
      if (chemin.endsWith('/products')) {
        return {
          body: enveloppe('products', [{ id: '1', name: multilangue('Sable fin'), price: '2500.000000' }]),
          headers: { 'content-range': '0-0/1' },
        };
      }
      return { body: enveloppe(chemin.split('/').pop() ?? '', []) };
    });
    const lecture = await readPrestashopCatalog(
      cible, { apiKey: 'CLEFAPI1234567890ABCDEF123456' }, { fetchImpl }, { defaultCurrency: 'XOF' },
    );
    expect(lecture.ok).toBe(true);
    if (!lecture.ok) return;

    const { produits } = normalizeCatalog(
      { platform: 'prestashop', endpoint: 'https://boutique.example/api', products: lecture.value.products, currency: 'XOF' },
      'prestashop',
      'EUR',
    );
    // 2500 XOF n'a pas de décimales : le prix doit rester 2500, pas 25.
    expect(produits[0].currency).toBe('XOF');
    expect(produits[0].priceMinor).toBe(250000);
    expect(produits[0].variants).toHaveLength(0);
  });
});
