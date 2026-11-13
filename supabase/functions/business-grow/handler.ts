import {
  buildBusinessSystemInstruction,
  BUSINESS_ROLE_SPECS,
  extractToolProposals,
  normalizeRoleKey,
  normalizeToolProposalArguments,
  type BusinessRoleKey,
  type ExtractedToolProposal,
  type MemorySnapshot,
  type WorkspaceCompanyContext,
} from './intelligence.ts';
import {
  listRemoteModels,
  probeProvider,
  ProviderCallError,
  type BusinessProvider,
  type CentralRouteMeta,
  type ChatMessage,
  type ProviderConfig,
  type ProviderProbeResult,
  type ProviderReply,
} from './providers.ts';

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
  | 'memory.item.delete'
  | 'providers.verify'
  | 'models.list'
  | 'roles.list'
  | 'routing.get'
  | 'routing.save'
  | 'quota.status'
  | 'requests.list'
  | 'tools.list'
  | 'tools.resolve'
  | 'integrations.list';

export interface RoutingOptions {
  selectionMode?: 'auto' | 'manual';
  preferredProviderKey?: string | null;
  preferredModelKey?: string | null;
  allowFallback?: boolean;
}

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
    roleKey?: BusinessRoleKey,
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
    preferredModelKey?: string | null,
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
  // Optional central AI engine store extensions (backward compatible with legacy test fixtures)
  recordHealthCheck?: (result: ProviderProbeResult) => Promise<void>;
  listModels?: (providerKey?: string | null) => Promise<unknown[]>;
  listRoles?: () => Promise<unknown[]>;
  getRoutingPreferences?: (userId: string) => Promise<unknown[]>;
  upsertRoutingPreference?: (
    userId: string,
    roleKey: BusinessRoleKey,
    options: Required<Pick<RoutingOptions, 'selectionMode' | 'allowFallback'>> & {
      preferredProviderKey: string | null;
      preferredModelKey: string | null;
    },
  ) => Promise<string>;
  getQuota?: (userId: string) => Promise<unknown>;
  reserveQuota?: (userId: string, requestId: string, amount: number, reason: string) => Promise<unknown>;
  captureQuota?: (userId: string, requestId: string, reserved: number, actual: number) => Promise<unknown>;
  releaseQuota?: (userId: string, requestId: string, amount: number, reason: string) => Promise<unknown>;
  listRecentRequests?: (userId: string, limit?: number) => Promise<unknown[]>;
  getWorkspaceContext?: (userId: string, workspaceId: string | null) => Promise<WorkspaceCompanyContext | null>;
  createToolExecution?: (
    userId: string,
    conversationId: string,
    requestId: string,
    proposal: ExtractedToolProposal,
  ) => Promise<string>;
  listToolExecutions?: (userId: string, conversationId?: string | null) => Promise<unknown[]>;
  resolveToolExecution?: (
    userId: string,
    executionId: string,
    decision: 'approved' | 'rejected' | 'executed' | 'failed',
    outputResult?: Record<string, unknown>,
  ) => Promise<{
    id: string;
    tool_name: string;
    status: string;
    input_args?: Record<string, unknown>;
    output_result?: Record<string, unknown>;
  }>;
  listIntegrationConnections?: (userId: string) => Promise<unknown[]>;
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
    meta?: CentralRouteMeta,
  ) => Promise<ProviderReply>;
  probe?: (provider: BusinessProvider, config: ProviderConfig) => Promise<ProviderProbeResult>;
  discoverModels?: (provider: BusinessProvider, config: ProviderConfig) => Promise<string[]>;
}

const jsonHeaders = { 'Content-Type': 'application/json; charset=utf-8' };
const maxMessageLength = 12_000;
const maxHistoryMessages = 40;
const maxHistoryCharacters = 60_000;
const systemMessage = 'Vous êtes le copilote Business Grow de VYORA. Répondez en français, sauf demande contraire. Distinguez les faits connus des hypothèses et n’inventez pas les données métier absentes.';

function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  for (const pattern of allowedOrigins) {
    if (!pattern.includes('*')) continue;
    let parsedPattern: URL;
    try {
      parsedPattern = new URL(pattern.replaceAll('*', 'xwildcardx'));
    } catch {
      continue;
    }
    if (parsedOrigin.protocol !== parsedPattern.protocol || parsedOrigin.port !== parsedPattern.port) {
      continue;
    }
    const escapedHost = parsedPattern.hostname
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replaceAll('xwildcardx', '[a-z0-9-]+');
    if (new RegExp(`^${escapedHost}$`, 'i').test(parsedOrigin.hostname)) {
      return true;
    }
  }
  return false;
}

function response(
  body: unknown,
  status: number,
  origin: string | null,
  allowedOrigins: string[],
  options: { forceAllowOrigin?: boolean } = {},
): Response {
  const headers = new Headers(jsonHeaders);
  if (origin && (options.forceAllowOrigin || isOriginAllowed(origin, allowedOrigins))) {
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

function chatHistory(
  value: unknown[],
  maxCharacters = maxHistoryCharacters,
  systemInstruction = systemMessage,
): ChatMessage[] {
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
  return [{ role: 'system', content: systemInstruction }, ...history];
}

function isProvider(value: string): value is BusinessProvider {
  return value === 'groq' || value === 'gemini'
    || value === 'deepseek' || value === 'mistral' || value === 'grok'
    || value === 'cloudflare' || value === 'openrouter';
}

function parseRoutingOptions(raw: unknown): RoutingOptions {
  const record = object(raw);
  const selectionMode = record.selectionMode === 'manual' ? 'manual' : 'auto';
  const preferredProviderKey = typeof record.preferredProviderKey === 'string'
    ? record.preferredProviderKey.trim().toLowerCase() || null
    : null;
  const preferredModelKey = typeof record.preferredModelKey === 'string'
    ? record.preferredModelKey.trim() || null
    : null;
  const allowFallback = typeof record.allowFallback === 'boolean' ? record.allowFallback : true;
  return { selectionMode, preferredProviderKey, preferredModelKey, allowFallback };
}

export function createBusinessGrowHandler(dependencies: BusinessGrowDependencies) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('Origin');
    const originAllowed = isOriginAllowed(origin, dependencies.allowedOrigins);
    const corsHeaders = new Headers({
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    if (origin && originAllowed) {
      corsHeaders.set('Access-Control-Allow-Origin', origin);
      corsHeaders.set('Vary', 'Origin');
    }

    if (origin && !originAllowed) {
      // Le préflight et la requête refusés renvoient l'en-tête CORS de repli :
      // sans lui, le navigateur transforme ce 403 explicite en erreur réseau
      // (FunctionsFetchError), que le SaaS affichait à tort comme « backend
      // absent ou non déployé ». Le refus reste un 403, il devient seulement lisible.
      return response(
        failure('ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'),
        403,
        origin,
        dependencies.allowedOrigins,
        { forceAllowOrigin: true },
      );
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
      return response(failure('UNAUTHENTICATED', 'Session VYORA invalide ou expirée.'), 401, origin, dependencies.allowedOrigins);
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
        case 'providers.verify': {
          const providerKey = string(body.providerKey, 40).toLowerCase();
          if (!isProvider(providerKey)) {
            return response(
              failure('PROVIDER_ADAPTER_NOT_IMPLEMENTED', 'Cet adaptateur fournisseur n’est pas encore activé côté serveur.'),
              400,
              origin,
              dependencies.allowedOrigins,
            );
          }
          const baseConfig = dependencies.providerConfigs[providerKey];
          const requestedModel = string(body.modelKey, 120);
          const config: ProviderConfig = {
            apiKey: baseConfig?.apiKey ?? '',
            model: requestedModel || baseConfig?.model || '',
          };
          const probeFn = dependencies.probe ?? ((p, cfg) => probeProvider(p, cfg));
          const probeResult = await probeFn(providerKey, config);
          if (dependencies.store.recordHealthCheck) {
            await dependencies.store.recordHealthCheck(probeResult);
          }
          if (probeResult.status !== 'healthy') {
            const statusCode = probeResult.errorCode === 'PROVIDER_NOT_CONFIGURED' ? 503 : 502;
            return response(
              {
                error: {
                  code: probeResult.errorCode ?? 'PROVIDER_UNAVAILABLE',
                  message: probeResult.errorCode === 'PROVIDER_NOT_CONFIGURED'
                    ? 'Clé API ou modèle serveur manquant pour ce fournisseur Business Grow.'
                    : `La vérification réelle du fournisseur ${providerKey} a échoué (${probeResult.errorCode ?? 'PROVIDER_UNAVAILABLE'}).`,
                },
                data: probeResult,
              },
              statusCode,
              origin,
              dependencies.allowedOrigins,
            );
          }
          data = probeResult;
          break;
        }
        case 'models.list': {
          const providerKey = string(body.providerKey, 40).toLowerCase() || null;
          const includeRemote = body.includeRemote === true;
          const catalog = dependencies.store.listModels
            ? await dependencies.store.listModels(providerKey)
            : [];
          const remote: Record<string, string[]> = {};
          if (includeRemote) {
            const targets: BusinessProvider[] = providerKey && isProvider(providerKey)
              ? [providerKey]
              : dependencies.providerOrder;
            for (const target of targets) {
              const cfg = dependencies.providerConfigs[target];
              if (!cfg?.apiKey) continue;
              try {
                const discoverFn = dependencies.discoverModels ?? ((p, c) => listRemoteModels(p, c));
                remote[target] = await discoverFn(target, cfg);
              } catch {
                remote[target] = [];
              }
            }
          }
          data = { models: catalog, remoteModels: remote };
          break;
        }
        case 'roles.list': {
          const roles = dependencies.store.listRoles
            ? await dependencies.store.listRoles()
            : BUSINESS_ROLE_SPECS;
          data = { roles };
          break;
        }
        case 'routing.get': {
          const preferences = dependencies.store.getRoutingPreferences
            ? await dependencies.store.getRoutingPreferences(userId)
            : [];
          data = { preferences };
          break;
        }
        case 'routing.save': {
          const roleKey = normalizeRoleKey(body.roleKey);
          const routing = parseRoutingOptions(body);
          if (routing.selectionMode === 'manual' && !routing.preferredProviderKey) {
            return response(
              failure('INVALID_ROUTING_PREFERENCE', 'Sélectionnez un fournisseur valide pour le mode manuel.'),
              400,
              origin,
              dependencies.allowedOrigins,
            );
          }
          const id = dependencies.store.upsertRoutingPreference
            ? await dependencies.store.upsertRoutingPreference(userId, roleKey, {
                selectionMode: routing.selectionMode ?? 'auto',
                preferredProviderKey: routing.preferredProviderKey ?? null,
                preferredModelKey: routing.preferredModelKey ?? null,
                allowFallback: routing.allowFallback ?? true,
              })
            : null;
          data = { saved: true, id, roleKey, ...routing };
          break;
        }
        case 'quota.status': {
          data = dependencies.store.getQuota
            ? await dependencies.store.getQuota(userId)
            : {
                domain: 'business_grow',
                studio_ugc_untouched: true,
                available_units: null,
                reserved_units: 0,
                monthly_allowance: null,
              };
          break;
        }
        case 'requests.list': {
          const requests = dependencies.store.listRecentRequests
            ? await dependencies.store.listRecentRequests(userId, 25)
            : [];
          data = { requests };
          break;
        }
        case 'tools.list': {
          const conversationId = body.conversationId == null ? null : uuid(body.conversationId);
          if (body.conversationId != null && !conversationId) {
            return response(failure('INVALID_CONVERSATION', 'Conversation invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          const tools = dependencies.store.listToolExecutions
            ? await dependencies.store.listToolExecutions(userId, conversationId)
            : [];
          data = { tools };
          break;
        }
        case 'tools.resolve': {
          const executionId = uuid(body.executionId);
          const decision = body.decision === 'approved' || body.decision === 'rejected'
            ? body.decision
            : null;
          if (!executionId || !decision) {
            return response(failure('INVALID_TOOL_RESOLUTION', 'Identifiant d’outil et décision explicite requis.'), 400, origin, dependencies.allowedOrigins);
          }
          if (!dependencies.store.resolveToolExecution) {
            return response(failure('TOOLS_NOT_CONFIGURED', 'Le module d’outils n’est pas activé.'), 501, origin, dependencies.allowedOrigins);
          }
          let resolved: Record<string, unknown>;
          try {
            if (decision === 'rejected') {
              data = await dependencies.store.resolveToolExecution(userId, executionId, 'rejected', { rejectedByUser: true });
              break;
            }
            resolved = await dependencies.store.resolveToolExecution(userId, executionId, 'approved');
          } catch (toolError) {
            const msg = toolError instanceof Error ? toolError.message : '';
            if (msg.includes('already resolved')) {
              return response(failure('TOOL_ALREADY_RESOLVED', 'Cette proposition d’outil a déjà été traitée.'), 409, origin, dependencies.allowedOrigins);
            }
            if (msg.includes('tool execution not found')) {
              return response(failure('TOOL_NOT_FOUND', 'Proposition d’outil introuvable.'), 404, origin, dependencies.allowedOrigins);
            }
            throw toolError;
          }
          const args = object(resolved.input_args);
          if (resolved.tool_name === 'propose_memory_save') {
            const memory = (await dependencies.store.getMemory(userId)) as MemorySnapshot | null;
            if (!memory?.consent) {
              await dependencies.store.resolveToolExecution(userId, executionId, 'failed', {
                error: 'business_memory_consent_required',
              });
              return response(
                failure('business_memory_consent_required', 'Activez le consentement mémoire avant d’enregistrer cette note métier.'),
                409,
                origin,
                dependencies.allowedOrigins,
              );
            }
            const category = string(args.category, 80) || 'business_context';
            const summary = string(args.summary, 1000) || string(args.text, 1000) || JSON.stringify(args);
            const itemId = await dependencies.store.putMemoryItem(userId, null, category, { text: summary, ...args });
            data = await dependencies.store.resolveToolExecution(userId, executionId, 'executed', {
              memoryItemId: itemId,
            });
            break;
          }
          if (resolved.tool_name === 'handoff_ugc_brief') {
            const normalizedHandoff = normalizeToolProposalArguments('handoff_ugc_brief', args);
            data = await dependencies.store.resolveToolExecution(userId, executionId, 'executed', {
              handoffDraft: {
                ...normalizedHandoff,
                product: string(normalizedHandoff.product, 160) || string(args.summary, 160),
                angle: string(normalizedHandoff.angle, 400) || string(args.summary, 400),
                hook: string(normalizedHandoff.hook, 300),
                targetAudience: string(normalizedHandoff.targetAudience, 300),
                consumesStudioCredits: false,
              },
            });
            break;
          }
          if (resolved.tool_name === 'request_connector_read') {
            const connectorKey = string(args.connectorKey, 60);
            const connections = dependencies.store.listIntegrationConnections
              ? await dependencies.store.listIntegrationConnections(userId)
              : [];
            const active = connections.find((item) => {
              const record = object(item);
              return record.connector_key === connectorKey && record.status === 'connected';
            });
            if (!active) {
              data = await dependencies.store.resolveToolExecution(userId, executionId, 'failed', {
                error: 'CONNECTOR_NOT_CONNECTED',
                connectorKey,
              });
              break;
            }
          }
          data = await dependencies.store.resolveToolExecution(userId, executionId, 'executed', {
            acknowledged: true,
            args,
          });
          break;
        }
        case 'integrations.list': {
          const connections = dependencies.store.listIntegrationConnections
            ? await dependencies.store.listIntegrationConnections(userId)
            : [];
          data = { connections };
          break;
        }
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
          const roleKey = normalizeRoleKey(body.roleKey);
          const explicitRouting = body.routing && typeof body.routing === 'object' && !Array.isArray(body.routing)
            ? body.routing
            : null;
          let routing = parseRoutingOptions(explicitRouting);
          if (!explicitRouting && dependencies.store.getRoutingPreferences) {
            try {
              const savedPrefs = await dependencies.store.getRoutingPreferences(userId);
              const matched = savedPrefs.find((pref) => object(pref).role_key === roleKey);
              if (matched) {
                const prefRecord = object(matched);
                routing = parseRoutingOptions({
                  selectionMode: prefRecord.selection_mode,
                  preferredProviderKey: prefRecord.preferred_provider_key,
                  preferredModelKey: prefRecord.preferred_model_key,
                  allowFallback: prefRecord.allow_fallback,
                });
              }
            } catch {
              // Keep default auto routing if preference lookup fails.
            }
          }
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) {
            return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          }

          const requestHash = await sha256(`${conversationId}\n${roleKey}\n${content}`);

          // Ground prompt safely in consented Business Memory and authorized company context.
          let memorySnapshot: MemorySnapshot | null = null;
          try {
            memorySnapshot = (await dependencies.store.getMemory(userId)) as MemorySnapshot | null;
          } catch {
            memorySnapshot = null;
          }
          let workspaceContext: WorkspaceCompanyContext | null = null;
          if (workspaceId && dependencies.store.getWorkspaceContext) {
            try {
              workspaceContext = await dependencies.store.getWorkspaceContext(userId, workspaceId);
            } catch {
              workspaceContext = null;
            }
          }

          const systemInstruction = buildBusinessSystemInstruction({
            baseSystemMessage: systemMessage,
            roleKey,
            memory: memorySnapshot,
            workspaceContext,
          });

          const history = chatHistory(
            await dependencies.store.listMessages(userId, conversationId),
            maxHistoryCharacters - content.length,
            systemInstruction,
          );
          history.push({ role: 'user', content });

          const submitted = roleKey === 'business_advisor'
            ? await dependencies.store.submitUserMessage(
                userId, conversationId, content, idempotencyKey, requestHash,
              )
            : await dependencies.store.submitUserMessage(
                userId, conversationId, content, idempotencyKey, requestHash, roleKey,
              );
          if (!submitted.created) {
            data = { ...submitted, providerAvailable: false };
            break;
          }

          const reserveAmount = roleKey === 'business_analysis' || roleKey === 'action_plan' || roleKey === 'sales_analysis' ? 2 : 1;
          let quotaReserved = false;
          if (dependencies.store.reserveQuota) {
            try {
              await dependencies.store.reserveQuota(userId, submitted.requestId, reserveAmount, `bg:${roleKey}`);
              quotaReserved = true;
            } catch (quotaError) {
              const message = quotaError instanceof Error ? quotaError.message : '';
              const code = message.includes('BG_INSUFFICIENT_QUOTA') ? 'BG_INSUFFICIENT_QUOTA' : 'BG_QUOTA_ERROR';
              await dependencies.store.failRequest(userId, submitted.requestId, code);
              return response(
                failure(
                  code,
                  code === 'BG_INSUFFICIENT_QUOTA'
                    ? 'Quota Business Grow épuisé. Vos crédits Studio UGC ne sont jamais utilisés dans Business Grow.'
                    : 'Impossible de réserver le quota Business Grow.',
                ),
                code === 'BG_INSUFFICIENT_QUOTA' ? 402 : 503,
                origin,
                dependencies.allowedOrigins,
              );
            }
          }

          await dependencies.store.startRequest(userId, submitted.requestId);
          const excludedProviders: BusinessProvider[] = [];
          let previousAttemptId: string | null = null;
          let fallbackReason: string | null = null;
          let lastErrorCode = 'NO_VERIFIED_PROVIDER';

          const preferredOrder: BusinessProvider[] = routing.selectionMode === 'manual'
            && routing.preferredProviderKey
            && isProvider(routing.preferredProviderKey)
            ? [
                routing.preferredProviderKey,
                ...(routing.allowFallback !== false
                  ? dependencies.providerOrder.filter((p) => p !== routing.preferredProviderKey)
                  : []),
              ]
            : dependencies.providerOrder;
          const maxAttempts = routing.selectionMode === 'manual' && routing.allowFallback === false
            ? 1
            : preferredOrder.length;

          for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
            let route: Awaited<ReturnType<BusinessGrowStore['selectRoute']>>;
            const usePreferredModel = Boolean(routing.preferredModelKey && attemptNumber === 1);
            try {
              try {
                route = usePreferredModel
                  ? await dependencies.store.selectRoute(
                      userId,
                      submitted.requestId,
                      conversationId,
                      attemptNumber,
                      previousAttemptId,
                      fallbackReason,
                      preferredOrder,
                      [...excludedProviders],
                      routing.preferredModelKey,
                    )
                  : await dependencies.store.selectRoute(
                      userId,
                      submitted.requestId,
                      conversationId,
                      attemptNumber,
                      previousAttemptId,
                      fallbackReason,
                      preferredOrder,
                      [...excludedProviders],
                    );
              } catch (firstRouteError) {
                if (
                  firstRouteError instanceof NoVerifiedProviderRouteError
                  && usePreferredModel
                  && routing.allowFallback !== false
                ) {
                  route = await dependencies.store.selectRoute(
                    userId,
                    submitted.requestId,
                    conversationId,
                    attemptNumber,
                    previousAttemptId,
                    fallbackReason ?? 'PREFERRED_MODEL_UNAVAILABLE',
                    preferredOrder,
                    [...excludedProviders],
                  );
                } else {
                  throw firstRouteError;
                }
              }
            } catch (error) {
              if (error instanceof NoVerifiedProviderRouteError) {
                lastErrorCode = 'NO_VERIFIED_PROVIDER';
                break;
              }
              lastErrorCode = 'ROUTE_SELECTION_FAILED';
              if (quotaReserved && dependencies.store.releaseQuota) {
                await dependencies.store.releaseQuota(userId, submitted.requestId, reserveAmount, lastErrorCode);
              }
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
            const selectedModel = route.providerModelKey || config?.model || '';
            if (!config || !config.apiKey || !selectedModel) {
              lastErrorCode = 'PROVIDER_NOT_CONFIGURED';
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

            const effectiveConfig: ProviderConfig = config.model === selectedModel
              ? config
              : { apiKey: config.apiKey, model: selectedModel, accountId: config.accountId ?? null };

            const startedAt = Date.now();
            let result: ProviderReply;
            try {
              // Le route choisi par le registre (modèle + rôle) part avec
              // l'appel : le moteur central l'exécute en tête de chaîne et
              // peut basculer sur un secours compatible (VYORA AI CORE).
              result = await dependencies.complete(provider, effectiveConfig, history, {
                model: selectedModel,
                roleKey,
              });
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

            const { cleanText, proposals } = extractToolProposals(result.content);
            await dependencies.store.finalizeAttempt(userId, submitted.requestId, route.attemptId, {
              status: 'succeeded',
              errorCode: null,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              latencyMs: Date.now() - startedAt,
              outputContent: cleanText,
            });

            if (quotaReserved && dependencies.store.captureQuota) {
              await dependencies.store.captureQuota(userId, submitted.requestId, reserveAmount, reserveAmount);
            }

            const createdTools: Array<{ id: string | null } & ExtractedToolProposal> = [];
            for (const proposal of proposals) {
              let execId: string | null = null;
              if (dependencies.store.createToolExecution) {
                try {
                  execId = await dependencies.store.createToolExecution(
                    userId, conversationId, submitted.requestId, proposal,
                  );
                } catch {
                  execId = null;
                }
              }
              createdTools.push({ id: execId, ...proposal });
            }

            data = {
              ...submitted,
              status: 'succeeded',
              providerAvailable: true,
              provider: {
                key: result.provider && result.provider !== provider ? result.provider : provider,
                model: result.model ?? route.providerModelKey,
                routedFrom: result.provider && result.provider !== provider ? provider : null,
              },
              roleKey,
              fallbackUsed: attemptNumber > 1,
              attemptsCount: attemptNumber,
              assistantReply: cleanText,
              usage: {
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
              },
              toolProposals: createdTools,
            };
            return response({ data }, 200, origin, dependencies.allowedOrigins);
          }

          if (quotaReserved && dependencies.store.releaseQuota) {
            await dependencies.store.releaseQuota(userId, submitted.requestId, reserveAmount, lastErrorCode);
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
          try {
            data = { itemId: await dependencies.store.putMemoryItem(userId, itemId, category, body.content) };
          } catch (memoryError) {
            const msg = memoryError instanceof Error ? memoryError.message : '';
            if (msg.includes('active memory consent required')) {
              return response(
                failure('business_memory_consent_required', 'Activez le consentement mémoire avant d’enregistrer une note métier.'),
                409,
                origin,
                dependencies.allowedOrigins,
              );
            }
            if (msg.includes('memory item not found')) {
              return response(failure('MEMORY_ITEM_NOT_FOUND', 'Note mémoire introuvable.'), 404, origin, dependencies.allowedOrigins);
            }
            throw memoryError;
          }
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
