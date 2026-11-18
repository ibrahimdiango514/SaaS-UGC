/**
 * Connecteur « API personnalisée » — mapping déclaratif.
 *
 * ## Pourquoi ce module existe
 *
 * Toute API produit est le même objet vu sous un autre angle : un tableau
 * d'objets, un nom quelque part, un prix à convertir, parfois une image, un
 * stock, des variantes. Ce qui change d'une boutique à l'autre, c'est
 * uniquement **où** se trouvent ces informations.
 *
 * Sans ce module, chaque nouvelle plateforme coûterait un adaptateur dédié — et
 * c'est exactement ce que la mission demande d'éviter. Avec lui, supporter une
 * API inconnue revient à écrire une correspondance de champs, pas du code.
 *
 * ## Les trois règles de conception
 *
 * 1. **Aucune expression n'est évaluée.** Un chemin de champ est une suite de
 *    clés séparées par des points, parcourue par accès de propriété littéral.
 *    `<script>alert(1)</script>` dans un mapping n'exécute rien : il ne trouve
 *    simplement aucune propriété, et le produit est rejeté avec un motif.
 *
 * 2. **Un champ manquant est un fait, pas une erreur.** L'absence de prix ne
 *    fabrique pas `0` : elle produit `null` et un avertissement. Un prix à zéro
 *    inventé ferait vendre à perte sans que personne ne l'ait décidé.
 *
 * 3. **Le prix est le point le plus dangereux.** Une erreur d'exposant se
 *    traduit par un facteur 100 sur toute une boutique. On n'essaie donc jamais
 *    de deviner : l'unité de la source est **déclarée** (`major` = 12,50,
 *    `minor` = 1250), et une valeur incohérente est écartée avec un motif
 *    explicite plutôt que convertie au hasard.
 */

import { buildProduct, type NormalizedProduct, type ProductVariant } from './normalize';
import type { UrlRejection } from './url-guard';

/* -------------------------------------------------------------------------- */
/* Configuration de mapping                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Unité dans laquelle la source publie ses prix.
 *
 * - `major` : 12,50 € → `12.5` (ou `"12,50"`) ;
 * - `minor` : 12,50 € → `1250` en centimes.
 *
 * Il n'y a volontairement pas d'option « devine » : deviner est précisément ce
 * qui produit des prix faux d'un facteur 100.
 */
export type PriceUnit = 'major' | 'minor';

/** Correspondance d'un champ VYORA vers un chemin de la source. */
export interface FieldMapping {
  /**
   * Chemin de la propriété. Les points séparent les niveaux.
   *
   * Exemples : `name`, `title`, `attributes.name`, `price.amount`,
   * `images.0.src` (index numérique supporté pour les tableaux).
   */
  path: string;
  /**
   * Valeur ajoutée au prix, dans l'unité de la source.
   * Sert aux API qui publient un prix hors taxe et une taxe séparée.
   */
  addPath?: string;
  /** Multiplicateur appliqué avant conversion (API en centimes de centime…). */
  multiplier?: number;
}

/** Mapping complet d'une API vers le modèle VYORA. */
export interface CustomApiMapping {
  /** Champ du nom. Obligatoire : sans nom, le produit n'est pas identifiable. */
  name: FieldMapping;
  /** Champ de la description. */
  description?: FieldMapping;
  /** Champ du prix. */
  price?: FieldMapping;
  /** Champ d'une référence produit (SKU). */
  sku?: FieldMapping;
  /**
   * Identifiant du produit chez la source.
   *
   * Vivement recommandé : c'est ce qui permet de reconnaître un produit
   * renommé d'un import à l'autre. À défaut, le rapprochement se fait sur le
   * nom, ce qui casse dès qu'un marchand corrige une faute de frappe.
   */
  platformId?: FieldMapping;
  /** Champ de l'image principale. */
  image?: FieldMapping;
  /** Champ de l'URL produit. */
  productUrl?: FieldMapping;
  /**
   * Champ des catégories.
   *
   * Peut désigner un tableau de chaînes (`categories`) ou de tableaux
   * (`category.name`), auquel cas chaque élément est lu.
   */
  categories?: FieldMapping;
  /** Champ du stock. */
  stock?: FieldMapping;
  /** Champ de la devise, quand elle diffère de la devise par défaut. */
  currency?: FieldMapping;
  /** Champ des variantes. */
  variants?: VariantMapping;
}

export interface VariantMapping {
  /** Chemin du tableau de variantes, DANS chaque produit. */
  path: string;
  /** Nom lisible de la variante. À défaut, composé depuis les options. */
  name?: FieldMapping;
  price?: FieldMapping;
  sku?: FieldMapping;
  stock?: FieldMapping;
  /** Nom du critère (« Taille »), constant pour toutes les variantes. */
  attributeName?: string;
}

/** Résultat du mapping d'un élément brut. */
export type MappedProduct =
  | { ok: true; product: NormalizedProduct; warnings: string[] }
  | { ok: false; reason: string };

export interface MapOptions {
  /** Devise utilisée quand la source n'en déclare pas. */
  currency: string;
  /** Unité des prix de la source. */
  priceUnit: PriceUnit;
  /** URL de la boutique, pour résoudre les URL produits relatives. */
  shopUrl?: string;
  /** Référence de provenance, écrite dans les faits du produit. */
  sourceReference: string;
}

/* -------------------------------------------------------------------------- */
/* Lecture d'un chemin                                                        */
/* -------------------------------------------------------------------------- */

/** Clés qui désigneraient le prototype plutôt qu'une donnée. */
const CLES_INTERDITES = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Lit une valeur par chemin, sans rien interpréter.
 *
 * Un index numérique traverse un tableau (`images.0.src`). Une clé inconnue
 * rend `undefined` — jamais d'exception, jamais d'exécution.
 */
export function readPath(racine: unknown, chemin: string): unknown {
  if (!chemin) return undefined;
  let courant: unknown = racine;
  for (const segment of chemin.split('.')) {
    if (!segment) return undefined;
    if (CLES_INTERDITES.has(segment)) return undefined;
    if (courant === null || courant === undefined) return undefined;

    if (Array.isArray(courant)) {
      if (!/^\d+$/.test(segment)) return undefined;
      const index = Number(segment);
      if (index >= courant.length) return undefined;
      courant = courant[index];
      continue;
    }

    if (typeof courant !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(courant, segment)) return undefined;
    courant = (courant as Record<string, unknown>)[segment];
  }
  return courant;
}

/** Lit une chaîne, en refusant tout ce qui n'en est pas une. */
function lireTexte(valeur: unknown): string | null {
  if (typeof valeur === 'string') {
    const propre = valeur.trim();
    return propre.length > 0 ? propre : null;
  }
  // Un nombre peut légitimement tenir lieu de nom (« 42 ») : on l'accepte.
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return String(valeur);
  return null;
}

/**
 * Lit un nombre, y compris depuis une chaîne formatée.
 *
 * `"1 250,50 €"` → `1250.50`. Le séparateur décimal est déterminé par le
 * dernier séparateur présent : c'est la seule heuristique fiable pour les
 * formats européens comme anglo-saxons.
 */
function lireNombre(valeur: unknown): number | null {
  if (typeof valeur === 'number') return Number.isFinite(valeur) ? valeur : null;
  if (typeof valeur !== 'string') return null;

  const brut = valeur.replace(/[\s\u00a0\u202f]/g, '');
  // On retire tout sauf chiffres, virgules, points et signe.
  const nettoye = brut.replace(/[^\d.,+-]/g, '');
  if (!nettoye) return null;

  const derniereVirgule = nettoye.lastIndexOf(',');
  const dernierPoint = nettoye.lastIndexOf('.');
  let normalise: string;

  if (derniereVirgule > dernierPoint) {
    // Format européen : 1.234,56
    normalise = nettoye.replace(/\./g, '').replace(',', '.');
  } else if (dernierPoint > derniereVirgule) {
    // Format anglo-saxon : 1,234.56
    normalise = nettoye.replace(/,/g, '');
  } else {
    normalise = nettoye;
  }

  const nombre = Number(normalise);
  return Number.isFinite(nombre) ? nombre : null;
}

/* -------------------------------------------------------------------------- */
/* Conversion du prix                                                         */
/* -------------------------------------------------------------------------- */

/** Devises sans subdivision : 1500 vaut 1500, pas 15,00. */
const DEVISES_SANS_DECIMALE = new Set([
  'XOF', 'XAF', 'XPF', 'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'RWF', 'GNF', 'KMF', 'DJF', 'PYG', 'VUV',
]);

/**
 * Convertit un prix source en unité mineure (centimes).
 *
 * ## Pourquoi le résultat peut être `null`
 *
 * Écarter un prix vaut mieux que publier un prix faux : une fiche à 0 F se vend,
 * une fiche à 12 F au lieu de 1200 F se vend aussi — et c'est une perte sèche.
 * Tout ce qui n'est pas convertible proprement devient donc `null` avec un
 * motif, et l'interface montre ces produits comme « prix à compléter ».
 *
 * ## Bornes
 * Un prix négatif ou démesuré (au-delà de 10^12 en unité mineure) est refusé :
 * ce sont des valeurs d'erreur, pas des prix.
 */
export function toMinorUnits(
  valeur: unknown,
  currency: string,
  unit: PriceUnit,
): { minor: number | null; warning?: string } {
  const nombre = lireNombre(valeur);
  if (nombre === null) {
    return { minor: null, warning: 'prix absent ou illisible' };
  }
  if (nombre < 0) {
    return { minor: null, warning: 'prix négatif écarté' };
  }

  const devise = (currency ?? '').toUpperCase();
  const sansDecimale = DEVISES_SANS_DECIMALE.has(devise);

  let minor: number;
  if (unit === 'minor') {
    // La source publie déjà des centimes. En devise sans subdivision, l'unité
    // mineure EST l'unité principale : rien à convertir.
    minor = sansDecimale ? Math.round(nombre) : Math.round(nombre);
  } else {
    // La source publie l'unité principale (12,50). On multiplie par 100 sauf
    // devise sans subdivision.
    minor = sansDecimale ? Math.round(nombre) : Math.round(nombre * 100);
  }

  if (!Number.isFinite(minor) || minor < 0) {
    return { minor: null, warning: 'prix incohérent écarté' };
  }
  // 10^12 centimes = 10 milliards d'unités : au-delà, c'est une erreur de
  // source (un prix en micro-unités, par exemple), pas un prix.
  if (minor > 1_000_000_000_000) {
    return { minor: null, warning: 'prix démesuré écarté' };
  }
  return { minor };
}

/* -------------------------------------------------------------------------- */
/* Mise en correspondance                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Transforme un élément brut en produit normalisé, selon le mapping.
 *
 * Le résultat distingue trois cas :
 *   - `ok: true` avec un produit ;
 *   - `ok: false` avec un motif : l'élément ne décrit pas un produit (nom
 *     absent, prix illisible…) — il est **compté** parmi les rejets, jamais
 *     silencieusement ignoré ;
 *   - les avertissements, qui n'empêchent pas l'import.
 */
export function mapProduct(
  brut: unknown,
  mapping: CustomApiMapping,
  options: MapOptions,
): MappedProduct {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) {
    return { ok: false, reason: 'entrée qui n’est pas un objet produit' };
  }

  const nom = lireTexte(readPath(brut, mapping.name.path));
  if (!nom) {
    // Sans nom, rien ne permet d'identifier le produit ni de le dédoublonner.
    return { ok: false, reason: `nom introuvable au chemin « ${mapping.name.path} »` };
  }

  const warnings: string[] = [];
  const deviseBrute = mapping.currency ? lireTexte(readPath(brut, mapping.currency.path)) : null;
  const currency = (deviseBrute ?? options.currency).toUpperCase();

  /* ------------------------------- prix ---------------------------------- */

  let priceMinor: number | null = null;
  if (mapping.price) {
    const brutPrix = readPath(brut, mapping.price.path);
    const ajout = mapping.price.addPath ? lireNombre(readPath(brut, mapping.price.addPath)) : null;
    const base = lireNombre(brutPrix);
    const multiplicateur = typeof mapping.price.multiplier === 'number' && Number.isFinite(mapping.price.multiplier)
      ? mapping.price.multiplier
      : 1;

    // Un prix + taxe séparée : on additionne AVANT conversion, ce qui évite
    // d'arrondir deux fois.
    const total = base === null ? null : base + (ajout ?? 0);
    const converti = toMinorUnits(
      total === null ? null : total * multiplicateur,
      currency,
      options.priceUnit,
    );
    priceMinor = converti.minor;
    if (converti.warning) warnings.push(converti.warning);
    if (base === null) warnings.push(`prix introuvable au chemin « ${mapping.price.path} »`);
  } else {
    warnings.push('aucun champ de prix configuré');
  }

  /* ------------------------------- autres --------------------------------- */

  const description = mapping.description ? lireTexte(readPath(brut, mapping.description.path)) : null;
  const sku = mapping.sku ? lireTexte(readPath(brut, mapping.sku.path)) : null;
  const platformIdBrut = mapping.platformId ? readPath(brut, mapping.platformId.path) : null;
  const platformId = platformIdBrut === null || platformIdBrut === undefined
    ? null
    : (typeof platformIdBrut === 'string' || typeof platformIdBrut === 'number'
      ? String(platformIdBrut)
      : null);

  const imageBrute = mapping.image ? lireTexte(readPath(brut, mapping.image.path)) : null;
  const imageUrl = imageBrute ? resoudreUrl(imageBrute, options.shopUrl, warnings) : null;

  const urlBrute = mapping.productUrl ? lireTexte(readPath(brut, mapping.productUrl.path)) : null;
  const productUrl = urlBrute ? resoudreUrl(urlBrute, options.shopUrl, warnings) : null;

  const categories = mapping.categories ? lireCategories(readPath(brut, mapping.categories.path)) : [];

  let stock: number | null = null;
  if (mapping.stock) {
    const brutStock = lireNombre(readPath(brut, mapping.stock.path));
    if (brutStock === null) {
      warnings.push('stock illisible');
    } else if (brutStock < 0) {
      // Un stock négatif est une anomalie de la source : on ne le ramène pas à
      // zéro, ce qui ferait passer une erreur pour une rupture.
      warnings.push('stock négatif écarté');
    } else {
      stock = Math.floor(brutStock);
    }
  }

  const variantes = mapping.variants
    ? lireVariantes(brut, mapping.variants, { currency, priceUnit: options.priceUnit, warnings })
    : [];

  /*
   * `buildProduct` est le constructeur commun du produit normalisé.
   *
   * Le réutiliser garantit trois choses sans les réécrire ici : la même
   * empreinte de déduplication que l'import par fichier, les mêmes bornes
   * (nom 200, description 4000, 100 variantes) et le même nettoyage des
   * références. Un second constructeur finirait par diverger, et un produit
   * mappé ne serait alors plus reconnu comme identique à un produit importé.
   *
   * Le prix, lui, n'est PAS recalculé par `buildProduct` : il est passé tel
   * quel, déjà converti par `toMinorUnits`. Reconvertir reviendrait à deviner
   * l'unité une seconde fois.
   */
  const produit = buildProduct({
    name: nom,
    description: description ?? '',
    priceMinor,
    currency,
    productUrl,
    imageUrl,
    categories,
    variants: variantes,
    // `null` explicite = inconnu. On ne passe pas `undefined`, qui laisserait
    // `buildProduct` déduire un stock à partir des variantes.
    stock,
    sku,
    platformId,
    source: { platform: 'file', reference: options.sourceReference },
    warnings,
  });

  if ('error' in produit) {
    return { ok: false, reason: produit.error };
  }
  return { ok: true, product: produit, warnings };
}

/** Résout une URL relative contre la boutique, en refusant les schémas actifs. */
function resoudreUrl(brut: string, shopUrl: string | undefined, warnings: string[]): string | null {
  // `javascript:` et `data:` ne sont pas des images ni des liens : ils
  // exécuteraient du code dans la page. Refus net, pas de nettoyage.
  if (/^(javascript|data|vbscript|file):/i.test(brut.trim())) {
    warnings.push('URL au schéma interdit écartée');
    return null;
  }
  try {
    if (shopUrl) return new URL(brut, shopUrl).toString();
    return new URL(brut).toString();
  } catch {
    warnings.push('URL illisible écartée');
    return null;
  }
}

/** Lit des catégories : tableau de chaînes, ou tableau d'objets. */
function lireCategories(valeur: unknown): string[] {
  if (Array.isArray(valeur)) {
    const sorties: string[] = [];
    for (const element of valeur) {
      if (typeof element === 'string') {
        const propre = element.trim();
        if (propre) sorties.push(propre);
        continue;
      }
      // Tableau d'objets : on cherche un `name`/`title` — c'est la forme que
      // prennent les catégories dans la quasi-totalité des API.
      if (element && typeof element === 'object') {
        const nom = lireTexte(readPath(element, 'name') ?? readPath(element, 'title'));
        if (nom) sorties.push(nom);
      }
    }
    return [...new Set(sorties)].slice(0, 12);
  }
  // Une chaîne unique est une catégorie, pas un tableau.
  const unique = lireTexte(valeur);
  return unique ? [unique] : [];
}

/** Lit les variantes d'un produit. */
function lireVariantes(
  brut: unknown,
  mapping: VariantMapping,
  contexte: { currency: string; priceUnit: PriceUnit; warnings: string[] },
): ProductVariant[] {
  const tableau = readPath(brut, mapping.path);
  if (tableau === undefined) return [];
  if (!Array.isArray(tableau)) {
    contexte.warnings.push(`variantes : le chemin « ${mapping.path} » n’est pas un tableau`);
    return [];
  }

  const variantes: ProductVariant[] = [];
  for (const [index, element] of tableau.entries()) {
    if (!element || typeof element !== 'object') continue;

    const nomFourni = mapping.name ? lireTexte(readPath(element, mapping.name.path)) : null;
    /*
     * Sans nom fourni, on numérote (« Variante 2 ») au lieu d'écrire un nom
     * vide : le produit resterait importable mais illisible à l'écran, et
     * l'utilisateur ne saurait pas quelle déclinaison il modifie.
     */
    const nom = nomFourni ?? `Variante ${index + 1}`;

    let prixMinor: number | null = null;
    if (mapping.price) {
      const converti = toMinorUnits(readPath(element, mapping.price.path), contexte.currency, contexte.priceUnit);
      prixMinor = converti.minor;
      if (converti.warning) contexte.warnings.push(`variante ${index + 1} : ${converti.warning}`);
    }

    const stockBrut = mapping.stock ? lireNombre(readPath(element, mapping.stock.path)) : null;

    variantes.push({
      name: nom,
      priceMinor: prixMinor,
      currency: null,
      sku: mapping.sku ? lireTexte(readPath(element, mapping.sku.path)) : null,
      stock: stockBrut !== null && stockBrut >= 0 ? Math.floor(stockBrut) : null,
      available: stockBrut !== null ? stockBrut > 0 : null,
      attributeName: mapping.attributeName ?? null,
    });
    if (variantes.length >= 100) break;
  }
  return variantes;
}

/* -------------------------------------------------------------------------- */
/* Validation du mapping                                                      */
/* -------------------------------------------------------------------------- */

export type MappingRejection = UrlRejection | 'name_required' | 'path_invalid' | 'price_unit_invalid';

export interface MappingValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Valide un mapping avant enregistrement.
 *
 * On refuse un mapping **inutilisable** (sans nom), pas un mapping incomplet :
 * une API sans prix reste importable, avec un avertissement. En revanche un
 * chemin syntaxiquement impossible (`a..b`, `.a`, `a.`) est refusé tout de
 * suite — il ne pourrait que produire des produits sans nom.
 */
export function validateMapping(mapping: CustomApiMapping, priceUnit: PriceUnit): MappingValidation {
  const errors: string[] = [];

  const verifierChemin = (chemin: string, etiquette: string) => {
    if (!chemin || !chemin.trim()) {
      errors.push(`${etiquette} : indiquez un chemin.`);
      return;
    }
    if (chemin.startsWith('.') || chemin.endsWith('.') || chemin.includes('..')) {
      errors.push(`${etiquette} : chemin invalide « ${chemin} ».`);
      return;
    }
    if (chemin.split('.').some((s) => CLES_INTERDITES.has(s))) {
      errors.push(`${etiquette} : chemin réservé « ${chemin} ».`);
    }
  };

  if (!mapping.name?.path) {
    errors.push('Le nom du produit est obligatoire.');
  } else {
    verifierChemin(mapping.name.path, 'Nom');
  }

  for (const [etiquette, champ] of Object.entries({
    Description: mapping.description,
    Prix: mapping.price,
    Référence: mapping.sku,
    Identifiant: mapping.platformId,
    Image: mapping.image,
    'URL produit': mapping.productUrl,
    Catégories: mapping.categories,
    Stock: mapping.stock,
    Devise: mapping.currency,
  })) {
    if (champ) verifierChemin(champ.path, etiquette);
  }

  if (mapping.variants) {
    verifierChemin(mapping.variants.path, 'Variantes');
    for (const [etiquette, champ] of Object.entries({
      'Nom de variante': mapping.variants.name,
      'Prix de variante': mapping.variants.price,
      'Référence de variante': mapping.variants.sku,
      'Stock de variante': mapping.variants.stock,
    })) {
      if (champ) verifierChemin(champ.path, etiquette);
    }
  }

  if (priceUnit !== 'major' && priceUnit !== 'minor') {
    errors.push('Unité de prix inconnue.');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Mapping proposé à partir des champs observés dans une réponse.
 *
 * ## Pourquoi proposer plutôt qu'imposer
 *
 * L'utilisateur voit une liste de champs (`id`, `title`, `price`, `images`…) et
 * ne sait pas toujours quoi mettre où. Une proposition correcte dans 80 % des
 * cas lui évite de tout saisir, et il peut la corriger : rien n'est appliqué
 * sans son accord.
 *
 * Les alias couvrent les conventions réellement rencontrées, Shopify/Woo
 * comprises. Aucun alias ne devine un chemin profond : mieux vaut ne rien
 * proposer qu'un mapping faux.
 */
export function suggestMapping(sampleFields: string[]): Partial<CustomApiMapping> {
  const champs = new Set(sampleFields.map((f) => f.toLowerCase()));
  const trouve = (...candidats: string[]): FieldMapping | undefined => {
    for (const candidat of candidats) {
      if (champs.has(candidat)) return { path: candidat };
    }
    return undefined;
  };

  const proposition: Partial<CustomApiMapping> = {
    name: trouve('name', 'title', 'product_name', 'nom', 'label') ?? { path: 'name' },
    description: trouve('description', 'body_html', 'short_description', 'details', 'desc'),
    price: trouve('price', 'regular_price', 'sale_price', 'unit_price', 'prix', 'amount'),
    sku: trouve('sku', 'reference', 'code', 'ref', 'part_number'),
    platformId: trouve('id', '_id', 'product_id', 'uuid', 'handle'),
    image: trouve('image', 'image_url', 'thumbnail', 'featured_image', 'picture'),
    productUrl: trouve('url', 'link', 'permalink', 'product_url', 'href'),
    categories: trouve('categories', 'category', 'tags', 'collections'),
    stock: trouve('stock', 'quantity', 'stock_quantity', 'inventory_quantity', 'available_quantity'),
    currency: trouve('currency', 'currency_code', 'devise'),
  };

  // On ne rend que les champs réellement trouvés : une proposition vide est
  // plus honnête qu'un chemin inventé qui échouera à l'import.
  for (const cle of Object.keys(proposition) as Array<keyof CustomApiMapping>) {
    if (proposition[cle] === undefined) delete proposition[cle];
  }
  return proposition;
}
