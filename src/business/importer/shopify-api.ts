/**
 * VYORA — connecteur Shopify : client de l'API Admin officielle.
 *
 * ## Quel mécanisme d'authentification, et pourquoi
 *
 * Shopify propose deux voies pour lire le catalogue d'une boutique :
 *
 *   1. **OAuth d'application publique** — l'utilisateur installe une application
 *      enregistrée chez Shopify. Elle exige un identifiant et un secret
 *      d'application appartenant à VYORA (`SHOPIFY_API_SECRET`), une URL de
 *      redirection déclarée, et une revue d'application. **Ce n'est pas ce qui
 *      est implémenté ici**, et le prétendre serait faux : le secret
 *      d'application n'existe pas dans ce dépôt, donc le parcours échouerait à
 *      la première étape.
 *
 *   2. **Jeton d'API Admin d'une application personnalisée** — le marchand crée
 *      une application dans *son* administration (Paramètres → Applications →
 *      Développer des applications), lui donne les droits `read_products`, et
 *      copie le jeton `shpat_…`. Aucune infrastructure OAuth n'est requise, et
 *      le jeton appartient au marchand : il le révoque quand il veut.
 *
 * C'est la voie 2 qui est implémentée. Elle est officielle, documentée par
 * Shopify, et c'est la seule qui puisse fonctionner sans secret d'application
 * côté VYORA. La fiche du catalogue porte le libellé exact.
 *
 * ## Ce que ce module ne fait jamais
 *
 * - **Aucune écriture.** Uniquement des `GET`. Les scopes demandés sont
 *   `read_products` et éventuellement `read_inventory` ; `write_*` n'est jamais
 *   utilisé, et `safe-egress.ts` refuse toute autre méthode de toute façon.
 * - **Aucune commande client.** L'API Orders n'est pas appelée : elle
 *   contiendrait des données personnelles d'acheteurs, hors du périmètre.
 * - **Aucune invention.** Pas de SKU, pas de stock, pas de variante qui ne soit
 *   pas dans la réponse.
 * - **Aucun jeton en URL, en log ou en message d'erreur.** Il ne vit que dans
 *   l'en-tête `X-Shopify-Access-Token` d'une requête sortante.
 *
 * ## Isolation des dépendances
 *
 * Module pur : aucun appel réseau direct, aucune lecture d'environnement. Tout
 * passe par `fetchImpl`, qui en production est `pinnedFetchLike` — donc le même
 * contrôle SSRF que le reste de l'import.
 */
import type { FetchLike } from './sources.ts';

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/** Version d'API épinglée. Une version mouvante casserait un jour sans prévenir. */
export const SHOPIFY_API_VERSION = '2024-10';

/** Plafond de produits lus, pour borner temps et mémoire. */
export const MAX_SHOPIFY_PRODUCTS = 5_000;
/** Taille de page : maximum documenté pour `/products.json`. */
export const SHOPIFY_PAGE_SIZE = 250;
/** Nombre maximal de pages, dérivé du plafond. */
export const MAX_SHOPIFY_PAGES = Math.ceil(MAX_SHOPIFY_PRODUCTS / SHOPIFY_PAGE_SIZE);
/** Plafond d'octets d'une page (250 produits avec descriptions restent < 8 Mio). */
export const MAX_SHOPIFY_BYTES = 8 * 1024 * 1024;

/** Préfixe d'un jeton d'application personnalisée. */
export const SHOPIFY_TOKEN_PREFIX = 'shpat_';
/** Suffixe d'un domaine d'administration. */
export const SHOPIFY_MYSHOPIFY_SUFFIX = '.myshopify.com';

/**
 * Scopes exigés par la lecture du catalogue.
 *
 * `read_products` couvre produits, variantes, images et collections.
 * `read_inventory` n'est PAS exigé : le stock est déjà publié par
 * `/products.json` (`variant.inventory_quantity`). L'exiger obligerait le
 * marchand à cocher une case de plus pour une donnée qu'il a déjà accordée —
 * et un scope manquant ferait échouer une connexion qui fonctionne.
 */
export const SHOPIFY_REQUIRED_SCOPES = ['read_products'] as const;

/** Scope facultatif, jamais exigé. */
export const SHOPIFY_OPTIONAL_SCOPES = ['read_inventory'] as const;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Ressources lues, pour le compte rendu de connexion. */
export type ShopifyResource = 'shop' | 'products' | 'scopes';

/** Codes d'erreur, tous affichables. */
export type ShopifyErrorCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'insufficient_scope'
  | 'shop_mismatch'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'network_failed'
  | 'blocked_url'
  | 'dns_failed'
  | 'not_json'
  | 'unexpected_status';

export interface ShopifyError {
  code: ShopifyErrorCode;
  message: string;
  /** Scopes réellement accordés mais manquants, quand ils sont connus. */
  missingScopes?: string[];
  /** Scopes accordés à la clé, quand Shopify les publie. */
  grantedScopes?: string[];
  status?: number;
}

export type ShopifyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ShopifyError };

export interface ShopifyCredentials {
  /** Domaine `xxx.myshopify.com` (jamais une URL de vitrine). */
  shopDomain: string;
  /** Jeton d'application personnalisée `shpat_…`. */
  accessToken: string;
}

export interface ShopifyFetchDeps {
  /** `fetch` de la sortie épinglée. Jamais `fetch` brut. */
  fetchImpl: FetchLike;
  retries?: number;
  retryDelayMs?: number;
  pause?: (ms: number) => Promise<void>;
}

export interface ShopifyProbe {
  shopName: string | null;
  domain: string;
  currency: string | null;
  /** Pays de la boutique, quand il est publié. */
  countryCode: string | null;
  totalProducts: number | null;
  hasMorePages: boolean;
  grantedScopes: string[];
  resourcesRead: ShopifyResource[];
  /** Vrai si le scope d'inventaire est présent (information, jamais exigence). */
  inventoryScope: boolean;
}

export interface ShopifyCatalog {
  platform: 'shopify';
  endpoint: string;
  shopName: string | null;
  domain: string;
  currency: string | null;
  /** Produits bruts, au format Admin API, prêts pour le mappeur commun. */
  products: unknown[];
  /** Variantes publiées dans la réponse, pour vérifier qu'on ne les perd pas. */
  variantsSeen: number;
  /** `draft` et `archived` écartés, comptés pour pouvoir le dire. */
  unpublishedSkipped: number;
  truncated: boolean;
  resourcesRead: ShopifyResource[];
}

/* -------------------------------------------------------------------------- */
/* Validation de l'entrée                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Normalise le domaine saisi par le marchand.
 *
 * Accepte ce que les gens tapent réellement : `boutique.myshopify.com`,
 * `https://boutique.myshopify.com/admin`, ou même l'adresse de la vitrine
 * `https://boutique.com`. Dans ce dernier cas, **on ne devine pas** le domaine
 * `.myshopify.com` : il faudrait une requête réseau pour le découvrir, et se
 * tromper enverrait le jeton à la mauvaise boutique. On refuse avec un message
 * qui dit où trouver le bon domaine.
 */
export function normalizeShopDomain(
  raw: unknown,
): ShopifyResult<{ domain: string; host: string }> {
  const texte = typeof raw === 'string' ? raw.trim() : '';
  if (!texte) {
    return fail('auth_required', 'Le domaine de la boutique est requis (ex. ma-boutique.myshopify.com).');
  }

  let host: string;
  try {
    // Sans schéma, `URL` échoue : on en ajoute un pour l'analyse.
    const url = new URL(/^https?:\/\//i.test(texte) ? texte : `https://${texte}`);
    host = url.hostname.toLowerCase();
  } catch {
    return fail('auth_required', 'Ce domaine n’est pas une adresse valide.');
  }

  if (!host.endsWith(SHOPIFY_MYSHOPIFY_SUFFIX)) {
    return fail(
      'shop_mismatch',
      `« ${host} » n’est pas un domaine d’administration Shopify. Utilisez le domaine `
      + `« …${SHOPIFY_MYSHOPIFY_SUFFIX} » affiché dans Shopify → Paramètres → Domaines `
      + '(et non l’adresse de votre vitrine).',
    );
  }

  // `xxx.myshopify.com` : un seul label avant le suffixe, non vide.
  const label = host.slice(0, -SHOPIFY_MYSHOPIFY_SUFFIX.length);
  if (!label || label.includes('.') || !/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    return fail('shop_mismatch', 'Le domaine d’administration Shopify est mal formé.');
  }

  return { ok: true, value: { domain: host, host } };
}

/** Valide un jeton d'application personnalisée. */
export function validateShopifyToken(raw: unknown): ShopifyResult<string> {
  const jeton = typeof raw === 'string' ? raw.trim() : '';
  if (!jeton) {
    return fail('auth_required', 'Le jeton d’API Admin est requis.');
  }
  if (/\s/.test(jeton)) {
    // Espace ou saut de ligne : copie incomplète, ou tentative d'injection
    // d'en-tête. Dans les deux cas, il ne part pas.
    return fail('auth_required', 'Le jeton ne doit contenir aucun espace ni retour à la ligne.');
  }
  if (!jeton.startsWith(SHOPIFY_TOKEN_PREFIX)) {
    return fail(
      'auth_required',
      `Un jeton d’application personnalisée Shopify commence par « ${SHOPIFY_TOKEN_PREFIX} ». `
      + 'Si vous utilisez un autre type de jeton, créez une application personnalisée dans '
      + 'Shopify → Paramètres → Applications.',
    );
  }
  if (jeton.length < 20) {
    return fail('auth_required', 'Ce jeton semble incomplet : copiez-le en entier.');
  }
  return { ok: true, value: jeton };
}

/* -------------------------------------------------------------------------- */
/* Requêtes                                                                    */
/* -------------------------------------------------------------------------- */

/** Construit une URL d'API Admin, sans jamais y placer le jeton. */
export function shopifyAdminUrl(domain: string, path: string, query: Record<string, string> = {}): string {
  const url = new URL(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/${path.replace(/^\/+/, '')}`);
  for (const [cle, valeur] of Object.entries(query)) {
    url.searchParams.set(cle, valeur);
  }
  return url.toString();
}

/**
 * Lit les scopes réellement accordés au jeton.
 *
 * Shopify les publie dans l'en-tête `X-Shopify-Access-Scopes` de toute réponse
 * authentifiée. C'est la seule source fiable : le marchand peut avoir coché
 * `read_products` puis l'avoir décoché, et le jeton reste valide. Sans cette
 * lecture, une clé sans droit catalogue serait déclarée « connectée ».
 */
export function readGrantedScopes(headerValue: string | null): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Scopes exigés qui manquent réellement. */
export function missingRequiredScopes(granted: string[]): string[] {
  const presents = new Set(granted);
  return SHOPIFY_REQUIRED_SCOPES.filter((scope) => !presents.has(scope));
}

/**
 * Exécute une `GET` authentifiée sur l'API Admin.
 *
 * ## Gestion des erreurs
 * Les codes Shopify ont chacun une cause distincte et une correction distincte :
 * - `401` → jeton invalide ou révoqué ;
 * - `403` → jeton valide, scope manquant (Shopify le dit dans le corps) ;
 * - `404` → boutique inexistante ou application désinstallée ;
 * - `423` → boutique verrouillée (impayée, en configuration) ;
 * - `429` → limite de débit, réessayée avec le délai demandé.
 *
 * Les confondre enverrait le marchand corriger le mauvais problème.
 */
export async function fetchShopifyResource(
  credentials: ShopifyCredentials,
  path: string,
  query: Record<string, string>,
  deps: ShopifyFetchDeps,
): Promise<ShopifyResult<{
  payload: unknown;
  status: number;
  grantedScopes: string[];
  hasMore: boolean;
  /** Curseur `page_info` extrait de l'en-tête `Link`, ou `null`. */
  nextCursor: string | null;
}>> {
  const url = shopifyAdminUrl(credentials.shopDomain, path, query);
  const retries = Math.max(0, deps.retries ?? 2);
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let derniereErreur: ShopifyError | null = null;

  for (let essai = 0; essai <= retries; essai++) {
    if (essai > 0) await pause(Math.max(0, deps.retryDelayMs ?? 700) * 2 ** (essai - 1));

    let reponse: Response;
    try {
      reponse = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
          // Seul emplacement du jeton.
          'x-shopify-access-token': credentials.accessToken,
          accept: 'application/json',
        },
      });
    } catch (cause) {
      // La sortie épinglée lève une erreur portant parfois un statut HTTP : un
      // 401 reçu ainsi décrit une RÉPONSE et doit être classifié comme telle.
      const statut = (cause as { status?: number })?.status;
      if (typeof statut === 'number' && statut >= 400) {
        const classifie = classifyShopifyStatus(statut, null);
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
        return fail('dns_failed', 'Le domaine de la boutique n’a pas pu être résolu.');
      }
      derniereErreur = {
        code: 'network_failed',
        message: 'La boutique n’a pas répondu. Vérifiez le domaine et réessayez.',
      };
      continue;
    }

    const scopes = readGrantedScopes(reponse.headers.get('x-shopify-access-scopes'));

    if (reponse.status === 429 || reponse.status >= 500) {
      derniereErreur = classifyShopifyStatus(reponse.status, null, scopes);
      // `Retry-After` est en secondes chez Shopify : le respecter évite
      // d'aggraver la limite.
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
      return { ok: false, error: classifyShopifyStatus(reponse.status, corps, scopes) };
    }

    let payload: unknown;
    try {
      payload = texte ? JSON.parse(texte) : null;
    } catch {
      // Une réponse HTML à l'API signifie portail captif ou proxy, jamais
      // Shopify : le dire vaut mieux qu'un « JSON invalide ».
      if (/^\s*<(!doctype|html)/i.test(texte)) {
        return fail('not_json', 'La réponse n’est pas du JSON : un portail ou un proxy intercepte les requêtes.');
      }
      return fail('not_json', 'La réponse de l’API Shopify n’est pas du JSON lisible.');
    }

    // Pagination par curseur : en-tête `Link` avec `rel="next"`. Le curseur est
    // lu ICI, au même endroit que la réponse qui le publie — le recalculer
    // ailleurs depuis l'URL courante produirait un `page_info` faux.
    const lien = reponse.headers.get('link') ?? '';
    const nextCursor = extrairePageInfo(lien);
    const hasMore = nextCursor !== null || /rel="next"/.test(lien);

    return {
      ok: true,
      value: { payload, status: reponse.status, grantedScopes: scopes, hasMore, nextCursor },
    };
  }

  return {
    ok: false,
    error: derniereErreur ?? {
      code: 'server_error',
      message: 'L’API Shopify est indisponible pour le moment.',
    },
  };
}

/** Traduit un statut HTTP en erreur actionnable. */
export function classifyShopifyStatus(
  status: number,
  corps: unknown,
  grantedScopes: string[] = [],
): ShopifyError {
  if (status === 401) {
    return {
      code: 'auth_invalid',
      status,
      message:
        'Le jeton Shopify est refusé. Il a peut-être été révoqué, ou l’application a été désinstallée. '
        + 'Créez un nouveau jeton dans Shopify → Paramètres → Applications, puis reconnectez la boutique.',
    };
  }
  if (status === 403) {
    const manquants = missingRequiredScopes(grantedScopes);
    return {
      code: 'insufficient_scope',
      status,
      grantedScopes,
      missingScopes: manquants.length > 0 ? manquants : [...SHOPIFY_REQUIRED_SCOPES],
      message:
        'Le jeton n’a pas le droit de lire le catalogue. Dans Shopify → Paramètres → Applications, '
        + 'ouvrez votre application et cochez « read_products » (lecture des produits).',
    };
  }
  if (status === 404) {
    return {
      code: 'not_found',
      status,
      message:
        'Cette boutique n’a pas été trouvée. Vérifiez le domaine « …myshopify.com », '
        + 'et que l’application n’a pas été supprimée.',
    };
  }
  if (status === 423) {
    return {
      code: 'unexpected_status',
      status,
      message:
        'La boutique Shopify est verrouillée (abonnement Shopify en attente, ou boutique en cours de configuration). '
        + 'Régularisez côté Shopify, puis réessayez.',
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      status,
      message: 'Shopify limite temporairement les requêtes. Réessayez dans quelques secondes.',
    };
  }
  if (status >= 500) {
    return {
      code: 'server_error',
      status,
      message: 'Shopify a renvoyé une erreur. Réessayez dans un instant.',
    };
  }
  // Le corps est volontairement ignoré dans le message : il peut contenir des
  // données de la boutique. Seul le statut est repris.
  void corps;
  return {
    code: 'unexpected_status',
    status,
    message: `L’API Shopify a répondu de façon inattendue (${status}).`,
  };
}

/* -------------------------------------------------------------------------- */
/* Sonde et lecture                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Vérifie la connexion en lisant réellement la boutique ET le catalogue.
 *
 * ## Pourquoi deux appels
 * `GET /shop.json` prouve que le jeton existe. Il ne prouve **pas** que
 * `read_products` est accordé. Une clé sans ce scope serait déclarée
 * « connectée », puis l'aperçu échouerait en 403 — le marchand aurait connecté
 * une boutique pour rien.
 *
 * On lit donc la boutique (nom, devise, pays → identification) ET la première
 * page de produits (preuve du scope catalogue). Les deux sont des `GET`.
 */
export async function probeShopify(
  credentials: ShopifyCredentials,
  deps: ShopifyFetchDeps,
): Promise<ShopifyResult<ShopifyProbe>> {
  const domaine = normalizeShopDomain(credentials.shopDomain);
  if (!domaine.ok) return domaine;
  const jeton = validateShopifyToken(credentials.accessToken);
  if (!jeton.ok) return jeton;

  const net = { shopDomain: domaine.value.domain, accessToken: jeton.value };
  const resourcesRead: ShopifyResource[] = [];

  const boutique = await fetchShopifyResource(net, 'shop.json', {}, deps);
  if (!boutique.ok) return boutique;
  resourcesRead.push('shop');
  const shop = (boutique.value.payload as { shop?: Record<string, unknown> })?.shop ?? {};
  const grantedScopes = boutique.value.grantedScopes;
  if (grantedScopes.length > 0) resourcesRead.push('scopes');

  // Contrôle des scopes AVANT la lecture des produits : si `read_products`
  // manque, on le dit maintenant, avec le scope exact.
  const manquants = missingRequiredScopes(grantedScopes);
  if (grantedScopes.length > 0 && manquants.length > 0) {
    return {
      ok: false,
      error: {
        code: 'insufficient_scope',
        grantedScopes,
        missingScopes: manquants,
        message:
          `Votre jeton Shopify n’a pas la permission ${manquants.join(' et ')}. `
          + 'Ouvrez Shopify → Paramètres → Applications → Développer des applications, '
          + 'puis vos droits d’administration, et cochez « read_products ».',
      },
    };
  }

  // Première page : preuve réelle du droit catalogue, et volume.
  const produits = await fetchShopifyResource(net, 'products.json', { limit: '1' }, deps);
  if (!produits.ok) return produits;
  resourcesRead.push('products');

  // Shopify ne publie pas de total : on ne l'invente pas. `null` signifie
  // « inconnu », ce que l'interface affiche tel quel.
  const liste = (produits.value.payload as { products?: unknown })?.products;
  const premierePage = Array.isArray(liste) ? liste.length : 0;

  return {
    ok: true,
    value: {
      shopName: typeof shop.name === 'string' ? shop.name : null,
      domain: domaine.value.domain,
      currency: typeof shop.currency === 'string' ? shop.currency : null,
      countryCode: typeof shop.country_code === 'string' ? shop.country_code : null,
      totalProducts: null,
      hasMorePages: premierePage > 0 && produits.value.hasMore,
      grantedScopes,
      resourcesRead,
      inventoryScope: grantedScopes.includes('read_inventory'),
    },
  };
}

/**
 * Parcourt le catalogue publié.
 *
 * ## Invariants
 * - **Pagination par curseur** via l'en-tête `Link` (`page_info`). Un calcul
 *   `?page=N` se désynchronise dès qu'un produit est ajouté pendant la lecture.
 * - **Curseur immobile = arrêt.** Une API qui renverrait toujours le même lien
 *   ferait sinon tourner indéfiniment.
 * - **Plafonds durs** (`MAX_SHOPIFY_PRODUCTS`, `MAX_SHOPIFY_PAGES`) : temps et
 *   mémoire bornés, et `truncated` le dit.
 * - **Les brouillons sont écartés et comptés.** `/products.json` renvoie aussi
 *   `draft` et `archived` ; importer l'un d'eux publierait dans VYORA une fiche
 *   que le marchand n'a pas mise en vente.
 * - **Aucune écriture.**
 */
export async function readShopifyCatalog(
  credentials: ShopifyCredentials,
  deps: ShopifyFetchDeps,
): Promise<ShopifyResult<ShopifyCatalog>> {
  const domaine = normalizeShopDomain(credentials.shopDomain);
  if (!domaine.ok) return domaine;
  const jeton = validateShopifyToken(credentials.accessToken);
  if (!jeton.ok) return jeton;

  const net = { shopDomain: domaine.value.domain, accessToken: jeton.value };
  const resourcesRead: ShopifyResource[] = [];

  const boutique = await fetchShopifyResource(net, 'shop.json', {}, deps);
  if (!boutique.ok) return boutique;
  resourcesRead.push('shop');
  const shop = (boutique.value.payload as { shop?: Record<string, unknown> })?.shop ?? {};

  const produits: unknown[] = [];
  let variantsSeen = 0;
  let unpublishedSkipped = 0;
  let truncated = false;
  let curseur: string | null = null;
  let dernierCurseur: string | null = null;

  for (let page = 0; page < MAX_SHOPIFY_PAGES; page++) {
    const query: Record<string, string> = { limit: String(SHOPIFY_PAGE_SIZE) };
    if (curseur) query.page_info = curseur;

    const reponse = await fetchShopifyResource(net, 'products.json', query, deps);
    if (!reponse.ok) {
      /*
       * Une page qui échoue en cours de route n'est PAS un catalogue vide.
       * On préfère l'échec explicite : le marchand relance, plutôt que
       * d'importer 40 produits sur 300 en croyant avoir tout pris.
       */
      return reponse;
    }
    if (page === 0) resourcesRead.push('products');

    const liste = (reponse.value.payload as { products?: unknown })?.products;
    const items = Array.isArray(liste) ? liste : [];
    if (items.length === 0) break;

    for (const brut of items) {
      const produit = brut as Record<string, unknown>;
      const statut = typeof produit.status === 'string' ? produit.status : 'active';
      if (statut !== 'active') {
        // `draft`, `archived` : comptés, jamais importés.
        unpublishedSkipped += 1;
        continue;
      }
      const variantes = Array.isArray(produit.variants) ? produit.variants : [];
      variantsSeen += variantes.length;
      produits.push(produit);
    }

    if (produits.length >= MAX_SHOPIFY_PRODUCTS) {
      truncated = true;
      break;
    }

    const suivant = reponse.value.nextCursor;
    if (!suivant) break;
    if (suivant === dernierCurseur) break;
    dernierCurseur = suivant;
    curseur = suivant;
  }

  return {
    ok: true,
    value: {
      platform: 'shopify',
      endpoint: `https://${domaine.value.domain}/admin/api/${SHOPIFY_API_VERSION}/products.json`,
      shopName: typeof shop.name === 'string' ? shop.name : null,
      domain: domaine.value.domain,
      currency: typeof shop.currency === 'string' ? shop.currency : null,
      products: produits,
      variantsSeen,
      unpublishedSkipped,
      truncated,
      resourcesRead,
    },
  };
}

/**
 * Extrait `page_info` de l'en-tête `Link` d'une réponse Shopify.
 *
 * Forme publiée :
 * `<https://shop.myshopify.com/admin/api/2024-10/products.json?limit=250&page_info=abc>; rel="next"`.
 *
 * Le curseur est un jeton opaque : on le recopie tel quel, sans le décoder ni
 * le reconstruire. Il ne contient aucune donnée sensible (il est publié dans
 * l'en-tête de la réponse précédente), mais il n'est jamais journalisé pour
 * autant — il n'apporte rien au diagnostic.
 */
export function extrairePageInfo(lien: string): string | null {
  if (!lien) return null;
  for (const morceau of lien.split(',')) {
    if (!/rel="?next"?/i.test(morceau)) continue;
    const url = /<([^>]+)>/.exec(morceau);
    if (!url) continue;
    try {
      const pageInfo = new URL(url[1]).searchParams.get('page_info');
      return pageInfo && pageInfo.trim() ? pageInfo.trim() : null;
    } catch {
      continue;
    }
  }
  return null;
}

function fail(code: ShopifyErrorCode, message: string): { ok: false; error: ShopifyError } {
  return { ok: false, error: { code, message } };
}
