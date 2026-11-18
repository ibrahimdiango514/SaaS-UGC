/**
 * Phase D — lecture paginée et reprise.
 *
 * Les cas testés ici sont ceux qui coûtent cher en production : une API qui
 * ignore la pagination et renvoie la même page indéfiniment, un curseur qui ne
 * bouge pas, une page d'erreur HTML au milieu d'un import, une panne réseau à
 * la troisième page. Aucun ne doit produire une boucle infinie ni perdre les
 * produits déjà lus.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HARD_MAX_PAGES,
  MAX_PRODUCTS,
  runCustomApiImport,
  type ImportFetch,
} from '../src/business/importer/custom-api-import';
import type { CustomApiMapping } from '../src/business/importer/custom-api-mapping';

const mapping: CustomApiMapping = {
  name: { path: 'title' },
  price: { path: 'price' },
  platformId: { path: 'id' },
};

const mapOptions = {
  currency: 'XOF',
  priceUnit: 'major' as const,
  sourceReference: 'api-personnalisee',
};

const BASE = 'https://api.boutique.example';

/** Fabrique un produit brut minimal. */
const produit = (id: number) => ({ id, title: `Produit ${id}`, price: 1000 });

/** `FetchLike` scripté : chaque appel consomme une réponse. */
function fetchScript(reponses: Array<() => Response | Promise<Response>>): { impl: ImportFetch; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const impl: ImportFetch = async (url) => {
    urls.push(url);
    const maker = reponses[Math.min(index, reponses.length - 1)];
    index += 1;
    return maker();
  };
  return { impl, urls };
}

const jsonResponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const options = (over: Partial<Parameters<typeof runCustomApiImport>[2]> = {}) => ({
  mapping,
  pagination: { kind: 'page' as const, path: '/api/products?page={page}&limit={limit}', pageSize: 2, maxPages: 5 },
  mapOptions,
  ...over,
});

describe('pagination par page', () => {
  it('lit toutes les pages et s’arrête sur une page incomplète', async () => {
    const { impl, urls } = fetchScript([
      () => jsonResponse([produit(1), produit(2)]),
      () => jsonResponse([produit(3)]), // page incomplète = dernière
    ]);

    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;

    expect(resultat.products).toHaveLength(3);
    expect(resultat.pages).toBe(2);
    expect(resultat.truncated).toBe(false);
    expect(urls[0]).toBe('https://api.boutique.example/api/products?page=1&limit=2');
    expect(urls[1]).toBe('https://api.boutique.example/api/products?page=2&limit=2');
  });

  it('borne le nombre de pages et le signale', async () => {
    // Une API qui renvoie toujours une page PLEINE de produits NOUVEAUX ne
    // s'arrête jamais d'elle-même : seule la borne l'arrête.
    let compteur = 0;
    const { impl } = fetchScript([() => jsonResponse([produit(compteur += 1), produit(compteur += 1)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'page', path: '/p?page={page}&limit={limit}', pageSize: 2, maxPages: 3 },
    }));

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.pages).toBe(3);
    expect(resultat.truncated).toBe(true);
    // La page 3 vient d'être lue : la reprise doit demander la 4.
    expect(resultat.nextPage).toBe(4);
  });

  it('n’excède jamais le plafond dur, même si la configuration le demande', async () => {
    let compteur = 0;
    const { impl } = fetchScript([() => jsonResponse([produit(compteur += 1), produit(compteur += 1)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'page', path: '/p?page={page}&limit={limit}', pageSize: 2, maxPages: 99999 },
    }));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.pages).toBeLessThanOrEqual(HARD_MAX_PAGES);
  });

  it('s’arrête quand une page ne contient que des produits déjà lus', async () => {
    // Comportement très courant : l'API ignore `?page=` et renvoie tout.
    const { impl, urls } = fetchScript([() => jsonResponse([produit(1), produit(2)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'page', path: '/p?page={page}&limit={limit}', pageSize: 2, maxPages: 20 },
    }));

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // Deux pages identiques suffisent à conclure ; on n'a pas épuisé les 20.
    expect(urls.length).toBeLessThanOrEqual(3);
    expect(resultat.warnings.join(' ')).toMatch(/pagination semble ignorée/i);
    expect(resultat.products).toHaveLength(2);
  });
});

describe('pagination par curseur', () => {
  it('suit le curseur jusqu’à son absence', async () => {
    const { impl, urls } = fetchScript([
      () => jsonResponse({ data: [produit(1)], next_cursor: 'c2' }),
      () => jsonResponse({ data: [produit(2)], next_cursor: null }),
    ]);

    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'cursor', path: '/p?cursor={cursor}&limit={limit}', pageSize: 1, maxPages: 10 },
    }));

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
    // Le curseur de départ est vide : l'API n'en fournit qu'après la 1re page.
    // Au premier appel, le paramètre de curseur est ABSENT (pas vide) :
    // envoyer `cursor=` serait accepté par certaines API et rejeté par d'autres.
    expect(urls[0]).not.toContain('cursor');
    expect(urls[1]).toContain('cursor=c2');
  });

  it('percent-encode un curseur contenant des caractères spéciaux', async () => {
    const { impl, urls } = fetchScript([
      () => jsonResponse({ data: [produit(1)], next_cursor: 'a&b=c' }),
      () => jsonResponse({ data: [], next_cursor: null }),
    ]);
    await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'cursor', path: '/p?cursor={cursor}', pageSize: 1, maxPages: 5 },
    }));
    expect(urls[1]).toContain('cursor=a%26b%3Dc');
    expect(urls[1]!.split('&')).toHaveLength(1);
  });

  it('s’arrête si le curseur ne bouge pas', async () => {
    // Curseur identique ET produits identiques : deux pages suffisent à
    // constater que l'API ne progresse pas.
    const { impl, urls } = fetchScript([
      () => jsonResponse({ data: [produit(1)], next_cursor: 'meme' }),
      () => jsonResponse({ data: [produit(1)], next_cursor: 'meme' }),
      () => jsonResponse({ data: [produit(1)], next_cursor: 'meme' }),
    ]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'cursor', path: '/p?cursor={cursor}', pageSize: 1, maxPages: 50 },
    }));

    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // Sans cette détection, l'import aurait fait 50 requêtes identiques.
    expect(urls.length).toBeLessThanOrEqual(2);
    expect(resultat.products).toHaveLength(1);
    expect(resultat.warnings.join(' ')).toMatch(/pagination/i);
  });
});

describe('pagination désactivée', () => {
  it('ne fait qu’une requête', async () => {
    const { impl, urls } = fetchScript([() => jsonResponse([produit(1), produit(2), produit(3)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'none', path: '/api/products', pageSize: 50, maxPages: 10 },
    }));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(3);
    expect(urls).toHaveLength(1);
  });
});

describe('erreurs', () => {
  it('401 arrête tout et ne rend aucun produit', async () => {
    const { impl } = fetchScript([() => jsonResponse({ detail: 'non autorisé' }, 401)]);
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.stage).toBe('auth');
    expect(resultat.code).toBe('AUTH_INVALID');
    expect(resultat.partial.products).toEqual([]);
  });

  it('403 est distinct de 401', async () => {
    const { impl } = fetchScript([() => jsonResponse({}, 403)]);
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('une page HTML au milieu conserve les produits déjà lus', async () => {
    const { impl } = fetchScript([
      () => jsonResponse([produit(1), produit(2)]),
      () => new Response('<html>Erreur 500</html>', { status: 500, headers: { 'content-type': 'text/html' } }),
    ]);
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    // La reprise s'appuie sur ces produits : les perdre obligerait à tout relire.
    expect(resultat.partial.products).toHaveLength(2);
    expect(resultat.partial.pages).toBe(2);
  });

  it('une panne réseau rend les produits déjà lus', async () => {
    let appel = 0;
    const impl: ImportFetch = async () => {
      appel += 1;
      if (appel === 1) return jsonResponse([produit(1), produit(2)]);
      throw new Error('ECONNRESET');
    };
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.stage).toBe('network');
    expect(resultat.partial.products).toHaveLength(2);
    // Le message ne doit pas reprendre le texte de l'exception (qui peut
    // contenir l'URL complète).
    expect(resultat.message).not.toContain('ECONNRESET');
  });

  it('refuse une réponse sans tableau à la première page', async () => {
    const { impl } = fetchScript([() => jsonResponse({ message: 'bienvenue' })]);
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.stage).toBe('shape');
    expect(resultat.code).toBe('NO_ARRAY');
  });

  it('une page vide plus loin est une fin normale, pas une erreur', async () => {
    const { impl } = fetchScript([
      () => jsonResponse([produit(1), produit(2)]),
      () => jsonResponse({ data: [] }),
    ]);
    const resultat = await runCustomApiImport(BASE, impl, options());
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
  });

  it('refuse une pagination incohérente sans faire de requête', async () => {
    const { impl, urls } = fetchScript([() => jsonResponse([])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'page', path: '/p', pageSize: 2, maxPages: 5 }, // pas de {page}
    }));
    expect(resultat.ok).toBe(false);
    if (resultat.ok) return;
    expect(resultat.code).toBe('PAGINATION_INCOHERENTE');
    expect(urls).toHaveLength(0);
  });
});

describe('reprise', () => {
  it('reprend à la page demandée', async () => {
    const { impl, urls } = fetchScript([() => jsonResponse([produit(5)])]);
    await runCustomApiImport(BASE, impl, options({
      resumeFrom: 3,
      pagination: { kind: 'page', path: '/p?page={page}&limit={limit}', pageSize: 2, maxPages: 5 },
    }));
    expect(urls[0]).toContain('page=3');
  });

  it('reprend avec un curseur', async () => {
    const { impl, urls } = fetchScript([() => jsonResponse({ data: [produit(9)], next_cursor: null })]);
    await runCustomApiImport(BASE, impl, options({
      resumeCursor: 'repr01',
      pagination: { kind: 'cursor', path: '/p?cursor={cursor}', pageSize: 5, maxPages: 5 },
    }));
    expect(urls[0]).toContain('cursor=repr01');
  });

  it('expose l’index global du premier produit', async () => {
    const { impl } = fetchScript([() => jsonResponse([produit(1)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({ resumeFrom: 4 }));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    // C'est ce qui rend la reprise idempotente côté écriture.
    expect(resultat.firstIndex).toBe(3);
  });
});

describe('garanties transverses', () => {
  it('n’émet que des GET', async () => {
    const methodes: string[] = [];
    const impl: ImportFetch = async (_url, init) => {
      methodes.push((init?.method ?? 'GET').toUpperCase());
      return jsonResponse([produit(1)]);
    };
    await runCustomApiImport(BASE, impl, options());
    expect(new Set(methodes)).toEqual(new Set(['GET']));
  });

  it('transmet les en-têtes fournis, sans les interpréter', async () => {
    const vus: Array<Record<string, string>> = [];
    const impl: ImportFetch = async (_url, init) => {
      vus.push(init?.headers as Record<string, string>);
      return jsonResponse([produit(1)]);
    };
    await runCustomApiImport(BASE, impl, options({ headers: { 'x-api-key': 'secret-de-test' } }));
    expect(vus[0]['x-api-key']).toBe('secret-de-test');
    expect(vus[0].accept).toBe('application/json');
  });

  it('appelle onPage avec la progression', async () => {
    const pages: number[] = [];
    const { impl } = fetchScript([
      () => jsonResponse([produit(1), produit(2)]),
      () => jsonResponse([produit(3)]),
    ]);
    await runCustomApiImport(BASE, impl, options({ onPage: (info) => pages.push(info.kept) }));
    expect(pages).toEqual([2, 1]);
  });

  it('compte les rejets avec un motif, sans les perdre', async () => {
    const { impl } = fetchScript([() => jsonResponse([produit(1), { price: 10 }, produit(3)])]);
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'none', path: '/p', pageSize: 10, maxPages: 1 },
    }));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products).toHaveLength(2);
    expect(resultat.rejected).toHaveLength(1);
    expect(resultat.rejected[0].reason).toContain('title');
  });

  it('borne le nombre total de produits', async () => {
    // Une API qui renvoie toujours des produits NOUVEAUX ne s'arrête que par
    // le plafond : sans lui, la mémoire de l'Edge Function serait saturée.
    let compteur = 0;
    const impl: ImportFetch = async () => {
      const page = Array.from({ length: 100 }, () => produit(compteur += 1));
      return jsonResponse(page);
    };
    const resultat = await runCustomApiImport(BASE, impl, options({
      pagination: { kind: 'none', path: '/p', pageSize: 10, maxPages: 1 },
    }));
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.products.length).toBeLessThanOrEqual(MAX_PRODUCTS);
  });

  it('ne journalise jamais un en-tête reçu en cas d’échec', async () => {
    const journal: unknown[] = [];
    const espion = vi.spyOn(console, 'error').mockImplementation((...args) => journal.push(args));
    const impl: ImportFetch = async () => jsonResponse({}, 401);
    await runCustomApiImport(BASE, impl, options({ headers: { authorization: 'Bearer tres-secret' } }));
    espion.mockRestore();
    expect(JSON.stringify(journal)).not.toContain('tres-secret');
  });
});
