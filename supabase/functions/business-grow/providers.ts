export type BusinessProvider = 'groq' | 'gemini';
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
}

export interface ProviderReply {
  content: string;
  inputTokens: number | null;
  outputTokens: number | null;
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
const maxOutputTokens = 2_048;

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

async function postJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
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

export async function callProvider(
  provider: BusinessProvider,
  config: ProviderConfig,
  messages: ChatMessage[],
  fetcher: typeof fetch = fetch,
): Promise<ProviderReply> {
  if (!config.apiKey || !config.model) {
    throw new ProviderCallError('PROVIDER_NOT_CONFIGURED', false);
  }
  if (!messages.length || messages.some((message) => !message.content.trim())) {
    throw new ProviderCallError('INVALID_CHAT_CONTEXT', false);
  }

  if (provider === 'groq') {
    const result = await postJson(
      fetcher,
      'https://api.groq.com/openai/v1/chat/completions',
      { Authorization: `Bearer ${config.apiKey}` },
      {
        model: config.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        max_tokens: maxOutputTokens,
      },
    );
    const choices = Array.isArray(result.choices) ? result.choices : [];
    const choice = asRecord(choices[0]);
    const message = asRecord(choice.message);
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) throw new ProviderCallError('PROVIDER_EMPTY_RESPONSE', true);
    const usage = asRecord(result.usage);
    return {
      content,
      inputTokens: tokenCount(usage.prompt_tokens),
      outputTokens: tokenCount(usage.completion_tokens),
    };
  }

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
  if (!contents.length) throw new ProviderCallError('INVALID_CHAT_CONTEXT', false);
  const result = await postJson(
    fetcher,
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
    { 'x-goog-api-key': config.apiKey },
    {
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      contents,
      generationConfig: { maxOutputTokens },
    },
  );
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const candidate = asRecord(candidates[0]);
  const candidateContent = asRecord(candidate.content);
  const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
  const text = parts
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
