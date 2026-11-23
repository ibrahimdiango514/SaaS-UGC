import { describe, expect, it } from 'vitest';
import { parseImageInputs } from '../supabase/functions/_shared/ai-core/images';
import { NATIVE_ADAPTERS } from '../supabase/functions/_shared/ai-core/adapters';
import { buildAiChain } from '../supabase/functions/_shared/ai-core/router';
import type { AiRegistrySnapshot } from '../supabase/functions/_shared/ai-core/registry';
import { buildCentralRequest } from '../supabase/functions/business-grow/providers';

const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

describe('validation des images', () => {
  it('accepte une image JPEG en base64 et retire un préfixe data URL', () => {
    const result = parseImageInputs([{ mimeType: 'image/jpeg', dataBase64: `data:image/jpeg;base64,${JPEG}` }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.images).toEqual([{ mimeType: 'image/jpeg', dataBase64: JPEG }]);
    }
  });

  it('refuse un type non supporté', () => {
    const result = parseImageInputs([{ mimeType: 'image/svg+xml', dataBase64: JPEG }]);
    expect(result.ok).toBe(false);
  });

  it('refuse un base64 invalide', () => {
    const result = parseImageInputs([{ mimeType: 'image/png', dataBase64: 'pas du base64 !' }]);
    expect(result.ok).toBe(false);
  });

  it('borne le nombre d’images', () => {
    const row = { mimeType: 'image/png', dataBase64: JPEG };
    const result = parseImageInputs([row, row, row, row, row, row]);
    expect(result.ok).toBe(false);
  });
});

describe('format multimodal des adaptateurs', () => {
  const image = { mimeType: 'image/jpeg', dataBase64: JPEG };

  it('Gemini utilise inlineData', () => {
    const transport = NATIVE_ADAPTERS.gemini.buildRequest({
      credentials: { apiKey: 'test-key' },
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Décris cette image', images: [image] }],
    });
    const body = transport.body as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[0].parts).toEqual([
      { text: 'Décris cette image' },
      { inlineData: { mimeType: 'image/jpeg', data: JPEG } },
    ]);
  });

  it('le protocole OpenAI utilise image_url avec une data URL', () => {
    const transport = NATIVE_ADAPTERS.groq.buildRequest({
      credentials: { apiKey: 'test-key' },
      model: 'modele-vision',
      messages: [{ role: 'user', content: 'Décris', images: [image] }],
    });
    const body = transport.body as { messages: Array<{ content: unknown }> };
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Décris' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG}` } },
    ]);
  });

  it('transmet les images au moteur central, jamais dans le texte', () => {
    const request = buildCentralRequest('gemini', [
      { role: 'user', content: 'Analyse', images: [image] },
    ]);
    expect(request.messages).toEqual([
      { role: 'user', content: 'Analyse', images: [image] },
    ]);
  });
});

describe('routage vision', () => {
  const snapshot: AiRegistrySnapshot = {
    version: 1,
    providers: [
      { key: 'groq', name: 'Groq', status: 'available', aggregator: false, adapterKind: 'openai', baseUrl: null, modelsUrl: null, apiKeyEnv: null, accountIdEnv: null, gatewayIdEnv: null, headers: {}, transport: 'rest' },
      { key: 'gemini', name: 'Gemini', status: 'available', aggregator: false, adapterKind: 'gemini', baseUrl: null, modelsUrl: null, apiKeyEnv: null, accountIdEnv: null, gatewayIdEnv: null, headers: {}, transport: 'rest' },
    ],
    models: [
      { provider: 'groq', key: 'texte', providerModel: 'openai/gpt-oss-120b', name: 'Texte', verified: true, tier: 'fast', capabilities: { writing: true }, contextIn: 131072, maxOut: 8192, costIn: 0.15, costOut: 0.6, rpm: null, tpm: null },
      // Le registre historique de production déclare `images: true` (et non
      // `vision`) : le routeur doit malgré tout reconnaître la capacité vision.
      { provider: 'gemini', key: 'vision', providerModel: 'gemini-2.5-flash', name: 'Vision', verified: true, tier: 'fast', capabilities: { images: true, writing: true }, contextIn: 1048576, maxOut: 8192, costIn: null, costOut: null, rpm: null, tpm: null },
    ],
    roles: [{ key: 'business_advisor', capabilities: {}, enabled: true }],
    rules: [],
    budget: { monthly: null, alert: null, daily: null },
    monthlySpendUsd: 0,
  };

  it('écarte un modèle sans vision quand une image est jointe', () => {
    const { steps } = buildAiChain(
      snapshot,
      { role: 'business_advisor', requireCapabilities: ['vision'] },
      new Set(['groq', 'gemini']),
    );
    expect(steps.map((step) => step.providerKey)).toEqual(['gemini']);
  });

  it('sans modèle vision, la chaîne est vide et explicite', () => {
    const { steps, skipReason } = buildAiChain(
      snapshot,
      { role: 'business_advisor', requireCapabilities: ['vision'] },
      new Set(['groq']),
    );
    expect(steps).toEqual([]);
    expect(skipReason).toBe('NO_MATCHING_MODEL');
  });
});
