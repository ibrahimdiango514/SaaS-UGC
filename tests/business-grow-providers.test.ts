import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callProvider,
  getProviderAdapter,
  listRemoteModels,
  probeProvider,
  primeProviderRegistry,
  providerConfigFor,
  ProviderCallError,
  providerOrder,
  registeredProviderKeys,
  type ChatMessage,
} from '../supabase/functions/business-grow/providers';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Réponds en français.' },
  { role: 'user', content: 'Bonjour.' },
];

/**
 * Registre minimal : c'est LUI qui décrit le protocole de chaque fournisseur.
 * Aucun fournisseur n'est écrit dans le code, donc un identifiant inventé ici
 * fonctionne exactement comme un fournisseur réel.
 */
const registryRows = [
  { provider_key: 'groq', display_name: 'Groq', adapter_kind: 'openai', default_base_url: 'https://api.groq.com/openai/v1' },
  { provider_key: 'gemini', display_name: 'Gemini', adapter_kind: 'gemini', default_base_url: 'https://generativelanguage.googleapis.com/v1beta' },
  { provider_key: 'cloudflare', display_name: 'Cloudflare Workers AI', adapter_kind: 'cloudflare', default_base_url: 'https://api.cloudflare.com/client/v4', account_id_env: 'CLOUDFLARE_ACCOUNT_ID' },
  { provider_key: 'openrouter', display_name: 'OpenRouter', adapter_kind: 'openai', default_base_url: 'https://openrouter.ai/api/v1', is_aggregator: true, default_headers: { 'X-Title': 'VYORA' } },
  { provider_key: 'deepseek', display_name: 'DeepSeek', adapter_kind: 'openai', default_base_url: 'https://api.deepseek.com' },
  { provider_key: 'mistral', display_name: 'Mistral AI', adapter_kind: 'openai', default_base_url: 'https://api.mistral.ai/v1' },
  { provider_key: 'grok', display_name: 'Grok (xAI)', adapter_kind: 'openai', default_base_url: 'https://api.x.ai/v1' },
];

beforeEach(() => { primeProviderRegistry(registryRows); });

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

  it('valide la FORME des identifiants de fournisseurs, sans liste figée', () => {
    // Aucun catalogue : l'ordre fourni est normalisé (doublons, casse, espaces)
    // et un identifiant inconnu du code reste accepté — c'est le registre qui
    // décide ensuite s'il est servable.
    expect(providerOrder('gemini, groq ,gemini')).toEqual(['gemini', 'groq']);
    expect(providerOrder('fournisseur-inconnu,groq')).toEqual(['fournisseur-inconnu', 'groq']);
    expect(providerOrder('')).toEqual([]);
    expect(providerOrder('pas valide!,groq')).toEqual(['groq']);
  });

  it('sert n’importe quel fournisseur décrit par le registre, sans le connaître', () => {
    // Les fournisseurs viennent du registre : la liste est lue, pas écrite.
    expect(registeredProviderKeys()).toEqual(
      ['cloudflare', 'deepseek', 'gemini', 'grok', 'groq', 'mistral', 'openrouter'],
    );
    // Un identifiant parfaitement inconnu obtient un adaptateur dès que la
    // forme est valide : plus aucune liste fermée dans le code.
    expect(getProviderAdapter('fournisseur-inconnu')?.id).toBe('fournisseur-inconnu');
    expect(getProviderAdapter('Pas Valide!')).toBeNull();

    // La configuration effective est résolue depuis le registre.
    expect(providerConfigFor('fournisseur-inconnu')).toBeNull();
    const config = providerConfigFor('groq', { apiKey: 'secret-groq', model: 'modele-groq' });
    expect(config).toMatchObject({ apiKey: 'secret-groq', model: 'modele-groq', baseUrl: 'https://api.groq.com/openai/v1' });
  });

  it('les fournisseurs OpenAI-compatibles suivent l’URL fournie par le registre', async () => {
    const ok = {
      choices: [{ message: { role: 'assistant', content: 'Réponse.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    };
    const cases: Array<{ provider: 'deepseek' | 'mistral' | 'grok' | 'openrouter'; url: string }> = [
      { provider: 'deepseek', url: 'https://api.deepseek.com/chat/completions' },
      { provider: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions' },
      { provider: 'grok', url: 'https://api.x.ai/v1/chat/completions' },
      { provider: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
    ];
    let lastCall: [RequestInfo | URL, RequestInit | undefined] = ['', undefined];
    for (const { provider, url } of cases) {
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        lastCall = [input, init];
        return new Response(JSON.stringify(ok), { status: 200 });
      });
      const result = await callProvider(provider, { apiKey: `secret-${provider}`, model: 'some-model' }, messages, fetcher);
      expect(String(lastCall[0])).toBe(url);
      expect(new Headers(lastCall[1]?.headers as Record<string, string>).get('Authorization'))
        .toBe(`Bearer secret-${provider}`);
      expect(result).toEqual({ content: 'Réponse.', inputTokens: 3, outputTokens: 5 });
    }
  });

  it('Cloudflare Workers AI : URL par compte ; sans compte, aucun appel réseau', async () => {
    const ok = {
      choices: [{ message: { role: 'assistant', content: 'Réponse CF.' } }],
      usage: { prompt_tokens: 2, completion_tokens: 4 },
    };
    let cfUrl = '';
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      cfUrl = String(input);
      return new Response(JSON.stringify(ok), { status: 200 });
    });
    const result = await callProvider(
      'cloudflare',
      { apiKey: 'cf-token', model: '@cf/qwen/qwen3.8-27b', accountId: 'acct-42' },
      messages,
      fetcher,
    );
    // Endpoint OpenAI-compatible DOCUMENTÉ par Cloudflare (Workers AI) :
    // `/ai/v1/chat/completions` — et non `/ai/v1/chat`, qui n'existe pas.
    expect(cfUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acct-42/ai/v1/chat/completions');
    expect(result.content).toBe('Réponse CF.');

    const noAccount = vi.fn();
    await expect(
      callProvider('cloudflare', { apiKey: 'cf-token', model: '@cf/qwen/qwen3.8-27b', accountId: null }, messages, noAccount),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    expect(noAccount).not.toHaveBeenCalled();
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

  it('strips <think> reasoning tags from Groq completions when visible text remains', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '<think>Raisonnement interne</think>\nRéponse finale claire.' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }), { status: 200 }),
    );

    const result = await callProvider(
      'groq',
      { apiKey: 'test-groq-secret', model: 'qwen/qwen3.8-27b' },
      messages,
      fetcher,
    );
    expect(result.content).toBe('Réponse finale claire.');
  });
});

// ---------------------------------------------------------------------------
// 402 : solde fournisseur épuisé
// ---------------------------------------------------------------------------
//
// Cas réel (2026-11-15) : LLM7 répond « Insufficient balance » et Ollama
// « Add usage credits ». Sans distinction, ce cas était classé « requête
// rejetée » et l'opérateur cherchait un défaut de configuration inexistant.
describe('callProvider — 402 facturation', () => {
  const config = {
    apiKey: 'test-key',
    baseUrl: 'https://api.llm7.io/v1',
    model: 'chat-solid',
  };

  it('402 → PROVIDER_PAYMENT_REQUIRED (distinct d’un refus de requête)', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Insufficient balance. Please top up your balance.' }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(
      callProvider('llm7', config as never, [{ role: 'user', content: 'bonjour' }], fetcher),
    ).rejects.toMatchObject({ code: 'PROVIDER_PAYMENT_REQUIRED', retryable: true });
  });

  it('400 reste PROVIDER_REQUEST_REJECTED (non réessayable tel quel)', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad request' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(
      callProvider('llm7', config as never, [{ role: 'user', content: 'bonjour' }], fetcher),
    ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_REJECTED' });
  });
});
