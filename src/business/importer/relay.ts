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

/* ------------------------- validité de l'aperçu -------------------------- */

/**
 * Seuil à partir duquel on prévient l'utilisateur que l'aperçu va expirer.
 *
 * Deux minutes : assez tôt pour qu'il ait le temps de confirmer ou de relancer,
 * assez tard pour ne pas crier au loup dès l'affichage d'un aperçu qu'il vient
 * de demander. En dessous, le message devient une alerte ; au-delà, il n'y a
 * rien à dire.
 */
export const PREVIEW_WARNING_MS = 2 * 60 * 1000;

export type PreviewValidity =
  /** Valide, largement le temps de confirmer. */
  | { state: 'valid'; remainingMs: number; label: string }
  /** Valide, mais l'échéance approche. */
  | { state: 'expiring'; remainingMs: number; label: string }
  /** Échu : la confirmation est refusée par le serveur. */
  | { state: 'expired'; remainingMs: 0; label: string }
  /** Le serveur n'a pas fourni d'échéance lisible : on n'affirme rien. */
  | { state: 'unknown'; remainingMs: null; label: string };

/**
 * Traduit une échéance ISO en état affichable.
 *
 * ## Pourquoi c'est ici et pas dans le composant
 * C'est une règle, pas de la mise en page : elle décide si le bouton de
 * confirmation doit être actif. La tester dans un composant obligerait à faire
 * avancer une horloge React ; ici, c'est une fonction pure, vérifiable
 * directement — et c'est elle qui garantit qu'on ne propose **jamais** de
 * confirmer un aperçu expiré.
 *
 * `remainingMs` peut être négatif en entrée (horloge locale en retard sur le
 * serveur) : on le ramène à 0 plutôt que d'afficher une durée négative.
 */
export function previewValidity(expiresAt: string | null | undefined, now: number): PreviewValidity {
  if (!expiresAt) {
    return { state: 'unknown', remainingMs: null, label: 'Durée de validité inconnue.' };
  }
  const echeance = Date.parse(expiresAt);
  if (!Number.isFinite(echeance)) {
    return { state: 'unknown', remainingMs: null, label: 'Durée de validité inconnue.' };
  }
  const reste = Math.max(0, echeance - now);
  if (reste === 0) {
    return {
      state: 'expired',
      remainingMs: 0,
      label: 'Aperçu expiré. Relancez l’analyse du fichier pour confirmer.',
    };
  }
  const label = `Aperçu valable encore ${formaterDuree(reste)} : confirmez avant l’expiration.`;
  if (reste <= PREVIEW_WARNING_MS) {
    return { state: 'expiring', remainingMs: reste, label };
  }
  return { state: 'valid', remainingMs: reste, label };
}

/**
 * Formate une durée courte en français lisible.
 *
 * Arrondi à la seconde inférieure : afficher « 1 min » quand il reste 59 s
 * ferait confirmer l'utilisateur à une seconde de l'échec.
 */
export function formaterDuree(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const secondes = total % 60;
  if (minutes === 0) return `${secondes} s`;
  if (secondes === 0) return `${minutes} min`;
  return `${minutes} min ${secondes} s`;
}
