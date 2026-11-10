import { supabase } from '../lib/supabase';

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
    throw new BusinessGrowApiError(
      typeof detail.message === 'string' ? detail.message : error.message,
      typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED',
      error.context instanceof Response ? error.context.status : undefined,
    );
  }

  if (!data || typeof data !== 'object') {
    throw new BusinessGrowApiError('Réponse Business Grow invalide.', 'INVALID_RESPONSE');
  }
  const response = data as Record<string, unknown>;
  if (response.error && typeof response.error === 'object') {
    const detail = response.error as Record<string, unknown>;
    throw new BusinessGrowApiError(
      typeof detail.message === 'string' ? detail.message : 'La demande Business Grow a échoué.',
      typeof detail.code === 'string' ? detail.code : 'BUSINESS_GROW_REQUEST_FAILED',
    );
  }
  return response.data as T;
}

export const businessGrowApi = {
  getStatus: () => invoke<{ providers: BusinessProviderStatus[] }>('status'),
  listConversations: () => invoke<{ conversations: BusinessConversation[] }>('conversations.list'),
  createConversation: (title: string, workspaceId: string | null) =>
    invoke<{ conversationId: string }>('conversations.create', { title, workspaceId }),
  renameConversation: (conversationId: string, title: string) =>
    invoke<{ renamed: boolean }>('conversations.rename', { conversationId, title }),
  deleteConversation: (conversationId: string) =>
    invoke<{ deleted: boolean }>('conversations.delete', { conversationId }),
  listMessages: (conversationId: string) =>
    invoke<{ messages: BusinessMessage[] }>('messages.list', { conversationId }),
  sendMessage: (conversationId: string, content: string, idempotencyKey: string) =>
    invoke<{
      requestId: string;
      inputMessageId: string;
      status: string;
      providerAvailable: boolean;
    }>('messages.send', { conversationId, content, idempotencyKey }),
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
