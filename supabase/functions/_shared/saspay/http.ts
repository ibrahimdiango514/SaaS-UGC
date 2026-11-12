// VYORA — couche HTTP des Edge Functions de paiement.
//
// Deux gestionnaires :
//   * `createPaymentsHandler` : appels du navigateur (JWT utilisateur requis).
//   * `createWebhookHandler`  : appels de SasPay (signature HMAC requise).
// Ce fichier ne dépend pas de Deno : les deux gestionnaires sont testables tels
// quels (Request → Response).

import { createSasPayClient } from './client.ts';
import {
  PaymentError, createPaymentService, safeErrorMessage,
  type OrderRecord, type PaymentService, type PaymentUser,
} from './payments.ts';
import { createSupabasePaymentStore } from './store.ts';

export interface PaymentsEnv {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Clé secrète SasPay. Lue uniquement côté serveur. */
  sasPaySecretKey: string;
  /** Secret de signature du webhook VYORA (propre à ce point de terminaison). */
  webhookSecret: string;
  /** Origines supplémentaires autorisées, séparées par des virgules. */
  extraOrigins: string;
}

type EnvReader = (key: string) => string;

export function readPaymentsEnv(get: EnvReader): PaymentsEnv {
  return {
    supabaseUrl: get('SUPABASE_URL'),
    anonKey: get('SUPABASE_ANON_KEY'),
    serviceRoleKey: get('SUPABASE_SERVICE_ROLE_KEY'),
    // Clé DÉDIÉE à VYORA. Aucun repli sur `SASPAY_SECRET_KEY` : cette variable
    // appartient à un autre produit hébergé sur le même projet et ne doit jamais
    // servir à encaisser pour VYORA par simple oubli de configuration.
    sasPaySecretKey: get('VYORA_SASPAY_SECRET_KEY').trim(),
    // Chaque webhook SasPay possède son propre secret : celui de VYORA n'est pas
    // celui d'un autre produit hébergé sur le même projet.
    webhookSecret: get('VYORA_SASPAY_WEBHOOK_SECRET').trim(),
    extraOrigins: get('VYORA_PAYMENTS_ALLOWED_ORIGINS'),
  };
}

const STATIC_ORIGINS = new Set([
  'https://vyora-ugc.netlify.app',
  'http://localhost:5173', 'http://localhost:4173',
  'http://127.0.0.1:5173', 'http://127.0.0.1:4173',
]);
// Aucun domaine générique (bac à sable, hébergeur partagé) n'est admis d'office :
// l'origine sert aussi à construire l'adresse de retour après paiement. Une
// origine supplémentaire se déclare, exacte, dans VYORA_PAYMENTS_ALLOWED_ORIGINS.
const ORIGIN_PATTERNS = [
  /^https:\/\/deploy-preview-\d+--vyora-ugc\.netlify\.app$/,
  /^https:\/\/deploy-preview-\d+--vyora\.netlify\.app$/,
];

export function isAllowedOrigin(origin: string, extraOrigins = ''): boolean {
  if (!origin) return false;
  if (STATIC_ORIGINS.has(origin)) return true;
  if (ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return true;
  return extraOrigins.split(',').map((value) => value.trim()).filter(Boolean).includes(origin);
}

function log(event: string, details: Record<string, unknown> = {}): void {
  // Journal structuré : jamais de clé, de jeton ni de numéro complet.
  console.log(JSON.stringify({ scope: 'vyora-payments', event, ...details }));
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function failure(error: unknown, headers: Record<string, string> = {}): Response {
  if (error instanceof PaymentError) {
    return json({ error: { code: error.code, message: error.message, ...error.details } }, error.status, headers);
  }
  log('unexpected_error', { message: safeErrorMessage(error) });
  return json({ error: { code: 'PAYMENT_INTERNAL_ERROR', message: 'Une erreur inattendue est survenue. Aucun débit n’a été effectué par VYORA.' } }, 500, headers);
}

export interface HandlerDeps {
  env: PaymentsEnv;
  fetcher?: typeof fetch;
  now?: () => number;
  /** Injection de test : remplace le service construit à partir de l'environnement. */
  service?: PaymentService;
}

function buildService(deps: HandlerDeps): PaymentService {
  if (deps.service) return deps.service;
  const fetcher = deps.fetcher ?? fetch;
  return createPaymentService({
    store: createSupabasePaymentStore({
      supabaseUrl: deps.env.supabaseUrl, serviceRoleKey: deps.env.serviceRoleKey, fetcher, log,
    }),
    client: deps.env.sasPaySecretKey ? createSasPayClient({ secretKey: deps.env.sasPaySecretKey, fetcher }) : null,
    webhookSecret: deps.env.webhookSecret || null,
    now: deps.now ?? Date.now,
    log,
  });
}

async function authenticate(request: Request, deps: HandlerDeps): Promise<PaymentUser> {
  const authorization = request.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(authorization)) {
    throw new PaymentError('PAYMENT_UNAUTHENTICATED', 401, 'Session expirée, veuillez vous reconnecter.');
  }
  const fetcher = deps.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${deps.env.supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: { apikey: deps.env.anonKey, Authorization: authorization },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new PaymentError('PAYMENT_AUTH_UNAVAILABLE', 503, 'Vérification de session momentanément impossible. Réessayez.');
  }
  if (!response.ok) {
    throw new PaymentError('PAYMENT_UNAUTHENTICATED', 401, 'Session expirée, veuillez vous reconnecter.');
  }
  const user = await response.json().catch(() => null) as {
    id?: unknown; email?: unknown; user_metadata?: Record<string, unknown> | null;
  } | null;
  if (!user || typeof user.id !== 'string') {
    throw new PaymentError('PAYMENT_UNAUTHENTICATED', 401, 'Session expirée, veuillez vous reconnecter.');
  }
  const meta = user.user_metadata ?? {};
  const name = [meta.display_name, meta.full_name, meta.name].find((value) => typeof value === 'string' && value.trim());
  return { id: user.id, email: typeof user.email === 'string' ? user.email : null, name: typeof name === 'string' ? name : null };
}

/** Gestionnaire appelé par le navigateur : `POST { action, … }`. */
export function createPaymentsHandler(deps: HandlerDeps) {
  const service = buildService(deps);

  return async function handler(request: Request): Promise<Response> {
    const origin = request.headers.get('origin') ?? '';
    const allowed = isAllowedOrigin(origin, deps.env.extraOrigins);
    const cors: Record<string, string> = { Vary: 'Origin' };
    if (allowed) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type, x-client-info';
      cors['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      cors['Access-Control-Max-Age'] = '86400';
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    // Un navigateur d'une origine inconnue est refusé ; un appel serveur à serveur
    // (sans en-tête Origin) reste soumis au JWT.
    if (origin && !allowed) {
      return json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origine non autorisée.' } }, 403, cors);
    }
    if (request.method !== 'POST') {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' } }, 405, cors);
    }

    try {
      const user = await authenticate(request, deps);
      let body: Record<string, unknown>;
      try {
        const parsed = await request.json();
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not_object');
        body = parsed as Record<string, unknown>;
      } catch {
        throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Requête invalide.');
      }

      switch (body.action) {
        case 'options':
          return json(await service.options(user, { product: body.product, item: body.item }), 200, cors);
        case 'create': {
          const returnUrl = (order: OrderRecord) => (allowed
            ? `${origin}/app/paiement/retour?produit=${order.product}&commande=${order.id}`
            : null);
          return json(await service.create(user, {
            product: body.product, item: body.item, country: body.country, flow: body.flow,
            network: body.network, phone: body.phone, idempotency_key: body.idempotency_key,
          }, { returnUrl }), 200, cors);
        }
        case 'status':
          return json(await service.refresh(user, { product: body.product, order_id: body.order_id }), 200, cors);
        case 'balances':
          return json(await service.balances(user), 200, cors);
        default:
          throw new PaymentError('PAYMENT_INVALID_REQUEST', 400, 'Action inconnue.');
      }
    } catch (error) {
      return failure(error, cors);
    }
  };
}

/** Gestionnaire appelé par SasPay. Aucune session : la signature fait foi. */
export function createWebhookHandler(deps: HandlerDeps) {
  const service = buildService(deps);

  return async function handler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' } }, 405);
    }
    try {
      // Corps BRUT : la signature porte sur les octets reçus, jamais sur un JSON re-sérialisé.
      const rawBody = await request.text();
      if (rawBody.length > 65_536) {
        throw new PaymentError('WEBHOOK_INVALID_BODY', 413, 'Corps de webhook trop volumineux.');
      }
      return json(await service.webhook(rawBody, {
        signature: request.headers.get('x-webhook-signature'),
        timestamp: request.headers.get('x-webhook-timestamp'),
      }), 200);
    } catch (error) {
      return failure(error);
    }
  };
}

/**
 * Gestionnaire appelé par la tâche planifiée (pg_cron → pg_net). Aucune session :
 * l'en-tête dédié puis le jeton serveur (Vault) font foi. Aucun paramètre n'est lu
 * dans la requête hormis l'étiquette de provenance.
 */
export function createReconcileHandler(deps: HandlerDeps) {
  const service = buildService(deps);

  return async function handler(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Méthode non autorisée.' } }, 405);
    }
    // Refus avant toute lecture en base : une requête anonyme ne coûte rien.
    if (request.headers.get('x-vyora-cron') !== 'payments-reconcile') {
      return json({ error: { code: 'CRON_FORBIDDEN', message: 'Appel non autorisé.' } }, 403);
    }
    const presented = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    try {
      if (!(await service.isCronToken(presented))) {
        return json({ error: { code: 'CRON_UNAUTHORIZED', message: 'Jeton invalide.' } }, 401);
      }
      const body = await request.json().catch(() => null) as { source?: unknown } | null;
      const source = body && typeof body.source === 'string' && /^[a-z_-]{1,20}$/.test(body.source) ? body.source : 'cron';
      return json(await service.reconcile({ source }), 200);
    } catch (error) {
      return failure(error);
    }
  };
}
