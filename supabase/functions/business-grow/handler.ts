import { buildBusinessReport, defaultPeriod, isReportType, reportForModel, validDate, validPeriod, type BusinessReport, type BusinessSnapshot, type ReportType } from './diagnostics.ts';
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
  | 'integrations.list'
  | 'integrations.request'
  | 'integrations.cancel'
  | 'integrations.disconnect'
  | 'modules.records'
  | 'automation.task.confirm'
  | 'agent.report'
  | 'agent.reports.list'
  | 'agent.reports.delete'
  | 'agent.task.propose'
  | 'memory.legacy.import';

// Une action préfixée ne peut pas être comprise par l'Edge historique v22.
// Le client Phase 3 évite ainsi qu'un ancien serveur ignore workspaceId et
// lise ou modifie silencieusement le périmètre personnel.
const WORKSPACE_ACTIONS = new Set<string>([
  'requests.list', 'tools.list', 'tools.resolve',
  'integrations.list', 'integrations.request', 'integrations.cancel', 'integrations.disconnect',
  'conversations.list', 'conversations.create', 'conversations.rename', 'conversations.delete',
  'messages.list', 'messages.send', 'memory.get', 'memory.consent', 'memory.profile.save',
  'memory.item.put', 'memory.item.delete', 'memory.legacy.import', 'modules.records',
  'agent.report', 'agent.reports.list', 'agent.reports.delete', 'agent.task.propose', 'automation.task.confirm',
]);

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
  listScopedRecentRequests?: (userId: string, workspaceId: string, limit?: number) => Promise<unknown[]>;
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
  requestIntegrationConnection?: (userId: string, connectorKey: string, workspaceId: string | null) => Promise<string>;
  cancelIntegrationRequest?: (userId: string, connectorKey: string) => Promise<boolean>;
  disconnectIntegrationConnection?: (userId: string, connectorKey: string) => Promise<boolean>;
  listScopedIntegrationConnections?: (userId: string, workspaceId: string) => Promise<unknown[]>;
  requestScopedIntegrationConnection?: (userId: string, workspaceId: string, connectorKey: string) => Promise<string>;
  cancelScopedIntegrationRequest?: (userId: string, workspaceId: string, connectorKey: string) => Promise<boolean>;
  disconnectScopedIntegrationConnection?: (userId: string, workspaceId: string, connectorKey: string) => Promise<boolean>;
  listModuleRecords?: (userId: string, category: string) => Promise<unknown[]>;
  createModuleRecord?: (userId: string, category: string, data: Record<string, unknown>, dedupeKey?: string | null) => Promise<string>;
  updateModuleRecord?: (userId: string, recordId: string, data: Record<string, unknown>) => Promise<boolean>;
  deleteModuleRecord?: (userId: string, recordId: string) => Promise<boolean>;
  // Phase 3 : services dédiés au périmètre utilisateur + entreprise.
  getWorkspaceProtocol?: (userId: string, workspaceId: string) => Promise<string>;
  resolveScopedAgentTool?: (userId: string, workspaceId: string, executionId: string, decision: 'approved' | 'rejected') => Promise<unknown>;
  getConversationScope?: (userId: string, conversationId: string) => Promise<{ workspaceId: string | null } | null>;
  listScopedConversations?: (userId: string, workspaceId: string) => Promise<unknown[]>;
  getScopedMemory?: (userId: string, workspaceId: string) => Promise<unknown>;
  setScopedMemoryConsent?: (userId: string, workspaceId: string, enabled: boolean, policy: string) => Promise<unknown>;
  saveScopedMemoryProfile?: (userId: string, workspaceId: string, profile: Record<string, unknown>) => Promise<void>;
  putScopedMemoryItem?: (userId: string, workspaceId: string, itemId: string | null, category: string, content: unknown) => Promise<string>;
  deleteScopedMemoryItem?: (userId: string, workspaceId: string, itemId: string) => Promise<boolean>;
  importLegacyMemory?: (userId: string, workspaceId: string) => Promise<unknown>;
  listScopedModuleRecords?: (userId: string, workspaceId: string, category: string) => Promise<unknown[]>;
  createScopedModuleRecord?: (userId: string, workspaceId: string, category: string, data: Record<string, unknown>, dedupeKey: string | null) => Promise<string>;
  updateScopedModuleRecord?: (userId: string, workspaceId: string, category: string, recordId: string, data: Record<string, unknown>) => Promise<boolean>;
  deleteScopedModuleRecord?: (userId: string, workspaceId: string, category: string, recordId: string) => Promise<boolean>;
  confirmAutomationTask?: (userId: string, workspaceId: string, playbookId: string, sourceCategory: string, sourceId: string, previewDay: string, expectedPlaybook: Record<string, unknown>, expectedSource: Record<string, unknown>, task: Record<string, unknown>) => Promise<{ taskId: string; created: boolean }>;
  getBusinessSnapshot?: (userId: string, workspaceId: string) => Promise<BusinessSnapshot>;
  saveAgentReport?: (userId: string, workspaceId: string, type: ReportType, from: string, to: string, idempotencyKey: string, report: BusinessReport) => Promise<unknown>;
  listAgentReports?: (userId: string, workspaceId: string) => Promise<unknown[]>;
  deleteAgentReport?: (userId: string, workspaceId: string, reportId: string) => Promise<boolean>;
  proposeAgentTask?: (userId: string, workspaceId: string, conversationId: string, category: string, sourceId: string, idempotencyKey: string) => Promise<unknown>;
  resolveAgentTool?: (userId: string, executionId: string, decision: 'approved' | 'rejected') => Promise<unknown>;
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

const INTEGRATION_CONNECTOR_KEYS = new Set(['facebook', 'instagram', 'youtube', 'tiktok', 'shopify', 'woocommerce']);

function integrationConnectorKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return INTEGRATION_CONNECTOR_KEYS.has(key) ? key : null;
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
  return value === 'groq' || value === 'gemini';
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

    if (request.method === 'OPTIONS') {
      // Un préflight 403 est opaque dans le navigateur, même avec Allow-Origin.
      // Autoriser uniquement la négociation CORS permet au POST de renvoyer un
      // refus lisible ; aucune donnée ni action n'est exposée par OPTIONS.
      if (origin && !originAllowed) {
        corsHeaders.set('Access-Control-Allow-Origin', origin);
        corsHeaders.set('Vary', 'Origin');
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (origin && !originAllowed) {
      // Le POST est toujours refusé AVANT authentification et accès au store.
      // L'en-tête CORS rend uniquement ce 403 lisible par l'origine refusée.
      return response(
        failure('ORIGIN_NOT_ALLOWED', 'Origine non autorisée.'),
        403,
        origin,
        dependencies.allowedOrigins,
        { forceAllowOrigin: true },
      );
    }
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

    const rawAction = string(body.action, 60);
    const versionedWorkspaceAction = rawAction.startsWith('v3.');
    const action = (versionedWorkspaceAction ? rawAction.slice(3) : rawAction) as BusinessAction;
    try {
      let scopedWorkspace: string | null = null;
      if (versionedWorkspaceAction) {
        if (!WORKSPACE_ACTIONS.has(action)) return response(failure('UNKNOWN_ACTION', 'Opération Business Grow inconnue.'), 400, origin, dependencies.allowedOrigins);
        scopedWorkspace = uuid(body.workspaceId);
        if (!scopedWorkspace) return response(failure('INVALID_WORKSPACE', 'Entreprise requise.'), 400, origin, dependencies.allowedOrigins);
        if (!dependencies.store.getWorkspaceProtocol) return response(failure('AGENT_UNAVAILABLE', 'Le stockage par entreprise n’est pas disponible.'), 503, origin, dependencies.allowedOrigins);
        let protocol: string;
        try { protocol = await dependencies.store.getWorkspaceProtocol(userId, scopedWorkspace); }
        catch (error) {
          if (error instanceof Error && error.message.includes('workspace access denied')) throw error;
          return response(failure('AGENT_UNAVAILABLE', 'Le stockage par entreprise n’est pas disponible.'), 503, origin, dependencies.allowedOrigins);
        }
        if (protocol !== 'business-workspace-v3') return response(failure('AGENT_UNAVAILABLE', 'Le stockage par entreprise n’est pas compatible.'), 503, origin, dependencies.allowedOrigins);
        // Pour ces opérations, l'identifiant seul ne suffit pas : vérifier qu'il
        // correspond aussi à l'entreprise active avant la lecture ou mutation.
        if (['conversations.rename', 'conversations.delete', 'messages.list', 'tools.list'].includes(action)) {
          const conversationId = uuid(body.conversationId);
          if (!conversationId) return response(failure('INVALID_CONVERSATION', 'Conversation requise.'), 400, origin, dependencies.allowedOrigins);
          if (!dependencies.store.getConversationScope) return response(failure('AGENT_UNAVAILABLE', 'Périmètre de conversation indisponible.'), 503, origin, dependencies.allowedOrigins);
          const scope = await dependencies.store.getConversationScope(userId, conversationId);
          if (!scope || scope.workspaceId !== scopedWorkspace) return response(failure('CONVERSATION_NOT_FOUND', 'Conversation introuvable dans cette entreprise.'), 404, origin, dependencies.allowedOrigins);
        }
      }
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
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.listScopedRecentRequests) return response(failure('AGENT_UNAVAILABLE', 'Historique par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          const requests = workspaceId ? await dependencies.store.listScopedRecentRequests!(userId, workspaceId, 25)
            : dependencies.store.listRecentRequests ? await dependencies.store.listRecentRequests(userId, 25) : [];
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
          if (scopedWorkspace) {
            if (!dependencies.store.resolveScopedAgentTool) return response(failure('TOOLS_NOT_CONFIGURED', 'Le module d’outils par entreprise n’est pas activé.'), 503, origin, dependencies.allowedOrigins);
            data = await dependencies.store.resolveScopedAgentTool(userId, scopedWorkspace, executionId, decision);
            break;
          }
          if (!dependencies.store.resolveToolExecution && !dependencies.store.resolveAgentTool) {
            return response(failure('TOOLS_NOT_CONFIGURED', 'Le module d’outils n’est pas activé.'), 501, origin, dependencies.allowedOrigins);
          }
          // En production, validation + effet + journal sont une seule transaction SQL.
          // Une répétition de la même décision retourne le résultat initial.
          if (dependencies.store.resolveAgentTool) {
            data = await dependencies.store.resolveAgentTool(userId, executionId, decision);
            break;
          }
          let resolved: Record<string, unknown>;
          try {
            if (decision === 'rejected') {
              data = await dependencies.store.resolveToolExecution!(userId, executionId, 'rejected', { rejectedByUser: true });
              break;
            }
            resolved = await dependencies.store.resolveToolExecution!(userId, executionId, 'approved');
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
              await dependencies.store.resolveToolExecution!(userId, executionId, 'failed', {
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
            data = await dependencies.store.resolveToolExecution!(userId, executionId, 'executed', {
              memoryItemId: itemId,
            });
            break;
          }
          if (resolved.tool_name === 'handoff_ugc_brief') {
            const normalizedHandoff = normalizeToolProposalArguments('handoff_ugc_brief', args);
            data = await dependencies.store.resolveToolExecution!(userId, executionId, 'executed', {
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
              data = await dependencies.store.resolveToolExecution!(userId, executionId, 'failed', {
                error: 'CONNECTOR_NOT_CONNECTED',
                connectorKey,
              });
              break;
            }
          }
          // Ne jamais présenter un accusé de réception comme une action métier exécutée.
          data = await dependencies.store.resolveToolExecution!(userId, executionId, 'failed', {
            error: 'ATOMIC_TOOL_SERVICE_UNAVAILABLE',
          });
          break;
        }
        case 'integrations.list': {
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.listScopedIntegrationConnections) return response(failure('INTEGRATIONS_UNAVAILABLE', 'Intégrations par entreprise indisponibles.'), 503, origin, dependencies.allowedOrigins);
          if (!workspaceId && !dependencies.store.listIntegrationConnections) return response(failure('INTEGRATIONS_UNAVAILABLE', 'Intégrations indisponibles.'), 503, origin, dependencies.allowedOrigins);
          const connections = workspaceId
            ? await dependencies.store.listScopedIntegrationConnections!(userId, workspaceId)
            : await dependencies.store.listIntegrationConnections!(userId);
          data = { connections }; break;
        }
        case 'integrations.request': {
          const connectorKey = integrationConnectorKey(body.connectorKey);
          if (!connectorKey) return response(failure('INVALID_CONNECTOR', 'Connecteur inconnu.'), 400, origin, dependencies.allowedOrigins);
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          // L'ancienne interface envoie l'entreprise à la demande, mais omet
          // ensuite ce périmètre à la lecture/annulation : un succès serait invisible.
          if (workspaceId && !scopedWorkspace) return response(failure('BUSINESS_GROW_UPGRADE_REQUIRED', 'Actualisez Business Grow avant de demander une intégration pour cette entreprise.'), 409, origin, dependencies.allowedOrigins);
          if (workspaceId ? !dependencies.store.requestScopedIntegrationConnection : !dependencies.store.requestIntegrationConnection) {
            return response(failure('INTEGRATIONS_UNAVAILABLE', 'Les demandes de connexion ne sont pas encore disponibles.'), 503, origin, dependencies.allowedOrigins);
          }
          const status = workspaceId
            ? await dependencies.store.requestScopedIntegrationConnection!(userId, workspaceId, connectorKey)
            : await dependencies.store.requestIntegrationConnection!(userId, connectorKey, null);
          data = { connectorKey, status }; break;
        }
        case 'integrations.cancel': {
          const connectorKey = integrationConnectorKey(body.connectorKey);
          if (!connectorKey) return response(failure('INVALID_CONNECTOR', 'Connecteur inconnu.'), 400, origin, dependencies.allowedOrigins);
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId ? !dependencies.store.cancelScopedIntegrationRequest : !dependencies.store.cancelIntegrationRequest) {
            return response(failure('INTEGRATIONS_UNAVAILABLE', 'Les demandes de connexion ne sont pas encore disponibles.'), 503, origin, dependencies.allowedOrigins);
          }
          const cancelled = workspaceId
            ? await dependencies.store.cancelScopedIntegrationRequest!(userId, workspaceId, connectorKey)
            : await dependencies.store.cancelIntegrationRequest!(userId, connectorKey);
          data = { connectorKey, cancelled }; break;
        }
        case 'integrations.disconnect': {
          const connectorKey = integrationConnectorKey(body.connectorKey);
          if (!connectorKey) return response(failure('INVALID_CONNECTOR', 'Connecteur inconnu.'), 400, origin, dependencies.allowedOrigins);
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId ? !dependencies.store.disconnectScopedIntegrationConnection : !dependencies.store.disconnectIntegrationConnection) {
            return response(failure('INTEGRATIONS_UNAVAILABLE', 'La déconnexion locale n’est pas encore disponible.'), 503, origin, dependencies.allowedOrigins);
          }
          const disconnected = workspaceId
            ? await dependencies.store.disconnectScopedIntegrationConnection!(userId, workspaceId, connectorKey)
            : await dependencies.store.disconnectIntegrationConnection!(userId, connectorKey);
          data = { connectorKey, disconnected }; break;
        }
        case 'agent.report': {
          const workspaceId = uuid(body.workspaceId);
          const type = body.reportType;
          const from = body.from; const to = body.to;
          if (!workspaceId || !isReportType(type) || !validPeriod(from, to) || typeof to !== 'string') {
            return response(failure('INVALID_REPORT', 'Entreprise, type et période valide (366 jours maximum) sont requis.'), 400, origin, dependencies.allowedOrigins);
          }
          if (!dependencies.store.getBusinessSnapshot) {
            return response(failure('AGENT_UNAVAILABLE', 'L’analyse métier n’est pas encore disponible.'), 503, origin, dependencies.allowedOrigins);
          }
          const snapshot = await dependencies.store.getBusinessSnapshot(userId, workspaceId);
          const report = buildBusinessReport(snapshot, type, from, to);
          if (body.save === true) {
            const idempotencyKey = uuid(body.idempotencyKey);
            if (!idempotencyKey || !dependencies.store.saveAgentReport) {
              return response(failure('INVALID_REPORT', 'Une clé d’idempotence est requise pour enregistrer le rapport.'), 400, origin, dependencies.allowedOrigins);
            }
            data = await dependencies.store.saveAgentReport(userId, workspaceId, type, from, to, idempotencyKey, report);
          } else data = { report, saved: false };
          break;
        }
        case 'agent.reports.list': {
          const workspaceId = uuid(body.workspaceId);
          if (!workspaceId) return response(failure('INVALID_WORKSPACE', 'Entreprise requise.'), 400, origin, dependencies.allowedOrigins);
          if (!dependencies.store.listAgentReports) return response(failure('AGENT_UNAVAILABLE', 'Rapports indisponibles.'), 503, origin, dependencies.allowedOrigins);
          data = { reports: await dependencies.store.listAgentReports(userId, workspaceId) };
          break;
        }
        case 'agent.reports.delete': {
          const workspaceId = uuid(body.workspaceId); const reportId = uuid(body.reportId);
          if (!workspaceId || !reportId) return response(failure('INVALID_REPORT', 'Entreprise et rapport requis.'), 400, origin, dependencies.allowedOrigins);
          if (!dependencies.store.deleteAgentReport) return response(failure('AGENT_UNAVAILABLE', 'Suppression de rapport indisponible.'), 503, origin, dependencies.allowedOrigins);
          const deleted = await dependencies.store.deleteAgentReport(userId, workspaceId, reportId);
          if (!deleted) return response(failure('REPORT_NOT_FOUND', 'Rapport introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
          data = { deleted }; break;
        }
        case 'agent.task.propose': {
          const workspaceId = uuid(body.workspaceId); const conversationId = uuid(body.conversationId);
          const sourceId = uuid(body.sourceRecordId); const key = uuid(body.idempotencyKey);
          const category = string(body.sourceCategory, 80);
          if (!workspaceId || !conversationId || !sourceId || !key || !/^(growth_prospect|bg_module_[a-z0-9_]{2,60})$/.test(category)) {
            return response(failure('INVALID_TASK_PROPOSAL', 'Entreprise, conversation et source valide sont requises.'), 400, origin, dependencies.allowedOrigins);
          }
          if (!dependencies.store.proposeAgentTask) return response(failure('AGENT_UNAVAILABLE', 'Propositions de tâches indisponibles.'), 503, origin, dependencies.allowedOrigins);
          data = await dependencies.store.proposeAgentTask(userId, workspaceId, conversationId, category, sourceId, key);
          break;
        }
        case 'automation.task.confirm': {
          // Cette opération n'existe que dans le protocole scoped : aucun repli
          // vers une création historique personnelle ou sans contrôle de source.
          if (!scopedWorkspace) return response(failure('INVALID_WORKSPACE', 'Protocole d’entreprise requis.'), 400, origin, dependencies.allowedOrigins);
          const playbookId = uuid(body.playbookId), sourceId = uuid(body.sourceId);
          const category = string(body.sourceCategory, 80);
          const expectedPlaybook = object(body.expectedPlaybook), expectedSource = object(body.expectedSource), task = object(body.task);
          if (!playbookId || !sourceId || !validDate(body.previewDay) || ![
            'bg_module_lead_rescue', 'bg_module_order_cart_recovery', 'bg_module_payment_recovery',
            'bg_module_customer_recovery', 'bg_module_smart_inventory',
          ].includes(category) || !Object.keys(expectedPlaybook).length || !Object.keys(expectedSource).length || !Object.keys(task).length) {
            return response(failure('INVALID_AUTOMATION_TASK', 'Aperçu d’automatisation invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          if (!dependencies.store.confirmAutomationTask) return response(failure('AGENT_UNAVAILABLE', 'Confirmation d’automatisation indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = await dependencies.store.confirmAutomationTask(userId, scopedWorkspace, playbookId, category, sourceId, body.previewDay, expectedPlaybook, expectedSource, task);
          break;
        }
        case 'modules.records': {
          const category = string(body.category, 80);
          const op = string(body.op, 20) || 'list';
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (!/^bg_module_[a-z0-9_]{2,60}$/.test(category)) {
            return response(failure('INVALID_MODULE', 'Module métier inconnu.'), 400, origin, dependencies.allowedOrigins);
          }
          if (workspaceId ? !dependencies.store.listScopedModuleRecords : !dependencies.store.listModuleRecords) {
            return response(failure('MODULES_UNAVAILABLE', 'Le stockage des modules métier n’est pas encore déployé.'), 503, origin, dependencies.allowedOrigins);
          }
          if (op === 'list') {
            data = { records: workspaceId
              ? await dependencies.store.listScopedModuleRecords!(userId, workspaceId, category)
              : await dependencies.store.listModuleRecords!(userId, category) };
            break;
          }
          if (op === 'create') {
            const recordData = object(body.data);
            if (!Object.keys(recordData).length || (workspaceId ? !dependencies.store.createScopedModuleRecord : !dependencies.store.createModuleRecord)) {
              return response(failure('INVALID_MODULE_DATA', 'Données du module invalides.'), 400, origin, dependencies.allowedOrigins);
            }
            const dedupeKey = body.dedupeKey == null ? null : string(body.dedupeKey, 200) || null;
            const recordId = workspaceId
              ? await dependencies.store.createScopedModuleRecord!(userId, workspaceId, category, recordData, dedupeKey)
              : await dependencies.store.createModuleRecord!(userId, category, recordData, dedupeKey);
            data = { recordId }; break;
          }
          if (op === 'update') {
            const recordId = uuid(body.recordId); const recordData = object(body.data);
            if (!recordId || !Object.keys(recordData).length || (workspaceId ? !dependencies.store.updateScopedModuleRecord : !dependencies.store.updateModuleRecord)) {
              return response(failure('INVALID_MODULE_RECORD', 'Enregistrement ou données invalides.'), 400, origin, dependencies.allowedOrigins);
            }
            const updated = workspaceId
              ? await dependencies.store.updateScopedModuleRecord!(userId, workspaceId, category, recordId, recordData)
              : await dependencies.store.updateModuleRecord!(userId, recordId, recordData);
            if (!updated) return response(failure('MODULE_RECORD_NOT_FOUND', 'Enregistrement introuvable.'), 404, origin, dependencies.allowedOrigins);
            data = { updated }; break;
          }
          if (op === 'delete') {
            const recordId = uuid(body.recordId);
            if (!recordId || (workspaceId ? !dependencies.store.deleteScopedModuleRecord : !dependencies.store.deleteModuleRecord)) {
              return response(failure('INVALID_MODULE_RECORD', 'Enregistrement invalide.'), 400, origin, dependencies.allowedOrigins);
            }
            const deleted = workspaceId
              ? await dependencies.store.deleteScopedModuleRecord!(userId, workspaceId, category, recordId)
              : await dependencies.store.deleteModuleRecord!(userId, recordId);
            if (!deleted) return response(failure('MODULE_RECORD_NOT_FOUND', 'Enregistrement introuvable.'), 404, origin, dependencies.allowedOrigins);
            data = { deleted }; break;
          }
          return response(failure('INVALID_MODULE_OPERATION', 'Opération de module inconnue.'), 400, origin, dependencies.allowedOrigins);
        }
        case 'conversations.list': {
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.listScopedConversations) return response(failure('AGENT_UNAVAILABLE', 'Historique par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = { conversations: workspaceId ? await dependencies.store.listScopedConversations!(userId, workspaceId) : await dependencies.store.listConversations(userId) };
          break;
        }
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
          if (dependencies.store.getConversationScope && !await dependencies.store.getConversationScope(userId, conversationId)) {
            return response(failure('CONVERSATION_NOT_FOUND', 'Conversation introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
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
          const requestedWorkspace = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !requestedWorkspace) {
            return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          }
          let workspaceId = requestedWorkspace;
          if (dependencies.store.getConversationScope) {
            const scope = await dependencies.store.getConversationScope(userId, conversationId);
            if (!scope) return response(failure('CONVERSATION_NOT_FOUND', 'Conversation introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
            if (requestedWorkspace && requestedWorkspace !== scope.workspaceId) {
              return response(failure('CONVERSATION_SCOPE_MISMATCH', 'Cette conversation appartient à un autre espace. Créez une nouvelle conversation.'), 403, origin, dependencies.allowedOrigins);
            }
            workspaceId = scope.workspaceId;
          }

          const requestHash = await sha256(`${conversationId}\n${roleKey}\n${content}`);

          // Une conversation d'entreprise ne lit jamais la mémoire personnelle historique.
          let memorySnapshot: MemorySnapshot | null = null;
          try {
            memorySnapshot = (workspaceId
              ? dependencies.store.getScopedMemory ? await dependencies.store.getScopedMemory(userId, workspaceId) : null
              : await dependencies.store.getMemory(userId)) as MemorySnapshot | null;
          } catch { memorySnapshot = null; }
          let workspaceContext: WorkspaceCompanyContext | null = null;
          if (workspaceId && dependencies.store.getWorkspaceContext) {
            try { workspaceContext = await dependencies.store.getWorkspaceContext(userId, workspaceId); }
            catch { workspaceContext = null; }
          }
          let diagnosticContext: string | null = null;
          if (workspaceId) {
            try {
              if (!dependencies.store.getBusinessSnapshot) throw new Error('snapshot unavailable');
              const period = defaultPeriod();
              const snapshot = await dependencies.store.getBusinessSnapshot(userId, workspaceId);
              diagnosticContext = reportForModel(buildBusinessReport(snapshot, 'health', period.from, period.to));
            } catch {
              diagnosticContext = 'Données des modules indisponibles : aucun diagnostic chiffré ne peut être confirmé.';
            }
          }
          const systemInstruction = buildBusinessSystemInstruction({
            baseSystemMessage: systemMessage,
            roleKey,
            memory: memorySnapshot,
            workspaceContext,
            diagnosticContext,
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
              : { apiKey: config.apiKey, model: selectedModel };

            const startedAt = Date.now();
            let result: ProviderReply;
            try {
              result = await dependencies.complete(provider, effectiveConfig, history);
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
        case 'memory.get': {
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.getScopedMemory) return response(failure('AGENT_UNAVAILABLE', 'Mémoire par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = workspaceId ? await dependencies.store.getScopedMemory!(userId, workspaceId) : await dependencies.store.getMemory(userId);
          break;
        }
        case 'memory.consent': {
          if (typeof body.enabled !== 'boolean') return response(failure('INVALID_CONSENT', 'Le consentement doit être activé ou révoqué.'), 400, origin, dependencies.allowedOrigins);
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.setScopedMemoryConsent) return response(failure('AGENT_UNAVAILABLE', 'Mémoire par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = workspaceId
            ? await dependencies.store.setScopedMemoryConsent!(userId, workspaceId, body.enabled, 'business-grow-workspace-memory-v1')
            : await dependencies.store.setMemoryConsent(userId, body.enabled, 'business-grow-memory-v1');
          break;
        }
        case 'memory.profile.save': {
          const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.saveScopedMemoryProfile) return response(failure('AGENT_UNAVAILABLE', 'Mémoire par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          if (workspaceId) await dependencies.store.saveScopedMemoryProfile!(userId, workspaceId, object(body.profile));
          else await dependencies.store.saveMemoryProfile(userId, object(body.profile));
          data = { saved: true }; break;
        }
        case 'memory.item.put': {
          const category = string(body.category, 80); const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (!category || body.content == null) return response(failure('INVALID_MEMORY_ITEM', 'La catégorie et le contenu sont obligatoires.'), 400, origin, dependencies.allowedOrigins);
          const itemId = body.itemId == null ? null : uuid(body.itemId);
          if (body.itemId != null && !itemId) return response(failure('INVALID_MEMORY_ITEM', 'Identifiant mémoire invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.putScopedMemoryItem) return response(failure('AGENT_UNAVAILABLE', 'Mémoire par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = { itemId: workspaceId
            ? await dependencies.store.putScopedMemoryItem!(userId, workspaceId, itemId, category, body.content)
            : await dependencies.store.putMemoryItem(userId, itemId, category, body.content) };
          break;
        }
        case 'memory.item.delete': {
          const itemId = uuid(body.itemId); const workspaceId = body.workspaceId == null ? null : uuid(body.workspaceId);
          if (body.workspaceId != null && !workspaceId) return response(failure('INVALID_WORKSPACE', 'Espace de travail invalide.'), 400, origin, dependencies.allowedOrigins);
          if (!itemId) return response(failure('INVALID_MEMORY_ITEM', 'Identifiant mémoire invalide.'), 400, origin, dependencies.allowedOrigins);
          if (workspaceId && !dependencies.store.deleteScopedMemoryItem) return response(failure('AGENT_UNAVAILABLE', 'Mémoire par entreprise indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = { deleted: workspaceId ? await dependencies.store.deleteScopedMemoryItem!(userId, workspaceId, itemId) : await dependencies.store.deleteMemoryItem(userId, itemId) };
          break;
        }
        case 'memory.legacy.import': {
          const workspaceId = uuid(body.workspaceId);
          if (!workspaceId || body.confirmed !== true) return response(failure('CONFIRMATION_REQUIRED', 'Confirmez explicitement l’import dans cette entreprise.'), 400, origin, dependencies.allowedOrigins);
          if (!dependencies.store.importLegacyMemory) return response(failure('AGENT_UNAVAILABLE', 'Import indisponible.'), 503, origin, dependencies.allowedOrigins);
          data = await dependencies.store.importLegacyMemory(userId, workspaceId); break;
        }
        default:
          return response(failure('UNKNOWN_ACTION', 'Opération Business Grow inconnue.'), 400, origin, dependencies.allowedOrigins);
      }

      return response({ data }, 200, origin, dependencies.allowedOrigins);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('workspace access denied')) return response(failure('WORKSPACE_ACCESS_DENIED', 'Accès refusé à cette entreprise ou rôle insuffisant.'), 403, origin, dependencies.allowedOrigins);
      if (message.includes('active memory consent required') || message.includes('memory consent revoked') || message.includes('memory consent required')) {
        return response(failure('business_memory_consent_required', 'Activez le consentement mémoire de cette entreprise avant cette opération.'), 409, origin, dependencies.allowedOrigins);
      }
      if (message.includes('idempotency key conflict')) return response(failure('IDEMPOTENCY_CONFLICT', 'Cette clé correspond à une autre opération.'), 409, origin, dependencies.allowedOrigins);
      if (message.includes('agent source changed')) return response(failure('AGENT_SOURCE_CHANGED', 'Les données source ont changé. Relancez le diagnostic avant de confirmer.'), 409, origin, dependencies.allowedOrigins);
      if (message.includes('automation source changed') || message.includes('automation source no longer eligible')) return response(failure('AUTOMATION_SOURCE_CHANGED', 'La règle ou sa source a changé. Recalculez l’aperçu avant de confirmer.'), 409, origin, dependencies.allowedOrigins);
      if (message.includes('automation preview expired')) return response(failure('AUTOMATION_PREVIEW_EXPIRED', 'La date UTC de l’aperçu a changé. Recalculez-le avant de confirmer.'), 409, origin, dependencies.allowedOrigins);
      if (message.includes('invalid automation')) return response(failure('INVALID_AUTOMATION_TASK', 'Aperçu d’automatisation invalide. Recalculez-le.'), 400, origin, dependencies.allowedOrigins);
      if (message.includes('already resolved')) return response(failure('TOOL_ALREADY_RESOLVED', 'Cette proposition ou sa source a déjà été traitée.'), 409, origin, dependencies.allowedOrigins);
      if (message.includes('agent source not found') || message.includes('conversation not found') || message.includes('tool execution not found') || message.includes('memory item not found')) {
        return response(failure('RECORD_NOT_FOUND', 'Enregistrement introuvable ou inaccessible.'), 404, origin, dependencies.allowedOrigins);
      }
      if (message.includes('limit reached')) return response(failure('RECORD_LIMIT_REACHED', 'Limite de stockage atteinte pour cette entreprise.'), 409, origin, dependencies.allowedOrigins);
      console.error('business-grow request failed', { action });
      return response(failure('BUSINESS_GROW_BACKEND_ERROR', 'Le service Business Grow est temporairement indisponible.'), 500, origin, dependencies.allowedOrigins);
    }
  };
}
