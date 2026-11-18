/**
 * VYORA — connecteur WooCommerce : client de l'API REST officielle.
 *
 * ## Mécanisme d'authentification retenu
 *
 * WooCommerce propose deux voies :
 *
 *   1. **Clés API REST** (*WooCommerce → Réglages → Avancé → API REST*) —
 *      une paire `Consumer key` / `Consumer secret`, transmise en **Basic**
 *      (`base64(cle:secret)`) sur HTTPS. C'est la voie officielle pour un
 *      serveur, et c'est celle implémentée ici.
 *   2. **Jeton OAuth 1.0a** signé — réservé aux applications tierces
 *      enregistrées sur le site. Il exige un aller-retour de validation et un
 *      secret partagé ; sans cela, impossible de signer correctement.
 *
 * La voie 2 **n'est pas implémentée** et la fiche du catalogue ne la propose
 * pas. Prétendre le contraire produirait une signature invalide à chaque appel.
 *
 * ## « Minimal nécessaire »
 *
 * WooCommerce n'a que trois droits : lecture, écriture, suppression. Il n'y a
 * pas de scope par ressource. On demande donc **Lecture** seule, et le client
 * n'émet que des `GET` : même si le marchand accordait l'écriture, aucune
 * requête d'écriture n'existe dans ce module. C'est la seule garantie possible
 * côté API, et elle est doublée côté sortie réseau (`safe-egress.ts` refuse
 * toute méthode autre que GET).
 *
 * ## Isolation des dépendances
 *
 * Module pur : aucun appel réseau direct. Tout passe par `fetchImpl`, qui en
 * production est `pinnedFetchLike` — le même contrôle SSRF que le reste.
 */
import type { FetchLike } from './sources.ts';

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/** Plafond de produits lus. */
export const MAX_WOO_PRODUCTS = 5_000;
/** Taille de page : maximum documenté par WooCommerce (`per_page` ≤ 100). */
export const WOO_PAGE_SIZE = 100;
/** Nombre maximal de pages. */
export const MAX_WOO_PAGES = Math.ceil(MAX_WOO_PRODUCTS / WOO_PAGE_SIZE);
/** Plafond d'octets d'une page. */
export const MAX_WOO_BYTES = 8 * 1024 * 1024;

/** Préfixe de clé publié par WooCommerce (depuis la version 3.5). */
export const WOO_KEY_PREFIX = 'ck_';

/** Chemin de l'API REST, relatif à la racine du site. */
export const WOO_API_PATH = '/wp-json/wc/v3';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type WooResource = 'products' | 'variations' | 'categories' | 'system_status';

export type WooErrorCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'not_found'
  | 'rest_disabled'
  | 'rate_limited'
  | 'server_error'
  | 'network_failed'
  | 'blocked_url'
  | 'dns_failed'
  | 'not_json'
  | 'unexpected_status';

export interface WooError {
  code: WooErrorCode;
  message: string;
  status?: number;
}

export type WooResult<T> = { ok: true; value: T } | { ok: false; error: WooError };

export interface WooCredentials {
  /** Racine du site, `https://boutique.com` ou avec sous-dossier. */
  siteUrl: string;
  consumerKey: string;
  consumerSecret: string;
}

export interface WooFetchDeps {
  fetchImpl: FetchLike;
  retries?: number;
  retryDelayMs?: number;
  pause?: (ms: number) => Promise<void>;
}

export interface WooProbe {
  storeName: string | null;
  siteUrl: string;
  currency: string | null;
  country: string | null;
  /** Total de produits annoncé par l'en-tête `X-WP-Total`. */
  totalProducts: number | null;
  /** Nombre de pages annoncé par `X-WP-TotalPages`. */
  totalPages: number | null;
  /** Vrai si le catalogue contient des produits variables. */
  hasVariableProducts: boolean;
  resourcesRead: WooResource[];
}

export interface WooCatalog {
  platform: 'woocommerce';
  endpoint: string;
  storeName: string | null;
  siteUrl: string;
  currency: string | null;
  categories: Map<number, string>;
  products: unknown[];
  /** Nombre de variations lues sur les produits variables. */
  variationsRead: number;
  truncated: boolean;
  resourcesRead: WooResource[];
}

/* -------------------------------------------------------------------------- */
/* Validation de l'entrée                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalise l'adresse du site.
 *
 * **HTTPS obligatoire** : les clés API WooCommerce voyagent en Basic (donc en
 * clair dans l'en-tête, protégé par TLS uniquement). Sur HTTP, elles seraient
 * lisibles par tous les intermédiaires. On refuse donc `http://` sans exception
 * — y compris pour un site local, qui n'est de toute façon pas joignable.
 */
export function normalizeWooSite(raw: unknown): WooResult<{ siteUrl: string; origin: string; basePath: string }> {
  const texte = typeof raw === 'string' ? raw.trim() : '';
  if (!texte) {
    return fail('auth_required', 'L’adresse de votre site WooCommerce est requise.');
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(texte) ? texte : `https://${texte}`);
  } catch {
    return fail('auth_required', 'Cette adresse n’est pas valide.');
  }
  if (url.protocol !== 'https:') {
    return fail(
      'auth_required',
      'L’adresse doit commencer par https:// : les clés WooCommerce ne doivent jamais circuler en clair.',
    );
  }
  if (url.username || url.password) {
    return fail('auth_required', 'Ne placez pas d’identifiants dans l’adresse : utilisez les clés API.');
  }

  // Un sous-dossier est courant (`https://exemple.com/boutique/`). On le garde,
  // sans jamais conserver un chemin plus profond que la racine installée.
  const basePath = url.pathname.replace(/\/+$/, '');
  const siteUrl = `${url.origin}${basePath}`;
  return { ok: true, value: { siteUrl, origin: url.origin, basePath } };
}

/** Valide la paire de clés. */
export function validateWooCredentials(
  rawKey: unknown,
  rawSecret: unknown,
): WooResult<{ key: string; secret: string }> {
  const cle = typeof rawKey === 'string' ? rawKey.trim() : '';
  const secret = typeof rawSecret === 'string' ? rawSecret.trim() : '';

  if (!cle || !secret) {
    return fail(
      'auth_required',
      'Les deux clés sont requises : Consumer key ET Consumer secret '
      + '(WooCommerce → Réglages → Avancé → API REST).',
    );
  }
  if (/\s/.test(cle) || /\s/.test(secret)) {
    return fail('auth_required', 'Les clés ne doivent contenir aucun espace ni retour à la ligne.');
  }
  if (!cle.startsWith(WOO_KEY_PREFIX)) {
    return fail(
      'auth_required',
      `Une Consumer key WooCommerce commence par « ${WOO_KEY_PREFIX} ». `
      + 'Vérifiez que vous n’avez pas copié le Consumer secret à sa place.',
    );
  }
  if (cle.length < 20 || secret.length < 20) {
    return fail('auth_required', 'Une des clés semble incomplète : copiez-la en entier.');
  }
  return { ok: true, value: { key: cle, secret } };
}

/* -------------------------------------------------------------------------- */
/* Requêtes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Construit l'en-tête `Authorization` Basic.
 *
 * `btoa` n'existe pas dans tous les contextes d'exécution (Edge Deno, Node) :
 * on encode en UTF-8 soi-même. Les clés WooCommerce sont ASCII, mais un secret
 * recopié peut contenir un caractère inattendu, et `btoa` lèverait alors une
 * exception opaque.
 */
export function basicAuthHeader(cle: string, secret: string): string {
  const brut = `${cle}:${secret}`;
  const octets = new TextEncoder().encode(brut);
  let binaire = '';
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return `Basic ${btoa(binaire)}`;
}

/** URL d'API, sans jamais y placer les clés. */
export function wooApiUrl(siteUrl: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(`${siteUrl.replace(/\/+$/, '')}${WOO_API_PATH}/${path.replace(/^\/+/, '')}`);
  for (const [cle, valeur] of Object.entries(query)) url.searchParams.set(cle, valeur);
  return url.toString();
}

/**
 * Lit les en-têtes de pagination.
 *
 * WooCommerce publie `X-WP-Total` et `X-WP-TotalPages`. Contrairement à Shopify,
 * le total est donc CONNU : on ne parcourt pas « jusqu'à ce que ça s'arrête »,
 * on s'arrête quand le total est couvert. C'est une requête de moins et une
 * garantie de plus.
 */
export function readWooPagination(headers: Headers): { total: number | null; totalPages: number | null } {
  /*
   * `Number(null)` vaut 0 : sans ce garde, une réponse sans `X-WP-Total`
   * annoncerait « 0 produit » et l'interface afficherait une boutique vide au
   * lieu d'un total inconnu. On lit donc la chaîne AVANT de convertir.
   */
  const lire = (nom: string): number | null => {
    const brut = headers.get(nom);
    if (brut === null || brut.trim() === '') return null;
    const nombre = Number(brut);
    return Number.isFinite(nombre) && nombre >= 0 ? nombre : null;
  };
  return { total: lire('x-wp-total'), totalPages: lire('x-wp-totalpages') };
}

/**
 * Exécute une `GET` authentifiée.
 *
 * ## Distinguer les échecs
 * - `401` → clés refusées (révoquées, ou recopiées de travers) ;
 * - `403` → clés valides sans droit de lecture, ou API bloquée par un pare-feu ;
 * - `404` → l'API REST WooCommerce n'est pas là (plugin désactivé, permaliens) ;
 *
 * Un `404` sur `/wp-json/wc/v3/products` est le cas le plus fréquent chez un
 * marchand qui vient d'installer WordPress : les permaliens « simples »
 * désactivent `/wp-json/`. Le message doit le dire, sinon il cherchera du côté
 * des clés.
 */
export async function fetchWooResource(
  credentials: WooCredentials,
  path: string,
  query: Record<string, string>,
  deps: WooFetchDeps,
): Promise<WooResult<{ payload: unknown; status: number; total: number | null; totalPages: number | null }>> {
  const site = normalizeWooSite(credentials.siteUrl);
  if (!site.ok) return site;
  const cles = validateWooCredentials(credentials.consumerKey, credentials.consumerSecret);
  if (!cles.ok) return cles;

  const url = wooApiUrl(site.value.siteUrl, path, query);
  const authorization = basicAuthHeader(cles.value.key, cles.value.secret);
  const retries = Math.max(0, deps.retries ?? 2);
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let derniereErreur: WooError | null = null;

  for (let essai = 0; essai <= retries; essai++) {
    if (essai > 0) await pause(Math.max(0, deps.retryDelayMs ?? 700) * 2 ** (essai - 1));

    let reponse: Response;
    try {
      reponse = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
          // Seul emplacement des clés.
          authorization,
          accept: 'application/json',
        },
      });
    } catch (cause) {
      const statut = (cause as { status?: number })?.status;
      if (typeof statut === 'number' && statut >= 400) {
        const classifie = classifyWooStatus(statut, null);
        if (statut === 429 || statut >= 500) {
          derniereErreur = classifie;
          continue;
        }
        return { ok: false, error: classifie };
      }
      const code = (cause as { code?: string })?.code;
      if (code === 'blocked_url') {
        return fail('blocked_url', 'Cette adresse n’est pas accessible depuis VYORA.');
      }
      if (code === 'dns_failed' || code === 'no_resolver') {
        return fail('dns_failed', 'Le domaine du site n’a pas pu être résolu.');
      }
      derniereErreur = {
        code: 'network_failed',
        message: 'Le site n’a pas répondu. Vérifiez l’adresse et réessayez.',
      };
      continue;
    }

    if (reponse.status === 429 || reponse.status >= 500) {
      derniereErreur = classifyWooStatus(reponse.status, null);
      const attente = Number(reponse.headers.get('retry-after'));
      if (Number.isFinite(attente) && attente > 0 && essai < retries) {
        await pause(Math.min(attente, 10) * 1000);
      }
      continue;
    }

    const texte = await reponse.text();

    if (reponse.status < 200 || reponse.status >= 300) {
      let corps: unknown = null;
      try {
        corps = texte ? JSON.parse(texte) : null;
      } catch {
        corps = null;
      }
      return { ok: false, error: classifyWooStatus(reponse.status, corps) };
    }

    let payload: unknown;
    try {
      payload = texte ? JSON.parse(texte) : null;
    } catch {
      if (/^\s*<(!doctype|html)/i.test(texte)) {
        return fail(
          'not_json',
          'La réponse est une page HTML, pas du JSON : l’adresse ne pointe pas vers l’API REST WooCommerce, '
          + 'ou un pare-feu intercepte la requête.',
        );
      }
      return fail('not_json', 'La réponse de l’API WooCommerce n’est pas du JSON lisible.');
    }

    const pagination = readWooPagination(reponse.headers);
    return {
      ok: true,
      value: {
        payload,
        status: reponse.status,
        total: pagination.total,
        totalPages: pagination.totalPages,
      },
    };
  }

  return {
    ok: false,
    error: derniereErreur ?? {
      code: 'server_error',
      message: 'L’API WooCommerce est indisponible pour le moment.',
    },
  };
}

/** Traduit un statut HTTP en erreur actionnable. */
export function classifyWooStatus(status: number, corps: unknown): WooError {
  if (status === 401) {
    return {
      code: 'auth_invalid',
      status,
      message:
        'Les clés WooCommerce sont refusées. Vérifiez qu’elles n’ont pas été révoquées '
        + '(WooCommerce → Réglages → Avancé → API REST), ou régénérez-en une paire.',
    };
  }
  if (status === 403) {
    return {
      code: 'unexpected_status',
      status,
      message:
        'Le site refuse l’accès à l’API. Vérifiez que les clés ont le droit « Lecture », '
        + 'et qu’un pare-feu ou un module de sécurité n’bloque pas /wp-json/.',
    };
  }
  if (status === 404) {
    // Le corps est lu pour distinguer « API absente » de « produit absent ».
    const code = (corps as { code?: unknown })?.code;
    if (code === 'woocommerce_rest_product_invalid_id') {
      return { code: 'not_found', status, message: 'Ce produit n’existe plus sur le site.' };
    }
    return {
      code: 'rest_disabled',
      status,
      message:
        'L’API REST WooCommerce n’est pas accessible à cette adresse. Deux causes fréquentes : '
        + 'les permaliens sont en mode « Simple » (Réglages → Permaliens → choisissez « Titre de la '
        + 'publication »), ou WooCommerce n’est pas actif sur ce site.',
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      status,
      message: 'Le site limite temporairement les requêtes. Réessayez dans quelques secondes.',
    };
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      status,
      message: 'Le site a renvoyé une erreur. Réessayez dans un instant.',
    };
  }
  return {
    code: 'unexpected_status',
    status,
    message: `L’API WooCommerce a répondu de façon inattendue (${status}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Sonde et lecture                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Vérifie la connexion en lisant réellement le catalogue.
 *
 * Un `200` sur `/system_status` prouve que les clés existent, mais pas qu'elles
 * lisent les produits — et ce point d'accès est souvent refusé aux clés
 * « Lecture ». On sonde donc directement `products?per_page=1`, qui est
 * exactement ce dont l'import a besoin. Les en-têtes `X-WP-Total` donnent au
 * passage le volume réel.
 */
export async function probeWooCommerce(
  credentials: WooCredentials,
  deps: WooFetchDeps,
): Promise<WooResult<WooProbe>> {
  const site = normalizeWooSite(credentials.siteUrl);
  if (!site.ok) return site;
  const cles = validateWooCredentials(credentials.consumerKey, credentials.consumerSecret);
  if (!cles.ok) return cles;

  const net: WooCredentials = {
    siteUrl: site.value.siteUrl,
    consumerKey: cles.value.key,
    consumerSecret: cles.value.secret,
  };
  const resourcesRead: WooResource[] = [];

  const produits = await fetchWooResource(
    net,
    'products',
    { per_page: '1', status: 'publish' },
    deps,
  );
  if (!produits.ok) return produits;
  resourcesRead.push('products');

  /*
   * La devise et le nom de boutique ne sont pas publiés par l'API REST v3
   * (`/system_status`, qui les contient, est refusé aux clés « Lecture » sur
   * bien des installations). On ne les invente pas : ils restent `null`, et la
   * normalisation retombera sur la devise par défaut de l'import, en le
   * signalant.
   */

  // Le catalogue contient-il des produits variables ? Cela décide si l'import
  // devra lire les variations (une requête par produit variable).
  const variables = await fetchWooResource(
    net,
    'products',
    { per_page: '1', type: 'variable', status: 'publish' },
    deps,
  );
  const hasVariableProducts = variables.ok
    && Array.isArray(variables.value.payload)
    && variables.value.payload.length > 0;

  return {
    ok: true,
    value: {
      storeName: null,
      siteUrl: site.value.siteUrl,
      currency: null,
      country: null,
      totalProducts: produits.value.total,
      totalPages: produits.value.totalPages,
      hasVariableProducts,
      resourcesRead,
    },
  };
}

/**
 * Lit le catalogue complet : catégories, produits, variations.
 *
 * L'ordre est imposé par les dépendances : les catégories nomment les produits,
 * et les variations n'existent que pour les produits variables.
 */
export async function readWooCatalog(
  credentials: WooCredentials,
  deps: WooFetchDeps,
): Promise<WooResult<WooCatalog>> {
  const site = normalizeWooSite(credentials.siteUrl);
  if (!site.ok) return site;
  const cles = validateWooCredentials(credentials.consumerKey, credentials.consumerSecret);
  if (!cles.ok) return cles;

  const net: WooCredentials = {
    siteUrl: site.value.siteUrl,
    consumerKey: cles.value.key,
    consumerSecret: cles.value.secret,
  };
  const resourcesRead: WooResource[] = [];

  // 1) Catégories : une seule page suffit pour les 100 premières, et un
  //    catalogue qui en aurait plus reste lisible (les produits portent l'id).
  const categories = new Map<number, string>();
  const categoriesReponse = await fetchWooResource(net, 'products/categories', { per_page: '100' }, deps);
  if (categoriesReponse.ok && Array.isArray(categoriesReponse.value.payload)) {
    resourcesRead.push('categories');
    for (const brut of categoriesReponse.value.payload) {
      const categorie = brut as Record<string, unknown>;
      const id = Number(categorie.id);
      const nom = typeof categorie.name === 'string' ? categorie.name.trim() : '';
      if (Number.isFinite(id) && nom) categories.set(id, nom);
    }
  }

  // 2) Produits, page par page, jusqu'au total annoncé.
  const produits: unknown[] = [];
  let truncated = false;
  let totalConnu: number | null = null;

  for (let page = 1; page <= MAX_WOO_PAGES; page++) {
    const reponse = await fetchWooResource(
      net,
      'products',
      { per_page: String(WOO_PAGE_SIZE), page: String(page), status: 'publish' },
      deps,
    );
    if (!reponse.ok) {
      /*
       * Une page qui échoue en cours de route n'est PAS un catalogue vide :
       * on échoue explicitement plutôt que de rendre 40 produits sur 300.
       */
      return reponse;
    }
    if (page === 1) resourcesRead.push('products');
    totalConnu = reponse.value.total ?? totalConnu;

    const liste = Array.isArray(reponse.value.payload) ? reponse.value.payload : [];
    if (liste.length === 0) break;
    produits.push(...liste);

    if (produits.length >= MAX_WOO_PRODUCTS) {
      truncated = true;
      break;
    }
    // Total connu et déjà couvert : inutile d'appeler une page de plus.
    if (totalConnu !== null && produits.length >= totalConnu) break;
    // Dernière page atteinte d'après le site.
    if (reponse.value.totalPages !== null && page >= reponse.value.totalPages) break;
    // Page incomplète : il n'y en a pas d'autre.
    if (liste.length < WOO_PAGE_SIZE) break;
  }

  // 3) Variations des produits variables.
  //
  // Un produit variable sans ses variations serait importé comme une fiche à
  // prix unique — c'est-à-dire au mauvais prix. On lit donc les variations,
  // avec un plafond global pour ne pas exploser le temps d'exécution.
  let variationsRead = 0;
  for (const brut of produits) {
    const produit = brut as Record<string, unknown>;
    if (produit.type !== 'variable') continue;
    const id = Number(produit.id);
    if (!Number.isFinite(id)) continue;

    const variations = await fetchWooResource(
      net,
      `products/${id}/variations`,
      { per_page: '100' },
      deps,
    );
    if (!variations.ok) {
      // Une variation illisible ne bloque pas tout le catalogue : le produit
      // sera importé avec les variations lisibles, et l'avertissement le dira.
      continue;
    }
    if (Array.isArray(variations.value.payload)) {
      produit.__variations = variations.value.payload;
      variationsRead += variations.value.payload.length;
      if (resourcesRead.includes('variations') === false) resourcesRead.push('variations');
    }
    if (variationsRead >= MAX_WOO_PRODUCTS) break;
  }

  return {
    ok: true,
    value: {
      platform: 'woocommerce',
      endpoint: wooApiUrl(site.value.siteUrl, 'products'),
      storeName: null,
      siteUrl: site.value.siteUrl,
      currency: null,
      categories,
      products: produits,
      variationsRead,
      truncated,
      resourcesRead,
    },
  };
}

function fail(code: WooErrorCode, message: string): { ok: false; error: WooError } {
  return { ok: false, error: { code, message } };
}
