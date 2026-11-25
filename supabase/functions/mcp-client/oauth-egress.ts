/**
 * SORAHNEX — sortie réseau dédiée à OAuth 2.1.
 *
 * ## Pourquoi une seconde sortie, et pas `safe-egress`
 *
 * La sortie de `store-import` impose `content-type: application/json` à tout
 * `POST` : c'est juste pour du JSON-RPC MCP, mais **faux pour OAuth**. La
 * RFC 6749 §3.2 impose `application/x-www-form-urlencoded` au point de jeton ;
 * envoyer du JSON à la place ferait échouer la majorité des fournisseurs réels.
 *
 * Ce module ne relâche donc rien de la politique de sécurité, il en applique une
 * variante explicite :
 *
 *   - l'URL doit être **https**, sans identifiants, sur le port 443, avec un nom
 *     d'hôte (jamais une IP littérale) ;
 *   - **toutes** les adresses résolues doivent être publiques (aucune privée) ;
 *   - la connexion est **épinglée** sur l'IP validée, TLS vérifié sur le nom ;
 *   - **aucune redirection** suivie (un 3xx est une erreur) : suivre une
 *     redirection emporterait le `code_verifier` vers un hôte choisi par le
 *     serveur distant ;
 *   - le `content-type` envoyé n'est jamais libre : `application/json` ou
 *     `application/x-www-form-urlencoded`, rien d'autre ;
 *   - réponse bornée en taille et en durée ;
 *   - aucun repli vers `fetch` : si le runtime réseau manque, on échoue fermé.
 *
 * `store-import/safe-egress.ts` reste **inchangé** : le durcissement du POST
 * MCP n'est pas assoupli pour faire plaisir à OAuth.
 */
import {
  MAX_HEADER_BYTES,
  PinnedFetchFailure,
  connectPinnedTls,
  decodeChunked,
  parseHead,
  type PinnedSocket,
} from '../store-import/pinned-fetch.ts';
import { assertPublicAddresses, explainRejection, isPublicHostname, parseStoreUrl } from '../../../src/business/importer/url-guard.ts';

/** Taille maximale d'une réponse OAuth (métadonnées ou jeton). */
export const MAX_REPONSE_OAUTH = 64 * 1024;
/** Délai d'une requête OAuth. */
export const DELAI_OAUTH_MS = 15_000;

export type TypeContenuOAuth = 'application/json' | 'application/x-www-form-urlencoded';

export interface ReponseOAuth {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type EchecOAuth = { code: string; message: string };
export type ResultatHttpOAuth = { ok: true; valeur: ReponseOAuth } | { ok: false; error: EchecOAuth };

export interface DependancesOAuthHttp {
  resolveHost: (hostname: string) => Promise<string[]>;
  /** Injectable en test : remplace la connexion TLS réelle. */
  connect?: (ip: string, hostname: string) => Promise<PinnedSocket>;
  timeoutMs?: number;
  onConnected?: (ip: string, hostname: string) => void;
}

function echec(code: string, message: string): ResultatHttpOAuth {
  return { ok: false, error: { code, message } };
}

/**
 * Construit la requête HTTP/1.1.
 *
 * Écrite ici plutôt que réutilisée : `buildRequest` du module d'importation
 * refuse le formulaire, et c'est volontaire de sa part. Le contrôle du
 * `content-type` est refait ici, avec exactement deux valeurs permises.
 */
export function requeteOAuth(
  hostname: string,
  chemin: string,
  accept: string,
  entetes: Record<string, string>,
  methode: 'GET' | 'POST',
  typeContenu: TypeContenuOAuth,
  corps?: string,
): string {
  const autorises: TypeContenuOAuth[] = ['application/json', 'application/x-www-form-urlencoded'];
  if (!autorises.includes(typeContenu)) {
    throw new PinnedFetchFailure('protocol_error', 'Type de contenu non autorisé en sortie OAuth.');
  }
  for (const [nom, valeur] of Object.entries(entetes)) {
    // Un nom ou une valeur contenant un saut de ligne permettrait d'injecter
    // des en-têtes : refus avant tout réseau.
    if (/[\r\n]/.test(nom) || /[\r\n]/.test(valeur)) {
      throw new PinnedFetchFailure('protocol_error', 'En-tête OAuth invalide.');
    }
  }

  const lignes = [`${methode} ${chemin || '/'} HTTP/1.1`];
  lignes.push(`Host: ${hostname}`);
  lignes.push('User-Agent: SORAHNEX-MCP/1.0 (+https://vyora.app)');
  lignes.push(`Accept: ${accept}`);
  lignes.push('Accept-Encoding: identity');
  if (methode === 'POST') lignes.push(`Content-Type: ${typeContenu}`);
  for (const [nom, valeur] of Object.entries(entetes)) lignes.push(`${nom}: ${valeur}`);
  if (methode === 'POST') {
    // La longueur est en OCTETS, pas en caractères : l'accent UTF-8 en fait deux.
    lignes.push(`Content-Length: ${new TextEncoder().encode(corps ?? '').byteLength}`);
  }
  lignes.push('Connection: close');
  return `${lignes.join('\r\n')}\r\n\r\n${methode === 'POST' ? corps ?? '' : ''}`;
}

async function lireBorne(socket: PinnedSocket, maxOctets: number): Promise<Uint8Array> {
  const morceaux: Uint8Array[] = [];
  let total = 0;
  while (total < maxOctets) {
    const tampon = new Uint8Array(16 * 1024);
    const n = await socket.read(tampon);
    if (n === null) break;
    morceaux.push(tampon.subarray(0, n));
    total += n;
  }
  const sortie = new Uint8Array(total);
  let position = 0;
  for (const morceau of morceaux) {
    sortie.set(morceau, position);
    position += morceau.length;
  }
  return sortie;
}

/**
 * Requête HTTPS épinglée, réservée aux points de terminaison OAuth.
 *
 * Le résultat est toujours un couple statut/corps : c'est à l'appelant de
 * décider ce qu'un 400 signifie. Seules les fautes de transport sont des échecs.
 */
export async function requeteOAuthSure(
  urlBrute: string | URL,
  options: {
    accept: string;
    methode: 'GET' | 'POST';
    typeContenu: TypeContenuOAuth;
    corps?: string;
    entetes?: Record<string, string>;
    maxBytes?: number;
  },
  deps: DependancesOAuthHttp,
): Promise<ResultatHttpOAuth> {
  const typeContenu = options.typeContenu;
  if (typeContenu !== 'application/json' && typeContenu !== 'application/x-www-form-urlencoded') {
    return echec('protocole', 'Type de contenu non autorisé en sortie OAuth.');
  }

  const url = new URL(typeof urlBrute === 'string' ? urlBrute : urlBrute.toString());
  // Même garde que l'importateur : https, port standard, hôte non littéral.
  const controle = parseStoreUrl(url.toString());
  if (!controle.ok) return echec('url_refusee', explainRejection(controle.reason));
  const publicHote = isPublicHostname(url.hostname);
  if (!publicHote.ok) return echec('url_refusee', explainRejection(publicHote.reason));

  let adresses: string[];
  try {
    adresses = await deps.resolveHost(url.hostname);
  } catch {
    return echec('dns', 'Le domaine du serveur d’autorisation n’a pas pu être résolu.');
  }
  if (!Array.isArray(adresses) || adresses.length === 0) {
    return echec('dns', 'Le domaine ne renvoie aucune adresse.');
  }
  const adressesPubliques = assertPublicAddresses(adresses);
  if (!adressesPubliques.ok) return echec('url_refusee', explainRejection(adressesPubliques.reason));

  const ip = adresses[0] as string;
  const connect = deps.connect ?? ((adresse: string, nom: string) => connectPinnedTls(adresse, nom));
  const timeoutMs = deps.timeoutMs ?? DELAI_OAUTH_MS;
  const maxBytes = options.maxBytes ?? MAX_REPONSE_OAUTH;

  const abandon = new AbortController();
  const minuteur = setTimeout(() => abandon.abort(), timeoutMs);
  let socket: PinnedSocket | null = null;

  try {
    socket = await connect(ip, url.hostname);
    const fermer = () => {
      try {
        socket?.close();
      } catch {
        // Déjà fermé.
      }
    };
    abandon.signal.addEventListener('abort', fermer, { once: true });
    deps.onConnected?.(ip, url.hostname);

    const chemin = `${url.pathname}${url.search}`;
    await socket.write(new TextEncoder().encode(
      requeteOAuth(
        url.hostname,
        chemin,
        options.accept,
        options.entetes ?? {},
        options.methode,
        typeContenu,
        options.corps,
      ),
    ));

    const brut = await lireBorne(socket, maxBytes + MAX_HEADER_BYTES);
    if (abandon.signal.aborted) return echec('delai', 'Le serveur d’autorisation n’a pas répondu à temps.');

    const head = parseHead(brut);
    const corpsBrut = brut.slice(head.bodyOffset);
    const transfert = (head.headers['transfer-encoding'] ?? '').toLowerCase();
    const corps = transfert.includes('chunked') ? decodeChunked(corpsBrut, maxBytes) : corpsBrut;
    if (corps.byteLength > maxBytes) return echec('trop_volumineux', 'La réponse dépasse la taille autorisée.');

    /*
     * Une redirection n'est JAMAIS suivie. Sur un point de jeton, elle
     * emporterait le `code_verifier` (dans le corps rejoué) ou l'en-tête
     * `Authorization` vers un hôte tiers.
     */
    if (head.status >= 300 && head.status < 400) {
      return echec('redirection', 'Le serveur d’autorisation a répondu par une redirection, refusée.');
    }

    return {
      ok: true,
      valeur: {
        status: head.status,
        headers: head.headers,
        body: new TextDecoder('utf-8', { fatal: false }).decode(corps),
      },
    };
  } catch (cause) {
    if (cause instanceof PinnedFetchFailure) return echec(cause.code, cause.message);
    if (abandon.signal.aborted) return echec('delai', 'Le serveur d’autorisation n’a pas répondu à temps.');
    return echec('reseau', 'La requête vers le serveur d’autorisation a échoué.');
  } finally {
    clearTimeout(minuteur);
    try {
      socket?.close();
    } catch {
      // Déjà fermé.
    }
  }
}
