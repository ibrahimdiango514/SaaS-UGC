// VYORA AI CORE — types communs (partagés par tous les espaces).
//
// Aucune dépendance d'environnement : le code fonctionne identiquement sous
// Deno (Edge), Node (tests vitest) et dans le bundle esbuild de Business Grow.
// Les secrets et l'accès réseau sont TOUJOURS injectés par l'hôte.

export type AiChatRole = 'system' | 'user' | 'assistant';

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}

export interface AiCallOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

/** Identifiants d'un fournisseur — JAMAIS sérialisés dans une réponse. */
export interface AiCredentials {
  apiKey?: string | null;
  /** Cloudflare Workers AI : identifiant de compte (non secret à lui seul). */
  accountId?: string | null;
}

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH_FAILED'
  | 'AI_RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'AI_EMPTY_RESPONSE';

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;
  constructor(code: AiErrorCode, retryable: boolean, message?: string) {
    super(message ?? code);
    this.name = 'AiProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Code transport HTTP → code IA normalisé. */
export function aiErrorFromStatus(status: number): AiProviderError {
  if (status === 401 || status === 403) return new AiProviderError('AI_AUTH_FAILED', false);
  if (status === 429) return new AiProviderError('AI_RATE_LIMITED', true);
  if (status >= 500) return new AiProviderError('AI_UNAVAILABLE', true);
  return new AiProviderError('AI_UNAVAILABLE', true);
}

export interface AiTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface AiParsedResult {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Contrat d'un adaptateur de fournisseur : la couche commune ne suppose AUCUN
 * protocole en particulier (OpenAI-compatible, Gemini, Workers AI, agrégateur).
 * Chaque adaptateur décrit sa requête transport et interprète sa réponse.
 */
export interface AiProviderAdapter {
  readonly id: string;
  /** Construit la requête HTTP. Lève AiProviderError si non configuré. */
  buildRequest(params: {
    credentials: AiCredentials;
    model: string;
    messages: AiChatMessage[];
    options?: AiCallOptions;
  }): AiTransportRequest;
  /** Interprète le JSON de réponse. Lève AiProviderError si invalide/vide. */
  parse(payload: unknown): AiParsedResult;
  /** URL de liste des modèles (pour la vérification) ou null si inconnue. */
  modelsUrl(credentials: AiCredentials): string | null;
  /** Interprète la liste des modèles (ids ou noms bruts). */
  parseModelList(payload: unknown): string[];
}

/** Niveaux de service du routage intelligent. */
export type AiLevel = 'fast' | 'economy' | 'advanced' | 'specialized' | 'fallback';

export const AI_LEVELS: readonly AiLevel[] = ['fast', 'economy', 'advanced', 'specialized', 'fallback'];
