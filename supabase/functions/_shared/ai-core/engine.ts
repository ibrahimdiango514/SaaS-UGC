// VYORA AI CORE — moteur d'exécution : appels unifiés + secours plafonné.
//
// Le moteur n'invente jamais de réponse : chaque tentative réelle est
// journalisée (fournisseur, modèle, tokens, latence, coût, code d'erreur) et
// un échec final renvoie le code explicite. Fallback plafonné :
//   - longueur de chaîne max (routage) et tentatives max (défaut 3) ;
//   - un même fournisseur+modèle n'est tenté qu'une seule fois (anti-boucle) ;
//   - délai par appel (défaut 25 s) ;
//   - l'agrégateur n'est un recours que s'il reste dans la chaîne.

import { resolveAiAdapter } from './adapters.ts';
import { AiRegistrySnapshot } from './registry.ts';
import { buildAiChain, estimateCostUsd, estimatePromptTokens, AiChainStep } from './router.ts';
import { AiCallOptions, AiChatMessage, AiCredentials, AiProviderError } from './types.ts';

export interface AiAttemptRecord {
  attempt: number;
  providerKey: string;
  modelKey: string;
  providerModelKey: string;
  status: 'success' | 'error' | 'timeout';
  errorCode: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Score de routage de cette étape (pourquoi elle a été essayée). */
  score?: number;
  /** Origine de l'étape : règle du rôle ou catalogue. */
  routedBy?: 'role_rule' | 'catalog';
}

export interface AiCallRequest {
  messages: AiChatMessage[];
  options?: AiCallOptions;
  role?: string | null;
  level?: 'fast' | 'economy' | 'advanced' | 'specialized' | 'fallback' | 'auto' | null;
  requireCapabilities?: string[];
  preferProvider?: string | null;
  /** Fournisseurs à écarter pour cet appel (ex. dernier échec connu). */
  avoidProviders?: string[];
  /**
   * Contexte minimal exigible (jetons d'entrée). Par défaut : taille estimée
   * du prompt, pour ne jamais router vers un modèle trop court.
   */
  minContextTokens?: number | null;
  /** Plafond de coût d'entrée publié (USD / million de jetons). */
  maxCostInPerMtok?: number | null;
  /**
   * Clé d'idempotence : un même appel rejoué (timeout réseau, retry client) ne
   * rappelle JAMAIS le fournisseur — le moteur rend le résultat déjà obtenu.
   */
  requestKey?: string | null;
  /** Provenance de l'appel (Business Grow, Studio UGC, système). */
  space?: 'business' | 'studio' | 'system';
  userId?: string | null;
  workspaceId?: string | null;
  taskKey?: string | null;
}

export interface AiCallOutcome {
  ok: boolean;
  /** Code explicite quand ok=false : REGISTRY_UNAVAILABLE, BUDGET_EXHAUSTED,
   *  NO_CONFIGURED_PROVIDER, NO_MATCHING_MODEL ou le code du dernier échec. */
  code: string | null;
  content: string | null;
  providerKey: string | null;
  modelKey: string | null;
  providerModelKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  latencyMs: number;
  attempts: AiAttemptRecord[];
  /** Vrai si l'appel a été refusé par le verrou d'idempotence (aucune dépense). */
  duplicate?: boolean;
}

export interface AiCallLogEntry {
  space: 'business' | 'studio' | 'system';
  userId: string | null;
  workspaceId: string | null;
  taskKey: string | null;
  attempts: AiAttemptRecord[];
  costInputUsd: number | null;
  costOutputUsd: number | null;
}

export interface AiEngineDeps {
  /** Charge le registre (snapshot). null = indisponible → chemin de secours. */
  loadRegistry(): Promise<AiRegistrySnapshot | null>;
  /**
   * Fournisseurs configurés hors registre (compatibilité des intégrations
   * historiques). Le moteur y AJOUTE tout fournisseur du registre dont la clé
   * se résout : la liste des fournisseurs servis n'est donc jamais figée ici.
   */
  configuredProviders(): ReadonlySet<string>;
  /** Clés par fournisseur — jamais sérialisées, jamais renvoyées au client. */
  credentials(providerKey: string): AiCredentials;
  /**
   * Optionnel : variables d'environnement réellement présentes côté Edge
   * (noms seulement). Sert aux fournisseurs dont le nom de variable est fourni
   * par le registre : le moteur peut ainsi résoudre une clé sans qu'aucun nom
   * de fournisseur ne soit écrit dans le code.
   */
  env?(name: string): string | null;
  fetcher: typeof fetch;
  /** Journalisation (une entrée par exécution, avec TOUTES les tentatives).
   *  Doit être non bloquante : un échec de journalisation ne doit jamais
   *  faire échouer l'appel IA. */
  logCall(entry: AiCallLogEntry): Promise<void> | void;
  /**
   * Optionnel : journal de la DÉCISION de routage (chaîne ordonnée, score,
   * raison). Non bloquant, jamais de secret.
   */
  logRouting?(entry: AiRoutingLogEntry): Promise<void> | void;
  /**
   * Optionnel : idempotence. `claim` réserve la clé (false = déjà en cours ou
   * déjà terminée) ; `release` enregistre l'issue. Sans ces fonctions, le
   * moteur fonctionne normalement mais sans protection anti-rejeu.
   */
  claimCall?(
    requestKey: string,
    meta: { space: 'business' | 'studio' | 'system'; userId: string | null; workspaceId: string | null },
  ): Promise<{ claimed: boolean; status: string; providerKey: string | null; modelKey: string | null; outcomeCode: string | null }>;
  releaseCall?(params: {
    requestKey: string;
    status: 'succeeded' | 'failed';
    providerKey: string | null;
    modelKey: string | null;
    outcomeCode: string | null;
    contentChars: number | null;
  }): Promise<void> | void;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}

export interface AiRoutingLogEntry {
  space: 'business' | 'studio' | 'system';
  taskKey: string | null;
  roleKey: string | null;
  level: string | null;
  requestKey: string | null;
  chain: Array<{
    provider: string;
    model: string;
    score: number;
    reason: 'role_rule' | 'catalog';
    costIn: number | null;
    costOut: number | null;
  }>;
  chosenProvider: string | null;
  chosenModel: string | null;
  attempts: number;
  skipReason: string | null;
}

async function fetchJsonWithTimeout(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new AiProviderError('AI_TIMEOUT', true);
    throw new AiProviderError('AI_UNAVAILABLE', true);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    if (!res.ok) throw statusError(res.status);
    throw new AiProviderError('AI_INVALID_RESPONSE', true);
  }
  if (!res.ok) throw statusError(res.status);
  return { status: res.status, json };
}

function statusError(status: number): AiProviderError {
  if (status === 401 || status === 403) return new AiProviderError('AI_AUTH_FAILED', false);
  if (status === 429) return new AiProviderError('AI_RATE_LIMITED', true);
  if (status >= 500) return new AiProviderError('AI_UNAVAILABLE', true);
  return new AiProviderError('AI_INVALID_RESPONSE', true);
}

/**
 * Fournisseurs réellement configurables pour CE snapshot.
 *
 * Un fournisseur est retenu dès que sa clé se résout — par le nom de variable
 * déclaré au registre (`api_key_env`) ou par le fournisseur de credentials des
 * intégrations historiques. Aucune clé en dur, aucune liste en dur : ajouter
 * une ligne de registre + un secret suffit à rendre un fournisseur disponible.
 * Un fournisseur exigeant un identifiant de compte (`account_id_env`) n'est
 * retenu que si cet identifiant est lui aussi présent.
 */
export function resolveConfiguredProvidersFromSnapshot(
  snapshot: AiRegistrySnapshot,
  deps: AiEngineDeps,
): Set<string> {
  return resolveConfiguredProviders(snapshot, deps, credentialsResolver(snapshot, deps));
}

function resolveConfiguredProviders(
  snapshot: AiRegistrySnapshot,
  deps: AiEngineDeps,
  credentialsFor: (providerKey: string) => AiCredentials,
): Set<string> {
  const configured = new Set<string>(deps.configuredProviders());
  for (const provider of snapshot.providers) {
    if (provider.status === 'disabled') continue;
    const credentials = credentialsFor(provider.key);
    if (!credentials.apiKey) continue;
    // Un identifiant de compte/passerelle requis mais absent laisse le
    // fournisseur hors jeu : il n'est pas tenté avec une requête incomplète.
    if (provider.accountIdEnv && !credentials.accountId) continue;
    if (provider.transport === 'gateway' && provider.gatewayIdEnv && !credentials.gatewayId) continue;
    configured.add(provider.key);
  }
  return configured;
}

/**
 * Résolution des identifiants d'un fournisseur — LOGIQUE UNIQUE du moteur.
 *
 * Ordre : descripteur du registre (`api_key_env` / `account_id_env` /
 * `gateway_id_env`) lu dans les secrets Edge, puis repli sur les conventions
 * historiques fournies par l'hôte. Exportée pour que les diagnostics de routage
 * utilisent EXACTEMENT cette logique : une copie divergerait silencieusement.
 */
export function credentialsResolver(
  snapshot: AiRegistrySnapshot,
  deps: AiEngineDeps,
): (providerKey: string) => AiCredentials {
  const providerIndex = new Map(snapshot.providers.map((p) => [p.key, p]));
  return (providerKey: string): AiCredentials => {
    const descriptor = providerIndex.get(providerKey);
    const envName = descriptor?.apiKeyEnv;
    if (envName && deps.env) {
      const apiKey = deps.env(envName);
      const accountId = descriptor?.accountIdEnv ? deps.env(descriptor.accountIdEnv) : null;
      const gatewayId = descriptor?.gatewayIdEnv ? deps.env(descriptor.gatewayIdEnv) : null;
      if (apiKey) {
        const base = deps.credentials(providerKey);
        return {
          apiKey,
          accountId: accountId ?? base.accountId ?? null,
          gatewayId: gatewayId ?? base.gatewayId ?? null,
        };
      }
    }
    return deps.credentials(providerKey);
  };
}

export async function runAiCall(deps: AiEngineDeps, request: AiCallRequest): Promise<AiCallOutcome> {
  const startedAt = Date.now();
  const maxAttempts = Math.max(1, Math.min(5, deps.maxAttempts ?? 3));
  const timeoutMs = Math.max(5_000, deps.requestTimeoutMs ?? 25_000);

  const snapshot = await deps.loadRegistry();
  if (!snapshot) {
    return {
      ok: false, code: 'REGISTRY_UNAVAILABLE', content: null,
      providerKey: null, modelKey: null, providerModelKey: null,
      inputTokens: null, outputTokens: null, estimatedCostUsd: null,
      latencyMs: Date.now() - startedAt, attempts: [],
    };
  }

  // Modèle de référence pour le coût estimé : le modèle réellement servi.
  const modelIndex = new Map(snapshot.models.map((m) => [`${m.provider}|${m.key}`, m]));
  const providerIndex = new Map(snapshot.providers.map((p) => [p.key, p]));

  const credentialsFor = credentialsResolver(snapshot, deps);

  /** Journalise la DÉCISION (jamais bloquant, jamais de secret). */
  const logDecision = (params: {
    steps: AiChainStep[];
    chosenProvider: string | null;
    chosenModel: string | null;
    attempts: number;
    skipReason: string | null;
  }): void => {
    if (!deps.logRouting) return;
    void safeLogRouting(deps, {
      space: request.space ?? 'system',
      taskKey: request.taskKey ?? request.role ?? null,
      roleKey: request.role ?? null,
      level: request.level ?? null,
      requestKey: request.requestKey ?? null,
      chain: params.steps.map((step) => ({
        provider: step.providerKey,
        model: step.modelKey,
        score: step.score,
        reason: step.reason,
        costIn: step.costIn,
        costOut: step.costOut,
      })),
      chosenProvider: params.chosenProvider,
      chosenModel: params.chosenModel,
      attempts: params.attempts,
      skipReason: params.skipReason,
    });
  };

  // — Idempotence : un appel déjà en cours ou déjà terminé ne repart PAS chez
  //   le fournisseur. C'est la protection contre la double facturation.
  if (request.requestKey) {
    try {
      if (!deps.claimCall) throw new Error('idempotency unavailable');
      const claim = await deps.claimCall(request.requestKey, {
        space: request.space ?? 'system',
        userId: request.userId ?? null,
        workspaceId: request.workspaceId ?? null,
      });
      if (!claim.claimed) {
        return {
          ok: false, code: 'AI_DUPLICATE_IN_FLIGHT', content: null,
          providerKey: claim.providerKey, modelKey: claim.modelKey, providerModelKey: null,
          inputTokens: null, outputTokens: null, estimatedCostUsd: null,
          latencyMs: Date.now() - startedAt, attempts: [], duplicate: true,
        };
      }
    } catch {
      // No provider request is safe without the requested idempotency lock.
      return {
        ok: false, code: 'AI_IDEMPOTENCY_UNAVAILABLE', content: null,
        providerKey: null, modelKey: null, providerModelKey: null,
        inputTokens: null, outputTokens: null, estimatedCostUsd: null,
        latencyMs: Date.now() - startedAt, attempts: [],
      };
    }
  }

  const contextTokens = estimatePromptTokens(request.messages);
  // Une image exige un modèle vision : sans ce filtre, le routeur pourrait
  // envoyer la demande à un modèle texte qui ne verrait pas l'image.
  const hasImages = request.messages.some((message) => (message.images?.length ?? 0) > 0);
  const requiredCapabilities = [
    ...(request.requireCapabilities ?? []),
    ...(hasImages ? ['vision'] : []),
  ];
  const { steps, skipReason } = buildAiChain(
    snapshot,
    {
      role: request.role ?? null,
      level: request.level ?? null,
      requireCapabilities: requiredCapabilities,
      preferProvider: request.preferProvider ?? null,
      avoidProviders: request.avoidProviders,
      minContextTokens: request.minContextTokens ?? contextTokens,
      maxCostInPerMtok: request.maxCostInPerMtok ?? null,
    },
    resolveConfiguredProviders(snapshot, deps, credentialsFor),
  );
  if (skipReason) {
    logDecision({ steps, chosenProvider: null, chosenModel: null, attempts: 0, skipReason });
    if (request.requestKey && deps.releaseCall) {
      void deps.releaseCall({
        requestKey: request.requestKey, status: 'failed',
        providerKey: null, modelKey: null, outcomeCode: skipReason, contentChars: null,
      });
    }
    return {
      ok: false, code: skipReason, content: null,
      providerKey: null, modelKey: null, providerModelKey: null,
      inputTokens: null, outputTokens: null, estimatedCostUsd: null,
      latencyMs: Date.now() - startedAt, attempts: [],
    };
  }

  const attempts: AiAttemptRecord[] = [];
  let lastError: AiProviderError | null = null;

  for (let i = 0; i < Math.min(steps.length, maxAttempts); i += 1) {
    const step: AiChainStep = steps[i];
    // L'adaptateur est construit À PARTIR DU REGISTRE : aucun fournisseur n'est
    // nommé dans le code, seule la ligne du registre décrit son protocole.
    const provider = providerIndex.get(step.providerKey);
    const adapter = resolveAiAdapter(provider
      ? {
          key: provider.key,
          kind: provider.adapterKind,
          baseUrl: provider.baseUrl ?? '',
          baseUrlEnv: provider.baseUrlEnv,
          apiKeyEnv: provider.apiKeyEnv,
          accountIdEnv: provider.accountIdEnv,
          gatewayIdEnv: provider.gatewayIdEnv,
          transport: provider.transport,
          modelsUrl: provider.modelsUrl,
          headers: provider.headers,
        }
      : null);
    if (!adapter) {
      attempts.push({
        attempt: i + 1, providerKey: step.providerKey, modelKey: step.modelKey,
        providerModelKey: step.providerModelKey, status: 'error',
        errorCode: 'UNSUPPORTED_PROVIDER', latencyMs: 0, inputTokens: null, outputTokens: null,
        score: step.score, routedBy: step.reason,
      });
      lastError = new AiProviderError('AI_UNAVAILABLE', true);
      continue;
    }

    const attemptStart = Date.now();
    try {
      const transport = adapter.buildRequest({
        credentials: credentialsFor(step.providerKey),
        model: step.providerModelKey,
        messages: request.messages,
        options: request.options,
      });
      const { json } = await fetchJsonWithTimeout(deps.fetcher, transport.url, transport.headers, transport.body, timeoutMs);
      const parsed = adapter.parse(json);
      const latencyMs = Date.now() - attemptStart;

      const model = modelIndex.get(`${step.providerKey}|${step.modelKey}`);
      const costIn = model?.costIn ?? step.costIn;
      const costOut = model?.costOut ?? step.costOut;
      const total = estimateCostUsd(costIn, costOut, parsed.inputTokens, parsed.outputTokens);

      attempts.push({
        attempt: i + 1, providerKey: step.providerKey, modelKey: step.modelKey,
        providerModelKey: step.providerModelKey, status: 'success', errorCode: null,
        latencyMs, inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens,
        score: step.score, routedBy: step.reason,
      });

      void safeLog(deps, {
        space: request.space ?? 'system',
        userId: request.userId ?? null,
        workspaceId: request.workspaceId ?? null,
        taskKey: request.taskKey ?? request.role ?? null,
        attempts,
        costInputUsd: parsed.inputTokens !== null && costIn !== null ? Math.round((parsed.inputTokens / 1e6) * costIn * 1e6) / 1e6 : null,
        costOutputUsd: parsed.outputTokens !== null && costOut !== null ? Math.round((parsed.outputTokens / 1e6) * costOut * 1e6) / 1e6 : null,
      });
      logDecision({
        steps,
        chosenProvider: step.providerKey,
        chosenModel: step.modelKey,
        attempts: attempts.length,
        skipReason: null,
      });
      if (request.requestKey && deps.releaseCall) {
        void deps.releaseCall({
          requestKey: request.requestKey,
          status: 'succeeded',
          providerKey: step.providerKey,
          modelKey: step.modelKey,
          outcomeCode: null,
          contentChars: parsed.content.length,
        });
      }

      return {
        ok: true, code: null, content: parsed.content,
        providerKey: step.providerKey, modelKey: step.modelKey, providerModelKey: step.providerModelKey,
        inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens,
        estimatedCostUsd: total, latencyMs: Date.now() - startedAt, attempts,
      };
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : new AiProviderError('AI_UNAVAILABLE', true);
      const latencyMs = Date.now() - attemptStart;
      attempts.push({
        attempt: i + 1, providerKey: step.providerKey, modelKey: step.modelKey,
        providerModelKey: step.providerModelKey,
        status: providerError.code === 'AI_TIMEOUT' ? 'timeout' : 'error',
        errorCode: providerError.code, latencyMs, inputTokens: null, outputTokens: null,
        score: step.score, routedBy: step.reason,
      });
      lastError = providerError;
      // Secours : la chaîne n'est jamais plus longue que le plafond ; chaque
      // étape est unique (anti-boucle).
    }
  }

  void safeLog(deps, {
    space: request.space ?? 'system',
    userId: request.userId ?? null,
    workspaceId: request.workspaceId ?? null,
    taskKey: request.taskKey ?? request.role ?? null,
    attempts,
    costInputUsd: null,
    costOutputUsd: null,
  });
  logDecision({
    steps,
    chosenProvider: null,
    chosenModel: null,
    attempts: attempts.length,
    skipReason: lastError ? lastError.code : 'NO_MATCHING_MODEL',
  });
  if (request.requestKey && deps.releaseCall) {
    void deps.releaseCall({
      requestKey: request.requestKey,
      status: 'failed',
      providerKey: attempts[attempts.length - 1]?.providerKey ?? null,
      modelKey: attempts[attempts.length - 1]?.modelKey ?? null,
      outcomeCode: lastError ? lastError.code : 'NO_MATCHING_MODEL',
      contentChars: null,
    });
  }

  return {
    ok: false,
    code: lastError ? lastError.code : 'NO_MATCHING_MODEL',
    content: null, providerKey: null, modelKey: null, providerModelKey: null,
    inputTokens: null, outputTokens: null, estimatedCostUsd: null,
    latencyMs: Date.now() - startedAt, attempts,
  };
}

/**
 * Payload du journal de routage, au format lu par `public.vyora_ai_log_routing`.
 *
 * Le moteur manipule du camelCase ; la RPC lit `p_payload->>'chosen_provider'`,
 * `->>'role_key'`, `->>'skip_reason'`. Transmettre l'objet tel quel écrivait des
 * colonnes VIDES sans jamais lever d'erreur — la journalisation est « non
 * bloquante » par conception, donc la perte était silencieuse. La conversion
 * vit ici, à un seul endroit, plutôt que chez chaque hôte.
 */
export function routingLogPayload(entry: AiRoutingLogEntry): Record<string, unknown> {
  return {
    space: entry.space,
    task_key: entry.taskKey,
    role_key: entry.roleKey,
    level: entry.level,
    request_key: entry.requestKey,
    chain: entry.chain,
    chosen_provider: entry.chosenProvider,
    chosen_model: entry.chosenModel,
    attempts: entry.attempts,
    skip_reason: entry.skipReason,
  };
}

async function safeLogRouting(deps: AiEngineDeps, entry: AiRoutingLogEntry): Promise<void> {
  try {
    await deps.logRouting?.(entry);
  } catch {
    // La traçabilité ne doit jamais faire échouer l'appel IA.
  }
}

async function safeLog(deps: AiEngineDeps, entry: AiCallLogEntry): Promise<void> {
  try {
    await deps.logCall(entry);
  } catch {
    // La journalisation ne doit jamais faire échouer l'appel IA.
  }
}
