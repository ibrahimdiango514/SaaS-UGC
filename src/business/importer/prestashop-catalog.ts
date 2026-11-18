/**
 * VYORA — connecteur PrestaShop : assemblage du catalogue.
 *
 * Ce module transforme les ressources PrestaShop (produits, déclinaisons,
 * valeurs d'attribut, stock) en `RawCatalogProduct[]`, la forme que le moteur
 * commun sait déjà normaliser. Il ne réinvente rien : le prix, la devise, le
 * stock et les identifiants repartent ensuite dans `normalizeCatalogProduct`,
 * puis dans `matchBatch`.
 *
 * ## La règle qui gouverne ce fichier
 * **Une déclinaison n'est jamais un produit.** Elle est fusionnée dans le
 * produit parent, sous forme de variante. Un import qui créerait « Chemise —
 * M » et « Chemise — L » comme deux fiches casserait le catalogue du marchand,
 * et c'est l'erreur la plus facile à commettre en lisant l'API PrestaShop.
 *
 * ## Ce que « déclinaison » veut dire ici
 * `combinations` porte la référence (SKU), l'incidence de prix et l'id de
 * `stock_availables`. Les libellés lisibles (« M », « Rouge ») viennent de
 * `product_option_values`, et le nom du groupe (« Taille ») de
 * `product_options`. Sans ces trois ressources, on aurait des variantes
 * « #12 » — inutilisables.
 */
import type { RawCatalogProduct } from './sources.ts';
import { cleanReference } from './normalize.ts';
import {
  MAX_PRESTASHOP_COMBINATIONS,
  MAX_PRESTASHOP_PAGES,
  MAX_PRESTASHOP_PRODUCTS,
  PRESTASHOP_PAGE_SIZE,
  fetchPrestashopPage,
  priceMinorOf,
  textOf,
  type PrestashopCatalog,
  type PrestashopCombination,
  type PrestashopCredentials,
  type PrestashopFetchDeps,
  type PrestashopPage,
  type PrestashopProbe,
  type PrestashopResource,
  type PrestashopResult,
  type PrestashopTarget,
} from './prestashop-api.ts';

/** Champs demandés à l'API : rien de plus, pour ne pas tirer des descriptions. */
const PRODUIT_DISPLAY = '[id,name,reference,price,id_default_image,active,date_upd,id_shop_default]';
const VALEUR_DISPLAY = '[id,id_attribute_group,name]';
const GROUPE_DISPLAY = '[id,name]';
const STOCK_DISPLAY = '[id,id_product,id_product_attribute,quantity]';

/** Lit toutes les pages d'une ressource, avec plafond et reprise sur débit. */
async function lireTout(
  target: PrestashopTarget,
  credentials: PrestashopCredentials,
  resource: PrestashopResource,
  display: string,
  deps: PrestashopFetchDeps,
  options: { maxPages: number; maxItems: number; stopAt?: (total: number) => boolean },
): Promise<PrestashopResult<{ items: unknown[]; truncated: boolean; total: number | null }>> {
  const items: unknown[] = [];
  let total: number | null = null;
  let truncated = false;

  for (let page = 1; page <= options.maxPages; page++) {
    const resultat = await fetchPrestashopPage(
      target,
      credentials,
      resource,
      { page, limit: PRESTASHOP_PAGE_SIZE, display },
      deps,
    );
    if (!resultat.ok) return resultat;
    // `PrestashopPage` est structurellement le même contrat : on garde le type
    // local pour ne pas faire dépendre les tests de la forme exacte.
    const donnees: PrestashopPage = resultat.value;
    total = donnees.total ?? total;
    if (donnees.empty) break;
    items.push(...donnees.items);

    if (items.length >= options.maxItems) {
      // Plafond atteint : on s'arrête et on le DIT. Un catalogue tronqué
      // silencieusement ferait croire à une suppression de produits.
      truncated = true;
      break;
    }
    // Total connu et déjà couvert : inutile d'appeler une page de plus.
    if (total !== null && items.length >= total) break;
  }

  return { ok: true, value: { items, truncated, total } };
}

/**
 * Vérifie la connexion en lisant réellement des ressources.
 *
 * Une vérification qui se contenterait d'un `200` sur la racine de l'API ne
 * prouverait rien : certaines boutiques répondent une page de connexion en 200.
 * On lit donc `shops` et `languages` (documentées, sans données sensibles), et
 * on rapporte les ressources effectivement obtenues.
 */
export async function probePrestashop(
  target: PrestashopTarget,
  credentials: PrestashopCredentials,
  deps: PrestashopFetchDeps,
): Promise<PrestashopResult<PrestashopProbe>> {
  if (!credentials.apiKey || credentials.apiKey.trim().length < 8) {
    return {
      ok: false,
      error: {
        code: 'auth_required',
        message: 'La clé Webservice PrestaShop est requise (au moins 8 caractères).',
      },
    };
  }

  const resourcesRead: PrestashopResource[] = [];

  const boutique = await fetchPrestashopPage(
    target, credentials, 'shops', { page: 1, limit: 1 }, deps,
  );
  if (!boutique.ok) return boutique;
  resourcesRead.push('shops');
  const premiere = boutique.value.items[0] as Record<string, unknown> | undefined;
  const shopName = premiere ? textOf(premiere.name) || null : null;
  const version = premiere && typeof premiere.version === 'string' ? premiere.version : null;

  const langues = await fetchPrestashopPage(
    target, credentials, 'languages', { page: 1, limit: 50 }, deps,
  );
  if (!langues.ok) return langues;
  resourcesRead.push('languages');
  const languages = langues.value.items.flatMap((brut) => {
    const ligne = brut as Record<string, unknown>;
    const id = Number(ligne.id);
    if (!Number.isFinite(id)) return [];
    return [{ id, isoCode: String(ligne.iso_code ?? textOf(ligne.iso_code) ?? '').toLowerCase() }];
  });

  // Première page de produits : c'est elle qui prouve le droit de LIRE le
  // catalogue, et qui donne le volume total. Sans cette lecture, une clé
  // limitée aux boutiques serait déclarée « valide » à tort.
  const produits = await fetchPrestashopPage(
    target, credentials, 'products', { page: 1, limit: 1, display: PRODUIT_DISPLAY }, deps,
  );
  if (!produits.ok) return produits;
  resourcesRead.push('products');

  return {
    ok: true,
    value: {
      version,
      shopName,
      languages,
      totalProducts: produits.value.total,
      resourcesRead,
    },
  };
}

/**
 * Lit le catalogue complet : produits, déclinaisons, attributs, stock.
 *
 * L'ordre est imposé par la dépendance des données : les déclinaisons ont
 * besoin des produits, les libellés d'attribut des déclinaisons.
 */
export async function readPrestashopCatalog(
  target: PrestashopTarget,
  credentials: PrestashopCredentials,
  deps: PrestashopFetchDeps,
  options: { defaultCurrency?: string; langId?: number; shopName?: string | null } = {},
): Promise<PrestashopResult<PrestashopCatalog>> {
  const rejets: Array<{ line: number; reason: string }> = [];
  const resourcesRead: PrestashopResource[] = [];

  // 1) Produits.
  const produits = await lireTout(target, credentials, 'products', PRODUIT_DISPLAY, deps, {
    maxPages: MAX_PRESTASHOP_PAGES,
    maxItems: MAX_PRESTASHOP_PRODUCTS,
  });
  if (!produits.ok) return produits;
  resourcesRead.push('products');

  // 2) Libellés d'attribut : sans eux, les déclinaisons s'appelleraient « #12 ».
  const valeurs = await lireTout(target, credentials, 'product_option_values', VALEUR_DISPLAY, deps, {
    maxPages: 50,
    maxItems: 10_000,
  });
  const groupes = await lireTout(target, credentials, 'product_options', GROUPE_DISPLAY, deps, {
    maxPages: 20,
    maxItems: 2_000,
  });
  if (valeurs.ok) resourcesRead.push('product_option_values');
  if (groupes.ok) resourcesRead.push('product_options');

  const nomGroupe = new Map<string, string>();
  if (groupes.ok) {
    for (const brut of groupes.value.items) {
      const ligne = brut as Record<string, unknown>;
      const id = String(ligne.id ?? '');
      if (id) nomGroupe.set(id, textOf(ligne.name, options.langId));
    }
  }
  const valeurAttribut = new Map<string, { name: string; groupName: string | null }>();
  if (valeurs.ok) {
    for (const brut of valeurs.value.items) {
      const ligne = brut as Record<string, unknown>;
      const id = String(ligne.id ?? '');
      if (!id) continue;
      const groupeId = String((ligne.id_attribute_group as Record<string, unknown>)?.['#text']
        ?? ligne.id_attribute_group ?? '');
      valeurAttribut.set(id, {
        name: textOf(ligne.name, options.langId),
        groupName: nomGroupe.get(groupeId) ?? null,
      });
    }
  }

  // 3) Déclinaisons.
  const declinaisons = await lireTout(
    target, credentials, 'combinations',
    // `full` est nécessaire : les associations d'attribut n'apparaissent pas
    // avec une liste de champs restreinte.
    'full', deps,
    { maxPages: Math.ceil(MAX_PRESTASHOP_COMBINATIONS / PRESTASHOP_PAGE_SIZE), maxItems: MAX_PRESTASHOP_COMBINATIONS },
  );
  if (!declinaisons.ok) {
    // Des produits SANS leurs déclinaisons seraient un catalogue faux. On
    // préfère échouer explicitement plutôt que d'importer un catalogue
    // amputé de ses tailles.
    return declinaisons;
  }
  resourcesRead.push('combinations');

  const parProduit = new Map<string, PrestashopCombination[]>();
  for (const brut of declinaisons.value.items) {
    const ligne = brut as Record<string, unknown>;
    const productId = String(ligne.id_product ?? '');
    const id = String(ligne.id ?? '');
    if (!productId || !id) continue;
    const attributs: Array<{ name: string; groupName: string | null }> = [];
    const associations = (ligne.associations ?? {}) as Record<string, unknown>;
    const listeValeurs = ((associations.product_option_values ?? {}) as Record<string, unknown>)
      .product_option_value;
    for (const v of Array.isArray(listeValeurs) ? listeValeurs : listeValeurs ? [listeValeurs] : []) {
      const idValeur = String((v as Record<string, unknown>)?.id ?? '');
      const connue = valeurAttribut.get(idValeur);
      if (connue) attributs.push(connue);
      else if (idValeur) attributs.push({ name: `Valeur ${idValeur}`, groupName: null });
    }
    const liste = parProduit.get(productId) ?? [];
    liste.push({
      id,
      productId,
      sku: typeof ligne.reference === 'string' && ligne.reference.trim() ? ligne.reference.trim() : null,
      // `price` d'une déclinaison est une INCIDENCE, pas un prix absolu :
      // l'additionner au prix du parent est la seule lecture correcte.
      priceMinorImpact: priceMinorOf(ligne.price),
      quantity: ligne.quantity === undefined ? null : Number(ligne.quantity),
      attributes: attributs,
    });
    parProduit.set(productId, liste);
  }

  // 4) Stock réel, par déclinaison.
  //
  // `combinations.quantity` est un cache dénormalisé que PrestaShop ne met pas
  // toujours à jour (réservations, commandes en cours). `stock_availables` est
  // la source de vérité ; on la préfère quand elle est disponible, et on
  // retombe sur le cache sinon — en le signalant.
  const stock = await lireTout(target, credentials, 'stock_availables', STOCK_DISPLAY, deps, {
    maxPages: Math.ceil(MAX_PRESTASHOP_COMBINATIONS / PRESTASHOP_PAGE_SIZE),
    maxItems: MAX_PRESTASHOP_COMBINATIONS,
  });
  const stockParCle = new Map<string, number>();
  if (stock.ok) {
    resourcesRead.push('stock_availables');
    for (const brut of stock.value.items) {
      const ligne = brut as Record<string, unknown>;
      const productId = String(ligne.id_product ?? '');
      if (!productId) continue;
      const attributeId = String(ligne.id_product_attribute ?? '0');
      const quantite = Number(ligne.quantity);
      if (!Number.isFinite(quantite)) continue;
      stockParCle.set(`${productId}:${attributeId}`, quantite);
    }
  }

  // 5) Assemblage.
  const currency = options.defaultCurrency ?? null;
  const catalogue: RawCatalogProduct[] = [];
  const base = target.root.origin;

  produits.value.items.forEach((brut, index) => {
    const ligne = brut as Record<string, unknown>;
    const id = String(ligne.id ?? '');
    const nom = textOf(ligne.name, options.langId).trim();
    if (!id || !nom) {
      rejets.push({ line: index + 1, reason: 'produit sans identifiant ou sans nom' });
      return;
    }

    const combinaisons = parProduit.get(id) ?? [];
    const referenceProduit = cleanReference(typeof ligne.reference === 'string' ? ligne.reference : '');

    // Prix du parent : prix de base, hors incidence de déclinaison.
    const prixBase = priceMinorOf(ligne.price);

    const variants = combinaisons.map((combinaison) => {
      const libelle = combinaison.attributes.map((a) => a.name).filter(Boolean).join(' / ');
      const quantiteStock = stockParCle.get(`${id}:${combinaison.id}`)
        ?? stockParCle.get(`${id}:0`)
        ?? combinaison.quantity
        ?? null;
      const prixVariante = prixBase === null
        ? null
        : prixBase + (combinaison.priceMinorImpact ?? 0);
      return {
        name: libelle || `Déclinaison ${combinaison.id}`,
        // Un prix null reste null : une déclinaison sans prix hérite du parent
        // côté normalisation, jamais d'un zéro inventé.
        //
        // `priceMinor` est la valeur de référence : PrestaShop publie un
        // décimal dont l'exposant dépend de la devise de la boutique, et le
        // normaliseur ne doit pas le reconvertir (il lirait 24,90 EUR comme
        // 24 centimes). `price` est conservé pour les lecteurs qui l'attendent.
        price: prixVariante === null ? null : prixVariante / 100,
        priceMinor: prixVariante,
        sku: combinaison.sku,
        available: quantiteStock === null ? null : quantiteStock > 0,
        stock: quantiteStock,
        attributeName: combinaison.attributes[0]?.groupName ?? null,
      };
    });

    // Stock du produit : somme des déclinaisons quand il y en a, sinon la
    // ligne `stock_availables` du produit nu (id_product_attribute = 0).
    let stockProduit: number | null = null;
    if (variants.length > 0) {
      const connus = variants.map((v) => v.stock).filter((v): v is number => v !== null);
      stockProduit = connus.length > 0 ? connus.reduce((a, b) => a + b, 0) : null;
    } else {
      stockProduit = stockParCle.get(`${id}:0`) ?? null;
    }

    // Le SKU du produit n'est promu que s'il n'y a PAS de déclinaisons : sinon
    // la référence de la déclinaison identifie une taille, pas la fiche.
    const sku = variants.length <= 1 ? (referenceProduit ?? variants[0]?.sku ?? null) : referenceProduit;

    const imageId = typeof ligne.id_default_image === 'object'
      ? String((ligne.id_default_image as Record<string, unknown>)['#text'] ?? '')
      : String(ligne.id_default_image ?? '');
    const productUrl = `${base}/index.php?id_product=${id}&controller=product`;

    catalogue.push({
      name: nom,
      // Aucune description tirée d'office : `display` ne la demande pas, et
      // une description absente ne doit pas écraser celle du marchand.
      description: '',
      price: prixBase === null ? null : prixBase / 100,
      // Prix déjà converti : évite toute double conversion au normaliseur.
      priceMinor: prixBase,
      currency,
      productUrl,
      imageUrl: imageId && imageId !== '0'
        ? `${base}/img/p/${imageId.split('').join('/')}/${imageId}.jpg`
        : null,
      categories: [],
      variants,
      sku,
      platformId: id,
      stock: stockProduit,
      imageId: imageId && imageId !== '0' ? imageId : null,
    } as RawCatalogProduct & { stock: number | null; imageId: string | null });
  });

  return {
    ok: true,
    value: {
      platform: 'prestashop',
      endpoint: `${base}${(target.basePath ?? '/api').replace(/\/$/, '')}`,
      products: catalogue,
      currency,
      rejected: rejets,
      truncated: produits.value.truncated,
      resourcesRead,
    },
  };
}
