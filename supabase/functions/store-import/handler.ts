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
import {
  formatPreviewPrice,
  isImportable,
  normalizeCatalog,
  type ImportBatch,
} from '../../../src/business/importer/pipeline.ts';
import { fetchPublicCatalog } from '../../../src/business/importer/sources.ts';
import { DEFAULT_CURRENCY, type NormalizedProduct } from '../../../src/business/importer/normalize.ts';
import type { FileParseResult } from '../../../src/business/importer/files.ts';
import { pinnedFetchLike, type EgressDeps } from './safe-egress.ts';
import { MAX_CATALOG_BYTES, MAX_HTML_BYTES } from '../../../src/business/importer/sources.ts';

/* ------------------------------- dépendances ------------------------------- */

/** Ligne de produit déjà présente, pour la détection de doublons. */
export interface ExistingProduct {
  id: string;
  name: string;
}

export interface WorkspaceGrant {
  /** L'utilisateur peut-il LIRE cette entreprise ? */
  canRead: boolean;
  /** L'utilisateur peut-il ÉCRIRE dans cette entreprise ? */
  canWrite: boolean;
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
   * Vérifie l'abonnement Business Ground de CET utilisateur.
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
     */
    options?: { updateExisting?: boolean },
  ): Promise<{
    created: number;
    /** Nombre de VARIANTES réellement écrites, pas seulement détectées. */
    variantsCreated?: number;
    /** Produits EXISTANTS mis à jour (mode mise à jour uniquement). */
    updated?: number;
    /** Variantes ajoutées à des produits existants (mode mise à jour). */
    variantsUpdated?: number;
    failed: Array<{ name: string; reason: string }>;
  }>;
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
  summary: ImportBatch['summary'];
  products: Array<{
    index: number;
    name: string;
    price: string;
    currency: string;
    productUrl: string | null;
    warnings: string[];
    duplicate: 'in-batch' | 'existing' | null;
    importable: boolean;
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

function allowedOrigin(origin: string | null, liste: string[]): boolean {
  if (!origin) return false;
  return liste.some((motif) => {
    if (motif === origin) return true;
    if (!motif.includes('*')) return false;
    // Motif simple : un seul `*` en tête de sous-domaine.
    const [prefixe, suffixe] = motif.split('*');
    return origin.startsWith(prefixe) && origin.endsWith(suffixe);
  });
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
            message: access?.message || 'Un abonnement Business Ground actif est requis.',
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
    if (action !== 'preview' && action !== 'import') {
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
          : await faireApercu(dependencies, { userId, workspaceId, url: text(body.url, 2048), now, ttl });
        await apercus.set(payload.data.previewId, {
          ...payload.record,
          kind: fichier ? 'file' : 'url',
          importables: payload.data.products.map((p) => p.importable),
        }, payload.record.createdAt + ttl);
        return jsonResponse({ data: payload.data }, 200, corsOrigin);
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

      // Un aperçu ne se rejoue pas : la confirmation le consomme.
      await apercus.delete(previewId);
      // Le mode est volontairement explicite : `true` seul l'active, tout le
      // reste retombe sur la création, comme avant.
      const mode = { updateExisting: body.updateExisting === true };
      const resultat = await dependencies.insertProducts(
        workspaceId, retenus, enregistrement.kind, mode,
      );

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
        data: { ...resultat, variantsCreated: resultat.variantsCreated ?? 0 },
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

  if (verdict.access === 'public-json') {
    const catalogue = await fetchPublicCatalog(verdict.platform, racine, {
      resolveHost: deps.resolveHost,
      fetchImpl: pinnedFetchLike(deps, { accept: 'application/json', maxBytes: MAX_CATALOG_BYTES }),
    });
    if (!catalogue.ok) {
      throw new StoreImportError('CATALOG_UNAVAILABLE', catalogue.error.message, 502);
    }
    endpoint = catalogue.value.endpoint;
    const normalise = normalizeCatalog(catalogue.value, verdict.platform as 'shopify' | 'woocommerce', DEFAULT_CURRENCY);
    if (normalise.produits.length === 0) {
      throw new StoreImportError(
        'CATALOG_EMPTY',
        'Le catalogue public ne contient aucun produit lisible. Vérifiez que la boutique publie ses produits.',
        422,
      );
    }
    produits.push(...normalise.produits);
    rejets = normalise.rejets;
  } else {
    throw new StoreImportError(
      'NO_PUBLIC_CATALOG',
      `Plateforme identifiée (${verdict.platform}) sans catalogue public normalisé. Importez un export CSV, XLSX ou XML, ou connectez la boutique par son API officielle.`,
      422,
    );
  }

  // 4) Doublons : lecture seule du catalogue existant, aucune écriture.
  const existants = await dependencies.listExistingProducts(contexte.workspaceId);
  const parNom = new Map(existants.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const vusDansLeLot = new Set<string>();

  const lignes = produits.map((produit, index) => {
    const cle = produit.name.trim().toLowerCase();
    let duplicate: 'in-batch' | 'existing' | null = null;
    if (parNom.has(cle)) duplicate = 'existing';
    else if (vusDansLeLot.has(cle)) duplicate = 'in-batch';
    vusDansLeLot.add(cle);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      warnings: produit.warnings,
      duplicate,
      importable: isImportable(produit) && duplicate !== 'in-batch',
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
    };
  });

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
  };

  return {
    data,
    record: {
      userId: contexte.userId,
      workspaceId: contexte.workspaceId,
      createdAt: contexte.now(),
      kind: 'url',
      products: produits,
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
  const parNom = new Map(existants.map((p) => [p.name.trim().toLowerCase(), p.id]));
  const vusDansLeLot = new Set<string>();

  const lignes = produits.map((produit, index) => {
    const cle = produit.name.trim().toLowerCase();
    let duplicate: 'in-batch' | 'existing' | null = null;
    if (parNom.has(cle)) duplicate = 'existing';
    else if (vusDansLeLot.has(cle)) duplicate = 'in-batch';
    vusDansLeLot.add(cle);
    return {
      index,
      name: produit.name,
      price: formatPreviewPrice(produit),
      currency: produit.currency,
      productUrl: produit.productUrl,
      warnings: produit.warnings,
      duplicate,
      importable: isImportable(produit) && duplicate !== 'in-batch',
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
