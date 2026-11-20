import { describe, expect, it } from 'vitest';
import { anthropicCatalogHeaders, createAnthropicAdapter } from '../supabase/functions/_shared/ai-core/anthropic';

describe('Anthropic Messages — gabarit isolé, sans réseau', () => {
  it('construit la requête native et lit texte et usage', () => {
    const adapter = createAnthropicAdapter('https://api.anthropic.com/v1');
    const request = adapter.buildRequest({ credentials: { apiKey: 'test-key' }, model: 'model-id', messages: [
      { role: 'system', content: 'Consigne' }, { role: 'user', content: 'Bonjour' }, { role: 'user', content: 'Encore' },
      { role: 'assistant', content: 'Réponse' }, { role: 'user', content: 'Suite' },
    ], options: { maxOutputTokens: 42 } });
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers).toMatchObject({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body).toEqual({ model: 'model-id', max_tokens: 42, system: 'Consigne', messages: [
      { role: 'user', content: 'Bonjour\n\nEncore' }, { role: 'assistant', content: 'Réponse' }, { role: 'user', content: 'Suite' },
    ] });
    expect(adapter.parse({ content: [{ type: 'text', text: 'Salut' }], usage: { input_tokens: 5, output_tokens: 2 } })).toEqual({ content: 'Salut', inputTokens: 5, outputTokens: 2 });
    expect(adapter.parseModelList({ data: [{ id: 'model-b' }, { id: 'model-a' }] })).toEqual(['model-a', 'model-b']);
    expect(anthropicCatalogHeaders('test-key')).toEqual({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
  });
  it('refuse les origines non prévues, clés absentes, entrées incompatibles et réponses sans texte', () => {
    expect(() => createAnthropicAdapter('https://evil.example/v1')).toThrow('AI_NOT_CONFIGURED');
    const adapter = createAnthropicAdapter('https://api.anthropic.com/v1');
    expect(() => adapter.buildRequest({ credentials: { apiKey: 'test' }, model: 'x', messages: [{ role: 'assistant', content: 'orphan' }] })).toThrow('AI_INVALID_RESPONSE');
    expect(() => adapter.buildRequest({ credentials: {}, model: 'x', messages: [{ role: 'user', content: 'hi' }] })).toThrow('AI_NOT_CONFIGURED');
    expect(() => adapter.parse({ content: [{ type: 'tool_use', name: 'x' }] })).toThrow('AI_EMPTY_RESPONSE');
  });
});
