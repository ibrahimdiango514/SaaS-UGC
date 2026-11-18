/**
 * Edge Function `store-import` — import d'un catalogue par URL **ou par fichier**.
 *
 * ## Pourquoi une Edge Function
 * Le navigateur ne peut ni résoudre le DNS ni épingler une IP : l'import par URL
 * exige du serveur. Le panneau `StoreImportPanel` affichait donc ce mode
 * désactivé. Ici la même logique d'import tourne côté serveur, avec une sortie
 * réseau contrôlée.
 *
 * ## Ce qui est réutilisé (aucune deuxième logique)
 * - `runUrlImport` / `normalizeCatalog` (`src/business/importer/pipeline.ts`) :
 *   pipeline exact du client.
 * - `probeStore` / `fetchPublicCatalog` (`sources.ts`) : sonde et lecture.
 * - `parseStoreUrl` / `assertPublicAddresses` : validation d'URL et d'IP.
 * - La sortie réseau est remplacée par `pinnedFetchLike` (`safe-egress.ts`) :
 *   même pipeline, mais la connexion est épinglée sur l'IP validée.
 *
 * ## Pourquoi l'import de fichier passe aussi par ici
 * Le chemin fichier existait uniquement côté navigateur : le fichier était
 * analysé localement, puis écrit par des `insert` PostgREST successifs. Or ces
 * `insert` ne sont contrôlés que par l'appartenance à l'entreprise : un compte
 * SANS abonnement pouvait donc créer des produits en appelant PostgREST
 * directement, alors que le même compte était refusé sur le chemin URL. Un
 * verrou qui ne protège qu'une porte n'est pas un verrou. Le fichier est
 * maintenant analysé et écrit ici, derrière la même garde d'abonnement.
 *
 * ## Garanties
 * - **Aperçu sans écriture** : `preview` ne touche jamais `ugc_products`.
 * - **Confirmation explicite** : `import` exige `confirmed === true` ET un
 *   `previewId` émis par CETTE fonction pour CET utilisateur et CETTE
 *   entreprise ; il expire et ne peut pas être rejoué.
 * - **Isolation** : l'entreprise est vérifiée côté base par
 *   `saas_business.bg_require_workspace` (owner ou membre avec rôle d'écriture),
 *   pas seulement par un identifiant reçu du client.
 * - **Aucun secret transmis** : la requête sortante ne porte ni JWT ni clé. Le
 *   contrôle le vérifie par test.
 */

import { probeStore } from '../../../src/business/importer/sources.ts';
import { detectPlatform } from '../../../src/business/importer/platform.ts';
import { matchesOrigin } from '../../../src/lib/origin-allowlist.ts';
import {
  formatPreviewPrice,
  isImportable,
  normalizeCatalog,
  type ImportBatch,
} from '../../../src/business/importer/pipeline.ts';
import { fetchPublicCatalog } from '../../../src/business/importer/sources.ts';
import { DEFAULT_CURRENCY, type NormalizedProduct } from '../../../src/business/importer/normalize.ts';
import { matchBatch, type MatchResult } from '../../../src/business/importer/matching.ts';
import { readPrestashopCatalog } from '../../../src/business/importer/prestashop-catalog.ts';
import { readShopifyCatalog } from '../../../src/business/importer/shopify-api.ts';
import { toShopifyRawProducts } from '../../../src/business/importer/shopify-catalog.ts';
import { readWooCatalog } from '../../../src/business/importer/woocommerce-api.ts';
import type { StorePlatform } from '../../../src/business/importer/platform.ts';
import { toWooRawProducts } from '../../../src/business/importer/woocommerce-catalog.ts';
import { explainChariowError, readChariowCatalog, toChariowRawProduct } from '../../../src/business/importer/chariow-catalog.ts';
import type { FileParseResult } from '../../../src/business/importer/files.ts';
import { pinnedFetchLike, type EgressDeps } from './safe-egress.ts';
import { MAX_CATALOG_BYTES, MAX_HTML_BYTES } from '../../../src/business/importer/sources.ts';

/* ------------------------------- dépendances ------------------------------- */

/** Ligne de produit déjà présente, pour la détection de doublons. */
export interface ExistingProduct {
  id: string;
  name: string;
  /** Référence produit en base (peut être absente sur un ancien import). */
  sku?: string | null;
  /** Identifiant de la plateforme d'origine, s'il a été conservé. */
  platformId?: string | null;
  /** Références des déclinaisons : un SKU de variante identifie le produit. */
  variantSkus?: string[];
}

export interface WorkspaceGrant {
  /** L'utilisateur peut-il LIRE cette entreprise ? */
  canRead: boolean;
  /** L'utilisateur peut-il ÉCRIRE dans cette entreprise ? */
  canWrite: boolean;
}

/** Une ligne de progression : un produit réellement traité. */
export interface ProgressRecord {
  workspaceId: string;
  userId: string;
  importKey: string;
  lineKey: string;
  productId: string;
  outcome: 'created' | 'updated';
  variantsWritten: number;
}

export interface PreviewRecord {
  userId: string;
  workspaceId: string;
  createdAt: number;
  /** D'où viennent les produits : sert à l'historique et à la traçabilité. */
  kind: 'url' | 'file';
  /** Produits validés au moment de l'aperçu — la confirmation ne relit pas le réseau. */
  products: NormalizedProduct[];
  /**
   * Pour chaque produit, s'il est importable (hors doublon interne).
   *
   * Mémorisé ici et non recalculé à la confirmation : le choix affiché à
   * l'utilisateur doit être exactement celui appliqué, même si le catalogue
   * change entre-temps.
   */
  importables?: boolean[];
  /**
   * Décisions de rapprochement, par position dans `products`.
   *
   * Mémorisées avec l'aperçu, et pas recalculées à la confirmation : la cible
   * d'une mise à jour doit rester celle qui a été montrée. Un catalogue qui
   * change entre l'aperçu et la confirmation ne doit pas déplacer l'écriture
   * sur une autre fiche.
   */
  matches?: Array<{ match: string; targetId: string | null }>;
  origin: ImportBatch['origin'];
}

/**
 * Droits d'accès au module Import & Connect, calculés CÔTÉ SERVEUR.
 *
 * Le navigateur n'envoie jamais ceci : la valeur vient de
 * `saas_business.bg_import_access`, lue avec la connexion service. Un client
 * qui prétendrait être abonné n'a aucune prise sur cette décision.
 */
export interface ImportAccess {
  allowed: boolean;
  /** Motif lisible par la machine : NO_SUBSCRIPTION, SUBSCRIPTION_EXPIRED… */
  reason: string;
  /** Message destiné à l'utilisateur. */
  message: string;
  status?: string | null;
  planKey?: string | null;
  currentPeriodEnd?: string | null;
}

/**
 * Stockage des aperçus.
 *
 * ## Pourquoi une interface, et pas une `Map` en dur
 * Un aperçu vivait uniquement dans la mémoire de l'instance Edge qui l'avait
 * produit. Or Supabase Edge Functions en font tourner plusieurs : la
 * confirmation, servie par une autre instance, ne retrouvait pas l'aperçu et
 * répondait `PREVIEW_EXPIRED`. Un import de fichier devenait donc **impossible
 * à confirmer** dès que deux requêtes tombaient sur deux instances — ce qui
 * était exactement le cas en production, et pas dans les tests à une instance.
 *
 * L'interface permet une implémentation partagée (la base) sans changer le
 * contrat du handler ; la `Map` reste le repli quand aucune n'est fournie.
 */
export interface PreviewStore {
  get(id: string): Promise<PreviewRecord | undefined>;
  /** `expiresAt` est absolu : le stockage n'a pas à connaître la durée de vie. */
  set(id: string, record: PreviewRecord, expiresAt: number): Promise<void>;
  delete(id: string): Promise<void>;
  /** Appelé avant lecture/écriture : retire les aperçus échus. */
  purge(limite: number, ttl: number): Promise<void>;
}

export interface StoreImportDependencies {
  /** Vérifie l'utilisateur à partir de l'en-tête Authorization. */
  getUserId(authorization: string): Promise<string | null>;
  /**
   * Vérifie l'abonnement Business Grow de CET utilisateur.
   *
   * Obligatoire : sans cette dépendance, le module refuse de servir
   * (`IMPORT_ACCESS_UNAVAILABLE`). On préfère indisponible à ouvert.
   */
  checkImportAccess(userId: string): Promise<ImportAccess>;
  /** Contrôle d'accès à l'entreprise, exécuté en base. */
  grantWorkspace(userId: string, workspaceId: string): Promise<WorkspaceGrant>;
  /** Catalogue existant de l'entreprise, pour les doublons. */
  listExistingProducts(workspaceId: string): Promise<ExistingProduct[]>;
  /** Écrit les produits retenus. Ne doit jamais être appelé par `preview`. */
  insertProducts(
    workspaceId: string,
    products: NormalizedProduct[],
    /** Origine réelle, enregistrée dans les faits du produit (audit). */
    kind?: 'url' | 'file',
    /**
     * `updateExisting` remplace les produits déjà présents au lieu d'en créer
     * un doublon. Absent = création (comportement historique).
     *
     * `indexes` restreint l'écriture à ces positions du lot : c'est le
     * mécanisme de reprise — on ne retraite que ce qui reste.
     */
    options?: { updateExisting?: boolean; indexes?: number[] },
  ): Promise<{
    created: number;
    /** Nombre de VARIANTES réellement écrites, pas seulement détectées. */
    variantsCreated?: number;
    /** Produits EXISTANTS mis à jour (mode mise à jour uniquement). */
    updated?: number;
    /** Variantes ajoutées à des produits existants (mode mise à jour). */
    variantsUpdated?: number;
    /**
     * Lignes réellement écrites, dans l'ordre. Sert à journaliser la
     * progression : sans elles, une reprise ne saurait pas ce qui est fait.
     */
    written?: Array<{ index: number; productId: string; outcome: 'created' | 'updated'; variantsWritten: number }>;
    failed: Array<{ name: string; reason: string }>;
  }>;
  /**
   * Progression d'un lot : lignes déjà écrites, pour reprendre sans doublon.
   *
   * Optionnel : sans cette dépendance, la reprise se comporte comme avant —
   * elle retraite tout le lot, ce que le rapprochement transforme en mises à
   * jour plutôt qu'en doublons. On perd la reprise fine, pas la sûreté.
   */
  readProgress?(workspaceId: string, userId: string, importKey: string): Promise<ProgressRecord[]>;
  /**
   * Relit côté serveur la clé d'API d'une connexion boutique vérifiée.
   *
   * Utilisée par l'aperçu `prestashop` : le navigateur n'envoie jamais la clé,
   * et elle ne ressort pas de la fonction. Absente = le connecteur n'est pas
   * disponible dans cette installation ; l'aperçu le dit explicitement au lieu
   * d'échouer sur une clé vide.
   */
  readStoreCredential?(userId: string, connectorKey: string): Promise<string | null>;
  /** Écrit une ligne de progression après une écriture réussie. */
  recordProgress?(line: ProgressRecord): Promise<void>;
  /**
   * Journalise l'import confirmé (produits créés, échecs, variantes).
   *
   * Optionnel pour ne pas casser les doublures de test existantes, mais
   * `index.ts` le fournit toujours : sans historique, « consulter son
   * historique après expiration » n'aurait rien à consulter.
   */
  recordImport?(job: {
    workspaceId: string;
    userId: string;
    source: 'file' | 'url';
    reference: string | null;
    created: number;
    failed: number;
    variantsCreated: number;
    failures: Array<{ name: string; reason: string }>;
  }): Promise<{ status: string }>;
  /**
   * Analyse d'un fichier (CSV/TSV/XML/XLSX).
   *
   * Injectable pour les tests ; en production, c'est `importFile` du module
   * partagé — exactement le même code que celui utilisé côté navigateur, pour
   * qu'un fichier ne puisse pas être lu différemment selon le chemin.
   */
  parseFile?: (bytes: Uint8Array, filename: string) => Promise<FileImportResult>;
  /**
   * Stockage des aperçus. Absent ⇒ mémoire de l'instance (repli), ce qui suffit
   * aux tests et au développement local, mais **pas** à plusieurs instances :
   * la confirmation tombait alors sur `PREVIEW_EXPIRED`.
   */
  previewStore?: PreviewStore;
  /** Résolveur DNS serveur. Absent = import refusé (fail-closed). */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Connexion TCP+TLS, injectable pour les tests. */
  connect?: EgressDeps['connect'];
  /** Horloge, injectable pour tester l'expiration. */
  now?: () => number;
  allowedOrigins: string[];
  /** Durée de validité d'un aperçu. */
  previewTtlMs?: number;
}

/* --------------------------------- types ---------------------------------- */

export type StoreImportAction = 'preview' | 'import';

export interface StoreImportRequest {
  action: StoreImportAction;
  workspaceId: string;
  /** Import par URL : adresse de la boutique. */
  url: string;
  /**
   * Import par fichier : contenu encodé en base64 et nom d'origine.
   *
   * Base64 plutôt que multipart : le corps reste du JSON, donc un seul chemin
   * de validation, et la taille se contrôle avant décodage.
   */
  fileBase64?: string;
  fileName?: string;
  /** Obligatoire pour `import`. */
  previewId?: string;
  /** Obligatoire pour `import`, strictement `true`. */
  confirmed?: boolean;
  /**
   * Mise à jour des produits déjà présents.
   *
   * Absent = comportement historique : un produit déjà au catalogue est créé
   * à côté (l'avertissement de l'aperçu le dit). `{ updateExisting: true }`
   * remplace le produit existant au lieu d'en créer un second — c'est la
   * demande « import et mise à jour des variantes » : réimporter un catalogue
   * qui a changé de tailles ne doit pas produire deux fiches.
   */
  updateExisting?: boolean;
  /** Indices de produits à écrire ; absent = tous les importables. */
  selection?: number[];
}

export interface PreviewPayload {
  previewId: string;
  expiresAt: string;
  origin: ImportBatch['origin'];
  /**
   * Produits écartés parce que non publiés chez la source (Chariow).
   *
   * Absent quand la notion n'existe pas pour la source. Sa présence évite de
   * faire passer « 3 produits publiés » pour « 3 produits au total ».
   */
  draftsSkipped?: number;
  summary: ImportBatch['summary'];
  products: Array<{
    index: number;
    name: string;
    price: string;
    currency: string;
    productUrl: string | null;
    /** Référence produit (SKU) lue à la source, si elle existe. */
    sku?: string | null;
    /** Identifiant du produit dans la plateforme d'origine. */
    platformId?: string | null;
    warnings: string[];
    duplicate: 'in-batch' | 'existing' | null;
    /**
     * Décision de rapprochement avec le catalogue existant.
     *
     * `ambiguous` n'écrit rien : la ligne est présentée pour décision, jamais
     * fusionnée d'office sur une ressemblance de nom.
     */
    match?: 'create' | 'update' | 'ambiguous' | 'duplicate-in-batch';
    /** Pourquoi cette décision — en français, lisible à l'écran. */
    matchReason?: string;
    /** Produits du catalogue proposés quand la décision est ambiguë. */
    candidates?: Array<{ id: string; name: string }>;
    /** Produit visé quand la décision est `update`. */
    targetId?: string | null;
    importable: boolean;
    /**
     * Plateforme d'origine de la fiche (`chariow`, `prestashop`, `unknown`…).
     *
     * Sert à expliquer une limite propre à la source dans l'écran d'aperçu —
     * par exemple l'absence de variantes détaillées chez Chariow.
     */
    platform?: string;
    /**
     * Déclinaisons détectées, telles qu'elles seront écrites.
     *
     * Exposer le détail — et pas seulement un nombre — est ce qui permet de
     * vérifier à l'écran que « S, M, L » seront bien persistés. Afficher
     * « 3 variantes » sans dire lesquelles ne prouve rien.
     */
    variants: Array<{
      name: string;
      price: string;
      currency: string;
      sku: string | null;
      stock: number | null;
      attributeName: string | null;
    }>;
  }>;
  rejected: Array<{ line: number; reason: string }>;
  warnings: string[];
  /** Adresse IP réellement contactée : preuve du contrôle SSRF. */
  connectedTo: string;
}

export interface ImportPayload {
  created: number;
  failed: Array<{ name: string; reason: string }>;
}

/* --------------------------------- erreurs -------------------------------- */

/** Résultat de l'analyse d'un fichier, tel que le handler le consomme. */
export type FileImportResult = FileParseResult;

export class StoreImportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'StoreImportError';
    this.code = code;
    this.status = status;
  }
}

const PREVIEW_TTL_MS = 10 * 60 * 1000;
/**
 * Plafond du fichier reçu.
 *
 * Identique à `MAX_FILE_BYTES` du module partagé (8 Mio), mais appliqué AVANT
 * décodage base64 : un corps de 200 Mo ne doit pas être matérialisé en mémoire
 * pour être ensuite refusé. On tolère 4/3 (l'encodage base64) plus une marge.
 */
const MAX_FILE_BASE64_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4096;
const MAX_PREVIEWS_PER_USER = 20;

/* -------------------------------- utilitaires ----------------------------- */

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function uuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/**
 * Origine autorisée ?
 *
 * Délègue à `matchesOrigin` : la même règle sert à `store-connect`. Deux
 * implémentations de la correspondance de motifs avaient déjà divergé (dont
 * une qui n'acceptait qu'un `*` en tête), et l'une d'elles laissait passer une
 * origine sans correspondance exacte du suffixe.
 */
function allowedOrigin(origin: string | null, liste: string[]): boolean {
  if (!origin) return false;
  return liste.some((motif) => matchesOrigin(motif, origin));
}

function jsonResponse(payload: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (origin) {
    headers.set('access-control-allow-origin', origin);
    headers.set('vary', 'Origin');
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

function failure(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/* --------------------------------- handler -------------------------------- */

/**
 * Repli en mémoire, utilisé quand aucun stockage partagé n'est fourni.
 *
 * Il conserve exactement le comportement d'origine (et les tests existants),
 * tout en rendant explicite sa limite : deux instances ne le partagent pas.
 */
function memoireLocale(): PreviewStore {
  const carte = new Map<string, PreviewRecord>();
  return {
    async get(id) {
      return carte.get(id);
    },
    async set(id, record) {
      carte.set(id, record);
      // Garde-fou : la carte ne doit jamais grossir sans fin.
      if (carte.size > MAX_PREVIEWS_PER_USER) {
        const tri = [...carte.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
        for (const [cle] of tri.slice(0, carte.size - MAX_PREVIEWS_PER_USER)) carte.delete(cle);
      }
    },
    async delete(id) {
      carte.delete(id);
    },
    async purge(limite, duree) {
      for (const [id, enregistrement] of carte) {
        if (limite - enregistrement.createdAt > duree) carte.delete(id);
      }
    },
  };
}

export function createStoreImportHandler(dependencies: StoreImportDependencies) {
  const allowedOrigins = dependencies.allowedOrigins;
  const now = dependencies.now ?? (() => Date.now());
  const ttl = dependencies.previewTtlMs ?? PREVIEW_TTL_MS;
  // Aperçus : stockage partagé quand il est fourni (base), mémoire locale sinon.
  // Le repli mémoire suffit à une instance unique ; il ne suffit pas en
  // production, où plusieurs instances se relaient.
  const apercus: PreviewStore = dependencies.previewStore ?? memoireLocale();
  const purge = () => apercus.purge(now(), ttl);

  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('Origin');
    const originOk = allowedOrigin(origin, allowedOrigins);
    const corsOrigin = originOk ? origin : null;

    if (request.method === 'OPTIONS') {
      // Négociation CORS seulement : aucune donnée, aucune action.
      const headers = new Headers({
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
        'access-control-max-age': '86400',
      });
      if (corsOrigin) {
        headers.set('access-control-allow-origin', corsOrigin);
        headers.set('vary', 'Origin');
      }
      return new Response(null, { status: 204, headers });
    }

    if (origin && !originOk) {
      // Refus AVANT authentification. CORS n'est pas la frontière d'auth, mais
      // on ne traite pas non plus une origine inconnue.
      return jsonResponse(failure('ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'), 403, origin);
    }
    if (request.method !== 'POST') {
      return jsonResponse(failure('METHOD_NOT_ALLOWED', 'Méthode non autorisée.'), 405, corsOrigin);
    }

    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
      return jsonResponse(failure('UNAUTHENTICATED', 'Authentification requise.'), 401, corsOrigin);
    }

    let userId: string | null;
    try {
      userId = await dependencies.getUserId(authorization);
    } catch {
      return jsonResponse(failure('AUTH_SERVICE_UNAVAILABLE', 'Le service d’authentification est temporairement indisponible.'), 503, corsOrigin);
    }
    if (!userId) {
      return jsonResponse(failure('UNAUTHENTICATED', 'Session VYORA invalide ou expirée.'), 401, corsOrigin);
    }
    if (!uuid(userId)) {
      return jsonResponse(failure('UNAUTHENTICATED', 'Session VYORA invalide.'), 401, corsOrigin);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return jsonResponse(failure('INVALID_BODY', 'Corps JSON invalide.'), 400, corsOrigin);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(failure('INVALID_BODY', 'Corps JSON invalide.'), 400, corsOrigin);
    }

    // ---------------------------------------------------------------------
    // ABONNEMENT BUSINESS GROUND — vérifié AVANT toute opération.
    //
    // Place volontaire : après l'identité (on sait QUI demande), et avant la
    // lecture de l'action, la vérification d'entreprise, tout accès réseau et
    // toute écriture. Un appel direct à cette fonction sans abonnement ne peut
    // donc rien déclencher, même avec un corps parfaitement formé.
    //
    // La décision ne dépend d'aucune valeur envoyée par le client : seul
    // `userId`, établi par GoTrue, est utilisé.
    // ---------------------------------------------------------------------
    if (typeof dependencies.checkImportAccess !== 'function') {
      return jsonResponse(
        failure('IMPORT_ACCESS_UNAVAILABLE', 'La vérification de l’abonnement est indisponible.'),
        503, corsOrigin,
      );
    }
    let access: ImportAccess;
    try {
      access = await dependencies.checkImportAccess(userId);
    } catch {
      // Panne de vérification : on refuse. Un doute ne doit jamais ouvrir
      // l'accès à un module réservé aux abonnés.
      return jsonResponse(
        failure('IMPORT_ACCESS_UNAVAILABLE', 'La vérification de l’abonnement est indisponible.'),
        503, corsOrigin,
      );
    }
    if (!access || access.allowed !== true) {
      return jsonResponse(
        {
          error: {
            code: 'BUSINESS_GROW_SUBSCRIPTION_REQUIRED',
            message: access?.message || 'Un abonnement Business Grow actif est requis.',
            reason: access?.reason ?? 'NO_SUBSCRIPTION',
            // Le client utilise ces champs pour afficher l'état réel et le lien
            // de souscription ; ils ne donnent aucun droit.
            subscription_status: access?.status ?? null,
            plan_key: access?.planKey ?? null,
            current_period_end: access?.currentPeriodEnd ?? null,
          },
        },
        403,
        corsOrigin,
      );
    }

    const action = text(body.action, 20);
    if (action !== 'preview' && action !== 'import' && action !== 'resume') {
      return jsonResponse(failure('UNKNOWN_ACTION', 'Opération d’import inconnue.'), 400, corsOrigin);
    }
    const workspaceId = uuid(body.workspaceId);
    if (!workspaceId) {
      return jsonResponse(failure('INVALID_WORKSPACE', 'Entreprise requise.'), 400, corsOrigin);
    }

    // Autorisation : contrôlée en base, jamais déduite de l'identifiant reçu.
    let grant: WorkspaceGrant;
    try {
      grant = await dependencies.grantWorkspace(userId, workspaceId);
    } catch {
      return jsonResponse(failure('WORKSPACE_CHECK_UNAVAILABLE', 'La vérification d’accès est indisponible.'), 503, corsOrigin);
    }
    if (!grant.canRead) {
      return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Accès refusé à cette entreprise.'), 403, corsOrigin);
    }

    try {
      if (action === 'preview') {
        if (!grant.canWrite) {
          return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Rôle insuffisant pour importer dans cette entreprise.'), 403, corsOrigin);
        }
        await purge();
        // Deux sources, une seule garde : l'abonnement a déjà été vérifié
        // ci-dessus, avant même de savoir de quel type d'import il s'agit.
        const fichier = typeof body.fileBase64 === 'string' && body.fileBase64.length > 0;
        /*
         * `connectorKey` : aperçu d'une boutique dont l'API est HÉBERGÉE chez
         * l'éditeur (Chariow). Il n'y a pas d'URL de boutique à joindre — la
         * clé est dans Vault, l'hôte de l'API est fixe.
         *
         * Sans cette distinction, l'appelant devrait envoyer une adresse
         * factice pour satisfaire la validation d'URL, ce qui ferait croire au
         * serveur qu'il va contacter cette adresse. Le type de la requête dit
         * donc deux intentions réelles, au lieu d'un paramètre détourné.
         */
        const connecteur = text(body.connectorKey, 40);
        const payload = fichier
          ? await faireApercuFichier(dependencies, {
            userId,
            workspaceId,
            base64: body.fileBase64 as string,
            nom: text(body.fileName, 200),
            // Horloge et TTL injectés : sans eux, `expiresAt` renvoyé au client
            // pouvait ne pas correspondre à l'échéance réelle du stockage, et
            // l'interface aurait décompté un temps faux.
            now,
            ttl,
          })
          : connecteur
            ? await faireApercuConnecteur(dependencies, { userId, workspaceId, connectorKey: connecteur, now, ttl })
            : await faireApercu(dependencies, { userId, workspaceId, url: text(body.url, 2048), now, ttl });
        await apercus.set(payload.data.previewId, {
          ...payload.record,
          kind: fichier ? 'file' : 'url',
          importables: payload.data.products.map((p) => p.importable),
        }, payload.record.createdAt + ttl);
        return jsonResponse({ data: payload.data }, 200, corsOrigin);
      }

      /* ---------------------------------------------------------------- */
      /* `resume` — état d'un lot, sans aucune écriture                     */
      /* ---------------------------------------------------------------- */
      // Volontairement en LECTURE seule : cette action dit où l'import s'est
      // arrêté. Elle n'écrit pas, et elle n'est jamais appelée
      // automatiquement — une opération dont le résultat est incertain ne se
      // relance pas sans vérifier son état.
      if (action === 'resume') {
        const lotKey = text(body.importKey, 80);
        if (!lotKey) {
          return jsonResponse(failure('IMPORT_KEY_REQUIRED', 'Identifiant de lot requis pour reprendre.'), 400, corsOrigin);
        }
        if (typeof dependencies.readProgress !== 'function') {
          // Sans journal, on ne prétend pas savoir : on le dit et on laisse
          // l'import normal se charger du rapprochement.
          return jsonResponse({
            data: {
              importKey: lotKey,
              progressAvailable: false,
              total: 0,
              lines: [],
              message: 'La progression de cet import n’est pas disponible : relancez l’aperçu, les produits déjà présents seront mis à jour et non dupliqués.',
            },
          }, 200, corsOrigin);
        }
        let lignes: ProgressRecord[] = [];
        try {
          lignes = await dependencies.readProgress(workspaceId, userId, lotKey);
        } catch {
          return jsonResponse(
            failure('PROGRESS_UNAVAILABLE', 'La progression de cet import est momentanément illisible.'),
            503, corsOrigin,
          );
        }
        return jsonResponse({
          data: {
            importKey: lotKey,
            progressAvailable: true,
            total: lignes.length,
            lines: lignes.map((ligne) => ({
              lineKey: ligne.lineKey,
              productId: ligne.productId,
              outcome: ligne.outcome,
              variantsWritten: ligne.variantsWritten,
            })),
          },
        }, 200, corsOrigin);
      }

      // `import`
      if (!grant.canWrite) {
        return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Rôle insuffisant pour importer dans cette entreprise.'), 403, corsOrigin);
      }
      if (body.confirmed !== true) {
        return jsonResponse(
          failure('CONFIRMATION_REQUIRED', 'Confirmez explicitement l’import : aucun produit n’est créé sans confirmation.'),
          400,
          corsOrigin,
        );
      }
      const previewId = text(body.previewId, 80);
      if (!previewId) {
        return jsonResponse(failure('PREVIEW_REQUIRED', 'Relancez l’aperçu : aucun produit n’est importé sans prévisualisation.'), 400, corsOrigin);
      }
      await purge();
      const enregistrement = await apercus.get(previewId);
      // Un aperçu appartient à UN utilisateur et UNE entreprise.
      if (!enregistrement || enregistrement.userId !== userId || enregistrement.workspaceId !== workspaceId) {
        return jsonResponse(failure('PREVIEW_EXPIRED', 'Aperçu introuvable ou expiré : relancez la prévisualisation.'), 409, corsOrigin);
      }
      if (now() - enregistrement.createdAt > ttl) {
        await apercus.delete(previewId);
        return jsonResponse(failure('PREVIEW_EXPIRED', 'Aperçu expiré : relancez la prévisualisation.'), 409, corsOrigin);
      }

      const selection = lireSelection(
        body.selection,
        enregistrement.products.length,
        enregistrement.importables,
      );
      if (selection instanceof StoreImportError) {
        return jsonResponse(failure(selection.code, selection.message), selection.status, corsOrigin);
      }
      const retenus = selection.map((index) => enregistrement.products[index]).filter(Boolean);
      if (retenus.length === 0) {
        return jsonResponse(failure('NOTHING_SELECTED', 'Aucun produit retenu pour l’import.'), 400, corsOrigin);
      }

      /*
       * Reprise : quand le client fournit une clé de lot et que le journal est
       * disponible, on RELIT la progression et on ne retraite que ce qui
       * reste. C'est la vérification d'état exigée avant toute reprise : on ne
       * relance pas une écriture incertaine, on regarde d'abord ce qui est
       * réellement en base.
       *
       * Si la lecture échoue, on ne reprend pas « à l'aveugle » : le lot est
       * traité entièrement, et le rapprochement transforme les produits déjà
       * présents en mises à jour. Moins efficace, jamais dupliquant.
       */
      const lotKey = text(body.importKey, 80);
      let indexes: number[] | undefined;
      let dejaFaits = 0;
      if (lotKey && typeof dependencies.readProgress === 'function') {
        try {
          const lignes = await dependencies.readProgress(workspaceId, userId, lotKey);
          const faites = new Set(lignes.map((ligne) => ligne.lineKey));
          const restants: number[] = [];
          selection.forEach((index) => {
            const produit = enregistrement.products[index];
            if (!produit) return;
            const cle = progressLineKey(produit);
            if (faites.has(cle)) { dejaFaits += 1; return; }
            restants.push(index);
          });
          // Tous les produits retenus sont déjà écrits : on ne réécrit RIEN et
          // on le dit. C'est l'idempotence demandée — répéter ne duplique pas.
          if (restants.length === 0) {
            await apercus.delete(previewId);
            return jsonResponse({
              data: {
                created: 0, updated: 0, variantsCreated: 0, variantsUpdated: 0,
                failed: [], alreadyDone: dejaFaits,
                message: 'Tous les produits de ce lot sont déjà écrits : rien n’a été réécrit.',
              },
            }, 200, corsOrigin);
          }
          indexes = restants;
        } catch {
          indexes = undefined;
        }
      }

      // Un aperçu ne se rejoue pas : la confirmation le consomme.
      await apercus.delete(previewId);
      // Le mode est volontairement explicite : `true` seul l'active, tout le
      // reste retombe sur la création, comme avant.
      /*
       * Cibles du rapprochement : pour chaque produit retenu que l'aperçu a
       * décidé de mettre à jour, l'identifiant exact du produit visé.
       *
       * C'est ce qui remplace la recherche par nom à l'écriture : deux fiches
       * homonymes ne peuvent plus être confondues, et un produit que le
       * rapprochement n'a pas retenu n'est jamais écrasé.
       */
      const targets: Record<number, string> = {};
      selection.forEach((position) => {
        const decision = enregistrement.matches?.[position];
        if (decision?.match === 'update' && decision.targetId) {
          targets[position] = decision.targetId;
        }
      });
      const aDesCibles = Object.keys(targets).length > 0;
      const mode = {
        updateExisting: body.updateExisting === true || aDesCibles,
        // `undefined` = tout le lot ; sinon, seulement ce qui reste à faire.
        indexes,
        targets,
      };
      const resultat = await dependencies.insertProducts(
        workspaceId, retenus, enregistrement.kind, mode,
      );

      /*
       * Progression : une ligne par produit réellement écrit, APRÈS coup.
       *
       * Une panne de ce journal ne fait pas échouer l'import (les produits sont
       * en base) ; elle prive seulement la reprise suivante du détail. Le
       * rapprochement reste le filet : les produits déjà présents seront mis à
       * jour, pas dupliqués.
       */
      if (lotKey && typeof dependencies.recordProgress === 'function' && resultat.written) {
        for (const ligne of resultat.written) {
          const produit = enregistrement.products[ligne.index];
          if (!produit) continue;
          try {
            await dependencies.recordProgress({
              workspaceId,
              userId,
              importKey: lotKey,
              lineKey: progressLineKey(produit),
              productId: ligne.productId,
              outcome: ligne.outcome,
              variantsWritten: ligne.variantsWritten,
            });
          } catch (erreur) {
            console.error('store-import: progression non enregistrée', {
              erreur: erreur instanceof Error ? erreur.message : 'inconnue',
            });
          }
        }
      }

      // L'historique est écrit APRÈS coup et ne fait jamais échouer l'import :
      // les produits sont déjà en base, une panne du journal ne doit pas
      // transformer un succès en erreur (l'utilisateur relancerait et
      // créerait des doublons).
      if (dependencies.recordImport) {
        try {
          await dependencies.recordImport({
            workspaceId,
            userId,
            source: enregistrement.kind,
            reference: enregistrement.origin?.reference ?? null,
            created: resultat.created + (resultat.updated ?? 0),
            failed: resultat.failed.length,
            variantsCreated: (resultat.variantsCreated ?? 0) + (resultat.variantsUpdated ?? 0),
            failures: resultat.failed,
          });
        } catch (erreur) {
          console.error('store-import: historique non enregistré', {
            erreur: erreur instanceof Error ? erreur.message : 'inconnue',
          });
        }
      }

      return jsonResponse({
        data: {
          ...resultat,
          variantsCreated: resultat.variantsCreated ?? 0,
          // Le détail des lignes écrites est interne : il sert au journal, pas
          // à l'affichage. On n'expose donc ni index ni identifiants.
          written: undefined,
          alreadyDone: dejaFaits,
        },
      }, 200, corsOrigin);
    } catch (cause) {
      if (cause instanceof StoreImportError) {
        return jsonResponse(failure(cause.code, cause.message), cause.status, corsOrigin);
      }
      console.error('store-import failed', { action });
      return jsonResponse(failure('STORE_IMPORT_BACKEND_ERROR', 'Le service d’import est temporairement indisponible.'), 500, corsOrigin);
    }
  };
}

/**
 * Clé stable d'une ligne de lot : référence d'abord, puis identifiant de
 * source, puis nom normalisé.
 *
 * Elle ne sert qu'à reconnaître une ligne DÉJÀ traitée dans un même lot — pas à
 * décider d'une fusion. Les décisions de rapprochement passent par
 * `matching.ts` et restent soumises à la décision de l'utilisateur.
 */
export function progressLineKey(produit: { name: string; sku?: string | null; platformId?: string | null }): string {
  const reference = String(produit.sku ?? '').trim().toUpperCase().replace(/[\s\-_.]+/g, '');
  if (reference) return `ref:${reference}`;
  const identifiant = String(produit.platformId ?? '').trim();
  if (identifiant) return `pid:${identifiant}`;
  const nom = String(produit.name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return `nom:${nom}`;
}

/**
 * Rapproche un lot du catalogue existant.
 *
 * Remplace l'ancienne comparaison « nom exact minuscule » par les niveaux de
 * `matching.ts`. Deux garanties pour l'appelant :
 *
 *  - `duplicate` et `importable` gardent leur sens historique, donc
 *    l'interface et les tests existants continuent de fonctionner ;
 *  - une correspondance AMBIGUË n'est jamais importable : elle est affichée
 *    pour décision, et l'import la refuse tant qu'elle n'est pas tranchée.
 *
 * Une ligne rapprochée reste importable (elle sera mise à jour) ; c'est
 * `match: 'update'` qui le dit, et l'interface peut le présenter ainsi.
 */
function rapprocher(
  produits: NormalizedProduct[],
  existants: ExistingProduct[],
): ReturnType<typeof matchBatch> {
  const catalogue = existants.map((produit) => ({
    id: produit.id,
    name: produit.name,
    sku: produit.sku ?? null,
    platformId: produit.platformId ?? null,
    variantSkus: produit.variantSkus ?? [],
  }));
  return matchBatch(
    produits.map((produit) => ({
      name: produit.name,
      sku: produit.sku ?? null,
      platformId: produit.platformId ?? null,
      variantSkus: (produit.variants ?? []).flatMap((v) => (v.sku ? [v.sku] : [])),
    })),
    catalogue,
  );
}

/**
 * Traduit une décision de rapprochement en champs d'aperçu.
 *
 * `matchReason` est en français et destiné à l'écran : il explique POURQUOI
 * rien ne sera écrit pour une ligne ambiguë, sans jargon.
 */
function decisionApercu(
  resultat: MatchResult | undefined,
  existants: ExistingProduct[],
): {
  duplicate: 'in-batch' | 'existing' | null;
  match: 'create' | 'update' | 'ambiguous' | 'duplicate-in-batch';
  matchReason: string;
  candidates: Array<{ id: string; name: string }>;
  targetId: string | null;
} {
  if (!resultat) {
    return { duplicate: null, match: 'create', matchReason: 'Aucun produit correspondant.', candidates: [], targetId: null };
  }
  switch (resultat.decision) {
    case 'update':
      return {
        duplicate: 'existing',
        match: 'update',
        matchReason: resultat.reason,
        candidates: [],
        targetId: resultat.targetId,
      };
    case 'ambiguous':
      return {
        // Historiquement, un nom déjà présent était marqué « existing ». On
        // conserve ce marquage pour l'affichage, sans en faire une décision.
        duplicate: 'existing',
        match: 'ambiguous',
        matchReason: resultat.reason,
        candidates: resultat.candidates.flatMap((id) => {
          const produit = existants.find((existant) => existant.id === id);
          return produit ? [{ id: produit.id, name: produit.name }] : [];
        }),
        targetId: null,
      };
    case 'duplicate-in-batch':
      return {
        duplicate: 'in-batch',
        match: 'duplicate-in-batch',
        matchReason: resultat.reason,
        candidates: [],
        targetId: null,
      };
    case 'create':
    default:
      return {
        duplicate: null,
        match: 'create',
        matchReason: resultat.reason,
        candidates: [],
        targetId: null,
      };
  }
}

/**
 * Détermine les produits à écrire.
 *
 * Par défaut, on ne retient que les produits **importables** de l'aperçu : un
 * doublon interne au lot est marqué non importable précisément pour ne pas être
 * écrit deux fois. Retenir « tous les indices » contredisait le résumé affiché
 * à l'utilisateur (et écrivait deux fois le même produit).
 *
 * Une sélection explicite reste honorée telle quelle : c'est l'utilisateur qui
 * décide, et le serveur ne réécrit pas son choix.
 */
function lireSelection(
  value: unknown,
  taille: number,
  importables?: boolean[],
): number[] | StoreImportError {
  if (value === undefined || value === null) {
    if (importables && importables.length === taille) {
      return importables.flatMap((ok, index) => (ok ? [index] : []));
    }
    return Array.from({ length: taille }, (_, i) => i);
  }
  if (!Array.isArray(value)) return new StoreImportError('INVALID_SELECTION', 'Sélection invalide.', 400);
  const propres = value.filter((v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) < taille);
  if (propres.length !== value.length) return new StoreImportError('INVALID_SELECTION', 'Sélection invalide.', 400);
  // Doublons retirés : un produit ne peut pas être importé deux fois.
  return [...new Set(propres as number[])];
}

/* -------------------------------- aperçu ---------------------------------- */

/**
 * Construit l'aperçu. **Ne lit ni n'écrit jamais `ugc_products`.**
 * Le seul accès disque est la liste des noms existants, pour signaler les
 * doublons sans rien créer.
 */
async function faireApercu(
  dependencies: StoreImportDependencies,
  contexte: { userId: string; workspaceId: string; url: string; now: () => number; ttl: number },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  if (!dependencies.resolveHost) {
    // Sans résolveur, l'épinglage est impossible : on refuse plutôt que de
    // laisser `fetch` résoudre lui-même (ce serait rouvrir le SSRF).
    throw new StoreImportError(
      'RESOLVER_UNAVAILABLE',
      'La vérification DNS serveur n’est pas disponible : import refusé par sécurité.',
      503,
    );
  }

  // L'IP contactée est relevée par la sortie réseau elle-même : la preuve du
  // contrôle SSRF ne coûte aucune requête supplémentaire.
  let connectedTo = '';
  const deps: EgressDeps = {
    resolveHost: dependencies.resolveHost,
    connect: dependencies.connect,
    onConnected: (ip) => {
      connectedTo = ip;
    },
  };
  const url = contexte.url;
  if (!url) throw new StoreImportError('INVALID_URL', 'URL de boutique requise.', 400);

  // 1) Sonde : `probeStore` du client, sortie réseau épinglée.
  //
  // La sonde lit une PAGE HTML : elle n'est pas authentifiée. C'est voulu — la
  // page d'accueil d'une boutique est publique, et y envoyer une clé d'API
  // ferait sortir le secret sur une URL arbitraire dictée par l'utilisateur.
  // L'authentification ne commence qu'à l'appel de l'API, sur la racine
  // déduite du site.
  const sonde = await probeStore(url, {
    resolveHost: deps.resolveHost,
    fetchImpl: pinnedFetchLike(deps, { accept: 'text/html,application/xhtml+xml', maxBytes: MAX_HTML_BYTES }),
  });
  if (!sonde.ok) {
    const code = sonde.error.code;
    if (code === 'blocked_url' || code === 'dns_failed') {
      throw new StoreImportError('URL_REFUSED', sonde.error.message, 400);
    }
    if (code === 'timeout') throw new StoreImportError('SOURCE_TIMEOUT', sonde.error.message, 504);
    if (code === 'too_large') throw new StoreImportError('RESPONSE_TOO_LARGE', sonde.error.message, 413);
    if (code === 'no_resolver') {
      throw new StoreImportError('RESOLVER_UNAVAILABLE', sonde.error.message, 503);
    }
    throw new StoreImportError('SOURCE_UNREACHABLE', sonde.error.message, 502);
  }

  // 2) Détection : même moteur que le client.
  const verdict = detectPlatform(sonde.value);
  if (verdict.platform === 'unknown') {
    throw new StoreImportError(
      'PLATFORM_UNKNOWN',
      'Plateforme non identifiée. Importez un export CSV, XLSX ou XML, ou connectez la boutique par son API officielle.',
      422,
    );
  }

  // 3) Acquisition : catalogue public normalisé, sinon explication honnête.
  const racine = new URL(`${new URL(sonde.value.finalUrl).origin}${new URL(sonde.value.finalUrl).pathname.replace(/\/$/, '')}/`);
  const produits: NormalizedProduct[] = [];
  let rejets: Array<{ line: number; reason: string }> = [];
  let endpoint: string | null = null;
  /** Produits Chariow écartés parce que non publiés (compté, jamais importé). */
  let brouillonsChariow = 0;
  /** La source de cet aperçu est-elle Chariow (pour les champs qui lui sont propres) ? */
  const plateformeChariow = verdict.platform === 'chariow';

  // `public-json` n'est vrai que pour Shopify et WooCommerce ; on le dit au
  // type plutôt que de caster, pour qu'un futur ajout de plateforme casse ici
  // au lieu de produire un catalogue lu avec le mauvais exposant de prix.
  const plateformePublique = verdict.access === 'public-json'
    && (verdict.platform === 'shopify' || verdict.platform === 'woocommerce')
    ? verdict.platform
    : null;

  if (plateformePublique) {
    const catalogue = await fetchPublicCatalog(plateformePublique, racine, {
      resolveHost: deps.resolveHost,
      fetchImpl: pinnedFetchLike(deps, { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES }),
    });
    if (!catalogue.ok) {
      throw new StoreImportError('CATALOG_UNAVAILABLE', catalogue.error.message, 502);
    }
    endpoint = catalogue.value.endpoint;
    const normalise = normalizeCatalog(catalogue.value, plateformePublique, DEFAULT_CURRENCY);
    if (normalise.produits.length === 0) {
      throw new StoreImportError(
        'CATALOG_EMPTY',
        'Le catalogue public ne contient aucun produit lisible. Vérifiez que la boutique publie ses produits.',
        422,
      );
    }
    produits.push(...normalise.produits);
    rejets = normalise.rejets;
  } else if (verdict.platform === 'prestashop') {
    /*
     * PrestaShop n'a pas de catalogue public : on passe par l'API Webservice,
     * avec la clé déposée dans Vault au moment de la connexion. Le navigateur
     * ne voit jamais cette clé.
     *
     * Sans connexion vérifiée, on ne tente rien : on dit quoi faire. Sortir un
     * « catalogue vide » ici ferait croire à une boutique sans produits.
     */
    if (typeof dependencies.readStoreCredential !== 'function') {
      throw new StoreImportError(
        'CONNECTOR_UNAVAILABLE',
        'Le connecteur PrestaShop n’est pas disponible sur cette installation.',
        503,
      );
    }
    const cle = await dependencies.readStoreCredential(contexte.userId, 'prestashop');
    if (!cle) {
      throw new StoreImportError(
        'CONNECTION_REQUIRED',
        'Connectez votre boutique PrestaShop (URL et clé Webservice) avant de lancer l’aperçu.',
        409,
      );
    }
    const lecture = await readPrestashopCatalog(
      { root: racine, basePath: '/api' },
      { apiKey: cle },
      { fetchImpl: pinnedFetchLike(deps, { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES }) },
      { defaultCurrency: DEFAULT_CURRENCY },
    );
    if (!lecture.ok) {
      /*
       * Le message vient du connecteur : il ne contient jamais la clé.
       *
       * `forbidden` compte comme un refus de connexion, pas comme une panne :
       * une clé valide mais sans droits de lecture sur `products` est un
       * problème de connexion que le marchand peut corriger (droits de la clé),
       * et lui répondre 502 lui ferait chercher la panne du mauvais côté.
       */
      const refus = lecture.error.code === 'auth_invalid' || lecture.error.code === 'forbidden';
      throw new StoreImportError(
        refus ? 'STORE_CONNECTION_REFUSED' : 'CATALOG_UNAVAILABLE',
        lecture.error.message,
        refus ? 401 : 502,
      );
    }
    if (lecture.value.products.length === 0) {
      throw new StoreImportError(
        'CATALOG_EMPTY',
        'L’API PrestaShop ne renvoie aucun produit actif pour cette boutique.',
        422,
      );
    }
    endpoint = lecture.value.endpoint;
    // Même normalisation que Shopify/Woo : le connecteur ne fait que PRODUIRE
    // la forme brute commune. Prix, devise, stock et identifiants passent donc
    // par exactement le même code, puis par le même rapprochement.
    const normalise = normalizeCatalog(
      {
        platform: 'prestashop',
        endpoint: lecture.value.endpoint,
        products: lecture.value.products,
        currency: lecture.value.currency,
      },
      'prestashop',
      DEFAULT_CURRENCY,
    );
    produits.push(...normalise.produits);
    rejets = [...lecture.value.rejected, ...normalise.rejets];
  } else if (verdict.platform === 'chariow') {
    /*
     * Chariow : aucun catalogue public. Le catalogue n'est lisible que par
     * `GET https://api.chariow.com/v1/products`, avec la clé déposée dans Vault
     * au moment de la connexion. Le navigateur ne la voit jamais.
     *
     * L'hôte interrogé est FIXE (`api.chariow.com`), il ne dépend pas de l'URL
     * reçue : la boutique saisie sert uniquement à identifier la plateforme et
     * à construire les liens produits. Il n'y a donc pas d'adresse arbitraire à
     * épingler ici — la sortie réseau reste celle de l'import commun, qui
     * revalide la résolution de l'hôte API à chaque appel.
     */
    if (typeof dependencies.readStoreCredential !== 'function') {
      throw new StoreImportError(
        'CONNECTOR_UNAVAILABLE',
        'Le connecteur Chariow n’est pas disponible sur cette installation.',
        503,
      );
    }
    const cle = await dependencies.readStoreCredential(contexte.userId, 'chariow');
    if (!cle) {
      throw new StoreImportError(
        'CONNECTION_REQUIRED',
        'Connectez votre boutique Chariow (clé API dans Settings → API Keys) avant de lancer l’aperçu.',
        409,
      );
    }
    const lecture = await readChariowCatalog(
      { apiKey: cle },
      { fetchImpl: pinnedFetchLike(deps, { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES }) },
      { defaultCurrency: DEFAULT_CURRENCY },
    );
    if (!lecture.ok) {
      // 401 (clé révoquée) et 403 (scope manquant) sont des problèmes de
      // CONNEXION que le marchand peut corriger : les traiter comme une panne
      // d'import l'enverrait chercher au mauvais endroit.
      const refusConnexion = lecture.error.code === 'auth_invalid'
        || lecture.error.code === 'insufficient_scope'
        || lecture.error.code === 'forbidden';
      throw new StoreImportError(
        refusConnexion ? 'STORE_CONNECTION_REFUSED' : 'CATALOG_UNAVAILABLE',
        explainChariowError(lecture.error),
        refusConnexion ? 401 : 502,
      );
    }
    const catalogue = lecture.value;
    if (catalogue.products.length === 0) {
      /*
       * Message précis : « aucun produit publié » n'est PAS « aucun produit ».
       * Une boutique dont tous les articles sont en brouillon produirait sinon
       * un « catalogue vide » incompréhensible pour le marchand, qui voit bien
       * ses produits dans son tableau de bord Chariow.
       */
      const brouillons = catalogue.draftsSkipped;
      throw new StoreImportError(
        'CATALOG_EMPTY',
        brouillons > 0
          ? `Aucun produit publié chez Chariow : ${brouillons} produit(s) sont en brouillon ou suspendus. Publiez-les dans Chariow, puis relancez l’aperçu.`
          : 'L’API Chariow ne renvoie aucun produit pour cette boutique.',
        422,
      );
    }
    endpoint = catalogue.endpoint;
    // Même normalisation que Shopify, Woo et PrestaShop : le connecteur ne fait
    // que PRODUIRE la forme brute commune.
    const bruts = catalogue.products.map((produit) =>
      toChariowRawProduct(produit, catalogue.store.url, catalogue.currency ?? DEFAULT_CURRENCY)
    );
    const normalise = normalizeCatalog(
      {
        platform: 'chariow',
        endpoint: catalogue.endpoint,
        products: bruts,
        currency: catalogue.currency,
      },
      'chariow',
      DEFAULT_CURRENCY,
    );
    produits.push(...normalise.produits);
    rejets = [...catalogue.rejected, ...normalise.rejets];
    // Les brouillons écartés sont DITS à l'écran, pas seulement dans un journal.
    brouillonsChariow = catalogue.draftsSkipped;
  } else {
    throw new StoreImportError(
      'NO_PUBLIC_CATALOG',
      `Plateforme identifiée (${verdict.platform}) sans catalogue public normalisé. Importez un export CSV, XLSX ou XML, ou connectez la boutique par son API officielle.`,
      422,
    );
  }

  // 4) Rapprochement : lecture seule du catalogue existant, aucune écriture.
  const existants = await dependencies.listExistingProducts(contexte.workspaceId);
  const rapprochements = rapprocher(produits, existants);

  const lignes = produits.map((produit, index) => {
    const decision = decisionApercu(rapprochements[index], existants);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      sku: produit.sku ?? null,
      platformId: produit.platformId ?? null,
      warnings: produit.warnings,
      duplicate: decision.duplicate,
      match: decision.match,
      matchReason: decision.matchReason,
      candidates: decision.candidates,
      targetId: decision.targetId,
      // Une ligne ambiguë n'est pas importable : rien n'est fusionné tant que
      // l'utilisateur n'a pas tranché. Un doublon interne non plus.
      importable: isImportable(produit)
        && decision.match !== 'ambiguous'
        && decision.match !== 'duplicate-in-batch',
      // Une place de marché ne décrit pas ses déclinaisons de la même façon
      // qu'un fichier : on n'en invente pas ici.
      variants: (produit.variants ?? []).map((variante) => ({
        name: variante.name,
        // Le prix d'une variante est formaté avec SA devise, qui retombe sur
        // celle du parent quand elle est absente.
        price: formatPreviewPrice({
          priceMinor: variante.priceMinor,
          currency: (variante.currency ?? produit.currency),
        } as NormalizedProduct),
        currency: variante.currency ?? produit.currency,
        sku: variante.sku,
        stock: variante.stock ?? null,
        attributeName: variante.attributeName ?? null,
      })),
      // Provenance de la fiche : `platformId` est l'identifiant STABLE chez la
      // source (`prd_…` Chariow). Il est renvoyé pour que l'écran puisse
      // expliquer pourquoi un produit sera mis à jour plutôt que dupliqué.
      platform: produit.source.platform,
    };
  });

  /*
   * Brouillons Chariow : remontés à l'écran, pas seulement dans un journal.
   *
   * Un marchand qui voit « 3 produits » alors que sa boutique en contient 8
   * conclurait à une panne d'import. Le décompte explicite fait la différence
   * entre une limite de l'API et une perte de données.
   */
  const brouillonsEcartes = plateformeChariow ? brouillonsChariow : 0;

  const importables = lignes.filter((l) => l.importable).length;
  const origin: ImportBatch['origin'] = {
    kind: 'url',
    reference: sonde.value.finalUrl,
    platform: verdict.platform,
    endpoint,
  };

  const warnings = [
    'Aucun produit n’a été créé : cette étape est une prévisualisation.',
    ...(lignes.some((l) => l.duplicate === 'existing')
      ? ['Des produits portent un nom déjà présent dans votre catalogue : ils seront créés en plus si vous confirmez.']
      : []),
    ...(lignes.some((l) => l.duplicate === 'in-batch')
      ? ['Des doublons internes au catalogue source sont ignorés : aucun produit n’est écrit deux fois.']
      : []),
    ...(rejets.length ? [`${rejets.length} produit(s) du catalogue source n’ont pas pu être normalisés.`] : []),
    ...(brouillonsChariow > 0
      ? [`${brouillonsChariow} produit(s) Chariow non publié(s) (brouillon ou suspendu) ont été écartés : seuls les produits publiés sont importés.`]
      : []),
  ];

  const previewId = crypto.randomUUID();
  const expire = new Date(contexte.now() + contexte.ttl).toISOString();

  const data: PreviewPayload = {
    previewId,
    expiresAt: expire,
    origin,
    summary: {
      total: lignes.length,
      importable: importables,
      duplicateInBatch: lignes.filter((l) => l.duplicate === 'in-batch').length,
      duplicateExisting: lignes.filter((l) => l.duplicate === 'existing').length,
      withWarnings: lignes.filter((l) => l.warnings.length > 0).length,
      priced: produits.filter((p) => p.priceMinor !== null).length,
      unpriced: produits.filter((p) => p.priceMinor === null).length,
    },
    products: lignes,
    rejected: rejets,
    warnings,
    connectedTo,
    ...(brouillonsEcartes > 0 ? { draftsSkipped: brouillonsEcartes } : {}),
  };

  return {
    data,
    record: {
      userId: contexte.userId,
      workspaceId: contexte.workspaceId,
      createdAt: contexte.now(),
      kind: 'url',
      products: produits,
      // Décisions figées avec l'aperçu : la confirmation applique exactement ce
      // qui a été montré.
      matches: lignes.map((ligne) => ({ match: ligne.match, targetId: ligne.targetId })),
      origin,
    },
  };
}

/**
 * Aperçu pour un connecteur dont l'API est **hébergée chez l'éditeur**.
 *
 * ## Pourquoi une fonction séparée de `faireApercu`
 * `faireApercu` commence par sonder une page HTML de boutique : il lui faut une
 * URL, un résolveur et un épinglage. Chariow n'a rien de tout cela — l'hôte de
 * l'API est constant (`api.chariow.com`) et le catalogue vient d'une clé. Passer
 * par le chemin « URL » obligerait à inventer une adresse, et ferait croire au
 * serveur qu'il contacte la boutique.
 *
 * Ce qui est **partagé** et non dupliqué : la sortie réseau épinglée, le
 * normaliseur (`normalizeCatalog`), le rapprochement (`matchBatch`), la
 * construction de l'aperçu, la sélection, la confirmation, la reprise et
 * l'historique. Cette fonction ne fait que produire `produits` et `endpoint` ;
 * tout le reste est le code commun.
 */

/* --------------------- Shopify et WooCommerce (phase E) -------------------- */
/*
 * Ces deux-là sont des connecteurs AUTHENTIFIÉS : contrairement au catalogue
 * public, ils lisent l'API d'administration avec les identifiants du marchand.
 * Tout le reste est commun — normalisation, rapprochement, dédoublonnage,
 * aperçu, confirmation, reprise, historique — et c'est précisément l'intérêt :
 * un produit Shopify et un produit PrestaShop produisent la même fiche.
 *
 * ## L'adresse vient du secret, pas de la requête
 *
 * Le domaine (Shopify) ou l'URL du site (WooCommerce) a été validé à la
 * connexion, puis rangé dans Vault avec les clés. L'aperçu le relit de là : le
 * navigateur ne peut donc pas faire contacter une adresse arbitraire par un
 * simple champ de formulaire. La garde SSRF s'applique quand même à chaque
 * import, puisque la sortie épinglée revalide la résolution.
 */

/** Découpe le secret Shopify : première ligne = domaine, seconde = jeton. */
export function splitShopifySecret(brut: string): { domain: string; token: string } | null {
  const lignes = brut.split('\n');
  if (lignes.length < 2) return null;
  const domain = lignes[0].trim();
  const token = lignes[1].trim();
  if (!domain || !token) return null;
  return { domain, token };
}

/** Découpe le secret WooCommerce : clé, secret, site. */
export function splitWooSecret(brut: string): { key: string; secret: string; siteUrl: string } | null {
  const lignes = brut.split('\n');
  if (lignes.length < 3) return null;
  const [key, secret, siteUrl] = lignes.map((l) => l.trim());
  if (!key || !secret || !siteUrl) return null;
  return { key, secret, siteUrl };
}

async function faireApercuShopify(
  dependencies: StoreImportDependencies,
  contexte: { userId: string; workspaceId: string; connectorKey: string; now: () => number; ttl: number },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  if (typeof dependencies.readStoreCredential !== 'function') {
    throw new StoreImportError(
      'CONNECTOR_UNAVAILABLE',
      'Le connecteur Shopify n’est pas disponible sur cette installation.',
      503,
    );
  }
  const brut = await dependencies.readStoreCredential(contexte.userId, 'shopify');
  const secret = brut ? splitShopifySecret(brut) : null;
  if (!secret) {
    throw new StoreImportError(
      'CONNECTION_REQUIRED',
      'Connectez votre boutique Shopify (domaine et jeton d’API Admin) avant de lancer l’aperçu.',
      409,
    );
  }

  if (!dependencies.resolveHost) {
    // Sans résolveur, la sortie épinglée ne peut pas vérifier l'IP : on refuse
    // plutôt que de laisser `fetch` résoudre seul (ce serait rouvrir le SSRF).
    throw new StoreImportError(
      'RESOLVER_UNAVAILABLE',
      'La vérification DNS serveur n’est pas disponible : import refusé par sécurité.',
      503,
    );
  }

  let connectedTo = '';
  const lecture = await readShopifyCatalog(
    { shopDomain: secret.domain, accessToken: secret.token },
    {
      fetchImpl: pinnedFetchLike(
        { resolveHost: dependencies.resolveHost, connect: dependencies.connect, onConnected: (ip) => { connectedTo = ip; } },
        { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES },
      ),
    },
  );

  if (!lecture.ok) {
    const refus = lecture.error.code === 'auth_invalid' || lecture.error.code === 'insufficient_scope';
    throw new StoreImportError(
      refus ? 'STORE_CONNECTION_REFUSED' : 'CATALOG_UNAVAILABLE',
      lecture.error.message,
      refus ? 401 : 502,
    );
  }

  const catalogue = lecture.value;
  if (catalogue.products.length === 0) {
    throw new StoreImportError(
      'CATALOG_EMPTY',
      catalogue.unpublishedSkipped > 0
        ? `Aucun produit publié chez Shopify : ${catalogue.unpublishedSkipped} produit(s) sont en brouillon ou archivés. `
          + 'Publiez-les dans Shopify, puis relancez l’aperçu.'
        : 'L’API Shopify ne renvoie aucun produit pour cette boutique.',
      422,
    );
  }

  const projection = toShopifyRawProducts(catalogue);
  const normalise = normalizeCatalog(
    {
      platform: 'shopify',
      endpoint: catalogue.endpoint,
      products: projection.produits,
      currency: catalogue.currency,
    },
    'shopify',
    DEFAULT_CURRENCY,
  );

  if (normalise.produits.length === 0) {
    throw new StoreImportError(
      'CATALOG_EMPTY',
      'Les produits Shopify lus n’ont pas pu être normalisés.',
      422,
    );
  }

  return await assemblerApercuConnecteur(dependencies, {
    ...contexte,
    produits: normalise.produits,
    rejets: [...projection.rejets, ...normalise.rejets],
    endpoint: catalogue.endpoint,
    platform: 'shopify',
    reference: catalogue.domain,
    connectedTo,
    warningsSupplementaires: [
      ...(catalogue.unpublishedSkipped > 0
        ? [`${catalogue.unpublishedSkipped} produit(s) Shopify non publié(s) (brouillon ou archivé) ont été écartés.`]
        : []),
      ...(catalogue.truncated
        ? ['Le catalogue dépasse la limite de lecture : une partie des produits n’a pas été récupérée.']
        : []),
      ...(catalogue.variantsSeen > projection.variantes
        ? [`${catalogue.variantsSeen - projection.variantes} variante(s) n’ont pas pu être rattachées à leur produit.`]
        : []),
    ],
  });
}

async function faireApercuWooCommerce(
  dependencies: StoreImportDependencies,
  contexte: { userId: string; workspaceId: string; connectorKey: string; now: () => number; ttl: number },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  if (typeof dependencies.readStoreCredential !== 'function') {
    throw new StoreImportError(
      'CONNECTOR_UNAVAILABLE',
      'Le connecteur WooCommerce n’est pas disponible sur cette installation.',
      503,
    );
  }
  const brut = await dependencies.readStoreCredential(contexte.userId, 'woocommerce');
  const secret = brut ? splitWooSecret(brut) : null;
  if (!secret) {
    throw new StoreImportError(
      'CONNECTION_REQUIRED',
      'Connectez votre site WooCommerce (clés API REST) avant de lancer l’aperçu.',
      409,
    );
  }

  if (!dependencies.resolveHost) {
    throw new StoreImportError(
      'RESOLVER_UNAVAILABLE',
      'La vérification DNS serveur n’est pas disponible : import refusé par sécurité.',
      503,
    );
  }

  let connectedTo = '';
  const lecture = await readWooCatalog(
    { siteUrl: secret.siteUrl, consumerKey: secret.key, consumerSecret: secret.secret },
    {
      fetchImpl: pinnedFetchLike(
        { resolveHost: dependencies.resolveHost, connect: dependencies.connect, onConnected: (ip) => { connectedTo = ip; } },
        { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES },
      ),
    },
  );

  if (!lecture.ok) {
    const refus = lecture.error.code === 'auth_invalid' || lecture.error.code === 'rest_disabled';
    throw new StoreImportError(
      refus ? 'STORE_CONNECTION_REFUSED' : 'CATALOG_UNAVAILABLE',
      lecture.error.message,
      refus ? 401 : 502,
    );
  }

  const catalogue = lecture.value;
  if (catalogue.products.length === 0) {
    throw new StoreImportError('CATALOG_EMPTY', 'L’API WooCommerce ne renvoie aucun produit publié.', 422);
  }

  const projection = toWooRawProducts(catalogue);
  const normalise = normalizeCatalog(
    {
      platform: 'woocommerce',
      endpoint: catalogue.endpoint,
      products: projection.produits,
      currency: catalogue.currency,
    },
    'woocommerce',
    DEFAULT_CURRENCY,
  );

  if (normalise.produits.length === 0) {
    throw new StoreImportError('CATALOG_EMPTY', 'Les produits WooCommerce lus n’ont pas pu être normalisés.', 422);
  }

  return await assemblerApercuConnecteur(dependencies, {
    ...contexte,
    produits: normalise.produits,
    rejets: [...projection.rejets, ...normalise.rejets],
    endpoint: catalogue.endpoint,
    platform: 'woocommerce',
    reference: catalogue.siteUrl,
    connectedTo,
    warningsSupplementaires: [
      ...(catalogue.truncated
        ? ['Le catalogue dépasse la limite de lecture : une partie des produits n’a pas été récupérée.']
        : []),
      ...(projection.variablesSansVariations.length > 0
        ? [
          `${projection.variablesSansVariations.length} produit(s) à variations n’ont pas pu être lus avec leurs `
          + `déclinaisons (${projection.variablesSansVariations.slice(0, 3).join(', ')}${projection.variablesSansVariations.length > 3 ? '…' : ''}) : `
          + 'ils seront importés au prix affiché, sans déclinaison.',
        ]
        : []),
    ],
  });
}

/**
 * Assemble un aperçu à partir de produits DÉJÀ normalisés.
 *
 * Mutualisé entre Shopify et WooCommerce pour qu'ils héritent exactement du
 * même rapprochement, du même calcul d'importabilité et des mêmes décisions
 * figées. Une copie aurait fini par diverger, et c'est le genre d'écart qui
 * produit des doublons.
 */
async function assemblerApercuConnecteur(
  dependencies: StoreImportDependencies,
  contexte: {
    userId: string;
    workspaceId: string;
    now: () => number;
    ttl: number;
    produits: NormalizedProduct[];
    rejets: Array<{ line: number; reason: string }>;
    endpoint: string;
    /** Plateforme d'origine, au type du catalogue : aucune valeur libre. */
    platform: StorePlatform;
    reference: string;
    connectedTo: string;
    warningsSupplementaires: string[];
  },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  const { produits, rejets } = contexte;

  const existants = await dependencies.listExistingProducts(contexte.workspaceId);
  const rapprochements = rapprocher(produits, existants);

  const lignes = produits.map((produit, index) => {
    const decision = decisionApercu(rapprochements[index], existants);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      sku: produit.sku ?? null,
      platformId: produit.platformId ?? null,
      warnings: produit.warnings,
      duplicate: decision.duplicate,
      match: decision.match,
      matchReason: decision.matchReason,
      candidates: decision.candidates,
      targetId: decision.targetId,
      importable: isImportable(produit)
        && decision.match !== 'ambiguous'
        && decision.match !== 'duplicate-in-batch',
      variants: [],
      platform: contexte.platform,
    };
  });

  const importables = lignes.filter((l) => l.importable).length;
  const origin: ImportBatch['origin'] = {
    kind: 'url',
    reference: contexte.reference,
    platform: contexte.platform,
    endpoint: contexte.endpoint,
  };

  const warnings = [
    'Aucun produit n’a été créé : cette étape est une prévisualisation.',
    ...contexte.warningsSupplementaires,
    ...(lignes.some((l) => l.warnings.length > 0)
      ? ['Certains produits portent un avertissement (prix absent, variantes incomplètes) : lisez-le avant de confirmer.']
      : []),
    ...(rejets.length ? [`${rejets.length} produit(s) du catalogue source n’ont pas pu être normalisés.`] : []),
  ];

  const data: PreviewPayload = {
    previewId: crypto.randomUUID(),
    expiresAt: new Date(contexte.now() + contexte.ttl).toISOString(),
    origin,
    summary: {
      total: lignes.length,
      importable: importables,
      duplicateInBatch: lignes.filter((l) => l.duplicate === 'in-batch').length,
      duplicateExisting: lignes.filter((l) => l.duplicate === 'existing').length,
      withWarnings: lignes.filter((l) => l.warnings.length > 0).length,
      priced: produits.filter((p) => p.priceMinor !== null).length,
      unpriced: produits.filter((p) => p.priceMinor === null).length,
    },
    products: lignes,
    rejected: rejets,
    warnings,
    connectedTo: contexte.connectedTo,
  };

  return {
    data,
    record: {
      userId: contexte.userId,
      workspaceId: contexte.workspaceId,
      createdAt: contexte.now(),
      kind: 'url',
      products: produits,
      // Décisions figées avec l'aperçu : la confirmation applique exactement ce
      // qui a été montré, même si le catalogue change entre-temps.
      matches: lignes.map((ligne) => ({ match: ligne.match, targetId: ligne.targetId })),
      origin,
    },
  };
}

async function faireApercuConnecteur(
  dependencies: StoreImportDependencies,
  contexte: {
    userId: string;
    workspaceId: string;
    connectorKey: string;
    now: () => number;
    ttl: number;
  },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  const connecteursConnus = ['chariow', 'prestashop', 'shopify', 'woocommerce', 'custom-api'];
  if (!connecteursConnus.includes(contexte.connectorKey)) {
    // Un identifiant inconnu ne doit pas retomber silencieusement sur un autre
    // connecteur : on refuse explicitement.
    throw new StoreImportError('UNKNOWN_CONNECTOR', 'Connecteur inconnu pour l’aperçu.', 400);
  }

  // Shopify et WooCommerce ont leur propre lecture (API authentifiée) et
  // rejoignent l'assemblage commun : on délègue AVANT les contrôles Chariow,
  // qui exigeraient un résolveur et une clé propres à ce connecteur.
  if (contexte.connectorKey === 'shopify') {
    return await faireApercuShopify(dependencies, contexte);
  }
  if (contexte.connectorKey === 'woocommerce') {
    return await faireApercuWooCommerce(dependencies, contexte);
  }
  if (typeof dependencies.readStoreCredential !== 'function') {
    throw new StoreImportError(
      'CONNECTOR_UNAVAILABLE',
      'Le connecteur Chariow n’est pas disponible sur cette installation.',
      503,
    );
  }
  if (!dependencies.resolveHost) {
    // La sortie épinglée exige un résolveur : sans lui, l'import est refusé
    // plutôt que de laisser `fetch` résoudre seul (ce serait rouvrir le SSRF).
    throw new StoreImportError(
      'RESOLVER_UNAVAILABLE',
      'La vérification DNS serveur n’est pas disponible : import refusé par sécurité.',
      503,
    );
  }

  if (contexte.connectorKey === 'shopify') {
    return await faireApercuShopify(dependencies, contexte);
  }
  if (contexte.connectorKey === 'woocommerce') {
    return await faireApercuWooCommerce(dependencies, contexte);
  }

  const cle = await dependencies.readStoreCredential(contexte.userId, 'chariow');
  if (!cle) {
    throw new StoreImportError(
      'CONNECTION_REQUIRED',
      'Connectez votre boutique Chariow (clé API dans Settings → API Keys) avant de lancer l’aperçu.',
      409,
    );
  }

  let connectedTo = '';
  const deps: EgressDeps = {
    resolveHost: dependencies.resolveHost,
    connect: dependencies.connect,
    onConnected: (ip) => {
      connectedTo = ip;
    },
  };

  const lecture = await readChariowCatalog(
    { apiKey: cle },
    { fetchImpl: pinnedFetchLike(deps, { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES }) },
    { defaultCurrency: DEFAULT_CURRENCY },
  );
  if (!lecture.ok) {
    const refusConnexion = lecture.error.code === 'auth_invalid'
      || lecture.error.code === 'insufficient_scope'
      || lecture.error.code === 'forbidden';
    throw new StoreImportError(
      refusConnexion ? 'STORE_CONNECTION_REFUSED' : 'CATALOG_UNAVAILABLE',
      explainChariowError(lecture.error),
      refusConnexion ? 401 : 502,
    );
  }

  const catalogue = lecture.value;
  if (catalogue.products.length === 0) {
    const brouillons = catalogue.draftsSkipped;
    throw new StoreImportError(
      'CATALOG_EMPTY',
      brouillons > 0
        ? `Aucun produit publié chez Chariow : ${brouillons} produit(s) sont en brouillon ou suspendus. Publiez-les dans Chariow, puis relancez l’aperçu.`
        : 'L’API Chariow ne renvoie aucun produit pour cette boutique.',
      422,
    );
  }

  // Projection vers la forme brute commune, puis normalisation COMMUNE.
  const bruts = catalogue.products.map((produit) =>
    toChariowRawProduct(produit, catalogue.store.url, catalogue.currency ?? DEFAULT_CURRENCY)
  );
  const normalise = normalizeCatalog(
    {
      platform: 'chariow',
      endpoint: catalogue.endpoint,
      products: bruts,
      currency: catalogue.currency,
    },
    'chariow',
    DEFAULT_CURRENCY,
  );
  const produits = normalise.produits;
  const rejets = [...catalogue.rejected, ...normalise.rejets];
  if (produits.length === 0) {
    throw new StoreImportError(
      'CATALOG_EMPTY',
      'Les produits Chariow lus n’ont pas pu être normalisés.',
      422,
    );
  }

  // Rapprochement : lecture seule du catalogue existant, aucune écriture.
  const existants = await dependencies.listExistingProducts(contexte.workspaceId);
  const rapprochements = rapprocher(produits, existants);

  const lignes = produits.map((produit, index) => {
    const decision = decisionApercu(rapprochements[index], existants);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      sku: produit.sku ?? null,
      platformId: produit.platformId ?? null,
      warnings: produit.warnings,
      duplicate: decision.duplicate,
      match: decision.match,
      matchReason: decision.matchReason,
      candidates: decision.candidates,
      targetId: decision.targetId,
      importable: isImportable(produit)
        && decision.match !== 'ambiguous'
        && decision.match !== 'duplicate-in-batch',
      variants: [],
      platform: 'chariow',
    };
  });

  const importables = lignes.filter((l) => l.importable).length;
  const origin: ImportBatch['origin'] = {
    kind: 'url',
    reference: catalogue.store.url ?? 'https://api.chariow.com',
    platform: 'chariow',
    endpoint: catalogue.endpoint,
  };

  const warnings = [
    'Aucun produit n’a été créé : cette étape est une prévisualisation.',
    ...(catalogue.draftsSkipped > 0
      ? [`${catalogue.draftsSkipped} produit(s) Chariow non publié(s) (brouillon ou suspendu) ont été écartés : seuls les produits publiés sont importés.`]
      : []),
    ...(catalogue.truncated
      ? ['Le catalogue dépasse la limite de lecture : une partie des produits n’a pas été récupérée.']
      : []),
    ...(lignes.some((l) => l.warnings.length > 0)
      ? ['Certains produits portent un avertissement (variantes non exposées par l’API, prix absent) : lisez-le avant de confirmer.']
      : []),
    ...(rejets.length ? [`${rejets.length} produit(s) du catalogue source n’ont pas pu être normalisés.`] : []),
  ];

  const previewId = crypto.randomUUID();
  const expire = new Date(contexte.now() + contexte.ttl).toISOString();

  const data: PreviewPayload = {
    previewId,
    expiresAt: expire,
    origin,
    summary: {
      total: lignes.length,
      importable: importables,
      duplicateInBatch: lignes.filter((l) => l.duplicate === 'in-batch').length,
      duplicateExisting: lignes.filter((l) => l.duplicate === 'existing').length,
      withWarnings: lignes.filter((l) => l.warnings.length > 0).length,
      priced: produits.filter((p) => p.priceMinor !== null).length,
      unpriced: produits.filter((p) => p.priceMinor === null).length,
    },
    products: lignes,
    rejected: rejets,
    warnings,
    connectedTo,
    ...(catalogue.draftsSkipped > 0 ? { draftsSkipped: catalogue.draftsSkipped } : {}),
  };

  return {
    data,
    record: {
      userId: contexte.userId,
      workspaceId: contexte.workspaceId,
      createdAt: contexte.now(),
      kind: 'url',
      products: produits,
      // Décisions figées avec l'aperçu : la confirmation applique exactement ce
      // qui a été montré, même si le catalogue change entre-temps.
      matches: lignes.map((ligne) => ({ match: ligne.match, targetId: ligne.targetId })),
      origin,
    },
  };
}

/**
 * Construit l'aperçu d'un FICHIER (CSV/TSV/XML/XLSX).
 *
 * ## Aucune sortie réseau
 * Contrairement à l'aperçu par URL, rien n'est téléchargé : le contenu est déjà
 * dans la requête. Il n'y a donc ni résolveur, ni épinglage d'IP, ni risque
 * SSRF. Les protections qui comptent ici sont la taille, le type réel du
 * contenu et la neutralisation des formules.
 *
 * ## Ce que cette fonction ne fait PAS
 * Elle n'écrit rien. Elle lit le catalogue existant en lecture seule, pour
 * signaler les doublons, et rend un aperçu que `import` devra confirmer.
 */
async function faireApercuFichier(
  dependencies: StoreImportDependencies,
  contexte: {
    userId: string; workspaceId: string; base64: string; nom: string;
    now: () => number; ttl: number;
  },
): Promise<{ data: PreviewPayload; record: PreviewRecord }> {
  if (typeof dependencies.parseFile !== 'function') {
    // Fail-closed : sans analyseur, aucun fichier n'est accepté.
    throw new StoreImportError(
      'FILE_PARSER_UNAVAILABLE',
      'L’analyse de fichier n’est pas disponible : import refusé par sécurité.',
      503,
    );
  }

  // 1) Taille, AVANT tout décodage : un corps énorme ne doit pas être
  //    matérialisé pour être ensuite refusé.
  if (contexte.base64.length > MAX_FILE_BASE64_CHARS) {
    throw new StoreImportError(
      'FILE_TOO_LARGE',
      'Fichier trop volumineux (limite 8 Mio).',
      413,
    );
  }

  // 2) Décodage strict. `atob` est permissif : il ignore les caractères hors
  //    alphabet, donc un contenu non base64 passerait en silence. On valide
  //    d'abord la forme, sinon le « fichier » analysé n'est pas celui reçu.
  const propre = contexte.base64.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(propre) || propre.length % 4 !== 0) {
    throw new StoreImportError('INVALID_FILE_ENCODING', 'Contenu de fichier illisible.', 400);
  }
  let octets: Uint8Array;
  try {
    const binaire = atob(propre);
    octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
  } catch {
    throw new StoreImportError('INVALID_FILE_ENCODING', 'Contenu de fichier illisible.', 400);
  }
  if (octets.byteLength === 0) {
    throw new StoreImportError('EMPTY_FILE', 'Le fichier est vide.', 400);
  }

  // 3) Analyse. Le module partagé borne la taille, vérifie la signature réelle
  //    (pas l'extension) et neutralise les formules de tableur.
  const nom = contexte.nom || 'import.csv';
  const resultat = await dependencies.parseFile(octets, nom);
  if (!resultat.ok) {
    throw new StoreImportError(
      'FILE_UNREADABLE',
      resultat.errors.slice(0, 3).join(' ') || 'Le fichier n’a pas pu être lu.',
      422,
    );
  }
  if (resultat.products.length === 0) {
    throw new StoreImportError('FILE_EMPTY_CATALOG', 'Aucun produit valide dans le fichier.', 422);
  }

  // 4) Aperçu identique au chemin URL : mêmes règles de doublon, même forme de
  //    réponse, pour que l'interface n'ait qu'un seul affichage à gérer.
  const produits = resultat.products;
  const existants = await dependencies.listExistingProducts(contexte.workspaceId);
  const rapprochements = rapprocher(produits, existants);

  const lignes = produits.map((produit, index) => {
    const decision = decisionApercu(rapprochements[index], existants);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      sku: produit.sku ?? null,
      platformId: produit.platformId ?? null,
      warnings: produit.warnings,
      duplicate: decision.duplicate,
      match: decision.match,
      matchReason: decision.matchReason,
      candidates: decision.candidates,
      targetId: decision.targetId,
      importable: isImportable(produit)
        && decision.match !== 'ambiguous'
        && decision.match !== 'duplicate-in-batch',
      // Variantes du FICHIER : ce sont elles qu'on persiste. Le chemin URL
      // n'en expose pas (une place de marché ne les fournit pas de la même
      // façon) ; un tableau vide y est donc la réponse juste, pas un oubli.
      variants: (produit.variants ?? []).map((variante) => ({
        name: variante.name,
        price: formatPreviewPrice({
          priceMinor: variante.priceMinor,
          currency: variante.currency ?? produit.currency,
        } as NormalizedProduct),
        currency: variante.currency ?? produit.currency,
        sku: variante.sku,
        stock: variante.stock ?? null,
        attributeName: variante.attributeName ?? null,
      })),
    };
  });

  const origin: ImportBatch['origin'] = {
    kind: 'file',
    reference: nom,
    // Un fichier n'a pas de plateforme : `kind: 'file'` porte cette information,
    // et `platform` reste 'unknown' plutôt qu'une valeur inventée.
    platform: 'unknown',
    endpoint: resultat.format,
  };

  const warnings = [
    'Aucun produit n’a été créé : cette étape est une prévisualisation.',
    ...resultat.warnings.slice(0, 8),
    ...(lignes.some((l) => l.duplicate === 'existing')
      ? ['Des produits portent un nom déjà présent dans votre catalogue : ils seront créés en plus si vous confirmez.']
      : []),
    ...(lignes.some((l) => l.duplicate === 'in-batch')
      ? ['Des doublons internes au fichier sont ignorés : aucun produit n’est écrit deux fois.']
      : []),
  ];

  const previewId = crypto.randomUUID();
  // Même horloge que le stockage : l'échéance affichée est celle qui décidera
  // réellement de la validité, y compris quand les tests avancent l'heure.
  const expire = new Date(contexte.now() + contexte.ttl).toISOString();

  const data: PreviewPayload = {
    previewId,
    expiresAt: expire,
    origin,
    summary: {
      total: lignes.length,
      importable: lignes.filter((l) => l.importable).length,
      duplicateInBatch: lignes.filter((l) => l.duplicate === 'in-batch').length,
      duplicateExisting: lignes.filter((l) => l.duplicate === 'existing').length,
      withWarnings: lignes.filter((l) => l.warnings.length > 0).length,
      priced: produits.filter((p) => p.priceMinor !== null).length,
      unpriced: produits.filter((p) => p.priceMinor === null).length,
    },
    products: lignes,
    rejected: [],
    warnings,
    // Aucune connexion réseau : le champ reste vide plutôt que de laisser
    // croire à une lecture distante.
    connectedTo: '',
  };

  return {
    data,
    record: {
      userId: contexte.userId,
      workspaceId: contexte.workspaceId,
      // `contexte.now()` et non `Date.now()` : l'horloge injectée est celle
      // qui décide de l'expiration. Mélanger les deux faisait diverger
      // l'échéance affichée et l'échéance appliquée dès qu'un test avançait
      // l'heure.
      createdAt: contexte.now(),
      kind: 'file',
      products: produits,
      matches: lignes.map((ligne) => ({ match: ligne.match ?? 'create', targetId: ligne.targetId ?? null })),
      origin,
    },
  };
}

/**
 * Résolveur DNS Deno. `A` et `AAAA` sont tous deux demandés : refuser seulement
 * l'IPv6 laisserait un contournement par enregistrement AAAA.
 */
export function denoResolveHost(): (hostname: string) => Promise<string[]> {
  return async (hostname: string) => {
    const deno = (globalThis as unknown as {
      Deno?: { resolveDns?: (name: string, type: 'A' | 'AAAA' | 'CNAME') => Promise<string[]> };
    }).Deno;
    if (!deno?.resolveDns) {
      // Fail-closed : sans résolveur, pas d'import.
      throw new Error('Deno.resolveDns indisponible');
    }
    const [a, aaaa] = await Promise.all([
      deno.resolveDns(hostname, 'A').catch(() => [] as string[]),
      deno.resolveDns(hostname, 'AAAA').catch(() => [] as string[]),
    ]);
    return [...a, ...aaaa];
  };
}
