/**
 * SORAHNEX — URL de boutique : validation, dérivation, garde SSRF.
 *
 * ## Le risque, concrètement
 *
 * Dès qu'une application accepte une URL fournie par l'utilisateur et va la
 * chercher côté serveur, elle devient un **proxy**. Sans garde, un utilisateur
 * peut demander `http://169.254.169.254/latest/meta-data/` (métadonnées cloud),
 * `http://localhost:5432` (base interne) ou `http://10.0.0.5/admin`, et lire la
 * réponse à travers l'interface. C'est la classe SSRF, et c'est la faille la
 * plus fréquente des importateurs d'URL.
 *
 * ## Stratégie : refuser tôt, refuser large
 *
 * Une liste noire ne suffit pas (elle rate `0x7f.0.0.1`, `2130706433`,
 * `[::1]`, `127.1`…). On procède donc en trois temps :
 *   1. **Forme** : seul `https` est accepté, port standard uniquement, pas
 *      d'identifiants dans l'URL, pas de fragment.
 *   2. **Hôte** : refus des littéraux (`127.0.0.1`, `[::1]`, `2130706433`,
 *      `0x7f000001`, `127.1`), des noms réservés (`localhost`, `.internal`,
 *      `.local`, `.arpa`) et des noms à un seul label.
 *   3. **Résolution DNS** : l'appelant fournit les adresses obtenues ; toute
 *      adresse privée, loopback, lien-local, CGNAT ou de documentation
 *      invalide la requête. La résolution est la seule étape qui ne peut pas
 *      être pure — d'où l'injection explicite plutôt qu'un appel réseau caché.
 *
 * `assertPublicHost` est séparé de `validateStoreUrl` pour que la partie pure
 * reste testable sans réseau, et pour que le serveur puisse rejouer le contrôle
 * après résolution (protection contre le DNS rebinding).
 */

/** Hôtes refusés par leur nom, sans résolution. */
const RESERVED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

/** Suffixes réservés (RFC 6761, 6762, 8375) : jamais une boutique publique. */
const RESERVED_SUFFIXES = [
  '.localhost', '.local', '.localdomain', '.internal', '.intranet',
  '.corp', '.home', '.lan', '.private', '.arpa',
];

export type UrlRejection =
  | 'empty'
  | 'invalid_url'
  | 'not_https'
  | 'non_standard_port'
  | 'credentials_in_url'
  | 'has_fragment'
  | 'ip_literal'
  | 'reserved_hostname'
  | 'single_label'
  | 'private_address'
  | 'no_addresses';

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: UrlRejection };

/**
 * Parse et normalise une URL de boutique saisie par l'utilisateur.
 *
 * `example-boutique.com` est accepté sans schéma : on préfixe `https://`. En
 * revanche, une URL qui déclare explicitement `http://` est refusée — on ne
 * « corrige » pas silencieusement une intention en clair, on la rejette.
 */
export function parseStoreUrl(input: string): UrlCheck {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  // Un port explicite non standard contourne souvent les filtres applicatifs.
  if (url.port !== '' && url.port !== '443') return { ok: false, reason: 'non_standard_port' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.hash) return { ok: false, reason: 'has_fragment' };

  // Un hôte vide ou un point final isolé (`https://./`) n'est pas une boutique.
  if (!url.hostname) return { ok: false, reason: 'invalid_url' };

  /*
   * Contrôle d'hôte **dans cette fonction**, et non chez l'appelant.
   *
   * C'est une correction issue des tests : la première version séparait la
   * validation de forme et le contrôle d'hôte, et un appelant pouvait n'utiliser
   * que la première. Une garde qu'on peut oublier d'appeler n'est pas une garde.
   */
  const hote = isPublicHostname(url.hostname);
  if (!hote.ok) return { ok: false, reason: hote.reason };

  return { ok: true, url };
}

/** Vrai si la chaîne est un littéral IPv4 sous une forme que `URL` accepte. */
function looksLikeIpv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Contrôle de l'hôte, sans réseau.
 *
 * Les formes décimales et hexadécimales (`2130706433`, `0x7f000001`) sont
 * normalisées par le parseur `URL` de la plateforme en `127.0.0.1` — on les
 * refuse donc de deux façons : si elles arrivent normalisées, `looksLikeIpv4`
 * les attrape ; si elles arrivent brutes, l'absence de point les trahit.
 */
export function isPublicHostname(hostname: string): { ok: true } | { ok: false; reason: UrlRejection } {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (!host) return { ok: false, reason: 'invalid_url' };

  // IPv6 littéral : toujours entre crochets dans une URL.
  if (host.startsWith('[') || host.includes(':')) {
    // Seules les adresses IPv6 publiques (2000::/3) seraient acceptables ; on
    // refuse tout le reste, ce qui couvre ::1, fe80::, fc00::/7 et ::ffff:…
    return { ok: false, reason: 'ip_literal' };
  }

  if (looksLikeIpv4(host)) return { ok: false, reason: 'ip_literal' };
  // Un entier ou un hexadécimal seul est une IPv4 déguisée.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return { ok: false, reason: 'ip_literal' };
  if (RESERVED_HOSTNAMES.has(host)) return { ok: false, reason: 'reserved_hostname' };
  if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, reason: 'reserved_hostname' };
  }
  // `shop` ou `intranet` seul : pas un domaine public.
  if (!host.includes('.')) return { ok: false, reason: 'single_label' };
  return { ok: true };
}

/** Adresse IPv4 privée, loopback, lien-local, CGNAT, ou réservée. */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true;                          // 0.0.0.0/8
  if (a === 10) return true;                         // 10.0.0.0/8
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // lien-local (métadonnées cloud)
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
  if (a === 192 && b === 168) return true;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0 && parts[2] === 0) return true;  // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true;     // 198.18.0.0/15
  if (a >= 224) return true;                         // multicast et réservé
  return false;
}

/** Développe une IPv6 en huit groupes de 16 bits, ou `null` si illisible. */
function expandIpv6(value: string): number[] | null {
  let texte = value;
  // Un suffixe IPv4 en notation pointée devient deux groupes hexadécimaux.
  const v4 = texte.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const parts = v4[1].split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    texte = `${texte.slice(0, texte.length - v4[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const [gauche, droite] = texte.split('::');
  const g = gauche ? gauche.split(':').filter(Boolean) : [];
  const d = droite !== undefined ? droite.split(':').filter(Boolean) : [];
  if (droite === undefined && g.length !== 8) return null;
  const manquants = 8 - g.length - d.length;
  if (manquants < 0) return null;
  const groupes = [...g, ...Array<string>(manquants).fill('0'), ...d];
  if (groupes.length !== 8) return null;
  const valeurs = groupes.map((groupe) => parseInt(groupe, 16));
  return valeurs.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff) ? valeurs : null;
}

/**
 * Adresse IPv6 non publique.
 *
 * ## Le cas qui a motivé la version actuelle
 *
 * `::ffff:7f00:1` est la même adresse que `::ffff:127.0.0.1`, soit 127.0.0.1.
 * La première version ne reconnaissait que la notation pointée : un attaquant
 * qui fournit la forme hexadécimale passait la garde. On développe donc
 * l'adresse en huit groupes avant de décider.
 */
export function isPrivateIpv6(ip: string): boolean {
  const value = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (value.startsWith('ff')) return true; // multicast

  const groupes = expandIpv6(value);
  if (!groupes) return true; // illisible → traité comme privé (fail-closed)

  // ::ffff:a.b.c.d / ::ffff:xxxx:yyyy — IPv4 encapsulée (mapped).
  const mapped = groupes.slice(0, 5).every((g) => g === 0) && groupes[5] === 0xffff;
  // 64:ff9b::/96 — NAT64, ramène aussi vers l'IPv4.
  const nat64 = groupes[0] === 0x64 && groupes[1] === 0xff9b && groupes.slice(2, 6).every((g) => g === 0);
  if (mapped || nat64) {
    const ipv4 = `${groupes[6] >> 8}.${groupes[6] & 0xff}.${groupes[7] >> 8}.${groupes[7] & 0xff}`;
    return isPrivateIpv4(ipv4);
  }
  return false;
}

/**
 * Vérifie les adresses résolues pour un hôte.
 *
 * À appeler **après** la résolution DNS et **avant** la requête. Un seul
 * résultat privé suffit à refuser : un attaquant qui contrôle une zone DNS peut
 * renvoyer une adresse publique puis une adresse interne (DNS rebinding).
 */
export function assertPublicAddresses(addresses: string[]): { ok: true } | { ok: false; reason: UrlRejection } {
  if (addresses.length === 0) return { ok: false, reason: 'no_addresses' };
  for (const address of addresses) {
    const privee = address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address);
    if (privee) return { ok: false, reason: 'private_address' };
  }
  return { ok: true };
}

/** Message affichable pour un refus — sans révéler d'information interne. */
export function explainRejection(reason: UrlRejection): string {
  switch (reason) {
    case 'empty': return 'Indiquez l’adresse de votre boutique.';
    case 'invalid_url': return 'Cette adresse n’est pas une URL valide.';
    case 'not_https': return 'Seules les adresses HTTPS sont acceptées.';
    case 'non_standard_port': return 'Seul le port standard (443) est accepté.';
    case 'credentials_in_url': return 'Une adresse de boutique ne doit pas contenir d’identifiants.';
    case 'has_fragment': return 'Retirez le fragment (#…) de l’adresse.';
    case 'ip_literal': return 'Les adresses IP ne sont pas acceptées : utilisez un nom de domaine.';
    case 'reserved_hostname': return 'Cette adresse désigne un réseau local ou réservé.';
    case 'single_label': return 'Indiquez un nom de domaine complet (ex. boutique.com).';
    case 'private_address': return 'Cette adresse pointe vers un réseau privé : import refusé.';
    case 'no_addresses': return 'Le domaine n’a pas pu être résolu.';
  }
}

/**
 * Chemin de développement des travaux : `parseStoreUrl` + `isPublicHostname`
 * suffisent à valider une saisie ; la résolution est faite par l'appelant et
 * contrôlée par `assertPublicAddresses`.
 */

/**
 * Racine de boutique : l'origine seule.
 *
 * La première version conservait un sous-répertoire « qui ressemble à une base
 * d'installation ». C'était deviner : `/boutique/` peut être une base WordPress
 * *ou* une route applicative. Deviner produit des 404 silencieux.
 *
 * On retourne donc l'origine, toujours prévisible, et `storeRootCandidates`
 * fournit les variantes à essayer explicitement.
 */
export function storeRoot(url: URL): URL {
  return new URL(`${url.origin}/`);
}

/**
 * Candidats de racine à essayer, dans l'ordre.
 *
 * - l'origine (`https://site.com/`) ;
 * - l'origine suivie du premier segment de chemin (`https://site.com/boutique/`)
 *   quand il existe et n'est pas une route manifestement applicative.
 *
 * L'appelant les essaie l'un après l'autre et s'arrête au premier qui répond.
 * Aucun n'est supposé valide.
 */
export function storeRootCandidates(url: URL): URL[] {
  const candidats = [storeRoot(url)];
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return candidats;

  const ROUTES_APPLICATIVES = new Set([
    'products', 'product', 'collections', 'collection', 'cart', 'panier',
    'pages', 'page', 'account', 'compte', 'checkout', 'catalog', 'catalogue',
    'index.php', 'wp-admin', 'wp-login.php', 'admin', 'login',
  ]);
  const premier = segments[0].toLowerCase();
  if (!ROUTES_APPLICATIVES.has(premier) && /^[a-z0-9][a-z0-9_-]{0,40}$/.test(premier)) {
    candidats.push(new URL(`${url.origin}/${segments[0]}/`));
  }
  return candidats;
}
