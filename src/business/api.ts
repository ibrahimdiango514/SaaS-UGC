import { supabase, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../lib/supabase';
import { DEFAULT_SUPABASE_URL, isLocalBusinessGrowFunctionUrl } from '../lib/public-config';

function currentHostname(): string {
  return typeof window !== 'undefined' && typeof window.location?.hostname === 'string'
    ? window.location.hostname.toLowerCase()
    : '';
}

function isNetlifyHost(): boolean {
  return currentHostname().endsWith('.netlify.app');
}

/** En développement, le serveur Vite, et non le navigateur, joint Supabase local. */
function useLocalFunction(): boolean {
  if (!import.meta.env.DEV) return false;
  const configured = (import.meta.env as Record<string, string | undefined>)
    .VITE_BUSINESS_GROW_FUNCTION_URL?.trim();
  if (!configured) return false;
  if (isLocalBusinessGrowFunctionUrl(configured)) return true;
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

export interface BusinessModuleRecord {
  id: string;
  category: string;
  data: Record<string, unknown>;
  created_at: string;
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

const RELAY_PATH = '/api/business-grow';
const NETLIFY_FUNCTION_PATH = '/.netlify/functions/business-grow';
type Transport = 'direct' | 'relay' | 'netlify-function';

// Le canal qui a réellement répondu à une lecture est privilégié pour les
// actions suivantes. Aucun jeton ou résultat utilisateur n'est mis en cache.
const preferredTransport = new WeakMap<Window, Transport>();

function currentWindow(): Window | null {
  return typeof window === 'undefined' ? null : window;
}

function transportOrder(localOnly: boolean): Transport[] {
  const defaults: Transport[] = localOnly
    ? ['relay']
    : isNetlifyHost()
      // Les relais Netlify de ce dépôt ciblent le projet canonique en dur : ne
      // jamais leur transmettre le JWT d'un autre projet configuré par Vite.
      ? SUPABASE_URL.replace(/\/+$/, '') === DEFAULT_SUPABASE_URL
        ? ['relay', 'netlify-function', 'direct']
        : ['direct']
      : ['direct', 'relay'];
  const win = currentWindow();
  const preferred = win ? preferredTransport.get(win) : undefined;
  return preferred && defaults.includes(preferred)
    ? [preferred, ...defaults.filter((item) => item !== preferred)]
    : defaults;
}

/** URL de la fonction Edge, dérivée de la configuration Supabase publique. */
function edgeFunctionUrl(): string {
  return `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/business-grow`;
}

const READ_ACTIONS = new Set([
  'status', 'models.list', 'roles.list', 'routing.get', 'quota.status',
  'requests.list', 'tools.list', 'integrations.list', 'conversations.list',
  'messages.list', 'memory.get',
]);

function isReadOnly(action: string, values: Record<string, unknown>): boolean {
  return READ_ACTIONS.has(action) || (action === 'modules.records' && values.op === 'list');
}

type TransportOutcome<T> =
  | { kind: 'data'; value: T }
  | { kind: 'retry'; reason: string }
  | { kind: 'fatal'; error: BusinessGrowApiError };

/**
 * Un 404 métier structuré reste une erreur métier. Les erreurs de réseau, HTML
 * et relais ne prouvent jamais que le backend est absent. Sur une écriture,
 * une réponse perdue ou illisible ne permet pas de savoir si elle a été jouée.
 */
async function readFunctionResponse<T>(response: Response): Promise<TransportOutcome<T>> {
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase();
  let payload: unknown;
  if (!contentType.includes('text/html')) {
    try {
      payload = await response.json();
    } catch {
      // La réponse est examinée ci-dessous, sans inventer un diagnostic de déploiement.
    }
  }

  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const detail = body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown>
    : null;
  if (response.status === 404 && typeof detail?.code !== 'string') {
    return { kind: 'retry', reason: 'point d’entrée HTTP 404' };
  }
  if (payload === undefined) {
    return { kind: 'retry', reason: `réponse illisible HTTP ${response.status}` };
  }
  if (response.status < 200 || response.status >= 300) {
    const code = typeof detail?.code === 'string' ? detail.code : '';
    if ([502, 504].includes(response.status) && [
      'BUSINESS_GROW_UNAVAILABLE', 'BUSINESS_GROW_RELAY_UNAVAILABLE', 'BUSINESS_GROW_TIMEOUT',
    ].includes(code)) {
      return { kind: 'retry', reason: `relais HTTP ${response.status}` };
    }
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
    : body; // La passerelle Supabase renvoie aussi { code, message } à la racine.
  const code = typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED';
  if (status === 401 && /^(?:UNAUTHORIZED|INVALID_JWT)/i.test(code)) {
    return new BusinessGrowApiError('Session VYORA invalide ou expirée. Reconnectez-vous.', 'UNAUTHENTICATED', status);
  }
  return new BusinessGrowApiError(
    typeof detail.message === 'string' ? detail.message : 'La demande Business Grow a échoué.',
    code,
    status,
  );
}

async function attemptTransport<T>(
  transport: Transport,
  action: string,
  values: Record<string, unknown>,
  accessToken: string,
): Promise<TransportOutcome<T>> {
  const target = transport === 'direct' ? edgeFunctionUrl()
    : transport === 'relay' ? RELAY_PATH : NETLIFY_FUNCTION_PATH;
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...values }),
      signal: AbortSignal.timeout(isReadOnly(action, values) ? 15_000 : 45_000),
    });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    return {
      kind: 'retry',
      reason: timeout ? 'délai dépassé' : 'transport réseau',
      // fetch ne distingue pas un échec avant l'envoi d'une réponse perdue après
      // exécution : rejouer une mutation ici pourrait créer des doublons.
    };
  }
  return readFunctionResponse<T>(response);
}

async function invokeWithFallback<T>(
  action: string,
  values: Record<string, unknown>,
  accessToken: string,
  localOnly: boolean,
): Promise<T> {
  const readOnly = isReadOnly(action, values);
  const failures: string[] = [];
  for (const transport of transportOrder(localOnly)) {
    const outcome = await attemptTransport<T>(transport, action, values, accessToken);
    if (outcome.kind === 'data') {
      const win = currentWindow();
      if (win) preferredTransport.set(win, transport);
      return outcome.value;
    }
    if (outcome.kind === 'fatal') throw outcome.error;
    failures.push(`${transport}: ${outcome.reason}`);
    if (!readOnly) {
      throw new BusinessGrowApiError(
        'La réponse à cette action n’a pas pu être confirmée. Vérifiez son résultat avant de la relancer pour éviter un doublon.',
        'BUSINESS_GROW_RESULT_UNKNOWN',
      );
    }
  }

  // Diagnostic sans JWT, contenu utilisateur ni affirmation sur l'état du déploiement.
  console.warn('[business-grow] connexion impossible', { action, failures });
  throw new BusinessGrowApiError(
    'Impossible de joindre Business Grow depuis cet appareil. Vérifiez votre connexion puis réessayez.',
    'BUSINESS_GROW_UNREACHABLE',
  );
}

async function invoke<T>(action: string, values: Record<string, unknown> = {}): Promise<T> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new BusinessGrowApiError(sessionError.message, 'SESSION_ERROR');
  if (!sessionData.session) throw new BusinessGrowApiError('Connectez-vous pour utiliser Business Grow.', 'UNAUTHENTICATED', 401);

  const localOnly = useLocalFunction();
  const accessToken = sessionData.session.access_token;
  if (!isReadOnly(action, values)) {
    // Vérifier le canal par une lecture avant chaque écriture permet aussi de
    // basculer si le réseau a changé depuis le dernier chargement de la page.
    await invokeWithFallback('status', {}, accessToken, localOnly);
  }
  return invokeWithFallback<T>(action, values, accessToken, localOnly);
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
  requestIntegration: (connectorKey: string, workspaceId?: string | null) =>
    invoke<{ connectorKey: string; status: string }>('integrations.request', {
      connectorKey,
      ...(workspaceId ? { workspaceId } : {}),
    }),
  cancelIntegration: (connectorKey: string) =>
    invoke<{ connectorKey: string; cancelled: boolean }>('integrations.cancel', { connectorKey }),
  disconnectIntegration: (connectorKey: string) =>
    invoke<{ connectorKey: string; disconnected: boolean }>('integrations.disconnect', { connectorKey }),
  listModuleRecords: (category: string) =>
    invoke<{ records: BusinessModuleRecord[] }>('modules.records', { category, op: 'list' }),
  createModuleRecord: (category: string, data: Record<string, unknown>, dedupeKey?: string | null) =>
    invoke<{ recordId: string }>('modules.records', {
      category,
      op: 'create',
      data,
      ...(dedupeKey ? { dedupeKey } : {}),
    }),
  updateModuleRecord: (category: string, recordId: string, data: Record<string, unknown>) =>
    invoke<{ updated: boolean }>('modules.records', { category, op: 'update', recordId, data }),
  deleteModuleRecord: (category: string, recordId: string) =>
    invoke<{ deleted: boolean }>('modules.records', { category, op: 'delete', recordId }),
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
