import {
  ProviderCallError,
  type BusinessProvider,
  type ChatMessage,
  type ProviderConfig,
  type ProviderReply,
} from './providers';

export type BusinessAction =
  | 'status'
  | 'conversations.list'
  | 'conversations.create'
  | 'conversations.rename'
  | 'conversations.delete'
  | 'messages.list'
  | 'messages.send'
  | 'memory.get'
  | 'memory.consent'
  | 'memory.profile.save'
  | 'memory.item.put'
  | 'memory.item.delete';

export interface BusinessGrowStore {
  listProviders(): Promise<unknown[]>;
  listConversations(userId: string): Promise<unknown[]>;
  listMessages(userId: string, conversationId: string): Promise<unknown[]>;
  createConversation(userId: string, title: string, workspaceId: string | null): Promise<string>;
  renameConversation(userId: string, conversationId: string, title: string): Promise<boolean>;
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  getMemory(userId: string): Promise<unknown>;
  setMemoryConsent(userId: string, enabled: boolean, policyVersion: string): Promise<unknown>;
  saveMemoryProfile(userId: string, profile: Record<string, unknown>): Promise<void>;
  putMemoryItem(userId: string, itemId: string | null, category: string, content: unknown): Promise<string>;
  deleteMemoryItem(userId: string, itemId: string): Promise<boolean>;
  submitUserMessage(
    userId: string,
    conversationId: string,
    content: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ requestId: string; inputMessageId: string; status: string; created: boolean }>;
  startRequest(userId: string, requestId: string): Promise<void>;
  selectRoute(
    userId: string,
    requestId: string,
    conversationId: string,
    attemptNumber: number,
    fallbackFromAttemptId: string | null,
    fallbackReason: string | null,
    preferredProviders: BusinessProvider[],
    excludedProviders: BusinessProvider[],
  ): Promise<{ attemptId: string; providerKey: string; modelKey: string; providerModelKey: string }>;
  failRequest(userId: string, requestId: string, errorCode: string): Promise<void>;
  finalizeAttempt(
    userId: string,
    requestId: string,
    attemptId: string,
    result: {
      status: 'succeeded' | 'failed';
      errorCode: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
      outputContent?: string;
      finalizeRequest?: boolean;
    },
  ): Promise<void>;
}

export class NoVerifiedProviderRouteError extends Error {
  constructor() {
    super('No verified provider route is available.');
    this.name = 'NoVerifiedProviderRouteError';
  }
}

export interface BusinessGrowDependencies {
  store: BusinessGrowStore;
  getUserId: (authorization: string) => Promise<string | null>;
  allowedOrigins: string[];
  providerConfigs: Partial<Record<BusinessProvider, ProviderConfig>>;
  providerOrder: BusinessProvider[];
  complete: (
    provider: BusinessProvider,
    config: ProviderConfig,
    messages: ChatMessage[],
  ) => Promise<ProviderReply>;
}

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const maxMessageLength = 12_000;
const maxHistoryMessages = 40;
const maxHistoryCharacters = 60_000;
const systemMessage = 'Vous êtes le copilote Business Grow de Reelora. Répondez en français, sauf demande contraire. Distinguez les faits connus des hypothèses et n’inventez pas les données métier absentes.';

function response(
  body: unknown,
  status: number,
  origin: string | null,
  allowedOrigins: string[],
): Response {
  const headers = new Headers(jsonHeaders);
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(code: string, message: string) {
  return { error: { code, message } };
}

function string(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uuid(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return null;
  }
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function chatHistory(value: unknown[], maxCharacters = maxHistoryCharacters): ChatMessage[] {
  const candidates: ChatMessage[] = [];
  for (const item of value.slice(-maxHistoryMessages)) {
    const message = object(item);
    if ((message.author_role === 'user' || message.author_role === 'assistant')
      && typeof message.content === 'string'
      && message.content.trim()) {
      candidates.push({ role: message.author_role, content: message.content.slice(0, maxMessageLength) });
    }
  }
  const history: ChatMessage[] = [];
  let remainingCharacters = Math.max(0, maxCharacters);
  for (const message of candidates.reverse()) {
    if (remainingCharacters <= 0) break;
    const content = message.content.slice(-remainingCharacters);
    history.unshift({ role: message.role, content });
    remainingCharacters -= content.length;
  }
  return [{ role: 'system', content: systemMessage }, ...history];
}

function isProvider(value: string): value is BusinessProvider {
  return value === 'groq' || value === 'gemini';
}

export function createBusinessGrowHandler(dependencies: BusinessGrowDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const corsHeaders = new Headers({
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    if (origin && dependencies.allowedOrigins.includes(origin)) {
      corsHeaders.set('Access-Control-Allow-Origin', origin);
      corsHeaders.set('Vary', 'Origin');
    }

    if (origin && !dependencies.allowedOrigins.includes(origin)) {
      return response(failure('ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'), 403, null, dependencies.allowedOrigins);
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== 'POST') {
      return response(failure('METHOD_NOT_ALLOWED', 'Méthode non autorisée.'), 405, origin, dependencies.allowedOrigins);
    }

    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) {
      return response(failure('UNAUTHENTICATED', 'Authentification requise.'), 401, origin, dependencies.allowedOrigins);
    }
    let userId: string | null;
    try {
      userId = await dependencies.getUserId(authorization);
    } catch {
      return response(
        failure('AUTH_SERVICE_UNAVAILABLE', 'Le service d’authentification est temporairement indisponible.'),
        503,
        origin,
        dependencies.allowedOrigins,
      );
    }
    if (!userId) {
      return response(failure('UNAUTHENTICATED', 'Session Reelora invalide ou expirée.'), 401, origin, dependencies.allowedOrigins);
    }

    let body: Record<string, unknown>;
    try {
      body = object(await request.json());
    } catch {
      return response(failure('INVALID_BODY', 'Corps JSON invalide.'), 400, origin, dependencies.allowedOrigins);
    }

    const action = string(body.action, 60) as BusinessAction;
    try {
      let data: unknown;
      switch (action) {
        case 'status':
          data = { providers: await dependencies.store.listProviders() };
          break;
        case 'conversations.list':
          data = { conversations: await dependencies.store.listConversations(userId) };
          break;
        case 'conversations.create': {
          const title = string(body.title, 160) || 'Nouvelle conversation';
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) {
            return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          data = {
            conversationId: await dependencies.store.createConversation(userId, title, workspaceId),
          };
          break;
        }
        case 'conversations.rename': {
          const conversationId = uuid(body.conversationId);
          const title = string(body.title, 160);
          if (!conversationId || !title) {
            return response(failure('INVALID_CONVERSATION', 'Conversation et nouveau titre obligatoires.'), 400, origin, dependencies.allowedOrigins);
          }
          const renamed = await dependencies.store.renameConversation(userId, conversationId, title);
          if (!renamed) {
            return response(failure('CONVERSATION_NOT_FOUND', 'Conversation introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
          }
          data = { renamed };
          break;
        }
        case 'conversations.delete': {
          const conversationId = uuid(body.conversationId);
          if (!conversationId) {
            return response(failure('INVALID_CONVERSATION', 'Conversation invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          const deleted = await dependencies.store.deleteConversation(userId, conversationId);
          if (!deleted) {
            return response(failure('CONVERSATION_NOT_FOUND', 'Conversation introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
          }
          data = { deleted };
          break;
        }
        case 'messages.list': {
          const conversationId = uuid(body.conversationId);
          if (!conversationId) {
            return response(failure('INVALID_CONVERSATION', 'Conversation invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          data = { messages: await dependencies.store.listMessages(userId, conversationId) };
          break;
        }
        case 'messages.send': {
          const conversationId = uuid(body.conversationId);
          const content = string(body.content, maxMessageLength);
          const idempotencyKey = uuid(body.idempotencyKey);
          if (!conversationId || !idempotencyKey || !content) {
            return response(failure('INVALID_MESSAGE', 'Conversation, demande et clé d’idempotence sont obligatoires.'), 400, origin, dependencies.allowedOrigins);
          }
          const requestHash = await sha256(`${conversationId}\n${content}`);
          const history = chatHistory(
            await dependencies.store.listMessages(userId, conversationId),
            maxHistoryCharacters - content.length,
          );
          history.push({ role: 'user', content });
          const submitted = await dependencies.store.submitUserMessage(
            userId, conversationId, content, idempotencyKey, requestHash,
          );
          if (!submitted.created) {
            data = { ...submitted, providerAvailable: false };
            break;
          }

          await dependencies.store.startRequest(userId, submitted.requestId);
          const excludedProviders: BusinessProvider[] = [];
          let previousAttemptId: string | null = null;
          let fallbackReason: string | null = null;
          let lastErrorCode = 'NO_VERIFIED_PROVIDER';

          for (let attemptNumber = 1; attemptNumber <= dependencies.providerOrder.length; attemptNumber += 1) {
            let route: Awaited<ReturnType<BusinessGrowStore['selectRoute']>>;
            try {
              route = await dependencies.store.selectRoute(
                userId,
                submitted.requestId,
                conversationId,
                attemptNumber,
                previousAttemptId,
                fallbackReason,
                dependencies.providerOrder,
                excludedProviders,
              );
            } catch (error) {
              if (error instanceof NoVerifiedProviderRouteError) {
                lastErrorCode = 'NO_VERIFIED_PROVIDER';
                break;
              }
              lastErrorCode = 'ROUTE_SELECTION_FAILED';
              await dependencies.store.failRequest(userId, submitted.requestId, lastErrorCode);
              return response(
                failure(lastErrorCode, 'La sélection sécurisée du fournisseur a échoué. Réessayez plus tard.'),
                503,
                origin,
                dependencies.allowedOrigins,
              );
            }

            if (!isProvider(route.providerKey)) {
              await dependencies.store.finalizeAttempt(userId, submitted.requestId, route.attemptId, {
                status: 'failed',
                errorCode: 'UNSUPPORTED_PROVIDER',
                inputTokens: null,
                outputTokens: null,
                latencyMs: 0,
                finalizeRequest: false,
              });
              lastErrorCode = 'NO_VERIFIED_PROVIDER';
              break;
            }

            const provider = route.providerKey;
            const config = dependencies.providerConfigs[provider];
            if (!config || !config.apiKey || !config.model || config.model !== route.providerModelKey) {
              lastErrorCode = config?.model && config.model !== route.providerModelKey
                ? 'PROVIDER_MODEL_MISMATCH'
                : 'PROVIDER_NOT_CONFIGURED';
              await dependencies.store.finalizeAttempt(userId, submitted.requestId, route.attemptId, {
                status: 'failed',
                errorCode: lastErrorCode,
                inputTokens: null,
                outputTokens: null,
                latencyMs: 0,
                finalizeRequest: false,
              });
              excludedProviders.push(provider);
              previousAttemptId = route.attemptId;
              fallbackReason = lastErrorCode;
              continue;
            }

            const startedAt = Date.now();
            let result: ProviderReply;
            try {
              result = await dependencies.complete(provider, config, history);
            } catch (error) {
              const providerError = error instanceof ProviderCallError
                ? error
                : new ProviderCallError('PROVIDER_UNAVAILABLE', true);
              lastErrorCode = providerError.code;
              await dependencies.store.finalizeAttempt(userId, submitted.requestId, route.attemptId, {
                status: 'failed',
                errorCode: providerError.code,
                inputTokens: null,
                outputTokens: null,
                latencyMs: Date.now() - startedAt,
                finalizeRequest: false,
              });
              excludedProviders.push(provider);
              previousAttemptId = route.attemptId;
              fallbackReason = providerError.code;
              continue;
            }

            await dependencies.store.finalizeAttempt(userId, submitted.requestId, route.attemptId, {
              status: 'succeeded',
              errorCode: null,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs: Date.now() - startedAt,
              outputContent: result.content,
            });
            data = {
              ...submitted,
              status: 'succeeded',
              providerAvailable: true,
              provider: { key: provider, model: route.providerModelKey },
            };
            return response({ data }, 200, origin, dependencies.allowedOrigins);
          }

          await dependencies.store.failRequest(userId, submitted.requestId, lastErrorCode);
          return response(failure(
            lastErrorCode,
            lastErrorCode === 'NO_VERIFIED_PROVIDER'
              ? 'Aucun fournisseur configuré, vérifié et disponible pour cette demande. Le message utilisateur a été conservé; aucune réponse n’a été simulée.'
              : `Les fournisseurs configurés n’ont pas pu traiter la demande (code : ${lastErrorCode}). Le message est conservé; consultez le statut et réessayez.`,
          ), 503, origin, dependencies.allowedOrigins);
        }
        case 'memory.get':
          data = await dependencies.store.getMemory(userId);
          break;
        case 'memory.consent': {
          if (typeof body.enabled !== 'boolean') {
            return response(failure('INVALID_CONSENT', 'Le consentement doit être activé ou révoqué.'), 400, origin, dependencies.allowedOrigins);
          }
          data = await dependencies.store.setMemoryConsent(userId, body.enabled, 'business-grow-memory-v1');
          break;
        }
        case 'memory.profile.save':
          await dependencies.store.saveMemoryProfile(userId, object(body.profile));
          data = { saved: true };
          break;
        case 'memory.item.put': {
          const category = string(body.category, 80);
          if (!category || body.content == null) {
            return response(failure('INVALID_MEMORY_ITEM', 'La catégorie et le contenu sont obligatoires.'), 400, origin, dependencies.allowedOrigins);
          }
          const itemId = body.itemId == null ? null : uuid(body.itemId);
          if (body.itemId != null && !itemId) {
            return response(failure('INVALID_MEMORY_ITEM', 'Identifiant mémoire invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          data = { itemId: await dependencies.store.putMemoryItem(userId, itemId, category, body.content) };
          break;
        }
        case 'memory.item.delete': {
          const itemId = uuid(body.itemId);
          if (!itemId) {
            return response(failure('INVALID_MEMORY_ITEM', 'Identifiant mémoire invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          data = { deleted: await dependencies.store.deleteMemoryItem(userId, itemId) };
          break;
        }
        default:
          return response(failure('UNKNOWN_ACTION', 'Opération Business Grow inconnue.'), 400, origin, dependencies.allowedOrigins);
      }

      return response({ data }, 200, origin, dependencies.allowedOrigins);
    } catch (error) {
      console.error('business-grow request failed', { action });
      return response(
        failure('BUSINESS_GROW_BACKEND_ERROR', 'Le service Business Grow est temporairement indisponible.'),
        500,
        origin,
        dependencies.allowedOrigins,
      );
    }
  };
}
