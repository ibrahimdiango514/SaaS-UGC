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
import { buildAiChain, estimateCostUsd, AiChainStep } from './router.ts';
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
}

export interface AiCallRequest {
  messages: AiChatMessage[];
  options?: AiCallOptions;
  role?: string | null;
  level?: 'fast' | 'economy' | 'advanced' | 'specialized' | 'fallback' | 'auto' | null;
  requireCapabilities?: string[];
  preferProvider?: string | null;
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
  maxAttempts?: number;
  requestTimeoutMs?: number;
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
    if (provider.accountIdEnv && !credentials.accountId) continue;
    configured.add(provider.key);
  }
  return configured;
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

  /** Clé du fournisseur : d'abord le descripteur du registre, sinon le deps. */
  const credentialsFor = (providerKey: string): AiCredentials => {
    const descriptor = providerIndex.get(providerKey);
    const envName = descriptor?.apiKeyEnv;
    if (envName && deps.env) {
      const apiKey = deps.env(envName);
      const accountId = descriptor?.accountIdEnv ? deps.env(descriptor.accountIdEnv) : null;
      if (apiKey) return { apiKey, accountId: accountId ?? null };
    }
    return deps.credentials(providerKey);
  };

  const { steps, skipReason } = buildAiChain(
    snapshot,
    request,
    resolveConfiguredProviders(snapshot, deps, credentialsFor),
  );
  if (skipReason) {
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
          apiKeyEnv: provider.apiKeyEnv,
          accountIdEnv: provider.accountIdEnv,
          modelsUrl: provider.modelsUrl,
          headers: provider.headers,
        }
      : null);
    if (!adapter) {
      attempts.push({
        attempt: i + 1, providerKey: step.providerKey, modelKey: step.modelKey,
        providerModelKey: step.providerModelKey, status: 'error',
        errorCode: 'UNSUPPORTED_PROVIDER', latencyMs: 0, inputTokens: null, outputTokens: null,
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

  return {
    ok: false,
    code: lastError ? lastError.code : 'NO_MATCHING_MODEL',
    content: null, providerKey: null, modelKey: null, providerModelKey: null,
    inputTokens: null, outputTokens: null, estimatedCostUsd: null,
    latencyMs: Date.now() - startedAt, attempts,
  };
}

async function safeLog(deps: AiEngineDeps, entry: AiCallLogEntry): Promise<void> {
  try {
    await deps.logCall(entry);
  } catch {
    // La journalisation ne doit jamais faire échouer l'appel IA.
  }
}
