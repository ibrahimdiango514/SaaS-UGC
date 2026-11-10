import { describe, expect, it, vi } from 'vitest';
import {
  callProvider,
  getProviderAdapter,
  listRemoteModels,
  probeProvider,
  PROVIDER_ADAPTERS,
  ProviderCallError,
  providerOrder,
  type ChatMessage,
} from '../supabase/functions/business-grow/providers';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Réponds en français.' },
  { role: 'user', content: 'Bonjour.' },
];

describe('Business Grow provider clients', () => {
  it('calls the official Groq Chat Completions API with configured model and maps usage', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'Réponse Groq.' } }],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      }), { status: 200 }),
    );

    const result = await callProvider(
      'groq',
      { apiKey: 'test-groq-secret', model: 'configured-groq-model' },
      messages,
      fetcher,
    );

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-groq-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'configured-groq-model',
      messages: [{ role: 'system' }, { role: 'user' }],
    });
    expect(result).toEqual({ content: 'Réponse Groq.', inputTokens: 7, outputTokens: 4 });
  });

  it('calls Gemini REST v1beta with the key in a server-side header and system instruction', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Réponse Gemini.' }] } }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 5 },
      }), { status: 200 }),
    );

    const result = await callProvider(
      'gemini',
      { apiKey: 'test-gemini-secret', model: 'configured-gemini-model' },
      [...messages, { role: 'assistant', content: 'Précédent.' }],
      fetcher,
    );

    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/configured-gemini-model:generateContent');
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe('test-gemini-secret');
    expect(String(url)).not.toContain('test-gemini-secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      systemInstruction: { parts: [{ text: 'Réponds en français.' }] },
      contents: [{ role: 'user' }, { role: 'model' }],
    });
    expect(result).toEqual({ content: 'Réponse Gemini.', inputTokens: 6, outputTokens: 5 });
  });

  it('merges consecutive Gemini turns with the same role into one content entry', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Réponse.' }] } }],
      }), { status: 200 }),
    );

    await callProvider(
      'gemini',
      { apiKey: 'test-gemini-secret', model: 'configured-gemini-model' },
      [
        { role: 'system', content: 'Réponds en français.' },
        { role: 'user', content: 'Question précédente.' },
        { role: 'user', content: 'Question actuelle.' },
        { role: 'assistant', content: 'Réponse.' },
      ],
      fetcher,
    );

    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(String(init?.body)).contents).toEqual([
      { role: 'user', parts: [{ text: 'Question précédente.' }, { text: 'Question actuelle.' }] },
      { role: 'model', parts: [{ text: 'Réponse.' }] },
    ]);
  });

  it('does not make a provider request when the secret or model is missing', async () => {
    const fetcher = vi.fn();

    await expect(callProvider('groq', { apiKey: '', model: 'model' }, messages, fetcher))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await expect(callProvider('gemini', { apiKey: 'secret', model: '' }, messages, fetcher))
      .rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps rate limits, server errors and timeouts to sanitized provider errors', async () => {
    const rateLimited = vi.fn(async () => new Response('private provider response', { status: 429 }));
    await expect(callProvider('groq', { apiKey: 'secret', model: 'model' }, messages, rateLimited))
      .rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryable: true });

    const serverError = vi.fn(async () => new Response('', { status: 503 }));
    await expect(callProvider('gemini', { apiKey: 'secret', model: 'model' }, messages, serverError))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });

    const timedOut = vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); });
    await expect(callProvider('groq', { apiKey: 'secret', model: 'model' }, messages, timedOut))
      .rejects.toBeInstanceOf(ProviderCallError);
    await expect(callProvider('groq', { apiKey: 'secret', model: 'model' }, messages, timedOut))
      .rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('parses a unique, supported server provider order and uses the safe default', () => {
    expect(providerOrder('gemini,groq,gemini,unknown')).toEqual(['gemini', 'groq']);
    expect(providerOrder('unknown')).toEqual(['groq', 'gemini']);
  });

  it('registers prepared extensible adapters without claiming live execution', async () => {
    expect(PROVIDER_ADAPTERS.get('openai')?.implemented).toBe(false);
    expect(PROVIDER_ADAPTERS.get('anthropic')?.implemented).toBe(false);
    expect(PROVIDER_ADAPTERS.get('deepseek')?.implemented).toBe(false);
    expect(PROVIDER_ADAPTERS.get('mistral')?.implemented).toBe(false);
    expect(getProviderAdapter('groq')?.implemented).toBe(true);
    expect(getProviderAdapter('gemini')?.implemented).toBe(true);

    const fetcher = vi.fn();
    await expect(
      callProvider('openai' as unknown as 'groq', { apiKey: 'test-key', model: 'gpt-4o-mini' }, messages, fetcher),
    ).rejects.toMatchObject({ code: 'PROVIDER_ADAPTER_NOT_IMPLEMENTED', retryable: false });
    await expect(
      getProviderAdapter('openai')!.complete({ apiKey: 'test-key', model: 'gpt-4o-mini' }, messages, fetcher),
    ).rejects.toMatchObject({ code: 'PROVIDER_ADAPTER_NOT_IMPLEMENTED', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('discovers remote models for Groq and Gemini from official endpoints', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.groq.com')) {
        return new Response(JSON.stringify({
          data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'mixtral-8x7b-32768' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
      }), { status: 200 });
    });

    await expect(listRemoteModels('groq', { apiKey: 'groq-secret', model: 'llama-3.3-70b-versatile' }, fetcher))
      .resolves.toEqual(['llama-3.3-70b-versatile', 'mixtral-8x7b-32768']);
    await expect(listRemoteModels('gemini', { apiKey: 'gemini-secret', model: 'gemini-2.5-flash' }, fetcher))
      .resolves.toEqual(['gemini-2.5-flash']);
  });

  it('performs real server-side probe checks and never reports healthy on failure', async () => {
    const healthyFetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'OK' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1 },
      }), { status: 200 });
    });

    const probeOk = await probeProvider('groq', { apiKey: 'secret', model: 'llama-3.3-70b-versatile' }, healthyFetcher);
    expect(probeOk).toMatchObject({
      providerKey: 'groq',
      modelKey: 'llama-3.3-70b-versatile',
      status: 'healthy',
      errorCode: null,
      availableModels: ['llama-3.3-70b-versatile'],
    });

    const failingFetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] }), { status: 200 });
      }
      return new Response('unauthorized', { status: 401 });
    });

    const probeFail = await probeProvider('groq', { apiKey: 'bad-secret', model: 'llama-3.3-70b-versatile' }, failingFetcher);
    expect(probeFail).toMatchObject({
      providerKey: 'groq',
      status: 'failed',
      errorCode: 'PROVIDER_AUTH_FAILED',
    });
  });
});
