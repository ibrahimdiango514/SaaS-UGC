// SORAHNEX AI CORE — types communs (partagés par tous les espaces).
//
// Aucune dépendance d'environnement : le code fonctionne identiquement sous
// Deno (Edge), Node (tests vitest) et dans le bundle esbuild de Grow.
// Les secrets et l'accès réseau sont TOUJOURS injectés par l'hôte.

export type AiChatRole = 'system' | 'user' | 'assistant';

/** Image transmise au modèle pour analyse visuelle (base64 sans préfixe data:). */
export interface AiImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface AiChatMessage {
  role: AiChatRole;
  content: string;
  /**
   * Images jointes à CE message. Elles ne sont jamais fusionnées dans le texte :
   * chaque adaptateur les place dans le format multimodal natif du fournisseur.
   */
  images?: AiImageInput[];
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
  /** Cloudflare AI Gateway : identifiant de la passerelle (non secret). */
  gatewayId?: string | null;
}

export type AiErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_AUTH_FAILED'
  | 'AI_RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'AI_TIMEOUT'
  | 'AI_INVALID_RESPONSE'
  | 'AI_EMPTY_RESPONSE'
  /** Identifiant de compte ou de passerelle requis mais absent des secrets. */
  | 'AI_ACCOUNT_NOT_CONFIGURED';

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
/**
 * Gabarit de protocole d'un fournisseur, stocké DANS LE REGISTRE
 * (`ai_providers.adapter_kind`).
 *
 * Décision d'architecture : SORAHNEX ne parle plus qu'un protocole, `openai`
 * (/chat/completions + /models). Les fournisseurs sont centralisés derrière
 * FreeLLMAPI et exposés par ce protocole ; aucun adaptateur natif par
 * fournisseur ne subsiste (ni Groq, ni Gemini, ni Cloudflare).
 *
 *  - `openai` : /chat/completions + /models au format OpenAI ;
 *  - `none`   : protocole non supporté → listé mais jamais appelé (le moteur
 *               refuse proprement le fournisseur).
 */
export type AiAdapterKind = 'openai' | 'none';

/** Voie d'accès à un fournisseur (registre), pas son identité. */
export type AiProviderTransport = 'rest' | 'gateway';

export const AI_PROVIDER_TRANSPORTS: readonly AiProviderTransport[] = ['rest', 'gateway'];

export const AI_ADAPTER_KINDS: readonly AiAdapterKind[] = ['openai', 'none'];

/** Décrit UN fournisseur sans figer son identité dans le code. */
export interface AiProviderDescriptor {
  key: string;
  kind: AiAdapterKind;
  /** URL de base, ex. `https://api.exemple.com/v1`. */
  baseUrl: string;
  /**
   * Nom de la variable d'environnement qui porte l'URL de base (jamais la
   * valeur). Utilisée quand le registre ne fige pas l'URL : FreeLLMAPI peut
   * ainsi changer d'hôte sans modification du registre ni du code.
   */
  baseUrlEnv?: string | null;
  /** Nom de la variable d'environnement qui porte la clé (jamais la valeur). */
  apiKeyEnv: string | null;
  /** Variable portant l'identifiant de compte (Cloudflare), si nécessaire. */
  accountIdEnv?: string | null;
  /** Variable portant l'identifiant de passerelle (Cloudflare AI Gateway). */
  gatewayIdEnv?: string | null;
  /**
   * Voie d'appel du fournisseur :
   *  - `rest`     : API officielle du fournisseur (défaut) ;
   *  - `gateway`  : passerelle du fournisseur (Cloudflare AI Gateway), qui
   *                 exige un jeton dédié et un identifiant de passerelle.
   * Aucune autre valeur n'est acceptée : le registre décide, le code se tait.
   */
  transport?: AiProviderTransport | null;
  /** URL de base de la liste des modèles (défaut : déduite de `baseUrl`). */
  modelsUrl?: string | null;
  /** En-têtes supplémentaires (attribution d'un agrégateur, version d'API…). */
  headers?: Record<string, string> | undefined;
  aggregator?: boolean;
}

export interface AiProviderAdapter {
  readonly id: string;
  /** Gabarit de protocole effectivement utilisé (diagnostic/administration). */
  readonly kind?: AiAdapterKind;
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
