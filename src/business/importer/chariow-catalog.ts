/**
 * SORAHNEX — connecteur Chariow : sonde de connexion et lecture du catalogue.
 *
 * Ce module transforme les réponses de l'API Chariow en la forme que le moteur
 * commun sait déjà traiter. Il ne réinvente rien : le prix, la devise, le stock
 * et les identifiants repartent ensuite dans `normalizeCatalogProduct`, puis dans
 * `matchBatch`, puis dans l'aperçu — exactement le même chemin que PrestaShop.
 *
 * ## Ce qui rend Chariow différent des autres connecteurs
 *
 * | | Shopify / Woo | PrestaShop | Chariow |
 * |---|---|---|---|
 * | Catalogue public | oui | non | **non** |
 * | Hôte interrogé | la boutique | la boutique | **fixe** (`api.chariow.com`) |
 * | Pagination | offset / page | `limit=offset,n` | **curseur** |
 * | Total annoncé | oui | `Content-Range` | **non** |
 * | Variantes | liste | liste | **booléen seul** |
 * | SKU | oui | oui | **non** |
 *
 * Le point le plus structurant est l'absence de total : on ne peut pas dire
 * « 12 produits sur 12 » avant d'avoir parcouru le curseur jusqu'au bout. La
 * lecture va donc au bout, avec un plafond dur, et rapporte `truncated` si le
 * plafond est atteint — un catalogue tronqué silencieusement ferait croire à une
 * suppression de produits.
 *
 * ## Les brouillons
 *
 * `GET /v1/products` renvoie **tous** les produits, y compris `draft` et
 * `suspended`. C'est documenté par Chariow. Importer un brouillon publierait
 * dans SORAHNEX une fiche que le marchand n'a pas encore publiée : on filtre sur
 * `published`, et on **compte** ce qui a été écarté pour pouvoir le dire.
 */
import {
  CHARIOW_PAGE_SIZE,
  MAX_CHARIOW_PAGES,
  MAX_CHARIOW_PRODUCTS,
  fetchChariowResource,
  validateChariowKey,
  type ChariowCatalog,
  type ChariowCredentials,
  type ChariowError,
  type ChariowFetchDeps,
  type ChariowProduct,
  type ChariowProbe,
  type ChariowResult,
  type ChariowResource,
} from './chariow-api.ts';
import {
  amountToMinor,
  mapChariowProduct,
  mapChariowStore,
  pickChariowCurrency,
} from './chariow-pricing.ts';
import type { RawCatalogProduct } from './sources.ts';
import { DEFAULT_CURRENCY, normalizeCurrency } from './normalize.ts';

/**
 * Statuts considérés comme publiés.
 *
 * `published` seul : `draft` n'est pas prêt, `suspended` est retiré de la vente
 * par Chariow (souvent pour un motif de conformité). Importer l'un ou l'autre
 * mettrait en avant un produit que le marchand ne peut pas vendre.
 */
export const CHARIOW_PUBLISHED = 'published';

/**
 * Vérifie la connexion en lisant réellement des ressources.
 *
 * ## Pourquoi deux appels
 * Un `200` sur `GET /v1/store` prouve seulement que la clé a `store.read`. Un
 * import de catalogue exige aussi `products.read` : sans ce second appel, une
 * clé volontairement limitée serait déclarée « connectée », puis l'aperçu
 * échouerait en `403` — l'utilisateur aurait connecté une boutique pour rien.
 *
 * On lit donc la boutique (nom, URL, statut → identification) ET la première
 * page de produits (preuve du scope catalogue). Les deux sont des `GET`.
 */
export async function probeChariow(
  credentials: ChariowCredentials,
  deps: ChariowFetchDeps,
): Promise<ChariowResult<ChariowProbe>> {
  const cle = validateChariowKey(credentials.apiKey);
  if (!cle.ok) return cle;

  const resourcesRead: ChariowResource[] = [];

  const boutique = await fetchChariowResource({ apiKey: cle.value }, 'store', {}, deps);
  if (!boutique.ok) return boutique;
  resourcesRead.push('store');
  const store = mapChariowStore(boutique.value.payload);

  // Le statut de la boutique est une information utile : une boutique
  // `suspended` accepte la clé mais ne sert rien. On ne bloque pas — on le
  // rapporte, et la fiche le dira.
  const produits = await fetchChariowResource(
    { apiKey: cle.value },
    'products',
    { per_page: '1' },
    deps,
  );
  if (!produits.ok) return produits;
  resourcesRead.push('products');

  const page = produits.value.payload as { data?: unknown; pagination?: unknown };
  const liste = Array.isArray(page.data) ? page.data : [];
  const pagination = (page.pagination ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    value: {
      store,
      firstPageCount: liste.length,
      hasMorePages: pagination.has_more_pages === true
        || (typeof pagination.next_cursor === 'string' && pagination.next_cursor !== ''),
      resourcesRead,
    },
  };
}

/**
 * Parcourt le catalogue par curseur.
 *
 * ## Invariants
 * - **Le curseur vient de la réponse**, jamais d'un calcul : Chariow ne publie
 *   pas d'offset, et une page calculée à la main se désynchronise dès qu'un
 *   produit est créé pendant la lecture.
 * - **Un curseur identique à lui-même arrête la boucle.** Une API qui
 *   renverrait toujours le même `next_cursor` ferait sinon tourner indéfiniment.
 *   C'est le genre de panne qu'on ne découvre qu'en production, sur le compte
 *   d'un client.
 * - **Le plafond est dur** (`MAX_CHARIOW_PRODUCTS`, `MAX_CHARIOW_PAGES`) : temps
 *   et mémoire bornés, et `truncated` le dit à l'utilisateur.
 * - **Aucune écriture** : uniquement des `GET`.
 */
export async function readChariowCatalog(
  credentials: ChariowCredentials,
  deps: ChariowFetchDeps,
  options: { defaultCurrency?: string; storeName?: string | null } = {},
): Promise<ChariowResult<ChariowCatalog>> {
  const cle = validateChariowKey(credentials.apiKey);
  if (!cle.ok) return cle;

  const deviseDemandee = normalizeCurrency(options.defaultCurrency ?? DEFAULT_CURRENCY).currency;

  const boutique = await fetchChariowResource({ apiKey: cle.value }, 'store', {}, deps);
  if (!boutique.ok) return boutique;
  const store = mapChariowStore(boutique.value.payload);
  const resourcesRead: ChariowResource[] = ['store'];

  const produits: ChariowProduct[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  let draftsSkipped = 0;
  let truncated = false;
  let curseur: string | null = null;
  let dernierCurseur: string | null = null;
  let devise: string | null = null;
  let ligne = 0;

  for (let page = 0; page < MAX_CHARIOW_PAGES; page++) {
    const query: Record<string, string> = { per_page: String(CHARIOW_PAGE_SIZE) };
    if (curseur) query.cursor = curseur;

    const reponse = await fetchChariowResource({ apiKey: cle.value }, 'products', query, deps);
    if (!reponse.ok) {
      /*
       * Une page qui échoue en cours de route n'est PAS un catalogue vide.
       * On préfère l'échec explicite : l'utilisateur relance, plutôt que
       * d'importer 40 produits sur 300 en croyant avoir tout pris.
       */
      return reponse;
    }
    if (page === 0) resourcesRead.push('products');

    const payload = reponse.value.payload as { data?: unknown; pagination?: unknown };
    const items = Array.isArray(payload.data) ? payload.data : [];
    if (items.length === 0) break;

    for (const brut of items) {
      ligne += 1;
      const produit = mapChariowProduct(brut);
      if (!produit) {
        rejected.push({ line: ligne, reason: 'produit sans identifiant ou sans nom exploitable' });
        continue;
      }
      if (produit.status !== CHARIOW_PUBLISHED) {
        // Compté, jamais importé : un brouillon chez Chariow ne doit pas
        // devenir une fiche visible dans SORAHNEX.
        draftsSkipped += 1;
        continue;
      }
      // La devise est déduite du PREMIER produit lisible, puis conservée : un
      // catalogue Chariow est mono-devise en pratique, et changer de devise en
      // cours de route cacherait une incohérence de données.
      if (!devise) {
        devise = pickChariowCurrency(produit.amount, produit.trackingCurrency, deviseDemandee);
      }
      produits.push(produit);
    }

    if (produits.length >= MAX_CHARIOW_PRODUCTS) {
      truncated = true;
      break;
    }

    const pagination = (payload.pagination ?? {}) as Record<string, unknown>;
    const suivant = typeof pagination.next_cursor === 'string' && pagination.next_cursor.trim()
      ? pagination.next_cursor.trim()
      : null;
    const aSuivante = pagination.has_more_pages === true || suivant !== null;

    if (!aSuivante || !suivant) break;
    // Curseur qui ne progresse pas : la boucle s'arrête AVANT de tourner à vide.
    if (suivant === dernierCurseur) break;
    dernierCurseur = suivant;
    curseur = suivant;
  }

  return {
    ok: true,
    value: {
      platform: 'chariow',
      endpoint: 'https://api.chariow.com/v1/products',
      store,
      products: produits,
      currency: devise ?? deviseDemandee,
      draftsSkipped,
      rejected,
      truncated,
      resourcesRead,
    },
  };
}

/**
 * Traduit une erreur de scope en message actionnable pour l'utilisateur.
 *
 * Un `403` Chariow est presque toujours réparable en trente secondes : la clé
 * existe, il manque une case à cocher. Renvoyer « accès refusé » obligerait le
 * marchand à deviner laquelle.
 */
export function explainChariowError(erreur: ChariowError): string {
  if (erreur.code === 'insufficient_scope') {
    const scopes = erreur.missingScopes?.length ? erreur.missingScopes.join(' et ') : 'products.read';
    return `Votre clé Chariow n’a pas la permission ${scopes}. Ouvrez app.chariow.com → Settings → API Keys, modifiez la clé (sans la régénérer) et cochez « products.read » ainsi que « store.read ».`;
  }
  return erreur.message;
}

/* -------------------------------------------------------------------------- */
/* Projection vers la forme brute commune                                      */
/* -------------------------------------------------------------------------- */

/**
 * Convertit un produit Chariow en `RawCatalogProduct` — la forme que
 * `normalizeCatalog` sait déjà traiter.
 *
 * ## Pourquoi cette fonction existe
 * Le moteur d'import commun (normalisation, rapprochement, aperçu, écriture) ne
 * doit pas connaître Chariow. Tout connecteur se contente de **produire** cette
 * forme brute ; le prix, la devise, le stock et les identifiants repartent
 * ensuite dans exactement le même code que Shopify, WooCommerce et PrestaShop.
 * C'est ce qui interdit un second moteur d'import.
 *
 * ## Points de vigilance
 * - `priceMinor` est fourni : c'est la valeur de référence, aucune reconversion
 *   en aval (sinon 24 900 XOF redeviendrait 249 000).
 * - `price` est aussi fourni, en unité principale, pour les lecteurs qui
 *   l'attendent ; il ne sert jamais au calcul.
 * - `sku` reste `null` : Chariow n'en publie pas, et en inventer un casserait
 *   le rapprochement d'un import à l'autre.
 * - `variants` reste vide ; `has_variant_pricing` devient un avertissement.
 * - `platformId` = `prd_…`, l'identifiant stable qui permet de reconnaître un
 *   produit renommé au prochain import.
 */
export function toChariowRawProduct(
  produit: ChariowProduct,
  boutiqueUrl: string | null,
  currency: string,
): RawCatalogProduct {
  const devise = produit.amount.currency ?? produit.trackingCurrency ?? currency;
  const warnings: string[] = [];

  if (produit.hasVariantPricing) {
    /*
     * Chariow annonce des tarifs par variante mais ne publie AUCUNE liste de
     * variantes (ni prix, ni stock, ni identifiant par option). On le dit au
     * lieu de fabriquer des options factices : l'utilisateur peut alors
     * compléter les déclinaisons dans SORAHNEX en connaissance de cause.
     */
    warnings.push(
      'Ce produit a des tarifs par variante chez Chariow, que l’API ne détaille pas : le prix importé est celui affiché, sans les déclinaisons.',
    );
  }
  if (produit.amount.value === null && !produit.isFree) {
    warnings.push('Chariow ne publie pas de prix pour ce produit : le prix est à compléter.');
  }

  return {
    name: produit.name,
    description: produit.description,
    // Unité principale, pour les lecteurs qui attendent `price`.
    price: produit.amount.value,
    // LA référence : déjà convertie avec le bon exposant de devise.
    priceMinor: amountToMinor(produit.amount, devise),
    currency: devise,
    productUrl: urlProduitChariow(boutiqueUrl, produit.slug),
    imageUrl: produit.imageUrl,
    categories: produit.category?.label
      ? [produit.category.label]
      : produit.category?.value
        ? [produit.category.value]
        : [],
    variants: [],
    // Jamais inventé : Chariow n'expose pas de référence produit.
    sku: null,
    platformId: produit.id,
    stock: produit.stock,
    warnings,
  };
}

/**
 * URL publique d'une fiche produit Chariow.
 *
 * Le schéma `https://<boutique>/<slug>` est celui observé sur les vitrines
 * Chariow. On ne le construit que si la boutique a été confirmée par
 * `GET /v1/store` : une URL fabriquée à partir d'une adresse saisie mais non
 * vérifiée pointerait peut-être vers un autre site.
 */
export function urlProduitChariow(boutiqueUrl: string | null, slug: string | null): string | null {
  if (!boutiqueUrl || !slug) return null;
  try {
    const base = new URL(boutiqueUrl.includes('://') ? boutiqueUrl : `https://${boutiqueUrl}`);
    if (base.protocol !== 'https:') return null;
    return new URL(slug, `${base.origin}/`).toString();
  } catch {
    return null;
  }
}
