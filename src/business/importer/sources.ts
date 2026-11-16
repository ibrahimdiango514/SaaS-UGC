/**
 * VYORA — sources de catalogue : sonde de boutique et lecture des fichiers
 * publics.
 *
 * ## Ce module est le seul endroit qui fait du réseau
 *
 * Tout le reste de l'importateur est pur et testable hors ligne. Ici, quatre
 * fonctions seulement sortent, et chacune applique la même séquence :
 *
 *   1. **valider l'URL** (`parseStoreUrl` — qui inclut la garde d'hôte) ;
 *   2. **résoudre et contrôler les adresses** (`assertPublicAddresses`) ;
 *   3. **appeler** avec un délai, une taille de réponse bornée, et sans
 *      suivre de redirection vers un autre hôte ;
 *   4. **valider la réponse** avant de la rendre.
 *
 * ## Ce que l'on ne fait pas
 *
 * - Aucun contournement de protection : pas de `User-Agent` usurpant un
 *   navigateur pour franchir un pare-feu applicatif, pas de tentative sur des
 *   chemins d'administration, pas de pagination forcée au-delà de ce que la
 *   plateforme expose publiquement.
 * - Aucun accès aux commandes, aux stocks privés ou aux données clients :
 *   `/products.json` (Shopify) et `/wp-json/wc/store/v1/products` (WooCommerce)
 *   renvoient un catalogue **public**, en lecture seule, et ne contiennent ni
 *   commande ni donnée personnelle.
 * - Aucune requête si l'utilisateur n'a pas fourni d'URL : on ne devine pas.
 *
 * ## Résolution DNS
 *
 * Une Edge Function n'a pas d'accès direct au résolveur. `resolveHost` est donc
 * injectable : en production, l'appelant branche `Deno.resolveDns` ; dans les
 * tests, une fonction déterministe. Sans résolveur fourni, la sonde **refuse**
 * de partir (`no_resolver`) plutôt que de faire confiance au nom seul — c'est
 * le comportement fail-closed.
 */
import { assertPublicAddresses, explainRejection, parseStoreUrl, storeRootCandidates, type UrlRejection } from './url-guard';

/** Délai maximal d'une requête de sonde. */
export const PROBE_TIMEOUT_MS = 12_000;
/** Taille maximale du HTML lu pour la détection (256 Kio). */
export const MAX_HTML_BYTES = 256 * 1024;
/** Taille maximale d'une réponse de catalogue (8 Mio). */
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type ResolveHost = (hostname: string) => Promise<string[]>;

export type SourceErrorCode =
  | 'invalid_url'
  | 'blocked_url'
  | 'no_resolver'
  | 'dns_failed'
  | 'redirected_offsite'
  | 'timeout'
  | 'http_error'
  | 'too_large'
  | 'unreachable'
  | 'not_found';

export interface SourceError {
  code: SourceErrorCode;
  message: string;
  status?: number;
}

export type SourceResult<T> = { ok: true; value: T } | { ok: false; error: SourceError };

export interface SourceDeps {
  /** `fetch` par défaut, injectable pour les tests. */
  fetchImpl?: FetchLike;
  /** Résolveur DNS. Absent = la sonde refuse de partir. */
  resolveHost?: ResolveHost;
  now?: () => Date;
}

/** Erreur de source, avec un message affichable et sans détail interne. */
function sourceError(code: SourceErrorCode, message: string, status?: number): SourceError {
  return status === undefined ? { code, message } : { code, message, status };
}

/** Traduit un refus d'URL en erreur de source. */
function fromUrlRejection(reason: UrlRejection): SourceError {
  return sourceError('blocked_url', explainRejection(reason));
}

/**
 * Valide une URL et vérifie les adresses résolues.
 *
 * Exporté parce que la sonde, la lecture de catalogue et l'aperçu d'image
 * doivent tous passer par la même porte — sans exception.
 */
export async function guardUrl(
  input: string,
  deps: Required<Pick<SourceDeps, 'resolveHost'>>,
): Promise<SourceResult<URL>> {
  const check = parseStoreUrl(input);
  if (!check.ok) return { ok: false, error: fromUrlRejection(check.reason) };

  let adresses: string[];
  try {
    adresses = await deps.resolveHost(check.url.hostname);
  } catch {
    return { ok: false, error: sourceError('dns_failed', 'Le domaine n’a pas pu être résolu.') };
  }
  const controle = assertPublicAddresses(adresses);
  if (!controle.ok) return { ok: false, error: fromUrlRejection(controle.reason) };
  return { ok: true, value: check.url };
}

/**
 * Requête `GET` bornée.
 *
 * - `redirect: 'manual'` : une redirection vers un autre hôte est examinée, pas
 *   suivie aveuglément. C'est le contournement SSRF le plus courant : une URL
 *   publique qui redirige vers `http://169.254.169.254`.
 * - `AbortController` sur un délai fixe.
 * - lecture en flux avec plafond : une réponse de 2 Gio ne remplit pas la
 *   mémoire avant d'être rejetée.
 */
async function boundedGet(
  url: URL,
  deps: SourceDeps & { resolveHost?: ResolveHost },
  maxBytes: number,
  accept: string,
): Promise<SourceResult<{ body: string; contentType: string; finalUrl: string; headers: Record<string, string> }>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        // Un User-Agent honnête : on s'annonce comme VYORA, on ne se fait pas
        // passer pour un navigateur pour franchir une protection.
        'user-agent': 'VYORA-CatalogImporter/1.0 (+https://vyora.app)',
        accept,
        'accept-language': 'fr,en;q=0.8',
      },
    });

    // Redirection : on ne la suit pas. On le signale, l'appelant décide.
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        error: sourceError('redirected_offsite', 'La boutique redirige vers une autre adresse : import interrompu.', response.status),
      };
    }
    if (response.status === 404) {
      return { ok: false, error: sourceError('not_found', 'Ressource introuvable sur cette boutique.', 404) };
    }
    if (!response.ok) {
      return { ok: false, error: sourceError('http_error', `La boutique a répondu ${response.status}.`, response.status) };
    }

    const annonce = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(annonce) && annonce > maxBytes) {
      return { ok: false, error: sourceError('too_large', 'La réponse dépasse la taille autorisée.') };
    }

    // Lecture bornée, même si `content-length` est absent ou menteur.
    const lecteur = response.body?.getReader();
    if (!lecteur) {
      const texte = await response.text();
      if (texte.length > maxBytes) return { ok: false, error: sourceError('too_large', 'Réponse trop volumineuse.') };
      return {
        ok: true,
        value: {
          body: texte,
          contentType: response.headers.get('content-type') ?? '',
          finalUrl: url.toString(),
          headers: Object.fromEntries(response.headers.entries()),
        },
      };
    }

    const morceaux: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await lecteur.cancel();
        return { ok: false, error: sourceError('too_large', 'Réponse trop volumineuse : lecture interrompue.') };
      }
      morceaux.push(value);
    }
    const buffer = new Uint8Array(total);
    let position = 0;
    for (const morceau of morceaux) {
      buffer.set(morceau, position);
      position += morceau.byteLength;
    }

    return {
      ok: true,
      value: {
        body: new TextDecoder('utf-8', { fatal: false }).decode(buffer),
        contentType: response.headers.get('content-type') ?? '',
        finalUrl: url.toString(),
        headers: Object.fromEntries(response.headers.entries()),
      },
    };
  } catch (cause) {
    const abandonne = cause instanceof Error && cause.name === 'AbortError';
    // Un `fetch` de substitution (sortie réseau épinglée de l'Edge Function) peut
    // refuser AVANT la connexion : plafond de taille, blocage SSRF, certificat.
    // Sans cette lecture, ces refus étaient rapportés « injoignable » — un
    // diagnostic faux qui masque la vraie cause.
    const code = (cause as { code?: string } | null)?.code;
    if (!abandonne && code === 'too_large') {
      return { ok: false, error: sourceError('too_large', 'La réponse dépasse la taille autorisée.') };
    }
    if (!abandonne && code === 'blocked_url') {
      return { ok: false, error: sourceError('blocked_url', 'Cette adresse est refusée : elle ne peut pas être contactée.') };
    }
    if (!abandonne && (code === 'tls_failed' || code === 'connect_failed')) {
      return { ok: false, error: sourceError('unreachable', 'La connexion sécurisée avec la boutique a échoué.') };
    }
    return {
      ok: false,
      error: abandonne
        ? sourceError('timeout', 'La boutique n’a pas répondu dans le délai autorisé.')
        : sourceError('unreachable', 'La boutique est injoignable.'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Empreinte d'une page, base de la détection de plateforme. */
export interface StoreProbe {
  finalUrl: string;
  hostname: string;
  httpStatus: number;
  headers: Record<string, string>;
  html: string;
  /** Racines candidates essayées, dans l'ordre. */
  triedRoots: string[];
}

/**
 * Sonde une boutique : une seule requête `GET` sur la racine.
 *
 * Renvoie l'empreinte nécessaire à `detectPlatform`. Ne cherche pas de
 * catalogue ici : détecter la plateforme et lire le catalogue sont deux
 * opérations distinctes, et la seconde n'est lancée que si l'utilisateur la
 * demande.
 */
export async function probeStore(input: string, deps: SourceDeps = {}): Promise<SourceResult<StoreProbe>> {
  if (!deps.resolveHost) {
    return {
      ok: false,
      error: sourceError(
        'no_resolver',
        'La vérification DNS n’est pas disponible : import refusé par sécurité.',
      ),
    };
  }
  const garde = await guardUrl(input, { resolveHost: deps.resolveHost });
  if (!garde.ok) return garde;

  const candidats = storeRootCandidates(garde.value);
  const tried: string[] = [];
  let derniereErreur: SourceError | null = null;

  for (const candidat of candidats) {
    tried.push(candidat.toString());
    // Chaque candidat est revalidé : un sous-répertoire ne change pas l'hôte,
    // mais la règle « valider à chaque saut » évite les raccourcis.
    const check = parseStoreUrl(candidat.toString());
    if (!check.ok) { derniereErreur = fromUrlRejection(check.reason); continue; }

    const reponse = await boundedGet(candidat, deps, MAX_HTML_BYTES, 'text/html,application/xhtml+xml');
    if (!reponse.ok) { derniereErreur = reponse.error; continue; }

    return {
      ok: true,
      value: {
        finalUrl: reponse.value.finalUrl,
        hostname: new URL(reponse.value.finalUrl).hostname,
        httpStatus: 200,
        headers: reponse.value.headers,
        html: reponse.value.body,
        triedRoots: tried,
      },
    };
  }

  return { ok: false, error: derniereErreur ?? sourceError('unreachable', 'Aucune racine de boutique n’a répondu.') };
}

/* ------------------------- lecture des catalogues ------------------------- */

/** Produit brut, tel que le rend une API publique — avant normalisation. */
export interface RawCatalogProduct {
  name: string;
  description: string;
  price: string | number | null;
  currency: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  categories: string[];
  variants: Array<{ name: string; price: string | number | null; sku: string | null; available: boolean | null }>;
}

export interface PublicCatalog {
  platform: 'shopify' | 'woocommerce';
  endpoint: string;
  products: RawCatalogProduct[];
}

/**
 * Extrait un produit Shopify (`/products.json`).
 *
 * La structure est documentée : `{ products: [{ title, body_html, handle,
 * variants:[{price, sku, available}], images:[{src}], product_type, tags }] }`.
 */
export function mapShopifyProducts(payload: unknown): RawCatalogProduct[] {
  const liste = (payload as { products?: unknown })?.products;
  if (!Array.isArray(liste)) return [];
  return liste.map((brut) => {
    const p = brut as Record<string, unknown>;
    const variants = Array.isArray(p.variants) ? p.variants as Array<Record<string, unknown>> : [];
    const images = Array.isArray(p.images) ? p.images as Array<Record<string, unknown>> : [];
    const premier = variants[0];
    const handle = typeof p.handle === 'string' ? p.handle : null;
    return {
      name: typeof p.title === 'string' ? p.title : '',
      description: typeof p.body_html === 'string' ? p.body_html : '',
      price: premier && (typeof premier.price === 'string' || typeof premier.price === 'number') ? premier.price : null,
      currency: null, // absent de /products.json : déduit par l'appelant
      productUrl: handle ? `/products/${handle}` : null,
      imageUrl: images[0] && typeof images[0].src === 'string' ? images[0].src : null,
      categories: [p.product_type, ...(Array.isArray(p.tags) ? p.tags : String(p.tags ?? '').split(','))]
        .filter((v): v is string => typeof v === 'string' && v.trim() !== ''),
      variants: variants.map((v) => ({
        name: typeof v.title === 'string' ? v.title : 'Variante',
        price: typeof v.price === 'string' || typeof v.price === 'number' ? v.price : null,
        sku: typeof v.sku === 'string' && v.sku ? v.sku : null,
        available: typeof v.available === 'boolean' ? v.available : null,
      })),
    };
  }).filter((p) => p.name !== '');
}

/**
 * Extrait un produit WooCommerce Store API.
 *
 * Structure documentée : `{ name, description, prices:{price, currency_code},
 * permalink, images:[{src}], categories:[{name}] }`. Attention : `prices.price`
 * est déjà en **unité mineure** (chaîne), contrairement à Shopify.
 */
export function mapWooProducts(payload: unknown): RawCatalogProduct[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((brut) => {
    const p = brut as Record<string, unknown>;
    const prix = (p.prices ?? {}) as Record<string, unknown>;
    const images = Array.isArray(p.images) ? p.images as Array<Record<string, unknown>> : [];
    const categories = Array.isArray(p.categories) ? p.categories as Array<Record<string, unknown>> : [];
    return {
      name: typeof p.name === 'string' ? p.name : '',
      description: typeof p.description === 'string' ? p.description : typeof p.short_description === 'string' ? p.short_description : '',
      // Marqueur : la valeur est en unité mineure. L'appelant ne convertit pas.
      price: typeof prix.price === 'string' || typeof prix.price === 'number' ? prix.price : null,
      currency: typeof prix.currency_code === 'string' ? prix.currency_code : null,
      productUrl: typeof p.permalink === 'string' ? p.permalink : null,
      imageUrl: images[0] && typeof images[0].src === 'string' ? images[0].src : null,
      categories: categories.map((c) => (typeof c.name === 'string' ? c.name : '')).filter(Boolean),
      variants: [],
    };
  }).filter((p) => p.name !== '');
}

/**
 * Lit le catalogue public d'une boutique déjà identifiée.
 *
 * Ne fonctionne que pour les plateformes qui exposent réellement un catalogue
 * public (`shopify`, `woocommerce`). Pour les autres, on renvoie `not_found`
 * avec un message qui dit pourquoi — jamais une liste vide présentée comme un
 * catalogue vide.
 */
export async function fetchPublicCatalog(
  platform: string,
  rootUrl: URL,
  deps: SourceDeps = {},
): Promise<SourceResult<PublicCatalog>> {
  if (!deps.resolveHost) {
    return { ok: false, error: sourceError('no_resolver', 'La vérification DNS n’est pas disponible.') };
  }

  const endpoints: Array<{ url: URL; accept: string; mapper: (payload: unknown) => RawCatalogProduct[]; nom: 'shopify' | 'woocommerce' }> = [];
  const base = rootUrl.origin + rootUrl.pathname.replace(/\/$/, '');
  if (platform === 'shopify') {
    endpoints.push({
      url: new URL(`${base}/products.json?limit=250`),
      accept: 'application/json',
      mapper: mapShopifyProducts,
      nom: 'shopify',
    });
  } else if (platform === 'woocommerce') {
    endpoints.push({
      url: new URL(`${base}/wp-json/wc/store/v1/products?per_page=100`),
      accept: 'application/json',
      mapper: mapWooProducts,
      nom: 'woocommerce',
    });
  } else {
    return {
      ok: false,
      error: sourceError(
        'not_found',
        'Cette plateforme n’expose pas de catalogue public : utilisez l’export de fichier ou la connexion officielle.',
      ),
    };
  }

  let derniere: SourceError | null = null;
  for (const endpoint of endpoints) {
    const garde = await guardUrl(endpoint.url.toString(), { resolveHost: deps.resolveHost });
    if (!garde.ok) { derniere = garde.error; continue; }

    const reponse = await boundedGet(endpoint.url, deps, MAX_CATALOG_BYTES, endpoint.accept);
    if (!reponse.ok) { derniere = reponse.error; continue; }

    let payload: unknown;
    try {
      payload = JSON.parse(reponse.value.body);
    } catch {
      derniere = sourceError('unreachable', 'La réponse du catalogue n’est pas du JSON valide.');
      continue;
    }

    const produits = endpoint.mapper(payload);
    if (produits.length === 0) {
      derniere = sourceError('not_found', 'Le catalogue public est vide ou inaccessible sans autorisation.');
      continue;
    }
    return {
      ok: true,
      value: { platform: endpoint.nom, endpoint: endpoint.url.toString(), products: produits },
    };
  }

  return { ok: false, error: derniere ?? sourceError('not_found', 'Aucun catalogue public accessible.') };
}
