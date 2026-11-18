/**
 * Edge Function `store-connect` — connexion d'une boutique à clé d'API.
 *
 * ## Le parcours, en une fonction
 *
 * ```
 * POST { action: 'connect', workspaceId, url, apiKey }
 *   → valide l'URL (SSRF) → résout → vérifie la clé EN LISANT l'API
 *   → dépose la clé dans Vault → enregistre integration_connections
 *   → répond { status: 'connected', shopName, totalProducts, resourcesRead }
 * ```
 *
 * ## Où vivent les secrets
 *
 * **Nulle part dans la réponse.** La clé envoyée par le navigateur n'est
 * écrite ni dans un journal, ni dans la réponse, ni dans `integration_connections` :
 * elle part dans **Vault**, et la table ne conserve que le NOM du secret
 * (`credential_ref`). Le navigateur ne peut donc jamais la relire, et un
 * `select *` sur la table ne la révèle pas.
 *
 * ## Pourquoi ce n'est pas un deuxième système de connexion
 *
 * Les états (`pending`, `connected`, `error`) et la table sont ceux du socle
 * Business Grow (`saas_business.integration_connections`). On ajoute seulement
 * deux RPC pour écrire un secret Vault et journaliser la vérification. Aucune
 * table parallèle n'est créée pour l'état de connexion.
 *
 * ## Sécurité, dans l'ordre où elle s'applique
 *
 * 1. Authentification GoTrue (jamais un en-tête de confiance).
 * 2. Abonnement Business Grow **actif et payé** (`bg_import_access`).
 * 3. Accès en écriture à l'entreprise (`bg_require_workspace(…, true)`).
 * 4. Validation d'URL + résolution DNS + épinglage IP (aucun SSRF possible).
 * 5. La clé n'est utilisée que pour un `GET` sortant, jamais renvoyée.
 */

import {
  PRESTASHOP_API_PATH,
  classifyStatus,
  redactedUrl,
  type PrestashopCredentials,
  type PrestashopError,
  type PrestashopProbe,
  type PrestashopTarget,
} from '../../../src/business/importer/prestashop-api.ts';
// La sonde et la lecture vivent dans le module d'assemblage : la première
// vérifie en lisant réellement des ressources, la seconde construit le
// catalogue. `prestashop-api.ts` ne fait que parler à l'API.
import { probePrestashop, readPrestashopCatalog } from '../../../src/business/importer/prestashop-catalog.ts';
import {
  CHARIOW_API_HOST,
  validateChariowKey,
  type ChariowError,
} from '../../../src/business/importer/chariow-api.ts';
import {
  explainChariowError,
  probeChariow,
  readChariowCatalog,
  toChariowRawProduct,
} from '../../../src/business/importer/chariow-catalog.ts';
import { sameShopOrigin } from '../../../src/business/importer/chariow-pricing.ts';
import {
  probeShopify,
  normalizeShopDomain,
  validateShopifyToken,
} from '../../../src/business/importer/shopify-api.ts';
import {
  probeWooCommerce,
  normalizeWooSite,
  validateWooCredentials,
} from '../../../src/business/importer/woocommerce-api.ts';
import {
  buildAuthHeaders,
  parseCustomApiBaseUrl,
  parseCustomApiEndpoint,
  explainCustomApiRejection,
  type AuthScheme,
} from '../../../src/business/importer/custom-api-guard.ts';
import {
  paginationCoherente,
  probeResponse,
  type PaginationKind,
} from '../../../src/business/importer/custom-api-probe.ts';
import { resolveCorsOrigin } from '../../../src/lib/origin-allowlist.ts';
import {
  assertPublicAddresses,
  explainRejection,
  parseStoreUrl,
} from '../../../src/business/importer/url-guard.ts';
import type { CatalogPlatform } from '../../../src/business/importer/sources.ts';

/* ------------------------------- dépendances ------------------------------- */

export interface ConnectGrant {
  canRead: boolean;
  canWrite: boolean;
}

export interface ConnectAccess {
  allowed: boolean;
  reason: string;
  message: string;
  status?: string | null;
  planKey?: string | null;
}

/** Ce que la fonction attend de son environnement. Tout est injectable. */
export interface ConnectDependencies {
  getUserId(authorization: string): Promise<string | null>;
  checkImportAccess(userId: string): Promise<ConnectAccess>;
  /** Droits sur l'entreprise, lus en base — jamais d'après le client. */
  grantWorkspace(userId: string, workspaceId: string): Promise<ConnectGrant>;
  /** Dépose un secret dans Vault et rend son NOM (jamais sa valeur). */
  storeCredential(input: { userId: string; connectorKey: string; secret: string }): Promise<string>;
  /**
   * Relit le secret Vault d'un connecteur, côté serveur uniquement.
   *
   * Utilisé par `preview` : la clé ne repasse pas par le navigateur. Rend
   * `null` quand aucune connexion n'existe — l'aperçu est alors refusé avec un
   * motif explicite plutôt que d'échouer sur une clé vide.
   */
  readCredential(userId: string, connectorKey: string): Promise<string | null>;
  /** Supprime un secret Vault devenu inutile. Ne lève jamais. */
  deleteCredential(name: string): Promise<void>;
  /** Enregistre la connexion réussie (RPC `bg_connect_integration`). */
  recordConnection(input: {
    userId: string; workspaceId: string; connectorKey: string;
    credentialRef: string; externalAccountRef: string | null;
    resourcesRead: string[]; totalProducts: number | null; durationMs: number;
  }): Promise<{ connectionId: string; status: string }>;
  /** Journalise un échec (RPC `bg_record_integration_failure`). */
  recordFailure(input: {
    userId: string; workspaceId: string; connectorKey: string;
    errorCode: string; errorMessage: string; durationMs: number;
  }): Promise<{ connectionId: string; status: string }>;
  /** État courant d'un connecteur pour cette entreprise. */
  readConnection(userId: string, workspaceId: string, connectorKey: string): Promise<unknown>;
  /**
   * Remet la connexion à `disconnected` et vide `credential_ref`.
   *
   * Sans cette écriture, supprimer le secret laissait la ligne au statut
   * `connected` : l'écran annonçait une connexion qui n'existait plus.
   */
  markDisconnected?(userId: string, workspaceId: string, connectorKey: string): Promise<unknown>;
  /** Résolution DNS réelle (Deno.resolveDns), injectable en test. */
  resolveHost(hostname: string): Promise<string[]>;
  /** `fetch` épinglé sur l'IP validée (`pinnedFetchLike`). */
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Écrit la configuration d'une API personnalisée (table dédiée).
   *
   * Séparé de `recordConnection` : l'une décrit l'état de connexion commun à
   * tous les connecteurs, l'autre les paramètres propres à une API décrite par
   * l'utilisateur. Les mélanger aurait imposé un schéma fourre-tout.
   */
  saveCustomApiConfig?(input: {
    userId: string; workspaceId: string; credentialRef: string;
    baseUrl: string; authScheme: string; authHeaderName: string | null;
    productsPath: string; paginationKind: string; pageSize: number; maxPages: number;
    mapping: Record<string, unknown>; priceUnit: 'major' | 'minor'; currency: string;
    probeSummary: string; probeStatus: number; productsFound: number; durationMs: number;
  }): Promise<{
    ok?: boolean; code?: string; message?: string;
    connectionId?: string; configurationId?: string;
  } | void>;
  /**
   * Nom du secret Vault existant, sans en lire la valeur.
   *
   * Utile à `save-custom` : le secret a déjà été déposé par la sonde, et il ne
   * faut pas le redemander. `readCredential` rendrait la valeur — dont on n'a
   * justement pas besoin ici.
   */
  readCredentialRef?(userId: string, connectorKey: string): Promise<string | null>;
  /** Marque de temps, injectable. */
  now?: () => number;
  /** Journal technique, silencieux en test. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

/* --------------------------------- réponses -------------------------------- */

export interface Failure {
  error: { code: string; message: string };
}

export class ConnectError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ConnectError';
    this.code = code;
    this.status = status;
  }
}

function failure(code: string, message: string): Failure {
  return { error: { code, message } };
}

function jsonResponse(payload: unknown, status: number, corsOrigin: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': corsOrigin,
      'cache-control': 'no-store',
    },
  });
}

/** Ne garde qu'un texte plausible dans une réponse d'erreur. */
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** UUID accepté, sinon `null`. */
function uuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/* ---------------------------- validation des entrées --------------------------- */

/**
 * Clé Webservice PrestaShop : 32 caractères alphanumériques en pratique.
 *
 * On ne l'impose pas à 32 exactement : un marchand peut régénérer une clé plus
 * longue, et certaines installations acceptent d'autres formes. On refuse
 * seulement ce qui ne peut pas être une clé : vide, trop courte, contenant un
 * caractère de contrôle ou un espace (qui casserait l'en-tête `Authorization`).
 */
export function normalizeApiKey(raw: unknown): string | null {
  const valeur = text(raw, 200);
  if (valeur.length < 8) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(valeur)) return null;
  return valeur;
}

/**
 * Vérifie l'URL de la boutique et résout son adresse.
 *
 * Le contrôle de forme (`parseStoreUrl`) refuse déjà : schéma non HTTPS, port
 * non standard, identifiants dans l'URL, hôte littéral, `.local`/`.internal`.
 * La résolution est faite ici, et TOUTES les adresses doivent être publiques :
 * une seule adresse privée suffit à refuser, ce qui bloque un DNS hostile qui
 * renverrait une adresse publique et une adresse interne.
 */
async function verifierCible(
  rawUrl: string,
  deps: ConnectDependencies,
): Promise<{ target: PrestashopTarget; connectedTo: string }> {
  const forme = parseStoreUrl(rawUrl);
  if (!forme.ok) {
    throw new ConnectError('URL_REFUSED', explainRejection(forme.reason), 400);
  }
  const url = forme.url;

  let adresses: string[];
  try {
    adresses = await deps.resolveHost(url.hostname);
  } catch {
    throw new ConnectError('DNS_FAILED', 'Le domaine de la boutique n’a pas pu être résolu.', 502);
  }
  if (!Array.isArray(adresses) || adresses.length === 0) {
    throw new ConnectError('DNS_FAILED', 'Le domaine de la boutique ne renvoie aucune adresse.', 502);
  }
  const controle = assertPublicAddresses(adresses);
  if (!controle.ok) {
    throw new ConnectError('URL_REFUSED', explainRejection(controle.reason), 400);
  }

  // La racine de la boutique : on garde un éventuel sous-dossier, sans le
  // chemin complet saisi par l'utilisateur (qui pourrait contenir un identifiant).
  const basePath = url.pathname.replace(/\/+$/, '');
  return {
    target: { root: new URL(`${url.origin}/`), basePath: basePath || PRESTASHOP_API_PATH },
    connectedTo: adresses[0],
  };
}

/** Nom de secret Vault : stable par utilisateur et connecteur, sans secret dedans. */
export function credentialName(userId: string, connectorKey: string): string {
  return `vyora_${connectorKey}_${userId}`;
}

/**
 * Connecteurs dont la connexion est vérifiée par une lecture réelle de l'API.
 *
 * `mode` décide du parcours :
 *  - `shop-api` : l'API est **chez le marchand** (PrestaShop). L'URL de la
 *    boutique est obligatoire, résolue, contrôlée contre le SSRF, puis épinglée.
 *  - `hosted-api` : l'API est **chez l'éditeur** (Chariow, `api.chariow.com`).
 *    L'hôte est fixe et non fourni par l'utilisateur : la surface SSRF liée à
 *    une adresse d'API arbitraire disparaît. L'URL de la vitrine ne sert qu'à
 *    confirmer que la clé correspond bien à la boutique annoncée.
 */
const CONNECTEURS: Record<
  string,
  { platform: CatalogPlatform; label: string; mode: 'shop-api' | 'hosted-api' | 'shopify-admin' | 'woo-rest' }
> = {
  prestashop: { platform: 'prestashop', label: 'PrestaShop', mode: 'shop-api' },
  chariow: { platform: 'chariow', label: 'Chariow', mode: 'hosted-api' },
  /*
   * Shopify et WooCommerce ont leurs propres parcours : le premier s'adresse
   * à une API d'administration fixe déduite du domaine `*.myshopify.com`, le
   * second à l'API REST du site du marchand avec une paire de clés. Aucun des
   * deux ne rentre dans le formulaire « URL + une clé » de PrestaShop.
   */
  shopify: { platform: 'shopify', label: 'Shopify', mode: 'shopify-admin' },
  woocommerce: { platform: 'woocommerce', label: 'WooCommerce', mode: 'woo-rest' },
};

/* ---------------------------------- actions -------------------------------- */

/** `connect` : vérifie réellement la connexion, puis l'enregistre. */
async function connecter(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps } = contexte;
  const connectorKey = text(body.connectorKey, 40) || 'prestashop';
  const connecteur = CONNECTEURS[connectorKey];
  if (!connecteur) {
    return jsonResponse(failure('UNKNOWN_CONNECTOR', 'Connecteur inconnu.'), 400, corsOrigin);
  }

  // Chariow a son propre parcours : l'API n'est pas chez le marchand, donc il
  // n'y a ni résolution de boutique ni épinglage d'adresse client à faire. On
  // délègue AVANT la validation d'URL PrestaShop, qui exigerait une adresse
  // de boutique obligatoire — Chariow, lui, la déduit de l'API.
  if (connecteur.mode === 'hosted-api') {
    return connecterHerberge(body, { userId, workspaceId, corsOrigin, deps, connectorKey });
  }
  if (connecteur.mode === 'shopify-admin') {
    return connecterShopify(body, { userId, workspaceId, corsOrigin, deps, connectorKey });
  }
  if (connecteur.mode === 'woo-rest') {
    return connecterWooCommerce(body, { userId, workspaceId, corsOrigin, deps, connectorKey });
  }

  const apiKey = normalizeApiKey(body.apiKey);
  if (!apiKey) {
    return jsonResponse(
      failure('API_KEY_REQUIRED', 'La clé Webservice est requise (au moins 8 caractères, sans espace).'),
      400, corsOrigin,
    );
  }
  const rawUrl = text(body.url, 500);
  if (!rawUrl) {
    return jsonResponse(failure('URL_REQUIRED', 'L’adresse de la boutique est requise.'), 400, corsOrigin);
  }

  const debut = (deps.now ?? Date.now)();
  let cible: { target: PrestashopTarget; connectedTo: string };
  try {
    cible = await verifierCible(rawUrl, deps);
  } catch (erreur) {
    if (erreur instanceof ConnectError) {
      return jsonResponse(failure(erreur.code, erreur.message), erreur.status, corsOrigin);
    }
    throw erreur;
  }

  // Vérification RÉELLE : on lit `shops`, `languages` et la première page de
  // produits. Un `200` sur la racine ne prouverait rien.
  const credentials: PrestashopCredentials = { apiKey };
  const sonde = await probePrestashop(cible.target, credentials, {
    fetchImpl: deps.fetchImpl,
    pause: async () => {},
  });

  if (!sonde.ok) {
    const duree = (deps.now ?? Date.now)() - debut;
    await journaliserEchec(deps, {
      userId, workspaceId, connectorKey, duree, erreur: sonde.error, phase: 'probe',
    });
    const statut = statutPourErreur(sonde.error);
    return jsonResponse(failure(sonde.error.code.toUpperCase(), sonde.error.message), statut, corsOrigin);
  }

  const rapport = sonde.value;

  let credentialRef: string;
  try {
    credentialRef = await deps.storeCredential({
      userId,
      connectorKey,
      // La clé est rangée telle quelle : le secret Vault est chiffré au repos.
      secret: apiKey,
    });
  } catch (erreur) {
    deps.log?.('store-connect: dépôt du secret impossible', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return jsonResponse(
      failure('SECRET_STORE_UNAVAILABLE', 'La clé n’a pas pu être enregistrée de façon sécurisée. Réessayez.'),
      503, corsOrigin,
    );
  }

  const duree = (deps.now ?? Date.now)() - debut;
  let enregistrement: { connectionId: string; status: string };
  try {
    enregistrement = await deps.recordConnection({
      userId,
      workspaceId,
      connectorKey,
      credentialRef,
      // La référence externe est le domaine de la boutique — jamais la clé.
      externalAccountRef: redactedUrl(cible.target.root.toString()),
      resourcesRead: rapport.resourcesRead,
      totalProducts: rapport.totalProducts,
      durationMs: duree,
    });
  } catch (erreur) {
    // La connexion n'a pas pu être enregistrée : le secret déposé est inutile,
    // on le retire pour ne pas laisser un secret orphelin dans Vault.
    await deps.deleteCredential(credentialRef).catch(() => {});
    const message = erreur instanceof Error ? erreur.message : '';
    if (/SUBSCRIPTION_REQUIRED/i.test(message)) {
      return jsonResponse(
        failure('SUBSCRIPTION_REQUIRED', 'Un abonnement Business Grow actif et payé est requis pour connecter une boutique.'),
        403, corsOrigin,
      );
    }
    if (/WORKSPACE_ACCESS_DENIED|forbidden/i.test(message)) {
      return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Droits insuffisants sur cette entreprise.'), 403, corsOrigin);
    }
    deps.log?.('store-connect: enregistrement impossible', { erreur: message || 'inconnue' });
    return jsonResponse(failure('CONNECTION_NOT_SAVED', 'La connexion vérifiée n’a pas pu être enregistrée.'), 500, corsOrigin);
  }

  return jsonResponse({
    data: {
      connectorKey,
      status: enregistrement.status,
      connected: true,
      shopName: rapport.shopName,
      version: rapport.version,
      totalProducts: rapport.totalProducts,
      languages: rapport.languages,
      resourcesRead: rapport.resourcesRead,
      // L'adresse contactée est une preuve du contrôle SSRF ; elle ne contient
      // aucun secret.
      connectedTo: cible.connectedTo,
      endpoint: `${cible.target.root.origin}${cible.target.basePath ?? PRESTASHOP_API_PATH}`,
      durationMs: duree,
      // `nomSecret` n'est PAS renvoyé : le navigateur n'a aucun usage du nom
      // d'un secret Vault, et le lui donner élargirait la surface d'attaque.
    },
  }, 200, corsOrigin);
}

/* --------------------- connecteurs à API hébergée (Chariow) ----------------- */

/**
 * Connexion d'une boutique dont l'API appartient à l'ÉDITEUR (Chariow).
 *
 * ## Différences assumées avec PrestaShop
 *
 * | | PrestaShop | Chariow |
 * |---|---|---|
 * | Hôte de l'API | la boutique du marchand | `api.chariow.com`, fixe |
 * | Contrôle SSRF | résolution + épinglage de l'IP | hôte constant, non fourni |
 * | URL de boutique | obligatoire, c'est l'API | facultative, sert de contrôle |
 *
 * L'hôte de l'API n'étant **pas** dicté par la requête, il n'y a pas d'adresse
 * arbitraire à épingler : la sortie reste la sortie épinglée commune
 * (`pinnedFetchLike`), qui revalide la résolution de `api.chariow.com` à chaque
 * appel. Le SSRF ne disparaît donc pas, il est simplement réduit à un seul nom,
 * connu à l'avance.
 *
 * ## Le contrôle qui compte : la clé appartient-elle à CETTE boutique ?
 *
 * Une clé Chariow donne accès à **une** boutique. Si le marchand saisit
 * l'adresse de sa vitrine, on compare avec `data.url` renvoyé par
 * `GET /v1/store`. Sans cette comparaison, une clé appartenant à une autre
 * boutique serait acceptée et l'import écraserait le catalogue de la mauvaise
 * entreprise. En cas de désaccord, on **refuse** au lieu d'importer.
 */
async function connecterHerberge(
  body: Record<string, unknown>,
  contexte: {
    userId: string;
    workspaceId: string;
    corsOrigin: string;
    deps: ConnectDependencies;
    connectorKey: string;
  },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps, connectorKey } = contexte;

  const cle = validateChariowKey(body.apiKey);
  if (!cle.ok) {
    return jsonResponse(failure('API_KEY_REQUIRED', cle.error.message), 400, corsOrigin);
  }

  // Adresse de vitrine : facultative. Elle ne sert qu'à la confirmation
  // d'appartenance, jamais à joindre l'API.
  const vitrine = text(body.url, 500);

  const debut = (deps.now ?? Date.now)();
  const sonde = await probeChariow({ apiKey: cle.value }, { fetchImpl: deps.fetchImpl });

  if (!sonde.ok) {
    const duree = (deps.now ?? Date.now)() - debut;
    await journaliserEchec(deps, {
      userId, workspaceId, connectorKey, duree,
      erreur: { code: sonde.error.code, message: sonde.error.message },
      phase: 'probe',
    });
    return jsonResponse(
      failure(sonde.error.code.toUpperCase(), explainChariowError(sonde.error)),
      statutPourErreurChariow(sonde.error),
      corsOrigin,
    );
  }

  const rapport = sonde.value;

  // Confirmation d'appartenance : seulement si le marchand a saisi une adresse
  // ET si Chariow en publie une. On ne refuse pas sur une donnée manquante —
  // on refuse seulement sur un DÉSACCORD explicite.
  if (vitrine && rapport.store.url && !sameShopOrigin(rapport.store.url, vitrine)) {
    return jsonResponse(
      failure(
        'SHOP_MISMATCH',
        `Cette clé appartient à la boutique ${rapport.store.url}, pas à ${vitrine}. Vérifiez la clé (Settings → API Keys de la bonne boutique).`,
      ),
      409,
      corsOrigin,
    );
  }

  let credentialRef: string;
  try {
    credentialRef = await deps.storeCredential({ userId, connectorKey, secret: cle.value });
  } catch (erreur) {
    deps.log?.('store-connect: dépôt du secret impossible', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return jsonResponse(
      failure('SECRET_STORE_UNAVAILABLE', 'La clé n’a pas pu être enregistrée de façon sécurisée. Réessayez.'),
      503, corsOrigin,
    );
  }

  const duree = (deps.now ?? Date.now)() - debut;
  let enregistrement: { connectionId: string; status: string };
  try {
    enregistrement = await deps.recordConnection({
      userId,
      workspaceId,
      connectorKey,
      credentialRef,
      // Référence externe : l'URL publique de la boutique lue chez Chariow.
      // Jamais la clé, jamais son nom de secret.
      externalAccountRef: rapport.store.url,
      resourcesRead: rapport.resourcesRead,
      // Chariow ne publie pas de total : `null` est plus honnête qu'un 0.
      totalProducts: null,
      durationMs: duree,
    });
  } catch (erreur) {
    await deps.deleteCredential(credentialRef).catch(() => {});
    const message = erreur instanceof Error ? erreur.message : '';
    if (/SUBSCRIPTION_REQUIRED/i.test(message)) {
      return jsonResponse(
        failure('SUBSCRIPTION_REQUIRED', 'Un abonnement Business Grow actif et payé est requis pour connecter une boutique.'),
        403, corsOrigin,
      );
    }
    if (/WORKSPACE_ACCESS_DENIED|forbidden/i.test(message)) {
      return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Droits insuffisants sur cette entreprise.'), 403, corsOrigin);
    }
    deps.log?.('store-connect: enregistrement impossible', { erreur: message || 'inconnue' });
    return jsonResponse(failure('CONNECTION_NOT_SAVED', 'La connexion vérifiée n’a pas pu être enregistrée.'), 500, corsOrigin);
  }

  return jsonResponse({
    data: {
      connectorKey,
      status: enregistrement.status,
      connected: true,
      // Ce que la vérification a RÉELLEMENT lu chez Chariow.
      shopName: rapport.store.name,
      version: null,
      totalProducts: null,
      languages: [],
      resourcesRead: rapport.resourcesRead,
      connectedTo: CHARIOW_API_HOST,
      endpoint: 'https://api.chariow.com/v1',
      storeUrl: rapport.store.url,
      storeStatus: rapport.store.status,
      storeId: rapport.store.id,
      durationMs: duree,
    },
  }, 200, corsOrigin);
}

/** Traduit une erreur Chariow en statut HTTP. */
function statutPourErreurChariow(erreur: ChariowError): number {
  switch (erreur.code) {
    case 'auth_required':
      return 400;
    case 'auth_invalid':
      return 401;
    case 'insufficient_scope':
    case 'forbidden':
      return 403;
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'too_large':
      return 413;
    case 'blocked_url':
    case 'not_found':
    case 'bad_response':
      return 400;
    default:
      return 502;
  }
}

/**
 * Aperçu Chariow : lit le catalogue, le projette dans la forme brute commune,
 * et le renvoie SANS RIEN ÉCRIRE.
 *
 * La clé vient de Vault : le navigateur ne la renvoie jamais. C'est ce qui
 * permet à l'aperçu de fonctionner après un rechargement de page sans que
 * l'utilisateur ait à ressaisir son secret.
 */
async function previsualiserChariow(
  contexte: { userId: string; corsOrigin: string; deps: ConnectDependencies },
  currency?: string,
): Promise<Response> {
  const { userId, corsOrigin, deps } = contexte;

  const apiKey = await deps.readCredential(userId, 'chariow');
  if (!apiKey) {
    return jsonResponse(
      failure('CONNECTION_REQUIRED', 'Connectez d’abord votre boutique Chariow : aucune clé n’est enregistrée pour ce connecteur.'),
      409, corsOrigin,
    );
  }

  const lecture = await readChariowCatalog(
    { apiKey },
    { fetchImpl: deps.fetchImpl },
    { defaultCurrency: currency },
  );
  if (!lecture.ok) {
    return jsonResponse(
      failure(lecture.error.code.toUpperCase(), explainChariowError(lecture.error)),
      statutPourErreurChariow(lecture.error),
      corsOrigin,
    );
  }

  const catalogue = lecture.value;
  // Les produits sont renvoyés sous la forme brute normalisable : c'est
  // `store-import` qui applique ensuite `normalizeCatalog` et `matchBatch`.
  // Le rapprochement reste donc à UN seul endroit, quel que soit le connecteur.
  const produits = catalogue.products.map((produit) =>
    toChariowRawProduct(produit, catalogue.store.url, catalogue.currency ?? 'XOF')
  );

  return jsonResponse({
    data: {
      platform: 'chariow',
      endpoint: catalogue.endpoint,
      connectedTo: CHARIOW_API_HOST,
      currency: catalogue.currency,
      resourcesRead: catalogue.resourcesRead,
      // Un catalogue tronqué doit être DIT : l'utilisateur verrait sinon une
      // partie de ses produits sans savoir qu'il en manque.
      truncated: catalogue.truncated,
      // Compté et remonté : distinguer « 0 produit » de « 0 produit publié,
      // 4 brouillons » est la différence entre une boutique vide et un import
      // qui aurait dû ramener des fiches.
      draftsSkipped: catalogue.draftsSkipped,
      rejected: catalogue.rejected,
      store: catalogue.store,
      products: produits,
      count: produits.length,
    },
  }, 200, corsOrigin);
}

/** Traduit une erreur du connecteur en statut HTTP. */
function statutPourErreur(erreur: PrestashopError): number {
  switch (erreur.code) {
    case 'auth_required':
    case 'auth_invalid':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_prestashop':
    case 'not_found':
    case 'api_disabled':
    case 'blocked_url':
      return 400;
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'too_large':
      return 413;
    case 'dns_failed':
      return 502;
    default:
      return 502;
  }
}

async function journaliserEchec(
  deps: ConnectDependencies,
  entree: {
    userId: string; workspaceId: string; connectorKey: string;
    // Structure minimale commune à tous les connecteurs : un code machine et un
    // message déjà expurgé. Le journal ne connaît donc pas les types propres à
    // chaque API, et n'a aucune raison de manipuler un secret.
    duree: number; erreur: { code: string; message: string }; phase: string;
  },
): Promise<void> {
  try {
    await deps.recordFailure({
      userId: entree.userId,
      workspaceId: entree.workspaceId,
      connectorKey: entree.connectorKey,
      errorCode: entree.erreur.code.toUpperCase(),
      // Le message vient de notre propre code : il ne peut pas contenir la clé.
      errorMessage: entree.erreur.message,
      durationMs: entree.duree,
    });
  } catch (erreur) {
    // Une panne du journal ne doit pas masquer la vraie erreur, qui est plus
    // utile à l'utilisateur.
    deps.log?.('store-connect: journal d’échec indisponible', {
      phase: entree.phase,
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
  }
}


/* ------------------------- Shopify (API Admin) ----------------------------- */
/*
 * Pendant Shopify du parcours PrestaShop, avec trois différences qui comptent :
 *
 * 1. **Le domaine est `*.myshopify.com`**, pas l'adresse de la vitrine. C'est
 *    le seul hôte qui parle l'API d'administration ; une vitrine sur domaine
 *    personnalisé n'y répond pas. On refuse donc plutôt que de deviner.
 * 2. **L'hôte est épinglé comme les autres** : c'est une adresse fournie par
 *    l'utilisateur, donc passée à la garde SSRF avant tout appel.
 * 3. **Les scopes sont vérifiés réellement.** Un jeton valide sans
 *    `read_products` est refusé AVANT d'être rangé dans Vault : sinon le
 *    marchand verrait « connecté » puis un import en échec.
 */
async function connecterShopify(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies; connectorKey: string },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps, connectorKey } = contexte;

  const domaine = normalizeShopDomain(body.url ?? body.shopDomain);
  if (!domaine.ok) {
    return jsonResponse(failure('SHOPIFY_DOMAIN_INVALID', domaine.error.message), 400, corsOrigin);
  }
  const jeton = validateShopifyToken(body.apiKey);
  if (!jeton.ok) {
    return jsonResponse(failure('API_KEY_REQUIRED', jeton.error.message), 400, corsOrigin);
  }

  // Garde SSRF et épinglage : même chemin que PrestaShop.
  const debut = (deps.now ?? Date.now)();
  let connectedTo: string;
  try {
    const verifie = await verifierCible(`https://${domaine.value.domain}`, deps);
    connectedTo = verifie.connectedTo;
  } catch (erreur) {
    if (erreur instanceof ConnectError) {
      return jsonResponse(failure(erreur.code, erreur.message), erreur.status, corsOrigin);
    }
    throw erreur;
  }

  const sonde = await probeShopify(
    { shopDomain: domaine.value.domain, accessToken: jeton.value },
    { fetchImpl: deps.fetchImpl, pause: async () => {} },
  );

  if (!sonde.ok) {
    const duree = (deps.now ?? Date.now)() - debut;
    await journaliserEchec(deps, {
      userId, workspaceId, connectorKey, duree,
      erreur: { code: sonde.error.code, message: sonde.error.message },
      phase: 'probe',
    });
    return jsonResponse(
      failure(sonde.error.code.toUpperCase(), sonde.error.message),
      statutPourErreurExterne(sonde.error),
      corsOrigin,
    );
  }

  const rapport = sonde.value;

  let credentialRef: string;
  try {
    /*
     * Le secret porte le domaine ET le jeton, séparés par un saut de ligne.
     *
     * `store-import` a besoin du domaine pour épingler sa sortie réseau : c'est
     * une adresse fournie par l'utilisateur, elle doit passer la garde SSRF à
     * CHAQUE import, pas seulement à la connexion. Un jeton seul ne le permettrait
     * pas, et le redemander au navigateur ferait circuler un secret à chaque
     * aperçu.
     */
    credentialRef = await deps.storeCredential({
      userId,
      connectorKey,
      secret: `${domaine.value.domain}\n${jeton.value}`,
    });
  } catch (erreur) {
    deps.log?.('store-connect: dépôt du secret Shopify impossible', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return jsonResponse(
      failure('SECRET_STORE_UNAVAILABLE', 'Le jeton n’a pas pu être enregistré de façon sécurisée. Réessayez.'),
      503, corsOrigin,
    );
  }

  const duree = (deps.now ?? Date.now)() - debut;
  let enregistrement: { connectionId: string; status: string };
  try {
    enregistrement = await deps.recordConnection({
      userId,
      workspaceId,
      connectorKey,
      credentialRef,
      // Le domaine, jamais le jeton.
      externalAccountRef: rapport.domain,
      resourcesRead: rapport.resourcesRead,
      totalProducts: rapport.totalProducts,
      durationMs: duree,
    });
  } catch (erreur) {
    await deps.deleteCredential(credentialRef).catch(() => {});
    return await reponseEnregistrementImpossible(erreur, 'shopify', corsOrigin, deps);
  }

  return jsonResponse({
    data: {
      connectorKey,
      status: enregistrement.status,
      connected: true,
      shopName: rapport.shopName,
      domain: rapport.domain,
      currency: rapport.currency,
      totalProducts: rapport.totalProducts,
      grantedScopes: rapport.grantedScopes,
      inventoryScope: rapport.inventoryScope,
      resourcesRead: rapport.resourcesRead,
      connectedTo,
    },
  }, 200, corsOrigin);
}

/* ---------------------- WooCommerce (API REST v3) -------------------------- */
/*
 * Ici, pas de domaine imposé : chaque site WooCommerce est indépendant. La
 * garde SSRF est donc celle de PrestaShop — résolution + épinglage — et la paire
 * de clés est vérifiée en lisant réellement une page de produits.
 *
 * La permission « Lecture » suffit et est la seule demandée : le client
 * n'émet que des `GET`, et `safe-egress.ts` refuse toute autre méthode.
 */
async function connecterWooCommerce(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies; connectorKey: string },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps, connectorKey } = contexte;

  const site = normalizeWooSite(text(body.url, 500));
  if (!site.ok) {
    return jsonResponse(failure('WOO_SITE_INVALID', site.error.message), 400, corsOrigin);
  }
  const cles = validateWooCredentials(body.apiKey, body.apiSecret);
  if (!cles.ok) {
    return jsonResponse(failure('API_KEY_REQUIRED', cles.error.message), 400, corsOrigin);
  }

  const debut = (deps.now ?? Date.now)();
  let connectedTo: string;
  try {
    const verifie = await verifierCible(site.value.siteUrl, deps);
    connectedTo = verifie.connectedTo;
  } catch (erreur) {
    if (erreur instanceof ConnectError) {
      return jsonResponse(failure(erreur.code, erreur.message), erreur.status, corsOrigin);
    }
    throw erreur;
  }

  const sonde = await probeWooCommerce(
    { siteUrl: site.value.siteUrl, consumerKey: cles.value.key, consumerSecret: cles.value.secret },
    { fetchImpl: deps.fetchImpl, pause: async () => {} },
  );

  if (!sonde.ok) {
    const duree = (deps.now ?? Date.now)() - debut;
    await journaliserEchec(deps, {
      userId, workspaceId, connectorKey, duree,
      erreur: { code: sonde.error.code, message: sonde.error.message },
      phase: 'probe',
    });
    return jsonResponse(
      failure(sonde.error.code.toUpperCase(), sonde.error.message),
      statutPourErreurExterne(sonde.error),
      corsOrigin,
    );
  }

  const rapport = sonde.value;

  /*
   * Les DEUX clés et l'adresse du site sont rangées, séparées par des sauts de
   * ligne : `store-import` les relit ensemble, et l'adresse lui sert à épingler
   * sa sortie réseau. Le secret Vault est chiffré au repos, et ce bloc ne sort
   * jamais du serveur.
   */
  let credentialRef: string;
  try {
    credentialRef = await deps.storeCredential({
      userId,
      connectorKey,
      secret: `${cles.value.key}\n${cles.value.secret}\n${site.value.siteUrl}`,
    });
  } catch (erreur) {
    deps.log?.('store-connect: dépôt des clés WooCommerce impossible', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return jsonResponse(
      failure('SECRET_STORE_UNAVAILABLE', 'Les clés n’ont pas pu être enregistrées de façon sécurisée. Réessayez.'),
      503, corsOrigin,
    );
  }

  const duree = (deps.now ?? Date.now)() - debut;
  let enregistrement: { connectionId: string; status: string };
  try {
    enregistrement = await deps.recordConnection({
      userId,
      workspaceId,
      connectorKey,
      credentialRef,
      externalAccountRef: redactedUrl(site.value.siteUrl),
      resourcesRead: rapport.resourcesRead,
      totalProducts: rapport.totalProducts,
      durationMs: duree,
    });
  } catch (erreur) {
    await deps.deleteCredential(credentialRef).catch(() => {});
    return await reponseEnregistrementImpossible(erreur, 'woocommerce', corsOrigin, deps);
  }

  return jsonResponse({
    data: {
      connectorKey,
      status: enregistrement.status,
      connected: true,
      shopName: rapport.storeName,
      siteUrl: rapport.siteUrl,
      totalProducts: rapport.totalProducts,
      totalPages: rapport.totalPages,
      hasVariableProducts: rapport.hasVariableProducts,
      resourcesRead: rapport.resourcesRead,
      connectedTo,
    },
  }, 200, corsOrigin);
}

/** Statut HTTP pour une erreur de sonde Shopify ou WooCommerce. */
function statutPourErreurExterne(erreur: { code: string }): number {
  switch (erreur.code) {
    case 'auth_required':
      return 400;
    case 'auth_invalid':
      return 401;
    case 'insufficient_scope':
    case 'rest_disabled':
      return 403;
    case 'shop_mismatch':
    case 'not_found':
      return 409;
    case 'rate_limited':
      return 429;
    case 'blocked_url':
      return 400;
    case 'dns_failed':
    case 'network_failed':
      return 502;
    case 'not_json':
      return 502;
    default:
      return 502;
  }
}

/**
 * Réponse commune quand l'enregistrement de la connexion échoue.
 *
 * Mutualisé pour Shopify et WooCommerce : la cause est toujours la même
 * (abonnement, droits sur l'entreprise, autre), et deux copies finiraient par
 * diverger.
 */
async function reponseEnregistrementImpossible(
  erreur: unknown,
  connecteur: string,
  corsOrigin: string,
  deps: ConnectDependencies,
): Promise<Response> {
  const message = erreur instanceof Error ? erreur.message : '';
  if (/SUBSCRIPTION_REQUIRED|SUBSCRIPTION_EXPIRED|SUBSCRIPTION_CANCELED/i.test(message)) {
    return jsonResponse(
      failure('SUBSCRIPTION_REQUIRED', 'Un abonnement Business Grow actif et payé est requis pour connecter une boutique.'),
      403, corsOrigin,
    );
  }
  if (/WORKSPACE_ACCESS_DENIED|forbidden/i.test(message)) {
    return jsonResponse(failure('WORKSPACE_ACCESS_DENIED', 'Droits insuffisants sur cette entreprise.'), 403, corsOrigin);
  }
  deps.log?.(`store-connect: enregistrement ${connecteur} impossible`, { erreur: message || 'inconnue' });
  return jsonResponse(failure('CONNECTION_NOT_SAVED', 'La connexion vérifiée n’a pas pu être enregistrée.'), 500, corsOrigin);
}

/* --------------------------------- routeur -------------------------------- */

/**
 * Gestionnaire HTTP.
 *
 * Actions : `connect`, `status`, `preview`, `disconnect`.
 * - `connect` écrit (Vault + table) : abonnement et droits d'écriture exigés.
 * - `status` lit seulement.
 * - `preview` lit le catalogue : même garde que `store-import`, sans écriture.
 * - `disconnect` retire le secret Vault et marque la connexion déconnectée.
 */
export async function handleStoreConnect(
  request: Request,
  deps: ConnectDependencies,
  options: { allowedOrigins: string[] } = { allowedOrigins: [] },
): Promise<Response> {
  const origin = request.headers.get('origin');
  // Motifs (joker compris) plutôt qu'égalité stricte : sinon
  // `https://deploy-preview-*--…` ne correspondait à rien, et la prévisualisation
  // Netlify recevait un CORS refusé.
  const corsOrigin = resolveCorsOrigin(options.allowedOrigins, origin);
  const corsHeaders = {
    'access-control-allow-origin': corsOrigin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'vary': 'origin',
  };

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify(failure('METHOD_NOT_ALLOWED', 'Méthode non autorisée.')), {
      status: 405, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify(failure('INVALID_JSON', 'Corps de requête illisible.')), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return new Response(JSON.stringify(failure('INVALID_JSON', 'Corps de requête illisible.')), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }

  const action = text(body.action, 20);
  if (!['connect', 'status', 'preview', 'disconnect', 'probe-custom', 'save-custom'].includes(action)) {
    return new Response(JSON.stringify(failure('UNKNOWN_ACTION', 'Opération inconnue.')), {
      status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }

  try {
    // 1) Authentification : GoTrue, jamais un en-tête déclaratif.
    const autorisation = request.headers.get('authorization') ?? '';
    const userId = await deps.getUserId(autorisation);
    if (!userId) {
      return new Response(JSON.stringify(failure('UNAUTHENTICATED', 'Session VYORA invalide ou expirée.')), {
        status: 401, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    const workspaceId = uuid(body.workspaceId);
    if (!workspaceId) {
      return new Response(JSON.stringify(failure('INVALID_WORKSPACE', 'Entreprise requise.')), {
        status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // 2) Abonnement : actif ET payé. Contrôlé avant toute lecture réseau ou
    //    écriture, y compris pour `status` — un compte expiré n'a pas à faire
    //    interroger une boutique.
    const acces = await deps.checkImportAccess(userId);
    if (!acces.allowed) {
      const statut = acces.reason === 'SUBSCRIPTION_EXPIRED' || acces.reason === 'SUBSCRIPTION_CANCELED'
        ? 403 : acces.reason === 'NO_SUBSCRIPTION' ? 402 : 403;
      return new Response(JSON.stringify(failure(
        acces.reason || 'SUBSCRIPTION_REQUIRED',
        acces.message || 'Un abonnement Business Grow actif est requis.',
      )), {
        status: statut, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // 3) Entreprise : lue en base, pas reçue du client.
    const grant = await deps.grantWorkspace(userId, workspaceId);
    const ecriture = action === 'connect' || action === 'disconnect' || action === 'save-custom';
    if (ecriture ? !grant.canWrite : !grant.canRead) {
      return new Response(JSON.stringify(failure('WORKSPACE_ACCESS_DENIED', 'Droits insuffisants sur cette entreprise.')), {
        status: 403, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    if (action === 'status') {
      const connecteur = text(body.connectorKey, 40) || 'prestashop';
      if (!CONNECTEURS[connecteur]) {
        return new Response(JSON.stringify(failure('UNKNOWN_CONNECTOR', 'Connecteur inconnu.')), {
          status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      }
      const etat = await deps.readConnection(userId, workspaceId, connecteur);
      return new Response(JSON.stringify({ data: etat }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    if (action === 'disconnect') {
      const connecteur = text(body.connectorKey, 40) || 'prestashop';
      if (!CONNECTEURS[connecteur]) {
        return new Response(JSON.stringify(failure('UNKNOWN_CONNECTOR', 'Connecteur inconnu.')), {
          status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      }
      /*
       * Ordre voulu : le statut en base d'abord, le secret ensuite.
       *
       * Si le secret disparaissait en premier et que l'écriture du statut
       * échouait, la base affirmerait « connecté » sans qu'aucune clé existe —
       * l'utilisateur ne pourrait plus rien importer sans comprendre pourquoi.
       * Dans l'ordre inverse, une suppression de secret ratée laisse au pire un
       * secret orphelin dans Vault : inutilisable, puisqu'aucune connexion ne
       * le désigne plus.
       */
      let etat: Record<string, unknown> | null = null;
      if (typeof deps.markDisconnected === 'function') {
        try {
          await deps.markDisconnected(userId, workspaceId, connecteur);
        } catch (erreur) {
          deps.log?.('store-connect: déconnexion impossible', {
            erreur: erreur instanceof Error ? erreur.message : 'inconnue',
          });
          return new Response(JSON.stringify(failure(
            'DISCONNECT_FAILED',
            'La déconnexion n’a pas pu être enregistrée. Réessayez.',
          )), {
            status: 503, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
          });
        }
      }
      // Le secret est retiré de Vault une fois l'état enregistré.
      await deps.deleteCredential(credentialName(userId, connecteur)).catch(() => {});
      etat = await deps.readConnection(userId, workspaceId, connecteur) as Record<string, unknown> | null;
      return new Response(JSON.stringify({ data: { disconnected: true, connection: etat } }), {
        status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    if (action === 'preview') {
      return await previsualiser(body, { userId, workspaceId, corsOrigin, deps });
    }

    if (action === 'probe-custom') {
      return await sonderApiPersonnalisee(body, { userId, workspaceId, corsOrigin, deps });
    }

    if (action === 'save-custom') {
      return await enregistrerApiPersonnalisee(body, { userId, workspaceId, corsOrigin, deps });
    }

    return await connecter(body, { userId, workspaceId, corsOrigin, deps });
  } catch (erreur) {
    if (erreur instanceof ConnectError) {
      return new Response(JSON.stringify(failure(erreur.code, erreur.message)), {
        status: erreur.status, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }
    deps.log?.('store-connect: erreur interne', {
      erreur: erreur instanceof Error ? erreur.message : 'inconnue',
    });
    return new Response(JSON.stringify(failure(
      'STORE_CONNECT_BACKEND_ERROR',
      'Le service de connexion est temporairement indisponible.',
    )), {
      status: 500, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  }
}

/**
 * `preview` : lit le catalogue PrestaShop et renvoie les produits **normalisés**,
 * sans écrire.
 *
 * La clé n'est jamais redemandée : elle vient du secret Vault associé à la
 * connexion. C'est ce qui permet à l'aperçu de fonctionner sans que le
 * navigateur conserve la clé.
 */
async function previsualiser(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies },
): Promise<Response> {
  const { userId, corsOrigin, deps } = contexte;
  const connectorKey = text(body.connectorKey, 40) || 'prestashop';
  if (!CONNECTEURS[connectorKey]) {
    return jsonResponse(failure('UNKNOWN_CONNECTOR', 'Connecteur inconnu.'), 400, corsOrigin);
  }

  const rawUrl = text(body.url, 500);
  if (!rawUrl) {
    return jsonResponse(failure('URL_REQUIRED', 'L’adresse de la boutique est requise.'), 400, corsOrigin);
  }
  let cible: { target: PrestashopTarget; connectedTo: string };
  try {
    cible = await verifierCible(rawUrl, deps);
  } catch (erreur) {
    if (erreur instanceof ConnectError) {
      return jsonResponse(failure(erreur.code, erreur.message), erreur.status, corsOrigin);
    }
    throw erreur;
  }

  const connecteur = CONNECTEURS[connectorKey];
  if (connecteur.mode === 'hosted-api') {
    return await previsualiserChariow(
      { userId, corsOrigin, deps },
      typeof body.currency === 'string' ? body.currency : undefined,
    );
  }

  const apiKey = await deps.readCredential(userId, connectorKey);
  if (!apiKey) {
    return jsonResponse(
      failure('CONNECTION_REQUIRED', 'Connectez d’abord la boutique : aucune clé n’est enregistrée pour ce connecteur.'),
      409, corsOrigin,
    );
  }

  const resultat = await readPrestashopCatalog(
    cible.target,
    { apiKey },
    { fetchImpl: deps.fetchImpl, pause: async () => {} },
    { defaultCurrency: typeof body.currency === 'string' ? body.currency : undefined },
  );

  if (!resultat.ok) {
    return jsonResponse(failure(resultat.error.code.toUpperCase(), resultat.error.message), statutPourErreur(resultat.error), corsOrigin);
  }

  const catalogue = resultat.value;
  return jsonResponse({
    data: {
      platform: catalogue.platform,
      endpoint: catalogue.endpoint,
      connectedTo: cible.connectedTo,
      currency: catalogue.currency,
      resourcesRead: catalogue.resourcesRead,
      truncated: catalogue.truncated,
      rejected: catalogue.rejected,
      // Les produits sont renvoyés dans la forme brute normalisable : c'est
      // `store-import` qui applique ensuite `normalizeCatalog` et `matchBatch`,
      // pour que le rapprochement reste à UN seul endroit.
      products: catalogue.products,
      count: catalogue.products.length,
    },
  }, 200, corsOrigin);
}

/** Lit un corps de réponse en le plafonnant, sans jamais lever. */
async function capterCorps(reponse: Response): Promise<string> {
  try {
    const texte = await reponse.text();
    // 2 Mio suffisent pour la première page d'un catalogue ; au-delà, ce n'est
    // pas un catalogue mais une erreur de configuration.
    return texte.length > 2 * 1024 * 1024 ? texte.slice(0, 2 * 1024 * 1024) : texte;
  } catch {
    return '';
  }
}

/** Réponse JSON avec les en-têtes CORS déjà calculés par l'appelant. */
function reponseJson(statut: number, corsOrigin: string) {
  return {
    status: statut,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': corsOrigin,
      vary: 'origin',
    },
  };
}

/* ------------------------- API personnalisée (phase D) ---------------------- */
/*
 * Deux actions, dans cet ordre imposé : `probe-custom` vérifie sans rien
 * écrire, `save-custom` enregistre **en s'appuyant sur un test récent**. Le
 * client ne peut pas sauter l'étape 1 : il ne dispose d'aucun moyen de
 * fabriquer la preuve, et la base refuse de toute façon une configuration sans
 * sonde (`PROBE_REQUIRED`).
 *
 * La clé arrive par le corps, part dans Vault, et n'est jamais renvoyée. Aucun
 * journal ne contient ni la clé, ni l'URL complète avec ses paramètres.
 */

interface CiblePersonnalisee {
  baseUrl: string;
  scheme: AuthScheme;
  headerName: string | null;
  productsPath: string;
  pagination: PaginationKind;
  pageSize: number;
  /** Secret fourni à l'instant, ou relu du coffre s'il est absent. */
  secret: string | null;
  /** URL qui a réellement été testée (affichée à l'utilisateur). */
  testedUrl: string;
}

/**
 * Lit et valide la cible décrite par le client.
 *
 * La clé est facultative **ici** : `save-custom` peut enregistrer une
 * configuration dont le secret a déjà été rangé par une sonde précédente.
 * `probe-custom`, lui, exige une clé quand le schéma en réclame une.
 */
function lireCible(
  body: Record<string, unknown>,
  options: { secretRequis: boolean; secretCoffre: string | null },
): CiblePersonnalisee {
  const base = parseCustomApiBaseUrl(text(body.baseUrl, 400));
  if (!base.ok) throw new ConnectError('INVALID_BASE_URL', explainCustomApiRejection(base.reason), 400);

  const scheme = (text(body.authScheme, 10) || 'bearer') as AuthScheme;
  if (!['bearer', 'header', 'basic', 'none'].includes(scheme)) {
    throw new ConnectError('INVALID_AUTH_SCHEME', 'Mode d’authentification non pris en charge.', 400);
  }

  const headerName = scheme === 'header' ? text(body.authHeaderName, 60).toLowerCase() : null;
  if (scheme === 'header' && !headerName) {
    throw new ConnectError('INVALID_AUTH_SCHEME', 'Nom d’en-tête d’authentification requis.', 400);
  }

  const pagination = (text(body.paginationKind, 10) || 'page') as PaginationKind;
  if (!['none', 'page', 'cursor'].includes(pagination)) {
    throw new ConnectError('INVALID_PAGINATION', 'Mode de pagination inconnu.', 400);
  }

  /*
   * Le chemin est stocké **sans** marqueur : les paramètres de pagination sont
   * composés au moment de la requête (`composerChemin`). Exiger `{page}` dans
   * le chemin enregistré aurait obligé l'utilisateur à taper une syntaxe
   * interne — et rendu impossible la simple saisie « /api/products ».
   */
  const cheminBrut = text(body.productsPath, 300) || '/';
  const coherence = paginationCoherente(pagination, composerModele(cheminBrut, pagination));
  if (!coherence.ok) {
    throw new ConnectError('PAGINATION_INCOHERENTE', coherence.message ?? 'Pagination incohérente.', 400);
  }

  const endpoint = parseCustomApiEndpoint(base.value, composerModele(cheminBrut, pagination));
  if (!endpoint.ok) throw new ConnectError('INVALID_ENDPOINT', explainCustomApiRejection(endpoint.reason), 400);

  // La clé du corps prime : elle vient d'être saisie et peut avoir changé.
  const secreteSaisi = text(body.secret, 400);
  const secret = secreteSaisi || options.secretCoffre;
  if (options.secretRequis && scheme !== 'none' && !secret) {
    throw new ConnectError('SECRET_REQUIRED', 'Clé ou jeton requis pour tester cette API.', 400);
  }

  // Un secret dans l'URL serait journalisé par tous les intermédiaires.
  if (secreteSaisi && endpoint.value.url.href.includes(secreteSaisi)) {
    throw new ConnectError('SECRET_IN_URL', 'Ne placez pas la clé dans l’adresse : utilisez l’en-tête d’authentification.', 400);
  }

  const taille = Number(body.pageSize);
  // `new URL` ajoute « / » à une origine nue. On le retire : l'adresse stockée
  // doit être celle que l'utilisateur a saisie, sans décoration.
  const baseNormalisee = base.value.pathname === '/' && !base.value.search
    ? base.value.origin
    : base.value.href.replace(/\/$/, '');
  return {
    baseUrl: baseNormalisee,
    scheme,
    headerName,
    productsPath: cheminBrut,
    pagination,
    pageSize: Number.isFinite(taille) && taille > 0 ? Math.min(Math.floor(taille), 100) : 50,
    secret: scheme === 'none' ? null : secret,
    testedUrl: endpoint.value.url.href,
  };
}

/**
 * Ajoute les marqueurs de pagination au chemin saisi.
 *
 * L'utilisateur indique « /api/products » ; le mode de pagination détermine ce
 * qui est ajouté. Une adresse contenant déjà `{page}` est respectée telle
 * quelle — les APIs qui attendent le numéro dans le chemin existent.
 */
function composerModele(chemin: string, pagination: PaginationKind): string {
  const base = chemin.trim() || '/';
  if (pagination === 'none') return base;
  if (base.includes('{page}') || base.includes('{cursor}') || base.includes('{limit}')) return base;
  const separateur = base.includes('?') ? '&' : '?';
  if (pagination === 'page') return `${base}${separateur}page={page}&limit={limit}`;
  return `${base}${separateur}cursor={cursor}`;
}

/** Remplace les marqueurs d'une première requête : la page 1 n'a pas de curseur. */
function premiereRequete(modele: string, taille: number): string {
  return modele
    .replace('{page}', '1')
    .replace('{limit}', String(taille))
    .replace(/[?&]cursor=\{cursor\}/, '');
}

/** Premier chemin d'un tableau dans une réponse JSON, comme la sonde locale. */
async function sonderApiPersonnalisee(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps } = contexte;

  let secretCoffre: string | null = null;
  try {
    secretCoffre = await deps.readCredential(userId, 'custom-api');
  } catch {
    secretCoffre = null;
  }

  const cible = lireCible(body, { secretRequis: true, secretCoffre });
  const depart = deps.now ? deps.now() : Date.now();

  const police = buildAuthHeaders({
    scheme: cible.scheme,
    // `AuthConfig` attend des champs facultatifs, pas `null` : un `null` ici
    // serait sérialisé en en-tête absent, mais le type doit rester honnête.
    headerName: cible.headerName ?? undefined,
    secret: cible.secret ?? undefined,
  });
  if (police.rejected.length > 0) {
    // Un en-tête refusé donne un 401 incompréhensible côté boutique : on
    // s'arrête ici, avec un motif qui désigne le champ à corriger.
    throw new ConnectError('HEADER_NOT_ALLOWED', 'En-tête ou valeur d’authentification refusé.', 400);
  }
  const entetes: Record<string, string> = { accept: 'application/json' };
  for (const entete of police.headers) entetes[entete.name] = entete.value;

  // La sonde lit la PREMIÈRE page : un curseur vide ferait démarrer l'API au
  // milieu de rien sur certaines implémentations.
  const url = new URL(premiereRequete(cible.testedUrl, cible.pageSize));
  const adresses = await deps.resolveHost(url.hostname);
  const publique = assertPublicAddresses(adresses);
  if (!publique.ok) {
    // Message volontairement générique : il ne doit pas servir de sonde réseau.
    throw new ConnectError('SSRF_BLOCKED', 'Cette adresse n’est pas accessible depuis VYORA.', 400);
  }

  let reponse: Response;
  try {
    reponse = await deps.fetchImpl(url.href, {
      method: 'GET',
      headers: entetes,
      redirect: 'error',
    });
  } catch {
    throw new ConnectError('NETWORK_FAILED', 'La boutique n’a pas répondu. Vérifiez l’adresse.', 502);
  }

  const duree = (deps.now ? deps.now() : Date.now()) - depart;
  // Le corps est lu ici, plafonné, avant analyse : `probeResponse` ne fait
  // aucune entrée-sortie et reste testable sans réseau.
  const texte = await capterCorps(reponse);
  const sonde = probeResponse({
    status: reponse.status,
    contentType: reponse.headers.get('content-type') ?? undefined,
    body: texte,
  }, typeof body.declaredArrayPath === 'string' ? body.declaredArrayPath : undefined);

  deps.log?.('store-connect: sonde api personnalisée', {
    userId, workspaceId,
    hote: url.hostname,
    statut: reponse.status,
    ok: sonde.ok,
    code: sonde.code,
    duree,
  });

  /*
   * Une sonde réussie crée la connexion et range la clé.
   *
   * C'est l'ordre imposé par la base : `bg_save_custom_api_connection` exige
   * qu'une connexion existe avant d'accepter une configuration, et la
   * configuration n'est acceptée qu'après une sonde. Autrement dit, la sonde
   * est le seul moment où la connexion peut naître.
   *
   * Le secret part dans Vault ici : l'utilisateur n'a pas à le ressaisir pour
   * enregistrer, et il n'est plus jamais renvoyé au navigateur ensuite.
   */
  if (sonde.ok) {
    let credentialRef: string | null = null;
    if (cible.secret) {
      credentialRef = await deps.storeCredential({
        userId, connectorKey: 'custom-api', secret: cible.secret,
      });
    }
    if (credentialRef) {
      await deps.recordConnection({
        userId,
        workspaceId,
        connectorKey: 'custom-api',
        credentialRef,
        externalAccountRef: url.hostname,
        // `catalog` est la seule ressource lue : la sonde n'a demandé que des
        // produits.
        resourcesRead: ['catalog'],
        totalProducts: sonde.count ?? null,
        durationMs: duree,
      }).catch((erreur) => {
        deps.log?.('store-connect: connexion non enregistrée après sonde', {
          erreur: erreur instanceof Error ? erreur.message : 'inconnue',
        });
      });
    }
  }

  // Aucune trace d'échec n'est écrite à ce stade : une sonde ratée pendant la
  // configuration n'est pas un incident de connexion, et l'import n'a pas
  // encore eu lieu.
  return new Response(JSON.stringify({
    data: {
      probe: sonde,
      status: reponse.status,
      productsFound: sonde.count ?? 0,
      durationMs: duree,
      // L'URL testée, pour que l'utilisateur voie exactement ce qui a été lu.
      testedPath: `${url.pathname}${url.search}`,
      host: url.hostname,
    },
  }), reponseJson(200, corsOrigin));
}

/**
 * Enregistre une configuration d'API personnalisée.
 *
 * La configuration n'est acceptée que si le même client vient de réussir une
 * sonde : `probeStatus` et `productsFound` sont comparés aux valeurs
 * attendues, et la base applique `PROBE_REQUIRED`.
 */
async function enregistrerApiPersonnalisee(
  body: Record<string, unknown>,
  contexte: { userId: string; workspaceId: string; corsOrigin: string; deps: ConnectDependencies },
): Promise<Response> {
  const { userId, workspaceId, corsOrigin, deps } = contexte;

  const sondeStatut = Number(body.probeStatus);
  if (!Number.isFinite(sondeStatut) || sondeStatut !== 200) {
    throw new ConnectError(
      'PROBE_REQUIRED',
      'Testez l’API avec succès avant d’enregistrer cette configuration.',
      400,
    );
  }

  let secretCoffre: string | null = null;
  try {
    secretCoffre = await deps.readCredential(userId, 'custom-api');
  } catch {
    secretCoffre = null;
  }

  const cible = lireCible(body, { secretRequis: false, secretCoffre });
  const depart = deps.now ? deps.now() : Date.now();

  // 1) La clé d'abord. Sans elle, enregistrer une configuration « connectée »
  //    afficherait une connexion qui ne peut rien lire.
  let credentialRef: string | null = null;
  if (cible.secret) {
    credentialRef = await deps.storeCredential({
      userId, connectorKey: 'custom-api', secret: cible.secret,
    });
  } else if (deps.readCredentialRef) {
    credentialRef = await deps.readCredentialRef(userId, 'custom-api');
  }
  if (!credentialRef) {
    throw new ConnectError(
      'SECRET_REQUIRED',
      'Aucune clé n’est enregistrée pour cette API : saisissez-la avant d’enregistrer.',
      400,
    );
  }

  const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {};

  /*
   * 2) L'enregistrement passe par `bg_save_custom_api_connection`, qui délègue
   *    elle-même à `bg_connect_integration` : contrôle d'appartenance à
   *    l'entreprise, abonnement payant, validation du connecteur, journal de
   *    vérification. Appeler `recordConnection` ici aurait doublé cette
   *    écriture — et fait échouer la RPC, qui exige que la connexion existe
   *    AVANT la configuration.
   */
  const ecriture = await deps.saveCustomApiConfig?.({
    userId,
    workspaceId,
    credentialRef,
    baseUrl: cible.baseUrl,
    authScheme: cible.scheme,
    authHeaderName: cible.headerName,
    productsPath: cible.productsPath,
    paginationKind: cible.pagination,
    pageSize: cible.pageSize,
    maxPages: Number.isFinite(Number(body.maxPages)) ? Math.min(Math.max(Number(body.maxPages), 1), 200) : 20,
    mapping: mapping as Record<string, unknown>,
    priceUnit: text(body.priceUnit, 10) === 'minor' ? 'minor' : 'major',
    currency: (text(body.currency, 3) || 'XOF').toUpperCase(),
    probeSummary: text(body.probeSummary, 400),
    probeStatus: sondeStatut,
    productsFound: Number(body.productsFound) || 0,
    durationMs: (deps.now ? deps.now() : Date.now()) - depart,
  });
  if (!ecriture || ecriture.ok === false) {
    throw new ConnectError(
      ecriture?.code ?? 'CUSTOM_API_SAVE_FAILED',
      ecriture?.message ?? 'La configuration n’a pas pu être enregistrée.',
      400,
    );
  }

  return new Response(JSON.stringify({
    data: {
      saved: true,
      connectionId: ecriture.connectionId ?? null,
      status: 'connected',
      baseUrl: cible.baseUrl,
      mappingFields: Object.keys(mapping).length,
    },
  }), reponseJson(200, corsOrigin));
}

export { classifyStatus };
export type { PrestashopProbe };
