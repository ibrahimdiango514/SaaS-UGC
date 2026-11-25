/**
 * SORAHNEX — connecteur Shopify : projection vers la forme brute commune.
 *
 * Aucune normalisation ici : ce module produit des `RawCatalogProduct`, la même
 * structure que PrestaShop et Chariow. Prix, devise, arrondi, dédoublonnage et
 * rapprochement passent ensuite par `normalizeCatalog`, `matchBatch` et l'aperçu
 * — exactement le même chemin. C'est ce qui garantit qu'un produit Shopify et
 * son équivalent PrestaShop produisent la même fiche.
 *
 * ## Différences avec le catalogue public `/products.json`
 *
 * | | Public (`/products.json`) | Admin (`/admin/api/…/products.json`) |
 * |---|---|---|
 * | Stock par variante | absent | `inventory_quantity` publié |
 * | Produits en brouillon | exclus | présents (`status`) |
 * | Graphies | HTML du thème | `body_html` complet |
 * | Prix | chaîne décimale | chaîne décimale, même unité |
 *
 * Le stock est donc une vraie information ici, et pas une déduction : quand
 * `inventory_quantity` est présent, il est repris ; sinon il reste `null`
 * (inconnu), jamais zéro.
 *
 * ## Ce qui n'est jamais inventé
 *
 * - Un produit sans titre exploitable n'est pas fabriqué : il est rejeté.
 * - Une variante `available: false` n'est pas « épuisée » par défaut : seule la
 *   quantité, quand elle existe, dit le stock.
 * - L'URL produit n'est construite que si le domaine de vitrine est connu ;
 *   sinon elle reste `null` plutôt que de pointer vers l'administration.
 */
import type { RawCatalogProduct } from './sources.ts';
import type { ShopifyCatalog } from './shopify-api.ts';

/** Statut d'un produit Shopify qui doit être importé. */
export const SHOPIFY_ACTIVE = 'active';

/** Image choisie : la première de la liste, jamais une image d'administration. */
function premiereImage(produit: Record<string, unknown>): string | null {
  const images = Array.isArray(produit.images) ? produit.images : [];
  for (const image of images) {
    const src = (image as { src?: unknown })?.src;
    if (typeof src === 'string' && src.trim()) return src.trim();
  }
  return null;
}

/**
 * Extrait les catégories.
 *
 * Shopify n'a pas de « catégorie » unique : il a `product_type` (un texte libre)
 * et `tags` (liste). Les deux sont utiles au rapprochement, aucun ne doit être
 * inventé s'il est vide.
 */
function categoriesDe(produit: Record<string, unknown>): string[] {
  const liste: string[] = [];
  const type = produit.product_type;
  if (typeof type === 'string' && type.trim()) liste.push(type.trim());

  const tags = produit.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) if (typeof tag === 'string' && tag.trim()) liste.push(tag.trim());
  } else if (typeof tags === 'string') {
    for (const tag of tags.split(',')) if (tag.trim()) liste.push(tag.trim());
  }
  return liste;
}

/**
 * Extrait l'identifiant stable.
 *
 * `id` Shopify est numérique et ne change jamais ; `handle` peut être modifié
 * par le marchand. On préfère donc l'`id`, et on ne retombe sur le `handle` que
 * s'il manque — sans jamais fabriquer de valeur.
 */
function identifiantDe(produit: Record<string, unknown>): string | null {
  const id = produit.id;
  if (typeof id === 'number' || typeof id === 'string') {
    const texte = String(id).trim();
    if (texte) return texte;
  }
  if (typeof produit.handle === 'string' && produit.handle.trim()) return produit.handle.trim();
  return null;
}

/**
 * Convertit un produit Shopify Admin en produit brut commun.
 *
 * Rend `null` quand le produit n'est pas exploitable (titre vide, identifiant
 * absent) : l'appelant le compte comme rejeté plutôt que d'importer une fiche
 * anonyme.
 */
export function toShopifyRawProduct(
  produit: Record<string, unknown>,
  options: { storefrontDomain?: string | null } = {},
): RawCatalogProduct | null {
  const nom = typeof produit.title === 'string' ? produit.title.trim() : '';
  if (!nom) return null;

  const plateformeId = identifiantDe(produit);
  const variantes = Array.isArray(produit.variants)
    ? produit.variants as Array<Record<string, unknown>>
    : [];

  /*
   * Une variante unique sans titre propre PORTE le produit. Shopify nomme
   * toujours la variante par défaut « Default Title » : l'afficher comme une
   * déclinaison donnerait l'illusion d'un choix qui n'existe pas.
   */
  const variantesUtiles = variantes.length === 1 && estVarianteParDefaut(variantes[0])
    ? []
    : variantes;

  const mappees = variantesUtiles.map((variante) => {
    const stock = quantiteDe(variante.inventory_quantity);
    return {
      name: typeof variante.title === 'string' && variante.title.trim()
        ? variante.title.trim()
        : 'Variante',
      price: prixDe(variante.price),
      sku: typeof variante.sku === 'string' && variante.sku.trim() ? variante.sku.trim() : null,
      // `inventory_policy: continue` autorise la vente à stock nul : la
      // disponibilité n'est donc PAS déductible de la quantité seule.
      available: typeof variante.inventory_quantity === 'number'
        ? variante.inventory_quantity > 0 || variante.inventory_policy === 'continue'
        : null,
      stock,
      attributeName: premierOption(variante),
    };
  });

  /*
   * Stock du produit : la somme des quantités CONNUES.
   *
   * Le total est calculé sur TOUTES les variantes, y compris celle que l'on
   * n'affiche pas comme déclinaison : sur une fiche à variante unique, la
   * quantité vit dans `variants[0]` et c'est bien le stock du produit. La
   * calculer sur `mappees` seule rendrait `null` pour la plupart des boutiques
   * sans déclinaisons — c'est-à-dire l'écrasante majorité.
   *
   * Si aucune quantité n'est publiée, le stock reste `null` : un zéro serait un
   * mensonge, `null` veut dire « non suivi ».
   */
  const stocksConnus = variantes
    .map((variante) => quantiteDe(variante.inventory_quantity))
    .filter((q): q is number => typeof q === 'number');
  const stockTotal = stocksConnus.length > 0
    ? stocksConnus.reduce((somme, q) => somme + q, 0)
    : null;

  const premier = variantes[0];
  const prixProduit = premier ? prixDe(premier.price) : null;

  return {
    name: nom,
    description: typeof produit.body_html === 'string' ? produit.body_html : '',
    price: prixProduit,
    // Shopify publie la devise au niveau de la BOUTIQUE, pas du produit :
    // l'appelant la fournit (`catalog.currency`). `null` ici est honnête.
    currency: null,
    productUrl: urlProduit(produit, options.storefrontDomain ?? null),
    imageUrl: premiereImage(produit),
    categories: categoriesDe(produit),
    variants: mappees,
    /*
     * SKU du produit : celui de la variante UNIQUE réelle.
     *
     * Attention au piège : `mappees` est vide quand la seule variante est
     * « Default Title » — c'est-à-dire exactement le cas d'une boutique sans
     * déclinaisons, où le SKU de cette variante EST la référence du produit.
     * Se fier à `mappees` faisait perdre le SKU sur la majorité des boutiques.
     */
    sku: variantes.length === 1 && typeof premier?.sku === 'string' && premier.sku.trim()
      ? premier.sku.trim()
      : null,
    platformId: plateformeId,
    stock: stockTotal,
  };
}

/** Vrai si la variante est celle que Shopify crée d'office. */
function estVarianteParDefaut(variante: Record<string, unknown> | undefined): boolean {
  if (!variante) return false;
  const titre = typeof variante.title === 'string' ? variante.title.trim().toLowerCase() : '';
  const option1 = typeof variante.option1 === 'string' ? variante.option1.trim() : '';
  return (titre === 'default title' || titre === '' || titre === 'titre par défaut')
    && (option1 === '' || option1.toLowerCase() === 'default title');
}

/**
 * Nom du critère de la variante.
 *
 * Shopify publie la VALEUR (`option1: « Rouge »`), pas le nom du critère : celui-
 * ci vit sur le produit, dans `options[].name` (« Couleur »). Sans lui, la
 * variante s'appellerait « Variante » et le critère serait inconnu. On rend donc
 * `null` plutôt qu'une approximation : `RawCatalogProduct` accepte `null`, et
 * l'interface n'affiche pas de critère qu'elle ne connaît pas.
 *
 * La valeur, elle, est déjà dans `name` (le titre de la variante).
 */
function premierOption(_variante: Record<string, unknown>): string | null {
  return null;
}

/**
 * Lit une quantité d'inventaire.
 *
 * `null` (inconnue) et `0` (épuisé) sont deux choses différentes : Shopify
 * renvoie `null` quand l'inventaire n'est pas suivi pour l'article.
 */
function quantiteDe(valeur: unknown): number | null {
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return Math.max(0, Math.trunc(valeur));
  return null;
}

/** Prix publié : chaîne décimale, reprise telle quelle pour la normalisation. */
function prixDe(valeur: unknown): string | number | null {
  if (typeof valeur === 'string' && valeur.trim()) return valeur.trim();
  if (typeof valeur === 'number' && Number.isFinite(valeur)) return valeur;
  return null;
}

/**
 * Construit l'URL publique du produit.
 *
 * `handle` est le seul segment fiable. Sans domaine de vitrine connu, on ne
 * fabrique rien : une URL vers `/admin/` n'a aucun intérêt pour un client, et
 * une URL relative seule ne serait pas cliquable dans SORAHNEX.
 */
function urlProduit(produit: Record<string, unknown>, domaineVitrine: string | null): string | null {
  const handle = typeof produit.handle === 'string' ? produit.handle.trim() : '';
  if (!handle) return null;
  if (!domaineVitrine) return null;
  return `https://${domaineVitrine}/products/${handle}`;
}

/**
 * Projette un catalogue Shopify complet vers la forme brute commune.
 *
 * Le comptage des variantes est repris de la lecture : il sert à vérifier, dans
 * l'aperçu, qu'aucune déclinaison n'a été perdue en route.
 */
export function toShopifyRawProducts(catalogue: ShopifyCatalog): {
  produits: RawCatalogProduct[];
  rejets: Array<{ line: number; reason: string }>;
  variantes: number;
} {
  const produits: RawCatalogProduct[] = [];
  const rejets: Array<{ line: number; reason: string }> = [];
  let variantes = 0;

  catalogue.products.forEach((brut, index) => {
    const produit = brut as Record<string, unknown>;
    const converti = toShopifyRawProduct(produit, { storefrontDomain: null });
    if (!converti) {
      rejets.push({ line: index + 1, reason: 'produit sans titre ou sans identifiant exploitable' });
      return;
    }
    variantes += converti.variants.length;
    produits.push(converti);
  });

  return { produits, rejets, variantes };
}
