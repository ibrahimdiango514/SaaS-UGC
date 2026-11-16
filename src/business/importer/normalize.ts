/**
 * VYORA — normalisation des produits importés.
 *
 * ## Le problème
 *
 * Un même produit arrive sous quatre formes selon la source :
 * Shopify (`{title, body_html, variants:[{price}], image:{src}}`),
 * WooCommerce Store API (`{name, description, prices:{price}, images:[]}`),
 * un CSV collé par un humain (`Nom;Prix;Description`), et un XML de flux.
 * Sans normalisation, l'import produit quatre qualités de données différentes
 * et la détection de doublons ne détecte rien.
 *
 * ## Ce que « normaliser » veut dire ici
 *
 *   - **prix** : un entier en unité mineure (`priceMinor`) plus une devise ISO.
 *     On ne stocke jamais un flottant monétaire : `19.99` en flottant devient
 *     `19.989999…` dès la première multiplication.
 *   - **texte** : HTML nettoyé (aucune balise, aucune entité), espaces
 *     compactés, longueurs bornées. Un `body_html` Shopify contient des
 *     `<script>` : ils ne doivent jamais atteindre l'interface.
 *   - **URL** : seules `https` publiques sont conservées ; une URL d'image en
 *     `javascript:` ou en `data:` est rejetée.
 *   - **empreinte** : un identifiant de déduplication calculé sur le nom et la
 *     marque, insensible à la casse, aux accents et à la ponctuation.
 */
import type { StorePlatform } from './platform.ts';

/** Un produit normalisé, prêt pour la prévisualisation et l'écriture. */
export interface NormalizedProduct {
  /** Nom affiché, jamais vide. */
  name: string;
  description: string;
  /** Prix en unité mineure (centimes), ou `null` si absent. */
  priceMinor: number | null;
  currency: string;
  /** URL produit, si la source en fournit une. */
  productUrl: string | null;
  /** Première image utilisable, ou `null`. */
  imageUrl: string | null;
  categories: string[];
  variants: ProductVariant[];
  /**
   * Quantité disponible, quand la source la fournit.
   *
   * `null` signifie « inconnu », et non « zéro » : confondre les deux ferait
   * afficher « en rupture » sur tout un catalogue dont la colonne stock est
   * simplement absente. Un stock négatif est une anomalie : il est écarté avec
   * un avertissement, pas ramené à zéro.
   */
  stock: number | null;
  /** Empreinte de déduplication — voir `productFingerprint`. */
  fingerprint: string;
  /** Provenance, pour l'audit et le message d'erreur. */
  source: { platform: StorePlatform | 'file'; reference: string };
  /**
   * Champs dont la valeur a été corrigée ou écartée. L'interface les affiche :
   * un import silencieusement « réparé » est un import qu'on ne peut pas auditer.
   */
  warnings: string[];
}

export interface ProductVariant {
  name: string;
  priceMinor: number | null;
  /** Devise propre à la variante : `null` = celle du produit parent. */
  currency: string | null;
  sku: string | null;
  /**
   * Quantité propre à la variante.
   *
   * Distincte du stock du produit parent, qui est la SOMME des variantes : le
   * parent répond « combien en tout », la variante répond « combien en M ».
   * `null` = inconnu, jamais zéro.
   */
  stock: number | null;
  available: boolean | null;
  /** Nom du critère (« Taille », « Couleur »), quand la source le fournit. */
  attributeName: string | null;
}

/** Limites hautes : elles protègent la mémoire et l'affichage. */
export const LIMITS: {
  name: number; description: number; url: number; categories: number; variants: number; benefits: number;
} = {
  name: 200,
  description: 4000,
  url: 1000,
  categories: 12,
  variants: 100,
  benefits: 8,
};

/** Devise par défaut, cohérente avec le reste de l'application. */
export const DEFAULT_CURRENCY = 'XOF';

/** Devises sans subdivision : un prix de 1500 vaut 1500, pas 15,00. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'XOF', 'XAF', 'XPF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'GNF', 'KMF', 'DJF', 'PYG', 'VUV',
]);

/**
 * Devises connues : celles que l'application sait formater et écrire.
 *
 * Une devise absente de cette liste n'est pas « exotique mais valable » : elle
 * n'a pas d'exposant connu, donc un prix dans cette devise serait converti avec
 * un facteur arbitraire. On retombe sur la devise par défaut **en le disant**,
 * plutôt que d'inventer une conversion.
 */
export const KNOWN_CURRENCIES = new Set([
  ...['XOF', 'XAF', 'XPF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'GNF', 'KMF', 'DJF', 'PYG', 'VUV'],
  'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK', 'DKK',
  'CNY', 'HKD', 'SGD', 'INR', 'BRL', 'MXN', 'ZAR', 'NGN', 'GHS', 'MAD', 'TND', 'DZD', 'EGP',
  'AED', 'SAR', 'TRY', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'ILS', 'THB', 'IDR', 'MYR', 'PHP', 'TWD',
]);

/** Ramène une devise reçue à une devise connue, sinon la devise par défaut. */
export function normalizeCurrency(raw: unknown): { currency: string; warning?: string } {
  const valeur = String(raw ?? '').trim().toUpperCase();
  if (!valeur) return { currency: DEFAULT_CURRENCY };
  // Certains fichiers mettent le symbole plutôt que le code.
  const symboles: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY' };
  const code = symboles[valeur] ?? valeur;
  if (!/^[A-Z]{3}$/.test(code)) return { currency: DEFAULT_CURRENCY, warning: `devise « ${valeur} » inconnue, remplacée par ${DEFAULT_CURRENCY}` };
  if (!KNOWN_CURRENCIES.has(code)) return { currency: DEFAULT_CURRENCY, warning: `devise « ${valeur} » non prise en charge, remplacée par ${DEFAULT_CURRENCY}` };
  return { currency: code };
}

/** Nombre de décimales d'une devise. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/**
 * Convertit un prix textuel en unité mineure.
 *
 * Accepte `1 500,50`, `1,500.50`, `1500`, `€19.99`, `19.99 EUR`.
 * Refuse ce qui n'est pas un nombre : mieux vaut `null` (prix inconnu) qu'un
 * prix faux — un prix faux se propage dans les devis.
 */
export function parsePriceMinor(raw: unknown, currency: string): { minor: number | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') return { minor: null };
  const exponent = currencyExponent(currency);

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return { minor: null, warning: 'prix numérique invalide' };
    // Les API Shopify fournissent déjà des chaînes décimales ; un nombre reçu
    // ici est une valeur en unité principale.
    //
    // `Math.round` ne suffit pas : un tableur stocke 24.9 en binaire, et
    // `24.9 * 100` vaut 2490.0000000000005. Sur une ligne isolée l'écart est
    // négligeable, mais une multiplication répétée sur un catalogue entier
    // finit par produire des centimes fantômes. On arrondit donc au centième
    // d'unité mineure avant l'arrondi final.
    return { minor: Math.round(Number((raw * 10 ** exponent).toFixed(6))) };
  }

  const texte = String(raw).trim();
  // On isole les chiffres et séparateurs, en ignorant symbole et code devise.
  const nettoye = texte.replace(/[^\d.,-]/g, '');
  if (!nettoye || !/\d/.test(nettoye)) return { minor: null, warning: 'prix illisible' };

  // Déterminer le séparateur décimal : le dernier séparateur rencontré, à
  // condition qu'il soit suivi d'un nombre de chiffres plausible.
  const dernierPoint = nettoye.lastIndexOf('.');
  const derniereVirgule = nettoye.lastIndexOf(',');
  const separateur = Math.max(dernierPoint, derniereVirgule);
  let entier: string;
  let decimales = '';
  /** Arrondi pour une devise sans décimales (voir plus bas). */
  let arrondi = 0;

  if (separateur === -1) {
    entier = nettoye;
  } else if (exponent === 0) {
    // Devise sans unité subdivisionnaire (XOF, JPY…). Les branches ci-dessous
    // supposent `exponent > 0` : sans ce cas dédié, « 12000.00 » (prix Shopify
    // en XOF) était lu 1 200 000 — facteur 100.
    // Le DERNIER groupe décide : 1 ou 2 chiffres après le dernier séparateur
    // sont une décimale (« 12,000.00 »), arrondie à l'unité ; 3 chiffres sont
    // des milliers (« 1.200.000 »). Les séparateurs précédents sont des
    // milliers et disparaissent au nettoyage.
    const apres = nettoye.slice(separateur + 1);
    if (apres.length > 0 && apres.length <= 2) {
      entier = nettoye.slice(0, separateur);
      arrondi = apres[0] >= '5' ? 1 : 0;
    } else {
      entier = nettoye;
    }
  } else {
    const apres = nettoye.slice(separateur + 1);
    // « 1,500 » avec 3 chiffres après la virgule : c'est un séparateur de
    // milliers, pas une décimale (sauf devise à 3 décimales, rare).
    if (apres.length === exponent && exponent > 0) {
      entier = nettoye.slice(0, separateur);
      decimales = apres;
    } else if (apres.length === 0) {
      entier = nettoye.slice(0, separateur);
    } else if (apres.length <= exponent && exponent > 0) {
      entier = nettoye.slice(0, separateur);
      decimales = apres.padEnd(exponent, '0');
    } else {
      entier = nettoye;
    }
  }

  const chiffres = entier.replace(/[.,]/g, '');
  if (!/^-?\d+$/.test(chiffres)) return { minor: null, warning: 'prix illisible' };
  const valeur = Number(chiffres);
  if (!Number.isFinite(valeur) || valeur < 0) return { minor: null, warning: 'prix négatif ou hors limites' };
  const dec = Number(decimales || '0');
  const minor = valeur * 10 ** exponent + (exponent > 0 ? dec : arrondi);
  if (!Number.isSafeInteger(minor)) return { minor: null, warning: 'prix hors limites' };
  return { minor };
}

/** Inverse : unité mineure → chaîne décimale, pour l'affichage et l'écriture. */
export function minorToDecimal(minor: number | null, currency: string): number | null {
  if (minor === null) return null;
  const exponent = currencyExponent(currency);
  return exponent === 0 ? minor : Math.round(minor) / 10 ** exponent;
}

/** Retire les balises et décode les entités les plus courantes. */
export function stripHtml(raw: unknown, maxLength = LIMITS.description): string {
  if (raw === null || raw === undefined) return '';
  let texte = String(raw);
  // Blocs de script et de style : leur contenu n'est jamais du texte produit.
  texte = texte.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  texte = texte.replace(/<br\s*\/?>/gi, ' ');
  texte = texte.replace(/<\/(p|div|li|h[1-6])>/gi, ' ');
  texte = texte.replace(/<[^>]+>/g, '');
  const entites: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&apos;': "'", '&eacute;': 'é', '&egrave;': 'è', '&agrave;': 'à',
    '&ccedil;': 'ç', '&ugrave;': 'ù', '&ecirc;': 'ê', '&ocirc;': 'ô',
  };
  texte = texte.replace(/&[a-z#0-9]+;/gi, (m) => entites[m.toLowerCase()] ?? ' ');
  return texte.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/**
 * Valide une URL distante.
 *
 * Seules `https` sont conservées. `javascript:`, `data:` et `blob:` sont
 * écartés : une URL d'image issue d'une source non fiable ne doit jamais
 * pouvoir exécuter quoi que ce soit une fois affichée.
 */
export function safeRemoteUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString().slice(0, LIMITS.url);
  } catch {
    return null;
  }
}

/**
 * Normalise un nom pour la comparaison : minuscules, sans accents, sans
 * ponctuation, espaces compactés.
 *
 * `Sérum Éclat 30ml` et `SERUM ECLAT - 30 ML` donnent la même clé. C'est ce qui
 * rend la détection de doublons utile plutôt qu'approximative.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Empreinte de déduplication.
 *
 * Volontairement **pas** un identifiant de source : deux imports successifs du
 * même catalogue doivent produire la même empreinte, même si l'identifiant
 * distant change (Shopify change d'ID lors d'une recréation de boutique).
 */
export function productFingerprint(name: string, categories: string[] = []): string {
  const base = [nameKey(name), ...categories.slice(0, 2).map(nameKey)].filter(Boolean).join('|');
  // FNV-1a 32 bits : court, déterministe, suffisant pour une comparaison locale
  // (ce n'est pas un identifiant de sécurité).
  let hash = 0x811c9dc5;
  for (let i = 0; i < base.length; i += 1) {
    hash ^= base.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Nettoie une liste de catégories. */
export function normalizeCategories(raw: unknown): string[] {
  const brut = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;|>]/) : [];
  const vues = new Set<string>();
  for (const valeur of brut) {
    const texte = stripHtml(valeur, 80);
    if (!texte) continue;
    const cle = nameKey(texte);
    if (!cle || vues.has(cle)) continue;
    vues.add(cle);
    if (vues.size >= LIMITS.categories) break;
  }
  return Array.from(vues).map((cle) => cle);
}

/** Construit un produit normalisé à partir des champs déjà extraits. */
export function buildProduct(input: {
  name: unknown;
  description?: unknown;
  priceMinor?: number | null;
  currency?: string;
  productUrl?: unknown;
  imageUrl?: unknown;
  categories?: unknown;
  variants?: ProductVariant[];
  stock?: unknown;
  source: NormalizedProduct['source'];
  warnings?: string[];
}): NormalizedProduct | { error: string } {
  const name = stripHtml(input.name, LIMITS.name);
  if (!name) return { error: 'nom manquant' };

  const currency = (input.currency ?? DEFAULT_CURRENCY).toUpperCase().slice(0, 3);
  const categories = normalizeCategories(input.categories);
  const avertissements = [...(input.warnings ?? [])];
  const stock = parseStock(input.stock);
  if (stock.warning) avertissements.push(stock.warning);

  return {
    name,
    description: stripHtml(input.description ?? ''),
    priceMinor: input.priceMinor ?? null,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY,
    productUrl: safeRemoteUrl(input.productUrl),
    imageUrl: safeRemoteUrl(input.imageUrl),
    categories,
    variants: (input.variants ?? []).slice(0, LIMITS.variants),
    stock: stock.value,
    fingerprint: productFingerprint(name, categories),
    source: input.source,
    warnings: avertissements,
  };
}

/**
 * Lit une quantité en stock.
 *
 * Trois issues, volontairement distinctes :
 *   - valeur absente → `null` (inconnu), sans avertissement : une colonne stock
 *     facultative n'est pas une anomalie ;
 *   - valeur illisible ou négative → `null` **avec** un avertissement : la
 *     donnée est fausse, et le taire ferait croire à un stock nul ;
 *   - valeur valide → l'entier.
 */
export function parseStock(raw: unknown): { value: number | null; warning?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const texte = String(raw).trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(texte)) return { value: null, warning: 'stock illisible, écarté' };
  const valeur = Number(texte);
  if (!Number.isFinite(valeur)) return { value: null, warning: 'stock illisible, écarté' };
  if (valeur < 0) return { value: null, warning: 'stock négatif, écarté' };
  return { value: Math.floor(valeur) };
}

/**
 * Détecte les doublons dans un lot et face au catalogue existant.
 *
 * Deux niveaux, distingués à l'écran parce qu'ils n'ont pas le même sens :
 *   - **`in-batch`** : le même produit apparaît deux fois dans la source ;
 *   - **`existing`** : il existe déjà dans le catalogue de l'entreprise.
 *
 * Aucun produit n'est supprimé automatiquement : on marque, l'utilisateur
 * décide. Une déduplication silencieuse ferait perdre des variantes légitimes.
 */
export type DuplicateKind = 'in-batch' | 'existing';

export interface DuplicateHit {
  index: number;
  kind: DuplicateKind;
  /** Index du premier produit identique, pour un doublon interne au lot. */
  against?: number;
  existingId?: string;
}

export function findDuplicates(
  products: NormalizedProduct[],
  existing: Array<{ id: string; name: string }> = [],
): DuplicateHit[] {
  const parEmpreinte = new Map<string, number>();
  const existants = new Map<string, string>();
  for (const produit of existing) {
    const cle = productFingerprint(produit.name);
    if (!existants.has(cle)) existants.set(cle, produit.id);
  }

  const hits: DuplicateHit[] = [];
  products.forEach((produit, index) => {
    const premier = parEmpreinte.get(produit.fingerprint);
    if (premier !== undefined) {
      hits.push({ index, kind: 'in-batch', against: premier });
      return;
    }
    parEmpreinte.set(produit.fingerprint, index);
    const existant = existants.get(produit.fingerprint) ?? existants.get(productFingerprint(produit.name));
    if (existant) hits.push({ index, kind: 'existing', existingId: existant });
  });
  return hits;
}
