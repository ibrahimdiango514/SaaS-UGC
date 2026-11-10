import { describe, expect, it, vi } from 'vitest';
import {
  callProvider,
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
});
