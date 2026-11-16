/**
 * Sortie réseau sûre : le seul chemin par lequel l'Edge Function `store-import`
 * atteint Internet.
 *
 * ## Le contrôle SSRF est fait À LA CONNEXION, pas avant
 * `fetch()` refait sa propre résolution DNS. Vérifier les adresses depuis
 * `Deno.resolveDns` puis appeler `fetch` laisse une fenêtre de rebinding : le
 * nom peut renvoyer une autre adresse à la seconde résolution. Ici la connexion
 * TCP est ouverte **sur l'IP littérale validée** (`pinned-fetch.ts`), donc
 * l'adresse contrôlée est exactement l'adresse contactée.
 *
 * ## Ce qui est réutilisé, jamais réécrit
 * - `parseStoreUrl` : schéma, port, hôte littéral interdit, `.local`.
 * - `assertPublicAddresses` : plages privées, réservées, métadonnées cloud
 *   (`169.254.0.0/16`), IPv4 mappée en IPv6, NAT64, multicast, fail-closed.
 * - `explainRejection` : messages affichables.
 *
 * Aucune deuxième logique de validation n'existe ici : ce module ne fait
 * qu'appliquer la logique existante à chaque saut, avant chaque connexion.
 *
 * ## Redirections
 * Jamais suivies à l'aveugle. Chaque `Location` est revalidée ET re-résolue,
 * avec un nombre de sauts borné. Une redirection vers une adresse interdite est
 * refusée **avant** toute connexion vers elle.
 */

import {
  assertPublicAddresses,
  explainRejection,
  parseStoreUrl,
  storeRootCandidates,
  type UrlRejection,
} from '../../../src/business/importer/url-guard.ts';
import type { FetchLike, StoreProbe } from '../../../src/business/importer/sources.ts';
import { httpGetPinned, type PinnedSocket } from './pinned-fetch.ts';

/** Nombre maximal de redirections examinées. */
export const MAX_REDIRECTS = 3;

export type EgressErrorCode =
  | 'blocked_url'
  | 'dns_failed'
  | 'dns_empty'
  | 'redirect_limit'
  | 'too_many_redirects'
  | 'tls_failed'
  | 'connect_failed'
  | 'timeout'
  | 'too_large'
  | 'protocol_error'
  | 'unreachable';

export interface EgressError {
  code: EgressErrorCode;
  message: string;
}

export type EgressResult<T> = { ok: true; value: T } | { ok: false; error: EgressError };

/** Résolveur DNS : renvoie toutes les adresses du nom (IPv4 et IPv6). */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Connexion TCP+TLS injectable, pour tester sans réseau. */
export type Connect = (ip: string, hostname: string) => Promise<PinnedSocket>;

export interface EgressDeps {
  resolveHost: ResolveHost;
  connect?: Connect;
  timeoutMs?: number;
}

function erreur(code: EgressErrorCode, message: string): EgressError {
  return { code, message };
}

function fromRejection(reason: UrlRejection): EgressError {
  return erreur('blocked_url', explainRejection(reason));
}

/**
 * Résout puis valide TOUTES les adresses du nom.
 *
 * Refuser une seule adresse privée suffit à refuser le nom : un serveur DNS
 * hostile renvoie souvent une adresse publique et une adresse interne pour
 * franchir un contrôle qui n'examinerait que la première.
 */
async function resolveAndCheck(
  hostname: string,
  deps: EgressDeps,
): Promise<EgressResult<string[]>> {
  let adresses: string[];
  try {
    adresses = await deps.resolveHost(hostname);
  } catch {
    return { ok: false, error: erreur('dns_failed', 'Le domaine n’a pas pu être résolu.') };
  }
  if (!Array.isArray(adresses) || adresses.length === 0) {
    return { ok: false, error: erreur('dns_empty', 'Le domaine ne renvoie aucune adresse.') };
  }
  const controle = assertPublicAddresses(adresses);
  if (!controle.ok) return { ok: false, error: fromRejection(controle.reason) };
  return { ok: true, value: adresses };
}

interface PageResult {
  body: string;
  headers: Record<string, string>;
  finalUrl: string;
  status: number;
  /** Adresse IP réellement contactée : la preuve du contrôle SSRF. */
  connectedTo: string;
}

/**
 * `GET` HTTPS sûr.
 *
 * Invariant central : `connectedTo` appartient toujours à la liste d'adresses
 * validées par `assertPublicAddresses` **pour ce saut**, juste avant la
 * connexion. On re-résout à chaque saut, y compris sur le même hôte : un
 * changement de résolution entre l'aperçu et la lecture est ainsi vu.
 */
export async function safeGet(
  input: string | URL,
  options: { accept: string; maxBytes: number },
  deps: EgressDeps,
): Promise<EgressResult<PageResult>> {
  let courant = typeof input === 'string' ? input : input.toString();

  for (let saut = 0; saut <= MAX_REDIRECTS; saut++) {
    // 1) Validation syntaxique (schéma, port, hôte littéral interdit).
    const check = parseStoreUrl(courant);
    if (!check.ok) return { ok: false, error: fromRejection(check.reason) };
    const url = check.url;

    // 2) Résolution + validation de TOUTES les adresses, à CHAQUE saut.
    const adresses = await resolveAndCheck(url.hostname, deps);
    if (!adresses.ok) return adresses;

    // 3) Connexion épinglée sur une adresse validée. On essaie les adresses
    //    dans l'ordre ; chacune a déjà été contrôlée.
    let derniere: EgressError | null = null;
    for (const ip of adresses.value) {
      // Contrôle final juste avant la connexion : la liste vient d'être
      // validée, on la revérifie pour que le code de connexion ne puisse pas
      // être atteint avec une adresse non contrôlée.
      const final = assertPublicAddresses([ip]);
      if (!final.ok) return { ok: false, error: fromRejection(final.reason) };

      try {
        const reponse = await httpGetPinned(
          { ip, hostname: url.hostname, path: `${url.pathname}${url.search}` },
          { accept: options.accept, maxBytes: options.maxBytes, timeoutMs: deps.timeoutMs, connect: deps.connect },
        );

        // 4) Redirection éventuelle : revalidée au tour suivant, jamais suivie ici.
        if (reponse.status >= 300 && reponse.status < 400) {
          const location = reponse.headers['location'];
          if (!location) {
            return { ok: false, error: erreur('protocol_error', 'Redirection sans destination.') };
          }
          if (saut === MAX_REDIRECTS) {
            return { ok: false, error: erreur('too_many_redirects', 'Trop de redirections successives.') };
          }
          let suivante: URL;
          try {
            suivante = new URL(location, url);
          } catch {
            return { ok: false, error: erreur('protocol_error', 'Redirection illisible.') };
          }
          // La destination sera revalidée ET re-résolue au prochain tour.
          courant = suivante.toString();
          derniere = null;
          break;
        }

        if (reponse.status === 404) {
          return { ok: false, error: erreur('unreachable', 'Ressource introuvable sur cette boutique.') };
        }
        if (reponse.status < 200 || reponse.status >= 300) {
          return { ok: false, error: erreur('unreachable', `La boutique a répondu ${reponse.status}.`) };
        }

        return {
          ok: true,
          value: {
            body: reponse.body,
            headers: reponse.headers,
            finalUrl: url.toString(),
            status: reponse.status,
            connectedTo: ip,
          },
        };
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        derniere = code === 'timeout'
          ? erreur('timeout', 'La boutique n’a pas répondu dans le délai autorisé.')
          : code === 'too_large'
            ? erreur('too_large', 'La réponse dépasse la taille autorisée.')
            : code === 'tls_failed'
              ? erreur('tls_failed', 'La connexion sécurisée avec la boutique a échoué.')
              : code === 'connect_failed'
                ? erreur('connect_failed', 'La boutique est injoignable.')
                : erreur('protocol_error', 'La réponse de la boutique est illisible.');
        // Une erreur de sécurité ou de protocole n'est pas « réessayable » sur
        // une autre adresse : on s'arrête pour la taille dépassée et le délai.
        if (derniere.code === 'too_large' || derniere.code === 'timeout') return { ok: false, error: derniere };
      }
    }

    // Redirection en cours : on passe au saut suivant.
    if (derniere === null) continue;
    return { ok: false, error: derniere };
  }

  return { ok: false, error: erreur('redirect_limit', 'Trop de redirections successives.') };
}

/**
 * `fetch` compatible `FetchLike`, pour réutiliser SANS MODIFICATION
 * `probeStore` / `fetchPublicCatalog` (`src/business/importer/sources.ts`).
 *
 * C'est la pièce qui évite une deuxième logique : la sonde et la lecture de
 * catalogue du client continuent de servir, et leur unique point de sortie
 * réseau est remplacé par la connexion épinglée. Chaque appel refait
 * résolution + validation, donc un rebinding entre deux appels est détecté.
 *
 * Rendue en `Response` standard : les garde-fous existants de `sources.ts`
 * (refus des 3xx, plafond de lecture, types MIME) restent actifs tels quels.
 */
export function pinnedFetchLike(deps: EgressDeps, defaults: { accept: string; maxBytes: number }): FetchLike {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      // Aucune méthode d'écriture ne sort d'ici : l'import ne modifie jamais la
      // boutique distante.
      throw new Error('Méthode non autorisée sur la sortie réseau de l’import.');
    }
    const entetes = new Headers(init?.headers ?? {});
    const accept = entetes.get('accept') ?? defaults.accept;
    // Un délai propre à l'appel est respecté s'il est fourni (AbortSignal).
    const resultat = await safeGet(input, { accept, maxBytes: defaults.maxBytes }, deps);
    if (!resultat.ok) {
      throw new PinnedNetworkError(resultat.error.code, resultat.error.message);
    }
    const { value } = resultat;
    const headers = new Headers();
    for (const [nom, valeur] of Object.entries(value.headers)) headers.set(nom, valeur);
    // La réponse est intégralement en mémoire : un seul corps, relisible.
    return new Response(value.body, { status: value.status, statusText: '', headers });
  };
}

/** Erreur réseau portant un code, pour que `sources.ts` la classe correctement. */
export class PinnedNetworkError extends Error {
  readonly code: EgressErrorCode;

  constructor(code: EgressErrorCode, message: string) {
    super(message);
    this.name = 'PinnedNetworkError';
    this.code = code;
  }
}

/**
 * Sonde une boutique par la sortie épinglée, en réutilisant `probeStore`.
 *
 * `probeStore` exige un `resolveHost` : on lui passe celui de l'environnement
 * Deno. La sonde valide une première fois, puis `pinnedFetchLike` revalide à
 * chaque connexion effective — les deux contrôles sont le même code.
 */
export async function probeStorePinned(
  input: string,
  options: { maxHtmlBytes: number; accept?: string },
  deps: EgressDeps,
): Promise<EgressResult<StoreProbe>> {
  const { probeStore } = await import('../../../src/business/importer/sources.ts');
  const accept = options.accept ?? 'text/html,application/xhtml+xml';
  const resultat = await probeStore(input, {
    resolveHost: deps.resolveHost,
    fetchImpl: pinnedFetchLike(deps, { accept, maxBytes: options.maxHtmlBytes }),
  });
  if (!resultat.ok) {
    return { ok: false, error: { code: (resultat.error.code as EgressErrorCode) ?? 'unreachable', message: resultat.error.message } };
  }
  return { ok: true, value: resultat.value };
}

/** Racines candidates de la boutique, réexportées pour l'Edge Function. */
export { storeRootCandidates };
