// VYORA AI CORE — adaptateurs de FOURNISSEURS, construits depuis le registre.
//
// Il n'existe ici AUCUNE liste de fournisseurs : le module ne connaît que des
// gabarits de protocole (`openai`, `gemini`, `cloudflare`, `none`). Chaque
// fournisseur est décrit par sa ligne du registre central
// (`saas_business.ai_providers` : `adapter_kind`, `default_base_url`,
// `models_url`, `default_headers`, `api_key_env`) et par son secret côté Edge ;
// `resolveAiAdapter()` assemble l'adaptateur correspondant.
//
// Trois fournisseurs conservent un adaptateur DÉDIÉ parce que leur protocole
// n'est pas strictement OpenAI (Groq et Cloudflare Workers AI : URL et lecture
// des modèles spécifiques ; Gemini : protocole natif). Ces adaptateurs
// reproduisent EXACTEMENT le comportement déjà en production — aucune
// réécriture. Un nouveau fournisseur OpenAI-compatible s'ajoute donc par une
// ligne de registre + un secret, sans modifier ce fichier.
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
export function createOpenAiCompatibleAdapter(
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
      // Quand l'API annonce les méthodes supportées, seuls les modèles de
      // conversation sont retenus (jamais un modèle d'embedding).
      .filter((item) => {
        const methods = rec(item).supportedGenerationMethods;
        return !Array.isArray(methods) || methods.includes('generateContent');
      })
      .map((item) => rec(item).name)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^models\//, ''))
      .sort();
  },
};

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

/**
 * ---------------------------------------------------------------------------
 * REGISTRE DE PROTOCOLES (et non de fournisseurs)
 * ---------------------------------------------------------------------------
 * Le code ne référence AUCUN fournisseur par son nom : il ne connaît que des
 * gabarits de protocole. Les fournisseurs eux-mêmes sont décrits par les lignes
 * du registre central (`saas_business.ai_providers` → `adapter_kind`,
 * `default_base_url`, `models_url`, `default_headers`) et par la présence de
 * leur secret côté Edge.
 *
 * Conséquence concrète : un nouveau fournisseur compatible OpenAI s'ajoute par
 * une ligne de registre + une variable d'environnement, sans redéploiement de
 * code et sans toucher à cette liste.
 *
 * Trois fournisseurs conservent un adaptateur DÉDIÉ (protocole natif non
 * strictement générique, écrit et vérifié en production) : Groq, Gemini et
 * Cloudflare Workers AI.
 */
export const NATIVE_ADAPTERS: Record<string, AiProviderAdapter> = {
  groq: groqAdapter,
  gemini: geminiAdapter,
  cloudflare: cloudflareAdapter,
};

/** Fournisseur décrivant son propre protocole (adaptateur natif). */
function adapterFromNative(descriptor: AiProviderDescriptor): AiProviderAdapter | null {
  const native = NATIVE_ADAPTERS[descriptor.key];
  if (!native) return null;
  return native;
}

/** Construit un adaptateur à partir d'un gabarit + d'une URL de base. */
function adapterFromDescriptor(descriptor: AiProviderDescriptor): AiProviderAdapter | null {
  if (descriptor.kind === 'none') return null;
  if (NATIVE_ADAPTERS[descriptor.key]) return adapterFromNative(descriptor);

  const base = descriptor.baseUrl.replace(/\/+$/, '');
  if (!base) return null;

  if (descriptor.kind === 'openai') {
    const chatUrl = `${base}/chat/completions`;
    const modelsUrl = descriptor.modelsUrl ?? `${base}/models`;
    const extraHeaders = descriptor.headers ?? {};
    return {
      id: descriptor.key,
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
      modelsUrl: (credentials) => (credentials.apiKey ? modelsUrl : null),
      parseModelList: parseModelIds,
    };
  }

  // Gabarit connu mais URL incompatible avec ce protocole : on refuse
  // proprement plutôt que d'envoyer une requête mal formée au fournisseur.
  return null;
}

/**
 * Résout l'adaptateur d'un fournisseur.
 *
 * Ordre : gabarit explicite (`ai_providers.adapter_kind`) → nom historique
 * (compatibilité des intégrations déjà en production) → inconnu (le moteur
 * journalise `UNSUPPORTED_PROVIDER`, jamais de réponse inventée).
 */
export function resolveAiAdapter(descriptor: AiProviderDescriptor | null | undefined): AiProviderAdapter | null {
  if (!descriptor) return null;
  if (descriptor.kind === 'none') return null;
  return adapterFromDescriptor(descriptor);
}

/**
 * Adaptateur « sans registre » pour les intégrations historiques.
 *
 * Utilisé par les chemins de secours (Business Grow) qui ne chargent pas le
 * snapshot. Les appels de production passent par `resolveAiAdapter()` avec la
 * ligne de registre du fournisseur — donc par le même code.
 */
export function getAiAdapter(providerKey: string): AiProviderAdapter | null {
  const native = NATIVE_ADAPTERS[providerKey];
  if (native) return native;
  return null;
}

/** Nom de base normalisé d'un modèle (déduplication agrégateur/direct). */
export function modelBaseKey(providerModelKey: string): string {
  const parts = providerModelKey.split('/');
  return parts[parts.length - 1].toLowerCase();
}
