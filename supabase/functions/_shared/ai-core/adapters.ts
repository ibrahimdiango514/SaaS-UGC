// VYORA AI CORE — adaptateurs fournisseurs (7 fournisseurs).
//
// Couche d'abstraction commune : chaque fournisseur décrit sa propre requête
// et sa propre réponse. Cinq fournisseurs partagent un protocole
// OpenAI-compatible (Groq, DeepSeek, Mistral, Grok/xAI, OpenRouter — l'agrégateur
// expose le même protocole) ; Cloudflare Workers AI expose un point de
// conversation au même format mais sur une URL par compte ; Gemini conserve
// son protocole natif. Les intégrations Groq et Gemini reproduisent EXACTEMENT
// le protocole déjà en production (URLs, en-têtes, corps, lecture des tokens) —
// aucune réécriture de leur comportement.
//
// Aucune I/O ici : buildRequest/parse sont purs. L'exécution HTTP est dans
// engine.ts (fetch injecté) — ce qui permet des tests unitaires complets.

import {
  AiCallOptions,
  AiChatMessage,
  AiCredentials,
  AiParsedResult,
  AiProviderAdapter,
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

/** Nettoie un contenu de réponse (bloc <think> éventuel, espacements). */
function cleanContent(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const withoutThink = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return withoutThink || text;
}

function requireConfigured(credentials: AiCredentials, model: string, messages: AiChatMessage[]): void {
  if (!credentials.apiKey || !model) throw new AiProviderError('AI_NOT_CONFIGURED', false);
  if (!messages.length || messages.some((m) => !m.content.trim())) {
    throw new AiProviderError('AI_INVALID_RESPONSE', false);
  }
}

function openAiBody(model: string, messages: AiChatMessage[], options?: AiCallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
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
function createOpenAiCompatibleAdapter(
  id: string,
  chatUrl: string,
  modelsUrl: string | null = null,
  extraHeaders: (credentials: AiCredentials) => Record<string, string> = () => ({}),
): AiProviderAdapter {
  return {
    id,
    buildRequest({ credentials, model, messages, options }) {
      requireConfigured(credentials, model, messages);
      return {
        url: chatUrl,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}`, ...extraHeaders(credentials) },
        body: openAiBody(model, messages, options),
      };
    },
    parse: parseOpenAi,
    modelsUrl: (credentials) => (credentials.apiKey && modelsUrl ? modelsUrl : null),
    parseModelList: parseModelIds,
  };
}

// ---------------------------------------------------------------------------
// GROQ — protocole identique à l'intégration existante (non modifiée).
// ---------------------------------------------------------------------------
const groqAdapter: AiProviderAdapter = {
  id: 'groq',
  buildRequest({ credentials, model, messages, options }) {
    requireConfigured(credentials, model, messages);
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
      body: openAiBody(model, messages, options),
    };
  },
  parse: parseOpenAi,
  modelsUrl: (credentials) => (credentials.apiKey ? 'https://api.groq.com/openai/v1/models' : null),
  parseModelList: parseModelIds,
};

// ---------------------------------------------------------------------------
// GEMINI — protocole natif identique à l'intégration existante (non modifiée).
// ---------------------------------------------------------------------------
function buildGeminiTurns(messages: AiChatMessage[]) {
  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push({ text: message.content });
    else contents.push({ role, parts: [{ text: message.content }] });
  }
  while (contents[0]?.role === 'model') contents.shift();
  return { systemText, contents };
}

const geminiAdapter: AiProviderAdapter = {
  id: 'gemini',
  buildRequest({ credentials, model, messages, options }) {
    requireConfigured(credentials, model, messages);
    const { systemText, contents } = buildGeminiTurns(messages);
    if (!contents.length) throw new AiProviderError('AI_INVALID_RESPONSE', false);
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: options?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    };
    if (typeof options?.temperature === 'number') generationConfig.temperature = options.temperature;
    const body: Record<string, unknown> = {
      contents,
      generationConfig,
    };
    if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': credentials.apiKey ?? '' },
      body,
    };
  },
  parse(payload) {
    const data = rec(payload);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const candidate = rec(candidates[0]);
    const parts = Array.isArray(rec(candidate.content).parts) ? (rec(candidate.content).parts as unknown[]) : [];
    const content = cleanContent(
      parts.map((part) => rec(part).text).filter((t): t is string => typeof t === 'string').join(''),
    );
    if (!content) throw new AiProviderError('AI_EMPTY_RESPONSE', true);
    const usage = rec(data.usageMetadata);
    return {
      content,
      inputTokens: num(usage.promptTokenCount),
      outputTokens: num(usage.candidatesTokenCount),
    };
  },
  modelsUrl: (credentials) => (credentials.apiKey ? 'https://generativelanguage.googleapis.com/v1beta/models' : null),
  parseModelList(payload) {
    const data = rec(payload);
    const rows = Array.isArray(data.models) ? data.models : [];
    return rows
      .map((item) => rec(item).name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''))
      .sort();
  },
};

// ---------------------------------------------------------------------------
// DEEPSEEK — protocole OpenAI (api.deepseek.com).
// ---------------------------------------------------------------------------
const deepseekAdapter = createOpenAiCompatibleAdapter(
  'deepseek',
  'https://api.deepseek.com/chat/completions',
  'https://api.deepseek.com/models',
);

// ---------------------------------------------------------------------------
// MISTRAL — protocole OpenAI (api.mistral.ai/v1).
// ---------------------------------------------------------------------------
const mistralAdapter = createOpenAiCompatibleAdapter(
  'mistral',
  'https://api.mistral.ai/v1/chat/completions',
  'https://api.mistral.ai/v1/models',
);

// ---------------------------------------------------------------------------
// GROK (xAI) — protocole OpenAI (api.x.ai/v1).
// ---------------------------------------------------------------------------
const grokAdapter = createOpenAiCompatibleAdapter(
  'grok',
  'https://api.x.ai/v1/chat/completions',
  'https://api.x.ai/v1/models',
);

// ---------------------------------------------------------------------------
// CLOUDFLARE WORKERS AI — point de conversation par compte (Bearer jeton API).
// Le modèle est préfixé “@cf/…”. La requête suit le format de chat standard.
// ---------------------------------------------------------------------------
const cloudflareAdapter: AiProviderAdapter = {
  id: 'cloudflare',
  buildRequest({ credentials, model, messages, options }) {
    if (!credentials.apiKey || !credentials.accountId || !model) {
      throw new AiProviderError('AI_NOT_CONFIGURED', false);
    }
    if (!messages.length || messages.some((m) => !m.content.trim())) {
      throw new AiProviderError('AI_INVALID_RESPONSE', false);
    }
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/v1/chat`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiKey}` },
      body: openAiBody(model, messages, options),
    };
  },
  parse: parseOpenAi,
  modelsUrl: (credentials) =>
    credentials.apiKey && credentials.accountId
      ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/ai/models`
      : null,
  parseModelList: (payload) => {
    const data = rec(payload);
    const rows = Array.isArray(data.result) && Array.isArray(rec(data.result).models)
      ? (rec(data.result).models as unknown[])
      : Array.isArray(data.result) ? (data.result as unknown[])
      : [];
    const out: string[] = [];
    for (const row of rows) {
      const r = rec(row);
      const id = typeof r.id === 'string' ? r.id : typeof r.name === 'string' ? r.name : null;
      if (id && !out.includes(id)) out.push(id);
    }
    return out.sort();
  },
};

// ---------------------------------------------------------------------------
// OPENROUTER — AGRÉGATEUR (protocole OpenAI). Ajoute les en-têtes
// HTTP-Referer / X-Title requis par le service (attribution).
// ---------------------------------------------------------------------------
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

const openrouterAdapter: AiProviderAdapter = {
  id: 'openrouter',
  buildRequest({ credentials, model, messages, options }) {
    requireConfigured(credentials, model, messages);
    return {
      url: OPENROUTER_CHAT_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credentials.apiKey}`,
        'HTTP-Referer': 'https://vyora-ugc.netlify.app',
        'X-Title': 'VYORA',
      },
      body: openAiBody(model, messages, options),
    };
  },
  parse: parseOpenAi,
  modelsUrl: (credentials) => (credentials.apiKey ? OPENROUTER_MODELS_URL : null),
  parseModelList: parseModelIds,
};

export const AI_PROVIDERS: Record<string, AiProviderAdapter> = {
  groq: groqAdapter,
  gemini: geminiAdapter,
  deepseek: deepseekAdapter,
  mistral: mistralAdapter,
  grok: grokAdapter,
  cloudflare: cloudflareAdapter,
  openrouter: openrouterAdapter,
};

export function getAiAdapter(providerKey: string): AiProviderAdapter | null {
  return AI_PROVIDERS[providerKey] ?? null;
}

/** Nom de base normalisé d'un modèle (déduplication agrégateur/direct). */
export function modelBaseKey(providerModelKey: string): string {
  const parts = providerModelKey.split('/');
  return parts[parts.length - 1].toLowerCase();
}
