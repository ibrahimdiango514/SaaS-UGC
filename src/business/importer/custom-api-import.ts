/**
 * Connecteur « API personnalisée » — lecture paginée et import.
 *
 * ## Ce que ce module NE fait pas
 *
 * Il ne contacte rien. Toutes les requêtes passent par un `FetchLike` fourni
 * par l'appelant, qui est, en production, la sortie épinglée de `store-import`
 * (`pinnedFetchLike`) : résolution DNS contrôlée, connexion sur l'IP validée,
 * redirections revalidées. Fabriquer un `fetch` ici ouvrirait un second chemin
 * de sortie réseau — c'est-à-dire une seconde faille à côté de celle qui est
 * testée.
 *
 * Il ne construit pas non plus l'authentification : les en-têtes arrivent déjà
 * calculés depuis `custom-api-guard.ts`. Ce module ne voit donc jamais un
 * secret, et ne peut pas le journaliser.
 *
 * ## Les garde-fous de pagination
 *
 * Une API mal configurée, ou hostile, peut boucler : curseur qui ne bouge pas,
 * page suivante toujours identique, total qui n'arrive jamais. Trois limites
 * bornent le travail :
 *
 *   - `maxPages` (défaut 20, plafond 200) : nombre de requêtes ;
 *   - `MAX_PRODUCTS` : nombre total de produits retenus ;
 *   - détection de **répétition** : si une page ne contient que des produits
 *     déjà vus, la boucle s'arrête avec un motif. C'est le cas le plus fréquent
 *     en pratique (API qui ignore `?page=` et renvoie tout à chaque fois).
 *
 * ## La reprise
 *
 * `resumeFrom` permet de reprendre à une page donnée. Chaque produit retenu
 * porte son index global : la reprise est donc **idempotente** — rejouer une
 * page déjà traitée ne duplique rien, puisque l'appelant écrit par index.
 */

import {
  mapProduct,
  type CustomApiMapping,
  type MapOptions,
} from './custom-api-mapping';
import {
  lireChemin,
  paginationCoherente,
  probeResponse,
  substituerPagination,
  type PaginationKind,
} from './custom-api-probe';
import type { NormalizedProduct } from './normalize';

/** Signature minimale compatible avec `FetchLike` de `sources.ts`. */
export type ImportFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Nombre maximal de produits retenus, toutes pages confondues. */
export const MAX_PRODUCTS = 5000;

/** Plafond dur du nombre de pages, quelle que soit la configuration. */
export const HARD_MAX_PAGES = 200;

export interface PaginationPlan {
  kind: PaginationKind;
  /** Modèle de chemin, avec `{page}`, `{limit}` ou `{cursor}`. */
  path: string;
  pageSize: number;
  maxPages: number;
}

export interface ImportRunOptions {
  mapping: CustomApiMapping;
  pagination: PaginationPlan;
  mapOptions: MapOptions;
  /** En-têtes déjà construits (authentification). Jamais journalisés. */
  headers?: Record<string, string>;
  /** Page de départ, pour une reprise. 1 par défaut. */
  resumeFrom?: number;
  /** Curseur de départ, pour une reprise en mode curseur. */
  resumeCursor?: string | null;
  /** Appelé après chaque page : sert à journaliser la progression. */
  onPage?: (info: PageProgress) => void;
  /** Injecté pour rendre les tests déterministes. */
  now?: () => number;
}

export interface PageProgress {
  page: number;
  /** Produits lus sur cette page, rejetés compris. */
  read: number;
  /** Produits retenus sur cette page. */
  kept: number;
  /** Rejets cumulés depuis le début. */
  rejectedTotal: number;
  /** Curseur suivant, en mode curseur. */
  nextCursor: string | null;
}

export type ImportOutcome =
  | {
    ok: true;
    products: NormalizedProduct[];
    /** Index global du premier produit : base de la reprise. */
    firstIndex: number;
    rejected: Array<{ index: number; reason: string }>;
    warnings: string[];
    pages: number;
    /** Nombre de pages restantes si la borne a été atteinte. */
    truncated: boolean;
    /** Curseur à repasser pour continuer, en mode curseur. */
    nextCursor: string | null;
    /** Prochaine page à demander, en mode page. */
    nextPage: number | null;
  }
  | {
    ok: false;
    /** Étape où l'échec est survenu. */
    stage: 'http' | 'json' | 'shape' | 'auth' | 'network';
    code: string;
    message: string;
    /** Statut HTTP, quand il y en a un. */
    status?: number;
    /** Produits déjà retenus avant l'échec : rien n'est perdu, la reprise existe. */
    partial: { products: NormalizedProduct[]; rejected: Array<{ index: number; reason: string }>; pages: number };
  };

/**
 * Lit toutes les pages et rend les produits retenus.
 *
 * L'ordre est celui de la source. Aucun dédoublonnage n'est fait ici : le
 * rapprochement (`matching.ts`) et l'aperçu s'en chargent, et supprimer une
 * ligne en silence ferait perdre une variante légitime.
 */
export async function runCustomApiImport(
  baseUrl: string,
  fetchImpl: ImportFetch,
  options: ImportRunOptions,
): Promise<ImportOutcome> {
  const { pagination } = options;

  /*
   * Cohérence vérifiée AVANT toute requête.
   *
   * Un modèle qui annonce une pagination par page sans marqueur `{page}` ne
   * paginerait pas : il relirait indéfiniment la même adresse. Mieux vaut
   * refuser tout de suite, sans consommer une requête ni allumer d'alerte côté
   * boutique.
   */
  const coherence = paginationCoherente(pagination.kind, pagination.path);
  if (!coherence.ok) {
    return echec('shape', 'PAGINATION_INCOHERENTE', coherence.message ?? 'Pagination incohérente.', undefined, [], [], 0);
  }

  const maxPages = Math.min(
    Math.max(1, Math.floor(pagination.maxPages) || 1),
    HARD_MAX_PAGES,
  );

  const produits: NormalizedProduct[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const warnings: string[] = [];

  let page = Math.max(1, Math.floor(options.resumeFrom ?? 1));
  let cursor: string | null = options.resumeCursor ?? null;
  let pagesLues = 0;
  let truncated = false;
  let nextCursor: string | null = null;
  // Empreintes déjà vues : sert à détecter une API qui renvoie la même page.
  const vues = new Set<string>();
  let repetitionsConsecutives = 0;

  // La toute première requête sert de preuve de vie : elle est aussi celle
  // dont la réponse est analysée pour confirmer qu'un tableau existe.
  let premiereReponse = true;

  while (pagesLues < maxPages && produits.length < MAX_PRODUCTS) {
    /* ------------------------- construire l'adresse ---------------------- */

    let chemin: string;
    try {
      chemin = substituerPagination(modelePourCurseur(pagination, cursor), {
        page: pagination.kind === 'page' ? page : undefined,
        limit: pagination.kind === 'none' ? undefined : pagination.pageSize,
        cursor: pagination.kind === 'cursor' ? cursor : undefined,
      });
    } catch (cause) {
      return echec('shape', 'PAGINATION_INCOHERENTE', messageDe(cause), undefined, produits, rejected, pagesLues);
    }

    const url = new URL(chemin, baseUrl).toString();

    /* ----------------------------- requête ------------------------------ */

    let reponse: Response;
    try {
      reponse = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(options.headers ?? {}),
        },
      });
    } catch (cause) {
      // Panne réseau : ce n'est pas une erreur de configuration. Les produits
      // déjà lus sont rendus pour que l'utilisateur puisse reprendre.
      return echec('network', 'NETWORK_FAILED', messageDe(cause), undefined, produits, rejected, pagesLues);
    }

    pagesLues += 1;
    const corps = await reponse.text().catch(() => '');

    /* ------------------------------ analyse ----------------------------- */

    const corpsPropre = corps.trim();
    let json: unknown;
    if (corpsPropre) {
      try {
        json = JSON.parse(corpsPropre);
      } catch {
        // Une réponse non-JSON à la première page est une erreur de cible ;
        // plus tard, elle signale une page d'erreur HTML d'un serveur fatigué.
        return echec(
          'json',
          'NOT_JSON',
          `La réponse de la page ${page} n’est pas du JSON valide.`,
          reponse.status,
          produits,
          rejected,
          pagesLues,
        );
      }
    }

    /*
     * La sonde est réutilisée pour qualifier la réponse : 401, 403, 404 et les
     * JSON sans tableau ont déjà des messages écrits et testés. Elle est
     * appliquée SANS chemin déclaré, car c'est justement à la première page
     * qu'on veut savoir si la structure est exploitable.
     */
    const sonde = probeResponse({
      status: reponse.status,
      contentType: reponse.headers.get('content-type') ?? undefined,
      body: corpsPropre || '{}',
    });

    if (premiereReponse && !sonde.ok) {
      // La sonde distingue déjà les causes ; on en déduit l'étape, ce qui
      // permet à l'interface de proposer le bon correctif (clé, droits, chemin).
      const etape = sonde.code === 'unauthorized' || sonde.code === 'forbidden'
        ? 'auth'
        : sonde.code === 'no_array' || sonde.code === 'not_json' || sonde.code === 'empty_body'
          ? 'shape'
          : 'http';
      return echec(
        etape,
        codeDepuisSonde(sonde.code),
        sonde.message,
        reponse.status,
        produits,
        rejected,
        pagesLues,
      );
    }
    premiereReponse = false;

    /* ------------------------- extraire les données ---------------------- */

    /*
     * Le tableau de produits est cherché de la même façon que dans la sonde :
     * chemin déclaré s'il existe, sinon chemins usuels. `sonde.arrayPath` n'est
     * pas réutilisé tel quel car il a été calculé sans chemin déclaré.
     */
    const tableau = extraireTableau(json, options.mapping);
    if (!tableau) {
      // Dernière page vide : c'est une fin normale pour beaucoup d'API.
      if (pagesLues > 1 && estVide(json)) break;
      return echec(
        'shape',
        'NO_ARRAY',
        `Aucun tableau de produits trouvé à la page ${page}. Vérifiez le chemin configuré.`,
        reponse.status,
        produits,
        rejected,
        pagesLues,
      );
    }

    if (tableau.length === 0) {
      // Tableau vide = fin de pagination. On s'arrête proprement.
      break;
    }

    /* --------------------------- mapper les produits --------------------- */

    let nouveaux = 0;
    for (const element of tableau) {
      if (produits.length >= MAX_PRODUCTS) {
        truncated = true;
        break;
      }
      const mapped = mapProduct(element, options.mapping, options.mapOptions);
      if (!mapped.ok) {
        rejected.push({ index: produits.length + rejected.length, reason: mapped.reason });
        continue;
      }

      // Détection de répétition : si une page entière ne contient que des
      // empreintes déjà vues, l'API ignore la pagination et renvoie tout à
      // chaque fois. Continuer ne ferait que consommer des requêtes.
      const empreinte = `${mapped.product.platformId ?? ''}|${mapped.product.fingerprint}`;
      if (vues.has(empreinte)) continue;
      vues.add(empreinte);
      nouveaux += 1;
      produits.push(mapped.product);
    }

    /*
     * Seuil à 1, et non 2.
     *
     * Une page entièrement composée de produits déjà vus prouve déjà que
     * l'API ne progresse plus : la page suivante sera identique. Attendre une
     * deuxième répétition ne coûte qu'une requête inutile — et, sur une API
     * facturée à l'appel, elle se paie. Le premier test l'a montré : trois
     * requêtes identiques au lieu de deux.
     */
    repetitionsConsecutives = nouveaux === 0 ? repetitionsConsecutives + 1 : 0;
    if (repetitionsConsecutives >= 1) {
      warnings.push(
        `La page ${page} ne contenait que des produits déjà lus : la pagination semble ignorée par l’API, `
        + 'l’import s’arrête ici. Vérifiez le mode de pagination configuré.',
      );
      break;
    }

    /* ------------------------------- suite ------------------------------ */

    nextCursor = extraireCurseur(json, tableau);
    options.onPage?.({
      page,
      read: tableau.length,
      kept: nouveaux,
      rejectedTotal: rejected.length,
      nextCursor,
    });

    if (pagination.kind === 'none') break;
    if (pagination.kind === 'cursor') {
      if (!nextCursor) break; // plus de curseur : fin naturelle
      cursor = nextCursor;
    } else {
      // Une page incomplète signale la dernière page sans requête de trop.
      if (tableau.length < pagination.pageSize) break;
      /*
       * `page` n'est incrémenté QU'APRÈS le test de plafond ci-dessous. Une
       * première version l'incrémentait ici : au plafond atteint, `nextPage`
       * valait une page jamais demandée, et une reprise aurait sauté la
       * dernière page lue. L'incrémentation est donc déplacée en fin de boucle.
       */
    }

    if (pagesLues >= maxPages) {
      truncated = true;
      break;
    }

    // Ici seulement : la page suivante sera effectivement demandée.
    if (pagination.kind === 'page') page += 1;
  }

  if (produits.length >= MAX_PRODUCTS) truncated = true;

  return {
    ok: true,
    products: produits,
    firstIndex: Math.max(0, Math.floor(options.resumeFrom ?? 1) - 1),
    rejected,
    warnings,
    pages: pagesLues,
    truncated,
    nextCursor: pagination.kind === 'cursor' ? nextCursor : null,
    nextPage: pagination.kind === 'page' && truncated ? page + 1 : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Aides                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Modèle d'adresse pour le premier appel en mode curseur.
 *
 * ## Le défaut corrigé
 *
 * La première version passait le modèle tel quel : `?cursor={cursor}` avec un
 * curseur `null` levait « Curseur absent », et **l'import ne démarrait pas du
 * tout**. C'est le premier test d'intégration qui l'a révélé — le mode curseur
 * n'aurait jamais fonctionné, et le symptôme (une erreur de configuration sur
 * une API correctement configurée) aurait été particulièrement trompeur.
 *
 * ## Ce qui est fait
 *
 * Au premier appel, il n'y a pas de curseur à envoyer. On retire donc le
 * PARAMÈTRE entier (`cursor={cursor}`), et pas seulement le marqueur : envoyer
 * `?cursor=` vide est accepté par certaines API et rejeté par d'autres, alors
 * que l'absence du paramètre est la forme canonique d'« à partir du début ».
 *
 * Si le marqueur n'est pas un paramètre isolé (curseur dans le chemin),
 * on le laisse vide : l'API répondra elle-même, et l'erreur sera lisible.
 */
function modelePourCurseur(pagination: PaginationPlan, cursor: string | null): string {
  if (pagination.kind !== 'cursor' || cursor) return pagination.path;
  return pagination.path
    .replace(/[?&]?[a-z0-9_-]*=\{cursor\}/gi, '')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '')
    .replace(/\{cursor\}/g, '');
}

/** Chemins usuels, alignés sur ceux de la sonde. */
const CHEMINS_USUELS = ['', 'data', 'items', 'products', 'data.products', 'data.items', 'data.data', 'results', 'records', 'rows'];

/** Trouve le tableau de produits : chemin déclaré d'abord, sinon usuels. */
function extraireTableau(json: unknown, _mapping: CustomApiMapping): unknown[] | null {
  if (Array.isArray(json)) return json;

  /*
   * On n'utilise PAS le mapping pour deviner le tableau.
   *
   * Le mapping décrit où se trouvent les CHAMPS d'un produit, pas celui du
   * tableau de produits ; s'en servir reviendrait à déduire une structure à
   * partir d'une autre. Les chemins usuels suffisent, et l'utilisateur voit
   * celui qui a marché dans l'aperçu de la sonde.
   */
  for (const chemin of CHEMINS_USUELS) {
    if (!chemin) continue;
    const trouve = lireChemin(json, chemin);
    if (Array.isArray(trouve)) return trouve;
  }
  return null;
}

/** Vrai si la réponse ne contient manifestement rien. */
function estVide(json: unknown): boolean {
  if (json === null || json === undefined) return true;
  if (Array.isArray(json)) return json.length === 0;
  if (typeof json === 'object') return Object.keys(json as object).length === 0;
  return false;
}

/**
 * Cherche un curseur de suite dans la réponse.
 *
 * Trois emplacements couvrent la quasi-totalité des API : `next_cursor`,
 * `nextCursor`, `meta.next_cursor`, `pagination.next_cursor`, `next`.
 * Volontairement pas de recherche récursive : un `next` trouvé au hasard dans
 * un produit serait interprété comme un curseur et ferait boucler l'import.
 */
function extraireCurseur(json: unknown, tableau: unknown[]): string | null {
  void tableau;
  const candidats = [
    'next_cursor',
    'nextCursor',
    'meta.next_cursor',
    'meta.nextCursor',
    'pagination.next_cursor',
    'pagination.nextCursor',
    'next',
  ];
  for (const chemin of candidats) {
    const valeur = lireChemin(json, chemin);
    if (typeof valeur === 'string' && valeur.trim().length > 0) return valeur.trim();
    if (typeof valeur === 'number' && Number.isFinite(valeur)) return String(valeur);
  }
  return null;
}

function codeDepuisSonde(code: string): string {
  switch (code) {
    case 'unauthorized': return 'AUTH_INVALID';
    case 'forbidden': return 'INSUFFICIENT_SCOPE';
    case 'not_found': return 'ENDPOINT_NOT_FOUND';
    case 'not_json': return 'NOT_JSON';
    case 'empty_body': return 'EMPTY_BODY';
    case 'no_array': return 'NO_ARRAY';
    case 'too_large': return 'TOO_LARGE';
    case 'server_error': return 'SERVER_ERROR';
    default: return 'UNEXPECTED_STATUS';
  }
}

function messageDe(cause: unknown): string {
  // Un message d'erreur réseau peut contenir l'URL complète (donc la query) ;
  // il ne contient jamais d'en-tête. On reste bref et générique.
  void cause;
  return 'La boutique n’a pas pu être contactée.';
}

function echec(
  stage: 'http' | 'json' | 'shape' | 'auth' | 'network',
  code: string,
  message: string,
  status: number | undefined,
  products: NormalizedProduct[],
  rejected: Array<{ index: number; reason: string }>,
  pages: number,
): ImportOutcome {
  return {
    ok: false,
    stage,
    code,
    message,
    ...(status !== undefined ? { status } : {}),
    partial: { products, rejected, pages },
  };
}
