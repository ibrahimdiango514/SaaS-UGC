import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../lib/supabase';

const NETLIFY_PREVIEW_HOST_PATTERN = /^deploy-preview-\d+--[a-z0-9-]+\.netlify\.app$/i;

function currentHostname(): string {
  return typeof window !== 'undefined' && typeof window.location?.hostname === 'string'
    ? window.location.hostname.toLowerCase()
    : '';
}

function isNetlifyDeployPreview(): boolean {
  return NETLIFY_PREVIEW_HOST_PATTERN.test(currentHostname());
}

function isNetlifyHost(): boolean {
  return currentHostname().endsWith('.netlify.app');
}

function localFunctionUrl(): string | null {
  if (!import.meta.env.DEV) return null;
  const configured = (import.meta.env as Record<string, string | undefined>)
    .VITE_BUSINESS_GROW_FUNCTION_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (
      url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.port === '54321'
      && url.pathname === '/functions/v1/business-grow'
    ) return url.toString();
  } catch {
    throw new BusinessGrowApiError(
      'VITE_BUSINESS_GROW_FUNCTION_URL doit cibler la fonction Supabase locale sur localhost:54321.',
      'INVALID_LOCAL_FUNCTION_URL',
    );
  }
  throw new BusinessGrowApiError(
    'VITE_BUSINESS_GROW_FUNCTION_URL doit cibler la fonction Supabase locale sur localhost:54321.',
    'INVALID_LOCAL_FUNCTION_URL',
  );
}

export interface BusinessConversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  last_message?: string | null;
}

export interface BusinessMessage {
  id: string;
  author_role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: string;
  request_status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null;
  request_error_code?: string | null;
  request_provider_key?: string | null;
  request_model_key?: string | null;
}

export interface BusinessMemoryItem {
  id: string;
  category: string;
  content: unknown;
  created_at: string;
  updated_at: string;
}

export interface BusinessMemory {
  consent: boolean;
  policyVersion: string | null;
  profile: Record<string, unknown> | null;
  items: BusinessMemoryItem[];
}

export interface BusinessProviderStatus {
  provider_key: string;
  display_name: string;
  enabled: boolean;
  status: 'unverified' | 'available' | 'degraded' | 'unavailable';
  config_status: 'missing' | 'configured' | 'error';
  checked_at: string | null;
  verified_model_keys?: string[];
  error_code?: string | null;
}

export interface BusinessModelRecord {
  provider_key: string;
  model_key: string;
  provider_model_key: string;
  display_name: string;
  capabilities: Record<string, unknown>;
  enabled: boolean;
  verification_status: 'unverified' | 'verified' | 'unavailable';
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  verified_at: string | null;
  error_code?: string | null;
}

export interface BusinessQuotaStatus {
  domain: 'business_grow';
  studio_ugc_untouched: boolean;
  available_units: number | null;
  reserved_units: number;
  monthly_allowance: number | null;
  period_key?: string;
  period_used?: number;
  lifetime_consumed?: number;
}

export interface BusinessToolExecution {
  id: string;
  conversation_id: string;
  request_id: string | null;
  tool_name: string;
  risk_level: 'read_only' | 'write_requires_approval' | 'external_publish_requires_approval';
  status: 'pending_approval' | 'approved' | 'rejected' | 'executed' | 'failed';
  input_args: Record<string, unknown>;
  output_result: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
}

export interface BusinessVerificationResult {
  providerKey: string;
  modelKey: string;
  status: 'healthy' | 'failed';
  latencyMs: number;
  errorCode: string | null;
  availableModels: string[];
}

export interface BusinessRoutingPreference {
  id?: string;
  roleKey: string;
  selectionMode: 'auto' | 'manual';
  preferredProviderKey: string | null;
  preferredModelKey: string | null;
  allowFallback: boolean;
}

export interface BusinessIntegrationConnection {
  id: string;
  workspace_id: string | null;
  connector_key: string;
  external_account_ref: string | null;
  status: 'unconfigured' | 'pending' | 'connected' | 'disconnected' | 'error';
  updated_at: string;
}

export interface BusinessSendOptions {
  roleKey?: string;
  workspaceId?: string | null;
  routing?: {
    selectionMode?: 'auto' | 'manual';
    preferredProviderKey?: string | null;
    preferredModelKey?: string | null;
    allowFallback?: boolean;
  };
}

export class BusinessGrowApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BusinessGrowApiError';
  }
}

const NETLIFY_RELAY_ENDPOINTS = ['/api/business-grow', '/.netlify/functions/business-grow'];

/** URL de la fonction Edge, dérivée de la configuration Supabase publique. */
function edgeFunctionUrl(): string {
  return `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/business-grow`;
}

type TransportOutcome<T> =
  | { kind: 'data'; value: T }
  | { kind: 'retry'; reason: string }
  | { kind: 'fatal'; error: BusinessGrowApiError };

/**
 * Interprète une réponse HTTP de la fonction. Un 404 sur une *fonction* signifie
 * qu'aucun relais/point d'entrée n'est monté à cette adresse (repli légitime) ;
 * partout ailleurs c'est une vraie erreur applicative qu'il ne faut pas masquer.
 */
async function readFunctionResponse<T>(response: Response): Promise<TransportOutcome<T>> {
  const contentType = (response.headers?.get('Content-Type') ?? '').toLowerCase();
  if (contentType.includes('text/html')) {
    return { kind: 'retry', reason: `HTML ${response.status}` };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: 'retry', reason: `JSON invalide ${response.status}` };
  }
  if (response.status === 404) {
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const error = body.error && typeof body.error === 'object'
      ? body.error as Record<string, unknown>
      : {};
    // 404 métier renvoyé par la fonction (ex. MEMORY_ITEM_NOT_FOUND) : à propager.
    if (typeof error.code === 'string' && error.code !== 'NOT_FOUND') {
      return { kind: 'fatal', error: toApiError(payload, response.status) };
    }
    return { kind: 'retry', reason: '404 sans fonction' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'fatal', error: toApiError(payload, response.status) };
  }
  try {
    return { kind: 'data', value: parseResponse<T>(payload, response.status) };
  } catch (error) {
    return {
      kind: 'fatal',
      error: error instanceof BusinessGrowApiError
        ? error
        : new BusinessGrowApiError('Réponse Business Grow invalide.', 'INVALID_RESPONSE', response.status),
    };
  }
}

function toApiError(payload: unknown, status: number): BusinessGrowApiError {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const detail = body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown>
    : {};
  return new BusinessGrowApiError(
    typeof detail.message === 'string' ? detail.message : 'La demande Business Grow a échoué.',
    typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED',
    status,
  );
}

/**
 * Relais same-origin (Netlify Edge/Function ou serveur de dev). Utilisé en premier
 * sur un aperçu Netlify — où l'appel direct à `*.supabase.co` peut être bloqué par
 * la politique réseau de l'environnement — puis comme repli sur toute autre origine.
 */
async function invokeViaRelay<T>(
  action: string,
  values: Record<string, unknown>,
  accessToken: string,
): Promise<TransportOutcome<T>> {
  const attempts: string[] = [];
  for (const endpoint of NETLIFY_RELAY_ENDPOINTS) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, ...values }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return {
          kind: 'fatal',
          error: new BusinessGrowApiError(
            'Le relais Business Grow ne répond pas dans le délai prévu.',
            'BUSINESS_GROW_TIMEOUT',
          ),
        };
      }
      attempts.push(`${endpoint}: transport`);
      continue;
    }
    const outcome = await readFunctionResponse<T>(response);
    if (outcome.kind === 'retry') attempts.push(`${endpoint}: ${outcome.reason}`);
    else return outcome;
  }
  return { kind: 'retry', reason: attempts.join(' | ') || 'relais absent' };
}

/** Appel direct à la fonction Edge Supabase, avec le JWT VYORA explicite. */
async function invokeViaEdge<T>(
  action: string,
  values: Record<string, unknown>,
  accessToken: string,
): Promise<TransportOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(edgeFunctionUrl(), {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...values }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      return {
        kind: 'fatal',
        error: new BusinessGrowApiError(
          'Le service Business Grow ne répond pas dans le délai prévu.',
          'BUSINESS_GROW_TIMEOUT',
        ),
      };
    }
    return { kind: 'retry', reason: 'transport direct' };
  }
  return await readFunctionResponse<T>(response);
}

async function invoke<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new BusinessGrowApiError(sessionError.message, 'SESSION_ERROR');
  if (!sessionData.session) throw new BusinessGrowApiError('Connectez-vous pour utiliser Business Grow.', 'UNAUTHENTICATED', 401);

  const localUrl = localFunctionUrl();
  if (localUrl) {
    let response: Response;
    try {
      response = await fetch(localUrl, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${sessionData.session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, ...values }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new BusinessGrowApiError(
          'Le serveur local Business Grow ne répond pas dans le délai prévu.',
          'BUSINESS_GROW_TIMEOUT',
        );
      }
      throw new BusinessGrowApiError(
        'Le serveur local Business Grow est injoignable. Vérifiez que la fonction Edge locale est démarrée.',
        'BUSINESS_GROW_UNAVAILABLE',
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BusinessGrowApiError(
        'Le serveur Business Grow a renvoyé une réponse invalide.',
        'INVALID_RESPONSE',
        response.status,
      );
    }
    return parseResponse<T>(payload, response.status);
  }

  const token = sessionData.session.access_token;
  // Sur un aperçu Netlify, le relais same-origin est le chemin le plus sûr ;
  // ailleurs on tente l'appel direct d'abord. Chaque chemin échoue vers l'autre :
  // un blocage réseau d'un seul canal ne doit jamais faire croire à un backend absent.
  const transports = isNetlifyDeployPreview() || isNetlifyHost()
    ? [invokeViaRelay, invokeViaEdge]
    : [invokeViaEdge, invokeViaRelay];

  const failures: string[] = [];
  for (const transport of transports) {
    const outcome = await transport<T>(action, values, token);
    if (outcome.kind === 'data') return outcome.value;
    if (outcome.kind === 'fatal') throw outcome.error;
    failures.push(outcome.reason);
  }

  throw new BusinessGrowApiError(
    `Le service Business Grow est momentanément inaccessible depuis cet appareil (${failures.join(' ; ')}). Réessayez dans quelques instants.`,
    'BUSINESS_GROW_UNREACHABLE',
  );
}

function parseResponse<T>(payload: unknown, status: number): T {
  if (!payload || typeof payload !== 'object') {
    throw new BusinessGrowApiError('Réponse Business Grow invalide.', 'INVALID_RESPONSE', status);
  }
  const response = payload as Record<string, unknown>;
  if (status < 200 || status >= 300 || response.error) {
    const detail = response.error && typeof response.error === 'object'
      ? response.error as Record<string, unknown>
      : {};
    throw new BusinessGrowApiError(
      typeof detail.message === 'string' ? detail.message : 'La demande Business Grow a échoué.',
      typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED',
      status,
    );
  }
  if (!('data' in response)) {
    throw new BusinessGrowApiError('Réponse Business Grow invalide.', 'INVALID_RESPONSE', status);
  }
  return response.data as T;
}

export const businessGrowApi = {
  getStatus: () => invoke<{ providers: BusinessProviderStatus[] }>('status'),
  verifyProvider: (providerKey: string, modelKey?: string) =>
    invoke<BusinessVerificationResult>('providers.verify', {
      providerKey,
      ...(modelKey ? { modelKey } : {}),
    }),
  listModels: (providerKey?: string | null, includeRemote = false) =>
    invoke<{ models: BusinessModelRecord[]; remoteModels: Record<string, string[]> }>('models.list', {
      ...(providerKey ? { providerKey } : {}),
      includeRemote,
    }),
  listRoles: () =>
    invoke<{ roles: Array<{ role_key?: string; roleKey?: string; description: string }> }>('roles.list'),
  getRouting: () =>
    invoke<{ preferences: Array<Record<string, unknown>> }>('routing.get'),
  saveRouting: (pref: BusinessRoutingPreference) =>
    invoke<{ saved: boolean; id: string | null }>('routing.save', { ...pref }),
  getQuota: () => invoke<BusinessQuotaStatus>('quota.status'),
  listRequests: () => invoke<{ requests: Array<Record<string, unknown>> }>('requests.list'),
  listTools: (conversationId?: string | null) =>
    invoke<{ tools: BusinessToolExecution[] }>('tools.list', conversationId ? { conversationId } : {}),
  resolveTool: (executionId: string, decision: 'approved' | 'rejected') =>
    invoke<Record<string, unknown>>('tools.resolve', { executionId, decision }),
  listIntegrations: () =>
    invoke<{ connections: BusinessIntegrationConnection[] }>('integrations.list'),
  listConversations: () => invoke<{ conversations: BusinessConversation[] }>('conversations.list'),
  createConversation: (title: string, workspaceId: string | null) =>
    invoke<{ conversationId: string }>('conversations.create', { title, workspaceId }),
  renameConversation: (conversationId: string, title: string) =>
    invoke<{ renamed: boolean }>('conversations.rename', { conversationId, title }),
  deleteConversation: (conversationId: string) =>
    invoke<{ deleted: boolean }>('conversations.delete', { conversationId }),
  listMessages: (conversationId: string) =>
    invoke<{ messages: BusinessMessage[] }>('messages.list', { conversationId }),
  sendMessage: (
    conversationId: string,
    content: string,
    idempotencyKey: string,
    options?: BusinessSendOptions,
  ) =>
    invoke<{
      requestId: string;
      inputMessageId: string;
      status: string;
      providerAvailable: boolean;
      provider?: { key: string; model: string };
      roleKey?: string;
      fallbackUsed?: boolean;
      attemptsCount?: number;
      usage?: { inputTokens: number | null; outputTokens: number | null };
      toolProposals?: Array<{ id: string | null; toolName: string; riskLevel: string; summary: string; arguments: Record<string, unknown> }>;
    }>('messages.send', {
      conversationId,
      content,
      idempotencyKey,
      ...(options?.roleKey ? { roleKey: options.roleKey } : {}),
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.routing ? { routing: options.routing } : {}),
    }),
  getMemory: () => invoke<BusinessMemory>('memory.get'),
  setMemoryConsent: (enabled: boolean) =>
    invoke<{ event_id: number; occurred_at: string }>('memory.consent', { enabled }),
  saveMemoryProfile: (profile: Record<string, unknown>) =>
    invoke<{ saved: boolean }>('memory.profile.save', { profile }),
  putMemoryItem: (category: string, content: unknown, itemId: string | null = null) =>
    invoke<{ itemId: string }>('memory.item.put', { itemId, category, content }),
  deleteMemoryItem: (itemId: string) =>
    invoke<{ deleted: boolean }>('memory.item.delete', { itemId }),
};
