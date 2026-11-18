/**
 * Connecteur « API personnalisée » — sonde de configuration.
 *
 * ## Le problème
 *
 * Configurer une API tierce, c'est deviner : le chemin est-il `/products`,
 * `/api/products` ou `/api/v1/products` ? Les produits sont-ils sous
 * `data`, `items`, `products` ? Sans moyen de tester, l'utilisateur enregistre,
 * lance un import, et découvre l'erreur à la fin — après avoir saisi sa clé.
 *
 * Cette sonde répond à trois questions **avant** l'import :
 *   1. l'adresse répond-elle, et avec quel code ?
 *   2. la réponse est-elle du JSON ?
 *   3. où se trouve le tableau de produits dedans ?
 *
 * ## Ce qu'elle ne fait pas
 *
 * Elle **ne contacte rien**. Elle ne reçoit qu'un corps déjà lu par
 * `store-import`, qui applique le contrôle SSRF. Fabriquer un `fetch` ici
 * créerait un second chemin de sortie réseau, c'est-à-dire une seconde faille
 * potentielle à côté de celle qui est testée. La fonction est donc pure et
 * testable sans réseau.
 *
 * ## Aucune exécution de code utilisateur
 *
 * Les chemins de champs (`data.items`) sont lus par accès de propriété
 * littéral, pas évalués. Une clé `__proto__` ou une chaîne comme
 * `constructor.constructor("…")()` n'est jamais interprétée : elle ne désigne
 * aucune propriété, donc elle rend `undefined`. Un accès `eval`/`Function` est
 * absent de ce module, et un test le vérifie.
 */

/** Forme d'une réponse d'API, telle que la sonde la voit. */
export interface ProbeInput {
  /** Code HTTP reçu. 0 = pas de réponse. */
  status: number;
  /** En-tête `content-type` reçu. */
  contentType?: string;
  /** Corps déjà lu et plafonné par l'appelant. */
  body: string;
}

export interface ProbeOutcome {
  ok: boolean;
  /** Code d'erreur stable, pour l'interface et les journaux. */
  code:
    | 'ok'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'server_error'
    | 'not_json'
    | 'empty_body'
    | 'no_array'
    | 'too_large'
    | 'unexpected_status';
  /** Message affichable, sans contenu de la réponse. */
  message: string;
  /** Chemin réellement trouvé pour le tableau de produits. */
  arrayPath?: string;
  /** Nombre d'éléments du tableau, si trouvé. */
  count?: number;
  /** Noms des champs du premier produit : sert à proposer un mapping. */
  sampleFields?: string[];
}

/** Chemins testés, dans l'ordre du plus courant au plus rare. */
export const COMMON_ARRAY_PATHS = [
  '',
  'data',
  'items',
  'products',
  'data.products',
  'data.items',
  'data.data',
  'result',
  'results',
  'payload',
  'content',
  'records',
  'rows',
  'body',
  'list',
];

/** Plafond d'octets accepté pour une réponse de sonde. */
export const MAX_PROBE_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Analyse une réponse et localise le tableau de produits.
 *
 * `declaredPath` est le chemin configuré par l'utilisateur. S'il est fourni et
 * qu'il désigne un tableau, on s'y tient : deviner à sa place rendrait le
 * mapping final imprévisible. Sinon on parcourt les chemins usuels et on
 * rapporte celui qui a marché, pour que l'utilisateur puisse le voir et le
 * corriger.
 */
export function probeResponse(input: ProbeInput, declaredPath?: string): ProbeOutcome {
  if (input.status === 401) {
    return {
      ok: false,
      code: 'unauthorized',
      message: 'L’API a refusé l’authentification (401). Vérifiez la clé ou le mode d’authentification.',
    };
  }
  if (input.status === 403) {
    return {
      ok: false,
      code: 'forbidden',
      message: 'L’API refuse l’accès à cette ressource (403). La clé est peut-être valide mais sans les droits nécessaires.',
    };
  }
  if (input.status === 404) {
    return {
      ok: false,
      code: 'not_found',
      message: 'Aucune ressource à cette adresse (404). Vérifiez le chemin de l’API.',
    };
  }
  if (input.status === 0) {
    return {
      ok: false,
      code: 'unexpected_status',
      message: 'La boutique n’a pas répondu. Vérifiez l’adresse et sa disponibilité.',
    };
  }
  if (input.status >= 500) {
    return {
      ok: false,
      code: 'server_error',
      message: `Le serveur distant a renvoyé une erreur (${input.status}). Vérifiez que l’API fonctionne.`,
    };
  }
  if (input.status < 200 || input.status >= 300) {
    return {
      ok: false,
      code: 'unexpected_status',
      message: `Réponse inattendue (${input.status}). Vérifiez le chemin de l’API.`,
    };
  }

  const corps = (input.body ?? '').trim();
  if (!corps) {
    return { ok: false, code: 'empty_body', message: 'La réponse est vide : cette adresse ne renvoie pas de catalogue.' };
  }
  if (corps.length > MAX_PROBE_BODY_BYTES) {
    return { ok: false, code: 'too_large', message: 'La réponse est trop volumineuse pour être analysée.' };
  }

  const type = (input.contentType ?? '').toLowerCase();
  if (type && !type.includes('json') && !corps.startsWith('{') && !corps.startsWith('[')) {
    return {
      ok: false,
      code: 'not_json',
      message: `La réponse n’est pas du JSON (${type.split(';')[0]}). Vérifiez que l’adresse pointe bien vers l’API et non vers la page d’accueil.`,
    };
  }

  let analyse: unknown;
  try {
    analyse = JSON.parse(corps);
  } catch {
    return { ok: false, code: 'not_json', message: 'La réponse n’est pas du JSON valide : elle est peut-être tronquée.' };
  }

  // Cas direct : le corps EST le tableau.
  if (Array.isArray(analyse)) {
    return {
      ok: true,
      code: 'ok',
      message: 'Réponse lue : le corps contient directement un tableau de produits.',
      arrayPath: '',
      count: analyse.length,
      sampleFields: champsPremierElement(analyse),
    };
  }

  if (declaredPath !== undefined && declaredPath !== '') {
    const trouve = lireChemin(analyse, declaredPath);
    if (Array.isArray(trouve)) {
      return {
        ok: true,
        code: 'ok',
        message: `Réponse lue : le chemin « ${declaredPath} » contient le tableau.`,
        arrayPath: declaredPath,
        count: trouve.length,
        sampleFields: champsPremierElement(trouve),
      };
    }
    return {
      ok: false,
      code: 'no_array',
      message: `Le chemin « ${declaredPath} » n’a pas donné de tableau. Vérifiez la structure de la réponse.`,
    };
  }

  for (const chemin of COMMON_ARRAY_PATHS) {
    if (chemin === '') continue;
    const trouve = lireChemin(analyse, chemin);
    if (Array.isArray(trouve)) {
      return {
        ok: true,
        code: 'ok',
        // On rapporte le chemin pour que l'utilisateur puisse le VERIFIER, pas
        // pour qu'il le croie sur parole : il le voit dans l'interface.
        message: `Réponse lue : le tableau de produits se trouve sous « ${chemin} ».`,
        arrayPath: chemin,
        count: trouve.length,
        sampleFields: champsPremierElement(trouve),
      };
    }
  }

  return {
    ok: false,
    code: 'no_array',
    message: 'La réponse est du JSON valide mais aucun tableau de produits n’y a été trouvé. '
      + 'Indiquez dans quel champ se trouvent les produits.',
  };
}

/**
 * Lit un chemin de propriétés, sans interpréter quoi que ce soit.
 *
 * `data.items` est découpé sur les points et parcouru propriété par propriété.
 * Aucun `eval`, aucune `Function`, aucun `Proxy`. Une clé inconnue rend
 * `undefined`, ce qui est le résultat attendu — pas une erreur d'exécution.
 *
 * Les clés `__proto__`, `constructor` et `prototype` sont explicitement
 * ignorées : les laisser traverser permettrait de lire des propriétés du
 * prototype au lieu de données, et de faire croire à un tableau qui n'existe
 * pas dans la réponse.
 */
export function lireChemin(racine: unknown, chemin: string): unknown {
  const interdit = new Set(['__proto__', 'constructor', 'prototype']);
  let courant: unknown = racine;
  for (const segment of chemin.split('.')) {
    if (!segment) return undefined;
    if (interdit.has(segment)) return undefined;
    if (courant === null || typeof courant !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(courant, segment)) return undefined;
    courant = (courant as Record<string, unknown>)[segment];
  }
  return courant;
}

/** Noms des champs du premier élément, pour proposer un mapping. */
function champsPremierElement(tableau: unknown[]): string[] {
  const premier = tableau[0];
  if (!premier || typeof premier !== 'object' || Array.isArray(premier)) return [];
  return Object.keys(premier as Record<string, unknown>).slice(0, 40);
}

/* -------------------------------------------------------------------------- */
/* Les trois variables de substitution                                        */
/* -------------------------------------------------------------------------- */

/**
 * Remplace `{page}`, `{limit}` et `{cursor}` dans un modèle d'URL.
 *
 * ## Pourquoi une substitution littérale et pas un moteur de gabarit
 *
 * Un moteur de gabarit (`{a.b}`, filtres, expressions) exécuterait des
 * expressions fournies par l'utilisateur. Ici trois marqueurs, trois
 * remplacements, et rien d'autre : aucune valeur ne peut produire autre chose
 * qu'une URL.
 *
 * ## Les valeurs sont contrôlées
 * `page` et `limit` doivent être des entiers positifs ; `cursor` est
 * percent-encodé. Un curseur contenant `&admin=1` ne peut donc pas ajouter un
 * paramètre.
 */
export function substituerPagination(
  modele: string,
  valeurs: { page?: number; limit?: number; cursor?: string | null },
): string {
  let url = modele;

  if (url.includes('{page}')) {
    if (valeurs.page === undefined || !Number.isInteger(valeurs.page) || valeurs.page < 1) {
      throw new Error('Numéro de page invalide.');
    }
    url = url.split('{page}').join(String(valeurs.page));
  }
  if (url.includes('{limit}')) {
    if (valeurs.limit === undefined || !Number.isInteger(valeurs.limit) || valeurs.limit < 1) {
      throw new Error('Taille de page invalide.');
    }
    url = url.split('{limit}').join(String(valeurs.limit));
  }
  if (url.includes('{cursor}')) {
    if (!valeurs.cursor) throw new Error('Curseur absent : la pagination ne peut pas continuer.');
    url = url.split('{cursor}').join(encodeURIComponent(valeurs.cursor));
  }

  // Un marqueur inconnu est une erreur de configuration, pas une valeur à
  // laisser passer telle quelle dans l'URL.
  const restant = /\{[a-z_]+\}/i.exec(url);
  if (restant) throw new Error(`Marqueur inconnu dans l’adresse : ${restant[0]}`);

  return url;
}

/** Type de pagination supporté. Volontairement peu nombreux. */
export type PaginationKind = 'page' | 'cursor' | 'none';

/** Vrai si le modèle contient le marqueur attendu pour ce type. */
export function paginationCoherente(kind: PaginationKind, modele: string): { ok: boolean; message?: string } {
  switch (kind) {
    case 'page':
      if (!modele.includes('{page}')) {
        return { ok: false, message: 'La pagination par page exige le marqueur {page} dans l’adresse.' };
      }
      return { ok: true };
    case 'cursor':
      if (!modele.includes('{cursor}')) {
        return { ok: false, message: 'La pagination par curseur exige le marqueur {cursor} dans l’adresse.' };
      }
      return { ok: true };
    case 'none':
      return { ok: true };
    default:
      return { ok: false, message: 'Type de pagination inconnu.' };
  }
}
