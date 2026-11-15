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
  /**
   * Message d'erreur RENVOYÉ PAR LE FOURNISSEUR (tronqué, assaini).
   *
   * Pourquoi : un `400` sans corps ne permet aucun diagnostic — c'est
   * exactement ce qui a rendu `PROVIDER_REQUEST_REJECTED` indéchiffrable sur
   * LLM7 et Ollama. Le corps est lu, tronqué et purgé de tout secret avant
   * d'être persisté ; il ne contient jamais la clé (les fournisseurs ne la
   * renvoient pas et `redactSecrets` la retire par précaution).
   */
  completionDetail: string | null;
  /** Statut HTTP de la complétion (null si jamais tentée). */
  completionHttpStatus: number | null;
  latencyMs: number;
}

/** Tronque un texte pour la persistance (jamais de charge illimitée). */
const DETAIL_MAX = 400;

/**
 * Assainit un corps d'erreur avant persistance.
 *
 * Trois protections : longueur bornée, retours à la ligne aplatis, et retrait
 * de toute valeur ressemblant à un jeton (au cas où le fournisseur recopierait
 * l'en-tête `Authorization` dans son message d'erreur — cela arrive).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]')
    .replace(/(sk-|gnk-|cfut_|key-)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_MAX);
}

/** Extrait le message d'erreur le plus parlant d'une charge JSON inconnue. */
export function errorDetailOf(payload: unknown, raw: string | null): string | null {
  const text = (() => {
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const err = record.error;
      const candidates = [
        typeof record.message === 'string' ? record.message : null,
        typeof record.detail === 'string' ? record.detail : null,
        err && typeof err === 'object'
          ? (err as Record<string, unknown>).message
          : typeof err === 'string' ? err : null,
        typeof record.code === 'string' ? record.code : null,
      ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      if (candidates.length) return candidates[0];
    }
    return raw;
  })();
  if (!text) return null;
  const clean = redactSecrets(text);
  return clean.length ? clean : null;
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_FAILED';
  // 402 = la clé est valide, c'est le SOLDE qui est vide. Cas réel du
  // 2026-11-15 : LLM7 (« Insufficient balance ») et Ollama (« Add usage
  // credits ») renvoyaient tous deux 402, classé « requête rejetée » — ce qui
  // laissait croire à un défaut de configuration. Le distinguer oriente
  // l'opérateur vers la facturation, seul endroit où agir.
  if (status === 402) return 'PROVIDER_PAYMENT_REQUIRED';
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
    completionDetail: null,
    completionHttpStatus: null,
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

  // — Complétion réelle, plafonnée : sortie minime, nombre d'essais borné —
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

  /**
   * Modèles à essayer, dans l'ordre.
   *
   * Pourquoi plusieurs : un catalogue contient des familles que la sonde ne
   * sait pas distinguer (LLM7 publie `jev-latest` à côté de modèles de chat).
   * S'arrêter au premier refus faisait déclarer « fournisseur défaillant » alors
   * que la bonne conclusion était « ce modèle-là n'accepte pas le chat ».
   *
   * Bornes strictes, pour ne jamais transformer une sonde en dépense :
   *   * au plus `PROBE_ATTEMPTS` complétions (3) ;
   *   * un nouvel essai UNIQUEMENT sur un refus qui met en cause le MODÈLE
   *     (400/404/422). Un 401/402/403/429 concerne le compte entier : réessayer
   *     un autre modèle ne changerait rien et multiplierait les appels.
   */
  const candidates = probeModel === 'auto'
    ? probeModelCandidates(result.models, null, PROBE_ATTEMPTS)
    : [testedModel];

  let last: AiProbeResult | null = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const model = candidates[index];
    const attempt = await attemptCompletion(adapter, credentials, model, options, result, startedAt);
    if (attempt.completionOk === true) return attempt;
    last = attempt;
    const retryable = attempt.completionHttpStatus !== null
      && MODEL_LEVEL_REJECTION.has(attempt.completionHttpStatus)
      && index < candidates.length - 1;
    if (!retryable) return attempt;
  }

  return last ?? result;
}

/**
 * Statuts qui mettent en cause le MODÈLE et non le compte.
 *
 * 401/403 (clé), 402 (crédits), 429 (quota) sont des verdicts sur le compte :
 * changer de modèle ne les corrigerait pas. 400/404/422 disent « cette requête,
 * pour ce modèle, est invalide » : un autre modèle peut répondre.
 */
const MODEL_LEVEL_REJECTION = new Set([400, 404, 422]);

/** Nombre maximal de complétions de contrôle par sonde. */
const PROBE_ATTEMPTS = 3;

async function attemptCompletion(
  adapter: NonNullable<ReturnType<typeof resolveAiAdapter>>,
  credentials: AiCredentials,
  testedModel: string,
  options: AiProbeOptions,
  result: AiProbeResult,
  startedAt: number,
): Promise<AiProbeResult> {
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
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!res.ok) {
      // Le corps est lu SANS échouer la sonde : c'est la seule information qui
      // distingue un modèle inexistant d'un paramètre refusé.
      const rawBody = await res.text().catch(() => null);
      let parsedBody: unknown = null;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsedBody = null;
      }
      return {
        ...result,
        reached: 'completion',
        probeModel: testedModel,
        completionOk: false,
        completionErrorCode: statusCode(res.status),
        completionHttpStatus: res.status,
        completionDetail: errorDetailOf(parsedBody, rawBody),
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

// ---------------------------------------------------------------------------
// Choix du modèle de sonde
// ---------------------------------------------------------------------------

/** Plafond au-delà duquel un prix publié n'est plus une information de tri. */
const MAX_PLAUSIBLE_COST_PER_MTOK = 1000;

export function conversationalModels(models: AiCatalogModel[]): AiCatalogModel[] {
  return models.filter(isChatCapable);
}

/**
 * Ce modèle accepte-t-il vraiment `/v1/chat/completions` ?
 *
 * Les catalogues mélangent les familles : LLM7 publie pêle-mêle des modèles de
 * chat, d'image (`gpt-image-*`, `seedance-*`, `kling-*`) et de transcription
 * (`whisper-*`). Sonder un modèle d'image sur l'endpoint de chat renvoie un 400
 * « does not support chat endpoints » — un faux négatif qui faisait passer un
 * fournisseur sain pour défaillant.
 */
export function isChatCapable(model: AiCatalogModel): boolean {
  const caps = model.capabilities as Record<string, unknown>;
  if (caps.embeddings === true || caps.images === true || caps.video === true || caps.audio === true) {
    return false;
  }
  return !NON_CHAT_FAMILY.test(model.providerModel);
}

/**
 * Familles qui ne répondent pas sur `/chat/completions`.
 *
 * Nécessaire PARCE QUE les catalogues ne déclarent pas toujours leur
 * architecture : LLM7 renvoie tous ses modèles avec la seule capacité
 * `writing`, y compris `gpt-image-2`, `seedance-2.0` et `whisper-large-v3`. Le
 * filtre par capacités déclarées ne peut donc rien y voir.
 *
 * C'est un filtre de NOM, assumé comme tel : il ne prétend pas déduire une
 * capacité, il reconnaît des familles génératives connues (image, vidéo,
 * synthèse et reconnaissance vocales, embeddings) pour ne pas envoyer une
 * requête de chat à un modèle qui la refusera.
 */
const NON_CHAT_FAMILY = new RegExp(
  [
    'gpt-image', 'dall-e', 'stable-diffusion', 'sdxl', 'flux-', '-flux', 'midjourney',
    'seedance', 'kling', 'sora', 'veo-', 'runway', 'pika',
    'whisper', 'tts', '-tts', 'voxtral', 'elevenlabs',
    'embed', 'bge-', 'gte-', 'e5-', 'voyage', 'rerank',
  ].join('|'),
  'i',
);

/** Modèles triés par préférence : préférence explicite, puis prix plausible. */
function rankedProbeModels(models: AiCatalogModel[], preferred: string | null): AiCatalogModel[] {
  const conversational = conversationalModels(models);
  const ranked: AiCatalogModel[] = [];
  if (preferred) {
    const exact = conversational.find((m) => m.providerModel === preferred);
    if (exact) ranked.push(exact);
  }
  const priced = conversational
    .filter((m) => {
      // Les DEUX prix doivent être plausibles : chez LLM7 l'anomalie porte sur
      // l'entrée (`claude-sonnet-5` : 450 000 $/Mtok en entrée, 2,25 en sortie).
      // Ne regarder que la sortie laisserait passer ce modèle.
      const costs = [m.costIn, m.costOut].filter((v): v is number => v !== null);
      return costs.length > 0 && costs.every((c) => c >= 0 && c <= MAX_PLAUSIBLE_COST_PER_MTOK);
    })
    .sort((a, b) => (a.costOut ?? a.costIn ?? 0) - (b.costOut ?? b.costIn ?? 0));
  for (const model of [...priced, ...conversational]) {
    if (!ranked.some((m) => m.providerModel === model.providerModel)) ranked.push(model);
  }
  return ranked;
}

/**
 * Choix du modèle de sonde, par préférence explicite puis par prix publié.
 * Aucun identifiant n'est écrit en dur : le modèle vient du catalogue réel.
 */
export function pickProbeModel(models: AiCatalogModel[], preferred: string | null): string | null {
  return rankedProbeModels(models, preferred)[0]?.providerModel ?? null;
}

/**
 * Modèles de repli, dans l'ordre, pour une sonde qui doit insister.
 *
 * Sert uniquement à la sonde : jamais au routage produit (voir `router.ts`).
 * Le plafond est appliqué ici, pas chez l'appelant.
 */
export function probeModelCandidates(
  models: AiCatalogModel[],
  preferred: string | null,
  limit = 3,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const model of rankedProbeModels(models, preferred)) {
    if (out.length >= Math.max(1, limit)) break;
    if (seen.has(model.providerModel)) continue;
    seen.add(model.providerModel);
    out.push(model.providerModel);
  }
  return out;
}
