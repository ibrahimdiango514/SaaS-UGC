/**
 * VYORA — détection de plateforme e-commerce.
 *
 * ## Principe : des indices observables, jamais une supposition
 *
 * Une boutique ne dit presque jamais « je suis Shopify ». On l'identifie par
 * des traces qu'elle laisse forcément :
 *   - **le domaine** (`*.myshopify.com`) — indice le plus fiable ;
 *   - **les en-têtes HTTP** (`x-shopid`, `x-powered-by`, cookies de session) ;
 *   - **le HTML servi** (chemins d'assets, balises meta, scripts) ;
 *   - **des chemins publics** qui n'existent que chez un éditeur
 *     (`/products.json` pour Shopify, `/wp-json/wc/store/products` pour
 *     WooCommerce).
 *
 * ## Ce que la détection ne fait pas
 *
 * Elle ne **déclare** pas une plateforme sur un seul indice faible. Chaque
 * règle a un poids ; on ne conclut que si le meilleur score dépasse un seuil et
 * distance le suivant. En dessous, on renvoie `unknown` — et l'interface
 * proposera l'import par fichier plutôt que d'inventer une API.
 *
 * Un faux positif coûte cher : croire qu'une boutique est Shopify conduit à
 * appeler `/products.json`, obtenir 404, et afficher un échec incompréhensible.
 * « Je ne sais pas » est un résultat acceptable ; « je me trompe » ne l'est pas.
 */
import { storeRoot } from './url-guard.ts';

/** Plateformes connues de l'importateur. */
export type StorePlatform =
  | 'shopify'
  | 'woocommerce'
  | 'prestashop'
  | 'magento'
  | 'opencart'
  | 'wix'
  | 'bigcommerce'
  | 'squarespace'
  | 'ecwid'
  | 'chariow'
  | 'unknown';

export const PLATFORM_LABELS: Record<StorePlatform, string> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  prestashop: 'PrestaShop',
  magento: 'Magento',
  opencart: 'OpenCart',
  wix: 'Wix',
  bigcommerce: 'BigCommerce',
  squarespace: 'Squarespace',
  ecwid: 'Ecwid',
  chariow: 'Chariow',
  unknown: 'Plateforme non identifiée',
};

/** Ce dont dispose l'importateur pour un catalogue, par plateforme. */
export type CatalogAccess = 'public-json' | 'public-xml' | 'html-only' | 'api-authorized' | 'none';

export const ACCESS_LABELS: Record<CatalogAccess, string> = {
  'public-json': 'Catalogue public JSON',
  'public-xml': 'Catalogue public XML',
  'html-only': 'Lecture HTML (aucune API publique)',
  'api-authorized': 'API officielle (autorisation requise)',
  none: 'Aucun accès automatisé',
};

/** Indices collectés par l'appelant, une seule fois, lors de la sonde. */
export interface PageFingerprint {
  /** URL finale, après redirections — une redirection peut révéler la plateforme. */
  finalUrl: string;
  headers: Record<string, string>;
  /** HTML brut, éventuellement tronqué par l'appelant. */
  html: string;
}

export interface PlatformVerdict {
  platform: StorePlatform;
  /** Score du meilleur candidat, pour l'audit. */
  score: number;
  /** Indices retenus, lisibles par un humain. */
  evidence: string[];
  /** Confiance : `high` seulement si le score dépasse nettement le second. */
  confidence: 'high' | 'medium' | 'low';
  access: CatalogAccess;
}

const SEUIL_DECISION = 3;
const SEUIL_CONFIANCE_HAUTE = 6;

interface Rule {
  platform: StorePlatform;
  weight: number;
  label: string;
  test: (fp: PageFingerprint, host: string) => boolean;
}

/** Lit un en-tête sans se soucier de la casse. */
function header(fp: PageFingerprint, name: string): string {
  const cible = name.toLowerCase();
  for (const [key, value] of Object.entries(fp.headers)) {
    if (key.toLowerCase() === cible) return value;
  }
  return '';
}

/** Vrai si l'une des aiguilles figure dans le HTML, sans tenir compte de la casse. */
function hasAny(html: string, needles: string[]): boolean {
  const lowered = html.toLowerCase();
  return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

/**
 * Règles pondérées.
 *
 * Les poids traduisent la fiabilité : un `cdn.shopify.com` dans le HTML vaut 4
 * (quasi certain), un `x-powered-by: Wix` vaut 3, la simple présence du mot
 * « shopify » vaut 1 (un article de blog peut le mentionner).
 */
const RULES: Rule[] = [
  // --- Chariow ---
  // Plateforme d'hébergement de boutiques de produits numériques. Aucun
  // catalogue public : le seul chemin de lecture est son API authentifiée.
  // Les indices sont sans ambiguïté — Chariow signe ses vitrines et sert ses
  // assets depuis sa propre infrastructure.
  { platform: 'chariow', weight: 5, label: 'domaine *.mychariow.online', test: (_fp, host) => host.endsWith('.mychariow.online') },
  { platform: 'chariow', weight: 4, label: 'mention « Powered by Chariow »', test: (fp) => /powered by\s*<?[^>]*>?\s*chariow/i.test(fp.html) || hasAny(fp.html, ['chariow.com']) },
  { platform: 'chariow', weight: 3, label: 'assets cdn.axazara.com', test: (fp) => hasAny(fp.html, ['cdn.axazara.com']) },
  { platform: 'chariow', weight: 2, label: 'portail de commandes app.ateliat.com', test: (fp) => hasAny(fp.html, ['app.ateliat.com']) },
  { platform: 'chariow', weight: 1, label: 'mention « chariow »', test: (fp) => hasAny(fp.html, ['chariow']) },

  // --- Shopify ---
  { platform: 'shopify', weight: 5, label: 'domaine *.myshopify.com', test: (_fp, host) => host.endsWith('.myshopify.com') },
  { platform: 'shopify', weight: 4, label: 'en-tête x-shopid', test: (fp) => Boolean(header(fp, 'x-shopid')) },
  { platform: 'shopify', weight: 4, label: 'en-tête x-shopify-stage', test: (fp) => Boolean(header(fp, 'x-shopify-stage')) },
  { platform: 'shopify', weight: 4, label: 'assets cdn.shopify.com', test: (fp) => hasAny(fp.html, ['cdn.shopify.com', 'shopifycdn.com']) },
  { platform: 'shopify', weight: 2, label: 'Shopify.theme dans le HTML', test: (fp) => hasAny(fp.html, ['shopify.theme', 'shopify.routes']) },
  { platform: 'shopify', weight: 1, label: 'mention « shopify »', test: (fp) => hasAny(fp.html, ['shopify']) },

  // --- WooCommerce / WordPress ---
  { platform: 'woocommerce', weight: 4, label: 'assets /wp-content/', test: (fp) => hasAny(fp.html, ['/wp-content/', '/wp-includes/']) },
  { platform: 'woocommerce', weight: 3, label: 'meta generator WordPress', test: (fp) => /<meta[^>]+name=["']generator["'][^>]+wordpress/i.test(fp.html) },
  { platform: 'woocommerce', weight: 3, label: 'classes woocommerce', test: (fp) => hasAny(fp.html, ['woocommerce-page', 'class="woocommerce', 'wc-block']) },
  { platform: 'woocommerce', weight: 2, label: 'en-tête x-powered-by WordPress', test: (fp) => /wordpress/i.test(header(fp, 'x-powered-by')) },
  { platform: 'woocommerce', weight: 1, label: 'panier woocommerce', test: (fp) => hasAny(fp.html, ['add-to-cart=', 'wc-ajax=']) },

  // --- PrestaShop ---
  { platform: 'prestashop', weight: 4, label: 'meta generator PrestaShop', test: (fp) => /<meta[^>]+name=["']generator["'][^>]+prestashop/i.test(fp.html) },
  { platform: 'prestashop', weight: 3, label: 'assets /themes/ + /modules/', test: (fp) => hasAny(fp.html, ['/modules/ps_', 'prestashop']) },
  { platform: 'prestashop', weight: 2, label: 'cookie PrestaShop', test: (fp) => hasAny(header(fp, 'set-cookie'), ['prestashop-']) },

  // --- Magento ---
  { platform: 'magento', weight: 4, label: 'assets static/version…/frontend', test: (fp) => /static\/version\d+\/frontend\//i.test(fp.html) },
  { platform: 'magento', weight: 3, label: 'cookie mage-cache / X-Magento', test: (fp) => hasAny(header(fp, 'set-cookie'), ['mage-cache', 'private_content_version']) || Boolean(header(fp, 'x-magento-cache-debug')) },
  { platform: 'magento', weight: 2, label: 'classes mage', test: (fp) => hasAny(fp.html, ['data-mage-init', 'Magento_']) },

  // --- OpenCart ---
  { platform: 'opencart', weight: 4, label: 'route index.php?route=', test: (fp) => hasAny(fp.html, ['index.php?route=product', 'index.php?route=common']) },
  { platform: 'opencart', weight: 2, label: 'assets catalog/view/', test: (fp) => hasAny(fp.html, ['catalog/view/javascript', 'catalog/view/theme']) },

  // --- Wix ---
  { platform: 'wix', weight: 4, label: 'en-tête x-wix-request-id', test: (fp) => Boolean(header(fp, 'x-wix-request-id')) || hasAny(header(fp, 'server'), ['wix']) },
  { platform: 'wix', weight: 3, label: 'assets parastorage', test: (fp) => hasAny(fp.html, ['parastorage.com', 'wixstatic.com', 'wix.com/website']) },

  // --- BigCommerce ---
  { platform: 'bigcommerce', weight: 4, label: 'assets bigcommerce', test: (fp) => hasAny(fp.html, ['cdn11.bigcommerce.com', 'bigcommerce.com/s-']) },
  { platform: 'bigcommerce', weight: 2, label: 'cookie SHOP_SESSION_TOKEN', test: (fp) => hasAny(header(fp, 'set-cookie'), ['shopsession', 'athena']) },

  // --- Squarespace ---
  { platform: 'squarespace', weight: 4, label: 'assets squarespace', test: (fp) => hasAny(fp.html, ['static1.squarespace.com', 'squarespace-cdn.com']) },
  { platform: 'squarespace', weight: 2, label: 'meta generator Squarespace', test: (fp) => /<meta[^>]+name=["']generator["'][^>]+squarespace/i.test(fp.html) || Boolean(header(fp, 'x-served-by')) && /squarespace/i.test(header(fp, 'x-served-by')) },

  // --- Ecwid ---
  { platform: 'ecwid', weight: 4, label: 'script ecwid', test: (fp) => hasAny(fp.html, ['ecwid.com/script.js', 'app.ecwid.com', 'ecwid-shopping-cart']) },
  { platform: 'ecwid', weight: 2, label: 'identifiant storeid', test: (fp) => /storeid/i.test(fp.html) && hasAny(fp.html, ['ecwid']) },
];

/** Accès au catalogue selon la plateforme détectée. */
export function accessFor(platform: StorePlatform): CatalogAccess {
  switch (platform) {
    case 'shopify':
      // `/products.json` est un point d'accès public, documenté par l'éditeur.
      return 'public-json';
    case 'woocommerce':
      // Le Store API WC est public quand le site l'expose.
      return 'public-json';
    case 'bigcommerce':
    case 'magento':
      return 'html-only';
    case 'prestashop':
      return 'html-only';
    case 'chariow':
      // Chariow n'expose AUCUN catalogue public : ni `/products.json`, ni flux,
      // et son `sitemap.xml` ne liste que des pages statiques. Le seul accès est
      // `GET https://api.chariow.com/v1/products` avec une clé `sk_live_…`.
      return 'api-authorized';
    case 'opencart':
    case 'wix':
    case 'squarespace':
    case 'ecwid':
      // Ces plateformes servent leur catalogue via des API authentifiées :
      // aucun catalogue public normalisé n'est garanti.
      return 'api-authorized';
    default:
      return 'none';
  }
}

/**
 * Détecte la plateforme à partir des indices collectés.
 *
 * Le calcul est pur : il ne fait aucun appel réseau, ce qui le rend testable
 * avec des empreintes fabriquées. L'appelant est responsable de la sonde
 * (une requête `GET` sur la page d'accueil, avec garde SSRF).
 */
export function detectPlatform(fp: PageFingerprint): PlatformVerdict {
  let host = '';
  try {
    host = new URL(fp.finalUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }

  const scores = new Map<StorePlatform, { score: number; evidence: string[] }>();
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.test(fp, host);
    } catch {
      matched = false; // un indice qui lève n'élimine pas les autres
    }
    if (!matched) continue;
    const current = scores.get(rule.platform) ?? { score: 0, evidence: [] };
    current.score += rule.weight;
    current.evidence.push(rule.label);
    scores.set(rule.platform, current);
  }

  const classement = Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score);

  if (classement.length === 0 || classement[0][1].score < SEUIL_DECISION) {
    return {
      platform: 'unknown',
      score: classement[0]?.[1].score ?? 0,
      evidence: classement[0]?.[1].evidence ?? [],
      confidence: 'low',
      access: 'none',
    };
  }

  const [meilleur, données] = classement[0];
  const second = classement[1]?.[1].score ?? 0;
  const marge = données.score - second;
  const confidence: PlatformVerdict['confidence'] = données.score >= SEUIL_CONFIANCE_HAUTE && marge >= 2
    ? 'high'
    : marge >= 2
      ? 'medium'
      : 'low';

  return {
    platform: meilleur,
    score: données.score,
    evidence: données.evidence,
    confidence,
    access: accessFor(meilleur),
  };
}

/**
 * Points d'accès publics à essayer, dans l'ordre, pour la plateforme détectée.
 *
 * Aucun de ces chemins n'est deviné : ce sont ceux que les éditeurs exposent
 * eux-mêmes. Si l'un renvoie 404 ou 401, on ne « creuse » pas — on passe au
 * suivant, puis à l'import de fichier.
 */
export function publicCatalogEndpoints(platform: StorePlatform, root: URL): URL[] {
  const base = root.origin + root.pathname.replace(/\/$/, '');
  const make = (path: string) => new URL(`${base}${path}`);
  switch (platform) {
    case 'shopify':
      return [make('/products.json?limit=250')];
    case 'woocommerce':
      // Store API publique (WooCommerce 6+), en lecture seule.
      return [make('/wp-json/wc/store/v1/products?per_page=100')];
    default:
      return [];
  }
}

/** Racine de boutique à partir d'une URL validée. */
export { storeRoot };
