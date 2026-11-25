// SORAHNEX AI CORE — adaptateur de FOURNISSEUR unique, construit depuis le registre.
//
// Décision d'architecture (migration 2026-11-23) : SORAHNEX ne parle plus qu'UN
// SEUL protocole, `openai` (chat/completions + models). Les fournisseurs
// centralisés derrière FreeLLMAPI sont exposés par ce protocole ; il n'existe
// donc plus d'adaptateur natif par fournisseur ni aucune liste de fournisseurs
// dans le code.
//
// Un fournisseur = une ligne du registre central (`saas_business.ai_providers` :
// `adapter_kind`, `default_base_url` ou `base_url_env`, `models_url`,
// `default_headers`, `api_key_env`) + un secret côté Edge. Ajouter un
// fournisseur ne demande AUCUNE modification de ce fichier.
//
// `adapter_kind = 'none'` permet de déclarer un protocole non supporté : il est
// listé mais jamais appelé (erreur explicite, aucune requête mal formée).
//
// Aucune I/O ici : buildRequest/parse sont purs. L'exécution HTTP est dans
// engine.ts (fetch injecté) — ce qui permet des tests unitaires complets.

import {
  AiCallOptions,
  AiChatMessage,
  AiCredentials,
  AiParsedResult,
  AiProviderAdapter,
  AiProviderDescriptor,
  AiProviderError,
} from './types.ts';

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Nettoie un contenu de réponse (bloc `think` éventuel, espacements). */
function cleanContent(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const withoutThink = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
  return withoutThink || text;
}

function requireConfigured(credentials: AiCredentials, model: string, messages: AiChatMessage[]): void {
  if (!credentials.apiKey || !model) throw new AiProviderError('AI_NOT_CONFIGURED', false);
  if (!messages.length || messages.some((m) => !m.content.trim() && !m.images?.length)) {
    throw new AiProviderError('AI_INVALID_RESPONSE', false);
  }
}

function openAiBody(model: string, messages: AiChatMessage[], options?: AiCallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    // Format multimodal OpenAI : `content` devient un tableau de parties. Un
    // message sans image garde une chaîne simple (compatibilité maximale).
    messages: messages.map((m) => ({
      role: m.role,
      content: m.images?.length
        ? [
            ...(m.content.trim() ? [{ type: 'text', text: m.content }] : []),
            ...m.images.map((image) => ({
              type: 'image_url',
              image_url: { url: `data:${image.mimeType};base64,${image.dataBase64}` },
            })),
          ]
        : m.content,
    })),
    max_tokens: options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (typeof options?.temperature === 'number') body.temperature = options.temperature;
  return body;
}

/** Parseur commun : réponse au format OpenAI (choices + usage). */
function parseOpenAi(payload: unknown): AiParsedResult {
  const data = rec(payload);
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = rec(rec(choices[0]).message);
  const content = cleanContent(message.content);
  if (!content) throw new AiProviderError('AI_EMPTY_RESPONSE', true);
  const usage = rec(data.usage);
  return {
    content,
    inputTokens: num(usage.prompt_tokens),
    outputTokens: num(usage.completion_tokens),
  };
}

function parseModelIds(payload: unknown): string[] {
  const data = rec(payload);
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((item) => rec(item).id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .sort();
}

/** Fabrique un adaptateur OpenAI-compatible (le protocole, pas l'identité). */
export function createOpenAiCompatibleAdapter(
  id: string,
  chatUrl: string,
  modelsUrl: string | null = null,
  extraHeaders: Record<string, string> = {},
): AiProviderAdapter {
  return {
    id,
    kind: 'openai',
    buildRequest({ credentials, model, messages, options }) {
      requireConfigured(credentials, model, messages);
      return {
        url: chatUrl,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.apiKey}`,
          ...extraHeaders,
        },
        body: openAiBody(model, messages, options),
      };
    },
    parse: parseOpenAi,
    modelsUrl: (credentials) => (credentials.apiKey && modelsUrl ? modelsUrl : null),
    parseModelList: parseModelIds,
  };
}

/**
 * Résout l'adaptateur d'un fournisseur à partir de son descripteur de registre.
 *
 * Un seul protocole est accepté (`openai`) ; `none` et une URL de base absente
 * produisent `null` : le moteur journalise alors `UNSUPPORTED_PROVIDER` au lieu
 * d'envoyer une requête inventée. Aucun nom de fournisseur n'est reconnu ici.
 */
export function resolveAiAdapter(descriptor: AiProviderDescriptor | null | undefined): AiProviderAdapter | null {
  if (!descriptor || descriptor.kind !== 'openai') return null;
  const base = (descriptor.baseUrl ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return createOpenAiCompatibleAdapter(
    descriptor.key,
    `${base}/chat/completions`,
    descriptor.modelsUrl ?? `${base}/models`,
    descriptor.headers ?? {},
  );
}

/** Nom de base normalisé d'un modèle (déduplication agrégateur/direct). */
export function modelBaseKey(providerModelKey: string): string {
  const parts = providerModelKey.split('/');
  return parts[parts.length - 1].toLowerCase();
}
