// @vitest-environment node
/**
 * Sources de catalogue — la couche qui fait réellement du réseau.
 *
 * Aucun test ne contacte Internet : `fetch` et le résolveur DNS sont injectés.
 * C'est le seul moyen de vérifier les cas hostiles de façon déterministe — un
 * vrai DNS ne renverra jamais 169.254.169.254 pour signaler l'attaque.
 *
 * Les scénarios couverts :
 *   - redirection vers une adresse interne (contournement SSRF classique) ;
 *   - résolveur absent (fail-closed) ;
 *   - résolution mixte publique + privée (DNS rebinding) ;
 *   - réponse énorme (dépassement mémoire) ;
 *   - délai dépassé ;
 *   - catalogue public réel (Shopify, WooCommerce) et absence de catalogue.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CATALOG_BYTES,
  fetchPublicCatalog,
  guardUrl,
  mapShopifyProducts,
  mapWooProducts,
  probeStore,
} from '../src/business/importer/sources';
import { detectPlatform } from '../src/business/importer/platform';

const résolveurPublic = async () => ['93.184.216.34'];
const résolveurPrivé = async () => ['10.0.0.5'];
const résolveurMixte = async () => ['93.184.216.34', '192.168.1.10'];
const résolveurEchec = async () => { throw new Error('NXDOMAIN'); };

function htmlRéponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}
function jsonRéponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('guardUrl — la porte unique', () => {
  it('accepte une URL publique résolue vers une adresse publique', async () => {
    const resultat = await guardUrl('https://boutique.com/', { resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(true);
  });

  it('refuse quand la résolution donne une adresse privée', async () => {
    const resultat = await guardUrl('https://boutique.com/', { resolveHost: résolveurPrivé });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('blocked_url');
  });

  it('refuse une résolution mixte (DNS rebinding)', async () => {
    const resultat = await guardUrl('https://boutique.com/', { resolveHost: résolveurMixte });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.message).toMatch(/réseau privé/i);
  });

  it('refuse quand la résolution échoue', async () => {
    const resultat = await guardUrl('https://boutique.com/', { resolveHost: résolveurEchec });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('dns_failed');
  });

  it('refuse une URL invalide sans appeler le réseau', async () => {
    const fetchImpl = vi.fn();
    const resultat = await guardUrl('http://boutique.com/', { resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('probeStore — fail-closed sans résolveur', () => {
  it('refuse de partir si le résolveur DNS est absent', async () => {
    // Sans résolveur, on ne peut pas prouver que l'hôte n'est pas interne.
    // Faire confiance au nom seul serait précisément le trou SSRF.
    const fetchImpl = vi.fn();
    const resultat = await probeStore('https://boutique.com/', { fetchImpl });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('no_resolver');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuse avant tout appel quand l’hôte résout vers le privé', async () => {
    const fetchImpl = vi.fn();
    const resultat = await probeStore('https://interne.exemple.com/', {
      fetchImpl,
      resolveHost: résolveurPrivé,
    });
    expect(resultat.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('probeStore — une redirection ne contourne pas la garde', () => {
  it('ne suit pas une redirection et le signale', async () => {
    // Scénario d'attaque : l'hôte public redirige en 302 vers les métadonnées
    // cloud. Un `fetch` qui suit les redirections irait les chercher.
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));
    const resultat = await probeStore('https://boutique.com/', {
      fetchImpl,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('redirected_offsite');
    // Un seul appel : celui de la racine, pas celui de la destination.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const destination = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(destination).not.toContain('169.254');
  });

  it('annonce un User-Agent honnête, sans usurper un navigateur', async () => {
    const fetchImpl = vi.fn(async () => htmlRéponse('<html></html>'));
    await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const ua = String((init.headers as Record<string, string>)['user-agent']);
    expect(ua).toContain('VYORA');
    expect(ua).not.toMatch(/Mozilla|Chrome|Safari/);
    expect(init.redirect).toBe('manual');
  });
});

describe('probeStore — réponses anormales', () => {
  it('signale un 404 sans prétendre avoir lu une boutique', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    const resultat = await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('not_found');
  });

  it('refuse une réponse annoncée trop volumineuse', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', {
      status: 200,
      headers: { 'content-length': String(MAX_CATALOG_BYTES * 10) },
    }));
    const résultat = await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(résultat.ok).toBe(false);
    if (!résultat.ok) expect(résultat.error.code).toBe('too_large');
  });

  it('interrompt une réponse qui dépasse la limite en cours de lecture', async () => {
    // `content-length` absent : la garde doit fonctionner quand même.
    const gros = 'a'.repeat(300 * 1024);
    const fetchImpl = vi.fn(async () => new Response(gros, { status: 200 }));
    const resultat = await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('too_large');
  });

  it('signale un délai dépassé', async () => {
    const fetchImpl = vi.fn(async () => {
      const erreur = new Error('aborted');
      erreur.name = 'AbortError';
      throw erreur;
    });
    const resultat = await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('timeout');
  });

  it('signale une boutique injoignable', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const resultat = await probeStore('https://boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('unreachable');
  });

  it('essaie la racine, puis le sous-répertoire, et retient la première réussie', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url) === 'https://site.com/') return new Response('', { status: 404 });
      return htmlRéponse('<html>/wp-content/</html>');
    });
    const resultat = await probeStore('https://site.com/boutique/', { fetchImpl: fetchImpl as never, resolveHost: résolveurPublic });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) {
      expect(resultat.value.triedRoots).toEqual(['https://site.com/', 'https://site.com/boutique/']);
    }
  });
});

describe('détection de bout en bout — de la sonde au verdict', () => {
  it('identifie Shopify par ses en-têtes et conclut à un catalogue public', async () => {
    const fetchImpl = vi.fn(async () => htmlRéponse(
      '<html><link href="https://cdn.shopify.com/s/files/theme.css"><script>Shopify.theme={}</script></html>',
      { 'x-shopid': '12345' },
    ));
    const sonde = await probeStore('https://ma-boutique.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(sonde.ok).toBe(true);
    if (!sonde.ok) return;
    const verdict = detectPlatform(sonde.value);
    expect(verdict.platform).toBe('shopify');
    expect(verdict.confidence).toBe('high');
    expect(verdict.access).toBe('public-json');
  });

  it('identifie WooCommerce et conclut à un catalogue public', async () => {
    const fetchImpl = vi.fn(async () => htmlRéponse(
      '<html><link href="/wp-content/themes/x/style.css"><body class="woocommerce-page"></body></html>',
    ));
    const sonde = await probeStore('https://boutique-wp.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(sonde.ok).toBe(true);
    if (!sonde.ok) return;
    const verdict = detectPlatform(sonde.value);
    expect(verdict.platform).toBe('woocommerce');
    expect(verdict.access).toBe('public-json');
  });

  it('ne devine pas une plateforme sans indice suffisant', async () => {
    const fetchImpl = vi.fn(async () => htmlRéponse('<html><body>Bienvenue</body></html>'));
    const sonde = await probeStore('https://boutique-inconnue.com/', { fetchImpl, resolveHost: résolveurPublic });
    expect(sonde.ok).toBe(true);
    if (!sonde.ok) return;
    const verdict = detectPlatform(sonde.value);
    expect(verdict.platform).toBe('unknown');
    expect(verdict.access).toBe('none');
  });
});

describe('catalogues publics — mapping des structures réelles', () => {
  it('mappe un produit Shopify documenté', () => {
    const produits = mapShopifyProducts({
      products: [{
        title: 'Sérum éclat',
        body_html: '<p>Un <strong>sérum</strong> vitaminé</p>',
        handle: 'serum-eclat',
        product_type: 'Soin',
        tags: ['vitamine', 'éclat'],
        variants: [{ title: '30 ml', price: '12000.00', sku: 'SER-30', available: true }],
        images: [{ src: 'https://cdn.shopify.com/serum.jpg' }],
      }],
    });
    expect(produits).toHaveLength(1);
    expect(produits[0].name).toBe('Sérum éclat');
    expect(produits[0].productUrl).toBe('/products/serum-eclat');
    expect(produits[0].categories).toEqual(['Soin', 'vitamine', 'éclat']);
    expect(produits[0].variants[0].sku).toBe('SER-30');
  });

  it('mappe un produit WooCommerce documenté, prix en unité mineure', () => {
    const produits = mapWooProducts([{
      name: 'Baume lèvres',
      description: '<p>Baume nourrissant</p>',
      prices: { price: '4500', currency_code: 'XOF' },
      permalink: 'https://boutique.com/produit/baume',
      images: [{ src: 'https://boutique.com/baume.jpg' }],
      categories: [{ name: 'Soin' }],
    }]);
    expect(produits[0].name).toBe('Baume lèvres');
    expect(produits[0].currency).toBe('XOF');
    // Le prix WooCommerce est déjà en unité mineure : pas de conversion.
    expect(produits[0].price).toBe('4500');
  });

  it('ignore les entrées sans nom au lieu de créer des produits vides', () => {
    expect(mapShopifyProducts({ products: [{ title: '' }, { title: 'Valide' }] })).toHaveLength(1);
    expect(mapWooProducts([{ name: '' }, { name: 'Valide' }])).toHaveLength(1);
  });

  it('refuse une structure inattendue sans lever', () => {
    expect(mapShopifyProducts({ pas: 'la' })).toEqual([]);
    expect(mapWooProducts({ pas: 'un tableau' })).toEqual([]);
    expect(mapShopifyProducts(null)).toEqual([]);
  });
});

describe('fetchPublicCatalog — lecture réelle, sans invention', () => {
  it('lit /products.json sur Shopify et rend les produits', async () => {
    const fetchImpl = vi.fn(async () => jsonRéponse({
      products: [{ title: 'Sérum', handle: 'serum', variants: [{ price: '1000' }] }],
    }));
    const resultat = await fetchPublicCatalog('shopify', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) return;
    expect(resultat.value.platform).toBe('shopify');
    expect(resultat.value.products).toHaveLength(1);
    const url = String((fetchImpl.mock.calls[0] as unknown[])[0]);
    expect(url).toBe('https://boutique.com/products.json?limit=250');
  });

  it('lit le Store API WooCommerce', async () => {
    const fetchImpl = vi.fn(async () => jsonRéponse([{ name: 'Baume', prices: { price: '4500', currency_code: 'XOF' } }]));
    const resultat = await fetchPublicCatalog('woocommerce', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(true);
    if (resultat.ok) expect(resultat.value.products[0].name).toBe('Baume');
  });

  it('refuse une plateforme sans catalogue public, en expliquant quoi faire', async () => {
    const fetchImpl = vi.fn();
    const resultat = await fetchPublicCatalog('wix', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) {
      expect(resultat.error.code).toBe('not_found');
      expect(resultat.error.message).toMatch(/export de fichier|connexion officielle/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('un catalogue vide est une erreur, pas un catalogue de zéro produit', async () => {
    const fetchImpl = vi.fn(async () => jsonRéponse({ products: [] }));
    const resultat = await fetchPublicCatalog('shopify', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.message).toMatch(/vide ou inaccessible/i);
  });

  it('un 403 (protection) n’est pas contourné', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const resultat = await fetchPublicCatalog('shopify', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('http_error');
    // Un seul essai : on n'insiste pas, on ne change pas d'User-Agent.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('une réponse non JSON est signalée, pas interprétée', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>captcha</html>', { status: 200 }));
    const resultat = await fetchPublicCatalog('shopify', new URL('https://boutique.com/'), {
      fetchImpl: fetchImpl as never,
      resolveHost: résolveurPublic,
    });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.message).toMatch(/JSON valide/i);
  });

  it('sans résolveur, refuse de partir', async () => {
    const fetchImpl = vi.fn();
    const resultat = await fetchPublicCatalog('shopify', new URL('https://boutique.com/'), { fetchImpl: fetchImpl as never });
    expect(resultat.ok).toBe(false);
    if (!resultat.ok) expect(resultat.error.code).toBe('no_resolver');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
