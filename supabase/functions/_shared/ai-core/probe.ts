// VYORA AI CORE — sondes de fournisseurs (catalogue + modèle réel).
//
// Une sonde répond à trois questions, dans cet ordre, et RIEN de plus :
//   1. la clé est-elle acceptée ? (lecture du catalogue — coût nul) ;
//   2. quels modèles le fournisseur publie-t-il réellement ? (catalogue live) ;
//   3. le modèle choisi répond-il vraiment ? (une complétion minimale, bornée).
//
// Le catalogue d'abord : une clé refusée n'entraîne AUCUNE complétion, donc
// aucune facture. La complétion est plafonnée (16 jetons de sortie) et ne part
// jamais si le catalogue a déjà échoué.
//
// Aucun fournisseur n'est nommé ici : le descripteur (URL de base, gabarit,
// noms de variables d'environnement) vient du registre.

import { resolveAiAdapter } from './adapters.ts';
import { normalizeCatalog, AiCatalogModel } from './catalog.ts';
import { AiCredentials, AiProviderDescriptor, AiProviderError } from './types.ts';

export interface AiProbeDescriptor {
  key: string;
  kind: AiProviderDescriptor['kind'];
  baseUrl: string;
  modelsUrl: string | null;
  apiKeyEnv: string | null;
  accountIdEnv: string | null;
  /** Voie d'appel déclarée au registre (Cloudflare : rest | gateway). */
  transport?: 'rest' | 'gateway' | null;
  headers: Record<string, string>;
}

/** Résultat normalisé d'une sonde. Aucun secret n'y figure. */
export interface AiProbeResult {
  providerKey: string;
  /** Clé résolue côté serveur (jamais renvoyée au client). */
  configured: boolean;
  /** Étape réellement atteinte. */
  reached: 'credentials' | 'catalog' | 'completion';
  catalogOk: boolean;
  catalogHttpStatus: number | null;
  catalogErrorCode: string | null;
  /** Catalogue normalisé (plafonné par l'appelant avant écriture). */
  models: AiCatalogModel[];
  /** Modèle testé en complétion (identifiant fournisseur). */
  probeModel: string | null;
  completionOk: boolean | null;
  completionErrorCode: string | null;
  latencyMs: number;
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  if (status === 404) return 'PROVIDER_MODELS_ENDPOINT_MISSING';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_REQUEST_REJECTED';
}

/**
 * En-têtes de lecture du catalogue.
 *
 * Le gabarit `openai` et `gemini` s'authentifient comme la conversation ; le
 * gabarit `cloudflare` accepte le jeton en `Authorization` sur l'API REST.
 * Le registre peut imposer des en-têtes supplémentaires (attribution).
 */
export function catalogHeaders(
  descriptor: AiProbeDescriptor,
  credentials: AiCredentials,
): Record<string, string> {
  const headers: Record<string, string> = { ...descriptor.headers };
  if (!credentials.apiKey) return headers;
  if (descriptor.kind === 'gemini') {
    headers['x-goog-api-key'] = credentials.apiKey;
  } else {
    headers.Authorization = `Bearer ${credentials.apiKey}`;
  }
  return headers;
}

/** URL de catalogue effective, ou null si le registre n'en publie pas. */
export function catalogUrl(descriptor: AiProbeDescriptor, credentials: AiCredentials): string | null {
  if (descriptor.modelsUrl) return descriptor.modelsUrl;
  if (!descriptor.baseUrl) return null;
  const base = descriptor.baseUrl.replace(/\/+$/, '');
  if (descriptor.kind === 'gemini') return `${base}/models`;
  if (descriptor.kind === 'cloudflare') {
    return credentials.accountId
      ? `${base}/accounts/${encodeURIComponent(credentials.accountId)}/ai/models`
      : null;
  }
  return `${base}/models`;
}

export interface AiProbeOptions {
  fetcher: typeof fetch;
  timeoutMs?: number;
  /** Complétion réelle de contrôle (désactivable : catalogue seul). */
  probeCompletion?: boolean;
}

async function readJson(fetcher: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number) {
  const res = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, ok: res.ok, payload };
}

/**
 * Sonde complète d'un fournisseur.
 *
 * Le modèle de complétion est choisi par l'appelant (le registre décide) : la
 * sonde ne devine jamais quel modèle existe. Si `probeModel` est absent, la
 * complétion est sautée et `completionOk` vaut `null` (jamais `true`).
 */
export async function probeProvider(
  descriptor: AiProbeDescriptor,
  credentials: AiCredentials,
  /**
   * Modèle à tester, ou `'auto'` pour choisir dans le catalogue RÉEL du
   * fournisseur (jamais un identifiant écrit en dur). `null` = pas de test.
   */
  probeModel: string | null | 'auto',
  options: AiProbeOptions,
): Promise<AiProbeResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base: AiProbeResult = {
    providerKey: descriptor.key,
    configured: Boolean(credentials.apiKey),
    reached: 'credentials',
    catalogOk: false,
    catalogHttpStatus: null,
    catalogErrorCode: null,
    models: [],
    probeModel: probeModel === 'auto' ? null : (probeModel ?? null),
    completionOk: null,
    completionErrorCode: null,
    latencyMs: 0,
  };

  if (!credentials.apiKey) {
    return { ...base, catalogErrorCode: 'PROVIDER_NOT_CONFIGURED', latencyMs: Date.now() - startedAt };
  }

  const url = catalogUrl(descriptor, credentials);
  if (!url) {
    // Cas réel : gabarit exigeant un identifiant de compte non fourni.
    return { ...base, catalogErrorCode: 'PROVIDER_ACCOUNT_ID_MISSING', latencyMs: Date.now() - startedAt };
  }

  let catalog;
  try {
    catalog = await readJson(options.fetcher, url, catalogHeaders(descriptor, credentials), timeoutMs);
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      ...base,
      catalogErrorCode: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      latencyMs: Date.now() - startedAt,
    };
  }

  if (!catalog.ok) {
    return {
      ...base,
      reached: 'catalog',
      catalogHttpStatus: catalog.status,
      catalogErrorCode: statusCode(catalog.status),
      latencyMs: Date.now() - startedAt,
    };
  }

  const normalized = normalizeCatalog(descriptor.kind, catalog.payload);
  const result: AiProbeResult = {
    ...base,
    reached: 'catalog',
    catalogOk: normalized.models.length > 0,
    catalogHttpStatus: catalog.status,
    catalogErrorCode: normalized.models.length > 0 ? null : `PROVIDER_CATALOG_${normalized.warning ?? 'EMPTY'}`.toUpperCase().replace(/\s+/g, '_'),
    models: normalized.models,
    latencyMs: Date.now() - startedAt,
  };

  if (options.probeCompletion === false) return result;

  // Choix du modèle APRÈS la lecture du catalogue : on ne teste qu'un
  // identifiant que le fournisseur vient de publier.
  const testedModel = probeModel === 'auto' ? pickProbeModel(result.models, null) : probeModel;
  if (!testedModel) return result;

  // — Complétion réelle, plafonnée : une seule requête, sortie minime —
  const adapter = resolveAiAdapter({
    key: descriptor.key,
    kind: descriptor.kind,
    baseUrl: descriptor.baseUrl,
    apiKeyEnv: descriptor.apiKeyEnv,
    accountIdEnv: descriptor.accountIdEnv,
    transport: descriptor.transport ?? 'rest',
    modelsUrl: descriptor.modelsUrl,
    headers: descriptor.headers,
  });
  if (!adapter) {
    return { ...result, reached: 'completion', completionOk: false, completionErrorCode: 'PROVIDER_ADAPTER_UNSUPPORTED' };
  }

  try {
    const transport = adapter.buildRequest({
      credentials,
      model: testedModel,
      messages: [{ role: 'user', content: 'Réponds uniquement: OK' }],
      options: { maxOutputTokens: 16, temperature: 0 },
    });
    const res = await options.fetcher(transport.url, {
      method: 'POST',
      headers: transport.headers,
      body: JSON.stringify(transport.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        ...result,
        reached: 'completion',
        probeModel: testedModel,
        completionOk: false,
        completionErrorCode: statusCode(res.status),
        latencyMs: Date.now() - startedAt,
      };
    }
    const payload = await res.json().catch(() => null);
    const parsed = adapter.parse(payload);
    return {
      ...result,
      reached: 'completion',
      probeModel: testedModel,
      completionOk: parsed.content.trim().length > 0,
      completionErrorCode: parsed.content.trim().length > 0 ? null : 'PROVIDER_EMPTY_RESPONSE',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    const code = error instanceof AiProviderError
      ? error.code
      : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? 'AI_TIMEOUT'
        : 'AI_UNAVAILABLE';
    return { ...result, reached: 'completion', probeModel: testedModel, completionOk: false, completionErrorCode: code, latencyMs: Date.now() - startedAt };
  }
}

/** Modèles conversationnels du catalogue (les embeddings sont écartés du test). */
export function conversationalModels(models: AiCatalogModel[]): AiCatalogModel[] {
  return models.filter((model) => model.capabilities.embeddings !== true);
}

/**
 * Choix du modèle de sonde, par préférence explicite puis par prix publié.
 * Aucun identifiant n'est écrit en dur : le modèle vient du catalogue réel.
 */
export function pickProbeModel(models: AiCatalogModel[], preferred: string | null): string | null {
  const conversational = conversationalModels(models);
  if (preferred && conversational.some((m) => m.providerModel === preferred)) return preferred;
  const priced = [...conversational]
    .filter((m) => m.costIn !== null || m.costOut !== null)
    .sort((a, b) => (a.costOut ?? a.costIn ?? 0) - (b.costOut ?? b.costIn ?? 0));
  return (priced[0] ?? conversational[0])?.providerModel ?? null;
}
