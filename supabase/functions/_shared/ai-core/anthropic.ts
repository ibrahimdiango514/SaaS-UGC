/** Anthropic Messages protocol. Not registered or deployed until Business Grow's
 * pinned artifact and the database adapter-kind constraint are migrated together. */
import { AiProviderError, type AiProviderAdapter } from './types.ts';
const rec = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const count = (v: unknown): number | null => typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

export function anthropicCatalogHeaders(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}
export function createAnthropicAdapter(baseUrl: string): AiProviderAdapter {
  const base = baseUrl.replace(/\/+$/, '');
  if (!/^https:\/\/api\.anthropic\.com\/v1$/.test(base)) throw new AiProviderError('AI_NOT_CONFIGURED', false);
  return {
    id: 'anthropic',
    buildRequest({ credentials, model, messages, options }) {
      if (!credentials.apiKey || !model) throw new AiProviderError('AI_NOT_CONFIGURED', false);
      if (!messages.length || messages.some(m => !m.content.trim())) throw new AiProviderError('AI_INVALID_RESPONSE', false);
      const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const message of messages) {
        if (message.role === 'system') continue;
        const previous = turns[turns.length - 1];
        if (previous?.role === message.role) previous.content += `\n\n${message.content}`;
        else turns.push({ role: message.role, content: message.content });
      }
      if (!turns.length || turns[0].role !== 'user') throw new AiProviderError('AI_INVALID_RESPONSE', false);
      const maxTokens = options?.maxOutputTokens ?? 4096;
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new AiProviderError('AI_INVALID_RESPONSE', false);
      const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages: turns };
      if (system) body.system = system;
      if (typeof options?.temperature === 'number') body.temperature = options.temperature;
      return { url: `${base}/messages`, headers: { 'Content-Type': 'application/json', ...anthropicCatalogHeaders(credentials.apiKey) }, body };
    },
    parse(payload) {
      const data = rec(payload);
      const blocks = Array.isArray(data.content) ? data.content : [];
      const content = blocks.map(rec).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
      if (!content) throw new AiProviderError('AI_EMPTY_RESPONSE', true);
      const usage = rec(data.usage);
      return { content, inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) };
    },
    modelsUrl: credentials => credentials.apiKey ? `${base}/models` : null,
    parseModelList(payload) {
      const data = rec(payload);
      return (Array.isArray(data.data) ? data.data : []).map(rec).map(row => row.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0).sort();
    },
  };
}
