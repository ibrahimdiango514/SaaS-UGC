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
 * 2. Abonnement Business Ground **actif et payé** (`bg_import_access`).
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

/** Le connecteur dont on vérifie la connexion. Un seul pour l'instant. */
const CONNECTEURS: Record<string, { platform: CatalogPlatform; label: string }> = {
  prestashop: { platform: 'prestashop', label: 'PrestaShop' },
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
        failure('SUBSCRIPTION_REQUIRED', 'Un abonnement Business Ground actif et payé est requis pour connecter une boutique.'),
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
    duree: number; erreur: PrestashopError; phase: string;
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
  const origin = request.headers.get('origin') ?? '';
  const corsOrigin = options.allowedOrigins.includes(origin) ? origin : 'null';
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
  if (!['connect', 'status', 'preview', 'disconnect'].includes(action)) {
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
        acces.message || 'Un abonnement Business Ground actif est requis.',
      )), {
        status: statut, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // 3) Entreprise : lue en base, pas reçue du client.
    const grant = await deps.grantWorkspace(userId, workspaceId);
    const ecriture = action === 'connect' || action === 'disconnect';
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

export { classifyStatus };
export type { PrestashopProbe };
