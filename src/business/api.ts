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

/** Mémoire persistante de l'agent : une déclaration explicite de l'utilisateur,
 *  mémorisée avec son niveau de confiance (fact = vérifié, hypothèse = à confirmer). */
export interface BusinessAgentMemory {
  id: string;
  category: string;
  title: string;
  content: string;
  confidence: string;
  score?: number | null;
  created_at?: string | null;
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

/** Un seul élément de l'aperçu confirmé ; les instantanés ne sont pas transmis à un fournisseur IA. */
export interface AutomationTaskConfirmation {
  playbookId: string;
  sourceCategory: string;
  sourceId: string;
  previewDay: string;
  expectedPlaybook: Record<string, unknown>;
  expectedSource: Record<string, unknown>;
  task: Record<string, unknown>;
}

export type BusinessReportType = 'commercial' | 'financial' | 'customers' | 'recovery' | 'operations' | 'health';
export interface BusinessRecommendation {
  id: string; kind: string; module: string; priority: 'critique' | 'élevée' | 'moyenne' | 'faible';
  problem: string; evidence: string[]; potentialImpact: string; action: string;
  sourceCategory: string; sourceRecordId: string;
  facts: Record<string, number | string>;
}
export interface BusinessReport {
  type: BusinessReportType; period: { from: string; to: string }; asOf: string;
  coverage: Array<{ module: string; category: string; count: number; status: 'available' | 'empty' | 'consent_required'; truncated: boolean }>;
  metrics: Array<{ label: string; value: number; unit: string; basis: string }>;
  recommendations: BusinessRecommendation[]; totalRecommendations: number; warnings: string[];
}
export interface SavedBusinessReport {
  id: string; report_type: BusinessReportType; period_from: string; period_to: string;
  document: BusinessReport; created_at: string;
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
  // Les relais hébergés de ce dépôt ciblent le projet canonique en dur, y
  // compris derrière un domaine personnalisé. Ne jamais leur transmettre le
  // JWT d'un autre projet, même lorsque son accès direct échoue. Le mode local
  // explicite utilise uniquement le proxy Vite validé vers localhost:54321.
  const canonicalProject = SUPABASE_URL.replace(/\/+$/, '') === DEFAULT_SUPABASE_URL;
  const defaults: Transport[] = localOnly
    ? ['relay']
    : !canonicalProject
      ? ['direct']
      : isNetlifyHost()
        ? ['relay', 'netlify-function', 'direct']
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
  'messages.list', 'memory.get', 'agent.reports.list',
]);

// Le préfixe de protocole est volontairement inconnu des anciennes versions
// Edge : elles ne pourront pas ignorer workspaceId et écrire en personnel.
const WORKSPACE_ACTIONS = new Set([
  'requests.list', 'tools.list', 'tools.resolve',
  'integrations.list', 'integrations.request', 'integrations.cancel', 'integrations.disconnect',
  'conversations.list', 'conversations.create', 'conversations.rename', 'conversations.delete',
  'messages.list', 'messages.send', 'memory.get', 'memory.consent', 'memory.profile.save',
  'memory.item.put', 'memory.item.delete', 'memory.legacy.import', 'modules.records',
  'agent.report', 'agent.reports.list', 'agent.reports.delete', 'agent.task.propose', 'automation.task.confirm',
]);

function isReadOnly(action: string, values: Record<string, unknown>): boolean {
  const canonical = action.startsWith('v3.') ? action.slice(3) : action;
  return READ_ACTIONS.has(canonical) || (canonical === 'modules.records' && values.op === 'list')
    || (canonical === 'agent.report' && values.save !== true);
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
  const versioned = typeof values.workspaceId === 'string' && values.workspaceId.length > 0 && WORKSPACE_ACTIONS.has(action);
  const wireAction = versioned ? `v3.${action}` : action;
  try {
    return await invokeWithFallback<T>(wireAction, values, accessToken, localOnly);
  } catch (error) {
    if (versioned && error instanceof BusinessGrowApiError && error.code === 'UNKNOWN_ACTION') {
      throw new BusinessGrowApiError('Cette version du service ne prend pas en charge les données par entreprise. Aucune modification n’a été effectuée.', 'BUSINESS_GROW_UPGRADE_REQUIRED', error.status);
    }
    throw error;
  }
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
  listRequests: (workspaceId?: string | null) => invoke<{ requests: Array<Record<string, unknown>> }>('requests.list', workspaceId ? { workspaceId } : {}),
  listTools: (conversationId?: string | null, workspaceId?: string | null) =>
    invoke<{ tools: BusinessToolExecution[] }>('tools.list', { ...(conversationId ? { conversationId } : {}), ...(workspaceId ? { workspaceId } : {}) }),
  resolveTool: (executionId: string, decision: 'approved' | 'rejected', workspaceId?: string | null) =>
    invoke<Record<string, unknown>>('tools.resolve', { executionId, decision, ...(workspaceId ? { workspaceId } : {}) }),
  listIntegrations: (workspaceId?: string | null) =>
    invoke<{ connections: BusinessIntegrationConnection[] }>('integrations.list', workspaceId ? { workspaceId } : {}),
  requestIntegration: (connectorKey: string, workspaceId?: string | null) =>
    invoke<{ connectorKey: string; status: string }>('integrations.request', {
      connectorKey,
      ...(workspaceId ? { workspaceId } : {}),
    }),
  cancelIntegration: (connectorKey: string, workspaceId?: string | null) =>
    invoke<{ connectorKey: string; cancelled: boolean }>('integrations.cancel', { connectorKey, ...(workspaceId ? { workspaceId } : {}) }),
  disconnectIntegration: (connectorKey: string, workspaceId?: string | null) =>
    invoke<{ connectorKey: string; disconnected: boolean }>('integrations.disconnect', { connectorKey, ...(workspaceId ? { workspaceId } : {}) }),
  listModuleRecords: (category: string, workspaceId?: string | null) =>
    invoke<{ records: BusinessModuleRecord[] }>('modules.records', { category, op: 'list', ...(workspaceId ? { workspaceId } : {}) }),
  createModuleRecord: (category: string, data: Record<string, unknown>, dedupeKey?: string | null, workspaceId?: string | null) =>
    invoke<{ recordId: string }>('modules.records', {
      category, op: 'create', data, ...(dedupeKey ? { dedupeKey } : {}), ...(workspaceId ? { workspaceId } : {}),
    }),
  updateModuleRecord: (category: string, recordId: string, data: Record<string, unknown>, workspaceId?: string | null) =>
    invoke<{ updated: boolean }>('modules.records', { category, op: 'update', recordId, data, ...(workspaceId ? { workspaceId } : {}) }),
  deleteModuleRecord: (category: string, recordId: string, workspaceId?: string | null) =>
    invoke<{ deleted: boolean }>('modules.records', { category, op: 'delete', recordId, ...(workspaceId ? { workspaceId } : {}) }),
  confirmAutomationTask: (workspaceId: string, confirmation: AutomationTaskConfirmation) =>
    invoke<{ taskId: string; created: boolean }>('automation.task.confirm', { workspaceId, ...confirmation }),
  listConversations: (workspaceId?: string | null) => invoke<{ conversations: BusinessConversation[] }>('conversations.list', workspaceId ? { workspaceId } : {}),
  generateReport: (workspaceId: string, reportType: BusinessReportType, from: string, to: string, save = false, idempotencyKey?: string) =>
    invoke<{ report: BusinessReport; id?: string; created?: boolean; saved?: boolean }>('agent.report', {
      workspaceId, reportType, from, to, save, ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  listReports: (workspaceId: string) => invoke<{ reports: SavedBusinessReport[] }>('agent.reports.list', { workspaceId }),
  deleteReport: (workspaceId: string, reportId: string) => invoke<{ deleted: boolean }>('agent.reports.delete', { workspaceId, reportId }),
  proposeTask: (workspaceId: string, conversationId: string, sourceCategory: string, sourceRecordId: string, idempotencyKey: string) =>
    invoke<{ id: string; summary: string; status: string }>('agent.task.propose', { workspaceId, conversationId, sourceCategory, sourceRecordId, idempotencyKey }),
  createConversation: (title: string, workspaceId: string | null) =>
    invoke<{ conversationId: string }>('conversations.create', { title, workspaceId }),
  renameConversation: (conversationId: string, title: string, workspaceId?: string | null) =>
    invoke<{ renamed: boolean }>('conversations.rename', { conversationId, title, ...(workspaceId ? { workspaceId } : {}) }),
  deleteConversation: (conversationId: string, workspaceId?: string | null) =>
    invoke<{ deleted: boolean }>('conversations.delete', { conversationId, ...(workspaceId ? { workspaceId } : {}) }),
  listMessages: (conversationId: string, workspaceId?: string | null) =>
    invoke<{ messages: BusinessMessage[] }>('messages.list', { conversationId, ...(workspaceId ? { workspaceId } : {}) }),
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
  getMemory: (workspaceId?: string | null) => invoke<BusinessMemory>('memory.get', workspaceId ? { workspaceId } : {}),
  setMemoryConsent: (enabled: boolean, workspaceId?: string | null) =>
    invoke<{ event_id: number; occurred_at: string }>('memory.consent', { enabled, ...(workspaceId ? { workspaceId } : {}) }),
  saveMemoryProfile: (profile: Record<string, unknown>, workspaceId?: string | null) =>
    invoke<{ saved: boolean }>('memory.profile.save', { profile, ...(workspaceId ? { workspaceId } : {}) }),
  putMemoryItem: (category: string, content: unknown, itemId: string | null = null, workspaceId?: string | null) =>
    invoke<{ itemId: string }>('memory.item.put', { itemId, category, content, ...(workspaceId ? { workspaceId } : {}) }),
  deleteMemoryItem: (itemId: string, workspaceId?: string | null) =>
    invoke<{ deleted: boolean }>('memory.item.delete', { itemId, ...(workspaceId ? { workspaceId } : {}) }),
  /** Mémoire persistante de l'agent (VYORA AI CORE, saas_business.ai_memories). */
  listAgentMemories: (options?: { category?: string; limit?: number; workspaceId?: string | null }) =>
    invoke<{ memories: BusinessAgentMemory[] }>('agentMemory.list', {
      ...(options?.category ? { category: options.category } : {}),
      ...(options?.limit ? { limit: options.limit } : {}),
      ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
    }),
  searchAgentMemories: (query: string, limit?: number, workspaceId?: string | null) =>
    invoke<{ memories: BusinessAgentMemory[] }>('agentMemory.search', {
      query,
      ...(limit ? { limit } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }),
  forgetAgentMemory: (memoryId: string, workspaceId?: string | null) =>
    invoke<{ forgotten: boolean }>('agentMemory.forget', { memoryId, ...(workspaceId ? { workspaceId } : {}) }),
  importLegacyMemory: (workspaceId: string) =>
    invoke<{ importedItems: number; importedProfile: boolean }>('memory.legacy.import', { workspaceId, confirmed: true }),
};
