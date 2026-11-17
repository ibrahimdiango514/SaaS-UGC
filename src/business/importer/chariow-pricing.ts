/**
 * VYORA — connecteur Chariow : conversion des produits vers la forme commune.
 *
 * ## Le piège central de Chariow : les prix
 *
 * Chariow publie ses montants sous forme d'objets
 * `{ value, formatted, short, currency }`, où `value` est un **décimal en unité
 * principale** — `99` pour 99,00 $, `24.9` pour 24,90 €. Ce n'est **pas** une
 * unité mineure, contrairement à WooCommerce.
 *
 * Deux conséquences :
 *
 * 1. Il faut multiplier par `10 ** exposant` de la devise, une fois et une
 *    seule. Le normaliseur commun (`normalizeCatalogProduct`) sait le faire et
 *    nous le refaisons **pas** : on lui transmet `priceMinor` déjà calculé,
 *    qu'il prend comme valeur de référence.
 *
 * 2. L'exposant dépend de la devise. `24.9` en USD vaut 2490 centimes ;
 *    `24.9` en XOF vaut **25** francs (la devise n'a pas de subdivision, et
 *    0,9 arrondit à 1). Confondre les deux, c'est soit un facteur 100, soit des
 *    centimes fantômes — exactement le défaut déjà corrigé côté PrestaShop.
 *
 * `currencyExponent` vient du normaliseur commun : la règle des devises sans
 * décimale (XOF, XAF, JPY…) y est définie une fois, pas ici.
 *
 * ## Ce qui n'est jamais inventé
 *
 * - **Aucun SKU** : l'API Chariow n'en publie pas. `platformId` (`prd_…`) est
 *   la seule identité stable.
 * - **Aucune variante** : `has_variant_pricing` est un booléen. Le déplier en
 *   fausses variantes (« Option 1 ») polluerait le catalogue du marchand.
 * - **Aucun stock à zéro** : `quantity` peut être `null` (produit numérique sans
 *   gestion de stock) ; `null` reste `null`.
 */
import { currencyExponent } from './normalize.ts';
import type { ChariowProduct, ChariowStore, ChariowAmount } from './chariow-api.ts';

/* -------------------------------------------------------------------------- */
/* Montants                                                                    */
/* -------------------------------------------------------------------------- */

/** Lit un objet montant Chariow, en tolérant les formes partielles. */
function readAmount(raw: unknown): ChariowAmount | null {
  if (!raw || typeof raw !== 'object') return null;
  const objet = raw as Record<string, unknown>;
  const valeur = typeof objet.value === 'number' && Number.isFinite(objet.value)
    ? objet.value
    : typeof objet.value === 'string' && objet.value.trim() && Number.isFinite(Number(objet.value))
      ? Number(objet.value)
      : null;
  const currency = typeof objet.currency === 'string' && objet.currency.trim()
    ? objet.currency.trim().toUpperCase()
    : null;
  const formatted = typeof objet.formatted === 'string' && objet.formatted.trim()
    ? objet.formatted.trim()
    : null;
  if (valeur === null && currency === null && formatted === null) return null;
  return { value: valeur, currency, formatted };
}

/**
 * Choisit le prix à retenir parmi les montants publiés par Chariow.
 *
 * Ordre voulu, du plus « ce que le client paie » au plus théorique :
 *
 * 1. `pricing.effective` — le prix effectivement appliqué (promo comprise) ;
 * 2. `pricing.current_price` — le prix courant ;
 * 3. `pricing.price` — le prix catalogue, si les deux précédents manquent ;
 * 4. `pricing.sale_price` — dernier recours.
 *
 * `minimum_price` / `suggested_price` ne sont **jamais** retenus : sur un
 * produit « prix libre » (`what_you_want`), ce sont des bornes de saisie, pas
 * des prix de vente. Les prendre pour le prix afficherait « 0 $ » sur une
 * formation vendue au choix du client.
 *
 * Un prix absent (`null`) reste absent : le normaliseur le signalera comme
 * « prix à compléter », ce qui est plus honnête qu'un zéro.
 */
export function pickChariowPrice(pricing: unknown): ChariowAmount | null {
  if (!pricing || typeof pricing !== 'object') return null;
  const p = pricing as Record<string, unknown>;
  for (const cle of ['effective', 'current_price', 'price', 'sale_price'] as const) {
    const montant = readAmount(p[cle]);
    if (montant && montant.value !== null) return montant;
  }
  return null;
}

/**
 * Convertit un montant Chariow en unité mineure pour une devise donnée.
 *
 * ## Pourquoi `toFixed(6)` avant l'arrondi
 * `24.9 * 100` vaut `2490.0000000000005` en binaire. Sur une ligne isolée
 * l'écart est invisible ; sur un catalogue entier, il finit par produire des
 * centimes fantômes. On arrondit donc au millionième d'unité mineure avant
 * l'arrondi final — la même précaution que `parsePriceMinor`.
 *
 * ## Le cas XOF
 * `currencyExponent('XOF')` vaut 0 : `1500.5` devient `1501` (arrondi au franc),
 * et non `150050`. C'est le défaut « facteur 100 » qu'on refuse de reproduire.
 *
 * Rend `null` pour un montant absent ou négatif : un prix négatif est une
 * anomalie de la source, pas un prix à importer.
 */
export function amountToMinor(amount: ChariowAmount | null, currency: string): number | null {
  if (!amount || amount.value === null) return null;
  if (!Number.isFinite(amount.value) || amount.value < 0) return null;
  const exposant = currencyExponent(currency);
  const minor = Number((amount.value * 10 ** exposant).toFixed(6));
  if (!Number.isFinite(minor)) return null;
  if (!Number.isSafeInteger(Math.round(minor))) return null;
  return Math.round(minor);
}

/**
 * Détermine la devise d'un produit.
 *
 * Priorité au montant lui-même (`pricing.effective.currency`), puis à la devise
 * de référence `pricing.tracking.currency` (celle dans laquelle Chariow compte
 * réellement les ventes), puis à la devise de la boutique.
 *
 * On ne convertit JAMAIS entre devises : si un produit est libellé en USD et la
 * boutique en XOF, on garde USD et on le dit. Un taux de change inventé
 * produirait un prix faux, ce qui est pire qu'une devise mixte assumée.
 */
export function pickChariowCurrency(
  amount: ChariowAmount | null,
  trackingCurrency: string | null,
  fallback: string,
): string {
  const candidats = [amount?.currency, trackingCurrency, fallback];
  for (const candidat of candidats) {
    if (typeof candidat === 'string' && /^[A-Z]{3}$/.test(candidat)) return candidat;
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Stock                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Lit le stock restant d'un produit.
 *
 * `quantity` vaut `null` pour un produit sans gestion de stock (cas fréquent
 * des produits numériques). Ne pas le confondre avec zéro est essentiel :
 * afficher « en rupture » sur tout un catalogue numérique serait un défaut
 * visible immédiatement.
 *
 * Forme : `{ value, remaining: { value, percent }, sold: {…}, total }`.
 * On préfère `remaining.value` à `value`, qui peut désigner la quantité
 * initiale selon les produits.
 */
export function readChariowStock(quantity: unknown): number | null {
  if (!quantity || typeof quantity !== 'object') return null;
  const q = quantity as Record<string, unknown>;
  const restant = q.remaining;
  if (restant && typeof restant === 'object') {
    const valeur = (restant as Record<string, unknown>).value;
    if (typeof valeur === 'number' && Number.isFinite(valeur) && valeur >= 0) return Math.floor(valeur);
  }
  if (typeof q.value === 'number' && Number.isFinite(q.value) && q.value >= 0) return Math.floor(q.value);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Mapping produit                                                             */
/* -------------------------------------------------------------------------- */

/** Lit une chaîne bornée, `null` si vide. */
function texte(raw: unknown, max = 2000): string | null {
  if (typeof raw !== 'string') return null;
  const valeur = raw.trim();
  if (!valeur) return null;
  return valeur.length > max ? valeur.slice(0, max) : valeur;
}

/**
 * URL d'image exploitable, ou `null`.
 *
 * Seules les URL `https` publiques sont conservées : une `data:` ou une
 * `javascript:` dans un catalogue distant n'a rien à faire dans une fiche
 * produit VYORA.
 */
export function safeImageUrl(raw: unknown): string | null {
  const valeur = texte(raw, 2000);
  if (!valeur) return null;
  try {
    const url = new URL(valeur);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Convertit un produit Chariow en produit du modèle commun.
 *
 * Rend `null` quand le produit est inexploitable (identifiant ou nom absent) :
 * l'appelant le compte comme rejet avec sa raison.
 *
 * Le filtre `published` n'est **pas** appliqué ici : c'est une décision de
 * lecture, faite par `readChariowCatalog`, qui doit pouvoir compter les
 * brouillons écartés. Mélanger les deux ferait perdre ce décompte.
 */
export function mapChariowProduct(raw: unknown): ChariowProduct | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;

  const id = texte(p.id, 120);
  const name = texte(p.name, 300);
  if (!id || !name) return null;

  const pricing = (p.pricing ?? {}) as Record<string, unknown>;
  const amount = pickChariowPrice(pricing);

  const tracking = (pricing.tracking ?? {}) as Record<string, unknown>;
  const trackingCurrency = texte(tracking.currency, 8)?.toUpperCase() ?? null;

  const pictures = (p.pictures ?? {}) as Record<string, unknown>;
  // `cover` est l'image de fiche ; `thumbnail` est un recadrage. On préfère la
  // première, et on retombe sur la seconde — Chariow n'en publie que deux.
  const imageUrl = safeImageUrl(pictures.cover) ?? safeImageUrl(pictures.thumbnail);

  const categorie = p.category;
  const category = categorie && typeof categorie === 'object'
    ? {
      value: texte((categorie as Record<string, unknown>).value, 80),
      label: texte((categorie as Record<string, unknown>).label, 160),
    }
    : null;

  // Un produit « prix libre » n'a pas de prix de vente : `minimum_price` est
  // une borne, pas un prix. `is_free` le dit explicitement, et c'est la seule
  // source qu'on accepte pour affirmer « gratuit ».
  const isFree = p.is_free === true;
  const prixRetenu = isFree ? { value: 0, currency: amount?.currency ?? null, formatted: null } : amount;

  return {
    id,
    name,
    slug: texte(p.slug, 200),
    description: typeof p.description === 'string' ? p.description : '',
    status: texte(p.status, 20),
    type: texte(p.type, 40),
    category,
    isFree,
    imageUrl,
    amount: prixRetenu ?? { value: null, currency: null, formatted: null },
    trackingCurrency,
    stock: readChariowStock(p.quantity),
    // Booléen CONSERVÉ comme indicateur : il deviendra un avertissement dans
    // l'aperçu (« ce produit a des tarifs par variante que Chariow n'expose
    // pas »), jamais une liste de variantes fabriquée.
    hasVariantPricing: p.has_variant_pricing === true,
    onSaleUntil: texte(p.on_sale_until, 40),
  };
}

/* -------------------------------------------------------------------------- */
/* Mapping boutique                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Lit la boutique renvoyée par `GET /v1/store`.
 *
 * `GET /v1/store` répond `{ data: { … } }` — contrairement à la liste de
 * produits qui place `data` en tableau au même niveau. On accepte les deux
 * formes plutôt que de casser sur une variation de l'API.
 */
export function mapChariowStore(payload: unknown): ChariowStore {
  const racine = (payload as { data?: unknown })?.data;
  const brut = Array.isArray(racine) ? racine[0] : racine;
  const s = (brut && typeof brut === 'object' ? brut : {}) as Record<string, unknown>;
  const stats = (s.stats ?? {}) as Record<string, unknown>;
  const totalCustomers = typeof stats.total_customers === 'number' && Number.isFinite(stats.total_customers)
    ? stats.total_customers
    : null;

  return {
    id: texte(s.id, 120),
    name: texte(s.name, 200),
    description: texte(s.description, 2000),
    logoUrl: safeImageUrl(s.logo_url),
    url: texte(s.url, 500),
    status: texte(s.status, 40),
    totalCustomers,
  };
}

/**
 * Compare deux URL de boutique sans se laisser piéger par le schéma, le `www.`,
 * le port ou la casse.
 *
 * Sert à une seule chose : confirmer que la clé API appartient bien à la
 * boutique que le marchand a saisie. Sans cette comparaison, une clé d'une autre
 * boutique serait acceptée silencieusement, et l'import écraserait le catalogue
 * de la mauvaise entreprise.
 */
export function sameShopOrigin(a: string | null, b: string | null): boolean {
  const normaliser = (valeur: string | null): string | null => {
    if (!valeur) return null;
    try {
      const url = new URL(valeur.includes('://') ? valeur : `https://${valeur}`);
      return url.hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return null;
    }
  };
  const gauche = normaliser(a);
  const droite = normaliser(b);
  if (!gauche || !droite) return false;
  return gauche === droite;
}
