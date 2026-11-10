// Reelora Central AI Engine — Multi-Provider Orchestrator & Business Grow Intelligence.
// - Groq & Google Gemini adapters with automatic fallback, cost tracking, routing rules.
// - Extensible registry prepared for OpenAI, Anthropic Claude, DeepSeek, Mistral.
// - Business Grow AI credits are strictly isolated from Studio UGC credits (`bg_wallets` vs `ugc_wallets`).
// - NEVER reads or logs secrets to responses; NEVER claims a provider is connected without a live call;
//   NEVER fabricates AI responses when providers are unconfigured or fail.

import type {
  AIProviderKey,
  AISpace,
  AITaskType,
  AIChatMessage,
  CostTier,
  RoutingRuleInput,
  SelectionMode,
} from './types.ts';
import { readServerEnv } from './providers/base.ts';
import { ProviderRegistry } from './providers/registry.ts';
import { AllProvidersFailedError, buildCandidateChain, orchestrateAI } from './router.ts';
import {
  BUSINESS_GROW_TOOLS,
  buildBusinessGrowSystemPrompt,
  classifyToolProposals,
  type BusinessMemoryRecord,
  type BusinessProfileRecord,
  type ExternalConnectorRecord,
} from './businessGrow.ts';

type Json = Record<string, unknown>;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name, x-retry-count',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function fail(code: string, message: string, status = 400, extra: Json = {}): Response {
  return json({ error: { code, message, ...extra } }, status);
}

function str(v: unknown, max = 4000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

const SUPABASE_URL = () => readServerEnv('SUPABASE_URL');
const ANON_KEY = () => readServerEnv('SUPABASE_ANON_KEY') || readServerEnv('SUPABASE_PUBLISHABLE_KEY');
const SERVICE_KEY = () => readServerEnv('SUPABASE_SERVICE_ROLE_KEY');

async function authUserId(userJwt: string): Promise<string | null> {
  if (!SUPABASE_URL() || !ANON_KEY()) return null;
  try {
    const res = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
      headers: { apikey: ANON_KEY(), Authorization: userJwt },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const u = await res.json() as Json;
    return typeof u.id === 'string' ? u.id : null;
  } catch {
    return null;
  }
}

async function rpcUser(name: string, args: Json, userJwt: string): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY(), Authorization: userJwt, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data !== null && 'message' in data
      ? String((data as Json).message) : text || `HTTP ${res.status}`;
    return { ok: false, data: null, error: msg };
  }
  return { ok: true, data };
}

async function rpcService(name: string, args: Json): Promise<{ ok: boolean; data: unknown; error?: string }> {
  if (!SUPABASE_URL() || !SERVICE_KEY()) return { ok: false, data: null, error: 'SERVICE_KEY_MISSING' };
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data !== null && 'message' in data
      ? String((data as Json).message) : text || `HTTP ${res.status}`;
    return { ok: false, data: null, error: msg };
  }
  return { ok: true, data };
}

async function restGetUser<T = Json>(path: string, userJwt: string): Promise<T[]> {
  if (!SUPABASE_URL() || !ANON_KEY()) return [];
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    headers: { apikey: ANON_KEY(), Authorization: userJwt },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? (data as T[]) : [];
}

async function restServicePost<T = Json>(tableView: string, payload: unknown): Promise<T | null> {
  if (!SUPABASE_URL() || !SERVICE_KEY()) return null;
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${tableView}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? ((data[0] as T) ?? null) : (data as T);
}

async function restServicePatch(tableView: string, filter: string, payload: unknown): Promise<void> {
  if (!SUPABASE_URL() || !SERVICE_KEY()) return;
  await fetch(`${SUPABASE_URL()}/rest/v1/${tableView}?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

async function resolveWorkspace(requestedWs: string | null, userJwt: string): Promise<string | null> {
  if (requestedWs) {
    const rows = await restGetUser<{ id: string }>(
      `ugc_workspaces?id=eq.${encodeURIComponent(requestedWs)}&select=id&limit=1`,
      userJwt,
    );
    if (rows.length === 0) return null;
    return rows[0].id;
  }
  const walletRes = await rpcUser('reelora_bg_ensure_wallet', {}, userJwt);
  if (walletRes.ok && typeof walletRes.data === 'object' && walletRes.data !== null) {
    const ws = (walletRes.data as Json).workspace_id;
    if (typeof ws === 'string') return ws;
  }
  const list = await restGetUser<{ id: string }>('ugc_workspaces?select=id&order=created_at.asc&limit=1', userJwt);
  return list[0]?.id ?? null;
}

async function loadRoutingRule(
  workspaceId: string,
  userId: string,
  space: AISpace,
  taskType: AITaskType,
  userJwt: string,
): Promise<RoutingRuleInput | undefined> {
  const rows = await restGetUser<Json>(
    `reelora_ai_routing_rules?active=eq.true&space=in.(${encodeURIComponent(space)},global)&task_type=in.(${encodeURIComponent(taskType)},default)&select=*`,
    userJwt,
  );
  if (rows.length === 0) return undefined;

  // Specificity priority: user+workspace+task > workspace+task > user+workspace+default > workspace+default > system+task > system+default
  const score = (r: Json) => {
    let s = 0;
    if (r.workspace_id === workspaceId) s += 4;
    if (r.user_id === userId) s += 8;
    if (r.task_type === taskType) s += 2;
    if (r.space === space) s += 1;
    return s;
  };
  const best = [...rows].sort((a, b) => score(b) - score(a))[0];
  if (!best) return undefined;

  const chainRaw = Array.isArray(best.fallback_chain) ? best.fallback_chain : [];
  const fallbackChain = chainRaw
    .map((item) => {
      const obj = (item ?? {}) as Json;
      const pk = str(obj.provider_key ?? obj.providerKey, 40) as AIProviderKey;
      const mid = str(obj.model_id ?? obj.modelId, 120);
      return pk && mid ? { providerKey: pk, modelId: mid } : null;
    })
    .filter((v): v is { providerKey: AIProviderKey; modelId: string } => v !== null);

  return {
    selectionMode: (best.selection_mode === 'manual' ? 'manual' : 'auto') as SelectionMode,
    preferredProviderKey: str(best.preferred_provider_key, 40) as AIProviderKey || null,
    preferredModelId: str(best.preferred_model_id, 120) || null,
    fallbackChain,
    maxCostTier: (str(best.max_cost_tier, 20) || 'premium') as CostTier,
    allowFallback: best.allow_fallback !== false,
  };
}

function mergeRouting(base: RoutingRuleInput | undefined, overrideRaw: unknown): RoutingRuleInput {
  const ov = (overrideRaw && typeof overrideRaw === 'object' ? overrideRaw : {}) as Json;
  const selectionMode: SelectionMode = ov.selectionMode === 'manual' || ov.selectionMode === 'auto'
    ? ov.selectionMode
    : base?.selectionMode ?? 'auto';

  const preferredProviderKey = (str(ov.preferredProviderKey, 40) as AIProviderKey) || base?.preferredProviderKey || null;
  const preferredModelId = str(ov.preferredModelId, 120) || base?.preferredModelId || null;

  const rawChain = Array.isArray(ov.fallbackChain) ? ov.fallbackChain : undefined;
  const fallbackChain = rawChain
    ? rawChain
        .map((item) => {
          const obj = (item ?? {}) as Json;
          const pk = str(obj.providerKey ?? obj.provider_key, 40) as AIProviderKey;
          const mid = str(obj.modelId ?? obj.model_id, 120);
          return pk && mid ? { providerKey: pk, modelId: mid } : null;
        })
        .filter((v): v is { providerKey: AIProviderKey; modelId: string } => v !== null)
    : base?.fallbackChain;

  return {
    selectionMode,
    preferredProviderKey,
    preferredModelId,
    fallbackChain,
    maxCostTier: (str(ov.maxCostTier, 20) as CostTier) || base?.maxCostTier || 'premium',
    allowFallback: typeof ov.allowFallback === 'boolean' ? ov.allowFallback : (base?.allowFallback ?? true),
  };
}

export interface EngineHandlerDeps {
  registry?: ProviderRegistry;
}

export function createAiEngineHandler(deps: EngineHandlerDeps = {}) {
  const registry = deps.registry ?? new ProviderRegistry();

  return async function handler(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'Méthode non autorisée.', 405);

    const userJwt = req.headers.get('Authorization') ?? '';
    if (!userJwt.startsWith('Bearer ')) return fail('UNAUTHENTICATED', 'Authentification requise.', 401);
    const userId = await authUserId(userJwt);
    if (!userId) return fail('UNAUTHENTICATED', 'Jeton utilisateur invalide.', 401);

    let body: Json;
    try { body = await req.json() as Json; } catch {
      return fail('INVALID_BODY', 'Corps de requête JSON invalide.', 400);
    }

    const action = str(body.action, 60);

    // ------------------------------------------------------------------------
    // 1. HEALTH & HONEST PROVIDER STATUS (zero secrets, never claims connected without real test)
    // ------------------------------------------------------------------------
    if (action === 'health') {
      const dbProviders = await restGetUser<Json>('reelora_ai_providers?select=provider_key,verification_status,last_verified_at,last_error_code', userJwt);
      const dbMap = new Map(dbProviders.map((p) => [String(p.provider_key), p]));

      const providers = registry.listSummaries().map((s) => {
        const dbRow = dbMap.get(s.providerKey);
        const verifiedInDb = dbRow?.verification_status === 'connected';
        return {
          ...s,
          // Honest status: `configured` = server secret present; `connected` = live test verified.
          connected: s.configured && verifiedInDb,
          verificationStatus: !s.implemented
            ? 'planned'
            : !s.configured
            ? 'unconfigured'
            : (dbRow?.verification_status ?? 'configured_unverified'),
          lastVerifiedAt: dbRow?.last_verified_at ?? null,
          lastErrorCode: dbRow?.last_error_code ?? null,
        };
      });

      return json({
        engine: 'reelora-ai-engine',
        status: 'ok',
        creditDomainIsolation: true,
        providers,
        models: registry.listModels(),
      });
    }

    // ------------------------------------------------------------------------
    // 2. LIST MODELS (catalog + optional live remote listing when configured)
    // ------------------------------------------------------------------------
    if (action === 'list_models') {
      const providerFilter = str(body.providerKey, 40) as AIProviderKey | '';
      const includeRemote = body.includeRemote === true;
      const models = registry.listModels().filter((m) => !providerFilter || m.providerKey === providerFilter);
      const remoteModels: Record<string, string[]> = {};

      if (includeRemote) {
        for (const adapter of registry.listAll()) {
          if (providerFilter && adapter.providerKey !== providerFilter) continue;
          if (adapter.isImplemented && adapter.isConfigured() && adapter.listRemoteModels) {
            try {
              remoteModels[adapter.providerKey] = await adapter.listRemoteModels();
            } catch {
              remoteModels[adapter.providerKey] = [];
            }
          }
        }
      }

      return json({ models, remoteModels });
    }

    // ------------------------------------------------------------------------
    // 3. REAL PROVIDER VERIFICATION (runs genuine API call, never simulated)
    // ------------------------------------------------------------------------
    if (action === 'verify_provider') {
      const providerKey = str(body.providerKey, 40) as AIProviderKey;
      const modelId = str(body.modelId, 120) || undefined;
      const adapter = registry.get(providerKey);
      if (!adapter) {
        return fail('UNKNOWN_PROVIDER', `Fournisseur inconnu : ${providerKey}`, 400);
      }
      const result = await adapter.verify(modelId);
      const dbStatus = !result.configured
        ? 'unconfigured'
        : result.verified
        ? 'connected'
        : 'error';
      await rpcService('reelora_ai_set_provider_verification', {
        p_provider_key: providerKey,
        p_status: dbStatus,
        p_error_code: result.errorCode ?? null,
      });
      return json(result, result.verified ? 200 : result.configured ? 502 : 503);
    }

    // ------------------------------------------------------------------------
    // 4. EXECUTE / BUSINESS_CHAT (Routing + Fallback + Isolated BG Credits + Telemetry)
    // ------------------------------------------------------------------------
    if (action === 'execute' || action === 'business_chat') {
      const space: AISpace = body.space === 'studio_ugc' ? 'studio_ugc' : 'business_grow';
      const taskType = (str(body.taskType, 40) || 'chat') as AITaskType;
      const workspaceId = await resolveWorkspace(str(body.workspaceId, 80) || null, userJwt);
      if (!workspaceId) {
        return fail('FORBIDDEN', 'Espace de travail introuvable ou accès refusé.', 403);
      }

      const storedRule = await loadRoutingRule(workspaceId, userId, space, taskType, userJwt);
      const routing = mergeRouting(storedRule, body.routing);
      const conversationId = str(body.conversationId, 80) || null;
      const businessProfileId = str(body.businessProfileId, 80) || null;

      let systemPrompt = str(body.systemPrompt, 16000);
      let messages: AIChatMessage[] = Array.isArray(body.messages)
        ? (body.messages as Json[])
            .map((m) => ({
              role: (['system', 'user', 'assistant', 'tool'].includes(str(m.role, 20)) ? str(m.role, 20) : 'user') as AIChatMessage['role'],
              content: str(m.content, 16000),
            }))
            .filter((m) => m.content.length > 0)
        : [];
      const userPrompt = str(body.prompt, 16000);
      if (userPrompt) messages.push({ role: 'user', content: userPrompt });

      // Hydrate structured Business Grow context & isolated memory when business_chat
      let activeProfile: BusinessProfileRecord | null = null;
      let activeMemories: BusinessMemoryRecord[] = [];
      let connectors: ExternalConnectorRecord[] = [];

      if (action === 'business_chat') {
        if (businessProfileId) {
          const rows = await restGetUser<BusinessProfileRecord>(
            `reelora_bg_business_profiles?id=eq.${encodeURIComponent(businessProfileId)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
            userJwt,
          );
          activeProfile = rows[0] ?? null;
        } else {
          const rows = await restGetUser<BusinessProfileRecord>(
            `reelora_bg_business_profiles?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&order=is_default.desc,updated_at.desc&limit=1`,
            userJwt,
          );
          activeProfile = rows[0] ?? null;
        }

        if (activeProfile && activeProfile.ai_memory_consent !== false) {
          activeMemories = await restGetUser<BusinessMemoryRecord>(
            `reelora_bg_business_memories?business_profile_id=eq.${encodeURIComponent(activeProfile.id)}&user_id=eq.${encodeURIComponent(userId)}&active=eq.true&order=pinned.desc,updated_at.desc&limit=30`,
            userJwt,
          );
        }

        if (activeProfile) {
          const rawConns = await restGetUser<ExternalConnectorRecord>(
            `reelora_bg_external_connectors?business_profile_id=eq.${encodeURIComponent(activeProfile.id)}&user_id=eq.${encodeURIComponent(userId)}`,
            userJwt,
          );
          connectors = rawConns;
        }

        if (conversationId && messages.length <= 1) {
          const history = await restGetUser<{ role: string; content: string }>(
            `reelora_bg_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc&limit=16`,
            userJwt,
          );
          if (history.length > 0) {
            const histMsgs: AIChatMessage[] = history.map((h) => ({
              role: (h.role === 'assistant' ? 'assistant' : 'user') as AIChatMessage['role'],
              content: h.content,
            }));
            messages = [...histMsgs, ...messages];
          }
        }

        const bgSystem = buildBusinessGrowSystemPrompt({
          taskType,
          profile: activeProfile,
          memories: activeMemories,
          connectors,
        });
        systemPrompt = systemPrompt ? `${bgSystem}\n\n${systemPrompt}` : bgSystem;
      }

      if (messages.length === 0) {
        return fail('INVALID_INPUT', 'Aucun message ou prompt fourni pour le moteur IA.', 400);
      }

      // Check candidate chain before reserving Business Grow credits so unconfigured envs don't touch credits
      const chain = buildCandidateChain(
        {
          space,
          taskType,
          systemPrompt,
          messages,
          routing,
        },
        registry,
      );
      const anyConfigured = chain.some((c) => {
        const a = registry.get(c.providerKey);
        return Boolean(a && a.isImplemented && a.isConfigured());
      });
      if (!anyConfigured) {
        return fail(
          'AI_PROVIDERS_NOT_CONFIGURED',
          'Aucun fournisseur IA actif n’est configuré côté serveur (GROQ_API_KEY ou GEMINI_API_KEY). Ajoutez au moins une clé API dans Supabase Secrets. Aucune réponse n’est simulée et aucun crédit n’a été débité.',
          503,
          { providers: registry.listSummaries(), creditsDebited: 0 },
        );
      }

      const requestId = crypto.randomUUID();
      const maxReserve = space === 'business_grow'
        ? Math.max(1, ...chain.map((c) => c.creditsCost))
        : 0;

      // Strictly isolated Business Grow credit reservation — NEVER touches Studio UGC credits!
      let creditsReserved = 0;
      if (space === 'business_grow' && maxReserve > 0) {
        const reserveRes = await rpcService('reelora_bg_reserve_credits', {
          p_user_id: userId,
          p_workspace_id: workspaceId,
          p_request_id: requestId,
          p_credits: maxReserve,
          p_idempotency_key: `bg-reserve:${requestId}`,
        });
        if (!reserveRes.ok) {
          if (reserveRes.error?.includes('bg_insufficient_credits')) {
            return fail(
              'BG_INSUFFICIENT_CREDITS',
              'Solde de crédits Business Grow insuffisant. Les crédits Studio UGC ne sont jamais utilisés pour Business Grow.',
              402,
            );
          }
          // If DB migration isn't deployed yet in local/unit environments, only fail if strict DB configured
          if (reserveRes.error !== 'SERVICE_KEY_MISSING') {
            return fail('BG_QUOTA_ERROR', `Impossible de réserver vos crédits Business Grow : ${reserveRes.error}`, 400);
          }
        } else {
          creditsReserved = maxReserve;
        }
      }

      const primaryCandidate = chain[0];
      await restServicePost('reelora_ai_requests', {
        id: requestId,
        user_id: userId,
        workspace_id: workspaceId,
        space,
        task_type: taskType,
        conversation_id: conversationId,
        business_profile_id: activeProfile?.id ?? businessProfileId,
        selection_mode: routing.selectionMode,
        requested_provider_key: primaryCandidate?.providerKey ?? null,
        requested_model_id: primaryCandidate?.modelId ?? null,
        status: 'running',
      });

      const tools = body.enableTools === false
        ? undefined
        : action === 'business_chat'
        ? BUSINESS_GROW_TOOLS
        : undefined;

      try {
        const result = await orchestrateAI(
          {
            space,
            taskType,
            systemPrompt,
            messages,
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.45,
            maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : 2400,
            jsonMode: body.jsonMode === true,
            tools,
            routing,
          },
          registry,
        );

        let chargedCredits = result.creditsCost;
        if (space === 'business_grow' && creditsReserved > 0) {
          const cap = await rpcService('reelora_bg_capture_credits', {
            p_user_id: userId,
            p_workspace_id: workspaceId,
            p_request_id: requestId,
            p_reserved: creditsReserved,
            p_charged: result.creditsCost,
            p_idempotency_key: `bg-capture:${requestId}`,
          });
          if (cap.ok && typeof cap.data === 'object' && cap.data !== null && 'charged' in cap.data) {
            chargedCredits = Number((cap.data as Json).charged ?? result.creditsCost);
          }
        }

        // Persist attempt traces & finalize request telemetry
        for (const attempt of result.attempts) {
          await restServicePost('reelora_ai_request_attempts', {
            request_id: requestId,
            attempt_number: attempt.attemptNumber,
            provider_key: attempt.providerKey,
            model_id: attempt.modelId,
            status: attempt.status,
            http_status: attempt.httpStatus ?? null,
            error_code: attempt.errorCode ?? null,
            error_message: attempt.errorMessage ?? null,
            latency_ms: attempt.latencyMs,
            input_tokens: attempt.inputTokens,
            output_tokens: attempt.outputTokens,
            estimated_cost_usd: attempt.estimatedCostUsd,
          });
        }

        await restServicePatch('reelora_ai_requests', `id=eq.${requestId}`, {
          actual_provider_key: result.response.providerKey,
          actual_model_id: result.response.modelId,
          status: 'succeeded',
          fallback_used: result.fallbackUsed,
          attempts_count: result.attempts.length,
          latency_ms: result.response.latencyMs,
          input_tokens: result.response.inputTokens,
          output_tokens: result.response.outputTokens,
          estimated_cost_usd: result.response.estimatedCostUsd,
          bg_credits_charged: space === 'business_grow' ? chargedCredits : 0,
          completed_at: new Date().toISOString(),
        });

        const toolProposals = classifyToolProposals(result.response.toolCalls);

        // Persist assistant response + pending tool approvals for Business Grow chat
        let savedAssistantMessageId: string | null = null;
        if (action === 'business_chat' && conversationId) {
          const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
          if (lastUserMsg && body.persistUserMessage !== false) {
            await restServicePost('reelora_bg_messages', {
              conversation_id: conversationId,
              workspace_id: workspaceId,
              user_id: userId,
              role: 'user',
              content: lastUserMsg.content,
              task_type: taskType,
            });
          }

          const inserted = await restServicePost<{ id: string }>('reelora_bg_messages', {
            conversation_id: conversationId,
            workspace_id: workspaceId,
            user_id: userId,
            role: 'assistant',
            content: result.response.text || 'Proposition d’action structurée prête pour votre validation.',
            task_type: taskType,
            provider_key: result.response.providerKey,
            model_id: result.response.modelId,
            request_id: requestId,
            tool_proposals: toolProposals,
            token_count: result.response.outputTokens,
          });
          savedAssistantMessageId = inserted?.id ?? null;

          for (const proposal of toolProposals) {
            await restServicePost('reelora_bg_tool_executions', {
              workspace_id: workspaceId,
              user_id: userId,
              business_profile_id: activeProfile?.id ?? businessProfileId,
              conversation_id: conversationId,
              message_id: savedAssistantMessageId,
              request_id: requestId,
              tool_name: proposal.toolName,
              risk_level: proposal.riskLevel,
              status: proposal.riskLevel === 'read' ? 'approved' : 'pending_approval',
              input_args: proposal.arguments,
            });
          }
        }

        return json({
          requestId,
          space,
          taskType,
          provider: result.response.providerKey,
          model: result.response.modelId,
          fallbackUsed: result.fallbackUsed,
          attempts: result.attempts,
          text: result.response.text,
          toolProposals,
          usage: {
            inputTokens: result.response.inputTokens,
            outputTokens: result.response.outputTokens,
            estimatedCostUsd: result.response.estimatedCostUsd,
            bgCreditsCharged: space === 'business_grow' ? chargedCredits : 0,
            studioUgcCreditsCharged: 0,
          },
          latencyMs: result.response.latencyMs,
          messageId: savedAssistantMessageId,
          businessProfileId: activeProfile?.id ?? null,
        });
      } catch (err) {
        if (space === 'business_grow' && creditsReserved > 0) {
          await rpcService('reelora_bg_release_credits', {
            p_user_id: userId,
            p_workspace_id: workspaceId,
            p_request_id: requestId,
            p_reserved: creditsReserved,
            p_idempotency_key: `bg-release:${requestId}`,
            p_reason: err instanceof AllProvidersFailedError ? err.code : 'engine_error',
          });
        }

        if (err instanceof AllProvidersFailedError) {
          for (const attempt of err.attempts) {
            await restServicePost('reelora_ai_request_attempts', {
              request_id: requestId,
              attempt_number: attempt.attemptNumber,
              provider_key: attempt.providerKey,
              model_id: attempt.modelId,
              status: attempt.status,
              http_status: attempt.httpStatus ?? null,
              error_code: attempt.errorCode ?? null,
              error_message: attempt.errorMessage ?? null,
              latency_ms: attempt.latencyMs,
              input_tokens: attempt.inputTokens,
              output_tokens: attempt.outputTokens,
              estimated_cost_usd: attempt.estimatedCostUsd,
            });
          }

          await restServicePatch('reelora_ai_requests', `id=eq.${requestId}`, {
            status: 'failed',
            fallback_used: err.attempts.length > 1,
            attempts_count: err.attempts.length,
            error_code: err.code,
            error_message: err.message,
            bg_credits_charged: 0,
            completed_at: new Date().toISOString(),
          });

          const status = err.code === 'NOT_CONFIGURED'
            ? 503
            : err.code === 'RATE_LIMITED'
            ? 429
            : 502;
          return fail(err.code, err.message, status, {
            requestId,
            attempts: err.attempts,
            creditsRefunded: creditsReserved,
          });
        }

        const msg = err instanceof Error ? err.message : String(err);
        await restServicePatch('reelora_ai_requests', `id=eq.${requestId}`, {
          status: 'failed',
          error_code: 'AI_ENGINE_INTERNAL',
          error_message: msg.slice(0, 400),
          bg_credits_charged: 0,
          completed_at: new Date().toISOString(),
        });
        return fail('AI_ENGINE_INTERNAL', 'Erreur interne du moteur IA. Vos crédits ont été restitués.', 500, {
          requestId,
          creditsRefunded: creditsReserved,
        });
      }
    }

    return fail('UNKNOWN_ACTION', `Action moteur IA inconnue : ${action}`, 400);
  };
}

export const handler = createAiEngineHandler();

// Deno-only bootstrap so Vitest can import `handler` / `createAiEngineHandler` cleanly in Node.
const runtime = globalThis as unknown as { Deno?: { serve?: (fn: (r: Request) => Promise<Response>) => void } };
if (runtime.Deno?.serve) runtime.Deno.serve(handler);
