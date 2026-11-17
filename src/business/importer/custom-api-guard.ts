/**
 * Connecteur « API personnalisée » — garde d'adresse et politique d'en-têtes.
 *
 * ## Le problème, énoncé sans détour
 *
 * Ce connecteur laisse un utilisateur désigner **lui-même** l'adresse que le
 * serveur VYORA va interroger. C'est exactement la définition d'une SSRF : si
 * l'adresse n'est pas contrôlée, un utilisateur peut faire appeler par nos
 * serveurs `https://169.254.169.254/latest/meta-data/` (métadonnées cloud),
 * `https://10.0.0.5/` (réseau interne) ou `https://interne.entreprise.local/`,
 * et lire la réponse — ou seulement son code — depuis l'interface.
 *
 * ## Ce que fait ce module, et ce qu'il ne fait PAS
 *
 * Il valide la **forme** : schéma, port, absence d'identifiants dans l'URL,
 * absence de fragment, hôte public, chemin prévisible, et hôte identique à
 * celui configuré.
 *
 * Il **ne fait pas** la résolution DNS, et c'est délibéré : la validation de
 * l'adresse IP doit avoir lieu au moment de la connexion, sur l'adresse
 * réellement contactée, sinon un rebinding DNS passe entre les mailles. Ce
 * contrôle existe déjà, une seule fois, dans `safe-egress.ts` +
 * `pinned-fetch.ts`, et ce module ne le duplique pas — une deuxième
 * implémentation de sécurité qui divergerait serait pire que pas de deuxième.
 *
 * ## Ce module est utilisé à DEUX endroits
 *
 * 1. Côté navigateur, pour un retour immédiat sur la saisie ;
 * 2. côté Edge Function, **à chaque requête**, avec les valeurs relues du
 *    stockage — jamais celles envoyées par le client. Un formulaire peut mentir.
 */

import { isPublicHostname, type UrlRejection } from './url-guard';

/** Ce qui peut être refusé dans une configuration d'API personnalisée. */
export type CustomApiRejection =
  | UrlRejection
  | 'not_absolute'
  | 'path_dot_segments'
  | 'path_control_chars'
  | 'path_too_long'
  | 'host_not_allowed'
  | 'header_not_allowed'
  | 'header_value_invalid'
  | 'header_too_long'
  | 'too_many_headers';

export type CustomApiCheck<T> = { ok: true; value: T } | { ok: false; reason: CustomApiRejection; detail?: string };

/** Longueur maximale d'une URL d'endpoint. Au-delà, ce n'est plus une URL. */
export const MAX_ENDPOINT_URL_LENGTH = 2048;

/** Longueur maximale d'une valeur d'en-tête (RFC 7230 recommande 8 Ko par ligne). */
export const MAX_HEADER_VALUE_LENGTH = 512;

/** Nombre maximal d'en-têtes personnalisés. Trois suffisent à tous les cas réels. */
export const MAX_CUSTOM_HEADERS = 5;

/**
 * En-têtes qu'un utilisateur peut faire envoyer.
 *
 * ## Pourquoi une liste blanche, et pas une liste noire
 *
 * Une liste noire d'en-têtes interdits (`Host`, `Connection`, `Content-Length`,
 * `Transfer-Encoding`…) serait toujours incomplète : il suffirait d'un en-tête
 * oublié, ou d'une variante de casse, pour casser le message HTTP. Une liste
 * blanche a l'avantage inverse : ce qui n'y est pas n'est pas envoyé, même si
 * personne n'y a pensé.
 *
 * Les noms retenus sont ceux des API de catalogue réelles. Tous transportent un
 * secret, et c'est précisément pour cela qu'ils sont autorisés — un en-tête
 * personnel sans secret n'a pas d'usage ici.
 */
export const ALLOWED_AUTH_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-shopify-access-token',
  'x-restli-protocol-version',
] as const;

export type AllowedAuthHeader = (typeof ALLOWED_AUTH_HEADERS)[number];

/** En-têtes qu'il ne faut jamais laisser passer, même s'ils ressemblaient à la liste blanche. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
]);

export interface CustomApiEndpoint {
  /** URL absolue, https, sans fragment ni identifiants. */
  url: URL;
  /** Chemin réellement utilisé, query comprise. */
  path: string;
}

/**
 * Valide l'**adresse de base** d'une API personnalisée.
 *
 * C'est la seule adresse dont l'hôte sera retenu : toutes les requêtes du
 * connecteur devront rester sur cet hôte.
 */
export function parseCustomApiBaseUrl(input: string): CustomApiCheck<URL> {
  const resultat = parseCandidate(input);
  if (!resultat.ok) return resultat;
  const url = resultat.value;

  // Une base sert de préfixe : elle ne porte pas de query. L'accepter
  // donnerait deux sources de paramètres concaténées, donc ambiguës.
  if (url.search) {
    return { ok: false, reason: 'invalid_url', detail: 'L’adresse de base ne doit pas comporter de paramètres (?…).' };
  }

  return { ok: true, value: url };
}

/**
 * Valide une URL d'endpoint **contre** l'hôte de la base.
 *
 * ## La règle d'hôte unique
 *
 * Un endpoint relatif (`/api/products`) est résolu contre la base. Un endpoint
 * absolu n'est accepté que s'il désigne **le même hôte** que la base. Sans cette
 * règle, la configuration pourrait désigner `https://evil.example/` comme
 * endpoint alors que la base — la seule adresse montrée à l'utilisateur et
 * vérifiée à la connexion — pointe ailleurs. L'utilisateur croirait parler à son
 * serveur et le connecteur parlerait à un autre.
 *
 * C'est aussi ce qui garantit qu'une redirection ne peut pas être exploitée :
 * `safe-egress` la refuse de toute façon, mais la limiter à l'hôte configuré
 * ajoute une couche indépendante.
 */
export function parseCustomApiEndpoint(base: URL, input: string, allowAbsolute = true): CustomApiCheck<CustomApiEndpoint> {
  const brut = (input ?? '').trim();
  if (!brut) return { ok: false, reason: 'not_absolute', detail: 'Indiquez un chemin d’API.' };

  /*
   * 1) Contrôles sur la SAISIE, avant toute analyse.
   *
   * Cette étape existe parce que `new URL()` **réécrit** ce qu'on lui donne :
   *   - il supprime les tabulations et les sauts de ligne ;
   *   - il percent-encode les autres caractères de contrôle (`\u0007` devient
   *     `%07`) ;
   *   - il décode `%2e` en `.` ;
   *   - il normalise `..`.
   *
   * Un contrôle placé après analyse examine donc une valeur déjà modifiée par
   * l'analyseur, et ne voit plus ce qui a été introduit. C'est exactement le
   * piège dans lequel une première version de ce module était tombée : le
   * contrôle « caractères de contrôle » ne refusait rien. On vérifie donc la
   * saisie brute d'abord.
   */
  if (/[\u0000-\u001f\u007f]/.test(brut)) {
    // Les caractères de contrôle n'ont aucun usage légitime dans un chemin
    // d'API : saut de ligne (injection d'en-tête), NUL (troncature côté
    // serveur), tabulation (ignorée par l'analyseur).
    return { ok: false, reason: 'path_control_chars' };
  }
  if (/%2e/i.test(brut)) {
    // `%2e%2e` : l'analyseur le décode en `..` et le normalise, donc le chemin
    // appelé est déjà propre — mais la SAISIE ne l'était pas, et un
    // utilisateur qui écrit cela cherche à sortir du préfixe d'API. On refuse
    // plutôt que de deviner l'intention.
    return { ok: false, reason: 'path_dot_segments' };
  }
  /*
   * Double barre dans le CHEMIN (la query est exclue : `?url=https://…` est un
   * paramètre légitime). Dans le chemin, `//` est traité comme un hôte par le
   * parseur (`//evil.example/x`) : c'est un contournement de la règle d'hôte
   * unique.
   */
  const cheminSeul = brut.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('?')[0].split('#')[0];
  if (cheminSeul.includes('//')) {
    return { ok: false, reason: 'host_not_allowed', detail: 'Une adresse sans schéma mais avec un hôte est refusée.' };
  }

  /*
   * 2) Analyse et contrôles communs.
   *
   * Les deux chemins — absolu et relatif — passent par la MÊME validation
   * (`parseCandidate`). Une première version validait l'absolu et se contentait
   * d'analyser le relatif : un chemin relatif pouvait donc porter un fragment,
   * des identifiants ou un port que l'absolu aurait refusés.
   */
  let url: URL;
  const absolu = /^[a-z][a-z0-9+.-]*:\/\//i.test(brut);
  if (absolu) {
    if (!allowAbsolute) {
      return { ok: false, reason: 'not_absolute', detail: 'Un chemin relatif est attendu ici.' };
    }
    const resultat = parseCandidate(brut);
    if (!resultat.ok) return resultat;
    url = resultat.value;
  } else {
    // `brut` est relatif : on le résout contre la base, puis on valide l'URL
    // obtenue avec les mêmes règles qu'une URL absolue. Le schéma, le port et
    // l'hôte viennent de la base — déjà validée — mais la revalidation ne coûte
    // rien et garantit qu'aucun chemin ne contourne les contrôles.
    let candidate: URL;
    try {
      candidate = new URL(brut, base);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    const resultat = parseCandidate(candidate.href);
    if (!resultat.ok) return resultat;
    url = resultat.value;

    // `%2e` a pu apparaître par normalisation de la base ; on contrôlait déjà la
    // saisie, mais le chemin final doit rester sans segment « . » encodé.
    if (/%2e/i.test(url.pathname)) return { ok: false, reason: 'path_dot_segments' };
  }

  // L'hôte de l'endpoint doit être celui de la base. Comparaison sur le
  // hostname normalisé, jamais sur la chaîne brute.
  if (url.hostname.toLowerCase() !== base.hostname.toLowerCase()) {
    return {
      ok: false,
      reason: 'host_not_allowed',
      detail: `L’endpoint doit rester sur ${base.hostname} : un autre hôte n’est jamais interrogé.`,
    };
  }

  if (url.href.length > MAX_ENDPOINT_URL_LENGTH) {
    return { ok: false, reason: 'path_too_long' };
  }

  return { ok: true, value: { url, path: `${url.pathname}${url.search}` } };
}

/** Partie commune aux deux validations : schéma, port, hôte public. */
function parseCandidate(input: string): CustomApiCheck<URL> {
  const brut = (input ?? '').trim();
  if (!brut) return { ok: false, reason: 'empty' };
  if (brut.length > MAX_ENDPOINT_URL_LENGTH) return { ok: false, reason: 'path_too_long' };
  /*
   * Les caractères de contrôle sont contrôlés sur la SAISIE, avant analyse.
   *
   * C'est une correction de test : `new URL()` retire silencieusement un NUL,
   * si bien qu'un contrôle placé après analyse ne voyait plus rien à refuser.
   * Une garde qui examine une valeur déjà nettoyée par l'analyseur ne garde
   * rien.
   */
  if (/[\u0000-\u001f\u007f]/.test(brut)) return { ok: false, reason: 'path_control_chars' };

  let url: URL;
  try {
    url = new URL(brut);
  } catch {
    return { ok: false, reason: 'not_absolute', detail: 'L’adresse doit être complète (https://…).' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'non_standard_port' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.hash) return { ok: false, reason: 'has_fragment' };

  // Délègue à la garde existante : IPv4 déguisée, IPv6 littéral, `.local`,
  // `.internal`, nom à label unique… Une seule implémentation, réutilisée.
  const hote = isPublicHostname(url.hostname);
  if (!hote.ok) return { ok: false, reason: hote.reason };

  return { ok: true, value: url };
}

/* -------------------------------------------------------------------------- */
/* En-têtes d'authentification                                                */
/* -------------------------------------------------------------------------- */

export interface HeaderPolicyResult {
  /** En-têtes retenus, dans l'ordre d'envoi. */
  headers: Array<{ name: AllowedAuthHeader; value: string }>;
  /** En-têtes écartés, avec la raison — pour l'avertir, pas pour l'ignorer. */
  rejected: Array<{ name: string; reason: CustomApiRejection }>;
}

/**
 * Applique la politique d'en-têtes à une configuration utilisateur.
 *
 * ## Pourquoi écarter au lieu de tout refuser
 *
 * Un utilisateur qui configure `X-Custom-Auth` doit savoir pourquoi il n'est pas
 * envoyé, sinon il voit une erreur 401 sans comprendre. On renvoie donc la liste
 * des refus, que l'interface affiche **avant** l'enregistrement. Le serveur, lui,
 * n'envoie que `headers` — les refus sont une information, pas une autorisation.
 *
 * ## Ce qui est contrôlé sur la valeur
 * Un saut de ligne dans une valeur d'en-tête permet d'injecter des en-têtes
 * supplémentaires dans le message HTTP (CRLF injection). C'est la raison pour
 * laquelle la vérification est ici, et **de nouveau** dans `buildRequest`, qui
 * ne fait par ailleurs confiance à aucun appelant.
 */
export function applyHeaderPolicy(
  brut: Array<{ name: string; value: string }> | undefined | null,
): HeaderPolicyResult {
  const headers: HeaderPolicyResult['headers'] = [];
  const rejected: HeaderPolicyResult['rejected'] = [];
  const vus = new Set<string>();

  for (const entree of brut ?? []) {
    const nom = String(entree?.name ?? '').trim().toLowerCase();
    const valeur = String(entree?.value ?? '');

    if (!nom) {
      rejected.push({ name: String(entree?.name ?? ''), reason: 'header_not_allowed' });
      continue;
    }
    if (FORBIDDEN_HEADERS.has(nom)) {
      rejected.push({ name: nom, reason: 'header_not_allowed' });
      continue;
    }
    if (!(ALLOWED_AUTH_HEADERS as readonly string[]).includes(nom)) {
      rejected.push({ name: nom, reason: 'header_not_allowed' });
      continue;
    }
    // Un nom autorisé en double créerait deux lignes du même en-tête : le
    // premier gagne, le second est signalé plutôt que silencieusement perdu.
    if (vus.has(nom)) {
      rejected.push({ name: nom, reason: 'header_value_invalid' });
      continue;
    }
    if (valeur.trim().length === 0) {
      rejected.push({ name: nom, reason: 'header_value_invalid' });
      continue;
    }
    if (/[\r\n\u0000]/.test(valeur)) {
      rejected.push({ name: nom, reason: 'header_value_invalid' });
      continue;
    }
    if (valeur.length > MAX_HEADER_VALUE_LENGTH) {
      rejected.push({ name: nom, reason: 'header_too_long' });
      continue;
    }
    if (headers.length >= MAX_CUSTOM_HEADERS) {
      rejected.push({ name: nom, reason: 'too_many_headers' });
      continue;
    }

    vus.add(nom);
    headers.push({ name: nom as AllowedAuthHeader, value: valeur });
  }

  return { headers, rejected };
}

/**
 * Construit l'en-tête `Authorization` à partir du mode d'authentification.
 *
 * Les modes sont volontairement peu nombreux : chacun correspond à une pratique
 * réellement rencontrée sur les API de catalogue. Un mode « autre » ouvert
 * reviendrait à laisser l'utilisateur composer un en-tête arbitraire — ce que la
 * liste blanche ci-dessus interdit déjà.
 */
export type AuthScheme = 'none' | 'bearer' | 'header' | 'basic';

export interface AuthConfig {
  scheme: AuthScheme;
  /** Jeton ou `utilisateur:motdepasse` pour `basic`. Jamais journalisé. */
  secret?: string;
  /** Nom d'en-tête pour `scheme: 'header'`. */
  headerName?: string;
}

/**
 * Traduit une configuration d'authentification en en-têtes concrets.
 *
 * Le secret n'est **jamais** inclus dans la valeur de retour autrement que sous
 * la forme qu'il doit prendre sur le réseau. Aucun appelant ne doit afficher le
 * résultat : `redactHeaders` existe pour ça.
 */
export function buildAuthHeaders(auth: AuthConfig): HeaderPolicyResult {
  const rejected: HeaderPolicyResult['rejected'] = [];
  const secret = String(auth.secret ?? '');

  if (auth.scheme === 'none') {
    return { headers: [], rejected };
  }

  if (!secret.trim()) {
    return { headers: [], rejected: [{ name: auth.scheme, reason: 'header_value_invalid' }] };
  }
  if (/[\r\n\u0000]/.test(secret)) {
    // Un secret contenant un saut de ligne est soit une erreur de copie, soit
    // une tentative d'injection. Dans les deux cas, il ne part pas.
    return { headers: [], rejected: [{ name: auth.scheme, reason: 'header_value_invalid' }] };
  }
  if (secret.length > MAX_HEADER_VALUE_LENGTH) {
    return { headers: [], rejected: [{ name: auth.scheme, reason: 'header_too_long' }] };
  }

  switch (auth.scheme) {
    case 'bearer':
      return { headers: [{ name: 'authorization', value: `Bearer ${secret}` }], rejected };

    case 'basic': {
      // `btoa` n'existe pas dans tous les contextes d'exécution : on encode en
      // UTF-8 puis en base64 sans dépendre du DOM.
      const octets = new TextEncoder().encode(secret);
      let binaire = '';
      for (const octet of octets) binaire += String.fromCharCode(octet);
      const encode = typeof btoa === 'function'
        ? btoa(binaire)
        : // Repli Deno/Node : `Buffer` n'existe pas forcément non plus, mais
          // l'Edge Function fournit `btoa` via `globalThis`. On échoue
          // explicitement plutôt que d'envoyer un en-tête mal encodé.
          (() => { throw new Error('Encodage base64 indisponible.'); })();
      return { headers: [{ name: 'authorization', value: `Basic ${encode}` }], rejected };
    }

    case 'header': {
      const nom = String(auth.headerName ?? '').trim().toLowerCase();
      if (!(ALLOWED_AUTH_HEADERS as readonly string[]).includes(nom) || nom === 'authorization') {
        return {
          headers: [],
          rejected: [{ name: nom || 'header', reason: 'header_not_allowed' }],
        };
      }
      return { headers: [{ name: nom as AllowedAuthHeader, value: secret }], rejected };
    }

    default:
      return { headers: [], rejected: [{ name: String(auth.scheme), reason: 'header_not_allowed' }] };
  }
}

/**
 * Rend des en-têtes affichables : les valeurs secrètes sont remplacées.
 *
 * Sert à tout journal, tout message d'erreur et tout affichage de diagnostic. Un
 * en-tête `Authorization` ne doit apparaître nulle part avec sa valeur, même
 * tronquée : une clé tronquée à 8 caractères reste une fuite partielle.
 */
export function redactHeaders(headers: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  return headers.map((entree) => ({
    name: entree.name,
    // On conserve la FORME (schéma, longueur) sans le contenu : c'est ce qui
    // aide à diagnostiquer sans divulguer.
    value: redactHeaderValue(entree.name, entree.value),
  }));
}

function redactHeaderValue(name: string, value: string): string {
  const schema = /^(Bearer|Basic|Token)\s+/i.exec(value);
  if (schema) return `${schema[1]} ••••(${value.length - schema[0].length} car.)`;
  if (name.toLowerCase() === 'authorization') return `••••(${value.length} car.)`;
  return `••••(${value.length} car.)`;
}

/** Message affichable pour un refus de configuration. */
export function explainCustomApiRejection(reason: CustomApiRejection): string {
  switch (reason) {
    case 'not_absolute':
      return 'Indiquez une adresse complète, commençant par https://.';
    case 'path_dot_segments':
      return 'Retirez les segments « . » et « .. » du chemin.';
    case 'path_control_chars':
      return 'Le chemin contient des caractères de contrôle.';
    case 'path_too_long':
      return 'Cette adresse est trop longue.';
    case 'host_not_allowed':
      return 'L’adresse doit rester sur le domaine que vous avez configuré.';
    case 'header_not_allowed':
      return 'Cet en-tête n’est pas autorisé. Utilisez un en-tête d’authentification standard.';
    case 'header_value_invalid':
      return 'La valeur de l’en-tête est vide ou contient un caractère interdit.';
    case 'header_too_long':
      return 'La valeur de l’en-tête est trop longue.';
    case 'too_many_headers':
      return `Cinq en-têtes personnalisés au maximum.`;
    default:
      // Les refus d'URL réutilisent les messages déjà écrits pour les boutiques.
      return explainUrlRejection(reason);
  }
}

/** Sous-ensemble d'`explainRejection` pour les cas atteignables ici. */
function explainUrlRejection(reason: CustomApiRejection): string {
  switch (reason) {
    case 'empty': return 'Indiquez une adresse.';
    case 'invalid_url': return 'Cette adresse n’est pas valide.';
    case 'not_https': return 'Seules les adresses HTTPS sont acceptées.';
    case 'non_standard_port': return 'Seul le port 443 est accepté.';
    case 'credentials_in_url': return 'Une adresse ne doit pas contenir d’identifiants.';
    case 'has_fragment': return 'Retirez le fragment (#…) de l’adresse.';
    case 'ip_literal': return 'Les adresses IP ne sont pas acceptées : utilisez un nom de domaine.';
    case 'reserved_hostname': return 'Cette adresse désigne un réseau local ou réservé : elle ne sera pas contactée.';
    case 'single_label': return 'Indiquez un nom de domaine complet (ex. boutique.com).';
    case 'private_address': return 'Cette adresse pointe vers un réseau privé : refusé.';
    case 'no_addresses': return 'Le domaine n’a pas pu être résolu.';
    default: return 'Configuration refusée.';
  }
}
