import { supabase, SUPABASE_PUBLISHABLE_KEY } from '../lib/supabase';

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

  const { data, error } = await supabase.functions.invoke('business-grow', {
    body: { action, ...values },
  });

  if (error) {
    let payload: unknown = data;
    if (!payload && error.context instanceof Response) {
      try { payload = await error.context.clone().json(); } catch { /* use the SDK error below */ }
    }
    const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    const detail = body.error && typeof body.error === 'object'
      ? body.error as Record<string, unknown>
      : {};
    const status = error.context instanceof Response ? error.context.status : undefined;
    if (error.name === 'FunctionsFetchError' || status === 404) {
      throw new BusinessGrowApiError(
        'Le backend Business Grow est absent ou injoignable. La fonction serveur n’est peut-être pas déployée.',
        'BUSINESS_GROW_UNAVAILABLE',
        status,
      );
    }
    throw new BusinessGrowApiError(
      typeof detail.message === 'string' ? detail.message : error.message,
      typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED',
      status,
    );
  }

  return parseResponse<T>(data, 200);
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
