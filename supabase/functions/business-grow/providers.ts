export type BusinessProvider = 'groq' | 'gemini';
export type ExtensibleProviderId = BusinessProvider | 'openai' | 'anthropic' | 'deepseek' | 'mistral';
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
}

export interface ProviderCompletionOptions {
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ProviderReply {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderProbeResult {
  providerKey: ExtensibleProviderId;
  modelKey: string;
  status: 'healthy' | 'failed';
  latencyMs: number;
  errorCode: string | null;
  availableModels: string[];
}

export interface BusinessProviderAdapter {
  readonly id: ExtensibleProviderId;
  readonly displayName: string;
  readonly envKeyVar: string;
  readonly envModelVar: string;
  readonly implemented: boolean;
  complete(
    config: ProviderConfig,
    messages: ChatMessage[],
    fetcher?: typeof fetch,
    options?: ProviderCompletionOptions,
  ): Promise<ProviderReply>;
  listModels(config: ProviderConfig, fetcher?: typeof fetch): Promise<string[]>;
  probe(config: ProviderConfig, fetcher?: typeof fetch): Promise<ProviderProbeResult>;
}

export class ProviderCallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'ProviderCallError';
  }
}

const requestTimeoutMs = 25_000;
const probeTimeoutMs = 15_000;
const defaultMaxOutputTokens = 4_096;

function providerError(status: number): ProviderCallError {
  if (status === 401 || status === 403) return new ProviderCallError('PROVIDER_AUTH_FAILED', false);
  if (status === 429) return new ProviderCallError('PROVIDER_RATE_LIMITED', true);
  if (status >= 500) return new ProviderCallError('PROVIDER_UNAVAILABLE', true);
  return new ProviderCallError('PROVIDER_REQUEST_REJECTED', false);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = requestTimeoutMs,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json', ...headers } : headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ProviderCallError('PROVIDER_TIMEOUT', true);
    }
    if (error instanceof ProviderCallError) throw error;
    throw new ProviderCallError('PROVIDER_NETWORK_ERROR', true);
  }

  if (!response.ok) throw providerError(response.status);
  try {
    return asRecord(await response.json());
  } catch {
    throw new ProviderCallError('PROVIDER_INVALID_RESPONSE', true);
  }
}

function buildGeminiTurns(messages: ChatMessage[]) {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const previous = contents.at(-1);
    if (previous?.role === role) {
      previous.parts.push({ text: message.content });
    } else {
      contents.push({ role, parts: [{ text: message.content }] });
    }
  }
  while (contents[0]?.role === 'model') contents.shift();
  return { systemText, contents };
}

function validateCallInputs(config: ProviderConfig, messages: ChatMessage[]): void {
  if (!config.apiKey || !config.model) {
    throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
  }
  if (!messages.length || messages.some((message) => !message.content.trim())) {
    throw new ProviderCallError('INVALID_CHAT_CONTEXT', false);
  }
}

const groqAdapter: BusinessProviderAdapter = {
  id: 'groq',
  displayName: 'Groq',
  envKeyVar: 'BUSINESS_GROW_GROQ_API_KEY',
  envModelVar: 'BUSINESS_GROW_GROQ_MODEL',
  implemented: true,

  async complete(config, messages, fetcher = fetch, options) {
    validateCallInputs(config, messages);
    const maxTokens = options?.maxOutputTokens ?? defaultMaxOutputTokens;
    const payload: Record<string, unknown> = {
      model: config.model,
      messages: messages.map(({ role, content }) => ({ role, content })),
      max_tokens: maxTokens,
    };
    if (typeof options?.temperature === 'number') payload.temperature = options.temperature;

    const result = await requestJson(
      fetcher,
      'https://api.groq.com/openai/v1/chat/completions',
      'POST',
      { Authorization: `Bearer ${config.apiKey}` },
      payload,
    );
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice.message);
    const rawContent = typeof message.content === 'string' ? message.content.trim() : '';
    const withoutThink = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const content = withoutThink || rawContent;
    if (!content) throw new ProviderCallError('PROVIDER_EMPTY_RESPONSE', true);
    const usage = asRecord(result.usage);
    return {
      content,
      inputTokens: tokenCount(usage.prompt_tokens),
      outputTokens: tokenCount(usage.completion_tokens),
    };
  },

  async listModels(config, fetcher = fetch) {
    if (!config.apiKey) throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
    const result = await requestJson(
      fetcher,
      'https://api.groq.com/openai/v1/models',
      'GET',
      { Authorization: `Bearer ${config.apiKey}` },
      undefined,
      probeTimeoutMs,
    );
    const rows = Array.isArray(result.data) ? result.data : [];
    return rows
      .map((item) => asRecord(item).id)
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .sort();
  },

  async probe(config, fetcher = fetch) {
    const startedAt = Date.now();
    if (!config.apiKey || !config.model) {
      return {
        providerKey: 'groq',
        modelKey: config.model || '',
        status: 'failed',
        latencyMs: 0,
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        availableModels: [],
      };
    }
    try {
      const availableModels = await groqAdapter.listModels(config, fetcher);
      await groqAdapter.complete(
        config,
        [{ role: 'user', content: 'Réponds uniquement OK.' }],
        fetcher,
        { maxOutputTokens: 256, temperature: 0 },
      );
      return {
        providerKey: 'groq',
        modelKey: config.model,
        status: 'healthy',
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        availableModels,
      };
    } catch (error) {
      const code = error instanceof ProviderCallError ? error.code : 'PROVIDER_UNAVAILABLE';
      return {
        providerKey: 'groq',
        modelKey: config.model,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
        availableModels: [],
      };
    }
  },
};

const geminiAdapter: BusinessProviderAdapter = {
  id: 'gemini',
  displayName: 'Gemini',
  envKeyVar: 'BUSINESS_GROW_GEMINI_API_KEY',
  envModelVar: 'BUSINESS_GROW_GEMINI_MODEL',
  implemented: true,

  async complete(config, messages, fetcher = fetch, options) {
    validateCallInputs(config, messages);
    const { systemText, contents } = buildGeminiTurns(messages);
    if (!contents.length) throw new ProviderCallError('INVALID_CHAT_CONTEXT', false);

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: options?.maxOutputTokens ?? defaultMaxOutputTokens,
    };
    if (typeof options?.temperature === 'number') generationConfig.temperature = options.temperature;

    const result = await requestJson(
      fetcher,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      'POST',
      { 'x-goog-api-key': config.apiKey },
      {
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents,
        generationConfig,
      },
    );
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const candidate = asRecord(candidates[0]);
    const finishReason = typeof candidate.finishReason === 'string' ? candidate.finishReason : '';
    if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
      throw new ProviderCallError('PROVIDER_SAFETY_BLOCKED', true);
    }
    const candidateContent = asRecord(candidate.content);
    const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
    const text = parts
      .filter((part) => asRecord(part).thought !== true)
      .map((part) => asRecord(part).text)
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
    if (!text) throw new ProviderCallError('PROVIDER_EMPTY_RESPONSE', true);
    const usage = asRecord(result.usageMetadata);
    return {
      content: text,
      inputTokens: tokenCount(usage.promptTokenCount),
      outputTokens: tokenCount(usage.candidatesTokenCount),
    };
  },

  async listModels(config, fetcher = fetch) {
    if (!config.apiKey) throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
    const result = await requestJson(
      fetcher,
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100',
      'GET',
      { 'x-goog-api-key': config.apiKey },
      undefined,
      probeTimeoutMs,
    );
    const models = Array.isArray(result.models) ? result.models : [];
    return models
      .filter((item) => {
        const methods = asRecord(item).supportedGenerationMethods;
        return Array.isArray(methods) && methods.includes('generateContent');
      })
      .map((item) => {
        const name = asRecord(item).name;
        return typeof name === 'string' ? name.replace(/^models\//, '') : '';
      })
      .filter((id) => id.length > 0)
      .sort();
  },

  async probe(config, fetcher = fetch) {
    const startedAt = Date.now();
    if (!config.apiKey || !config.model) {
      return {
        providerKey: 'gemini',
        modelKey: config.model || '',
        status: 'failed',
        latencyMs: 0,
        errorCode: 'PROVIDER_NOT_CONFIGURED',
        availableModels: [],
      };
    }
    try {
      const availableModels = await geminiAdapter.listModels(config, fetcher);
      await geminiAdapter.complete(
        config,
        [{ role: 'user', content: 'Réponds uniquement OK.' }],
        fetcher,
        { maxOutputTokens: 256, temperature: 0 },
      );
      return {
        providerKey: 'gemini',
        modelKey: config.model,
        status: 'healthy',
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        availableModels,
      };
    } catch (error) {
      const code = error instanceof ProviderCallError ? error.code : 'PROVIDER_UNAVAILABLE';
      return {
        providerKey: 'gemini',
        modelKey: config.model,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        errorCode: code,
        availableModels: [],
      };
    }
  },
};

function createPreparedAdapter(
  id: Exclude<ExtensibleProviderId, BusinessProvider>,
  displayName: string,
  envKeyVar: string,
  envModelVar: string,
): BusinessProviderAdapter {
  return {
    id,
    displayName,
    envKeyVar,
    envModelVar,
    implemented: false,
    async complete() {
      throw new ProviderCallError('PROVIDER_ADAPTER_NOT_IMPLEMENTED', false);
    },
    async listModels() {
      return [];
    },
    async probe(config) {
      return {
        providerKey: id,
        modelKey: config.model || '',
        status: 'failed',
        latencyMs: 0,
        errorCode: 'PROVIDER_ADAPTER_NOT_IMPLEMENTED',
        availableModels: [],
      };
    },
  };
}

export const PROVIDER_ADAPTERS: ReadonlyMap<ExtensibleProviderId, BusinessProviderAdapter> = new Map([
  ['groq', groqAdapter],
  ['gemini', geminiAdapter],
  ['openai', createPreparedAdapter('openai', 'OpenAI', 'BUSINESS_GROW_OPENAI_API_KEY', 'BUSINESS_GROW_OPENAI_MODEL')],
  ['anthropic', createPreparedAdapter('anthropic', 'Anthropic Claude', 'BUSINESS_GROW_ANTHROPIC_API_KEY', 'BUSINESS_GROW_ANTHROPIC_MODEL')],
  ['deepseek', createPreparedAdapter('deepseek', 'DeepSeek', 'BUSINESS_GROW_DEEPSEEK_API_KEY', 'BUSINESS_GROW_DEEPSEEK_MODEL')],
  ['mistral', createPreparedAdapter('mistral', 'Mistral AI', 'BUSINESS_GROW_MISTRAL_API_KEY', 'BUSINESS_GROW_MISTRAL_MODEL')],
]);

export function getProviderAdapter(provider: string): BusinessProviderAdapter | null {
  return PROVIDER_ADAPTERS.get(provider as ExtensibleProviderId) ?? null;
}

export async function callProvider(
  provider: BusinessProvider,
  config: ProviderConfig,
  messages: ChatMessage[],
  fetcher: typeof fetch = fetch,
  options?: ProviderCompletionOptions,
): Promise<ProviderReply> {
  const adapter = getProviderAdapter(provider);
  if (!adapter || !adapter.implemented) {
    throw new ProviderCallError('PROVIDER_ADAPTER_NOT_IMPLEMENTED', false);
  }
  return await adapter.complete(config, messages, fetcher, options);
}

export async function probeProvider(
  provider: BusinessProvider,
  config: ProviderConfig,
  fetcher: typeof fetch = fetch,
): Promise<ProviderProbeResult> {
  const adapter = getProviderAdapter(provider);
  if (!adapter) {
    return {
      providerKey: provider,
      modelKey: config.model || '',
      status: 'failed',
      latencyMs: 0,
      errorCode: 'UNSUPPORTED_PROVIDER',
      availableModels: [],
    };
  }
  return await adapter.probe(config, fetcher);
}

export async function listRemoteModels(
  provider: BusinessProvider,
  config: ProviderConfig,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const adapter = getProviderAdapter(provider);
  if (!adapter || !adapter.implemented) return [];
  return await adapter.listModels(config, fetcher);
}

export function listAdapterDescriptors(): Array<{
  id: ExtensibleProviderId;
  displayName: string;
  envKeyVar: string;
  envModelVar: string;
  implemented: boolean;
}> {
  return [...PROVIDER_ADAPTERS.values()].map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    envKeyVar: adapter.envKeyVar,
    envModelVar: adapter.envModelVar,
    implemented: adapter.implemented,
  }));
}

export function providerOrder(value: string): BusinessProvider[] {
  const supported: BusinessProvider[] = ['groq', 'gemini'];
  const parsed = value.split(',').map((item) => item.trim().toLowerCase());
  const valid = parsed.filter((item): item is BusinessProvider =>
    supported.includes(item as BusinessProvider),
  );
  const unique = [...new Set(valid)];
  return unique.length ? unique : ['groq', 'gemini'];
}
