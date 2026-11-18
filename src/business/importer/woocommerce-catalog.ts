/**
 * VYORA — connecteur WooCommerce : projection vers la forme brute commune.
 *
 * Comme pour Shopify et PrestaShop, ce module ne normalise rien : il produit des
 * `RawCatalogProduct`, puis `normalizeCatalog` applique les mêmes règles de prix,
 * de devise et d'arrondi, `matchBatch` le même rapprochement, et l'aperçu le même
 * rendu. Un produit WooCommerce et son équivalent PrestaShop donnent donc la même
 * fiche VYORA.
 *
 * ## L'unité de prix, point le plus piégeux
 *
 * L'API REST v3 publie le prix en **chaîne décimale** (`"12.50"`), comme
 * PrestaShop, et non en unité mineure comme la Store API publique
 * (`/wp-json/wc/store/v1/products`). Confondre les deux multiplie tous les prix
 * par 100. On lit donc `price` (v3), jamais `prices.price` (Store API).
 *
 * ## Les variations
 *
 * Un produit `variable` porte ses variations dans `__variations`, ajouté par le
 * lecteur après un appel dédié. Une variation a son propre prix, son SKU, sa
 * quantité. Quand le produit n'a PAS de variations lisibles, on ne fabrique pas
 * de fausse déclinaison : la fiche reste simple, avec un avertissement.
 */
import type { RawCatalogProduct } from './sources.ts';
import type { WooCatalog } from './woocommerce-api.ts';

/** Statuts WooCommerce considérés comme publiés. */
export const WOO_PUBLISHED = 'publish';

/** Extrait l'URL d'image, en préférant la plus grande taille disponible. */
function imageDe(produit: Record<string, unknown>): string | null {
  const images = Array.isArray(produit.images) ? produit.images : [];
  for (const image of images) {
    const src = (image as { src?: unknown })?.src;
    if (typeof src === 'string' && src.trim()) return src.trim();
  }
  return null;
}

/**
 * Noms de catégories.
 *
 * L'API publie `categories: [{ id, name, slug }]` : le nom y est déjà. On
 * n'utilise la table `categories` du catalogue que lorsque le nom manque, pour
 * ne pas dépendre d'un second appel.
 */
function categoriesDe(produit: Record<string, unknown>, table: Map<number, string>): string[] {
  const liste = Array.isArray(produit.categories) ? produit.categories : [];
  const noms: string[] = [];
  for (const brut of liste) {
    const categorie = brut as Record<string, unknown>;
    const nom = typeof categorie.name === 'string' ? categorie.name.trim() : '';
    if (nom) {
      noms.push(nom);
      continue;
    }
    const id = Number(categorie.id);
    if (Number.isFinite(id) && table.has(id)) noms.push(table.get(id) as string);
  }
  return noms;
}

/** Lit une quantité de stock. `null` (non suivi) ≠ `0` (épuisé). */
function quantiteDe(valeur: unknown): number | null {
  if (valeur === null || valeur === undefined) return null;
  const nombre = Number(valeur);
  if (!Number.isFinite(nombre)) return null;
  return Math.max(0, Math.trunc(nombre));
}

/** Prix publié : chaîne décimale, reprise telle quelle. */
function prixDe(valeur: unknown): string | number | null {
  if (typeof valeur === 'string' && valeur.trim()) return valeur.trim();
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return valeur;
  return null;
}

/**
 * Convertit un produit WooCommerce en produit brut commun.
 *
 * Rend `null` quand la fiche n'est pas exploitable (nom vide, identifiant
 * absent) : l'appelant le compte comme rejeté.
 */
export function toWooRawProduct(
  produit: Record<string, unknown>,
  table: Map<number, string>,
): RawCatalogProduct | null {
  const nom = typeof produit.name === 'string' ? produit.name.trim() : '';
  if (!nom) return null;

  const id = produit.id;
  const plateformeId = (typeof id === 'number' || typeof id === 'string') && String(id).trim()
    ? String(id).trim()
    : null;

  const variations = Array.isArray(produit.__variations)
    ? produit.__variations as Array<Record<string, unknown>>
    : [];

  const mappees = variations.map((variation) => {
    const stock = quantiteDe(variation.stock_quantity);
    const attributs = Array.isArray(variation.attributes)
      ? variation.attributes as Array<Record<string, unknown>>
      : [];
    // `attributes[].option` est la VALEUR (« Rouge ») ; le NOM du critère
    // (« Couleur ») est souvent vide dans la réponse des variations.
    const valeurs = attributs
      .map((a) => (typeof a.option === 'string' ? a.option.trim() : ''))
      .filter(Boolean);
    const nomCritere = attributs
      .map((a) => (typeof a.name === 'string' ? a.name.trim() : ''))
      .find(Boolean) ?? null;

    return {
      name: valeurs.length > 0 ? valeurs.join(' / ') : 'Variante',
      price: prixDe(variation.price) ?? prixDe(variation.regular_price),
      sku: typeof variation.sku === 'string' && variation.sku.trim() ? variation.sku.trim() : null,
      // `stock_status` est publié même sans gestion de stock : c'est la source
      // fiable de « en stock / en rupture ».
      available: typeof variation.stock_status === 'string'
        ? variation.stock_status === 'instock'
        : null,
      stock,
      attributeName: nomCritere,
    };
  });

  const stocksConnus = mappees.map((v) => v.stock).filter((q): q is number => typeof q === 'number');
  const stockDuProduit = quantiteDe(produit.stock_quantity);
  const stockTotal = stocksConnus.length > 0
    ? stocksConnus.reduce((somme, q) => somme + q, 0)
    : stockDuProduit;

  const prixProduit = prixDe(produit.price)
    ?? prixDe(produit.regular_price)
    ?? (mappees.length > 0 ? mappees[0].price : null);

  return {
    name: nom,
    // `description` est le texte long ; `short_description` en est un résumé.
    // On préfère le long quand il existe, sinon le court — jamais les deux
    // concaténés, ce qui dupliquerait le contenu.
    description: typeof produit.description === 'string' && produit.description.trim()
      ? produit.description
      : (typeof produit.short_description === 'string' ? produit.short_description : ''),
    price: prixProduit,
    // La devise n'est pas publiée par l'API v3 : l'appelant fournit la sienne,
    // ou la normalisation retombe sur la devise par défaut.
    currency: null,
    productUrl: typeof produit.permalink === 'string' && produit.permalink.trim()
      ? produit.permalink.trim()
      : null,
    imageUrl: imageDe(produit),
    categories: categoriesDe(produit, table),
    variants: mappees,
    // Le SKU produit n'a de sens que sans variations : avec plusieurs, le SKU
    // de la première appartient à une taille.
    sku: mappees.length === 0 && typeof produit.sku === 'string' && produit.sku.trim()
      ? produit.sku.trim()
      : null,
    platformId: plateformeId,
    stock: stockTotal,
  };
}

/**
 * Projette un catalogue WooCommerce complet.
 *
 * Rend aussi la liste des produits variables dont AUCUNE variation n'a pu être
 * lue : ce sont ceux dont le prix affiché pourrait être faux, et l'aperçu doit
 * le signaler plutôt que de laisser croire à une fiche complète.
 */
export function toWooRawProducts(catalogue: WooCatalog): {
  produits: RawCatalogProduct[];
  rejets: Array<{ line: number; reason: string }>;
  variantes: number;
  variablesSansVariations: string[];
} {
  const produits: RawCatalogProduct[] = [];
  const rejets: Array<{ line: number; reason: string }> = [];
  const variablesSansVariations: string[] = [];
  let variantes = 0;

  catalogue.products.forEach((brut, index) => {
    const produit = brut as Record<string, unknown>;
    const statut = typeof produit.status === 'string' ? produit.status : WOO_PUBLISHED;
    if (statut !== WOO_PUBLISHED) {
      rejets.push({ line: index + 1, reason: `statut « ${statut} » : non publié` });
      return;
    }

    const converti = toWooRawProduct(produit, catalogue.categories);
    if (!converti) {
      rejets.push({ line: index + 1, reason: 'produit sans nom ou sans identifiant exploitable' });
      return;
    }

    if (produit.type === 'variable' && converti.variants.length === 0) {
      // Le prix d'un produit variable est un intervalle ; sans ses variations,
      // la fiche serait importée au prix le plus bas sans le dire.
      variablesSansVariations.push(converti.name);
    }

    variantes += converti.variants.length;
    produits.push(converti);
  });

  return { produits, rejets, variantes, variablesSansVariations };
}
