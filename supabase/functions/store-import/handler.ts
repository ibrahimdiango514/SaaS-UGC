/**
 * Edge Function `store-import` — import d'un catalogue par URL.
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
  /** Produits validés au moment de l'aperçu — la confirmation ne relit pas le réseau. */
  products: NormalizedProduct[];
  origin: ImportBatch['origin'];
}

export interface StoreImportDependencies {
  /** Vérifie l'utilisateur à partir de l'en-tête Authorization. */
  getUserId(authorization: string): Promise<string | null>;
  /** Contrôle d'accès à l'entreprise, exécuté en base. */
  grantWorkspace(userId: string, workspaceId: string): Promise<WorkspaceGrant>;
  /** Catalogue existant de l'entreprise, pour les doublons. */
  listExistingProducts(workspaceId: string): Promise<ExistingProduct[]>;
  /** Écrit les produits retenus. Ne doit jamais être appelé par `preview`. */
  insertProducts(workspaceId: string, products: NormalizedProduct[]): Promise<{ created: number; failed: Array<{ name: string; reason: string }> }>;
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
  url: string;
  /** Obligatoire pour `import`. */
  previewId?: string;
  /** Obligatoire pour `import`, strictement `true`. */
  confirmed?: boolean;
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

export function createStoreImportHandler(dependencies: StoreImportDependencies) {
  const allowedOrigins = dependencies.allowedOrigins;
  const now = dependencies.now ?? (() => Date.now());
  const ttl = dependencies.previewTtlMs ?? PREVIEW_TTL_MS;
  // Aperçus en mémoire. Une instance peut redémarrer : le client reçoit alors
  // `PREVIEW_EXPIRED` et doit relancer l'aperçu — jamais d'import à l'aveugle.
  const apercus = new Map<string, PreviewRecord>();

  function purge(): void {
    const limite = now();
    for (const [id, enregistrement] of apercus) {
      if (limite - enregistrement.createdAt > ttl) apercus.delete(id);
    }
  }

  /** Garde-fou : la table ne doit jamais grossir sans fin. */
  function evincer(): void {
    if (apercus.size <= MAX_PREVIEWS_PER_USER) return;
    const tri = [...apercus.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id] of tri.slice(0, apercus.size - MAX_PREVIEWS_PER_USER)) apercus.delete(id);
  }

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
        purge();
        const payload = await faireApercu(dependencies, { userId, workspaceId, url: text(body.url, 2048), now, ttl });
        apercus.set(payload.data.previewId, payload.record);
        evincer();
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
      purge();
      const enregistrement = apercus.get(previewId);
      // Un aperçu appartient à UN utilisateur et UNE entreprise.
      if (!enregistrement || enregistrement.userId !== userId || enregistrement.workspaceId !== workspaceId) {
        return jsonResponse(failure('PREVIEW_EXPIRED', 'Aperçu introuvable ou expiré : relancez la prévisualisation.'), 409, corsOrigin);
      }
      if (now() - enregistrement.createdAt > ttl) {
        apercus.delete(previewId);
        return jsonResponse(failure('PREVIEW_EXPIRED', 'Aperçu expiré : relancez la prévisualisation.'), 409, corsOrigin);
      }

      const selection = lireSelection(body.selection, enregistrement.products.length);
      if (selection instanceof StoreImportError) {
        return jsonResponse(failure(selection.code, selection.message), selection.status, corsOrigin);
      }
      const retenus = selection.map((index) => enregistrement.products[index]).filter(Boolean);
      if (retenus.length === 0) {
        return jsonResponse(failure('NOTHING_SELECTED', 'Aucun produit retenu pour l’import.'), 400, corsOrigin);
      }

      // Un aperçu ne se rejoue pas : la confirmation le consomme.
      apercus.delete(previewId);
      const resultat = await dependencies.insertProducts(workspaceId, retenus);
      return jsonResponse({ data: resultat }, 200, corsOrigin);
    } catch (cause) {
      if (cause instanceof StoreImportError) {
        return jsonResponse(failure(cause.code, cause.message), cause.status, corsOrigin);
      }
      console.error('store-import failed', { action });
      return jsonResponse(failure('STORE_IMPORT_BACKEND_ERROR', 'Le service d’import est temporairement indisponible.'), 500, corsOrigin);
    }
  };
}

function lireSelection(value: unknown, taille: number): number[] | StoreImportError {
  if (value === undefined || value === null) return Array.from({ length: taille }, (_, i) => i);
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
