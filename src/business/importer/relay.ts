/**
 * Client de l'Edge Function `store-import`.
 *
 * ## Aucun accès réseau direct à la boutique
 * Le navigateur ne résout pas le DNS et ne peut pas épingler une IP : il ne
 * contacte donc **jamais** la boutique. Il envoie l'URL au serveur, qui valide,
 * résout, contrôle et lit. L'aperçu revient décrit ; la confirmation renvoie un
 * `previewId` que seul le serveur peut honorer.
 *
 * ## L'aperçu ne crée rien
 * `previewStore` n'écrit aucun produit, ni côté serveur ni côté client. C'est
 * `importStore` — après `confirmed: true` et un aperçu appartenant à cet
 * utilisateur et cette entreprise — qui déclenche l'écriture.
 */
import { invokeEdge } from '../../lib/api';
import type { NormalizedProduct } from './normalize';
import type { ImportBatch } from './pipeline';

/** Produit tel que l'aperçu serveur le décrit. */
export interface StorePreviewProduct {
  index: number;
  name: string;
  price: string;
  currency: string;
  productUrl: string | null;
  warnings: string[];
  duplicate: 'in-batch' | 'existing' | null;
  importable: boolean;
  /**
   * Déclinaisons du produit, telles que le serveur les écrira.
   *
   * Optionnel dans le type et non obligatoire : un serveur plus ancien (ou une
   * réponse mise en cache) n'en renvoie pas, et l'interface doit alors afficher
   * la fiche sans variantes plutôt que de casser sur `undefined`.
   */
  variants?: Array<{
    name: string;
    price: string;
    currency: string;
    sku: string | null;
    stock: number | null;
    attributeName: string | null;
  }>;
}

export interface StorePreview {
  previewId: string;
  /**
   * Nombre de produits écartés parce que NON PUBLIÉS chez la source (Chariow).
   *
   * Absent pour les sources qui n'ont pas de notion de brouillon. Sa présence
   * permet à l'écran de distinguer « 3 produits » de « 3 produits, 5 brouillons
   * ignorés » — sinon un marchand croirait son catalogue incomplet.
   */
  draftsSkipped?: number;
  expiresAt: string;
  summary: ImportBatch['summary'];
  products: StorePreviewProduct[];
  rejected: Array<{ line: number; reason: string }>;
  warnings: string[];
  origin: ImportBatch['origin'];
  /** Adresse réellement contactée par le serveur (preuve du contrôle SSRF). */
  connectedTo: string;
}

export interface StoreImportResult {
  created: number;
  failed: Array<{ name: string; reason: string }>;
}

interface Enveloppe<T> {
  data: T;
}

/**
 * Encode un fichier en base64 pour l'envoi au serveur.
 *
 * `btoa` n'accepte que du latin-1 : on passe par les octets, jamais par la
 * chaîne Unicode. Le découpage par blocs évite de dépasser la taille maximale
 * d'arguments lors de l'étalement d'un très gros tableau.
 */
export function fichierEnBase64(octets: Uint8Array): string {
  let binaire = '';
  const bloc = 0x8000;
  for (let i = 0; i < octets.length; i += bloc) {
    binaire += String.fromCharCode(...octets.subarray(i, i + bloc));
  }
  return btoa(binaire);
}

/**
 * Demande l'aperçu d'un FICHIER. **N'écrit rien.**
 *
 * Le fichier était auparavant analysé dans le navigateur, puis écrit par des
 * `insert` PostgREST successifs que seule l'appartenance à l'entreprise
 * contrôlait : un compte sans abonnement pouvait donc créer des produits, alors
 * qu'il était refusé sur le chemin URL. En passant par la même Edge Function, la
 * garde d'abonnement est évaluée **avant** l'analyse du fichier.
 */
export async function previewFile(input: {
  workspaceId: string;
  fileName: string;
  bytes: Uint8Array;
}): Promise<StorePreview> {
  const { data } = await invokeEdge<Enveloppe<StorePreview>>('store-import', {
    action: 'preview',
    workspaceId: input.workspaceId,
    fileName: input.fileName,
    fileBase64: fichierEnBase64(input.bytes),
  });
  return data;
}

/**
 * Demande un aperçu. **N'écrit rien.**
 *
 * Lève `AppError` avec le code serveur (`URL_REFUSED`, `RESOLVER_UNAVAILABLE`,
 * `PLATFORM_UNKNOWN`, `NO_PUBLIC_CATALOG`, …) : l'interface affiche la raison
 * exacte au lieu d'un échec générique.
 */
export async function previewStore(input: {
  workspaceId: string;
  url: string;
}): Promise<StorePreview> {
  const { data } = await invokeEdge<Enveloppe<StorePreview>>('store-import', {
    action: 'preview',
    workspaceId: input.workspaceId,
    url: input.url,
  });
  return data;
}

/**
 * Demande un aperçu pour un connecteur à clé d'API **hébergée** (Chariow).
 *
 * Pourquoi une fonction distincte plutôt qu'un `url` facultatif :
 *
 * - Pour PrestaShop, l'URL **est** l'API : elle est obligatoire, et l'oublier
 *   donne un aperçu qui échoue à l'exécution.
 * - Pour Chariow, l'API est chez l'éditeur (`api.chariow.com`) : la clé vient
 *   de Vault, et l'adresse de vitrine ne sert qu'à nommer la source. Un appel
 *   « aperçu d'une boutique par URL » laisserait croire que le serveur va
 *   contacter cette adresse, ce qui est faux.
 *
 * Le type sépare donc deux intentions réelles, au lieu de rendre un paramètre
 * optionnel qui serait obligatoire dans un cas et ignoré dans l'autre.
 */
export async function previewConnectedStore(input: {
  workspaceId: string;
  connectorKey: 'chariow';
}): Promise<StorePreview> {
  const { data } = await invokeEdge<Enveloppe<StorePreview>>('store-import', {
    action: 'preview',
    workspaceId: input.workspaceId,
    // Le serveur lit la clé dans Vault sous ce connecteur. L'absence d'URL est
    // volontaire : pour Chariow, il n'y a pas de boutique à joindre.
    connectorKey: input.connectorKey,
  });
  return data;
}

/**
 * Confirme l'import d'un aperçu.
 *
 * `selection` permet de n'importer qu'une partie des produits ; absente, tous
 * les produits importables de l'aperçu sont retenus. Le serveur refuse un
 * aperçu expiré, déjà consommé, ou appartenant à un autre utilisateur ou une
 * autre entreprise.
 */
export async function importStore(input: {
  workspaceId: string;
  previewId: string;
  selection?: number[];
}): Promise<StoreImportResult> {
  const { data } = await invokeEdge<Enveloppe<StoreImportResult>>('store-import', {
    action: 'import',
    workspaceId: input.workspaceId,
    previewId: input.previewId,
    // Strictement `true` : le serveur refuse toute autre valeur.
    confirmed: true,
    ...(input.selection ? { selection: input.selection } : {}),
  });
  return data;
}

/**
 * Convertit un aperçu serveur en `ImportBatch` pour l'affichage existant.
 *
 * Les produits ne portent ici que ce que l'aperçu expose (nom, prix formaté,
 * URL, avertissements) : l'écriture est faite par le serveur, donc aucun
 * `NormalizedProduct` complet n'est nécessaire côté navigateur. Le champ
 * `products` reste vide et l'interface s'appuie sur `preview.products`.
 */
export function previewToBatch(preview: StorePreview): ImportBatch {
  const duplicates: ImportBatch['duplicates'] = preview.products
    .filter((produit) => produit.duplicate !== null)
    .map((produit) => ({ index: produit.index, kind: produit.duplicate as 'in-batch' | 'existing' }));
  return {
    origin: preview.origin,
    products: [] as NormalizedProduct[],
    duplicates,
    rejected: preview.rejected,
    warnings: preview.warnings,
    truncated: false,
    summary: preview.summary,
  };
}

// La logique de validité vit dans `preview-validity.ts` : elle est pure et
// testable sans navigateur, alors que ce module importe la couche `api` (qui
// touche `window`). On la ré-exporte ici pour que l'interface n'ait qu'un seul
// point d'entrée à connaître.
export {
  PREVIEW_WARNING_MS, formaterDuree, previewValidity,
  type PreviewValidity,
} from './preview-validity';
