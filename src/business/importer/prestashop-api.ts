/**
 * VYORA — connecteur PrestaShop : lecture du catalogue par API officielle.
 *
 * ## Pourquoi l'API et pas le HTML
 * PrestaShop n'expose aucun catalogue public normalisé : `accessFor('prestashop')`
 * renvoie `html-only`, et lire les pages produit au HTML serait à la fois
 * fragile (un thème suffit à tout changer) et incomplet (déclinaisons, stock et
 * références n'y figurent pas de façon fiable). On passe donc par l'API
 * Webservice officielle, avec une clé délivrée par le marchand.
 *
 * ## Isolation stricte des dépendances
 * Ce module est **pur** : aucun appel réseau direct, aucune lecture
 * d'environnement. Tout passe par `EgressDeps` (résolution DNS + connexion
 * épinglée), donc par le même contrôle SSRF que l'import d'URL existant. C'est
 * ce qui permet de le tester sur des réponses réalistes sans réseau, et de
 * garantir qu'il ne peut pas contourner `safe-egress.ts`.
 *
 * ## Ce que le connecteur lit, et dans quel ordre
 * ```
 * GET /api/products?display=[id,name,reference,price,id_default_image,active,date_upd]
 * GET /api/product_option_values?display=[id,id_attribute_group,name]   (libellés)
 * GET /api/product_options?display=[id,name]                            (noms de groupe)
 * GET /api/combinations?display=full                                   (déclinaisons)
 * GET /api/stock_availables?display=[id,id_product,id_product_attribute,quantity]
 * ```
 * Aucun de ces appels n'est deviné : ce sont les ressources documentées de
 * PrestaShop 1.6/1.7/8.x. La pagination est celle de l'API (`limit`), et le
 * total est lu dans l'en-tête `Content-Range`.
 *
 * ## Ce que le connecteur ne fait JAMAIS
 * - Il n'écrit pas dans la boutique : uniquement des `GET`.
 * - Il ne promeut pas une déclinaison en produit : une déclinaison est
 *   rattachée à son produit parent, toujours.
 * - Il n'invente ni prix, ni devise, ni stock absents.
 * - Il ne met pas la clé API dans une URL journalisée, un message d'erreur ou
 *   une réponse.
 */
import type { FetchLike } from './sources.ts';
import type { RawCatalogProduct } from './sources.ts';
import type { StorePlatform } from './platform.ts';

/** Chemin par défaut de l'API PrestaShop. */
export const PRESTASHOP_API_PATH = '/api';

/** Version minimale et maximale réellement prises en charge. */
export const PRESTASHOP_SUPPORTED_SHOP_VERSIONS = ['1.6', '1.7', '8'] as const;

/** Plafond de produits lus, pour borner temps et mémoire. */
export const MAX_PRESTASHOP_PRODUCTS = 5_000;
/** Taille de page demandée à l'API (PrestaShop accepte au-delà de 100). */
export const PRESTASHOP_PAGE_SIZE = 100;
/** Nombre maximal de pages, dérivé du plafond ci-dessus. */
export const MAX_PRESTASHOP_PAGES = Math.ceil(MAX_PRESTASHOP_PRODUCTS / PRESTASHOP_PAGE_SIZE);
/** Nombre maximal de déclinaisons lues, pour un catalogue de tailles. */
export const MAX_PRESTASHOP_COMBINATIONS = 20_000;

/** Ressources lues par le connecteur. */
export type PrestashopResource =
  | 'products'
  | 'combinations'
  | 'product_option_values'
  | 'product_options'
  | 'stock_availables'
  | 'languages'
  | 'shops';

/** Codes d'erreur du connecteur, tous affichables. */
export type PrestashopErrorCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'forbidden'
  | 'not_prestashop'
  | 'api_disabled'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'too_large'
  | 'bad_response'
  | 'blocked_url'
  | 'dns_failed'
  | 'unreachable';

export interface PrestashopError {
  code: PrestashopErrorCode;
  message: string;
}

export type PrestashopResult<T> = { ok: true; value: T } | { ok: false; error: PrestashopError };

/** Identifiants d'accès. Jamais sérialisés dans une réponse. */
export interface PrestashopCredentials {
  /** Clé Webservice délivrée par le marchand (Paramètres > Webservice). */
  apiKey: string;
}

/** Boutique interrogée. */
export interface PrestashopTarget {
  /** Racine validée (schéma https, hôte public, port standard). */
  root: URL;
  /** Chemin de l'API, `''` pour la racine (certaines boutiques le déplacent). */
  basePath?: string;
}

/**
 * Ce que la vérification de connexion a réellement constaté.
 *
 * Volontairement factuel : pas de « connecté » sans une ressource lue avec
 * succès. `shops` permet de nommer la boutique, `languages` de connaître la
 * langue par défaut pour les libellés.
 */
export interface PrestashopProbe {
  /** Version annoncée par l'API, sans garantie (champ libre côté marchand). */
  version: string | null;
  /** Nom de la boutique, lu dans la ressource `shops`. */
  shopName: string | null;
  /** Langues configurées, pour retenir la langue par défaut des libellés. */
  languages: Array<{ id: number; isoCode: string }>;
  /** Nombre de produits annoncé par `Content-Range`, `null` si absent. */
  totalProducts: number | null;
  /** Ressources effectivement lues — la preuve de la vérification. */
  resourcesRead: PrestashopResource[];
}

/** Déclinaison d'un produit, telle que PrestaShop la décrit. */
export interface PrestashopCombination {
  id: string;
  productId: string;
  sku: string | null;
  /** Prix d'incidence éventuel, déjà en unité mineure. */
  priceMinorImpact: number | null;
  quantity: number | null;
  /** Libellés des valeurs d'attribut (« M », « Rouge »). */
  attributes: Array<{ name: string; groupName: string | null }>;
}

/** Catalogue PrestaShop normalisé vers le modèle commun. */
export interface PrestashopCatalog {
  platform: Extract<StorePlatform, 'prestashop'>;
  endpoint: string;
  products: RawCatalogProduct[];
  /** Devise de la boutique, `null` si l'API ne la publie pas. */
  currency: string | null;
  /** Rejets : produits ou déclinaisons illisibles, avec leur raison. */
  rejected: Array<{ line: number; reason: string }>;
  /** Vrai si le plafond de produits a été atteint : la lecture s'est arrêtée. */
  truncated: boolean;
  /** Ressources lues, pour le compte rendu de connexion. */
  resourcesRead: PrestashopResource[];
}

/* -------------------------------------------------------------------------- */
/* Utilitaires d'analyse                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Lit une valeur texte dans une entité PrestaShop.
 *
 * L'API renvoie soit une chaîne, soit un objet multilingue
 * `{ language: [{ '@id':'1', value:'…' }, …] }`. On retient la langue demandée,
 * puis la première disponible — jamais une valeur inventée.
 */
export function textOf(value: unknown, langId?: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object') return '';
  const brut = (value as Record<string, unknown>).language;
  const liste = Array.isArray(brut) ? brut : brut ? [brut] : [];
  if (liste.length === 0) return '';
  const choisi = langId === undefined
    ? liste[0]
    : liste.find((l) => String((l as Record<string, unknown>)['@id'] ?? '') === String(langId)) ?? liste[0];
  const valeur = (choisi as Record<string, unknown>)?.value;
  return typeof valeur === 'string' ? valeur : typeof valeur === 'number' ? String(valeur) : '';
}

/**
 * Lit un prix PrestaShop (chaîne décimale, point séparateur) en unité mineure.
 *
 * PrestaShop publie des montants à 6 décimales par défaut. `Math.round` sur le
 * produit par 100 est exact pour les devises à 2 décimales ; les devises sans
 * décimale (XOF) sont traitées plus loin par le normaliseur commun, qui
 * applique le bon exposant. On ne décide donc pas ici de l'exposant.
 */
export function priceMinorOf(value: unknown): number | null {
  const brut = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  if (!brut.trim()) return null;
  const nombre = Number(brut.replace(',', '.'));
  if (!Number.isFinite(nombre)) return null;
  return Math.round(nombre * 100);
}

/** Convertit un identifiant PrestaShop en chaîne, `null` si absent. */
function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const texte = typeof value === 'object'
    ? String((value as Record<string, unknown>)['#text'] ?? (value as Record<string, unknown>).value ?? '')
    : String(value);
  const propre = texte.trim();
  return propre && propre !== '0' ? propre : null;
}

/**
 * Étiquette un refus HTTP en erreur affichable.
 *
 * Le message ne contient JAMAIS la clé : elle n'est pas dans l'URL de départ,
 * et `redactedUrl` est utilisée partout où l'URL doit être montrée.
 */
export function classifyStatus(status: number): PrestashopError {
  if (status === 413) {
    return {
      code: 'bad_response',
      message: 'La boutique a refusé la requête comme trop volumineuse : réduisez le nombre de champs demandés.',
    };
  }
  if (status === 401) {
    return {
      code: 'auth_invalid',
      message: 'La clé Webservice a été refusée. Vérifiez la clé et son rattachement à cette boutique.',
    };
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      message: 'L’accès à l’API est refusé : la clé existe, mais n’a pas les droits de lecture sur cette ressource.',
    };
  }
  if (status === 404) {
    return {
      code: 'not_found',
      message: 'L’API PrestaShop ne répond pas à cette adresse : vérifiez l’URL de la boutique et le chemin de l’API.',
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: 'La boutique limite temporairement le débit de l’API : réessayez dans quelques minutes.',
    };
  }
  if (status === 405 || status === 501) {
    return {
      code: 'api_disabled',
      message: 'Le Webservice PrestaShop n’est pas activé sur cette boutique, ou la clé n’a pas été créée.',
    };
  }
  return {
    code: 'unreachable',
    message: `La boutique a répondu ${status}.`,
  };
}

/**
 * URL d'une ressource, sans jamais y placer la clé.
 *
 * La clé part en en-tête (`Authorization`), pas en paramètre `?ws_key=` : une
 * URL finit dans des journaux et des caches, un en-tête ne doit pas y finir.
 * `redactedUrl` sert à montrer l'adresse sans secret.
 */
export function resourceUrl(
  target: PrestashopTarget,
  resource: PrestashopResource,
  query: Record<string, string> = {},
): string {
  const base = target.root.origin + (target.basePath ?? PRESTASHOP_API_PATH).replace(/\/$/, '');
  const url = new URL(`${base}/${resource}`);
  url.searchParams.set('output_format', 'JSON');
  for (const [cle, valeur] of Object.entries(query)) url.searchParams.set(cle, valeur);
  return url.toString();
}

/** URL affichable : aucune information d'identification ne peut y figurer. */
export function redactedUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(adresse illisible)';
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture d'une ressource                                                     */
/* -------------------------------------------------------------------------- */

export interface PrestashopFetchDeps {
  /** `fetch` de la sortie épinglée (`pinnedFetchLike`), jamais `fetch` brut. */
  fetchImpl: FetchLike;
  /** Plafond de taille par réponse. */
  maxBytes?: number;
  /**
   * Attente entre deux pages, pour respecter la limite de débit.
   * Injectée : les tests n'attendent pas réellement.
   */
  pause?: (ms: number) => Promise<void>;
  /** Nombre maximal de tentatives sur une réponse 429 ou 5xx. */
  retries?: number;
  /** Délai de base entre deux tentatives (doublé à chaque essai). */
  retryDelayMs?: number;
}

/** Réponse brute d'une page, avant analyse. */
export interface PrestashopPage {
  items: unknown[];
  /** Total annoncé par `Content-Range`, `null` si absent. */
  total: number | null;
  /** Vrai quand la page est vide : la pagination s'arrête là. */
  empty: boolean;
}

/**
 * Lit `Content-Range: 0-99/1234`.
 *
 * L'en-tête est absent chez certains serveurs (ou mangé par un cache) : on
 * renvoie alors `null`, et l'appelant continue simplement jusqu'à la page vide.
 */
export function parseContentRange(value: string | null): number | null {
  if (!value) return null;
  const apresSlash = /\/(\d+)\s*$/.exec(value);
  if (apresSlash) return Number(apresSlash[1]);
  return null;
}

/** Retire l'enveloppe `{ prestashop: { <ressource>: … } }`. */
export function unwrapPrestashop(payload: unknown, resource: PrestashopResource): unknown {
  const racine = (payload as Record<string, unknown> | null)?.prestashop;
  if (!racine || typeof racine !== 'object') return null;
  return (racine as Record<string, unknown>)[resource] ?? null;
}

/** Normalise une collection PrestaShop en tableau. */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

/**
 * Lit une ressource paginée.
 *
 * ## Comportement sur erreur
 * - 401/403/404/405 : erreur immédiate, non réessayée (réessayer ne changerait
 *   rien et retarderait le message utile).
 * - 429 et 5xx : réessai avec attente croissante, puis erreur. Un catalogue
 *   partiel présenté comme complet serait pire qu'un échec.
 *
 * ## Pourquoi la page vide termine la boucle
 * Certaines boutiques ignorent `limit` et renvoient tout d'un coup, d'autres
 * tronquent sans `Content-Range`. On s'arrête sur `items.length === 0` ou sur
 * le total annoncé, jamais sur une supposition.
 */
export async function fetchPrestashopPage(
  target: PrestashopTarget,
  credentials: PrestashopCredentials,
  resource: PrestashopResource,
  options: { page: number; limit: number; display?: string; query?: Record<string, string> },
  deps: PrestashopFetchDeps,
): Promise<PrestashopResult<PrestashopPage>> {
  const query: Record<string, string> = { ...(options.query ?? {}) };
  query.limit = `${(options.page - 1) * options.limit},${options.limit}`;
  if (options.display) query.display = options.display;
  const url = resourceUrl(target, resource, query);

  const retries = Math.max(0, deps.retries ?? 2);
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let derniereErreur: PrestashopError | null = null;

  for (let essai = 0; essai <= retries; essai++) {
    if (essai > 0) await pause(Math.max(0, deps.retryDelayMs ?? 500) * 2 ** (essai - 1));
    let reponse: Response;
    try {
      reponse = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
          // La clé part en en-tête : jamais dans l'URL, donc jamais dans un
          // journal d'accès ou un historique de cache.
          authorization: `Basic ${base64(`${credentials.apiKey}:`)}`,
          accept: 'application/json',
        },
      });
    } catch (cause) {
      const code = (cause as { code?: string })?.code;
      // Un statut HTTP renvoyé par la sortie épinglée (`PinnedNetworkError`)
      // décrit une RÉPONSE, pas une panne : il doit passer par la même
      // classification qu'une réponse reçue normalement, sinon un 401 devient
      // « injoignable » et le marchand cherche au mauvais endroit.
      const statut = (cause as { status?: number })?.status;
      if (typeof statut === 'number' && statut >= 400) {
        const classifie = classifyStatus(statut);
        if (statut === 429 || statut >= 500) {
          derniereErreur = classifie;
          continue;
        }
        return { ok: false, error: classifie };
      }
      const traduit = traduireErreurReseau(code, cause);
      if (traduit.code === 'blocked_url' || traduit.code === 'dns_failed') {
        return { ok: false, error: traduit };
      }
      derniereErreur = traduit;
      continue;
    }

    if (reponse.status === 429 || reponse.status >= 500) {
      derniereErreur = classifyStatus(reponse.status);
      continue;
    }
    if (reponse.status < 200 || reponse.status >= 300) {
      return { ok: false, error: classifyStatus(reponse.status) };
    }

    const texte = await reponse.text();
    // Une réponse HTML à l'adresse de l'API signifie presque toujours que
    // l'URL n'est pas celle d'un Webservice (page 404 du thème, portail de
    // connexion) : le dire clairement vaut mieux qu'un « JSON invalide ».
    if (/^\s*<(!doctype|html)/i.test(texte)) {
      return {
        ok: false,
        error: {
          code: 'not_prestashop',
          message: 'Cette adresse renvoie une page HTML, pas l’API PrestaShop. Vérifiez l’URL de la boutique.',
        },
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(texte);
    } catch {
      return {
        ok: false,
        error: { code: 'bad_response', message: 'La réponse de l’API n’est pas du JSON valide.' },
      };
    }

    const collection = unwrapPrestashop(payload, resource);
    if (collection === null) {
      // Ressource vide : PrestaShop renvoie `""` ou `[]` selon la version.
      return { ok: true, value: { items: [], total: 0, empty: true } };
    }
    const items = asArray(collection);
    const total = parseContentRange(reponse.headers.get('content-range'));
    return { ok: true, value: { items, total, empty: items.length === 0 } };
  }

  return {
    ok: false,
    error: derniereErreur ?? {
      code: 'unreachable',
      message: 'La boutique n’a pas répondu après plusieurs tentatives.',
    },
  };
}

/** Traduit un échec de la sortie réseau épinglée en erreur du connecteur. */
function traduireErreurReseau(code: string | undefined, cause: unknown): PrestashopError {
  const message = (cause as { message?: string })?.message;
  switch (code) {
    case 'blocked_url':
      return { code: 'blocked_url', message: message ?? 'Adresse refusée par le contrôle de sécurité.' };
    case 'dns_failed':
    case 'dns_empty':
      return { code: 'dns_failed', message: message ?? 'Le domaine de la boutique n’a pas pu être résolu.' };
    case 'timeout':
      return { code: 'timeout', message: 'La boutique n’a pas répondu dans le délai autorisé.' };
    case 'too_large':
      return { code: 'too_large', message: 'La réponse de la boutique dépasse la taille autorisée.' };
    default:
      return { code: 'unreachable', message: message ?? 'La boutique est injoignable.' };
  }
}

/** Base64 sans `btoa` : disponible aussi sous Deno et en test. */
function base64(valeur: string): string {
  if (typeof btoa === 'function') return btoa(valeur);
  // Chemin de repli minimal (UTF-8 → base64), utilisé hors navigateur.
  const octets = new TextEncoder().encode(valeur);
  let binaire = '';
  for (const octet of octets) binaire += String.fromCharCode(octet);
  // eslint-disable-next-line no-undef
  return (globalThis as { Buffer?: { from: (v: string, e: string) => { toString: (e: string) => string } } })
    .Buffer?.from(binaire, 'binary').toString('base64') ?? '';
}

export { idOf as prestashopIdOf };
