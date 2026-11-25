/**
 * SORAHNEX — connecteur Chariow : client de l'API officielle.
 *
 * ## Ce que Chariow est, et ce que cela impose
 *
 * Chariow héberge des boutiques de produits numériques (formations, licences,
 * services, coaching, bundles). Il n'existe **aucun catalogue public** : pas de
 * `/products.json`, pas de flux XML, et le `sitemap.xml` d'une boutique ne liste
 * que ses pages statiques. Le catalogue n'est lisible que par
 * `GET https://api.chariow.com/v1/products`, avec une clé `sk_live_…` en
 * `Authorization: Bearer`.
 *
 * Conséquence de conception : contrairement à Shopify/WooCommerce, il n'y a
 * rien à « découvrir » sur la boutique. L'hôte de l'API est **fixe** — il n'est
 * jamais dicté par l'utilisateur — ce qui retire d'emblée la surface SSRF liée à
 * une adresse d'API fournie par le client. La seule adresse saisie par le
 * marchand est celle de sa vitrine, et elle ne sert qu'à **vérifier que la clé
 * correspond bien à cette boutique** (comparaison avec `data.url` renvoyé par
 * `GET /v1/store`).
 *
 * ## Isolation stricte des dépendances
 *
 * Ce module est **pur** : aucun appel réseau direct, aucune lecture
 * d'environnement. Tout passe par `fetchImpl`, qui en production est la sortie
 * épinglée (`pinnedFetchLike`) — donc le même contrôle SSRF que le reste de
 * l'import. C'est ce qui permet de le tester sur des réponses réalistes sans
 * réseau, et de garantir qu'il ne peut pas contourner `safe-egress.ts`.
 *
 * ## Ce que le client ne fait JAMAIS
 *
 * - Il n'écrit, ne modifie et ne supprime rien : uniquement des `GET`.
 * - Il ne demande que deux scopes (`store.read`, `products.read`).
 * - Il n'invente ni SKU, ni variante, ni stock : l'API Chariow n'en fournit pas
 *   (`has_variant_pricing` est un simple booléen).
 * - Il ne met la clé ni dans une URL, ni dans un message d'erreur, ni dans une
 *   réponse : elle ne vit que dans l'en-tête `Authorization` d'une requête
 *   sortante.
 */
import type { FetchLike } from './sources.ts';

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base de l'API officielle.
 *
 * **Fixe, et non paramétrable par l'appelant.** Une API dont on accepte
 * l'adresse depuis une requête est une primitive SSRF : ici, l'utilisateur ne
 * peut pas la déplacer, donc la clé ne peut pas être envoyée ailleurs.
 */
export const CHARIOW_API_BASE = 'https://api.chariow.com/v1';

/** Plafond de produits lus, pour borner temps et mémoire. */
export const MAX_CHARIOW_PRODUCTS = 5_000;
/** Taille de page demandée (maximum documenté : 100). */
export const CHARIOW_PAGE_SIZE = 100;
/** Nombre maximal de pages, dérivé du plafond si le curseur ne s'arrêtait pas. */
export const MAX_CHARIOW_PAGES = Math.ceil(MAX_CHARIOW_PRODUCTS / CHARIOW_PAGE_SIZE);
/** Plafond de taille d'une réponse d'API (une page de 100 produits reste petite). */
export const MAX_CHARIOW_BYTES = 4 * 1024 * 1024;

/** Préfixe attendu d'une clé de boutique Chariow. */
export const CHARIOW_KEY_PREFIX = 'sk_';
/** Longueur minimale plausible d'une clé (`sk_live_` + secret). */
export const CHARIOW_KEY_MIN_LENGTH = 20;

/** Hôte de l'API, pour l'affichage et l'audit. */
export const CHARIOW_API_HOST = 'api.chariow.com';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Ressources lues par le connecteur. Sert de preuve dans le compte rendu. */
export type ChariowResource = 'store' | 'products';

/** Codes d'erreur du connecteur, tous affichables. */
export type ChariowErrorCode =
  | 'auth_required'
  | 'auth_invalid'
  | 'insufficient_scope'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'too_large'
  | 'bad_response'
  | 'blocked_url'
  | 'dns_failed'
  | 'unreachable';

export interface ChariowError {
  code: ChariowErrorCode;
  message: string;
  /**
   * Scopes manquants, quand l'API les nomme (`403` avec `errors.scopes`).
   *
   * On les transporte au lieu de les fondre dans le message : l'utilisateur
   * reçoit alors « ajoutez products.read », qui est actionnable, au lieu de
   * « accès refusé ».
   */
  missingScopes?: string[];
}

export type ChariowResult<T> = { ok: true; value: T } | { ok: false; error: ChariowError };

/** Identifiants d'accès. Jamais sérialisés dans une réponse. */
export interface ChariowCredentials {
  /** Clé `sk_live_…` créée dans app.chariow.com → Settings → API Keys. */
  apiKey: string;
}

/** Boutique Chariow, telle que `GET /v1/store` la décrit. */
export interface ChariowStore {
  /** Identifiant stable (`store_…`). */
  id: string | null;
  name: string | null;
  description: string | null;
  logoUrl: string | null;
  /** URL publique de la boutique — sert à vérifier qu'on parle de la bonne. */
  url: string | null;
  /** `active` | `under_review` | `suspended` | `archived`. */
  status: string | null;
  totalCustomers: number | null;
}

/** Ce que la vérification de connexion a réellement constaté. */
export interface ChariowProbe {
  store: ChariowStore;
  /**
   * Nombre de produits annoncé par la première page, `null` si l'API ne le dit
   * pas.
   *
   * Chariow ne publie pas de total : on rapporte donc `has_more_pages` et la
   * taille de la première page, ce qui est une information honnête (« au moins
   * N produits ») plutôt qu'un chiffre inventé.
   */
  firstPageCount: number | null;
  hasMorePages: boolean;
  /** Ressources effectivement lues — la preuve de la vérification. */
  resourcesRead: ChariowResource[];
}

/** Montant Chariow : `{ value, formatted, short, currency }`. */
export interface ChariowAmount {
  value: number | null;
  currency: string | null;
  formatted: string | null;
}

/** Produit Chariow, réduit aux champs utiles au catalogue SORAHNEX. */
export interface ChariowProduct {
  /** `prd_…` — identifiant STABLE, seule identité fiable côté Chariow. */
  id: string;
  name: string;
  slug: string | null;
  /** HTML assaini par Chariow ; le normaliseur commun retire les balises. */
  description: string;
  /** `draft` | `published` | `suspended`. */
  status: string | null;
  type: string | null;
  category: { value: string | null; label: string | null } | null;
  isFree: boolean;
  imageUrl: string | null;
  /** Prix effectif retenu (voir `pickChariowPrice`). */
  amount: ChariowAmount;
  /** Devise de référence du produit (`pricing.tracking.currency`), si publiée. */
  trackingCurrency: string | null;
  /** Stock restant, `null` = inconnu (jamais 0 par défaut). */
  stock: number | null;
  /** `has_variant_pricing` : indicateur SEUL, aucune liste de variantes. */
  hasVariantPricing: boolean;
  onSaleUntil: string | null;
}

/** Catalogue Chariow normalisé vers le modèle commun. */
export interface ChariowCatalog {
  platform: 'chariow';
  endpoint: string;
  store: ChariowStore;
  products: ChariowProduct[];
  /** Devise de la boutique, déduite des prix observés. */
  currency: string | null;
  /**
   * Nombre de produits écartés parce qu'ils ne sont pas publiés.
   *
   * Compté, pas seulement filtré : l'aperçu doit pouvoir dire « 4 brouillons
   * ignorés » plutôt que de laisser croire que la boutique n'a que 12 fiches.
   */
  draftsSkipped: number;
  /** Produits écartés pour une autre raison (identifiant ou nom absent). */
  rejected: Array<{ line: number; reason: string }>;
  /** Vrai si le plafond de produits a été atteint : la lecture s'est arrêtée. */
  truncated: boolean;
  resourcesRead: ChariowResource[];
}

/** Dépendances de lecture. */
export interface ChariowFetchDeps {
  /** `fetch` de la sortie épinglée (`pinnedFetchLike`), jamais `fetch` brut. */
  fetchImpl: FetchLike;
  /** Attente entre deux pages, injectée : les tests n'attendent pas. */
  pause?: (ms: number) => Promise<void>;
  /** Nombre maximal de tentatives sur 429 / 5xx. */
  retries?: number;
  /** Délai de base entre deux tentatives (doublé à chaque essai). */
  retryDelayMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Validation de la clé                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Contrôle de forme d'une clé Chariow.
 *
 * On refuse tôt, avec un message utile, ce qui ne peut pas être une clé :
 * - vide ou trop courte ;
 * - contenant un espace ou un caractère de contrôle (casserait l'en-tête
 *   `Authorization`, voire y injecterait une ligne) ;
 * - ne commençant pas par `sk_` — Chariow n'émet que des clés `sk_live_…`.
 *
 * On ne vérifie **pas** la validité réelle ici : c'est le rôle de la sonde, qui
 * lit effectivement `GET /v1/store`. Une clé bien formée mais révoquée doit être
 * refusée par Chariow, avec un message qui vient de Chariow.
 */
export function validateChariowKey(raw: unknown): ChariowResult<string> {
  if (typeof raw !== 'string') {
    return { ok: false, error: { code: 'auth_required', message: 'La clé API Chariow est requise.' } };
  }
  const cle = raw.trim();
  if (cle.length === 0) {
    return { ok: false, error: { code: 'auth_required', message: 'La clé API Chariow est requise.' } };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(cle)) {
    return {
      ok: false,
      error: {
        code: 'auth_required',
        message: 'La clé API contient un espace ou un caractère invisible : recopiez-la sans espace.',
      },
    };
  }
  if (!cle.startsWith(CHARIOW_KEY_PREFIX)) {
    return {
      ok: false,
      error: {
        code: 'auth_required',
        message: 'Une clé Chariow commence par « sk_ » (clé de boutique, créée dans Settings → API Keys).',
      },
    };
  }
  if (cle.length < CHARIOW_KEY_MIN_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'auth_required',
        message: 'Cette clé est trop courte pour être une clé Chariow. Vérifiez la copie (elle n’est affichée qu’une fois).',
      },
    };
  }
  return { ok: true, value: cle };
}

/* -------------------------------------------------------------------------- */
/* Classification des erreurs                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Traduit un statut HTTP Chariow en erreur affichable.
 *
 * Les messages de Chariow sont utiles (ils nomment le scope manquant), mais on
 * ne les relaie jamais tels quels sans les borner : une réponse d'API distante
 * ne doit pas dicter le texte affiché à l'utilisateur, ni servir de vecteur.
 */
export function classifyChariowStatus(
  status: number,
  body?: unknown,
  missingScopes?: string[],
): ChariowError {
  const scopes = missingScopes && missingScopes.length > 0 ? missingScopes : undefined;

  if (status === 401) {
    return {
      code: 'auth_invalid',
      message: 'Chariow a refusé la clé API. Elle a peut-être été supprimée, révoquée, ou son créateur n’est plus membre actif de l’équipe. Créez une nouvelle clé dans Settings → API Keys.',
    };
  }
  if (status === 403) {
    const liste = scopes?.length ? scopes.join(', ') : 'products.read et store.read';
    return {
      code: 'insufficient_scope',
      message: `La clé est valide mais n’a pas les permissions nécessaires (${liste}). Modifiez ses scopes dans Chariow → Settings → API Keys, sans la régénérer.`,
      ...(scopes ? { missingScopes: scopes } : {}),
    };
  }
  if (status === 404) {
    return {
      code: 'not_found',
      message: 'L’adresse de l’API Chariow n’a pas été reconnue. Vérifiez que la clé provient bien de Chariow.',
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message: 'Chariow limite temporairement le débit (100 requêtes par minute). Réessayez dans quelques instants.',
    };
  }
  if (status >= 500) {
    return {
      code: 'unreachable',
      message: 'L’API Chariow est momentanément indisponible. Réessayez plus tard : aucun import partiel n’est conservé.',
    };
  }
  // 400 / 422 : la requête a été refusée. On ne relaie pas le corps brut (il
  // peut contenir un écho de la requête), seulement le fait.
  const detail = messageChariow(body);
  return {
    code: 'bad_response',
    message: detail
      ? `Chariow a refusé la requête : ${detail}`
      : 'Chariow a refusé la requête (paramètres non acceptés).',
  };
}

/**
 * Extrait un message court d'une réponse d'erreur Chariow.
 *
 * Borné et nettoyé : c'est du texte distant, il ne doit ni être long, ni
 * contenir de saut de ligne qui déformerait l'affichage.
 */
function messageChariow(body: unknown): string | null {
  const message = (body as { message?: unknown })?.message;
  if (typeof message !== 'string') return null;
  const propre = message.replace(/\s+/g, ' ').trim();
  if (!propre) return null;
  return propre.length > 200 ? `${propre.slice(0, 200)}…` : propre;
}

/**
 * Lit les scopes manquants d'une réponse `403`.
 *
 * Chariow les publie à deux endroits : `errors.scopes` dans le corps, et
 * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`. On accepte
 * les deux, parce qu'un proxy peut retirer l'un ou l'autre.
 */
export function readMissingScopes(body: unknown, wwwAuthenticate?: string | null): string[] {
  const resultat: string[] = [];
  const erreurs = (body as { errors?: unknown })?.errors;
  const liste = (erreurs as { scopes?: unknown })?.scopes;
  if (Array.isArray(liste)) {
    for (const element of liste) {
      if (typeof element === 'string' && element.trim()) resultat.push(element.trim());
    }
  }
  if (resultat.length === 0 && typeof wwwAuthenticate === 'string') {
    // `scope="a b"` ou `scope=a` — les espaces séparent plusieurs scopes.
    const correspondance = /scope\s*=\s*"?([^",]+)"?/i.exec(wwwAuthenticate);
    if (correspondance) {
      for (const element of correspondance[1].split(/\s+/)) {
        if (element.trim()) resultat.push(element.trim());
      }
    }
  }
  return Array.from(new Set(resultat));
}

/* -------------------------------------------------------------------------- */
/* Construction des URL et lecture d'une page                                  */
/* -------------------------------------------------------------------------- */

/** URL d'une ressource de l'API, sans jamais y placer la clé. */
export function chariowUrl(path: 'store' | 'products', query: Record<string, string> = {}): string {
  const url = new URL(`${CHARIOW_API_BASE}/${path}`);
  for (const [cle, valeur] of Object.entries(query)) url.searchParams.set(cle, valeur);
  return url.toString();
}

/** Enveloppe paginée renvoyée par `GET /v1/products`. */
export interface ChariowPage {
  items: unknown[];
  nextCursor: string | null;
  hasMorePages: boolean;
  count: number;
}

/**
 * Lit `pagination` d'une réponse de liste.
 *
 * Le curseur est la seule façon correcte d'avancer : Chariow ne publie pas de
 * total, et un `offset` calculé à la main se désynchronise dès qu'un produit
 * est créé pendant la lecture.
 */
export function readChariowPagination(payload: unknown): {
  nextCursor: string | null;
  hasMorePages: boolean;
  count: number;
} {
  const pagination = (payload as { pagination?: unknown })?.pagination;
  if (!pagination || typeof pagination !== 'object') {
    return { nextCursor: null, hasMorePages: false, count: 0 };
  }
  const p = pagination as Record<string, unknown>;
  const nextCursor = typeof p.next_cursor === 'string' && p.next_cursor.trim() ? p.next_cursor.trim() : null;
  const count = typeof p.count === 'number' && Number.isFinite(p.count) ? p.count : 0;
  return {
    nextCursor,
    // `has_more_pages` est la source de vérité ; à défaut, la présence d'un
    // curseur suffit. Sans les deux, on s'arrête — jamais de boucle infinie.
    hasMorePages: p.has_more_pages === true || nextCursor !== null,
    count,
  };
}

/**
 * Appelle une ressource GET de l'API Chariow.
 *
 * ## Comportement sur erreur
 * - 401/403/404 : erreur immédiate, non réessayée. Réessayer ne changerait rien
 *   et retarderait le message utile ; surtout, un 403 « scope manquant » est
 *   une action à faire côté Chariow, pas une panne.
 * - 429 et 5xx : réessai avec attente croissante, puis erreur. Un catalogue
 *   partiel présenté comme complet serait pire qu'un échec.
 *
 * ## La clé ne sort que par l'en-tête
 * Elle n'apparaît jamais dans l'URL (donc jamais dans un journal d'accès), et
 * aucun message d'erreur ne la reconstruit.
 */
export async function fetchChariowResource(
  credentials: ChariowCredentials,
  path: 'store' | 'products',
  query: Record<string, string>,
  deps: ChariowFetchDeps,
): Promise<ChariowResult<{ payload: unknown; status: number; missingScopes: string[] }>> {
  const url = chariowUrl(path, query);
  const retries = Math.max(0, deps.retries ?? 2);
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let derniereErreur: ChariowError | null = null;

  for (let essai = 0; essai <= retries; essai++) {
    if (essai > 0) await pause(Math.max(0, deps.retryDelayMs ?? 600) * 2 ** (essai - 1));

    let reponse: Response;
    try {
      reponse = await deps.fetchImpl(url, {
        method: 'GET',
        headers: {
          // Seul emplacement de la clé.
          authorization: `Bearer ${credentials.apiKey}`,
          accept: 'application/json',
        },
      });
    } catch (cause) {
      // La sortie épinglée lève une `PinnedNetworkError` portant un code et,
      // parfois, le statut HTTP observé. Un 401 reçu ainsi décrit une RÉPONSE :
      // il doit passer par la même classification qu'une réponse normale, sinon
      // une clé révoquée deviendrait « injoignable » et le marchand chercherait
      // la panne du mauvais côté.
      const statut = (cause as { status?: number })?.status;
      if (typeof statut === 'number' && statut >= 400) {
        const classifie = classifyChariowStatus(statut);
        if (statut === 429 || statut >= 500) {
          derniereErreur = classifie;
          continue;
        }
        return { ok: false, error: classifie };
      }
      const traduit = traduireErreurReseau((cause as { code?: string })?.code, cause);
      if (traduit.code === 'blocked_url' || traduit.code === 'dns_failed') {
        return { ok: false, error: traduit };
      }
      derniereErreur = traduit;
      continue;
    }

    if (reponse.status === 429 || reponse.status >= 500) {
      derniereErreur = classifyChariowStatus(reponse.status);
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
      const scopes = readMissingScopes(corps, reponse.headers.get('www-authenticate'));
      return { ok: false, error: classifyChariowStatus(reponse.status, corps, scopes) };
    }

    // Une réponse HTML à l'adresse de l'API signifie un portail captif ou un
    // proxy d'entreprise, jamais une réponse de Chariow : le dire vaut mieux
    // qu'un « JSON invalide ».
    if (/^\s*<(!doctype|html)/i.test(texte)) {
      return {
        ok: false,
        error: {
          code: 'bad_response',
          message: 'L’adresse de l’API Chariow a renvoyé une page HTML au lieu de JSON : un intermédiaire réseau (proxy, portail captif) intercepte la connexion.',
        },
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(texte);
    } catch {
      return {
        ok: false,
        error: { code: 'bad_response', message: 'La réponse de l’API Chariow n’est pas du JSON valide.' },
      };
    }

    return {
      ok: true,
      value: {
        payload,
        status: reponse.status,
        missingScopes: readMissingScopes(payload, reponse.headers.get('www-authenticate')),
      },
    };
  }

  return {
    ok: false,
    error: derniereErreur ?? {
      code: 'unreachable',
      message: 'L’API Chariow n’a pas répondu après plusieurs tentatives.',
    },
  };
}

/** Traduit un échec de la sortie réseau épinglée en erreur du connecteur. */
function traduireErreurReseau(code: string | undefined, cause: unknown): ChariowError {
  const message = (cause as { message?: string })?.message;
  switch (code) {
    case 'blocked_url':
      return { code: 'blocked_url', message: message ?? 'Adresse refusée par le contrôle de sécurité.' };
    case 'dns_failed':
    case 'dns_empty':
      return { code: 'dns_failed', message: message ?? 'Le domaine de l’API Chariow n’a pas pu être résolu.' };
    case 'timeout':
      return { code: 'timeout', message: 'L’API Chariow n’a pas répondu dans le délai autorisé.' };
    case 'too_large':
      return { code: 'too_large', message: 'La réponse de l’API Chariow dépasse la taille autorisée.' };
    default:
      return { code: 'unreachable', message: message ?? 'L’API Chariow est injoignable.' };
  }
}
