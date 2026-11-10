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
  ): Promise<{ attemptId: string; providerKey: string; modelKey: string }>;
  failRequest(userId: string, requestId: string, errorCode: string): Promise<void>;
  finalizeAttempt(userId: string, requestId: string, attemptId: string, errorCode: string): Promise<void>;
}

export interface BusinessGrowDependencies {
  store: BusinessGrowStore;
  getUserId: (authorization: string) => Promise<string | null>;
  allowedOrigins: string[];
}

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const maxMessageLength = 12_000;

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

export function createBusinessGrowHandler(dependencies: BusinessGrowDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const corsHeaders = new Headers({
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    if (origin && dependencies.allowedOrigins.includes(origin)) {
      corsHeaders.set('Access-Control-Allow-Origin', origin);
      corsHeaders.set('Vary', 'Origin');
    }

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    if (request.method !== 'POST') {
      return response(failure('METHOD_NOT_ALLOWED', 'Méthode non autorisée.'), 405, origin, dependencies.allowedOrigins);
    }
    if (origin && !dependencies.allowedOrigins.includes(origin)) {
      return response(failure('ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'), 403, null, dependencies.allowedOrigins);
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
          const submitted = await dependencies.store.submitUserMessage(
            userId, conversationId, content, idempotencyKey, requestHash,
          );
          if (!submitted.created) {
            data = { ...submitted, providerAvailable: false };
            break;
          }

          await dependencies.store.startRequest(userId, submitted.requestId);
          try {
            const route = await dependencies.store.selectRoute(userId, submitted.requestId, conversationId);
            await dependencies.store.finalizeAttempt(
              userId, submitted.requestId, route.attemptId, 'PROVIDER_ADAPTER_NOT_CONFIGURED',
            );
            data = {
              ...submitted,
              status: 'failed',
              providerAvailable: false,
              error: {
                code: 'PROVIDER_ADAPTER_NOT_CONFIGURED',
                message: 'Aucun adaptateur fournisseur Business Grow n’est activé. Aucun appel IA ni coût fournisseur n’a été engagé.',
              },
            };
            return response(data, 503, origin, dependencies.allowedOrigins);
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            const code = message.toLowerCase().includes('route') || message.toLowerCase().includes('healthy')
              ? 'NO_VERIFIED_PROVIDER'
              : 'AI_DIRECTOR_ERROR';
            await dependencies.store.failRequest(userId, submitted.requestId, code);
            data = {
              ...submitted,
              status: 'failed',
              providerAvailable: false,
              error: {
                code,
                message: 'Aucun fournisseur vérifié et disponible pour cette demande. Le message est conservé dans votre historique, aucune réponse n’a été simulée.',
              },
            };
            return response(data, 503, origin, dependencies.allowedOrigins);
          }
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
      console.error('business-grow request failed', {
        action,
        message: error instanceof Error ? error.message : 'unknown error',
      });
      return response(
        failure('BUSINESS_GROW_BACKEND_ERROR', 'Le service Business Grow est temporairement indisponible.'),
        500,
        origin,
        dependencies.allowedOrigins,
      );
    }
  };
}
