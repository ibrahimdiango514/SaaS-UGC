/**
 * Connexion HTTP épinglée sur l'adresse IP vérifiée.
 *
 * ## Le problème que ce fichier résout
 * `fetch()` accepte un nom d'hôte et **refait sa propre résolution DNS interne**
 * au moment de se connecter. Vérifier les adresses avec `Deno.resolveDns`, puis
 * appeler `fetch`, laisse donc une fenêtre : le nom peut être résolu une seconde
 * fois, et renvoyer une autre adresse (DNS rebinding). Aucune option de `fetch`
 * ne permet d'imposer l'IP réellement contactée.
 *
 * Conclusion : pour garantir « l'adresse contrôlée est l'adresse contactée », il
 * faut **ouvrir la connexion TCP nous-mêmes** sur l'IP validée.
 *
 * ## La solution
 * 1. `Deno.connect({ hostname: ip })` — l'IP littérale a déjà été validée par
 *    `assertPublicAddresses` (`url-guard.ts`), aucune résolution n'a lieu ici :
 *    Deno ne résout pas une IP littérale (vérifié par
 *    `tests/store-import-pinned.test.ts`).
 * 2. `Deno.startTls(conn, { hostname })` — le nom d'origine sert au **SNI** et à
 *    la **validation du certificat** : le TLS reste vérifié contre l'hôte
 *    demandé, jamais contre l'IP. On n'utilise donc PAS
 *    `unsafelyDisableHostnameVerification`.
 * 3. Requête HTTP/1.1 minimale (`Connection: close`), réponse lue de façon
 *    bornée, avec plafond d'octets et délai global.
 *
 * ## Ce qui n'est PAS réimplémenté
 * - La validation d'URL et d'IP : `parseStoreUrl` / `assertPublicAddresses`
 *   (`src/business/importer/url-guard.ts`) — une seule logique, celle du client.
 * - Le refus des métadonnées cloud : couvert par le refus des plages privées et
 *   réservées de `url-guard.ts` (`169.254.0.0/16`, `fd00::/8`, …).
 * Ce fichier n'ajoute que ce que `fetch` ne sait pas faire : épingler l'IP.
 *
 * ## Redirections
 * Aucune n'est suivie ici. `httpGet` renvoie la réponse telle quelle, et
 * l'appelant (`safe-egress.ts`) décide : chaque saut est revalidé et
 * **re-résolu**, avec un nombre de sauts borné.
 */

/** Délai global d'une requête, en-têtes + corps. */
export const PINNED_TIMEOUT_MS = 12_000;

/** Longueur maximale des en-têtes de réponse acceptés. */
export const MAX_HEADER_BYTES = 32 * 1024;

export interface PinnedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Corps décodé en UTF-8 (les catalogues sont du texte). */
  body: string;
  /** Nombre d'octets réellement reçus (avant décodage). */
  bytes: number;
}

export type PinnedFetchError =
  | 'tls_failed'
  | 'connect_failed'
  | 'timeout'
  | 'too_large'
  | 'protocol_error';

export class PinnedFetchFailure extends Error {
  readonly code: PinnedFetchError;

  constructor(code: PinnedFetchError, message: string) {
    super(message);
    this.name = 'PinnedFetchFailure';
    this.code = code;
  }
}

/** Signature minimale d'un socket Deno, pour injecter un faux en test. */
export interface PinnedSocket {
  read(p: Uint8Array): Promise<number | null>;
  write(p: Uint8Array): Promise<number>;
  close(): void;
}

/**
 * Sous-ensemble de l'API Deno réellement utilisé.
 *
 * Déclaré ici plutôt qu'en global : `tsconfig.json` du dépôt couvre `src` et
 * `tests` (pas les types Deno), et une déclaration globale masquerait qu'on en
 * dépend. Si le runtime ne fournit pas ces fonctions, la connexion échoue
 * fermé (`connect_failed`) — jamais de repli vers `fetch`.
 */
export interface DenoNetworkRuntime {
  connect(options: { hostname: string; port: number; transport?: 'tcp' }): Promise<PinnedSocket>;
  startTls(connection: PinnedSocket, options: { hostname: string }): Promise<PinnedSocket>;
}

/** Lit le runtime Deno sans le supposer présent. */
export function denoNetwork(): DenoNetworkRuntime {
  const runtime = (globalThis as unknown as { Deno?: Partial<DenoNetworkRuntime> }).Deno;
  if (!runtime?.connect || !runtime?.startTls) {
    throw new PinnedFetchFailure(
      'connect_failed',
      'La connexion réseau épinglée n’est pas disponible dans cet environnement : import refusé.',
    );
  }
  return runtime as DenoNetworkRuntime;
}

/**
 * Ouvre une connexion TLS **vers une IP littérale déjà validée**, en vérifiant
 * le certificat contre `hostname`.
 *
 * `Deno.connectTls` ne permet pas de dissocier l'IP contactée du nom validé
 * (pas d'option `serverName`). C'est pourquoi on établit le TCP puis on
 * démarre le TLS explicitement avec le nom d'origine.
 */
export async function connectPinnedTls(ip: string, hostname: string, port = 443): Promise<PinnedSocket> {
  const deno = denoNetwork();
  let tcp: PinnedSocket;
  try {
    // L'IP est un littéral déjà contrôlé : aucune résolution DNS ici.
    tcp = await deno.connect({ hostname: ip, port });
  } catch {
    throw new PinnedFetchFailure('connect_failed', 'Connexion impossible vers l’adresse vérifiée.');
  }
  try {
    // SNI + vérification du certificat sur l'hôte demandé, jamais sur l'IP.
    // `Deno.connectTls` n'expose pas de `serverName` : on établit donc le TCP
    // puis on démarre le TLS avec le nom d'origine, comme le recommande Deno.
    return await deno.startTls(tcp, { hostname });
  } catch {
    try {
      tcp.close();
    } catch {
      // Déjà fermé.
    }
    throw new PinnedFetchFailure('tls_failed', 'La connexion sécurisée avec la boutique a échoué.');
  }
}

/**
 * En-têtes qu'un appelant peut faire passer par la sortie épinglée.
 *
 * ## Pourquoi une liste, et pas « tous »
 *
 * `buildRequest` écrit le message HTTP/1.1 à la main. Un nom d'en-tête non
 * maîtrisé (ou une valeur contenant un saut de ligne) permettrait d'injecter
 * des lignes supplémentaires dans ce message. La liste garantit que seuls des
 * en-têtes choisis, et contrôlés, peuvent en sortir.
 *
 * ## Pourquoi elle s'est élargie
 *
 * Elle ne contenait que `authorization`, ce qui suffisait à PrestaShop et à
 * Chariow. Un connecteur générique doit pouvoir s'authentifier comme les API
 * réelles le demandent : `X-Api-Key`, `X-Shopify-Access-Token`… Ces noms sont
 * exactement ceux de la politique côté application
 * (`ALLOWED_AUTH_HEADERS` dans `custom-api-guard.ts`), et ce n'est pas une
 * coïncidence : les deux listes doivent rester alignées. Un test le vérifie.
 *
 * ## Ce qui reste interdit
 *
 * `host`, `content-length`, `transfer-encoding`, `connection`… ne sont pas
 * dans la liste, et `buildRequest` les écrit lui-même à partir de valeurs
 * calculées. Aucun appelant ne peut les influencer.
 */
const EN_TETES_TRANSMIS = [
  'authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-shopify-access-token',
  'x-restli-protocol-version',
  /*
   * En-têtes du protocole MCP (client sortant). Ajoutés un par un, jamais par
   * préfixe : `mcp-*` en joker laisserait passer `mcp-session-id` sur un hôte
   * tiers, et une session volée suffit à reprendre une conversation.
   *
   * `content-type` est indispensable pour un `POST` JSON-RPC ; il est vérifié
   * séparément dans `buildRequest`, qui n'accepte que `application/json`.
   */
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

/** En-têtes qu'un appelant peut faire passer par la sortie épinglée. */
export const EN_TETES_TRANSMIS_EXPORTES: readonly string[] = EN_TETES_TRANSMIS;

export function buildRequest(
  hostname: string,
  path: string,
  accept: string,
  extraHeaders: Record<string, string> = {},
  /** Méthode HTTP. `GET` par défaut : le comportement d'origine ne change pas. */
  methode: 'GET' | 'POST' = 'GET',
  /** Corps éventuel (JSON-RPC). Jamais transmis pour un `GET`. */
  corps?: string,
): string {
  // Le chemin ne peut pas contenir d'espace ni de retour à la ligne : une URL
  // parsée par `URL` encode déjà ces caractères, et on refuse le reste.
  if (/[\r\n]/.test(path)) throw new PinnedFetchFailure('protocol_error', 'Chemin de requête invalide.');
  // Les en-têtes supplémentaires viennent de l'appelant (clé d'API d'une
  // boutique). Deux règles : liste blanche stricte, et aucune valeur ne peut
  // contenir un saut de ligne — c'est ce qui empêche une clé de sortir du
  // message HTTP en injectant des en-têtes supplémentaires.
  const lignes: string[] = [];
  // On parcourt les en-têtes REÇUS et on les filtre, plutôt que de parcourir la
  // liste blanche : un appelant peut ainsi n'envoyer qu'un sous-ensemble, et
  // l'ordre qu'il choisit est conservé (certaines API y sont sensibles).
  for (const [nomBrut, valeur] of Object.entries(extraHeaders)) {
    const nom = nomBrut.toLowerCase();
    if (!(EN_TETES_TRANSMIS as readonly string[]).includes(nom)) continue;
    if (typeof valeur !== 'string' || valeur.length === 0) continue;
    // Une valeur contenant un saut de ligne sortirait du message HTTP et
    // ajouterait des en-têtes arbitraires. C'est LE contrôle qui empêche une
    // clé de se transformer en injection.
    if (/[\r\n]/.test(valeur)) throw new PinnedFetchFailure('protocol_error', 'En-tête de requête invalide.');
    // Casse canonique : « Authorization », « X-Api-Key »… Un nom d'en-tête est
    // insensible à la casse, mais un serveur strict peut comparer la chaîne.
    const nomCanonique = nom === 'authorization'
      ? 'Authorization'
      : nom.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
    lignes.push(`${nomCanonique}: ${valeur}`);
  }

  /*
   * `content-type` est le seul en-tête dont la VALEUR est contrôlée : un
   * serveur MCP reçoit du JSON-RPC, jamais du formulaire ni du multipart. La
   * laisser libre permettrait de faire passer une requête d'un autre type à
   * travers notre sortie épinglée.
   */
  const indexType = lignes.findIndex((l) => l.toLowerCase().startsWith('content-type:'));
  if (indexType !== -1) {
    const valeur = lignes[indexType].slice(lignes[indexType].indexOf(':') + 1).trim();
    if (!/^application\/json(;\s*charset=utf-8)?$/i.test(valeur)) {
      throw new PinnedFetchFailure('protocol_error', 'Type de contenu non autorisé en sortie.');
    }
  }

  const methodeFinale: 'GET' | 'POST' = methode === 'POST' ? 'POST' : 'GET';
  const corpsFinal = methodeFinale === 'POST' ? (corps ?? '') : '';

  if (methodeFinale === 'POST') {
    // Un corps sans `content-length` est refusé par la plupart des serveurs, et
    // un `transfer-encoding: chunked` demanderait une réécriture du socket.
    // On n'accepte donc que le mode simple, avec la longueur en OCTETS (pas en
    // caractères : un accent UTF-8 fait deux octets).
    if (!lignes.some((l) => l.toLowerCase().startsWith('content-type:'))) {
      lignes.push('Content-Type: application/json');
    }
    lignes.push(`Content-Length: ${new TextEncoder().encode(corpsFinal).byteLength}`);
  }

  return [
    `${methodeFinale} ${path || '/'} HTTP/1.1`,
    `Host: ${hostname}`,
    'User-Agent: SORAHNEX-CatalogImporter/1.0 (+https://vyora.app)',
    `Accept: ${accept}`,
    'Accept-Language: fr,en;q=0.8',
    'Accept-Encoding: identity',
    ...lignes,
    'Connection: close',
    '',
    corpsFinal,
  ].join('\r\n');
}

/**
 * Lit la réponse jusqu'à la fermeture du socket, en refusant dès que le plafond
 * est dépassé — la lecture s'arrête, elle ne se contente pas d'échouer après
 * coup.
 */
async function readBounded(socket: PinnedSocket, maxBytes: number): Promise<Uint8Array> {
  const morceaux: Uint8Array[] = [];
  let total = 0;
  const tampon = new Uint8Array(64 * 1024);
  for (;;) {
    const lus = await socket.read(tampon);
    if (lus === null || lus === 0) break;
    total += lus;
    if (total > maxBytes) {
      throw new PinnedFetchFailure('too_large', 'La réponse dépasse la taille autorisée.');
    }
    morceaux.push(tampon.slice(0, lus));
  }
  const sortie = new Uint8Array(total);
  let position = 0;
  for (const morceau of morceaux) {
    sortie.set(morceau, position);
    position += morceau.byteLength;
  }
  return sortie;
}

/**
 * Décodeur `chunked` (RFC 9112 §7.1).
 *
 * Nécessaire : `Transfer-Encoding: chunked` est le mode par défaut de nombreux
 * serveurs. Sans ce décodage, le corps contiendrait les tailles hexadécimales et
 * le JSON du catalogue serait invalide. On garde le plafond appliqué au décodage.
 */
export function decodeChunked(input: Uint8Array, maxBytes: number): Uint8Array {
  const sortie: Uint8Array[] = [];
  let position = 0;
  let total = 0;
  const texte = () => new TextDecoder('latin1').decode(input);
  for (;;) {
    // Taille du chunk : hexadécimal jusqu'au CRLF.
    let finLigne = -1;
    for (let i = position; i + 1 < input.length; i++) {
      if (input[i] === 13 && input[i + 1] === 10) {
        finLigne = i;
        break;
      }
    }
    if (finLigne === -1) {
      if (position >= input.length) break;
      throw new PinnedFetchFailure('protocol_error', 'Réponse HTTP tronquée.');
    }
    const ligneTaille = texte().slice(position, finLigne).split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(ligneTaille)) {
      throw new PinnedFetchFailure('protocol_error', 'Encodage de réponse invalide.');
    }
    const taille = Number.parseInt(ligneTaille, 16);
    position = finLigne + 2;
    if (taille === 0) break; // Chunk final : les trailers éventuels sont ignorés.
    if (position + taille > input.length) {
      throw new PinnedFetchFailure('protocol_error', 'Longueur de chunk incohérente.');
    }
    total += taille;
    if (total > maxBytes) {
      throw new PinnedFetchFailure('too_large', 'La réponse dépasse la taille autorisée.');
    }
    sortie.push(input.slice(position, position + taille));
    position += taille + 2; // Le CRLF après les données.
  }
  const resultat = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of sortie) {
    resultat.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return resultat;
}

/** Analyse le statut et les en-têtes ; s'arrête sur la première ligne vide. */
export function parseHead(raw: Uint8Array): { status: number; statusText: string; headers: Record<string, string>; bodyOffset: number } {
  const finEntetes = (() => {
    for (let i = 0; i + 3 < raw.length; i++) {
      if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) return i;
    }
    return -1;
  })();
  if (finEntetes === -1) throw new PinnedFetchFailure('protocol_error', 'Réponse HTTP sans en-têtes complets.');
  if (finEntetes > MAX_HEADER_BYTES) throw new PinnedFetchFailure('protocol_error', 'En-têtes de réponse trop volumineux.');

  const head = new TextDecoder('latin1').decode(raw.slice(0, finEntetes));
  const lignes = head.split('\r\n');
  const statut = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(lignes[0] ?? '');
  if (!statut) throw new PinnedFetchFailure('protocol_error', 'Ligne de statut HTTP invalide.');

  const headers: Record<string, string> = {};
  for (const ligne of lignes.slice(1)) {
    const deuxPoints = ligne.indexOf(':');
    if (deuxPoints <= 0) continue;
    const nom = ligne.slice(0, deuxPoints).trim().toLowerCase();
    const valeur = ligne.slice(deuxPoints + 1).trim();
    // En-têtes répétés : on garde la première valeur, suffisant pour ce usage.
    if (!(nom in headers)) headers[nom] = valeur;
  }
  return { status: Number(statut[1]), statusText: (statut[2] ?? '').trim(), headers, bodyOffset: finEntetes + 4 };
}

/**
 * `GET` HTTPS épinglé sur `ip`, avec SNI et validation du certificat sur
 * `hostname`. Aucune redirection n'est suivie ; aucun cookie n'est conservé.
 */
export async function httpGetPinned(
  target: { ip: string; hostname: string; path: string },
  options: {
    accept: string;
    maxBytes: number;
    timeoutMs?: number;
    /** Injectable pour les tests : remplace la connexion TLS réelle. */
    connect?: (ip: string, hostname: string) => Promise<PinnedSocket>;
    /** En-têtes transmis à la boutique (liste blanche : `authorization`). */
    headers?: Record<string, string>;
    /* `post` explicite : la valeur par défaut reste `get`. */
    method?: 'get' | 'post';
    body?: string;
  },
): Promise<PinnedResponse> {
  const timeoutMs = options.timeoutMs ?? PINNED_TIMEOUT_MS;
  const connect = options.connect ?? ((ip: string, hostname: string) => connectPinnedTls(ip, hostname));
  const controller = new AbortController();
  const minuteur = setTimeout(() => controller.abort(), timeoutMs);

  let socket: PinnedSocket | null = null;
  try {
    socket = await connect(target.ip, target.hostname);
    const abandon = () => {
      try {
        socket?.close();
      } catch {
        // Socket déjà fermé.
      }
    };
    controller.signal.addEventListener('abort', abandon, { once: true });

    await socket.write(new TextEncoder().encode(
      buildRequest(
        target.hostname,
        target.path,
        options.accept,
        options.headers,
        options.method === 'post' ? 'POST' : 'GET',
        options.body,
      ),
    ));
    // Plafond de lecture majoré : en-têtes + corps chunked (qui ajoute des
    // métadonnées) restent sous maxBytes + MAX_HEADER_BYTES.
    const brut = await readBounded(socket, options.maxBytes + MAX_HEADER_BYTES);
    if (controller.signal.aborted) throw new PinnedFetchFailure('timeout', 'La boutique n’a pas répondu dans le délai autorisé.');

    const head = parseHead(brut);
    const corpsBrut = brut.slice(head.bodyOffset);
    const transferEncoding = (head.headers['transfer-encoding'] ?? '').toLowerCase();
    const corps = transferEncoding.includes('chunked')
      ? decodeChunked(corpsBrut, options.maxBytes)
      : corpsBrut;

    // `content-length` menteur : le plafond est déjà appliqué à la lecture et au
    // décodage, on vérifie en plus la taille finale annoncée.
    const annonce = Number(head.headers['content-length'] ?? '0');
    if (Number.isFinite(annonce) && annonce > options.maxBytes) {
      throw new PinnedFetchFailure('too_large', 'La réponse annonce une taille trop importante.');
    }
    if (corps.byteLength > options.maxBytes) {
      throw new PinnedFetchFailure('too_large', 'La réponse dépasse la taille autorisée.');
    }

    return {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers,
      body: new TextDecoder('utf-8', { fatal: false }).decode(corps),
      bytes: corps.byteLength,
    };
  } catch (cause) {
    if (cause instanceof PinnedFetchFailure) throw cause;
    if (controller.signal.aborted) {
      throw new PinnedFetchFailure('timeout', 'La boutique n’a pas répondu dans le délai autorisé.');
    }
    throw new PinnedFetchFailure('protocol_error', 'La réponse de la boutique est illisible.');
  } finally {
    clearTimeout(minuteur);
    try {
      socket?.close();
    } catch {
      // Déjà fermé.
    }
  }
}
