// VYORA — client SasPay (serveur uniquement).
//
// Seules des routes présentes dans la spécification OpenAPI officielle sont
// appelées (https://docs.saspay.me/api-reference/openapi.json) :
//   POST /payments/softpay/                 (Idempotency-Key pris en charge)
//   POST /checkout-sessions/                (Idempotency-Key NON pris en charge)
//   GET  /checkout-sessions/{id}/status/
//   GET  /payments/{payment_id}/verify/
//   GET  /pricing/my-rates/
//   GET  /merchant-balances/                (lecture seule)
//   GET  /transactions/                     (lecture seule, pagination par curseur)
//
// La spécification ne décrit la RÉPONSE de `GET /transactions/` que par un
// exemple, sans schéma : aucun champ n'y est garanti. Les paramètres de requête,
// eux, sont spécifiés (`status`, `transaction_type`, `created_at__gte`,
// `page_size` ≤ 200, `cursor`). Voir `listSuccessfulPayments`.
//
// Aucun décaissement, aucun transfert, aucune « recharge » : ces routes ne sont
// pas implémentées. La clé secrète n'apparaît jamais dans un message d'erreur.

export const SASPAY_API_BASE = 'https://api.saspay.me/api/v1';

export type SasPayErrorKind =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'gone' | 'unprocessable' | 'rate_limited' | 'provider_unavailable'
  | 'provider_unreachable' | 'invalid_response';

export class SasPayError extends Error {
  readonly status: number;
  readonly kind: SasPayErrorKind;
  /** Code métier renvoyé par SasPay (`invalid_method`, `not_pending`…), sinon le genre. */
  readonly code: string;
  /** Vrai si la même requête peut être rejouée sans risque (avec la même clé d'idempotence). */
  readonly retryable: boolean;
  /** Vrai si l'on est certain qu'aucun paiement n'a été créé par cette requête. */
  readonly definitive: boolean;

  constructor(status: number, kind: SasPayErrorKind, code: string, message: string) {
    super(redactSecrets(message));
    this.name = 'SasPayError';
    this.status = status;
    this.kind = kind;
    this.code = code;
    this.retryable = kind === 'conflict' || kind === 'rate_limited'
      || kind === 'provider_unavailable' || kind === 'provider_unreachable' || kind === 'invalid_response';
    this.definitive = kind === 'bad_request' || kind === 'unauthorized' || kind === 'forbidden'
      || kind === 'not_found' || kind === 'gone' || kind === 'unprocessable';
  }
}

const SECRET_PATTERN = /sk_(?:test|live)_[A-Za-z0-9_-]+/g;

/** Masque toute clé SasPay qui se serait glissée dans un texte destiné aux journaux. */
export function redactSecrets(text: string): string {
  return String(text ?? '').replace(SECRET_PATTERN, 'sk_***');
}

/** `test`, `live` ou `unknown` — déduit du préfixe, sans jamais exposer la clé. */
export function keyMode(secretKey: string): 'test' | 'live' | 'unknown' {
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function kindForStatus(status: number): SasPayErrorKind {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'bad_request';
}

/** Extrait (code, message) d'un corps d'erreur, avec ou sans enveloppe `{success:false,error}`. */
function readError(body: unknown, fallback: string): { code: string; message: string } {
  if (!isRecord(body)) return { code: fallback, message: fallback };
  const error = body.error;
  if (isRecord(error)) {
    if (typeof error.code === 'string' || typeof error.message === 'string') {
      return {
        code: typeof error.code === 'string' && error.code ? error.code : fallback,
        message: typeof error.message === 'string' && error.message ? error.message : fallback,
      };
    }
    // Erreurs de validation par champ : { champ: [message, …] }.
    const fields = Object.keys(error).slice(0, 6).join(', ');
    return { code: 'validation_error', message: fields ? `Champs refusés : ${fields}` : fallback };
  }
  if (typeof error === 'string' && error) return { code: fallback, message: error };
  const code = typeof body.code === 'string' && body.code ? body.code : fallback;
  const message = typeof body.message === 'string' && body.message
    ? body.message
    : typeof body.detail === 'string' && body.detail ? body.detail : fallback;
  return { code, message };
}

/** Accepte les deux formes documentées : `{success:true,data}` ou la ressource nue. */
function unwrap(body: unknown): unknown {
  if (isRecord(body) && typeof body.success === 'boolean' && 'data' in body) return body.data;
  return body;
}

export interface SasPayCustomer {
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
}

export interface SoftpayRequest {
  amount: string;
  currency: string;
  country: string;
  network: string;
  customer: SasPayCustomer;
  description?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutSessionRequest {
  amount: string;
  currency: string;
  customer_email: string;
  customer_name: string;
  description?: string;
  country?: string;
  customer_phone?: string;
  return_url?: string;
  metadata?: Record<string, string>;
}

export const TRANSACTION_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'] as const;
export type TransactionStatus = typeof TRANSACTION_STATUSES[number];

export const CHECKOUT_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED'] as const;
export type CheckoutStatus = typeof CHECKOUT_STATUSES[number];

export interface SoftpayResult { id: string; status: string; checkout_url: string | null }
export interface CheckoutSessionResult { id: string; status: string; checkout_url: string }
export interface CheckoutStatusResult {
  id: string;
  status: CheckoutStatus;
  transaction_id: string | null;
  transaction_status: string | null;
  transaction_reference: string | null;
}
export interface VerifiedPayment {
  id: string;
  status: TransactionStatus;
  reference: string | null;
  requested_amount: string | null;
  currency: string | null;
  fee_charge_mode: string | null;
  client_fee: string | null;
  debited_amount: string | null;
  net_amount: string | null;
}
export interface MerchantBalance {
  id: string;
  country: string;
  currency: string;
  available_amount: string;
  pending_amount: string;
  is_frozen: boolean;
  updated_at: string | null;
}

/** Transaction telle que listée par SasPay. Sert à REPÉRER un paiement, jamais à le croire. */
export interface ListedTransaction {
  id: string;
  description: string | null;
  reference: string | null;
  created_at: string | null;
}
export interface TransactionListing {
  transactions: ListedTransaction[];
  /** Vrai si SasPay avait encore des pages au-delà de la limite demandée. */
  truncated: boolean;
  /**
   * Nombre de transactions listées dont la réponse portait un champ
   * `description`. La spécification OpenAPI ne garantit pas ce champ (il
   * n'apparaît que dans un exemple) : s'il vaut 0 alors que des transactions
   * sont listées, le rapprochement par référence est AVEUGLE.
   */
  described: number;
}

export interface SasPayClientOptions {
  secretKey: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface SasPayClient {
  mode: 'test' | 'live' | 'unknown';
  softpay(body: SoftpayRequest, idempotencyKey: string): Promise<SoftpayResult>;
  createCheckoutSession(body: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
  checkoutStatus(sessionId: string): Promise<CheckoutStatusResult>;
  verifyPayment(paymentId: string): Promise<VerifiedPayment>;
  myRates(): Promise<Json[]>;
  merchantBalances(): Promise<MerchantBalance[]>;
  /** Encaissements réussis depuis une date (lecture seule, pagination par curseur). */
  listSuccessfulPayments(options: { createdAfter: string; maxPages?: number; pageSize?: number }): Promise<TransactionListing>;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export function createSasPayClient(options: SasPayClientOptions): SasPayClient {
  const secretKey = options.secretKey.trim();
  const baseUrl = (options.baseUrl ?? SASPAY_API_BASE).replace(/\/+$/, '');
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function request(method: 'GET' | 'POST', path: string, body?: Json, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey.slice(0, 255);

    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Délai dépassé ou réseau : on ignore si SasPay a traité la requête.
      throw new SasPayError(0, 'provider_unreachable', 'provider_unreachable', 'SasPay est injoignable');
    }

    let parsed: unknown = null;
    try {
      const raw = await response.text();
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const kind = kindForStatus(response.status);
      const { code, message } = readError(parsed, kind);
      throw new SasPayError(response.status, kind, code, message);
    }
    if (isRecord(parsed) && parsed.success === false) {
      const { code, message } = readError(parsed, 'bad_request');
      throw new SasPayError(response.status, 'bad_request', code, message);
    }
    return unwrap(parsed);
  }

  function record(value: unknown, where: string): Json {
    if (!isRecord(value)) {
      throw new SasPayError(200, 'invalid_response', 'invalid_response', `Réponse SasPay inattendue (${where})`);
    }
    return value;
  }

  function requiredId(value: unknown, where: string): string {
    const id = text(value);
    if (!id || id.length > 80) {
      throw new SasPayError(200, 'invalid_response', 'invalid_response', `Identifiant SasPay absent (${where})`);
    }
    return id;
  }

  return {
    mode: keyMode(secretKey),

    async softpay(body, idempotencyKey) {
      const data = record(await request('POST', '/payments/softpay/', body as unknown as Json, idempotencyKey), 'softpay');
      return {
        id: requiredId(data.id, 'softpay'),
        status: (text(data.status) ?? 'PENDING').toUpperCase(),
        checkout_url: httpsUrl(data.checkout_url),
      };
    },

    async createCheckoutSession(body) {
      const data = record(await request('POST', '/checkout-sessions/', body as unknown as Json), 'checkout');
      const checkoutUrl = httpsUrl(data.checkout_url);
      if (!checkoutUrl) {
        throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Lien de paiement SasPay absent');
      }
      return {
        id: requiredId(data.id, 'checkout'),
        status: (text(data.status) ?? 'PENDING').toUpperCase(),
        checkout_url: checkoutUrl,
      };
    },

    async checkoutStatus(sessionId) {
      const data = record(
        await request('GET', `/checkout-sessions/${encodeURIComponent(sessionId)}/status/`),
        'checkout-status',
      );
      const status = (text(data.status) ?? '').toUpperCase();
      if (!(CHECKOUT_STATUSES as readonly string[]).includes(status)) {
        throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Statut de session SasPay inconnu');
      }
      return {
        id: requiredId(data.id ?? sessionId, 'checkout-status'),
        status: status as CheckoutStatus,
        transaction_id: text(data.transaction_id),
        transaction_status: text(data.transaction_status)?.toUpperCase() ?? null,
        transaction_reference: text(data.transaction_reference),
      };
    },

    async verifyPayment(paymentId) {
      const data = record(
        await request('GET', `/payments/${encodeURIComponent(paymentId)}/verify/`),
        'verify',
      );
      const status = (text(data.status) ?? '').toUpperCase();
      // Un statut non documenté n'est jamais interprété : il bloque la livraison.
      if (!(TRANSACTION_STATUSES as readonly string[]).includes(status)) {
        throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Statut de paiement SasPay inconnu');
      }
      return {
        id: requiredId(data.id, 'verify'),
        status: status as TransactionStatus,
        reference: text(data.reference),
        requested_amount: text(data.requested_amount),
        currency: text(data.currency)?.toUpperCase() ?? null,
        fee_charge_mode: text(data.fee_charge_mode),
        client_fee: text(data.client_fee),
        debited_amount: text(data.debited_amount),
        net_amount: text(data.net_amount),
      };
    },

    async myRates() {
      const data = await request('GET', '/pricing/my-rates/');
      const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : null;
      if (!rows) {
        throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Grille tarifaire SasPay inattendue');
      }
      return rows.filter(isRecord);
    },

    async merchantBalances() {
      const balances: MerchantBalance[] = [];
      // Pagination documentée : { count, next, previous, results }, 100 par page.
      for (let page = 1; page <= 5; page += 1) {
        const data = await request('GET', `/merchant-balances/?page=${page}&page_size=100`);
        const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : null;
        if (!rows) {
          throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Soldes SasPay inattendus');
        }
        for (const row of rows.filter(isRecord)) {
          balances.push({
            id: text(row.id) ?? '',
            country: (text(row.country) ?? '').toUpperCase(),
            currency: (text(row.currency) ?? '').toUpperCase(),
            available_amount: text(row.available_amount) ?? '0.00',
            pending_amount: text(row.pending_amount) ?? '0.00',
            is_frozen: row.is_frozen === true,
            updated_at: text(row.updated_at),
          });
        }
        if (Array.isArray(data) || !isRecord(data) || !data.next) break;
      }
      return balances;
    },

    async listSuccessfulPayments({ createdAfter, maxPages = 5, pageSize = 200 }) {
      const query = new URLSearchParams({
        status: 'SUCCESS', transaction_type: 'PAIEMENT', created_at__gte: createdAfter,
        page_size: String(Math.min(Math.max(Math.trunc(pageSize), 1), 200)),
      });
      const transactions: ListedTransaction[] = [];
      let described = 0;
      let path: string | null = `/transactions/?${query.toString()}`;
      for (let page = 0; path && page < Math.max(maxPages, 1); page += 1) {
        const data = await request('GET', path);
        const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.results) ? data.results : null;
        if (!rows) {
          throw new SasPayError(200, 'invalid_response', 'invalid_response', 'Liste de transactions SasPay inattendue');
        }
        for (const row of rows.filter(isRecord)) {
          const id = text(row.id);
          if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) continue;
          // Les filtres sont réappliqués ici : on ne dépend pas de leur respect par l'API.
          if ((text(row.status) ?? '').toUpperCase() !== 'SUCCESS') continue;
          const direction = (text(row.flow_direction) ?? 'INBOUND').toUpperCase();
          if (direction !== 'INBOUND') continue;
          // Champ PRÉSENT dans la réponse (même vide) : l'API expose bien le libellé.
          if (Object.prototype.hasOwnProperty.call(row, 'description')) described += 1;
          transactions.push({
            id,
            description: text(row.description)?.slice(0, 300) ?? null,
            reference: text(row.reference),
            created_at: text(row.created_at),
          });
        }
        path = nextPagePath(isRecord(data) ? data.next : null, baseUrl);
      }
      return { transactions, truncated: path !== null, described };
    },
  };
}

/**
 * Chemin de la page suivante. Le curseur est une adresse absolue fournie par
 * SasPay : elle n'est suivie que si elle reste sur l'API SasPay configurée —
 * la clé secrète n'est jamais envoyée ailleurs.
 */
export function nextPagePath(next: unknown, baseUrl: string): string | null {
  if (typeof next !== 'string' || !next) return null;
  const prefix = `${baseUrl.replace(/\/+$/, '')}/`;
  if (!next.startsWith(prefix)) return null;
  const path = next.slice(prefix.length - 1);
  return path.startsWith('/transactions/') ? path : null;
}
