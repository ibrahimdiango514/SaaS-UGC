/**
 * VYORA — orchestration d'un import de catalogue.
 *
 * ## Le principe : une seule séquence, toujours la même
 *
 * Quel que soit le point d'entrée (URL de boutique, fichier, bientôt API
 * autorisée), l'import passe par les mêmes étapes et produit la même structure
 * de résultat. L'interface n'a donc qu'un seul cas à gérer, et la
 * prévisualisation est toujours calculée de la même façon.
 *
 *   1. **acquérir**  — lire la source (réseau ou fichier) ;
 *   2. **normaliser** — convertir vers `NormalizedProduct` ;
 *   3. **dédupliquer** — interne au lot, puis face au catalogue existant ;
 *   4. **résumer**  — compter ce qui est importable, en doublon, en erreur.
 *
 * ## Ce que le pipeline ne fait jamais
 *
 * - **Écrire en base.** Il produit un lot prêt à importer ; l'écriture est une
 *   action distincte, déclenchée par l'utilisateur après prévisualisation.
 *   C'est ce qui rend « prévisualisation avant import » réel et non décoratif.
 * - **Inventer un produit** pour combler une ligne vide.
 * - **Masquer une erreur** : chaque produit écarté est listé avec sa raison.
 */
import type { NormalizedProduct } from './normalize.ts';
import { buildProduct, findDuplicates, parsePriceMinor, DEFAULT_CURRENCY, type DuplicateHit } from './normalize.ts';
import type { FileParseResult } from './files.ts';
import type { CatalogPlatform, RawCatalogProduct, PublicCatalog } from './sources.ts';
import { fetchPublicCatalog, probeStore, type SourceDeps } from './sources.ts';
import { detectPlatform, type PlatformVerdict, type StorePlatform } from './platform.ts';

/** Ce qui a été demandé à l'importateur. */
export type ImportIntent =
  | { kind: 'url'; url: string }
  | { kind: 'file'; filename: string; bytes: Uint8Array };

/** Origine d'un lot, pour l'audit et l'affichage. */
export interface ImportOrigin {
  kind: 'url' | 'file';
  /** URL de la boutique ou nom du fichier — jamais un secret. */
  reference: string;
  platform: StorePlatform;
  /** Point d'accès réellement utilisé, quand il y en a un. */
  endpoint: string | null;
}

export interface ImportBatch {
  origin: ImportOrigin;
  products: NormalizedProduct[];
  duplicates: DuplicateHit[];
  /** Lignes écartées, avec leur raison. */
  rejected: Array<{ line: number; reason: string }>;
  warnings: string[];
  truncated: boolean;
  summary: ImportSummary;
}

export interface ImportSummary {
  total: number;
  /** Importables sans conflit. */
  importable: number;
  /** Doublons internes au lot. */
  duplicateInBatch: number;
  /** Déjà présents dans le catalogue de l'entreprise. */
  duplicateExisting: number;
  /** Nombre de produits dont un champ a été corrigé ou écarté. */
  withWarnings: number;
  /** Prix connus / inconnus : l'utilisateur voit ce qu'il devra compléter. */
  priced: number;
  unpriced: number;
}

export type ImportResult =
  | { ok: true; batch: ImportBatch }
  | { ok: false; stage: 'probe' | 'acquire' | 'normalize'; errors: string[]; verdict?: PlatformVerdict };

export interface RunImportOptions {
  deps?: SourceDeps;
  /** Catalogue existant, pour la détection de doublons. */
  existing?: Array<{ id: string; name: string }>;
  /** Devise par défaut quand la source n'en fournit pas. */
  currency?: string;
  /** Injecté pour rendre les tests déterministes. */
  importer?: (bytes: Uint8Array, filename: string) => Promise<FileParseResult>;
}

/** Résume un lot de produits. */
export function summarizeBatch(products: NormalizedProduct[], duplicates: DuplicateHit[]): ImportSummary {
  const inBatch = duplicates.filter((d) => d.kind === 'in-batch').length;
  const existing = duplicates.filter((d) => d.kind === 'existing').length;
  const withWarnings = products.filter((p) => p.warnings.length > 0).length;
  const priced = products.filter((p) => p.priceMinor !== null).length;
  return {
    total: products.length,
    importable: products.length - inBatch,
    duplicateInBatch: inBatch,
    duplicateExisting: existing,
    withWarnings,
    priced,
    unpriced: products.length - priced,
  };
}

/**
 * Convertit un produit d'API publique en produit normalisé.
 *
 * La différence Shopify / WooCommerce est réelle et piégeuse :
 *   - Shopify donne `12000.00` (unité principale, texte décimal) ;
 *   - WooCommerce donne `12000` (unité **mineure** : 120,00 € serait `12000`).
 * Les traiter pareil produirait des prix faux d'un facteur 100. On applique
 * donc deux conversions distinctes, et le résultat est vérifié par test.
 */
export function normalizeCatalogProduct(
  raw: RawCatalogProduct,
  platform: CatalogPlatform,
  origin: { reference: string; endpoint: string },
  defaultCurrency = DEFAULT_CURRENCY,
): NormalizedProduct | { error: string } {
  const currency = (raw.currency ?? defaultCurrency).toUpperCase();
  // Les avertissements du LECTEUR passent en premier : ils décrivent une limite
  // de la source (« variantes non exposées ») que le prix ne doit pas masquer.
  const warnings: string[] = [...(raw.warnings ?? [])];

  let priceMinor: number | null;
  if (typeof raw.priceMinor === 'number' && Number.isFinite(raw.priceMinor) && raw.priceMinor >= 0) {
    // Le lecteur a déjà converti : PrestaShop publie un décimal dont l'exposant
    // dépend de la devise de la boutique. Reconvertir ici reviendrait à
    // deviner une deuxième fois, et à diverger du prix affiché par la boutique.
    priceMinor = Math.round(raw.priceMinor);
  } else if (platform === 'woocommerce' || platform === 'prestashop' && raw.priceMinor === undefined) {
    // Déjà en unité mineure : on refuse seulement ce qui n'est pas entier.
    const nombre = raw.price === null ? null : Number(String(raw.price).replace(/[^\d.-]/g, ''));
    if (nombre !== null && Number.isFinite(nombre) && nombre >= 0) {
      priceMinor = Math.round(nombre);
    } else {
      priceMinor = null;
      if (raw.price !== null) warnings.push('prix WooCommerce illisible');
    }
  } else {
    const converti = parsePriceMinor(raw.price, currency);
    priceMinor = converti.minor;
    if (converti.warning) warnings.push(converti.warning);
  }

  // URL relative Shopify (`/products/serum`) : on la résout sur l'origine.
  let productUrl: string | null = raw.productUrl;
  if (productUrl && productUrl.startsWith('/')) {
    try {
      productUrl = new URL(productUrl, origin.endpoint).toString();
    } catch {
      productUrl = null;
      warnings.push('URL produit relative non résolue');
    }
  }

  return buildProduct({
    name: raw.name,
    description: raw.description,
    priceMinor,
    currency,
    productUrl,
    imageUrl: raw.imageUrl,
    categories: raw.categories,
    variants: raw.variants.map((v) => ({
      name: v.name,
      priceMinor: typeof v.priceMinor === 'number' && Number.isFinite(v.priceMinor)
        ? Math.round(v.priceMinor)
        : platform === 'woocommerce'
          ? (v.price === null ? null : Math.round(Number(String(v.price).replace(/[^\d.-]/g, '')) || 0))
          : parsePriceMinor(v.price, currency).minor,
      sku: v.sku,
      // Une source distante ne fournit pas toujours un stock par variante :
      // `null` (inconnu) et non 0, qui afficherait « rupture » partout.
      // PrestaShop, lui, le publie — on le transmet tel quel.
      stock: typeof v.stock === 'number' && Number.isFinite(v.stock) ? v.stock : null,
      currency: null,
      attributeName: v.attributeName ?? null,
      available: v.available,
    })),
    // Identifiants stables transmis tels quels : le rapprochement les utilise,
    // la normalisation ne les invente pas.
    sku: raw.sku,
    platformId: raw.platformId,
    // Stock global quand le lecteur le connaît (PrestaShop). `undefined` laisse
    // `buildProduct` décider : somme des déclinaisons, ou inconnu.
    ...(typeof raw.stock === 'number' && Number.isFinite(raw.stock) ? { stock: raw.stock } : {}),
    source: { platform, reference: origin.reference },
    warnings,
  });
}

/** Assemble un lot à partir de produits normalisés et de rejets. */
function assemble(
  origin: ImportOrigin,
  produits: NormalizedProduct[],
  rejected: Array<{ line: number; reason: string }>,
  warnings: string[],
  truncated: boolean,
  existing: Array<{ id: string; name: string }>,
): ImportBatch {
  const duplicates = findDuplicates(produits, existing);
  return {
    origin,
    products: produits,
    duplicates,
    rejected,
    warnings,
    truncated,
    summary: summarizeBatch(produits, duplicates),
  };
}

/**
 * Un produit est-il importable tel quel ?
 *
 * Exporté parce que l'interface doit appliquer exactement la même règle que
 * l'écriture : proposer d'importer un produit que la base refusera serait un
 * faux pas de plus.
 */
export function isImportable(product: NormalizedProduct): boolean {
  return Boolean(product.name && product.name.trim().length > 0);
}

/**
 * Exécute un import complet.
 *
 * L'ordre est significatif : on sonde **avant** de lire le catalogue, car la
 * lecture dépend de la plateforme détectée. Et si la détection échoue, on ne
 * tente aucun point d'accès au hasard.
 */
export async function runUrlImport(input: string, options: RunImportOptions = {}): Promise<ImportResult> {
  const deps = options.deps ?? {};
  const existing = options.existing ?? [];
  const currency = options.currency ?? DEFAULT_CURRENCY;

  // 1) Sonde
  const sonde = await probeStore(input, deps);
  if (!sonde.ok) {
    return { ok: false, stage: 'probe', errors: [sonde.error.message] };
  }

  const verdict = detectPlatform(sonde.value);

  // 2) Acquisition
  if (verdict.platform === 'unknown' || verdict.access !== 'public-json') {
    // On ne devine pas un endpoint. On explique ce qui est possible.
    const raison = verdict.platform === 'unknown'
      ? 'Plateforme non identifiée : aucun catalogue public ne peut être lu automatiquement.'
      : `Plateforme identifiée (${verdict.platform}) mais sans catalogue public normalisé.`;
    return {
      ok: false,
      stage: 'acquire',
      verdict,
      errors: [
        raison,
        'Importez votre catalogue depuis un export CSV, XLSX ou XML, ou connectez la boutique par son API officielle.',
      ],
    };
  }

  const root = new URL(`${new URL(sonde.value.finalUrl).origin}${new URL(sonde.value.finalUrl).pathname.replace(/\/$/, '')}/`);
  const catalogue = await fetchPublicCatalog(verdict.platform, root, deps);
  if (!catalogue.ok) {
    return { ok: false, stage: 'acquire', verdict, errors: [catalogue.error.message] };
  }

  // 3) Normalisation
  const { produits, rejets } = normalizeCatalog(catalogue.value, verdict.platform as 'shopify' | 'woocommerce', currency);

  if (produits.length === 0) {
    return {
      ok: false,
      stage: 'normalize',
      verdict,
      errors: ['Aucun produit exploitable dans le catalogue public.', ...rejets.slice(0, 3).map((r) => `Ligne ${r.line} : ${r.reason}`)],
    };
  }

  return {
    ok: true,
    batch: assemble(
      {
        kind: 'url',
        reference: new URL(sonde.value.finalUrl).origin,
        platform: verdict.platform,
        endpoint: catalogue.value.endpoint,
      },
      produits,
      rejets,
      [],
      catalogue.value.products.length >= 250,
      existing,
    ),
  };
}

/** Normalise un catalogue public entier, en gardant la trace des rejets. */
export function normalizeCatalog(
  catalogue: PublicCatalog,
  platform: CatalogPlatform,
  currency: string,
): { produits: NormalizedProduct[]; rejets: Array<{ line: number; reason: string }> } {
  const produits: NormalizedProduct[] = [];
  const rejets: Array<{ line: number; reason: string }> = [];
  catalogue.products.forEach((brut, index) => {
    const produit = normalizeCatalogProduct(
      brut,
      platform,
      { reference: catalogue.endpoint, endpoint: catalogue.endpoint },
      currency,
    );
    if ('error' in produit) {
      rejets.push({ line: index + 1, reason: produit.error });
      return;
    }
    produits.push(produit);
  });
  return { produits, rejets };
}

/**
 * Exécute un import de fichier.
 *
 * Le parsing est délégué (injectable) pour que la couche réseau et la couche
 * fichier restent testables séparément.
 */
export async function runFileImport(
  bytes: Uint8Array,
  filename: string,
  options: RunImportOptions = {},
): Promise<ImportResult> {
  const importer = options.importer ?? (await import('./files')).importFile;
  const resultat = await importer(bytes, filename);

  if (!resultat.ok) {
    return { ok: false, stage: 'acquire', errors: resultat.errors };
  }

  const produits = resultat.products;
  if (produits.length === 0) {
    return { ok: false, stage: 'normalize', errors: ['Aucun produit valide dans le fichier.'] };
  }

  return {
    ok: true,
    batch: assemble(
      { kind: 'file', reference: filename, platform: 'unknown', endpoint: null },
      produits,
      [],
      resultat.warnings,
      resultat.truncated,
      options.existing ?? [],
    ),
  };
}

/** Point d'entrée unique, selon l'intention. */
export async function runImport(intent: ImportIntent, options: RunImportOptions = {}): Promise<ImportResult> {
  if (intent.kind === 'url') return runUrlImport(intent.url, options);
  return runFileImport(intent.bytes, intent.filename, options);
}

/** Formate un prix normalisé pour l'affichage de prévisualisation. */
export function formatPreviewPrice(product: NormalizedProduct): string {
  if (product.priceMinor === null) return 'prix à compléter';
  const exposant = ['XOF', 'XAF', 'JPY', 'KRW', 'CLP'].includes(product.currency) ? 0 : 2;
  const valeur = exposant === 0 ? product.priceMinor : product.priceMinor / 10 ** exposant;
  try {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: product.currency,
      maximumFractionDigits: exposant,
      minimumFractionDigits: exposant,
    }).format(valeur);
  } catch {
    return `${valeur.toLocaleString('fr-FR')} ${product.currency}`;
  }
}
